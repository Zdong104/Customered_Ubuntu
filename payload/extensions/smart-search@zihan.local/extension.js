/**
 * Smart Search: Spotlight-style "Quick Answers" in the Activities overview.
 *
 * Registers an in-process search provider (Main.overview.searchController
 * .addProvider) and moves its result group to the top of the search view.
 * parser.js (pure JS) turns the query into rows; services.js does the async
 * network/cache work for currency, weather and dictionary lookups.
 *
 * Ordering: SearchResultsView keeps provider displays as children of its
 * content box in registration order and picks the default (Enter) result by
 * walking _providers in order. After addProvider() we move our display to
 * child index 0 and our provider to the front of _providers, so the group
 * sits above Applications/Files and its first row is the Enter target. The
 * group hides itself when we return no ids, so unrecognized queries leave
 * the view exactly as stock.
 *
 * Activation: rows without a URL set metaInfo.clipboardText, which the
 * shell's SearchResult.activate() copies before closing the overview; we
 * add a short OSD. Lookup rows open their URL in the default browser.
 *
 * Network rows: parse() returns {pending: key}; getInitialResultSet waits
 * 250 ms (600-1500 ms for quota-limited flight lookups), fetches (deduplicated, cached, 5 s timeouts) and
 * re-parses. When the shell cancels the search (next keystroke, overview
 * closed) the promise resolves [] immediately, before the shell starts the
 * next search, so a stale answer can never overwrite a newer one.
 *
 * Test hook: Main.extensionManager.lookup('smart-search@zihan.local')
 *   .stateObj._provider.getInitialResultSet(['36F'], new Gio.Cancellable())
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {parse} from './parser.js';
import {Services} from './services.js';
import {FlightSetupDialog} from './setupDialog.js';

const MAX_REMEMBERED = 400;
const PROVIDER_ID = 'smart-search@zihan.local';

function makeAppInfo() {
    // A real GAppInfo (the shell calls should_show()/get_name()/get_icon()
    // on it) that never launches anything: the provider header is made
    // non-reactive in _moveToTop().
    const kf = new GLib.KeyFile();
    const text = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Quick Answers',
        'Icon=accessories-calculator-symbolic',
        'Exec=true',
        '',
    ].join('\n');
    kf.load_from_data(text, new TextEncoder().encode(text).length, GLib.KeyFileFlags.NONE);
    return GioUnix.DesktopAppInfo.new_from_keyfile(kf);
}

class QuickAnswersProvider {
    constructor(services, onAction) {
        this.id = PROVIDER_ID;
        this._onAction = onAction;
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;
        this.appInfo = makeAppInfo();
        this._services = services;
        this._rows = new Map();     // result id -> row
        this._waiters = new Set();
        this._destroyed = false;
    }

    destroy() {
        this._destroyed = true;
        // Drop pending waits without resolving them: the provider is being
        // unregistered, so the shell must not get a late update for a
        // display that no longer exists. Disconnecting here is safe (we are
        // not inside a cancellable emission).
        for (const w of this._waiters) {
            w.done = true;
            if (w.timerId)
                GLib.source_remove(w.timerId);
            w.timerId = 0;
            if (w.cancelId)
                w.cancellable.disconnect(w.cancelId);
            w.cancelId = 0;
        }
        this._waiters.clear();
        this._rows.clear();
        this._services = null;
        this._onAction = null;
    }

    async getInitialResultSet(terms, cancellable) {
        if (this._destroyed)
            return [];
        const query = terms.join(' ');
        let r;
        try {
            r = parse(query, this._services.ctx());
            if (r && !Array.isArray(r) && r.pending) {
                const ok = await this._waitFor(r.pending, cancellable);
                if (!ok || this._destroyed || cancellable?.is_cancelled())
                    return [];
                r = parse(query, this._services.ctx());
            }
        } catch (e) {
            console.error(`[smart-search] parse failed for "${query}": ${e}\n${e.stack}`);
            return [];
        }
        return Array.isArray(r) ? this._remember(r) : [];
    }

    getSubsearchResultSet(_previousResults, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    getResultMetas(ids, cancellable) {
        if (cancellable?.is_cancelled())
            return Promise.resolve([]);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return Promise.resolve(ids.map(id => {
            const r = this._rows.get(id) ?? {title: '…', desc: ''};
            const meta = {
                id,
                name: r.title,
                description: r.desc,
                createIcon: size => this._createIcon(r, size, scale),
            };
            if (!r.url && r.copy)
                meta.clipboardText = r.copy;
            return meta;
        }));
    }

    filterResults(results, maxNumber) {
        return results.slice(0, maxNumber);
    }

    activateResult(id, _terms) {
        const r = this._rows.get(id);
        if (!r)
            return;
        if (r.action) {
            // e.g. 'flight-setup': the shell closes the overview right after this
            this._onAction?.(r);
            return;
        }
        if (r.url) {
            try {
                Gio.AppInfo.launch_default_for_uri(r.url, global.create_app_launch_context(0, -1));
            } catch (e) {
                Main.notifyError('Quick Answers', `Could not open ${r.url}: ${e.message}`);
            }
            return;
        }
        // the shell copies metaInfo.clipboardText right after this call
        try {
            Main.osdWindowManager.showOne(Main.layoutManager.primaryIndex,
                new Gio.ThemedIcon({name: 'edit-copy-symbolic'}), `Copied ${r.copy}`, null);
        } catch (e) {
            console.log(`[smart-search] OSD failed: ${e.message}`);
        }
    }

    launchSearch(_terms) {
    }

    _createIcon(r, size, scale) {
        if (r.color) {
            return new St.Widget({
                width: size * scale,
                height: size * scale,
                style: `background-color: ${r.color}; border-radius: ${Math.round(size / 4)}px;` +
                    ' border: 1px solid rgba(128, 128, 128, 0.6);',
            });
        }
        return new St.Icon({
            icon_name: r.icon ?? 'accessories-calculator-symbolic',
            icon_size: size,
        });
    }

    _remember(rows) {
        const ids = [];
        for (const r of rows) {
            // id encodes the content: the shell caches result actors by id
            const id = `${PROVIDER_ID}\u001f${r.title}\u001f${r.desc}\u001f${r.url ?? ''}\u001f${r.action ?? ''}${r.flight ?? ''}`;
            this._rows.delete(id);
            this._rows.set(id, r);
            ids.push(id);
        }
        for (const k of this._rows.keys()) {
            if (this._rows.size <= MAX_REMEMBERED)
                break;
            if (!ids.includes(k))
                this._rows.delete(k);
        }
        return ids;
    }

    /** Debounce, fetch `key`; resolves true when data arrived, false if the search was cancelled. */
    _waitFor(key, cancellable) {
        return new Promise(resolve => {
            const w = {done: false, timerId: 0, cancelId: 0, cancellable};
            const settle = (ok, fromCancelHandler) => {
                if (w.done)
                    return;
                w.done = true;
                if (w.timerId)
                    GLib.source_remove(w.timerId);
                w.timerId = 0;
                // g_cancellable_disconnect() from inside the cancelled
                // handler deadlocks; after it fired the handler is spent.
                if (w.cancelId && !fromCancelHandler)
                    cancellable.disconnect(w.cancelId);
                w.cancelId = 0;
                this._waiters.delete(w);
                resolve(ok);
            };
            this._waiters.add(w);
            if (cancellable) {
                const id = cancellable.connect(() => settle(false, true));
                if (w.done)
                    return; // was already cancelled; handler ran synchronously
                w.cancelId = id;
            }
            const start = () => {
                w.timerId = 0;
                this._services.fetch(key).then(() => settle(true, false));
                return GLib.SOURCE_REMOVE;
            };
            if (this._services.isInflight(key))
                start();
            else
                w.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._services.debounceFor(key), start);
        });
    }
}

export default class SmartSearchExtension extends Extension {
    enable() {
        this._services = new Services();
        this._services.start();
        this._provider = new QuickAnswersProvider(this._services, r => this._onAction(r));
        Main.overview.searchController.addProvider(this._provider);
        this._moveToTop();
    }

    disable() {
        this._cancelPendingDialog();
        this._setupDialog?.destroy();
        this._setupDialog = null;
        if (this._reopenId)
            GLib.source_remove(this._reopenId);
        this._reopenId = 0;
        if (this._provider) {
            // The view keeps a pointer to the default (Enter) result; if it
            // is one of our rows it would be used after being destroyed by
            // removeProvider() when disabling mid-search.
            const view = Main.overview.searchController._searchResults;
            if (view && view._defaultResult?.provider === this._provider)
                view._defaultResult = null;
            this._provider.destroy();
            Main.overview.searchController.removeProvider(this._provider);
            this._provider.display = null;
            this._provider = null;
        }
        this._services?.destroy();
        this._services = null;
    }

    _onAction(r) {
        if (r.action === 'flight-setup')
            this._openFlightSetup(r);
    }

    /** Open the setup dialog once the overview has finished closing. */
    _openFlightSetup(r) {
        if (this._setupDialog || !this._services)
            return;
        this._cancelPendingDialog();
        const open = () => {
            this._cancelPendingDialog();
            if (this._setupDialog || !this._services)
                return;
            const dialog = new FlightSetupDialog({
                services: this._services,
                flight: r.flight,
                onDone: () => this._reopenSearch(r.query),
            });
            dialog.connect('destroy', () => {
                if (this._setupDialog === dialog)
                    this._setupDialog = null;
            });
            this._setupDialog = dialog;
            if (!dialog.open()) {
                dialog.destroy();
                Main.notifyError('Quick Answers', 'Could not open the flight status setup. Try again.');
            }
        };
        if (Main.overview.visible || Main.overview.animationInProgress) {
            this._hiddenId = Main.overview.connect('hidden', open);
            // safety net if 'hidden' never comes
            this._openTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._openTimeoutId = 0;
                open();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            open();
        }
    }

    _cancelPendingDialog() {
        if (this._hiddenId)
            Main.overview.disconnect(this._hiddenId);
        this._hiddenId = 0;
        if (this._openTimeoutId)
            GLib.source_remove(this._openTimeoutId);
        this._openTimeoutId = 0;
    }

    /** After a successful setup, show the searched flight again (now with its card). */
    _reopenSearch(query) {
        if (!query || !this._services)
            return;
        try {
            Main.overview.show();
            if (this._reopenId)
                GLib.source_remove(this._reopenId);
            this._reopenId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._reopenId = 0;
                Main.overview.searchEntry?.set_text(query);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.log(`[smart-search] could not reopen the search: ${e.message}`);
        }
    }

    _moveToTop() {
        const p = this._provider;
        try {
            const providers = Main.overview.searchController._searchResults?._providers;
            if (Array.isArray(providers)) {
                const i = providers.indexOf(p);
                if (i > 0) {
                    providers.splice(i, 1);
                    providers.unshift(p);
                }
            }
            const display = p.display;
            display?.get_parent()?.set_child_at_index(display, 0);
            if (display?.providerInfo) {
                display.providerInfo.reactive = false;
                display.providerInfo.can_focus = false;
            }
        } catch (e) {
            console.error(`[smart-search] could not move Quick Answers to the top: ${e}`);
        }
    }
}
