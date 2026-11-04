#!/bin/bash
# Runs the extension in a headless GNOME Shell against tests/mock-t3.js, then saves
# a report and screenshots of the top bar, the menu and the preferences.
#
#   tests/headless.sh OUTPUT_DIR
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
    gnome-shell --headless --wayland --virtual-monitor 1728x1080 > "$OUT/shell.log" 2>&1 &
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
        ev "Main.panel.statusArea['$UUID'].menu.open(); 'ok'" > /dev/null
        sleep 2
        echo "menu: $(ev "const out = []; const walk = a => { if (a instanceof imports.gi.St.Label && a.text) out.push(a.text); a.get_children?.().forEach(walk); }; walk(Main.panel.statusArea['$UUID'].menu.box); out.join(' / ')")"
        echo "menu-box: $(ev "const b = Main.panel.statusArea['$UUID'].menu.actor; const [x, y] = b.get_transformed_position(); [x, y, b.width, b.height].map(Math.round).join(' ')")"
    } > "$OUT/report.txt" 2>&1
    shot "$OUT/menu-full.png"
    ev "Main.panel.statusArea['$UUID'].menu.close(); 'ok'" > /dev/null
    gnome-extensions prefs "$UUID" > "$OUT/prefs.log" 2>&1 || echo "prefs: could not open" >> "$OUT/report.txt"
    sleep 6
    ev "Main.overview.hide(); global.display.focus_window?.move_resize_frame(false, 514, 36, 700, 1040); 'ok'" > /dev/null
    sleep 2
    echo "prefs-window: $(ev "const w = global.display.focus_window; w ? [w.get_frame_rect().x, w.get_frame_rect().y, w.get_frame_rect().width, w.get_frame_rect().height, w.title].join(' ') : 'none'")" >> "$OUT/report.txt"
    shot "$OUT/prefs-full.png"
    kill "$shell"
    wait "$shell" 2> /dev/null || true
    [ -n "${system_bus:-}" ] && kill "$system_bus"
    exit 0
fi

REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
export UUID=t3-ai-usage@mawox.github.io
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
KEYS

gjs -m "$REPO/tests/mock-t3.js" --port 3999 --base-dir "$HOME/.t3" > "$OUT/mock.log" 2>&1 &
mock=$!
trap 'kill $mock 2> /dev/null; rm -rf "$WORK"' EXIT
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
    crop('panel', 1728 - 560, 0, 560, max(28, y - 4), source='menu')
win = report.get('prefs-window', '').replace("'", ' ').replace('"', ' ').replace(')', ' ').split()
nums = [int(n) for n in win if n.lstrip('-').isdigit()]
if len(nums) >= 4:
    crop('prefs', *nums[:4])
PY
cat "$OUT/report.txt"
grep -E "JS ERROR|TypeError|ReferenceError|SyntaxError|t3-ai-usage|T3 AI Usage" "$OUT/shell.log" "$OUT/prefs.log" 2> /dev/null | grep -v "a11y" | head -20 || true
