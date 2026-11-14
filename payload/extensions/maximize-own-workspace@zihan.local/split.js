/**
 * Split View: macOS Mission Control's "drag a window onto a full-screen space".
 *
 * In the overview, a window dragged over the primary strip's thumbnail of a
 * full-screen space (exactly one in-scope window there, maximized or
 * fullscreen) lights up the half of the thumbnail under the pointer. Dropping
 * it there moves the window in on that side and the resident to the other
 * side, 50/50, and the view goes to that workspace. Anywhere else the drop is
 * stock (and the rule of extension.js then applies as before).
 *
 * The pair is first-class state of maximize-own-workspace: a workspace holding
 * a split pair holds only that pair, like a full-screen space (_arrive,
 * _hasMax, _violations in extension.js check isPaired()). The sweep in
 * extension.js calls check() first and finish() last, so a partner that
 * closes, minimizes, leaves (another workspace or monitor) or is maximized
 * ends the pair, and the partner left behind is maximized again: a full-screen
 * space once more. A maximized partner is isolated by the usual _isolate,
 * which moves the other one to a fresh workspace; it is maximized there.
 *
 * Leaving the split (2026-11-08): a pair exists only while its two windows
 * tile the work area exactly (any divider ratio). A half dragged by its title
 * bar (or keyboard-moved) further than EXIT_PX, resized on an outer edge, with
 * its vertical maximization cleared, or moved by a tiling key ends the pair
 * as an EXIT (_release): nothing is re-maximized and nothing moves; both
 * windows keep their geometry as plain normal windows, and the isolation
 * records the pair held are dropped, so the workspace is an ordinary shared
 * one (it keeps its MADE tag, so it is swept once empty). Geometry changes
 * outside a grab are judged WATCH_MS after they stop (_judge). There is no
 * swap of the halves any more: with "drag = leave", a drop over the other
 * half would be ambiguous.
 *
 * Tiling: Mutter 50 does not expose meta_window_tile() to JS, so a half is
 * what Ubuntu's tiling-assistant uses too: vertically maximized (Mutter keeps
 * the height; is_maximized() stays false) plus move_resize_frame to the work
 * area half. Resizing the inner edge of one half resizes the other (live,
 * through size-changed during the grab; clamped to both minimum sizes when
 * the grab ends). A title-bar drag shorter than EXIT_PX snaps the half back;
 * a longer one leaves the split (above). A half that a window cannot fit (get_min_size) means no
 * split: the stock drop runs instead. A client that ignores its half anyway
 * (checked VERIFY_MS later) ends the pair as if the drop had been stock.
 *
 * Places (2026-11-09): a pair holds a real Meta.Workspace on the primary
 * ({kind: 'real', ws, mon}) or, on a secondary monitor, one Workspace Islands
 * virtual workspace ({kind: 'virt', conn, group}: the islands group Set by
 * identity, which survives reorders, and the connector, which survives
 * hotplugs). Islands' thumbnails (secondary strips) are drop targets through
 * workspace-manage's bridge (islands.js), which also tells the sweep about
 * every islands membership change (a window moved between two parked
 * virtual workspaces emits no Meta signal). See DESIGN-external-split.md.
 *
 * Parking: islands hides the windows of a virtual workspace that is not on
 * screen by minimizing them (tagged). Mutter keeps their frames and the
 * vertical maximization through that, so a parked pair is left alone; a
 * partner minimized by islands while the pair's virtual workspace IS on
 * screen has left it.
 *
 * Restore rect (MAX_ON): Mutter keeps a window's pre-maximize rect where the
 * window was maximized. A half on a secondary whose rect lies elsewhere
 * would jump there on any un-maximize (and leave islands). Such a window's
 * rect is moved to its half when it is tiled ("laundered", _place).
 *
 * Fail closed: without workspace-manage's bridge, with an islands version it
 * was not verified against, or after any error in the virtual-workspace code
 * (_breakVirt, for the rest of the session), secondaries are stock and the
 * primary split works as before.
 *
 * ISOLATION records of the two windows are stashed in the pair while it lasts
 * (a tiled window must not "merge back" when it is un-maximized or minimized)
 * and handed back to the window that ends up full-screen again. The dragged
 * window gets one pointing to the windows it left, so un-maximizing it later
 * takes it home, as with any isolated window.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    ThumbnailState,
    WorkspaceThumbnail,
} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

/** On both windows of a pair: the pair object (shared). */
export const PAIR = Symbol.for('maximize-own-workspace.split');

/** extension.js's isolation record and made-workspace tag (same global symbols). */
const ISOLATION = Symbol.for('maximize-own-workspace.isolation');
const MADE = Symbol.for('maximize-own-workspace.made');

const DEBUG = false;

/** When to check that both clients took their half, and how often. */
const VERIFY_MS = 1500;
const VERIFY_TRIES = 3;

/** A client wider than its half by more than this did not take it. */
const SLACK = 24;

/** A title-bar drag / keyboard move of a half longer than this leaves the split. */
const EXIT_PX = 40;

/** Quiet time after a half's geometry changed (no grab) before it is judged. */
const WATCH_MS = 400;

/** After we tile, the time clients get to take their halves before being judged. */
const PENDING_MS = 1500;

/**
 * Setup (2026-11-09): for this long after a split, a partner that changes
 * monitor or workspace (or gets parked by islands) on its own is put back,
 * at most REHOME_TRIES times, instead of ending the pair. Nobody can grab it
 * that fast; it is the client or Mutter. Seen live with Claude (Electron on
 * XWayland, externals above eDP-1): untiling it restored bounds on the
 * monitor above for a moment, it became sticky there, and when it came back
 * Mutter put it on the active workspace, not the pair's: "moved away".
 */
const SETUP_MS = 2000;
const REHOME_TRIES = 4;
/** A partner asked back to the pair's monitor is asked again no sooner than this. */
const REHOME_GAP_MS = 250;

/**
 * Cross-monitor split: how long a window dropped from a secondary monitor
 * gets to arrive on the primary (a maximized Wayland client switches monitor
 * only once it acked its new size) before the split is given up.
 */
const LAND_MS = 5000;
const LAND_POLL_MS = 50;

/** workspace-islands' tag on windows it minimized itself (visibility.js). */
const ISLANDS_HIDDEN = Symbol.for('workspace-islands.hidden');

/**
 * On a window: the connector of the monitor where its vertical restore rect
 * was taken (it became vertically maximized there; extension.js stamps it).
 * Unknown counts as elsewhere.
 */
const MAX_ON = Symbol.for('maximize-own-workspace.max-on');

/** A laundered half's actor stays frozen this long (_place). */
const LAUNDER_THAW_MS = 300;

/**
 * After a monitor change, pairs whose two windows are together again on a
 * place of their own are re-tiled from QUICK_DELAY_MS on (after islands'
 * 300 ms and workspace-manage's undock 1 s settles), polling until
 * QUICK_UNTIL_MS, instead of only at the 4 s settle (_quickRetile).
 */
const QUICK_DELAY_MS = 1200;
const QUICK_UNTIL_MS = 4500;
const QUICK_POLL_MS = 250;

/**
 * _unflag: a released half's geometry is re-asked for (at most KEEP_TRIES
 * times) until it stayed put KEEP_QUIET_MS; its actor is frozen till then,
 * KEEP_MS at the longest.
 */
const KEEP_MS = 1000;
const KEEP_QUIET_MS = 150;
const KEEP_TRIES = 6;

/** Mutter's META_GRAB_OP_WINDOW_FLAG_UNCONSTRAINED. */
const GRAB_UNCONSTRAINED = 1024;

const EAST_OPS = new Set([
    Meta.GrabOp.RESIZING_E, Meta.GrabOp.RESIZING_NE, Meta.GrabOp.RESIZING_SE,
    Meta.GrabOp.KEYBOARD_RESIZING_E, Meta.GrabOp.KEYBOARD_RESIZING_NE,
    Meta.GrabOp.KEYBOARD_RESIZING_SE,
]);
const WEST_OPS = new Set([
    Meta.GrabOp.RESIZING_W, Meta.GrabOp.RESIZING_NW, Meta.GrabOp.RESIZING_SW,
    Meta.GrabOp.KEYBOARD_RESIZING_W, Meta.GrabOp.KEYBOARD_RESIZING_NW,
    Meta.GrabOp.KEYBOARD_RESIZING_SW,
]);

const MOVE_OPS = new Set([Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING]);

const HOVER_STYLE = 'background-color: rgba(53, 132, 228, 0.45);' +
    'border: 2px solid rgba(255, 255, 255, 0.85); border-radius: 6px;';

function log(message) {
    if (DEBUG)
        console.log(`[split-view] ${message}`);
}

function isMax(window) {
    return window.is_maximized() || window.is_fullscreen();
}

export function isPaired(window) {
    return window?.[PAIR]?.alive === true;
}

function minSize(window) {
    const r = window.get_min_size();
    return r.length === 3 ? [r[1], r[2]] : r;
}

function fits(window, rect) {
    const [w, h] = minSize(window);
    return w <= rect.w && h <= rect.h;
}

function title(window) {
    return `"${window.get_title()}"`;
}

function rootOf(window) {
    let w = window;
    for (let parent = w.get_transient_for(); parent; parent = w.get_transient_for())
        w = parent;
    return w;
}

function now() {
    return GLib.get_monotonic_time() / 1000;
}

/** Connector of monitor `index`, or null. */
function connectorOf(index) {
    try {
        for (const lm of global.backend.get_monitor_manager().get_logical_monitors()) {
            if (lm.get_number() === index)
                return lm.get_monitors()[0]?.get_connector() ?? null;
        }
    } catch (e) {
        console.warn(`[split-view] no connector for monitor ${index}: ${e}`);
    }
    return null;
}

/** Monitor index of `connector`, or -1 while it is not attached. */
function monitorOf(connector) {
    if (!connector)
        return -1;
    try {
        return global.backend.get_monitor_manager().get_monitor_for_connector(connector);
    } catch (e) {
        return -1;
    }
}

/** extension.js: the window just became vertically maximized where it is. */
export function stampMaxOn(window) {
    const conn = connectorOf(window.get_monitor());
    if (conn)
        window[MAX_ON] = conn;
}

/** Same place (extension.js sameLoc): virtual ones by group identity. */
function sameLoc(a, b) {
    if (!a || !b || a.kind !== b.kind)
        return false;
    if (a.kind === 'real')
        return a.ws === b.ws && a.mon === b.mon;
    if (a.kind === 'virt')
        return a.conn === b.conn && a.group === b.group;
    return false;
}

/** What a pair keeps of a location: survives renumbering and hotplugs. */
function placeOf(loc) {
    return loc.kind === 'real'
        ? {kind: 'real', ws: loc.ws, mon: loc.mon}
        : {kind: 'virt', conn: loc.conn, group: loc.group};
}

function where(loc) {
    if (loc?.kind === 'real')
        return `workspace ${loc.ws.index() + 1}`;
    if (loc?.kind === 'virt')
        return `virtual workspace ${loc.idx + 1} on ${loc.conn}`;
    return 'nowhere';
}

function hasWorkspace(ws) {
    const wm = global.workspace_manager;
    for (let i = 0; i < wm.get_n_workspaces(); i++) {
        if (wm.get_workspace_by_index(i) === ws)
            return true;
    }
    return false;
}

export class SplitView {
    /** @param {object} owner the MaximizeOwnWorkspace extension */
    constructor(owner) {
        this._owner = owner;
    }

    enable() {
        this._pairs = new Set();
        this._injector = new InjectionManager();
        this._hover = null;
        this._monitor = null;
        this._resize = null;
        this._areaId = 0;
        this._keeps = new Set(); // _unflag's windows still settling
        this._signals = [];
        this._hideId = 0;
        this._refused = null; // last window logged as too big for a half
        this._landing = new Map(); // cross-monitor drops on their way (_crossSplit)
        this._virtBroken = false; // _breakVirt: secondaries stock for the session
        this._sub = null; // workspace-manage islands change subscription
        this._quickId = 0;
        this._thaws = new Map(); // laundered actor -> thaw timeout id

        const self = this;
        const proto = WorkspaceThumbnail?.prototype;
        if (typeof proto?.handleDragOverInternal === 'function' &&
            typeof proto?.acceptDropInternal === 'function') {
            this._injector.overrideMethod(proto, 'handleDragOverInternal',
                original => function (source, actor, time) {
                    const side = self._hoverSide(this, source);
                    if (side)
                        return DND.DragMotionResult.MOVE_DROP;
                    return original.call(this, source, actor, time);
                });
            this._injector.overrideMethod(proto, 'acceptDropInternal',
                original => function (source, actor, time) {
                    if (self._drop(this, source))
                        return true;
                    return original.call(this, source, actor, time);
                });
        } else {
            console.warn('[split-view] stock WorkspaceThumbnail not as expected; no split view');
        }

        const connect = (object, signal, callback) =>
            this._signals.push([object, object.connect(signal, callback)]);
        connect(Main.overview, 'window-drag-begin', () => this._dragBegin());
        connect(Main.overview, 'window-drag-end', () => this._dragEnd());
        connect(Main.overview, 'window-drag-cancelled', () => this._dragEnd());
        connect(global.display, 'grab-op-begin', (_d, window, op) => this._grabBegin(window, op));
        connect(global.display, 'grab-op-end', (_d, window) => this._grabEnd(window));
        // Work area changed (dock, panel struts) without a monitor change.
        connect(global.display, 'workareas-changed', () => this._retileLater());
        connect(Main.layoutManager, 'monitors-changed', () => this._layoutMoved());

        // Pairs kept across a lock screen (see disable()).
        for (const actor of global.get_window_actors()) {
            const pair = actor.meta_window?.[PAIR];
            if (pair?.alive && !this._pairs.has(pair)) {
                this._pairs.add(pair);
                this._watch(pair);
                log(`kept pair ${title(pair.left)} | ${title(pair.right)}`);
            }
        }
    }

    disable() {
        this._injector.clear();
        this._clearHover();
        this._dragEnd();
        this._endResize();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        if (this._hideId) {
            GLib.Source.remove(this._hideId);
            this._hideId = 0;
        }
        if (this._areaId) {
            GLib.Source.remove(this._areaId);
            this._areaId = 0;
        }
        if (this._quickId) {
            GLib.Source.remove(this._quickId);
            this._quickId = 0;
        }
        for (const [actor, id] of this._thaws) {
            GLib.Source.remove(id);
            actor.thaw();
        }
        this._thaws.clear();
        this._sub?.off?.();
        this._sub = null;
        for (const keep of [...this._keeps])
            this._kept(keep);
        for (const landing of [...this._landing.values()])
            this._stopLanding(landing);
        for (const stop of [...(this._lates ?? [])])
            stop();
        this._lates = null;
        for (const pair of this._pairs) {
            if (pair.verifyId) {
                GLib.Source.remove(pair.verifyId);
                pair.verifyId = 0;
            }
            if (pair.rehomeId) {
                GLib.Source.remove(pair.rehomeId);
                pair.rehomeId = 0;
            }
            pair.transit?.clear();
            this._unwatch(pair);
            // Like the isolation records: a lock screen keeps them, a real
            // disable leaves two plain windows side by side.
            if (!Main.sessionMode.isLocked)
                this._forget(pair);
        }
        this._pairs.clear();
    }

    // ---- drop target -----------------------------------------------------------

    /** What a drop of `source` on `thumb` would split, or null. */
    _plan(thumb, source) {
        const B = source?.metaWindow;
        if (!B || !thumb)
            return null;
        const owner = this._owner;
        if (owner._busy)
            return null;
        const ctx = owner._context();
        const loc = this._thumbLoc(thumb, ctx);
        return loc ? this._planAt(loc, B, ctx) : null;
    }

    /**
     * The place a thumbnail shows, as extension.js describes places: a stock
     * primary thumbnail's workspace, or an islands thumbnail's virtual one.
     */
    _thumbLoc(thumb, ctx) {
        if (thumb.metaWorkspace) {
            if (thumb.state > ThumbnailState.NORMAL || thumb.monitorIndex !== ctx.primary)
                return null;
            return {kind: 'real', ws: thumb.metaWorkspace, mon: thumb.monitorIndex};
        }
        const state = thumb._state;
        if (!state || !Number.isInteger(thumb._index) || !this._virtReady(ctx))
            return null;
        return this._virtLoc(state.connector, state._groups?.[thumb._index], ctx);
    }

    /** A thumbnail drag's source (strip.js placeRefOf) as a location, or null. */
    _refLoc(ref, ctx) {
        if (ref?.kind === 'virt')
            return this._virtReady(ctx) ? this._virtLoc(ref.state?.connector, ref.group, ctx) : null;
        if (ref instanceof Meta.Workspace && hasWorkspace(ref))
            return {kind: 'real', ws: ref, mon: ctx.primary};
        return null;
    }

    /** Islands group `group` of connector `conn` as a location, or null. */
    _virtLoc(conn, group, ctx) {
        const state = conn ? ctx.registry?.forConnector?.(conn) ?? null : null;
        const idx = state && group ? state._groups?.indexOf(group) ?? -1 : -1;
        const mon = idx >= 0 ? monitorOf(conn) : -1;
        if (mon < 0 || mon === ctx.primary || ctx.registry.forMonitorIndex(mon) !== state)
            return null;
        return {kind: 'virt', state, conn, idx, mon, group};
    }

    /**
     * Secondaries take part: workspace-manage's islands bridge is up, islands
     * is a verified version with every probe passing, and nothing broke.
     */
    _virtReady(ctx) {
        if (this._virtBroken || !ctx.onlyOnPrimary || !ctx.registry || !ctx.manage)
            return false;
        try {
            if (ctx.manage.splitReady?.() !== true)
                return false;
            const token = ctx.manage.islandsToken?.() ?? null;
            if (token && this._sub?.token !== token) {
                this._sub?.off?.();
                this._sub = ctx.manage.onIslandsChanged(() => this._owner._schedule());
            }
            return true;
        } catch (e) {
            this._breakVirt(e, 'readiness check');
            return false;
        }
    }

    /**
     * Circuit breaker: an error in the virtual-workspace code turns split
     * view on secondaries off for the session. Their pairs become two plain
     * windows where they are (_release); the primary is not affected.
     */
    _breakVirt(e, why) {
        if (this._virtBroken)
            return;
        this._virtBroken = true;
        console.warn(`[split-view] split view on secondary monitors is off for this session ` +
            `(${why}): ${e}\n${e?.stack ?? ''}`);
        try {
            this._clearHover();
        } catch (e2) {
            this._hover = null;
        }
        for (const pair of [...(this._pairs ?? [])]) {
            if (pair.loc.kind !== 'virt')
                continue;
            try {
                this._release(pair, 'split view on secondaries turned off');
            } catch (e2) {
                this._forget(pair);
            }
        }
        for (const landing of [...(this._landing?.values() ?? [])]) {
            if (landing.place?.kind === 'virt')
                this._stopLanding(landing);
        }
    }

    // ---- a pair's place ------------------------------------------------------------

    /** The pair's place as extension.js describes places, or null once gone. */
    _loc(pair, ctx = this._owner._context()) {
        const p = pair.loc;
        if (p.kind === 'real')
            return hasWorkspace(p.ws) ? {kind: 'real', ws: p.ws, mon: p.mon} : null;
        return this._virtLoc(p.conn, p.group, ctx);
    }

    /** Monitor index of the pair's place, -1 while its monitor is away. */
    _mon(pair) {
        return pair.loc.kind === 'real' ? pair.loc.mon : monitorOf(pair.loc.conn);
    }

    /** The pair's place is the one on screen (its monitor's active workspace). */
    _active(pair, ctx = this._owner._context()) {
        const loc = this._loc(pair, ctx);
        if (!loc)
            return false;
        return loc.kind === 'real' ? loc.ws.active : loc.idx === loc.state.activeIndex;
    }

    _inPlace(pair, w) {
        const p = pair.loc;
        if (p.kind === 'real')
            return w.get_workspace() === p.ws && w.get_monitor() === p.mon;
        return p.group.has(w) && w.get_monitor() === monitorOf(p.conn);
    }

    /**
     * What a split of B into full-screen space `loc` would be, or null. B is
     * anywhere else: another workspace of the same monitor, or another
     * monitor (cross: true; it travels there first, _crossSplit). `landed`:
     * B has just arrived on `loc` (_landed), and is not counted there.
     * `parked`: B may be parked by islands (a dragged virtual workspace's).
     */
    _planAt(loc, B, ctx, {landed = false, parked = false} = {}) {
        const owner = this._owner;
        if (owner._busy || this._landing.has(B) || isPaired(B))
            return null;
        if (loc.kind === 'virt' && !this._virtReady(ctx))
            return null;
        const members = owner._members(loc, ctx).filter(w => w !== B);
        if (members.length !== 1)
            return null;
        const A = members[0];
        if (!isMax(A) || isPaired(A) || this._landing.has(A))
            return null;

        const d = owner._describe(B, ctx);
        // B.minimized: on a secondary, islands-parked (userMin is false).
        if (!d.eligible || d.userMin || d.loc.kind === 'none' ||
            (B.minimized && !(parked && d.loc.kind === 'virt')))
            return null;
        let cross = false;
        if (d.loc.mon === loc.mon) {
            if (sameLoc(d.loc, loc) && !landed)
                return null;
        } else if (!landed && ctx.onlyOnPrimary && typeof B.move_to_monitor === 'function') {
            cross = true;
        } else {
            return null;
        }
        // A maximized window allows no resize, a fullscreen one no move
        // either; the minimum sizes say whether both fit a half (the
        // narrower one, they differ by 1px).
        const {left, right} = this._halves(loc.mon, 0.5);
        const half = left.w <= right.w ? left : right;
        for (const w of [A, B]) {
            if (!isMax(w) && (!w.allows_move() || !w.allows_resize()))
                return null;
            if (!fits(w, half)) {
                if (this._refused !== w) {
                    this._refused = w;
                    log(`no split: ${title(w)} (min ${minSize(w)}) does not fit a half (${half.w}x${half.h})`);
                }
                return null;
            }
        }
        return {A, B, loc, ctx, cross};
    }

    _sideAt(thumb) {
        const [px, py] = global.get_pointer();
        const [ok, x] = thumb.transform_stage_point(px, py);
        if (!ok || thumb.width <= 0)
            return null;
        return x < thumb.width / 2 ? 'left' : 'right';
    }

    /** handleDragOverInternal: the side to light up, or null for stock. */
    _hoverSide(thumb, source) {
        let side = null;
        try {
            if (this._plan(thumb, source))
                side = this._sideAt(thumb);
            if (side)
                this._showHover(thumb, side);
            else if (this._hover?.thumb === thumb)
                this._clearHover();
        } catch (e) {
            this._failed(e, thumb);
            side = null;
        }
        return side;
    }

    /** An error on a drop target: an islands one trips the circuit breaker. */
    _failed(e, thumb) {
        if (thumb && !thumb.metaWorkspace)
            this._breakVirt(e, 'secondary drop target');
        else
            console.error(`[split-view] ${e}\n${e.stack}`);
    }

    /** workspace-manage islands.js: a window over an islands thumbnail. */
    windowHover(thumb, window) {
        return this._hoverSide(thumb, {metaWindow: window});
    }

    /** workspace-manage islands.js: a window dropped on an islands thumbnail. */
    windowDrop(thumb, window) {
        return this._drop(thumb, {metaWindow: window});
    }

    _showHover(thumb, side) {
        if (this._hover?.thumb === thumb && this._hover.side === side)
            return;
        this._clearHover();
        let overlay;
        const contents = thumb._contents;
        const m = thumb._monitor;
        if (!thumb.metaWorkspace && contents && m) {
            // An islands thumbnail: its contents are the monitor at full
            // size, scaled down; the half is the work area's.
            const scale = Math.max(thumb.width / m.width, 0.01);
            const wa = Main.layoutManager.getWorkAreaForMonitor(m.index);
            const half = Math.round(wa.width / 2);
            overlay = new St.Widget({
                reactive: false,
                style: 'background-color: rgba(53, 132, 228, 0.45);' +
                    `border: ${Math.round(2 / scale)}px solid rgba(255, 255, 255, 0.85);` +
                    `border-radius: ${Math.round(6 / scale)}px;`,
            });
            overlay.set_position((side === 'left' ? wa.x : wa.x + half) - m.x, wa.y - m.y);
            overlay.set_size(side === 'left' ? half : wa.width - half, wa.height);
            contents.add_child(overlay);
            contents.set_child_above_sibling(overlay, null);
        } else {
            const half = Math.round(thumb.width / 2);
            overlay = new St.Widget({style: HOVER_STYLE, reactive: false});
            overlay.set_position(side === 'left' ? 0 : half, 0);
            overlay.set_size(side === 'left' ? half : thumb.width - half, thumb.height);
            thumb.add_child(overlay);
        }
        const destroyId = thumb.connect('destroy', () => {
            if (this._hover?.thumb === thumb)
                this._hover = null;
        });
        this._hover = {thumb, side, overlay, destroyId};
    }

    _clearHover() {
        const hover = this._hover;
        this._hover = null;
        if (!hover)
            return;
        hover.thumb.disconnect(hover.destroyId);
        hover.overlay.destroy();
    }

    _dragBegin() {
        if (this._monitor)
            return;
        // A drag leaving the thumbnail (or the strip) gets no call on the
        // thumbnail; this takes the highlight down.
        this._monitor = {
            dragMotion: event => {
                // By pointer, not by picked actor: over the active islands
                // thumbnail DND picks the strip's indicator on top of it.
                if (this._hover && !this._hover.thumb.contains(event.targetActor) &&
                    !this._pointerOver(this._hover.thumb))
                    this._clearHover();
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._monitor);
    }

    _pointerOver(actor) {
        const [px, py] = global.get_pointer();
        const [ok, x, y] = actor.transform_stage_point(px, py);
        return ok && x >= 0 && y >= 0 && x < actor.width && y < actor.height;
    }

    _dragEnd() {
        this._clearHover();
        this._refused = null;
        if (this._monitor) {
            DND.removeDragMonitor(this._monitor);
            this._monitor = null;
        }
    }

    /** acceptDropInternal: true when it split. */
    _drop(thumb, source) {
        const hovered = this._hover?.thumb === thumb ? this._hover.side : null;
        this._clearHover();
        try {
            const plan = this._plan(thumb, source);
            if (!plan)
                return false;
            const side = this._sideAt(thumb) ?? hovered;
            if (!side)
                return false;
            return plan.cross ? this._crossSplit(plan, side) : this._split(plan, side);
        } catch (e) {
            this._failed(e, thumb);
            return false;
        }
    }

    // ---- making a pair ---------------------------------------------------------

    _halves(mon, ratio) {
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon);
        const lw = Math.round(wa.width * ratio);
        return {
            wa,
            left: {x: wa.x, y: wa.y, w: lw, h: wa.height},
            right: {x: wa.x + lw, y: wa.y, w: wa.width - lw, h: wa.height},
        };
    }

    /**
     * `crossed`: B just came from a secondary monitor (_landed); what it left
     * there means nothing here, so it gets no home record. `space`: B is the
     * window of a workspace thumbnail dropped here (thumbDrop); that
     * workspace goes, with any overlay windows left on it.
     */
    _split({A, B, loc, ctx}, side, {crossed = false, space = null} = {}) {
        const owner = this._owner;
        const halves = this._halves(loc.mon, 0.5);
        const rectB = side === 'left' ? halves.left : halves.right;
        const rectA = side === 'left' ? halves.right : halves.left;
        if (!fits(A, rectA) || !fits(B, rectB))
            return false; // _plan checked the narrower half already

        const time = global.get_current_time();
        let pair;
        owner._busy = true;
        try {
            // Leaving a pair of its own first: that pair ends as usual (the
            // partner fills its space again once B is gone, below).
            const old = B[PAIR];
            let regrow = null;
            if (old?.alive) {
                const stay = old.left === B ? old.right : old.left;
                regrow = this._end(old, `${title(B)} left for another split`, {stay});
            }

            const from = owner._describe(B, ctx).loc;
            const info = new Map();
            for (const w of [A, B]) {
                info.set(w, {home: w[ISOLATION] ?? null, full: w.is_fullscreen()});
                delete w[ISOLATION];
            }
            if (crossed) {
                info.get(B).home = null;
            } else if (!info.get(B).home) {
                const mates = owner._members(from, ctx).filter(w => w !== B);
                if (mates.length > 0)
                    info.get(B).home = {mates, created: true};
            }

            pair = {
                alive: true,
                loc: placeOf(loc), // see "Places" above
                ratio: 0.5,
                left: side === 'left' ? B : A,
                right: side === 'left' ? A : B,
                host: A,
                guest: B,
                info,
                verifyId: 0,
                settled: false, // both took their halves (_verify); until then _judge waits
                pendingUntil: 0,
                setupUntil: now() + SETUP_MS, // see SETUP_MS
                rehomes: 0,
                transit: new Map(), // partner put back during setup -> last ask (ms)
                watchIds: [],
                judgeId: 0,
                shown: true, // its place was on screen at the last check()
            };
            A[PAIR] = pair;
            B[PAIR] = pair;
            this._pairs.add(pair);

            if (loc.kind === 'real')
                this._joinReal(B, loc, space, time);
            else
                this._joinVirt(B, loc, from, space, ctx);
            this._tile(pair);
            this._watch(pair);
            if (regrow)
                this._regrow([regrow], ctx);
            log(`split ${title(pair.left)} | ${title(pair.right)} on ${where(loc)}` +
                `${crossed ? ' (from another monitor)' : ''}${space ? ' (workspace dropped)' : ''}`);
        } finally {
            owner._busy = false;
            owner._absorb(ctx);
        }
        // The workspace B left may be a made one, now empty: the next sweep
        // collects it (it is no longer the active one).
        owner._schedule();

        this._verifyLater(pair, 1);
        this._hideOverviewSoon();
        return true;
    }

    /** B joins A's primary workspace `loc`, which becomes the active one. */
    _joinReal(B, loc, space, time) {
        const owner = this._owner;
        const source = B.get_workspace();
        const wasSpace = isMax(B);
        if (source !== loc.ws)
            B.change_workspace(loc.ws);
        // A dropped workspace thumbnail: overlays left on it (Vocalinux,
        // wl-clipboard; nothing in scope, see _spaceWindow) come along.
        if (space && source === space && source !== loc.ws) {
            for (const w of source.list_windows()) {
                if (!w.is_on_all_workspaces() && !w.get_transient_for() &&
                    !owner._dying.has(w) && rootOf(w) !== B)
                    w.change_workspace(loc.ws);
            }
        }
        // B was a full-screen space of its own: that space goes, as on
        // macOS (it may be the user's workspace, which the isolation kept
        // B on). _collect drops it once it is not the active one.
        if (wasSpace && source && source !== loc.ws &&
            source.list_windows().every(w => w.is_on_all_workspaces())) {
            source[MADE] = true;
            log(`workspace ${source.index() + 1} held only ${title(B)}; it goes`);
        }
        // The pair's workspace is the active one BEFORE anything is
        // untiled: an X11 client whose restored bounds lie on another
        // monitor is sticky there for a moment, and Mutter puts a window
        // that stops being sticky on the active workspace (the 2026-11-09
        // "Claude moved away" pairs; the one that held was dropped while
        // its target was already the active workspace).
        loc.ws.activate_with_focus(B, time);
    }

    /**
     * B joins A's virtual workspace `loc` (B is on that monitor: in another
     * of its virtual workspaces, or just landed in this one), which becomes
     * the one on screen: also BEFORE anything is untiled, because an X11
     * window laundered in _place leaves the monitor for a moment and islands
     * files it back into the ACTIVE virtual workspace. B's dialogs come
     * along, and for a dropped thumbnail (`space`) the overlays left there.
     * A virtual workspace that was B's full-screen space goes (MADE: _collect
     * drops it once it is not the active one).
     */
    _joinVirt(B, loc, from, space, ctx) {
        const owner = this._owner;
        const {state, group} = loc;
        const source = from.kind === 'virt' && from.conn === loc.conn && from.group !== group
            ? from.group : null;
        const wasSpace = !!source && isMax(B) && [...source].every(w =>
            w === B || owner._dying.has(w) || !owner._describe(w, ctx).eligible);
        const moving = source
            ? [...source].filter(w => !owner._dying.has(w) &&
                (rootOf(w) === B || (space && !owner._describe(w, ctx).eligible)))
            : [];
        for (const w of moving)
            ctx.manage.moveToGroup(state, w, group);
        if (!group.has(B))
            throw new Error(`${title(B)} did not join ${where(loc)}`);
        if (wasSpace) {
            source[MADE] = true;
            log(`virtual workspace ${state._groups.indexOf(source) + 1} on ${loc.conn} ` +
                `held only ${title(B)}; it goes`);
        }
        ctx.manage.activateGroup(state, group);
        if (!B.minimized)
            B.focus(global.get_current_time());
    }

    _hideOverviewSoon() {
        if (this._hideId)
            return;
        this._hideId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._hideId = 0;
            Main.overview.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- from a secondary monitor ----------------------------------------------

    /** A window on its way from a secondary (_crossSplit) or back to its half (setup). */
    inTransit(window) {
        if (this._landing?.has(window))
            return true;
        for (const keep of this._keeps ?? []) {
            if (keep.window === window && keep.hopped)
                return true;
        }
        for (const pair of this._pairs ?? []) {
            if (pair.alive && pair.transit?.has(window))
                return true;
        }
        return false;
    }

    /**
     * B, the visible window of a secondary monitor's virtual workspace, was
     * dropped on a primary full-screen space. Order (cross.js's for a
     * secondary -> primary move): the target workspace is made the active
     * one, since Mutter puts a window that stops being sticky there; then B
     * moves monitor, still maximized if it was (Mutter re-fits it; a Wayland
     * client lands once it acked the new size, an X11 one at once). While it
     * travels it is in transit: the sweep leaves it alone, so it is never an
     * "arrival" on A's space. Once it is on the primary (_landed) it leaves
     * islands and the split is made as for a primary window. Not there
     * within LAND_MS: no split, B stays where it is (_abortLanding).
     */
    _crossSplit({A, B, loc, ctx}, side) {
        const owner = this._owner;
        const d = owner._describe(B, ctx);
        const src = d.loc;
        if (src.kind === 'none' || (src.kind === 'virt' && !src.group))
            return false;
        if (loc.kind === 'virt' && typeof ctx.manage?.landInGroup !== 'function')
            return false;
        const others = (src.kind === 'virt'
            ? src.state.windowsOn(src.idx)
            : src.ws.list_windows().filter(w => w.get_monitor() === src.mon && !w.is_on_all_workspaces()))
            .filter(w => w !== B && rootOf(w) !== B && !owner._dying.has(w));
        const landing = {
            B, A, side,
            place: placeOf(loc), // where B goes
            mon: loc.mon,
            // Where B comes from: a virtual workspace (state, group,
            // connector; _leaveIslands) or a primary one (ws; _leaveReal).
            srcKind: src.kind,
            ws: src.kind === 'real' ? src.ws : null,
            state: src.state ?? null,
            group: src.group ?? null,
            connector: src.conn ?? null,
            wasSpace: isMax(B) && others.length === 0,
            from: d, // B's place before, for the sweep if no split comes of it
            until: now() + LAND_MS,
            laterId: 0,
            pollId: 0,
            enteredId: 0,
        };
        this._landing.set(B, landing);
        delete B[ISOLATION]; // its mates are on the other monitor

        const time = global.get_current_time();
        owner._busy = true;
        try {
            log(`cross-monitor split: ${title(B)} from ${where(src)}${src.kind === 'real' ? ' (primary)' : ''} ` +
                `to ${where(loc)} (${side} of ${title(A)})`);
            if (loc.kind === 'real') {
                if (!loc.ws.active)
                    loc.ws.activate(time);
                B.move_to_monitor(loc.mon);
            } else {
                // Islands files B into A's virtual workspace as it arrives
                // (workspace-manage land()), shown as that one is active.
                ctx.manage.activateGroup(loc.state, loc.group);
                ctx.manage.landInGroup(loc.state, loc.group, [B], () => B.move_to_monitor(loc.mon));
            }
        } catch (e) {
            if (loc.kind === 'virt') {
                owner._busy = false;
                this._stopLanding(landing);
                throw e;
            }
            console.error(`[split-view] ${e}\n${e.stack}`);
        } finally {
            owner._busy = false;
            owner._absorb(ctx);
        }
        this._hideOverviewSoon();

        if (B.get_monitor() === loc.mon) {
            this._landed(landing); // an X11 client, or a floating one
            return true;
        }
        landing.enteredId = global.display.connect('window-entered-monitor', (_d, _i, w) => {
            if (w === B)
                this._landLater(landing);
        });
        landing.pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAND_POLL_MS, () => {
            if (this._landing.get(B) !== landing) {
                landing.pollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (owner._dying.has(B) || !B.get_compositor_private()) {
                landing.pollId = 0;
                this._stopLanding(landing);
                log(`${title(B)} closed on its way to the other monitor`);
                return GLib.SOURCE_REMOVE;
            }
            if (B.get_monitor() === landing.mon) {
                landing.pollId = 0;
                this._landed(landing);
                return GLib.SOURCE_REMOVE;
            }
            if (now() > landing.until) {
                landing.pollId = 0;
                this._abortLanding(landing);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        return true;
    }

    /** Out of a signal handler (Mutter is mid-move): finish at the next frame. */
    _landLater(landing) {
        if (landing.laterId)
            return;
        landing.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            landing.laterId = 0;
            if (this._landing.get(landing.B) === landing && landing.B.get_monitor() === landing.mon)
                this._landed(landing);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopLanding(landing) {
        if (this._landing.get(landing.B) === landing)
            this._landing.delete(landing.B);
        if (landing.pollId) {
            GLib.Source.remove(landing.pollId);
            landing.pollId = 0;
        }
        if (landing.laterId) {
            global.compositor.get_laters().remove(landing.laterId);
            landing.laterId = 0;
        }
        if (landing.enteredId) {
            global.display.disconnect(landing.enteredId);
            landing.enteredId = 0;
        }
    }

    /** B is on the target monitor: onto the space (out of islands' care, or into its group), and split. */
    _landed(landing) {
        if (this._landing.get(landing.B) !== landing)
            return;
        this._stopLanding(landing);
        const owner = this._owner;
        const {B, place} = landing;
        if (owner._dying.has(B) || !B.get_compositor_private())
            return;

        let ctx = owner._context();
        owner._busy = true;
        try {
            if (place.kind === 'real') {
                // Sticky on the primary only if the user asked for it (window
                // menu "always on visible workspace"); a split space is not that.
                if (B.is_on_all_workspaces())
                    B.unstick();
                if (hasWorkspace(place.ws) && B.get_workspace() !== place.ws)
                    B.change_workspace(place.ws);
            } else {
                const target = this._virtLoc(place.conn, place.group, ctx);
                if (target && !place.group.has(B))
                    ctx.manage?.moveToGroup(target.state, B, place.group);
            }
            if (landing.srcKind === 'virt')
                this._leaveIslands(landing, ctx);
            else
                this._leaveReal(landing, ctx);
        } catch (e) {
            if (place.kind === 'virt') {
                owner._busy = false;
                owner._absorb(owner._context());
                throw e;
            }
            console.error(`[split-view] ${e}\n${e.stack}`);
        } finally {
            owner._busy = false;
        }

        ctx = owner._context();
        let loc = null;
        if (place.kind === 'real')
            loc = hasWorkspace(place.ws) ? {kind: 'real', ws: place.ws, mon: place.mon} : null;
        else
            loc = this._virtLoc(place.conn, place.group, ctx);
        const plan = loc ? this._planAt(loc, B, ctx, {landed: true}) : null;
        if (plan && this._split(plan, landing.side, {crossed: true}))
            return;
        // A went away, stopped being a full-screen space, B does not fit, ...:
        // B arrived like any window from the other monitor (the sweep sees it
        // come from where it was and applies the rule).
        log(`${title(B)} arrived on the other monitor but no split holds there now; ` +
            'a plain arrival');
        owner._snapshot.set(B, landing.from);
        owner._schedule();
    }

    /**
     * B left a primary workspace for a secondary. If it was B's full-screen
     * space (or one made for a split), now empty, it goes, as on macOS; the
     * primary then shows a neighbour (_dropIfEmpty).
     */
    _leaveReal(landing, ctx) {
        const ws = landing.ws;
        if (!ws || !hasWorkspace(ws) || !(landing.wasSpace || ws[MADE]))
            return;
        this._owner._dropIfEmpty({kind: 'real', ws, mon: ctx.primary}, ctx);
    }

    /**
     * B left its virtual workspace for the primary. Islands drops a window
     * from its group as it leaves the monitor (window-left-monitor); anything
     * it has not let go of is dropped here. A virtual workspace that held
     * only B goes if it was made for a split (MADE) or was B's full-screen
     * space; the user's own (non-made) workspaces stay, empty. Removing the
     * active one makes a neighbour active (islands.js remove()), so the
     * secondary shows something sensible.
     */
    _leaveIslands(landing, ctx) {
        const owner = this._owner;
        const {B, group} = landing;
        const state = ctx.registry?.forConnector?.(landing.connector) ?? landing.state;
        if (!state?._groups)
            return;
        const at = state.indexOf(B);
        if (at >= 0)
            state._groups[at].delete(B);
        const idx = state._groups.indexOf(group);
        if (idx < 0)
            return;
        const left = state.windowsOn(idx).filter(w => !owner._dying.has(w));
        if (left.length === 0 && (group[MADE] || landing.wasSpace) && state.size > 1 && ctx.manage) {
            log(`virtual workspace ${idx + 1} on ${state.connector} held only ${title(B)}; it goes`);
            ctx.manage.removeVirtualWorkspace(state, idx);
        } else {
            state._notifySizeChanged?.();
            owner._islandsChanged(ctx, `${title(B)} left for the primary`);
        }
    }

    /** B did not reach the primary in time: no split; it stays where it is. */
    _abortLanding(landing) {
        this._stopLanding(landing);
        const owner = this._owner;
        const {B} = landing;
        log(`${title(B)} did not reach the other monitor within ${LAND_MS} ms; no split, ` +
            'it stays where it is');
        if (owner._dying.has(B) || !B.get_compositor_private())
            return;
        // Its client may still take the move later (it was asked to): then
        // it is a plain arrival for the sweep, but the place it left on the
        // secondary goes as it would have (_leaveIslands), not left empty.
        const late = {id: 0, timeoutId: 0};
        const stop = () => {
            if (late.id)
                global.display.disconnect(late.id);
            if (late.timeoutId)
                GLib.Source.remove(late.timeoutId);
            late.id = late.timeoutId = 0;
            this._lates?.delete(stop);
        };
        late.id = global.display.connect('window-entered-monitor', (_d, _i, w) => {
            if (w !== B || B.get_monitor() !== landing.mon)
                return;
            stop();
            global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                if (!owner._dying.has(B) && this._lates) {
                    log(`${title(B)} reached the other monitor late; dropping what it left`);
                    if (landing.srcKind === 'virt')
                        this._leaveIslands(landing, owner._context());
                    else
                        this._leaveReal(landing, owner._context());
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        late.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
            late.timeoutId = 0;
            stop();
            return GLib.SOURCE_REMOVE;
        });
        this._lates ??= new Set();
        this._lates.add(stop);
        // From here on it is an ordinary window: its place now is the
        // baseline, and should it still arrive later, that is an arrival.
        const d = owner._describe(B, owner._context());
        if (d.mapped)
            owner._snapshot.set(B, d);
        owner._schedule();
    }

    // ---- a workspace thumbnail dropped on another (workspace-manage strip.js) ----

    /**
     * The one window of the place `ref` names (a primary Meta.Workspace, or
     * strip.js's {kind: 'virt', state, group}) if it is a full-screen space,
     * else null. On a secondary it may be parked (its virtual workspace is
     * not the one on screen).
     */
    _spaceWindow(ref, ctx) {
        const owner = this._owner;
        const loc = this._refLoc(ref, ctx);
        if (!loc)
            return null;
        const members = owner._members(loc, ctx, {includeMinimized: true});
        if (members.length !== 1)
            return null;
        const B = members[0];
        if (!isMax(B) || isPaired(B) || owner._describe(B, ctx).userMin ||
            (loc.kind === 'real' && B.minimized))
            return null;
        // Anything else on it must be an overlay or B's own dialogs, or the
        // workspace could not go: a full-screen space holds one window.
        const all = loc.kind === 'real'
            ? loc.ws.list_windows().filter(w => !w.is_on_all_workspaces())
            : loc.state.windowsOn(loc.idx);
        const rest = all.filter(w => w !== B && !owner._dying.has(w) && rootOf(w) !== B);
        if (rest.some(w => owner._describe(w, ctx).eligible))
            return null;
        return B;
    }

    /** Workspace `ref`'s thumbnail over `thumb`, on the same strip: the split, or null. */
    _thumbPlan(ref, thumb) {
        if (!thumb || this._owner._busy)
            return null;
        const ctx = this._owner._context();
        const loc = this._thumbLoc(thumb, ctx);
        const from = loc ? this._refLoc(ref, ctx) : null;
        if (!from || sameLoc(loc, from) || loc.mon !== from.mon)
            return null;
        const B = this._spaceWindow(ref, ctx);
        return B ? this._planAt(loc, B, ctx, {parked: true}) : null;
    }

    /** Pointer over `thumb` with workspace `ref`'s thumbnail: the side lit, or null. */
    thumbHover(ref, thumb) {
        let side = null;
        try {
            if (this._thumbPlan(ref, thumb))
                side = this._sideAt(thumb);
            if (side)
                this._showHover(thumb, side);
            else
                this._clearHover();
        } catch (e) {
            this._failed(e, thumb);
            side = null;
        }
        return side;
    }

    thumbClear() {
        this._clearHover();
    }

    /** Workspace `ref`'s thumbnail dropped on `thumb`: true when it split. */
    thumbDrop(ref, thumb) {
        const hovered = this._hover?.thumb === thumb ? this._hover.side : null;
        this._clearHover();
        try {
            const plan = this._thumbPlan(ref, thumb);
            const side = plan ? this._sideAt(thumb) ?? hovered : null;
            if (!side)
                return false;
            log(`${where(this._refLoc(ref, plan.ctx))} (${title(plan.B)}) dropped on ` +
                `${where(plan.loc)}'s ${side} half`);
            return this._split(plan, side, {space: ref});
        } catch (e) {
            this._failed(e, thumb);
            return false;
        }
    }

    _tile(pair) {
        pair.pendingUntil = GLib.get_monotonic_time() / 1000 + PENDING_MS;
        const mon = this._mon(pair);
        if (mon < 0)
            return;
        const halves = this._halves(mon, pair.ratio);
        // Laundering (see _place) only where islands files a hopping X11
        // window back into the right virtual workspace: the active one.
        const conn = pair.loc.kind === 'virt' && this._active(pair) ? pair.loc.conn : null;
        this._place(pair.left, halves.left, conn);
        this._place(pair.right, halves.right, conn);
    }

    /**
     * Tile `window` to rect `r`. `conn`: a secondary's connector, where a
     * window whose vertical restore rect lies elsewhere (MAX_ON) gets it
     * moved here: vertical maximization off and on again in one turn, with
     * the half asked for in between, its actor frozen. Mutter otherwise
     * restores that rect on any un-maximize (exit, Super+Down): the window
     * jumps to the other monitor, out of islands, and on a monitor of
     * another scale an X11 window comes back the wrong size (prototype p2).
     * An X11 client goes there and back within the turn (synchronous, not
     * seen: frozen); a Wayland one never gets the restore (p3).
     */
    _place(window, r, conn = null) {
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (conn && window.maximized_vertically && window[MAX_ON] !== conn) {
            const actor = window.get_compositor_private();
            if (actor) {
                Main.wm.skipNextEffect(actor);
                if (!this._thaws.has(actor))
                    actor.freeze();
            }
            if (window.maximized_horizontally)
                window.set_unmaximize_flags(Meta.MaximizeFlags.HORIZONTAL);
            window.set_unmaximize_flags(Meta.MaximizeFlags.VERTICAL);
            window.move_resize_frame(true, r.x, r.y, r.w, r.h);
            window.set_maximize_flags(Meta.MaximizeFlags.VERTICAL);
            window.move_resize_frame(true, r.x, r.y, r.w, r.h);
            window[MAX_ON] = conn;
            if (actor) {
                Main.wm._skippedActors?.delete(actor);
                const old = this._thaws.get(actor);
                if (old)
                    GLib.Source.remove(old);
                this._thaws.set(actor, GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAUNDER_THAW_MS, () => {
                    this._thaws.delete(actor);
                    if (window.get_compositor_private() === actor)
                        actor.thaw();
                    return GLib.SOURCE_REMOVE;
                }));
            }
            log(`${title(window)}: restore rect moved to ${conn}`);
            return;
        }
        if (window.maximized_horizontally && window.maximized_vertically) {
            // Only the horizontal half goes: the height (and so the monitor,
            // for monitors stacked vertically, as the user's are) never goes
            // through the saved, pre-maximize rect, which for a window
            // maximized elsewhere can lie on another monitor (2026-11-09:
            // Claude restored onto the external above eDP-1 and left the pair).
            window.set_unmaximize_flags(Meta.MaximizeFlags.HORIZONTAL);
        } else if (window.maximized_horizontally) {
            window.unmaximize();
        }
        if (!window.maximized_vertically)
            window.set_maximize_flags(Meta.MaximizeFlags.VERTICAL);
        // One call, no move_frame() first (as tiling-assistant does): on
        // Wayland a move alone lands at once with the old size, which for
        // the right half of a maximized window overlaps the next monitor
        // mostly; the window "entered" it, islands made it sticky and the
        // pair ended. A move with a resize waits for the client's new size.
        window.move_resize_frame(true, r.x, r.y, r.w, r.h);
    }

    _verifyLater(pair, attempt) {
        pair.verifyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_MS, () => {
            pair.verifyId = 0;
            this._verify(pair, attempt);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Both clients took their half? A slow one gets asked again (twice);
     * one that still refuses ends the pair as if the drop had been stock.
     */
    _verify(pair, attempt) {
        if (!pair.alive)
            return;
        const mon = this._mon(pair);
        if (mon < 0) {
            this._verifyLater(pair, attempt); // its monitor is away for now
            return;
        }
        const halves = this._halves(mon, pair.ratio);
        const bad = [[pair.left, halves.left], [pair.right, halves.right]]
            .find(([w, r]) => w.get_frame_rect().width > r.w + SLACK);
        if (!bad) {
            pair.settled = true;
            this._judgeLater(pair);
            return;
        }
        if (attempt < VERIFY_TRIES || this._owner._grabbing) {
            log(`${title(bad[0])} is not at its half yet (${bad[0].get_frame_rect().width} > ${bad[1].w}); asking again`);
            if (!this._owner._grabbing)
                this._place(bad[0], bad[1]);
            this._verifyLater(pair, attempt + 1);
            return;
        }

        const owner = this._owner;
        const ctx = owner._context();
        const {host, guest} = pair;
        log(`${title(bad[0])} did not take its half (${bad[0].get_frame_rect().width} > ${bad[1].w}); ` +
            'undoing the split');
        owner._busy = true;
        try {
            // The host takes its space back first, so the guest then leaves
            // it as an arrival (a fresh workspace right after).
            this._fill(this._end(pair, 'client refused its half', {stay: host}));
            guest.unmaximize(); // back to the size it had before
            const d = owner._describe(guest, ctx);
            if (d.eligible && sameLoc(d.loc, this._loc(pair, ctx)))
                owner._arrive({loc: d.loc, windows: [guest]}, ctx);
            owner._collect(ctx);
        } finally {
            owner._busy = false;
            owner._absorb(ctx);
        }
    }

    // ---- ending a pair ---------------------------------------------------------

    /** Drop the pair without touching the windows. */
    _forget(pair) {
        pair.alive = false;
        if (pair.verifyId) {
            GLib.Source.remove(pair.verifyId);
            pair.verifyId = 0;
        }
        if (pair.rehomeId) {
            GLib.Source.remove(pair.rehomeId);
            pair.rehomeId = 0;
        }
        pair.transit?.clear();
        this._unwatch(pair);
        this._pairs?.delete(pair);
        for (const w of [pair.left, pair.right]) {
            if (w[PAIR] === pair)
                delete w[PAIR];
        }
        if (this._resize?.pair === pair)
            this._endResize();
    }

    /**
     * The two windows left the split (dragged out, resized off their tiles,
     * un-maximized vertically, moved by a tiling key): an EXIT, not a
     * dissolve. Nothing is re-maximized and nothing moves; both stay where
     * they are as normal windows, and the isolation records the pair held
     * (pair.info) go with it, so un-maximizing never takes the host "home"
     * and the workspace is an ordinary shared one. Its MADE tag, if any, stays:
     * _collect drops it once it is empty.
     */
    _release(pair, why) {
        this._forget(pair);
        log(`leaving split ${title(pair.left)} | ${title(pair.right)}: ${why}; ` +
            'both stay where they are as normal windows');
        for (const w of [pair.left, pair.right]) {
            if (this._owner._dying.has(w) || !w.get_compositor_private())
                continue;
            delete w[ISOLATION];
            this._unflag(w);
        }
    }

    /**
     * Clear a half's vertical maximization, keeping the geometry it has.
     *
     * Un-maximizing restores the size from before the split, so the rect it
     * has is asked for again whenever the window lands elsewhere, until it
     * has stayed put for KEEP_QUIET_MS. On Wayland the request only works
     * once the restore reached the client (asked for in the same turn, the
     * restore won); an X11 GTK client applies the restore at once and then
     * asks for its own remembered size a moment later. Meanwhile the actor
     * is frozen (as the shell's own size-change animations do), so the
     * restored size is never shown: the nested test saw no frame of it,
     * against one without the freeze. KEEP_MS ends it in any case.
     */
    _unflag(window) {
        if (isMax(window) || !window.maximized_vertically)
            return;
        const f = window.get_frame_rect();
        const actor = window.get_compositor_private();
        // Where it is, taken before the un-maximize (an X11 client's restore
        // is applied at once, hop included). On a secondary: its virtual
        // workspace, by group.
        const d0 = this._owner._describe(window, this._owner._context());
        const home = {
            mon: window.get_monitor(),
            ws: window.get_workspace(),
            virt: d0.loc.kind === 'virt' ? {conn: d0.loc.conn, group: d0.loc.group} : null,
        };
        // No un-maximize animation: it would run to the restored size.
        Main.wm.skipNextEffect(actor);
        actor.freeze();
        window.set_unmaximize_flags(Meta.MaximizeFlags.VERTICAL);
        Main.wm._skippedActors?.delete(actor); // in case no size-change was emitted

        // Mutter restores the height from the pre-maximize rect, which for a
        // window first maximized on another monitor lies there (move_to_monitor
        // does not move it): the window hops over, becomes sticky, islands
        // may park it. It is asked back below; meanwhile it is in transit
        // (inTransit), and once back it gets its workspace and is shown.
        // (A half on a secondary had that rect laundered in _place.)
        const keep = {window, actor, home, ids: [], timeoutId: 0, quietId: 0, tries: 0, thawed: false};
        // X11 CSD clients shift their frame by a few px as their shadows change.
        const same = g => Math.abs(g.x - f.x) <= 2 && Math.abs(g.y - f.y) <= 2 &&
            Math.abs(g.width - f.width) <= 2 && Math.abs(g.height - f.height) <= 2;
        const homeAgain = () => {
            const ctx = this._owner._context();
            const vloc = home.virt ? this._virtLoc(home.virt.conn, home.virt.group, ctx) : null;
            // Parked by islands on the way: shown again, unless its virtual
            // workspace is not the one on screen (the user switched away).
            if (window.minimized && window[ISLANDS_HIDDEN] === true &&
                (!home.virt || (vloc && vloc.idx === vloc.state.activeIndex))) {
                delete window[ISLANDS_HIDDEN];
                window.unminimize();
            }
            if (window.get_monitor() !== home.mon)
                return;
            if (vloc && !home.virt.group.has(window) && this._virtReady(ctx))
                ctx.manage.moveToGroup(vloc.state, window, home.virt.group);
            else if (!home.virt && home.ws && !window.is_on_all_workspaces() &&
                window.get_workspace() !== home.ws && hasWorkspace(home.ws))
                window.change_workspace(home.ws);
            if (keep.hopped) {
                keep.hopped = false;
                const d = this._owner._describe(window, this._owner._context());
                if (d.mapped)
                    this._owner._snapshot.set(window, d); // for the sweep it never left
                log(`${title(window)} is back after its restore hopped monitors`);
            }
        };
        const quiet = () => {
            if (keep.quietId)
                GLib.Source.remove(keep.quietId);
            keep.quietId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEEP_QUIET_MS, () => {
                keep.quietId = 0;
                this._kept(keep);
                return GLib.SOURCE_REMOVE;
            });
        };
        const fix = () => {
            if (window.get_monitor() !== home.mon)
                keep.hopped = true;
            homeAgain();
            if (!same(window.get_frame_rect()) && keep.tries < KEEP_TRIES) {
                keep.tries++;
                window.move_resize_frame(true, f.x, f.y, f.width, f.height);
            }
            if (keep.tries > 0)
                quiet(); // done once nothing moved it for a while
        };
        keep.ids.push(
            window.connect('size-changed', fix),
            window.connect('position-changed', fix),
            window.connect('unmanaging', () => this._kept(keep)));
        keep.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEEP_MS, () => {
            keep.timeoutId = 0;
            if (!same(window.get_frame_rect()) && !this._owner._dying.has(window))
                window.move_resize_frame(true, f.x, f.y, f.width, f.height);
            this._kept(keep);
            return GLib.SOURCE_REMOVE;
        });
        this._keeps.add(keep);
        fix(); // X11 clients have the restored rect already
    }

    /** _unflag is done with a window: stop watching it, thaw its actor. */
    _kept(keep) {
        if (!this._keeps.delete(keep))
            return;
        for (const id of keep.ids)
            keep.window.disconnect(id);
        if (keep.timeoutId)
            GLib.Source.remove(keep.timeoutId);
        if (keep.quietId)
            GLib.Source.remove(keep.quietId);
        if (!keep.thawed) {
            keep.thawed = true;
            if (keep.window.get_compositor_private() === keep.actor)
                keep.actor.thaw();
        }
    }

    /** Both halves exactly tile the work area (any divider ratio), within SLACK. */
    _tiles(pair) {
        const {wa} = this._halves(this._mon(pair), pair.ratio);
        const l = pair.left.get_frame_rect();
        const r = pair.right.get_frame_rect();
        const near = (a, b) => Math.abs(a - b) <= SLACK;
        return pair.left.maximized_vertically && pair.right.maximized_vertically &&
            near(l.x, wa.x) && near(l.x + l.width, r.x) &&
            near(r.x + r.width, wa.x + wa.width) &&
            [l, r].every(f => near(f.y, wa.y) && near(f.height, wa.height));
    }

    /** Judge each half's geometry changes that no grab of ours accounts for. */
    _watch(pair) {
        this._unwatch(pair);
        for (const w of [pair.left, pair.right]) {
            for (const signal of ['position-changed', 'size-changed'])
                pair.watchIds.push([w, w.connect(signal, () => this._judgeLater(pair))]);
        }
    }

    _unwatch(pair) {
        for (const [w, id] of pair.watchIds ?? [])
            w.disconnect(id);
        pair.watchIds = [];
        if (pair.judgeId) {
            GLib.Source.remove(pair.judgeId);
            pair.judgeId = 0;
        }
    }

    _judgeLater(pair, delay = WATCH_MS) {
        if (!pair.alive)
            return;
        if (pair.judgeId)
            GLib.Source.remove(pair.judgeId);
        pair.judgeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(delay)), () => {
            pair.judgeId = 0;
            try {
                this._judge(pair);
            } catch (e) {
                console.error(`[split-view] ${e}\n${e.stack}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * A half's geometry changed outside a grab (a tiling key, Super+Down's
     * restore, the client itself): does the pair still tile? Grabs are
     * judged at their end (_grabEnd); workspace, monitor, minimize and
     * maximize changes are the sweep's (check()).
     */
    _judge(pair) {
        const owner = this._owner;
        if (!pair.alive || !pair.settled)
            return; // _verify decides first
        // Locked: the dock (not in unlock-dialog) is gone and its strut with
        // it, so the work area is not the one the pair tiles; do not end a
        // pair over that. Changes after the unlock are judged as usual.
        if (Main.sessionMode.isLocked)
            return;
        if (owner._grabbing || owner._layoutChanging || owner._busy) {
            this._judgeLater(pair);
            return;
        }
        const wait = pair.pendingUntil - GLib.get_monotonic_time() / 1000;
        if (wait > 0) {
            this._judgeLater(pair, wait + 50);
            return;
        }
        // Clients on a hidden workspace may lag behind a re-tile; nobody
        // rearranged windows the user cannot see.
        if (this._mon(pair) < 0 || !this._active(pair))
            return;
        const here = [pair.left, pair.right].every(w =>
            !owner._dying.has(w) && this._inPlace(pair, w) && !w.minimized && !isMax(w));
        if (!here || this._tiles(pair))
            return;
        this._release(pair, 'the two no longer tile the work area');
    }

    /**
     * End a pair. `maximized` (isolated next by the sweep) gets its isolation
     * record back now; `stay` gets it from _regrow, once it is full-screen
     * again. Returns the _regrow entry for `stay`, or null.
     */
    _end(pair, why, {stay = null, maximized = null} = {}) {
        this._forget(pair);
        log(`ending ${title(pair.left)} | ${title(pair.right)}: ${why}`);
        const home = maximized ? pair.info.get(maximized)?.home : null;
        if (home && !maximized[ISOLATION])
            maximized[ISOLATION] = home;
        if (!stay)
            return null;
        const info = pair.info.get(stay);
        return {window: stay, full: !!info?.full, home: info?.home ?? null};
    }

    /** `entry.window` is a full-screen space again: as before, and its record. */
    _fill(entry) {
        const w = entry.window;
        if (entry.full) {
            if (w.maximized_vertically)
                w.unmaximize(); // or it comes back from fullscreen as a half
            w.make_fullscreen();
        } else {
            w.maximize();
        }
        if (entry.home && !w[ISOLATION])
            w[ISOLATION] = entry.home;
        log(`${title(w)} is a full-screen space again`);
    }

    /** Make each window a full-screen space again, as it was before. */
    _regrow(entries, ctx) {
        for (const entry of entries) {
            const w = entry?.window;
            if (!w || isPaired(w) || this._owner._dying.has(w))
                continue;
            const owner = this._owner;
            let d = owner._describe(w, ctx);
            // Minimized by the user: not now. Parked by islands (its virtual
            // workspace is not on screen): it is shown full-screen later.
            if (!d.eligible || d.loc.kind === 'none' || d.userMin ||
                (w.minimized && d.loc.kind !== 'virt'))
                continue;
            // Not alone (its partner was maximized but nothing isolated it):
            // leave as an arrival would, then fill the place it lands on.
            if (owner._members(d.loc, ctx).some(m => m !== w)) {
                owner._arrive({loc: d.loc, windows: [w]}, ctx);
                d = owner._describe(w, ctx);
                if (owner._members(d.loc, ctx).some(m => m !== w))
                    continue;
            }
            this._fill(entry);
        }
    }

    /**
     * Start of a sweep (extension.js _act, _busy set): end every pair that
     * no longer holds. Returns the windows to make full-screen again; the
     * sweep hands them to finish() after its own moves.
     */
    check(ctx) {
        const regrow = [];
        if (!this._pairs?.size)
            return regrow;
        const alive = new Set(this._owner._windows());
        if ([...this._pairs].some(p => p.loc.kind === 'virt'))
            this._virtReady(ctx); // (re)subscribes to islands' changes
        for (const pair of [...this._pairs]) {
            if (!pair.alive)
                continue;
            if (pair.loc.kind !== 'virt') {
                this._checkPair(pair, ctx, alive, regrow);
                continue;
            }
            try {
                this._checkPair(pair, ctx, alive, regrow);
            } catch (e) {
                this._breakVirt(e, 'pair check');
            }
        }
        return regrow;
    }

    _checkPair(pair, ctx, alive, regrow) {
        const owner = this._owner;
        const virt = pair.loc.kind === 'virt';
        const ploc = this._loc(pair, ctx);
        const mon = this._mon(pair);
        const active = !!ploc && this._active(pair, ctx);
        const status = new Map();
        for (const w of [pair.left, pair.right]) {
            if (!alive.has(w) || owner._dying.has(w)) {
                status.set(w, 'closed');
                continue;
            }
            if (this._rehome(pair, w, ctx)) {
                status.set(w, 'ok'); // on its way back (SETUP_MS)
                continue;
            }
            const d = owner._describe(w, ctx);
            if (!d.eligible || !ploc || !sameLoc(d.loc, ploc) || d.loc.mon !== mon)
                status.set(w, {moved: d});
            else if (d.userMin)
                status.set(w, 'minimized');
            else if (virt && w.minimized)
                // Parked by islands: fine while the pair's virtual workspace
                // is not on screen; hidden while it is, it is not in it.
                status.set(w, active ? {moved: d} : 'ok');
            else if (isMax(w))
                status.set(w, 'maximized');
            else if (!w.maximized_vertically)
                status.set(w, 'untiled'); // Super+Down, a tiling key, ...
            else
                status.set(w, 'ok');
        }
        const [sl, sr] = [status.get(pair.left), status.get(pair.right)];
        if (sl === 'ok' && sr === 'ok') {
            // Shown again after being parked: a work area that changed
            // width meanwhile (heights Mutter re-fits itself) is caught up.
            if (virt && active && !pair.shown)
                this._retileIfOff(pair, 'shown again');
            pair.shown = active;
            return;
        }
        if ((sl === 'ok' || sl === 'untiled') && (sr === 'ok' || sr === 'untiled')) {
            const which = [pair.left, pair.right].filter(w => status.get(w) === 'untiled');
            this._release(pair, `${which.map(title).join(', ')} no longer vertically maximized`);
            return;
        }

        // Moved together (an isolation, a removed workspace, an undock or a
        // redock took both): still a pair, at the new place.
        if (sl?.moved && sr?.moved) {
            const [dl, dr] = [sl.moved, sr.moved];
            if (dl.eligible && dr.eligible && !dl.userMin && !dr.userMin &&
                sameLoc(dl.loc, dr.loc) && !isMax(pair.left) && !isMax(pair.right) &&
                (dl.loc.kind === 'real' ? dl.loc.mon === ctx.primary : this._virtReady(ctx))) {
                log(`pair moved together to ${where(dl.loc)}`);
                pair.loc = placeOf(dl.loc);
                if (dl.loc.mon !== mon)
                    this._tile(pair);
                else
                    this._retileIfOff(pair, 'moved together');
                pair.shown = this._active(pair, ctx);
                return;
            }
        }

        const describe = s => (typeof s === 'string' ? s : 'moved away');
        const why = [pair.left, pair.right]
            .filter(w => status.get(w) !== 'ok')
            .map(w => `${title(w)} ${describe(status.get(w))}`)
            .join(', ');
        const stay = [pair.left, pair.right].find(w => status.get(w) === 'ok') ?? null;
        const maximized = [pair.left, pair.right].find(w => status.get(w) === 'maximized') ?? null;
        const entry = this._end(pair, why, {stay, maximized});
        if (entry)
            regrow.push(entry);

        // A window that left for another workspace (or was minimized)
        // gets its own size back. Not one that went to another monitor:
        // un-maximizing restores a position, and that is on this one.
        for (const w of [pair.left, pair.right]) {
            const s = status.get(w);
            const left = s === 'minimized' || (s?.moved && s.moved.eligible);
            if (left && !isMax(w) && w.maximized_vertically && w.get_monitor() === mon)
                w.unmaximize();
        }
    }

    /**
     * Setup (SETUP_MS after the split): a partner that left the pair's
     * monitor or workspace, or was parked by islands while the pair's
     * virtual workspace is on screen, did not do so by the user's hand (no
     * grab can start that fast; a grab-op-end's own exit is _grabEnd's).
     * Ask it back to its half, at most REHOME_TRIES times in all, and keep
     * the pair meanwhile. True while it is on its way back; false when it is
     * home, or setup is over (then check() judges it as always, and a
     * partner still away ends the pair). Both parked because the user
     * switched the secondary's virtual workspace is not away.
     */
    _rehome(pair, w, ctx) {
        const owner = this._owner;
        const virt = pair.loc.kind === 'virt';
        const mon = this._mon(pair);
        const parked = w.minimized && w[ISLANDS_HIDDEN] === true;
        const shown = !virt || this._active(pair, ctx);
        const away = virt
            ? w.get_monitor() !== mon || !pair.loc.group.has(w) || (parked && shown)
            : parked || w.get_monitor() !== mon ||
                (!w.is_on_all_workspaces() && w.get_workspace() !== pair.loc.ws);
        const t = now();
        if (!away) {
            if (pair.transit.delete(w)) {
                // Home again: for the sweep it never left.
                const d = owner._describe(w, ctx);
                if (d.mapped)
                    owner._snapshot.set(w, d);
                log(`${title(w)} is back on its half`);
            }
            return false;
        }
        const ploc = this._loc(pair, ctx);
        if (t > pair.setupUntil || owner._grabbing || !ploc || mon < 0 ||
            (virt && !this._virtReady(ctx))) {
            pair.transit.delete(w);
            return false;
        }
        const last = pair.transit.get(w);
        if (last !== undefined && t - last < REHOME_GAP_MS)
            return true; // asked a moment ago; a Wayland client takes a few frames
        if (pair.rehomes >= REHOME_TRIES) {
            pair.transit.delete(w);
            return false;
        }
        pair.rehomes++;
        pair.transit.set(w, t);
        log(`${title(w)} left its half by itself (monitor ${w.get_monitor()}, ` +
            `${w.is_on_all_workspaces() ? 'sticky' : `workspace ${w.get_workspace()?.index() + 1}`}` +
            `${parked ? ', parked by islands' : ''}); putting it back ` +
            `(${pair.rehomes}/${REHOME_TRIES})`);
        if (parked && shown) {
            delete w[ISLANDS_HIDDEN];
            w.unminimize();
        }
        if (w.get_monitor() !== mon) {
            const halves = this._halves(mon, pair.ratio);
            const r = w === pair.left ? halves.left : halves.right;
            if (!w.maximized_vertically)
                w.set_maximize_flags(Meta.MaximizeFlags.VERTICAL);
            w.move_resize_frame(true, r.x, r.y, r.w, r.h);
            pair.pendingUntil = Math.max(pair.pendingUntil, t + PENDING_MS);
        }
        if (!virt && !w.is_on_all_workspaces() && w.get_workspace() !== pair.loc.ws)
            w.change_workspace(pair.loc.ws);
        // Back on the secondary (islands filed it into its active virtual
        // workspace as it entered), or there all along in another one.
        if (virt && w.get_monitor() === mon && !pair.loc.group.has(w))
            ctx.manage.moveToGroup(ploc.state, w, pair.loc.group);
        // A client that never moves sends no signal: look again regardless.
        if (!pair.rehomeId) {
            pair.rehomeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REHOME_GAP_MS, () => {
                owner._schedule();
                if (pair.alive && pair.transit.size > 0 && now() <= pair.setupUntil + REHOME_GAP_MS)
                    return GLib.SOURCE_CONTINUE;
                pair.rehomeId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
        return true;
    }

    /**
     * extension.js moved these windows to `loc` together (a fresh workspace
     * or virtual workspace): a pair among them goes along.
     */
    relocated(windows, loc) {
        if (!loc || loc.kind === 'none')
            return;
        for (const pair of this._pairs ?? []) {
            if (windows.includes(pair.left) && windows.includes(pair.right))
                pair.loc = placeOf(loc);
        }
    }

    /** Screen unlocked (extension.js _sessionUpdated): re-tile what is off. */
    unlocked() {
        this._retileLater();
    }

    /** End of a sweep: the windows check() returned become full-screen again. */
    finish(regrow, ctx) {
        if (regrow.length > 0)
            this._regrow(regrow, ctx);
    }

    /** After the layout settled (_busy set): check, and re-tile what holds. */
    validate(ctx) {
        this.finish(this.check(ctx), ctx);
        this._retile();
    }

    _retileLater() {
        // Locked: the work area only changes for the lock (the dock goes
        // away); unlocked() re-checks. A monitor change still re-tiles
        // through the settle's validate() and _quickRetile.
        if (this._areaId || !this._pairs?.size || Main.sessionMode.isLocked)
            return;
        this._areaId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._areaId = 0;
            // Mid-monitor-change the settle's validate() does it.
            if (!this._owner._layoutChanging && !this._owner._grabbing)
                this._retile();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Every pair on screen back on its halves of the current work area. */
    _retile() {
        for (const pair of this._pairs ?? []) {
            if (!pair.alive || (pair.loc.kind === 'virt' && !this._active(pair)))
                continue; // a parked one is checked once it is shown again
            this._retileIfOff(pair, 're-tiling to the work area');
        }
    }

    /** Re-tile `pair` if its halves are off the work area (horizontally). */
    _retileIfOff(pair, why) {
        const mon = this._mon(pair);
        if (mon < 0)
            return;
        const halves = this._halves(mon, pair.ratio);
        const off = [[pair.left, halves.left], [pair.right, halves.right]].some(([w, r]) => {
            const f = w.get_frame_rect();
            return Math.abs(f.x - r.x) > 2 || Math.abs(f.width - r.w) > SLACK;
        });
        if (off) {
            log(`${why}: re-tiling ${title(pair.left)} | ${title(pair.right)}`);
            this._tile(pair);
        }
    }

    // ---- after a monitor change ----------------------------------------------------

    _layoutMoved() {
        if (!this._pairs?.size)
            return;
        this._quickFrom = now() + QUICK_DELAY_MS;
        this._quickUntil = now() + QUICK_UNTIL_MS;
        if (this._quickId)
            return;
        this._quickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUICK_POLL_MS, () => {
            if (!this._pairs?.size || now() > this._quickUntil) {
                this._quickId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (now() >= this._quickFrom && !this._owner._grabbing) {
                for (const pair of [...this._pairs]) {
                    try {
                        this._quickRetile(pair);
                    } catch (e) {
                        if (pair.loc.kind === 'virt')
                            this._breakVirt(e, 'monitor change');
                        else
                            console.error(`[split-view] ${e}\n${e.stack}`);
                    }
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    /**
     * Once both halves sit together on a place of their own again (an
     * undock moved their virtual workspace to a primary workspace, a redock
     * filed them back into it), tile them there now, not only at the 4 s
     * settle: the moves overlapped them (prototype p7). Membership is still
     * check()'s at the settle; this only follows and re-tiles.
     */
    _quickRetile(pair) {
        if (!pair.alive)
            return;
        const owner = this._owner;
        const ctx = owner._context();
        const [dl, dr] = [pair.left, pair.right].map(w => owner._describe(w, ctx));
        if (!dl.eligible || !dr.eligible || dl.userMin || dr.userMin || !sameLoc(dl.loc, dr.loc))
            return;
        if (dl.loc.kind === 'virt' ? !this._virtReady(ctx) : dl.loc.mon !== ctx.primary)
            return;
        if (isMax(pair.left) || isMax(pair.right) ||
            !pair.left.maximized_vertically || !pair.right.maximized_vertically)
            return;
        // Still part of a pile (an undock in progress puts every window on
        // the active workspace first).
        if (owner._members(dl.loc, ctx, {includeMinimized: true})
            .some(w => w !== pair.left && w !== pair.right))
            return;
        if (!sameLoc(this._loc(pair, ctx), dl.loc)) {
            log(`${title(pair.left)} | ${title(pair.right)} are on ${where(dl.loc)} after the monitor change`);
            pair.loc = placeOf(dl.loc);
            pair.shown = this._active(pair, ctx);
        }
        this._retileIfOff(pair, 'monitor change');
    }

    // ---- linked resize ---------------------------------------------------------

    _grabBegin(window, op) {
        // The user took hold of a window _unflag is still settling: theirs now.
        for (const keep of [...this._keeps]) {
            if (keep.window === window)
                this._kept(keep);
        }
        const pair = window?.[PAIR];
        if (!pair?.alive)
            return;
        op &= ~GRAB_UNCONSTRAINED;
        this._endResize();
        const f = window.get_frame_rect();
        const [px, py] = global.get_pointer();
        const grab = {
            pair, window, id: 0, frame: [f.x, f.y], pointer: [px, py],
            move: MOVE_OPS.has(op),
            keyboard: op === Meta.GrabOp.KEYBOARD_MOVING,
        };
        // The inner edge, by pointer: the partner follows live. Any other
        // resize (outer edge, keyboard) is judged when it ends.
        const inner = window === pair.left ? EAST_OPS : WEST_OPS;
        if (!grab.move && inner.has(op)) {
            grab.id = window.connect('size-changed', () => this._follow(pair, window));
        } else if (grab.keyboard) {
            // Mutter gives a keyboard-moved half its own size back as the
            // move starts (and the old rect on Escape); the move counts from
            // there. A keyboard move never resizes otherwise.
            grab.id = window.connect('size-changed', () => {
                const g = window.get_frame_rect();
                grab.frame = [g.x, g.y];
            });
        }
        this._resize = grab;
    }

    /** The grabbed half moved the divider: the other half follows. */
    _follow(pair, window) {
        if (!pair.alive)
            return;
        const mon = this._mon(pair);
        if (mon < 0)
            return;
        const {wa} = this._halves(mon, pair.ratio);
        const f = window.get_frame_rect();
        const other = window === pair.left ? pair.right : pair.left;
        const x = window === pair.left ? f.x + f.width : wa.x;
        const w = window === pair.left ? wa.x + wa.width - x : f.x - wa.x;
        if (w > 0)
            other.move_resize_frame(true, x, wa.y, w, wa.height);
    }

    /**
     * A grab of a half ended (before extension.js's grab-op-end handler, so
     * before the sweep it schedules). Moved further than EXIT_PX: it left
     * the split. A resize that kept its outer edge (and full height) moved
     * the divider; any other resize left the split. Maximized, minimized or
     * on another workspace: the sweep's check() ends the pair as before.
     */
    _grabEnd(window) {
        const grab = this._resize;
        if (!grab || grab.window !== window)
            return;
        this._endResize();
        const {pair} = grab;
        // Gone elsewhere (another workspace, virtual workspace or monitor):
        // the sweep's check() ends the pair.
        const mon = this._mon(pair);
        if (!pair.alive || isMax(window) || window.minimized || !this._inPlace(pair, window) || mon < 0)
            return;
        const {wa} = this._halves(mon, pair.ratio);
        const f = window.get_frame_rect();

        if (grab.move) {
            // By pointer: Mutter restores a dragged half's own size (moving
            // its frame) the moment it moves. A keyboard move warps the
            // pointer instead: by frame, from where the restore put it.
            const [px, py] = global.get_pointer();
            const moved = grab.keyboard
                ? Math.hypot(f.x - grab.frame[0], f.y - grab.frame[1])
                : Math.hypot(px - grab.pointer[0], py - grab.pointer[1]);
            if (moved < EXIT_PX && window.get_monitor() === mon) {
                log(`${title(window)} moved ${Math.round(moved)} px; back to its half`);
                this._tile(pair);
                return;
            }
            this._release(pair, `${title(window)} dragged out (${Math.round(moved)} px)`);
            return;
        }

        const near = (a, b) => Math.abs(a - b) <= SLACK;
        const outer = window === pair.left
            ? near(f.x, wa.x)
            : near(f.x + f.width, wa.x + wa.width);
        if (window.get_monitor() !== mon || !window.maximized_vertically || !outer ||
            !near(f.y, wa.y) || !near(f.height, wa.height)) {
            this._release(pair, `${title(window)} resized off its half`);
            return;
        }
        // Settle the divider where the user left it, inside both minimum widths.
        let divider = window === pair.left ? f.x + f.width - wa.x : f.x - wa.x;
        const [leftMin] = minSize(pair.left);
        const [rightMin] = minSize(pair.right);
        divider = Math.max(leftMin, Math.min(wa.width - rightMin, divider));
        pair.ratio = Math.max(0.05, Math.min(0.95, divider / wa.width));
        log(`divider at ${Math.round(pair.ratio * 100)}%`);
        this._tile(pair);
    }

    _endResize() {
        if (!this._resize)
            return;
        if (this._resize.id)
            this._resize.window.disconnect(this._resize.id);
        this._resize = null;
    }
}
