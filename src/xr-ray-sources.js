// Slot assignment for the VR panel's controller rays. Pure and dependency-free
// (no three, no DOM) so it is unit-testable offline.
//
// The panel draws at most one ray per slot and slot 0 is the pointer that drives
// selection, so slots are keyed by HANDEDNESS, not input-source order:
// `renderer.xr.getController(i)` indexes by connection order, which swaps hands
// whenever the left controller wakes first.
//
// Hands are not controllers. A controller has a trigger on each hand, so two rays
// are two usable pointers. Under hand tracking only ONE hand can select: the free
// hand, resolveFreeHand() in wrist-poke.js, the wrist opposite the content panel
// (right by default, mirrored by `?wrist=`). The other hand's pinch is the rotate
// drag, so its ray would promise an activation it cannot perform. vrpanel.js also
// has ONE `_rayDot` shared by both slots, and the second slot's hit overwrote the
// first's; silencing the non-select hand's ray removes that second writer.
//
// So with `selectHandedness` supplied, a tracked HAND only gets a ray if it is the
// select hand, and it takes slot 0. Controllers keep both rays.

// Slot 0 is the pointer that claims the cursor. Without an explicit select hand it
// is the right one, the same hand resolveFreeHand() yields for the default
// `wristPanelHand`.
const RAY_SLOT_HANDEDNESS = ["right", "left"];

// Only sources that expose a pointing ray qualify. "gaze" and "screen" target-ray
// modes point from the eyes / a 2D touch and would draw a ray the viewer never
// aimed. Tracked hands keep theirs ("tracked-pointer" too).
function isRaySource(source) {
  return Boolean(source && source.targetRaySpace && source.targetRayMode === "tracked-pointer");
}

// A hand-tracking source, as opposed to a controller. `source.hand` is the XRHand;
// the non-articulated fallback profile (`meta-fixed-hand`, see isHandLikeSource in
// xr-microgestures.js) has no XRHand and no ray worth drawing, so this narrow test
// is enough here.
function isHandSource(source) {
  return Boolean(source && source.hand);
}

// Slot order for a given select hand: the selecting hand first, so slot 0 stays
// the pointer that owns the cursor whichever way `wristPanelHand` is mirrored.
function raySlotHandedness(selectHandedness) {
  if (selectHandedness === "left") {
    return ["left", "right"];
  }
  if (selectHandedness === "right") {
    return ["right", "left"];
  }
  return RAY_SLOT_HANDEDNESS;
}

// Maps `inputSources` onto fixed ray slots. Returns an array of length `slotCount`
// whose entries are the input source for that slot or null; null means "hide that
// line this frame", so a disconnected controller never leaves a stale ray.
//
// `selectHandedness` ("left"/"right", from resolveFreeHand()) additionally
// silences the ray of a tracked hand that cannot select. Omitted, both hands are
// drawn with the right hand in slot 0.
function selectRaySlotSources(inputSources, slotCount = RAY_SLOT_HANDEDNESS.length, {
  selectHandedness = null
} = {}) {
  const slots = new Array(slotCount).fill(null);
  if (!inputSources) {
    return slots;
  }
  const order = raySlotHandedness(selectHandedness);
  const unplaced = [];
  for (const source of inputSources) {
    if (!isRaySource(source)) {
      continue;
    }
    // One ray per select hand under hand tracking. A hand with no usable handedness is
    // dropped rather than passed to the fallback below: it cannot be shown to be the
    // one that selects, and drawing it would put the cursor on a hand that cannot fire.
    if (selectHandedness && isHandSource(source) && source.handedness !== selectHandedness) {
      continue;
    }
    const slot = order.indexOf(source.handedness);
    if (slot >= 0 && slot < slotCount && !slots[slot]) {
      slots[slot] = source;
    } else {
      unplaced.push(source);
    }
  }
  // Sources with no usable handedness ("none", undefined, or a second source on the
  // same hand) fill whatever remains, in arrival order, so a single unlabelled
  // pointer still gets a ray.
  for (const source of unplaced) {
    const free = slots.indexOf(null);
    if (free < 0) {
      break;
    }
    slots[free] = source;
  }
  return slots;
}

// The extra ray-selectable surfaces each slot may pick this frame, COPIED into
// per-slot buffers. The provider (wristui's wristRayTargets) refills one
// module-level array on every call and returns the same array, so keeping its
// return value for slot 0 and asking again for slot 1 leaves both slots holding
// slot 1's list. The buffers are reused, so a frame still allocates nothing.
function fillSlotRayTargets(slotSources, targetsFor, buffers = []) {
  for (let slot = 0; slot < slotSources.length; slot += 1) {
    let out = buffers[slot];
    if (!out) {
      out = [];
      buffers[slot] = out;
    }
    out.length = 0;
    const source = slotSources[slot];
    if (!source) {
      continue;
    }
    const targets = targetsFor(source.handedness);
    if (!targets) {
      continue;
    }
    for (const target of targets) {
      out.push(target);
    }
  }
  buffers.length = slotSources.length;
  return buffers;
}

// A slot fires on its OWN trigger only. `edges` is `{ left, right, any }` from
// input.js: per-handedness select edges plus the any-source edge, which is the
// fallback for a source with no usable handedness (a lone unlabelled pointer has
// no partner to confuse with). Otherwise aiming left and pulling right would fire
// the left ray's target.
function slotSelectEdge(source, edges) {
  if (!source || !edges) {
    return false;
  }
  const hand = source.handedness;
  if (hand === "left" || hand === "right") {
    return Boolean(edges[hand]);
  }
  return Boolean(edges.any);
}

// The same per-hand resolution applied to the trigger's level rather than its
// edge: a hold keeps asking whether this slot's trigger is still down.
const slotSelectHeld = slotSelectEdge;

// Hold-to-activate on a ray target (Exit VR on the launcher row). A ray click is
// an edge, the wrong shape for Exit VR: one stray trigger pull must not end the
// session. Same contract as the controller B-hold (input.js) and the wrist panel's
// Exit row (wristui.js): a timer behind a progress ring.
//
// `armed` STARTS a hold and `engaged` CONTINUES it. Without the distinction, a
// trigger already held for something else would start the timer as soon as the ray
// drifted onto Exit; requiring the press edge to land on the button makes it
// "pull on Exit and keep holding".
function createRayHoldState() {
  return { slot: -1, scope: null, elapsedS: 0, progress: 0, holding: false, fired: false };
}

// Returns the NEXT state; never mutates `prev`. `fired` latches true on the frame
// the hold completes and stays true until the hold is broken, so a caller reads a
// rising edge by comparing with the previous frame's `fired`.
//   engaged     per slot: its ray is on the hold target AND its trigger is down
//   armed       per slot: its select EDGE landed on the hold target this frame
//   scope       which surface owns the hold; a change abandons it
//   dtS         frame delta, seconds
//   holdSeconds total hold required
//
// A slot with no live source contributes `false` to both, so a controller that
// disconnects mid-hold cancels it rather than freezing the timer.
//
// `scope` exists because the same hold target can be drawn on more than one
// surface (Exit VR is on both the launcher row and the menu's toolbar, found by
// action type). A hold started on one must not be finished by the other; there is
// no new press edge to restart it while the trigger is still down, so the timer
// dies where it stood.
function updateRayHoldState(prev, {
  engaged = [],
  armed = [],
  scope = null,
  dtS = 0,
  holdSeconds = 0
} = {}) {
  // The incumbent keeps the hold while it stays engaged: the other ray drifting
  // across the same button must not reset a hold already two-thirds done.
  let base = prev;
  let slot = prev.slot >= 0 && prev.scope === scope && engaged[prev.slot] ? prev.slot : -1;
  if (slot < 0) {
    for (let i = 0; i < engaged.length; i += 1) {
      if (engaged[i] && armed[i]) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      return createRayHoldState();
    }
    base = createRayHoldState();
  }
  const elapsedS = base.fired ? base.elapsedS : base.elapsedS + Math.max(dtS, 0);
  const progress = holdSeconds > 0 ? Math.min(1, elapsedS / holdSeconds) : 1;
  return {
    slot,
    scope,
    elapsedS,
    progress,
    holding: true,
    fired: base.fired || progress >= 1
  };
}

// A hold that was started and then abandoned before completing: the cue to tell
// the user "that one needs a hold".
function rayHoldAborted(prev, next) {
  return prev.elapsedS > 0 && !prev.fired && next.elapsedS === 0;
}

// Which slot owns the SHARED world-panel cursor: the NEAREST hit, not the first
// slot to have one. Ties go to the lower slot, so the select hand wins a draw.
// Returns -1 for no hits.
//
// Activation, hover and the cursor dot are per-slot. What is shared is the world
// panel's canvas, which draws ONE hover highlight, so when both rays are on it
// something must arbitrate; nearest-wins is the rule castSelectionRay() applies
// within a slot.
function pickPointerSlot(hits) {
  let best = -1;
  let bestDistance = Infinity;
  for (let slot = 0; slot < hits.length; slot += 1) {
    const hit = hits[slot];
    if (!hit) {
      continue;
    }
    const distance = Number.isFinite(hit.distance) ? hit.distance : Infinity;
    if (best < 0 || distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best;
}

export {
  RAY_SLOT_HANDEDNESS,
  isRaySource,
  isHandSource,
  raySlotHandedness,
  selectRaySlotSources,
  fillSlotRayTargets,
  slotSelectEdge,
  slotSelectHeld,
  createRayHoldState,
  updateRayHoldState,
  rayHoldAborted,
  pickPointerSlot
};
