/**
 * Maximize to Own Workspace.
 *
 * The rule: a workspace that holds a maximized or fullscreen window holds only
 * that window, on that monitor.
 *
 * On the primary monitor a "workspace" is a real Meta.Workspace. On secondary
 * monitors (workspaces-only-on-primary = true) every window is sticky, and
 * Workspace Islands groups them into virtual workspaces. There a "workspace" is
 * one of its groups, driven through its Registry / MonitorState API.
 *
 * How it works: every signal that could matter only schedules a sweep, which
 * runs once, before the next frame. The sweep compares each window with the
 * snapshot taken at the end of the previous sweep:
 *
 *   location changed      the window arrived somewhere (dropped in the
 *                         overview, Super+Shift+PageUp/Down, window menu, moved
 *                         to another monitor, new window). If that place now
 *                         breaks the rule, the arriving window goes to a fresh
 *                         empty workspace right after it.
 *   became max/fullscreen the window gets its own workspace. As in corgijan's
 *   (or unminimized max)  extension, the maximized window stays where it is and
 *                         the others move to a fresh workspace inserted before
 *                         it, so nothing under the user's eyes jumps.
 *   un-maximized,         if we isolated it, merge it back with the windows it
 *   minimized, closed     was split from. A workspace created for the split is
 *                         removed again once the merge empties it, like a
 *                         macOS fullscreen space.
 *
 * Fresh workspaces: with static workspaces (dynamic-workspaces=false, as
 * workspace-manage@zihan.local runs them) one is appended for every split. On
 * secondaries, workspace-manage's insertVirtualWorkspace() makes one; without
 * it, islands cannot insert and a split needs an empty virtual workspace.
 *
 * Why this cannot loop: our own moves run with _busy set (their signals are
 * ignored) and the snapshot is retaken after them, so they never show up as a
 * change. Every action either resolves a rule violation or consumes an
 * isolation record. Monitor hotplugs, and Workspace Islands' own enable /
 * reapply / settle passes, are absorbed: the snapshot is retaken, nothing acts.
 * Nothing runs while a mouse/keyboard grab (window drag) is in progress.
 *
 * Reconcile: absorbing means a change made while the layout settles is never
 * seen as one (2026-11-04: undocking put the Claude window, un-stuck by
 * no-sticky-claude, on maximized Chrome's workspace; the overlap became the
 * baseline and stayed). So once the layout has settled, and after enable()
 * (which starts a settle period of its own), the state itself is checked:
 * every place that breaks the rule is split with the same isolate/arrive
 * moves a live change would have used (_reconcile).
 *
 * Split View (split.js, SPLIT_VIEW): in the overview, a window dropped on the
 * left/right half of a full-screen space's thumbnail shares that space 50/50
 * with its window. The pair is part of the rule: a workspace holding a split
 * pair holds only that pair (holdsPlace). _act asks split.js first which
 * pairs ended (a partner closed, minimized, left, or was maximized) and has
 * the partner left behind maximized again at the end. A pair whose windows
 * stop tiling the work area (a half dragged out, resized off, Super+Down)
 * is an exit instead: split.js drops the pair and its isolation records, so
 * both stay put as normal windows on what is now an ordinary shared
 * workspace; nothing here sends the host home (it has no record left).
 *
 * Lock screen (session-modes includes unlock-dialog, 2026-11-09): the
 * extension stays enabled while locked, so its snapshot, records and pairs
 * live on and a dock/undock made while locked is settled (_collect /
 * _reconcile) together with workspace-manage's undock regroup, out of sight.
 * Window changes are not acted on while locked: the sweep keeps the pre-lock
 * snapshot and the sweep at unlock sees them as the changes they are.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WorkspaceGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {SplitView, isPaired, stampMaxOn} from './split.js';

const ISLANDS_UUID = 'workspace-islands@danielbernalo.github.io';
const MANAGE_UUID = 'workspace-manage@zihan.local';

/** Set by workspace-islands' visibility.js on windows it minimized itself. */
const ISLANDS_HIDDEN = Symbol.for('workspace-islands.hidden');

/**
 * Isolation record: { mates: Meta.Window[], created: boolean, reconciled? },
 * the windows a maximized window was split from, and whether the split made a
 * workspace. Kept on the window (like workspace-islands' own notes) so it
 * survives the disable/enable the shell does around a lock screen.
 * `reconciled`: the split was made by _reconcile from a pile-up nobody chose
 * (e.g. an undock); merging back then only ever goes to surviving mates,
 * never to the nearest unrelated workspace (_mergeTarget's fallback).
 */
const ISOLATION = Symbol.for('maximize-own-workspace.isolation');

/**
 * Tag on a Meta.Workspace (or an islands group Set) this extension created.
 * The isolation record above is lost when its window moves (monitor
 * reconnect) and is never made for a non-maximized arrival, so tagged places
 * are also swept once empty (_collect). The user's own "+" workspaces carry
 * no tag and are never touched.
 */
const MADE = Symbol.for('maximize-own-workspace.made');

/** Quiet period after the last monitor change. Longer than islands' 300 ms. */
const SETTLE_MS = 4000;

/** Also move a new non-maximized window that opens on a maximized one's workspace. */
const SPLIT_NEW_WINDOWS = true;

/**
 * Split View (split.js): drag a window onto a full-screen space's thumbnail
 * (left or right half) to share it 50/50. A workspace holding a split pair
 * holds only that pair, as a full-screen space holds only its window.
 */
const SPLIT_VIEW = true;

/**
 * Apps whose windows are overlays, never workspace members. On Wayland GNOME
 * has no layer-shell, so e.g. Vocalinux's dictation strip maps as a plain
 * NORMAL toplevel (its NOTIFICATION / skip-taskbar hints are X11-only); left
 * in scope it got split off the maximized window it was dictating into, and
 * the workspace followed it. wl-copy (which Vocalinux pastes through) maps an
 * invisible 1x1 "wl-clipboard" toplevel to get keyboard focus, since GNOME has
 * no data-control protocol; splitting that one switched the workspace right
 * before the paste. Matched against wm_class / app_id, lowercased; wl-copy sets
 * no app_id at all, only a title, so a classless window is matched by title.
 */
const EXEMPT_APPS = new Set(['vocalinux', 'wl-clipboard']);

/**
 * DING (ding@rastersoft.com) desktop windows, "Desktop Icons N": maximized,
 * NORMAL and not skip-taskbar until DING's shell code sees them map and makes
 * them DESKTOP windows. Before that they look like any maximized window, and
 * on 2026-11-11 10:50 (docking) _reconcile split them onto virtual workspaces
 * of their own; islands minimized the ones off screen before their first map,
 * so DING never placed them and the desktop icons vanished. Recognised from
 * the owning process (known at once) or DING's marker.
 */
const DING_SCRIPT = 'ding@rastersoft.com/app/ding.js';
const _dingWindows = new WeakMap();

function isDingWindow(window) {
    if (window.customJS_ding)
        return true;
    const known = _dingWindows.get(window);
    if (known !== undefined)
        return known;
    const pid = window.get_pid?.() ?? -1;
    if (!(pid > 0))
        return false; // not known yet: ask again later
    let ding = false;
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        ding = ok && new TextDecoder().decode(bytes).includes(DING_SCRIPT);
    } catch (e) {
        ding = false;
    }
    _dingWindows.set(window, ding);
    return ding;
}

function isExempt(window) {
    if (isDingWindow(window))
        return true;
    const cls = window.get_wm_class() ?? window.get_gtk_application_id();
    const key = cls ?? window.get_title() ?? '';
    return EXEMPT_APPS.has(key.toLowerCase());
}

const DEBUG = false;

function log(message) {
    if (DEBUG)
        console.log(`maximize-own-workspace: ${message}`);
}

function isMax(window) {
    return window.is_maximized() || window.is_fullscreen();
}

/** Holds its place alone: maximized/fullscreen, or half of a split pair. */
function holdsPlace(window) {
    return isMax(window) || isPaired(window);
}

/** Minimized by the user, as opposed to hidden by workspace-islands. */
function isUserMinimized(window) {
    return window.minimized && window[ISLANDS_HIDDEN] !== true;
}

function allWorkspaces() {
    const wm = global.workspace_manager;
    const list = [];
    for (let i = 0; i < wm.get_n_workspaces(); i++)
        list.push(wm.get_workspace_by_index(i));
    return list;
}

function rootOf(window) {
    let w = window;
    for (let parent = w.get_transient_for(); parent; parent = w.get_transient_for())
        w = parent;
    return w;
}

function sameLoc(a, b) {
    if (!a || !b || a.kind !== b.kind)
        return false;
    if (a.kind === 'real')
        return a.ws === b.ws && a.mon === b.mon;
    if (a.kind === 'virt') {
        // By group, not index: workspace-manage can reorder, insert and
        // remove virtual workspaces, which renumbers groups nobody moved.
        return a.conn === b.conn &&
            (a.group && b.group ? a.group === b.group : a.idx === b.idx);
    }
    return true;
}

const BUTTON_MASKS = Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK |
    Clutter.ModifierType.BUTTON4_MASK | Clutter.ModifierType.BUTTON5_MASK;

/**
 * Mutter 50 aborts the shell (clutter-sprite.c:718, the assertion in
 * clutter_sprite_notify_grab) when the stage grabs itself while a stale
 * implicit grab is held. That happens when a press starts while a Wayland
 * popup grab is up (the press's event chain is then only that grab's "input
 * only grab actor"), the client closes the popup on that press (GTK4 does),
 * which destroys the actor, and the stage is grabbed before the button comes
 * up: Main.pushModal(global.stage) from an animated workspace switch (an app
 * activating a window on another workspace) or the overview. Crashed
 * 2026-11-13 13:54 when Files opened a link in Chrome; upstream
 * mutter#5121, open. The stage-on-stage path keeps the implicit grab
 * and asserts nothing was dropped from it, and it can never contain an
 * actor that has left the stage.
 *
 * A grab on any other actor takes the other path, which cancels the
 * implicit grab cleanly. So, only for a stage grab with no grab active and a
 * button down, first grab and drop a throwaway actor. The held click is
 * cancelled, as a modal on any other actor would cancel it. Otherwise
 * nothing changes.
 */
function flushImplicitGrab(stage, grab) {
    const sink = new Clutter.Actor({name: 'maximize-own implicit-grab flush'});
    stage.insert_child_at_index(sink, 0);
    try {
        grab.call(stage, sink).dismiss();
    } finally {
        sink.destroy();
    }
}

/**
 * Islands' moveWindowTo(), minus its side effect on the app rule. Islands
 * takes every move as the user saying where the app belongs and files the
 * app's windows there from then on (indexForApp), keyed by WM class, so one
 * key for every Chrome window and PWA. Our moves say nothing of the kind;
 * they kept pointing "google-chrome" at whatever group the last split made,
 * where islands then dropped a Chrome window that re-entered the monitor
 * mid-drag (2026-11-09: Teams jumped to another page on a drag-unmaximize).
 */
function islandsMove(state, window, index) {
    const rules = state._appRules;
    const key = window.get_wm_class()?.toLowerCase() ?? null;
    const keep = rules instanceof Map && !!key;
    const had = keep && rules.has(key);
    const old = had ? rules.get(key) : undefined;
    const moved = state.moveWindowTo(window, index);
    if (keep && state._appRules === rules) {
        if (had)
            rules.set(key, old);
        else
            rules.delete(key);
    }
    return moved;
}

/** Re-entries this long after a grab ended still count as part of the drag. */
const DRAG_GRACE_MS = 1500;

/** Stable key for a real workspace; index() asserts once it is removed. */
const workspaceIds = new WeakMap();
let nextWorkspaceId = 0;

function workspaceKey(ws) {
    if (!ws)
        return -1;
    if (!workspaceIds.has(ws))
        workspaceIds.set(ws, nextWorkspaceId++);
    return workspaceIds.get(ws);
}

/** A virtual-workspace location, with the group it names right now. */
function virtLoc(loc, idx) {
    return {...loc, idx, group: loc.state._groups?.[idx] ?? null};
}

function locKey(loc) {
    if (!loc)
        return 'new';
    if (loc.kind === 'real')
        return `real:${workspaceKey(loc.ws)}:${loc.mon}`;
    if (loc.kind === 'virt')
        return `virt:${loc.conn}:${loc.idx}`;
    return 'none';
}

export default class MaximizeOwnWorkspace extends Extension {
    enable() {
        this._windowSignals = new Map();
        this._snapshot = new Map();
        this._dying = new Set();
        this._gone = [];
        this._signals = [];
        this._busy = false;
        this._grab = null; // {window, op, since} from grab-op-begin; see _grabbing
        this._dragged = null; // {window, until}: the last grab's window; _keepDragged
        this._laterId = 0;
        this._settleId = 0;
        this._layoutChanging = false;
        this._lastRegistry = null;
        this._lastPrimary = -1;
        this._split = null;
        if (SPLIT_VIEW) {
            this._split = new SplitView(this);
            this._split.enable();
        }

        this._connect(global.display, 'window-created', (_d, window) => {
            this._trackWindow(window);
            this._schedule();
        });
        this._connect(global.display, 'window-entered-monitor', (_d, _m, window) => {
            this._keepDragged(window);
            this._schedule();
        });
        this._connect(global.display, 'grab-op-begin', (_d, window, op) => {
            this._grab = {window, op, since: GLib.get_monotonic_time()};
        });
        this._connect(global.display, 'grab-op-end', (_d, window) => {
            const held = this._grab?.window ?? window;
            if (held)
                this._dragged = {window: held, until: GLib.get_monotonic_time() + DRAG_GRACE_MS * 1000};
            this._grab = null;
            this._schedule();
        });
        this._connect(global.window_manager, 'map', () => this._schedule());
        this._connect(global.backend.get_monitor_manager(), 'monitors-changing',
            () => this._layoutChanged());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._layoutChanged());
        // Leaving an emptied tagged workspace lets _collect drop it.
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._schedule());
        this._locked = Main.sessionMode.isLocked;
        this._connect(Main.sessionMode, 'updated', () => this._sessionUpdated());

        for (const actor of global.get_window_actors()) {
            if (actor.meta_window)
                this._trackWindow(actor.meta_window);
        }

        this._absorb(this._context());
        // Whatever happened while we were off (lock screen, undock with the
        // screen locked) was never seen as a change. Reconcile once the
        // layout has been quiet for SETTLE_MS; islands, enabled after us,
        // restarts that wait through its registry change.
        // Stock WorkspaceGroup._syncStacking throws "record is undefined" when a
        // window becomes eligible mid-switch (new window, move, stick/unstick,
        // or our own maximize moves during the 250 ms animation), aborting the
        // stacking loop. Same code, but skip actors that have no record yet.
        this._injections = new InjectionManager();
        this._injections.overrideMethod(WorkspaceGroup.prototype, '_syncStacking',
            () => function () {
                const windowActors = global.get_window_actors().filter(w =>
                    this._shouldShowWindow(w.meta_window));

                let lastRecord;
                const bottomActor = this._background ?? null;

                for (const windowActor of windowActors) {
                    const record = this._windowRecords.find(r => r.windowActor === windowActor);
                    if (!record)
                        continue;

                    this.set_child_above_sibling(record.clone,
                        lastRecord ? lastRecord.clone : bottomActor);
                    lastRecord = record;
                }
            });
        // Main.pushModal(global.stage) with a button down can abort the
        // shell; see flushImplicitGrab.
        this._injections.overrideMethod(Clutter.Stage.prototype, 'grab',
            grab => function (actor) {
                if (actor === this && !this.get_grab_actor() &&
                    (global.get_pointer()[2] & BUTTON_MASKS)) {
                    try {
                        flushImplicitGrab(this, grab);
                        console.log('maximize-own-workspace: stage grab with a button down, implicit grab flushed first');
                    } catch (e) {
                        console.warn(`maximize-own-workspace: implicit-grab flush failed: ${e}`);
                    }
                }
                return grab.call(this, actor);
            });

        this._layoutChanged();
        console.log('maximize-own-workspace: enabled');
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
        this._split?.disable();
        this._split = null;
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = 0;
        }

        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];

        for (const [window, ids] of this._windowSignals) {
            for (const id of ids)
                window.disconnect(id);
            // A lock screen disables us and enables us again a moment later;
            // keep the records for that. A real disable drops them.
            if (!Main.sessionMode.isLocked)
                delete window[ISOLATION];
        }
        this._windowSignals.clear();
        this._snapshot.clear();
        this._dying.clear();
        this._gone = [];
        this._grab = null;
        this._dragged = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    /**
     * A window being dragged (or just let go) entered a secondary monitor.
     * Islands files it by its app rule there (trustPlacement is off for
     * drags, the rule is not), so a drag-unmaximize whose window touched
     * another monitor for a frame (Mutter's restore rect) came back onto
     * another virtual workspace, hidden, and the view could follow it.
     * Islands' own intent is "a dragged window belongs to that monitor's
     * active virtual workspace": hold it to that, synchronously, right after
     * islands' handler (it is enabled first), so nothing leaves the pointer.
     */
    _keepDragged(window) {
        if (!window || Main.sessionMode.isLocked || this._split?.inTransit(window))
            return;
        const grabbed = this._grab?.window === window ||
            (this._dragged?.window === window && GLib.get_monotonic_time() < this._dragged.until);
        if (!grabbed)
            return;
        const ctx = this._context();
        const mon = window.get_monitor();
        if (!ctx.registry || !ctx.onlyOnPrimary || mon < 0 || mon === ctx.primary)
            return;
        const state = ctx.registry.forMonitorIndex(mon);
        const idx = state?.indexOf(window) ?? -1;
        if (idx < 0 || idx === state.activeIndex)
            return;
        log(`"${window.get_title()}" dragged onto ${state.connector}: islands filed it on virtual ` +
            `workspace ${idx + 1}; keeping it on the one in view (${state.activeIndex + 1})`);
        islandsMove(state, window, state.activeIndex);
        this._islandsChanged(ctx, `kept dragged "${window.get_title()}" in view`);
    }

    /** Lock / unlock: at unlock, act on what changed while locked. */
    _sessionUpdated() {
        const locked = Main.sessionMode.isLocked;
        if (locked === this._locked)
            return;
        this._locked = locked;
        if (locked) {
            log('screen locked: window changes wait for the unlock');
            return;
        }
        log('unlocked: catching up on window changes made while locked');
        this._split?.unlocked();
        this._schedule();
    }

    _trackWindow(window) {
        if (this._windowSignals.has(window))
            return;

        const schedule = () => this._schedule();
        const ids = [
            window.connect('workspace-changed', schedule),
            window.connect('notify::maximized-horizontally', schedule),
            window.connect('notify::maximized-vertically', () => {
                // Where Mutter took its restore rect (split.js MAX_ON).
                if (window.maximized_vertically)
                    stampMaxOn(window);
                schedule();
            }),
            window.connect('notify::fullscreen', schedule),
            window.connect('notify::minimized', schedule),
            window.connect('notify::on-all-workspaces', schedule),
            window.connect('unmanaging', () => this._onUnmanaging(window)),
            window.connect('unmanaged', () => this._onUnmanaged(window)),
        ];
        this._windowSignals.set(window, ids);
    }

    _onUnmanaging(window) {
        const iso = window[ISOLATION];
        if (iso && !this._busy) {
            const now = this._describe(window, this._context());
            if (now.eligible && now.loc.kind !== 'none')
                this._gone.push({window, loc: now.loc, iso});
        }
        this._dying.add(window);
        this._schedule();
    }

    _onUnmanaged(window) {
        const ids = this._windowSignals.get(window);
        if (ids) {
            for (const id of ids)
                window.disconnect(id);
            this._windowSignals.delete(window);
        }
        this._snapshot.delete(window);
        this._dying.delete(window);
        delete window[ISOLATION];
    }

    _layoutChanged() {
        this._layoutChanging = true;
        if (this._settleId)
            GLib.Source.remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            if (this._grabbing)
                return GLib.SOURCE_CONTINUE; // not mid-drag; ask again later
            const ctx = this._context();
            if (ctx.registry !== this._lastRegistry || ctx.primary !== this._lastPrimary) {
                // Islands or the primary changed without a sweep noticing:
                // settle again from now.
                this._absorb(ctx);
                return GLib.SOURCE_CONTINUE;
            }
            this._settleId = 0;
            this._layoutChanging = false;
            this._gone = [];
            this._busy = true;
            try {
                this._split?.validate(ctx);
                this._collect(ctx);
                this._reconcile(ctx);
            } catch (e) {
                console.error(`maximize-own-workspace: ${e}\n${e.stack}`);
            } finally {
                this._busy = false;
                this._absorb(ctx);
            }
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._settleId, '[maximize-own-workspace] monitor settle');
    }

    /**
     * Whether a window drag/resize grab is in progress. A grab-op-begin whose
     * grab-op-end never comes (2026-11-08: one right after login) used to
     * leave a plain flag stuck, which silently froze every sweep and the
     * monitor settle until the next window drag: no full-screen spaces, no
     * split view. So the recorded grab is only believed while it can still be
     * live: its window is managed, and a mouse grab still has a button held
     * (1 s grace for the press itself); a keyboard grab gets 2 minutes.
     */
    get _grabbing() {
        const g = this._grab;
        if (!g)
            return false;
        const ageMs = (GLib.get_monotonic_time() - g.since) / 1000;
        const keyboard = (g.op & 0x100) !== 0; // META_GRAB_OP_WINDOW_FLAG_KEYBOARD
        let stale = !g.window || g.window.get_compositor_private?.() === null;
        if (!stale && keyboard) {
            stale = ageMs > 120000;
        } else if (!stale && ageMs > 1000) {
            const [, , mods] = global.get_pointer();
            const buttons = Clutter.ModifierType.BUTTON1_MASK |
                Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;
            stale = (mods & buttons) === 0;
        }
        if (stale) {
            console.warn(`maximize-own-workspace: dropping a stale grab (op ${g.op}, ${Math.round(ageMs)} ms, no grab-op-end)`);
            this._grab = null;
            this._schedule();
            return false;
        }
        return true;
    }

    // ---- API for workspace-manage@zihan.local (strip.js) ---------------------

    /**
     * A workspace thumbnail dragged in the primary strip: workspace `ws`'s
     * over the thumbnail `thumb` (stock WorkspaceThumbnail). If `ws` is a
     * full-screen space and `thumb` one too that a split fits, the half under
     * the pointer is lit and returned ('left' / 'right'); else null, unlit.
     */
    thumbnailSplitHover(ws, thumb) {
        return this._split?.thumbHover(ws, thumb) ?? null;
    }

    thumbnailSplitClear() {
        this._split?.thumbClear();
    }

    /** Dropped there: true if the two spaces became a split pair (`ws` then goes). */
    thumbnailSplitDrop(ws, thumb) {
        return this._split?.thumbDrop(ws, thumb) ?? false;
    }

    /*
     * A window dragged over / dropped on a Workspace Islands thumbnail of a
     * secondary strip (workspace-manage islands.js; stock primary
     * thumbnails are patched by split.js itself). `ws` above may also be
     * {kind: 'virt', state, group} for an islands thumbnail being dragged.
     */
    windowSplitHover(thumb, window) {
        return this._split?.windowHover(thumb, window) ?? null;
    }

    windowSplitDrop(thumb, window) {
        return this._split?.windowDrop(thumb, window) ?? false;
    }

    // ---- API for dock-pull-window@zihan.local --------------------------------

    /**
     * May a dock click bring `window` (a root window, not a transient) to
     * where its monitor is looking, instead of switching to it? Answered from
     * this extension's own model, so the dock follows the same rule:
     *
     *   kind      'real' (primary workspace), 'virt' (islands group on a
     *             secondary) or 'none' (out of the model)
     *   eligible  in scope here (normal, not skip-taskbar / exempt, not sticky
     *             on the primary, tracked by islands on a secondary)
     *   holds     maximized, fullscreen or half of a split pair: it has a
     *             place of its own, so the click goes there (stock)
     *   away      not at the place its monitor shows now
     *   hereHeld  the place shown now is a full-screen space (a maximized /
     *             fullscreen window or a split pair holds it): nothing may
     *             join it, so the click switches away (stock)
     *   state     the islands MonitorState for 'virt', else null
     *
     * Only meaningful while this extension is ACTIVE (the caller checks).
     */
    pullInfo(window) {
        if (!window || !this._dying)
            return null;
        const ctx = this._context();
        const d = this._describe(window, ctx);
        let here = null;
        if (d.loc.kind === 'real')
            here = {kind: 'real', ws: global.workspace_manager.get_active_workspace(), mon: d.loc.mon};
        else if (d.loc.kind === 'virt')
            here = virtLoc(d.loc, d.loc.state.activeIndex);
        return {
            kind: d.loc.kind,
            eligible: d.eligible,
            holds: holdsPlace(window),
            away: !!here && !sameLoc(d.loc, here),
            hereHeld: !!here && this._hasMax(here, ctx),
            state: d.loc.kind === 'virt' ? d.loc.state : null,
        };
    }

    _schedule() {
        if (this._busy || this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sweep();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- model ---------------------------------------------------------------

    /** Live Workspace Islands handles, or nulls when it is not running. */
    _context() {
        let ext = null;
        let registry = null;
        try {
            const obj = Main.extensionManager.lookup(ISLANDS_UUID)?.stateObj ?? null;
            if (obj?._registry && typeof obj._registry.forMonitorIndex === 'function') {
                ext = obj;
                registry = obj._registry;
            }
        } catch (e) {
            console.warn(`maximize-own-workspace: cannot reach workspace-islands: ${e}`);
        }

        let manage = null;
        const managed = Main.extensionManager.lookup(MANAGE_UUID);
        if (managed?.state === ExtensionState.ACTIVE &&
            typeof managed.stateObj?.insertVirtualWorkspace === 'function')
            manage = managed.stateObj;

        return {
            ext,
            registry,
            manage,
            primary: global.display.get_primary_monitor(),
            onlyOnPrimary: Meta.prefs_get_workspaces_only_on_primary(),
        };
    }

    _windows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(w => w && !this._dying.has(w));
    }

    /**
     * Where a window is, in the model it belongs to, and whether the rule
     * applies to it at all.
     */
    _describe(window, ctx) {
        const mon = window.get_monitor();
        const basic = window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.get_transient_for() &&
            !window.is_skip_taskbar() &&
            !isExempt(window) &&
            !this._dying.has(window);
        const virtual = ctx.onlyOnPrimary && mon !== ctx.primary;

        let loc;
        let eligible;
        if (!virtual) {
            const ws = window.get_workspace();
            // Sticky on the primary means the user asked for it (or it is a
            // desktop/dock): out of scope.
            eligible = basic && !window.is_on_all_workspaces() && !!ws;
            loc = {kind: 'real', ws, mon};
        } else {
            const state = mon >= 0 ? ctx.registry?.forMonitorIndex(mon) ?? null : null;
            const idx = state ? state.indexOf(window) : -1;
            // Sticky here is by design; islands' membership is what counts.
            eligible = basic && idx >= 0;
            loc = idx >= 0
                ? {kind: 'virt', state, conn: state.connector, idx, mon, group: state._groups?.[idx]}
                : {kind: 'none'};
        }

        return {
            loc,
            eligible,
            max: isMax(window),
            // On the primary islands parks nothing: a window minimized there
            // is out of sight however it got minimized (an islands-parked one
            // after an undock is about to be shown by workspace-manage), and
            // gets no workspace of its own while it is (2026-11-06: undocked
            // parked windows were split to fresh workspaces that looked empty).
            userMin: virtual ? isUserMinimized(window) : window.minimized,
            mapped: window.mapped,
        };
    }

    /** Eligible windows at a place. Minimized ones only if asked for. */
    _members(loc, ctx, {includeMinimized = false} = {}) {
        let windows;
        if (loc.kind === 'real')
            windows = loc.ws.list_windows().filter(w => w.get_monitor() === loc.mon);
        else if (loc.kind === 'virt')
            windows = loc.state.windowsOn(loc.idx);
        else
            return [];

        return windows.filter(w => {
            if (this._dying.has(w))
                return false;
            const d = this._describe(w, ctx);
            return d.eligible && sameLoc(d.loc, loc) && (includeMinimized || !d.userMin);
        });
    }

    /**
     * Everything that should leave a place along with its regular windows:
     * any type, minimized or not, except sticky windows and transients (Mutter
     * moves those with their parent).
     */
    _movable(loc, except) {
        let windows;
        if (loc.kind === 'real') {
            windows = loc.ws.list_windows().filter(w =>
                w.get_monitor() === loc.mon && !w.is_on_all_workspaces() &&
                !w.get_transient_for());
        } else if (loc.kind === 'virt') {
            // Islands tracks dialogs as members too; keep each with its root.
            windows = loc.state.windowsOn(loc.idx);
        } else {
            return [];
        }
        return windows.filter(w => !this._dying.has(w) &&
            (!except || rootOf(w) !== except));
    }

    _hasMax(loc, ctx, except) {
        return this._members(loc, ctx).some(w => w !== except && holdsPlace(w));
    }

    _isActive(loc) {
        if (loc.kind === 'real')
            return loc.ws === global.workspace_manager.get_active_workspace();
        if (loc.kind === 'virt')
            return loc.idx === loc.state.activeIndex;
        return false;
    }

    _absorb(ctx) {
        this._snapshot.clear();
        for (const window of this._windows()) {
            const d = this._describe(window, ctx);
            // A window that is not on screen yet is "new" until it is.
            if (d.mapped)
                this._snapshot.set(window, d);
        }
        this._lastRegistry = ctx.registry;
        this._lastPrimary = ctx.primary;
    }

    // ---- sweep ---------------------------------------------------------------

    _sweep() {
        if (this._grabbing)
            return; // grab-op-end schedules another one

        const ctx = this._context();
        const modelChanged = ctx.registry !== this._lastRegistry ||
            ctx.primary !== this._lastPrimary;

        if (this._layoutChanging || this._settleId || modelChanged) {
            log(modelChanged ? 'islands/primary changed, absorbing' : 'layout settling, absorbing');
            this._gone = [];
            this._absorb(ctx);
            if (modelChanged)
                this._layoutChanged();
            return;
        }

        // Locked: nobody chose these window changes on screen. Keep the old
        // snapshot (no absorb), so the sweep _sessionUpdated() runs at
        // unlock sees them; a monitor change still settles above.
        if (Main.sessionMode.isLocked)
            return;

        this._busy = true;
        try {
            this._act(ctx);
            this._collect(ctx);
        } catch (e) {
            console.error(`maximize-own-workspace: ${e}\n${e.stack}`);
        } finally {
            this._busy = false;
            this._absorb(ctx);
        }
    }

    _act(ctx) {
        // Split pairs that no longer hold end first; the partner left behind
        // becomes a full-screen space again after the moves below.
        const regrow = this._split?.check(ctx) ?? [];

        const gone = this._gone;
        this._gone = [];
        for (const g of gone)
            this._mergeGone(g, ctx);

        const merges = [];
        const isolations = [];
        const arrivals = new Map();
        const arrive = (window, originKey, loc) => {
            const key = `${originKey}->${locKey(loc)}`;
            if (!arrivals.has(key))
                arrivals.set(key, {loc, windows: []});
            arrivals.get(key).windows.push(window);
        };

        for (const window of this._windows()) {
            // Split View is moving it (from a secondary monitor, or back to
            // its half): its arrival is split.js's, not a rule's.
            if (this._split?.inTransit(window))
                continue;
            const now = this._describe(window, ctx);
            const prev = this._snapshot.get(window);

            if (!now.eligible || now.loc.kind === 'none') {
                // Out of scope (sticky, not tracked by islands, ...). If it was
                // isolated, that record no longer means anything.
                if (prev && !sameLoc(prev.loc, now.loc))
                    delete window[ISOLATION];
                continue;
            }

            if (!prev) {
                if (!now.mapped || now.userMin)
                    continue;
                if (now.max)
                    isolations.push(window);
                else if (SPLIT_NEW_WINDOWS)
                    arrive(window, 'new', now.loc);
                continue;
            }

            if (!prev.eligible) {
                // Came into scope where it stands (e.g. un-stuck onto the
                // current workspace): that is an arrival too.
                if (!now.userMin)
                    arrive(window, 'eligible', now.loc);
                continue;
            }

            if (!sameLoc(prev.loc, now.loc)) {
                // Moved by the user: whatever it was split from no longer
                // applies. A split below may record a new one.
                delete window[ISOLATION];
                if (!now.userMin)
                    arrive(window, locKey(prev.loc), now.loc);
                continue;
            }

            const iso = window[ISOLATION];
            if (iso && prev.max && !now.max) {
                merges.push([window, 'unmaximized']);
                continue;
            }
            if (iso && !prev.userMin && now.userMin) {
                merges.push([window, 'minimized']);
                continue;
            }
            if (now.userMin)
                continue;
            if (now.max && (!prev.max || prev.userMin)) {
                isolations.push(window);
                continue;
            }
            if (prev.userMin)
                arrive(window, `unminimized:${locKey(now.loc)}`, now.loc);
        }

        for (const [window, why] of merges)
            this._merge(window, why, ctx);
        for (const group of arrivals.values())
            this._arrive(group, ctx);
        for (const window of isolations)
            this._isolate(window, ctx);
        this._split?.finish(regrow, ctx);
    }

    // ---- reconcile -----------------------------------------------------------

    /**
     * Split every place that breaks the rule as it stands: 2+ maximized
     * windows, or a maximized one plus others. Run once the layout has
     * settled, where the diff in _act() cannot see what changed. "Members"
     * are what _act() counts too, so EXEMPT_APPS, transients, skip-taskbar,
     * user-minimized and (on the primary) sticky windows never trigger it.
     *
     * One window per place stays (_keeper). If it is maximized, the rest
     * leave as when it is maximized (_isolate: fresh place before it, MADE,
     * isolation record on the keeper). If it is a normal window, each
     * maximized one leaves as an arrival would (_arrive: fresh place after,
     * record on the window that left). A place made here can itself break
     * the rule (two maximized windows moved out together), so repeat until
     * nothing changes; every pass either resolves a place or moves nothing.
     */
    _reconcile(ctx) {
        const passes = this._windows().length + 1;
        for (let pass = 0; pass < passes; pass++) {
            const before = this._layoutKey(ctx);
            for (const loc of this._violations(ctx)) {
                const members = this._members(loc, ctx);
                if (members.some(isPaired)) {
                    // A split pair keeps its place; anyone else leaves.
                    for (const window of members.filter(w => !isPaired(w))) {
                        log(`reconcile: "${window.get_title()}" shares a split pair's workspace`);
                        const d = this._describe(window, ctx);
                        if (d.eligible && sameLoc(d.loc, loc))
                            this._arrive({loc: d.loc, windows: [window]}, ctx, {reconciled: true});
                    }
                    continue;
                }
                if (members.length < 2 || !members.some(isMax))
                    continue; // resolved by an earlier move this pass
                const keeper = this._keeper(members, loc);
                const where = loc.kind === 'real'
                    ? `workspace ${loc.ws.index() + 1}`
                    : `virtual workspace ${loc.idx + 1} on ${loc.state.connector}`;
                log(`reconcile: ${members.length} windows share ${where} ` +
                    `with a maximized one; keeping "${keeper.get_title()}"`);
                if (isMax(keeper)) {
                    this._isolate(keeper, ctx, {reconciled: true});
                } else {
                    const leaving = members.filter(w => isMax(w));
                    for (const window of leaving) {
                        const d = this._describe(window, ctx);
                        if (d.eligible && sameLoc(d.loc, loc))
                            this._arrive({loc: d.loc, windows: [window]}, ctx, {reconciled: true});
                    }
                }
            }
            if (this._layoutKey(ctx) === before)
                return;
        }
    }

    /** Places breaking the rule, one entry each. */
    _violations(ctx) {
        const places = new Map();
        const moving = w => this._split?.inTransit(w) ?? false;
        for (const window of this._windows()) {
            if (moving(window))
                continue;
            const d = this._describe(window, ctx);
            if (!d.eligible || d.userMin || d.loc.kind === 'none')
                continue;
            const key = locKey(d.loc);
            if (!places.has(key))
                places.set(key, d.loc);
        }
        return [...places.values()].filter(loc => {
            const members = this._members(loc, ctx);
            if (members.some(moving))
                return false; // Split View is mid-move there; not a pile-up

            if (members.some(isPaired))
                return members.some(w => !isPaired(w));
            return members.length > 1 && members.some(isMax);
        });
    }

    /**
     * Which window keeps a place: the focused one (or the one owning the
     * focused dialog), else the most recently used maximized one, by the
     * workspace's MRU list (Alt+Tab's order; the active workspace's for a
     * virtual place, whose windows are on all of them). Ties and windows
     * missing from that list go by user time, then the older window, so the
     * choice is stable across passes.
     */
    _keeper(members, loc) {
        const focus = global.display.focus_window;
        const focused = focus ? rootOf(focus) : null;
        if (focused && members.includes(focused))
            return focused;

        let mru = [];
        try {
            const ws = loc.kind === 'real' ? loc.ws : global.workspace_manager.get_active_workspace();
            mru = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, ws);
        } catch (e) {
            console.warn(`maximize-own-workspace: no MRU list: ${e}`);
        }
        const rank = w => {
            const i = mru.indexOf(w);
            return i < 0 ? mru.length : i;
        };
        return members.filter(isMax).sort((a, b) =>
            rank(a) - rank(b) ||
            (b.get_user_time() >>> 0) - (a.get_user_time() >>> 0) ||
            a.get_stable_sequence() - b.get_stable_sequence())[0];
    }

    /** Where every in-scope window is; equal before/after = nothing moved. */
    _layoutKey(ctx) {
        return this._windows()
            .map(w => `${w.get_stable_sequence()}@${locKey(this._describe(w, ctx).loc)}`)
            .sort()
            .join(' ');
    }

    // ---- actions -------------------------------------------------------------

    /**
     * Windows arrived at a place together. If that place now breaks the rule,
     * they move on to a fresh workspace right after it.
     */
    _arrive({loc, windows}, ctx, extra = {}) {
        const group = windows.filter(w => {
            const d = this._describe(w, ctx);
            return d.eligible && !d.userMin && sameLoc(d.loc, loc);
        });
        if (group.length === 0)
            return;

        const present = this._members(loc, ctx);
        const residents = present.filter(w => !group.includes(w));
        if (residents.length === 0 || !present.some(holdsPlace))
            return;

        const focus = global.display.focus_window;
        const focused = group.find(w => w === focus) ?? null;
        // Never switch/focus behind the lock screen (a locked settle's reconcile).
        const follow = !!focused && !Main.overview.visible &&
            !Main.sessionMode.isLocked && this._isActive(loc);

        let moved = null;
        if (loc.kind === 'real') {
            const [fresh, created] = this._freshWorkspace(loc.ws, 'after');
            if (!fresh)
                return;
            for (const w of group)
                w.change_workspace(fresh);
            this._split?.relocated(group, {kind: 'real', ws: fresh, mon: loc.mon});
            if (follow)
                fresh.activate_with_focus(focused, global.get_current_time());
            moved = {created};
            log(`split ${group.length} arriving window(s) to workspace ${fresh.index()}`);
        } else {
            moved = this._moveToEmptyGroup(group, loc, ctx, {follow, focused, where: 'after'});
        }

        if (moved && group.length === 1 && isMax(group[0]))
            group[0][ISOLATION] = {mates: residents, created: moved.created, ...extra};
    }

    /**
     * A window became maximized/fullscreen (or came back from minimized that
     * way) where other windows are. It stays put; they leave.
     */
    _isolate(window, ctx, extra = {}) {
        const d = this._describe(window, ctx);
        if (!d.eligible || d.userMin || !d.max || d.loc.kind === 'none')
            return;

        const present = this._members(d.loc, ctx);
        if (!present.some(w => w !== window))
            return;

        const others = this._movable(d.loc, window);
        if (others.length === 0)
            return;
        const mates = present.filter(w => w !== window);

        let created;
        if (d.loc.kind === 'real') {
            const [fresh, made] = this._freshWorkspace(d.loc.ws, 'before');
            if (!fresh)
                return;
            for (const w of others)
                w.change_workspace(fresh);
            created = made;
            log(`isolated "${window.get_title()}" on workspace ${d.loc.ws.index()}`);
        } else {
            const moved = this._moveToEmptyGroup(others, d.loc, ctx, {where: 'before'});
            if (!moved)
                return;
            created = moved.created;
        }

        // A record it already holds (still maximized, split again by a
        // reconcile) keeps its mates: un-maximizing should find either set.
        const old = window[ISOLATION];
        window[ISOLATION] = old
            ? {...old, mates: [...new Set([...old.mates, ...mates])], created: old.created || created}
            : {mates, created, ...extra};
    }

    /** An isolated window was un-maximized or minimized: rejoin its mates. */
    _merge(window, why, ctx) {
        const iso = window[ISOLATION];
        delete window[ISOLATION];

        const d = this._describe(window, ctx);
        if (!d.eligible || d.loc.kind === 'none')
            return;
        if (this._members(d.loc, ctx).some(w => w !== window))
            return; // not alone any more: nothing to merge

        const target = this._mergeTarget(window, d.loc, iso, ctx);
        if (!target)
            return;

        log(`merging "${window.get_title()}" back (${why})`);
        let emptied = d.loc;
        if (this._isActive(d.loc)) {
            // The window stays where the user is looking; its mates come to it.
            this._bringTo(d.loc, target, window);
            emptied = target;
        } else if (d.loc.kind === 'real') {
            window.change_workspace(target.ws);
        } else {
            islandsMove(d.loc.state, window, target.idx);
            this._islandsChanged(ctx, `merged "${window.get_title()}"`);
        }
        if (iso?.created)
            this._dropIfEmpty(emptied, ctx);
    }

    /** An isolated window closed while the user was looking at it. */
    _mergeGone({window, loc, iso}, ctx) {
        if (loc.kind === 'real') {
            if (!allWorkspaces().includes(loc.ws))
                return;
        } else {
            const state = ctx.registry?.forConnector(loc.conn) ?? null;
            const idx = state && loc.group ? state._groups?.indexOf(loc.group) ?? -1 : loc.idx;
            if (!state || idx < 0 || idx >= state.size)
                return;
            loc = virtLoc({...loc, state}, idx);
        }

        if (this._members(loc, ctx).some(w => w !== window))
            return;

        // Closed while the user was elsewhere, or with nothing left to go back
        // to: only the workspace the split made has to go.
        const target = this._isActive(loc) ? this._mergeTarget(window, loc, iso, ctx) : null;
        if (!target) {
            if (iso?.created)
                this._dropIfEmpty(loc, ctx);
            return;
        }

        log(`"${window.get_title()}" closed, returning to its mates`);
        let emptied = loc;
        if (loc.kind === 'real') {
            this._bringTo(loc, target, window);
            emptied = target;
        } else if (typeof ctx.ext?._commitSwitch === 'function') {
            ctx.ext._commitSwitch(loc.state, target.idx, {announce: false});
        } else {
            loc.state.switchTo(target.idx);
        }
        if (iso?.created)
            this._dropIfEmpty(emptied, ctx);
    }

    /**
     * Where an isolated window belongs: wherever most of its surviving mates
     * are now, unless that place holds a maximized window of its own; else
     * the nearest occupied place on the same monitor without one.
     */
    _mergeTarget(window, loc, iso, ctx) {
        const alive = new Set(this._windows());
        const counts = new Map();
        for (const mate of iso?.mates ?? []) {
            if (mate === window || !alive.has(mate))
                continue;
            const d = this._describe(mate, ctx);
            if (!d.eligible || d.loc.kind !== loc.kind || sameLoc(d.loc, loc))
                continue;
            if (loc.kind === 'real' && d.loc.mon !== loc.mon)
                continue;
            if (loc.kind === 'virt' && d.loc.conn !== loc.conn)
                continue;
            const key = locKey(d.loc);
            const entry = counts.get(key) ?? {loc: d.loc, n: 0};
            entry.n++;
            counts.set(key, entry);
        }

        // Most mates first; a place holding a maximized window of its own is
        // skipped for the next one (a reconcile's mates can be split up).
        const best = [...counts.values()].sort((a, b) => b.n - a.n)
            .find(entry => !this._hasMax(entry.loc, ctx, window));
        if (best)
            return best.loc;
        if (iso?.reconciled)
            return null; // see ISOLATION: never pull in an unrelated workspace

        // corgijan's fallback: the closest occupied workspace, lower first.
        const candidates = [];
        if (loc.kind === 'real') {
            const wm = global.workspace_manager;
            const here = loc.ws.index();
            for (let i = here - 1; i >= 0; i--)
                candidates.push({kind: 'real', ws: wm.get_workspace_by_index(i), mon: loc.mon});
            for (let i = here + 1; i < wm.get_n_workspaces(); i++)
                candidates.push({kind: 'real', ws: wm.get_workspace_by_index(i), mon: loc.mon});
        } else {
            for (let i = loc.idx - 1; i >= 0; i--)
                candidates.push(virtLoc(loc, i));
            for (let i = loc.idx + 1; i < loc.state.size; i++)
                candidates.push(virtLoc(loc, i));
        }
        return candidates.find(c =>
            this._members(c, ctx, {includeMinimized: true}).length > 0 &&
            !this._hasMax(c, ctx, window)) ?? null;
    }

    /** Pull everything at `from` into `to` (the active place). */
    _bringTo(to, from, except) {
        const windows = this._movable(from).filter(w => w !== except);
        if (to.kind === 'real') {
            // corgijan's trick: the active workspace takes the target's place
            // in the list, so the view does not move and the target, emptied,
            // is dropped by dynamic workspaces.
            const wm = global.workspace_manager;
            let index = from.ws.index();
            if (to.ws.index() < index)
                index -= 1;
            if (to.ws.index() !== index)
                wm.reorder_workspace(to.ws, index);
            for (const w of windows)
                w.change_workspace(to.ws);
        } else {
            for (const w of windows)
                islandsMove(to.state, w, to.idx);
            this._islandsChanged(this._context(), `merged into virtual workspace ${to.idx + 1}`);
        }
    }

    /**
     * An empty real workspace placed right before/after `ws`, and whether it
     * was made for this. Static workspaces are the user's own (that is how
     * workspace-manage runs them), so one is always appended and dropped
     * again on merge, like a macOS fullscreen space. With dynamic workspaces
     * the trailing empty one is used, else a new one; GNOME removes it.
     */
    _freshWorkspace(ws, where) {
        const wm = global.workspace_manager;
        const isEmpty = candidate => candidate !== ws && candidate.list_windows()
            .every(w => w.is_on_all_workspaces() || this._dying.has(w));

        const n = wm.get_n_workspaces();
        const last = wm.get_workspace_by_index(n - 1);
        const dynamic = Meta.prefs_get_dynamic_workspaces();
        const fresh = dynamic && isEmpty(last)
            ? last
            : wm.append_new_workspace(false, global.get_current_time());
        if (!fresh) {
            log('no empty workspace available');
            return [null, false];
        }
        if (!dynamic)
            fresh[MADE] = true;

        let index = where === 'after' ? ws.index() + 1 : ws.index();
        if (fresh.index() < ws.index())
            index -= 1;
        if (fresh.index() !== index)
            wm.reorder_workspace(fresh, index);
        return [fresh, !dynamic];
    }

    /**
     * Move windows to a fresh virtual workspace inserted right before/after
     * `loc` (workspace-manage). Without workspace-manage islands cannot
     * insert: then the first empty one after `loc` (wrapping), and a full
     * monitor means no split. Returns {created}, or null when nothing moved.
     */
    _moveToEmptyGroup(windows, loc, ctx, {follow = false, focused = null, where = 'after'}) {
        const state = loc.state;
        let target = ctx.manage?.insertVirtualWorkspace(
            state, where === 'before' ? loc.idx : loc.idx + 1) ?? -1;
        const created = target >= 0;
        if (created && state._groups?.[target])
            state._groups[target][MADE] = true;
        for (let k = 1; !created && k < state.size; k++) {
            const j = (loc.idx + k) % state.size;
            if (state.windowsOn(j).every(w => this._dying.has(w))) {
                target = j;
                break;
            }
        }
        if (target < 0) {
            console.log(`maximize-own-workspace: no empty virtual workspace on ${state.connector}; ` +
                'leaving windows where they are');
            return null;
        }

        if (follow) {
            for (const w of windows) {
                const actor = w.get_compositor_private();
                if (actor)
                    Main.wm.skipNextEffect(actor);
            }
        }

        for (const w of windows) {
            islandsMove(state, w, target);
            // Dynamic mode can renumber groups after a move; follow the window.
            target = state.indexOf(w);
        }
        if (target >= 0)
            this._split?.relocated(windows, virtLoc(loc, target));

        if (follow && typeof ctx.ext?._commitSwitch === 'function') {
            ctx.ext._commitSwitch(state, target, {announce: false});
            focused.focus(global.get_current_time());
        } else {
            this._islandsChanged(ctx, `split ${windows.length} window(s) to virtual workspace ${target + 1}`);
        }
        log(`moved ${windows.length} window(s) to virtual workspace ${target + 1} on ${state.connector}`);
        return {created};
    }

    /**
     * A workspace a split created, now emptied by the merge: remove it. With
     * dynamic workspaces GNOME does that itself.
     */
    _dropIfEmpty(loc, ctx) {
        if (loc.kind === 'real') {
            const wm = global.workspace_manager;
            if (Meta.prefs_get_dynamic_workspaces() || wm.get_n_workspaces() <= 1 ||
                !allWorkspaces().includes(loc.ws))
                return;
            if (!loc.ws.list_windows().every(w => w.is_on_all_workspaces() || this._dying.has(w)))
                return;
            const time = global.get_current_time();
            if (loc.ws.active) {
                const index = loc.ws.index();
                wm.get_workspace_by_index(index > 0 ? index - 1 : index + 1).activate(time);
            }
            log(`removing workspace ${loc.ws.index() + 1}, made for a split`);
            wm.remove_workspace(loc.ws, time);
        } else if (loc.kind === 'virt' && ctx.manage) {
            const idx = loc.group ? loc.state._groups?.indexOf(loc.group) ?? -1 : loc.idx;
            if (idx < 0 || loc.state.windowsOn(idx).some(w => !this._dying.has(w)))
                return;
            log(`removing virtual workspace ${idx + 1} on ${loc.state.connector}, made for a split`);
            ctx.manage.removeVirtualWorkspace(loc.state, idx);
        }
    }

    /**
     * Drop every place this extension created that is now empty, except the
     * one being looked at (it goes once the user leaves it).
     */
    _collect(ctx) {
        const wm = global.workspace_manager;
        const vacant = ws => ws.list_windows()
            .every(w => w.is_on_all_workspaces() || this._dying.has(w));
        if (!Meta.prefs_get_dynamic_workspaces()) {
            for (const ws of allWorkspaces().reverse()) {
                if (!ws[MADE] || ws.active || wm.get_n_workspaces() <= 1 || !vacant(ws))
                    continue;
                log(`collecting empty workspace ${ws.index() + 1}, made for a split`);
                wm.remove_workspace(ws, global.get_current_time());
            }
        }

        if (!ctx.registry || !ctx.manage)
            return;
        for (let mon = 0; mon < global.display.get_n_monitors(); mon++) {
            const state = ctx.registry.forMonitorIndex(mon);
            if (!state?._groups)
                continue;
            for (let i = state.size - 1; i >= 0; i--) {
                if (!state._groups[i]?.[MADE] || i === state.activeIndex || state.size <= 1)
                    continue;
                if (state.windowsOn(i).some(w => !this._dying.has(w)))
                    continue;
                log(`collecting empty virtual workspace ${i + 1} on ${state.connector}, made for a split`);
                ctx.manage.removeVirtualWorkspace(state, i);
            }
        }
    }

    /** Let islands persist and redraw its indicator, as its own moves do. */
    _islandsChanged(ctx, message) {
        try {
            ctx.ext?._afterChange?.(`maximize-own-workspace: ${message}`);
        } catch (e) {
            console.warn(`maximize-own-workspace: islands _afterChange failed: ${e}`);
        }
    }
}
