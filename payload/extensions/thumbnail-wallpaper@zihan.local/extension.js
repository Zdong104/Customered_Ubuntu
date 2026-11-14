/**
 * Draw the wallpaper behind the overview's workspace thumbnails.
 *
 * Since GNOME 40 the stock thumbnails (WorkspaceThumbnail, the strip above the
 * primary monitor's overview) hold window clones only, over the theme's flat
 * grey. workspace-islands' own strip on secondary monitors puts the wallpaper
 * behind its thumbnails, so with an external display the two strips disagreed.
 * This gives the stock ones the same backdrop.
 *
 * One seam: WorkspaceThumbnail._init. Its `_contents` is laid out in stage
 * coordinates (clones sit at their real screen positions and `setPorthole`
 * shifts the whole thing by the work area's origin), so a BackgroundManager
 * with `controlPosition` places the wallpaper at the monitor's stage origin
 * and it lines up with the clones on its own. It goes in below every clone.
 *
 * Thumbnails are rebuilt on every overview entry, so enable/disable only
 * affect the next one.
 */

import Meta from 'gi://Meta';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceThumbnail} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

/**
 * Whether `index` names a monitor Mutter still has. On a multi-step undock
 * (primary DP-x -> DP-y -> eDP-1 within ~2 s) a thumbnail can outlive its
 * monitor; a BackgroundManager for it then fails Mutter's assertions
 * (get_monitor_geometry / get_monitor_scale).
 */
function isValidMonitor(index) {
    return Number.isInteger(index) && index >= 0 &&
        index < global.display.get_n_monitors() &&
        !!Main.layoutManager.monitors[index];
}

export default class ThumbnailWallpaperExtension extends Extension {
    enable() {
        this._injector = new InjectionManager();

        const thumbnail = WorkspaceThumbnail?.prototype;
        if (typeof thumbnail?._init !== 'function') {
            console.warn('thumbnail-wallpaper: WorkspaceThumbnail._init not found');
            return;
        }

        this._injector.overrideMethod(thumbnail, '_init',
            originalMethod => function (...args) {
                originalMethod.call(this, ...args);

                if (!this._contents)
                    return;

                const group = new Meta.BackgroundGroup();
                this._contents.insert_child_below(group, null);

                let manager = null;
                const drop = () => {
                    manager?.destroy();
                    manager = null;
                };
                // Only for a monitor that exists now; otherwise wait for the
                // next monitors-changed (by then the thumbnail is usually
                // rebuilt anyway). A change also drops a backdrop whose
                // monitor went away or changed, instead of keeping stale data.
                const attach = () => {
                    drop();
                    if (!isValidMonitor(this.monitorIndex))
                        return;
                    manager = new Background.BackgroundManager({
                        container: group,
                        monitorIndex: this.monitorIndex,
                    });
                };
                attach();

                Main.layoutManager.connectObject('monitors-changed', attach, this);
                this.connect('destroy', drop);
            });
    }

    disable() {
        this._injector?.clear();
        this._injector = null;
    }
}
