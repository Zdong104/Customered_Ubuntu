/**
 * notification-tidy, implementation 1 (loaded by extension.js; add impl-2.js
 * and disable/enable to reload a tweak without a relogin).
 *
 * A. Clear an app's notifications once you have looked at the app.
 *    Ubuntu Dock badges an app with the notifications left in its tray
 *    source; WeChat never withdraws them, so its badge never clears. Here an
 *    app counts as "seen" when its window has the focus, the session is
 *    unlocked and there was input within ACTIVE_IDLE_MS:
 *      - focus moves to the app and stays FOCUS_DELAY_MS;
 *      - a notification arrives for the focused app and it is still focused
 *        (and you are still active) ADDED_DELAY_MS later;
 *      - you come back from >= ACTIVE_IDLE_MS idle with the app focused, and
 *        it is still focused FOCUS_DELAY_MS later.
 *    Then every non-resident notification in that app's sources is destroyed
 *    as DISMISSED (the app gets NotificationClosed reason 2); resident ones
 *    are only marked acknowledged. Sources without an app are never touched.
 *
 * B. File Chrome PWA notifications under the PWA. Chrome sends every site's
 *    notification as desktop-entry=google-chrome; the only per-site signal is
 *    the first body line (the origin host). FdoNotificationDaemon.NotifyAsync
 *    is wrapped on the instance (GJS's wrapJSObject looks the method up on
 *    each D-Bus call), and for a new notification whose host is in the table
 *    _getApp is made to return the PWA's app for that one call. Updates
 *    (replacesId) keep their source, and actions still go to Chrome.
 *
 * Journal lines are tagged [notif-tidy] and never contain message content.
 * The per-event "cleared" / "routed" lines are only written with DEBUG = true.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const TAG = '[notif-tidy]';
const DEBUG = false;
const dbg = msg => { if (DEBUG) console.log(msg); };
const FOCUS_DELAY_MS = 1000;
const ADDED_DELAY_MS = 6000;
// "The user is active" = some input within this long. Also the idle span
// after which the next input counts as "coming back".
const ACTIVE_IDLE_MS = 6000;
const CHROME_ID = 'google-chrome.desktop';

const TEAMS = 'chrome-cifhbcnohmdccbgoicgdjpfamggdegmo-Default.desktop';
const OUTLOOK = 'chrome-eoficlgicibekocmfdomjbfnjmehnhcd-Default.desktop';
const GCHAT = 'chrome-pommaclcbfghclhalboakcipcmmndhcj-Default.desktop';
const CRD = 'chrome-cmkncekebbebpfilplodngbpllndjkfo-Default.desktop';

// origin host (or parent domain) -> PWA desktop id
const DEFAULT_MAP = {
    'teams.microsoft.com': TEAMS,
    'teams.cloud.microsoft': TEAMS,
    'teams.live.com': TEAMS,
    'outlook.office.com': OUTLOOK,
    'outlook.office365.com': OUTLOOK,
    'outlook.cloud.microsoft': OUTLOOK,
    'outlook.live.com': OUTLOOK,
    'chat.google.com': GCHAT,
    'remotedesktop.google.com': CRD,
};

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function appOfSource(source) {
    const app = source?.app ?? source?._app ?? null;
    return app instanceof Shell.App ? app : null;
}

function normHost(s) {
    if (typeof s !== 'string')
        return null;
    const h = s.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    return HOST_RE.test(h) ? h : null;
}

function unpack(v) {
    return v instanceof GLib.Variant ? v.deepUnpack() : v;
}

export class Impl {
    enable() {
        this._timers = new Map();
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._mapStamp = undefined;
        this._table = null;
        this._mapPath = GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'notification-tidy', 'pwa-map.json']);

        this._tracker = Shell.WindowTracker.get_default();
        this._idle = global.backend.get_core_idle_monitor();

        // --- A: clear on engagement
        this._tracker.connectObject('notify::focus-app', () => this._onFocusApp(), this);
        const watch = source => source.connectObject('notification-added',
            (s, n) => this._onNotificationAdded(s, n), this);
        Main.messageTray.getSources().forEach(watch);
        Main.messageTray.connectObject('source-added', (_t, s) => watch(s), this);
        this._idleWatchId = this._idle.add_idle_watch(ACTIVE_IDLE_MS, () => this._onIdle());

        // --- B: route Chrome PWA notifications
        this._installRouter();
    }

    disable() {
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        if (this._idleWatchId)
            this._idle.remove_watch(this._idleWatchId);
        if (this._activeWatchId)
            this._idle.remove_watch(this._activeWatchId);
        this._idleWatchId = this._activeWatchId = 0;

        this._tracker.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        Main.messageTray.getSources().forEach(s => s.disconnectObject(this));

        this._removeRouter();
        this._tracker = null;
        this._idle = null;
    }

    // ---------------------------------------------------------------- A

    _schedule(name, ms, fn) {
        this._cancel(name);
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _cancel(name) {
        const id = this._timers.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timers.delete(name);
        }
    }

    _engaged(app) {
        return !!app &&
            !Main.sessionMode.isLocked && !Main.screenShield?.locked &&
            this._tracker.focus_app === app &&
            this._idle.get_idletime() < ACTIVE_IDLE_MS;
    }

    // Arm a delayed check for the focused app.
    _checkLater(name, ms) {
        const app = this._tracker.focus_app;
        if (!app) {
            this._cancel(name);
            return;
        }
        this._schedule(name, ms, () => {
            if (this._engaged(app))
                this._clear(app);
        });
    }

    _onFocusApp() {
        this._cancel('added');
        this._checkLater('focus', FOCUS_DELAY_MS);
    }

    _onNotificationAdded(source, _notification) {
        const app = appOfSource(source);
        if (app && app === this._tracker.focus_app)
            this._checkLater('added', ADDED_DELAY_MS);
    }

    // Idle for ACTIVE_IDLE_MS: the next input is "coming back".
    _onIdle() {
        if (this._activeWatchId)
            return;
        this._activeWatchId = this._idle.add_user_active_watch(() => {
            this._activeWatchId = 0;
            this._checkLater('active', FOCUS_DELAY_MS);
        });
    }

    _clear(app) {
        const id = app.get_id();
        let cleared = 0, acked = 0;
        for (const source of [...Main.messageTray.getSources()]) {
            if (appOfSource(source)?.get_id() !== id)
                continue;
            for (const n of [...source.notifications]) {
                if (n.resident) {
                    if (!n.acknowledged) {
                        n.acknowledged = true;
                        acked++;
                    }
                } else {
                    n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
                    cleared++;
                }
            }
        }
        if (cleared || acked)
            dbg(`${TAG} cleared ${cleared} for ${id}${acked ? ` (acknowledged ${acked} resident)` : ''}`);
    }

    // ---------------------------------------------------------------- B

    _installRouter() {
        const daemon = Main.notificationDaemon?._fdoNotificationDaemon;
        if (!daemon || typeof daemon.NotifyAsync !== 'function') {
            console.warn(`${TAG} no FdoNotificationDaemon; PWA routing off`);
            return;
        }
        const impl = this;
        const orig = daemon.NotifyAsync;
        const wrapper = function (params, invocation) {
            let app = null;
            if (impl._wrapper === wrapper) {
                try {
                    app = impl._pwaAppFor(this, params);
                } catch (e) {
                    logError(e, `${TAG} routing`);
                }
            }
            if (!app)
                return orig.call(this, params, invocation);
            const hadOwn = Object.hasOwn(this, '_getApp');
            const prev = this._getApp;
            this._getApp = () => app;
            try {
                return orig.call(this, params, invocation);
            } finally {
                if (hadOwn)
                    this._getApp = prev;
                else
                    delete this._getApp;
            }
        };
        this._daemon = daemon;
        this._hadOwnNotify = Object.hasOwn(daemon, 'NotifyAsync');
        this._origNotify = orig;
        this._wrapper = wrapper;
        daemon.NotifyAsync = wrapper;
    }

    _removeRouter() {
        const daemon = this._daemon;
        if (!daemon)
            return;
        if (daemon.NotifyAsync === this._wrapper) {
            if (this._hadOwnNotify)
                daemon.NotifyAsync = this._origNotify;
            else
                delete daemon.NotifyAsync;
        } else {
            console.warn(`${TAG} NotifyAsync was re-wrapped by someone else; leaving a pass-through`);
        }
        this._wrapper = null; // a left-behind wrapper now passes straight through
        this._daemon = null;
        this._origNotify = null;
    }

    // The PWA's Shell.App for a new Chrome notification whose origin host is
    // in the table, else null.
    _pwaAppFor(daemon, params) {
        const [appName, replacesId, , , body, , hints] = params;
        if (replacesId !== 0 && daemon._notifications?.has(replacesId))
            return null;
        const entry = unpack(hints?.['desktop-entry']);
        if (appName !== 'Google Chrome' && entry !== 'google-chrome')
            return null;

        const host = normHost(String(body ?? '').split('\n', 1)[0]);
        if (!host)
            return null;
        const target = this._lookupHost(host);
        if (!target)
            return null;
        const pwa = Shell.AppSystem.get_default().lookup_app(target);
        if (!pwa)
            return null;

        // What the stock code would pick. Chrome's browser pid can map to a
        // PWA window's app as well as to Chrome itself.
        const pid = unpack(hints?.['x-shell-sender-pid']) ?? 0;
        const cur = daemon._getApp(pid, entry, appName);
        const curId = cur?.get_id() ?? null;
        if (!curId || cur === pwa ||
            (curId !== CHROME_ID && !/^chrome-[a-p]{32}-/.test(curId)))
            return null;

        dbg(`${TAG} routed ${curId.replace(/\.desktop$/, '')} → ${target} (${host})`);
        return pwa;
    }

    _lookupHost(host) {
        const table = this._loadTable();
        let best = null;
        for (const [key, id] of Object.entries(table)) {
            if (!id || (host !== key && !host.endsWith(`.${key}`)))
                continue;
            if (!best || key.length > best.length)
                best = key;
        }
        return best ? table[best] : null;
    }

    // Built-in table plus ~/.config/notification-tidy/pwa-map.json, re-read
    // when the file's mtime changes. A user value of null drops a built-in.
    _loadTable() {
        const file = Gio.File.new_for_path(this._mapPath);
        let stamp = null;
        try {
            const info = file.query_info('time::modified,time::modified-usec',
                Gio.FileQueryInfoFlags.NONE, null);
            stamp = `${info.get_attribute_uint64('time::modified')}.` +
                `${info.get_attribute_uint32('time::modified-usec')}`;
        } catch {
            stamp = null; // no file
        }
        if (this._table && stamp === this._mapStamp)
            return this._table;

        const table = {...DEFAULT_MAP};
        if (stamp !== null) {
            try {
                const [, bytes] = file.load_contents(null);
                const user = JSON.parse(new TextDecoder().decode(bytes));
                if (!user || typeof user !== 'object' || Array.isArray(user))
                    throw new Error('top level must be an object');
                for (const [k, v] of Object.entries(user)) {
                    const host = normHost(k);
                    if (!host) {
                        console.warn(`${TAG} pwa-map: ignoring bad host "${k}"`);
                    } else if (v === null || v === '') {
                        delete table[host];
                    } else if (typeof v === 'string') {
                        table[host] = v.endsWith('.desktop') ? v : `${v}.desktop`;
                    } else {
                        console.warn(`${TAG} pwa-map: ignoring "${k}" (value must be a desktop id)`);
                    }
                }
            } catch (e) {
                console.warn(`${TAG} pwa-map.json unreadable, using built-ins: ${e.message}`);
            }
        }
        this._mapStamp = stamp;
        this._table = table;
        return table;
    }
}
