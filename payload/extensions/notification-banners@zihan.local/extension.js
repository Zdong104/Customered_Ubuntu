/**
 * Three changes to GNOME Shell's banner logic (js/ui/messageTray.js, GNOME 50):
 *
 * 1. 5-second cap. Stock banners only start their 4 s timeout once the user
 *    is active: if you are idle (>1 s without input) when a banner appears it
 *    stays until you move, then 2 s more; CRITICAL banners (Chrome uses it
 *    for Teams) never time out. Here every banner is expired MAX_BANNER_MS
 *    after it starts showing, unless the pointer is on it or it holds key
 *    focus (then it is re-checked every HOVER_RECHECK_MS). Expiring only
 *    hides the banner; the notification stays in the message list.
 *
 * 2. One banner, always the newest. Stock queues banners (sorted by urgency)
 *    and shows them one after another, each waiting for its own timeout, so
 *    old messages pop up minutes later. Here a new banner replaces the one on
 *    screen at once (unless it holds key focus), only the newest pending
 *    notification is kept in the banner queue, and one that waited more than
 *    MAX_QUEUE_WAIT_MS (e.g. during DND) is dropped. Dropped/superseded
 *    notifications stay in the message list. An update to the banner on
 *    screen restarts its 5 s.
 *
 * 3. Full-screen pass-through. Stock _updateState queues (does not show) any
 *    non-critical banner while the primary monitor has a full-screen window
 *    -- and maximize-own-workspace's full-screen spaces are real fullscreen.
 *    Here only notifications from an app with a window in front of you (on
 *    the active workspace, not minimized, on the monitor you are working on)
 *    are skipped; everything else shows. Do Not Disturb still holds banners.
 *
 * Both are prototype patches. dnd-hides-critical@zihan.local wraps the
 * instance's _updateState and calls the prototype method at call time, so
 * the two chain in either enable order.
 *
 * Journal lines tagged [notif-banners] record, per notification, the app,
 * urgency and whether the banner was shown or held (no message content).
 */
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const MAX_BANNER_MS = 5000;
const HOVER_RECHECK_MS = 500;
// A banner that could not be shown within this long is dropped, so old
// messages never pop up minutes later.
const MAX_QUEUE_WAIT_MS = 10000;
const TAG = '[notif-banners]';
// Diagnostics: logs every notification's app name to the journal when true.
const DEBUG = false;
const dbg = msg => { if (DEBUG) console.log(msg); };

function appOf(source) {
    if (source?.app)
        return source.app;
    if (source?._window)
        return Shell.WindowTracker.get_default().get_window_app(source._window);
    return null;
}

function appLabel(n) {
    const app = appOf(n?.source);
    return app?.get_id() ?? n?.source?.title ?? '?';
}

// Is a window of the notifying app visible in front of the user right now?
function appInFront(notification) {
    const app = appOf(notification?.source);
    if (!app)
        return false;
    const ws = global.workspace_manager.get_active_workspace();
    const focus = global.display.focus_window;
    const monitor = focus ? focus.get_monitor() : global.display.get_current_monitor();
    return app.get_windows().some(w =>
        !w.minimized &&
        w.get_monitor() === monitor &&
        (w.is_on_all_workspaces() || w.located_on_workspace(ws)) &&
        w.get_compositor_private()?.visible);
}

export default class NotificationBannersExtension extends Extension {
    enable() {
        this._inj = new InjectionManager();
        this._capId = 0;
        const proto = Object.getPrototypeOf(Main.messageTray);
        const ext = this;

        // Remember when each notification (re-)entered the banner queue, so
        // "stale" means "waited too long as a banner", not "old notification".
        let lastQueued = new Set();
        const queuedAt = new WeakMap();

        this._inj.overrideMethod(proto, '_updateState', orig => function (...args) {
            const mon = Main.layoutManager.primaryMonitor;
            const fullscreen = !!mon?.inFullscreen;
            const now = GLib.get_monotonic_time();
            const queue = (this._notificationQueue ?? []).filter(n => !n.acknowledged);
            for (const n of queue) {
                if (!lastQueued.has(n))
                    queuedAt.set(n, now);
            }

            // Only the newest pending notification may become a banner.
            // Everything else is dropped from the banner queue (it stays in
            // the message list): stale ones, ones whose app is in front of you
            // during full-screen, and ones superseded by a newer one.
            const drop = (n, why) => dbg(`${TAG} dropped (${why}): ${appLabel(n)}`);
            let keep = queue.filter(n => {
                if ((now - queuedAt.get(n)) / 1000 > MAX_QUEUE_WAIT_MS) {
                    drop(n, 'stale');
                    return false;
                }
                if (fullscreen && n.urgency !== MessageTray.Urgency.CRITICAL &&
                    !n.forFeedback && appInFront(n)) {
                    drop(n, 'full-screen, app in front');
                    return false;
                }
                return true;
            });
            if (keep.length > 1) {
                // Ones first seen in the same call (e.g. queued before
                // enable) tie on queuedAt; fall back to the notification's
                // own time so the newest still wins.
                keep.sort((a, b) => (queuedAt.get(b) - queuedAt.get(a)) ||
                    (a.datetime && b.datetime ? b.datetime.difference(a.datetime) : 0));
                keep.slice(1).forEach(n => drop(n, 'superseded'));
                keep = keep.slice(0, 1);
            }
            if (keep.length !== (this._notificationQueue ?? []).length ||
                keep[0] !== this._notificationQueue[0]) {
                this._notificationQueue = keep;
                this.emit('queue-changed');
            }
            lastQueued = new Set(keep);

            // A new banner replaces the one on screen right away (unless you
            // are typing into it). Stock waits for the current one to time out.
            const showing = this._notificationState === MessageTray.State.SHOWN ||
                this._notificationState === MessageTray.State.SHOWING;
            if (showing && keep.length && !this._notificationFocusGrabber?._focused) {
                dbg(`${TAG} replacing ${appLabel(this._notification)} with ${appLabel(keep[0])}`);
                this._notificationExpired = true;
            }

            // Full-screen no longer holds banners (DND still does).
            let patched = false;
            if (this._notificationState === MessageTray.State.HIDDEN && keep.length &&
                fullscreen && !this._busy) {
                Object.defineProperty(mon, 'inFullscreen', {value: false, configurable: true});
                patched = true;
            }
            try {
                return orig.apply(this, args);
            } finally {
                if (patched)
                    delete mon.inFullscreen; // back to the prototype getter
            }
        });

        // An update to the banner on screen (same notification, new content)
        // gets a fresh 5 s.
        this._inj.overrideMethod(proto, '_updateShowingNotification', orig => function (...args) {
            const r = orig.apply(this, args);
            ext._arm(this, this._notification, MAX_BANNER_MS);
            return r;
        });

        this._inj.overrideMethod(proto, '_showNotification', orig => function (...args) {
            const r = orig.apply(this, args);
            const n = this._notification;
            dbg(`${TAG} banner: ${appLabel(n)} urgency=${n?.urgency}`);
            return r;
        });

        this._inj.overrideMethod(proto, '_hideNotification', orig => function (...args) {
            ext._disarm();
            return orig.apply(this, args);
        });

        // Log every notification that arrives, so "no banner" can be told
        // apart from "the app never sent one".
        const watch = source => source.connectObject('notification-added', (_s, n) =>
            dbg(`${TAG} received: ${appLabel(n)} urgency=${n.urgency} ` +
                `dnd=${!!Main.messageTray._busy} ` +
                `fullscreen=${!!Main.layoutManager.primaryMonitor?.inFullscreen}`), this);
        Main.messageTray.getSources().forEach(watch);
        Main.messageTray.connectObject('source-added', (_t, s) => watch(s), this);
    }

    _arm(tray, notification, ms) {
        this._disarm();
        this._capId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._capId = 0;
            if (tray._notification !== notification ||
                (tray._notificationState !== MessageTray.State.SHOWN &&
                 tray._notificationState !== MessageTray.State.SHOWING))
                return GLib.SOURCE_REMOVE;
            if (tray._pointerInNotification || tray._notificationFocusGrabber?._focused) {
                this._arm(tray, notification, HOVER_RECHECK_MS);
                return GLib.SOURCE_REMOVE;
            }
            tray._notificationExpired = true;
            tray._updateState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _disarm() {
        if (this._capId) {
            GLib.source_remove(this._capId);
            this._capId = 0;
        }
    }

    disable() {
        this._disarm();
        Main.messageTray.disconnectObject(this);
        Main.messageTray.getSources().forEach(s => s.disconnectObject(this));
        this._inj.clear();
        this._inj = null;
    }
}
