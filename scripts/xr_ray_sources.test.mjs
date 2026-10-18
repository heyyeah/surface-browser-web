// VR panel controller-ray slot mapping (offline). Covers two regressions behind
// intermittent ray bugs: a ray slot must never be claimed by the wrong hand
// (slots must not follow input-source connection ORDER), and a slot with no live
// source must come back null so the caller hides that line instead of leaving a
// stale ray on screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectRaySlotSources,
  raySlotHandedness,
  fillSlotRayTargets,
  slotSelectEdge,
  pickPointerSlot
} from "../src/xr-ray-sources.js";
import { resolveFreeHand } from "../src/wrist-poke.js";

function pointer(handedness) {
  return { handedness, targetRayMode: "tracked-pointer", targetRaySpace: {} };
}

// A tracked HAND, as opposed to a controller: same pointing ray, plus an XRHand.
function hand(handedness) {
  return { ...pointer(handedness), hand: {} };
}

test("right hand takes slot 0 regardless of connection order", () => {
  const left = pointer("left");
  const right = pointer("right");
  assert.deepEqual(selectRaySlotSources([left, right]), [right, left]);
  assert.deepEqual(selectRaySlotSources([right, left]), [right, left]);
});

test("a lone left controller leaves slot 0 null", () => {
  const left = pointer("left");
  assert.deepEqual(selectRaySlotSources([left]), [null, left]);
});

test("no sources yields all-null slots", () => {
  assert.deepEqual(selectRaySlotSources([]), [null, null]);
  assert.deepEqual(selectRaySlotSources(undefined), [null, null]);
  assert.deepEqual(selectRaySlotSources(null), [null, null]);
});

test("gaze and screen sources never get a ray", () => {
  const gaze = { handedness: "none", targetRayMode: "gaze", targetRaySpace: {} };
  const screen = { handedness: "none", targetRayMode: "screen", targetRaySpace: {} };
  const spaceless = { handedness: "right", targetRayMode: "tracked-pointer" };
  assert.deepEqual(selectRaySlotSources([gaze, screen, spaceless]), [null, null]);
});

test("tracked hands still get rays", () => {
  const rightHand = hand("right");
  assert.deepEqual(selectRaySlotSources([rightHand]), [rightHand, null]);
});

// --- the ray belongs to the SELECT hand --------------------------------------
// Under hand tracking exactly one hand can select (resolveFreeHand(), the wrist
// opposite the content panel), so the other hand's ray would be an aiming
// affordance for a hand that cannot fire, and slot 1 could take the cursor
// whenever slot 0's ray missed the panel.

test("only the select HAND gets a ray, and it takes slot 0", () => {
  const left = hand("left");
  const right = hand("right");
  assert.deepEqual(
    selectRaySlotSources([left, right], 2, { selectHandedness: "right" }),
    [right, null],
    "the non-selecting hand draws nothing at all"
  );
  // Arrival order must not matter.
  assert.deepEqual(
    selectRaySlotSources([right, left], 2, { selectHandedness: "right" }),
    [right, null]
  );
  assert.deepEqual(
    selectRaySlotSources([left], 2, { selectHandedness: "right" }),
    [null, null],
    "a lone non-select hand leaves BOTH slots empty rather than borrowing slot 0"
  );
});

test("?wrist=right mirrors the ray with everything else", () => {
  // `?wrist=` names the wrist carrying CONTENT; the select hand is the other
  // one. Resolved through the same function input.js resolves Select from, so
  // the ray and the pinch that fires it can never name different hands.
  const left = hand("left");
  const right = hand("right");
  assert.equal(resolveFreeHand("left"), "right");
  assert.equal(resolveFreeHand("right"), "left");

  assert.deepEqual(
    selectRaySlotSources([left, right], 2, { selectHandedness: resolveFreeHand("left") }),
    [right, null]
  );
  assert.deepEqual(
    selectRaySlotSources([left, right], 2, { selectHandedness: resolveFreeHand("right") }),
    [left, null],
    "mirrored, the LEFT hand is the one that selects and the one that aims"
  );
});

test("slot order follows the select hand, and defaults to right without one", () => {
  assert.deepEqual(raySlotHandedness("right"), ["right", "left"]);
  assert.deepEqual(raySlotHandedness("left"), ["left", "right"]);
  assert.deepEqual(raySlotHandedness(null), ["right", "left"]);
  assert.deepEqual(raySlotHandedness("none"), ["right", "left"]);
});

test("CONTROLLERS keep both rays — the change is about hands", () => {
  // Two triggers, two usable pointers. Nothing here may narrow that.
  const left = pointer("left");
  const right = pointer("right");
  assert.deepEqual(
    selectRaySlotSources([left, right], 2, { selectHandedness: "right" }),
    [right, left]
  );
  assert.deepEqual(
    selectRaySlotSources([left, right], 2, { selectHandedness: "left" }),
    [left, right]
  );
  // ...including one controller alone on the non-select hand.
  assert.deepEqual(
    selectRaySlotSources([left], 2, { selectHandedness: "right" }),
    [null, left]
  );
});

test("a mixed session gives the controller its ray and the wrong hand none", () => {
  // Quest sessions do carry both at once (a controller put down keeps its
  // source alive for a while). The hand rule must not touch the controller.
  const leftController = pointer("left");
  const leftHand = hand("left");
  const rightHand = hand("right");
  assert.deepEqual(
    selectRaySlotSources([leftHand, leftController, rightHand], 2, { selectHandedness: "right" }),
    [rightHand, leftController]
  );
});

test("an unlabelled HAND is dropped rather than filling the select slot", () => {
  // The fallback exists for an unlabelled POINTER. A hand that cannot be shown
  // to be the selecting one must not inherit the cursor through it.
  const vague = { ...hand("none") };
  assert.deepEqual(selectRaySlotSources([vague], 2, { selectHandedness: "right" }), [null, null]);
  const stray = pointer("none");
  assert.deepEqual(selectRaySlotSources([stray], 2, { selectHandedness: "right" }), [stray, null]);
});

test("unlabelled and duplicate-hand sources fill the free slots in order", () => {
  const a = pointer("none");
  const b = pointer(undefined);
  assert.deepEqual(selectRaySlotSources([a, b]), [a, b]);

  const right = pointer("right");
  const alsoRight = pointer("right");
  assert.deepEqual(selectRaySlotSources([right, alsoRight]), [right, alsoRight]);
});

test("extra sources never overflow the slot array", () => {
  const sources = [pointer("right"), pointer("left"), pointer("none"), pointer("none")];
  const slots = selectRaySlotSources(sources);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots, [sources[0], sources[1]]);
});

// --- Per-slot target lists ---------------------------------------------------
// The provider refills and returns ONE array. Holding that return value per slot
// would alias every slot to the last one asked, which on two controllers offers
// slot 0 the wrist panel on its OWN arm (a panel no forward-pointing ray can
// reach) and leaves the other panel unreachable from either ray.

// A provider shaped exactly like wristui's wristRayTargets: one shared array,
// cleared and refilled on every call.
function sharedArrayProvider(targetsByHand) {
  const buffer = [];
  return (handedness) => {
    buffer.length = 0;
    for (const target of targetsByHand[handedness] || []) {
      buffer.push(target);
    }
    return buffer;
  };
}

test("each slot keeps its OWN targets when the provider reuses one array", () => {
  const leftPanel = { id: "left-panel" };
  const rightPanel = { id: "right-panel" };
  // The rule: a panel is offered to the OTHER arm's ray.
  const provider = sharedArrayProvider({ right: [leftPanel], left: [rightPanel] });
  const slots = [pointer("right"), pointer("left")];
  const buffers = fillSlotRayTargets(slots, provider);
  assert.deepEqual(buffers[0], [leftPanel], "the right ray reaches the LEFT panel");
  assert.deepEqual(buffers[1], [rightPanel], "the left ray reaches the RIGHT panel");
  assert.notEqual(buffers[0], buffers[1], "and the two slots are not the same array");
});

test("both wrist panels stay reachable across the pair of controllers", () => {
  const leftPanel = { id: "left-panel" };
  const rightPanel = { id: "right-panel" };
  const provider = sharedArrayProvider({ right: [leftPanel], left: [rightPanel] });
  const buffers = fillSlotRayTargets([pointer("right"), pointer("left")], provider);
  const reachable = new Set(buffers.flat());
  assert.ok(reachable.has(leftPanel) && reachable.has(rightPanel));
});

test("a slot with no source is emptied rather than left holding last frame's list", () => {
  const panel = { id: "panel" };
  const provider = sharedArrayProvider({ right: [panel], left: [] });
  const buffers = fillSlotRayTargets([pointer("right"), pointer("left")], provider);
  assert.deepEqual(buffers[0], [panel]);
  // The controller disconnects: its stale target must not survive the frame, or
  // a ray with no pose would keep a panel in the cast.
  fillSlotRayTargets([null, pointer("left")], provider, buffers);
  assert.deepEqual(buffers[0], []);
});

test("buffers are reused, so a steady frame allocates nothing", () => {
  const provider = sharedArrayProvider({ right: [{}], left: [] });
  const slots = [pointer("right"), pointer("left")];
  const buffers = fillSlotRayTargets(slots, provider);
  const first = buffers[0];
  const second = buffers[1];
  fillSlotRayTargets(slots, provider, buffers);
  assert.equal(buffers[0], first);
  assert.equal(buffers[1], second);
});

test("a provider that returns nothing costs that slot its targets, not the frame", () => {
  const buffers = fillSlotRayTargets([pointer("right"), pointer("left")], () => null);
  assert.deepEqual(buffers, [[], []]);
});

// --- Pointer priority --------------------------------------------------------
// Slot 0 must not claim the pointer whenever it hits anything at all: with the
// world panel open the select hand would eat the frame, so the other
// controller's aim at a wrist panel would produce no hover, no swallow, and a
// trigger that reaches the sphere.

test("the nearest hit owns the pointer, not the lowest slot", () => {
  const world = { distance: 2.4 };
  const wrist = { distance: 0.4 };
  assert.equal(pickPointerSlot([world, wrist]), 1);
  assert.equal(pickPointerSlot([wrist, world]), 0);
});

test("a lone hit in slot 1 still owns the pointer", () => {
  assert.equal(pickPointerSlot([null, { distance: 2.4 }]), 1);
});

test("no hits at all yields no pointer", () => {
  assert.equal(pickPointerSlot([null, null]), -1);
  assert.equal(pickPointerSlot([]), -1);
});

test("a tie goes to the select hand, which is slot 0", () => {
  const a = { distance: 1 };
  const b = { distance: 1 };
  assert.equal(pickPointerSlot([a, b]), 0);
});

test("a hit with no usable distance is still a hit", () => {
  // castSelectionRay always reports one, but a surface that ever stopped would
  // otherwise become silently unclickable rather than merely last in line.
  assert.equal(pickPointerSlot([{ distance: undefined }, null]), 0);
  assert.equal(pickPointerSlot([{ distance: undefined }, { distance: 3 }]), 1);
});

// --- Per-controller triggers -------------------------------------------------
// A ray's target fires only on the trigger of the controller projecting that ray.
// Deriving ONE select edge from `anySelectPressed` (either trigger) and handing
// it to the pointer-owning slot would let aiming with the left controller and
// pulling the RIGHT trigger fire the left ray's target.

test("a slot fires only on its own hand's trigger", () => {
  const left = pointer("left");
  const right = pointer("right");
  const rightOnly = { left: false, right: true, any: true };
  assert.equal(slotSelectEdge(right, rightOnly), true);
  assert.equal(slotSelectEdge(left, rightOnly), false);
  const leftOnly = { left: true, right: false, any: true };
  assert.equal(slotSelectEdge(left, leftOnly), true);
  assert.equal(slotSelectEdge(right, leftOnly), false);
});

test("aiming with one controller and pulling the other's trigger activates nothing", () => {
  // Left ray on a surface, right trigger pulled: the left slot must NOT see an edge.
  const slots = selectRaySlotSources([pointer("left"), pointer("right")]);
  const edges = { left: false, right: true, any: true };
  const fired = slots.map((source) => slotSelectEdge(source, edges));
  // Slot 0 is the right hand, slot 1 the left.
  assert.deepEqual(fired, [true, false]);
});

test("both triggers in one frame fire both slots, each on its own ray", () => {
  const slots = selectRaySlotSources([pointer("left"), pointer("right")]);
  const edges = { left: true, right: true, any: true };
  assert.deepEqual(slots.map((source) => slotSelectEdge(source, edges)), [true, true]);
});

test("an unlabelled pointer falls back to the any-source edge", () => {
  // "none" handedness has no partner to be confused with, and a lone unlabelled
  // pointer must still be clickable.
  const none = pointer("none");
  assert.equal(slotSelectEdge(none, { left: false, right: false, any: true }), true);
  assert.equal(slotSelectEdge(none, { left: true, right: true, any: false }), false);
});

test("an empty slot never fires", () => {
  assert.equal(slotSelectEdge(null, { left: true, right: true, any: true }), false);
  assert.equal(slotSelectEdge(pointer("right"), null), false);
});

test("a hand pinch reaches the select hand's slot", () => {
  // Under hand tracking only the select hand gets a ray, and input.js puts the
  // resolved pinch on that hand's edge.
  const selectHandedness = resolveFreeHand("left");
  const slots = selectRaySlotSources([hand("left"), hand("right")], 2, { selectHandedness });
  const edges = { left: selectHandedness === "left", right: selectHandedness === "right", any: true };
  assert.equal(slots[0].handedness, selectHandedness);
  assert.equal(slotSelectEdge(slots[0], edges), true);
  assert.equal(slots[1], null);
});
