/**
 * Shortcut Cheatsheet (macOS "hold Cmd" style).
 *
 * Hold Super alone for hold_ms (default 800) -> sheet.js overlay; let go ->
 * it disappears and the Overview does NOT toggle. A quick tap still toggles
 * the Overview, Super+<key> hides the sheet and runs the shortcut.
 *
 * Detecting the hold without a busy poll:
 *   On Wayland the focused client has the keyboard, and mutter swallows the
 *   overlay-key press itself, so the shell gets no key event for Super. But
 *   every input event resets mutter's core idle monitor. A persistent idle
 *   watch of PROBE_MS fires whenever input pauses for PROBE_MS; it checks the
 *   modifier mask (global.get_pointer()). Super down and no other modifier ->
 *   a one-shot timer for the rest of hold_ms, after which we show the sheet
 *   only if Super is still the only modifier AND the idle time is still >=
 *   hold_ms (i.e. nothing at all was pressed, clicked or moved since).
 *   Cost while Super is up: zero timers; one cheap callback per input pause.
 *
 * While the sheet is up / until Super is released:
 *   - a user-active watch fires on the next input event. If the pointer did
 *     not move it was a key / click / scroll -> hide (the key itself reaches
 *     mutter or the app as usual, nothing is grabbed). Pointer motion only
 *     re-arms the watch.
 *   - a POLL_MS poll of the modifier mask notices the release (bounded: runs
 *     only between show and Super release).
 *
 * Suppressing the Overview toggle:
 *   mutter (keybindings.c, process_overlay_key) calls
 *   meta_compositor_filter_keybinding() for the overlay-key binding on Super
 *   release, before emitting MetaDisplay::overlay-key. That reaches ShellWM's
 *   "filter-keybinding" signal (true_handled accumulator): Main.wm's handler
 *   returns false for overlay-key in NORMAL/OVERVIEW, ours then returns true
 *   once -> mutter skips the emission. The flag is armed on show and dropped
 *   RELEASE_GRACE_MS after we see Super released (or when consumed), so it can
 *   never eat a later tap. Nothing of the shell is patched.
 *
 * Test hooks: Main.extensionManager.lookup(uuid).stateObj.{show(), hide(), status()}
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DEFAULTS} from './defaults.js';
import {Sheet} from './sheet.js';

const DEBUG = false;

const PROBE_MS = 100;           // input pause after which we look at the modifiers
const POLL_MS = 50;             // release poll, only while the sheet is up / armed
const RELEASE_GRACE_MS = 400;   // keep the overlay-key filter armed this long after release
const IDLE_SLACK_MS = 30;       // timer jitter allowance when re-checking the idle time

const SUPER = Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;
const OTHER_MODS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.MOD3_MASK |
    Clutter.ModifierType.MOD5_MASK | Clutter.ModifierType.HYPER_MASK |
    Clutter.ModifierType.META_MASK;
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK | Clutter.ModifierType.BUTTON4_MASK |
    Clutter.ModifierType.BUTTON5_MASK;
const ALLOWED_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

function log(message) {
    if (DEBUG)
        console.log(`[shortcut-cheatsheet] ${message}`);
}

function mods() {
    return global.get_pointer()[2];
}

function superAlone(m = mods()) {
    return (m & SUPER) !== 0 && (m & (OTHER_MODS | BUTTONS)) === 0;
}

export default class ShortcutCheatsheetExtension extends Extension {
    enable() {
        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'shortcut-cheatsheet']);
        this._configPath = GLib.build_filenamev([this._configDir, 'shortcuts.json']);
        this._sheet = null;
        this._armed = false;          // overlay-key filter armed
        this._holdTimer = 0;
        this._pollTimer = 0;
        this._graceTimer = 0;
        this._activeWatch = 0;
        this._shownAt = null;         // pointer position when shown
        this._stats = {probes: 0, shows: 0, suppressed: 0};

        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._probeWatch = this._idleMonitor.add_idle_watch(PROBE_MS, () => this._onProbe());

        this._filterId = global.window_manager.connect('filter-keybinding',
            (_wm, binding) => this._onFilterKeybinding(binding));

        this._closers = [
            [Main.sessionMode, Main.sessionMode.connect('updated', () => this.hide())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this.hide())],
        ];
        log('enabled');
    }

    disable() {
        this._idleMonitor.remove_watch(this._probeWatch);
        this._probeWatch = 0;
        this._clearActiveWatch();
        global.window_manager.disconnect(this._filterId);
        this._filterId = 0;
        for (const [obj, id] of this._closers)
            obj.disconnect(id);
        this._closers = [];
        this._removeTimer('_holdTimer');
        this._removeTimer('_pollTimer');
        this._removeTimer('_graceTimer');
        this._destroySheet();
        this._armed = false;
        this._idleMonitor = null;
        log('disabled');
    }

    // ---- public (also used by tests) ----

    show() {
        if (this._sheet)
            return this.status();
        const {config, error} = this._loadConfig();
        const dark = St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;
        const monitor = Main.layoutManager.focusIndex ?? Main.layoutManager.primaryIndex;
        const geo = Main.layoutManager.monitors[monitor];
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let columns = Number(config.columns) || 0;
        if (columns <= 0)
            columns = geo && geo.width / scaleFactor < 1300 ? 2 : 3;

        this._sheet = new Sheet(config, {
            dark,
            columns,
            configPath: this._configPath.replace(GLib.get_home_dir(), '~'),
            error,
        });
        Main.layoutManager.uiGroup.add_child(this._sheet);
        const fit = this._sheet.present(monitor);
        this._stats.shows++;
        log(`shown on monitor ${monitor}: ${JSON.stringify(fit)}`);
        return {...this.status(), fit};
    }

    hide() {
        this._destroySheet();
        this._clearActiveWatch();
    }

    status() {
        return {
            shown: !!this._sheet,
            armed: this._armed,
            holdTimer: this._holdTimer !== 0,
            pollTimer: this._pollTimer !== 0,
            graceTimer: this._graceTimer !== 0,
            activeWatch: this._activeWatch !== 0,
            probeWatch: this._probeWatch !== 0,
            filter: this._filterId !== 0,
            stats: this._stats,
        };
    }

    // ---- hold detection ----

    _onProbe() {
        this._stats.probes++;
        if (this._sheet || this._holdTimer || this._armed)
            return;
        if (!superAlone() || !(Main.actionMode & ALLOWED_MODES))
            return;
        const hold = this._holdMs();   // re-reads the JSON: edits apply without relogin
        const idle = this._idleMonitor.get_idletime();
        const wait = Math.max(10, hold - idle);
        this._holdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            this._holdTimer = 0;
            this._onHoldElapsed(hold);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onHoldElapsed(hold) {
        if (!superAlone() || !(Main.actionMode & ALLOWED_MODES) || Main.sessionMode.isLocked)
            return;
        if (this._idleMonitor.get_idletime() < hold - IDLE_SLACK_MS)
            return;     // something happened in between (key, click, motion)
        try {
            this.show();
        } catch (e) {
            console.error(`[shortcut-cheatsheet] show failed: ${e}`);
            this._destroySheet();
            return;
        }
        this._armed = true;
        this._removeTimer('_graceTimer');
        const [x, y] = global.get_pointer();
        this._shownAt = [x, y];
        this._armActiveWatch();
        this._startPoll();
    }

    _holdMs() {
        // only runs when Super alone was held through a PROBE_MS pause
        const v = Number(this._loadConfig().config.hold_ms ?? DEFAULTS.hold_ms);
        return Number.isFinite(v) && v >= 200 ? v : DEFAULTS.hold_ms;
    }

    // ---- while shown / armed ----

    _armActiveWatch() {
        this._clearActiveWatch();
        this._activeWatch = this._idleMonitor.add_user_active_watch(() => {
            this._activeWatch = 0;
            this._onActivity();
        });
    }

    _clearActiveWatch() {
        if (this._activeWatch && this._idleMonitor)
            this._idleMonitor.remove_watch(this._activeWatch);
        this._activeWatch = 0;
    }

    _onActivity() {
        if (!this._sheet)
            return;
        const [x, y, m] = global.get_pointer();
        if (!(m & SUPER)) {
            this._onReleased();
            return;
        }
        const moved = this._shownAt && (x !== this._shownAt[0] || y !== this._shownAt[1]);
        if (moved && !(m & BUTTONS) && !(m & OTHER_MODS)) {
            this._shownAt = [x, y];
            this._armActiveWatch();     // pointer motion: keep showing
            return;
        }
        log('other input while held -> hide');
        this.hide();                    // key / click / scroll: let it through, close
    }

    _startPoll() {
        if (this._pollTimer)
            return;
        this._pollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            if (mods() & SUPER)
                return GLib.SOURCE_CONTINUE;
            this._pollTimer = 0;
            this._onReleased();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onReleased() {
        this.hide();
        this._removeTimer('_pollTimer');
        if (!this._armed || this._graceTimer)
            return;
        // mutter runs the overlay-key filter while processing the release; give
        // it time, then disarm so a later Super tap is never swallowed
        this._graceTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELEASE_GRACE_MS, () => {
            this._graceTimer = 0;
            this._armed = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onFilterKeybinding(binding) {
        if (!this._armed || binding.get_name() !== 'overlay-key')
            return false;
        this._armed = false;
        this._removeTimer('_graceTimer');
        this._stats.suppressed++;
        log('overlay-key suppressed');
        this.hide();
        return true;
    }

    // ---- helpers ----

    _loadConfig() {
        let text = null;
        try {
            const [ok, bytes] = GLib.file_get_contents(this._configPath);
            if (ok)
                text = new TextDecoder().decode(bytes);
        } catch (e) {
            if (!e.matches(GLib.FileError, GLib.FileError.NOENT))
                return {config: DEFAULTS, error: `Cannot read ${this._configPath}: ${e.message}`};
        }
        if (text === null) {
            this._writeDefaults();
            return {config: DEFAULTS, error: null};
        }
        try {
            const config = JSON.parse(text);
            if (!Array.isArray(config.sections))
                throw new Error('"sections" must be a list');
            return {config, error: null};
        } catch (e) {
            return {config: DEFAULTS, error: `shortcuts.json: ${e.message} (showing the defaults)`};
        }
    }

    _writeDefaults() {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o755);
            const file = Gio.File.new_for_path(this._configPath);
            file.replace_contents(new TextEncoder().encode(`${JSON.stringify(DEFAULTS, null, 2)}\n`),
                null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            console.error(`[shortcut-cheatsheet] cannot write defaults: ${e.message}`);
        }
    }

    _destroySheet() {
        this._sheet?.destroy();
        this._sheet = null;
        this._shownAt = null;
    }

    _removeTimer(field) {
        if (this[field])
            GLib.source_remove(this[field]);
        this[field] = 0;
    }
}
