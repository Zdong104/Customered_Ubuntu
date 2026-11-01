/**
 * Secondary monitors: Workspace Islands' virtual workspaces.
 *
 * Islands is driven from outside, never edited: an update would overwrite any
 * edit. Its modules are imported here by the same file:// URI the extension
 * system loaded them under, so this gets the very same module instances (and
 * classes, and the `applying` flag in visibility.js) that islands itself uses.
 *
 * A virtual workspace is one Set of windows in `state._groups`; the active one
 * is `state.activeIndex`. Every structural change (append, insert, remove,
 * reorder, resize) goes through _mutate(), which keeps everything islands
 * derives from that array consistent:
 *
 *   placement notes  re-stamped with each window's new index (placement.js)
 *   app rules        WM_CLASS -> index, remapped (or dropped with the group)
 *   visibility       windows entering the active group are shown, windows
 *                    leaving it hidden, with islands' own show()/hide(), so
 *                    the HIDDEN tag hide-minimized relies on stays right
 *   overview         state._notifySizeChanged(), on which islands' view
 *                    rebuilds its pages and strip
 *   indicator, saved-state   islands' _afterChange()
 *   count            our own settings key, per connector
 *
 * The group Sets themselves are kept (spliced, never copied), so anything that
 * holds on to a group identity, like maximize-own-workspace's snapshot, sees a
 * reorder as nothing having moved.
 *
 * ## Count
 *
 * Islands sizes every monitor to its `virtual-workspaces` setting, whose
 * schema floor is 2, and MonitorState.resize() refuses anything below 2. That
 * setting is left alone. Instead Registry._createState is wrapped to size each
 * new monitor to our per-connector count (1 for a monitor we have never seen),
 * and setFixedCount/setDynamic(false) no longer resize monitors while this is
 * enabled: islands would fold every window past the new end into the last
 * workspace, and growing back would not unfold them. In islands' dynamic mode
 * none of this applies; only reorder is offered.
 *
 * Islands shows its own overview only for a monitor with at least 2 virtual
 * workspaces (overview.js), so SecondaryMonitorDisplay._updateWorkspacesView is
 * wrapped to build islands' VirtualWorkspacesView for a monitor with 1, the
 * way islands builds it for 2+. This works whichever of the two extensions
 * wrapped the method last: islands falls through to the method it found for
 * fewer than 2, and this one falls through to the method it found otherwise.
 *
 * Disabling never resizes anything back. A lock screen disables this and
 * enables it again a moment later; resizing to islands' count and back in
 * between would fold windows together for good.
 */

import Meta from 'gi://Meta';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {SecondaryMonitorDisplay} from 'resource:///org/gnome/shell/ui/workspacesView.js';

import * as Strip from './strip.js';
import {MAX_WORKSPACES, exitFullscreen, pickNeighbour} from './primary.js';

export const ISLANDS_UUID = 'workspace-islands@danielbernalo.github.io';

const COUNTS_KEY = 'virtual-workspace-counts';

/** MonitorState.resize() refuses to go below this (monitorState.js MIN_SIZE). */
const ISLANDS_MIN_SIZE = 2;

export class IslandsBridge {
    constructor(injector, settings, log) {
        this._injector = injector;
        this._settings = settings;
        this._log = log;
        this._patched = new Set();
        this._counts = {};
        this.ready = false;
    }

    async enable() {
        const token = {};
        this._token = token;
        this._counts = this._loadCounts();

        const islands = Main.extensionManager.lookup(ISLANDS_UUID);
        if (!islands?.dir) {
            this._log('workspace-islands not installed; secondary monitors left alone');
            return;
        }

        let modules;
        try {
            modules = await Promise.all(
                ['monitorState.js', 'workspacesView.js', 'visibility.js', 'placement.js']
                    .map(name => import(islands.dir.get_child(name).get_uri())));
        } catch (e) {
            console.warn(`workspace-manage: cannot load workspace-islands modules: ${e}`);
            return;
        }
        if (this._token !== token)
            return; // disabled while loading

        const [monitorState, workspacesView, visibility, placement] = modules;
        if (typeof monitorState.Registry?.prototype?._createState !== 'function' ||
            typeof monitorState.MonitorState?.prototype?._notifySizeChanged !== 'function' ||
            typeof workspacesView.VirtualWorkspacesView !== 'function' ||
            typeof visibility.show !== 'function' || typeof visibility.hide !== 'function' ||
            typeof placement.stamp !== 'function' ||
            typeof SecondaryMonitorDisplay?.prototype?._updateWorkspacesView !== 'function') {
            console.warn('workspace-manage: workspace-islands is not the version this was ' +
                'written against (0.1.2); secondary monitors left alone');
            return;
        }
        this._monitorState = monitorState;
        this._View = workspacesView.VirtualWorkspacesView;
        this._visibility = visibility;
        this._placement = placement;

        this._install();
        Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
            if (ext.uuid === ISLANDS_UUID && ext.state === ExtensionState.ACTIVE)
                this._reconcile();
        }, this);

        this.ready = true;
        this._reconcile();

        // Enabled with the overview open: its views were built without us.
        const display = Main.overview?._overview?.controls?._workspacesDisplay;
        for (const monitorDisplay of display?._workspacesViews ?? []) {
            const view = monitorDisplay?._workspacesView;
            if (view instanceof this._View && !view._thumbnails?._wmAdapter)
                this._decorateView(view);
        }
        this._log('workspace-islands bridge ready');
    }

    disable() {
        this._token = null;
        this.ready = false;
        Main.extensionManager.disconnectObject(this);

        // Views built while we were enabled stay up until the overview closes
        // (they are rebuilt on every entry); take our widgets off them.
        for (const strip of this._strips ?? []) {
            for (const thumbnail of strip._thumbnails ?? []) {
                Strip.unmakeReorderable(thumbnail);
                Strip.removeCloseButton(thumbnail);
            }
            strip[Strip.ADD]?.destroy();
            delete strip[Strip.ADD];
            delete strip._wmAdapter;
            delete strip._wmState;
            delete strip._delegate;
            strip.queue_relayout();
        }
        this._strips = null;
        this._patched.clear();
    }

    // ---- islands handles -------------------------------------------------------

    /** The islands Extension object while it is running, else null. */
    _ext() {
        const ext = Main.extensionManager.lookup(ISLANDS_UUID);
        if (ext?.state !== ExtensionState.ACTIVE)
            return null;
        const obj = ext.stateObj;
        return obj?._registry ? obj : null;
    }

    /** Fixed mode: the count is ours to change. Dynamic: islands' own. */
    canResize(state) {
        const registry = this._ext()?._registry;
        return this.ready && !!registry && !registry._dynamic &&
            registry.forConnector(state.connector) === state;
    }

    // ---- injections ------------------------------------------------------------

    _install() {
        const self = this;
        const inj = this._injector;
        const registry = this._monitorState.Registry.prototype;

        inj.overrideMethod(registry, '_createState', original => function (connector) {
            if (this._dynamic)
                return original.call(this, connector);

            // Sized before restore() runs, as islands does, so the saved active
            // index and app rules are clamped into the count we will keep.
            const want = self._countFor(connector) ?? 1;
            const fixed = this._fixedCount;
            this._fixedCount = Math.max(ISLANDS_MIN_SIZE, want);
            let state;
            try {
                state = original.call(this, connector);
            } finally {
                this._fixedCount = fixed;
            }
            if (state.size !== want)
                self._resize(state, want, {quiet: true});
            self._setCount(connector, want);
            return state;
        });

        inj.overrideMethod(registry, 'setFixedCount', original => function (count) {
            if (this._dynamic)
                return original.call(this, count);
            // Remembered for islands, not applied: the counts are ours.
            this._fixedCount = count;
            return undefined;
        });

        inj.overrideMethod(registry, 'setDynamic', original => function (dynamic) {
            if (dynamic)
                return original.call(this, dynamic);
            this._dynamic = false;
            for (const state of this._states.values())
                state.setDynamic(false);
            self._reconcile();
            return undefined;
        });

        inj.overrideMethod(this._View.prototype, '_init', original => function (...args) {
            original.call(this, ...args);
            try {
                self._decorateView(this);
            } catch (e) {
                console.error(`workspace-manage: decorating islands view: ${e}\n${e.stack}`);
            }
        });

        inj.overrideMethod(SecondaryMonitorDisplay.prototype, '_updateWorkspacesView',
            original => function () {
                const ext = self._ext();
                const state = self.ready ? ext?._registry.forMonitorIndex(this._monitorIndex) : null;
                if (!state || state.size >= ISLANDS_MIN_SIZE ||
                    !Meta.prefs_get_workspaces_only_on_primary()) {
                    original.call(this);
                    return;
                }

                // Islands' own construction (overview.js patchSecondaryView),
                // for the one size it declines.
                this._workspacesView?.destroy();
                this._workspacesView = new self._View(
                    this._monitorIndex,
                    this._overviewAdjustment,
                    state,
                    index => ext._commitSwitch(state, index, {announce: false}),
                    (index, window, monitorIndex) =>
                        ext._dropWindow(state, index, window, monitorIndex));
                this.add_child(this._workspacesView);
            });
    }

    /** Islands' strip classes are module-private: patch them once seen. */
    _patchStripClasses(strip) {
        const self = this;
        const inj = this._injector;

        const stripProto = Object.getPrototypeOf(strip);
        if (!this._patched.has(stripProto)) {
            this._patched.add(stripProto);
            inj.overrideMethod(stripProto, '_buildThumbnails', original => function () {
                original.call(this);
                if (!this._wmAdapter)
                    return;
                if (this._indicator)
                    this._indicator.translation_x = 0;
                self._decorateThumbnails(this);
            });
            inj.overrideMethod(stripProto, 'vfunc_allocate', original => function (box) {
                const extra = Strip.addButtonExtent(this);
                if (extra === 0) {
                    original.call(this, box);
                } else {
                    const narrowed = box.copy();
                    narrowed.x2 -= extra;
                    original.call(this, narrowed);
                    this.set_allocation(box);
                }
                Strip.allocateAddButton(this, this._thumbnails ?? []);
            });
        }

        const thumbnail = strip._thumbnails?.[0];
        const thumbProto = thumbnail && Object.getPrototypeOf(thumbnail);
        if (thumbProto && !this._patched.has(thumbProto)) {
            this._patched.add(thumbProto);
            inj.overrideMethod(thumbProto, 'vfunc_allocate', original => function (box) {
                original.call(this, box);
                Strip.allocateCloseButton(this);
            });
        }
    }

    // ---- decoration ------------------------------------------------------------

    _decorateView(view) {
        const strip = view._thumbnails;
        const state = view._state;
        if (!this.ready || !strip || !state || !Array.isArray(strip._thumbnails))
            return;

        this._patchStripClasses(strip);
        this._strips ??= new Set();
        this._strips.add(strip);
        strip.connect('destroy', () => this._strips?.delete(strip));

        strip._wmState = state;
        strip._wmAdapter = {
            strip,
            indicator: strip._indicator,
            slots: () => strip._thumbnails.length === state.size ? strip._thumbnails : null,
            activeIndex: () => state.activeIndex,
            commit: (from, to) => this.reorder(state, from, to),
            onDragChanged: () => this._syncStrip(strip),
        };

        // Islands' thumbnails are drop targets for windows; the strip around
        // them takes the reorder drags, which they pass on (no metaWindow).
        strip._delegate = {
            handleDragOver(source, _actor, x) {
                if (!Strip.isReorderSource(source))
                    return DND.DragMotionResult.CONTINUE;
                return Strip.isOurDrag(source, strip)
                    ? Strip.dragOver(x)
                    : Strip.dragOverOther();
            },
            acceptDrop(source) {
                return Strip.isReorderSource(source) &&
                    Strip.isOurDrag(source, strip) && Strip.drop();
            },
        };

        const add = Strip.makeAddButton({
            add: () => this.insert(state, state.size),
            addWithWindow: window => this.appendWithWindow(state, window, view._monitorIndex),
        });
        strip.add_child(add);
        strip[Strip.ADD] = add;

        this._decorateThumbnails(strip);
    }

    _decorateThumbnails(strip) {
        const state = strip._wmState;
        for (const thumbnail of strip._thumbnails) {
            if (thumbnail[Strip.REORDER])
                continue;
            Strip.makeReorderable(thumbnail, strip._wmAdapter);
            Strip.addCloseButton(thumbnail, {
                close: () => this.remove(state, thumbnail._index),
                canClose: () => state.size > 1 && this.canResize(state),
            });
        }
        this._syncStrip(strip);
    }

    _syncStrip(strip) {
        const state = strip._wmState;
        const add = strip[Strip.ADD];
        if (add) {
            const visible = this.canResize(state) && state.size < MAX_WORKSPACES;
            if (add.visible !== visible) {
                add.visible = visible;
                strip.queue_relayout();
            }
        }
        for (const thumbnail of strip._thumbnails ?? [])
            Strip.syncCloseButton(thumbnail, () => state.size > 1 && this.canResize(state));
    }

    // ---- operations (also the API maximize-own-workspace uses) ----------------

    /**
     * New empty virtual workspace at `index` (0..size). Groups from `index` on
     * shift right; the active one stays active. Returns the index, or -1.
     */
    insert(state, index) {
        if (!this.canResize(state) || state.size >= MAX_WORKSPACES)
            return -1;
        index = Math.min(Math.max(index, 0), state.size);

        this._mutate(state, `inserted virtual workspace ${index + 1}`, groups => {
            const fresh = new Set();
            const next = [...groups.slice(0, index), fresh, ...groups.slice(index)];
            return {groups: next, map: i => (i >= index ? i + 1 : i)};
        });
        return index;
    }

    appendWithWindow(state, window, monitorIndex) {
        const index = this.insert(state, state.size);
        if (index < 0)
            return false;
        this._ext()?._dropWindow(state, index, window, monitorIndex);
        return true;
    }

    /**
     * Remove virtual workspace `index`. Its windows go to a neighbour (see
     * primary.js pickNeighbour); if it was active, so does the view.
     */
    remove(state, index) {
        if (!this.canResize(state) || state.size <= 1 || index < 0 || index >= state.size)
            return false;
        const target = pickNeighbour(index, state.size, i => state.windowsOn(i));
        const moved = state.windowsOn(index).length;
        exitFullscreen(state.windowsOn(index));

        this._mutate(state, `removed virtual workspace ${index + 1}, ${moved} window(s) ` +
            `to ${target + 1}`, (groups, active) => {
            const into = groups[target];
            for (const window of groups[index])
                into.add(window);
            const next = groups.filter((_g, i) => i !== index);
            return {
                groups: next,
                active: active === groups[index] ? into : active,
                map: i => next.indexOf(groups[i === index ? target : i]),
            };
        });
        return true;
    }

    /** Move virtual workspace `from` to position `to`. */
    reorder(state, from, to) {
        if (from === to || from < 0 || to < 0 || from >= state.size || to >= state.size)
            return false;
        this._mutate(state, `reordered virtual workspace ${from + 1} -> ${to + 1}`, groups => {
            const next = [...groups];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return {groups: next, map: i => next.indexOf(groups[i])};
        });
        return true;
    }

    /**
     * Exactly `size` groups: empty ones appended, or everything past the new
     * end folded into the last kept one (as islands' own resize does).
     */
    _resize(state, size, {quiet = false} = {}) {
        size = Math.max(1, size);
        if (size === state.size)
            return;
        this._mutate(state, `resized to ${size}`, (groups, active) => {
            if (size > groups.length) {
                const added = Array.from({length: size - groups.length}, () => new Set());
                return {groups: [...groups, ...added], map: i => i};
            }
            const kept = groups.slice(0, size);
            const last = kept[size - 1];
            for (const group of groups.slice(size)) {
                for (const window of group)
                    last.add(window);
            }
            return {
                groups: kept,
                active: kept.includes(active) ? active : last,
                map: i => Math.min(i, size - 1),
            };
        }, {quiet});
    }

    /**
     * The one place a monitor's groups change shape. `plan(groups, active)`
     * returns the new array (made of the same Sets, plus new ones), the group
     * that should be active (default: the same one), and how an old index maps
     * to a new one (for app rules; -1 drops the rule).
     */
    _mutate(state, message, plan, {quiet = false} = {}) {
        const {show, hide, isHiddenByUs} = this._visibility;
        const {stamp} = this._placement;

        const shownBefore = new Set(state.activeWindows);
        const oldGroups = state._groups;
        const oldActive = oldGroups[state.activeIndex];
        const {groups, active = oldActive, map} = plan(oldGroups, oldActive);

        state._groups = groups;
        state.activeIndex = Math.max(0, groups.indexOf(active));
        groups.forEach((group, index) => {
            for (const window of group)
                stamp(window, state.connector, index);
        });

        const rules = new Map();
        for (const [key, index] of state._appRules ?? []) {
            const mapped = map(index);
            if (mapped >= 0 && mapped < groups.length)
                rules.set(key, mapped);
        }
        state._appRules = rules;

        // Reveal first, then hide: islands' order, no flash of empty desktop.
        const shownAfter = new Set(state.activeWindows);
        for (const window of shownAfter) {
            if (!shownBefore.has(window) && (window.minimized ? isHiddenByUs(window) : true))
                show(window, {animate: false});
        }
        for (const window of shownBefore) {
            if (!shownAfter.has(window))
                hide(window, {animate: false});
        }

        if (state.size !== oldGroups.length || !quiet)
            this._setCount(state.connector, state.size);
        state._notifySizeChanged();

        if (!quiet) {
            try {
                this._ext()?._afterChange(`workspace-manage: ${state.connector} ${message}`);
            } catch (e) {
                console.warn(`workspace-manage: islands _afterChange failed: ${e}`);
            }
        }
        this._log(`${state.connector}: ${message} (now ${state.size}, ` +
            `active ${state.activeIndex + 1})`);
    }

    /** Bring every monitor islands knows to our count for it. */
    _reconcile() {
        const registry = this._ext()?._registry;
        if (!this.ready || !registry || registry._dynamic)
            return;

        for (const state of registry.states) {
            let want = this._countFor(state.connector);
            if (want === null) {
                // First time we see this monitor with islands already running
                // (e.g. this extension was just installed): keep every
                // workspace that has something on it, drop the empty tail.
                let last = 0;
                for (let i = 0; i < state.size; i++) {
                    if (state.windowsOn(i).length > 0 || i === state.activeIndex)
                        last = i;
                }
                want = last + 1;
            }
            if (want !== state.size)
                this._resize(state, want);
            this._setCount(state.connector, want);
        }
    }

    // ---- counts ------------------------------------------------------------------

    _loadCounts() {
        try {
            const parsed = JSON.parse(this._settings.get_string(COUNTS_KEY));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            console.warn(`workspace-manage: discarding unreadable ${COUNTS_KEY}: ${e}`);
            return {};
        }
    }

    _countFor(connector) {
        const n = this._counts[connector];
        return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_WORKSPACES) : null;
    }

    _setCount(connector, count) {
        if (this._counts[connector] === count)
            return;
        this._counts[connector] = count;
        this._settings.set_string(COUNTS_KEY, JSON.stringify(this._counts));
    }
}
