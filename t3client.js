// Reads the usage limits that T3 Code keeps for every provider account, and signs
// in to T3 servers with read-only sessions.
//
// T3 probes each account it runs (Claude, Codex, Cursor, Antigravity, ...) and keeps
// its session, weekly and monthly windows. A server returns them from its WebSocket
// RPC (`server.getConfig`) to a session with the `orchestration:read` scope.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Soup.Session.prototype, 'websocket_connect_async');

export const LOCAL_ID = 'local';
const LOCAL_NAME = 'This computer';
const T3_HOME = GLib.build_filenamev([GLib.get_home_dir(), '.t3']);
const RUNTIME_FILE = GLib.build_filenamev([T3_HOME, 'userdata', 'server-runtime.json']);
const TOKEN_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 't3-ai-usage', 'tokens']);

const SCOPE = 'orchestration:read';
const CLIENT_LABEL = 'T3 AI Usage';
// WebSocket RPC protocol of the T3 releases this client speaks.
const ORCHESTRATION_PROTOCOL = 2;
// The token for this computer is renewed a day before it expires, and the `t3`
// command runs at most once per half hour.
const RENEW_BEFORE_MS = 24 * 3600 * 1000;
const MINT_RETRY_SECONDS = 30 * 60;
const TIMEOUT_SECONDS = 30;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class T3Error extends Error {}
class AuthRejected extends T3Error {}

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function friendlyError(e) {
    if (e instanceof T3Error)
        return e;
    if (isCancelled(e))
        return new T3Error('stopped');
    if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
        return new T3Error('T3 is not running');
    if (e?.matches?.(Gio.ResolverError, Gio.ResolverError.NOT_FOUND) ||
        e?.matches?.(Gio.ResolverError, Gio.ResolverError.TEMPORARY_FAILURE) ||
        e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT) ||
        e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NETWORK_UNREACHABLE) ||
        e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.HOST_UNREACHABLE))
        return new T3Error('unreachable');
    return new T3Error(String(e?.message ?? e));
}

function describeCause(cause) {
    const text = JSON.stringify(cause ?? null);
    const message = /"message":"([^"]{1,200})"/.exec(text);
    return message ? message[1] : text.slice(0, 200);
}

async function readJson(path, cancellable = null) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return JSON.parse(decoder.decode(bytes));
}

// Tokens live in ~/.config/t3-ai-usage/tokens/<server id>.json, readable only by the user.

function tokenPath(id) {
    return GLib.build_filenamev([TOKEN_DIR, `${id}.json`]);
}

export async function readToken(id, cancellable = null) {
    try {
        const auth = await readJson(tokenPath(id), cancellable);
        return typeof auth?.token === 'string' && auth.token ? auth : null;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

export async function writeToken(id, auth) {
    GLib.mkdir_with_parents(TOKEN_DIR, 0o700);
    const bytes = new GLib.Bytes(encoder.encode(JSON.stringify(auth)));
    await Gio.File.new_for_path(tokenPath(id)).replace_contents_bytes_async(bytes, null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

export async function deleteToken(id) {
    try {
        await Gio.File.new_for_path(tokenPath(id)).delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch {}
}

// Servers to read: this computer (unless switched off) and the ones added in the
// preferences, stored as a JSON array of {id, name, url} in the `servers` setting.
export function parseServers(json) {
    try {
        const list = JSON.parse(json);
        if (Array.isArray(list))
            return list.filter(s => typeof s?.id === 'string' && typeof s.url === 'string' && s.id !== LOCAL_ID);
    } catch {}
    return [];
}

export function serverSpecs(settings) {
    const remote = parseServers(settings.get_string('servers'))
        .map(s => ({id: s.id, name: s.name || s.url, url: s.url}));
    return settings.get_boolean('local-server') ? [{id: LOCAL_ID, name: LOCAL_NAME, local: true}, ...remote] : remote;
}

// The server's base address: scheme, host, port and any path T3 is served under,
// without a trailing slash, query or fragment.
export function normalizeUrl(text) {
    let parsed = null;
    try {
        parsed = GLib.Uri.parse(text.trim(), GLib.UriFlags.NONE);
    } catch {}
    if (!['http', 'https'].includes(parsed?.get_scheme()) || !parsed.get_host())
        throw new T3Error('the address must start with https:// or http://');
    const host = parsed.get_host().includes(':') ? `[${parsed.get_host()}]` : parsed.get_host();
    const port = parsed.get_port() > 0 ? `:${parsed.get_port()}` : '';
    return `${parsed.get_scheme()}://${host}${port}${parsed.get_path().replace(/\/+$/, '')}`;
}

export function isLoopback(url) {
    return /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:|$)/.test(url);
}

// What the user pasted to sign in: a pairing link (http(s)://host/pair#token=...
// or the t3code:// app link), a bare pairing token, a bearer token, or the JSON
// printed by `t3 auth session issue --json`.
export function parseCredential(text) {
    text = text.trim();
    const appLink = /^t3code:\/\/pair\?(.*)$/.exec(text);
    if (appLink) {
        const params = GLib.Uri.parse_params(appLink[1], -1, '&', GLib.UriParamsFlags.NONE);
        if (params.pairingUrl)
            return parseCredential(params.pairingUrl);
    }
    const pairingUrl = /^(https?:\/\/[^#?\s]+?)\/pair#token=([^&\s]+)/.exec(text);
    if (pairingUrl)
        return {url: normalizeUrl(pairingUrl[1]), pairing: decodeURIComponent(pairingUrl[2])};
    if (text.startsWith('{')) {
        try {
            const issued = JSON.parse(text);
            if (issued?.token)
                return {token: issued.token};
        } catch {}
    }
    // Pairing tokens are short codes; session tokens are long signed strings.
    return text.length > 40 ? {token: text} : {pairing: text};
}

async function sendJson(http, msg, cancellable = null) {
    const bytes = await http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    let body = null;
    try {
        body = JSON.parse(decoder.decode(bytes.toArray()));
    } catch {}
    return {status: msg.status_code, body};
}

export async function sessionState(http, url, token) {
    const msg = Soup.Message.new('GET', `${url}/api/auth/session`);
    msg.get_request_headers().append('Authorization', `Bearer ${token}`);
    const {status, body} = await sendJson(http, msg);
    if (status !== Soup.Status.OK || typeof body?.authenticated !== 'boolean')
        throw new T3Error(`${url} does not answer like T3 Code (HTTP ${status})`);
    return body;
}

async function exchangePairing(http, url, pairing) {
    const form = Object.entries({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: pairing,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: SCOPE,
        client_label: CLIENT_LABEL,
    }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    const msg = Soup.Message.new('POST', `${url}/oauth/token`);
    msg.set_request_body_from_bytes('application/x-www-form-urlencoded',
        new GLib.Bytes(encoder.encode(form)));
    const {status, body} = await sendJson(http, msg);
    if (status !== Soup.Status.OK || !body?.access_token)
        throw new T3Error('T3 did not accept the pairing link; create a new one');
    return body.access_token;
}

// Signs in to a server with what the user pasted. `address` (optional) wins over
// the host in a pairing link, which T3 prints with 127.0.0.1 unless it is told the
// public address. Returns {url, auth: {token, expiresAt}}.
export async function signIn(http, address, text) {
    const credential = parseCredential(text);
    let url = address?.trim() ? normalizeUrl(address) : null;
    if (!url && credential.url && !isLoopback(credential.url))
        url = credential.url;
    if (!url)
        throw new T3Error('enter the server\'s address');
    try {
        const token = credential.token ?? await exchangePairing(http, url, credential.pairing);
        const state = await sessionState(http, url, token);
        if (!state.authenticated)
            throw new T3Error('T3 did not accept this token');
        // A token with more rights (such as one issued without --scope, which can also
        // run a terminal) is refused rather than stored.
        const scopes = state.permissions ?? state.scopes ?? [];
        if (!scopes.includes(SCOPE))
            throw new T3Error(`the token lacks the ${SCOPE} scope`);
        if (scopes.some(scope => scope !== SCOPE))
            throw new T3Error(`the token has more rights than ${SCOPE}; issue one with --scope ${SCOPE}`);
        return {url, auth: {token, expiresAt: state.expiresAt ?? null}};
    } catch (e) {
        throw friendlyError(e);
    }
}

function updateServers(settings, change) {
    settings.set_string('servers', JSON.stringify(change(parseServers(settings.get_string('servers')))));
}

// Adds a server from the preferences' form. `name` defaults to the first part of
// the host name. Returns the new entry.
export async function addServer(settings, http, {name, address, credential}) {
    const {url, auth} = await signIn(http, address, credential);
    const id = GLib.uuid_string_random();
    await writeToken(id, auth);
    const server = {id, name: name?.trim() || GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host().split('.')[0], url};
    updateServers(settings, list => [...list, server]);
    return server;
}

// Signs in to a listed server again. Changing its entry makes the extension read
// the new token.
export async function renewServer(settings, http, server, credential) {
    const {auth} = await signIn(http, server.url, credential);
    await writeToken(server.id, auth);
    updateServers(settings, list =>
        list.map(s => (s.id === server.id ? {...s, signedIn: new Date().toISOString()} : s)));
}

export async function removeServer(settings, server) {
    updateServers(settings, list => list.filter(s => s.id !== server.id));
    await deleteToken(server.id);
}

function findT3Command() {
    const bundled = GLib.build_filenamev([T3_HOME, 'bin', 't3']);
    if (GLib.file_test(bundled, GLib.FileTest.IS_EXECUTABLE))
        return bundled;
    return GLib.find_program_in_path('t3');
}

export class T3Server {
    constructor(spec, http) {
        this.id = spec.id;
        this.name = spec.name;
        this.local = Boolean(spec.local);
        this._url = spec.url ?? null;
        this._http = http;
        this._cancellable = new Gio.Cancellable();
        this._pending = new Set();
        this._proc = null;
        this._auth = undefined;
        this._lastMint = 0;
        this._mintError = null;
    }

    // When the sign-in of a server added in the preferences runs out (null when
    // unknown or for this computer, which renews its own).
    get expiresAt() {
        return this.local ? null : this._auth?.expiresAt ?? null;
    }

    destroy() {
        this._cancellable.cancel();
        this._proc?.force_exit();
        // Settling a pending call closes its WebSocket and removes its timeout.
        for (const stop of [...this._pending])
            stop();
    }

    // method: 'server.getConfig' (the cached snapshot) or 'server.refreshProviders'
    // (the server checks every provider first). Both answer {providers, ...}.
    async call(method) {
        try {
            const origin = await this._origin();
            let auth = await this._loadAuth();
            try {
                return await this._rpc(origin, auth.token, method);
            } catch (e) {
                if (!(e instanceof AuthRejected))
                    throw e;
                this._auth = null;
                if (!this.local)
                    throw new T3Error('signed out; sign in again in Settings');
                await deleteToken(this.id);
                auth = await this._mint();
                return await this._rpc(origin, auth.token, method);
            }
        } catch (e) {
            throw friendlyError(e);
        }
    }

    async _origin() {
        if (this._url)
            return this._url;
        let runtime;
        try {
            runtime = await readJson(RUNTIME_FILE, this._cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            throw new T3Error('T3 is not running');
        }
        if (typeof runtime?.origin !== 'string' || !/^https?:\/\//.test(runtime.origin))
            throw new T3Error('T3\'s server-runtime.json has no address');
        return runtime.origin;
    }

    async _loadAuth() {
        if (this._auth === undefined)
            this._auth = await readToken(this.id, this._cancellable);
        const auth = this._auth;
        const expires = Date.parse(auth?.expiresAt ?? '');
        if (this.local) {
            if (auth && !(expires - Date.now() < RENEW_BEFORE_MS))
                return auth;
            try {
                return await this._mint();
            } catch (e) {
                // Renewal can wait while the old token still works.
                if (auth && expires > Date.now() && !isCancelled(e))
                    return auth;
                throw e;
            }
        }
        if (!auth)
            throw new T3Error('not signed in; sign in in Settings');
        if (expires <= Date.now())
            throw new T3Error('sign-in expired; sign in again in Settings');
        return auth;
    }

    // Issues a session for this computer's T3 through its `t3` command, which the
    // T3 Code desktop app installs in ~/.t3/bin.
    async _mint() {
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._lastMint && now - this._lastMint < MINT_RETRY_SECONDS)
            throw new T3Error(this._mintError ?? 'no valid token; a new one is requested every 30 min');
        this._lastMint = now;
        const t3 = findT3Command();
        if (!t3) {
            this._mintError = 'the t3 command was not found (it comes with T3 Code)';
            throw new T3Error(this._mintError);
        }
        const argv = [t3, 'auth', 'session', 'issue', '--base-dir', T3_HOME, '--scope', SCOPE,
            '--ttl', '180d', '--label', CLIENT_LABEL, '--json'];
        let stdout, stderr;
        let timedOut = false;
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._proc = proc;
        let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
            timer = 0;
            timedOut = true;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        try {
            [stdout, stderr] = await proc.communicate_utf8_async(null, this._cancellable);
        } finally {
            if (timer)
                GLib.source_remove(timer);
            this._proc = null;
        }
        if (timedOut) {
            this._mintError = `t3 did not answer in ${TIMEOUT_SECONDS} s`;
            throw new T3Error(this._mintError);
        }
        let issued = null;
        try {
            issued = JSON.parse(stdout ?? '');
        } catch {}
        if (!proc.get_successful() || !issued?.token) {
            const reason = (stderr ?? '').trim().split('\n').pop() || `exit ${proc.get_exit_status()}`;
            this._mintError = `t3 could not issue a token: ${reason}`;
            throw new T3Error(this._mintError);
        }
        this._auth = {token: issued.token, expiresAt: issued.expiresAt ?? null};
        this._mintError = null;
        await writeToken(this.id, this._auth);
        return this._auth;
    }

    async _ticket(origin, token) {
        const msg = Soup.Message.new('POST', `${origin}/api/auth/websocket-ticket/rpc`);
        msg.get_request_headers().append('Authorization', `Bearer ${token}`);
        const {status, body} = await sendJson(this._http, msg, this._cancellable);
        if (status === Soup.Status.UNAUTHORIZED)
            throw new AuthRejected('T3 rejected the token');
        if (status !== Soup.Status.OK)
            throw new T3Error(`T3 answered HTTP ${status} to the ticket request`);
        if (typeof body?.ticket !== 'string' || !body.ticket)
            throw new T3Error('T3 sent no WebSocket ticket');
        return body.ticket;
    }

    async _connect(origin, ticket) {
        const url = `${origin.replace(/^http/, 'ws')}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL}` +
            `&wsTicket=${encodeURIComponent(ticket)}`;
        const msg = Soup.Message.new('GET', url);
        try {
            return await this._http.websocket_connect_async(msg, null, null, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            if (msg.status_code === 426)
                throw new T3Error('this T3 Code version is not supported yet; update T3 AI Usage');
            throw e;
        }
    }

    async _rpc(origin, token, method) {
        const conn = await this._connect(origin, await this._ticket(origin, token));
        // The provider snapshot carries model lists and runs to a few hundred KB.
        conn.set_max_incoming_payload_size(0);

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
                timer = 0;
                finish(reject, new T3Error(`no answer to ${method} in ${TIMEOUT_SECONDS} s`));
                return GLib.SOURCE_REMOVE;
            });
            const finish = (settle, value) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    GLib.source_remove(timer);
                this._pending.delete(stop);
                if (conn.get_state() === Soup.WebsocketState.OPEN)
                    conn.close(Soup.WebsocketCloseCode.NORMAL, null);
                settle(value);
            };
            const stop = () => finish(reject, new T3Error('stopped'));
            this._pending.add(stop);
            conn.connect('message', (_conn, type, bytes) => {
                if (type !== Soup.WebsocketDataType.TEXT)
                    return;
                let messages;
                try {
                    messages = [].concat(JSON.parse(decoder.decode(bytes.toArray())));
                } catch {
                    finish(reject, new T3Error('T3 sent data that is not JSON'));
                    return;
                }
                for (const m of messages) {
                    if (m?._tag === 'Ping') {
                        conn.send_text(JSON.stringify({_tag: 'Pong'}));
                    } else if (m?._tag === 'Exit' && String(m.requestId) === '1') {
                        if (m.exit?._tag === 'Success')
                            finish(resolve, m.exit.value);
                        else
                            finish(reject, new T3Error(`${method} failed: ${describeCause(m.exit?.cause)}`));
                    } else if (m?._tag === 'Defect' || m?._tag === 'ClientProtocolError') {
                        finish(reject, new T3Error(`${method} failed: ${describeCause(m)}`));
                    }
                }
            });
            conn.connect('error', (_conn, error) => finish(reject, friendlyError(error)));
            conn.connect('closed', () => finish(reject, new T3Error('T3 closed the connection')));
            conn.send_text(JSON.stringify({_tag: 'Request', id: '1', tag: method, payload: {}, headers: []}));
        });
    }
}

export function makeHttpSession() {
    return new Soup.Session({timeout: TIMEOUT_SECONDS});
}
