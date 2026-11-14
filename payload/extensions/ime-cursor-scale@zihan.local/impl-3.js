// 1. Scale the shell's IBus cursor rect into XWayland's (logical * ceil(max scale))
//    space so fcitx5's X11 candidate window lands under the cursor.
// 2. That window is an app window: the overview hides window_group, and shell
//    popups (emoji picker, dialogs) sit above it. When typing happens in the
//    shell itself (or windows are hidden), draw a Clutter.Clone of it on top.
// 3. St.Entry keeps showing its hint text while a preedit string is shown;
//    hide the hint while preediting.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import IBus from 'gi://IBus';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DEBUG = false; // impl-2 debugging showed: window-created is what catches fcitx (child-added never fires)
function dbg(msg) {
    if (DEBUG)
        console.log(`[ime-cursor-scale] ${msg}`);
}

export class Impl {
    enable() {
        this._fcitx = false;
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, 'org.fcitx.Fcitx5',
            Gio.BusNameWatcherFlags.NONE,
            () => { this._fcitx = true; },
            () => { this._fcitx = false; });

        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        const readNative = () => {
            this._native = this._mutter.get_strv('experimental-features')
                .includes('xwayland-native-scaling');
        };
        readNative();
        this._mutterId = this._mutter.connect('changed::experimental-features', readNative);

        const self = this;

        const icProto = IBus.InputContext.prototype;
        const origLoc = icProto.set_cursor_location;
        this._origLoc = origLoc;
        icProto.set_cursor_location = function (x, y, w, h) {
            const s = self._scale();
            if (s !== 1 && (x || y || w || h)) {
                return origLoc.call(this, Math.round(x * s), Math.round(y * s),
                    Math.round(w * s), Math.round(h * s));
            }
            return origLoc.call(this, x, y, w, h);
        };

        const imProto = Clutter.InputMethod.prototype;
        const origPre = imProto.set_preedit_text;
        this._origPre = origPre;
        imProto.set_preedit_text = function (text, ...rest) {
            const r = origPre.call(this, text, ...rest);
            try {
                self._syncHint(!!text);
            } catch (e) {
                logError(e, 'ime-cursor-scale');
            }
            return r;
        };

        this._clones = new Map();
        this._pending = new Map();
        this._groupId = global.window_group.connect('child-added',
            (_g, actor) => { dbg(`window_group child-added ${actor}`); this._maybeTrack(actor); });
        this._topId = global.top_window_group.connect('child-added',
            (_g, actor) => { dbg(`top_window_group child-added ${actor}`); this._maybeTrack(actor); });
        this._createdId = global.display.connect('window-created', (_d, win) => {
            dbg(`window-created class=${win.get_wm_class()} or=${win.is_override_redirect()} actor=${win.get_compositor_private()}`);
            const a = win.get_compositor_private();
            if (a)
                this._maybeTrack(a);
        });
        this._groupVisId = global.window_group.connect('notify::visible', () => this._syncAll());
        this._focusId = global.stage.connect('notify::key-focus', () => this._syncAll());
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncAll());
        for (const actor of global.window_group.get_children())
            this._maybeTrack(actor);
        for (const actor of global.top_window_group.get_children())
            this._maybeTrack(actor);
        dbg('enabled (impl-2)');
    }

    _scale() {
        if (!this._fcitx || !this._native)
            return 1;
        const d = global.display;
        let max = 1;
        for (let i = 0; i < d.get_n_monitors(); i++)
            max = Math.max(max, d.get_monitor_scale(i));
        return Math.ceil(max);
    }

    _syncHint(preediting) {
        const focus = global.stage.get_key_focus();
        if (!(focus instanceof Clutter.Text))
            return;
        const entry = focus.get_parent();
        if (!(entry instanceof St.Entry) || !entry.hint_actor)
            return;
        entry.hint_actor.visible = !preediting && entry.get_text() === '';
    }

    _isFcitx(actor) {
        const win = actor?.meta_window;
        return !!win && win.is_override_redirect() && win.get_wm_class() === 'fcitx';
    }

    _maybeTrack(actor) {
        if (!(actor instanceof Meta.WindowActor) || this._clones.has(actor) || this._pending.has(actor))
            return;
        if (!actor.meta_window) {
            const id = actor.connect('notify::meta-window', () => {
                actor.disconnect(id);
                this._pending.delete(actor);
                this._maybeTrack(actor);
            });
            this._pending.set(actor, id);
            return;
        }
        if (!this._isFcitx(actor))
            return;
        dbg(`tracking fcitx actor parent=${actor.get_parent()} pos=${actor.x},${actor.y}`);
        const clone = new Clutter.Clone({source: actor, reactive: false, visible: false});
        Main.layoutManager.uiGroup.add_child(clone);
        const sync = () => this._sync(actor, clone);
        const ids = [
            actor.connect('notify::x', sync),
            actor.connect('notify::y', sync),
            actor.connect('notify::visible', sync),
            actor.connect('destroy', () => this._untrack(actor)),
        ];
        this._clones.set(actor, {clone, ids});
        sync();
    }

    _untrack(actor) {
        const data = this._clones.get(actor);
        if (!data)
            return;
        this._clones.delete(actor);
        for (const id of data.ids)
            actor.disconnect(id);
        data.clone.destroy();
    }

    _shellHasTyping() {
        // key focus on a shell text actor = the shell itself is the IME client
        return global.stage.get_key_focus() instanceof Clutter.Text;
    }

    _sync(actor, clone) {
        const show = actor.visible && !Main.sessionMode.isLocked &&
            (!global.window_group.visible || this._shellHasTyping());
        dbg(`sync visible=${actor.visible} groupVis=${global.window_group.visible} focus=${global.stage.get_key_focus()} show=${show} pos=${actor.x},${actor.y}`);
        clone.visible = show;
        if (show) {
            clone.set_position(actor.x, actor.y);
            Main.layoutManager.uiGroup.set_child_above_sibling(clone, null);
        }
    }

    _syncAll() {
        for (const [actor, {clone}] of this._clones)
            this._sync(actor, clone);
    }

    disable() {
        IBus.InputContext.prototype.set_cursor_location = this._origLoc;
        Clutter.InputMethod.prototype.set_preedit_text = this._origPre;
        global.window_group.disconnect(this._groupId);
        global.top_window_group.disconnect(this._topId);
        global.display.disconnect(this._createdId);
        global.window_group.disconnect(this._groupVisId);
        global.stage.disconnect(this._focusId);
        Main.sessionMode.disconnect(this._sessionId);
        for (const [actor, id] of this._pending)
            actor.disconnect(id);
        this._pending = null;
        for (const actor of [...this._clones.keys()])
            this._untrack(actor);
        this._clones = null;
        Gio.bus_unwatch_name(this._watchId);
        this._mutter.disconnect(this._mutterId);
        this._mutter = null;
    }
}
