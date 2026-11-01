/**
 * Bring the browser forward when another app opens a link in it.
 *
 * WeChat and friends hand the URL to Chrome via xdg-open (or the OpenURI
 * portal) without an activation token. Chrome passes the URL to its running
 * instance, which opens a tab in its last-used window but is not allowed to
 * raise it: Mutter drops an xdg-activation request whose token it does not
 * know without even marking the window as demanding attention. The tab opens
 * off-screen, and clicking again just opens more tabs.
 *
 * So the trigger is the launch itself. Every GIO launch of a desktop file
 * (xdg-open -> gio open, and the portal) broadcasts
 * org.gtk.gio.DesktopAppInfo.Launched on the session bus. When that names the
 * browser, activate its most recently used window; if Chrome had no window
 * and makes a new one for the link, activate that once it is shown.
 * window-demands-attention / window-marked-urgent are still handled for the
 * cases where the request does reach Mutter.
 *
 * Main.activateWindow switches workspace and un-minimizes; workspace-islands
 * follows an un-minimized parked window to its virtual workspace on its own.
 *
 * Only the browser itself. Chrome PWAs (Outlook, Teams) have their own
 * chrome-*-Default.desktop ids and wm classes and mark themselves urgent on
 * new messages; those must keep notifying, not steal focus.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BROWSER_APP_IDS = new Set([
    'google-chrome.desktop',
    'com.google.Chrome.desktop',
]);
const BROWSER_WM_CLASSES = new Set(['google-chrome', 'Google-chrome']);

/** Long enough for Chrome to hand the URL over and map a fresh window. */
const NEW_WINDOW_GRACE_MS = 4000;
/** Lets the tab land before the window comes up. */
const RAISE_DELAY_MS = 150;

function isBrowser(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    if (BROWSER_APP_IDS.has(app?.get_id()))
        return true;
    return BROWSER_WM_CLASSES.has(window.get_wm_class());
}

function mostRecentBrowserWindow() {
    return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
        .find(isBrowser) ?? null;
}

function raise(window, why) {
    if (!window || window.has_focus())
        return;
    console.log(`raise-browser: activating "${window.get_title()}" (${why})`);
    Main.activateWindow(window);
}

export default class RaiseBrowserExtension extends Extension {
    enable() {
        this._launchedUntil = 0;
        this._raiseSource = 0;

        const onAttention = (_display, window) => {
            if (window && isBrowser(window))
                raise(window, 'demands attention');
        };
        global.display.connectObject(
            'window-demands-attention', onAttention,
            'window-marked-urgent', onAttention,
            'window-created', (_display, window) => this._onWindowCreated(window),
            this);

        this._launchedId = Gio.DBus.session.signal_subscribe(
            null, 'org.gtk.gio.DesktopAppInfo', 'Launched',
            '/org/gtk/gio/DesktopAppInfo', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => this._onLaunched(params));
    }

    _onLaunched(params) {
        const [desktopFile] = params.deepUnpack();
        const path = new TextDecoder().decode(desktopFile).replace(/\0+$/, '');
        if (!BROWSER_APP_IDS.has(GLib.path_get_basename(path)))
            return;

        this._launchedUntil = GLib.get_monotonic_time() + NEW_WINDOW_GRACE_MS * 1000;
        if (this._raiseSource)
            GLib.source_remove(this._raiseSource);
        this._raiseSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RAISE_DELAY_MS, () => {
            this._raiseSource = 0;
            raise(mostRecentBrowserWindow(), 'link opened by another app');
            return GLib.SOURCE_REMOVE;
        });
    }

    _onWindowCreated(window) {
        if (GLib.get_monotonic_time() > this._launchedUntil)
            return;
        // The app id and wm class are only settled once the window is shown.
        const id = window.connect('shown', () => {
            window.disconnect(id);
            if (isBrowser(window))
                raise(window, 'new window for opened link');
        });
    }

    disable() {
        global.display.disconnectObject(this);
        if (this._launchedId)
            Gio.DBus.session.signal_unsubscribe(this._launchedId);
        this._launchedId = 0;
        if (this._raiseSource)
            GLib.source_remove(this._raiseSource);
        this._raiseSource = 0;
    }
}
