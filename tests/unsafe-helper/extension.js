import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Unsafe mode opens org.gnome.Shell.Eval and the Screenshot API to the test script.
export default class UnsafeHelper extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
