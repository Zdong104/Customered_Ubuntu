/**
 * Copying in Files' Recent view puts recent:/// URIs on the clipboard.
 *
 * Nautilus offers three mimetypes for a file copy: text/uri-list,
 * text/plain;charset=utf-8 and x-special/gnome-copied-files. For ordinary
 * local files they hold file:// URIs, plain paths and "copy\n<uris>". In the
 * Recent view the files are gvfsd-recent's recent:///<hash> items, so a paste
 * into a terminal or chat box yields "recent:///3423c8c6..." instead of the
 * path.
 *
 * So whenever the clipboard owner changes and the new content is a file list
 * with recent:/// URIs in it, read every offered mimetype, map each
 * recent:/// URI to its standard::target-uri (a local path for the text
 * types, the file:// URI elsewhere, i.e. exactly what Nautilus offers for the
 * real file) and take over the clipboard with the rewritten content under all
 * of the original mimetypes. Pasting back into Files keeps working (and now
 * acts on the real file); copy vs. cut is preserved.
 *
 * Mutter's own MetaSelectionSourceMemory carries a single mimetype, and GJS
 * cannot implement MetaSelectionSource's async read vfunc, so the multi-
 * mimetype source is a small C class (src/multisource.c, built into
 * libmultisource.so) loaded as a GIOModule.
 *
 * Only the CLIPBOARD selection is touched; PRIMARY and DND are left alone.
 * Clipboard changes without text/uri-list or x-special/gnome-copied-files
 * (all text copies) cost nothing beyond a mimetype check.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {findRecentUris, resolveRecentUris, rewriteText} from './recentUris.js';

const CLIPBOARD = Meta.SelectionType.SELECTION_CLIPBOARD;
const TYPE_NAME = 'RcpMultiSource';

/**
 * File-list mimetypes; only these are read to decide whether to act.
 * text/uri-list first: GDK serializes it itself, while Nautilus' own
 * x-special/gnome-copied-files writer is fragile (below).
 */
const PROBE_MIMES = ['text/uri-list', 'x-special/gnome-copied-files'];
/**
 * Portal transfer keys refer to the original files and cannot be rewritten
 * (GTK cannot export recent:/// items through the portal anyway).
 */
const SKIP_MIMES = new Set([
    'application/vnd.portal.filetransfer',
    'application/vnd.portal.files',
]);
/** File lists are small; anything bigger is left alone. */
const MAX_BYTES = 1 << 20;

/*
 * Reads are never cancelled or size-limited: closing the pipe while Nautilus
 * 50 is still writing x-special/gnome-copied-files crashes Nautilus (SIGSEGV,
 * reproduced in a test shell). A newer clipboard owner just makes the
 * finished reads stale; they are dropped by comparing a serial.
 */

const utf8 = new TextDecoder('utf-8', {fatal: true});
const encoder = new TextEncoder();

function decodeText(bytes) {
    try {
        return utf8.decode(bytes);
    } catch {
        return null;
    }
}

/** Register RcpMultiSource from libmultisource.so once per shell process. */
function loadSourceType(dir) {
    let gtype = GObject.type_from_name(TYPE_NAME);
    if (gtype)
        return gtype;
    const path = dir.get_child('libmultisource.so').get_path();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    // The module pins itself (the type is static), so never unuse() it.
    Gio.IOModule.new(path).use();
    gtype = GObject.type_from_name(TYPE_NAME);
    return gtype || null;
}

function readMime(selection, mimetype) {
    return new Promise((resolve, reject) => {
        const out = Gio.MemoryOutputStream.new_resizable();
        selection.transfer_async(CLIPBOARD, mimetype, -1, out, null,
            (sel, res) => {
                try {
                    sel.transfer_finish(res);
                    out.close(null);
                    resolve(out.steal_as_bytes().toArray());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export default class RecentClipboardPathsExtension extends Extension {
    enable() {
        this._gtype = loadSourceType(this.dir);
        if (!this._gtype) {
            console.warn('recent-clipboard-paths: multi-mimetype source unavailable; inactive');
            return;
        }
        this._source = null;
        this._serial = 0;
        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed',
            (selection, type, owner) => this._onOwnerChanged(selection, type, owner),
            this);
    }

    _onOwnerChanged(selection, type, owner) {
        if (type !== CLIPBOARD)
            return;
        const serial = ++this._serial;
        if (!owner || owner === this._source)
            return;
        this._source = null;

        const mimetypes = selection.get_mimetypes(CLIPBOARD);
        const probe = PROBE_MIMES.find(m => mimetypes.includes(m));
        if (!probe)
            return;

        this._rewrite(selection, mimetypes, probe, serial).catch(e => {
            if (serial === this._serial)
                console.warn(`recent-clipboard-paths: ${e.message}`);
        });
    }

    async _rewrite(selection, mimetypes, probe, serial) {
        const stale = () => serial !== this._serial;
        const probeBytes = await readMime(selection, probe);
        const probeText = probeBytes.length <= MAX_BYTES ? decodeText(probeBytes) : null;
        if (stale() || !probeText || findRecentUris(probeText).length === 0)
            return;

        // Read everything before taking over: the old owner is gone after.
        const payloads = [];
        const uris = new Set();
        for (const mimetype of mimetypes) {
            if (SKIP_MIMES.has(mimetype))
                continue;
            const bytes = mimetype === probe
                ? probeBytes : await readMime(selection, mimetype);
            if (stale() || bytes.length > MAX_BYTES)
                return;
            const text = decodeText(bytes);
            if (text !== null)
                findRecentUris(text).forEach(u => uris.add(u));
            payloads.push({mimetype, bytes, text});
        }

        const map = await resolveRecentUris([...uris]);
        if (map.size === 0 || stale())
            return;

        const contents = payloads.map(({mimetype, bytes, text}) => [mimetype,
            text?.includes('recent:///')
                ? encoder.encode(rewriteText(mimetype, text, map)) : bytes]);
        const source = GObject.Object.new_with_properties(this._gtype,
            ['contents'], [new GLib.Variant('a(say)', contents)]);

        // set_owner emits owner-changed synchronously; mark it as ours first.
        this._source = source;
        selection.set_owner(CLIPBOARD, source);
        console.debug(`recent-clipboard-paths: rewrote ${map.size} recent:/// item(s)`);
    }

    disable() {
        // Keep our source as clipboard owner: disabling on screen lock must
        // not wipe what the user copied.
        this._selection?.disconnectObject(this);
        this._selection = null;
        this._serial++;  // drops any rewrite still in flight
        this._source = null;
    }
}
