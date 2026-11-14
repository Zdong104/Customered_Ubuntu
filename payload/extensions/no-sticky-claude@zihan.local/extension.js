/**
 * Keep the Claude desktop window on a single workspace.
 *
 * The Claude app (Electron, run on XWayland) calls setVisibleOnAllWorkspaces
 * from some of its code paths. On X11 that is a _NET_WM_STATE_STICKY request,
 * so the main window ends up on every workspace (seen 2026-10-21 and
 * 2026-11-04, both with eDP-1 as the only monitor).
 *
 * Mutter does not expose whether a window was *asked* to be sticky. With
 * workspaces-only-on-primary, windows on secondary monitors are on all
 * workspaces by design, and workspace-islands relies on that. So treat a window
 * as wrongly sticky only when it is on all workspaces *and* that cannot be the
 * secondary-monitor rule: it sits on the primary monitor, or the setting is
 * off. Re-check whenever the flag flips, the window changes monitor, or the
 * monitor layout changes (undocking moves windows onto eDP-1).
 *
 * Only the app's normal, taskbar-visible windows. Overlays the app may
 * legitimately pin everywhere are left alone.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WM_CLASSES = new Set([
    'com.anthropic.claude', 'com.anthropic.Claude',
    'claude-desktop', 'Claude-desktop', 'Claude',
]);

// Chromium/Electron apps on XWayland can re-assert _NET_WM_STATE_STICKY by
// themselves (seen 2026-11-10: a Google Docs Chrome window on every workspace).
const PREFIXES = ['google-chrome', 'chromium', 'crx_', 'microsoft-edge'];
const EXACT = new Set([
    'code', 'cursor', 'obsidian', 'wechat', 'slack', 'discord',
]);

function isTarget(window) {
    if (window.get_window_type() !== Meta.WindowType.NORMAL ||
        window.skip_taskbar)
        return false;
    const cls = window.get_wm_class();
    if (!cls)
        return false;
    if (WM_CLASSES.has(cls))
        return true;
    const lc = cls.toLowerCase();
    return EXACT.has(lc) || PREFIXES.some(p => lc.startsWith(p));
}

export default class NoStickyClaudeExtension extends Extension {
    enable() {
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._pending = new Set();
        this._tracked = new Set();
        this._idle = 0;

        global.display.connectObject(
            'window-created', (_d, w) => this._track(w),
            'window-entered-monitor', (_d, _m, w) => this._queue(w),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._queueAll(), this);

        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
    }

    _track(window) {
        if (!window || this._tracked.has(window))
            return;
        // Remembered here, not found again through the window actors on
        // disable: a window without an actor at that moment (just created,
        // or its actor already torn down) kept its handlers, and the next
        // flag flip ran _queue() on a disabled extension (2026-11-04 15:52,
        // lock screen during an undock: "this._pending is null").
        this._tracked.add(window);
        window.connectObject(
            'notify::on-all-workspaces', () => this._queue(window),
            'shown', () => this._queue(window),
            'unmanaged', () => {
                window.disconnectObject(this);
                this._tracked?.delete(window);
                this._pending?.delete(window);
            },
            this);
        this._queue(window);
    }

    _queueAll() {
        for (const actor of global.get_window_actors())
            this._queue(actor.meta_window);
    }

    // Defer: the flag changes from inside Mutter's own state updates.
    _queue(window) {
        if (!this._pending || !window)
            return; // disabled; a stray late signal
        this._pending.add(window);
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            if (!this._pending)
                return GLib.SOURCE_REMOVE;
            const windows = [...this._pending];
            this._pending.clear();
            windows.forEach(w => this._check(w));
            return GLib.SOURCE_REMOVE;
        });
    }

    _check(window) {
        if (!this._mutter || !window.get_compositor_private() || !isTarget(window) ||
            !window.is_on_all_workspaces())
            return;
        const onlyPrimary = this._mutter.get_boolean('workspaces-only-on-primary');
        if (onlyPrimary && !window.is_on_primary_monitor())
            return;
        console.log('no-sticky: unstuck ' + window.get_wm_class() + ' "' + window.get_title() + '"');
        window.unstick();
    }

    disable() {
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const window of this._tracked ?? [])
            window.disconnectObject(this);
        for (const actor of global.get_window_actors())
            actor.meta_window?.disconnectObject(this);
        this._tracked = null;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        this._pending = null;
        this._mutter = null;
    }
}
