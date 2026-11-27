#!/bin/bash
# Runs the extension in a headless GNOME Shell against tests/mock-t3.js, then saves
# a report and screenshots of the top bar, the menu and the preferences.
#
#   tests/headless.sh OUTPUT_DIR
#   MONITOR=1728x420 tests/headless.sh OUTPUT_DIR   (a short screen: the menu scrolls)
#   MONITOR=840x700 tests/headless.sh OUTPUT_DIR    (a narrow screen: the top bar tightens;
#                                                    800x700 drops the times, 640x700 shows "+N")
#
# The saved settings start with two accounts from older versions: Codex under an
# old key, with a label, a hidden limit and a top-bar switch, which the new key
# takes over, and a Claude account T3 no longer runs, which is dropped. At the end
# the mock T3 stops, and the top bar and the menu say T3 is off.
#
# Needs gnome-shell, gjs, dbus-run-session and python3-gi. Nothing outside a
# temporary directory is touched: HOME, the XDG directories and GSettings all
# point there.
set -eu

if [ "${1:-}" = --inside ]; then
    OUT=$2
    ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
    shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$1" > /dev/null; }
    if [ ! -S /run/dbus/system_bus_socket ]; then
        # Containers have no system bus, and GNOME Shell does not start without one.
        { read -r address; read -r system_bus; } < <(dbus-daemon --session --fork --print-address=1 --print-pid=1)
        export DBUS_SYSTEM_BUS_ADDRESS=$address
    fi
    gnome-shell --headless --wayland --virtual-monitor "$MONITOR" > "$OUT/shell.log" 2>&1 &
    shell=$!
    for _ in $(seq 90); do
        ev 'true' 2> /dev/null | grep -q '^(true' && break
        sleep 1
    done
    sleep 12
    {
        echo "gnome-shell: $(gnome-shell --version)"
        echo "extension: $(gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions \
            --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" | tr ',' '\n' | grep -E "'state'|'error'" | tr -d ' \n')"
        ev "Main.overview.hide(); Main.messageTray._bannerBin?.hide(); 'ok'" > /dev/null
        sleep 2
        echo "panel: $(ev "Main.panel.statusArea['$UUID'].get_children()[0].get_children().map(b => b.get_children().map(x => x.text ?? 'ring').join(' ')).join(' | ')")"
        # Layout chosen, width given and wanted, and whether GNOME shortened any label.
        echo "panel-fit: $(ev "const e = Main.extensionManager.lookup('$UUID').stateObj; const c = Main.panel.statusArea['$UUID'].container; const labels = []; const walk = a => { if (a instanceof imports.gi.St.Label) labels.push(a); a.get_children().forEach(walk); }; walk(c); ['step ' + e._panelStep + ' (room ' + Math.round(e._panelRoom()) + ', tried ' + e._panelWidths.join('/') + ')', Math.round(c.get_allocation_box().get_width()) + ' of ' + Math.round(c.get_preferred_width(-1)[1]), labels.some(l => l.clutter_text.get_layout().is_ellipsized()) ? 'shortened' : 'whole'].join(', ')")"
        echo "settings: $(ev "const s = Main.extensionManager.lookup('$UUID').stateObj._settings; JSON.stringify({known: JSON.parse(s.get_string('known-accounts')).map(k => k.key), order: s.get_strv('account-order'), panel: s.get_strv('panel-accounts'), labels: s.get_value('labels').deepUnpack(), hidden: s.get_strv('hidden-windows')})")"
        ev "Main.panel.statusArea['$UUID'].menu.open(); 'ok'" > /dev/null
        sleep 2
        echo "menu: $(ev "const out = []; const walk = a => { if (a instanceof imports.gi.St.Label && a.text) out.push(a.text); a.get_children?.().forEach(walk); }; walk(Main.panel.statusArea['$UUID'].menu.box); out.join(' / ')")"
        echo "menu-box: $(ev "const b = Main.panel.statusArea['$UUID'].menu.actor; const [x, y] = b.get_transformed_position(); [x, y, b.width, b.height].map(Math.round).join(' ')")"
        # The menu ends above the screen's bottom edge; its account list scrolls (content
        # height, visible height); the wheel reaches the list. After the screenshots: the keyboard reaches the footer.
        echo "menu-fits: $(ev "const b = Main.panel.statusArea['$UUID'].menu.actor; b.get_transformed_position()[1] + b.height <= global.stage.height")"
        echo "menu-scroll: $(ev "const s = Main.extensionManager.lookup('$UUID').stateObj._scroll; const a = s.get_vadjustment(); const [x, y] = s.get_transformed_position(); const picked = global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, x + 40, y + 20); [Math.round(a.upper), Math.round(a.page_size), picked === s ? 'wheel-ok' : 'wheel-missed'].join(' ')")"
    } > "$OUT/report.txt" 2>&1
    shot "$OUT/menu-full.png"
    ev "const a = Main.extensionManager.lookup('$UUID').stateObj._scroll.get_vadjustment(); a.value = a.upper; 'ok'" > /dev/null
    sleep 1
    shot "$OUT/menu-scrolled-full.png"
    echo "menu-keys: $(ev "const m = Main.panel.statusArea['$UUID'].menu; m.actor.navigate_focus(null, imports.gi.St.DirectionType.TAB_FORWARD, false); global.stage.key_focus?.label ?? 'none'")" >> "$OUT/report.txt"
    ev "Main.panel.statusArea['$UUID'].menu.close(); 'ok'" > /dev/null
    gnome-extensions prefs "$UUID" > "$OUT/prefs.log" 2>&1 || echo "prefs: could not open" >> "$OUT/report.txt"
    sleep 6
    ev "Main.overview.hide(); global.display.focus_window?.move_resize_frame(false, 514, 36, 700, 1040); 'ok'" > /dev/null
    sleep 2
    echo "prefs-window: $(ev "const w = global.display.focus_window; w ? [w.get_frame_rect().x, w.get_frame_rect().y, w.get_frame_rect().width, w.get_frame_rect().height, w.title].join(' ') : 'none'")" >> "$OUT/report.txt"
    shot "$OUT/prefs-full.png"

    # T3 stops, and has not answered for longer than the grace period.
    kill "$MOCK_PID"
    ev "const e = Main.extensionManager.lookup('$UUID').stateObj; for (const s of e._states.values()) s.okSeconds -= 3600; e._refresh(true); 'ok'" > /dev/null
    sleep 4
    echo "off-panel: $(ev "Main.panel.statusArea['$UUID'].get_children()[0].get_children().map(x => x.text ?? 'box').join(' | ')")" >> "$OUT/report.txt"
    echo "off-menu: $(ev "const out = []; const walk = a => { if (a instanceof imports.gi.St.Label && a.text) out.push(a.text); a.get_children?.().forEach(walk); }; walk(Main.panel.statusArea['$UUID'].menu.box); out.join(' / ')")" >> "$OUT/report.txt"
    kill "$shell"
    wait "$shell" 2> /dev/null || true
    [ -n "${system_bus:-}" ] && kill "$system_bus"
    exit 0
fi

REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
export UUID=t3-ai-usage@mawox.github.io MONITOR=${MONITOR:-1728x1080}
# A short path: the Wayland socket path must stay under 108 bytes.
WORK=$(mktemp -d /tmp/t3aiu.XXXXXX)
export HOME=$WORK/home XDG_CONFIG_HOME=$WORK/config XDG_DATA_HOME=$WORK/data XDG_CACHE_HOME=$WORK/cache
export XDG_RUNTIME_DIR=$WORK/run GSETTINGS_BACKEND=keyfile
mkdir -p "$HOME/.t3/bin" "$XDG_CONFIG_HOME/glib-2.0/settings" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
cp "$REPO/tests/fake-t3" "$HOME/.t3/bin/t3"

EXT=$XDG_DATA_HOME/gnome-shell/extensions
mkdir -p "$EXT/$UUID/schemas"
cp "$REPO"/{extension.js,prefs.js,model.js,t3client.js,stylesheet.css,metadata.json} "$EXT/$UUID/"
cp "$REPO"/schemas/*.gschema.xml "$EXT/$UUID/schemas/"
glib-compile-schemas "$EXT/$UUID/schemas"
cp -r "$REPO/tests/unsafe-helper" "$EXT/unsafe-helper@t3-ai-usage.test"
cat > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" << KEYS
[org/gnome/shell]
enabled-extensions=['unsafe-helper@t3-ai-usage.test', '$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/shell/extensions/t3-ai-usage]
known-accounts='[{"key":"codex:fp:0123456789abcdef","name":"Codex","driver":"codex","plan":"ChatGPT Pro","sources":["This computer"],"lastSeen":"$(date -d '-3 days' +%F)","windows":[{"id":"primary","label":"Session"}]},{"key":"claudeAgent:old@example.com","name":"Claude Old","driver":"claudeAgent","plan":"Claude Pro","sources":["This computer"],"lastSeen":"$(date -d '-2 days' +%F)","windows":[]}]'
account-order=['codex:fp:0123456789abcdef', 'claudeAgent:old@example.com']
panel-accounts=['codex:fp:0123456789abcdef', 'claudeAgent:old@example.com']
labels={'codex:fp:0123456789abcdef': 'Gx', 'claudeAgent:old@example.com': 'Co'}
hidden-windows=['codex:fp:0123456789abcdef|primary']
KEYS

gjs -m "$REPO/tests/mock-t3.js" --port 3999 --base-dir "$HOME/.t3" > "$OUT/mock.log" 2>&1 &
mock=$!
export MOCK_PID=$mock
# The mock may have stopped already: the test stops it to see T3 off.
trap 'kill $mock 2> /dev/null || true; rm -rf "$WORK"' EXIT
dbus-run-session -- "$0" --inside "$OUT"

python3 - "$OUT" << 'PY'
import sys
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
out = sys.argv[1]
report = dict(line.split(': ', 1) for line in open(f'{out}/report.txt') if ': ' in line)
def crop(name, x, y, w, h, source=None):
    try:
        full = GdkPixbuf.Pixbuf.new_from_file(f'{out}/{source or name}-full.png')
    except Exception as e:
        print(f'{name}: {e}')
        return
    x, y = max(0, x), max(0, y)
    w, h = min(w, full.get_width() - x), min(h, full.get_height() - y)
    full.new_subpixbuf(x, y, w, h).savev(f'{out}/{name}.png', 'png', [], [])
nums = [int(n) for n in report.get('menu-box', '').replace("'", ' ').replace('"', ' ').replace(',', ' ').replace(')', ' ').split() if n.lstrip('-').isdigit()]
if len(nums) >= 4:
    x, y, w, h = nums[-4:]
    crop('menu', x - 24, 0, w + 48, y + h + 24)
    crop('menu-scrolled', x - 24, 0, w + 48, y + h + 24)
    crop('panel', x + w - 536, 0, 560, max(28, y - 4), source='menu')
win = report.get('prefs-window', '').replace("'", ' ').replace('"', ' ').replace(')', ' ').split()
nums = [int(n) for n in win if n.lstrip('-').isdigit()]
if len(nums) >= 4:
    crop('prefs', *nums[:4])
PY
cat "$OUT/report.txt"
grep -E "JS ERROR|TypeError|ReferenceError|SyntaxError|t3-ai-usage|T3 AI Usage" "$OUT/shell.log" "$OUT/prefs.log" 2> /dev/null | grep -v "a11y" | head -20 || true
