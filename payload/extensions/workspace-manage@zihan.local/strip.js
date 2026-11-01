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
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

/** On a thumbnail we made draggable: its strip's adapter. */
export const REORDER = Symbol('workspace-manage.reorder');

/** On a thumbnail: its "×" button. On a strip: its "+" button. */
export const CLOSE = Symbol('workspace-manage.close');
export const ADD = Symbol('workspace-manage.add');

/** On a thumbnail: the Draggable we attached. */
const DRAGGABLE = Symbol('workspace-manage.draggable');

const SHIFT_TIME = 150;
const CLOSE_MARGIN = 3;

/** The drag in progress, if any. One pointer, one drag. */
let current = null;

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
 * A hover "×" in a thumbnail's top-left corner, where Mission Control has it.
 * `canClose()` is asked on every hover change: never on the last workspace,
 * never mid-drag.
 */
export function addCloseButton(thumbnail, {close, canClose}) {
    const button = new St.Button({
        style_class: 'workspace-manage-close',
        child: new St.Icon({icon_name: 'window-close-symbolic'}),
        accessible_name: 'Remove workspace',
        visible: false,
    });
    button.set_position(CLOSE_MARGIN, CLOSE_MARGIN);
    button.connect('clicked', () => close());
    thumbnail.add_child(button);
    thumbnail[CLOSE] = button;

    const sync = () => syncCloseButton(thumbnail, canClose);
    thumbnail.reactive = true;
    thumbnail.track_hover = true;
    button._wmHoverId = thumbnail.connect('notify::hover', sync);

    // Clicking the "×" must not also count as clicking the thumbnail (which
    // switches to it). The click gestures that would see it are disabled
    // while the pointer is on the button, and given back when it leaves or
    // goes away (a removed workspace takes its button with it, hovered).
    button.track_hover = true;
    button.connect('notify::hover', () => blockClicks(button, button.hover && button.visible));
    button.connect('destroy', () => blockClicks(button, false));
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

export function syncCloseButton(thumbnail, canClose) {
    const button = thumbnail[CLOSE];
    if (!button)
        return;
    button.visible = thumbnail.hover && !current && canClose();
    if (!button.visible)
        blockClicks(button, false);
}

export function removeCloseButton(thumbnail) {
    const button = thumbnail[CLOSE];
    if (!button)
        return;
    blockClicks(button, false);
    thumbnail.disconnect(button._wmHoverId);
    thumbnail.track_hover = false;
    button.destroy();
    delete thumbnail[CLOSE];
}

/** Position of the "×" in its thumbnail, for strips that allocate by hand. */
export function allocateCloseButton(thumbnail) {
    const button = thumbnail[CLOSE];
    if (!button)
        return;
    const [, width] = button.get_preferred_width(-1);
    const [, height] = button.get_preferred_height(width);
    const box = new Clutter.ActorBox();
    box.set_origin(CLOSE_MARGIN, CLOSE_MARGIN);
    box.set_size(width, height);
    button.allocate(box);
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
    // DND asks the source's _delegate for these. The stock and the islands
    // thumbnails are both their own delegate.
    thumbnail.getDragActor = () => {
        // Not get_transformed_size(): once the thumbnail is see-through (as
        // the drag makes it) that reports the unclipped extents of the
        // monitor-sized contents inside it.
        let scale = 1;
        for (let a = thumbnail; a; a = a.get_parent())
            scale *= a.scale_x;
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

/** A reorder drag from some other strip: not ours to take. */
export function dragOverOther() {
    return DND.DragMotionResult.CONTINUE;
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
        destroyed: false,
        opacity: thumbnail.opacity,
        monitor: {
            dragMotion: event => {
                // Off the strip: show the original order again.
                if (current && !adapter.strip.contains(event.targetActor))
                    preview(current.from);
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
    if (!slots || slots.length !== current.slots.length)
        return DND.DragMotionResult.NO_DROP;

    preview(targetSlot(current.slots, current.from, x));
    return DND.DragMotionResult.MOVE_DROP;
}

/** Drop on the strip. Returns true if it was ours to take. */
export function drop() {
    if (!current || current.from < 0)
        return false;

    const {from, to, adapter} = current;
    const slots = adapter.slots();
    if (!slots || slots.indexOf(current.thumbnail) !== from) {
        resetShifts(false);
        return false;
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
    resetShifts(true);
}

function end(thumbnail) {
    if (current?.thumbnail !== thumbnail)
        return;

    const {adapter, monitor, destroyed, keepShifts} = current;
    DND.removeDragMonitor(monitor);
    if (!destroyed) {
        thumbnail.disconnect(current.destroyId);
        if (!keepShifts)
            thumbnail.opacity = current.opacity;
    }
    if (!keepShifts)
        resetShifts(false);
    current = null;
    adapter.onDragChanged?.();
}

/**
 * Index the dragged slot would take: how many of the other slots sit before
 * the pointer. Works for either direction of the strip.
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
