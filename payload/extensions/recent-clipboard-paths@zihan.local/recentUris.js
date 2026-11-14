/**
 * Pure Gio/GLib helpers: find recent:/// URIs in clipboard data and map them
 * to the files they stand for. No gnome-shell imports, so the unit test can
 * load this module in plain gjs.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** gvfsd-recent names items recent:///<32 hex>; accept any non-space tail. */
const RECENT_URI_RE = /recent:\/\/\/[^\s"'<>]+/g;

/** Mimetypes whose consumers expect plain text: give them a local path. */
const TEXT_MIMES = new Set([
    'text/plain;charset=utf-8',
    'text/plain',
    'UTF8_STRING',
    'STRING',
    'TEXT',
]);

export function isTextMime(mimetype) {
    return TEXT_MIMES.has(mimetype) || mimetype.startsWith('text/plain;');
}

export function findRecentUris(text) {
    return [...new Set(text.match(RECENT_URI_RE) ?? [])];
}

function queryTarget(uri, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_uri(uri).query_info_async(
            'standard::target-uri', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (file, res) => {
                try {
                    resolve(file.query_info_finish(res)
                        .get_attribute_string('standard::target-uri'));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * Resolve recent:/// URIs to {uri, path} of their targets. Items that fail to
 * resolve (removed from the list, target gone) are left out of the map.
 *
 * @param {string[]} uris
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<Map<string, {uri: string, path: string|null}>>}
 */
export async function resolveRecentUris(uris, cancellable = null) {
    const map = new Map();
    await Promise.all(uris.map(async uri => {
        try {
            const target = await queryTarget(uri, cancellable);
            if (!target || target.startsWith('recent:'))
                return;
            map.set(uri, {uri: target, path: Gio.File.new_for_uri(target).get_path()});
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            console.warn(`recent-clipboard-paths: cannot resolve ${uri}: ${e.message}`);
        }
    }));
    return map;
}

/**
 * Replace every resolvable recent:/// URI in one clipboard payload.
 * Text mimetypes get the local path (as Nautilus gives for ordinary local
 * files); every other mimetype (text/uri-list, x-special/gnome-copied-files)
 * gets the target URI, keeping the payload's own separators.
 */
export function rewriteText(mimetype, text, map) {
    const asPath = isTextMime(mimetype);
    return text.replace(RECENT_URI_RE, uri => {
        const target = map.get(uri);
        if (!target)
            return uri;
        return asPath && target.path ? target.path : target.uri;
    });
}
