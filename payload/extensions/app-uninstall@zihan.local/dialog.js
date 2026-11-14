/**
 * Confirmation dialog for app-uninstall@zihan.local.
 *
 * States: checking (spinner while the removal is simulated) -> ready (what
 * goes, destructive button) | refused (why not, Close only) | failed.
 * Cancel is the default button (Enter / Escape both cancel).
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const ICON_SIZE = 64;
const LIST_ICON_SIZE = 24;
const MAX_LIST = 8;

export const UninstallDialog = GObject.registerClass({
    Signals: {'confirmed': {}},
}, class UninstallDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} p
     * @param {Gio.Icon} p.gicon - app icon
     * @param {string} p.title - e.g. Uninstall “FreeCAD”?
     * @param {string} p.verb - destructive button label
     */
    _init({gicon, title, verb}) {
        super._init({styleClass: 'app-uninstall-dialog', destroyOnClose: true});
        this._verb = verb;

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'app-uninstall-header',
        });
        header.add_child(new St.Icon({
            gicon,
            icon_size: ICON_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'app-uninstall-icon',
        }));
        this._content = new Dialog.MessageDialogContent({title, description: ''});
        header.add_child(this._content);
        this.contentLayout.add_child(header);

        this._busyBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'app-uninstall-busy',
        });
        this._spinner = new Animation.Spinner(16, {animate: true});
        this._busyBox.add_child(this._spinner);
        this._busyBox.add_child(new St.Label({
            text: 'Checking what will be removed…',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.contentLayout.add_child(this._busyBox);
        this._spinner.play();

        this._list = new Dialog.ListSection({title: ''});
        this._list.hide();
        this.contentLayout.add_child(this._list);

        this.phase = 'checking';
        this._setButtons([this._cancelButton('Cancel')]);
    }

    _cancelButton(label) {
        // default: Return / Enter cancel; Escape is mapped in _setButtons
        return {label, action: () => this.close(), default: true};
    }

    _setButtons(buttons) {
        this.setButtons(buttons);
        const cancel = buttons[0];
        if (this.dialogLayout?._buttonKeys)
            this.dialogLayout._buttonKeys[Clutter.KEY_Escape] = cancel;
        // buttons were replaced while open (or opening): focus back on Cancel
        if (this.state !== ModalDialog.State.CLOSED)
            cancel.button?.grab_key_focus();
    }

    // Escape also when the key focus is not inside the button row
    vfunc_key_release_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _stopBusy() {
        this._spinner.stop();
        this._busyBox.hide();
    }

    /**
     * @param {object} p
     * @param {string} p.description - one paragraph for the user
     * @param {string} [p.listTitle] - heading of the list
     * @param {Array<{title: string, description?: string, gicon?: Gio.Icon}>} [p.items]
     */
    setReady({description, listTitle = '', items = []}) {
        this._stopBusy();
        this.phase = 'ready';
        this._content.description = description;
        this._fillList(listTitle, items);
        this._setButtons([
            this._cancelButton('Cancel'),
            {
                label: this._verb,
                action: () => {
                    this.phase = 'confirmed';
                    this.emit('confirmed');
                    this.close();
                },
            },
        ]);
        const confirm = this.buttonLayout.get_children().at(-1);
        confirm?.add_style_class_name('app-uninstall-destructive');
    }

    setTitle(title) {
        this._content.title = title;
    }

    /** Removal not allowed or the check failed: explanation + Close. */
    setRefused(description, phase = 'refused', listTitle = '', items = []) {
        this._stopBusy();
        this.phase = phase;
        this._content.description = description;
        this._fillList(listTitle, items);
        this._setButtons([this._cancelButton('Close')]);
    }

    _fillList(title, items) {
        this._list.list.destroy_all_children();
        if (!items.length) {
            this._list.hide();
            return;
        }
        this._list.title = title;
        const shown = items.length > MAX_LIST + 1 ? items.slice(0, MAX_LIST) : items;
        for (const it of shown) {
            const icon = it.gicon
                ? new St.Icon({gicon: it.gicon, icon_size: LIST_ICON_SIZE})
                : new St.Icon({icon_name: 'package-x-generic-symbolic', icon_size: LIST_ICON_SIZE});
            this._list.list.add_child(new Dialog.ListSectionItem({
                icon_actor: icon,
                title: it.title,
                description: it.description ?? '',
            }));
        }
        if (shown.length < items.length) {
            this._list.list.add_child(new Dialog.ListSectionItem({
                title: `…and ${items.length - shown.length} more`,
                description: '',
            }));
        }
        this._list.show();
    }
});
