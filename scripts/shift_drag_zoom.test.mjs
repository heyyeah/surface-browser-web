// Shift + click-drag: zoom while moving, GenAI while still.
//
// One pointer stroke decides between a free gesture and a paid one, so the
// safety rules get the same treatment as the two-finger chord: a fake clock,
// and explicit sweeps for the ways a drag might become a purchase.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  createShiftDragState,
  applyShiftDragEvent,
  releaseShiftDrag,
  stepShiftDrag,
  SHIFT_DRAG_SLOP_PX,
  SHIFT_DRAG_CHORD_HOLD_MS,
  SHIFT_DRAG_METERS_PER_SHORT_EDGE,
  SHIFT_DRAG_CHORD_RING_DELAY_MS
} from "../src/shift-drag-zoom.js";
import { APP_STATE_INSIDE_SPHERE, APP_STATE_TUNNEL } from "../src/xr-hand-gestures.js";
import { AppState } from "../src/constants.js";

const SHORT_EDGE = 800;
const FRAME_MS = 16;

function driver({ appState = APP_STATE_INSIDE_SPHERE, genAiAvailable = true, enabled = true } = {}) {
  const d = { now: 1000, state: createShiftDragState(), appState, genAiAvailable, enabled, decisions: [] };
  d.event = (type, x, y, { shiftKey = true } = {}) => {
    const r = applyShiftDragEvent(d.state, {
      type, pointerId: 1, x, y, nowMs: d.now, shiftKey, enabled: d.enabled, appState: d.appState
    });
    d.state = r.state;
    return r.handled;
  };
  d.frame = (dtMs = FRAME_MS) => {
    d.now += dtMs;
    const r = stepShiftDrag(d.state, {
      nowMs: d.now, shortEdgePx: SHORT_EDGE, genAiAvailable: d.genAiAvailable
    });
    d.state = r.state;
    d.decisions.push(r.decision);
    return r.decision;
  };
  d.frames = (n, dt = FRAME_MS) => { let last = null; for (let i = 0; i < n; i += 1) last = d.frame(dt); return last; };
  return d;
}

test("the app-state strings are the ones the app actually uses", () => {
  // The trackpad module once shipped broken because it retyped these. Anchor them.
  assert.equal(APP_STATE_INSIDE_SPHERE, AppState.INSIDE_SPHERE);
  assert.equal(APP_STATE_TUNNEL, AppState.TUNNEL);
});

test("dragging up zooms in, and the travel accumulates from the anchor", () => {
  const d = driver();
  d.event("down", 400, 400);
  d.event("move", 400, 300);
  const first = d.frame();
  assert.equal(first.distance.active, true);
  assert.equal(first.distance.justEngaged, true);
  assert.equal(first.distance.target, "sphereZoom");
  const expected = 100 * (SHIFT_DRAG_METERS_PER_SHORT_EDGE / SHORT_EDGE);
  assert.ok(Math.abs(first.distance.deltaM - expected) < 1e-9, "up is positive, as hands apart");

  d.event("move", 400, 250);
  const second = d.frame();
  assert.equal(second.distance.justEngaged, false, "justEngaged fires once per stroke");
  assert.ok(second.distance.deltaM > first.distance.deltaM, "travel is from the anchor, not per-frame");
});

test("dragging down is the opposite sign", () => {
  const d = driver();
  d.event("down", 400, 400);
  d.event("move", 400, 500);
  assert.ok(d.frame().distance.deltaM < 0);
});

test("in the tunnel the same drag drives speed", () => {
  const d = driver({ appState: APP_STATE_TUNNEL });
  d.event("down", 400, 400);
  d.event("move", 400, 300);
  assert.equal(d.frame().distance.target, "tunnelSpeed");
});

test("holding still fires the chord once, with a ring on the way", () => {
  const d = driver();
  d.event("down", 400, 400);
  // NO ring on the frame of the press: shift+click that becomes a drag and
  // shift+hold that becomes a chord open identically, so drawing immediately
  // would flash it on every zoom.
  const pressed = d.frame();
  assert.equal(pressed.chord.active, false, "the ring must not appear on the press");

  d.frames(Math.ceil(SHIFT_DRAG_CHORD_RING_DELAY_MS / FRAME_MS) + 1);
  const armed = d.decisions.at(-1);
  assert.equal(armed.chord.active, true, "...but it appears once the delay elapses");
  assert.ok(armed.chord.progress >= 0 && armed.chord.progress < 1);
  assert.equal(armed.chord.x, 400);

  d.frames(Math.ceil(SHIFT_DRAG_CHORD_HOLD_MS / FRAME_MS) + 2);
  const fired = d.decisions.filter((x) => x.chord.target === "genai");
  assert.equal(fired.length, 1, "exactly once per stroke");
  const after = d.frames(10);
  assert.equal(after.chord.active, false, "and nothing after it");
  assert.equal(after.chord.target, null);
});

test("a shift+click released before the ring fills leaves nothing on screen", () => {
  // Releasing before the ring fills must not leave it on screen. The resolver
  // reports an idle decision forever after a released stroke; input.js has to ACT
  // on that, which is what the shiftDragChordRingShown latch is for.
  const d = driver();
  d.event("down", 400, 400);
  d.frames(Math.ceil(SHIFT_DRAG_CHORD_RING_DELAY_MS / FRAME_MS) + 2);
  assert.equal(d.decisions.at(-1).chord.active, true, "the ring is up");

  d.event("up", 400, 400);
  const after = d.frames(5);
  assert.equal(after.chord.active, false, "a released stroke must report no ring");
  assert.equal(after.chord.target, null, "and must not fire on the way out");
});

test("MONEY SAFETY: a stroke that travelled can never fire the chord", () => {
  const d = driver();
  d.event("down", 400, 400);
  d.frame();
  d.event("move", 400, 400 - SHIFT_DRAG_SLOP_PX);
  d.frame();
  // Come all the way back to the anchor and sit there far longer than the hold.
  d.event("move", 400, 400);
  const decisions = [d.frame(), ...Array.from({ length: 120 }, () => d.frame())];
  for (const decision of decisions) {
    assert.notEqual(decision.chord.target, "genai", "a zoom must never become a purchase");
  }
});

test("MONEY SAFETY: no chord without a relay, and no ring either", () => {
  const d = driver({ genAiAvailable: false });
  d.event("down", 400, 400);
  const decisions = [d.frame(), ...Array.from({ length: 120 }, () => d.frame())];
  for (const decision of decisions) {
    assert.equal(decision.chord.target, null);
    assert.equal(decision.chord.active, false, "a ring that fills and does nothing reads as a failed purchase");
  }
});

test("MONEY SAFETY: the resolver defaults to no chord when the flag is omitted", () => {
  let state = createShiftDragState();
  state = applyShiftDragEvent(state, {
    type: "down", pointerId: 1, x: 10, y: 10, nowMs: 0, shiftKey: true, appState: APP_STATE_INSIDE_SPHERE
  }).state;
  let fired = false;
  for (let i = 1; i <= 120; i += 1) {
    const r = stepShiftDrag(state, { nowMs: i * FRAME_MS, shortEdgePx: SHORT_EDGE });
    state = r.state;
    fired = fired || r.decision.chord.target === "genai";
  }
  assert.equal(fired, false, "an omitted flag must not spend money");
});

test("MONEY SAFETY: the chord never arms in the tunnel", () => {
  const d = driver({ appState: APP_STATE_TUNNEL });
  d.event("down", 400, 400);
  const decisions = [d.frame(), ...Array.from({ length: 120 }, () => d.frame())];
  for (const decision of decisions) {
    assert.equal(decision.chord.target, null, "there is no image to vary in the tunnel");
  }
});

test("a press without shift starts nothing", () => {
  const d = driver();
  assert.equal(d.event("down", 400, 400, { shiftKey: false }), false, "not handled, so not preventDefault-ed");
  assert.equal(d.frame().distance.active, false);
});

test("outside the sphere and tunnel, and while the panel is up, nothing starts", () => {
  for (const opts of [{ appState: "start" }, { enabled: false }]) {
    const d = driver(opts);
    assert.equal(d.event("down", 400, 400), false);
    assert.equal(d.frame().distance.active, false);
  }
});

test("letting go of shift ends the stroke", () => {
  const d = driver();
  d.event("down", 400, 400);
  d.event("move", 400, 300);
  assert.equal(d.frame().distance.active, true);
  d.state = releaseShiftDrag(d.state);
  assert.equal(d.frame().distance.active, false, "a stroke must not outlive the modifier that started it");
});

test("release ends the stroke, and the next one starts fresh", () => {
  const d = driver();
  d.event("down", 400, 400);
  d.event("move", 400, 300);
  d.frame();
  d.event("up", 400, 300);
  assert.equal(d.frame().distance.active, false);

  d.event("down", 400, 400);
  d.event("move", 400, 380);
  const next = d.frame();
  assert.equal(next.distance.justEngaged, true);
  const expected = 20 * (SHIFT_DRAG_METERS_PER_SHORT_EDGE / SHORT_EDGE);
  assert.ok(Math.abs(next.distance.deltaM - expected) < 1e-9, "no travel inherited from the last stroke");
});

test("NaN input cannot poison a stroke", () => {
  const d = driver();
  d.event("down", 400, 400);
  d.event("move", 400, 300);
  const before = d.frame().distance.deltaM;
  assert.equal(d.event("move", NaN, 100), false);
  assert.equal(d.frame(0).distance.deltaM, before);
  assert.equal(stepShiftDrag(d.state, { nowMs: NaN }).decision.distance.active, false);
});

// --- WIRING ----------------------------------------------------------------

test("input.js takes the ring down when the stroke ends, however it ended", () => {
  // The resolver reporting an idle decision is only half of it; something has to
  // ACT on it. applyShiftDragInput() early-returns once the stroke is null, so
  // without a latch the last ring it drew stays on screen forever.
  const inputJs = fs.readFileSync(new URL("../src/input.js", import.meta.url), "utf8");
  const fn = inputJs.slice(inputJs.indexOf("function applyShiftDragInput"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /if \(!shiftDragState\.stroke\) \{[\s\S]*?shiftDragChordRingShown[\s\S]*?updateTouchChordRing\(\{ active: false \}\)/,
    "the early return must clear a ring it had drawn");
  assert.match(body, /shiftDragChordRingShown = Boolean\(chord\.active\)/,
    "and must record whether one is up");
});
