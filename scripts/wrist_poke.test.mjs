// Wrist-launcher poke selection (offline). Covers the behaviours a device pass
// cannot easily prove by hand: which button a fingertip is nearest, that one
// push fires exactly once no matter how long it is held, that punching THROUGH
// the panel does not fire a second time on the way back out, and that a launcher
// appearing under a resting finger does not self-activate.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutRectToLocalRect,
  nearestPokeTarget,
  createWristPokeState,
  updateWristPokeState,
  resolveSectionPoke,
  resolveWristPokeOutcome,
  createWristFreezeState,
  isOwnerOccludingPanel,
  updateWristFreezeState,
  DEFAULT_WRIST_PANEL_HAND,
  normalizeWristPanelHand,
  resolveWristPanelHand,
  resolveFreeHand
} from "../src/wrist-poke.js";

const HOVER_M = 0.025;
const ACTIVATE_M = 0.010;
const RELEASE_M = 0.020;

// Two stacked 40 x 20 mm buttons on a 60 x 100 mm panel, in layout space.
const PANEL = { widthM: 0.06, heightM: 0.1 };
const LAYOUT = [
  { x: 0.01, y: 0.01, w: 0.04, h: 0.02 },
  { x: 0.01, y: 0.05, w: 0.04, h: 0.02 }
];
const RECTS = LAYOUT.map((rect) => layoutRectToLocalRect(rect, PANEL));

function poke(state, point, { tracked = true } = {}) {
  const hit = nearestPokeTarget(point, RECTS);
  return updateWristPokeState(state, {
    tracked,
    index: hit.index,
    approachM: hit.approachM,
    hoverRadiusM: HOVER_M,
    activateRadiusM: ACTIVATE_M,
    releaseRadiusM: RELEASE_M
  });
}

// Centre of a layout rect, in the local frame, `depth` metres off the face.
function centreOf(index, depth) {
  const rect = RECTS[index];
  return { x: rect.x + (rect.w / 2), y: rect.y + (rect.h / 2), z: depth };
}

test("layout rects convert to a centre-origin, y-up local frame", () => {
  // Top-left button: 10 mm in from the left edge of a 60 mm panel -> -20 mm;
  // its top is 10 mm down from the top of a 100 mm panel, so its BOTTOM edge
  // (the local-frame origin corner) sits at 50 - 10 - 20 = 20 mm.
  const local = layoutRectToLocalRect(LAYOUT[0], PANEL);
  assert.ok(Math.abs(local.x - -0.02) < 1e-9);
  assert.ok(Math.abs(local.y - 0.02) < 1e-9);
  assert.equal(local.w, 0.04);
  assert.equal(local.h, 0.02);
});

test("the nearest target is the one under the fingertip", () => {
  assert.equal(nearestPokeTarget(centreOf(0, 0.005), RECTS).index, 0);
  assert.equal(nearestPokeTarget(centreOf(1, 0.005), RECTS).index, 1);
});

test("approach distance is measured to the rect, not to its centre", () => {
  // Anywhere over the face, the only distance left is the depth.
  const overEdge = { x: RECTS[0].x + 0.001, y: RECTS[0].y + 0.001, z: 0.008 };
  assert.ok(Math.abs(nearestPokeTarget(overEdge, RECTS).approachM - 0.008) < 1e-9);
});

test("an empty target list reports no hit", () => {
  assert.deepEqual(nearestPokeTarget({ x: 0, y: 0, z: 0 }, []), {
    index: -1,
    approachM: Infinity
  });
});

test("hover highlights on approach without activating", () => {
  const state = poke(createWristPokeState(), centreOf(0, 0.02));
  assert.equal(state.hoverIndex, 0);
  assert.equal(state.activatedIndex, -1);
  assert.equal(state.pressed, false);
});

test("nothing hovers from outside the hover radius", () => {
  const state = poke(createWristPokeState(), centreOf(0, 0.05));
  assert.equal(state.hoverIndex, -1);
  assert.equal(state.activatedIndex, -1);
});

test("contact fires exactly once and does not repeat while held", () => {
  let state = poke(createWristPokeState(), centreOf(0, 0.02));
  state = poke(state, centreOf(0, 0.008));
  assert.equal(state.activatedIndex, 0, "fires on the frame contact is made");
  assert.equal(state.pressed, true);

  for (const depth of [0.006, 0.004, 0.006, 0.009]) {
    state = poke(state, centreOf(0, depth));
    assert.equal(state.activatedIndex, -1, `no repeat fire at depth ${depth}`);
  }
  assert.equal(state.hoverIndex, 0, "still highlighted while held");
});

test("a finger pushed THROUGH the panel does not fire again on the way out", () => {
  let state = poke(createWristPokeState(), centreOf(0, 0.008));
  assert.equal(state.activatedIndex, 0);
  // Straight through to the far side...
  state = poke(state, centreOf(0, -0.03));
  assert.equal(state.activatedIndex, -1);
  assert.equal(state.pressed, true, "past the face still counts as contact");
  // ...and back out through the button.
  state = poke(state, centreOf(0, 0.005));
  assert.equal(state.activatedIndex, -1, "the withdrawal must not re-fire");
});

test("retreating past the release radius re-arms for a second press", () => {
  let state = poke(createWristPokeState(), centreOf(0, 0.008));
  assert.equal(state.activatedIndex, 0);
  state = poke(state, centreOf(0, 0.019));
  assert.equal(state.pressed, true, "0.019 is inside the release radius");
  state = poke(state, centreOf(0, 0.022));
  assert.equal(state.pressed, false, "retreated far enough to re-arm");
  state = poke(state, centreOf(0, 0.008));
  assert.equal(state.activatedIndex, 0, "second deliberate press fires");
});

test("sliding a pressed finger onto the next button does not fire it", () => {
  let state = poke(createWristPokeState(), centreOf(0, 0.008));
  assert.equal(state.activatedIndex, 0);
  state = poke(state, centreOf(1, 0.008));
  assert.equal(state.activatedIndex, -1, "retreat is required before the next press");
  assert.equal(state.hoverIndex, 1);
});

test("a launcher that appears under a resting finger does not self-activate", () => {
  // createWristPokeState(true) is what setLauncherVisible() does on the rising
  // edge: whatever the finger is doing at that instant is not a press.
  let state = poke(createWristPokeState(true), centreOf(0, 0.004));
  assert.equal(state.activatedIndex, -1);
  state = poke(state, centreOf(0, 0.03));
  assert.equal(state.pressed, false, "moving away re-arms it");
  state = poke(state, centreOf(0, 0.004));
  assert.equal(state.activatedIndex, 0);
});

test("a tracking dropout keeps the press latch instead of re-arming", () => {
  let state = poke(createWristPokeState(), centreOf(0, 0.008));
  assert.equal(state.activatedIndex, 0);
  state = poke(state, centreOf(0, 0.008), { tracked: false });
  assert.equal(state.hoverIndex, -1, "nothing hovers without a fingertip");
  assert.equal(state.pressed, true, "a dropped frame must not re-arm a held finger");
  state = poke(state, centreOf(0, 0.008));
  assert.equal(state.activatedIndex, -1, "and the recovered frame must not re-fire");
});

test("the input state object is never mutated", () => {
  const state = createWristPokeState();
  const snapshot = { ...state };
  poke(state, centreOf(0, 0.004));
  assert.deepEqual(state, snapshot);
});

// --- freeze-on-approach and its releases -------------------------------------
//
// The freeze pins the quad's world pose AND keeps the panel alive through the
// wearing hand's dropout. If its only exit were the POKING fingertip retreating
// 13 cm, dropping the wearing arm with a finger parked nearby would leave the
// panel hanging there, no longer following its wrist.

const FREEZE_ENTER_M = 0.10;
const FREEZE_RELEASE_M = 0.13;
const ANCHOR_MAX_M = 0.06;
const LOST_GRACE_MS = 700;
const MAX_HOLD_MS = 6000;

// One frame of the freeze machine. The defaults are the healthy case: panel up,
// quad placed, the wearing hand posed and wearing it, the poking finger far.
function freeze(state, {
  approachM = 1,
  panelVisible = true,
  quadPlaced = true,
  pokerTracked = true,
  ownerPosed = true,
  ownerDriftM = 0, // live target pose -> frozen quad; 0 = the arm has not moved
  ownerLostMs = 0,
  nowMs = 0,
  ownerOccluding = false,
  pokeCommitted = false
} = {}) {
  return updateWristFreezeState(state, {
    panelVisible,
    quadPlaced,
    pokerTracked,
    approachM,
    enterRadiusM: FREEZE_ENTER_M,
    releaseRadiusM: FREEZE_RELEASE_M,
    ownerPosed,
    ownerDriftM,
    maxAnchorDriftM: ANCHOR_MAX_M,
    ownerLostMs,
    ownerLostGraceMs: LOST_GRACE_MS,
    nowMs,
    maxHoldMs: MAX_HOLD_MS,
    ownerOccluding,
    pokeCommitted
  });
}

test("a finger approaching freezes the panel, and hysteresis holds it", () => {
  let state = freeze(createWristFreezeState(), { approachM: 0.12 });
  assert.equal(state.frozen, false, "0.12 m is outside the enter radius");
  state = freeze(state, { approachM: 0.09 });
  assert.equal(state.frozen, true);
  state = freeze(state, { approachM: 0.12 });
  assert.equal(state.frozen, true, "inside the release radius it stays frozen");
  state = freeze(state, { approachM: 0.14 });
  assert.equal(state.frozen, false);
  assert.equal(state.reason, "retreat");
  assert.equal(state.rearmRequired, false, "a finger that left needs no re-arm");
});

test("THE STUCK PANEL: an arm that walks away releases its own freeze", () => {
  // The wearing hand is tracked perfectly well; it has simply moved, and the frozen
  // quad is nowhere near it any more.
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  assert.equal(state.frozen, true);
  // Poking moves the wrist a little; that must NOT unfreeze it.
  state = freeze(state, { approachM: 0.05, ownerDriftM: 0.03 });
  assert.equal(state.frozen, true, "an ordinary poke wanders a few centimetres");
  // Lifting the arm 10 cm toward the finger does.
  state = freeze(state, { approachM: 0.05, ownerDriftM: 0.10 });
  assert.equal(state.frozen, false);
  assert.equal(state.reason, "anchor-drift");
  assert.equal(state.rearmRequired, true, "the finger is still there; do not re-latch");
  // ...and it does not re-latch while the finger stays put, which is what would
  // otherwise reinstate the strand on the very next frame.
  state = freeze(state, { approachM: 0.05 });
  assert.equal(state.frozen, false);
  state = freeze(state, { approachM: 0.20 });
  assert.equal(state.rearmRequired, false, "leaving the release radius re-arms");
  state = freeze(state, { approachM: 0.05 });
  assert.equal(state.frozen, true, "and a fresh approach freezes normally again");
});

// --- THE PANEL BEHIND THE HAND -----------------------------------------------
//
// Narrower than the strand above: the wrist is still well inside ANCHOR_MAX_M,
// the hand is tracked and the finger has not retreated, so every other release is
// correctly silent, and the user is looking at the back of their own hand.

const OCCLUSION = { minDepthM: 0.05, maxRadiusM: 0.09 };
const HEAD = { x: 0, y: 1.6, z: 0 };
// A panel 40 cm in front of the face, and the wearing hand 12 cm in front of
// THAT (i.e. between the two), dead on the line of sight.
const QUAD = { x: 0, y: 1.4, z: -0.40 };

test("the occlusion test is a cylinder around the head to quad ray", () => {
  const inFront = { x: 0, y: 1.4 + (0.2 * 0.7), z: -0.28 };
  assert.equal(isOwnerOccludingPanel(HEAD, inFront, QUAD, OCCLUSION), true);

  // Beside it, not in front of it — which is where the hand normally is, since
  // the panel is strapped to it.
  const beside = { x: 0.16, y: 1.4, z: -0.40 };
  assert.equal(isOwnerOccludingPanel(HEAD, beside, QUAD, OCCLUSION), false);

  // Level with the panel: nearer by less than minDepthM is not "in front of".
  const level = { x: 0, y: 1.4 + (0.2 * 0.05), z: -0.38 };
  assert.equal(isOwnerOccludingPanel(HEAD, level, QUAD, OCCLUSION), false);

  // Behind the panel, and behind the head.
  const behind = { x: 0, y: 1.35, z: -0.60 };
  assert.equal(isOwnerOccludingPanel(HEAD, behind, QUAD, OCCLUSION), false);
  const backwards = { x: 0, y: 1.6, z: 0.30 };
  assert.equal(isOwnerOccludingPanel(HEAD, backwards, QUAD, OCCLUSION), false);

  // Degenerate: the panel at the eye. No ray, no occlusion.
  assert.equal(isOwnerOccludingPanel(HEAD, inFront, HEAD, OCCLUSION), false);
});

test("a hand in front of its own frozen panel RE-ANCHORS it", () => {
  // None of the other three releases fire here (an ordinary 3 cm drift, the hand
  // posed, the watchdog nowhere near), which is why the panel would otherwise sit
  // there.
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  assert.equal(state.frozen, true);
  state = freeze(state, { approachM: 0.05, ownerDriftM: 0.03, ownerOccluding: true });
  assert.equal(state.frozen, false);
  assert.equal(state.reason, "occluded");
  // Like the other abnormal releases it demands a re-arm, so the re-anchored
  // panel is not instantly re-frozen at the new pose and stranded again.
  assert.equal(state.rearmRequired, true);
  state = freeze(state, { approachM: 0.05, ownerOccluding: true });
  assert.equal(state.frozen, false, "still re-arming while the finger is close");
  state = freeze(state, { approachM: 0.20, ownerOccluding: true });
  assert.equal(state.rearmRequired, false, "the finger left");
});

test("...but NOT while a poke is actually landing", () => {
  // The gate. Moving the target in the last centimetre is the failure
  // freeze-on-approach exists to prevent, and it is worse than the occlusion:
  // the user misses the row entirely.
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  state = freeze(state, { approachM: 0.02, ownerOccluding: true, pokeCommitted: true });
  assert.equal(state.frozen, true, "the poke wins the last centimetre");
  assert.equal(state.reason, null);
  // The moment the finger backs off the approach again, the re-anchor is free
  // to fire.
  state = freeze(state, { approachM: 0.06, ownerOccluding: true, pokeCommitted: false });
  assert.equal(state.reason, "occluded");
});

test("the two releases that mean an ABANDONED panel are not gated by a poke", () => {
  // The ordering: `pokeCommitted` protects the last centimetre of a poke from a
  // re-anchor, and nothing more. A panel 20 cm from its own arm, or worn by a
  // hand that is gone, is not a poke worth protecting.
  let drifted = freeze(createWristFreezeState(), { approachM: 0.05 });
  drifted = freeze(drifted, { approachM: 0.02, ownerDriftM: 0.20, pokeCommitted: true });
  assert.equal(drifted.reason, "anchor-drift");

  let lost = freeze(createWristFreezeState(), { approachM: 0.05 });
  lost = freeze(lost, {
    approachM: 0.02,
    ownerPosed: false,
    ownerLostMs: LOST_GRACE_MS + 1,
    pokeCommitted: true
  });
  assert.equal(lost.reason, "hand-lost");
});

test("an occlusion by a hand that is not posed cannot release anything", () => {
  // The geometry needs a wrist position to have been read. Without one the
  // caller passes ownerOccluding: false anyway, but the rule states it too, so
  // a future caller cannot pass a stale verdict through.
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  state = freeze(state, {
    approachM: 0.05,
    ownerPosed: false,
    ownerOccluding: true,
    ownerLostMs: 100
  });
  assert.equal(state.frozen, true, "an unposed hand says nothing about occlusion");
});

test("wristui RE-ANCHORS on an occlusion rather than merely unfreezing", async () => {
  // A plain release would leave the panel crawling out from behind the hand at
  // WRIST_POSITION_LERP; clearing anchorInitialized routes the pose write through
  // its SNAP branch instead, the same one a fresh summon takes.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
  assert.ok(
    /nextFreeze\.reason === "occluded"[\s\S]{0,900}?panel\.anchorInitialized = false;/.test(src),
    "the occluded release must clear anchorInitialized"
  );
  // The gate is the HOVER radius, not the freeze's own 100 mm enter radius: the
  // freeze latches while the finger is still travelling, and a panel behind a
  // hand is worth re-aiming right up until the finger is on it.
  assert.ok(
    /const pokeCommitted = \(pokeApproachM <= WRIST_POKE_HOVER_M\)/.test(src),
    "pokeCommitted is the hover band, plus the press latch and the hold"
  );
  assert.ok(/\|\| panel\.poke\.pressed/.test(src));
  assert.ok(/\|\| panel\.hold\.holding/.test(src));
  // And the geometry comes from the pure function, not from a second copy.
  assert.ok(/ownerOccluding: ownerMeasured && isOwnerOccludingPanel\(/.test(src));
  // Drift is measured from the live target pose, not the wrist joint.
  assert.ok(/computePanelCentre\(hf, panel\.layout, _anchorTarget\)\.distanceTo\(panel\.quad\.position\)/.test(src));
});

test("a short dropout of the wearing hand still holds the freeze", () => {
  // The whole point of the freeze: poking your own wrist occludes it. The release
  // rules must not break that.
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  for (let ms = 33; ms <= LOST_GRACE_MS; ms += 33) {
    state = freeze(state, { approachM: 0.05, ownerPosed: false, ownerLostMs: ms, nowMs: ms });
    assert.equal(state.frozen, true, `still frozen ${ms} ms into the dropout`);
  }
});

test("an arm that is simply GONE releases it", () => {
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  state = freeze(state, {
    approachM: 0.05,
    ownerPosed: false,
    ownerLostMs: LOST_GRACE_MS + 1,
    nowMs: LOST_GRACE_MS + 1
  });
  assert.equal(state.frozen, false);
  assert.equal(state.reason, "hand-lost");
  assert.equal(state.rearmRequired, true);
});

test("the watchdog is a backstop, not the fix — it fires only at the end", () => {
  let state = freeze(createWristFreezeState(), { approachM: 0.05, nowMs: 0 });
  assert.equal(state.sinceMs, 0, "t=0 is a real timestamp, not an unset timer");
  state = freeze(state, { approachM: 0.05, nowMs: MAX_HOLD_MS - 1 });
  assert.equal(state.frozen, true, "a long deliberate approach is still an approach");
  state = freeze(state, { approachM: 0.05, nowMs: MAX_HOLD_MS });
  assert.equal(state.frozen, false);
  assert.equal(state.reason, "watchdog");
  assert.equal(state.rearmRequired, true);
});

test("no panel, no finger, no freeze — and the re-arm goes with them", () => {
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  assert.equal(state.frozen, true);
  // Hiding the panel is also the session-end path (setPanelVisible -> reset).
  assert.deepEqual(freeze(state, { approachM: 0.05, panelVisible: false }), createWristFreezeState());
  assert.deepEqual(freeze(state, { approachM: 0.05, pokerTracked: false }), createWristFreezeState());
  // A quad that has never been anchored sits at the origin; it cannot freeze.
  assert.equal(freeze(createWristFreezeState(), { approachM: 0.05, quadPlaced: false }).frozen, false);
});

test("a release names itself exactly once, on the frame it happens", () => {
  let state = freeze(createWristFreezeState(), { approachM: 0.05 });
  assert.equal(state.reason, null, "freezing is not a release");
  state = freeze(state, { approachM: 0.05, ownerDriftM: 0.5 });
  assert.equal(state.reason, "anchor-drift");
  state = freeze(state, { approachM: 0.05, ownerDriftM: 0.5 });
  assert.equal(state.reason, null, "the diagnostic logs an edge, not a state");
});

test("the freeze state object is never mutated", () => {
  const state = freeze(createWristFreezeState(), { approachM: 0.05 });
  const snapshot = { ...state };
  freeze(state, { approachM: 0.05, ownerDriftM: 0.9 });
  freeze(state, { approachM: 5 });
  assert.deepEqual(state, snapshot);
});

// --- resolveSectionPoke ------------------------------------------------------
//
// Close-on-repoke exists because the active row draws a ✕: a ✕ that does not
// close the open menu and unselect the item is a lie.

test("no panel open promotes: the poke opens the world panel on that mode", () => {
  assert.equal(resolveSectionPoke({ mainPanelOpen: false }), "promote");
  // A section can be the app's active mode while nothing is showing (hidePanel()
  // keeps activeModeId). That must still promote, never close a closed panel.
  assert.equal(
    resolveSectionPoke({ mainPanelOpen: false, sectionActive: true }),
    "promote",
    "a stale active mode behind a hidden panel is not something to close"
  );
});

test("poking the section the panel is SHOWING closes it — the ✕ means the ✕", () => {
  assert.equal(resolveSectionPoke({ mainPanelOpen: true, sectionActive: true }), "close");
});

test("poking a different section while the panel is open switches it in place", () => {
  // "switch" is what tells wristui not to re-anchor a panel the user can
  // already see; that distinction is why the promote/switch split exists.
  assert.equal(resolveSectionPoke({ mainPanelOpen: true, sectionActive: false }), "switch");
  assert.equal(
    resolveSectionPoke({ mainPanelOpen: true }),
    "switch",
    "a missing sectionActive reads as 'not this one', i.e. a switch"
  );
});

test("close is reachable from exactly one combination and no other", () => {
  const seen = [];
  for (const mainPanelOpen of [true, false]) {
    for (const sectionActive of [true, false]) {
      if (resolveSectionPoke({ mainPanelOpen, sectionActive }) === "close") {
        seen.push([mainPanelOpen, sectionActive]);
      }
    }
  }
  assert.deepEqual(seen, [[true, true]]);
});

test("the outcome resolver carries sectionActive through from the item", () => {
  // wristui.js passes the ROW, and the row's `active` flag comes from vrpanel's
  // launcherSections(). If that stopped reaching resolveSectionPoke() the ✕
  // would go back to being a lie, silently.
  const active = { id: "web", enabled: true, hold: false, active: true };
  const inactive = { id: "image", enabled: true, hold: false, active: false };
  assert.equal(
    resolveWristPokeOutcome(active, { role: "content", mainPanelOpen: true }),
    "close"
  );
  assert.equal(
    resolveWristPokeOutcome(inactive, { role: "content", mainPanelOpen: true }),
    "switch"
  );
  assert.equal(
    resolveWristPokeOutcome(active, { role: "content", mainPanelOpen: false }),
    "promote"
  );
});

// --- the wiring the pure function cannot see -------------------------------
// Source-level assertions, the same technique xr_hand_gestures.test.mjs uses
// against constants.js. wristui.js and vrpanel.js both need a live XR frame and a
// DOM to import, but these decisions are visible in their text, and a regression
// in either would otherwise only surface on a headset.

// activateTarget() is one pure resolveWristPokeOutcome() call followed by a
// switch on the outcome, so a branch is the text between its `case` label and the
// `break` that closes it.
async function activateTargetBranch(outcome) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wristui = fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
  const activate = wristui.slice(wristui.indexOf("function activateTarget("));
  const start = activate.indexOf(`case "${outcome}":`);
  assert.notEqual(start, -1, `activateTarget() has no "${outcome}" branch`);
  const body = activate.slice(start);
  // Comments are stripped: these branches are heavily commented (the capture
  // branch's comment says the word "countdown" in order to say there isn't one),
  // and an assertion about the CODE must not be answered by the prose about it.
  return body
    .slice(0, body.indexOf("break;"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("a content poke that is not a close goes through showPanelForMode()", async () => {
  // "promote" and "switch" share one branch; slicing from "promote" covers both.
  const branch = await activateTargetBranch("promote");
  assert.ok(
    /showPanelForMode\(/.test(branch),
    "promote/switch go through the one entry point"
  );
  assert.ok(
    !/hidePanel\(/.test(branch),
    "and neither of them hides anything — only the close branch does"
  );
});

test("the close branch hides the world panel, and hides only it", async () => {
  const branch = await activateTargetBranch("close");
  assert.ok(/hidePanel\(\)/.test(branch), "close actually closes");
  assert.ok(
    !/showPanelForMode\(/.test(branch),
    "a close must not also re-open the mode it just closed"
  );
  // togglePanel() would re-derive a decision this function has already made
  // (and its help/idle special-cases could get it wrong).
  assert.ok(!/togglePanel\(/.test(branch), "hidePanel, not togglePanel");
});

test("the wrist ✕ is drawn from EXACTLY the condition that closes", async () => {
  // A ✕ that does not close is a bug. The glyph hangs off a `closable` flag
  // computed as `item.active && ctxState.mainOpen` (the same two facts
  // resolveSectionPoke() returns "close" for), so the drawing and the behaviour
  // cannot drift apart. Source-level because wristui.js needs a live XR frame and a
  // DOM to import.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wristui = fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
  assert.match(
    wristui,
    /const closable = Boolean\(\s*\n\s*\(item\.active && ctxState\.mainOpen\)\s*\n\s*\|\| \(item\.id === "help" && ctxState\.helpOpen\)\s*\n\s*\);/,
    "closable is the close condition, verbatim — both halves of it"
  );
  // The cross is guarded by `closable`, which includes the Help row while help is
  // up: the row toggles, so a row drawn open without a cross would be a lie.
  const drawRow = wristui.slice(wristui.indexOf("function drawRow("));
  const crossAt = drawRow.indexOf('fillText("✕"');
  assert.notEqual(crossAt, -1, "the cross is still drawn somewhere");
  const guard = drawRow.slice(0, crossAt);
  assert.match(
    guard.slice(guard.lastIndexOf("if (")),
    /^if \(closable\) \{/,
    "the cross is drawn under `if (closable)`"
  );
});

test("THE HELP ROW TOGGLES: closed opens it, open closes it", () => {
  // The Help row toggles help: a poke that does nothing while help is open reads
  // as a dead control.
  const help = { id: "help", enabled: true, hold: false };
  assert.equal(
    resolveWristPokeOutcome(help, { role: "system", helpOpen: false }),
    "help"
  );
  assert.equal(
    resolveWristPokeOutcome(help, { role: "system", helpOpen: true }),
    "help-close"
  );
  // An unknown reads as closed, which is the safe half: the worst case is a
  // second open, not a control that appears dead.
  assert.equal(resolveWristPokeOutcome(help, { role: "system" }), "help");
  // The row's own gates still outrank the toggle, in the same order as before.
  assert.equal(
    resolveWristPokeOutcome({ ...help, enabled: false }, { role: "system", helpOpen: true }),
    "disabled"
  );
  assert.equal(
    resolveWristPokeOutcome({ ...help, hold: true }, { role: "system", helpOpen: true }),
    "hold-row"
  );
  // ...and nothing else moved: Capture is still a single named outcome.
  assert.equal(
    resolveWristPokeOutcome({ id: "capture", enabled: true, hold: false }, { role: "system" }),
    "capture"
  );
  assert.equal(
    resolveWristPokeOutcome({ id: "mystery", enabled: true, hold: false }, { role: "system" }),
    "unhandled"
  );
});

test("...and each half of the toggle calls the one function that does it", async () => {
  const open = await activateTargetBranch("help");
  assert.ok(/showHelpPanel\(\)/.test(open));
  assert.ok(!/toggleHelpPanel\(\)/.test(open), "the decision is already made");
  const close = await activateTargetBranch("help-close");
  assert.ok(/hideHelpPanel\(\)/.test(close), "the close half actually closes");
  assert.ok(!/showHelpPanel\(\)/.test(close), "and does not re-open it");
  // Same rule as the content rows' close branch: the outcome resolver has
  // already established which way this goes, so a toggle here would re-derive a
  // decision (and its help/idle special-cases could get it wrong).
  assert.ok(!/togglePanel\(|toggleHelpPanel\(/.test(close), "hideHelpPanel, not a toggle");
});

test("the help toggle reads the SAME helpOpen the row's own glyph does", async () => {
  // The ✕/open treatment on the Help row is drawn from `ctxState.helpOpen`
  // (wristui.js). If the decision stopped reading the same fact, the row would draw
  // one thing and do another.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wristui = fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
  assert.match(
    wristui,
    /\|\| \(item\.id === "help" && ctxState\.helpOpen\)/,
    "the row is drawn open (and closable) from helpOpen"
  );
  const call = wristui.slice(wristui.indexOf("const outcome = resolveWristPokeOutcome("));
  assert.match(
    call.slice(0, call.indexOf("});")),
    /helpOpen: context\.helpOpen/,
    "and the decision is handed the same fact"
  );
});

test("Capture fires the ONE existing screenshot path, not a second one", async () => {
  // The wrist row and the controller's left grip must stay a single code path:
  // saveScreenshotWithStatus() is what hides the hands and reports through
  // setStatus(), and a parallel capture here would silently skip both.
  const branch = await activateTargetBranch("capture");
  assert.ok(/saveScreenshotWithStatus\(\)/.test(branch));
  assert.ok(
    !/WebGLRenderTarget|readRenderTargetPixels/.test(branch),
    "no second capture implementation on the wrist path"
  );
  assert.ok(
    !/setTimeout|countdown/i.test(branch),
    "no countdown, delay or ring in front of the shutter"
  );
});

test("the wrist no longer fires the world panel's statusFooter action", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wristui = fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
  assert.ok(
    !/runPanelAction\(/.test(wristui),
    "the info/footer toggle lives on the world panel's own 'Show info' cell now"
  );
});

test("an explicitly chosen mode overrides the start-favourites shortcut", async () => {
  // The MAIN panel must not draw the same start-favourites list the IDLE panel
  // draws, or a correct promote looks like nothing happened. The override has to
  // sit on the draw, and be forgotten when the panel closes or the idle launcher
  // comes back.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vrpanel = fs.readFileSync(path.join(here, "..", "src", "vrpanel.js"), "utf8");
  assert.match(
    vrpanel,
    /if \(!keyboardOpen && !modeChosenExplicitly && shouldShowStartFavorites\(\)\)/,
    "the start-favourites draw is gated on the explicit choice"
  );
  assert.match(vrpanel, /function setActiveMode\([\s\S]{0,400}modeChosenExplicitly = true/);
  const hidePanel = vrpanel.slice(vrpanel.indexOf("function hidePanel("));
  assert.match(
    hidePanel.slice(0, hidePanel.indexOf("function togglePanel(")),
    /modeChosenExplicitly = false/,
    "closing the panel forgets the choice"
  );
  const idle = vrpanel.slice(vrpanel.indexOf("function showIdlePanel("));
  assert.match(
    idle.slice(0, idle.indexOf("function shouldShowIdlePanel(")),
    /modeChosenExplicitly = false/,
    "and so does dropping back to the idle launcher"
  );
});

// --- handedness ------------------------------------------------------------

test("the default panel hand is left, so the right hand is the free one", () => {
  // Select resolves the pinch that drives it from exactly this pair, and the
  // default must reproduce right-hand-selects exactly.
  assert.equal(DEFAULT_WRIST_PANEL_HAND, "left");
  assert.equal(resolveWristPanelHand("left"), "left");
  assert.equal(resolveFreeHand("left"), "right");
});

test("mirroring the setting mirrors both hands together", () => {
  assert.equal(resolveWristPanelHand("right"), "right");
  assert.equal(resolveFreeHand("right"), "left");
});

test("the free hand is never the panel hand, for any input at all", () => {
  // The hand wearing the launcher must never be the selecting hand: a pinch there
  // can eject the WebXR session.
  for (const value of ["left", "right", "LEFT", " Right ", "", null, undefined, "middle", 7]) {
    assert.notEqual(
      resolveFreeHand(value),
      resolveWristPanelHand(value),
      `free hand collided with the panel hand for ${JSON.stringify(value)}`
    );
  }
});

test("case and whitespace are tolerated; anything else falls back to the default", () => {
  assert.equal(normalizeWristPanelHand(" RIGHT "), "right");
  assert.equal(normalizeWristPanelHand("Left"), "left");
  // null is what lets setWristPanelHand() fall through to the next source.
  assert.equal(normalizeWristPanelHand("middle"), null);
  assert.equal(normalizeWristPanelHand(""), null);
  assert.equal(normalizeWristPanelHand(undefined), null);
  assert.equal(resolveWristPanelHand("middle"), DEFAULT_WRIST_PANEL_HAND);
  assert.equal(resolveFreeHand(undefined), "right");
});
