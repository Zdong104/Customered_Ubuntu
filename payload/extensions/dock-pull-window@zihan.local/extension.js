/**
 * Dock Pulls Windows.
 *
 * Stock: a dock click on an app whose window sits on another workspace
 * switches the user to that workspace (Main.activateWindow ->
 * Meta.Workspace.activate_with_focus). Here a NORMAL window that is not
 * maximized / fullscreen / half of a split pair comes to the current
 * workspace instead (unminimized if need be), and is focused there.
 *
 * Stock behaviour stays when
 *   - the window holds a place of its own (maximized, fullscreen, split pair:
 *     maximize-own-workspace gives those their own workspace by design),
 *   - the place being looked at is a full-screen space (nothing may join it),
 *   - the window is already where its monitor is looking (just focused),
 *   - the window is sticky / skip-taskbar / out of maximize-own's model,
 *   - the activation did not come from the dock: Alt+Tab, the overview
 *     (outside the dock's app spread), notifications are untouched.
 * The rule itself is asked from maximize-own-workspace (pullInfo()), so the
 * two never disagree about what a full-screen space is.
 *
 * Secondary monitors (workspaces-only-on-primary, Workspace Islands): every
 * window there is sticky, so the dock's Main.activateWindow lands in
 * Meta.Window.activate, un-minimizes a parked window, and islands follows it
 * to its virtual workspace. Here the window is filed into the monitor's
 * visible virtual workspace first, through workspace-manage's islands bridge
 * (moveToGroup, the same move its Split View uses); without that bridge
 * (splitReady() false) secondaries stay stock.
 *
 * How the dock is recognised: Main.activateWindow is an ES module export and
 * cannot be wrapped, so the dock's own entry points open a short synchronous
 * "dock context" instead:
 *   DockAbstractAppIcon.activate     icon click, Super+1..9
 *   WindowPreviewMenuItem.activate   the icon menu's "All Windows" previews
 *                                    (and the hover previews)
 *   PopupBaseMenuItem.activate       plain window items of the icon menu
 *                                    (show-windows-preview off), only when the
 *                                    menu's source is a dock icon
 *   Workspace._onCloneSelected       a window picked in the app spread (only
 *                                    while appSpread.isInAppSpread). Stock,
 *                                    a window on a non-active workspace there
 *                                    only scrolls the overview to it.
 * Inside a context, the FIRST Meta.Workspace.activate_with_focus or
 * Meta.Window.activate call is the window the dock is activating; it is
 * pulled if the rule allows, else passed through untouched. Later calls in
 * the same context (other extensions reacting to the focus change) are never
 * touched.
 *
 * The dock's modules are imported through the same file:// URLs the
 * extension system loaded them from, so they are the live module instances
 * (as hide-minimized does). Only after ubuntu-dock is ACTIVE; if it comes up
 * later, extension-state-changed hooks it then. Disabling restores every
 * method.
 */

import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const DEBUG = false;

const DOCK_UUID = 'ubuntu-dock@ubuntu.com';
const MAXOWN_UUID = 'maximize-own-workspace@zihan.local';
const MANAGE_UUID = 'workspace-manage@zihan.local';

function log(message) {
    if (DEBUG)
        console.log(`[dock-pull] ${message}`);
}

function describe(window) {
    return `"${window?.get_title?.() ?? '?'}"`;
}

function rootOf(window) {
    let w = window;
    for (let parent = w.get_transient_for(); parent; parent = w.get_transient_for())
        w = parent;
    return w;
}

function isMax(window) {
    return window.is_maximized() || window.is_fullscreen();
}

function activeExtension(uuid) {
    const ext = Main.extensionManager.lookup(uuid);
    return ext?.state === ExtensionState.ACTIVE ? ext : null;
}

export default class DockPullWindow extends Extension {
    enable() {
        this._injections = new InjectionManager();
        this._dockInjections = new InjectionManager();
        this._depth = 0;
        this._armed = false;
        this._busy = false;
        this._dock = null;
        this._hookGeneration = 0;
        this._hooking = false;

        this._installCore();
        this._stateId = Main.extensionManager.connect('extension-state-changed',
            (_mgr, ext) => {
                if (ext?.uuid === DOCK_UUID)
                    this._hookDock();
            });
        this._hookDock();
        log('enabled');
    }

    disable() {
        if (this._stateId) {
            Main.extensionManager.disconnect(this._stateId);
            this._stateId = 0;
        }
        this._hookGeneration++;
        this._dockInjections?.clear();
        this._dockInjections = null;
        this._injections?.clear();
        this._injections = null;
        this._dock = null;
        this._depth = 0;
        this._armed = false;
        log('disabled');
    }

    // ---- dock context ----------------------------------------------------------

    /** Run `fn` as a dock activation. Only the outermost one arms. */
    _inDock(why, fn) {
        if (this._depth === 0)
            this._armed = true;
        this._depth++;
        this._why = this._depth === 1 ? why : this._why;
        try {
            return fn();
        } finally {
            this._depth--;
            if (this._depth === 0)
                this._armed = false;
        }
    }

    /** The first activation in an armed dock context; disarms it. */
    _take() {
        if (this._depth === 0 || !this._armed || this._busy)
            return false;
        this._armed = false;
        return true;
    }

    _installCore() {
        const self = this;

        this._injections.overrideMethod(Meta.Workspace.prototype, 'activate_with_focus',
            original => function (window, time) {
                if (window && self._take()) {
                    try {
                        if (self._pull(window, time))
                            return undefined;
                    } catch (e) {
                        console.error(`[dock-pull] ${e}\n${e.stack}`);
                    }
                }
                return original.call(this, window, time);
            });

        this._injections.overrideMethod(Meta.Window.prototype, 'activate',
            original => function (time) {
                if (self._take()) {
                    try {
                        if (self._pull(this, time))
                            return undefined;
                    } catch (e) {
                        console.error(`[dock-pull] ${e}\n${e.stack}`);
                    }
                }
                return original.call(this, time);
            });

        // A window picked in the dock's app spread. Clones bind this method
        // when they are made, and the overview rebuilds its views (and clones)
        // on every entry, so the override is in effect from the next one.
        const workspace = Workspace?.prototype;
        if (typeof workspace?._onCloneSelected === 'function') {
            this._injections.overrideMethod(workspace, '_onCloneSelected',
                original => function (clone, time) {
                    if (!self._inSpread())
                        return original.call(this, clone, time);
                    return self._inDock('app spread', () => {
                        const window = clone?.metaWindow;
                        // Stock, a window of a workspace that is not the
                        // active one only scrolls the overview there.
                        if (window && this.metaWorkspace && !this.metaWorkspace.active &&
                            self._take()) {
                            try {
                                if (self._pull(window, time)) {
                                    Main.overview.hide();
                                    Main.panel.closeCalendar();
                                    return undefined;
                                }
                            } catch (e) {
                                console.error(`[dock-pull] ${e}\n${e.stack}`);
                            }
                        }
                        return original.call(this, clone, time);
                    });
                });
        } else {
            console.warn('[dock-pull] Workspace._onCloneSelected not found; app spread stays stock');
        }

        // Plain window items of a dock icon's menu (show-windows-preview off).
        this._injections.overrideMethod(PopupMenu.PopupBaseMenuItem.prototype, 'activate',
            original => function (...args) {
                if (!self._fromDockMenu(this))
                    return original.apply(this, args);
                return self._inDock('dock menu', () => original.apply(this, args));
            });
    }

    _fromDockMenu(item) {
        const AppIcon = this._dock?.AppIcon;
        if (!AppIcon)
            return false;
        try {
            return item._getTopMenu?.()?.sourceActor instanceof AppIcon;
        } catch {
            return false;
        }
    }

    _inSpread() {
        try {
            return this._dock?.DockManager?.getDefault?.()?.appSpread?.isInAppSpread === true;
        } catch {
            return false;
        }
    }

    /** Load the live dock modules and wrap its entry points (once). */
    async _hookDock() {
        if (this._dock || this._hooking)
            return;
        const dock = activeExtension(DOCK_UUID);
        if (!dock?.dir)
            return;

        const generation = this._hookGeneration;
        this._hooking = true;
        try {
            const url = name => dock.dir.get_child(name).get_uri();
            const [appIcons, windowPreview, docking] = await Promise.all([
                import(url('appIcons.js')),
                import(url('windowPreview.js')),
                import(url('docking.js')),
            ]);
            if (generation !== this._hookGeneration || !this._dockInjections)
                return; // disabled meanwhile

            const AppIcon = appIcons.DockAbstractAppIcon;
            const PreviewItem = windowPreview.WindowPreviewMenuItem;
            const DockManager = docking.DockManager;
            if (typeof AppIcon?.prototype?.activate !== 'function') {
                console.warn('[dock-pull] DockAbstractAppIcon.activate not found; dock clicks stay stock');
                return;
            }
            // The live instance, not a second copy of the module: the running
            // dock's manager must be visible through it.
            if (!DockManager?.getDefault?.())
                console.warn('[dock-pull] ubuntu-dock DockManager not live through its module (dash-to-dock instead?)');

            const self = this;
            this._dockInjections.overrideMethod(AppIcon.prototype, 'activate',
                original => function (...args) {
                    return self._inDock(`dock icon ${this.app?.get_id?.() ?? '?'}`,
                        () => original.apply(this, args));
                });
            if (typeof PreviewItem?.prototype?.activate === 'function') {
                this._dockInjections.overrideMethod(PreviewItem.prototype, 'activate',
                    original => function (...args) {
                        return self._inDock('dock window menu', () => original.apply(this, args));
                    });
            }
            this._dock = {AppIcon, DockManager};
            log('hooked ubuntu-dock');
        } catch (e) {
            console.error(`[dock-pull] cannot hook ubuntu-dock: ${e}\n${e.stack}`);
        } finally {
            this._hooking = false;
        }
    }

    // ---- the pull --------------------------------------------------------------

    /**
     * maximize-own's answer for `root` (see its pullInfo()), or a primary-only
     * stand-in when it is not running.
     */
    _info(root) {
        const maxOwn = activeExtension(MAXOWN_UUID);
        if (typeof maxOwn?.stateObj?.pullInfo === 'function') {
            try {
                const info = maxOwn.stateObj.pullInfo(root);
                if (info)
                    return info;
            } catch (e) {
                console.warn(`[dock-pull] maximize-own pullInfo failed: ${e}`);
            }
        }

        const mon = root.get_monitor();
        if (Meta.prefs_get_workspaces_only_on_primary() &&
            mon !== global.display.get_primary_monitor())
            return {kind: 'none', eligible: false};
        const ws = root.get_workspace();
        const active = global.workspace_manager.get_active_workspace();
        return {
            kind: 'real',
            eligible: root.get_window_type() === Meta.WindowType.NORMAL &&
                !root.is_skip_taskbar() && !root.is_on_all_workspaces() && !!ws,
            holds: isMax(root),
            away: !!ws && ws !== active,
            hereHeld: active.list_windows().some(w => w !== root &&
                w.get_monitor() === mon && !w.minimized &&
                w.get_window_type() === Meta.WindowType.NORMAL && isMax(w)),
            state: null,
        };
    }

    /**
     * Bring `window` (the one the dock is activating) where its monitor is
     * looking, unminimize and focus it. False = not ours, go stock.
     */
    _pull(window, time) {
        const root = rootOf(window);
        const info = this._info(root);
        const what = `${describe(window)}${root !== window ? ` (dialog of ${describe(root)})` : ''} [${this._why}]`;

        if (!info.eligible) {
            log(`${what}: out of scope (${info.kind}) -> stock`);
            return false;
        }
        if (!info.away) {
            log(`${what}: already on the current view -> stock focus`);
            return false;
        }
        if (info.holds) {
            log(`${what}: maximized/fullscreen/split -> stock switch`);
            return false;
        }
        if (info.hereHeld) {
            log(`${what}: current place is a full-screen space -> stock switch`);
            return false;
        }
        if (!time)
            time = global.get_current_time();

        this._busy = true;
        try {
            if (info.kind === 'real') {
                const ws = global.workspace_manager.get_active_workspace();
                // Mutter moves the transients (and ancestors) along.
                root.change_workspace(ws);
                if (root.get_workspace() !== ws) {
                    log(`${what}: move to the current workspace refused -> stock`);
                    return false;
                }
                log(`${what}: pulled to workspace ${ws.index() + 1}`);
            } else if (info.kind === 'virt') {
                const manage = activeExtension(MANAGE_UUID)?.stateObj;
                const state = info.state;
                const group = state?._groups?.[state.activeIndex];
                if (!manage?.splitReady?.() || typeof manage.moveToGroup !== 'function' || !group) {
                    log(`${what}: islands bridge not ready -> stock`);
                    return false;
                }
                const from = state.indexOf(root);
                // Islands tracks dialogs as members too; they go with the root.
                const family = from >= 0
                    ? state.windowsOn(from).filter(w => w !== root && rootOf(w) === root)
                    : [];
                if (!manage.moveToGroup(state, root, group)) {
                    log(`${what}: islands move refused -> stock`);
                    return false;
                }
                for (const w of family)
                    manage.moveToGroup(state, w, group);
                log(`${what}: pulled into virtual workspace ${state.activeIndex + 1} on ${state.connector}`);
            } else {
                return false;
            }

            for (const w of new Set([root, window])) {
                if (w.minimized)
                    w.unminimize();
            }
            window.activate(time);
        } finally {
            this._busy = false;
        }
        return true;
    }
}
