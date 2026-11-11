import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

import {T3Server, makeHttpSession, serverSpecs} from './t3client.js';
import {
    PANEL_DEFAULT_DRIVERS, ago, applyOrder, bindingWindow, clockTime, collectAccounts,
    compactReset, effectivePercent, isFable, level, pace, paceWarning, secondsSince, shortReset, windowId, windowKey,
} from './model.js';

// GNOME 51 removed St.BoxLayout's `vertical` in favour of `orientation`.
const VERTICAL = parseInt(PACKAGE_VERSION) >= 51
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

const POLL_SECONDS = 120;
// T3 re-probes every 5 min, but only while one of its windows is in the foreground.
// Older data means it is idle, so the panel asks it to re-probe, at the same pace.
const FORCE_REFRESH_SECONDS = 5 * 60 + 30;
// An account no server has managed to check for this long shows no numbers.
const STALE_ACCOUNT_SECONDS = 20 * 60;
const KNOWN_ACCOUNT_DAYS = 30;
// Servers added in the preferences warn this long before their sign-in runs out.
const EXPIRY_WARNING_DAYS = 7;

// The menu's grid: limit, bar, share left, reset.
const COLUMNS = 4;

const RING_SIZE = 18;
const RING_STROKE = 3;
const RING_TRACK = [1, 1, 1, 0.25];
const LEVEL_RGBA = {
    ok: [0x33 / 255, 0xd1 / 255, 0x7a / 255, 1],
    warn: [0xff / 255, 0x78 / 255, 0x00 / 255, 1],
    crit: [0xe0 / 255, 0x1b / 255, 0x24 / 255, 1],
};

const RENDER_KEYS = ['account-order', 'panel-accounts', 'labels', 'reset-mode', 'show-percent', 'show-label', 'hidden-windows', 'round-times'];

// Rings and bars fill to the share left. Near the limit the fill is short, so the
// track takes the warning colour as well.
function trackColor(lvl) {
    return lvl === 'ok' ? RING_TRACK : [...LEVEL_RGBA[lvl].slice(0, 3), 0.35];
}

// A plain DrawingArea with a repaint handler rather than a registered GObject
// subclass, so the extension can be reloaded in a running shell.
// used: share used of the window, or null when unknown.
function makeRing(used) {
    const ring = new St.DrawingArea({style_class: 't3-ai-usage-ring', y_align: Clutter.ActorAlign.CENTER});
    ring.set_size(RING_SIZE, RING_SIZE);
    ring.connect('repaint', area => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const radius = Math.min(w, h) / 2 - RING_STROKE / 2;
        const start = -Math.PI / 2;
        const lvl = used === null ? 'ok' : level(used);
        cr.setLineWidth(RING_STROKE);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(...trackColor(lvl));
        cr.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
        cr.stroke();
        const left = used === null ? 0 : 100 - used;
        if (left > 0) {
            cr.setSourceRGBA(...LEVEL_RGBA[lvl]);
            cr.arc(w / 2, h / 2, radius, start, start + (left / 100) * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    });
    return ring;
}

// The menu's bar: fill to the share left, and a marker where an even rate of use
// would leave it by now.
function makeBar(used, expectedUsed) {
    const left = 100 - used;
    const marker = expectedUsed === null || expectedUsed === undefined ? null : 100 - expectedUsed;
    const lvl = level(used);
    const bar = new St.DrawingArea({style_class: 't3-ai-usage-bar', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    bar.connect('repaint', area => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const bh = 6;
        const y = (h - bh) / 2;
        const rounded = (width, rgba) => {
            const r = bh / 2;
            cr.newSubPath();
            cr.arc(r, y + r, r, Math.PI / 2, 3 * Math.PI / 2);
            cr.arc(Math.max(r, width - r), y + r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.setSourceRGBA(...rgba);
            cr.fill();
        };
        rounded(w, trackColor(lvl));
        if (left > 0)
            rounded(Math.max(bh, (w * left) / 100), LEVEL_RGBA[lvl]);
        if (marker !== null) {
            const x = Math.min(w - 1, Math.max(1, Math.round((w * marker) / 100)));
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.rectangle(x - 1, 0, 2, h);
            cr.fill();
        }
        cr.$dispose();
    });
    return bar;
}

export default class T3AiUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._http = makeHttpSession();
        this._states = new Map();
        this._createServers();
        this._accounts = [];
        this._running = false;

        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._panelBox = new St.BoxLayout({style_class: 't3-ai-usage-panel', y_align: Clutter.ActorAlign.CENTER});
        this._button.add_child(this._panelBox);
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });
        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._settingsIds = RENDER_KEYS.map(key =>
            this._settings.connect(`changed::${key}`, () => this._render()));
        for (const key of ['servers', 'local-server']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._createServers();
                this._render();
                this._refresh();
            }));
        }

        this._render();
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        for (const server of this._servers ?? [])
            server.destroy();
        this._servers = null;
        this._http?.abort();
        this._http = null;
        this._button?.destroy();
        this._button = null;
        this._panelBox = null;
        this._rows = null;
        this._scroll = null;
        this._status = null;
        this._updated = null;
        this._settings = null;
        this._accounts = [];
        this._states = null;
    }

    _createServers() {
        for (const server of this._servers ?? [])
            server.destroy();
        const specs = serverSpecs(this._settings);
        this._servers = specs.map(spec => new T3Server(spec, this._http));
        // A server whose address or sign-in changed starts over.
        this._states.clear();
        this._running = false;
        this._forceQueued = false;
    }

    _refresh(force = false) {
        if (this._running) {
            // "Refresh now" during an update runs right after it.
            this._forceQueued ||= force;
            return;
        }
        this._running = true;
        const servers = this._servers;
        this._update(servers, force).catch(e => {
            console.error(`T3 AI Usage: ${e.message ?? e}`);
        }).finally(() => {
            if (servers !== this._servers)
                return;
            this._running = false;
            if (this._forceQueued) {
                this._forceQueued = false;
                this._refresh(true);
            }
        });
    }

    async _update(servers, force) {
        await Promise.all(servers.map(server => this._updateServer(server, force)));
        if (!this._button || servers !== this._servers)
            return;
        this._accounts = collectAccounts(servers
            .map(server => ({env: server, state: this._states.get(server.id)}))
            .filter(({state}) => state?.providers)
            .map(({env, state}) => ({env, providers: state.providers, accents: state.accents})));
        this._recordAccounts(this._accounts);
        this._render();
    }

    async _updateServer(server, force) {
        const state = this._states.get(server.id) ?? {lastForced: 0, accents: {}};
        this._states.set(server.id, state);
        try {
            const snapshot = await server.call('server.getConfig');
            for (const [id, instance] of Object.entries(snapshot.settings?.providerInstances ?? {}))
                state.accents[id] = instance?.accentColor ?? null;
            let providers = snapshot.providers ?? [];

            const checked = providers.filter(p => p.enabled && p.usageLimits?.checkedAt);
            const newest = Math.min(...checked.map(p => secondsSince(p.usageLimits.checkedAt)));
            const now = GLib.get_monotonic_time() / 1e6;
            if (force || (newest > FORCE_REFRESH_SECONDS && now - state.lastForced > FORCE_REFRESH_SECONDS)) {
                state.lastForced = now;
                try {
                    providers = (await server.call('server.refreshProviders')).providers ?? providers;
                } catch (e) {
                    // The snapshot from getConfig is still worth showing.
                    if (server === this._servers?.find(s => s.id === server.id))
                        console.warn(`T3 AI Usage: ${server.name}: re-check failed: ${e.message ?? e}`);
                }
            }
            state.providers = providers;
            state.error = null;
            state.okAt = GLib.DateTime.new_now_local();
        } catch (e) {
            if (server !== this._servers?.find(s => s.id === server.id))
                return;
            const error = e.message ?? String(e);
            // Logged when it changes, not on every poll.
            if (error !== state.error)
                console.warn(`T3 AI Usage: ${server.name}: ${error}`);
            state.error = error;
        }
    }

    // Remembers every account and its limit windows for the preferences window. Accounts
    // seen for the first time go into the saved order (and Claude/Codex ones into the
    // top bar); Fable windows seen for the first time are hidden.
    _recordAccounts(accounts) {
        let known = [];
        try {
            known = JSON.parse(this._settings.get_string('known-accounts'));
        } catch {}
        const today = GLib.DateTime.new_now_local();
        const byKey = new Map(known.filter(k => {
            const seen = GLib.DateTime.new_from_iso8601(`${k.lastSeen}T00:00:00Z`, null);
            return seen && today.difference(seen) / 864e8 <= KNOWN_ACCOUNT_DAYS;
        }).map(k => [k.key, k]));
        const fresh = accounts.filter(a => !byKey.has(a.key));
        const hidden = this._settings.get_strv('hidden-windows');
        const hide = [];
        for (const a of accounts) {
            // Windows T3 no longer reports stay listed, so their switches keep their state.
            const before = byKey.get(a.key)?.windows ?? [];
            const current = a.windows.map(w => ({id: windowId(w), label: w.label}));
            for (const w of a.windows) {
                const key = windowKey(a.key, windowId(w));
                if (isFable(w) && !before.some(b => b.id === windowId(w)) && !hidden.includes(key))
                    hide.push(key);
            }
            byKey.set(a.key, {
                key: a.key, name: a.name, driver: a.driver, plan: a.plan,
                defaultLabel: a.defaultLabel, sources: a.sources, lastSeen: today.format('%F'),
                windows: [...current, ...before.filter(b => !current.some(c => c.id === b.id))],
            });
        }
        if (hide.length)
            this._settings.set_strv('hidden-windows', [...hidden, ...hide]);
        const next = JSON.stringify([...byKey.values()]);
        if (next !== this._settings.get_string('known-accounts'))
            this._settings.set_string('known-accounts', next);
        if (!fresh.length)
            return;
        const order = this._settings.get_strv('account-order');
        this._settings.set_strv('account-order', [...order, ...fresh.map(a => a.key).filter(k => !order.includes(k))]);
        const panel = this._settings.get_strv('panel-accounts');
        const add = fresh.filter(a => PANEL_DEFAULT_DRIVERS.includes(a.driver) && !panel.includes(a.key));
        if (add.length)
            this._settings.set_strv('panel-accounts', [...panel, ...add.map(a => a.key)]);
    }

    _render() {
        if (!this._button)
            return;
        const ordered = applyOrder(this._accounts, this._settings.get_strv('account-order'));
        const labels = this._settings.get_value('labels').deepUnpack();
        this._renderPanel(ordered, labels);
        this._renderMenu(ordered);
    }

    _hasData() {
        return this._accounts.length > 0;
    }

    // Every server failed, or none is set up.
    _allFailed() {
        return this._servers.every(server => this._states.get(server.id)?.error);
    }

    _renderPanel(accounts, labels) {
        this._panelBox.destroy_all_children();
        if (!this._hasData() || this._allFailed()) {
            const failed = this._allFailed();
            this._panelBox.add_child(new St.Label({
                text: failed ? '⚠ AI' : 'AI …',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: failed ? 't3-ai-usage-error' : null,
            }));
            return;
        }
        const panel = new Set(this._settings.get_strv('panel-accounts'));
        const showLabel = this._settings.get_boolean('show-label');
        const showPercent = this._settings.get_boolean('show-percent');
        const resetMode = this._settings.get_string('reset-mode');
        const round = this._settings.get_boolean('round-times');
        for (const account of accounts.filter(a => panel.has(a.key))) {
            const box = new St.BoxLayout({style_class: 't3-ai-usage-account', y_align: Clutter.ActorAlign.CENTER});
            if (showLabel) {
                const label = new St.Label({
                    text: labels[account.key] || account.defaultLabel,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 't3-ai-usage-label',
                });
                if (account.accent)
                    label.set_style(`color: ${account.accent};`);
                box.add_child(label);
            }
            const windows = this._windows(account);
            // Every limit of the account is hidden in the preferences.
            if (this._usable(account) && !windows.length)
                continue;
            const binding = this._usable(account) ? bindingWindow(windows) : null;
            box.add_child(makeRing(binding ? binding.pct : null));

            const parts = [];
            if (binding && showPercent)
                parts.push(`${Math.round(100 - binding.pct)}%`);
            if (binding && (resetMode === 'always' || (resetMode === 'near-limit' && binding.pct >= 75)))
                parts.push(compactReset(binding.w.resetsAt, round));
            if (!binding)
                parts.push('?');
            if (parts.length) {
                box.add_child(new St.Label({
                    text: parts.join(' '),
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: binding ? 't3-ai-usage-reset' : 't3-ai-usage-reset t3-ai-usage-error',
                }));
            }
            this._panelBox.add_child(box);
        }
        // No account is chosen for the top bar: keep something to click.
        if (!this._panelBox.get_n_children())
            this._panelBox.add_child(new St.Label({text: 'AI', y_align: Clutter.ActorAlign.CENTER}));
    }

    _usable(account) {
        return !account.unavailable && account.windows.length > 0 &&
            secondsSince(account.checkedAt) <= STALE_ACCOUNT_SECONDS;
    }

    _windows(account) {
        const hidden = new Set(this._settings.get_strv('hidden-windows'));
        return account.windows.filter(w => !hidden.has(windowKey(account.key, windowId(w))));
    }

    // The menu's parts, built once. The account rows scroll when they are taller than
    // the screen; the server notes and the footer below them always stay in view.
    _buildMenu() {
        const menu = this._button.menu;
        // One grid for all accounts, so the bars of every limit line up.
        this._rows = new St.Widget({
            layout_manager: new Clutter.GridLayout({orientation: Clutter.Orientation.VERTICAL}),
            x_expand: true,
        });
        const content = new St.BoxLayout({...VERTICAL, style_class: 't3-ai-usage-content'});
        content.add_child(this._rows);
        // Reactive, so the pointer picks it and the wheel scrolls it: the rows are not.
        this._scroll = new St.ScrollView({
            child: content,
            reactive: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style_class: 't3-ai-usage-scroll',
        });
        const accounts = new PopupMenu.PopupMenuSection();
        accounts.actor.add_child(this._scroll);
        menu.addMenuItem(accounts);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._status = new St.BoxLayout({...VERTICAL, style_class: 't3-ai-usage-content'});
        this._updated = new St.Label({
            style_class: 't3-ai-usage-dim', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        const button = (label, activate) => {
            const b = new St.Button({label, can_focus: true, style_class: 'button t3-ai-usage-button'});
            b.connect('clicked', activate);
            return b;
        };
        const footer = new St.BoxLayout({style_class: 't3-ai-usage-content t3-ai-usage-footer'});
        footer.add_child(this._updated);
        footer.add_child(button('Refresh', () => this._refresh(true)));
        footer.add_child(button('Settings', () => {
            menu.close();
            this.openPreferences();
        }));
        const bottom = new PopupMenu.PopupMenuSection();
        bottom.actor.add_child(this._status);
        bottom.actor.add_child(footer);
        menu.addMenuItem(bottom);
    }

    _renderMenu(accounts) {
        // Clutter spacing is in physical pixels, CSS sizes are not.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._rows.layout_manager.column_spacing = 12 * scale;
        this._rows.layout_manager.row_spacing = 4 * scale;
        this._rows.destroy_all_children();
        this._row = 0;

        if (!this._servers.length)
            this._addText('No T3 server: turn on this computer or add a server in Settings', 't3-ai-usage-error');
        else if (!this._hasData() && !this._allFailed())
            this._addText('Waiting for T3…', 't3-ai-usage-dim');
        accounts.forEach((account, i) => this._addAccount(account, i === 0));

        this._status.destroy_all_children();
        const note = text => this._status.add_child(new St.Label({text, style_class: 't3-ai-usage-error'}));
        for (const server of this._servers) {
            const state = this._states.get(server.id);
            if (state?.error) {
                const last = state.okAt ? `, last data ${state.okAt.format('%H:%M')}` : '';
                note(`${server.name}: ${state.error}${last}`);
                continue;
            }
            const left = server.expiresAt ? (Date.parse(server.expiresAt) - Date.now()) / 864e5 : Infinity;
            if (left <= EXPIRY_WARNING_DAYS) {
                const days = Math.max(1, Math.ceil(left));
                note(`${server.name}: sign-in expires in ${days} ${days === 1 ? 'day' : 'days'}; ` +
                    'sign in again in Settings');
            }
        }
        this._status.visible = this._status.get_n_children() > 0;
        const okTimes = this._servers.map(server => this._states.get(server.id)?.okAt).filter(Boolean);
        this._updated.text = okTimes.length
            ? `Updated ${okTimes.reduce((x, y) => (x.compare(y) >= 0 ? x : y)).format('%H:%M')}`
            : '';
    }

    // Puts the cells of one row into the grid: [actor, column, columns spanned].
    _addRow(...cells) {
        for (const [actor, column, span] of cells)
            this._rows.layout_manager.attach(actor, column, this._row, span, 1);
        this._row++;
    }

    _addAccount(account, first) {
        const header = new St.BoxLayout({
            style_class: first ? 't3-ai-usage-header' : 't3-ai-usage-header t3-ai-usage-header-next',
            x_expand: true,
        });
        const name = new St.Label({text: account.name, style_class: 't3-ai-usage-account-name', x_expand: true});
        if (account.accent)
            name.set_style(`color: ${account.accent};`);
        header.add_child(name);
        // Where the account comes from, unless that is this computer or the only server.
        const local = this._servers.find(server => server.local)?.name;
        const plan = this._servers.length < 2 || account.sources.includes(local)
            ? account.plan : `${account.plan} · ${account.sources.join(', ')}`;
        header.add_child(new St.Label({text: plan, style_class: 't3-ai-usage-dim'}));
        this._addRow([header, 0, COLUMNS]);

        if (account.unavailable) {
            this._addText(account.unavailable.message ?? 'T3 could not read this account', 't3-ai-usage-error');
            return;
        }
        const age = secondsSince(account.checkedAt);
        if (age > STALE_ACCOUNT_SECONDS) {
            this._addText(`T3 last checked it at ${clockTime(account.checkedAt)} (${ago(age)})`, 't3-ai-usage-error');
            return;
        }
        const round = this._settings.get_boolean('round-times');
        const windows = this._windows(account);
        if (!windows.length)
            this._addText('All its limits are hidden in Settings', 't3-ai-usage-dim');
        const cell = (text, styleClass, x_align = Clutter.ActorAlign.START) =>
            new St.Label({text, style_class: styleClass, x_align, y_align: Clutter.ActorAlign.CENTER});
        for (const w of windows) {
            const pct = effectivePercent(w);
            const p = pace(w);
            this._addRow(
                [cell(w.label, null), 0, 1],
                [makeBar(pct, p?.expected), 1, 1],
                [cell(`${Math.round(100 - pct)} % left`, `t3-ai-usage-pct t3-ai-usage-${level(pct)}`, Clutter.ActorAlign.END), 2, 1],
                [cell(shortReset(w.resetsAt, round), 't3-ai-usage-dim t3-ai-usage-when'), 3, 1]);
            const warning = paceWarning(p, round);
            if (warning)
                this._addRow([cell(warning, `t3-ai-usage-pace t3-ai-usage-pace-${p.level}`), 1, COLUMNS - 1]);
        }
    }

    _addText(text, styleClass) {
        this._addRow([new St.Label({text, style_class: styleClass}), 0, COLUMNS]);
    }
}
