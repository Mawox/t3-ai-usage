// Accounts and formatting shared by the extension and its preferences.

import GLib from 'gi://GLib';

const DRIVER_LABELS = {claudeAgent: 'Cl', codex: 'Cx', cursor: 'Cu', antigravity: 'AG', grok: 'Gk', opencode: 'OC'};
const DRIVER_ORDER = ['claudeAgent', 'codex'];
// Accounts of these drivers go to the top bar when they first appear; the rest
// only to the menu until switched on in the preferences.
export const PANEL_DEFAULT_DRIVERS = ['claudeAgent', 'codex'];

export function defaultLabel(name, driver) {
    if (name.length <= 3)
        return name;
    const words = name.trim().split(/\s+/);
    if (words.length > 1)
        return words.map(w => w[0]).join('').slice(0, 3).toUpperCase();
    return DRIVER_LABELS[driver] ?? name.slice(0, 2);
}

// The same login can run on several T3 servers (laptop and hub). T3's credential
// fingerprint, or else e-mail plus workspace, identifies it across them.
function accountKey(envId, p) {
    const fingerprint = p.usageLimits?.credentialFingerprint;
    if (fingerprint)
        return `${p.driver}:fp:${fingerprint.slice(0, 16)}`;
    if (p.auth?.email)
        return [p.driver, p.auth.email, p.auth.workspaceId].filter(Boolean).join(':');
    return `${envId}:${p.instanceId}`;
}

export function secondsUntil(iso) {
    const t = Date.parse(iso ?? '');
    return Number.isNaN(t) ? null : (t - Date.now()) / 1000;
}

export function secondsSince(iso) {
    const s = secondsUntil(iso);
    return s === null ? Infinity : -s;
}

function defaultRank(driver) {
    const i = DRIVER_ORDER.indexOf(driver);
    return i < 0 ? DRIVER_ORDER.length : i;
}

// snapshots: [{env: {id, name}, providers, accents}] in environment priority order.
// Returns accounts in default order (Claude, Codex, then the rest as T3 lists them).
export function collectAccounts(snapshots) {
    const byKey = new Map();
    for (const {env, providers, accents} of snapshots) {
        for (const p of providers ?? []) {
            const limits = p.usageLimits;
            if (!p.enabled || !limits || limits.unavailable?.reason === 'unsupported')
                continue;
            if (!limits.unavailable && !(limits.windows?.length))
                continue;
            const name = p.displayName || p.instanceId;
            const account = {
                key: accountKey(env.id, p),
                driver: p.driver,
                name,
                defaultLabel: defaultLabel(name, p.driver),
                plan: p.auth?.label ?? '',
                accent: accents?.[p.instanceId] ?? null,
                checkedAt: limits.checkedAt,
                unavailable: limits.unavailable ?? null,
                windows: limits.windows ?? [],
                sources: [env.name],
            };
            const existing = byKey.get(account.key);
            if (!existing) {
                byKey.set(account.key, account);
                continue;
            }
            const fresher = existing.unavailable
                ? !account.unavailable || secondsSince(account.checkedAt) < secondsSince(existing.checkedAt)
                : !account.unavailable && secondsSince(account.checkedAt) < secondsSince(existing.checkedAt);
            const kept = fresher ? account : existing;
            byKey.set(account.key, {
                ...kept,
                name: existing.name,
                defaultLabel: existing.defaultLabel,
                accent: existing.accent ?? account.accent,
                sources: [...existing.sources, env.name],
            });
        }
    }
    return [...byKey.values()]
        .map((a, i) => ({a, i}))
        .sort((x, y) => defaultRank(x.a.driver) - defaultRank(y.a.driver) || x.i - y.i)
        .map(x => x.a);
}

// Orders items (anything with .key) by the saved order; unknown keys keep their
// relative order after the known ones.
export function applyOrder(items, order) {
    const pos = new Map(order.map((key, i) => [key, i]));
    return items.map((item, i) => ({item, i}))
        .sort((x, y) => (pos.get(x.item.key) ?? order.length + x.i) - (pos.get(y.item.key) ?? order.length + y.i))
        .map(x => x.item);
}

export function level(pct) {
    if (pct >= 90)
        return 'crit';
    if (pct >= 75)
        return 'warn';
    return 'ok';
}

// Claude's separate weekly limit for Fable models ("Weekly · Fable"). These start
// hidden; the preferences show them again.
export function isFable(w) {
    return /fable/i.test(w.id ?? '') || /fable/i.test(w.label ?? '');
}

export function windowId(w) {
    return w.id || w.label;
}

// The entry in the hidden-windows setting for one limit window of one account.
export function windowKey(accountKey, id) {
    return `${accountKey}|${id}`;
}

// A window whose reset has passed is empty until T3 checks again.
export function effectivePercent(w) {
    const s = secondsUntil(w.resetsAt);
    if (s !== null && s <= 0)
        return 0;
    return Math.max(0, Math.min(100, w.usedPercent));
}

// The window that limits the account: the fullest one, and on a tie the one that
// resets last, because that is how long the account stays blocked.
export function bindingWindow(windows) {
    let best = null;
    for (const w of windows) {
        const pct = effectivePercent(w);
        if (!best || pct > best.pct ||
            (pct === best.pct && (Date.parse(w.resetsAt ?? '') || 0) > (Date.parse(best.w.resetsAt ?? '') || 0)))
            best = {w, pct};
    }
    return best;
}

// A duration in its two largest units ([[4, 'd'], [11, 'h']]); with round, the
// largest unit alone, rounded to the nearest (15h 59m -> 16h, 4d 11h -> 4d).
function units(seconds, round) {
    const mins = Math.max(1, Math.round(seconds / 60));
    if (mins < 60)
        return [[mins, 'm']];
    if (round) {
        const hrs = Math.round(mins / 60);
        return hrs < 24 ? [[hrs, 'h']] : [[Math.round(mins / 1440), 'd']];
    }
    const hrs = Math.floor(mins / 60);
    const parts = hrs < 24 ? [[hrs, 'h'], [mins % 60, 'm']] : [[Math.floor(hrs / 24), 'd'], [hrs % 24, 'h']];
    return parts.filter(([value], i) => i === 0 || value > 0);
}

const LONG_UNITS = {m: 'min', h: 'h', d: 'd'};
const UNIT_SECONDS = {m: 60, h: 3600, d: 86400};

// The seconds a duration stands for once formatted (4d 11h rounds to 4 days).
function shownSeconds(seconds, round) {
    return units(seconds, round).reduce((sum, [value, unit]) => sum + value * UNIT_SECONDS[unit], 0);
}

function duration(seconds, sep, round = false) {
    return units(seconds, round).map(([value, unit]) => `${value}${unit}`).join(sep);
}

export function compactReset(iso, round = false) {
    const s = secondsUntil(iso);
    if (s === null)
        return '';
    return s <= 0 ? 'now' : duration(s, '', round);
}

// "2 h 11 min", "3 d 4 h", "11 min" for the menu.
export function longDuration(seconds, round = false) {
    return units(seconds, round).map(([value, unit]) => `${value} ${LONG_UNITS[unit]}`).join(' ');
}

export function relativeReset(iso, round = false) {
    const s = secondsUntil(iso);
    if (s === null)
        return '';
    return s <= 0 ? 'resetting' : `resets in ${longDuration(s, round)}`;
}

// Length of a window in seconds. T3 reports it for session and weekly windows;
// a monthly window without it runs from the same day a month before its reset.
function windowSeconds(w) {
    if (w.windowDurationMins)
        return w.windowDurationMins * 60;
    if (w.kind === 'monthly' && w.resetsAt) {
        const end = GLib.DateTime.new_from_iso8601(w.resetsAt, null);
        const start = end?.add_months(-1);
        if (end && start)
            return end.difference(start) / 1e6;
    }
    return null;
}

// Where the window stands against an even rate of use, assuming use continues at
// its average rate since the window started.
//   expected   share an even rate would have used by now (the bar's marker sits at 100 - expected left)
//   exhaustIn  seconds until the limit at the current rate, when that comes before the reset
//   lockout    seconds between running out and the reset
//   remaining  seconds until the reset (with exhaustIn)
//   projected  share used at the reset, when the limit is not reached
// Returns null when the window has no known length or reset time.
export function pace(w) {
    const total = windowSeconds(w);
    const remaining = secondsUntil(w.resetsAt);
    if (!total || remaining === null || remaining <= 0 || remaining > total)
        return null;
    const elapsed = total - remaining;
    const used = effectivePercent(w);
    const expected = (elapsed / total) * 100;
    if (used >= 100)
        return {expected, full: true, level: 'crit'};
    // Too early in the window, or nothing used yet: no rate worth projecting.
    if (used <= 0 || elapsed < Math.min(15 * 60, total * 0.02))
        return {expected};
    const rate = used / elapsed;
    const exhaustIn = (100 - used) / rate;
    if (exhaustIn < remaining) {
        const lockout = remaining - exhaustIn;
        return {expected, exhaustIn, lockout, remaining, level: lockout >= total * 0.1 ? 'crit' : 'warn'};
    }
    const projected = used + rate * remaining;
    return {expected, projected, level: projected >= 90 ? 'warn' : 'ok'};
}

export function paceText(p, round = false) {
    if (!p)
        return null;
    if (p.full)
        return 'Limit reached';
    if (p.exhaustIn !== undefined) {
        // The two times add up to the reset time shown above the line: the lockout is
        // what the shown reset leaves after the shown run-out time. When both show the
        // same, the line gives only the lockout.
        const exhaust = shownSeconds(p.exhaustIn, round);
        const lockout = shownSeconds(p.remaining, round) - exhaust;
        if (lockout < 60)
            return `On pace to run out ${longDuration(p.lockout, round)} before the reset`;
        return `On pace to run out in ${longDuration(exhaust, round)}, ${longDuration(lockout, round)} before the reset`;
    }
    if (p.projected !== undefined)
        return `On pace for ${Math.round(100 - p.projected)} % left at the reset`;
    return null;
}

export function clockTime(iso) {
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt ? dt.to_local().format('%H:%M') : '?';
}

export function ago(seconds) {
    return seconds < 90 ? 'just now' : `${duration(seconds, ' ')} ago`;
}
