// Thin loader: imports the newest impl-N.js so later fixes can be loaded by
// disable/enable instead of a relogin (ES modules are cached per file name).
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class NotificationTidy extends Extension {
    enable() {
        const token = this._token = (this._token ?? 0) + 1;
        let best = 0;
        const it = this.dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = it.next_file(null));) {
            const m = /^impl-(\d+)\.js$/.exec(info.get_name());
            if (m)
                best = Math.max(best, Number(m[1]));
        }
        import(`./impl-${best}.js`).then(mod => {
            if (token !== this._token)
                return;
            this._impl = new mod.Impl();
            this._impl.enable();
        }).catch(e => logError(e, 'notification-tidy'));
    }

    disable() {
        this._token = (this._token ?? 0) + 1;
        this._impl?.disable();
        this._impl = null;
    }
}
