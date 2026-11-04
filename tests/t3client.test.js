#!/usr/bin/env -S gjs -m
// Tests t3client.js against tests/mock-t3.js: addresses and credentials, signing
// in, adding, renewing and removing servers (with the extension's settings schema
// in memory), and this computer's token: gjs -m tests/t3client.test.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const repo = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const work = GLib.dir_make_tmp('t3-ai-usage-test-XXXXXX');
const [gjs, compileSchemas, rm] = ['gjs', 'glib-compile-schemas', 'rm'].map(name => GLib.find_program_in_path(name));
// Tokens and ~/.t3 go to the temporary directory, and no real `t3` is found; set
// before t3client.js reads them.
GLib.setenv('XDG_CONFIG_HOME', work, true);
GLib.setenv('HOME', work, true);
GLib.setenv('PATH', '/nonexistent', true);
const t3 = await import(`file://${repo}/t3client.js`);

const PORT = 3990;
const URL = `http://127.0.0.1:${PORT}`;
let failures = 0;
let count = 0;

function check(ok, name, detail = '') {
    count++;
    if (!ok) {
        failures++;
        printerr(`FAIL ${name} ${detail}`);
    }
}

async function rejects(promise, name) {
    try {
        await promise;
        check(false, name, '(did not fail)');
    } catch (e) {
        check(e instanceof t3.T3Error, name, e.message);
    }
}

function makeSettings() {
    const schemas = GLib.build_filenamev([work, 'schemas']);
    GLib.mkdir_with_parents(schemas, 0o700);
    Gio.File.new_for_path(`${repo}/schemas/org.gnome.shell.extensions.t3-ai-usage.gschema.xml`)
        .copy(Gio.File.new_for_path(`${schemas}/org.gnome.shell.extensions.t3-ai-usage.gschema.xml`), 0, null, null);
    Gio.Subprocess.new([compileSchemas, schemas], 0).wait_check(null);
    const source = Gio.SettingsSchemaSource.new_from_directory(schemas, null, false);
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.t3-ai-usage', false),
        backend: Gio.memory_settings_backend_new(),
    });
}

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

const mock = Gio.Subprocess.new([gjs, '-m', `${repo}/tests/mock-t3.js`, '--port', String(PORT),
    '--base-dir', `${work}/.t3`], Gio.SubprocessFlags.STDOUT_SILENCE);
await wait(1500);

// Addresses and credentials
check(t3.normalizeUrl('https://hub.example.ts.net/') === 'https://hub.example.ts.net', 'drops a trailing slash');
check(t3.normalizeUrl('http://[fd7a:115c::1]:3773') === 'http://[fd7a:115c::1]:3773', 'keeps IPv6 brackets');
check(t3.normalizeUrl('https://proxy.example/t3/') === 'https://proxy.example/t3', 'keeps a sub-path');
check(t3.parseCredential('https://proxy.example/t3/pair#token=ABC').url === 'https://proxy.example/t3', 'pairing link under a sub-path');
check(t3.parseCredential('t3code://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A3773%2Fpair%23token%3DXYZ').pairing === 'XYZ', 'app link');

try {
    const settings = makeSettings();
    settings.set_boolean('local-server', false);
    const http = t3.makeHttpSession();

    await rejects(t3.addServer(settings, http, {address: URL, credential: 'WRONGCODE123'}), 'a bad pairing code fails');
    check(t3.parseServers(settings.get_string('servers')).length === 0, 'a failed sign-in adds nothing');

    const hub = await t3.addServer(settings, http,
        {name: 'hub', address: URL, credential: `${URL}/pair#token=DEMOPAIRING1`});
    const servers = t3.parseServers(settings.get_string('servers'));
    check(servers.length === 1 && servers[0].name === 'hub' && servers[0].url === URL, 'adds the server', JSON.stringify(servers));
    check(Boolean((await t3.readToken(hub.id))?.token), 'stores its token');

    const specs = t3.serverSpecs(settings);
    check(specs.length === 1 && !specs[0].local, 'reads only the added server when this computer is off');
    const config = await new t3.T3Server(specs[0], http).call('server.getConfig');
    check(config.providers?.length === 4, 'reads the limits with the stored token');

    const named = await t3.addServer(settings, http, {address: `http://localhost:${PORT}`, credential: '{"token": "remote-demo-token"}'});
    check(named.name === 'localhost', 'names a server after its host', named.name);
    await t3.removeServer(settings, named);

    await t3.renewServer(settings, http, hub, '{"token": "remote-demo-token"}');
    const renewed = t3.parseServers(settings.get_string('servers'))[0];
    check(Boolean(renewed.signedIn), 'signing in again touches the entry');
    check((await t3.readToken(hub.id))?.token === 'remote-demo-token', 'and replaces the token');

    await t3.removeServer(settings, hub);
    check(t3.parseServers(settings.get_string('servers')).length === 0, 'removes the server');
    check((await t3.readToken(hub.id)) === null, 'and its token');

    await rejects(t3.addServer(settings, http, {address: URL, credential: '{"token": "admin-demo-token"}'}),
        'refuses a token with more rights than reading');

    settings.set_boolean('local-server', true);
    const local = t3.serverSpecs(settings)[0];
    check(local?.local === true, 'this computer comes first when on');
    // Its token is due for renewal, and no `t3` command is found: the old token is used.
    await t3.writeToken('local', {token: 'local-demo-token', expiresAt: new Date(Date.now() + 12 * 3600e3).toISOString()});
    const localConfig = await new t3.T3Server(local, http).call('server.getConfig');
    check(localConfig.providers?.length === 4, 'keeps a valid token when renewal fails');
    await t3.writeToken('local', {token: 'local-demo-token', expiresAt: new Date(Date.now() - 60e3).toISOString()});
    await rejects(new t3.T3Server(local, http).call('server.getConfig'), 'an expired token without t3 fails');
} finally {
    mock.force_exit();
    Gio.Subprocess.new([rm, '-rf', work], 0).wait(null);
}

print(`${count - failures} of ${count} passed`);
if (failures)
    imports.system.exit(1);
