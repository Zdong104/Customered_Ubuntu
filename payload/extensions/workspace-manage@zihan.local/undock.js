/**
 * Undock: a secondary monitor's virtual workspaces arrive on the primary as
 * workspaces of their own, not as one pile on the active one.
 *
 * What happens without this (2026-11-06): with workspaces-only-on-primary
 * every window on a secondary is on all workspaces. When its monitor goes
 * away Mutter moves it to the primary, where it stops being sticky and is put
 * on the ACTIVE workspace, so every window of every virtual workspace lands
 * in one place. Islands' window-left-monitor handler drops each one from its
 * group on the way (bookkeeping only), so the ones it had parked (minimized +
 * hidden tag) stay minimized. maximize-own-workspace's settle reconcile then
 * splits every maximized window off that pile into a workspace of its own,
 * parked (still minimized) ones included, and hide-minimized hides those in
 * the overview: workspaces that look empty.
 *
 * Here: the islands groups are snapshotted at the first sign of a layout
 * change (MonitorManager 'monitors-changing', before Mutter moves anything).
 * Once the layout has been quiet for SETTLE_MS (after islands' own 300 ms
 * settle, well before maximize-own's 4 s one), every group of a connector
 * that is no longer an attached secondary becomes ONE workspace appended to
 * the primary, holding the group's windows, but only if it has an open window:
 * a group that is empty, or holds only overlays (EXEMPT_APPS) or windows the
 * user minimized, gets no workspace (its minimized windows stay where Mutter
 * put them). Then the parked windows on the primary are shown (the bridge's
 * _unparkOrphans, held back until now so nothing un-minimizes on the active
 * workspace first). A window still on its way (a maximized Wayland client
 * changes monitor only once it has acked its new size) is waited for, up to
 * LANDING_MS.
 *
 * The workspaces made here carry maximize-own-workspace's MADE tag and our own
 * UNDOCKED one: when they are emptied (a redock: Mutter moves each window back
 * to the output it came from, and islands files it back into its virtual
 * workspace by its placement note) they are removed, at the next settle here
 * (even the active one: the view goes to a neighbour) or by maximize-own's
 * sweep. Workspaces the user made carry neither tag and are never touched.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MAX_WORKSPACES} from './primary.js';

/** Quiet period after the last monitor change. Islands settles at 300 ms. */
const SETTLE_MS = 1000;

/** How long windows still on their way to the primary are waited for. */
const LANDING_MS = 5000;
const RETRY_MS = 500;

/** maximize-own-workspace's tag: its sweep drops such a workspace once empty. */
const MADE = Symbol.for('maximize-own-workspace.made');
/** Ours: a workspace made for an undock, removed here once empty. */
const UNDOCKED = Symbol.for('workspace-manage.undocked');
/** Set by islands' visibility.js on windows it minimized itself. */
const ISLANDS_HIDDEN = Symbol.for('workspace-islands.hidden');

/** Overlays, never workspace members. Same list as maximize-own-workspace. */
const EXEMPT_APPS = new Set(['vocalinux', 'wl-clipboard']);

function isExempt(window) {
    const cls = window.get_wm_class() ?? window.get_gtk_application_id();
    const key = cls ?? window.get_title() ?? '';
    return EXEMPT_APPS.has(key.toLowerCase());
}

/** A window that makes a workspace worth having: a real, visible-to-be one. */
function isOpen(window) {
    if (window.get_window_type() !== Meta.WindowType.NORMAL || window.is_skip_taskbar() ||
        isExempt(window))
        return false;
    // Parked by islands = will be shown; minimized by the user = stays hidden.
    return !window.minimized || window[ISLANDS_HIDDEN] === true;
}

function liveWindows() {
    return new Set(global.get_window_actors().map(a => a.meta_window).filter(w => w));
}

function allWorkspaces() {
    const wm = global.workspace_manager;
    const list = [];
    for (let i = 0; i < wm.get_n_workspaces(); i++)
        list.push(wm.get_workspace_by_index(i));
    return list;
}

function vacant(ws) {
    return ws.list_windows().every(w => w.is_on_all_workspaces());
}

export class UndockRegroup {
    constructor(islands, log) {
        this._islands = islands;
        this._log = log;
        this._snapshot = null;
        this._plan = null;
        this._settleId = 0;
        this._retryId = 0;
        this._collectId = 0;
    }

    enable() {
        global.backend.get_monitor_manager().connectObject('monitors-changing',
            () => this._changing('monitors-changing'), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._changing('monitors-changed'), this);
    }

    disable() {
        global.backend.get_monitor_manager().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const id of [this._settleId, this._retryId, this._collectId]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._settleId = this._retryId = this._collectId = 0;
        this._snapshot = null;
        this._plan = null;
        this._islands.holdUnpark = false;
    }

    _changing(why) {
        // The first event of a burst is the one that still sees the old
        // layout; a dock emits several, and a later one may already see the
        // windows moved and islands' groups emptied.
        if (!this._snapshot) {
            this._snapshot = this._take();
            const n = this._snapshot.reduce((sum, e) =>
                sum + e.groups.reduce((s, g) => s + g.length, 0), 0);
            this._log(`undock: ${why}, snapshot of ${this._snapshot.length} secondary ` +
                `monitor(s), ${n} window(s)`);
        }
        // A plan still waiting on windows from the previous burst is
        // superseded: whatever it did not move yet, this burst decides.
        this._plan = null;
        if (this._retryId) {
            GLib.Source.remove(this._retryId);
            this._retryId = 0;
        }
        this._islands.holdUnpark = true;

        if (this._settleId)
            GLib.Source.remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this._settle();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._settleId, '[workspace-manage] undock settle');
    }

    /** Every islands group that holds windows, per connector, in screen order. */
    _take() {
        const registry = this._islands.registry();
        if (!registry)
            return [];
        const entries = [];
        for (const state of registry.states) {
            const groups = (state._groups ?? []).map(group => [...group]);
            const windows = groups.flat();
            if (windows.length === 0)
                continue;
            // Screen order by where its windows are (still the old layout);
            // monitor indices may already be stale at this point.
            const x = Math.min(...windows.map(w => w.get_frame_rect().x));
            entries.push({connector: state.connector, groups, x});
        }
        return entries.sort((a, b) => a.x - b.x);
    }

    _settle() {
        const snapshot = this._snapshot ?? [];
        this._snapshot = null;
        try {
            this._plan = this._makePlan(snapshot);
            this._deadline = GLib.get_monotonic_time() + LANDING_MS * 1000;
            this._step();
        } catch (e) {
            this._plan = null;
            console.error(`workspace-manage: undock regroup: ${e}\n${e.stack}`);
        } finally {
            this._islands.holdUnpark = false;
            this._islands.unparkNow();
        }
        try {
            this._collect();
        } catch (e) {
            console.error(`workspace-manage: undock collect: ${e}\n${e.stack}`);
        }
        // Once more after the stragglers (a window still on its way back to
        // a redocked monitor keeps its old workspace occupied for a moment).
        if (this._collectId)
            GLib.Source.remove(this._collectId);
        this._collectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LANDING_MS, () => {
            this._collectId = 0;
            try {
                this._collect();
            } catch (e) {
                console.error(`workspace-manage: undock collect: ${e}\n${e.stack}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Groups of connectors that are no longer an attached secondary. */
    _makePlan(snapshot) {
        const registry = this._islands.registry();
        if (!registry || !Meta.prefs_get_workspaces_only_on_primary())
            return [];
        const primary = Main.layoutManager.primaryIndex;
        const plan = [];
        for (const {connector, groups} of snapshot) {
            const index = this._islands.monitorIndexOf(connector);
            if (index >= 0 && index !== primary)
                continue; // still a secondary: islands keeps its groups
            const why = index === primary ? 'became the primary' : 'went away';
            groups.forEach((windows, i) => {
                const members = windows.filter(w => !isExempt(w));
                if (members.length > 0)
                    plan.push({label: `${connector} virtual workspace ${i + 1}`, why, windows: members, ws: null, moved: new Set()});
            });
        }
        return plan;
    }

    /**
     * Move what has arrived on the primary; come back for the rest. A group
     * gets its workspace once one of its open windows is on the primary.
     */
    _step() {
        const plan = this._plan;
        if (!plan || plan.length === 0) {
            this._plan = null;
            return;
        }
        const primary = Main.layoutManager.primaryIndex;
        const alive = liveWindows();
        const secondaries = new Set();
        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            if (i !== primary)
                secondaries.add(i);
        }
        const wm = global.workspace_manager;
        let waiting = false;

        for (const item of plan) {
            item.windows = item.windows.filter(w => alive.has(w) && !item.moved.has(w));
            // Back on a secondary (a quick redock), or sticky on purpose: not ours.
            const here = item.windows.filter(w => w.get_monitor() === primary &&
                !w.is_on_all_workspaces());
            const later = item.windows.filter(w => !secondaries.has(w.get_monitor()) &&
                w.get_monitor() !== primary);
            if (later.length > 0)
                waiting = true;
            if (here.length === 0)
                continue;

            if (!item.ws) {
                if (!here.some(isOpen)) {
                    if (!later.some(isOpen))
                        this._log(`undock: ${item.label} (${item.why}) has no open window; ` +
                            'no workspace for it');
                    continue;
                }
                if (Meta.prefs_get_dynamic_workspaces() || wm.n_workspaces >= MAX_WORKSPACES) {
                    this._log(`undock: no room for ${item.label}; its windows stay put`);
                    item.windows = [];
                    continue;
                }
                item.ws = wm.append_new_workspace(false, global.get_current_time());
                item.ws[MADE] = true;
                item.ws[UNDOCKED] = true;
                this._log(`undock: ${item.label} (${item.why}) -> workspace ${item.ws.index() + 1}`);
            }
            if (!allWorkspaces().includes(item.ws)) {
                item.windows = []; // removed meanwhile
                continue;
            }
            for (const w of here) {
                item.moved.add(w);
                if (w.get_workspace() !== item.ws)
                    w.change_workspace(item.ws);
            }
            this._log(`undock: moved ${here.map(w => `"${w.get_title()}"`).join(', ')} ` +
                `to workspace ${item.ws.index() + 1}`);
        }

        if (waiting && GLib.get_monotonic_time() < this._deadline) {
            this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
                this._retryId = 0;
                try {
                    this._step();
                } catch (e) {
                    this._plan = null;
                    console.error(`workspace-manage: undock regroup: ${e}\n${e.stack}`);
                }
                this._islands.unparkNow();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._plan = null;
        }
    }

    /** Drop every undock workspace that is empty now, the active one too. */
    _collect() {
        if (Meta.prefs_get_dynamic_workspaces())
            return;
        const wm = global.workspace_manager;
        for (const ws of allWorkspaces().reverse()) {
            if (!ws[UNDOCKED] || wm.n_workspaces <= 1 || !vacant(ws))
                continue;
            const time = global.get_current_time();
            const index = ws.index();
            if (ws.active)
                wm.get_workspace_by_index(index > 0 ? index - 1 : index + 1).activate(time);
            this._log(`undock: removing empty workspace ${index + 1}, made for an undock`);
            wm.remove_workspace(ws, time);
        }
    }
}
