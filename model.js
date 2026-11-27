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
        // Providers without an e-mail that share a driver and name on one server go by
        // their instance ids instead, all of them, so that no key passes to another
        // provider when one goes. Counted over every switched-on provider.
        const switchedOn = (providers ?? []).filter(p => p.enabled);
        const plain = p => accountKey(p, p.displayName || p.instanceId);
        const keys = new Map(switchedOn.map(p => {
            const shared = !p.auth?.email && switchedOn.filter(x => !x.auth?.email && plain(x) === plain(p)).length > 1;
            return [p.instanceId, shared ? `${p.driver}:instance:${p.instanceId}:${p.displayName || p.instanceId}` : plain(p)];
        }));
        for (const p of providers ?? []) {
            const limits = p.usageLimits;
            if (!p.enabled || !limits || limits.unavailable?.reason === 'unsupported')
                continue;
            if (!limits.unavailable && !(limits.windows?.length))
                continue;
            const name = p.displayName || p.instanceId;
            const account = {
                key: keys.get(p.instanceId),
                driver: p.driver,
                email: p.auth?.email ?? null,
                workspace: p.auth?.workspaceId ?? null,
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
// The instance id of a provider not identified yet (entries saved before 1.3).
const UNKNOWN_INSTANCE = '?';

// The login's e-mail and workspace; entries saved before 1.3 have them only in the
// key (driver:email:workspace).
function emailOf(k) {
    if (k.email !== undefined)
        return k.email;
    const part = k.key.split(':')[1] ?? '';
    return part.includes('@') ? part : null;
}

function workspaceOf(k) {
    if (k.workspace !== undefined)
        return k.workspace;
    return emailOf(k) ? k.key.split(':').slice(2).join(':') || null : null;
}

// Both are known and differ.
function differ(x, y) {
    return Boolean(x && y && x !== y);
}

// Updates the remembered accounts (the `known-accounts` setting, which the
// preferences list) with what the servers that answered in this poll report.
//   known      the saved list
//   accounts   collectAccounts() of the servers that answered
//   servers    every configured server, [{id, name}]
//   providers  Map of server id -> T3's provider list, for the servers that answered
//   today      'YYYY-MM-DD'
// Each remembered account lists its providers: a server and T3's instance id there.
// An account T3 no longer reports is kept while one of them may bring it back: its
// server did not answer (or answered with no providers at all, as T3 may while it
// starts), or T3 has the provider switched on and reports no account from it yet.
// When several remembered accounts wait on one provider, the one seen last keeps it.
// The rest are dropped: T3 dropped or switched off the provider, reports another
// login from it, or the server was removed. Accounts not seen for 30 days are
// dropped too.
// An account reported for the first time follows a dropped one of the same name
// from the same provider, unless their e-mails differ: T3 gave the login a new key.
// It replaces that account and inherits its label, place, top-bar switch and
// hidden limits.
// Returns {known, fresh, inherited, hide}: the new list, accounts seen for the first
// time that follow no other, a Map of new key -> the key it follows, and the keys of
// Fable windows seen for the first time (in hidden-windows form).
export function reconcileAccounts(known, accounts, servers, providers, today) {
    const configured = new Set(servers.map(s => s.id));
    // Providers T3 runs for usage limits; one it reports as unsupported never has any.
    const enabled = new Map([...providers].filter(([, list]) => list?.length).map(([id, list]) => [id, new Map(list
        .filter(p => p.enabled && p.usageLimits?.unavailable?.reason !== 'unsupported')
        .map(p => [p.instanceId, p]))]));
    const unanswered = instance => {
        const [id] = splitInstance(instance);
        return configured.has(id) && !enabled.has(id);
    };
    const current = new Map(accounts.map(a => [a.key, a]));
    const reported = new Set(accounts.flatMap(a => a.instances));
    // T3 runs the provider but reports no account from it yet.
    const waiting = instance => {
        const [id, instanceId] = splitInstance(instance);
        return Boolean(enabled.get(id)?.has(instanceId)) && !reported.has(instance);
    };

    // Entries saved before 1.3 name their servers but not the provider: it is the one
    // with the same driver and name (and e-mail, when several match), found once the
    // server answers. A server name that several servers share stands for each.
    const resolve = k => {
        // A key of the form `server id:instance id` belongs to that server only.
        const owner = servers.find(s => k.key.startsWith(`${s.id}:`));
        const instances = Array.isArray(k.instances)
            ? k.instances
            : (k.sources ?? []).flatMap(name => servers.filter(s => s.name === name && (!owner || s === owner))
                .map(s => instanceKey(s.id, UNKNOWN_INSTANCE)));
        return {
            ...k,
            instances: instances.flatMap(instance => {
                const [id, instanceId] = splitInstance(instance);
                if (instanceId !== UNKNOWN_INSTANCE || !enabled.has(id))
                    return [instance];
                const all = [...enabled.get(id).values()];
                // Old keys that name the provider: `server id:instance id`, or its
                // credential fingerprint.
                const exact = all.find(x => k.key === `${id}:${x.instanceId}` ||
                    (x.usageLimits?.credentialFingerprint && k.key === `${x.driver}:fp:${x.usageLimits.credentialFingerprint.slice(0, 16)}`));
                const matches = all.filter(x => x.driver === k.driver && (x.displayName || x.instanceId) === k.name);
                // A key of the form `server id:instance id` names its provider or none.
                const p = exact ?? (k.key.startsWith(`${id}:`) ? null
                    : matches.find(x => emailOf(k) && x.auth?.email === emailOf(k)) ??
                        matches.find(x => waiting(instanceKey(id, x.instanceId))) ?? matches[0]);
                return p ? [instanceKey(id, p.instanceId)] : [];
            }),
        };
    };
    const age = k => (Date.parse(today) - Date.parse(k.lastSeen)) / 864e5;
    const remembered = known.filter(k => typeof k?.key === 'string' && age(k) <= KNOWN_ACCOUNT_DAYS).map(resolve);
    const byKey = new Map(remembered.map(k => [k.key, k]));
    const absent = remembered.filter(k => !current.has(k.key));
    // By the day last seen, and on the same day the one saved later.
    const position = new Map(remembered.map((k, i) => [k.key, i]));
    const latestFirst = (x, y) => String(y.lastSeen).localeCompare(String(x.lastSeen)) ||
        position.get(y.key) - position.get(x.key);

    const holder = new Map();
    for (const k of [...absent].sort(latestFirst)) {
        for (const instance of k.instances) {
            if (waiting(instance) && !holder.has(instance))
                holder.set(instance, k);
        }
    }
    const alive = k => k.instances.some(instance => unanswered(instance) || holder.get(instance) === k);

    const inherited = new Map();
    const fresh = [];
    for (const a of accounts) {
        if (byKey.has(a.key))
            continue;
        const before = absent.filter(k => k.driver === a.driver &&
            !differ(a.email, emailOf(k)) && !differ(a.workspace, workspaceOf(k)) &&
            k.instances.some(instance => a.instances.includes(instance))).sort(latestFirst)[0];
        if (before)
            inherited.set(a.key, before.key);
        else
            fresh.push(a);
    }

    const hide = [];
    const record = (a, before) => {
        const seen = before?.windows ?? [];
        const windows = a.windows.map(w => ({id: windowId(w), label: w.label}));
        for (const w of a.windows) {
            if (isFable(w) && !seen.some(b => b.id === windowId(w)))
                hide.push(windowKey(a.key, windowId(w)));
        }
        // Providers that did not report this time may still run it: their server did not
        // answer, or T3 there has no limits for it yet.
        const elsewhere = (before?.instances ?? []).filter(i => !a.instances.includes(i) && (unanswered(i) || waiting(i)));
        const elsewhereNames = servers.filter(s => elsewhere.some(i => splitInstance(i)[0] === s.id)).map(s => s.name);
        return {
            key: a.key, name: a.name, driver: a.driver, email: a.email, workspace: a.workspace, plan: a.plan,
            defaultLabel: a.defaultLabel,
            sources: [...new Set([...a.sources, ...elsewhereNames])],
            instances: [...a.instances, ...elsewhere],
            lastSeen: today,
            // Windows T3 no longer reports stay listed, so their switches keep their state.
            windows: [...windows, ...seen.filter(b => !windows.some(c => c.id === b.id))],
        };
    };
    // An account kept without a report keeps only the providers that may still bring it back.
    const retained = k => {
        const instances = k.instances.filter(instance => unanswered(instance) || holder.get(instance) === k);
        const ids = new Set(instances.map(instance => splitInstance(instance)[0]));
        return {...k, instances, sources: servers.filter(s => ids.has(s.id)).map(s => s.name)};
    };
    // An account followed by a new key is replaced by it.
    const followed = new Set(inherited.values());
    const next = [];
    for (const k of remembered) {
        if (current.has(k.key))
            next.push(record(current.get(k.key), k));
        else if (alive(k) && !followed.has(k.key))
            next.push(retained(k));
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
