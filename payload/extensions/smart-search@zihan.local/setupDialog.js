/**
 * Guided first-run setup for inline flight status (AeroDataBox via RapidAPI).
 *
 * Opened from the "Sign in free to show flight status" row. It never opens
 * the browser by itself: step 1 has a button for that. The key entry is
 * labelled as an API key over and over (hint text + a note right under it)
 * because a bare password-style field once got the user's laptop password.
 *
 * Verify & save: local format check (nothing sent if it fails), then ONE
 * request for the flight that was searched (services.verifyAndSaveFlightKey),
 * then the key is written 0600 and the cache seeded. The key text is cleared
 * from the entry as soon as it has been handed over.
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';

import {SIGNUP_URL, checkKeyFormat} from './keySetup.js';

const INTRO = 'Quick Answers uses AeroDataBox for live flight data. Their Basic plan is free ' +
    '(about 200 lookups a month) and never charges you. This is a one-time setup.';
const STEPS = [
    'Open the sign-up page',
    'Sign up or log in to RapidAPI (a Google or GitHub account works)',
    'Choose the Basic plan ($0 / month) and click Subscribe',
    'Open the Endpoints/Playground tab and copy the value next to X-RapidAPI-Key (about 50 letters and numbers)',
    'Paste it below',
];

function wrapLabel(text, params = {}) {
    const label = new St.Label({text, x_expand: true, ...params});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

export const FlightSetupDialog = GObject.registerClass(
class FlightSetupDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} p
     * @param {object} p.services   services.js instance
     * @param {string} p.flight     e.g. 'DL1847' (verification request + first result)
     * @param {Function} p.onDone   called after [Done] on success
     */
    _init({services, flight, onDone}) {
        super._init({styleClass: 'prompt-dialog', destroyOnClose: true});
        this._services = services;
        this._flight = flight;
        this._onDone = onDone;
        this._busy = false;
        this._succeeded = false;
        this.connect('destroy', () => {
            this._destroyed = true;
            this._spinner?.stop();
            this._services = null;
            this._onDone = null;
        });

        this._content = new Dialog.MessageDialogContent({
            title: 'Show flight status in search',
            description: INTRO,
        });
        this.contentLayout.add_child(this._content);

        // numbered steps; step 1 carries the (user-controlled) browser button
        this._steps = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'spacing: 8px; padding-top: 12px; max-width: 30em;',
        });
        STEPS.forEach((text, i) => {
            const line = new St.BoxLayout({x_expand: true, style: 'spacing: 12px;'});
            line.add_child(wrapLabel(`${i + 1}.  ${text}`, {y_align: Clutter.ActorAlign.CENTER}));
            if (i === 0) {
                this._openButton = new St.Button({
                    style_class: 'button',
                    label: 'Open sign-up page',
                    can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._openButton.connect('clicked', () => this._openSignup());
                line.add_child(this._openButton);
            }
            this._steps.add_child(line);
        });
        this.contentLayout.add_child(this._steps);

        // the key entry: an API key, never the computer password
        this._entryBox = new St.BoxLayout({x_expand: true, style: 'spacing: 8px; padding-top: 14px;'});
        this._entry = new St.PasswordEntry({
            style_class: 'prompt-dialog-password-entry',
            hint_text: 'Paste your X-RapidAPI-Key here',
            can_focus: true,
            x_expand: true,
            show_peek_icon: true,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.clutter_text.connect('activate', () => this._verify());
        this._entry.clutter_text.connect('text-changed', () => this._setError(''));
        this._entryBox.add_child(this._entry);
        this._pasteButton = new St.Button({
            style_class: 'button',
            can_focus: true,
            accessible_name: 'Paste',
            child: new St.Icon({icon_name: 'edit-paste-symbolic', icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pasteButton.connect('clicked', () => this._paste());
        this._entryBox.add_child(this._pasteButton);
        this.contentLayout.add_child(this._entryBox);

        this._note = wrapLabel('This is an API key from RapidAPI — NOT your computer password.', {
            style_class: 'prompt-dialog-info-label',
            style: 'opacity: 0.7; font-size: 0.9em;',
        });
        this.contentLayout.add_child(this._note);

        this._error = wrapLabel('', {style_class: 'prompt-dialog-error-label', visible: false});
        this.contentLayout.add_child(this._error);

        this._status = new St.BoxLayout({style: 'spacing: 8px;', visible: false});
        // fixed 16 px, no fade: shown only while a request is in flight
        this._spinner = new Spinner(16, {animate: false, hideOnStop: true});
        this._spinner.y_align = Clutter.ActorAlign.CENTER;
        this._status.add_child(this._spinner);
        this._status.add_child(new St.Label({text: 'Checking…', y_align: Clutter.ActorAlign.CENTER}));
        this.contentLayout.add_child(this._status);

        this._success = wrapLabel('✓ Flight status is on. Search a flight number anytime.', {
            visible: false,
            style: 'font-weight: bold; padding-top: 12px;',
        });
        this.contentLayout.add_child(this._success);

        this._notNowButton = this.addButton({
            label: 'Not now',
            action: () => this._notNow(),
            key: Clutter.KEY_Escape,
        });
        this._verifyButton = this.addButton({
            label: 'Verify & save',
            action: () => this._verify(),
            default: true,
        });
        this.setInitialKeyFocus(this._entry);
    }

    // test hooks / state
    get entry() {
        return this._entry;
    }

    get errorText() {
        return this._error.visible ? this._error.text : '';
    }

    get succeeded() {
        return this._succeeded;
    }

    _openSignup() {
        try {
            Gio.AppInfo.launch_default_for_uri(SIGNUP_URL, global.create_app_launch_context(0, -1));
        } catch (e) {
            this._setError(`Couldn't open the browser: ${e.message}. Visit ${SIGNUP_URL}`);
        }
    }

    _paste() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (this._destroyed || !text)
                return;
            this._entry.set_text(text.trim());
            this._entry.grab_key_focus();
        });
    }

    _setError(text) {
        this._error.text = text;
        this._error.visible = !!text;
    }

    _setBusy(busy) {
        this._busy = busy;
        for (const w of [this._notNowButton, this._verifyButton, this._openButton, this._pasteButton]) {
            w.reactive = !busy;
            w.can_focus = !busy;
        }
        this._entry.reactive = !busy;
        this._entry.clutter_text.editable = !busy;
        this._status.visible = busy;
        if (busy)
            this._spinner.play();
        else
            this._spinner.stop();
    }

    /** End state: no spinner anywhere (it is destroyed on success). */
    _stopSpinner() {
        this._spinner?.stop();
        if (this._status)
            this._status.visible = false;
    }

    get spinnerShown() {
        return !!this._spinner && this._spinner.visible && this._status.visible;
    }

    _notNow() {
        if (this._busy)
            return;
        this._stopSpinner();
        this._entry.set_text('');
        this.close();
    }

    async _verify() {
        if (this._busy || this._succeeded || this._destroyed)
            return;
        const fmt = checkKeyFormat(this._entry.get_text());
        if (!fmt.ok) {
            this._setError(fmt.error);
            this._entry.grab_key_focus();
            return;
        }
        this._setError('');
        this._setBusy(true);
        let res;
        try {
            res = await this._services.verifyAndSaveFlightKey(fmt.key, this._flight);
        } catch (e) {
            res = {ok: false, message: `Something went wrong: ${e.message}`};
        }
        if (this._destroyed)
            return;
        this._setBusy(false);
        this._stopSpinner();
        if (!res.ok) {
            this._setError(res.message);
            this._entry.grab_key_focus();
            return;
        }
        this._showSuccess();
    }

    _showSuccess() {
        this._succeeded = true;
        this._stopSpinner();
        this._status.destroy();
        this._status = null;
        this._spinner = null;
        this._entry.set_text('');
        this._steps.hide();
        this._entryBox.hide();
        this._note.hide();
        this._setError('');
        this._success.show();
        this.clearButtons();
        const done = this.addButton({
            label: 'Done',
            action: () => this._done(),
            default: true,
        });
        // Escape closes too (same as Done)
        if (this.dialogLayout._buttonKeys)
            this.dialogLayout._buttonKeys[Clutter.KEY_Escape] = {button: done, action: () => this._done()};
        done.grab_key_focus();
    }

    _done() {
        const cb = this._onDone;
        this.close();
        cb?.();
    }
});
