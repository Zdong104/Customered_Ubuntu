/**
 * Never let a window's title bar sit under the GNOME top bar.
 *
 * Chrome PWAs run on XWayland here (see the fcitx5 note). XWayland's
 * _NET_WORKAREA is one rectangle for the whole layout with y = 0, so Chrome
 * believes the laptop monitor's work area starts at the monitor's top edge,
 * saves its bounds flush with it and asks for that position on the next
 * launch. Mutter honours it, the top bar covers Chrome's client-side title bar,
 * and the window can no longer be dragged. Other clients can do the same.
 *
 * Rule, for every monitor whose work area starts below its top edge (a top
 * bar, or any other top strut): a window's title band may not overlap that
 * strip [monitor top, work-area top).
 *  - Placement, restore, resize, unmaximize, workspace/monitor changes: the
 *    window is pushed down to the work-area top, or, when most of the band is
 *    already above the monitor edge and a monitor is up there, up so the
 *    band sits wholly on that monitor.
 *  - Dragging: the title crosses the bar only together with the pointer.
 *    Coming from below, the window stops at the bottom of the top bar (even
 *    when gripped far below its title) until the pointer itself is on the
 *    monitor above; then it follows, and on release it is settled wholly up
 *    there. A title that started the drag above stays above until the window
 *    is dragged wholly below the bar.
 *
 * Verified in a headless gnome-shell 50.1 with two stacked virtual monitors
 * (undecorated X11 probe, Super+drag via a Clutter virtual pointer).
 *  - Resizing from the top edge: left alone during the grab, then trimmed so
 *    the top edge is at the work-area top (bottom edge kept).
 * A title band that is on no monitor at all is brought back to the work-area
 * top of the window's monitor.
 *
 * Skipped: override-redirect windows, menus/tooltips/docks/desktop (only
 * normal, dialog and utility windows), fullscreen and vertically maximized
 * windows (Mutter fits those itself), skip-taskbar overlays, minimized
 * windows (that is also how workspace-islands parks them; they are checked
 * again when un-minimized), and EXEMPT_APPS.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/** Height of the band that must stay visible, in logical pixels. */
const TITLE = 48;
/** A window must overlap a monitor by this much for its top strip to count. */
const MIN_OVERLAP = 8;
const EXEMPT_APPS = new Set(['vocalinux', 'wl-clipboard']);
const MANAGED_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
]);
const MOVE_OPS = new Set([
    Meta.GrabOp.MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
    Meta.GrabOp.KEYBOARD_MOVING,
]);
const DEBUG = false;

function isResizeOp(op) {
    return (op & 0xF000) !== 0 || op === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN;
}

function monitorAt(x, y) {
    const display = global.display;
    for (let i = 0; i < display.get_n_monitors(); i++) {
        const m = display.get_monitor_geometry(i);
        if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
            return i;
    }
    return -1;
}

export default class TitlebarBelowPanel extends Extension {
    enable() {
        this._signals = [];
        this._windows = new Map(); // MetaWindow -> [signal ids]
        this._pending = new Set();
        this._laterId = 0;
        this._grab = null; // {window, op, side: Map<monitor, 'above'|'below'>}

        const connect = (obj, sig, fn) => this._signals.push([obj, obj.connect(sig, fn)]);
        connect(global.display, 'window-created', (_d, w) => this._track(w));
        connect(global.display, 'grab-op-begin', (_d, w, op) => {
            this._grab = {window: w, op, side: w ? this._sides(w) : new Map()};
        });
        connect(global.display, 'grab-op-end', (_d, w, op) => {
            const grab = this._grab;
            this._grab = null;
            if (w)
                this._fix(w, {release: grab?.window === w ? grab : {window: w, op, side: new Map()}});
        });
        connect(global.display, 'workareas-changed', () => this._queueAll());
        connect(global.workspace_manager, 'active-workspace-changed', () => this._queueAll());

        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
        this._queueAll();
    }

    disable() {
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        for (const [w, ids] of this._windows)
            ids.forEach(id => w.disconnect(id));
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._signals = this._windows = this._pending = this._grab = null;
        this._laterId = 0;
    }

    _log(msg) {
        if (DEBUG)
            console.log(`[titlebar-below-panel] ${msg}`);
    }

    _track(w) {
        if (!w || this._windows.has(w))
            return;
        const queue = () => this._queue(w);
        const ids = [
            w.connect('position-changed', queue),
            w.connect('size-changed', queue),
            w.connect('shown', queue),
            w.connect('notify::minimized', queue),
            w.connect('notify::fullscreen', queue),
            w.connect('notify::maximized-vertically', queue),
            w.connect('unmanaged', () => {
                this._windows.get(w)?.forEach(id => w.disconnect(id));
                this._windows.delete(w);
                this._pending.delete(w);
            }),
        ];
        this._windows.set(w, ids);
        this._queue(w);
    }

    _queueAll() {
        for (const w of this._windows.keys())
            this._queue(w);
    }

    /** Fix before the next frame is drawn, so a clamped drag does not flicker. */
    _queue(w) {
        this._pending.add(w);
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            const windows = [...this._pending];
            this._pending.clear();
            for (const win of windows)
                this._fix(win, {});
            return GLib.SOURCE_REMOVE;
        });
    }

    _eligible(w) {
        if (!this._windows?.has(w) || w.is_override_redirect() ||
            !MANAGED_TYPES.has(w.get_window_type()) ||
            w.minimized || w.is_fullscreen() || w.maximized_vertically ||
            w.is_skip_taskbar())
            return false;
        const key = w.get_wm_class() ?? w.get_gtk_application_id() ?? w.get_title() ?? '';
        return !EXEMPT_APPS.has(key.toLowerCase());
    }

    /** For each monitor with a top strip: is the window's title above its edge? */
    _sides(w) {
        const sides = new Map();
        const r = w.get_frame_rect();
        const display = global.display;
        for (let i = 0; i < display.get_n_monitors(); i++)
            sides.set(i, r.y + TITLE / 2 < display.get_monitor_geometry(i).y ? 'above' : 'below');
        return sides;
    }

    _fix(w, {release = null}) {
        if (!this._eligible(w))
            return;
        const grab = this._grab?.window === w ? this._grab : null;
        if (grab && isResizeOp(grab.op))
            return; // settled on grab-op-end
        const moving = grab !== null && MOVE_OPS.has(grab.op);
        // The drag being judged: in progress, or just released.
        const drag = moving ? grab : release && MOVE_OPS.has(release.op) ? release : null;
        const resized = release !== null && isResizeOp(release.op);
        const [, pointerY] = global.get_pointer();
        const r = w.get_frame_rect();
        if (r.width <= 0 || r.height <= 0)
            return;

        const display = global.display;
        for (let i = 0; i < display.get_n_monitors(); i++) {
            const m = display.get_monitor_geometry(i);
            const wa = w.get_work_area_for_monitor(i);
            const stripTop = m.y, stripBottom = wa.y;
            if (stripBottom <= stripTop)
                continue;
            const ox0 = Math.max(r.x, m.x), ox1 = Math.min(r.x + r.width, m.x + m.width);
            if (ox1 - ox0 < MIN_OVERLAP)
                continue;
            if (r.y >= stripBottom) {
                grab?.side.set(i, 'below');
                continue;
            }
            if (r.y + r.height <= stripTop)
                continue; // wholly on the monitor above
            const roomAbove = monitorAt((ox0 + ox1) / 2, stripTop - 1) >= 0;
            const inStrip = r.y + TITLE > stripTop;

            if (drag) {
                // The title crosses the top bar only together with the
                // pointer: from below it stops at the bar until the pointer is
                // on the monitor above; from above it stays above until it is
                // dragged wholly below the bar.
                const pointerAbove = roomAbove && pointerY < stripTop;
                if (pointerAbove)
                    drag.side.set(i, 'above');
                if (moving && pointerAbove)
                    return; // following the pointer; settled on release
                if (roomAbove && drag.side.get(i) === 'above') {
                    if (inStrip)
                        this._move(w, r.x, stripTop - TITLE, `kept on the monitor above ${i}`);
                } else {
                    this._move(w, r.x, stripBottom, `held below the top bar of ${i}`);
                }
                return;
            }

            if (!inStrip)
                continue;
            if (roomAbove && r.y + TITLE / 2 < stripTop) {
                this._move(w, r.x, stripTop - TITLE, `up onto the monitor above ${i}`);
            } else if (resized) {
                this._moveResize(w, r.x, stripBottom, r.width,
                    r.y + r.height - stripBottom, `resize trimmed to the top bar of ${i}`);
            } else if (release === null && w.allows_resize() && r.height > wa.height) {
                // Placement/restore taller than the room left: shrink to fit.
                this._moveResize(w, r.x, stripBottom, r.width, wa.height,
                    `below the top bar of ${i}, fitted`);
            } else {
                this._move(w, r.x, stripBottom, `below the top bar of ${i}`);
            }
            return;
        }

        // Title band on no monitor at all (above or between monitors).
        const midY = r.y + TITLE / 2;
        const onScreen = [r.x + MIN_OVERLAP, r.x + r.width / 2, r.x + r.width - MIN_OVERLAP]
            .some(x => monitorAt(x, midY) >= 0);
        if (!onScreen && !moving) {
            const mi = w.get_monitor();
            if (mi < 0)
                return;
            const wa = w.get_work_area_for_monitor(mi);
            if (r.y < wa.y)
                this._move(w, r.x, wa.y, `title bar off-screen, back to monitor ${mi}`);
        }
    }

    _move(w, x, y, why) {
        this._log(`${w.get_wm_class()} "${w.get_title()}": ${why} (y ${w.get_frame_rect().y} -> ${y})`);
        w.move_frame(true, x, y);
    }

    _moveResize(w, x, y, width, height, why) {
        this._log(`${w.get_wm_class()} "${w.get_title()}": ${why} (y ${w.get_frame_rect().y} -> ${y}, h ${height})`);
        w.move_resize_frame(true, x, y, width, height);
    }
}
