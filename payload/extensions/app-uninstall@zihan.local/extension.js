/**
 * App Uninstall.
 *
 * Adds "Uninstall" (or "Remove from App List" for the user's own launchers)
 * to the app icon menu: the app grid and its folders, overview search results
 * and the stock dash all use appMenu.js AppMenu; the Ubuntu Dock / Dash to
 * Dock builds its own DockAppIconMenu. The menu opens on right click, the
 * Menu key and press-and-hold (AppIcon's Clutter.LongPressGesture, which also
 * fires for a held mouse button).
 *
 * Which apps get the item comes from classify.py, run asynchronously in a
 * subprocess at startup and whenever the installed apps change (see its
 * header for how the protected set is derived). Apps Ubuntu ships get no item.
 *
 * Choosing the item opens a confirmation dialog that first simulates the
 * removal (PackageKit for debs, snapd/flatpak checks), refuses when it would
 * take any protected or critical package, install/upgrade anything, or more
 * than MAX_PACKAGES packages, and otherwise lists exactly what goes. Cancel
 * is the default button. The removal itself runs asynchronously; progress
 * and the result are shell notifications. Authorization is polkit's standard
 * password dialog (PackageKit / snapd ask it); a cancelled password,
 * a busy package manager and errors all end in a notification.
 *
 * Test hook: APP_UNINSTALL_DRY_RUN=1 in the shell's environment turns deb
 * removals into a PackageKit simulation of the very same call and skips
 * snap/flatpak removals (launchers still go to the Trash).
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import * as Backends from './backends.js';
import {UninstallDialog} from './dialog.js';

// The dock Ubuntu ships (and preload enables). The upstream Dash to Dock
// extension is not hooked in this copy.
const DOCK_UUIDS = ['ubuntu-dock@ubuntu.com'];
const MAX_PACKAGES = 15;
const DRY_RUN = GLib.getenv('APP_UNINSTALL_DRY_RUN') === '1';
const TAG = '[app-uninstall]';

/** Runs classify.py off the main loop and keeps its latest answer. */
class Classifier {
    constructor(dir, onChanged) {
        this._script = dir.get_child('classify.py').get_path();
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._timer = 0;
        this._running = false;
        this._again = false;
        this.data = null;
    }

    schedule(delayMs = 1500) {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, delayMs, () => {
            this._timer = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async refresh() {
        if (this._running) {
            this._again = true;
            return;
        }
        this._running = true;
        try {
            // the system interpreter, not whatever python3 is first in PATH
            const python = GLib.file_test('/usr/bin/python3', GLib.FileTest.IS_EXECUTABLE)
                ? '/usr/bin/python3' : GLib.find_program_in_path('python3');
            const proc = Gio.Subprocess.new([python, '-I', this._script],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const [out, err] = await proc.communicate_utf8_async(null, this._cancellable);
            if (!proc.get_successful())
                throw new Error(`classify.py failed: ${err}`);
            const data = JSON.parse(out);
            data.byPkg = {};
            data.bySnap = {};
            for (const [id, r] of Object.entries(data.apps)) {
                if (r.pkg)
                    (data.byPkg[r.pkg] ??= []).push(id);
                if (r.snap)
                    (data.bySnap[r.snap] ??= []).push(id);
            }
            data.critical = new RegExp(data.criticalRe);
            this.data = data;
            this._onChanged();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                console.error(`${TAG} ${e}`);
                this._failedAt = GLib.get_monotonic_time();
            }
        } finally {
            this._running = false;
            if (this._again && !this._cancellable.is_cancelled()) {
                this._again = false;
                this.schedule(500);
            }
        }
    }

    /** Load on demand (menu opened before the first run), at most every 30 s after a failure. */
    ensure() {
        if (this.data || this._running || this._timer)
            return;
        if (this._failedAt && GLib.get_monotonic_time() - this._failedAt < 30 * GLib.USEC_PER_SEC)
            return;
        this.schedule(0);
    }

    lookup(appId) {
        return this.data?.apps?.[appId] ?? null;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }
}

function formatSize(bytes) {
    return bytes ? GLib.format_size(bytes) : '';
}

export default class AppUninstallExtension extends Extension {
    enable() {
        this._injections = new InjectionManager();
        this._items = new Set();
        this._busy = new Set();
        this._dialog = null;
        this._generation = (this._generation ?? 0) + 1;
        this._dockIconClass = null;
        this._dockMenuPatched = false;

        this._classifier = new Classifier(this.dir, () => this._syncAll());
        this._classifier.schedule(3000);
        Shell.AppSystem.get_default().connectObject('installed-changed',
            () => this._classifier.schedule(2000), this);

        const self = this;
        // AppMenu has no open() of its own, so disable() simply deletes this.
        this._injections.overrideMethod(AppMenu.prototype, 'open', original => function (...args) {
            try {
                self._prepareAppMenu(this);
            } catch (e) {
                console.error(`${TAG} app menu: ${e}\n${e.stack}`);
            }
            return original.apply(this, args);
        });

        Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
            if (DOCK_UUIDS.includes(ext?.uuid) && ext.state === ExtensionState.ACTIVE)
                this._hookDock().catch(e => console.error(`${TAG} dock: ${e}`));
        }, this);
        this._hookDock().catch(e => console.error(`${TAG} dock: ${e}`));
    }

    disable() {
        this._generation++;
        this._injections.clear();
        this._injections = null;
        Shell.AppSystem.get_default().disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        this._classifier.destroy();
        this._classifier = null;
        for (const entry of [...this._items]) {
            entry.separator?.destroy();
            entry.item.destroy();
            if (entry.menu?._appUninstall === entry)
                delete entry.menu._appUninstall;
        }
        this._items.clear();
        this._dialog?.close();
        this._dialog = null;
        this._dockIconClass = null;
        this._dockMenuPatched = false;
        // running removals finish on their own and only post notifications
    }

    // ---- menu items -----------------------------------------------------------

    _newItem(menu, getApp, separator = null) {
        const item = new PopupMenu.PopupMenuItem('Uninstall');
        const entry = {item, menu, getApp, separator};
        item.connect('activate', () => {
            const app = getApp();
            if (app)
                this._confirm(app).catch(e => console.error(`${TAG} ${e}\n${e.stack}`));
        });
        item.connect('destroy', () => this._items.delete(entry));
        this._items.add(entry);
        return entry;
    }

    _syncEntry(entry) {
        const app = entry.getApp();
        const rec = app && !app.is_window_backed() ? this._classifier?.lookup(app.get_id()) : null;
        if (app && !rec)
            this._classifier?.ensure();
        const show = !!rec && rec.action !== 'none';
        entry.item.visible = show;
        if (entry.separator)
            entry.separator.visible = show;
        if (!show)
            return;
        entry.item.label.text = rec.action === 'remove-entry' ? 'Remove from App List' : 'Uninstall';
        entry.item.sensitive = !this._busy.has(this._key(rec));
    }

    _syncAll() {
        for (const entry of this._items)
            this._syncEntry(entry);
    }

    /** App grid, folders, search results, stock dash: AppMenu, kept per icon. */
    _prepareAppMenu(menu) {
        if (!menu._app)
            return;
        if (!menu._appUninstall) {
            const entry = this._newItem(menu, () => menu._app);
            const items = menu._getMenuItems();
            const at = items.indexOf(menu._detailsItem);
            menu.addMenuItem(entry.item, at >= 0 ? at + 1 : Math.max(items.length - 2, 0));
            menu._appUninstall = entry;
        }
        this._syncEntry(menu._appUninstall);
    }

    // ---- Ubuntu Dock -----------------------------------------------------------

    /**
     * The dock rebuilds its menu (DockAppIconMenu, not exported) on every
     * popup. Its class is reached through the first menu instance: popupMenu()
     * is wrapped, and for an icon without a menu yet, its menu manager's
     * addMenu (called between `new DockAppIconMenu` and popup()) is shadowed
     * on that one instance to catch the menu and patch _rebuildMenu on its
     * prototype before the first rebuild.
     */
    async _hookDock() {
        if (this._dockIconClass || this._dockHooking)
            return;
        const ext = DOCK_UUIDS.map(u => Main.extensionManager.lookup(u))
            .find(e => e?.state === ExtensionState.ACTIVE && e.dir);
        if (!ext)
            return;
        const generation = this._generation;
        this._dockHooking = true;
        try {
            const mod = await import(ext.dir.get_child('appIcons.js').get_uri());
            if (generation !== this._generation)
                return;
            const IconClass = mod.DockAbstractAppIcon;
            if (typeof IconClass?.prototype?.popupMenu !== 'function') {
                console.warn(`${TAG} ${ext.uuid}: DockAbstractAppIcon.popupMenu not found; dock menus stay stock`);
                return;
            }
            this._dockIconClass = IconClass;
            const self = this;
            this._injections.overrideMethod(IconClass.prototype, 'popupMenu', original => function (...args) {
                const mgr = this._menuManager;
                if (!self._dockMenuPatched) {
                    if (this._menu) {
                        self._patchDockMenu(this._menu);
                    } else if (mgr) {
                        mgr.addMenu = function (menu, ...rest) {
                            delete this.addMenu;
                            try {
                                self._patchDockMenu(menu);
                            } catch (e) {
                                console.error(`${TAG} dock menu: ${e}`);
                            }
                            return this.addMenu(menu, ...rest);
                        };
                    }
                }
                try {
                    return original.apply(this, args);
                } finally {
                    if (mgr && Object.hasOwn(mgr, 'addMenu'))
                        delete mgr.addMenu;
                }
            });
            console.log(`${TAG} hooked ${ext.uuid}`);
        } finally {
            this._dockHooking = false;
        }
    }

    _patchDockMenu(menu) {
        if (this._dockMenuPatched)
            return;
        let proto = Object.getPrototypeOf(menu);
        while (proto && !Object.hasOwn(proto, '_rebuildMenu'))
            proto = Object.getPrototypeOf(proto);
        if (!proto) {
            console.warn(`${TAG} dock menu has no _rebuildMenu; dock menus stay stock`);
            this._dockMenuPatched = true;
            return;
        }
        const self = this;
        this._injections.overrideMethod(proto, '_rebuildMenu', original => function (...args) {
            const ret = original.apply(this, args);
            try {
                const src = this.sourceActor;
                if (self._dockIconClass && src instanceof self._dockIconClass && src.app)
                    self._addDockItem(this, src);
            } catch (e) {
                console.error(`${TAG} dock menu: ${e}\n${e.stack}`);
            }
            return ret;
        });
        this._dockMenuPatched = true;
    }

    _addDockItem(menu, icon) {
        if (icon.app.is_window_backed?.())
            return;
        const separator = new PopupMenu.PopupSeparatorMenuItem();
        const entry = this._newItem(menu, () => icon.app, separator);
        separator.connect('destroy', () => {
            entry.separator = null;
        });
        // just above the dock's own "separator, Quit" tail
        const items = menu._getMenuItems();
        const quit = items.indexOf(menu._quitMenuItem);
        const at = quit > 0 ? quit - 1 : items.length;
        menu.addMenuItem(separator, at);
        menu.addMenuItem(entry.item, at + 1);
        this._syncEntry(entry);
    }

    // ---- confirm ----------------------------------------------------------------

    _key(rec) {
        return rec.pkg ? `deb:${rec.pkg}` : rec.snap ? `snap:${rec.snap}`
            : rec.flatpak ? `flatpak:${rec.flatpak}` : `file:${rec.file}`;
    }

    _appInfo(id) {
        const app = Shell.AppSystem.get_default().lookup_app(id);
        return app ? {title: app.get_name(), gicon: app.get_icon()} : null;
    }

    /**
     * Opens the dialog at once (checking), then fills it with the plan.
     *
     * @param {Shell.App} app - the app whose menu item was chosen
     */
    async _confirm(app) {
        const rec = this._classifier?.lookup(app.get_id());
        if (!rec || rec.action === 'none' || this._dialog)
            return;
        const name = app.get_name();
        const entry = rec.action === 'remove-entry';
        const dialog = new UninstallDialog({
            gicon: app.get_icon(),
            title: entry ? `Remove “${name}” from the App List?` : `Uninstall “${name}”?`,
            verb: entry ? 'Remove' : 'Uninstall',
        });
        this._dialog = dialog;
        let gone = false;
        dialog.connect('destroy', () => {
            gone = true;
            if (this._dialog === dialog)
                this._dialog = null;
        });
        dialog.open();

        const generation = this._generation;
        let plan;
        try {
            plan = await this._plan(app, rec);
        } catch (e) {
            if (!gone) {
                const msg = e instanceof Backends.UninstallError ? e.message : `Unexpected error: ${e}`;
                dialog.setTitle(`“${name}” can’t be ${entry ? 'removed' : 'uninstalled'} right now`);
                dialog.setRefused(`${msg}\n\nNothing has been changed.`, 'failed');
            }
            console.warn(`${TAG} plan ${this._key(rec)}: ${e} ${e.details ?? ''}`);
            return;
        }
        if (gone || generation !== this._generation)
            return;
        if (plan.refused) {
            dialog.setTitle(`“${name}” can’t be uninstalled here`);
            dialog.setRefused(plan.refused, 'refused', plan.listTitle, plan.items);
            console.log(`${TAG} refused ${this._key(rec)}: ${plan.refused}`);
            return;
        }
        dialog.connect('confirmed', () => {
            this._run(app, rec, plan).catch(e => console.error(`${TAG} ${e}\n${e.stack}`));
        });
        dialog.setReady(plan);
    }

    /**
     * What removing `app` means, or why it is refused.
     *
     * @returns {Promise<object>} {description, listTitle, items, refused?, run(onStatus, control), doneTitle}
     */
    async _plan(app, rec) {
        const data = this._classifier.data;
        const name = app.get_name();
        const id = app.get_id();
        const others = ids => [...new Set(ids)].filter(x => x !== id)
            .map(x => this._appInfo(x)).filter(Boolean)
            .filter((v, i, a) => a.findIndex(o => o.title === v.title) === i);
        const overrideItem = rec.localOverride ? [{
            title: 'Your own launcher for it',
            description: `${GLib.path_get_basename(rec.localOverride)} (moved to the Trash)`,
            gicon: new Gio.ThemedIcon({name: 'user-trash-symbolic'}),
        }] : [];
        const trashOverride = async () => {
            if (rec.localOverride && !DRY_RUN)
                await Backends.trashFiles([rec.localOverride]);
        };
        const keep = 'Your documents and personal files are not touched.';

        if (rec.origin === 'deb') {
            const p = await Backends.debPlan(rec.pkg);
            const bad = p.removing.filter(n => data.protectedDebs[n] || data.critical.test(n));
            const pkgItems = p.removing.map(n => ({
                title: n,
                description: n === rec.pkg ? 'the app’s package'
                    : data.protectedDebs[n] || data.critical.test(n) ? 'part of Ubuntu' : 'needs the app’s package',
            }));
            if (bad.length) {
                return {
                    refused: 'Removing it would also remove part of Ubuntu itself ' +
                        `(${bad.slice(0, 4).join(', ')}${bad.length > 4 ? ', …' : ''}). Nothing has been changed.`,
                    listTitle: 'Removing it would take',
                    items: pkgItems,
                };
            }
            if (p.other.length) {
                return {
                    refused: `Removing “${name}” would make the package manager also install or change other software ` +
                        `(${p.other.slice(0, 3).join(', ')}). Nothing has been changed.`,
                };
            }
            if (p.removing.length > MAX_PACKAGES) {
                return {
                    refused: `Removing “${name}” would take ${p.removing.length} software packages with it, more than ` +
                        `this tool removes at once (${MAX_PACKAGES}). Nothing has been changed.`,
                    listTitle: 'Removing it would take', items: pkgItems,
                };
            }
            const alsoApps = others(p.removing.flatMap(n => data.byPkg[n] ?? []));
            const items = [...alsoApps.map(a => ({...a, description: 'also removed'})), ...pkgItems, ...overrideItem];
            return {
                description: `${name} will be removed from this computer. ${keep} ` +
                    'You will be asked for your password.',
                listTitle: alsoApps.length ? 'Also removed' : 'Will be removed',
                items,
                run: async (onStatus, control) => {
                    await Backends.debRemove(p.ids, {onStatus, control}, DRY_RUN);
                    await trashOverride();
                },
                doneTitle: `${name} was uninstalled`,
            };
        }

        if (rec.origin === 'snap') {
            if (data.protectedSnaps[rec.snap])
                return {refused: `“${name}” is part of Ubuntu (${data.protectedSnaps[rec.snap]}) and can’t be uninstalled here.`};
            const s = await Backends.snapPlan(rec.snap);
            const alsoApps = others(data.bySnap[rec.snap] ?? []);
            const size = formatSize(s.size);
            return {
                description: `${name} (snap “${s.name}”${size ? `, ${size}` : ''}) will be removed from this computer. ` +
                    `${keep} You will be asked for your password.`,
                listTitle: alsoApps.length ? 'These apps come with it and are removed too' : '',
                items: [...alsoApps.map(a => ({...a, description: `part of the ${s.name} snap`})), ...overrideItem],
                run: async onStatus => {
                    if (DRY_RUN)
                        await Backends.snapPlan(rec.snap);
                    else
                        await Backends.snapRemove(rec.snap, {onStatus});
                    await trashOverride();
                },
                doneTitle: `${name} was uninstalled`,
            };
        }

        if (rec.origin === 'flatpak') {
            await Backends.flatpakRemove(rec.flatpak, rec.installation, {dryRun: true});
            return {
                description: `${name} (Flatpak, ${rec.installation} installation) will be removed. ${keep}` +
                    (rec.installation === 'system' ? ' You may be asked for your password.' : ''),
                items: overrideItem,
                run: async () => {
                    if (!DRY_RUN)
                        await Backends.flatpakRemove(rec.flatpak, rec.installation);
                    await trashOverride();
                },
                doneTitle: `${name} was uninstalled`,
            };
        }

        if (rec.origin === 'local') {
            const files = [rec.file, ...rec.appimage ? [rec.appimage] : []];
            let note = 'It is moved to the Trash, so you can restore it from the Trash in Files.';
            if (rec.appimage)
                note = 'The app (an AppImage file) and its launcher are moved to the Trash, so you can restore them from the Trash in Files.';
            else if (/Chrome web app/.test(rec.reason))
                note += ' To uninstall the web app itself, open it in Chrome and choose “Uninstall”.';
            return {
                description: `“${name}” will no longer appear in your apps. ${note}`,
                listTitle: 'Moved to the Trash',
                items: files.map(f => ({
                    title: GLib.path_get_basename(f),
                    description: GLib.path_get_dirname(f).replace(GLib.get_home_dir(), '~'),
                    gicon: new Gio.ThemedIcon({name: 'user-trash-symbolic'}),
                })),
                run: async () => {
                    await Backends.trashFiles(files);
                },
                doneTitle: `${name} was removed from the App List`,
            };
        }

        return {refused: `“${name}” was not installed by a package manager this tool knows, so it is left alone.`};
    }

    // ---- run --------------------------------------------------------------------

    _notify(title, body, gicon, {transient = true} = {}) {
        const source = MessageTray.getSystemSource();
        const n = new MessageTray.Notification({source, title, body, gicon, isTransient: transient});
        source.addNotification(n);
        return n;
    }

    async _run(app, rec, plan) {
        const key = this._key(rec);
        if (this._busy.has(key))
            return;
        this._busy.add(key);
        this._syncAll();
        const name = app.get_name();
        const gicon = app.get_icon();
        const removing = rec.action === 'remove-entry';
        const control = {};
        const progress = this._notify(removing ? `Removing ${name}…` : `Uninstalling ${name}…`,
            removing ? '' : 'You may be asked for your password.', gicon, {transient: false});
        if (rec.origin === 'deb')
            progress.addAction('Cancel', () => control.cancel?.());
        console.log(`${TAG} start ${key}${DRY_RUN ? ' (dry run)' : ''}`);
        try {
            await plan.run(status => {
                progress.body = status === 'lock'
                    ? 'Waiting for another software installation or update to finish…'
                    : status === 'auth' ? 'Waiting for your password…' : 'Removing…';
            }, control);
            progress.destroy();
            this._notify(plan.doneTitle + (DRY_RUN && !removing ? ' (dry run)' : ''), '', gicon);
            console.log(`${TAG} done ${key}`);
            this._classifier?.schedule(500);
        } catch (e) {
            progress.destroy();
            const err = e instanceof Backends.UninstallError ? e : new Backends.UninstallError('failed', String(e));
            const quiet = err.kind === 'auth' || err.kind === 'cancelled';
            const what = removing ? 'removed from the App List' : 'uninstalled';
            this._notify(quiet ? `${name} was not ${what}` : `${name} could not be ${what}`,
                err.message, gicon);
            console.warn(`${TAG} ${key}: ${err.kind}: ${err.message} ${err.details ?? ''}`);
        } finally {
            this._busy.delete(key);
            this._syncAll();
        }
    }
}
