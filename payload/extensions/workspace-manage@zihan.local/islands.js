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
 * A workspace moved here from another monitor (cross.js) arrives through
 * MonitorState.track, wrapped so islands files each arriving window straight
 * into the new group instead of by app rule or active index (land()).
 *
 * ## Split View on secondaries (2026-11-09)
 *
 * maximize-own-workspace's Split View pairs two windows on a virtual
 * workspace too. What it needs from islands goes through here, so islands'
 * private API is touched in one file and gated in one place (splitReady()):
 *
 *   change hooks    MonitorState track/untrack/moveWindowTo/switchTo and
 *                   _notifySizeChanged tell onChanged() listeners (its sweep);
 *                   a window moved between two parked groups emits no Meta
 *                   signal at all
 *   drop targets    islands' (module-private) thumbnail class gets the
 *                   window-split hover/drop (Strip.splitApi()); and the strip
 *                   forwards window drags to the thumbnail under the pointer,
 *                   because DND picks with PickMode.ALL and the active
 *                   thumbnail is covered by the strip's indicator (without
 *                   this a window could never be dropped on the visible
 *                   workspace's thumbnail, split or not)
 *   moves           moveToGroup(), activateGroup(), land() (cross.js's)
 *
 * splitReady() is false (secondaries stay stock) unless islands is the
 * version this was written against (SPLIT_VERSIONS) and every probed member
 * is there.
 *
 * Disabling never resizes anything back. A lock screen disables this and
 * enables it again a moment later; resizing to islands' count and back in
 * between would fold windows together for good.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {SecondaryMonitorDisplay} from 'resource:///org/gnome/shell/ui/workspacesView.js';

import * as Strip from './strip.js';
import {MAX_WORKSPACES, exitFullscreen, isValidMonitor, pickNeighbour} from './primary.js';

export const ISLANDS_UUID = 'workspace-islands@danielbernalo.github.io';

const COUNTS_KEY = 'virtual-workspace-counts';

/** MonitorState.resize() refuses to go below this (monitorState.js MIN_SIZE). */
const ISLANDS_MIN_SIZE = 2;

/** How long a window moving here with a workspace is waited for (land()). */
export const LANDING_MS = 5000;

/** Islands versions Split View on secondaries was verified against. */
const SPLIT_VERSIONS = new Set(['0.1.2']);

/** MonitorState methods after which split listeners hear of a change. */
const CHANGE_METHODS = ['untrack', 'moveWindowTo', 'switchTo', '_notifySizeChanged'];

/** Delay of the parked-on-primary sweep (_unparkOrphans) after a move. */
const UNPARK_DELAY_MS = 300;

/**
 * DING (ding@rastersoft.com) desktop windows, "Desktop Icons N": one maximized
 * transparent window per monitor, which DING's own shell code only turns into
 * a DESKTOP-type, skip-taskbar window once it is first mapped. Islands must
 * never adopt one: filed into a group that is not on screen, it is minimized
 * before its first map, DING never sees it map, and it stays minimized and on
 * the wrong monitor — with every icon (they all live on the primary's window)
 * gone. That is what docking did on 2026-11-11 10:50. Recognised from the
 * owning process (known at window-created, before title or type are), or from
 * the marker DING sets once it manages the window.
 */
const DING_SCRIPT = 'ding@rastersoft.com/app/ding.js';
const _dingWindows = new WeakMap();

export function isDingWindow(window) {
    if (!window)
        return false;
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

export class IslandsBridge {
    constructor(injector, settings, log) {
        this._injector = injector;
        this._settings = settings;
        this._log = log;
        this._patched = new Set();
        this._counts = {};
        this._landing = new Map();
        this._landingId = 0;
        this.ready = false;
        this.holdUnpark = false;
        this._listeners = new Set();
        this._hooked = false;
        this._splitVersion = false;
        this._thumbsOk = null; // null: no islands thumbnail seen yet
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
        const version = islands.metadata?.['version-name'] ?? null;
        this._splitVersion = SPLIT_VERSIONS.has(version);
        if (!this._splitVersion) {
            console.warn(`workspace-manage: workspace-islands ${version} is not a version ` +
                'Split View was verified against; split view stays on the primary');
        }
        this._monitorState = monitorState;
        this._View = workspacesView.VirtualWorkspacesView;
        this._visibility = visibility;
        this._placement = placement;

        this._install();
        await this._patchPanelDots(islands, token);
        if (this._token !== token)
            return;
        Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
            if (ext.uuid === ISLANDS_UUID && ext.state === ExtensionState.ACTIVE)
                this._reconcile();
        }, this);

        // Islands leaves a parked window minimized + HIDDEN-tagged when it
        // lands on the primary (see _unparkOrphans). Checked after every
        // monitor move and layout change, deferred past islands' own handlers.
        global.display.connectObject('window-entered-monitor',
            () => this._queueUnpark(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._queueUnpark(), this);

        this.ready = true;
        this._reconcile();
        this._queueUnpark();

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
        this._hooked = false;
        this._listeners.clear();
        Main.extensionManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        if (this._unparkId)
            clearTimeout(this._unparkId);
        this._unparkId = 0;
        this._clearLanding();

        // Views built while we were enabled stay up until the overview closes
        // (they are rebuilt on every entry); take our widgets off them.
        for (const strip of this._strips ?? []) {
            for (const thumbnail of strip._thumbnails ?? []) {
                Strip.unmakeReorderable(thumbnail);
                Strip.removeCloseButton(thumbnail);
            }
            strip[Strip.ADD]?.destroy();
            delete strip[Strip.ADD];
            Strip.removeDropMarker(strip);
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

    // ---- panel dots ------------------------------------------------------------

    /**
     * Islands repoints the top bar's workspace dots at the FOCUSED window's
     * monitor. The bar only exists on the primary, so with focus on an
     * external the dots counted that monitor's workspaces while the user was
     * looking at the primary (2026-11-09: 5 dots over a 1-workspace primary
     * overview). Make them always describe the primary, like stock GNOME;
     * secondary swipe previews are ignored for the same reason.
     */
    async _patchPanelDots(islands, token) {
        let Indicator;
        try {
            ({Indicator} = await import(islands.dir.get_child('indicator.js').get_uri()));
        } catch (e) {
            console.warn(`workspace-manage: cannot load islands indicator.js: ${e}`);
            return;
        }
        if (this._token !== token || typeof Indicator?.prototype?.sync !== 'function')
            return;

        this._injector.overrideMethod(Indicator.prototype, 'sync', original => function () {
            const adj = this._nativeAdjustment;
            if (!this._dots || !adj || typeof this._dots.set !== 'function')
                return original.call(this);
            this._dots.set(adj.upper, adj.value);
        });
        this._ext()?._indicator?.sync();
        this._log('panel dots follow the primary monitor');
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

        // A window arriving with a workspace moved here from another monitor
        // (cross.js) is filed straight into that workspace's group. Islands
        // would otherwise adopt it by app rule or the active index, minimizing
        // it first if that is some other group, and moveWindowTo() would then
        // play the unminimize to fix it. A window that was parked on its old
        // monitor is un-parked here if its new group is the one on screen.
        inj.overrideMethod(this._monitorState.MonitorState.prototype, 'track',
            original => function (window, index = -1, options = {}) {
                // DING's desktop windows are no member of any group (see
                // isDingWindow). -1 is what track() says for "not added".
                if (isDingWindow(window))
                    return -1;
                const landing = self._landing.get(window);
                const at = landing?.state === this ? this._groups.indexOf(landing.group) : -1;
                if (at < 0) {
                    const result = original.call(this, window, index, options);
                    self._changed();
                    return result;
                }
                self._landing.delete(window);
                const result = original.call(this, window, at, options);
                if (this.indexOf(window) === this.activeIndex)
                    self.reveal(window);
                self._changed();
                return result;
            });

        // Split View's sweep hears of every membership change (see header).
        const msProto = this._monitorState.MonitorState.prototype;
        if (CHANGE_METHODS.every(name => typeof msProto[name] === 'function')) {
            for (const name of CHANGE_METHODS) {
                inj.overrideMethod(msProto, name, original => function (...args) {
                    const result = original.apply(this, args);
                    self._changed();
                    return result;
                });
            }
            this._hooked = true;
        }

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
                // A display whose monitor is already gone (mid-undock) gets
                // the stock view; WorkspacesDisplay rebuilds it on
                // monitors-changed.
                const state = self.ready && isValidMonitor(this._monitorIndex)
                    ? ext?._registry.forMonitorIndex(this._monitorIndex) : null;
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
                    (index, window, monitorIndex) => isValidMonitor(monitorIndex)
                        ? ext._dropWindow(state, index, window, monitorIndex) : false);
                this.add_child(this._workspacesView);
            });
    }

    /** Islands' strip classes are module-private: patch them once seen. */
    _patchStripClasses(strip) {
        const self = this;
        const inj = this._injector;

        const thumbnail = strip._thumbnails?.[0];
        const thumbProto = thumbnail ? Object.getPrototypeOf(thumbnail) : null;
        if (thumbProto && !this._patched.has(thumbProto)) {
            this._patched.add(thumbProto);
            this._thumbsOk = typeof thumbProto.handleDragOver === 'function' &&
                typeof thumbProto.acceptDrop === 'function' &&
                Number.isInteger(thumbnail._index) && thumbnail._state === strip._state &&
                !!thumbnail._contents && !!thumbnail._monitor;
            if (!this._thumbsOk) {
                console.warn('workspace-manage: islands thumbnails are not as expected; ' +
                    'no split view on secondary strips');
            } else {
                // A window over an islands thumbnail: Split View's half, or
                // islands' own move to that virtual workspace.
                inj.overrideMethod(thumbProto, 'handleDragOver', original => function (source, ...args) {
                    const window = source?.metaWindow;
                    const api = window && self.splitReady() ? Strip.splitApi() : null;
                    if (typeof api?.windowSplitHover === 'function') {
                        let side = null;
                        try {
                            side = api.windowSplitHover(this, window);
                        } catch (e) {
                            console.error(`workspace-manage: split hover: ${e}\n${e.stack}`);
                        }
                        if (side)
                            return DND.DragMotionResult.MOVE_DROP;
                    }
                    return original.call(this, source, ...args);
                });
                inj.overrideMethod(thumbProto, 'acceptDrop', original => function (source, ...args) {
                    const window = source?.metaWindow;
                    const api = window && self.splitReady() ? Strip.splitApi() : null;
                    if (typeof api?.windowSplitDrop === 'function') {
                        try {
                            if (api.windowSplitDrop(this, window))
                                return true;
                        } catch (e) {
                            console.error(`workspace-manage: split drop: ${e}\n${e.stack}`);
                        }
                    }
                    return original.call(this, source, ...args);
                });
            }
        }

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
                Strip.allocateCloseButtons(this._thumbnails ?? []);
                Strip.allocateDropMarker(this);
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
            place: {kind: 'virtual', state},
            canTake: () => this.canResize(state) && state.size < MAX_WORKSPACES,
        };

        // Islands' thumbnails are drop targets for windows; the strip around
        // them takes the reorder drags, which they pass on (no metaWindow),
        // and workspaces dragged in from another monitor's strip.
        // A window reaches the strip itself only where DND picked no
        // thumbnail: the gaps, and the active thumbnail, which the strip's
        // indicator covers (DND picks non-reactive actors too). The
        // thumbnail under the pointer gets it, as the shell's ThumbnailsBox
        // does on the primary.
        const thumbAt = (x, y) => (strip._thumbnails ?? []).find(t => {
            const box = t.allocation;
            return x >= box.x1 && x < box.x2 && y >= box.y1 && y < box.y2;
        }) ?? null;
        strip._delegate = {
            handleDragOver(source, actor, x, y, time) {
                if (source?.metaWindow) {
                    const t = thumbAt(x, y);
                    return t
                        ? t.handleDragOver(source, actor, x - t.allocation.x1, y - t.allocation.y1, time)
                        : DND.DragMotionResult.CONTINUE;
                }
                if (!Strip.isReorderSource(source))
                    return DND.DragMotionResult.CONTINUE;
                return Strip.isOurDrag(source, strip)
                    ? Strip.dragOver(x)
                    : Strip.dragOverOther(source, strip._wmAdapter, x);
            },
            acceptDrop(source, actor, x, y, time) {
                if (source?.metaWindow) {
                    const t = thumbAt(x, y);
                    return t
                        ? t.acceptDrop(source, actor, x - t.allocation.x1, y - t.allocation.y1, time)
                        : false;
                }
                if (!Strip.isReorderSource(source))
                    return false;
                return Strip.isOurDrag(source, strip)
                    ? Strip.drop()
                    : Strip.dropOther(source, strip._wmAdapter, x);
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
        if (!isValidMonitor(monitorIndex))
            return false;
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

    // ---- Split View on secondaries (maximize-own-workspace) ---------------------

    /**
     * Whether Split View may pair windows on virtual workspaces: islands is
     * running, a verified version, and every hook and probe is in place.
     * False means secondaries stay stock.
     */
    splitReady() {
        return this.ready && this._splitVersion && this._hooked && this._thumbsOk !== false &&
            !!this._ext();
    }

    /** cb() after every islands membership change. Returns an unsubscribe. */
    onChanged(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _changed() {
        for (const cb of this._listeners) {
            try {
                cb();
            } catch (e) {
                console.error(`workspace-manage: islands change listener: ${e}\n${e.stack}`);
            }
        }
    }

    /**
     * File `window` (on this state's monitor) into `group`, by identity, as
     * islands' moveWindowTo() would, but with no animation: shown if `group`
     * is the active one, parked otherwise. Its placement note follows.
     */
    moveToGroup(state, window, group) {
        const to = state._groups.indexOf(group);
        if (to < 0)
            return false;
        const from = state.indexOf(window);
        if (from === to)
            return true;
        if (from >= 0)
            state._groups[from].delete(window);
        group.add(window);
        this._placement.stamp(window, state.connector, to);
        if (to === state.activeIndex)
            this.reveal(window);
        else
            this._visibility.hide(window, {animate: false});
        this._changed();
        try {
            this._ext()?._afterChange(`workspace-manage: ${state.connector} split moved ` +
                `"${window.get_title()}" to virtual workspace ${to + 1}`);
        } catch (e) {
            console.warn(`workspace-manage: islands _afterChange failed: ${e}`);
        }
        return true;
    }

    /** Make the virtual workspace `group` (by identity) the active one. */
    activateGroup(state, group) {
        const index = state._groups.indexOf(group);
        if (index >= 0)
            this.activate(state, index);
        return index >= 0;
    }

    // ---- a workspace moving between monitors (cross.js) ------------------------

    /** Monitor index of a state's display, or -1 while it is not attached. */
    monitorOf(state) {
        return this._monitorState.monitorIndexOf(state.connector);
    }

    /** Make virtual workspace `index` the active one, without the popup. */
    activate(state, index) {
        if (index === state.activeIndex)
            return;
        const ext = this._ext();
        if (ext)
            ext._commitSwitch(state, index, {announce: false});
        else
            state.switchTo(index, {animate: false});
    }

    /**
     * Bring `windows` onto this state's monitor into `group`. `moveAll` moves
     * them there (Meta.Window.move_to_monitor); islands adopts each one as it
     * enters the monitor, and the track() wrapper files it into `group`.
     *
     * Not every window has arrived when moveAll returns: one whose size
     * changes with the move (a maximized window, for a work area of another
     * size) changes monitor only once its Wayland client has acknowledged
     * the new size. Those stay expected for a while (LANDING_MS). One islands
     * did not adopt at all is filed here.
     */
    land(state, group, windows, moveAll) {
        for (const window of windows)
            this._landing.set(window, {state, group});
        try {
            moveAll();
        } finally {
            const monitor = this.monitorOf(state);
            for (const window of windows) {
                const at = state._groups.indexOf(group);
                if (at < 0)
                    break;
                const now = state.indexOf(window);
                if (now === -1 && window.get_monitor() === monitor) {
                    state.track(window, at, {trustPlacement: false});
                } else if (now >= 0 && now !== at) {
                    state._groups[now].delete(window);
                    group.add(window);
                    this._placement.stamp(window, state.connector, at);
                }
                if (state.indexOf(window) >= 0) {
                    this._landing.delete(window);
                    if (state.indexOf(window) === state.activeIndex)
                        this.reveal(window);
                }
            }
            if (this._landing.size > 0) {
                if (this._landingId)
                    clearTimeout(this._landingId);
                this._landingId = setTimeout(() => {
                    this._landingId = 0;
                    this._landing.clear();
                }, LANDING_MS);
            }
        }
    }

    _clearLanding() {
        if (this._landingId)
            clearTimeout(this._landingId);
        this._landingId = 0;
        this._landing.clear();
    }

    _queueUnpark() {
        if (this._unparkId)
            return;
        this._unparkId = setTimeout(() => {
            this._unparkId = 0;
            // During an undock undock.js shows them itself, once they have
            // been moved off the active workspace (unparkNow()).
            if (this.holdUnpark)
                return;
            try {
                this._unparkOrphans();
            } catch (e) {
                console.error(`workspace-manage: unpark sweep: ${e}\n${e.stack}`);
            }
        }, UNPARK_DELAY_MS);
    }

    /**
     * Show every islands-parked window that now sits on the primary monitor.
     *
     * Islands never manages the primary, so a HIDDEN-tagged window there is
     * minimized for no reason and invisible everywhere (islands' overview
     * filter drops tagged windows on non-island pages, thumbnails and Alt+Tab
     * skip minimized ones); only a dock click brings it back. It happens when
     * a parked window changes monitor: islands' window-left-monitor handler
     * untracks it (bookkeeping only, no show), so when the monitor it left is
     * then detached, or becomes the primary, detach()->restoreAll() no longer
     * finds it, and window-entered-monitor on the primary tracks nothing.
     * Seen 2026-11-06: "Employment - Google Chrome" parked on DP-4, DP-4
     * became primary on undock, window stayed [max,min] on a primary
     * workspace of its own. Islands' placement note is left alone, so its
     * _reclaim() still works if the monitor comes back.
     */
    _unparkOrphans() {
        if (!this.ready || !this._ext())
            return;
        const primary = Main.layoutManager.primaryIndex;
        const {isHiddenByUs, show} = this._visibility;
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            if (!window || !isHiddenByUs(window) || window.get_monitor() !== primary)
                continue;
            this._log(`unparking "${window.get_title()}": islands-hidden on the primary`);
            show(window, {animate: false});
        }
    }

    /** The parked-on-primary sweep, now (undock.js). */
    unparkNow() {
        try {
            this._unparkOrphans();
        } catch (e) {
            console.error(`workspace-manage: unpark sweep: ${e}\n${e.stack}`);
        }
    }

    /** Islands' Registry while it is running and bridged, else null. */
    registry() {
        return this.ready ? this._ext()?._registry ?? null : null;
    }

    /** Monitor index a connector drives now, or -1 (islands' own lookup). */
    monitorIndexOf(connector) {
        return this._monitorState?.monitorIndexOf(connector) ?? -1;
    }

    /** Un-park a window islands minimized, the way islands does. */
    reveal(window) {
        if (this._visibility.isHiddenByUs(window))
            this._visibility.show(window, {animate: false});
    }

    /** Islands' view rebuilds its pages and strip; persist and redraw dots. */
    changed(state, message) {
        state._notifySizeChanged();
        try {
            this._ext()?._afterChange(`workspace-manage: ${state.connector} ${message}`);
        } catch (e) {
            console.warn(`workspace-manage: islands _afterChange failed: ${e}`);
        }
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
