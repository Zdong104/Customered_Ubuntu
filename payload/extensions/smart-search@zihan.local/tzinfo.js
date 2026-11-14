/**
 * Time-zone glue for parser.js: wraps GLib.TimeZone (system tzdata) behind
 * the tiny {local, offset(id, utcMs)} interface the pure parser expects.
 * Only GLib, no shell imports, so the unit tests can use it too.
 */
import GLib from 'gi://GLib';

export function makeTz(localId = null) {
    const zones = new Map();
    const get = id => {
        if (!zones.has(id)) {
            let tz = null;
            try {
                tz = id === 'UTC' ? GLib.TimeZone.new_utc() : GLib.TimeZone.new_identifier(id);
            } catch {
                tz = null;
            }
            zones.set(id, tz);
        }
        return zones.get(id);
    };
    let local = localId;
    if (!local) {
        try {
            local = GLib.TimeZone.new_local().get_identifier();
        } catch {
            local = null;
        }
        // "/etc/localtime"/":/etc/localtime" style identifiers are not zone names
        if (!local || local.includes('/etc/') || !get(local))
            local = 'UTC';
    }
    return {
        local,
        offset(id, utcMs) {
            const tz = get(id);
            if (!tz)
                return null;
            const i = tz.find_interval(GLib.TimeType.UNIVERSAL, Math.floor(utcMs / 1000));
            if (i < 0)
                return null;
            return {offset: tz.get_offset(i), abbr: tz.get_abbreviation(i)};
        },
    };
}
