/**
 * Hide minimized windows from the overview and from Alt+Tab.
 *
 * Stock GNOME lists minimized windows in both. Two seams:
 *
 *   Workspace._isOverviewWindow     decides which windows get a clone in the
 *                                   overview. The overview rebuilds its views
 *                                   on every entry, so the check is fresh.
 *   WindowSwitcherPopup._getWindowList   the Alt+Tab (switch-windows) list.
 *
 * Workspace thumbnails already skip minimized windows, and the Super+Tab app
 * switcher is left alone on purpose: with the dock, it is how a minimized
 * window gets back.
 *
 * Stacks with workspace-islands, which overrides the same two methods. It
 * parks the windows of an inactive virtual workspace by minimizing them and
 * tagging them, and its overview pages for those workspaces are made of exactly
 * those windows. Those are not the user's minimized windows, so the overview
 * filter lets tagged ones through; dropping them left every inactive page on a
 * secondary monitor showing an empty desktop. Its Alt+Tab filter already hides
 * them, so that seam needs no exemption.
 */

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Set by workspace-islands' visibility.js on windows it minimized itself. */
const ISLANDS_HIDDEN = Symbol.for('workspace-islands.hidden');

/** Minimized by the user, as opposed to parked by workspace-islands. */
function isUserMinimized(window) {
    return window.minimized && window[ISLANDS_HIDDEN] !== true;
}

/**
 * Ubuntu Dock's "app spread" (click-action focus-or-appspread) is an overview
 * filtered to one app's windows, and it is how a minimized window gets found
 * again, so minimized windows stay in it. Its DockManager is reached through
 * the same file:// module instance the extension system loaded.
 */
const DOCK_UUID = 'ubuntu-dock@ubuntu.com';
let DockManager = null;

function loadDock() {
    const dock = Main.extensionManager.lookup(DOCK_UUID);
    if (!dock?.dir || DockManager)
        return;
    import(dock.dir.get_child('docking.js').get_uri())
        .then(module => {
            DockManager = module.DockManager ?? null;
        })
        .catch(e => console.warn(`hide-minimized: cannot load ubuntu-dock: ${e}`));
}

function inAppSpread() {
    try {
        return DockManager?.getDefault?.()?.appSpread?.isInAppSpread === true;
    } catch {
        return false;
    }
}

export default class HideMinimizedExtension extends Extension {
    enable() {
        this._injector = new InjectionManager();
        loadDock();

        const workspace = Workspace?.prototype;
        if (typeof workspace?._isOverviewWindow === 'function') {
            this._injector.overrideMethod(workspace, '_isOverviewWindow',
                originalMethod => function (window) {
                    return (!isUserMinimized(window) || inAppSpread()) &&
                        originalMethod.call(this, window);
                });
        } else {
            console.warn('hide-minimized: Workspace._isOverviewWindow not found');
        }

        const switcher = AltTab.WindowSwitcherPopup?.prototype;
        if (typeof switcher?._getWindowList === 'function') {
            this._injector.overrideMethod(switcher, '_getWindowList',
                originalMethod => function (...args) {
                    return originalMethod.call(this, ...args)
                        .filter(window => !window.minimized);
                });
        } else {
            console.warn('hide-minimized: WindowSwitcherPopup._getWindowList not found');
        }
    }

    disable() {
        this._injector?.clear();
        this._injector = null;
    }
}
