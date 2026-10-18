// Wrist-UI summon state machine and its two tiers (offline). Covers behaviours a
// device pass cannot easily prove by hand: the panel must not pop on a momentary
// glance, must not flicker when the condition drops for a frame, and must vanish
// the instant the hand stops tracking. Tier 1 (panel present) is a wide cone with
// no palm term; tier 2 (labels) is the narrow one nested inside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWristSummonState,
  updateWristSummonState,
  withinCone,
  gazeCosTo,
  resolveWristSummonTier
} from "../src/wrist-summon.js";

const SHOW_MS = 150;
const HIDE_MS = 400;

function step(state, { tracked = true, conditionMet = false, nowMs }) {
  return updateWristSummonState(state, {
    tracked,
    conditionMet,
    nowMs,
    showDelayMs: SHOW_MS,
    hideDelayMs: HIDE_MS
  });
}

test("a fresh state is hidden with no timers running", () => {
  assert.deepEqual(createWristSummonState(), {
    visible: false,
    satisfiedSinceMs: null,
    lostSinceMs: null
  });
});

test("the tier factor must hold for the show delay before the panel appears", () => {
  let state = createWristSummonState();
  state = step(state, { conditionMet: true, nowMs: 0 });
  assert.equal(state.visible, false, "no instant pop on the first satisfied frame");
  state = step(state, { conditionMet: true, nowMs: 149 });
  assert.equal(state.visible, false);
  state = step(state, { conditionMet: true, nowMs: 150 });
  assert.equal(state.visible, true);
});

test("a satisfied timer starting at t=0 is not treated as unset", () => {
  // performance.now() really can read 0 on the first frame; a falsy check here
  // would restart the sustain timer every frame and never show the panel.
  let state = step(createWristSummonState(), { conditionMet: true, nowMs: 0 });
  assert.equal(state.satisfiedSinceMs, 0);
  state = step(state, { conditionMet: true, nowMs: 200 });
  assert.equal(state.visible, true);
});

test("a brief drop in the condition does not flicker a visible panel", () => {
  let state = createWristSummonState();
  state = step(state, { conditionMet: true, nowMs: 0 });
  state = step(state, { conditionMet: true, nowMs: 200 });
  assert.equal(state.visible, true);

  state = step(state, { conditionMet: false, nowMs: 210 });
  assert.equal(state.visible, true, "still visible inside the hysteresis window");
  state = step(state, { conditionMet: true, nowMs: 250 });
  assert.equal(state.visible, true);
  assert.equal(state.lostSinceMs, null, "regaining the condition clears the hide timer");
});

test("the panel hides once the condition has been lost for the hide delay", () => {
  let state = createWristSummonState();
  state = step(state, { conditionMet: true, nowMs: 0 });
  state = step(state, { conditionMet: true, nowMs: 200 });
  state = step(state, { conditionMet: false, nowMs: 300 });
  assert.equal(state.visible, true);
  state = step(state, { conditionMet: false, nowMs: 699 });
  assert.equal(state.visible, true);
  state = step(state, { conditionMet: false, nowMs: 700 });
  assert.equal(state.visible, false);
});

test("losing the hand hides immediately and resets both timers", () => {
  let state = createWristSummonState();
  state = step(state, { conditionMet: true, nowMs: 0 });
  state = step(state, { conditionMet: true, nowMs: 200 });
  assert.equal(state.visible, true);
  state = step(state, { tracked: false, conditionMet: true, nowMs: 210 });
  assert.deepEqual(state, { visible: false, satisfiedSinceMs: null, lostSinceMs: null });
});

test("re-tracking restarts the sustain timer from scratch", () => {
  let state = createWristSummonState();
  state = step(state, { conditionMet: true, nowMs: 0 });
  state = step(state, { tracked: false, conditionMet: true, nowMs: 100 });
  state = step(state, { conditionMet: true, nowMs: 120 });
  assert.equal(state.visible, false, "the pre-drop dwell must not carry over");
  state = step(state, { conditionMet: true, nowMs: 270 });
  assert.equal(state.visible, true);
});

test("the input state object is never mutated", () => {
  const state = createWristSummonState();
  const snapshot = { ...state };
  step(state, { conditionMet: true, nowMs: 10 });
  assert.deepEqual(state, snapshot);
});

// --- two-tier resolution -----------------------------------------------------
// The shipped angles. Tier 1 is generous on purpose: the panel is meant to be
// there, minimally, whenever the hand is in view.
const VIEW_DEG = 50;
const FOCUS_DEG = 15;
const ANGLES = { viewMaxAngleDeg: VIEW_DEG, focusMaxAngleDeg: FOCUS_DEG };

// The cosine the runtime would produce for a hand `deg` off the centre of view.
function cosAt(deg) {
  return Math.cos((deg * Math.PI) / 180);
}

function tierAt(deg) {
  return resolveWristSummonTier(cosAt(deg), ANGLES);
}

test("a cone test is inclusive at its own edge and false just outside it", () => {
  assert.equal(withinCone(cosAt(50), 50), true, "exactly on the edge counts as inside");
  assert.equal(withinCone(cosAt(50.001), 50), false);
  assert.equal(withinCone(cosAt(0), 50), true);
  assert.equal(withinCone(-1, 50), false, "directly behind the head is never in view");
});

test("tier 1 shows the panel anywhere in the wide cone", () => {
  // At 30° off-centre the hand is plainly in view but nobody is looking AT it, and
  // that is the minimal icons state.
  assert.deepEqual(tierAt(0), { inView: true, focused: true });
  assert.deepEqual(tierAt(30), { inView: true, focused: false });
  assert.deepEqual(tierAt(49), { inView: true, focused: false });
});

test("tier 1 releases outside the wide cone", () => {
  assert.deepEqual(tierAt(51), { inView: false, focused: false });
  assert.deepEqual(tierAt(120), { inView: false, focused: false });
});

test("tier 2 needs the user to be looking at that wrist", () => {
  assert.equal(tierAt(14).focused, true);
  assert.equal(tierAt(16).focused, false);
});

test("tier 1 has no palm dependency — there is nowhere to put one", () => {
  // Asserted on the SIGNATURE rather than on a value: the rule takes one gaze
  // cosine and a pair of angles, full stop. A palm-toward-head factor beside the
  // gaze cone would be trivially satisfied by the jointless grip fallback and start
  // hiding the panels once real joints arrive.
  assert.equal(resolveWristSummonTier.length, 2, "gazeCos and the angles, nothing else");
  const keys = Object.keys(tierAt(20)).sort();
  assert.deepEqual(keys, ["focused", "inView"]);
  // Every distinct hand pose that shares a gaze cosine resolves identically,
  // whatever the wrist is doing — which is what "no palm term" means in use.
  for (const deg of [0, 10, 20, 35, 49, 51, 90]) {
    assert.deepEqual(tierAt(deg), resolveWristSummonTier(cosAt(deg), ANGLES));
  }
});

test("the focus cone is nested inside the view cone, so labels imply a panel", () => {
  // If these two ever get misconfigured the wrong way round, a panel could ask
  // for labels while not being shown at all. Sweep the whole range.
  for (let deg = 0; deg <= 180; deg += 1) {
    const tier = tierAt(deg);
    if (tier.focused) {
      assert.equal(tier.inView, true, `focused but not in view at ${deg}°`);
    }
  }
});

test("the tier-2 machine is the same machine, so labels cannot strobe either", () => {
  // wristui.js runs a second copy of updateWristSummonState() on the focus
  // cone, with its own slower delays (220/700 ms). This is that wiring, checked
  // end to end: a glance that grazes the cone edge must not flip the layout.
  const EXPAND_SHOW_MS = 220;
  const EXPAND_HIDE_MS = 700;
  const expand = (state, conditionMet, nowMs) => updateWristSummonState(state, {
    tracked: true,
    conditionMet,
    nowMs,
    showDelayMs: EXPAND_SHOW_MS,
    hideDelayMs: EXPAND_HIDE_MS
  });

  let state = createWristSummonState();
  state = expand(state, tierAt(10).focused, 0);
  state = expand(state, tierAt(10).focused, 219);
  assert.equal(state.visible, false, "a passing glance does not expand the panel");
  state = expand(state, tierAt(10).focused, 220);
  assert.equal(state.visible, true);

  // Eyes drift off the wrist for a couple of frames while it stays in view.
  state = expand(state, tierAt(30).focused, 260);
  assert.equal(state.visible, true, "still expanded inside the hysteresis window");
  state = expand(state, tierAt(10).focused, 300);
  assert.equal(state.visible, true);
  // A real look away does collapse it, eventually.
  state = expand(state, tierAt(30).focused, 400);
  state = expand(state, tierAt(30).focused, 1100);
  assert.equal(state.visible, false);
});

// --- the world-menu gaze collapse reuses THIS cone ---------------------------
//
// The wrist panels collapse to icons while the user reads the world panel. There
// must not be a SECOND notion of "looking at" beside the summon tiers, so the
// rule is the same withinCone() against the same head pose, and this pins that.

async function wristuiSource() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
}

test("the world-menu gaze test is withinCone against the same head forward", async () => {
  const src = await wristuiSource();
  const fn = src.slice(src.indexOf("function readWorldMenuGaze()"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(
    /withinCone\(_headForward\.dot\(_toWorldMenu\), WRIST_WORLD_MENU_GAZE_MAX_ANGLE_DEG\)/.test(body),
    "the collapse must ask the same question the summon tiers ask"
  );
  assert.ok(
    /readPanelWorldPosition\(/.test(body),
    "the world panel's own position, not a guess at where it is"
  );
  assert.ok(
    !/Math\.acos|Math\.cos/.test(body),
    "no second cone implementation — withinCone owns the trigonometry"
  );
  // Allocation-free, like every other per-frame path in this file.
  assert.ok(!/new THREE\./.test(body), "scratch vectors, not per-frame allocation");
});

test("the world-menu cone is wider than the wrist-focus cone, and says why", async () => {
  const src = await wristuiSource();
  const num = (name) => {
    const match = src.match(new RegExp(`const ${name} = (-?[0-9.]+);`));
    assert.ok(match, `${name} is missing or no longer a literal`);
    return Number(match[1]);
  };
  const world = num("WRIST_WORLD_MENU_GAZE_MAX_ANGLE_DEG");
  const focus = num("WRIST_SUMMON_FOCUS_MAX_ANGLE_DEG");
  const view = num("WRIST_SUMMON_VIEW_MAX_ANGLE_DEG");
  // The world panel is 1.6 x 1.2 m at 2.4 m: its own edges are 18.4 deg
  // horizontally from its centre, so a cone at or under the wrist-focus 15 deg
  // would only fire while staring at the middle of it.
  assert.ok(world > focus, "a 1.6 m panel at 2.4 m is wider than a wrist");
  assert.ok(world >= 18.4, "at least the panel's own horizontal half-angle");
  assert.ok(world < view, "but nowhere near 'facing roughly forward'");
});

// --- what tier 2 is aimed at -------------------------------------------------
//
// The cone is measured against the PANEL, not the wrist joint, and the panel
// hangs several centimetres off the wrist. These tests pin the geometry that says
// the offset is big enough to matter, and that aiming the cone at the panel
// centre removes it.

// The panel's own offsets, from wristui.js. Perpendicular to the line of sight
// is what costs an angle; the 35 mm palm offset points roughly AT the head in
// the pose the panel is designed to be read in, so it mostly does not.
const PANEL_ULNAR_M = 0.012;
const PANEL_LABEL_PIN_M = 0.027;   // labels layout's pinOffsetM
const PANEL_ROW_SPREAD_M = 0.055;  // quad half-height: the far row from centre

function degBetween(cos) {
  return (Math.acos(cos) * 180) / Math.PI;
}

test("gazeCosTo is the cosine to a POINT, and refuses a degenerate one", () => {
  const head = { x: 0, y: 0, z: 0 };
  const forward = { x: 0, y: 0, z: -1 };
  assert.ok(Math.abs(gazeCosTo(head, { x: 0, y: 0, z: -1 }, forward) - 1) < 1e-12);
  // 3-4-5: a target 0.3 m off-axis at 0.4 m ahead is 36.87 deg out.
  const cos = gazeCosTo(head, { x: 0.3, y: 0, z: -0.4 }, forward);
  assert.ok(Math.abs(degBetween(cos) - 36.8698976) < 1e-4);
  // Unnormalised forward vectors are handled — the caller passes scratch.
  assert.ok(Math.abs(gazeCosTo(head, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -7 }) - 1) < 1e-12);
  assert.ok(Number.isNaN(gazeCosTo(head, head, forward)), "no direction, no answer");
  assert.equal(withinCone(gazeCosTo(head, head, forward), 15), false, "and NaN is refused");
});

test("the wrist-to-panel offset really was most of a 15 deg cone", () => {
  // Reading the far row of a labels-mode panel at a 35 cm read distance. The
  // lateral term is the ulnar offset plus the labels layout's pin offset; the
  // longitudinal one is the row's own distance from the panel centre.
  const lateralM = PANEL_ULNAR_M + PANEL_LABEL_PIN_M;
  const rowM = PANEL_ROW_SPREAD_M;
  const offsetM = Math.hypot(lateralM, rowM);
  const atDeg = (distanceM) => (Math.atan2(offsetM, distanceM) * 180) / Math.PI;
  assert.ok(offsetM > 0.06, "67 mm from the wrist joint");
  assert.ok(atDeg(0.35) > 10.5 && atDeg(0.35) < 11.5, "10.9 deg at a 35 cm read");
  assert.ok(atDeg(0.30) > 12.5, "12.6 deg at 30 cm — inside a 15 deg cone by 2.4 deg");
  // ...and that is a BIAS, not noise: it is there on every frame of the pose.
  // Once it plus a little head drift breaks the cone, WRIST_EXPAND_HIDE_DELAY_MS
  // is the only thing between a steady gaze and the labels going away.
  assert.ok(atDeg(0.30) + 3 > FOCUS_DEG, "3 deg of head drift is enough to break it");
});

test("aiming the cone at the panel centre is what fixes it", () => {
  // The same pose, both ways. The head looks straight at the panel centre; the
  // wrist is 39 mm to one side of it and 10 mm nearer, at a 35 cm read.
  const head = { x: 0, y: 0, z: 0 };
  const forward = { x: 0, y: 0, z: -1 };
  const panel = { x: 0, y: 0, z: -0.35 };
  const wrist = { x: PANEL_ULNAR_M + PANEL_LABEL_PIN_M, y: 0.01, z: -0.34 };

  const wristCos = gazeCosTo(head, wrist, forward);
  const panelCos = gazeCosTo(head, panel, forward);
  assert.equal(withinCone(panelCos, FOCUS_DEG), true, "looking straight at it");
  assert.ok(degBetween(wristCos) > 6, "the wrist alone is already several degrees out");

  // The two tiers take two cosines, and the third argument carries the panel one.
  // Tier 1 stays on the hand: it asks "is that HAND in front of me", and at 50 deg
  // none of this is material.
  const tier = resolveWristSummonTier(wristCos, ANGLES, panelCos);
  assert.deepEqual(tier, { inView: true, focused: true });

  // The pose a wrist-aimed cone fails on: reading the far row at 30 cm, with five
  // degrees of ordinary head drift off the row's centre. The gaze is comfortably on
  // the panel (5 deg into a 15 deg cone) and the wrist is 16 deg away, because the
  // drift lands on TOP of the fixed 12.6 deg offset instead of being centred on it.
  const driftRad = (5 * Math.PI) / 180;
  const drifted = { x: -Math.sin(driftRad), y: 0, z: -Math.cos(driftRad) };
  const farRow = { x: 0, y: 0, z: -0.30 };
  const wristAtRow = { x: PANEL_ULNAR_M + PANEL_LABEL_PIN_M, y: PANEL_ROW_SPREAD_M, z: -0.30 };
  assert.ok(degBetween(gazeCosTo(head, farRow, drifted)) < FOCUS_DEG, "the gaze IS on the panel");
  const oldWay = resolveWristSummonTier(gazeCosTo(head, wristAtRow, drifted), ANGLES);
  const newWay = resolveWristSummonTier(
    gazeCosTo(head, wristAtRow, drifted),
    ANGLES,
    gazeCosTo(head, farRow, drifted)
  );
  assert.equal(oldWay.focused, false, "the wrist-aimed cone dropped a steady gaze");
  assert.equal(newWay.focused, true, "the panel-aimed one does not");
});

test("the third argument defaults to the first, so one cosine still works", () => {
  // Every existing caller and every existing test passes one cosine; the two
  // tiers must go on meaning what they meant.
  for (const deg of [0, 10, 14, 16, 30, 51]) {
    assert.deepEqual(
      resolveWristSummonTier(cosAt(deg), ANGLES),
      resolveWristSummonTier(cosAt(deg), ANGLES, cosAt(deg))
    );
  }
});

test("wristui aims tier 2 at the panel centre and tier 1 at the hand", async () => {
  const src = await wristuiSource();
  const fn = src.slice(src.indexOf("function summonTierFor("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(/panelGazeCosFor\(hf, panel\)/.test(body), "tier 2 reads the panel centre");
  assert.ok(/_headForward\.dot\(hf\.toHand\)/.test(body), "tier 1 still reads the hand");
  // And the panel centre must come from the SAME offset chain the pose uses, or
  // the cone and the panel would drift apart again the next time an offset moves.
  const centre = src.slice(src.indexOf("function panelGazeCosFor("));
  assert.ok(
    /computePanelCentre\(hf, panel\.layout, _panelGazeCentre\)/.test(centre),
    "one offset chain, not two"
  );
  assert.ok(!/new THREE\./.test(centre), "scratch vectors, not per-frame allocation");
});
