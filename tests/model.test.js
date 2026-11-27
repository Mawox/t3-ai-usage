#!/usr/bin/env -S gjs -m
// Tests for the account and time logic in model.js: gjs -m tests/model.test.js

import GLib from 'gi://GLib';

const dir = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const model = await import(`file://${dir}/model.js`);

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
let failures = 0;
let count = 0;

function equal(actual, expected, name) {
    count++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        failures++;
        printerr(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
    }
}

const at = seconds => new Date(Date.now() + seconds * 1000).toISOString();

// A window of `total` seconds that resets in `remaining` seconds and, at its
// average rate so far, runs out in `exhaustIn` seconds.
function windowRunningOut(total, remaining, exhaustIn) {
    const elapsed = total - remaining;
    return {
        kind: 'weekly', windowDurationMins: total / 60, resetsAt: at(remaining),
        usedPercent: (100 * elapsed) / (elapsed + exhaustIn),
    };
}

// Durations
equal(model.longDuration(15 * HOUR + 59 * MIN, true), '16 h', 'rounds 15 h 59 min to 16 h');
equal(model.longDuration(4 * DAY + 11 * HOUR, true), '4 d', 'rounds 4 d 11 h to 4 d');
equal(model.longDuration(4 * DAY + 13 * HOUR, true), '5 d', 'rounds 4 d 13 h to 5 d');
equal(model.longDuration(23 * HOUR + 40 * MIN, true), '1 d', 'rounds 23 h 40 min to 1 d');
equal(model.longDuration(4 * DAY + 11 * HOUR, false), '4 d 11 h', 'keeps two units unrounded');
equal(model.longDuration(2 * HOUR, false), '2 h', 'drops a zero second unit');
equal(model.longDuration(20, false), '1 min', 'shows at least a minute');
equal(model.compactReset(at(4 * DAY + 11 * HOUR + 30), false), '4d11h', 'compact reset');
equal(model.compactReset(at(-5)), 'now', 'a passed reset is now');
equal(model.shortReset(at(3 * HOUR + 40 * MIN + 30), true), '↻ 4 h', 'short reset, rounded');
equal(model.shortReset(at(-5)), '↻ now', 'a passed reset shows now');

// Pace: the run-out time and the time before the reset add up to the reset shown.
const reported = windowRunningOut(7 * DAY, 4.4 * DAY, 2.6 * DAY);
equal(model.paceWarning(model.pace(reported), true), 'Runs out in 3 d, 1 d before the reset',
    'rounded pace adds up to the rounded reset');
equal(model.paceWarning(model.pace(reported), false), 'Runs out in 2 d 14 h, 1 d 19 h before the reset',
    'unrounded pace adds up to the unrounded reset');
equal(model.paceWarning(model.pace(windowRunningOut(7 * DAY, 4.4 * DAY, 3.6 * DAY)), true),
    'Runs out 19 h before the reset', 'gives only the lockout when both round to the reset');
equal(model.paceWarning(model.pace(windowRunningOut(7 * DAY, 4.4 * DAY, 23 * HOUR)), true),
    'Runs out in 23 h, 3 d before the reset', 'mixed units');

const steady = {kind: 'weekly', windowDurationMins: 7 * 24 * 60, resetsAt: at(3.5 * DAY), usedPercent: 25};
equal(model.paceWarning(model.pace(steady)), null, 'no warning for a pace that leaves room');
equal(model.paceWarning(model.pace({...steady, usedPercent: 46})), 'On pace for 8 % left at the reset', 'a pace that nearly uses it up');
equal(Math.round(model.pace(steady).expected), 50, 'expected share used halfway through');
equal(model.paceWarning(model.pace({...steady, usedPercent: 100})), 'Limit reached', 'full window');
equal(model.pace({kind: 'weekly', resetsAt: at(DAY), usedPercent: 10}), null, 'no pace without a window length');
equal(model.pace({...steady, usedPercent: 0}).projected, undefined, 'no projection before any use');
equal(model.pace(windowRunningOut(7 * DAY, 4 * DAY, DAY)).level, 'crit', 'long lockout is critical');
equal(model.pace(windowRunningOut(7 * DAY, 4 * DAY, 3.5 * DAY)).level, 'warn', 'short lockout is a warning');

const monthly = {kind: 'monthly', resetsAt: at(10 * DAY), usedPercent: 50};
equal(model.pace(monthly) !== null, true, 'a monthly window without a length spans a calendar month');

// Windows
equal(model.effectivePercent({usedPercent: 80, resetsAt: at(-60)}), 0, 'a window past its reset is empty');
equal(model.effectivePercent({usedPercent: 130, resetsAt: at(60)}), 100, 'clamps to 100');
const later = {id: 'b', usedPercent: 70, resetsAt: at(2 * DAY)};
equal(model.bindingWindow([{id: 'a', usedPercent: 70, resetsAt: at(DAY)}, later, {id: 'c', usedPercent: 20}]).w.id, 'b',
    'on a tie the window that resets later binds');
equal(model.level(74), 'ok', 'level ok');
equal(model.level(75), 'warn', 'level warn');
equal(model.level(90), 'crit', 'level crit');
equal(model.isFable({id: 'seven_day_fable', label: 'Weekly · Fable'}), true, 'Fable window');
equal(model.isFable({id: 'seven_day', label: 'Weekly'}), false, 'not a Fable window');
equal(model.windowKey('codex:a@b', model.windowId({label: 'Weekly'})), 'codex:a@b|Weekly', 'window key falls back to the label');

// Accounts
equal(model.defaultLabel('Codex Work', 'codex'), 'CW', 'initials of a multi-word name');
equal(model.defaultLabel('Codex', 'codex'), 'Cx', 'driver label for a one-word name');
equal(model.defaultLabel('MA', 'claudeAgent'), 'MA', 'short names stay');

const provider = (instanceId, checkedAgo, extra = {}) => ({
    instanceId, driver: 'codex', displayName: 'Codex', enabled: true,
    auth: {email: 'a@example.com', label: 'Pro'},
    usageLimits: {checkedAt: at(-checkedAgo), windows: [{id: 'primary', usedPercent: 10, resetsAt: at(HOUR)}]},
    ...extra,
});
const merged = model.collectAccounts([
    {env: {id: 'local', name: 'laptop'}, providers: [provider('codex', 600)], accents: {codex: '#123456'}},
    {env: {id: 'hub', name: 'hub'}, providers: [provider('codex', 30), provider('off', 0, {enabled: false})]},
]);
equal(merged.length, 1, 'the same login on two servers is one account');
equal(merged[0].sources, ['laptop', 'hub'], 'both servers are listed');
equal(Math.round(model.secondsSince(merged[0].checkedAt)) <= 31, true, 'the fresher snapshot wins');
equal(merged[0].accent, '#123456', 'keeps the accent colour');

const noEmail = (instanceId, fingerprint) => ({
    instanceId, driver: 'antigravity', displayName: 'Antigravity', enabled: true, auth: {label: 'Google account'},
    usageLimits: {checkedAt: at(-60), credentialFingerprint: fingerprint, windows: [{id: '3p-weekly', usedPercent: 5}]},
});
const antigravity = model.collectAccounts([
    {env: {id: 'local', name: 'laptop'}, providers: [noEmail('antigravity', 'aaaa')]},
    {env: {id: 'hub', name: 'hub'}, providers: [noEmail('antigravity', 'bbbb')]},
]);
equal(antigravity.map(a => a.key), ['antigravity:name:Antigravity'],
    'an account without an e-mail goes by driver and name, not the fingerprint, and merges across servers');
equal(antigravity[0].instances, ['local|antigravity', 'hub|antigravity'], 'remembers the provider on each server');

// Remembered accounts. The situation of 27 Nov 2026: keys that changed over time.
const TODAY = '2026-11-27';
const servers = [{id: 'local', name: 'This computer'}, {id: 'hub', name: 'hub'}, {id: 'nas', name: 'nas'}];
const p = (instanceId, driver, displayName, email, extra = {}) => ({
    instanceId, driver, displayName, enabled: true, auth: email ? {email, workspaceId: 'ws1', label: 'Pro'} : {},
    usageLimits: email ? {checkedAt: at(-60), windows: [{id: 'primary', label: 'Weekly', usedPercent: 5}]} : null,
    ...extra,
});
const localProviders = [p('codex', 'codex', 'Codex', 'a@x'), p('antigravity', 'antigravity', 'Antigravity'),
    p('muse', 'muse', 'Muse Code', null, {enabled: false})];
const hubProviders = [p('codex', 'codex', 'Codex', 'a@x'), p('claude_scio', 'claudeAgent', 'Claude-post', 'b@x'),
    p('antigravity', 'antigravity', 'Antigravity')];
const answered = new Map([['local', localProviders], ['hub', hubProviders]]);
const now = model.collectAccounts([
    {env: servers[0], providers: localProviders},
    {env: servers[1], providers: hubProviders},
]);
const legacy = (key, name, driver, sources, lastSeen, windows = []) => ({key, name, driver, plan: '', sources, lastSeen, windows});
const known = [
    legacy('codex:a@x:ws1', 'Codex', 'codex', ['This computer', 'hub'], '2026-11-26'),
    legacy('codex:a@x', 'Codex', 'codex', ['This computer'], '2026-11-05'),
    legacy('claudeAgent:scio@x:ws1', 'Claude Scio', 'claudeAgent', ['hub'], '2026-11-14'),
    legacy('antigravity:fp:old', 'Antigravity', 'antigravity', ['hub'], '2026-11-15', [{id: '3p-5h', label: '5h'}]),
    legacy('antigravity:fp:new', 'Antigravity', 'antigravity', ['hub'], '2026-11-26', [{id: '3p-5h', label: '5h'}]),
    legacy('antigravity:fp:laptop', 'Antigravity', 'antigravity', ['This computer'], '2026-11-11'),
    legacy('muse:x', 'Muse Code', 'muse', ['This computer'], '2026-11-12'),
    legacy('kiro:x', 'Kiro', 'kiro', ['nas'], '2026-11-20'),
    legacy('gone:x', 'Gone', 'codex', ['old server'], '2026-11-20'),
    legacy('expired:x', 'Codex', 'codex', ['hub'], '2026-10-20'),
];
const first = model.reconcileAccounts(known, now, servers, answered, TODAY);
const keys = r => r.known.map(k => k.key);
equal(keys(first), ['codex:a@x:ws1', 'antigravity:fp:new', 'antigravity:fp:laptop', 'kiro:x', 'claudeAgent:b@x:ws1'],
    'drops replaced keys, renamed and switched-off providers, removed servers and old entries');
equal(first.known.find(k => k.key === 'codex:a@x:ws1').instances, ['local|codex', 'hub|codex'], 'current accounts record their providers');
equal(first.known.find(k => k.key === 'antigravity:fp:new').instances, ['hub|antigravity'],
    'an old entry learns its provider once its servers answer');
equal(first.known.find(k => k.key === 'kiro:x').instances, ['nas|?'], 'an entry waits for a server that did not answer');
equal([first.fresh.map(a => a.key), [...first.inherited]], [['claudeAgent:b@x:ws1'], []], 'a new login is fresh');

// Antigravity reports again, under its new key: it follows the entry seen last.
const withLimits = list => list.map(x => (x.driver === 'antigravity'
    ? {...x, usageLimits: {checkedAt: at(-60), windows: [{id: '3p-weekly', label: 'Weekly', usedPercent: 5}]}} : x));
const answered2 = new Map([['local', withLimits(localProviders)], ['hub', withLimits(hubProviders)]]);
const now2 = model.collectAccounts([
    {env: servers[0], providers: answered2.get('local')},
    {env: servers[1], providers: answered2.get('hub')},
]);
const second = model.reconcileAccounts(first.known, now2, servers, answered2, TODAY);
equal([...second.inherited], [['antigravity:name:Antigravity', 'antigravity:fp:new']], 'a new key follows the account it replaces');
equal(keys(second), ['codex:a@x:ws1', 'kiro:x', 'claudeAgent:b@x:ws1', 'antigravity:name:Antigravity'],
    'the replaced entries are dropped');
equal(second.known.at(-1).windows.map(w => w.id), ['3p-weekly', '3p-5h'], 'keeps the windows of the account it follows');
equal(second.fresh, [], 'nothing fresh');

const fable = model.reconcileAccounts([], [{...now[0], windows: [{id: 'seven_day_fable', label: 'Weekly · Fable'}]}],
    servers, answered, TODAY);
equal(fable.hide, [`${now[0].key}|seven_day_fable`], 'a Fable window seen for the first time is hidden');
equal(model.reconcileAccounts(first.known, [], servers, new Map(), TODAY).known.length, 5,
    'nothing is dropped when no server answered');

// Only the laptop answers.
const laptopOnly = new Map([['local', answered2.get('local')]]);
const nowLaptop = model.collectAccounts([{env: servers[0], providers: answered2.get('local')}]);
const twoServers = legacy('antigravity:fp:both', 'Antigravity', 'antigravity', ['This computer', 'hub'], '2026-11-26');
const partial = model.reconcileAccounts([twoServers], nowLaptop, servers, laptopOnly, TODAY);
equal([...partial.inherited], [['antigravity:name:Antigravity', 'antigravity:fp:both']],
    'an old entry follows on a server that answered while another did not');
equal(partial.known.filter(k => k.driver === 'antigravity').map(k => [k.key, k.instances]),
    [['antigravity:name:Antigravity', ['local|antigravity', 'hub|?']]], 'replaces it, still waiting for the other server');
const keepsHub = model.reconcileAccounts(second.known, nowLaptop, servers, laptopOnly, TODAY);
equal(keepsHub.known.find(k => k.key === 'codex:a@x:ws1').instances, ['local|codex', 'hub|codex'],
    'a server that did not answer keeps its providers');
equal(model.reconcileAccounts(second.known, [], servers, new Map([['local', []], ['hub', []]]), TODAY).known.length, 4,
    'a server that answers with no providers at all counts as not answering');

const otherLogin = model.collectAccounts([{env: servers[0], providers: [p('codex', 'codex', 'Codex', 'c@x')]}]);
const switched = model.reconcileAccounts([legacy('codex:a@x', 'Codex', 'codex', ['This computer'], '2026-11-20')],
    otherLogin, servers, new Map([['local', [p('codex', 'codex', 'Codex', 'c@x')]]]), TODAY);
equal([switched.fresh.map(a => a.key), switched.known.map(k => k.key)], [['codex:c@x:ws1'], ['codex:c@x:ws1']],
    'another login in the same provider starts afresh');

const twins = model.collectAccounts([{env: servers[0], providers: [noEmail('agA', 'x'), noEmail('agB', 'y')]}]);
equal(twins.map(a => a.key), ['antigravity:instance:agA:Antigravity', 'antigravity:instance:agB:Antigravity'],
    'two providers of one name on one server stay two accounts');
const twinGone = model.reconcileAccounts(model.reconcileAccounts([], twins, servers,
    new Map([['local', [noEmail('agA', 'x'), noEmail('agB', 'y')]]]), TODAY).known,
model.collectAccounts([{env: servers[0], providers: [noEmail('agB', 'y')]}]), servers,
new Map([['local', [noEmail('agB', 'y')]]]), TODAY);
equal([[...twinGone.inherited], twinGone.known.map(k => k.key)],
    [[['antigravity:name:Antigravity', 'antigravity:instance:agB:Antigravity']], ['antigravity:name:Antigravity']],
    'when one of them goes, the other keeps its own settings under the plain key');

const renamed = model.reconcileAccounts(twinGone.known,
    model.collectAccounts([{env: servers[0], providers: [{...noEmail('agB', 'y'), displayName: 'Gemini'}]}]), servers,
    new Map([['local', [{...noEmail('agB', 'y'), displayName: 'Gemini'}]]]), TODAY);
equal([...renamed.inherited], [['antigravity:name:Gemini', 'antigravity:name:Antigravity']], 'a renamed provider keeps its settings');

const ws2 = [{...p('codex', 'codex', 'Codex', 'a@x'), auth: {email: 'a@x', workspaceId: 'ws2', label: 'Team'}}];
const workspace = model.reconcileAccounts(second.known, model.collectAccounts([{env: servers[0], providers: ws2},
    {env: servers[1], providers: ws2}]), servers, new Map([['local', ws2], ['hub', ws2]]), TODAY);
equal([workspace.fresh.map(a => a.key), [...workspace.inherited]], [['codex:a@x:ws2'], []],
    'another workspace of the same login starts afresh');

const fp = model.reconcileAccounts([legacy('antigravity:fp:bbbb', 'Antigravity', 'antigravity', ['hub'], '2026-11-20'),
    legacy('antigravity:fp:aaaa', 'Antigravity', 'antigravity', ['hub'], '2026-11-21')],
model.collectAccounts([{env: servers[1], providers: [noEmail('agA', 'aaaa'), noEmail('agB', 'bbbb')]}]), servers,
new Map([['hub', [noEmail('agA', 'aaaa'), noEmail('agB', 'bbbb')]]]), TODAY);
equal([...fp.inherited], [['antigravity:instance:agA:Antigravity', 'antigravity:fp:aaaa'],
    ['antigravity:instance:agB:Antigravity', 'antigravity:fp:bbbb']], 'old fingerprint keys find their own provider');
const oldInstanceKey = model.reconcileAccounts([legacy('hub:gone', 'Antigravity', 'antigravity', ['hub'], '2026-11-20')],
    [], servers, answered2, TODAY);
equal(oldInstanceKey.known, [], 'an old instance key does not pass to a provider of the same name');
const twinServers = [{id: 'local', name: 'box'}, {id: 'hub', name: 'box'}];
const ownServer = model.reconcileAccounts([legacy('local:gone', 'Antigravity', 'antigravity', ['box'], '2026-11-20')],
    [], twinServers, new Map([['local', localProviders], ['hub', hubProviders]]), TODAY);
equal(ownServer.known, [], 'an old instance key stays with its own server when two share a name');

const unsupported = model.reconcileAccounts([legacy('opencode:name:OC', 'OC', 'opencode', ['This computer'], '2026-11-20')], [], servers,
    new Map([['local', [{instanceId: 'oc', driver: 'opencode', displayName: 'OC', enabled: true,
        usageLimits: {unavailable: {reason: 'unsupported'}}}]]]), TODAY);
equal(unsupported.known, [], 'a provider T3 reports as unsupported does not keep an account');

const pending = {...noEmail('agA', 'x'), usageLimits: null};
equal(model.collectAccounts([{env: servers[0], providers: [pending, noEmail('agB', 'y')]}]).map(a => a.key),
    ['antigravity:instance:agB:Antigravity'], 'a second provider keeps its key while the first has no limits');

const hubWaiting = new Map([['local', answered2.get('local')],
    ['hub', answered2.get('hub').map(x => (x.instanceId === 'codex' ? {...x, usageLimits: null} : x))]]);
const nowWaiting = model.collectAccounts([...hubWaiting].map(([id, list]) => ({env: servers.find(x => x.id === id), providers: list})));
equal(model.reconcileAccounts(second.known, nowWaiting, servers, hubWaiting, TODAY).known
    .find(k => k.key === 'codex:a@x:ws1').instances, ['local|codex', 'hub|codex'],
'a provider T3 runs without limits yet stays with the account');

const twoClaudes = [p('claude_1', 'claudeAgent', 'Claude', 'a@x'), {...p('claude_2', 'claudeAgent', 'Claude', 'b@x'), usageLimits: null}];
const resolved = model.reconcileAccounts([legacy('claudeAgent:b@x', 'Claude', 'claudeAgent', ['This computer'], '2026-11-20')],
    model.collectAccounts([{env: servers[0], providers: twoClaudes}]), servers, new Map([['local', twoClaudes]]), TODAY);
equal(resolved.known.find(k => k.key === 'claudeAgent:b@x')?.instances, ['local|claude_2'],
    'an old entry finds its provider by e-mail among providers of the same name');

const sameDay = model.reconcileAccounts([
    legacy('antigravity:fp:older', 'Antigravity', 'antigravity', ['hub'], '2026-11-26', [{id: 'a', label: 'a'}]),
    legacy('antigravity:fp:newer', 'Antigravity', 'antigravity', ['hub'], '2026-11-26', [{id: 'b', label: 'b'}]),
], now2.filter(a => a.driver === 'antigravity'), servers, answered2, TODAY);
equal([...sameDay.inherited], [['antigravity:name:Antigravity', 'antigravity:fp:newer']], 'on the same day the one saved later wins');

const order = model.applyOrder([{key: 'a'}, {key: 'b'}, {key: 'c'}], ['c', 'a']).map(x => x.key);
equal(order, ['c', 'a', 'b'], 'saved order first, unknown keys after');

equal(model.serverDown(null, false, null), false, 'a server that answered is up');
equal(model.serverDown('T3 is not running', true, 2 * MIN), false, 'no answer soon after the last one is not reported');
equal(model.serverDown('T3 is not running', true, model.SERVER_GRACE_SECONDS), false, 'the grace period includes its end');
equal(model.serverDown('T3 is not running', true, 6 * MIN), true, 'no answer past the grace period is reported');
equal(model.serverDown('T3 is not running', true, null), true, 'a server that never answered is reported at once');
equal(model.serverDown('T3 is not running', true, -10 * MIN), true, 'a clock set back does not extend the grace period');
equal(model.serverDown('signed out; sign in again in Settings', false, 1 * MIN), true, 'an error that needs the user is reported at once');

print(`${count - failures} of ${count} passed`);
if (failures)
    imports.system.exit(1);
