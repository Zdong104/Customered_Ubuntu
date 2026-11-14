/**
 * Moving a whole workspace to another monitor: Mission Control's drag of a
 * space from one display's strip into another's.
 *
 * The workspace arrives as a new one at the drop position and becomes the
 * target monitor's active workspace. The source monitor loses it, unless it
 * was that monitor's only one: then an empty one stays. Windows keep their
 * maximized/fullscreen state; Mutter re-fits them to the new monitor.
 *
 * Three ways, because the two kinds of monitor keep workspaces differently:
 *
 *   primary -> secondary   a real Meta.Workspace's windows move to the
 *                          monitor (Mutter makes them sticky there, as it does
 *                          every window off the primary) into a new virtual
 *                          group (islands.js land()).
 *   secondary -> primary   a virtual group's windows are un-parked (islands
 *                          minimizes inactive ones), leave islands' care, and
 *                          land on a new real workspace, made active first so
 *                          Mutter un-sticks them right onto it.
 *   secondary -> secondary   group to group, the first half of each above.
 *
 * Order matters for the eye and for maximize-own-workspace: the target place
 * is made and activated before any window moves, so its sweep sees the
 * windows arriving together in an empty place and leaves them be. A window
 * whose size changes with the move (maximized, onto a work area of another
 * size) changes monitor only when its client acknowledges the new size, a
 * few frames later; so the place it leaves is removed only once it is empty
 * (primary), or the window is dropped from it at once (virtual: islands only
 * learns of the move when it happens), and its arrival is still expected
 * (islands.js land()). Its MADE
 * tag (a workspace it created for a split) moves with the workspace, so the
 * new place is still swept away once emptied; a window's isolation record is
 * dropped by that extension itself, since the window moved.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MAX_WORKSPACES, isValidMonitor} from './primary.js';

/** maximize-own-workspace's tag on places it created; see the header. */
const MADE = Symbol.for('maximize-own-workspace.made');

/** How long a moved-from primary workspace waits for its windows to leave. */
const VACATE_MS = 5000;

export class CrossMonitorMove {
    constructor(primary, islands, log) {
        this._primary = primary;
        this._islands = islands;
        this._log = log;
        this._timeouts = new Set();
    }

    destroy() {
        for (const id of this._timeouts)
            GLib.Source.remove(id);
        this._timeouts.clear();
    }

    /**
     * Move workspace `from` of the source strip to position `index` (0..n) of
     * the target strip. Returns {sourceRemoved}, or null if nothing moved.
     */
    move(sourceAdapter, from, targetAdapter, index) {
        const source = sourceAdapter.place;
        const target = targetAdapter.place;
        if (!source || !target || !targetAdapter.canTake?.())
            return null;
        if (source.kind === 'primary' && target.kind === 'primary')
            return null;
        if (source.kind === 'virtual' && target.kind === 'virtual' &&
            source.state === target.state)
            return null;
        if (target.kind === 'virtual' || source.kind === 'virtual') {
            if (!this._islands?.ready)
                return null;
        }

        const taken = this._take(source, from);
        if (!taken)
            return null;

        const focus = global.display.focus_window;
        const arrived = target.kind === 'primary'
            ? this._toPrimary(taken, index)
            : this._toVirtual(taken, target.state, index);
        if (!arrived)
            return null;

        const sourceRemoved = this._release(taken);
        // Removing the source's active workspace activates a neighbour, and
        // that focuses a window there; the focus belongs with what moved.
        if (focus && taken.windows.includes(focus))
            focus.focus(global.get_current_time());

        this._log(`moved ${describe(source, from)} (${taken.windows.length} window(s)) ` +
            `to ${arrived}${sourceRemoved ? '' : '; source kept empty'}`);
        return {sourceRemoved};
    }

    // ---- source ----------------------------------------------------------------

    /** What moves: the windows, and where they come from. Null if invalid. */
    _take(source, from) {
        if (source.kind === 'primary') {
            const wm = global.workspace_manager;
            if (from < 0 || from >= wm.n_workspaces)
                return null;
            const ws = wm.get_workspace_by_index(from);
            const windows = ws.list_windows().filter(w => !w.is_on_all_workspaces());
            return {kind: 'primary', ws, windows: rootsFirst(windows), made: !!ws[MADE]};
        }

        const state = source.state;
        if (from < 0 || from >= state.size)
            return null;
        const group = state._groups[from];
        return {kind: 'virtual', state, group, windows: rootsFirst([...group]), made: !!group[MADE]};
    }

    /**
     * Take the moved workspace off the source monitor. Returns true if it was
     * removed, false if it stays as that monitor's (now empty) only one.
     */
    _release(taken) {
        if (taken.kind === 'primary') {
            const wm = global.workspace_manager;
            if (!hasWorkspace(taken.ws))
                return true;
            if (wm.n_workspaces <= 1)
                return false;
            this._leave(taken.ws);
            this._removeWhenVacated(taken.ws);
            return true;
        }

        const {state, group} = taken;
        // Islands drops a window from its group when it leaves the monitor;
        // anything it has not let go of yet would be merged into a neighbour.
        for (const window of taken.windows) {
            if (group.has(window))
                group.delete(window);
        }
        const index = state._groups.indexOf(group);
        if (index < 0)
            return true;
        if (state.size > 1 && this._islands.remove(state, index))
            return true;
        this._islands.changed(state, `virtual workspace ${index + 1} emptied`);
        return false;
    }

    /** If `ws` is the active workspace, activate a neighbour instead. */
    _leave(ws) {
        if (!ws.active)
            return;
        const wm = global.workspace_manager;
        const index = ws.index();
        wm.get_workspace_by_index(index > 0 ? index - 1 : index + 1)
            .activate(global.get_current_time());
    }

    /**
     * Remove a primary workspace once its windows are gone. Not at once: a
     * window whose size changes with the move (a maximized one, for a work
     * area of another size) leaves only once its client has acknowledged the
     * new size. Removed before that, Mutter would put it on a neighbour for a
     * moment, where maximize-own-workspace would split it off again.
     */
    _removeWhenVacated(ws) {
        const wm = global.workspace_manager;
        const started = GLib.get_monotonic_time();
        const check = () => {
            if (!hasWorkspace(ws))
                return true; // removed by someone else (maximize-own's sweep)
            const stayed = ws.list_windows().filter(w => !w.is_on_all_workspaces());
            if (stayed.length > 0) {
                if (GLib.get_monotonic_time() - started < VACATE_MS * 1000)
                    return false;
                this._log(`workspace ${ws.index() + 1} kept: ${stayed.length} window(s) ` +
                    'did not leave it');
                return true;
            }
            if (wm.n_workspaces > 1) {
                this._leave(ws);
                wm.remove_workspace(ws, global.get_current_time());
            }
            return true;
        };
        if (check())
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!check())
                return GLib.SOURCE_CONTINUE;
            this._timeouts.delete(id);
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(id, '[workspace-manage] remove vacated workspace');
        this._timeouts.add(id);
    }

    // ---- target ----------------------------------------------------------------

    _toPrimary(taken, index) {
        const wm = global.workspace_manager;
        if (Meta.prefs_get_dynamic_workspaces() || wm.n_workspaces >= MAX_WORKSPACES)
            return null;
        const primary = Main.layoutManager.primaryIndex;
        const time = global.get_current_time();

        const ws = wm.append_new_workspace(false, time);
        const at = Math.min(Math.max(index, 0), wm.n_workspaces - 1);
        if (ws.index() !== at)
            wm.reorder_workspace(ws, at);
        if (taken.made)
            ws[MADE] = true;
        // Mutter puts a window that stops being sticky on the active workspace.
        ws.activate(time);

        for (const window of taken.windows) {
            this._islands?.reveal(window);
            moveToMonitor(window, primary);
            if (!window.is_on_all_workspaces() && window.get_workspace() !== ws &&
                !window.get_transient_for())
                window.change_workspace(ws);
        }
        return `workspace ${ws.index() + 1} of the primary monitor`;
    }

    _toVirtual(taken, state, index) {
        const islands = this._islands;
        const monitor = islands.monitorOf(state);
        if (monitor < 0)
            return null;
        const at = islands.insert(state, index);
        if (at < 0)
            return null;
        const group = state._groups[at];
        if (taken.made)
            group[MADE] = true;
        islands.activate(state, at);

        islands.land(state, group, taken.windows, () => {
            for (const window of taken.windows)
                moveToMonitor(window, monitor);
        });
        islands.changed(state, `took a workspace as virtual workspace ${at + 1}`);
        return `virtual workspace ${state._groups.indexOf(group) + 1} of ${state.connector}`;
    }
}

/**
 * Meta.Window.move_to_monitor, keeping a floating window where it was within
 * the work area. Mutter does that itself for a window on screen, but puts one
 * on an inactive workspace (or parked by islands) in the top-left corner.
 * Maximized, tiled and fullscreen windows are left to Mutter, which re-fits
 * them to the new monitor.
 */
function moveToMonitor(window, monitor) {
    // `monitor` may be stale by now (islands.land runs this later, and an
    // undock renumbers monitors): skip rather than hand Mutter a bad index.
    if (!isValidMonitor(monitor))
        return;
    const from = window.get_monitor();
    if (from === monitor)
        return;
    const floating = isValidMonitor(from) && !window.is_fullscreen() &&
        !window.maximized_horizontally && !window.maximized_vertically;
    const rect = window.get_frame_rect();
    const fromArea = floating ? window.get_work_area_for_monitor(from) : null;

    window.move_to_monitor(monitor);
    if (!floating || window.get_monitor() !== monitor)
        return;

    if (!isValidMonitor(monitor))
        return;
    const area = window.get_work_area_for_monitor(monitor);
    const fit = (offset, room) => Math.max(0, Math.min(offset, room));
    window.move_frame(true,
        area.x + fit(rect.x - fromArea.x, area.width - rect.width),
        area.y + fit(rect.y - fromArea.y, area.height - rect.height));
}

/** Parents before their dialogs: Mutter moves an attached dialog with it. */
function rootsFirst(windows) {
    return [
        ...windows.filter(w => !w.get_transient_for()),
        ...windows.filter(w => w.get_transient_for()),
    ];
}

function hasWorkspace(ws) {
    const wm = global.workspace_manager;
    for (let i = 0; i < wm.n_workspaces; i++) {
        if (wm.get_workspace_by_index(i) === ws)
            return true;
    }
    return false;
}

function describe(place, index) {
    return place.kind === 'primary'
        ? `workspace ${index + 1} of the primary monitor`
        : `virtual workspace ${index + 1} of ${place.state.connector}`;
}
