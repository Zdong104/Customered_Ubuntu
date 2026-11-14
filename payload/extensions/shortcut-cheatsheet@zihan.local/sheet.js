/**
 * The cheatsheet overlay: a centred, non-reactive panel in uiGroup. It never
 * takes a grab or key focus, so the focused app and mutter's keybinding code
 * keep seeing every key while it is up (that is what lets Super+<key> cancel
 * it and still run the shortcut).
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FADE_MS = 120;
const FIT_FRACTION = 0.94;   // of the work area, before we scale the panel down

// Prettier labels for single keys typed in the JSON
const KEY_LABELS = {
    left: '←', right: '→', up: '↑', down: '↓',
    return: '↵', enter: '↵',
    pageup: 'PgUp', page_up: 'PgUp', pgup: 'PgUp',
    pagedown: 'PgDn', page_down: 'PgDn', pgdn: 'PgDn',
    escape: 'Esc', esc: 'Esc',
    print: 'Print', prtsc: 'PrtSc',
    control: 'Ctrl', ctrl: 'Ctrl', primary: 'Ctrl',
    super: 'Super', meta: 'Super', win: 'Super',
    space: 'Space', tab: 'Tab', shift: 'Shift', alt: 'Alt',
    backspace: '⌫', delete: 'Del', del: 'Del',
};

function prettyKey(token) {
    const t = token.trim();
    return KEY_LABELS[t.toLowerCase()] ?? t;
}

/**
 * "Super+. / Ctrl+Super+Space"  -> alternatives
 * "Alt+PrtSc then R E I S U B"  -> steps of one alternative
 * "Ctrl+Alt+F3"                 -> keys of one step ('+' joins)
 * A step with spaces and no '+' ("R E I S U B") is a typed sequence.
 */
function parseKeys(spec) {
    return String(spec).split(/\s+\/\s+/).map(alt =>
        alt.split(/\s+then\s+|\s*,\s+/i).map(step => {
            const s = step.trim();
            if (!s.includes('+') && /\s/.test(s))
                return {seq: true, keys: s.split(/\s+/)};
            // split on '+' but keep a literal '+' key ("Ctrl++" or "Super++")
            const keys = s.split(/(?<!^)\+(?!$)/).flatMap(k => (k === '' ? ['+'] : [k]));
            return {seq: false, keys};
        }));
}

function sep(text) {
    return new St.Label({text, style_class: 'scs-sep', y_align: Clutter.ActorAlign.CENTER});
}

function cap(text) {
    const label = new St.Label({text: prettyKey(text), style_class: 'scs-cap', y_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.ellipsize = 0;   // Pango.EllipsizeMode.NONE
    return label;
}

function buildKeys(spec) {
    const box = new St.BoxLayout({style_class: 'scs-keys', x_align: Clutter.ActorAlign.END});
    parseKeys(spec).forEach((alt, ai) => {
        if (ai > 0)
            box.add_child(sep('/'));
        alt.forEach((step, si) => {
            if (si > 0)
                box.add_child(sep('then'));
            step.keys.forEach((k, ki) => {
                if (ki > 0 && !step.seq)
                    box.add_child(sep('+'));
                // "Hold Super" etc.: a word that is not a key name stays plain text
                if (/^(hold|press|tap)$/i.test(k))
                    box.add_child(sep(k.toLowerCase()));
                else
                    box.add_child(cap(k));
            });
        });
    });
    return box;
}

function buildRow(item, keyCells) {
    const row = new St.BoxLayout({style_class: 'scs-row'});
    const keys = buildKeys(item.keys ?? '');
    const keyCell = new St.Bin({style_class: 'scs-keycell', child: keys, x_align: Clutter.ActorAlign.FILL});
    keyCells.push(keyCell);   // widths equalized per column in present()
    row.add_child(keyCell);

    const text = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'scs-text',
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    const desc = new St.Label({text: String(item.desc ?? ''), style_class: 'scs-desc'});
    desc.clutter_text.line_wrap = true;
    text.add_child(desc);
    if (item.zh)
        text.add_child(new St.Label({text: String(item.zh), style_class: 'scs-zh'}));
    row.add_child(text);
    return row;
}

/** Split sections into n columns, keeping order, balancing row counts. */
function distribute(sections, n) {
    const weight = s => (s.items?.length ?? 0) + 1.6;   // header ~ 1.6 rows
    const total = sections.reduce((a, s) => a + weight(s), 0);
    const cols = Array.from({length: n}, () => []);
    let col = 0, acc = 0;
    for (const s of sections) {
        const w = weight(s);
        // move on when this column already holds its share and adding s overshoots more than not
        if (col < n - 1 && acc > 0 && acc + w / 2 > (total / n) * (col + 1))
            col++;
        cols[col].push(s);
        acc += w;
    }
    return cols.filter(c => c.length > 0);
}

export const Sheet = GObject.registerClass(
class ShortcutCheatsheetSheet extends St.BoxLayout {
    _init(config, opts) {
        super._init({
            name: 'shortcut-cheatsheet',
            style_class: 'scs-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            can_focus: false,
            opacity: 0,
        });
        if (opts.dark)
            this.add_style_class_name('scs-dark');

        const header = new St.BoxLayout({style_class: 'scs-header'});
        header.add_child(new St.Label({text: 'Keyboard Shortcuts', style_class: 'scs-title', y_align: Clutter.ActorAlign.END}));
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(new St.Label({
            text: `release Super to close · edit ${opts.configPath}`,
            style_class: 'scs-hint',
            y_align: Clutter.ActorAlign.END,
        }));
        this.add_child(header);

        if (opts.error) {
            this.add_child(new St.Label({text: opts.error, style_class: 'scs-error'}));
        }

        const sections = (config.sections ?? []).filter(s => Array.isArray(s.items) && s.items.length);
        const n = Math.max(1, Math.min(opts.columns, sections.length || 1));
        const grid = new St.BoxLayout({style_class: 'scs-grid'});
        this._keyColumns = [];
        for (const colSections of distribute(sections, n)) {
            const keyCells = [];
            this._keyColumns.push(keyCells);
            const col = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'scs-column',
            });
            for (const s of colSections) {
                col.add_child(new St.Label({text: String(s.title ?? ''), style_class: 'scs-section'}));
                for (const item of s.items)
                    col.add_child(buildRow(item, keyCells));
            }
            grid.add_child(col);
        }
        this.add_child(grid);
    }

    /** Centre in the work area of monitorIndex, shrinking if needed, fade in. */
    present(monitorIndex) {
        const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        // key-cap column of each grid column = its widest key combo (needs the
        // actor on stage so the theme is resolved)
        for (const cells of this._keyColumns) {
            const w = Math.max(0, ...cells.map(c => c.get_child().get_preferred_width(-1)[1]));
            for (const c of cells)
                c.set_width(Math.ceil(w));
        }
        const [, natW] = this.get_preferred_width(-1);
        const [, natH] = this.get_preferred_height(natW);
        const scale = Math.min(1,
            (area.width * FIT_FRACTION) / natW,
            (area.height * FIT_FRACTION) / natH);
        this.set_size(natW, natH);
        this.set_pivot_point(0.5, 0.5);
        this.set_scale(scale, scale);
        this.set_position(
            Math.round(area.x + (area.width - natW) / 2),
            Math.round(area.y + (area.height - natH) / 2));
        this.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return {natW, natH, scale};
    }
});
