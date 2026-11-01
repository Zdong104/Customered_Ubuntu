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
 *
 * Every monitor starts with one workspace, and workspaces added by hand stay
 * when empty. Both kinds of monitor behave the same:
 *
 *   primary     stock GNOME workspaces in its ThumbnailsBox (primary.js), with
 *               Mutter's static workspaces: dynamic-workspaces=false, and
 *               num-workspaces holds the count across sessions.
 *   secondary   Workspace Islands' virtual workspaces in its own strip
 *               (islands.js), the count per connector in this extension's
 *               settings.
 *
 * strip.js has what the two share: the buttons and the reorder drag.
 *
 * API for maximize-own-workspace (through `stateObj`, like it reaches islands):
 *
 *   insertVirtualWorkspace(state, index) -> index, or -1
 *   removeVirtualWorkspace(state, index) -> bool   (windows go to a neighbour)
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

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PrimaryStrip} from './primary.js';
import {IslandsBridge} from './islands.js';

const DEBUG = false;

function log(message) {
    if (DEBUG)
        console.log(`workspace-manage: ${message}`);
}

export default class WorkspaceManage extends Extension {
    enable() {
        this._injector = new InjectionManager();
        this._settings = this.getSettings();

        this._primary = new PrimaryStrip(this._injector, log);
        this._primary.enable();

        this._islands = new IslandsBridge(this._injector, this._settings, log);
        this._islands.enable().catch(e =>
            console.error(`workspace-manage: islands bridge: ${e}\n${e.stack}`));

        console.log('workspace-manage: enabled');
    }

    disable() {
        this._islands?.disable();
        this._islands = null;

        this._primary?.disable();

        this._injector?.clear();
        this._injector = null;

        this._primary?.restoreStock();
        this._primary = null;

        this._settings = null;
    }

    insertVirtualWorkspace(state, index) {
        return this._islands?.insert(state, index) ?? -1;
    }

    removeVirtualWorkspace(state, index) {
        return this._islands?.remove(state, index) ?? false;
    }
}
