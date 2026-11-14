/**
 * Emoji Picker (macOS style).
 *
 * Keybinding "toggle-picker" (default Super+period and Ctrl+Super+Space)
 * opens picker.js's modal popup. Placement: under the text cursor when the
 * shell knows it (clients that talk to the shell's input method, i.e.
 * text-input-v3 / the IBus path), else centred in the work area of the
 * focused window's monitor. With GTK_IM_MODULE=fcitx most apps send their
 * caret to fcitx5 directly and the shell never sees it, so expect "centred".
 *
 * Insertion (works for Wayland and XWayland clients alike, since it only
 * relies on the clipboard and on ordinary key events):
 *   1. remember the focused window when opening; close the picker (popModal
 *      gives the keyboard back to that window)
 *   2. snapshot the clipboard (one representation: copied files > image/png
 *      > text > first offered type)
 *   3. put the emoji on CLIPBOARD (St.Clipboard -> MetaSelectionSourceMemory;
 *      mutter bridges it to X11 for XWayland apps)
 *   4. wait until the user has let go of Super/Ctrl/Alt/Shift, re-activate the
 *      window if focus moved, then synthesize Ctrl+V (Ctrl+Shift+V for the
 *      terminal-wm-classes) on a Clutter virtual keyboard
 *   5. restore-clipboard-delay ms later put the snapshot back, unless
 *      something else took the clipboard in between
 * No window was focused (desktop) -> the emoji just stays on the clipboard.
 *
 * Why not commit text directly: Main.inputMethod.commit() only reaches
 * text-input-v3 clients (not XWayland Chrome / WeChat, and not apps using
 * the fcitx GTK/Qt modules), and virtual-keyboard keyvals for characters
 * outside the keymap are dropped by mutter ("No keycode found").
 *
 * Test hook: Main.extensionManager.lookup(uuid).stateObj.toggle()
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EmojiData} from './data.js';
import {Picker} from './picker.js';

const DEBUG = false;

const PASTE_DELAY_MS = 70;          // after focus is back, before Ctrl+V
const MODIFIER_WAIT_MAX_MS = 1500;  // max wait for the user to release modifiers
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024; // never round-trip anything bigger
const SNAPSHOT_TIMEOUT_MS = 300;    // clipboard owner that never answers
const HELD_MASK = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK |
    Clutter.ModifierType.MOD4_MASK;
const TEXT_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];

function log(message) {
    if (DEBUG)
        console.log(`[emoji-picker] ${message}`);
}

export default class EmojiPickerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._data = null;
        this._picker = null;
        this._target = null;
        this._timeouts = new Set();
        this._clipGeneration = 0;
        this._pending = null;   // in-flight insertion, so a second one cancels the restore

        const seat = global.stage.context.get_backend().get_default_seat();
        this._vkbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._clipGeneration++;
        });

        Main.wm.addKeybinding('toggle-picker', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP,
            () => this.toggle());

        // anything that takes the screen away closes the picker
        this._closers = [
            [Main.overview, Main.overview.connect('showing', () => this._picker?.close())],
            [Main.sessionMode, Main.sessionMode.connect('updated', () => this._picker?.close())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._picker?.close())],
        ];
        log('enabled');
    }

    disable() {
        Main.wm.removeKeybinding('toggle-picker');
        for (const [obj, id] of this._closers)
            obj.disconnect(id);
        this._closers = [];
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._selection.disconnect(this._ownerChangedId);
        this._selection = null;
        this._picker?.destroy();
        this._picker = null;
        this._data = null;
        this._vkbd = null;
        this._target = null;
        this._pending = null;
        this._settings = null;
        log('disabled');
    }

    _timeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _sleep(ms) {
        return new Promise(resolve => this._timeout(ms, resolve));
    }

    _ensurePicker() {
        if (this._picker)
            return true;
        try {
            const t0 = GLib.get_monotonic_time();
            this._data = new EmojiData(`${this.path}/emoji-data.json`);
            this._picker = new Picker({
                data: this._data,
                getRecent: () => this._settings.get_strv('recent-emoji'),
                getTone: () => this._settings.get_int('skin-tone'),
                onPick: (text, rec) => this._insert(text, rec).catch(e => logError(e, '[emoji-picker] insert')),
                log,
            });
            log(`loaded ${this._data.all.length} emoji in ${Math.round((GLib.get_monotonic_time() - t0) / 1000)} ms`);
            return true;
        } catch (e) {
            logError(e, '[emoji-picker] could not build the picker');
            this._picker = null;
            return false;
        }
    }

    toggle() {
        if (this._picker?.isOpen) {
            this._picker.close();
            return;
        }
        // POPUP is only in the binding's modes so the shortcut can close the
        // picker; never open on top of someone else's menu
        if (Main.actionMode !== Shell.ActionMode.NORMAL)
            return;
        if (!this._ensurePicker())
            return;

        this._target = global.display.get_focus_window();
        const monitor = this._target?.get_monitor() ?? global.display.get_current_monitor();
        const t0 = GLib.get_monotonic_time();
        this._picker.open(this._caretRect(), monitor >= 0 ? monitor : Main.layoutManager.primaryIndex);
        log(`open took ${Math.round((GLib.get_monotonic_time() - t0) / 1000)} ms, target ${this._describe(this._target)}`);
    }

    /** Caret rectangle the shell's input method got from the focused client, if any. */
    _caretRect() {
        const im = Main.inputMethod;
        const rect = im?._cursorRect;
        const win = this._target;
        if (!im?._currentFocus || !rect || !win || (rect.width <= 0 && rect.height <= 0))
            return null;
        const frame = win.get_frame_rect();
        const inside = rect.x >= frame.x - 4 && rect.y >= frame.y - 4 &&
            rect.x <= frame.x + frame.width + 4 && rect.y <= frame.y + frame.height + 4;
        return inside ? rect : null;
    }

    _describe(win) {
        if (!win)
            return 'none';
        return `"${win.get_title()}" (${win.get_wm_class()}, ${win.get_client_type() === Meta.WindowClientType.X11 ? 'X11' : 'Wayland'})`;
    }

    _isTerminal(win) {
        const names = [win.get_wm_class(), win.get_wm_class_instance(),
            win.get_gtk_application_id(), win.get_sandboxed_app_id?.()]
            .filter(s => s).map(s => s.toLowerCase());
        const terms = this._settings.get_strv('terminal-wm-classes').map(s => s.toLowerCase());
        return names.some(n => terms.includes(n));
    }

    _remember(text) {
        const max = this._settings.get_int('recent-max');
        const list = this._settings.get_strv('recent-emoji').filter(e => e !== text);
        list.unshift(text);
        this._settings.set_strv('recent-emoji', list.slice(0, max));
    }

    _snapshotClipboard() {
        const clipboard = St.Clipboard.get_default();
        const types = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (!types || types.length === 0)
            return Promise.resolve(null);
        let mimetype = ['x-special/gnome-copied-files', 'image/png'].find(t => types.includes(t));
        const isText = !mimetype && TEXT_TYPES.some(t => types.includes(t));
        if (!mimetype && !isText)
            mimetype = types[0];
        return new Promise(resolve => {
            let done = false;
            const finish = value => {
                if (!done) {
                    done = true;
                    resolve(value);
                }
            };
            this._timeout(SNAPSHOT_TIMEOUT_MS, () => finish(null));
            if (isText) {
                clipboard.get_text(St.ClipboardType.CLIPBOARD,
                    (_c, text) => finish(text !== null ? {text} : null));
            } else {
                // St unrefs `bytes` as soon as this callback returns (st-clipboard.c
                // transfer_bytes_cb), so copy the data out now. Keeping the GBytes and
                // using it 800 ms later handed mutter a freed object: it read a garbage
                // size and fallocate'd ~28 GB of memfd -> system-wide OOM (2026-11-11).
                clipboard.get_content(St.ClipboardType.CLIPBOARD, mimetype, (_c, bytes) => {
                    const size = bytes ? bytes.get_size() : 0;
                    if (size <= 0 || size > SNAPSHOT_MAX_BYTES) {
                        if (size > SNAPSHOT_MAX_BYTES)
                            log(`clipboard ${mimetype} is ${size} bytes; not snapshotting`);
                        finish(null);
                        return;
                    }
                    finish({mimetype, data: Uint8Array.from(bytes.toArray())});
                });
            }
        });
    }

    async _waitForModifierRelease() {
        const start = GLib.get_monotonic_time();
        while ((global.get_pointer()[2] & HELD_MASK) !== 0 &&
               GLib.get_monotonic_time() - start < MODIFIER_WAIT_MAX_MS * 1000)
            await this._sleep(25);
    }

    _sendPaste(withShift) {
        const vk = this._vkbd;
        let t = GLib.get_monotonic_time();
        const press = keyval => vk.notify_keyval(t++, keyval, Clutter.KeyState.PRESSED);
        const release = keyval => vk.notify_keyval(t++, keyval, Clutter.KeyState.RELEASED);
        press(Clutter.KEY_Control_L);
        if (withShift)
            press(Clutter.KEY_Shift_L);
        press(Clutter.KEY_v);
        release(Clutter.KEY_v);
        if (withShift)
            release(Clutter.KEY_Shift_L);
        release(Clutter.KEY_Control_L);
    }

    async _insert(text, rec) {
        this._remember(text);
        const target = this._target;
        this._target = null;
        const job = {};
        const previous = this._pending;
        this._pending = job;

        // a second insertion before the first restored: keep the first snapshot
        const snapshot = previous?.snapshot !== undefined && previous.restorePending
            ? previous.snapshot
            : await this._snapshotClipboard();
        if (previous)
            previous.restorePending = false;
        job.snapshot = snapshot;
        job.restorePending = true;

        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        const generation = this._clipGeneration;

        const alive = target && !target.unmanaging && target.get_compositor_private();
        if (!alive) {
            log(`picked ${text} (${rec?.n ?? '?'}): no target window, left on the clipboard`);
            job.restorePending = false;
            return;
        }

        await this._waitForModifierRelease();
        if (this._pending !== job)
            return;
        if (global.display.get_focus_window() !== target)
            target.activate(global.get_current_time());
        await this._sleep(PASTE_DELAY_MS);
        if (this._pending !== job || global.display.get_focus_window() !== target) {
            log(`picked ${text}: focus moved away from ${this._describe(target)}, not pasting`);
            job.restorePending = false;
            return;
        }

        const terminal = this._isTerminal(target);
        this._sendPaste(terminal);
        log(`pasted ${text} (${rec?.n ?? '?'}) into ${this._describe(target)} with ${terminal ? 'Ctrl+Shift+V' : 'Ctrl+V'}`);

        const delay = this._settings.get_int('restore-clipboard-delay');
        if (delay <= 0 || !snapshot) {
            job.restorePending = false;
            return;
        }
        await this._sleep(delay);
        if (!job.restorePending || this._pending !== job)
            return;
        job.restorePending = false;
        if (this._clipGeneration !== generation) {
            log('clipboard changed after the paste; not restoring');
            return;
        }
        const clipboard = St.Clipboard.get_default();
        if (snapshot.text !== undefined)
            clipboard.set_text(St.ClipboardType.CLIPBOARD, snapshot.text);
        else
            clipboard.set_content(St.ClipboardType.CLIPBOARD, snapshot.mimetype,
                new GLib.Bytes(snapshot.data));
        log(`clipboard restored (${snapshot.text !== undefined ? 'text' : snapshot.mimetype})`);
    }
}
