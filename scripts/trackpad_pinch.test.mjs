// Tests for the trackpad pinch resolver (src/trackpad-pinch.js).
//
// The thing worth testing here is the STROKE MANUFACTURE. A wheel stream has no
// end event, so the release is a timeout, and a timeout is exactly what cannot
// be checked by hand on a device: "I pinched, paused, pinched again and it
// jumped" is a bug report nobody can reproduce reliably. Everything below runs
// on an injected clock so the boundary is exact.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createTrackpadPinchState,
  applyTrackpadWheelEvent,
  stepTrackpadPinch,
  TRACKPAD_PINCH_IDLE_MS,
  TRACKPAD_PINCH_METERS_PER_WHEEL_UNIT,
  TRACKPAD_PINCH_MAX_UNITS_PER_EVENT
} from "../src/trackpad-pinch.js";

// IMPORTED FROM THE SOURCE OF TRUTH, never retyped. A constant a test declares
// for itself can only confirm what the test already believes: retyped copies
// stay green while the module is wrong.
import { APP_STATE_INSIDE_SPHERE, APP_STATE_TUNNEL } from "../src/xr-hand-gestures.js";
import { AppState } from "../src/constants.js";

function createDriver({ appState = APP_STATE_INSIDE_SPHERE, enabled = true, startMs = 5_000 } = {}) {
  const driver = { now: startMs, state: createTrackpadPinchState(), appState, enabled };
  driver.wheel = (deltaY, { ctrlKey = true } = {}) => {
    const applied = applyTrackpadWheelEvent(driver.state, {
      deltaY,
      ctrlKey,
      nowMs: driver.now,
      enabled: driver.enabled,
      appState: driver.appState
    });
    driver.state = applied.state;
    return applied.handled;
  };
  driver.step = (advanceMs = 16) => {
    driver.now += advanceMs;
    const stepped = stepTrackpadPinch(driver.state, { nowMs: driver.now });
    driver.state = stepped.state;
    return stepped.decision;
  };
  return driver;
}

test("a pinch open engages once and reports travel toward zoom-in", () => {
  const d = createDriver();
  d.wheel(-20);
  const first = d.step();
  assert.equal(first.distance.active, true);
  assert.equal(first.distance.justEngaged, true, "engage reaches the applier with the first travel");
  assert.equal(first.distance.target, "sphereZoom");
  // deltaY negative = fingers apart = the same sign hands apart produce.
  assert.ok(first.distance.deltaM > 0, "fingers apart must be a positive delta, as for hands");

  d.wheel(-20);
  const second = d.step();
  assert.equal(second.distance.justEngaged, false, "justEngaged fires exactly once per stroke");
  assert.ok(
    Math.abs(second.distance.deltaM - 40 * TRACKPAD_PINCH_METERS_PER_WHEEL_UNIT) < 1e-9,
    "the stroke accumulates, it does not report per-event increments"
  );
});

test("a pinch closed is the opposite sign", () => {
  const d = createDriver();
  d.wheel(30);
  const decision = d.step();
  assert.ok(decision.distance.deltaM < 0);
});

test("in the tunnel the same pinch drives speed, not zoom", () => {
  const d = createDriver({ appState: APP_STATE_TUNNEL });
  d.wheel(-20);
  assert.equal(d.step().distance.target, "tunnelSpeed");
});

test("the stroke ends after the idle gap, and the next pinch starts fresh", () => {
  const d = createDriver();
  d.wheel(-40);
  // step(0) so the clock below measures the gap from the wheel event itself
  // rather than from the wheel event plus a frame.
  const engaged = d.step(0);
  assert.equal(engaged.distance.active, true);

  // Exactly one millisecond inside the gap: still the same stroke.
  const stillLive = d.step(TRACKPAD_PINCH_IDLE_MS - 1);
  assert.equal(stillLive.distance.active, true, "a burst gap must not end the stroke");

  // Two more milliseconds puts it one past: released.
  const released = d.step(2);
  assert.equal(released.distance.active, false, "the timeout is the release");

  // And the next pinch is a NEW stroke, not a continuation — otherwise the
  // applier would keep a baseline captured a gesture ago and the view would
  // jump on the first event of the second pinch.
  d.wheel(-10);
  const next = d.step();
  assert.equal(next.distance.justEngaged, true);
  assert.ok(
    Math.abs(next.distance.deltaM - 10 * TRACKPAD_PINCH_METERS_PER_WHEEL_UNIT) < 1e-9,
    "the second stroke must not inherit the first one's total"
  );
});

test("a wheel with no ctrlKey is not ours and is left to the page", () => {
  const d = createDriver();
  assert.equal(d.wheel(-40, { ctrlKey: false }), false, "not handled, so not preventDefault-ed");
  assert.equal(d.step().distance.active, false);
});

test("outside the tunnel and the sphere the event is left to the page", () => {
  // Ordinary browser page zoom on the start panel must keep working: a reader
  // enlarging the favourites grid is a legitimate thing to do.
  const d = createDriver({ appState: "START" });
  assert.equal(d.wheel(-40), false);
  assert.equal(d.step().distance.active, false);
});

test("a disabled frame (world panel up) leaves the event to the page", () => {
  const d = createDriver({ enabled: false });
  assert.equal(d.wheel(-40), false);
  assert.equal(d.step().distance.active, false);
});

test("a mouse-wheel-sized notch is clamped, not teleported", () => {
  // ctrl+wheel on a real mouse reports one large jump. Clamping keeps it usable
  // as a coarse zoom instead of throwing the view across its whole range.
  const d = createDriver();
  d.wheel(-1000);
  const decision = d.step();
  assert.ok(
    Math.abs(decision.distance.deltaM
      - TRACKPAD_PINCH_MAX_UNITS_PER_EVENT * TRACKPAD_PINCH_METERS_PER_WHEEL_UNIT) < 1e-9,
    "one event may contribute at most the per-event clamp"
  );
});

test("a stroke keeps the target it engaged with", () => {
  // Entering the sphere mid-pinch must not re-point a stroke whose baseline was
  // captured for the tunnel.
  const d = createDriver({ appState: APP_STATE_TUNNEL });
  d.wheel(-20);
  assert.equal(d.step().distance.target, "tunnelSpeed");
  d.appState = APP_STATE_INSIDE_SPHERE;
  d.wheel(-20);
  assert.equal(d.step().distance.target, "tunnelSpeed", "the live stroke keeps its target");
  // ...but the NEXT stroke picks up the new state.
  d.step(TRACKPAD_PINCH_IDLE_MS + 1);
  d.wheel(-20);
  assert.equal(d.step().distance.target, "sphereZoom");
});

test("NaN clocks and deltas cannot poison a stroke", () => {
  const d = createDriver();
  d.wheel(-20);
  const before = d.step().distance.deltaM;
  const applied = applyTrackpadWheelEvent(d.state, {
    deltaY: NaN,
    ctrlKey: true,
    nowMs: d.now,
    appState: APP_STATE_INSIDE_SPHERE
  });
  assert.equal(applied.handled, false);
  d.state = applied.state;
  assert.equal(d.step(0).distance.deltaM, before, "a NaN event changes nothing");

  const stepped = stepTrackpadPinch(d.state, { nowMs: NaN });
  assert.equal(stepped.decision.distance.active, false, "a NaN clock decides nothing");
});

test("a step with no stroke is inert", () => {
  const stepped = stepTrackpadPinch(createTrackpadPinchState(), { nowMs: 1000 });
  assert.equal(stepped.decision.distance.active, false);
  assert.equal(stepped.state.stroke, null);
});

test("the app-state strings are the ones the app actually uses", () => {
  // Regression test for the state-name constants. Every other test passes whatever
  // string it is given; only this one can notice that the string is wrong. Anchored
  // to AppState in constants.js, which is what state.appState is set from.
  assert.equal(APP_STATE_INSIDE_SPHERE, AppState.INSIDE_SPHERE);
  assert.equal(APP_STATE_TUNNEL, AppState.TUNNEL);

  // And the resolver claims the event for both of them, from the real values.
  for (const appState of [AppState.INSIDE_SPHERE, AppState.TUNNEL]) {
    const applied = applyTrackpadWheelEvent(createTrackpadPinchState(), {
      deltaY: -20,
      ctrlKey: true,
      nowMs: 1000,
      appState
    });
    assert.equal(applied.handled, true, `a pinch in ${appState} must be claimed`);
  }
  // ...and not for the states in between, where there is nothing to zoom.
  for (const appState of [AppState.TRANSITION_TO_SPHERE, AppState.EXITING_SPHERE]) {
    const applied = applyTrackpadWheelEvent(createTrackpadPinchState(), {
      deltaY: -20,
      ctrlKey: true,
      nowMs: 1000,
      appState
    });
    assert.equal(applied.handled, false, `${appState} must be left to the page`);
  }
});
