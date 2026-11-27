import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

import {T3Server, Unavailable, makeHttpSession, serverSpecs} from './t3client.js';
import {
    PANEL_DEFAULT_DRIVERS, ago, applyOrder, bindingWindow, clockTime, collectAccounts, compactReset, effectivePercent,
    level, pace, paceWarning, reconcileAccounts, secondsSince, serverDown, shortReset, windowId, windowKey,
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

// GNOME Shell disables the extension while the screen is locked. The last answer of
// each server survives that, so a T3 restart during a short sleep still gets its
// grace period: {spec: server spec as JSON, state} by server id. Data only; nothing
// polls or draws while the extension is off.
let keptStates = null;
// Servers added in the preferences warn this long before their sign-in runs out.
const EXPIRY_WARNING_DAYS = 7;

// The menu's grid: limit, bar, share left, reset.
const COLUMNS = 4;

// Top-bar layouts, from the roomiest. When the accounts do not fit beside the other
// indicators, the spacing tightens, then the text after each ring goes; otherwise
// GNOME would shorten the labels to "…".
const PANEL_LAYOUTS = [{tight: false, text: true}, {tight: true, text: true}, {tight: true, text: false}];
// A roomier layout comes back only with this much room to spare (logical pixels), so
// that a clock changing width does not switch it back and forth.
const PANEL_SPARE = 6;

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
        this._createServers(keptStates);
        keptStates = null;
        this._accounts = this._collectAccounts(this._servers);
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
        this._panelLayout = 0;
        this._panelWidths = [];
        this._panelArgs = null;
        this._fitLater = 0;
        // Room in the top bar changes when another indicator, the clock or the screen does.
        this._fitIds = [this._button.container, Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]
            .filter(Boolean)
            .map(actor => [actor, actor.connect('notify::allocation', () => this._queueFit())]);

        this._settingsIds = RENDER_KEYS.map(key =>
            this._settings.connect(`changed::${key}`, () => this._render()));
        for (const key of ['servers', 'local-server']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._createServers(this._keptStates());
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
        keptStates = this._keptStates();
        for (const [actor, id] of this._fitIds ?? [])
            actor.disconnect(id);
        this._fitIds = null;
        if (this._fitLater)
            global.compositor.get_laters().remove(this._fitLater);
        this._fitLater = 0;
        this._panelArgs = null;
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

    // Each server's last answer, for _createServers() to carry over to a server whose
    // settings (address, name, sign-in) did not change.
    _keptStates() {
        return new Map((this._servers ?? [])
            .filter(server => this._states?.get(server.id)?.okSeconds)
            .map(server => [server.id, {spec: JSON.stringify(server.spec), state: this._states.get(server.id)}]));
    }

    // kept: from _keptStates(), across a settings change or a screen lock.
    _createServers(kept = null) {
        for (const server of this._servers ?? [])
            server.destroy();
        const specs = serverSpecs(this._settings);
        this._servers = specs.map(spec => new T3Server(spec, this._http));
        // A server whose address or sign-in changed starts over.
        this._states.clear();
        for (const spec of specs) {
            const entry = kept?.get(spec.id);
            if (entry && entry.spec === JSON.stringify(spec)) {
                // The re-check throttle runs on a clock that stops during suspend, and
                // after a lock the server may hold old data: it may be re-checked at once.
                this._states.set(spec.id, {...entry.state, lastForced: 0, observed: false});
            }
        }
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
        this._accounts = this._collectAccounts(servers);
        // Only what servers reported in this poll counts as seen; restored or earlier
        // answers are only shown.
        const answered = servers.filter(s => this._states.get(s.id)?.observed);
        this._recordAccounts(this._collectAccounts(answered), answered);
        this._render();
    }

    _collectAccounts(servers) {
        return collectAccounts(servers
            .map(server => ({env: server, state: this._states.get(server.id)}))
            .filter(({state}) => state?.providers)
            .map(({env, state}) => ({env, providers: state.providers, accents: state.accents})));
    }

    async _updateServer(server, force) {
        const state = this._states.get(server.id) ?? {lastForced: 0, accents: {}};
        this._states.set(server.id, state);
        try {
            const snapshot = await server.call('server.getConfig');
            for (const [id, instance] of Object.entries(snapshot.settings?.providerInstances ?? {}))
                state.accents[id] = instance?.accentColor ?? null;
            const providers = snapshot.providers ?? [];
            // Kept at once, so a lock during the re-check below keeps this answer.
            this._answered(state, providers);

            const checked = providers.filter(p => p.enabled && p.usageLimits?.checkedAt);
            const newest = Math.min(...checked.map(p => secondsSince(p.usageLimits.checkedAt)));
            const now = GLib.get_monotonic_time() / 1e6;
            if (force || (newest > FORCE_REFRESH_SECONDS && now - state.lastForced > FORCE_REFRESH_SECONDS)) {
                state.lastForced = now;
                try {
                    const fresh = (await server.call('server.refreshProviders')).providers;
                    if (fresh)
                        this._answered(state, fresh);
                } catch (e) {
                    // The snapshot from getConfig is still worth showing.
                    if (server === this._servers?.find(s => s.id === server.id))
                        console.warn(`T3 AI Usage: ${server.name}: re-check failed: ${e.message ?? e}`);
                }
            }
        } catch (e) {
            if (server !== this._servers?.find(s => s.id === server.id))
                return;
            const error = e.message ?? String(e);
            // Logged when it changes, not on every poll.
            if (error !== state.error)
                console.warn(`T3 AI Usage: ${server.name}: ${error}`);
            state.error = error;
            state.unavailable = e instanceof Unavailable;
            state.network = e instanceof Unavailable && e.network;
            state.observed = false;
        }
    }

    // The server answered with these providers. The time is wall-clock time, so a
    // suspend counts towards the grace period; a failed re-check keeps it.
    _answered(state, providers) {
        state.providers = providers;
        state.error = null;
        state.unavailable = false;
        state.network = false;
        state.observed = true;
        state.okSeconds = GLib.get_real_time() / 1e6;
        state.okAt = GLib.DateTime.new_from_unix_local(Math.floor(state.okSeconds));
    }

    // Remembers every account and its limit windows for the preferences window, and
    // forgets dead ones together with their settings (see reconcileAccounts). Accounts
    // seen for the first time go into the saved order (and Claude/Codex ones into the
    // top bar); one that follows an account under a new key takes over its settings.
    // answered: the servers that answered in this poll.
    _recordAccounts(accounts, answered) {
        let known = null;
        try {
            known = JSON.parse(this._settings.get_string('known-accounts'));
        } catch {}
        // A saved list that cannot be read is replaced, but forgets no settings.
        const readable = Array.isArray(known);
        const providers = new Map(answered.map(server => [server.id, this._states.get(server.id).providers]));
        const today = GLib.DateTime.new_now_local().format('%F');
        const result = reconcileAccounts(readable ? known : [], accounts, this._servers, providers, today);
        const next = JSON.stringify(result.known);
        if (next !== this._settings.get_string('known-accounts'))
            this._settings.set_string('known-accounts', next);

        const keep = new Set(result.known.map(k => k.key));
        const prune = keys => (readable ? keys.filter(key => keep.has(key)) : keys);
        // An account that follows another goes right after it; when that one is not in
        // the list, at the end if `always`.
        const follow = (list, always) => {
            for (const [key, before] of result.inherited) {
                const i = list.indexOf(before);
                if (list.includes(key) || (i < 0 && !always))
                    continue;
                list = i < 0 ? [...list, key] : [...list.slice(0, i + 1), key, ...list.slice(i + 1)];
            }
            return list;
        };
        const save = (key, value) => {
            if (JSON.stringify(value) !== JSON.stringify(this._settings.get_strv(key)))
                this._settings.set_strv(key, value);
        };

        const order = follow(this._settings.get_strv('account-order'), true);
        save('account-order', prune([...order, ...result.fresh.map(a => a.key).filter(k => !order.includes(k))]));
        const panel = follow(this._settings.get_strv('panel-accounts'), false);
        const add = result.fresh.filter(a => PANEL_DEFAULT_DRIVERS.includes(a.driver) && !panel.includes(a.key));
        save('panel-accounts', prune([...panel, ...add.map(a => a.key)]));

        // Hidden windows are saved as `account key|window id`.
        const owner = entry => [...keep].find(key => entry.startsWith(`${key}|`));
        let hidden = this._settings.get_strv('hidden-windows');
        for (const [key, before] of result.inherited) {
            hidden = [...hidden, ...hidden.filter(entry => entry.startsWith(`${before}|`))
                .map(entry => `${key}${entry.slice(before.length)}`)];
        }
        hidden = [...new Set([...hidden, ...result.hide])];
        save('hidden-windows', readable ? hidden.filter(entry => owner(entry)) : hidden);

        const labels = this._settings.get_value('labels').deepUnpack();
        const nextLabels = {...labels};
        for (const [key, before] of result.inherited) {
            if (labels[before] && !labels[key])
                nextLabels[key] = labels[before];
        }
        for (const key of Object.keys(nextLabels)) {
            if (readable && !keep.has(key))
                delete nextLabels[key];
        }
        if (JSON.stringify(nextLabels) !== JSON.stringify(labels))
            this._settings.set_value('labels', new GLib.Variant('a{ss}', nextLabels));
    }

    _render() {
        if (!this._button)
            return;
        // Accounts only on servers that are off are left out; the menu says the server is off.
        const ordered = applyOrder(this._accounts.filter(a => !a.serverIds.every(id => this._off(id))),
            this._settings.get_strv('account-order'));
        const labels = this._settings.get_value('labels').deepUnpack();
        this._renderPanel(ordered, labels);
        this._renderMenu(ordered);
    }

    _hasData() {
        return this._accounts.length > 0;
    }

    // The server has failed since it last answered, or never answered, for longer
    // than the grace period.
    _down(server) {
        const state = this._states.get(server.id);
        const sinceOk = state?.okSeconds ? GLib.get_real_time() / 1e6 - state.okSeconds : null;
        return serverDown(state?.error, state?.unavailable, sinceOk);
    }

    // Every server is down, or none is set up.
    _allFailed() {
        return this._servers.every(server => this._down(server));
    }

    // The server is down only because it does not answer: T3 is off or out of reach.
    // A server no longer configured counts as off.
    _off(id) {
        const server = this._servers.find(s => s.id === id);
        return !server || (this._down(server) && this._states.get(id).unavailable);
    }

    // Builds the top bar in the roomiest layout that fits.
    _renderPanel(accounts, labels) {
        this._panelArgs = [accounts, labels];
        const room = this._panelRoom();
        const spare = PANEL_SPARE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._panelWidths = [];
        let layout = 0;
        for (; ; layout++) {
            this._buildPanel(accounts, labels, PANEL_LAYOUTS[layout]);
            if (layout === PANEL_LAYOUTS.length - 1 || room === Infinity)
                break;
            const [, width] = this._button.container.get_preferred_width(-1);
            this._panelWidths[layout] = width;
            if (width + (layout < this._panelLayout ? spare : 0) <= room)
                break;
        }
        this._panelLayout = layout;
    }

    // The width the top bar can give the indicator, in physical pixels: GNOME gives
    // the side box it sits in the room up to the centre box, less the other
    // indicators there. Infinity when that is not known.
    _panelRoom() {
        const container = this._button.container;
        const box = container.get_parent();
        const {_leftBox: left, _centerBox: center, _rightBox: right} = Main.panel;
        if (!center || !box || (box !== left && box !== right) || !box.get_stage() || !container.visible)
            return Infinity;
        // The centre box starts at the side boxes' width rounded up.
        const side = center.get_allocation_box().x1 - 1;
        if (side <= 0)
            return Infinity;
        const [, boxWidth] = box.get_preferred_width(-1);
        const [, ownWidth] = container.get_preferred_width(-1);
        return side - (boxWidth - ownWidth);
    }

    _queueFit() {
        if (this._fitLater || !this._button)
            return;
        this._fitLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._fitLater = 0;
            this._fitPanel();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Changes the layout when the room in the top bar changed enough.
    _fitPanel() {
        if (!this._button || !this._panelArgs)
            return;
        const room = this._panelRoom();
        const spare = PANEL_SPARE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, width] = this._button.container.get_preferred_width(-1);
        const tighter = this._panelLayout < PANEL_LAYOUTS.length - 1 && width > room;
        const roomier = this._panelLayout > 0 && this._panelWidths[this._panelLayout - 1] + spare <= room;
        if (tighter || roomier)
            this._renderPanel(...this._panelArgs);
    }

    _buildPanel(accounts, labels, layout) {
        this._panelBox.destroy_all_children();
        this._panelBox.style_class = layout.tight ? 't3-ai-usage-panel t3-ai-usage-panel-tight' : 't3-ai-usage-panel';
        if (!this._hasData() || this._allFailed()) {
            const failed = this._allFailed();
            // Every server is off or out of reach: nothing is wrong that the user could fix here.
            const off = failed && this._servers.length > 0 && this._servers.every(server => this._off(server.id));
            this._panelBox.add_child(new St.Label({
                text: off ? 'T3 off' : failed ? '⚠ AI' : 'AI …',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: off ? 't3-ai-usage-dim' : failed ? 't3-ai-usage-error' : null,
            }));
            return;
        }
        const panel = new Set(this._settings.get_strv('panel-accounts'));
        const showLabel = this._settings.get_boolean('show-label');
        const showPercent = this._settings.get_boolean('show-percent');
        const resetMode = this._settings.get_string('reset-mode');
        const round = this._settings.get_boolean('round-times');
        for (const account of accounts.filter(a => panel.has(a.key))) {
            const box = new St.BoxLayout({
                style_class: layout.tight ? 't3-ai-usage-account t3-ai-usage-account-tight' : 't3-ai-usage-account',
                y_align: Clutter.ActorAlign.CENTER,
            });
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
            if (binding && layout.text && showPercent)
                parts.push(`${Math.round(100 - binding.pct)}%`);
            if (binding && layout.text && (resetMode === 'always' || (resetMode === 'near-limit' && binding.pct >= 75)))
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
        const note = (text, styleClass = 't3-ai-usage-error') =>
            this._status.add_child(new St.Label({text, style_class: styleClass}));
        for (const server of this._servers) {
            const state = this._states.get(server.id);
            if (this._off(server.id)) {
                note(`${server.name}: ${state.network ? 'not reachable' : 'T3 is off'}`, 't3-ai-usage-dim');
                continue;
            }
            if (state?.error && this._down(server)) {
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
