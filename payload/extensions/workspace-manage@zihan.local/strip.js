/**
 * What both thumbnail strips share: the "+" button, the hover "×", and the
 * drag that reorders.
 *
 * The primary monitor's strip is stock GNOME's ThumbnailsBox; a secondary
 * monitor's is Workspace Islands' own. They have nothing in common but the
 * shape, so each side (primary.js, islands.js) describes its strip with an
 * adapter and this module does the rest:
 *
 *   adapter.strip         the actor the thumbnails are direct children of
 *   adapter.slots()       thumbnail actors, in workspace order, or null while
 *                         the strip is animating and must not be reordered
 *   adapter.indicator     the active-workspace frame, moved along in a preview
 *   adapter.activeIndex() which slot it frames
 *   adapter.commit(f, t)  apply the reorder; returns true if the strip will be
 *                         rebuilt from scratch (then nothing is put back)
 *   adapter.onDragChanged()  a drag began or ended (close buttons hide)
 *   adapter.place         what the strip shows, for a move to another monitor:
 *                         {kind: 'primary'} or {kind: 'virtual', state}
 *   adapter.canTake()     room for one more workspace dropped from elsewhere
 *
 * ## Telling a thumbnail drag from a window drag
 *
 * DND hands every drop target the source's `_delegate`. A window drag's source
 * has `metaWindow`; ours is the thumbnail itself, tagged with REORDER. Each
 * strip's drop handler checks the tag first and passes anything else to the
 * code that was there before, so dropping a window on a thumbnail is untouched.
 *
 * ## The preview
 *
 * Nothing is reordered until the drop. While dragging, the dragged thumbnail is
 * left in its slot but made invisible (the drag actor is a Clutter.Clone, which
 * paints its source at its own opacity, so it is unaffected) and the ones
 * between it and the target slide over by one slot with translation_x. That
 * opens a gap where it will land, which is what Mission Control shows. Only
 * translations change, never the strip's own child order or allocation, so the
 * stock and islands bookkeeping never see a half-done reorder.
 *
 * ## Dropping on another monitor's strip
 *
 * A thumbnail dragged onto another strip moves the whole workspace to that
 * monitor (Mission Control's drag of a space to another display). The target
 * strip shows a bar in the gap where it will be inserted; nothing slides
 * there, so neither strip's layout is touched before the drop. The move
 * itself is cross.js's, handed in with setMover(): this module only knows
 * strips. The source strip goes back to its original order as soon as the
 * pointer leaves it, and if the move took its workspace away the dragged
 * thumbnail is not shown again (it is on its way out).
 *
 * ## The drop band (the "magnet")
 *
 * A strip is only as wide as its thumbnails, so on a monitor with one
 * workspace a drop had to land right on it. For the length of a drag every
 * OTHER monitor that shows a strip gets an invisible catcher (a plain actor
 * in Main.uiGroup, under the drag actor, so DND picks it first): the full
 * monitor width, from the monitor's top edge down to one thumbnail height
 * below the strip. Anywhere in it the workspace goes to the gap nearest the
 * pointer's x along that strip (clamped to before-first / after-last; "+"
 * counts as after-last), with the insertion bar there and the strip lit up.
 * The source monitor gets no catcher, so a reorder on its own strip is what
 * it was; and the rest of a monitor (its window picker) is no band, so a
 * reorder that overshoots onto the monitor above the strip does nothing.
 *
 * ## Dropping a full-screen space on another (Split View)
 *
 * On any strip (primary, or a secondary's islands strip since 2026-11-09), a
 * thumbnail whose workspace is a full-screen space, held over the inner part
 * of another full-screen space's thumbnail on the SAME strip (not its outer
 * SPLIT_EDGE on either side, not a gap), lights the half under the pointer
 * instead of opening a reorder gap; dropped there, the two windows become a
 * 50/50 pair on the target and the dragged workspace goes. That is
 * maximize-own-workspace's Split View (setSplitter()); without it a drag only
 * reorders. A thumbnail dropped on another monitor's strip always moves the
 * workspace (cross.js), never splits.
 *
 * Split View is told which workspace a thumbnail shows by placeRefOf(): the
 * Meta.Workspace of a stock thumbnail, or {kind: 'virt', state, group} (the
 * islands group Set) of an islands one.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** On a thumbnail we made draggable: its strip's adapter. */
export const REORDER = Symbol('workspace-manage.reorder');

/** On a thumbnail: its "×" button. On a strip: its "+" button. */
export const CLOSE = Symbol('workspace-manage.close');
export const ADD = Symbol('workspace-manage.add');

/** On a thumbnail: the Draggable we attached. */
const DRAGGABLE = Symbol('workspace-manage.draggable');

/** On a strip: the insertion bar shown while a foreign workspace hovers it. */
const MARKER = Symbol('workspace-manage.marker');

/** On a drop-band catcher: the adapter of the strip it feeds. */
const BAND = Symbol('workspace-manage.band');

/** Style class a strip wears while a foreign workspace would drop on it. */
const DROP_TARGET_CLASS = 'workspace-manage-drop-target';

/** How far a drop band reaches below its strip, in thumbnail heights... */
const BAND_BELOW_THUMBNAILS = 1;
/** ...and at least this far (px), for a strip of very flat thumbnails. */
const BAND_BELOW_MIN = 48;

const SHIFT_TIME = 150;
/** A moved-away workspace's thumbnail not gone by then is shown again. */
const KEPT_CHECK_MS = 6000;
/** How far the "×" hangs out past the thumbnail's top-right corner. */
const CLOSE_OVERHANG = 7;
/** How far the insertion bar reaches above and below the thumbnails. */
const MARKER_OVERHANG = 4;

/** The drag in progress, if any. One pointer, one drag. */
let current = null;

/**
 * Every strip with reorderable thumbnails (adapter -> its strip's destroy
 * handler id): the candidates for a drop band when a drag begins.
 */
const known = new Map();

/**
 * Moves a workspace between strips:
 * (sourceAdapter, from, targetAdapter, index) -> {sourceRemoved} or null.
 */
let mover = null;

export function setMover(fn) {
    mover = fn;
    if (!fn)
        removeBands();
}

/**
 * Split View's thumbnail API (maximize-own-workspace@zihan.local), looked up
 * at each use: () -> {thumbnailSplitHover, thumbnailSplitClear,
 * thumbnailSplitDrop} or null. Without it a drag only ever reorders.
 */
let splitter = null;

export function setSplitter(fn) {
    splitter = fn;
}

/**
 * Dropping a full-screen space's thumbnail on another one's makes the two a
 * Split View pair (primary strip only). Only over the target's inner part:
 * the outer SPLIT_EDGE of its width on either side, and the gaps, reorder as
 * before. Either the half highlight or the reorder preview, never both.
 */
const SPLIT_EDGE = 0.2;

// ---- buttons -----------------------------------------------------------------

/**
 * The "+" at the end of a strip. Also a drop target: a window dropped on it
 * gets a new workspace of its own, as in Mission Control.
 *
 * @param {object} handlers
 * @param {() => void} handlers.add
 * @param {(window: Meta.Window) => boolean} handlers.addWithWindow
 */
export function makeAddButton({add, addWithWindow}) {
    const button = new St.Button({
        style_class: 'workspace-manage-add',
        child: new St.Icon({icon_name: 'list-add-symbolic'}),
        accessible_name: 'Add workspace',
        can_focus: true,
        y_expand: false,
    });
    button.connect('clicked', () => add());

    button._delegate = {
        handleDragOver(source) {
            return source?.metaWindow
                ? DND.DragMotionResult.MOVE_DROP
                : DND.DragMotionResult.CONTINUE;
        },
        acceptDrop(source) {
            if (!source?.metaWindow)
                return false;
            return addWithWindow(source.metaWindow);
        },
    };
    return button;
}

/** Room the "+" needs next to the thumbnails, or 0 when it is hidden. */
export function addButtonExtent(strip) {
    const button = strip[ADD];
    if (!button?.visible)
        return 0;
    const [, width] = button.get_preferred_width(-1);
    return width + strip.get_theme_node().get_length('spacing');
}

/**
 * Put the "+" right after the right-most thumbnail, as tall as the
 * thumbnails. Call after the strip laid out its thumbnails.
 */
export function allocateAddButton(strip, thumbnails) {
    const button = strip[ADD];
    if (!button)
        return;

    const box = new Clutter.ActorBox();
    const placed = thumbnails.filter(t => t.visible);
    if (!button.visible || placed.length === 0) {
        button.allocate(box);
        return;
    }

    const spacing = strip.get_theme_node().get_length('spacing');
    const [, width] = button.get_preferred_width(-1);
    const {y1, y2} = placed[0].allocation;
    const x2 = Math.max(...placed.map(t => t.allocation.x2));
    box.set_origin(Math.round(x2 + spacing), y1);
    box.set_size(width, y2 - y1);
    button.allocate(box);
}

/**
 * A hover "×" hanging off a thumbnail's top-right corner.
 * `canClose()` is asked on every hover change: never on the last workspace,
 * never mid-drag.
 *
 * The button is the strip's child, not the thumbnail's: the strip draws its
 * active-workspace highlight above the thumbnails, so only a sibling raised
 * over that highlight shows on the selected thumbnail. The strip places it
 * (allocateCloseButtons) and the thumbnail's clip doesn't reach it.
 */
export function addCloseButton(thumbnail, {close, canClose}) {
    const strip = thumbnail.get_parent();
    if (!strip)
        return null;
    const button = new St.Button({
        style_class: 'workspace-manage-close',
        child: new St.Icon({icon_name: 'window-close-symbolic'}),
        accessible_name: 'Remove workspace',
        visible: false,
    });
    button.connect('clicked', () => close());
    strip.add_child(button);
    thumbnail[CLOSE] = button;
    button._wmCanClose = canClose;

    // Hover is the thumbnail's or the button's own, since the button is no
    // longer inside the thumbnail. Going from one to the other passes through
    // a moment where neither is hovered, so hiding waits for the next idle.
    const sync = () => syncCloseButton(thumbnail, canClose, true);
    thumbnail.reactive = true;
    thumbnail.track_hover = true;
    button._wmHoverId = thumbnail.connect('notify::hover', sync);
    button._wmDestroyId = thumbnail.connect('destroy', () => removeCloseButton(thumbnail));

    // Clicking the "×" must not also count as clicking the strip. The click
    // gestures that would see it are disabled while the pointer is on the
    // button, and given back when it leaves or goes away (a removed
    // workspace takes its button with it, hovered).
    button.track_hover = true;
    button.connect('notify::hover', () => {
        blockClicks(button, button.hover && button.visible);
        sync();
    });
    button.connect('destroy', () => {
        blockClicks(button, false);
        if (button._wmIdleId)
            GLib.source_remove(button._wmIdleId);
        button._wmIdleId = 0;
    });
    return button;
}

function blockClicks(button, block) {
    if (block === !!button._wmBlocked)
        return;
    if (block) {
        button._wmBlocked = clickGesturesAbove(button).filter(g => g.enabled);
        for (const gesture of button._wmBlocked)
            gesture.enabled = false;
    } else {
        for (const gesture of button._wmBlocked)
            gesture.enabled = true;
        button._wmBlocked = null;
    }
}

export function syncCloseButton(thumbnail, canClose, deferHide = false) {
    const button = thumbnail[CLOSE];
    if (!button)
        return;
    const show = (thumbnail.hover || button.hover) && !current && canClose();
    if (show) {
        if (button._wmIdleId)
            GLib.source_remove(button._wmIdleId);
        button._wmIdleId = 0;
        if (!button.visible) {
            button.get_parent()?.set_child_above_sibling(button, null);
            button.show();
        }
        return;
    }
    if (deferHide) {
        if (!button._wmIdleId) {
            button._wmIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                button._wmIdleId = 0;
                syncCloseButton(thumbnail, canClose);
                return GLib.SOURCE_REMOVE;
            });
        }
        return;
    }
    button.hide();
    blockClicks(button, false);
}

export function removeCloseButton(thumbnail) {
    const button = thumbnail[CLOSE];
    if (!button)
        return;
    delete thumbnail[CLOSE];
    thumbnail.disconnect(button._wmHoverId);
    thumbnail.disconnect(button._wmDestroyId);
    thumbnail.track_hover = false;
    button.destroy();
}

/**
 * Places each visible "×" over its thumbnail's top-right corner, hanging out
 * past it. Called from the strip's allocation, after the thumbnails'.
 */
export function allocateCloseButtons(thumbnails) {
    for (const thumbnail of thumbnails) {
        const button = thumbnail[CLOSE];
        if (!button?.visible)
            continue;
        const [, width] = button.get_preferred_width(-1);
        const [, height] = button.get_preferred_height(width);
        const {x2, y1} = thumbnail.allocation;
        const box = new Clutter.ActorBox();
        box.set_origin(
            Math.round(x2 + thumbnail.translation_x - width + CLOSE_OVERHANG),
            Math.round(y1 + thumbnail.translation_y - CLOSE_OVERHANG));
        box.set_size(width, height);
        button.allocate(box);
    }
}

function clickGesturesAbove(actor) {
    const gestures = [];
    for (let a = actor.get_parent(); a; a = a.get_parent()) {
        for (const action of a.get_actions())
            if (action instanceof Clutter.ClickGesture)
                gestures.push(action);
        if (a[ADD] !== undefined || a._delegate?.handleDragOver)
            break; // the strip: nothing above it is ours to touch
    }
    return gestures;
}

// ---- reorder drag -------------------------------------------------------------

/** Make a thumbnail the source of a reorder drag. */
export function makeReorderable(thumbnail, adapter) {
    if (thumbnail[DRAGGABLE])
        return;

    thumbnail[REORDER] = adapter;
    remember(adapter);
    // DND asks the source's _delegate for these. The stock and the islands
    // thumbnails are both their own delegate.
    thumbnail.getDragActor = () => {
        // Not get_transformed_size(): once the thumbnail is see-through (as
        // the drag makes it) that reports the unclipped extents of the
        // monitor-sized contents inside it.
        const scale = stageScale(thumbnail);
        const [width, height] = thumbnail.allocation.get_size();
        return new Clutter.Clone({
            source: thumbnail,
            width: Math.round(width * scale),
            height: Math.round(height * scale),
        });
    };
    thumbnail.getDragActorSource = () => thumbnail;

    const draggable = DND.makeDraggable(thumbnail, {restoreOnSuccess: false});
    draggable.connect('drag-begin', () => begin(thumbnail));
    draggable.connect('drag-cancelled', () => cancel(thumbnail));
    draggable.connect('drag-end', () => end(thumbnail));
    thumbnail[DRAGGABLE] = draggable;
}

export function unmakeReorderable(thumbnail) {
    const draggable = thumbnail[DRAGGABLE];
    if (!draggable)
        return;
    thumbnail.remove_action(draggable.startGesture);
    delete thumbnail[DRAGGABLE];
    delete thumbnail[REORDER];
    delete thumbnail.getDragActor;
    delete thumbnail.getDragActorSource;
}

/** True if `source` is a reorder drag that belongs to this strip. */
export function isOurDrag(source, strip) {
    return !!current && source === current.thumbnail && current.adapter.strip === strip;
}

/** A reorder drag in progress from some strip: `source` is its thumbnail. */
function isCurrent(source) {
    return !!current && source === current.thumbnail;
}

/**
 * A workspace from another strip (`source`, its thumbnail) over this one
 * (`adapter`'s), at strip-local `x`: show where it would be inserted.
 */
export function dragOverOther(source, adapter, x) {
    const index = foreignIndex(source, adapter, x);
    if (index < 0) {
        hideMarker();
        return DND.DragMotionResult.NO_DROP;
    }
    showMarker(adapter, index);
    return DND.DragMotionResult.MOVE_DROP;
}

/** A workspace from another strip dropped on this one. True if it moved. */
export function dropOther(source, adapter, x) {
    const index = foreignIndex(source, adapter, x);
    hideMarker();
    if (index < 0)
        return false;

    // The source strip must still show what it did when the drag began.
    const {from} = current;
    const slots = current.adapter.slots();
    if (!slots || slots.indexOf(current.thumbnail) !== from)
        return false;

    let result = null;
    try {
        result = mover(current.adapter, from, adapter, index);
    } catch (e) {
        console.error(`workspace-manage: moving workspace: ${e}\n${e.stack}`);
    }
    if (!result)
        return false;
    current.sourceGone = !!result.sourceRemoved;
    resetShifts(false);
    return true;
}

/** Where a foreign drag at `x` would land in `adapter`'s strip, or -1. */
function foreignIndex(source, adapter, x) {
    if (!isCurrent(source) || current.from < 0 || !mover || !adapter ||
        adapter === current.adapter)
        return -1;
    if (!adapter.place || !current.adapter.place || !adapter.canTake?.())
        return -1;
    const slots = adapter.slots();
    if (!slots || slots.length === 0)
        return -1;
    return targetSlot(slots, -1, x);
}

// ---- insertion bar ---------------------------------------------------------------

function showMarker(adapter, index) {
    const strip = adapter.strip;
    if (current.over && current.over.adapter !== adapter)
        hideMarker();

    let marker = strip[MARKER];
    if (!marker) {
        marker = new St.Widget({style_class: 'workspace-manage-drop-marker'});
        strip.add_child(marker);
        strip[MARKER] = marker;
        marker.connect('destroy', () => {
            if (strip[MARKER] === marker)
                delete strip[MARKER];
        });
    }
    if (current.over?.index === index && marker.visible)
        return;

    current.over = {adapter, index};
    marker._wmIndex = index;
    marker._wmSlots = adapter.slots();
    strip.set_child_above_sibling(marker, null);
    marker.show();
    strip.add_style_class_name(DROP_TARGET_CLASS);
    strip.queue_relayout();
}

/** On disable: take the insertion bar (and the drop band) off a strip. */
export function removeDropMarker(strip) {
    strip[MARKER]?.destroy();
    delete strip[MARKER];
    strip.remove_style_class_name(DROP_TARGET_CLASS);
    for (const [adapter, id] of known) {
        if (adapter.strip !== strip)
            continue;
        strip.disconnect(id);
        known.delete(adapter);
    }
    if (current?.bands?.some(b => b[BAND].strip === strip))
        removeBands();
}

function hideMarker() {
    const over = current?.over;
    if (!over)
        return;
    current.over = null;
    const marker = over.adapter.strip[MARKER];
    if (marker?.get_stage()) {
        marker.hide();
        over.adapter.strip.remove_style_class_name(DROP_TARGET_CLASS);
        over.adapter.strip.queue_relayout();
    }
}

// ---- drop bands ------------------------------------------------------------------

function remember(adapter) {
    if (known.has(adapter))
        return;
    known.set(adapter, adapter.strip.connect('destroy', () => known.delete(adapter)));
}

/** Product of the scales from `actor` up to the stage. */
function stageScale(actor) {
    let scale = 1;
    for (let a = actor; a; a = a.get_parent())
        scale *= a.scale_x;
    return scale;
}

/** Index into Main.layoutManager.monitors of the monitor at stage (x, y), or -1. */
function monitorAt(x, y) {
    return Main.layoutManager.monitors.findIndex(m =>
        x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
}

/**
 * Where a strip is on the stage: {monitor, rect, thumbnailHeight}, or null if
 * it isn't showing.
 */
function placeOf(adapter) {
    const strip = adapter.strip;
    if (!strip.get_stage() || !strip.mapped)
        return null;
    const scale = stageScale(strip);
    const [x, y] = strip.get_transformed_position();
    const [w, h] = strip.allocation.get_size();
    const rect = {x, y, width: w * scale, height: h * scale};
    if (rect.width <= 0 || rect.height <= 0)
        return null;
    const monitor = monitorAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (monitor < 0)
        return null;
    const slot = adapter.slots()?.find(t => t.visible && t.allocation.get_height() > 0);
    const thumbnailHeight = slot
        ? slot.allocation.get_height() * stageScale(slot)
        : rect.height;
    return {monitor, rect, thumbnailHeight};
}

/** A drag began: give every other monitor showing a strip its drop band. */
function addBands() {
    removeBands();
    purgeStaleBands();
    if (!current || current.from < 0 || !mover || !current.adapter.place)
        return;
    const source = placeOf(current.adapter);
    const taken = new Set(source ? [source.monitor] : []);
    current.bands = [];
    for (const adapter of known.keys()) {
        if (adapter === current.adapter || !adapter.place)
            continue;
        const place = placeOf(adapter);
        if (!place || taken.has(place.monitor))
            continue;
        taken.add(place.monitor);

        const m = Main.layoutManager.monitors[place.monitor];
        const below = Math.max(place.thumbnailHeight * BAND_BELOW_THUMBNAILS, BAND_BELOW_MIN);
        const bottom = Math.min(m.y + m.height, place.rect.y + place.rect.height + below);
        const band = new St.Widget({
            name: 'workspace-manage-drop-band',
            x: m.x,
            y: m.y,
            width: m.width,
            height: Math.round(bottom - m.y),
        });
        band[BAND] = adapter;
        const stripX = (x, y) => {
            const [ok, sx] = adapter.strip.transform_stage_point(band.x + x, band.y + y);
            return ok ? sx : null;
        };
        band._delegate = {
            handleDragOver(source, _actor, x, y) {
                // A band outliving its workspace drag sits over the strip and
                // swallows every later drop there (window drops, split view).
                if (purgeIfStale(band, source))
                    return DND.DragMotionResult.CONTINUE;
                const sx = stripX(x, y);
                if (sx === null) {
                    hideMarker();
                    return DND.DragMotionResult.NO_DROP;
                }
                return dragOverOther(source, adapter, sx);
            },
            acceptDrop(source, _actor, x, y) {
                if (purgeIfStale(band, source))
                    return false;
                const sx = stripX(x, y);
                if (sx === null) {
                    hideMarker();
                    return false;
                }
                return dropOther(source, adapter, sx);
            },
        };
        // Called on drag-begin, before DND puts the drag actor on top.
        Main.uiGroup.add_child(band);
        current.bands.push(band);
    }
}

/**
 * Destroy drop bands that no live workspace drag owns, and the drop-target
 * highlight they may have left on strips (2026-11-08: a leftover band over
 * the primary strip took every window drop, so split view never saw one).
 */
function purgeStaleBands() {
    const live = current?.bands ?? [];
    let n = 0;
    for (const actor of Main.uiGroup.get_children()) {
        if (actor[BAND] !== undefined && !live.includes(actor)) {
            actor.destroy();
            n++;
        }
    }
    if (!current?.over) {
        for (const adapter of known.keys())
            adapter.strip?.remove_style_class_name(DROP_TARGET_CLASS);
    }
    if (n)
        console.warn(`workspace-manage: removed ${n} stale drop band(s)`);
    return n;
}

/** True (after cleaning up) if `band` is not part of the drag `source` is. */
function purgeIfStale(band, source) {
    if (current && isReorderSource(source) && current.bands?.includes(band))
        return false;
    band.hide();
    purgeStaleBands();
    return true;
}

function removeBands() {
    const bands = current?.bands;
    if (!bands)
        return;
    current.bands = null;
    for (const band of bands)
        band.destroy();
}

/** Is `actor` on (or the drop band of) the strip `over` describes? */
function isOver(over, actor) {
    return !!actor && (actor[BAND] === over.adapter || over.adapter.strip.contains(actor));
}

/**
 * Put the insertion bar in the gap before slot `index` (after the last one
 * for index === slots.length), as tall as the thumbnails. Called from the
 * strip's allocation, after the thumbnails'.
 */
export function allocateDropMarker(strip) {
    const marker = strip[MARKER];
    if (!marker?.visible)
        return;
    const slots = (marker._wmSlots ?? []).filter(t => t.get_parent() === strip);
    if (slots.length === 0) {
        marker.allocate(new Clutter.ActorBox());
        return;
    }

    const index = Math.min(marker._wmIndex, slots.length);
    const spacing = strip.get_theme_node().get_length('spacing');
    const rtl = slots.length > 1 &&
        slots[0].allocation.x1 > slots[slots.length - 1].allocation.x1;
    const before = slots[index - 1]?.allocation;
    const after = slots[index]?.allocation;
    // The gap's centre, along the strip's own direction.
    let centre;
    if (before && after)
        centre = rtl ? (after.x2 + before.x1) / 2 : (before.x2 + after.x1) / 2;
    else if (before)
        centre = rtl ? before.x1 - spacing / 2 : before.x2 + spacing / 2;
    else
        centre = rtl ? after.x2 + spacing / 2 : after.x1 - spacing / 2;

    const [, width] = marker.get_preferred_width(-1);
    // A little taller than the thumbnails, so it doesn't read as one edge
    // of the active workspace's frame next to it.
    const [stripWidth, stripHeight] = strip.allocation.get_size();
    const y1 = Math.max(0, slots[0].allocation.y1 - MARKER_OVERHANG);
    const y2 = Math.min(stripHeight, slots[0].allocation.y2 + MARKER_OVERHANG);
    const x1 = Math.max(0, Math.min(Math.round(centre - width / 2), stripWidth - width));
    const box = new Clutter.ActorBox();
    box.set_origin(x1, y1);
    box.set_size(width, y2 - y1);
    marker.allocate(box);
}

/** A reorder source at all (any strip). Window drags never are. */
export function isReorderSource(source) {
    return !!source?.[REORDER];
}

function begin(thumbnail) {
    const adapter = thumbnail[REORDER];
    const slots = adapter.slots();
    const from = slots ? slots.indexOf(thumbnail) : -1;

    current = {
        thumbnail,
        adapter,
        slots: slots ?? [],
        from,
        to: from,
        split: null, // {thumb, side}: the split a drop would make now
        destroyed: false,
        sourceGone: false,
        over: null,
        bands: null,
        opacity: thumbnail.opacity,
        monitor: {
            dragMotion: event => {
                // Off the strip: show the original order again.
                if (current && !adapter.strip.contains(event.targetActor))
                    preview(current.from);
                // Off the thumbnail a split would go to: no half lit.
                if (current?.split && !current.split.thumb.contains(event.targetActor))
                    clearSplit();
                // Off the other strip (and its band) it hovered: no insertion bar.
                if (current?.over && !isOver(current.over, event.targetActor))
                    hideMarker();
                return DND.DragMotionResult.CONTINUE;
            },
        },
    };
    current.destroyId = thumbnail.connect('destroy', () => {
        if (current?.thumbnail === thumbnail)
            current.destroyed = true;
    });
    DND.addDragMonitor(current.monitor);

    if (from >= 0)
        thumbnail.opacity = 0;
    try {
        addBands();
    } catch (e) {
        console.error(`workspace-manage: drop bands: ${e}\n${e.stack}`);
        removeBands();
    }
    adapter.onDragChanged?.();
}

/**
 * Pointer at strip-local `x`: where would the dragged workspace land?
 * Returns DND's answer for the cursor.
 */
export function dragOver(x) {
    if (!current || current.from < 0)
        return DND.DragMotionResult.NO_DROP;

    // The strip changed under the drag (a workspace came or went).
    const slots = current.adapter.slots();
    if (!slots || slots.length !== current.slots.length) {
        clearSplit();
        return DND.DragMotionResult.NO_DROP;
    }

    const hit = splitAt(x);
    if (hit) {
        current.split = hit;
        preview(current.from); // the strip as it is: no reorder gap
        return DND.DragMotionResult.MOVE_DROP;
    }
    clearSplit();
    preview(targetSlot(current.slots, current.from, x));
    return DND.DragMotionResult.MOVE_DROP;
}

/** The Split View API while maximize-own-workspace offers it, else null. */
export function splitApi() {
    try {
        const api = splitter?.() ?? null;
        return typeof api?.thumbnailSplitHover === 'function' ? api : null;
    } catch (e) {
        console.error(`workspace-manage: split view lookup: ${e}`);
        return null;
    }
}

/**
 * Pointer at strip-local `x`: is it over the inner part of another
 * thumbnail that the dragged full-screen space could split with? Lights
 * that half (Split View draws it) and returns {thumb, side}, or null.
 */
function splitAt(x) {
    const kind = current?.adapter.place?.kind;
    if (kind !== 'primary' && kind !== 'virtual')
        return null;
    const ws = placeRefOf(current.thumbnail);
    const api = ws ? splitApi() : null;
    if (!api)
        return null;
    for (const [k, thumb] of current.slots.entries()) {
        if (k === current.from || !placeRefOf(thumb))
            continue;
        const {x1, x2} = thumb.allocation;
        const edge = (x2 - x1) * SPLIT_EDGE;
        if (x < x1 + edge || x > x2 - edge)
            continue;
        let side = null;
        try {
            side = api.thumbnailSplitHover(ws, thumb);
        } catch (e) {
            console.error(`workspace-manage: split view hover: ${e}\n${e.stack}`);
        }
        return side ? {thumb, side} : null;
    }
    return null;
}

/**
 * The workspace a strip thumbnail shows, as Split View names it: the
 * Meta.Workspace of a stock thumbnail, {kind: 'virt', state, group} for an
 * islands one (its group Set, which survives reorders), or null.
 */
export function placeRefOf(thumbnail) {
    if (thumbnail?.metaWorkspace)
        return thumbnail.metaWorkspace;
    const state = thumbnail?._state;
    const group = Array.isArray(state?._groups) && Number.isInteger(thumbnail._index)
        ? state._groups[thumbnail._index] : null;
    return group ? {kind: 'virt', state, group} : null;
}

function clearSplit() {
    if (!current?.split)
        return;
    current.split = null;
    try {
        splitApi()?.thumbnailSplitClear();
    } catch (e) {
        console.error(`workspace-manage: split view: ${e}`);
    }
}

/** Drop on the strip. Returns true if it was ours to take. */
export function drop() {
    if (!current || current.from < 0)
        return false;

    const {from, to, adapter} = current;
    const slots = adapter.slots();
    if (!slots || slots.indexOf(current.thumbnail) !== from) {
        clearSplit();
        resetShifts(false);
        return false;
    }

    if (current.split) {
        // to === from here: the split preview shows no reorder.
        const {thumb} = current.split;
        current.split = null;
        let split = false;
        try {
            split = !!splitApi()?.thumbnailSplitDrop(placeRefOf(current.thumbnail), thumb);
        } catch (e) {
            console.error(`workspace-manage: split view drop: ${e}\n${e.stack}`);
        }
        if (split) {
            // Its window left; Split View's sweep removes the workspace.
            current.sourceGone = true;
            resetShifts(false);
            return true;
        }
    }

    const rebuilding = from !== to && adapter.commit(from, to);
    if (rebuilding) {
        // The strip is about to be thrown away and rebuilt in the new order.
        // Putting the old one back first would flash it for a frame.
        current.keepShifts = true;
    } else {
        resetShifts(false);
    }
    return true;
}

function cancel(thumbnail) {
    if (current?.thumbnail !== thumbnail)
        return;
    clearSplit();
    hideMarker();
    removeBands();
    resetShifts(true);
}

function end(thumbnail) {
    if (current?.thumbnail !== thumbnail)
        return;

    clearSplit();
    hideMarker();
    removeBands();
    const {adapter, monitor, destroyed, keepShifts, sourceGone} = current;
    DND.removeDragMonitor(monitor);
    if (!destroyed) {
        thumbnail.disconnect(current.destroyId);
        // A workspace moved to another monitor: its thumbnail is leaving.
        // Should the workspace stay after all (cross.js gave up waiting for
        // its windows), show the thumbnail again.
        if (!keepShifts && !sourceGone)
            thumbnail.opacity = current.opacity;
        else if (sourceGone)
            showIfKept(thumbnail, current.opacity);
    }
    if (!keepShifts)
        resetShifts(false);
    current = null;
    adapter.onDragChanged?.();
}

function showIfKept(thumbnail, opacity) {
    let id = 0;
    const destroyId = thumbnail.connect('destroy', () => GLib.source_remove(id));
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEPT_CHECK_MS, () => {
        thumbnail.disconnect(destroyId);
        thumbnail.opacity = opacity;
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Index the dragged slot would take: how many of the other slots sit before
 * the pointer. Works for either direction of the strip. `from` is -1 for a
 * workspace coming from another strip (then every slot counts).
 */
function targetSlot(slots, from, x) {
    const centre = t => (t.allocation.x1 + t.allocation.x2) / 2;
    const rtl = slots.length > 1 && centre(slots[0]) > centre(slots[slots.length - 1]);
    let index = 0;
    slots.forEach((slot, k) => {
        if (k === from)
            return;
        if (rtl ? centre(slot) > x : centre(slot) < x)
            index++;
    });
    return index;
}

function preview(to) {
    if (!current || current.from < 0 || to === current.to)
        return;
    current.to = to;

    const {from, adapter, slots} = current;
    const x = slots.map(t => t.allocation.x1);
    const shift = k => {
        if (from < to && k > from && k <= to)
            return x[k - 1] - x[k];
        if (to < from && k >= to && k < from)
            return x[k + 1] - x[k];
        return 0;
    };

    slots.forEach((slot, k) => {
        if (k !== from)
            ease(slot, shift(k));
    });

    const active = adapter.activeIndex();
    if (adapter.indicator && active >= 0 && active < slots.length)
        ease(adapter.indicator, active === from ? x[to] - x[from] : shift(active));
}

function resetShifts(animate) {
    if (!current)
        return;
    for (const slot of [...current.slots, current.adapter.indicator]) {
        if (!slot?.get_stage())
            continue; // destroyed with its strip
        if (animate) {
            ease(slot, 0);
        } else {
            slot.remove_transition('translation-x');
            slot.translation_x = 0;
        }
    }
    current.to = current.from;
}

function ease(actor, value) {
    actor.ease({
        translation_x: value,
        duration: SHIFT_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}
