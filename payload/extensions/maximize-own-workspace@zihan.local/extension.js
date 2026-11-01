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
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const ISLANDS_UUID = 'workspace-islands@danielbernalo.github.io';
const MANAGE_UUID = 'workspace-manage@zihan.local';

/** Set by workspace-islands' visibility.js on windows it minimized itself. */
const ISLANDS_HIDDEN = Symbol.for('workspace-islands.hidden');

/**
 * Isolation record: { mates: Meta.Window[], created: boolean }, the windows a
 * maximized window was split from, and whether the split made a workspace. Kept on the window (like workspace-islands' own notes) so it
 * survives the disable/enable the shell does around a lock screen.
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

function isExempt(window) {
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
        this._grabbing = false;
        this._laterId = 0;
        this._settleId = 0;
        this._layoutChanging = false;
        this._lastRegistry = null;
        this._lastPrimary = -1;

        this._connect(global.display, 'window-created', (_d, window) => {
            this._trackWindow(window);
            this._schedule();
        });
        this._connect(global.display, 'window-entered-monitor', () => this._schedule());
        this._connect(global.display, 'grab-op-begin', () => {
            this._grabbing = true;
        });
        this._connect(global.display, 'grab-op-end', () => {
            this._grabbing = false;
            this._schedule();
        });
        this._connect(global.window_manager, 'map', () => this._schedule());
        this._connect(global.backend.get_monitor_manager(), 'monitors-changing',
            () => this._layoutChanged());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._layoutChanged());
        // Leaving an emptied tagged workspace lets _collect drop it.
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._schedule());

        for (const actor of global.get_window_actors()) {
            if (actor.meta_window)
                this._trackWindow(actor.meta_window);
        }

        this._absorb(this._context());
        console.log('maximize-own-workspace: enabled');
    }

    disable() {
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
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _trackWindow(window) {
        if (this._windowSignals.has(window))
            return;

        const schedule = () => this._schedule();
        const ids = [
            window.connect('workspace-changed', schedule),
            window.connect('notify::maximized-horizontally', schedule),
            window.connect('notify::maximized-vertically', schedule),
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
            this._settleId = 0;
            this._layoutChanging = false;
            const ctx = this._context();
            this._absorb(ctx);
            this._busy = true;
            try {
                this._collect(ctx);
            } catch (e) {
                console.error(`maximize-own-workspace: ${e}\n${e.stack}`);
            } finally {
                this._busy = false;
            }
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._settleId, '[maximize-own-workspace] monitor settle');
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
            userMin: isUserMinimized(window),
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
        return this._members(loc, ctx).some(w => w !== except && isMax(w));
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
    }

    // ---- actions -------------------------------------------------------------

    /**
     * Windows arrived at a place together. If that place now breaks the rule,
     * they move on to a fresh workspace right after it.
     */
    _arrive({loc, windows}, ctx) {
        const group = windows.filter(w => {
            const d = this._describe(w, ctx);
            return d.eligible && !d.userMin && sameLoc(d.loc, loc);
        });
        if (group.length === 0)
            return;

        const present = this._members(loc, ctx);
        const residents = present.filter(w => !group.includes(w));
        if (residents.length === 0 || !present.some(isMax))
            return;

        const focus = global.display.focus_window;
        const focused = group.find(w => w === focus) ?? null;
        const follow = !!focused && !Main.overview.visible && this._isActive(loc);

        let moved = null;
        if (loc.kind === 'real') {
            const [fresh, created] = this._freshWorkspace(loc.ws, 'after');
            if (!fresh)
                return;
            for (const w of group)
                w.change_workspace(fresh);
            if (follow)
                fresh.activate_with_focus(focused, global.get_current_time());
            moved = {created};
            log(`split ${group.length} arriving window(s) to workspace ${fresh.index()}`);
        } else {
            moved = this._moveToEmptyGroup(group, loc, ctx, {follow, focused, where: 'after'});
        }

        if (moved && group.length === 1 && isMax(group[0]))
            group[0][ISOLATION] = {mates: residents, created: moved.created};
    }

    /**
     * A window became maximized/fullscreen (or came back from minimized that
     * way) where other windows are. It stays put; they leave.
     */
    _isolate(window, ctx) {
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

        window[ISOLATION] = {mates, created};
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
            d.loc.state.moveWindowTo(window, target.idx);
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

        const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
        if (best && !this._hasMax(best.loc, ctx, window))
            return best.loc;

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
                to.state.moveWindowTo(w, to.idx);
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
            state.moveWindowTo(w, target);
            // Dynamic mode can renumber groups after a move; follow the window.
            target = state.indexOf(w);
        }

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
