#!/usr/bin/env -S gjs -m
// A stand-in for a T3 Code server with sample accounts, for headless test runs and
// screenshots. It speaks the parts of T3's API the extension uses: the session and
// token-exchange endpoints, WebSocket tickets and the `server.getConfig` RPC.
//
//   gjs -m tests/mock-t3.js [--port 3999] [--base-dir DIR] [--protocol 2]
//
// --base-dir writes DIR/userdata/server-runtime.json, so the extension finds the
// mock as "this computer" when HOME points at DIR's parent and DIR is ~/.t3.
// Accepted bearer tokens: `local-demo-token` (what tests/fake-t3 issues),
// `remote-demo-token`, and `admin-demo-token`, which has more scopes than reading.
// The pairing code `DEMOPAIRING1` exchanges for a new read-only token.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const args = {};
for (let i = 0; i < ARGV.length; i += 2)
    args[ARGV[i].replace(/^--/, '')] = ARGV[i + 1];
const PORT = Number(args.port ?? 3999);
const PROTOCOL = String(args.protocol ?? 2);
const PAIRING = 'DEMOPAIRING1';
const DAY = 864e5;

const tokens = new Map([
    ['local-demo-token', Date.now() + 180 * DAY],
    ['remote-demo-token', Date.now() + 5 * DAY],
    ['admin-demo-token', Date.now() + 5 * DAY],
]);
const ADMIN_SCOPES = ['orchestration:read', 'orchestration:operate', 'terminal:operate', 'access:write'];
const tickets = new Set();
const decoder = new TextDecoder();

const iso = ms => new Date(ms).toISOString();
const inMinutes = mins => iso(Date.now() + mins * 60e3);

function window(id, kind, label, usedPercent, resetMins, windowDurationMins) {
    return {id, kind, label, usedPercent, resetsAt: inMinutes(resetMins), ...(windowDurationMins ? {windowDurationMins} : {})};
}

function provider(instanceId, driver, displayName, plan, email, windows) {
    return {
        instanceId, driver, displayName, enabled: true,
        auth: {status: 'authenticated', email, label: plan},
        usageLimits: {checkedAt: iso(Date.now() - 60e3), windows},
    };
}

function snapshot() {
    return {
        providers: [
            provider('claudeAgent', 'claudeAgent', 'Claude', 'Claude Max', 'ada@example.com', [
                window('five_hour', 'session', 'Session', 38, 130, 300),
                window('seven_day', 'weekly', 'Weekly', 61, 3 * 1440 + 200, 10080),
                window('seven_day_fable', 'weekly', 'Weekly · Fable', 4, 3 * 1440 + 200, 10080),
            ]),
            provider('claudeAgent_work', 'claudeAgent', 'Claude Work', 'Claude Team', 'ada@work.example', [
                window('seven_day', 'weekly', 'Weekly', 86, 2 * 1440 + 300, 10080),
            ]),
            provider('codex', 'codex', 'Codex', 'ChatGPT Pro', 'ada@example.com', [
                window('primary', 'session', 'Session', 22, 190, 300),
                window('secondary', 'weekly', 'Weekly', 47, 4 * 1440 + 90, 10080),
            ]),
            provider('cursor', 'cursor', 'Cursor', 'Cursor Pro', 'ada@example.com', [
                window('apiPercentUsed', 'monthly', 'Other Models', 56, 12 * 1440),
                window('autoPercentUsed', 'monthly', 'Cursor Models', 12, 12 * 1440),
                window('totalPercentUsed', 'monthly', 'Overall', 18, 12 * 1440),
            ]),
        ],
        settings: {
            providerInstances: {
                claudeAgent: {accentColor: '#e0895a'},
                claudeAgent_work: {accentColor: '#b48cf2'},
                codex: {accentColor: '#4fb3a9'},
            },
        },
    };
}

function bearer(msg) {
    const header = msg.get_request_headers().get_one('Authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    return (tokens.get(token) ?? 0) > Date.now() ? token : null;
}

function reply(msg, status, body) {
    msg.set_status(status, null);
    msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(JSON.stringify(body)));
}

const server = new Soup.Server();

server.add_handler('/api/auth/websocket-ticket/rpc', (_server, msg) => {
    if (!bearer(msg)) {
        reply(msg, 401, {error: 'unauthorized'});
        return;
    }
    const ticket = GLib.uuid_string_random();
    tickets.add(ticket);
    reply(msg, 200, {ticket});
});

server.add_handler('/api/auth/session', (_server, msg) => {
    const token = bearer(msg);
    const scopes = token === 'admin-demo-token' ? ADMIN_SCOPES : ['orchestration:read'];
    reply(msg, 200, token
        ? {authenticated: true, scopes, permissions: scopes, expiresAt: iso(tokens.get(token))}
        : {authenticated: false});
});

server.add_handler('/oauth/token', (_server, msg) => {
    const form = GLib.Uri.parse_params(decoder.decode(msg.get_request_body().flatten().toArray()), -1, '&',
        GLib.UriParamsFlags.WWW_FORM);
    if (form.subject_token !== PAIRING || form.scope !== 'orchestration:read') {
        reply(msg, 400, {error: 'invalid_grant'});
        return;
    }
    const token = `paired-${GLib.uuid_string_random()}`;
    tokens.set(token, Date.now() + 30 * DAY);
    reply(msg, 200, {access_token: token, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer', expires_in: 30 * 86400, scope: 'orchestration:read'});
});

// T3 refuses clients of another protocol version with 426 before the upgrade.
server.add_early_handler('/ws', (_server, msg) => {
    const query = GLib.Uri.parse_params(msg.get_uri().get_query() ?? '', -1, '&', GLib.UriParamsFlags.NONE);
    if (query.orchestrationProtocol !== PROTOCOL)
        reply(msg, 426, {error: 'orchestration_protocol_incompatible'});
    else if (!tickets.delete(query.wsTicket))
        reply(msg, 401, {error: 'invalid ticket'});
});

server.add_websocket_handler('/ws', null, null, (_server, _msg, _path, conn) => {
    conn.set_max_incoming_payload_size(0);
    conn.connect('message', (_conn, _type, bytes) => {
        const request = JSON.parse(decoder.decode(bytes.toArray()));
        if (request._tag !== 'Request')
            return;
        const known = ['server.getConfig', 'server.refreshProviders'].includes(request.tag);
        conn.send_text(JSON.stringify({
            _tag: 'Exit',
            requestId: request.id,
            exit: known
                ? {_tag: 'Success', value: snapshot()}
                : {_tag: 'Failure', cause: {message: `unknown method ${request.tag}`}},
        }));
    });
});

server.listen_local(PORT, Soup.ServerListenOptions.IPV4_ONLY);
const origin = `http://127.0.0.1:${PORT}`;
if (args['base-dir']) {
    const dir = GLib.build_filenamev([args['base-dir'], 'userdata']);
    GLib.mkdir_with_parents(dir, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([dir, 'server-runtime.json']), JSON.stringify({origin}));
}
print(`mock T3 listening on ${origin}`);
new GLib.MainLoop(null, false).run();
