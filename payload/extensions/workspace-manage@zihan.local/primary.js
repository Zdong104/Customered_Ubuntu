/**
 * The primary monitor: stock GNOME's ThumbnailsBox, real Meta.Workspaces.
 *
 * Seams (all on prototypes, through the extension's InjectionManager):
 *
 *   ThumbnailsBox._updateShouldShow   stock hides the strip below two
 *                                     workspaces (three when dynamic). With
 *                                     one workspace by default it has to show
 *                                     anyway, or there is nowhere to put "+".
 *   ThumbnailsBox.addThumbnails       every thumbnail it makes gets the drag,
 *                                     the "×", and the "+" on the strip.
 *   ThumbnailsBox.handleDragOver/acceptDrop   reorder drags first (and
 *                                     workspaces dragged in from a secondary
 *                                     monitor's strip), everything else
 *                                     (windows, apps, xdnd) as before.
 *   ThumbnailsBox.vfunc_get_preferred_width/height, vfunc_allocate
 *                                     room for "+" after the last thumbnail,
 *                                     and the insertion bar of a foreign drag.
 *   WorkspaceThumbnail._addWindowClone   window clones inside a thumbnail no
 *                                     longer start a window drag: a drag that
 *                                     starts on a thumbnail always moves the
 *                                     workspace, as in Mission Control and as
 *                                     on the secondary monitors' strip, whose
 *                                     previews were never draggable. Windows
 *                                     are still dragged from the big view.
 *   ThumbnailsBox._updateStates       recomputes the stock "indicator still
 *                                     sliding" flag before the stock code
 *                                     trusts it (see the override), so a
 *                                     workspace removed or added while the
 *                                     overview is open leaves or joins the
 *                                     strip at once.
 *
 * Thumbnails are rebuilt on every overview entry; the strip itself lives as
 * long as the overview.
 *
 * Count: Mutter's static workspaces (dynamic-workspaces=false). Mutter writes
 * the count back to num-workspaces whenever one is appended or removed, so the
 * count survives a relogin with no bookkeeping here. With dynamic workspaces
 * on, GNOME would take back any empty workspace "+" made, so "+" is hidden.
 */

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    ThumbnailsBox,
    ThumbnailState,
    WorkspaceThumbnail,
} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import * as Strip from './strip.js';

/** Mutter's own cap is 36; Mission Control's is 16. */
export const MAX_WORKSPACES = 16;

export class PrimaryStrip {
    constructor(injector, log) {
        this._injector = injector;
        this._log = log;
        this._boxes = new Set();
    }

    enable() {
        const box = ThumbnailsBox?.prototype;
        const thumb = WorkspaceThumbnail?.prototype;
        if (typeof box?.addThumbnails !== 'function' ||
            typeof box?._updateShouldShow !== 'function' ||
            typeof thumb?._addWindowClone !== 'function') {
            console.warn('workspace-manage: stock ThumbnailsBox not as expected; ' +
                'primary monitor left alone');
            return;
        }

        const self = this;
        const inj = this._injector;

        inj.overrideMethod(box, '_updateShouldShow', () => function () {
            if (this._shouldShow)
                return;
            this._shouldShow = true;
            this.notify('should-show');
        });

        inj.overrideMethod(box, 'addThumbnails', original => function (...args) {
            original.call(this, ...args);
            self._decorateBox(this);
        });

        inj.overrideMethod(box, 'handleDragOver', original => function (source, actor, x, y, time) {
            if (Strip.isReorderSource(source)) {
                return Strip.isOurDrag(source, this)
                    ? Strip.dragOver(x)
                    : Strip.dragOverOther(source, this._wmAdapter, x);
            }
            return original.call(this, source, actor, x, y, time);
        });

        inj.overrideMethod(box, 'acceptDrop', original => function (source, actor, x, y, time) {
            if (Strip.isReorderSource(source)) {
                return Strip.isOurDrag(source, this)
                    ? Strip.drop()
                    : Strip.dropOther(source, this._wmAdapter, x);
            }
            return original.call(this, source, actor, x, y, time);
        });

        inj.overrideMethod(box, 'vfunc_get_preferred_width', original => function (forHeight) {
            const [min, nat] = original.call(this, forHeight);
            const extra = Strip.addButtonExtent(this);
            return [min + extra, nat + extra];
        });

        inj.overrideMethod(box, 'vfunc_get_preferred_height', original => function (forWidth) {
            const extra = forWidth >= 0 ? Strip.addButtonExtent(this) : 0;
            return original.call(this, forWidth - extra);
        });

        // The thumbnails are laid out in a box narrowed by the "+" (children
        // are placed relative to the strip's origin, so only the far edge
        // moves) and the "+" goes in the room left on the right. On the
        // right in RTL too: the stock layout is mirrored inside that box.
        inj.overrideMethod(box, 'vfunc_allocate', original => function (box_) {
            const extra = Strip.addButtonExtent(this);
            if (extra === 0) {
                original.call(this, box_);
            } else {
                const narrowed = box_.copy();
                narrowed.x2 -= extra;
                original.call(this, narrowed);
                this.set_allocation(box_);
            }
            Strip.allocateAddButton(this, this._thumbnails);
            Strip.allocateCloseButtons(this._thumbnails);
            Strip.allocateDropMarker(this);
        });

        // Stock caches whether the active-workspace highlight is still
        // sliding (_animatingIndicator) and _updateStates does nothing while
        // it is set: no removed thumbnail slides out, no added one comes in.
        // The cache is refreshed on the workspace adjustment's notify::value
        // and, only while the overview is open, on active-workspace-changed.
        // A touchpad swipe outside the overview (WorkspaceAnimationController
        // ._switchWorkspaceEnd) eases the adjustment to the new workspace
        // first and activates it afterwards, so the last refresh sees
        // value !== active and nothing ever clears the flag. Every later
        // overview then kept removed workspaces' thumbnails (and hid added
        // ones) until it was closed and its strip rebuilt (2026-11-04).
        // Recompute the flag from the live values, as stock would have.
        if (typeof box._updateStates === 'function') {
            inj.overrideMethod(box, '_updateStates', original => function (...args) {
                const active = global.workspace_manager.get_active_workspace_index();
                if (this._scrollAdjustment)
                    this._animatingIndicator = this._scrollAdjustment.value !== active;
                return original.call(this, ...args);
            });
        }

        inj.overrideMethod(thumb, '_addWindowClone', original => function (...args) {
            const clone = original.call(this, ...args);
            if (this[Strip.REORDER])
                setCloneDraggable(clone, false);
            return clone;
        });

        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._mutterSettings.connectObject('changed::dynamic-workspaces',
            () => this._syncAll(), this);
        global.workspace_manager.connectObject('notify::n-workspaces',
            () => this._syncAll(), this);

        // The strip outlives our enable/disable; bring the live one in line.
        const live = liveBox();
        if (live) {
            live._updateShouldShow();
            this._decorateBox(live);
        }
    }

    disable() {
        this._mutterSettings?.disconnectObject(this);
        this._mutterSettings = null;
        global.workspace_manager.disconnectObject(this);

        for (const box of this._boxes) {
            for (const thumbnail of box._thumbnails ?? [])
                undecorateThumbnail(thumbnail);
            box[Strip.ADD]?.destroy();
            delete box[Strip.ADD];
            Strip.removeDropMarker(box);
            delete box._wmAdapter;
            box.disconnectObject(this);
            box.queue_relayout();
        }
        this._boxes.clear();
    }

    /** After the injections are gone: let the stock rules hide the strip again. */
    restoreStock() {
        liveBox()?._updateShouldShow();
    }

    // ---- decoration ----------------------------------------------------------

    _decorateBox(box) {
        if (!this._boxes.has(box)) {
            this._boxes.add(box);
            box.connectObject('destroy', () => this._boxes.delete(box), this);
        }

        if (!box[Strip.ADD]) {
            const button = Strip.makeAddButton({
                add: () => this.append(),
                addWithWindow: window => this.appendWithWindow(window, box._monitorIndex),
            });
            box.add_child(button);
            box[Strip.ADD] = button;
        }

        const adapter = this._adapterFor(box);
        for (const thumbnail of box._thumbnails) {
            if (thumbnail[Strip.REORDER])
                continue;
            Strip.makeReorderable(thumbnail, adapter);
            Strip.addCloseButton(thumbnail, {
                close: () => {
                    if (thumbnail.state === ThumbnailState.NORMAL)
                        this.remove(thumbnail.metaWorkspace);
                },
                canClose: () => thumbnail.state === ThumbnailState.NORMAL && this._canRemove(),
            });
            for (const clone of thumbnail._windows ?? [])
                setCloneDraggable(clone, false);
        }
        this._syncBox(box);
    }

    _adapterFor(box) {
        box._wmAdapter ??= {
            strip: box,
            indicator: box._indicator,
            slots: () => {
                const all = box._thumbnails;
                // Mid add/remove animation the array and the workspace list
                // disagree; reordering then would move the wrong workspace.
                if (all.some(t => t.state !== ThumbnailState.NORMAL))
                    return null;
                return all;
            },
            activeIndex: () => global.workspace_manager.get_active_workspace_index(),
            commit: (from, to) => {
                const ws = global.workspace_manager.get_workspace_by_index(from);
                this._log(`reorder workspace ${from + 1} -> ${to + 1}`);
                global.workspace_manager.reorder_workspace(ws, to);
                return false;
            },
            onDragChanged: () => this._syncBox(box),
            place: {kind: 'primary'},
            canTake: () => this.canTake(),
        };
        return box._wmAdapter;
    }

    _syncAll() {
        for (const box of this._boxes)
            this._syncBox(box);
    }

    _syncBox(box) {
        const add = box[Strip.ADD];
        if (add) {
            const visible = !Meta.prefs_get_dynamic_workspaces() &&
                global.workspace_manager.n_workspaces < MAX_WORKSPACES;
            if (add.visible !== visible) {
                add.visible = visible;
                box.queue_relayout();
            }
        }
        for (const thumbnail of box._thumbnails ?? []) {
            Strip.syncCloseButton(thumbnail, () =>
                thumbnail.state === ThumbnailState.NORMAL && this._canRemove());
        }
    }

    _canRemove() {
        return global.workspace_manager.n_workspaces > 1;
    }

    /** Room for a workspace moved here from another monitor (static only). */
    canTake() {
        return !Meta.prefs_get_dynamic_workspaces() &&
            global.workspace_manager.n_workspaces < MAX_WORKSPACES;
    }

    // ---- operations ------------------------------------------------------------

    append() {
        const wm = global.workspace_manager;
        if (wm.n_workspaces >= MAX_WORKSPACES)
            return null;
        const ws = wm.append_new_workspace(false, global.get_current_time());
        this._log(`appended workspace ${ws.index() + 1}`);
        return ws;
    }

    appendWithWindow(window, monitorIndex) {
        const ws = this.append();
        if (!ws)
            return false;
        Main.moveWindowToMonitorAndWorkspace(window, monitorIndex, ws.index(), true);
        return true;
    }

    /**
     * Remove a workspace. Its windows go to a neighbour (see pickNeighbour);
     * if it was the active one, so does the view.
     */
    remove(ws) {
        const wm = global.workspace_manager;
        if (wm.n_workspaces <= 1 || !ws || ws.index() < 0)
            return false;

        const index = ws.index();
        const windowsOn = i => wm.get_workspace_by_index(i).list_windows()
            .filter(w => !w.is_on_all_workspaces());
        const neighbour = wm.get_workspace_by_index(
            pickNeighbour(index, wm.n_workspaces, windowsOn));
        const time = global.get_current_time();

        const windows = windowsOn(index);
        exitFullscreen(windows);
        for (const window of windows)
            window.change_workspace(neighbour);
        if (ws.active)
            neighbour.activate(time);
        wm.remove_workspace(ws, time);

        this._log(`removed workspace ${index + 1}, ${windows.length} window(s) ` +
            `to workspace ${neighbour.index() + 1}`);
        return true;
    }
}

/**
 * Where a removed workspace's windows go: the workspace before it (after it,
 * for the first), unless that one holds a maximized or fullscreen window and
 * the other neighbour does not. With maximize-own-workspace, which gives such
 * a window a workspace to itself, landing there would only be split off into
 * a new workspace again.
 */
export function pickNeighbour(index, count, windowsOn) {
    const before = index - 1;
    const after = index + 1;
    if (before < 0)
        return after;
    if (after >= count)
        return before;
    const holdsMax = i => windowsOn(i).some(w => w.is_maximized() || w.is_fullscreen());
    return holdsMax(before) && !holdsMax(after) ? after : before;
}

/**
 * Closing a workspace that holds a maximized or fullscreen window ends that,
 * as closing a fullscreen space does in Mission Control.
 */
export function exitFullscreen(windows) {
    for (const window of windows) {
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (window.is_maximized())
            window.unmaximize();
    }
}

function setCloneDraggable(clone, draggable) {
    const gesture = clone?._draggable?.startGesture;
    if (gesture)
        gesture.enabled = draggable;
}

function undecorateThumbnail(thumbnail) {
    Strip.unmakeReorderable(thumbnail);
    Strip.removeCloseButton(thumbnail);
    thumbnail.reactive = false;
    for (const clone of thumbnail._windows ?? [])
        setCloneDraggable(clone, true);
}

/** Two private hops; `controls` is a public getter, the box beyond it is not. */
function liveBox() {
    return Main.overview?._overview?.controls?._thumbnailsBox ?? null;
}
