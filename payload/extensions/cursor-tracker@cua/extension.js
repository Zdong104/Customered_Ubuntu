import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DBUS_IFACE = `
<node>
  <interface name="org.cua.CursorTracker">
    <method name="GetPosition">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
    </method>
    <method name="GetPositionPixel">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="i" direction="out" name="mon_width"/>
      <arg type="i" direction="out" name="mon_height"/>
    </method>
    <method name="GetMonitorInfo">
      <arg type="s" direction="out" name="json"/>
    </method>
  </interface>
</node>`;

export default class CursorTrackerExtension {
    _dbusId = null;
    _ownerId = null;

    enable() {
        this._dbusId = Gio.DBus.session.register_object(
            '/org/cua/CursorTracker',
            Gio.DBusNodeInfo.new_for_xml(DBUS_IFACE).interfaces[0],
            (connection, sender, path, iface, method, params, invocation) => {
                if (method === 'GetPosition') {
                    // Legacy: return raw global logical coordinates
                    const [x, y] = global.get_pointer();
                    invocation.return_value(new GLib.Variant('(ii)', [x, y]));
                } else if (method === 'GetPositionPixel') {
                    // Return monitor-relative PIXEL coordinates (matching PipeWire screenshot)
                    const [gx, gy] = global.get_pointer();
                    const display = global.display;
                    const monIdx = display.get_current_monitor();
                    const geom = display.get_monitor_geometry(monIdx);
                    const scale = display.get_monitor_scale(monIdx);

                    // Convert global logical -> monitor-relative -> pixel
                    const localX = gx - geom.x;
                    const localY = gy - geom.y;
                    const pixelX = Math.round(localX * scale);
                    const pixelY = Math.round(localY * scale);
                    const monW = Math.round(geom.width * scale);
                    const monH = Math.round(geom.height * scale);

                    invocation.return_value(new GLib.Variant('(iiii)', [pixelX, pixelY, monW, monH]));
                } else if (method === 'GetMonitorInfo') {
                    // Diagnostic: return JSON with all monitor info
                    const display = global.display;
                    const n = display.get_n_monitors();
                    const current = display.get_current_monitor();
                    const [gx, gy] = global.get_pointer();
                    let monitors = [];
                    for (let i = 0; i < n; i++) {
                        const g = display.get_monitor_geometry(i);
                        const s = display.get_monitor_scale(i);
                        monitors.push({
                            index: i,
                            x: g.x, y: g.y, width: g.width, height: g.height,
                            scale: s,
                            pixel_width: Math.round(g.width * s),
                            pixel_height: Math.round(g.height * s),
                        });
                    }
                    const info = JSON.stringify({
                        pointer: {x: gx, y: gy},
                        current_monitor: current,
                        monitors: monitors,
                    });
                    invocation.return_value(new GLib.Variant('(s)', [info]));
                }
            },
            null,
            null
        );

        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.cua.CursorTracker',
            Gio.BusNameOwnerFlags.NONE,
            null, null, null
        );

        console.log('[CUA] Cursor tracker extension v2 enabled');
    }

    disable() {
        if (this._dbusId) {
            Gio.DBus.session.unregister_object(this._dbusId);
            this._dbusId = null;
        }
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }
        console.log('[CUA] Cursor tracker extension disabled');
    }
}
