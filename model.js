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

// The same login can run on several T3 servers (laptop and hub). Its e-mail plus
// workspace identifies it across them. An account without an e-mail goes by its
// driver and name: T3's credential fingerprint changes with every new sign-in, and
// differs between servers. Two such accounts of one driver and name, on different
// servers, are taken for one.
function accountKey(p, name) {
    if (p.auth?.email)
        return [p.driver, p.auth.email, p.auth.workspaceId].filter(Boolean).join(':');
    return `${p.driver}:name:${name}`;
}

// A provider account in T3: the server's id and T3's instance id there.
function instanceKey(serverId, instanceId) {
    return `${serverId}|${instanceId}`;
}

// [server id, instance id]. Server ids are 'local' or UUIDs.
function splitInstance(instance) {
    const i = instance.indexOf('|');
    return [instance.slice(0, i), instance.slice(i + 1)];
}

export function secondsUntil(iso) {
    const t = Date.parse(iso ?? '');
    return Number.isNaN(t) ? null : (t - Date.now()) / 1000;
}

export function secondsSince(iso) {
    const s = secondsUntil(iso);
    return s === null ? Infinity : -s;
}

// A server that stops answering keeps showing its last numbers this long before
// the menu reports it: a T3 update or restart takes it away for a minute or two.
export const SERVER_GRACE_SECONDS = 5 * 60;

// error: the last poll's error, or null. unavailable: the error is only that the
// server did not answer; any other error (sign-in, version) is reported at once.
// sinceOk: seconds since the server last answered, or null when it never has.
export function serverDown(error, unavailable, sinceOk) {
    if (!error)
        return false;
    return !unavailable || !(sinceOk !== null && sinceOk >= 0 && sinceOk <= SERVER_GRACE_SECONDS);
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
                key: accountKey(p, name),
                driver: p.driver,
                name,
                defaultLabel: defaultLabel(name, p.driver),
                plan: p.auth?.label ?? '',
                accent: accents?.[p.instanceId] ?? null,
                checkedAt: limits.checkedAt,
                unavailable: limits.unavailable ?? null,
                windows: limits.windows ?? [],
                sources: [env.name],
                serverIds: [env.id],
                instances: [instanceKey(env.id, p.instanceId)],
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
                serverIds: [...existing.serverIds, env.id],
                instances: [...existing.instances, ...account.instances],
            });
        }
    }
    return [...byKey.values()]
        .map((a, i) => ({a, i}))
        .sort((x, y) => defaultRank(x.a.driver) - defaultRank(y.a.driver) || x.i - y.i)
        .map(x => x.a);
}

const KNOWN_ACCOUNT_DAYS = 30;

// Updates the remembered accounts (the `known-accounts` setting, which the
// preferences list) with what the servers that answered in this poll report.
//   known      the saved list
//   accounts   collectAccounts() of the servers that answered
//   servers    every configured server, [{id, name}]
//   providers  Map of server id -> T3's provider list, for the servers that answered
//   today      'YYYY-MM-DD'
// An account T3 no longer reports is kept while one of its providers may bring it
// back: its server did not answer, or T3 has the provider switched on and reports
// no account from it yet. When several remembered accounts wait on one provider,
// the one seen last keeps it. The rest are dropped: T3 dropped or switched off the
// provider, reports another login from it, or the server was removed. Accounts not
// seen for 30 days are dropped too.
// An account reported for the first time follows a dropped one of the same name
// from the same provider: T3 gave the login a new key. It inherits that account's
// label, place, top-bar switch and hidden limits.
// Returns {known, fresh, inherited, hide}: the new list, accounts seen for the first
// time that follow no other, a Map of new key -> the key it follows, and the keys of
// Fable windows seen for the first time (in hidden-windows form).
export function reconcileAccounts(known, accounts, servers, providers, today) {
    const configured = new Set(servers.map(s => s.id));
    const idByName = new Map(servers.map(s => [s.name, s.id]));
    const enabled = new Map([...providers].map(([id, list]) =>
        [id, new Map((list ?? []).filter(p => p.enabled).map(p => [p.instanceId, p]))]));
    const current = new Map(accounts.map(a => [a.key, a]));
    const reported = new Set(accounts.flatMap(a => a.instances));

    // Entries saved before version 1.3 name their servers but not the provider: it is
    // the one with the same driver and name. They wait until those servers answer.
    const upgrade = k => {
        if (Array.isArray(k.instances))
            return k;
        const instances = [];
        for (const name of k.sources ?? []) {
            const id = idByName.get(name);
            if (id === undefined)
                continue;
            if (!enabled.has(id))
                return k;
            const p = [...enabled.get(id).values()].find(x => x.driver === k.driver && (x.displayName || x.instanceId) === k.name);
            if (p)
                instances.push(instanceKey(id, p.instanceId));
        }
        return {...k, instances};
    };
    const age = k => (Date.parse(today) - Date.parse(k.lastSeen)) / 864e5;
    const remembered = known.filter(k => typeof k?.key === 'string' && age(k) <= KNOWN_ACCOUNT_DAYS).map(upgrade);
    const byKey = new Map(remembered.map(k => [k.key, k]));
    const absent = remembered.filter(k => !current.has(k.key));
    const latestFirst = (x, y) => String(y.lastSeen).localeCompare(String(x.lastSeen));

    const unanswered = instance => {
        const [id] = splitInstance(instance);
        return configured.has(id) && !enabled.has(id);
    };
    const holder = new Map();
    for (const k of [...absent].sort(latestFirst)) {
        for (const instance of k.instances ?? []) {
            const [id, instanceId] = splitInstance(instance);
            if (enabled.get(id)?.has(instanceId) && !reported.has(instance) && !holder.has(instance))
                holder.set(instance, k);
        }
    }
    const alive = k => !Array.isArray(k.instances) ||
        k.instances.some(instance => unanswered(instance) || holder.get(instance) === k);

    const inherited = new Map();
    const fresh = [];
    for (const a of accounts) {
        if (byKey.has(a.key))
            continue;
        const before = absent.filter(k => k.driver === a.driver && k.name === a.name &&
            (k.instances ?? []).some(instance => a.instances.includes(instance))).sort(latestFirst)[0];
        if (before)
            inherited.set(a.key, before.key);
        else
            fresh.push(a);
    }

    const hide = [];
    // Windows T3 no longer reports stay listed, so their switches keep their state.
    const record = (a, before) => {
        const seen = before?.windows ?? [];
        const windows = a.windows.map(w => ({id: windowId(w), label: w.label}));
        for (const w of a.windows) {
            if (isFable(w) && !seen.some(b => b.id === windowId(w)))
                hide.push(windowKey(a.key, windowId(w)));
        }
        return {
            key: a.key, name: a.name, driver: a.driver, plan: a.plan, defaultLabel: a.defaultLabel,
            sources: a.sources, instances: a.instances, lastSeen: today,
            windows: [...windows, ...seen.filter(b => !windows.some(c => c.id === b.id))],
        };
    };
    const next = [];
    for (const k of remembered) {
        if (current.has(k.key))
            next.push(record(current.get(k.key), k));
        else if (alive(k))
            next.push(k);
    }
    for (const a of accounts) {
        if (!byKey.has(a.key))
            next.push(record(a, byKey.get(inherited.get(a.key))));
    }
    return {known: next, fresh, inherited, hide};
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

// "↻ 2 h" for the menu: the time until a limit resets.
export function shortReset(iso, round = false) {
    const s = secondsUntil(iso);
    if (s === null)
        return '';
    return `↻ ${s <= 0 ? 'now' : longDuration(s, round)}`;
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

// The line under a limit that is on course to run short, or null when its pace is fine.
export function paceWarning(p, round = false) {
    if (!p?.level || p.level === 'ok')
        return null;
    if (p.full)
        return 'Limit reached';
    if (p.exhaustIn === undefined)
        return `On pace for ${Math.round(100 - p.projected)} % left at the reset`;
    // The two times add up to the reset time shown on the line above: the lockout is
    // what the shown reset leaves after the shown run-out time. When both show the
    // same, the line gives only the lockout.
    const exhaust = shownSeconds(p.exhaustIn, round);
    const lockout = shownSeconds(p.remaining, round) - exhaust;
    if (lockout < 60)
        return `Runs out ${longDuration(p.lockout, round)} before the reset`;
    return `Runs out in ${longDuration(exhaust, round)}, ${longDuration(lockout, round)} before the reset`;
}

export function clockTime(iso) {
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt ? dt.to_local().format('%H:%M') : '?';
}

export function ago(seconds) {
    return seconds < 90 ? 'just now' : `${duration(seconds, ' ')} ago`;
}
