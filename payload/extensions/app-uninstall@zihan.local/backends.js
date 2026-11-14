/**
 * Removal backends for app-uninstall@zihan.local.
 *
 * Plain GIO only (no shell imports), so the same module also runs under a
 * standalone `gjs -m` test. Everything is asynchronous: D-Bus calls, the
 * snapd socket, subprocesses and the trash all go through *_async APIs.
 *
 *   deb      PackageKit over the system bus (org.freedesktop.PackageKit).
 *            plan: Resolve + RemovePackages(SIMULATE, allow_deps=true) lists
 *            every package apt would take out; no authorization is needed
 *            for a simulation. run: RemovePackages(flags=0, <exactly the
 *            simulated ids>, allow_deps=false, autoremove=false), so nothing
 *            beyond what the user confirmed can go; polkit (the shell's own
 *            password dialog) authorizes org.freedesktop.packagekit.package-remove.
 *   snap     snapd REST API on /run/snapd.socket with X-Allow-Interaction,
 *            so snapd asks polkit (same shell dialog) for io.snapcraft.snapd.manage.
 *            No purge: snapd keeps its automatic snapshot of the app's data.
 *   flatpak  `flatpak uninstall --user|--system -y <ref>` (no --delete-data,
 *            no unused-runtime cleanup). The system installation authorizes
 *            through flatpak's system helper and polkit.
 *   local    Gio.File.trash_async of the launcher (and a clearly owned
 *            AppImage), never a hard delete.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.IOStream.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'trash_async');

export class UninstallError extends Error {
    /**
     * @param {string} kind - cancelled | auth | busy | refused | missing | failed
     * @param {string} message - text for the user
     * @param {string} [details] - technical details for the log
     */
    constructor(kind, message, details = '') {
        super(message);
        this.kind = kind;
        this.details = details;
    }
}

// ------------------------------------------------------------ PackageKit ---

const PK_NAME = 'org.freedesktop.PackageKit';
const PK_PATH = '/org/freedesktop/PackageKit';
const PK_TX = 'org.freedesktop.PackageKit.Transaction';
const FILTER_INSTALLED = 1 << 2;          // PK_FILTER_ENUM_INSTALLED = 2
const TFLAG_SIMULATE = 1 << 2;           // PK_TRANSACTION_FLAG_ENUM_SIMULATE = 2
const INFO_INSTALLED = 1;
const INFO = {REMOVING: 13, CLEANUP: 14, OBSOLETING: 15, INSTALLING: 12, UPDATING: 11, DOWNGRADING: 20, REINSTALLING: 19};
const EXIT_SUCCESS = 1, EXIT_CANCELLED = 3;
const STATUS_WAITING_FOR_LOCK = 30, STATUS_WAITING_FOR_AUTH = 31;
const ERR = {NOT_AUTHORIZED: 48, CANNOT_GET_LOCK: 26, LOCK_REQUIRED: 67, TRANSACTION_CANCELLED: 17,
    CANNOT_REMOVE_SYSTEM_PACKAGE: 20, PACKAGE_NOT_INSTALLED: 7, DEP_RESOLUTION_FAILED: 13};

function pkName(id) {
    return id.split(';')[0];
}

/**
 * One PackageKit transaction: create, subscribe, run `method`, await Finished.
 *
 * @param {string} method - Transaction method name
 * @param {GLib.Variant} params - its arguments
 * @param {object} [opts]
 * @param {Function} [opts.onStatus] - (statusEnum) => void
 * @param {object} [opts.control] - gets .cancel() while running
 * @returns {Promise<{packages: Array<{info:number,id:string,name:string,summary:string}>}>}
 */
async function pkTransaction(method, params, opts = {}) {
    const bus = Gio.DBus.system;
    let path;
    try {
        const reply = await bus.call(PK_NAME, PK_PATH, PK_NAME, 'CreateTransaction',
            null, new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, 30000, null);
        [path] = reply.deepUnpack();
    } catch (e) {
        throw new UninstallError('missing',
            'The software service (PackageKit) is not available on this computer.', String(e));
    }

    return new Promise((resolve, reject) => {
        const packages = [];
        let error = null;
        const subs = [];
        const done = () => subs.splice(0).forEach(id => bus.signal_unsubscribe(id));

        subs.push(bus.signal_subscribe(PK_NAME, PK_TX, null, path, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, signal, args) => {
                if (signal === 'Package') {
                    const [info, id, summary] = args.deepUnpack();
                    packages.push({info, id, name: pkName(id), summary});
                } else if (signal === 'ErrorCode') {
                    const [code, details] = args.deepUnpack();
                    error ??= {code, details};
                } else if (signal === 'Finished') {
                    const [exit] = args.deepUnpack();
                    done();
                    if (exit === EXIT_SUCCESS && !error)
                        resolve({packages});
                    else
                        reject(pkError(error, exit));
                } else if (signal === 'Destroy') {
                    done();
                    reject(pkError(error, 0));
                }
            }));
        subs.push(bus.signal_subscribe(PK_NAME, 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', path, null, Gio.DBusSignalFlags.NONE, (...a) => {
                const [, changed] = a[5].deepUnpack();
                const status = changed?.Status?.deepUnpack?.();
                if (status !== undefined)
                    opts.onStatus?.(status);
            }));
        if (opts.control) {
            opts.control.cancel = () => bus.call(PK_NAME, path, PK_TX, 'Cancel', null, null,
                Gio.DBusCallFlags.NONE, -1, null).catch(() => {});
        }

        const locale = GLib.get_language_names()[0] ?? 'C';
        (async () => {
            await bus.call(PK_NAME, path, PK_TX, 'SetHints',
                new GLib.Variant('(as)', [[`locale=${locale}`, 'interactive=true', 'background=false']]),
                null, Gio.DBusCallFlags.NONE, 30000, null);
            await bus.call(PK_NAME, path, PK_TX, method, params, null,
                Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, 30000, null);
        })().catch(e => {
            done();
            reject(new UninstallError('failed', 'The software service refused the request.', String(e)));
        });
    });
}

function pkError(error, exit) {
    const details = error ? `${error.code}: ${error.details}` : `exit ${exit}`;
    switch (error?.code) {
    case ERR.NOT_AUTHORIZED:
        return new UninstallError('auth', 'Authentication was cancelled or failed.', details);
    case ERR.CANNOT_GET_LOCK:
    case ERR.LOCK_REQUIRED:
        return new UninstallError('busy',
            'Another program is installing or updating software right now. Try again when it has finished.', details);
    case ERR.TRANSACTION_CANCELLED:
        return new UninstallError('cancelled', 'Uninstall was cancelled.', details);
    case ERR.CANNOT_REMOVE_SYSTEM_PACKAGE:
        return new UninstallError('refused', 'This is part of the system and cannot be removed.', details);
    case ERR.PACKAGE_NOT_INSTALLED:
        return new UninstallError('missing', 'The app is no longer installed.', details);
    case ERR.DEP_RESOLUTION_FAILED:
        return new UninstallError('refused',
            'Removing it would need more changes than were confirmed; nothing was removed.', details);
    }
    if (exit === EXIT_CANCELLED)
        return new UninstallError('cancelled', 'Uninstall was cancelled.', details);
    return new UninstallError('failed', error?.details?.split('\n')[0] || 'The software service reported an error.', details);
}

/**
 * What removing deb `pkg` would take out (a PackageKit simulation, no auth).
 *
 * @param {string} pkg - binary package name
 * @returns {Promise<{ids: string[], removing: string[], other: string[]}>}
 */
export async function debPlan(pkg) {
    const {packages: found} = await pkTransaction('Resolve',
        new GLib.Variant('(tas)', [FILTER_INSTALLED, [pkg]]));
    const ids = found.filter(p => p.info === INFO_INSTALLED && p.name === pkg).map(p => p.id);
    if (!ids.length)
        throw new UninstallError('missing', `The package “${pkg}” is not installed.`);

    const {packages} = await pkTransaction('RemovePackages',
        new GLib.Variant('(tasbb)', [TFLAG_SIMULATE, ids, true, false]));
    const removing = packages.filter(p => p.info === INFO.REMOVING || p.info === INFO.OBSOLETING);
    const other = packages.filter(p => !removing.includes(p) && p.info !== INFO.CLEANUP && p.info !== INFO_INSTALLED);
    const allIds = [...new Set([...ids, ...removing.map(p => p.id)])];
    return {
        ids: allIds,
        removing: [...new Set(allIds.map(pkName))].sort(),
        // installs/upgrades a removal would trigger: always a refusal reason
        other: other.map(p => `${p.name} (${Object.keys(INFO).find(k => INFO[k] === p.info) ?? p.info})`),
    };
}

/**
 * Remove exactly `ids` (from debPlan) - no extra dependencies, no autoremove.
 *
 * @param {string[]} ids - PackageKit package ids
 * @param {object} [opts] - {onStatus, control}; onStatus gets 'lock' | 'auth' | 'running'
 * @param {boolean} [simulate] - test hook: run the same call as a simulation
 */
export async function debRemove(ids, opts = {}, simulate = false) {
    const onStatus = s => opts.onStatus?.(
        s === STATUS_WAITING_FOR_LOCK ? 'lock' : s === STATUS_WAITING_FOR_AUTH ? 'auth' : 'running');
    const {packages} = await pkTransaction('RemovePackages',
        new GLib.Variant('(tasbb)', [simulate ? TFLAG_SIMULATE : 0, ids, false, false]),
        {onStatus, control: opts.control});
    return packages;
}

// ----------------------------------------------------------------- snapd ---

const SNAPD_SOCKET = '/run/snapd.socket';

async function snapd(method, path, body = null) {
    const client = new Gio.SocketClient();
    let conn;
    try {
        conn = await client.connect_async(new Gio.UnixSocketAddress({path: SNAPD_SOCKET}), null);
    } catch (e) {
        throw new UninstallError('missing', 'The snap service (snapd) is not running.', String(e));
    }
    const payload = body ? JSON.stringify(body) : '';
    const req = `${method} ${path} HTTP/1.0\r\nHost: localhost\r\n` +
        'X-Allow-Interaction: true\r\n' +
        (body ? `Content-Type: application/json\r\nContent-Length: ${new TextEncoder().encode(payload).length}\r\n` : '') +
        `\r\n${payload}`;
    try {
        await conn.get_output_stream().write_all_async(new TextEncoder().encode(req), GLib.PRIORITY_DEFAULT, null);
        const chunks = [];
        const input = conn.get_input_stream();
        for (;;) {
            const bytes = await input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null);
            if (bytes.get_size() === 0)
                break;
            chunks.push(bytes.toArray());
        }
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let off = 0;
        for (const c of chunks) {
            all.set(c, off);
            off += c.length;
        }
        const text = new TextDecoder().decode(all);
        const sep = text.indexOf('\r\n\r\n');
        return JSON.parse(text.slice(sep + 4));
    } catch (e) {
        if (e instanceof UninstallError)
            throw e;
        throw new UninstallError('failed', 'Could not talk to the snap service.', String(e));
    } finally {
        conn.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
}

function snapdError(res) {
    const kind = res?.result?.kind ?? '';
    const msg = res?.result?.message ?? 'unknown error';
    if (kind === 'auth-cancelled')
        return new UninstallError('auth', 'Authentication was cancelled.', msg);
    if (kind === 'login-required' || res?.['status-code'] === 401 || res?.['status-code'] === 403)
        return new UninstallError('auth', 'Authentication failed or is not allowed.', msg);
    if (kind === 'snap-change-conflict')
        return new UninstallError('busy', 'This app is being updated right now. Try again in a few minutes.', msg);
    if (kind === 'snap-not-installed' || kind === 'snap-not-found')
        return new UninstallError('missing', 'The app is no longer installed.', msg);
    return new UninstallError('failed', msg, JSON.stringify(res?.result ?? res));
}

/**
 * Pre-check for a snap (snapd has no dry run): it must exist and be an app.
 *
 * @param {string} name - snap name
 * @returns {Promise<{name: string, title: string, version: string, size: number}>}
 */
export async function snapPlan(name) {
    const res = await snapd('GET', `/v2/snaps/${encodeURIComponent(name)}`);
    if (res?.type === 'error')
        throw snapdError(res);
    const s = res.result;
    if (s.type !== 'app')
        throw new UninstallError('refused', `“${name}” is a ${s.type} snap that other software needs.`);
    return {name: s.name, title: s.title || s.name, version: s.version, size: s['installed-size'] ?? 0};
}

/**
 * snap remove <name> (no --purge), polling the change until it is ready.
 *
 * @param {string} name - snap name
 * @param {object} [opts] - {onStatus}
 */
export async function snapRemove(name, opts = {}) {
    const res = await snapd('POST', `/v2/snaps/${encodeURIComponent(name)}`, {action: 'remove'});
    if (res?.type !== 'async')
        throw snapdError(res);
    opts.onStatus?.('running');
    for (;;) {
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            r();
            return GLib.SOURCE_REMOVE;
        }));
        const ch = await snapd('GET', `/v2/changes/${res.change}`);
        if (ch?.type === 'error')
            throw snapdError(ch);
        if (ch.result.ready) {
            if (ch.result.status === 'Done')
                return;
            throw new UninstallError('failed', ch.result.err?.split('\n').pop()?.trim() || 'The snap service reported an error.',
                ch.result.err ?? '');
        }
    }
}

// --------------------------------------------------------------- flatpak ---

/**
 * @param {string} ref - app id (or full ref)
 * @param {string} installation - 'user' | 'system'
 * @param {object} [opts] - {dryRun}: only check that flatpak knows the app
 */
export async function flatpakRemove(ref, installation, opts = {}) {
    const where = installation === 'user' ? '--user' : '--system';
    const argv = opts.dryRun
        ? ['flatpak', 'info', where, ref]
        : ['flatpak', 'uninstall', where, '-y', ref];
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE | Gio.SubprocessFlags.STDIN_PIPE);
    } catch (e) {
        throw new UninstallError('missing', 'Flatpak is not installed on this computer.', String(e));
    }
    const [out, err] = await proc.communicate_utf8_async('', null);
    if (!proc.get_successful()) {
        const msg = (err || out || '').trim().split('\n').pop();
        if (/not authorized|authorization|polkit/i.test(msg))
            throw new UninstallError('auth', 'Authentication was cancelled or failed.', msg);
        if (/lock/i.test(msg))
            throw new UninstallError('busy', 'Flatpak is busy with another operation. Try again later.', msg);
        throw new UninstallError('failed', msg || 'flatpak reported an error.', err);
    }
    return out;
}

// ----------------------------------------------------------------- local ---

/**
 * Move files to the Trash (never a hard delete). Missing files are skipped.
 *
 * @param {string[]} paths - absolute paths
 * @returns {Promise<string[]>} the paths actually trashed
 */
export async function trashFiles(paths) {
    const done = [];
    for (const p of paths) {
        const f = Gio.File.new_for_path(p);
        if (!f.query_exists(null))
            continue;
        try {
            await f.trash_async(GLib.PRIORITY_DEFAULT, null);
            done.push(p);
        } catch (e) {
            throw new UninstallError('failed', `Could not move ${GLib.path_get_basename(p)} to the Trash.`, String(e));
        }
    }
    return done;
}
