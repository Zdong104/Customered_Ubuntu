/**
 * Make Do Not Disturb hide every banner, critical ones included.
 *
 * Stock MessageTray._onNotificationRequestBanner skips the banner when the
 * source's policy has showBanners off (DND, or banners off for that app)
 * unless the notification is CRITICAL. Chrome maps a site's
 * requireInteraction to CRITICAL, so every Teams chat message shows a banner
 * through DND, and there is no setting for it in GNOME or Chrome.
 *
 * That handler is bound per source when the source is added, so patching the
 * prototype would miss sources that already exist. Instead wrap the
 * instance's _updateState, which every banner request ends in, and drop
 * queued notifications whose policy says no banners before the original
 * picks the next one to show. The message list is fed by the source
 * directly, not by this queue, so the notifications still land there.
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class DndHidesCriticalExtension extends Extension {
    enable() {
        const tray = Main.messageTray;
        const orig = tray._updateState;

        tray._updateState = function () {
            const queue = this._notificationQueue.filter(
                n => n.source?.policy?.showBanners !== false);
            if (queue.length !== this._notificationQueue.length) {
                this._notificationQueue = queue;
                this.emit('queue-changed');
            }
            return orig.call(this);
        };
    }

    disable() {
        // The original is the prototype method; dropping the own property
        // restores it.
        delete Main.messageTray._updateState;
    }
}
