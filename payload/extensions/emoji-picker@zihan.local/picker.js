/**
 * The picker popup: a modal chrome actor (never a window), so window-model
 * extensions (maximize-own, workspace-manage, islands, hide-minimized,
 * titlebar-below-panel ...) never see it.
 *
 *   backdrop  full-stage transparent St.Widget in Main.layoutManager.uiGroup;
 *             it holds the modal grab, eats clicks outside the panel (close)
 *   panel     search entry / section header / 9-column grid / category tabs
 *
 * Grid model: COLUMNS = 9 so a row has exactly as many cells as the digit
 * keys; the selected cell's row is the "active row" (faint blue band) and its
 * cells carry 1..9 badges, so number keys always mean "n-th emoji of the
 * highlighted row". Arrow keys move the selection, the badges follow.
 *
 * The UI is built on the first open and kept (hidden) afterwards; category
 * grids are built lazily and cached, search results are rebuilt per query.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const COLUMNS = 9;
const CELL = 38;          // px, must match .ep-cell in stylesheet.css
const VISIBLE_ROWS = 6;   // .ep-scroll height = VISIBLE_ROWS * CELL
const RECENT_ID = 'recent';

const MOD_MASK = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;

const DIGITS = new Map([
    [Clutter.KEY_1, 1], [Clutter.KEY_2, 2], [Clutter.KEY_3, 3],
    [Clutter.KEY_4, 4], [Clutter.KEY_5, 5], [Clutter.KEY_6, 6],
    [Clutter.KEY_7, 7], [Clutter.KEY_8, 8], [Clutter.KEY_9, 9],
    [Clutter.KEY_KP_1, 1], [Clutter.KEY_KP_2, 2], [Clutter.KEY_KP_3, 3],
    [Clutter.KEY_KP_4, 4], [Clutter.KEY_KP_5, 5], [Clutter.KEY_KP_6, 6],
    [Clutter.KEY_KP_7, 7], [Clutter.KEY_KP_8, 8], [Clutter.KEY_KP_9, 9],
]);

export class Picker {
    /**
     * @param {object} params
     * @param {EmojiData} params.data
     * @param {Function} params.getRecent   () => string[]
     * @param {Function} params.getTone     () => 0..5
     * @param {Function} params.onPick      (text, rec) => void, called after close
     * @param {Function} params.log
     */
    constructor({data, getRecent, getTone, onPick, log}) {
        this._data = data;
        this._getRecent = getRecent;
        this._getTone = getTone;
        this._onPick = onPick;
        this._log = log;

        this._grab = null;
        this._isOpen = false;
        this._grids = new Map();     // category id -> {box, rows, cells, items}
        this._searchGrid = null;
        this._current = null;        // grid currently shown
        this._catIndex = 0;
        this._sel = 0;
        this._activeRow = -1;
        this._lastMotion = [-1, -1];
        this._searchIdleId = 0;

        this._tabs = [{id: RECENT_ID, title: 'Recently Used', icon: 'emoji-recent-symbolic'},
            ...data.categories.map(c => ({id: c.id, title: c.title, icon: c.icon}))];

        this._buildUi();
    }

    get isOpen() {
        return this._isOpen;
    }

    // ---------------------------------------------------------------- UI

    _buildUi() {
        this._backdrop = new St.Widget({
            style_class: 'ep-backdrop',
            reactive: true,
            visible: false,
            x: 0, y: 0,
        });
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._backdrop.connect('button-press-event', this._onBackdropPress.bind(this));
        this._backdrop.connect('touch-event', this._onBackdropTouch.bind(this));
        this._backdrop.connect('captured-event', this._onCapturedEvent.bind(this));
        Main.layoutManager.uiGroup.add_child(this._backdrop);

        this._panel = new St.BoxLayout({
            style_class: 'ep-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._backdrop.add_child(this._panel);

        this._entry = new St.Entry({
            style_class: 'ep-search',
            hint_text: 'Search',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'ep-search-icon',
        }));
        this._entry.clutter_text.connect('text-changed', this._onSearchChanged.bind(this));
        this._panel.add_child(this._entry);

        const header = new St.BoxLayout({style_class: 'ep-header', x_expand: true});
        this._title = new St.Label({style_class: 'ep-section-title', y_align: Clutter.ActorAlign.CENTER});
        this._nameLabel = new St.Label({
            style_class: 'ep-selected-name',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._title);
        header.add_child(this._nameLabel);
        this._panel.add_child(header);

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'ep-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._empty = new St.Label({
            style_class: 'ep-empty',
            text: 'No Emoji Found',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._stack.add_child(this._scroll);
        this._stack.add_child(this._empty);
        this._panel.add_child(this._stack);

        this._tabBar = new St.BoxLayout({style_class: 'ep-tabs', x_expand: true});
        this._tabButtons = this._tabs.map((tab, i) => {
            const button = new St.Button({
                style_class: 'ep-tab',
                toggle_mode: false,
                can_focus: false,
                x_expand: true,
                child: new St.Icon({icon_name: tab.icon, style_class: 'ep-tab-icon'}),
            });
            button.accessible_name = tab.title;
            button.connect('clicked', () => this._showCategory(i));
            this._tabBar.add_child(button);
            return button;
        });
        this._panel.add_child(this._tabBar);

        this._colorSchemeId = St.Settings.get().connect('notify::color-scheme',
            () => this._syncColorScheme());
        this._syncColorScheme();
    }

    _syncColorScheme() {
        const dark = St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;
        if (dark)
            this._panel.add_style_class_name('ep-dark');
        else
            this._panel.remove_style_class_name('ep-dark');
    }

    _displayText(rec) {
        const tone = this._getTone();
        if (tone > 0 && rec.t)
            return rec.t[tone - 1];
        return rec.e;
    }

    /** items: [{text, rec}] -> grid object (not yet shown). */
    _buildGrid(items) {
        const box = new St.BoxLayout({
            style_class: 'ep-grid',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const rows = [];
        const cells = [];
        for (let r = 0; r * COLUMNS < items.length; r++) {
            const row = new St.BoxLayout({style_class: 'ep-row', x_align: Clutter.ActorAlign.START});
            box.add_child(row);
            rows.push(row);
            for (let c = 0; c < COLUMNS; c++) {
                const i = r * COLUMNS + c;
                if (i >= items.length) {
                    row.add_child(new St.Widget({style_class: 'ep-cell ep-cell-empty'}));
                    continue;
                }
                const cell = this._buildCell(items[i], i);
                row.add_child(cell);
                cells.push(cell);
            }
        }
        return {box, rows, cells, items};
    }

    _buildCell(item, index) {
        const inner = new St.Widget({layout_manager: new Clutter.BinLayout()});
        inner.add_child(new St.Label({
            style_class: 'ep-emoji',
            text: item.text,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        }));
        const cell = new St.Button({
            style_class: 'ep-cell',
            can_focus: false,
            track_hover: false,
            child: inner,
        });
        cell._epInner = inner;
        cell._epHint = null;
        cell.accessible_name = item.rec?.n ?? item.text;
        cell.connect('clicked', () => this._pick(index));
        cell.connect('motion-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            if (x === this._lastMotion[0] && y === this._lastMotion[1])
                return Clutter.EVENT_PROPAGATE;
            this._lastMotion = [x, y];
            if (this._sel !== index)
                this._select(index, false);
            return Clutter.EVENT_PROPAGATE;
        });
        return cell;
    }

    _setRowHints(rowIndex, visible) {
        const grid = this._current;
        if (!grid || rowIndex < 0)
            return;
        for (let c = 0; c < COLUMNS; c++) {
            const cell = grid.cells[rowIndex * COLUMNS + c];
            if (!cell)
                break;
            if (visible && !cell._epHint) {
                cell._epHint = new St.Label({
                    style_class: 'ep-hint',
                    text: `${c + 1}`,
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.END,
                    x_expand: true,
                    y_expand: true,
                });
                cell._epInner.add_child(cell._epHint);
            }
            if (cell._epHint)
                cell._epHint.visible = visible;
        }
        const row = grid.rows[rowIndex];
        if (row) {
            if (visible)
                row.add_style_class_name('ep-row-active');
            else
                row.remove_style_class_name('ep-row-active');
        }
    }

    /** Take the shown grid out of the scroll view (before destroying it). */
    _detachCurrent() {
        if (!this._current)
            return;
        this._setRowHints(this._activeRow, false);
        this._current.cells[this._sel]?.remove_style_pseudo_class('selected');
        this._scroll.set_child(null);
        this._current = null;
        this._activeRow = -1;
        this._sel = -1;
    }

    _setGrid(grid, title) {
        const prev = this._current;
        if (prev) {
            this._detachCurrent();
            if (prev === this._searchGrid && grid !== prev) {
                prev.box.destroy();
                this._searchGrid = null;
            }
        }
        this._current = grid;
        this._scroll.set_child(grid.box);
        this._scroll.vadjustment.value = 0;
        this._title.text = title;
        this._empty.visible = grid.items.length === 0;
        this._select(0, true);
    }

    _gridForCategory(i) {
        const tab = this._tabs[i];
        if (tab.id === RECENT_ID) {
            // rebuilt each time: content changes with every pick / tone change
            const items = [];
            for (const text of this._getRecent()) {
                const rec = this._data.lookup(text);
                items.push({text, rec});
            }
            const old = this._grids.get(RECENT_ID);
            if (old) {
                if (old === this._current)
                    this._detachCurrent();
                old.box.destroy();
            }
            const grid = this._buildGrid(items);
            this._grids.set(RECENT_ID, grid);
            return grid;
        }
        let grid = this._grids.get(tab.id);
        if (!grid) {
            const cat = this._data.categories.find(c => c.id === tab.id);
            grid = this._buildGrid(cat.emoji.map(rec => ({text: this._displayText(rec), rec})));
            this._grids.set(tab.id, grid);
        }
        return grid;
    }

    _showCategory(i) {
        const n = this._tabs.length;
        i = ((i % n) + n) % n;
        this._catIndex = i;
        this._tabButtons.forEach((b, j) => {
            if (j === i)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        });
        if (this._entry.text !== '') {
            this._suppressSearch = true;
            this._entry.text = '';
            this._suppressSearch = false;
        }
        this._setGrid(this._gridForCategory(i), this._tabs[i].title);
    }

    _onSearchChanged() {
        if (this._suppressSearch)
            return;
        if (this._searchIdleId)
            GLib.source_remove(this._searchIdleId);
        this._searchIdleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._searchIdleId = 0;
            this._runSearch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runSearch() {
        const query = this._entry.text;
        if (!query.trim()) {
            this._showCategory(this._catIndex);
            return;
        }
        const results = this._data.search(query);
        const grid = this._buildGrid(results.map(rec => ({text: this._displayText(rec), rec})));
        const old = this._searchGrid;
        if (old) {
            if (this._current === old)
                this._detachCurrent();
            old.box.destroy();
        }
        this._searchGrid = grid;
        this._tabButtons.forEach(b => b.remove_style_pseudo_class('checked'));
        this._setGrid(grid, results.length ? 'Search Results' : '');
    }

    // ---------------------------------------------------------- selection

    _select(index, scroll = true) {
        const grid = this._current;
        if (!grid)
            return;
        const n = grid.items.length;
        if (n === 0) {
            this._sel = -1;
            this._nameLabel.text = '';
            return;
        }
        index = Math.max(0, Math.min(n - 1, index));
        if (this._sel >= 0)
            grid.cells[this._sel]?.remove_style_pseudo_class('selected');
        this._sel = index;
        grid.cells[index].add_style_pseudo_class('selected');

        const row = Math.floor(index / COLUMNS);
        if (row !== this._activeRow) {
            this._setRowHints(this._activeRow, false);
            this._activeRow = row;
            this._setRowHints(row, true);
        }
        const item = grid.items[index];
        this._nameLabel.text = item.rec?.n ?? '';
        if (scroll)
            this._ensureRowVisible(row);
    }

    _ensureRowVisible(row) {
        const adj = this._scroll.vadjustment;
        const top = row * CELL;
        const bottom = top + CELL;
        if (top < adj.value)
            adj.value = top;
        else if (bottom > adj.value + adj.page_size)
            adj.value = bottom - adj.page_size;
    }

    _move(dx, dy) {
        if (!this._current || this._sel < 0)
            return;
        const n = this._current.items.length;
        let i = this._sel;
        if (dx)
            i = Math.max(0, Math.min(n - 1, i + dx));
        if (dy) {
            const target = i + dy * COLUMNS;
            if (target >= n) {
                // like macOS: from the second-last row, Down lands on the last item
                const lastRow = Math.floor((n - 1) / COLUMNS);
                if (Math.floor(i / COLUMNS) < lastRow)
                    i = n - 1;
            } else if (target >= 0) {
                i = target;
            }
        }
        this._select(i);
    }

    _pick(index) {
        const item = this._current?.items[index];
        if (!item)
            return;
        this.close();
        this._onPick(item.text, item.rec);
    }

    // ------------------------------------------------------------- events

    _insidePanel(x, y) {
        const [px, py] = this._panel.get_transformed_position();
        const [pw, ph] = this._panel.get_transformed_size();
        return x >= px && y >= py && x < px + pw && y < py + ph;
    }

    _onBackdropPress(_actor, event) {
        const [x, y] = event.get_coords();
        if (!this._insidePanel(x, y)) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onBackdropTouch(_actor, event) {
        if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        return this._onBackdropPress(_actor, event);
    }

    _onCapturedEvent(_actor, event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        // an input method is composing (pinyin in the search box): leave
        // arrows / digits / Enter / Esc to it
        if (Main.inputMethod.hasPreedit?.())
            return Clutter.EVENT_PROPAGATE;

        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const otherMods = (state & MOD_MASK) !== 0;

        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._entry.text !== '' && !otherMods)
                this._entry.text = '';
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._pick(this._sel);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_KP_Tab:
            this._showCategory(this._catIndex + (shift ? -1 : 1));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            this._showCategory(this._catIndex - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Left:
        case Clutter.KEY_KP_Left:
            if (ctrl)
                this._showCategory(this._catIndex - 1);
            else
                this._move(-1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
        case Clutter.KEY_KP_Right:
            if (ctrl)
                this._showCategory(this._catIndex + 1);
            else
                this._move(1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._move(0, -1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._move(0, 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
        case Clutter.KEY_KP_Page_Up:
            this._move(0, -(VISIBLE_ROWS - 1));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
        case Clutter.KEY_KP_Page_Down:
            this._move(0, VISIBLE_ROWS - 1);
            return Clutter.EVENT_STOP;
        }

        if (DIGITS.has(sym) && !otherMods) {
            const n = DIGITS.get(sym);
            if (this._activeRow >= 0)
                this._pick(this._activeRow * COLUMNS + n - 1);
            return Clutter.EVENT_STOP;
        }

        // everything else (letters, Backspace, Ctrl+A/V ...) goes to the search box
        if (global.stage.key_focus !== this._entry.clutter_text)
            this._entry.clutter_text.grab_key_focus();
        return Clutter.EVENT_PROPAGATE;
    }

    // ------------------------------------------------------- open / close

    /**
     * @param {object|null} caret  {x, y, width, height} in stage coordinates
     * @param {number} monitorIndex
     */
    open(caret, monitorIndex) {
        if (this._isOpen)
            return true;

        this._backdrop.visible = true;
        Main.layoutManager.uiGroup.set_child_above_sibling(this._backdrop, null);
        this._panel.opacity = 0;

        const grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        // older Clutter could refuse a grab (get_seat_state); GNOME 50 always grants it
        if (grab.get_seat_state && (grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            this._backdrop.visible = false;
            this._log('could not grab the keyboard; not opening');
            return false;
        }
        this._grab = grab;
        this._isOpen = true;

        // reset state: empty search, recents first when there are any
        this._suppressSearch = true;
        this._entry.text = '';
        this._suppressSearch = false;
        if (this._searchGrid) {
            if (this._current === this._searchGrid)
                this._detachCurrent();
            this._searchGrid.box.destroy();
            this._searchGrid = null;
        }
        const tone = this._getTone();
        if (tone !== this._builtTone) {
            for (const [id, grid] of this._grids) {
                if (grid === this._current)
                    this._detachCurrent();
                grid.box.destroy();
                this._grids.delete(id);
            }
            this._builtTone = tone;
        }
        this._showCategory(this._getRecent().length > 0 ? 0 : 1);
        this._entry.clutter_text.grab_key_focus();

        this._place(caret, monitorIndex);
        this._panel.ease({
            opacity: 255,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return true;
    }

    _place(caret, monitorIndex) {
        const [, natW] = this._panel.get_preferred_width(-1);
        const [, natH] = this._panel.get_preferred_height(natW);
        let area;
        if (caret) {
            const mon = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({
                    x: Math.round(caret.x), y: Math.round(caret.y),
                    width: Math.max(1, Math.round(caret.width)),
                    height: Math.max(1, Math.round(caret.height)),
                }));
            area = Main.layoutManager.getWorkAreaForMonitor(mon >= 0 ? mon : monitorIndex);
        } else {
            area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        }

        let x, y;
        if (caret) {
            x = caret.x - 16;
            y = caret.y + caret.height + 6;
            if (y + natH > area.y + area.height)
                y = caret.y - natH - 6;   // no room below: open above the caret
        } else {
            x = area.x + (area.width - natW) / 2;
            y = area.y + (area.height - natH) / 2;
        }
        x = Math.max(area.x + 8, Math.min(x, area.x + area.width - natW - 8));
        y = Math.max(area.y + 8, Math.min(y, area.y + area.height - natH - 8));
        this._panel.set_position(Math.round(x), Math.round(y));
        this._log(`open at ${Math.round(x)},${Math.round(y)} size ${natW}x${natH} ` +
            `(${caret ? 'caret' : `centred on monitor ${monitorIndex}`})`);
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        if (this._searchIdleId) {
            GLib.source_remove(this._searchIdleId);
            this._searchIdleId = 0;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._panel.remove_all_transitions();
        this._backdrop.visible = false;
    }

    destroy() {
        this.close();
        if (this._colorSchemeId) {
            St.Settings.get().disconnect(this._colorSchemeId);
            this._colorSchemeId = 0;
        }
        this._backdrop.destroy();
        this._grids.clear();
        this._searchGrid = null;
        this._current = null;
    }

    // ------------------------------------------------- test / debug hooks

    debugState() {
        return {
            open: this._isOpen,
            category: this._tabs[this._catIndex]?.id,
            search: this._entry.text,
            selected: this._sel,
            activeRow: this._activeRow,
            selectedText: this._current?.items[this._sel]?.text ?? null,
            count: this._current?.items.length ?? 0,
            panel: [...this._panel.get_transformed_position(), ...this._panel.get_transformed_size()],
        };
    }
}
