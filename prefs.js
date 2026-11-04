import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {applyOrder, windowKey} from './model.js';
import {
    addServer, isLoopback, makeHttpSession, parseCredential, parseServers, readToken, removeServer, renewServer,
} from './t3client.js';

const RESET_MODES = [
    ['always', 'Always'],
    ['near-limit', 'From 25 % left'],
    ['never', 'Never'],
];

function toast(window, title) {
    window.add_toast(new Adw.Toast({title, use_markup: false, timeout: 6}));
}

function signInText(auth) {
    if (!auth)
        return 'not signed in';
    const expires = auth.expiresAt ? GLib.DateTime.new_from_iso8601(auth.expiresAt, null) : null;
    if (!expires)
        return 'signed in';
    if (expires.to_unix() * 1000 <= Date.now())
        return 'sign-in expired';
    return `signed in until ${expires.to_local().format('%-d %b %Y')}`;
}

export default class T3AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const http = makeHttpSession();
        window._settings = settings;
        window.set_default_size(640, 720);

        const page = new Adw.PreferencesPage({title: 'T3 AI Usage', icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);
        const ids = [];
        page.add(this._displayGroup(settings, ids));

        const accounts = new Adw.PreferencesGroup({
            title: 'Accounts',
            description: 'The menu lists every account in this order. The switch puts an account in the top bar; ' +
                'the short field changes its label there. Open an account to choose which of its limits show.',
        });
        page.add(accounts);
        let rows = [];
        // Rows are rebuilt when the extension records accounts or the order changes;
        // open accounts stay open.
        const expanded = new Set();
        const rebuild = () => {
            for (const row of rows)
                accounts.remove(row);
            rows = this._accountRows(settings, expanded);
            for (const row of rows)
                accounts.add(row);
        };
        rebuild();
        for (const key of ['known-accounts', 'account-order'])
            ids.push(settings.connect(`changed::${key}`, rebuild));

        page.add(this._serversGroup(window, settings, http, ids));
        window.connect('close-request', () => {
            for (const id of ids)
                settings.disconnect(id);
            http.abort();
            return false;
        });
    }

    _serversGroup(window, settings, http, ids) {
        const group = new Adw.PreferencesGroup({
            title: 'Servers',
            description: 'Other computers running T3 Code, such as a server you reach over Tailscale. Sign in ' +
                'with a pairing link created in T3, which signs in for 30 days, or with the token that ' +
                '“t3 auth session issue --scope orchestration:read --ttl 180d” prints on that computer.',
        });
        const local = new Adw.SwitchRow({title: 'This computer', subtitle: 'T3 Code here; signs in by itself'});
        settings.bind('local-server', local, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(local);

        let rows = [];
        const rebuild = () => {
            for (const row of rows)
                group.remove(row);
            rows = [
                ...parseServers(settings.get_string('servers')).map(server =>
                    this._serverRow(window, settings, http, server)),
                this._addServerRow(window, settings, http),
            ];
            for (const row of rows)
                group.add(row);
        };
        rebuild();
        ids.push(settings.connect('changed::servers', rebuild));
        return group;
    }

    _serverRow(window, settings, http, server) {
        const row = new Adw.ExpanderRow({use_markup: false, title: server.name, subtitle: server.url});
        readToken(server.id).then(auth => {
            row.subtitle = `${server.url} · ${signInText(auth)}`;
        });

        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove this server',
            css_classes: ['flat'],
        });
        remove.connect('clicked', () => removeServer(settings, server));
        row.add_suffix(remove);

        const credential = new Adw.PasswordEntryRow({title: 'New pairing link or token', show_apply_button: true});
        credential.connect('apply', async () => {
            try {
                await renewServer(settings, http, server, credential.text);
                toast(window, `Signed in to ${server.name}`);
            } catch (e) {
                toast(window, `${server.name}: ${e.message}`);
            }
        });
        row.add_row(credential);
        return row;
    }

    _addServerRow(window, settings, http) {
        const row = new Adw.ExpanderRow({
            title: 'Add a server',
            subtitle: 'Paste a pairing link or a token from T3 Code on that computer',
        });
        const credential = new Adw.PasswordEntryRow({title: 'Pairing link or token'});
        const address = new Adw.EntryRow({title: 'Address, such as https://server.tailnet.ts.net'});
        const name = new Adw.EntryRow({title: 'Name (optional)'});
        // A pairing link names its server, unless T3 printed it for 127.0.0.1.
        credential.connect('changed', () => {
            const {url} = parseCredential(credential.text);
            if (url && !isLoopback(url) && !address.text.trim())
                address.text = url;
        });

        const actions = new Adw.ActionRow();
        const add = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        add.connect('clicked', async () => {
            add.sensitive = false;
            try {
                const server = await addServer(settings, http,
                    {name: name.text, address: address.text, credential: credential.text});
                toast(window, `Added ${server.name}`);
            } catch (e) {
                toast(window, e.message);
                add.sensitive = true;
            }
        });
        actions.add_suffix(add);
        for (const child of [credential, address, name, actions])
            row.add_row(child);
        return row;
    }

    _displayGroup(settings, ids) {
        const group = new Adw.PreferencesGroup({title: 'Display'});

        const label = new Adw.SwitchRow({title: 'Account label', subtitle: 'Short name before each ring'});
        settings.bind('show-label', label, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(label);

        const percent = new Adw.SwitchRow({title: 'Percentage', subtitle: 'Share left of the fullest window'});
        settings.bind('show-percent', percent, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(percent);

        const reset = new Adw.ComboRow({
            title: 'Time until reset',
            subtitle: 'Of the fullest window',
            model: Gtk.StringList.new(RESET_MODES.map(([, text]) => text)),
        });
        const sync = () => {
            const i = RESET_MODES.findIndex(([value]) => value === settings.get_string('reset-mode'));
            if (reset.selected !== Math.max(0, i))
                reset.selected = Math.max(0, i);
        };
        sync();
        reset.connect('notify::selected', () => {
            const value = RESET_MODES[reset.selected]?.[0];
            if (value && value !== settings.get_string('reset-mode'))
                settings.set_string('reset-mode', value);
        });
        ids.push(settings.connect('changed::reset-mode', sync));
        group.add(reset);

        const round = new Adw.SwitchRow({
            title: 'Round times',
            subtitle: '16h instead of 15h59m, 4d instead of 4d11h, in the top bar and the menu',
        });
        settings.bind('round-times', round, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(round);
        return group;
    }

    _accountRows(settings, expanded) {
        let known = [];
        try {
            known = JSON.parse(settings.get_string('known-accounts'));
        } catch {}
        if (!known.length) {
            return [new Adw.ActionRow({
                title: 'No accounts yet',
                subtitle: 'They appear here once the extension has read T3 Code.',
            })];
        }
        const accounts = applyOrder(known, settings.get_strv('account-order'));
        const keys = accounts.map(a => a.key);

        return accounts.map((account, index) => {
            const today = GLib.DateTime.new_now_local().format('%F');
            const seen = account.lastSeen && account.lastSeen !== today ? ` · last seen ${account.lastSeen}` : '';
            const windows = account.windows ?? [];
            const keyOf = w => windowKey(account.key, w.id);
            const subtitle = () => {
                const hidden = settings.get_strv('hidden-windows');
                const count = windows.filter(w => hidden.includes(keyOf(w))).length;
                const note = count ? ` · ${count} ${count === 1 ? 'limit' : 'limits'} hidden` : '';
                return [account.plan, (account.sources ?? []).join(' + ')].filter(Boolean).join(' · ') + seen + note;
            };
            // Names and limit labels come from T3 as plain text ("Claude & GPT").
            const row = new Adw.ExpanderRow({
                use_markup: false,
                title: account.name,
                subtitle: subtitle(),
                enable_expansion: windows.length > 0,
                expanded: expanded.has(account.key),
            });
            row.connect('notify::expanded', () => {
                if (row.expanded)
                    expanded.add(account.key);
                else
                    expanded.delete(account.key);
            });
            for (const w of windows) {
                const shown = new Adw.SwitchRow({
                    use_markup: false,
                    title: w.label,
                    active: !settings.get_strv('hidden-windows').includes(keyOf(w)),
                });
                shown.connect('notify::active', () => {
                    const hidden = settings.get_strv('hidden-windows').filter(k => k !== keyOf(w));
                    if (!shown.active)
                        hidden.push(keyOf(w));
                    settings.set_strv('hidden-windows', hidden);
                    row.subtitle = subtitle();
                });
                row.add_row(shown);
            }

            const entry = new Gtk.Entry({
                width_chars: 4,
                max_width_chars: 4,
                max_length: 6,
                valign: Gtk.Align.CENTER,
                placeholder_text: account.defaultLabel,
                tooltip_text: 'Label in the top bar',
                text: settings.get_value('labels').deepUnpack()[account.key] ?? '',
            });
            entry.connect('changed', () => {
                const labels = settings.get_value('labels').deepUnpack();
                const text = entry.text.trim();
                if (text)
                    labels[account.key] = text;
                else
                    delete labels[account.key];
                settings.set_value('labels', new GLib.Variant('a{ss}', labels));
            });
            // An expander row puts each new suffix before the previous ones, so they are
            // collected left to right and added in reverse.
            const suffixes = [entry];

            for (const [icon, delta, tip] of [['go-up-symbolic', -1, 'Move up'], ['go-down-symbolic', 1, 'Move down']]) {
                const target = index + delta;
                const button = new Gtk.Button({
                    icon_name: icon,
                    valign: Gtk.Align.CENTER,
                    tooltip_text: tip,
                    sensitive: target >= 0 && target < keys.length,
                    css_classes: ['flat'],
                });
                button.connect('clicked', () => {
                    const next = [...keys];
                    [next[index], next[target]] = [next[target], next[index]];
                    settings.set_strv('account-order', next);
                });
                suffixes.push(button);
            }

            const toggle = new Gtk.Switch({
                valign: Gtk.Align.CENTER,
                active: settings.get_strv('panel-accounts').includes(account.key),
                tooltip_text: 'Show in the top bar',
            });
            toggle.connect('notify::active', () => {
                const panel = settings.get_strv('panel-accounts').filter(k => k !== account.key);
                if (toggle.active)
                    panel.push(account.key);
                settings.set_strv('panel-accounts', panel);
            });
            suffixes.push(toggle);
            for (const widget of suffixes.reverse())
                row.add_suffix(widget);
            return row;
        });
    }
}
