/**
 * Workspace Manage: Mission Control-style workspaces in the overview.
 *
 *   reorder  drag a workspace thumbnail left or right and drop it; the others
 *            slide aside to show where it will land
 *   add      "+" at the end of the thumbnail strip appends a workspace; a
 *            window dropped on "+" gets a new workspace of its own
 *   remove   hovering a thumbnail shows "×"; its windows move to the
 *            workspace before it (after it, for the first). The last
 *            workspace cannot be removed.
 *   move     drag a thumbnail onto another monitor's strip: a bar shows where
 *            it goes, and on drop the workspace and all its windows move to
 *            that monitor as a new, active workspace there (cross.js)
 *
 * Every monitor starts with one workspace at login (resetAtLogin), and
 * workspaces added by hand stay when empty for the rest of that session. Both kinds of monitor behave the same:
 *
 *   primary     stock GNOME workspaces in its ThumbnailsBox (primary.js), with
 *               Mutter's static workspaces: dynamic-workspaces=false, and
 *               num-workspaces holds the count within a session.
 *   secondary   Workspace Islands' virtual workspaces in its own strip
 *               (islands.js), the count per connector in this extension's
 *               settings.
 *
 * strip.js has what the two share: the buttons and the reorder drag (and the
 * drop of a workspace on another monitor's strip, which cross.js carries out).
 *
 * API for maximize-own-workspace (through `stateObj`, like it reaches islands):
 *
 *   insertVirtualWorkspace(state, index) -> index, or -1
 *   removeVirtualWorkspace(state, index) -> bool   (windows go to a neighbour)
 *
 * and for Split View on secondaries (islands.js, "Split View on secondaries"):
 *
 *   splitReady() -> bool          islands verified + hooked; false = stay stock
 *   onIslandsChanged(cb) -> {token, off}   cb() after any membership change;
 *                                 `token` changes when the bridge is rebuilt
 *   moveToGroup(state, window, group) -> bool
 *   activateGroup(state, group) -> bool
 *   landInGroup(state, group, windows, moveAll)   (cross.js's land())
 *
 * where `state` is an islands MonitorState. Both return the failure value when
 * this is disabled, islands is not running, or islands is in dynamic mode.
 *
 * Session modes include unlock-dialog, like islands', and for islands' sake.
 * Disabling an extension makes the shell disable and re-enable every one
 * enabled after it. Were this disabled at lock while islands came after it in
 * that order, islands would be rebuilt without our Registry._createState
 * wrapper, sized to its own count, and fold every window past that count into
 * its last workspace; growing back on unlock cannot unfold them. Staying
 * enabled, this is always re-enabled before islands in such a rebase. Nothing
 * here does anything on the lock screen: there is no overview there.
 */

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {PrimaryStrip} from './primary.js';
import {IslandsBridge} from './islands.js';
import {CrossMonitorMove} from './cross.js';
import {UndockRegroup} from './undock.js';
import * as Strip from './strip.js';

const MAXIMIZE_OWN_UUID = 'maximize-own-workspace@zihan.local';

const DEBUG = false;

function log(message) {
    if (DEBUG)
        console.log(`workspace-manage: ${message}`);
}

export default class WorkspaceManage extends Extension {
    enable() {
        this._injector = new InjectionManager();
        this._settings = this.getSettings();
        this._resetAtLogin();

        this._primary = new PrimaryStrip(this._injector, log);
        this._primary.enable();

        this._islands = new IslandsBridge(this._injector, this._settings, log);
        this._islands.enable().catch(e =>
            console.error(`workspace-manage: islands bridge: ${e}\n${e.stack}`));

        this._cross = new CrossMonitorMove(this._primary, this._islands, log);

        this._undock = new UndockRegroup(this._islands, log);
        this._undock.enable();
        Strip.setMover((...args) => this._cross.move(...args));
        // Split View lives in maximize-own-workspace, enabled after us or not
        // at all: looked up whenever a thumbnail drag asks.
        Strip.setSplitter(() => {
            const ext = Main.extensionManager.lookup(MAXIMIZE_OWN_UUID);
            return ext?.state === ExtensionState.ACTIVE &&
                typeof ext.stateObj?.thumbnailSplitHover === 'function' ? ext.stateObj : null;
        });

        console.log('workspace-manage: enabled');
    }

    disable() {
        this._undock?.disable();
        this._undock = null;
        Strip.setMover(null);
        Strip.setSplitter(null);
        this._cross?.destroy();
        this._cross = null;
        this._islands?.disable();
        this._islands = null;

        this._primary?.disable();

        this._injector?.clear();
        this._injector = null;

        this._primary?.restoreStock();
        this._primary = null;

        this._settings = null;
    }

    /*
     * At login (shell still starting up) every monitor goes back to one
     * workspace: the primary's num-workspaces and each secondary's saved
     * count. Only then: an enable later in the session (an extension rebase,
     * re-enabling after a crash) must not fold windows together.
     */
    _resetAtLogin() {
        if (!Main.layoutManager._startingUp)
            return;
        new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'})
            .set_int('num-workspaces', 1);
        this._settings.set_string('virtual-workspace-counts', '{}');
        log('login: reset to one workspace per monitor');
    }

    insertVirtualWorkspace(state, index) {
        return this._islands?.insert(state, index) ?? -1;
    }

    removeVirtualWorkspace(state, index) {
        return this._islands?.remove(state, index) ?? false;
    }

    splitReady() {
        return this._islands?.splitReady() ?? false;
    }

    onIslandsChanged(cb) {
        const bridge = this._islands;
        if (!bridge)
            return null;
        return {token: bridge, off: bridge.onChanged(cb)};
    }

    islandsToken() {
        return this._islands ?? null;
    }

    moveToGroup(state, window, group) {
        return this._islands?.moveToGroup(state, window, group) ?? false;
    }

    activateGroup(state, group) {
        return this._islands?.activateGroup(state, group) ?? false;
    }

    landInGroup(state, group, windows, moveAll) {
        if (!this._islands)
            throw new Error('workspace-manage islands bridge is not running');
        this._islands.land(state, group, windows, moveAll);
    }
}
