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
equal(model.relativeReset(at(3 * HOUR + 40 * MIN + 30), true), 'resets in 4 h', 'relative reset, rounded');

// Pace: the run-out time and the time before the reset add up to the reset shown.
const reported = windowRunningOut(7 * DAY, 4.4 * DAY, 2.6 * DAY);
equal(model.paceText(model.pace(reported), true), 'On pace to run out in 3 d, 1 d before the reset',
    'rounded pace adds up to the rounded reset');
equal(model.paceText(model.pace(reported), false), 'On pace to run out in 2 d 14 h, 1 d 19 h before the reset',
    'unrounded pace adds up to the unrounded reset');
equal(model.paceText(model.pace(windowRunningOut(7 * DAY, 4.4 * DAY, 3.6 * DAY)), true),
    'On pace to run out 19 h before the reset', 'gives only the lockout when both round to the reset');
equal(model.paceText(model.pace(windowRunningOut(7 * DAY, 4.4 * DAY, 23 * HOUR)), true),
    'On pace to run out in 23 h, 3 d before the reset', 'mixed units');

const steady = {kind: 'weekly', windowDurationMins: 7 * 24 * 60, resetsAt: at(3.5 * DAY), usedPercent: 25};
equal(model.paceText(model.pace(steady)), 'On pace for 50 % left at the reset', 'projection under the limit');
equal(Math.round(model.pace(steady).expected), 50, 'expected share used halfway through');
equal(model.paceText(model.pace({...steady, usedPercent: 100})), 'Limit reached', 'full window');
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

const order = model.applyOrder([{key: 'a'}, {key: 'b'}, {key: 'c'}], ['c', 'a']).map(x => x.key);
equal(order, ['c', 'a', 'b'], 'saved order first, unknown keys after');

print(`${count - failures} of ${count} passed`);
if (failures)
    imports.system.exit(1);
