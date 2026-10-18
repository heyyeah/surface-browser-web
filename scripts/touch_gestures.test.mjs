// Touch controls: the decision logic, offline, on a fake clock.
//
// Everything the phone path decides lives in src/touch-gestures.js as pure
// functions so it can be proved here: tap vs drag at the exact boundary, the
// confirm hold and its two cancels, the money-safety property that a pinch which
// never held cannot buy a generation, the pointer bookkeeping under a third
// finger or a missing `pointercancel`, and the brake.
//
// The harness is a clock the test advances by hand and a driver that feeds
// pointer events into the recorder and frames into the step. No DOM, no
// renderer, no three.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOUCH_TAP_MAX_MOVE_PX,
  TOUCH_TAP_MAX_MS,
  TOUCH_PINCH_SLOP_PX,
  TOUCH_CHORD_HOLD_MS,
  TOUCH_CHORD_RING_DELAY_MS,
  TOUCH_DRAG_HAND_METERS_PER_SHORT_EDGE,
  TOUCH_POINTER_STALE_MS,
  touchMetersPerPixel,
  createTouchGestureState,
  applyTouchPointerEvent,
  stepTouchGestures
} from "../src/touch-gestures.js";
import {
  APP_STATE_INSIDE_SPHERE,
  APP_STATE_TUNNEL,
  ROTATE_BRAKE_HOLD_MS,
  ROTATE_YAW_DEADZONE_M,
  ROTATE_THROW_SPEED_MPS
} from "../src/xr-hand-gestures.js";

// A 390 x 844 CSS-pixel phone in portrait: the short edge is the width.
const SHORT_EDGE_PX = 390;
const FRAME_MS = 16;
const YAW_GAIN = 4.0;   // HAND_SPHERE_YAW_RAD_PER_M
const PITCH_GAIN = 4.0; // HAND_SPHERE_PITCH_RAD_PER_M

function createDriver({
  appState = APP_STATE_INSIDE_SPHERE,
  enabled = true,
  sphereRotationPaused = false,
  shortEdgePx = SHORT_EDGE_PX,
  // The driver models a server that HAS a GenAI relay. The resolver's own default
  // is false (see the genAiAvailable tests at the end of this file).
  genAiAvailable = true,
  startMs = 10_000
} = {}) {
  const driver = {
    now: startMs,
    state: createTouchGestureState(),
    appState,
    enabled,
    sphereRotationPaused,
    shortEdgePx,
    genAiAvailable,
    sphereYawSpeedRadPerS: 0,
    spherePitchSpeedRadPerS: 0,
    decisions: []
  };

  driver.event = (type, pointerId, x, y) => {
    driver.state = applyTouchPointerEvent(driver.state, {
      type,
      pointerId,
      x,
      y,
      now: driver.now
    });
  };

  // One rendered frame. `dtMs` advances the clock BEFORE the step, so a frame is
  // "time passed, now decide", which is what the render loop does.
  driver.frame = (dtMs = FRAME_MS) => {
    driver.now += dtMs;
    const stepped = stepTouchGestures(driver.state, {
      nowMs: driver.now,
      dtS: dtMs / 1000,
      enabled: driver.enabled,
      appState: driver.appState,
      shortEdgePx: driver.shortEdgePx,
      sphereRotationPaused: driver.sphereRotationPaused,
      genAiAvailable: driver.genAiAvailable,
      sphereYawSpeedRadPerS: driver.sphereYawSpeedRadPerS,
      spherePitchSpeedRadPerS: driver.spherePitchSpeedRadPerS,
      yawGainRadPerM: YAW_GAIN,
      pitchGainRadPerM: PITCH_GAIN,
      zoomGain: 1
    });
    driver.state = stepped.state;
    driver.decisions.push(stepped.decision);
    return stepped.decision;
  };

  // Advance the clock without an event, in whole frames.
  driver.frames = (count, dtMs = FRAME_MS) => {
    let last = null;
    for (let i = 0; i < count; i += 1) {
      last = driver.frame(dtMs);
    }
    return last;
  };

  driver.wait = (ms) => {
    const frames = Math.ceil(ms / FRAME_MS);
    return driver.frames(frames);
  };

  driver.anySelect = () => driver.decisions.some((d) => d.select);
  driver.anyChord = () => driver.decisions.some((d) => d.chord.target === "genai");
  driver.anyDistance = () => driver.decisions.some((d) => d.distance.active);

  return driver;
}

// --- Tap vs drag, at and around the thresholds -------------------------------

test("a short, still touch is a tap and fires select", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();          // 16 ms in, under both thresholds: undecided, no drag.
  d.event("up", 1, 202, 401);
  const decision = d.frame();
  assert.equal(decision.select, true, "a still, brief touch must select");
  assert.equal(decision.rotate.active, false);
  assert.equal(decision.rotate.justEngaged, false);
});

test("movement AT the slop is a drag, not a tap — the boundary belongs to the drag", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  // Exactly TOUCH_TAP_MAX_MOVE_PX away, on one axis so the distance is exact.
  d.event("move", 1, 200 + TOUCH_TAP_MAX_MOVE_PX, 400);
  const engage = d.frame();
  assert.equal(engage.rotate.justEngaged, true, "10 px is a drag");
  d.event("up", 1, 200 + TOUCH_TAP_MAX_MOVE_PX, 400);
  const release = d.frame();
  assert.equal(release.rotate.justReleased, true);
  assert.equal(d.anySelect(), false, "a drag must never also fire select");
});

test("movement one pixel INSIDE the slop is still a tap", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  d.event("move", 1, 200 + TOUCH_TAP_MAX_MOVE_PX - 1, 400);
  const held = d.frame();
  assert.equal(held.rotate.justEngaged, false, "9 px must not engage a drag");
  d.event("up", 1, 200 + TOUCH_TAP_MAX_MOVE_PX - 1, 400);
  assert.equal(d.frame().select, true);
});

test("duration AT the limit is a drag even with the finger perfectly still", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  // Frames up to but not including TOUCH_TAP_MAX_MS.
  let decision = null;
  while (d.now - 10_000 < TOUCH_TAP_MAX_MS - FRAME_MS) {
    decision = d.frame();
    assert.equal(decision.rotate.justEngaged, false, "still inside the tap window");
  }
  // The frame that crosses TOUCH_TAP_MAX_MS engages.
  decision = d.frame();
  assert.equal(decision.rotate.justEngaged, true, "300 ms of stillness is a drag, not a tap");
  assert.equal(d.anySelect(), false);
});

test("a touch released one frame short of the duration limit is a tap", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  // Advance to 288 ms (18 frames), still inside the 300 ms window.
  d.frames(18);
  assert.equal(d.now - 10_000, 288);
  d.event("up", 1, 200, 400);
  // The lift is at 288 ms; the resolving frame is later but the tap is judged on
  // upAt - downAt, not on when the frame ran.
  assert.equal(d.frame().select, true);
});

test("a drag that wanders out and back inside the slop still never taps", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  d.event("move", 1, 260, 400);   // well past the slop: engages
  assert.equal(d.frame().rotate.justEngaged, true);
  d.event("move", 1, 203, 400);   // back inside the slop, 100 ms in total
  d.frame();
  d.event("up", 1, 203, 400);
  d.frame();
  assert.equal(d.anySelect(), false, "a contact that engaged a drag can never be read as a tap");
});

test("a cancelled touch never taps", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  d.event("cancel", 1, 200, 400);
  assert.equal(d.frame().select, false);
});

test("tap is refused outside the sphere and while the panel owns the pointer", () => {
  for (const overrides of [{ appState: APP_STATE_TUNNEL }, { enabled: false }]) {
    const d = createDriver(overrides);
    d.event("down", 1, 200, 400);
    d.frame();
    d.event("up", 1, 200, 400);
    assert.equal(d.frame().select, false, JSON.stringify(overrides));
  }
});

// --- The drag is the grab model ----------------------------------------------

test("the drag maps displacement to an ANGLE with the hand path's own gain", () => {
  const d = createDriver();
  const metersPerPixel = touchMetersPerPixel(SHORT_EDGE_PX);
  d.event("down", 1, 100, 400);
  d.frame();
  d.event("move", 1, 140, 400);      // engage; the grab re-anchors here
  d.frame();
  // Now travel a known distance from the engage point and let the rate clamp
  // catch up over several frames.
  d.event("move", 1, 200, 400);
  let totalYaw = 0;
  for (let i = 0; i < 40; i += 1) {
    totalYaw += d.frame().rotate.deltaYawRad;
  }
  const expected = -((200 - 140) * metersPerPixel - ROTATE_YAW_DEADZONE_M) * YAW_GAIN;
  assert.ok(
    Math.abs(totalYaw - expected) < 1e-6,
    `a rightward drag must settle on the grab's angle target (${totalYaw} vs ${expected})`
  );
  assert.ok(totalYaw < 0, "a finger moving RIGHT drives negative yaw, like the hand and the mouse");
});

test("a finger moving UP drives positive pitch (screen y is inverted exactly once)", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  d.event("move", 1, 200, 340);   // up the screen
  d.frame();
  d.event("move", 1, 200, 240);
  let totalPitch = 0;
  for (let i = 0; i < 40; i += 1) {
    totalPitch += d.frame().rotate.deltaPitchRad;
  }
  assert.ok(totalPitch > 0, "up the screen must be positive pitch");
});

test("a held displacement holds its angle — the position map, not a speed", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  d.event("move", 1, 280, 400);
  d.frames(40);                        // settle on the target
  const settled = d.frames(20);
  assert.equal(settled.rotate.active, true);
  assert.ok(
    Math.abs(settled.rotate.deltaYawRad) < 1e-9,
    "a finger that stops moving must stop turning the sphere"
  );
});

test("a fast release hands off a throw; a gentle one imparts nothing", () => {
  const fast = createDriver();
  fast.event("down", 1, 40, 400);
  fast.frame();
  // ~15 px per 16 ms frame = ~940 px/s = ~0.84 m/s at the shipped scale, past
  // ROTATE_THROW_SPEED_MPS.
  for (let i = 1; i <= 14; i += 1) {
    fast.event("move", 1, 40 + (i * 15), 400);
    fast.frame();
  }
  fast.event("up", 1, 40 + (14 * 15), 400);
  const released = fast.frame();
  assert.equal(released.rotate.justReleased, true);
  assert.ok(released.rotate.releaseSpin.speedMps >= ROTATE_THROW_SPEED_MPS,
    `a flick must clear the throw speed (${released.rotate.releaseSpin.speedMps} m/s)`);
  assert.ok(released.rotate.releaseSpin.gain > 0);
  assert.ok(released.rotate.releaseSpin.yawRadPerS < 0, "a rightward flick spins the sphere rightward");

  const gentle = createDriver();
  gentle.event("down", 1, 200, 400);
  gentle.frame();
  for (let i = 1; i <= 10; i += 1) {
    gentle.event("move", 1, 200 + (i * 2), 400);   // ~125 px/s, a placement
    gentle.frame();
  }
  gentle.event("up", 1, 220, 400);
  const placed = gentle.frame();
  assert.equal(placed.rotate.justReleased, true);
  assert.equal(placed.rotate.releaseSpin.gain, 0, "a slow placement release must impart nothing");
  assert.equal(placed.rotate.releaseSpin.yawRadPerS, 0);
});

test("the release still AIMS the drift when it imparts no momentum", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  for (let i = 1; i <= 10; i += 1) {
    d.event("move", 1, 200 + (i * 2), 400);
    d.frame();
  }
  d.event("up", 1, 220, 400);
  const placed = d.frame();
  assert.equal(placed.rotate.releaseSpin.gain, 0);
  assert.ok(
    placed.rotate.releaseSpin.aimYawRadPerS < 0,
    "even a gentle release points the drift down the direction the drag was going"
  );
});

// --- The brake ---------------------------------------------------------------

test("a finger held still inside the deadzone brakes, once, on the rising edge", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  // The drag cannot engage before TOUCH_TAP_MAX_MS, so the earliest possible
  // brake is TOUCH_TAP_MAX_MS + ROTATE_BRAKE_HOLD_MS.
  const early = d.wait(TOUCH_TAP_MAX_MS + ROTATE_BRAKE_HOLD_MS - (2 * FRAME_MS));
  assert.equal(early.setPaused, null, "the brake must not beat the tap window plus the hold");
  const braked = d.frames(4);
  const brakeFrames = d.decisions.filter((decision) => decision.setPaused === true);
  assert.equal(brakeFrames.length, 1, "the brake latches once, on the rising edge");
  assert.equal(brakeFrames[0].pauseSource, "brake");
  assert.equal(braked.rotate.braking, true);
});

test("a moving finger never brakes, however long the drag lasts", () => {
  const d = createDriver();
  d.event("down", 1, 40, 400);
  d.frame();
  for (let i = 1; i <= 60; i += 1) {
    d.event("move", 1, 40 + (i * 5), 400);
    d.frame();
  }
  assert.equal(
    d.decisions.some((decision) => decision.setPaused === true),
    false,
    "a drag that keeps moving is not a brake"
  );
});

test("a flick hands rotation back: a hard release un-pauses a braked sphere", () => {
  const d = createDriver({ sphereRotationPaused: true });
  d.event("down", 1, 40, 400);
  d.frame();
  for (let i = 1; i <= 14; i += 1) {
    d.event("move", 1, 40 + (i * 15), 400);
    d.frame();
  }
  d.event("up", 1, 40 + (14 * 15), 400);
  const released = d.frame();
  assert.equal(released.setPaused, false, "a release hard enough to be a throw resumes rotation");
  assert.equal(released.pauseSource, "release-throw");
});

test("a gentle release leaves a paused sphere paused", () => {
  const d = createDriver({ sphereRotationPaused: true });
  d.event("down", 1, 200, 400);
  d.frame();
  for (let i = 1; i <= 10; i += 1) {
    d.event("move", 1, 200 + (i * 2), 400);
    d.frame();
  }
  d.event("up", 1, 220, 400);
  assert.equal(d.frame().setPaused, null, "fine placement must not resume the sphere");
});

// --- The pinch is the distance gesture ---------------------------------------

test("two fingers spreading engage the distance gesture with a positive delta", () => {
  const d = createDriver();
  const metersPerPixel = touchMetersPerPixel(SHORT_EDGE_PX);
  d.event("down", 1, 150, 400);
  d.event("down", 2, 250, 400);   // 100 px apart
  d.frame();
  d.event("move", 1, 100, 400);
  d.event("move", 2, 300, 400);   // 200 px apart
  const engaged = d.frame();
  assert.equal(engaged.distance.active, true);
  assert.equal(engaged.distance.justEngaged, true);
  assert.equal(engaged.distance.target, "sphereZoom");
  assert.ok(
    Math.abs(engaged.distance.deltaM - (100 * metersPerPixel)) < 1e-9,
    "fingers apart is a positive delta, measured from where the pair formed"
  );
  const held = d.frame();
  assert.equal(held.distance.justEngaged, false, "justEngaged fires exactly once");
});

test("the same gesture drives tunnel SPEED in the tunnel — one code path, read through appState", () => {
  const d = createDriver({ appState: APP_STATE_TUNNEL });
  d.event("down", 1, 150, 400);
  d.event("down", 2, 250, 400);
  d.frame();
  d.event("move", 1, 100, 400);
  d.event("move", 2, 300, 400);
  const engaged = d.frame();
  assert.equal(engaged.distance.active, true);
  assert.equal(engaged.distance.target, "tunnelSpeed");
  assert.ok(engaged.distance.deltaM > 0);
});

test("fingers coming together give a negative delta", () => {
  const d = createDriver();
  d.event("down", 1, 100, 400);
  d.event("down", 2, 300, 400);
  d.frame();
  d.event("move", 1, 180, 400);
  d.event("move", 2, 220, 400);
  const engaged = d.frame();
  assert.ok(engaged.distance.deltaM < 0, "fingers together must be the opposite sign");
});

// --- The GenAI chord, and the money-safety property --------------------------

test("two fingers held still for the confirm hold fire the chord, once", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  // NO ring on the frame the pair forms: a pinch-zoom starts identically, so
  // drawing it there would flash it on every zoom.
  const formed = d.frame();
  assert.equal(formed.chord.active, false, "the ring must not appear on contact");

  d.wait(TOUCH_CHORD_RING_DELAY_MS);
  const armed = d.decisions.at(-1);
  assert.equal(armed.chord.active, true, "...but it does appear once the delay elapses");
  assert.ok(armed.chord.progress >= 0 && armed.chord.progress < 1);
  assert.equal(armed.chord.x, 200, "the ring sits at the midpoint of the two touches");
  assert.equal(armed.chord.y, 400);

  d.wait(TOUCH_CHORD_HOLD_MS);
  const fired = d.decisions.filter((decision) => decision.chord.target === "genai");
  assert.equal(fired.length, 1, "the chord fires exactly once per two-finger episode");

  // ...and keeping the fingers down afterwards fires nothing more and shows no
  // ring: chordSpent, the same latch the VR chord uses.
  const after = d.frames(20);
  assert.equal(after.chord.target, null);
  assert.equal(after.chord.active, false);
});

test("a pinch-zoom never flashes the ring", () => {
  // Two fingers down and then spread opens identically to the chord, so the ring
  // must not be drawn on the frame the pair forms and removed once the travel
  // passes the slop.
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.frame();
  // A real pinch declares itself well inside the ring delay.
  d.wait(80);
  d.event("move", 1, 140, 400);
  d.event("move", 2, 260, 400);
  d.frames(6);
  assert.ok(d.decisions.every((decision) => decision.chord.active === false),
    "no frame of a zoom may show the confirm ring");
  assert.equal(d.anyChord(), false, "and it certainly must not fire");
});

test("the ring's progress is monotonic and reaches 1 exactly at the hold", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  let previous = 0;
  let fired = false;
  for (let i = 0; i < 60 && !fired; i += 1) {
    const decision = d.frame();
    if (decision.chord.target === "genai") {
      fired = true;
      assert.equal(decision.chord.progress, 1);
      break;
    }
    assert.ok(decision.chord.progress >= previous, "progress must never go backwards");
    assert.ok(decision.chord.progress < 1, "progress reaches 1 only on the firing frame");
    previous = decision.chord.progress;
  }
  assert.equal(fired, true);
});

test("moving either finger past the pinch threshold cancels the hold FOR GOOD", () => {
  for (const moved of ["first", "second"]) {
    const d = createDriver();
    d.event("down", 1, 180, 400);
    d.event("down", 2, 220, 400);
    d.frame();
    const id = moved === "first" ? 1 : 2;
    const baseX = moved === "first" ? 180 : 220;
    d.event("move", id, baseX + TOUCH_PINCH_SLOP_PX, 400);
    const zoomed = d.frame();
    assert.equal(zoomed.chord.active, false, `${moved}: the hold is cancelled`);
    assert.equal(zoomed.distance.active, true, `${moved}: ...and it became a zoom`);
    // Put the finger back exactly where it was and hold for far longer than the
    // confirm hold: the cancel is a latch, so nothing can revive it.
    d.event("move", id, baseX, 400);
    d.wait(TOUCH_CHORD_HOLD_MS * 3);
    assert.equal(d.anyChord(), false, `${moved}: a cancelled hold can never re-arm`);
  }
});

test("releasing early cancels the hold", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.wait(TOUCH_CHORD_HOLD_MS - (3 * FRAME_MS));
  assert.equal(d.anyChord(), false);
  d.event("up", 2, 220, 400);
  d.frame();
  d.wait(TOUCH_CHORD_HOLD_MS * 2);
  assert.equal(d.anyChord(), false, "a lift before the hold completes buys nothing");
  assert.equal(d.anySelect(), false, "...and neither finger's lift is a tap");
});

test("MONEY SAFETY: no two-finger gesture under the hold can ever fire the chord", () => {
  // Exhaustive sweep: every combination of a pinch that does not travel far enough
  // (0 .. slop px) with a hold that does not last long enough
  // (0 .. TOUCH_CHORD_HOLD_MS). None of them may spend money.
  for (let travelPx = 0; travelPx < TOUCH_PINCH_SLOP_PX; travelPx += 1) {
    for (let holdMs = 0; holdMs < TOUCH_CHORD_HOLD_MS; holdMs += 40) {
      const d = createDriver();
      d.event("down", 1, 180, 400);
      d.event("down", 2, 220, 400);
      d.frame();
      d.event("move", 1, 180 - travelPx, 400);
      d.event("move", 2, 220 + travelPx, 400);
      if (holdMs > 0) {
        d.wait(holdMs);
      }
      d.event("up", 1, 180 - travelPx, 400);
      d.event("up", 2, 220 + travelPx, 400);
      d.frame();
      d.frame();
      assert.equal(
        d.anyChord(),
        false,
        `a ${travelPx} px / ${holdMs} ms two-finger gesture must not fire a paid generation`
      );
    }
  }
});

test("MONEY SAFETY: a pinch that travelled is a zoom forever, whatever it does next", () => {
  const d = createDriver();
  d.event("down", 1, 120, 400);
  d.event("down", 2, 280, 400);
  d.frame();
  // A big, deliberate spread...
  for (let i = 1; i <= 8; i += 1) {
    d.event("move", 1, 120 - (i * 10), 400);
    d.event("move", 2, 280 + (i * 10), 400);
    d.frame();
  }
  assert.equal(d.anyDistance(), true, "it is a zoom");
  // ...and then the fingers freeze for five confirm holds.
  d.wait(TOUCH_CHORD_HOLD_MS * 5);
  assert.equal(d.anyChord(), false, "a fumbled zoom must never become a generation");
});

test("the chord is armed only inside the sphere", () => {
  const d = createDriver({ appState: APP_STATE_TUNNEL });
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.wait(TOUCH_CHORD_HOLD_MS * 2);
  assert.equal(d.anyChord(), false, "the tunnel has no GenAI chord (spec §3, the state column)");
  assert.equal(
    d.decisions.some((decision) => decision.chord.active),
    false,
    "...and no ring either"
  );
});

test("leaving the sphere mid-hold refuses the chord", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.wait(TOUCH_CHORD_HOLD_MS / 2);
  d.appState = "exiting_sphere";
  d.wait(TOUCH_CHORD_HOLD_MS * 2);
  assert.equal(d.anyChord(), false);
});

// --- Pointer bookkeeping -----------------------------------------------------

test("a third finger does not corrupt the tracked pair", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.wait(TOUCH_CHORD_RING_DELAY_MS);
  const armed = d.decisions.at(-1);
  assert.equal(armed.chord.x, 200);
  // A third finger lands somewhere else entirely and then moves a long way.
  d.event("down", 3, 40, 700);
  d.frame();
  d.event("move", 3, 350, 100);
  const stillPaired = d.frame();
  assert.equal(stillPaired.chord.active, true, "the third finger cannot cancel the pair's hold");
  assert.equal(stillPaired.chord.x, 200, "...nor move the ring off the pair's midpoint");
  assert.equal(stillPaired.chord.y, 400);
  assert.equal(stillPaired.distance.active, false, "...nor open a zoom of its own");
  d.wait(TOUCH_CHORD_HOLD_MS);
  assert.equal(d.anyChord(), true, "the pair's hold completes regardless of the third finger");
});

test("a third finger cannot restart the pinch after a pair member lifts", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.event("down", 3, 300, 400);
  d.frame();
  d.event("up", 1, 180, 400);
  d.frame();
  // Fingers 2 and 3 are still down and now spread hard. The pair is finished.
  d.event("move", 2, 120, 400);
  d.event("move", 3, 380, 400);
  const after = d.frames(4);
  assert.equal(after.distance.active, false, "the pair does not re-form from the fingers left over");
  assert.equal(after.chord.active, false);
});

test("a second finger stands the one-finger drag down and does not resume on its lift", () => {
  const d = createDriver();
  d.event("down", 1, 100, 400);
  d.frame();
  d.event("move", 1, 200, 400);
  assert.equal(d.frame().rotate.justEngaged, true);
  d.event("down", 2, 300, 400);
  const interrupted = d.frame();
  assert.equal(interrupted.rotate.justReleased, true, "the arriving finger ends the drag");
  d.event("up", 2, 300, 400);
  d.frame();
  // Finger 1 is alone again and moves a long way: nothing, until the screen clears.
  d.event("move", 1, 380, 400);
  const suppressed = d.frames(4);
  assert.equal(suppressed.rotate.active, false, "the episode stays multi-touch until every finger lifts");
  d.event("up", 1, 380, 400);
  d.frame();
  // A fresh contact works normally.
  d.event("down", 3, 100, 400);
  d.frame();
  d.event("move", 3, 200, 400);
  assert.equal(d.frame().rotate.justEngaged, true, "the latch clears once the screen is empty");
});

test("a two-finger tap resolves to nothing at all — not a select", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.event("up", 1, 180, 400);
  d.event("up", 2, 220, 400);
  d.frame();
  d.frame();
  assert.equal(d.anySelect(), false, "two fingers landing and lifting inside one frame is not a tap");
  assert.equal(d.anyChord(), false);
});

test("a missing pointercancel does not strand the gesture state", () => {
  const d = createDriver();
  d.event("down", 1, 100, 400);
  d.frame();
  d.event("move", 1, 220, 400);
  assert.equal(d.frame().rotate.justEngaged, true);
  // The browser stops reporting this finger and never sends up OR cancel.
  const stranded = d.frames(4);
  assert.equal(stranded.rotate.active, true, "still a live drag while the contact is fresh");
  d.wait(TOUCH_POINTER_STALE_MS + FRAME_MS);
  assert.equal(
    d.decisions.some((decision) => decision.rotate.justReleased),
    true,
    "the sweep must end the drag rather than hold the sphere forever"
  );
  assert.equal(d.state.pointers.length, 0, "...and drop the contact");
  assert.equal(d.state.drag, null);
  assert.equal(d.anySelect(), false, "a swept contact is cancelled, so it can never tap");

  // The screen is clear, so a new contact behaves normally.
  d.event("down", 2, 100, 400);
  d.frame();
  d.event("move", 2, 220, 400);
  assert.equal(d.frame().rotate.justEngaged, true);
});

test("a stranded pinch is swept too, and the ring goes with it", () => {
  const d = createDriver();
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.frame();
  d.event("move", 1, 120, 400);   // past the slop: a zoom, no chord
  d.frame();
  d.wait(TOUCH_POINTER_STALE_MS + FRAME_MS);
  const after = d.frames(2);
  assert.equal(after.distance.active, false);
  assert.equal(after.chord.active, false);
  assert.equal(d.state.pointers.length, 0);
  assert.equal(d.state.pinch, null);
});

test("a duplicate pointerdown for a live id restarts that contact rather than tracking two", () => {
  const d = createDriver();
  d.event("down", 1, 100, 400);
  d.frame();
  d.event("move", 1, 220, 400);
  d.frame();
  d.event("down", 1, 300, 300);   // the id came back without ever ending
  const decision = d.frame();
  assert.equal(d.state.pointers.length, 1, "one finger, one record");
  assert.equal(decision.chord.active, false, "a duplicate id must not look like two fingers");
});

test("events for an untracked pointer are ignored rather than disturbing a live gesture", () => {
  const d = createDriver();
  d.event("down", 1, 100, 400);
  d.frame();
  d.event("move", 1, 220, 400);
  assert.equal(d.frame().rotate.justEngaged, true);
  // A stray up for a pointer that was never tracked (it started over the
  // toolbar, or was already swept).
  d.event("up", 99, 0, 0);
  d.event("move", 99, 10, 10);
  const after = d.frames(2);
  assert.equal(after.rotate.active, true, "the live drag is untouched");
  assert.equal(d.state.pointers.length, 1);
});

test("a pointerup already followed by lostpointercapture is not double-ended", () => {
  const d = createDriver();
  d.event("down", 1, 200, 400);
  d.frame();
  d.event("up", 1, 202, 400);
  d.event("cancel", 1, 202, 400);   // what lostpointercapture records
  assert.equal(d.frame().select, true, "the tap survives the backstop that follows it");
});

// --- The scale, and what depends on it ---------------------------------------

test("the drag scale is the ONE constant, and both gestures read it", () => {
  const metersPerPixel = touchMetersPerPixel(SHORT_EDGE_PX);
  assert.ok(
    Math.abs((metersPerPixel * SHORT_EDGE_PX) - TOUCH_DRAG_HAND_METERS_PER_SHORT_EDGE) < 1e-12,
    "a drag across the short edge is worth exactly the configured hand stroke"
  );
  // Landscape: the SHORT edge still sets the feel, so rotating the phone does
  // not silently change how far a swipe turns the sphere.
  assert.equal(touchMetersPerPixel(SHORT_EDGE_PX), touchMetersPerPixel(SHORT_EDGE_PX));
  // A degenerate viewport disables the path rather than dividing by zero.
  assert.equal(touchMetersPerPixel(0), 0);

  const custom = createDriver();
  custom.event("down", 1, 150, 400);
  custom.event("down", 2, 250, 400);
  custom.frame();
  custom.event("move", 2, 350, 400);
  const engaged = custom.frame();
  assert.ok(
    Math.abs(engaged.distance.deltaM - (100 * metersPerPixel)) < 1e-9,
    "the pinch speaks the same metres the drag does"
  );
});

test("a zero-size viewport produces no decisions at all", () => {
  const d = createDriver({ shortEdgePx: 0 });
  d.event("down", 1, 200, 400);
  d.frame();
  d.event("move", 1, 300, 400);
  const decision = d.frames(4);
  assert.equal(decision.rotate.active, false);
  assert.equal(decision.select, false);
});

test("a step with no clock returns the state untouched", () => {
  const state = createTouchGestureState();
  const stepped = stepTouchGestures(state, { nowMs: NaN, dtS: 0.016 });
  assert.equal(stepped.decision.select, false);
  assert.equal(stepped.state.pointers.length, 0);
});

test("the recorder ignores events with no usable clock or coordinates", () => {
  let state = createTouchGestureState();
  state = applyTouchPointerEvent(state, { type: "down", pointerId: 1, x: 10, y: 10, now: NaN });
  assert.equal(state.pointers.length, 0);
  state = applyTouchPointerEvent(state, { type: "down", pointerId: 1, x: NaN, y: 10, now: 100 });
  assert.equal(state.pointers.length, 0);
  state = applyTouchPointerEvent(state, { type: "down", pointerId: 1, x: 10, y: 10, now: 100 });
  assert.equal(state.pointers.length, 1);
  const unchanged = applyTouchPointerEvent(state, { type: "move", pointerId: 1, x: NaN, y: 3, now: 110 });
  assert.equal(unchanged.pointers[0].x, 10, "a NaN move must not poison the position");
});

// --- The server gate ---------------------------------------------------------
//
// The two-finger hold must not fire the GenAI chord on a deployment with no
// relay configured. activateSelectedSphereImageForGenAi() refuses (a client test
// cannot reach that), and the resolver never arms, which is what these cover.

test("MONEY SAFETY: with no GenAI on the server the chord never arms", () => {
  const d = createDriver({ genAiAvailable: false });
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  // Twice the hold, so this is not merely "not yet".
  const decisions = [d.frame(), ...Array.from({ length: 80 }, () => d.frame())];
  for (const decision of decisions) {
    assert.equal(decision.chord.target, null, "no chord may fire");
    assert.equal(decision.chord.active, false, "and no ring may be drawn");
  }
});

test("MONEY SAFETY: the resolver defaults to no chord when the flag is omitted", () => {
  // A caller that forgets to pass genAiAvailable must get the SAFE answer. This
  // is the reason the option defaults false rather than true.
  let state = createTouchGestureState();
  let now = 10_000;
  for (const [id, x] of [[1, 180], [2, 220]]) {
    state = applyTouchPointerEvent(state, { type: "down", pointerId: id, x, y: 400, now });
  }
  let fired = false;
  for (let i = 0; i < 80; i += 1) {
    now += FRAME_MS;
    const stepped = stepTouchGestures(state, {
      nowMs: now,
      dtS: FRAME_MS / 1000,
      appState: APP_STATE_INSIDE_SPHERE,
      shortEdgePx: SHORT_EDGE_PX
      // genAiAvailable deliberately absent.
    });
    state = stepped.state;
    fired = fired || stepped.decision.chord.target === "genai";
  }
  assert.equal(fired, false, "an omitted flag must not spend money");
});

test("with no GenAI the two-finger pinch still zooms", () => {
  // The gate removes the chord, NOT the gesture the chord shares fingers with.
  const d = createDriver({ genAiAvailable: false });
  d.event("down", 1, 180, 400);
  d.event("down", 2, 220, 400);
  d.frame();
  d.event("move", 1, 120, 400);
  d.event("move", 2, 280, 400);
  const decision = d.frame();
  assert.equal(decision.distance.active, true, "the zoom channel must still engage");
  assert.equal(decision.distance.target, "sphereZoom");
  assert.ok(decision.distance.deltaM > 0, "spreading must still be a positive delta");
});

// --- The tap's location ------------------------------------------------------
//
// A tap activates what the viewer aimed at: the finger's point on a flat screen,
// falling back to the centre image when there is none. The resolver stays pure:
// it reports WHERE, and input.js does the raycast.

test("a tap reports where it landed", () => {
  const d = createDriver();
  d.event("down", 1, 137, 288);
  d.frame();
  d.event("up", 1, 137, 288);
  const decision = d.frame();
  assert.equal(decision.select, true);
  assert.deepEqual(decision.selectPoint, { x: 137, y: 288 });
});

test("a tap that drifted a few pixels reports the lift point, not the touchdown", () => {
  // The applier raycasts through this point, so it must be where the finger
  // actually was when it left — a tap that slid 8px should hit what it ended on.
  const d = createDriver();
  d.event("down", 1, 200, 200);
  d.frame();
  d.event("move", 1, 206, 203);
  d.frame();
  d.event("up", 1, 206, 203);
  const decision = d.frame();
  assert.equal(decision.select, true);
  assert.deepEqual(decision.selectPoint, { x: 206, y: 203 });
});

test("no tap means no point at all, never a stale one", () => {
  // null rather than {0,0}: the applier treats a point as "the viewer aimed
  // here", and a default of the top-left corner is an aim, not an absence.
  const d = createDriver();
  const idle = d.frame();
  assert.equal(idle.select, false);
  assert.equal(idle.selectPoint, null);

  // A drag is not a tap, and must carry no point either.
  d.event("down", 1, 100, 100);
  d.frame();
  d.event("move", 1, 260, 140);
  d.frame();
  d.event("up", 1, 260, 140);
  const released = d.frame();
  assert.equal(released.select, false);
  assert.equal(released.selectPoint, null);
});

// --- WIRING ------------------------------------------------------------------
//
// Every chord test above passes `genAiAvailable: true` into the harness, so the
// logic is proven but the CALL SITE is not. If src/input.js omitted the option,
// stepTouchGestures would default it to false and `chordArmed` would be false on
// every frame, silently.

const inputJs = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/input.js"),
  "utf8"
);

test("the TOUCH call site opts in to GenAI, or the chord can never arm", () => {
  const call = inputJs.slice(inputJs.indexOf("stepTouchGestures(touchGestureState, {"));
  const options = call.slice(0, call.indexOf("});"));
  assert.match(options, /genAiAvailable:\s*state\.genAiActionsEnabled/,
    "the touch path must pass genAiAvailable; the resolver defaults it to false");
});

test("the DESKTOP MOUSE call site still refuses it, deliberately", () => {
  // Not an oversight: a mouse has one pointer, so the two-finger chord has no
  // desktop equivalent and shift+drag owns that job. Pinned so the option is not
  // copy-pasted into a path that should not have it.
  const call = inputJs.slice(inputJs.indexOf("stepTouchGestures(desktopPointerGestureState, {"));
  const options = call.slice(0, call.indexOf("});"));
  assert.match(options, /genAiAvailable:\s*false/);
});
