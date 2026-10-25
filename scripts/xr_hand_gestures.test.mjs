// Direct-manipulation hand gestures (offline). Covers the parts a device pass
// cannot prove by hand: that a lone select-hand pinch selects IMMEDIATELY however
// many hands are up, that the GenAI chord is ORDERED (rotate pinch first) and
// bills nobody for a chord that was the start of something else, that the rotate
// drag moves both axes, that the stop signal outranks the distance gesture they
// both engage from, that the no-pinch distance gesture engages on RELATIVE change
// from a leaky-extremum baseline and lets go through a release grace, that the
// engage deadband is removed so the control does not jump, and that a palm-up
// pose refuses the drag. Same split as wrist_poke.test.mjs /
// xr_microgestures.test.mjs: reading the XR frame itself lives in src/input.js.
//
// The rotate drag is a GRAB: hand displacement names an ANGLE, not a speed. The
// older velocity model survives behind `?drag=vel`, and everything testing it is
// marked `legacy ?drag=vel`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_STATE_TUNNEL,
  APP_STATE_INSIDE_SPHERE,
  PINCH_DEBOUNCE_MS,
  GENAI_CONFIRM_HOLD_MS,
  DISTANCE_ENGAGE_REL,
  DISTANCE_RELEASE_REL,
  DISTANCE_EXTREMUM_LEAK_S,
  DISTANCE_RELEASE_GRACE_MS,
  DISTANCE_TRACKING_SETTLE_MS,
  HAND_DROPOUT_GRACE_MS,
  CHORD_LEAD_MS,
  MAX_GESTURE_STEP_MS,
  PINCH_DEBOUNCE_MIN_SAMPLES,
  minWindowSamples,
  medianOf,
  createFrameClock,
  stepFrameClock,
  createGracedWindow,
  stepGracedWindow,
  DISTANCE_COMMIT_MS,
  DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE,
  DISTANCE_VIEW_NDC_MARGIN_Y_BELOW,
  DISTANCE_MIN_SEPARATION_M,
  DISTANCE_POSE_LEVEL_M,
  DISTANCE_POSE_LEVEL_RELEASE_M,
  DISTANCE_POSE_EYE_BELOW_M,
  DISTANCE_POSE_EYE_BELOW_RELEASE_M,
  DISTANCE_POSE_FORWARD_M,
  DISTANCE_POSE_RELEASE_MS,
  DISTANCE_POSE_DIAG_INTERVAL_MS,
  distancePoseCheck,
  ROTATE_YAW_DEADZONE_M,
  ROTATE_YAW_FULL_DEFLECTION_M,
  ROTATE_PITCH_DEADZONE_M,
  ROTATE_PITCH_FULL_DEFLECTION_M,
  ROTATE_RESPONSE_EXPONENT,
  ROTATE_BRAKE_HOLD_MS,
  ROTATE_THROW_SPEED_MPS,
  ROTATE_THROW_MIN_TRAVEL_M,
  ROTATE_THROW_SPIN_GAIN_RAD_PER_MPS,
  ROTATE_THROW_SPIN_MAX_RAD_PER_S,
  HAND_GRAB_MAX_RATE_RAD_PER_S,
  ROTATE_RELEASE_VEL_SMOOTH_PER_S,
  ROTATE_RELEASE_MIN_MPS,
  ROTATE_RELEASE_RAMP_MPS,
  ROTATE_RELEASE_MAX_RAD_PER_S,
  ROTATE_RELEASE_DEBOUNCE_MS,
  GRAB_DROPOUT_EXTRAPOLATE_TAU_S,
  DRIFT_RESUME_DELAY_S,
  DRIFT_RESUME_SECONDS,
  SPHERE_COAST_TAU_STICK_S,
  SPHERE_COAST_TAU_HAND_THROW_S,
  stepCoastSpeed,
  ROTATE_BRAKE_CENTER_GATE,
  ROTATE_BRAKE_CENTER_MAX_NDC_R,
  handWithinNdcRadius,
  stepDriftResume,
  SPHERE_MANUAL_LAYER_COUPLING,
  sphereLayerSpreadMultiplier,
  manualLayerDifferential,
  createGrabState,
  stepGrabDisplacement,
  grabAngleTarget,
  stepGrabAngle,
  stepReleaseVelocity,
  releaseHandoff,
  PALM_AWAY_MIN_COS,
  STOP_POSE_STABILITY_MS,
  STOP_RELEASE_DROP_M,
  STOP_RELEASE_STABILITY_MS,
  STOP_RELEASE_TRACKING_GRACE_MS,
  stopHandExit,
  stepHandDragSpeed,
  driftDirectionAfterRotation,
  HAND_DRAG_SPEED_RESPONSE_PER_S,
  reanchorBaselineAfterClamp,
  relativeDeviation,
  horizontalSeparationM,
  isPalmFacingUp,
  isPalmFacingAway,
  rotateDeflection,
  rotateYawDeflection,
  rotatePitchDeflection,
  handWithinViewport,
  createDistanceState,
  updateDistanceGesture,
  createDistanceIntentState,
  updateDistanceIntent,
  DISTANCE_INTENT_MIN_RATE_MPS,
  DISTANCE_INTENT_STALE_MS,
  DISTANCE_TRACK_SLOT_MS,
  DISTANCE_TRACK_WINDOW_MS,
  DISTANCE_PATH_ENGAGE_RATIO,
  DISTANCE_PATH_REVERSE_RATIO,
  DISTANCE_LOWERING_DROP_M,
  DISTANCE_REARM_MS,
  DISTANCE_REARM_STILL_MS,
  DISTANCE_LOWERING_STEADY_M,
  DISTANCE_REVERSAL_GUARD_MS,
  createDistanceTrack,
  stepDistanceTrack,
  stepDistanceExtremum,
  distanceBaselineFor,
  noteDistanceStrokeEnd,
  distanceRefusalGate,
  createHandGestureState,
  resolveHandGestures
} from "../src/xr-hand-gestures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// constants.js imports three, so it is read as SOURCE rather than imported; the
// rig needs the two position gains.
const CONSTANTS_TEXT = fs.readFileSync(path.join(HERE, "..", "src", "constants.js"), "utf8");
const constantNumber = (name) => Number(
  new RegExp(`export const ${name} = (-?[\\d.]+);`).exec(CONSTANTS_TEXT)[1]
);
const YAW_RAD_PER_M = constantNumber("HAND_SPHERE_YAW_RAD_PER_M");
const PITCH_RAD_PER_M = constantNumber("HAND_SPHERE_PITCH_RAD_PER_M");

// Default panel hand is "left", so the free/selecting hand is "right" and the
// yaw-drag hand is "left".
const SELECT_HAND = "right";


const BASE = {
  appState: APP_STATE_INSIDE_SPHERE,
  panelOpen: false,
  launcherCapturing: false,
  genAiPending: false,
  selectHandedness: SELECT_HAND,
  leftPresent: true,
  rightPresent: true,
  leftPositioned: true,
  rightPositioned: true,
  leftPinch: false,
  rightPinch: false,
  leftMicrogestureEdge: false,
  rightMicrogestureEdge: false,
  handDistanceM: 0.4,
  // Hands held at chest height. Only the stop latch reads these, and only as a
  // delta against what it captured, so the absolute value is arbitrary — which
  // is the property REST_HEIGHT_M and the seated/standing test below check.
  leftHandHeightM: 1.2,
  rightHandHeightM: 1.2,
  rotatePalmUp: false,
  rotateLateralM: 0,
  rotateVerticalM: 0,
  // The grab model's position gains, exactly as input.js hands them over. The
  // tree is dependency-free and cannot read constants.js itself, so a rig that
  // omitted these would silently exercise a sphere with no position channel.
  rotateYawGainRadPerM: YAW_RAD_PER_M,
  rotatePitchGainRadPerM: PITCH_RAD_PER_M,
  rotateGainScale: 1,
  sphereYawSpeedRadPerS: 0,
  spherePitchSpeedRadPerS: 0,
  sphereRotationPaused: false,
  // Palms unreadable by default, i.e. NOT the stop pose — every test that is not
  // about the stop signal is therefore unaffected by it.
  leftPalmForwardDot: NaN,
  rightPalmForwardDot: NaN
};

// The stop signal's pose: both palms squarely away from the face.
const STOP_POSE = {
  leftPalmForwardDot: 0.95,
  rightPalmForwardDot: 0.95
};

// A tiny driver: feeds frames at 30 Hz (the hand-tracking rate this is designed
// for) and returns the last decision, so a test reads as "hold this pose for N
// milliseconds" rather than as a loop.
function makeRig(overrides = {}) {
  let gestureState = createHandGestureState();
  let now = 1000;
  let last = null;
  return {
    get now() {
      return now;
    },
    get decision() {
      return last;
    },
    // One frame.
    step(input = {}) {
      last = resolveHandGestures(gestureState, { ...BASE, ...overrides, ...input, now });
      gestureState = last.state;
      now += 1000 / 30;
      return last;
    },
    // Hold a pose for `ms`, returning every decision produced along the way.
    hold(ms, input = {}) {
      const end = now + ms;
      const seen = [];
      while (now <= end) {
        seen.push(this.step(input));
      }
      return seen;
    }
  };
}

// --- pure helpers ------------------------------------------------------------

test("relativeDeviation is scale-free and rejects a useless reference", () => {
  assert.ok(Math.abs(relativeDeviation(0.5, 0.4) - 0.25) < 1e-12);
  assert.equal(relativeDeviation(0.3, 0.4), Math.abs(0.3 - 0.4) / 0.4);
  // A 25% spread is 25% whether the hands started 20 cm or 80 cm apart.
  assert.ok(Math.abs(relativeDeviation(0.25, 0.2) - relativeDeviation(1.0, 0.8)) < 1e-12);
  assert.equal(relativeDeviation(0.5, 0), Infinity);
  assert.equal(relativeDeviation(NaN, 0.4), Infinity);
});

test("an unreadable palm counts as palm-up, so the drag is refused not gambled", () => {
  assert.equal(isPalmFacingUp(NaN), true);
  assert.equal(isPalmFacingUp(null), true);
  assert.equal(isPalmFacingUp(1), true, "palm straight up");
  assert.equal(isPalmFacingUp(0.6), true, "within 60 degrees of up");
  assert.equal(isPalmFacingUp(0), false, "palm facing horizontally");
  assert.equal(isPalmFacingUp(-1), false, "palm facing down");
});

test("an unreadable palm is NOT the stop pose, the opposite default to palm-up", () => {
  // Refusing the drag on an unknown pose costs a gesture; pausing the sphere on
  // an unknown pose would be a control acting on something nobody did.
  assert.equal(isPalmFacingAway(NaN), false);
  assert.equal(isPalmFacingAway(null), false);
  assert.equal(isPalmFacingAway(1), true, "palm square down the view direction");
  assert.equal(isPalmFacingAway(PALM_AWAY_MIN_COS), true);
  assert.equal(isPalmFacingAway(PALM_AWAY_MIN_COS - 0.01), false);
  assert.equal(isPalmFacingAway(0), false, "palms turned inward, i.e. the distance pose");
  assert.equal(isPalmFacingAway(-1), false, "palm toward the face, i.e. the summon pose");
});

// legacy ?drag=vel
test("rotate deflection has a deadzone and saturates at 1, on either axis", () => {
  for (const [deflect, deadzone, full] of [
    [rotateYawDeflection, ROTATE_YAW_DEADZONE_M, ROTATE_YAW_FULL_DEFLECTION_M],
    [rotatePitchDeflection, ROTATE_PITCH_DEADZONE_M, ROTATE_PITCH_FULL_DEFLECTION_M]
  ]) {
    assert.equal(deflect(0), 0);
    assert.equal(deflect(deadzone), 0);
    assert.equal(deflect(full), 1);
    assert.equal(deflect(full * 4), 1);
    assert.equal(deflect(-full * 4), -1);
    // Half the TRAVEL is not half the deflection: the curve
    // (ROTATE_RESPONSE_EXPONENT) makes the middle of a stroke worth more than a
    // straight line gives it. Both ends stay pinned, which everything else in this
    // file depends on.
    const half = deflect(deadzone + ((full - deadzone) / 2));
    assert.ok(Math.abs(half - Math.pow(0.5, ROTATE_RESPONSE_EXPONENT)) < 1e-9);
    assert.ok(half > 0.5, "and the bend is the EASIER way round, not expo");
    assert.equal(deflect(NaN), 0);
  }
  // The named wrappers are the shared curve with the axis's own pair, not two
  // curves that could drift apart.
  assert.equal(
    rotateYawDeflection(0.05),
    rotateDeflection(0.05, ROTATE_YAW_DEADZONE_M, ROTATE_YAW_FULL_DEFLECTION_M)
  );
});

// legacy ?drag=vel. A lateral sweep crosses the body and recruits the shoulder; a
// vertical lift is forearm-only. The same displacement must therefore buy MORE
// yaw than pitch, or the horizontal axis reads as the stiff one.
test("the HORIZONTAL axis is the more sensitive of the two", () => {
  assert.ok(
    ROTATE_YAW_FULL_DEFLECTION_M < ROTATE_PITCH_FULL_DEFLECTION_M,
    "yaw reaches full speed in less travel"
  );
  assert.ok(ROTATE_YAW_DEADZONE_M <= ROTATE_PITCH_DEADZONE_M, "and starts sooner");
  // Sampled below the shorter of the two full-deflection travels, or both
  // axes would simply read 1 and the comparison would prove nothing.
  for (const displacementM of [0.03, 0.05, 0.08]) {
    assert.ok(
      rotateYawDeflection(displacementM) > rotatePitchDeflection(displacementM),
      `${displacementM} m sideways outruns ${displacementM} m vertically`
    );
  }
  // Not so sensitive that it saturates inside an ordinary drag: full deflection
  // is still a deliberate sweep, not a twitch. Pinned to the throw's own
  // minimum travel rather than to a bare number, because that is the real
  // constraint — a throw has to stay a movement the drag itself was mapping.
  assert.ok(
    ROTATE_YAW_FULL_DEFLECTION_M >= ROTATE_THROW_MIN_TRAVEL_M * 2,
    "a recognised throw is at most half of the drag's full-deflection travel"
  );
});

// --- the distance gesture ----------------------------------------------------
//
// THE BASELINE IS A TURNING POINT, NOT A REST. Requiring a separation to hold
// still within DISTANCE_STABILITY_REL for 100 ms before anything could engage
// would be a defect: at a 0.4 m separation that tolerance is 24 mm, so a hand
// pair converging faster than 0.24 m/s could never settle a rest, and bringing
// your hands in from the sides is 0.5-1.0 m/s. The baseline is a leaky extremum:
// the closest-together and furthest-apart the hands have recently been, each
// relaxing toward the present reading over DISTANCE_EXTREMUM_LEAK_S.

// Hold a separation for a while. This puts both bounds on the same value, which
// is the state most of the tests below want to start from.
function holdSeparation(state, distanceM, now, frames = 6, stepMs = 1000 / 30) {
  let next = state;
  let t = now;
  for (let i = 0; i < frames; i += 1) {
    const step = updateDistanceGesture(next, { now: t, eligible: true, distanceM });
    next = step.state;
    t += stepMs;
  }
  return { state: next, now: t };
}

// Walk a separation from `fromM` to `toM` over `frames`, which is what a hand
// actually does; a teleport is the one input shape the leak treats differently
// (it eats a slice of a single-frame excursion, proportional to dt/tau).
function walkSeparation(state, { fromM, toM, now, frames = 8, stepMs = 1000 / 30, path }) {
  let step = { state, active: false, deltaM: 0, releaseReason: "" };
  let t = now;
  const seen = [];
  for (let i = 1; i <= frames; i += 1) {
    step = updateDistanceGesture(step.state, {
      now: t,
      eligible: true,
      distanceM: fromM + ((toM - fromM) * (i / frames)),
      path
    });
    seen.push(step);
    t += stepMs;
  }
  return { step, now: t, seen };
}

test("NO stillness is required: a continuous spread engages with no pause first", () => {
  // Hands converging and then spreading, never still for a single frame, must
  // engage.
  let step = { state: createDistanceState() };
  let t = 0;
  let sep = 0.55;
  // Coming in at 0.6 m/s, but not far enough for the inbound half to be a
  // stroke of its own — this test is about the TURN, not about closing.
  for (let i = 0; i < 4; i += 1) {
    sep -= 0.02;
    step = updateDistanceGesture(step.state, { now: t, eligible: true, distanceM: sep });
    t += 1000 / 30;
  }
  assert.equal(step.active, false, "the inbound half did not travel far enough");
  const turningPoint = sep;

  // ...and straight back out, with no pause at the turn. 0.6 m/s is far too fast
  // for a rest tracker's candidate to hold within 6% for 100 ms.
  const seen = [];
  for (let i = 0; i < 15; i += 1) {
    sep += 0.02;
    step = updateDistanceGesture(step.state, { now: t, eligible: true, distanceM: sep });
    seen.push(step);
    t += 1000 / 30;
  }
  assert.ok(seen.some((s) => s.active), "the minimum they reached IS the baseline");
  const engaged = seen.find((s) => s.justEngaged);
  assert.ok(
    engaged.state.baselineM < turningPoint * 1.08,
    `and it is the turning point, not the start: ${engaged.state.baselineM} vs ${turningPoint}`
  );
  assert.ok(engaged.deltaM >= 0, "and it is read as a spread, not as a close");
});

test("the extremum records a turning point at once and forgets it slowly", () => {
  // The pure arithmetic, so the leak's two halves are checkable without the
  // gesture around them. A new low is taken IMMEDIATELY (that is what makes a
  // turning point a turning point) and the stale bound decays with the time
  // constant.
  const start = { sepMinM: 0.4, sepMaxM: 0.4 };
  const dropped = stepDistanceExtremum(start, 0.3, 1 / 30);
  assert.equal(dropped.sepMinM, 0.3, "a new minimum is instant");
  assert.ok(dropped.sepMaxM < 0.4 && dropped.sepMaxM > 0.3, "the maximum only leaks");

  // One time constant of holding still closes ~63% of the gap.
  let leaked = { sepMinM: 0.3, sepMaxM: 0.4 };
  for (let i = 0; i < 30 * DISTANCE_EXTREMUM_LEAK_S; i += 1) {
    leaked = stepDistanceExtremum(leaked, 0.3, 1 / 30);
  }
  assert.ok(
    Math.abs(leaked.sepMaxM - (0.3 + (0.1 * Math.exp(-1)))) < 0.005,
    `one tau leaves 1/e of the gap, got ${leaked.sepMaxM}`
  );
  // A first reading seeds both bounds rather than engaging off zero.
  const seeded = stepDistanceExtremum({ sepMinM: 0, sepMaxM: 0 }, 0.55, 1 / 30);
  assert.deepEqual(seeded, { sepMinM: 0.55, sepMaxM: 0.55 });
});

test("the baseline is the extremum the hands are travelling AWAY from", () => {
  const bounds = { sepMinM: 0.3, sepMaxM: 0.7 };
  assert.equal(distanceBaselineFor(bounds, 0.5, 1), 0.3, "spreading measures from the minimum");
  assert.equal(distanceBaselineFor(bounds, 0.5, -1), 0.7, "closing measures from the maximum");
  // No direction (the pure-test fallback): the extremum they are furthest from.
  assert.equal(distanceBaselineFor(bounds, 0.65, 0), 0.3);
  assert.equal(distanceBaselineFor(bounds, 0.35, 0), 0.7);
  assert.equal(distanceBaselineFor({ sepMinM: 0, sepMaxM: 0 }, 0.4, 1), 0, "nothing yet");
});

test("the gesture engages on relative change, not on an absolute distance", () => {
  // A short reach and a long reach engage at the SAME relative spread, which is
  // the whole point of replacing the old absolute 0.65 m / 0.9 m pair.
  for (const rest of [0.2, 0.8]) {
    const held = holdSeparation(createDistanceState(), rest, 0);
    const justUnder = walkSeparation(held.state, {
      fromM: rest,
      toM: rest * (1 + DISTANCE_ENGAGE_REL - 0.08),
      now: held.now,
      frames: 6
    });
    assert.equal(justUnder.step.active, false, `rest ${rest}: under the enter bound`);

    const over = walkSeparation(held.state, {
      fromM: rest,
      toM: rest * (1 + DISTANCE_ENGAGE_REL + 0.15),
      now: held.now,
      frames: 6
    });
    assert.ok(over.seen.some((s) => s.justEngaged), `rest ${rest}: past the enter bound`);
  }
});

test("the engage deadband is removed, so the control starts at zero and grows", () => {
  const rest = 0.4;
  const held = holdSeparation(createDistanceState(), rest, 0);
  // Walked, not teleported: the deadband claim is about the frame the bound is
  // CROSSED on, and a hand crosses it rather than appearing past it.
  const walked = walkSeparation(held.state, {
    fromM: rest,
    toM: rest * 1.5,
    now: held.now,
    frames: 20
  });
  const engaged = walked.seen.find((s) => s.justEngaged);
  assert.ok(engaged, "engaged somewhere in the stroke");
  const perFrameM = (rest * 0.5) / 20;
  assert.ok(
    Math.abs(engaged.deltaM) <= perFrameM,
    `no jump on the engaging frame: ${engaged.deltaM} against one frame of ${perFrameM}`
  );

  // 10 cm further apart is 10 cm more control travel — 1:1 past the deadband.
  const at = engaged.state.baselineM * (1 + DISTANCE_ENGAGE_REL) + 0.02;
  const a = updateDistanceGesture(engaged.state, {
    now: walked.now, eligible: true, distanceM: at
  });
  const b = updateDistanceGesture(a.state, {
    now: walked.now + 33, eligible: true, distanceM: at + 0.1
  });
  assert.ok(Math.abs((b.deltaM - a.deltaM) - 0.1) < 1e-6, `got ${b.deltaM - a.deltaM}`);

  // Sign: hands apart is positive (speed up / zoom in), hands together negative.
  const together = holdSeparation(createDistanceState(), rest, 0);
  const pulled = walkSeparation(together.state, {
    fromM: rest,
    toM: rest * (1 - DISTANCE_ENGAGE_REL) - 0.05,
    now: together.now,
    frames: 8
  });
  assert.ok(pulled.step.active, "closing engages too");
  assert.ok(pulled.step.deltaM < 0, `got ${pulled.step.deltaM}`);
});

test("returning to rest releases, but only after the release grace", () => {
  const rest = 0.4;
  const settled = holdSeparation(createDistanceState(), rest, 0);
  let now = settled.now;
  let step = updateDistanceGesture(settled.state, {
    now,
    eligible: true,
    distanceM: rest * 1.4
  });
  assert.equal(step.active, true);

  // Back inside the release bound. It has to STAY there for the grace period,
  // so a single frame passing through rest mid-gesture does not drop it.
  const backAtRest = rest * (1 + (DISTANCE_RELEASE_REL / 2));
  step = updateDistanceGesture(step.state, { now: now + 33, eligible: true, distanceM: backAtRest });
  assert.equal(step.active, true, "still engaged inside the grace window");

  // Wander back out before the grace elapses: the clock resets.
  step = updateDistanceGesture(step.state, { now: now + 66, eligible: true, distanceM: rest * 1.4 });
  assert.equal(step.active, true);

  now += 100;
  step = updateDistanceGesture(step.state, { now, eligible: true, distanceM: backAtRest });
  assert.equal(step.active, true);
  step = updateDistanceGesture(step.state, {
    now: now + DISTANCE_RELEASE_GRACE_MS + 1,
    eligible: true,
    distanceM: backAtRest
  });
  assert.equal(step.active, false, "released once the grace elapsed");
});

test("a release reseeds the extremum, so it cannot bounce back in off a stale one", () => {
  const rest = 0.4;
  const settled = holdSeparation(createDistanceState(), rest, 0);
  let now = settled.now;
  let step = updateDistanceGesture(settled.state, { now, eligible: true, distanceM: rest * 1.4 });
  assert.equal(step.active, true);

  // Hold at rest until the release grace elapses and it lets go.
  for (let i = 0; step.active && i < 40; i += 1) {
    now += 1000 / 30;
    step = updateDistanceGesture(step.state, { now, eligible: true, distanceM: rest });
  }
  assert.equal(step.active, false, "released");
  assert.equal(step.state.sepMinM, rest, "both bounds were reseeded where the hands are");
  assert.equal(step.state.sepMaxM, rest);

  // Spread wide again on the very next frame. The stale 1.4x maximum is gone,
  // so the second stroke has to earn its own travel from here.
  now += 1000 / 30;
  step = updateDistanceGesture(step.state, { now, eligible: true, distanceM: rest * 1.1 });
  assert.equal(step.active, false, "no re-engage off the stale extremum");
});

test("losing eligibility drops the gesture and its baselines outright", () => {
  const settled = holdSeparation(createDistanceState(), 0.4, 0);
  const engaged = updateDistanceGesture(settled.state, {
    now: settled.now,
    eligible: true,
    distanceM: 0.56
  });
  assert.equal(engaged.active, true);
  const gone = updateDistanceGesture(engaged.state, {
    now: settled.now + 33,
    eligible: false,
    distanceM: 0.56
  });
  assert.equal(gone.active, false);
  assert.equal(gone.state.baselineM, 0);
  assert.equal(gone.state.sepMinM, 0);
  assert.equal(gone.state.sepMaxM, 0);
});

// --- the RATCHET: repeated strokes accumulate --------------------------------
// The gesture must not be limited to one stroke from wherever it engaged: if the
// only release were "put the hands back where they started", that would drive
// the control back to the value it engaged with on the way out.

// Hold a separation still until the gesture lets go, returning the last step.
function holdUntilRelease(state, distanceM, now, limitMs = 2000) {
  let step = { state, active: true, deltaM: 0, releaseReason: "" };
  let t = now;
  const end = now + limitMs;
  while (step.active && t <= end) {
    t += 1000 / 30;
    step = updateDistanceGesture(step.state, { now: t, eligible: true, distanceM });
  }
  return { step, now: t };
}

test("settling past the deadband COMMITS: the gesture lets go where it is", () => {
  const rest = 0.4;
  const settled = holdSeparation(createDistanceState(), rest, 0);
  const spread = rest * 1.6;
  let step = updateDistanceGesture(settled.state, {
    now: settled.now,
    eligible: true,
    distanceM: spread
  });
  assert.equal(step.active, true);
  const travelled = step.deltaM;
  assert.ok(travelled > 0, `the stroke moved the control, got ${travelled}`);

  const baseline = step.state.baselineM;
  const held = holdUntilRelease(step.state, spread, settled.now);
  assert.equal(held.step.active, false, "it let go without returning to rest");
  assert.equal(held.step.releaseReason, "committed");
  // The caller stops writing here, so whatever the control reached is KEPT.
  // Nothing unwound it: the last engaged frame still reported the full travel.
  assert.ok(
    Math.abs(travelled - (spread - baseline - (DISTANCE_ENGAGE_REL * baseline))) < 1e-9,
    "and the value it kept is the whole stroke past the deadband"
  );
  // The commit reseeds the extremum where the hands stopped, so the next stroke
  // starts from HERE — that is the whole of "repeated strokes accumulate".
  assert.equal(held.step.state.sepMinM, spread);
  assert.equal(held.step.state.sepMaxM, spread);
});

test("a committed stroke re-baselines, so the NEXT stroke continues it", () => {
  // The property the app needs: three strokes in the same direction must move
  // the control three times as far. The caller re-baselines from the live
  // control value on `justEngaged`, so what this has to prove is that each
  // engagement is possible and that each one's travel is measured from the new
  // rest rather than from the original one.
  const rest = 0.4;
  let settled = holdSeparation(createDistanceState(), rest, 0);
  let state = settled.state;
  let now = settled.now;
  let total = 0;
  let at = rest;

  for (let stroke = 0; stroke < 3; stroke += 1) {
    const from = at;
    at = from * 1.6;
    const engaged = updateDistanceGesture(state, { now, eligible: true, distanceM: at });
    assert.equal(engaged.active, true, `stroke ${stroke} engaged`);
    assert.ok(engaged.deltaM > 0, `stroke ${stroke} moved the control`);
    total += engaged.deltaM;
    const held = holdUntilRelease(engaged.state, at, now);
    assert.equal(held.step.releaseReason, "committed", `stroke ${stroke} committed`);
    state = held.step.state;
    now = held.now;
  }

  assert.ok(total > 0.3, `three strokes accumulate real travel, got ${total}`);
});

test("returning to rest still releases, and that exit is the CANCEL", () => {
  // The other release is unchanged and still unwinds: the control ends back at
  // the value it engaged with, which is what "put your hands back" should mean.
  const rest = 0.4;
  const settled = holdSeparation(createDistanceState(), rest, 0);
  let now = settled.now;
  let step = updateDistanceGesture(settled.state, {
    now,
    eligible: true,
    distanceM: rest * 1.4
  });
  assert.equal(step.active, true);
  // Come back continuously, so no settle can commit on the way.
  for (const d of [rest * 1.3, rest * 1.2, rest * 1.1, rest * 1.02]) {
    now += 1000 / 30;
    step = updateDistanceGesture(step.state, { now, eligible: true, distanceM: d });
  }
  assert.equal(step.deltaM, 0, "back inside the deadband, the control is at the baseline");
  for (let i = 0; step.active && i < 40; i += 1) {
    now += 1000 / 30;
    step = updateDistanceGesture(step.state, { now, eligible: true, distanceM: rest });
  }
  assert.equal(step.active, false);
  assert.equal(step.releaseReason, "rest");
});

test("a settle INSIDE the deadband cancels rather than committing", () => {
  // Nothing to keep there — the control is at the baseline — so this must go out
  // through the return-to-rest path and clear the rest, not through the ratchet.
  const rest = 0.4;
  const settled = holdSeparation(createDistanceState(), rest, 0);
  let step = updateDistanceGesture(settled.state, {
    now: settled.now,
    eligible: true,
    distanceM: rest * 1.4
  });
  assert.equal(step.active, true);
  const held = holdUntilRelease(step.state, rest * 1.02, settled.now);
  assert.equal(held.step.active, false);
  assert.equal(held.step.releaseReason, "rest");
});

test("a stroke is not committed while it is still moving", () => {
  // The commit window is longer than the rest tracker's on purpose: a stroke
  // that merely decelerates must not let go half way, or the control would stall
  // until the hands had travelled another whole engage band.
  const rest = 0.4;
  const settled = holdSeparation(createDistanceState(), rest, 0);
  let step = { state: settled.state, active: false };
  let now = settled.now;
  let at = rest;
  // 20 frames of continuous spreading — well past DISTANCE_COMMIT_MS in wall
  // clock, but never still.
  for (let i = 0; i < 20; i += 1) {
    at += 0.02;
    now += 1000 / 30;
    step = updateDistanceGesture(step.state, { now, eligible: true, distanceM: at });
  }
  assert.equal(step.active, true, "still engaged after 660 ms of travel");
  assert.equal(step.releaseReason, "");
});

test("anti-windup: a clamped control re-anchors so backing off works at once", () => {
  // One stroke can ask for far more than the range allows; without this the
  // baseline keeps the overshoot and the hands have to unwind all of it before
  // anything moves.
  assert.equal(reanchorBaselineAfterClamp(10, 5, 15), 10, "nothing clamped, nothing moved");
  // Asked for 10 + 40 = 50, the clamp allowed 34: the baseline becomes -6, so
  // baseline + travel is exactly 34 and one millimetre less travel moves it.
  assert.equal(reanchorBaselineAfterClamp(10, 40, 34), -6);
  const rebased = reanchorBaselineAfterClamp(10, 40, 34);
  assert.ok(rebased + 39.9 < 34, "backing off immediately comes off the clamp");
  // Garbage in, baseline out — never NaN, which would poison the control.
  for (const bad of [[NaN, 1, 1], [1, NaN, 1], [1, 1, NaN]]) {
    assert.equal(reanchorBaselineAfterClamp(...bad), bad[0]);
  }
});

// --- tracking in and out of frame must not move the control -----------------

test("both hands must be tracked for a settle window before anything engages", () => {
  const rig = makeRig();
  // Right hand missing: nothing can engage, and the tracked clock is not running.
  rig.hold(400, { rightPositioned: false, handDistanceM: NaN });
  // It comes back. The separation is already a big deviation from the rest that
  // settles now — the exact shape of a hand re-entering the tracking volume.
  const early = rig.hold(DISTANCE_TRACKING_SETTLE_MS - 120, { handDistanceM: 0.4 });
  assert.ok(early.every((d) => d.distance.active === false));
  const spreadTooSoon = rig.step({ handDistanceM: 0.4 * 1.6 });
  assert.equal(
    spreadTooSoon.distance.active,
    false,
    "a spread inside the settle window cannot engage"
  );
});

test("once the hands have settled, the gesture engages as before", () => {
  const rig = makeRig();
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 120, { handDistanceM: 0.4 });
  const seen = rig.hold(100, { handDistanceM: 0.4 * 1.6 });
  assert.ok(seen.some((d) => d.distance.active), "the gate opens, it is not a block");
});

// A BLINK (shorter than HAND_DROPOUT_GRACE_MS) freezes the gesture and hands it
// back; only a real LOSS drops it and demands a fresh settle. Many real tracking
// gaps are shorter than the settle gate, so treating every gap as a loss would
// drop the gesture constantly.
test("a sub-grace blink freezes the distance gesture instead of wiping it", () => {
  const rig = makeRig();
  rig.hold(400, { handDistanceM: 0.4 });
  const spread = 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1);
  rig.hold(100, { handDistanceM: spread });
  assert.equal(rig.decision.distance.active, true);

  // One frame with no left hand: inactive, zero delta, caller freezes.
  const blink = rig.step({ leftPositioned: false, leftPresent: false, handDistanceM: NaN });
  assert.equal(blink.distance.active, false, "nothing is written while the hand is gone");
  assert.equal(blink.distance.deltaM, 0);
  assert.equal(blink.state.distance.engaged, true, "but the gesture is still engaged");

  // Back at the same separation it left at: the stroke simply continues. No
  // re-settle, no re-engage, and no justEngaged edge that would re-baseline.
  const back = rig.step({ handDistanceM: spread });
  assert.equal(back.distance.active, true, "the stroke resumes");
  assert.equal(back.distance.justEngaged, false, "and is not treated as a new one");
});

test("losing a hand for longer than the grace drops it and does not snap on return", () => {
  const rig = makeRig();
  rig.hold(400, { handDistanceM: 0.4 });
  const spread = 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1);
  rig.hold(100, { handDistanceM: spread });
  assert.equal(rig.decision.distance.active, true);

  // The hand vanishes for longer than the dropout grace. The gesture must go
  // inactive with a ZERO delta — the caller stops writing, so the control
  // freezes where the stroke left it — and must actually let go.
  const lostFrames = rig.hold(HAND_DROPOUT_GRACE_MS + 100, {
    leftPositioned: false,
    leftPresent: false,
    handDistanceM: NaN
  });
  assert.ok(lostFrames.every((d) => d.distance.active === false));
  assert.ok(lostFrames.every((d) => d.distance.deltaM === 0), "losing tracking never writes a change");
  assert.equal(rig.decision.state.distance.engaged, false, "past the grace it really lets go");

  // It comes back at a wildly different separation, the way a re-acquired hand
  // does. Nothing may engage until the settle window has passed, and when it
  // does engage the first frame is still a zero delta — no jump.
  const back = rig.hold(DISTANCE_TRACKING_SETTLE_MS - 100, { handDistanceM: 0.9 });
  assert.ok(back.every((d) => d.distance.active === false), "no engage on re-acquisition");
  const settledAgain = rig.hold(600, { handDistanceM: 0.9 });
  assert.ok(settledAgain.every((d) => d.distance.deltaM === 0), "and still no jump");

  // Spread from the NEW baseline, crossing the enter bound rather than teleporting
  // past it, which is what a hand does and what the leaky extremum requires: a
  // single-frame teleport loses a slice of its excursion to the leak, a stroke does
  // not.
  const walked = [];
  for (let i = 1; i <= 25; i += 1) {
    walked.push(rig.step({ handDistanceM: 0.9 + (i * 0.02) }));
  }
  const engaged = walked.find((d) => d.distance.justEngaged);
  assert.ok(engaged, "it can engage again from the new baseline");
  assert.ok(
    Math.abs(engaged.distance.deltaM) < 0.02,
    `starting, as always, at zero — got ${engaged.distance.deltaM}`
  );
});

// --- the sphere dwell clock: an engaged gesture is not idling ---------------
// The 20 s dwell auto-advance (transitions.js) calls the same startSphereExit() a
// select does. If the dwell were only reset when the drag produced a NON-ZERO
// deflection, a held pinch would read as idling and a phantom "select" would fire
// mid-drag. A rotate-hand pinch cannot reach the select branch at all; that is
// asserted below too.

test("a drag held INSIDE the deadzone still counts as interaction", () => {
  const rig = makeRig();
  const seen = rig.hold(PINCH_DEBOUNCE_MS + 400, {
    leftPinch: true,
    // Hand drifting inside both deadzones: both deflections are exactly zero, so a
    // guard on deflection would let the dwell keep running.
    rotateLateralM: ROTATE_YAW_DEADZONE_M * 0.5,
    rotateVerticalM: -ROTATE_PITCH_DEADZONE_M * 0.5
  });
  const dragging = seen.filter((d) => d.rotate.active);
  assert.ok(dragging.length > 5, "the drag is engaged");
  assert.ok(
    dragging.every((d) => d.rotate.deflection === 0 && d.rotate.pitchDeflection === 0),
    "and producing no rotation at all"
  );
  assert.ok(dragging.every((d) => d.interacting), "yet every frame counts as interaction");
});

test("a perfectly still held pinch counts as interaction", () => {
  const rig = makeRig();
  const seen = rig.hold(PINCH_DEBOUNCE_MS + 600, { leftPinch: true });
  assert.ok(seen.slice(4).every((d) => d.interacting));
});

test("an engaged distance gesture and the stop pose count as interaction", () => {
  const rig = makeRig();
  rig.hold(400, { handDistanceM: 0.4 });
  const spread = rig.hold(100, { handDistanceM: 0.4 * 1.6 });
  assert.ok(spread.some((d) => d.distance.active));
  assert.ok(spread.filter((d) => d.distance.active).every((d) => d.interacting));

  const stopRig = makeRig();
  const posed = stopRig.hold(STOP_POSE_STABILITY_MS + 200, STOP_POSE);
  assert.ok(posed.some((d) => d.stop.active));
  assert.ok(posed.filter((d) => d.stop.active).every((d) => d.interacting));
});

test("hands doing nothing are idle, so the dwell is free to run", () => {
  // The other half of the contract: this must not become "the dwell never
  // fires". Two open, still, tracked hands with no gesture engaged are idle.
  const rig = makeRig();
  const seen = rig.hold(600, { handDistanceM: 0.4 });
  assert.ok(seen.every((d) => d.interacting === false));
});

test("the rotate hand's pinch can never reach the select branch", () => {
  // A rotate-hand pinch cannot be a select, whichever wrist carries the panel.
  for (const selectHandedness of ["left", "right"]) {
    const rotateHand = selectHandedness === "left" ? "right" : "left";
    const rig = makeRig({ selectHandedness });
    const seen = rig.hold(1000, { [`${rotateHand}Pinch`]: true, rotateLateralM: 0.1 });
    assert.ok(
      seen.every((d) => d.select === false),
      `${rotateHand} pinch must never select`
    );
    assert.ok(seen.some((d) => d.rotate.active), "it drags instead");
  }
});

test("a drag reports BOTH edges, so the dwell can be zeroed on each", () => {
  // The timer stops incrementing during a drag and is reset at start and end. The
  // tree owns both edges so input.js does not have to keep its own copy of "was it
  // dragging last frame".
  const rig = makeRig();
  const engaging = rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const engaged = engaging.find((d) => d.rotate.justEngaged);
  assert.ok(engaged, "the engage edge is reported");
  assert.equal(engaged.rotate.justReleased, false, "and is not also a release");

  const holding = rig.hold(200, { leftPinch: true, rotateLateralM: 0.05 });
  assert.ok(
    holding.every((d) => d.rotate.justEngaged === false && d.rotate.justReleased === false),
    "no edges while it is simply running"
  );

  const gone = letGo(rig);
  assert.equal(gone.rotate.active, false);
  assert.equal(gone.rotate.justReleased, true, "the release edge is reported");
  const after = rig.hold(200, { leftPinch: false });
  assert.ok(after.every((d) => d.rotate.justReleased === false), "exactly once");
});

test("the dwell clock is HELD, not merely reset, while a gesture is engaged", () => {
  // Belt and braces against a phantom auto-advance mid-drag, which arrives through
  // the same startSphereExit() a select does and so reads as a stray selection.
  // Three mechanisms:
  //   1. the level (`interacting`) resets the clock every engaged frame;
  //   2. `state.sphereInteractionHold` stops updateStateMachine() adding dt at
  //      all, so no ordering accident can slip a tick past the reset;
  //   3. both edges reset it explicitly.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(
    input,
    /if \(handGesture\.interacting\) \{\s*\n\s*markSphereInteraction\(\);\s*\n\s*state\.sphereInteractionHold = true;/,
    "the level both resets and holds"
  );
  assert.match(
    input,
    /if \(handGesture\.rotate\.justEngaged \|\| handGesture\.rotate\.justReleased\) \{\s*\n\s*markSphereInteraction\(\);/,
    "and both edges reset explicitly"
  );

  const transitions = fs.readFileSync(path.join(HERE, "..", "src", "transitions.js"), "utf8");
  // The condition has several terms, all pinned: this test owns the gesture hold,
  // idle_auto_advance.test.mjs owns the suspension, onboarding.test.mjs owns the
  // overlay, and none can be dropped to satisfy another.
  assert.match(
    transitions,
    /if \(!state\.sphereInteractionHold && !state\.sphereDwellHeldByOnboarding && !isSettingsOpen\(\) && !idle\.suspended\) \{\s*\n\s*state\.sphereDwellSeconds \+= dt;\s*\n\s*\}/,
    "the clock does not advance at all while a gesture is engaged"
  );

  // ...and the hold is a per-frame claim, cleared before any input runs, so it
  // can never strand the auto-advance permanently.
  const main = fs.readFileSync(path.join(HERE, "..", "src", "main.js"), "utf8");
  const clear = main.indexOf("state.sphereInteractionHold = false;");
  const pump = main.indexOf("applyXrControllerInput(dt);");
  assert.ok(clear > 0 && clear < pump, "cleared at the top of the frame");
});

test("input.js resets the dwell from `interacting`, not from a deflection", () => {
  // The wiring the pure tree cannot see. The deflection-based guard is the bug; if
  // it comes back, the phantom select comes back with it.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(
    input,
    /if \(handGesture\.interacting\) \{\s*\n\s*markSphereInteraction\(\);/,
    "the dwell reset hangs off the tree's own interaction flag"
  );
  const drag = input.slice(input.indexOf("function applyHandRotateDrag("));
  const body = drag.slice(0, drag.indexOf("\nfunction "));
  assert.ok(
    !/rotate\.deflection !== 0[\s\S]{0,120}markSphereInteraction\(\)/.test(body),
    "the deflection-guarded reset is gone"
  );
});

test("the sphere zoom writes hands-APART as zoom IN", () => {
  // Direction: moving hands out zooms in (makes things bigger) and speeds up the
  // tunnel. sphereViewOffset displaces the SPHERE, so a positive offset pushes it
  // away and shrinks everything.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const fn = input.slice(input.indexOf("function applyHandDistanceGesture("));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(
    body,
    /const travel = -decision\.deltaM \* HAND_SPHERE_ZOOM_UNITS_PER_METER;/,
    "apart (positive deltaM) must write a negative, inward offset"
  );
  assert.match(
    body,
    /const speedTravel = decision\.deltaM \* HAND_TUNNEL_SPEED_UNITS_PER_METER;/,
    "and tunnel speed keeps its sign: apart is faster"
  );
  // Both clamped controls re-anchor, or the far end becomes a trap again.
  assert.equal(
    (body.match(/reanchorBaselineAfterClamp\(/g) || []).length,
    2,
    "both the zoom and the speed use the anti-windup"
  );
});

// --- the tree: select, and the ordering that protects it ---------------------

test("a lone select-hand pinch selects as soon as it clears the debounce", () => {
  const rig = makeRig({ leftPresent: false, leftPositioned: false });
  assert.equal(rig.step({ rightPinch: true }).select, false, "not inside the debounce");
  const seen = rig.hold(PINCH_DEBOUNCE_MS + 40, { rightPinch: true });
  assert.ok(seen.some((d) => d.select), "select commits with no hold beyond the debounce");
});

test("the other hand merely BEING there no longer delays select", () => {
  // A present, tracked, non-pinching other hand must cost select exactly nothing
  // (no doubled hold, 120 -> 240 ms).
  const withBoth = makeRig();
  const withOne = makeRig({ leftPresent: false, leftPositioned: false });
  const firstSelectFrame = (rig) => {
    const seen = rig.hold(PINCH_DEBOUNCE_MS + 200, { rightPinch: true });
    return seen.findIndex((d) => d.select);
  };
  const both = firstSelectFrame(withBoth);
  const one = firstSelectFrame(withOne);
  assert.ok(both >= 0 && one >= 0, "both selected");
  assert.equal(both, one, "same frame either way");
});

test("select does NOT fire when the rotate hand was already pinching", () => {
  // Left holds a rotate drag; the right pinch that joins it is the GenAI chord,
  // not a select, and must never navigate the sphere on its way in.
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 60, { leftPinch: true });
  assert.equal(rig.decision.rotate.active, true, "the drag is running");
  const chord = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });
  assert.ok(chord.every((d) => d.select === false), "no select anywhere in the chord");
  assert.ok(chord.some((d) => d.genAi), "it resolves as the variation instead");
});

test("an asymmetric release cannot leak a select out of a chord", () => {
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 60, { leftPinch: true });
  rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });
  // The rotate hand lets go a beat before the select hand.
  const tail = rig.hold(400, { rightPinch: true });
  assert.ok(tail.every((d) => d.select === false), "armed stays armed for the whole contact");

  // Releasing and pinching again is a new contact, and selects normally.
  rig.hold(100, {});
  const fresh = rig.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
  assert.ok(fresh.some((d) => d.select), "a fresh pinch selects again");
});

test("right-then-left is a select, not a chord — order is the whole rule", () => {
  const rig = makeRig();
  const first = rig.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
  assert.ok(first.some((d) => d.select), "the select fired on the way in");
  const joined = rig.hold(GENAI_CONFIRM_HOLD_MS + 400, { rightPinch: true, leftPinch: true });
  assert.ok(joined.every((d) => d.genAi === false), "the late left pinch bills nobody");
});

test("a simultaneous two-hand pinch is a select, not a chord (ties do not arm)", () => {
  // Deliberate: the chord asks for a pinch that was ALREADY held, and refusing a
  // tie is the direction that cannot spend money.
  const rig = makeRig();
  const seen = rig.hold(GENAI_CONFIRM_HOLD_MS + 400, { leftPinch: true, rightPinch: true });
  assert.ok(seen.every((d) => d.genAi === false), "no fire from a tie");
  assert.ok(seen.some((d) => d.select), "it reads as the select it looks like");
});

test("the rotate hand never selects, whichever hand that is", () => {
  for (const selectHandedness of ["left", "right"]) {
    const rotatePinch = selectHandedness === "left" ? "rightPinch" : "leftPinch";
    const rig = makeRig({ selectHandedness });
    const seen = rig.hold(600, { [rotatePinch]: true });
    assert.ok(
      seen.every((d) => d.select === false),
      `select hand ${selectHandedness}: the rotate hand's pinch must not select`
    );
  }
});

test("a poke at the wrist launcher still swallows the select", () => {
  const rig = makeRig({ launcherCapturing: true });
  const seen = rig.hold(600, { rightPinch: true });
  assert.ok(seen.every((d) => d.select === false));
});

test("the chord beats the distance gesture", () => {
  const rig = makeRig({ appState: APP_STATE_TUNNEL });
  // Settle a rest, then engage the distance gesture on a spread.
  rig.hold(200, { handDistanceM: 0.4 });
  const spread = 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1);
  rig.hold(100, { handDistanceM: spread });
  assert.equal(rig.decision.distance.active, true, "distance gesture is running");

  // Now form the chord without moving the hands. Any pinch drops the distance
  // gesture — after the debounce, which is what keeps a swipe's incidental
  // button-0 press from dropping it (covered separately below).
  rig.hold(PINCH_DEBOUNCE_MS + 40, { handDistanceM: spread, leftPinch: true });
  const both = rig.hold(GENAI_CONFIRM_HOLD_MS + 150, {
    handDistanceM: spread,
    leftPinch: true,
    rightPinch: true
  });
  const settled = both.slice(4);
  assert.ok(settled.every((d) => d.pinchCount === 2), "both pinches debounced");
  assert.ok(settled.every((d) => d.distance.active === false), "the distance gesture stands down");
});

// --- the tree: the GenAI chord and its confirm hold --------------------------

function armChord(rig) {
  // Rotate hand first, then the select hand joins: the only order that arms it.
  rig.hold(PINCH_DEBOUNCE_MS + 60, { leftPinch: true });
  return rig;
}

test("GenAI needs the confirm hold and fires exactly once per chord", () => {
  const rig = armChord(makeRig());
  const early = rig.hold(GENAI_CONFIRM_HOLD_MS - 120, { leftPinch: true, rightPinch: true });
  assert.ok(early.every((d) => d.genAi === false), "a brief chord bills nobody");

  const seen = rig.hold(1500, { leftPinch: true, rightPinch: true });
  assert.equal(
    seen.filter((d) => d.genAi).length,
    1,
    "one fire however long the chord is held"
  );
});

test("the confirm hold is measured from the SELECT pinch, not the rotate one", () => {
  // The rotate pinch may have been held for a minute of drag before the chord;
  // that time must not count toward the money guard.
  const rig = makeRig();
  rig.hold(2000, { leftPinch: true });
  const early = rig.hold(GENAI_CONFIRM_HOLD_MS - 120, { leftPinch: true, rightPinch: true });
  assert.ok(early.every((d) => d.genAi === false), "the drag's own age buys nothing");
  const later = rig.hold(300, { leftPinch: true, rightPinch: true });
  assert.ok(later.some((d) => d.genAi), "it fires once the select pinch has been held");
});

test("a chord released before the hold never reaches the provider", () => {
  const rig = armChord(makeRig());
  const seen = [
    ...rig.hold(GENAI_CONFIRM_HOLD_MS - 100, { leftPinch: true, rightPinch: true }),
    ...rig.hold(400, {})
  ];
  assert.ok(seen.every((d) => d.genAi === false));
});

test("a chord broken by the rotate hand refuses, with a reason, for good", () => {
  const rig = armChord(makeRig());
  // Long enough for the select pinch to debounce and arm the chord, short
  // enough that the confirm hold has not completed.
  const armed = rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true, rightPinch: true });
  assert.ok(armed.every((d) => d.genAi === false), "not fired yet");
  // The rotate pinch lets go mid-hold, then comes back.
  const broken = rig.hold(120, { rightPinch: true });
  assert.ok(broken.some((d) => d.reason === "chord-broken"), "the readout says why");
  const rejoined = rig.hold(GENAI_CONFIRM_HOLD_MS + 400, { leftPinch: true, rightPinch: true });
  assert.ok(rejoined.every((d) => d.genAi === false), "no fire without a fresh chord");
  assert.ok(rejoined.every((d) => d.select === false), "and still no select either");
});

test("the chord is refused, with a reason, where the guards say so", () => {
  const cases = [
    [{ launcherCapturing: true }, "launcher-poke"],
    [{ panelOpen: true }, "panel-open"],
    // NOT the tunnel: that is the jump. A transition is what "wrong-state" means.
    [{ appState: "transition_to_sphere" }, "wrong-state"],
    [{ genAiPending: true }, "genai-pending"]
  ];
  for (const [overrides, reason] of cases) {
    const rig = armChord(makeRig(overrides));
    const seen = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, {
      leftPinch: true,
      rightPinch: true
    });
    assert.ok(seen.every((d) => d.genAi === false), `${reason}: must not fire`);
    assert.ok(seen.every((d) => d.chord.target === null), `${reason}: and nothing else fires`);
    assert.ok(seen.some((d) => d.reason === reason), `${reason}: readout says why`);
  }
});

test("THE CHORD IN THE TUNNEL JUMPS TO THE SPHERE, once", () => {
  // Pinch left then pinch right jumps to the sphere when in the tunnel: one
  // gesture, two meanings, chosen by app state.
  const rig = armChord(makeRig({ appState: APP_STATE_TUNNEL }));
  const seen = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });
  const fired = seen.filter((d) => d.chord.target === "tunnelJump");
  assert.equal(fired.length, 1, "exactly one jump per chord");
  assert.ok(seen.every((d) => d.genAi === false), "and it is NOT a genai variation");
  const event = seen
    .flatMap((d) => d.events)
    .find((e) => e.decision === "chord" && e.outcome === "fired");
  assert.equal(event.target, "tunnelJump", "the log names which meaning fired");

  // chordSpent: holding the chord for another second cannot fire a second jump,
  // and only an OBSERVED release of the select hand's button can re-arm it.
  const more = rig.hold(1000, { leftPinch: true, rightPinch: true });
  assert.ok(more.every((d) => d.chord.target === null), "held longer, still once");
});

test("...and in the sphere the very same chord is still the GenAI variation", () => {
  const rig = armChord(makeRig());
  const seen = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });
  const fired = seen.filter((d) => d.genAi);
  assert.equal(fired.length, 1, "unchanged: exactly one variation per chord");
  assert.equal(fired[0].chord.target, "genai");
  assert.ok(
    seen.every((d) => d.chord.target !== "tunnelJump"),
    "and the jump never fires from inside the sphere"
  );
});

test("a chord during a TRANSITION does nothing at all", () => {
  // Arming during `transition_to_sphere` is harmless (it only suppresses a select
  // that state would refuse anyway), but firing must not be, in either direction:
  // the camera is already flying to the sphere, and a variation has no selected
  // image to work from.
  const rig = armChord(makeRig({ appState: "transition_to_sphere" }));
  const seen = rig.hold(GENAI_CONFIRM_HOLD_MS + 400, { leftPinch: true, rightPinch: true });
  assert.ok(seen.every((d) => d.chord.target === null));
  assert.ok(seen.every((d) => d.genAi === false));
  assert.ok(
    seen.flatMap((d) => d.events).every((e) => !(e.decision === "chord" && e.outcome === "fired")),
    "nothing fires while the camera is flying"
  );
});

test("input.js maps the chord's target onto the two EXISTING entry points", () => {
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(input, /if \(handGesture\.chord\.target === "genai"\) \{/);
  assert.match(input, /\} else if \(handGesture\.chord\.target === "tunnelJump"\) \{/);
  // Neither branch invents a path. The GenAI one is the same call the both-
  // trigger chord and the thumb tap make; the jump is the same call the right
  // stick press and the DEV `J` key make, and it guards the app state itself.
  assert.match(input, /void activateSelectedSphereImageForGenAi\(\);/);
  assert.match(input, /function vrJumpToSphere\(\) \{[\s\S]*?state\.appState !== AppState\.TUNNEL/);
  assert.equal(input.match(/vrJumpToSphere\(\);/g).length, 2, "the chord and the stick, no third");
});

// --- the tree: the rotate drag (yaw + pitch) ---------------------------------

test("the rotate hand's pinch-drag drives BOTH axes, anchored on the engaging frame", () => {
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const engaging = rig.decision;
  assert.equal(engaging.rotate.active, true);

  // Drive it with an offset now that it is engaged. Sideways is yaw, vertical is
  // pitch, and the two are independent.
  const yawOnly = rig.step({ leftPinch: true, rotateLateralM: ROTATE_YAW_FULL_DEFLECTION_M });
  assert.equal(yawOnly.rotate.justEngaged, false);
  assert.equal(yawOnly.rotate.deflection, 1);
  assert.equal(yawOnly.rotate.pitchDeflection, 0);

  const pitchOnly = rig.step({ leftPinch: true, rotateVerticalM: -ROTATE_PITCH_FULL_DEFLECTION_M });
  assert.equal(pitchOnly.rotate.deflection, 0);
  assert.equal(pitchOnly.rotate.pitchDeflection, -1, "hand down is negative pitch deflection");

  const diagonal = rig.step({
    leftPinch: true,
    rotateLateralM: ROTATE_YAW_FULL_DEFLECTION_M * 5,
    rotateVerticalM: ROTATE_PITCH_FULL_DEFLECTION_M * 5
  });
  assert.equal(diagonal.rotate.deflection, 1);
  assert.equal(diagonal.rotate.pitchDeflection, 1, "both axes saturate independently");
});

// --- the drag's VELOCITY model -----------------------------------------------
// legacy ?drag=vel. Deflection names a speed, not an acceleration: a held
// deflection must not keep adding speed until it hits the clamp.

const MAX_SPEED = 1.6;
const FRAME_S = 1 / 72;

// Run `frames` frames at a constant deflection and return the speeds.
function dragSpeeds(deflection, frames, opts = {}) {
  let speed = opts.from ?? 0;
  const seen = [];
  for (let i = 0; i < frames; i += 1) {
    speed = stepHandDragSpeed(speed, {
      deflection,
      maxSpeed: MAX_SPEED,
      dt: FRAME_S,
      ...opts
    });
    seen.push(speed);
  }
  return seen;
}

test("a held deflection converges on a speed instead of growing", () => {
  const seen = dragSpeeds(1, 600); // ~8 seconds of holding it there
  const target = MAX_SPEED;
  assert.ok(seen.every((s) => s <= target + 1e-9), "never overshoots the target");
  assert.ok(Math.abs(seen[seen.length - 1] - target) < 1e-6, "and settles on it");
  // The property an acceleration model lacks: five more seconds buys nothing.
  const settled = seen[120];
  assert.ok(
    Math.abs(seen[seen.length - 1] - settled) < 1e-3,
    "holding longer does not go faster"
  );
});

test("half a deflection is half a speed, at rest and forever", () => {
  const half = dragSpeeds(0.5, 400);
  assert.ok(Math.abs(half[half.length - 1] - (MAX_SPEED * 0.5)) < 1e-6);
});

test("returning the hand toward the anchor returns the speed toward zero", () => {
  const pushed = dragSpeeds(1, 400);
  const held = pushed[pushed.length - 1];
  const back = dragSpeeds(0, 400, { from: held });
  assert.ok(back[0] < held, "it starts coming back immediately");
  assert.ok(back.every((s, i) => i === 0 || s <= back[i - 1] + 1e-12), "monotonically");
  assert.equal(back[back.length - 1], 0, "and actually reaches zero, not a creep");
});

test("dragging back through the anchor reverses without a separate brake", () => {
  const forward = dragSpeeds(1, 400);
  const reversed = dragSpeeds(-1, 400, { from: forward[forward.length - 1] });
  assert.ok(reversed.some((s) => Math.abs(s) < 0.05), "it passes through zero");
  assert.ok(Math.abs(reversed[reversed.length - 1] + MAX_SPEED) < 1e-6);
});

test("the zoom-based calming scales the SPEED, not a rate of change", () => {
  const calm = dragSpeeds(1, 400, { scale: 0.25 });
  assert.ok(
    Math.abs(calm[calm.length - 1] - (MAX_SPEED * 0.25)) < 1e-6,
    "a zoomed-in view tops out lower, rather than merely taking longer to run away"
  );
});

test("the drag reaches the same speed at 30 Hz as at 72 Hz", () => {
  // Hand tracking runs at 30 Hz and rendering at 72; an exponential written per
  // frame instead of per second would make the drag feel different on each.
  const slow = 1 / 30;
  let a = 0;
  for (let t = 0; t < 0.5; t += slow) {
    a = stepHandDragSpeed(a, { deflection: 1, maxSpeed: MAX_SPEED, dt: slow });
  }
  let b = 0;
  for (let t = 0; t < 0.5; t += FRAME_S) {
    b = stepHandDragSpeed(b, { deflection: 1, maxSpeed: MAX_SPEED, dt: FRAME_S });
  }
  assert.ok(Math.abs(a - b) < 0.02, `30 Hz ${a.toFixed(3)} vs 72 Hz ${b.toFixed(3)}`);
});

test("the drag speed never leaves the envelope every other rotation input lives in", () => {
  const wild = dragSpeeds(1, 200, { maxSpeed: 999 });
  assert.ok(wild.every((s) => Math.abs(s) <= 4 + 1e-9), "the +/-4 clamp still holds");
});

test("a garbage frame leaves the speed where it was", () => {
  for (const bad of [{ dt: 0 }, { dt: NaN }, { deflection: NaN }, { maxSpeed: NaN }]) {
    assert.equal(
      stepHandDragSpeed(0.7, { deflection: 1, maxSpeed: MAX_SPEED, dt: FRAME_S, ...bad }),
      0.7
    );
  }
});

test("constants.js exposes drag SPEEDS, not the superseded acceleration gains", () => {
  const constants = fs.readFileSync(path.join(HERE, "..", "src", "constants.js"), "utf8");
  assert.ok(
    !/HAND_SPHERE_(YAW|PITCH)_ACCEL\s*=/.test(constants),
    "the hand drag is velocity-proportional now; an _ACCEL name would be a lie"
  );
  assert.match(constants, /HAND_SPHERE_YAW_SPEED_MAX\s*=/);
  assert.match(constants, /HAND_SPHERE_PITCH_SPEED_MAX\s*=/);
  // The thumbstick keeps acceleration: it springs back to centre, so acceleration
  // is the only model that lets it hold a speed.
  assert.match(constants, /SPHERE_ROTATION_ACCEL\s*=/);
});

// --- THE GRAB MODEL ----------------------------------------------------------
// Displacement names an ANGLE, not a speed: dragging in a direction moves the
// selected image that way, a small drag moves across an image, and consecutive or
// longer gestures add up (the release throw covers long sweeps). The velocity
// model above survives only behind ?drag=vel, and its tests are kept for exactly
// as long as that flag is.

// Engage a drag and return the rig, positioned at the origin.
function grabRig(overrides = {}) {
  const rig = makeRig(overrides);
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  assert.equal(rig.decision.rotate.active, true, "the drag engaged");
  return rig;
}

// THE RELEASE EDGE IS DEBOUNCED. Opening the pinch does not end the drag on that
// frame: the contact survives ROTATE_RELEASE_DEBOUNCE_MS so a one-frame pinch
// flicker cannot restart the position map. Every release-edge read goes through
// here instead of a single `rig.step({ leftPinch: false })`, which is also the
// assertion that the edge arrives EXACTLY ONCE and within the window.
function letGo(rig, input = {}) {
  const deadline = rig.now + ROTATE_RELEASE_DEBOUNCE_MS + 200;
  let released = null;
  while (!released && rig.now <= deadline) {
    const d = rig.step({ ...input, leftPinch: false });
    if (d.rotate.justReleased) {
      released = d;
    }
  }
  assert.ok(released, "the release edge arrives once the debounce expires");
  return released;
}

// Walk the hand and sum the angle the position channel actually handed over.
function walkGrab(rig, { perFrameLateralM = 0, perFrameVerticalM = 0, frames, input = {} }) {
  let lateral = rig.grabLateralM || 0;
  let vertical = rig.grabVerticalM || 0;
  let yawRad = 0;
  let pitchRad = 0;
  const seen = [];
  for (let i = 0; i < frames; i += 1) {
    lateral += perFrameLateralM;
    vertical += perFrameVerticalM;
    const d = rig.step({
      leftPinch: true,
      rotateLateralM: lateral,
      rotateVerticalM: vertical,
      ...input
    });
    yawRad += d.rotate.grab.deltaYawRad;
    pitchRad += d.rotate.grab.deltaPitchRad;
    seen.push(d);
  }
  rig.grabLateralM = lateral;
  rig.grabVerticalM = vertical;
  return { yawRad, pitchRad, seen, last: seen[seen.length - 1] };
}

test("grabAngleTarget is LINEAR past the deadzone — no curve, no full-deflection", () => {
  // The whole appeal of a position map is that the sphere tracks the hand. A
  // response curve makes the same stroke worth different amounts depending on
  // where in the stroke it happens, which is the property being bought back.
  assert.equal(grabAngleTarget(0, ROTATE_YAW_DEADZONE_M, YAW_RAD_PER_M), 0);
  assert.equal(grabAngleTarget(ROTATE_YAW_DEADZONE_M, ROTATE_YAW_DEADZONE_M, YAW_RAD_PER_M), 0);
  const at = (m) => grabAngleTarget(m, ROTATE_YAW_DEADZONE_M, YAW_RAD_PER_M);
  const dz = ROTATE_YAW_DEADZONE_M;
  assert.ok(Math.abs(at(dz + 0.10) - (0.10 * YAW_RAD_PER_M)) < 1e-12);
  // Twice the travel past the deadzone is exactly twice the angle, all the way
  // out — there is no saturation, so a long sweep keeps paying.
  assert.ok(Math.abs(at(dz + 0.20) - (2 * at(dz + 0.10))) < 1e-12);
  assert.ok(Math.abs(at(dz + 2.0) - (2.0 * YAW_RAD_PER_M)) < 1e-9, "and never saturates");
  // Odd-symmetric, and NaN-safe.
  assert.equal(at(-(dz + 0.10)), -at(dz + 0.10));
  assert.equal(grabAngleTarget(NaN, dz, YAW_RAD_PER_M), 0);
  // The zoom gain multiplies the ANGLE, not a rate of change.
  assert.ok(Math.abs(grabAngleTarget(dz + 0.1, dz, YAW_RAD_PER_M, 0.5) - (at(dz + 0.1) / 2)) < 1e-12);
});

test("ONE IMAGE of arc is a stroke a hand can actually make", () => {
  // The calibration. A sphere panel subtends ~0.74 rad (7.0 m of arc at the 9.5 m
  // panel radius), so "drag a little to move across an image" has to cost well
  // under an arm's length.
  const imageRad = 7.0 / 9.5;
  const handM = ROTATE_YAW_DEADZONE_M + (imageRad / YAW_RAD_PER_M);
  assert.ok(handM > 0.10 && handM < 0.30, `one image = ${(handM * 100).toFixed(0)} cm of hand`);
  // ...and a full turn is deliberately MORE than one stroke: long sweeps are
  // what the release throw is for.
  assert.ok((2 * Math.PI) / YAW_RAD_PER_M > 1.0, "a full turn is over a metre of hand");
});

test("the two axes are EQUAL, so a diagonal drag does not skew", () => {
  // Equal gains on both axes: unequal gains (right for a velocity model) bend a
  // diagonal away from a position map's hand. The horizontal axis keeps its
  // compensation in the smaller deadzone instead.
  assert.equal(YAW_RAD_PER_M, PITCH_RAD_PER_M);
  assert.ok(ROTATE_YAW_DEADZONE_M < ROTATE_PITCH_DEADZONE_M, "yaw still starts sooner");
  const rig = grabRig();
  const walked = walkGrab(rig, { perFrameLateralM: 0.02, perFrameVerticalM: 0.02, frames: 12 });
  // A 45-degree hand path produces a 45-degree sphere path, to within the two
  // deadzones' difference (5 mm = 0.02 rad).
  assert.ok(
    Math.abs(Math.abs(walked.yawRad) - Math.abs(walked.pitchRad)) < 0.03,
    `yaw ${walked.yawRad.toFixed(3)} vs pitch ${walked.pitchRad.toFixed(3)}`
  );
});

test("the sphere moves WITH the hand, on both axes", () => {
  // The sign convention is unchanged from the velocity model and from the
  // desktop pointer drag: a hand moving right drives NEGATIVE yaw about world
  // +Y, which walks a point at -Z toward +x, i.e. the content moves right.
  const right = walkGrab(grabRig(), { perFrameLateralM: 0.02, frames: 10 });
  assert.ok(right.yawRad < 0, "rightward drag -> negative yaw");
  assert.equal(right.pitchRad, 0, "and nothing on the axis it did not move in");
  const left = walkGrab(grabRig(), { perFrameLateralM: -0.02, frames: 10 });
  assert.ok(Math.abs(left.yawRad + right.yawRad) < 1e-9, "the mirror image is the mirror image");
  const up = walkGrab(grabRig(), { perFrameVerticalM: 0.02, frames: 10 });
  assert.ok(up.pitchRad > 0, "upward drag -> positive pitch");
  const down = walkGrab(grabRig(), { perFrameVerticalM: -0.02, frames: 10 });
  assert.ok(down.pitchRad < 0);
});

test("A HELD DISPLACEMENT HOLDS AN ANGLE — the whole point of the swap", () => {
  // Under a velocity model, holding the hand 10 cm out would turn the sphere at
  // 1.6 rad/s forever. A position map has "move across one image and stop", and no
  // stroke has to be paid back by dragging the other way.
  const rig = grabRig();
  const out = walkGrab(rig, { perFrameLateralM: 0.02, frames: 6 });
  const expected = -(0.12 - ROTATE_YAW_DEADZONE_M) * YAW_RAD_PER_M;
  assert.ok(Math.abs(out.yawRad - expected) < 1e-6, `${out.yawRad.toFixed(4)} rad`);
  // Now hold it there for three seconds — a very long time to keep a pinch.
  const held = walkGrab(rig, { perFrameLateralM: 0, frames: 90 });
  assert.ok(Math.abs(held.yawRad) < 1e-9, "not one more radian");
  // And coming back to the anchor UNDOES it exactly, rather than adding an
  // opposite spin that then has to be cancelled in turn.
  const back = walkGrab(rig, { perFrameLateralM: -0.02, frames: 6 });
  assert.ok(Math.abs(back.yawRad + out.yawRad) < 1e-6, "the sphere returns where it started");
});

test("THE CATCH brings a spinning sphere under 5% in 250 ms, on both axes", () => {
  // If counter to the current rotation, stop it and start going the gesture's way;
  // halt the rotation perpendicular to the gesture: one mechanism. The catch is
  // stepHandDragSpeed() commanded to zero, which is what applyHandRotateDrag() runs
  // on every engaged frame.
  for (const start of [3.0, -3.0, 1.4, 0.3]) {
    let speed = start;
    for (let t = 0; t < 0.25; t += FRAME_S) {
      speed = stepHandDragSpeed(speed, { deflection: 0, maxSpeed: 0, dt: FRAME_S });
    }
    assert.ok(
      Math.abs(speed) < Math.abs(start) * 0.05,
      `${start} rad/s -> ${speed.toFixed(3)} after 250 ms`
    );
    assert.equal(Math.sign(speed) === -Math.sign(start), false, "and never overshoots past zero");
  }
  // NOT a hard kill: a quarter of the residual is still there after one frame,
  // which is what makes a same-direction grab read as ADDING rather than as the
  // sphere being snatched to a halt.
  const oneFrame = stepHandDragSpeed(3.0, { deflection: 0, maxSpeed: 0, dt: FRAME_S });
  assert.ok(oneFrame > 2.4, `${oneFrame.toFixed(2)} rad/s still running after one frame`);
});

test("THE RATE CLAMP is the envelope, because the grab bypasses the +/-4 one", () => {
  // The direct angle write goes straight onto sphereOrientation, so
  // applySphereRotationDelta()'s own clamp never sees it.
  const dt = 1 / 72;
  const step = stepGrabAngle(0, 100, { dtS: dt });
  assert.ok(Math.abs(step.deltaRad - (HAND_GRAB_MAX_RATE_RAD_PER_S * dt)) < 1e-12);
  // A clamped excursion is DROPPED, not repaid: the applied ledger advances by
  // the clamped delta, so the next frame does not hand over the teleport late.
  assert.equal(step.appliedRad, step.deltaRad);
  assert.ok(Math.abs(stepGrabAngle(0, -100, { dtS: dt }).deltaRad + (HAND_GRAB_MAX_RATE_RAD_PER_S * dt)) < 1e-12);
  // Inside the clamp it is exact — no smoothing, no lag.
  assert.ok(Math.abs(stepGrabAngle(0.2, 0.25, { dtS: dt }).deltaRad - 0.05) < 1e-12);
  // A garbage frame moves nothing.
  for (const bad of [{ dtS: 0 }, { dtS: NaN }]) {
    assert.equal(stepGrabAngle(0.2, 5, { ...bad }).deltaRad, 0);
  }
  assert.equal(stepGrabAngle(0.2, NaN, { dtS: dt }).appliedRad, 0.2);
  // ...and end to end: a joint that teleports 1 m in one frame turns the sphere
  // by at most the clamp, not by 4 radians.
  const rig = grabRig();
  const jump = rig.step({ leftPinch: true, rotateLateralM: 1.0 });
  assert.ok(
    Math.abs(jump.rotate.grab.deltaYawRad) <= (HAND_GRAB_MAX_RATE_RAD_PER_S * (1 / 30)) + 1e-9,
    `${jump.rotate.grab.deltaYawRad.toFixed(3)} rad in one frame`
  );
  // The clamp is a real envelope and not a formality: 3 m/s of hand is the most
  // it will pass, which is above every fling in the device log.
  assert.ok(HAND_GRAB_MAX_RATE_RAD_PER_S / YAW_RAD_PER_M >= 2.5, "a real fling is not clipped");
});

test("A DROPOUT MID-FLICK COASTS instead of freezing, and still does not snap", () => {
  // A frozen displacement is fine for a slow drag, but for a FLICK a 150-230 ms
  // freeze is a visible hitch. An unpositioned frame coasts the displacement along
  // the release-velocity EMA, decaying with GRAB_DROPOUT_EXTRAPOLATE_TAU_S.
  const rig = grabRig();
  walkGrab(rig, { perFrameLateralM: 0.02, frames: 5 });   // ~0.6 m/s
  const heldAt = rig.grabLateralM;

  // Five frames at 30 Hz is 167 ms of no position, the hand's last reading
  // frozen exactly as input.js freezes it.
  const gapSteps = [];
  for (let i = 0; i < 5; i += 1) {
    gapSteps.push(rig.step({ leftPinch: true, rotateLateralM: heldAt, leftPositioned: false }));
  }
  const duringGap = gapSteps.reduce((sum, d) => sum + d.rotate.grab.deltaYawRad, 0);
  assert.ok(duringGap < 0, "the sphere keeps going the way the hand was going");
  assert.ok(
    gapSteps.every((d) => d.rotate.grab.deltaYawRad <= 0),
    "and never reverses mid-gap"
  );
  // DECAYING, not free-running: the whole gap is worth at most v*tau of hand,
  // which at 0.6 m/s is 7 cm however long the hand stays away.
  assert.ok(
    Math.abs(duringGap) < 0.6 * GRAB_DROPOUT_EXTRAPOLATE_TAU_S * YAW_RAD_PER_M,
    `${duringGap.toFixed(3)} rad is inside the v*tau envelope`
  );
  // Each frame contributes less than the one before — the estimate is decaying.
  const first = Math.abs(gapSteps[0].rotate.grab.deltaYawRad);
  const last = Math.abs(gapSteps[gapSteps.length - 1].rotate.grab.deltaYawRad);
  assert.ok(last < first, `${last.toFixed(4)} < ${first.toFixed(4)}: the coast decays`);

  // The hand comes back 20 cm further along — 0.8 rad of sphere if it were
  // taken at face value. The re-anchor still absorbs the whole excursion,
  // INCLUDING the extrapolation, so there is no snap in either direction.
  const back = rig.step({ leftPinch: true, rotateLateralM: heldAt + 0.2 });
  assert.equal(back.rotate.grab.deltaYawRad, 0, "and it does not snap on return");
  // ...and control resumes from where the hand ACTUALLY is, at full gain.
  rig.grabLateralM = heldAt + 0.2;
  const after = walkGrab(rig, { perFrameLateralM: 0.02, frames: 5 });
  assert.ok(
    Math.abs(after.yawRad - (-0.10 * YAW_RAD_PER_M)) < 1e-6,
    `${after.yawRad.toFixed(4)} rad for 10 cm after the gap`
  );
});

test("...but a blink AT REST still moves nothing at all", () => {
  // The property that keeps the extrapolation honest: it coasts on a measured
  // velocity, and a hand that was not moving has none. A pinch held still
  // through a dropout must leave the sphere exactly where it was, or every
  // tracking gap becomes a slow drift.
  const rig = grabRig();
  // Long enough for the EMA to forget how the hand got to 0.06 m — the fixture
  // teleports it there, which a real hand does not.
  rig.hold(700, { leftPinch: true, rotateLateralM: 0.06 });
  let moved = 0;
  for (let i = 0; i < 6; i += 1) {
    moved += Math.abs(
      rig.step({ leftPinch: true, rotateLateralM: 0.06, leftPositioned: false })
        .rotate.grab.deltaYawRad
    );
  }
  // 0.001 rad is 0.06 degrees of sphere: below anything an eye could find.
  assert.ok(moved < 0.001, `${moved} rad while a still hand blinked`);
});

test("REPLAY: the 10:30:18 pinch flicker no longer restarts the position map", () => {
  // Pinch flicker: the left pinch can toggle several times in half a second
  // (released, engaged, a NEW contact, released), and each engage would be a
  // createGrabState() and a fresh anchor, which reads as stutter.
  const rig = grabRig();
  const walked = walkGrab(rig, { perFrameLateralM: 0.02, frames: 6 });
  const before = rig.decision.rotate.grab.appliedYawRad;
  assert.ok(walked.yawRad < -0.3, "the stroke is under way");

  // One frame of raw un-pinch, then the pinch is back. Without the debounce this
  // would end the contact AND cost another PINCH_DEBOUNCE_MS before a new one could
  // count, so the map restarted from wherever the hand was by then.
  const blip = rig.step({ leftPinch: false, rotateLateralM: rig.grabLateralM });
  assert.equal(blip.rotate.active, true, "the drag survives a one-frame un-pinch");
  assert.equal(blip.rotate.justReleased, false, "and produces no release edge");
  assert.equal(blip.rotate.releaseSpin, null, "and no handoff");
  assert.ok(
    Math.abs(blip.rotate.grab.deltaYawRad) < 1e-9,
    "the sphere holds its angle while the pinch is up"
  );

  const resumed = rig.step({ leftPinch: true, rotateLateralM: rig.grabLateralM });
  assert.equal(resumed.rotate.justEngaged, false, "and it is the SAME contact, not a new one");
  assert.ok(
    Math.abs(resumed.rotate.grab.appliedYawRad - before) < 1e-9,
    "the applied angle is exactly where the stroke left it"
  );

  // ...and the stroke carries on at full gain from where the hand actually is.
  const after = walkGrab(rig, { perFrameLateralM: 0.02, frames: 5 });
  assert.ok(
    Math.abs(after.yawRad - (-0.10 * YAW_RAD_PER_M)) < 1e-6,
    `${after.yawRad.toFixed(4)} rad for 10 cm after the flicker`
  );
});

test("...and the bridge freezes the map rather than following an open hand", () => {
  // The difference between the two unpositioned cases. A tracking gap coasts
  // (the hand is somewhere, we just cannot see it); a raw un-pinch FREEZES (the
  // hand is right there and is not holding anything). Whatever it does while
  // open is absorbed by the re-anchor when the pinch comes back.
  const rig = grabRig();
  walkGrab(rig, { perFrameLateralM: 0.02, frames: 6 });
  const held = rig.decision.rotate.grab.appliedYawRad;
  const wandered = rig.grabLateralM + 0.25;
  for (let i = 0; i < 2; i += 1) {
    const d = rig.step({ leftPinch: false, rotateLateralM: wandered });
    assert.equal(d.rotate.active, true);
    assert.ok(Math.abs(d.rotate.grab.deltaYawRad) < 1e-9, "an open hand moves nothing");
  }
  const resumed = rig.step({ leftPinch: true, rotateLateralM: wandered });
  assert.ok(Math.abs(resumed.rotate.grab.appliedYawRad - held) < 1e-9, "no snap on re-grip");
  rig.grabLateralM = wandered;
});

test("a REAL release still lands, and its throw is measured at the let-go instant", () => {
  // The cost of the bridge is that a genuine release is confirmed
  // ROTATE_RELEASE_DEBOUNCE_MS later. What must NOT change is the throw: a hand
  // decelerates the moment it opens, so the handoff reads the EMA snapshotted
  // at the first raw un-pinch rather than the one the expiry frame would see.
  const rig = grabRig();
  walkGrab(rig, { perFrameLateralM: 1.2 / 30, frames: 8 });
  const openedAt = rig.now;
  const released = letGo(rig, { rotateLateralM: rig.grabLateralM });
  assert.ok(
    released.rotate.releaseSpin.speedMps > 0.9,
    `the flick survives the bridge: ${released.rotate.releaseSpin.speedMps.toFixed(2)} m/s`
  );
  assert.ok(released.rotate.releaseSpin.yawRadPerS < -1.5, "and lands as a throw");
  // And it really did wait: this is the latency the constant buys.
  assert.ok(
    rig.now - openedAt >= ROTATE_RELEASE_DEBOUNCE_MS,
    "the release edge waited out the debounce"
  );
  assert.ok(
    rig.now - openedAt < ROTATE_RELEASE_DEBOUNCE_MS + 100,
    "but not much longer than it"
  );
});

test("the bridge is the ROTATE hand's alone, and yields to everything else", () => {
  // `pinching` itself is untouched, so pinchCount, the select level, the chord
  // and the distance gesture see exactly what they saw before. What the bridge
  // must never do is outlive a reason the contact should have ended.
  const src = fs.readFileSync(path.join(HERE, "..", "src", "xr-hand-gestures.js"), "utf8");
  assert.match(src, /const rotatePinchEffective = rotatePinchDown \|\| rotateReleaseBridged;/);
  assert.ok(
    !/pinching\[rotateHand\] = /.test(src),
    "the debounce never writes back into `pinching`"
  );

  // ...and every OTHER reason a contact ends still ends it on the frame it
  // happens, bridge or no bridge. The panel opening is the cheapest of them to
  // stage; the select hand, the palm turning over and the app state leaving the
  // sphere all sit on the same `&&` chain.
  const rig = grabRig();
  walkGrab(rig, { perFrameLateralM: 0.02, frames: 4 });
  const opened = rig.step({
    leftPinch: false,
    panelOpen: true,
    rotateLateralM: rig.grabLateralM
  });
  assert.equal(opened.rotate.active, false, "the bridge does not outlive its gates");
  assert.equal(opened.rotate.justReleased, true);
  // ...and the bridge is closed with it, so nothing re-opens the drag later.
  const later = rig.step({ leftPinch: true, panelOpen: true, rotateLateralM: rig.grabLateralM });
  assert.equal(later.rotate.active, false);
});

test("the displacement bookkeeping is dropout-safe on its own terms", () => {
  let grab = createGrabState();
  grab = stepGrabDisplacement(grab, { positioned: true, rawLateralM: 0, rawVerticalM: 0 });
  grab = stepGrabDisplacement(grab, { positioned: true, rawLateralM: 0.10, rawVerticalM: 0.05 });
  assert.ok(Math.abs(grab.lateralM - 0.10) < 1e-12);
  // Unpositioned frames HOLD, they do not zero.
  const gapped = stepGrabDisplacement(grab, { positioned: false, rawLateralM: 9, rawVerticalM: 9 });
  assert.ok(Math.abs(gapped.lateralM - 0.10) < 1e-12);
  assert.equal(gapped.positioned, false);
  // Re-acquisition absorbs the whole excursion into the offset.
  const resumed = stepGrabDisplacement(gapped, { positioned: true, rawLateralM: 0.40, rawVerticalM: 0.05 });
  assert.ok(Math.abs(resumed.lateralM - 0.10) < 1e-12, "continuous across the gap");
  assert.ok(Math.abs(resumed.offsetLateralM - 0.30) < 1e-12);
  // ...and movement after it is measured from there, not from the anchor.
  const moved = stepGrabDisplacement(resumed, { positioned: true, rawLateralM: 0.45, rawVerticalM: 0.05 });
  assert.ok(Math.abs(moved.lateralM - 0.15) < 1e-12);
  // An unreadable coordinate is an unpositioned frame, not a zero.
  assert.ok(
    Math.abs(stepGrabDisplacement(moved, { positioned: true, rawLateralM: NaN, rawVerticalM: 0 }).lateralM - 0.15) < 1e-12
  );
});

test("the release-velocity EMA HOLDS across a gap instead of decaying to zero", () => {
  // A blink 50 ms before the release must not eat the throw. Feeding zero
  // through the smoother would do exactly that.
  let vel = 0;
  for (let i = 0; i < 20; i += 1) {
    vel = stepReleaseVelocity(vel, { sampleMps: 1.2, dtS: 1 / 30 });
  }
  assert.ok(Math.abs(vel - 1.2) < 0.02, `settles on the hand speed: ${vel.toFixed(3)}`);
  const held = stepReleaseVelocity(vel, { sampleMps: NaN, dtS: 1 / 30 });
  assert.equal(held, vel, "an unmeasured frame holds");
  // ...and a hand that really did decelerate hands over almost nothing, inside
  // a couple of hundred milliseconds.
  let slowing = vel;
  for (let i = 0; i < 8; i += 1) {
    slowing = stepReleaseVelocity(slowing, { sampleMps: 0, dtS: 1 / 30 });
  }
  assert.ok(slowing < 0.18, `a stopped hand is under the release floor: ${slowing.toFixed(3)}`);
});

test("A RELEASE UNDER THE FLOOR IMPARTS NOTHING — placing an image is possible", () => {
  const rig = grabRig();
  // ~0.15 m/s: a deliberate, slow placement, below ROTATE_RELEASE_MIN_MPS.
  walkGrab(rig, { perFrameLateralM: 0.15 / 30, frames: 20 });
  const released = letGo(rig);
  assert.equal(released.rotate.justReleased, true);
  assert.equal(released.rotate.releaseSpin.gain, 0, "no handoff at all");
  assert.equal(released.rotate.releaseSpin.yawRadPerS, 0, "the sphere is left where it is");
  assert.ok(released.rotate.releaseSpin.speedMps < ROTATE_RELEASE_MIN_MPS);
  // ...and it still AIMS the drift, down the direction the drag was going, so a
  // placement does not release into a drift that walks the image back off.
  assert.ok(released.rotate.releaseSpin.aimYawRadPerS < 0, "aimed the way the hand went");
});

test("the release ramp has no cliff at the threshold", () => {
  const handoffAt = (mps) => releaseHandoff({
    velLateralMps: mps,
    velVerticalMps: 0,
    yawGainRadPerM: YAW_RAD_PER_M,
    pitchGainRadPerM: PITCH_RAD_PER_M
  });
  assert.equal(handoffAt(ROTATE_RELEASE_MIN_MPS - 0.001).gain, 0);
  assert.ok(Math.abs(handoffAt(ROTATE_RELEASE_MIN_MPS).gain) < 1e-12);
  const mid = handoffAt((ROTATE_RELEASE_MIN_MPS + ROTATE_RELEASE_RAMP_MPS) / 2);
  assert.ok(Math.abs(mid.gain - 0.5) < 1e-9);
  assert.equal(handoffAt(ROTATE_RELEASE_RAMP_MPS).gain, 1);
  assert.equal(handoffAt(3.0).gain, 1);
  // VELOCITY CONTINUITY: past the ramp the handoff is the SAME gain the drag
  // used, so the sphere does not change speed at the instant of release.
  assert.ok(Math.abs(handoffAt(0.5).yawRadPerS + (0.5 * YAW_RAD_PER_M)) < 1e-9);
  // ...and it is clamped, however violent the fling.
  assert.ok(Math.abs(handoffAt(50).yawRadPerS) <= ROTATE_RELEASE_MAX_RAD_PER_S + 1e-9);
});

test("TWO CONSECUTIVE FLICKS END FASTER THAN ONE — the handoff is additive", () => {
  // Consecutive gestures add up: the handoff adds to whatever the sphere is already
  // carrying rather than replacing it, which is also why the catch is a fast decay
  // and not a kill.
  const flick = (carryingYaw) => {
    const rig = makeRig({ sphereYawSpeedRadPerS: carryingYaw });
    rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true, sphereYawSpeedRadPerS: carryingYaw });
    walkGrab(rig, {
      perFrameLateralM: 0.5 / 30,
      frames: 10,
      input: { sphereYawSpeedRadPerS: carryingYaw }
    });
    const released = letGo(rig, { sphereYawSpeedRadPerS: carryingYaw });
    return released.rotate.releaseSpin;
  };
  const first = flick(0);
  assert.ok(first.gain === 1, "a 0.5 m/s flick clears the ramp");
  assert.ok(first.yawRadPerS < -1, `one flick: ${first.yawRadPerS.toFixed(2)} rad/s`);
  // The second flick starts from what the first left behind — minus whatever
  // the catch took back, which is deliberately NOT modelled here: the property
  // is that the handoff ADDS, and the catch is tested on its own above.
  const second = flick(first.yawRadPerS);
  assert.ok(
    second.yawRadPerS < first.yawRadPerS,
    `two flicks: ${second.yawRadPerS.toFixed(2)} rad/s, faster than ${first.yawRadPerS.toFixed(2)}`
  );
  // ...up to the ceiling, so a stream of flicks cannot run away.
  let carried = 0;
  for (let i = 0; i < 12; i += 1) {
    carried = flick(carried).yawRadPerS;
  }
  assert.ok(Math.abs(carried) <= ROTATE_RELEASE_MAX_RAD_PER_S + 1e-9, "clamped, not unbounded");
});

test("a re-grip cannot fling by accident, however many times it happens", () => {
  // Let go, move the hand back, pinch again: the classic way to drag further
  // than one arm's length. Each release is below the floor, so each imparts
  // nothing and the angle simply accumulates.
  let carried = 0;
  for (let i = 0; i < 4; i += 1) {
    const rig = makeRig({ sphereYawSpeedRadPerS: carried });
    rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true, sphereYawSpeedRadPerS: carried });
    const walked = walkGrab(rig, {
      perFrameLateralM: 0.12 / 30,
      frames: 25,
      input: { sphereYawSpeedRadPerS: carried }
    });
    assert.ok(walked.yawRad < -0.3, "each grip turns the sphere a useful amount");
    const released = letGo(rig, { sphereYawSpeedRadPerS: carried });
    carried = released.rotate.releaseSpin.yawRadPerS;
  }
  assert.equal(carried, 0, "and the sphere is still exactly where the last grip put it");
});

test("the handoff reads the EMA, not the release frame's own speed (§2.8)", () => {
  // `dragSpeedMps` is only computed while `dragging`, and on the release frame it
  // is already false, so it reads 0.00 there. A handoff built on that reading could
  // never fling anything.
  const rig = grabRig();
  walkGrab(rig, { perFrameLateralM: 1.2 / 30, frames: 8 });
  const released = letGo(rig);
  assert.equal(released.rotate.speedMps, 0, "the old reading really is blind here");
  assert.ok(released.rotate.releaseSpin.speedMps > 0.9, "the EMA is not");
  assert.ok(released.rotate.releaseSpin.yawRadPerS < -1.5, "so the flick lands");
});

test("a release hard enough to be a throw hands a paused sphere back", () => {
  // The throw's latch-release effect on the release edge too. Mid-drag `thrown`
  // still exists as the stop latch's third exit; this is the case the grab model
  // creates, where the fling is only measurable on release.
  const rig = makeRig({ sphereRotationPaused: true });
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true, sphereRotationPaused: true });
  walkGrab(rig, {
    perFrameLateralM: 0.9 / 30,
    frames: 6,
    input: { sphereRotationPaused: true }
  });
  const released = letGo(rig, { sphereRotationPaused: true });
  assert.ok(released.rotate.releaseSpin.speedMps >= ROTATE_THROW_SPEED_MPS);
  assert.equal(released.stop.setPaused, false, "rotation is handed back");
  assert.equal(released.stop.pauseSource, "release-throw");

  // ...and a gentle release does NOT, which is what keeps the brake usable.
  const gentle = makeRig({ sphereRotationPaused: true });
  gentle.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true, sphereRotationPaused: true });
  walkGrab(gentle, {
    perFrameLateralM: 0.2 / 30,
    frames: 10,
    input: { sphereRotationPaused: true }
  });
  const kept = gentle.step({ leftPinch: false, sphereRotationPaused: true });
  assert.notEqual(kept.stop.setPaused, false, "a slow release leaves the pause alone");
});

test("the zoom gain scales the ANGLE, and is floored", () => {
  const rig = grabRig({ rotateGainScale: 0.5 });
  const half = walkGrab(rig, { perFrameLateralM: 0.02, frames: 8, input: { rotateGainScale: 0.5 } });
  const full = walkGrab(grabRig(), { perFrameLateralM: 0.02, frames: 8 });
  assert.ok(Math.abs(half.yawRad - (full.yawRad / 2)) < 1e-9);
  // The floor itself is input.js's, because it is the zoom that decides it.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(input, /const POSITION_GAIN_ZOOM_MIN = 0\.5;/);
  assert.match(input, /function handDragGainScale\(\)/);
  // NOT sphereRotationAccelScale(): that one bottoms out at 0.08 and applies a
  // 0.55 paused factor, neither of which belongs on a position map.
  const gainFn = input.slice(input.indexOf("function handDragGainScale()"));
  const body = gainFn.slice(0, gainFn.indexOf("\n}"));
  assert.ok(!/sphereRotationPaused/.test(body), "the pause does not calm a position map");
  assert.ok(!/PAUSED_/.test(body));
});

test("input.js runs the catch BEFORE the position map, and only in the grab model", () => {
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const drag = input.slice(input.indexOf("function applyHandRotateDrag("));
  const body = drag.slice(0, drag.indexOf("\n// DEV-only readout for the W4 gestures"));
  // The A/B branch: the grab model is the default and ?drag=vel is one branch, not
  // a second implementation.
  assert.match(body, /if \(HAND_DRAG_VELOCITY_MODEL\) \{/);
  const velBranch = body.indexOf("if (HAND_DRAG_VELOCITY_MODEL) {");
  const catchCall = body.indexOf("deflection: 0,\n    maxSpeed: 0,");
  const applyCall = body.indexOf("applySphereGrabRotation(");
  assert.ok(velBranch > 0 && catchCall > velBranch, "the grab path is after the flag branch");
  assert.ok(applyCall > catchCall, "the catch runs first, then the angle is applied");
  // The claim that stands the idle drift down and holds the dwell clock is made
  // on EVERY engaged frame, in both models — it is above the branch.
  assert.ok(body.indexOf("state.sphereRotationInputActive = true;") < velBranch);
  // The flag itself follows the file's own query-param pattern.
  const config = fs.readFileSync(path.join(HERE, "..", "src", "config.js"), "utf8");
  assert.match(config, /export const HAND_DRAG_VELOCITY_MODEL = \(\(\) => \{/);
  assert.match(config, /\.get\("drag"\) === "vel"/);
});

test("input.js writes the handoff into the same two speeds everything else uses", () => {
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(input, /state\.sphereYRotSpeed = releaseSpin\.yawRadPerS;/);
  assert.match(input, /state\.sphereXRotSpeed = releaseSpin\.pitchRadPerS;/);
  // ...and aims the drift from the handoff, not from a speed the position model
  // never wrote.
  assert.match(
    input,
    /setSphereDriftDirectionFromRotation\(\s*\n\s*releaseSpin\.aimYawRadPerS,\s*\n\s*releaseSpin\.aimPitchRadPerS\s*\n\s*\)/
  );
  // The legacy mid-drag throw is behind the flag: under the grab model it would
  // write a speed the catch is about to eat.
  assert.match(input, /if \(HAND_DRAG_VELOCITY_MODEL && handGesture\.rotate\.throwSpin\) \{/);
});

test("sphere.js's grab write keeps momentum, the iris coupling and the cycle", () => {
  const sphere = fs.readFileSync(path.join(HERE, "..", "src", "sphere.js"), "utf8");
  const fn = sphere.slice(sphere.indexOf("function applySphereGrabRotation("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /sphereOrientation\.premultiply\(_pointerRotX\);/);
  assert.match(body, /sphereOrientation\.premultiply\(_pointerRotY\);/);
  // The pointer path zeroes both speeds, which would make every grab a hard
  // kill; the catch owns that decay instead.
  assert.ok(!/sphereXRotSpeed = 0/.test(body), "the residual momentum survives the grab");
  assert.match(body, /applyPausedIrisCoupling\(deltaPitch, deltaYaw\);/);
  assert.match(body, /advanceSphereTextureCycle\(/);
  // Both are shared with the momentum path rather than copied, so they cannot
  // drift apart.
  assert.match(sphere, /function applyPausedIrisCoupling\(/);
  assert.match(sphere, /function advanceSphereTextureCycle\(/);
  assert.equal(sphere.match(/state\.irisXRot \+= \(deltaPitch \* 0\.7\)/g).length, 1);
});

test("PREMULTIPLY ORDER: input.js writes sphereOrientation before sphere.js does", () => {
  // Two writers to one quaternion in a single frame is only safe because the order
  // is fixed: applyXrControllerInput() premultiplies the grab's angle, then the
  // sphere update premultiplies the momentum delta and copies the result onto the
  // content group.
  const main = fs.readFileSync(path.join(HERE, "..", "src", "main.js"), "utf8");
  const inputPump = main.indexOf("applyXrControllerInput(dt);");
  const spherePump = main.indexOf("updateSpherePlacement();");
  assert.ok(inputPump > 0 && spherePump > inputPump, "input first, sphere second");
  // ...and the per-frame claim both of them read is cleared before either runs.
  assert.ok(main.indexOf("state.sphereRotationInputActive = false;") < inputPump);
});

test("each drag axis has its OWN deadzone, so a still hand rotates nothing", () => {
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const jitter = rig.step({
    leftPinch: true,
    rotateLateralM: ROTATE_YAW_DEADZONE_M,
    rotateVerticalM: -ROTATE_PITCH_DEADZONE_M
  });
  assert.equal(jitter.rotate.deflection, 0);
  assert.equal(jitter.rotate.pitchDeflection, 0);
});

test("the drag reports zero deflection on BOTH axes on the frame it engages", () => {
  const rig = makeRig();
  // Large stale offsets are present from the moment the pinch lands; the drag
  // anchor is only set on that frame, so neither may be applied.
  const seen = rig.hold(PINCH_DEBOUNCE_MS + 40, {
    leftPinch: true,
    rotateLateralM: ROTATE_YAW_FULL_DEFLECTION_M * 3,
    rotateVerticalM: ROTATE_PITCH_FULL_DEFLECTION_M * 3
  });
  const engaging = seen.find((d) => d.rotate.justEngaged);
  assert.ok(engaging, "the drag engaged");
  assert.equal(engaging.rotate.deflection, 0);
  assert.equal(engaging.rotate.pitchDeflection, 0);
});

test("a palm-up pinch never starts a drag (Meta system-gesture hazard)", () => {
  const rig = makeRig({ rotatePalmUp: true });
  const seen = rig.hold(600, { leftPinch: true, rotateLateralM: ROTATE_YAW_FULL_DEFLECTION_M });
  assert.ok(seen.every((d) => d.rotate.active === false));
});

test("the drag is sphere-only and stands down behind an open panel or a poke", () => {
  for (const overrides of [
    { appState: APP_STATE_TUNNEL },
    { panelOpen: true },
    { launcherCapturing: true }
  ]) {
    const rig = makeRig(overrides);
    const seen = rig.hold(600, { leftPinch: true, rotateLateralM: ROTATE_YAW_FULL_DEFLECTION_M });
    assert.ok(
      seen.every((d) => d.rotate.active === false),
      `${JSON.stringify(overrides)}: no drag`
    );
  }
});

// --- the tree: microgesture noise --------------------------------------------

test("a microgesture cancels the pinch it co-fires, for the whole contact", () => {
  // A swipe fires button 0 alongside its own button, so the pinch read is noisy. A
  // cancelled contact must stay cancelled: the frames AFTER the swipe must not
  // sneak a select through.
  const rig = makeRig();
  rig.step({ rightPinch: true, rightMicrogestureEdge: true });
  const seen = rig.hold(600, { rightPinch: true });
  assert.ok(seen.every((d) => d.select === false), "no select from a swipe's pinch");

  // Releasing and pinching again is a new contact, and selects normally.
  rig.hold(100, {});
  const fresh = rig.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
  assert.ok(fresh.some((d) => d.select));
});

test("a stray rotate-hand microgesture no longer kills select", () => {
  // A swipe on the ROTATE hand co-fires button 0; it must not be read as a
  // two-hand pinch whose `selectBlocked` latch then refuses every select until both
  // hands release. The cancel rule plus the ordering rule between them make it a
  // non-event.
  const rig = makeRig();
  rig.step({ leftPinch: true, leftMicrogestureEdge: true });
  const seen = rig.hold(600, { leftPinch: true, rightPinch: true });
  assert.ok(seen.some((d) => d.select), "select still commits");
  assert.ok(seen.every((d) => d.genAi === false), "and the phantom pinch bills nobody");
});

test("a one-frame pinch blip does not disturb an engaged distance gesture", () => {
  const rig = makeRig({ appState: APP_STATE_TUNNEL });
  rig.hold(200, { handDistanceM: 0.4 });
  const spread = 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1);
  rig.hold(100, { handDistanceM: spread });
  assert.equal(rig.decision.distance.active, true);

  // One frame of button-0 noise: below the debounce, so it never counts as a
  // pinch and the gesture keeps running.
  const blip = rig.step({ handDistanceM: spread, rightPinch: true });
  assert.equal(blip.distance.active, true);
  assert.equal(blip.pinchCount, 0);
});

test("a real pinch does drop the distance gesture", () => {
  const rig = makeRig({ appState: APP_STATE_TUNNEL });
  rig.hold(200, { handDistanceM: 0.4 });
  const spread = 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1);
  rig.hold(100, { handDistanceM: spread });
  assert.equal(rig.decision.distance.active, true);
  rig.hold(PINCH_DEBOUNCE_MS + 40, { handDistanceM: spread, rightPinch: true });
  assert.equal(rig.decision.distance.active, false);
});

// --- the tree: the stop signal -----------------------------------------------

test("the stop pose pauses only after its stability window", () => {
  const rig = makeRig();
  const early = rig.hold(STOP_POSE_STABILITY_MS - 60, STOP_POSE);
  assert.ok(early.every((d) => d.stop.active === false), "hands merely passing through");
  assert.ok(early.every((d) => d.stop.setPaused === null), "and nothing is driven");

  const later = rig.hold(200, STOP_POSE);
  const engaged = later.find((d) => d.stop.justEngaged);
  assert.ok(engaged, "the pose settled");
  assert.equal(engaged.stop.setPaused, true, "it asks for the pause");
  assert.ok(
    later.filter((d) => d.stop.justEngaged).length === 1,
    "engaging is an edge, not a per-frame command"
  );
});

test("the stop pose forces the distance gesture to stand down", () => {
  // The conflict this gesture exists in: palms-away with no pinch is exactly the
  // distance gesture's own engage condition, so only the palms tell them apart.
  const rig = makeRig();
  rig.hold(200, { handDistanceM: 0.4 });
  const spread = 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1);
  const seen = rig.hold(STOP_POSE_STABILITY_MS + 200, { ...STOP_POSE, handDistanceM: spread });
  assert.ok(seen.every((d) => d.distance.active === false), "no zoom while the stop pose is held");
  assert.ok(seen.some((d) => d.stop.active), "and the stop signal is what is running");
});

test("one frame of palms-away noise does not drop an engaged distance gesture", () => {
  const rig = makeRig();
  rig.hold(200, { handDistanceM: 0.4 });
  const spread = 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1);
  rig.hold(100, { handDistanceM: spread });
  assert.equal(rig.decision.distance.active, true);
  const blip = rig.step({ ...STOP_POSE, handDistanceM: spread });
  assert.equal(blip.distance.active, true, "a zoom in flight survives a stray palm reading");
  assert.equal(blip.stop.active, false);
});

// --- the tree: the stop LATCH ------------------------------------------------
// The pause must not end the moment the pose does. Release from stop to continue
// rotation happens only when both hands move down from the stop position, not
// when the hands rotate from it or one pinches and moves.

// Engage the latch and return the rig, with the hands at `heightM`.
function latched(overrides = {}, heightM = 1.2) {
  const rig = makeRig(overrides);
  rig.hold(STOP_POSE_STABILITY_MS + 100, {
    ...STOP_POSE,
    leftHandHeightM: heightM,
    rightHandHeightM: heightM
  });
  assert.equal(rig.decision.stop.latched, true, "the latch engaged");
  assert.equal(rig.decision.stop.active, true, "and the pose is being held");
  return rig;
}

test("rotating the palms out of the stop pose does NOT resume", () => {
  const rig = latched();
  // Palms turned back toward each other: the pose is gone, the latch is not.
  const seen = rig.hold(1000, { leftPalmForwardDot: 0.0, rightPalmForwardDot: 0.0 });
  assert.ok(seen.every((d) => d.stop.justReleased === false), "nothing released");
  assert.ok(seen.every((d) => d.stop.setPaused === null), "and nothing was driven");
  assert.equal(rig.decision.stop.latched, true, "still paused");
  assert.equal(rig.decision.stop.active, false, "but no longer posed");
});

test("a left pinch does NOT resume; it drags a still-paused sphere", () => {
  const rig = latched();
  const seen = rig.hold(PINCH_DEBOUNCE_MS + 200, { leftPinch: true });
  assert.ok(seen.every((d) => d.stop.justReleased === false), "the pinch did not resume");
  assert.equal(rig.decision.stop.latched, true);
  // The pinch still becomes a drag — sphereRotationPaused only scales rotation
  // acceleration down (sphereRotationAccelScale in input.js), it does not refuse
  // input, so manual rotation of a paused sphere is intended.
  assert.equal(rig.decision.rotate.active, true, "and it is a drag");
});

test("both hands dropping below the engage height is the release", () => {
  for (const wasPaused of [false, true]) {
    const rig = latched({ sphereRotationPaused: wasPaused });
    const low = 1.2 - STOP_RELEASE_DROP_M - 0.05;
    const seen = rig.hold(STOP_RELEASE_STABILITY_MS + 100, {
      leftHandHeightM: low,
      rightHandHeightM: low
    });
    const exit = seen.find((d) => d.stop.justReleased);
    assert.ok(exit, "the hands went down");
    assert.equal(exit.stop.releaseReason, "hands-down");
    assert.equal(
      exit.stop.setPaused,
      wasPaused,
      `was ${wasPaused ? "paused" : "running"}: put back the way the pose found it`
    );
    assert.equal(rig.decision.stop.latched, false);
  }
});

test("the release is RELATIVE to where the pose engaged, not a world height", () => {
  // The same absolute height is a release for a standing user and no release at
  // all for a seated one — which is the entire reason the anchor is captured.
  const standing = latched({}, 1.5);
  standing.hold(STOP_RELEASE_STABILITY_MS + 100, {
    leftHandHeightM: 1.15,
    rightHandHeightM: 1.15
  });
  assert.equal(standing.decision.stop.latched, false, "1.5 -> 1.15 is a 35 cm drop");

  const seated = latched({}, 1.0);
  seated.hold(1000, { leftHandHeightM: 1.15, rightHandHeightM: 1.15 });
  assert.equal(seated.decision.stop.latched, true, "1.0 -> 1.15 is not a drop at all");
});

test("one hand down is not a release", () => {
  const rig = latched();
  const seen = rig.hold(1000, {
    leftHandHeightM: 1.2 - STOP_RELEASE_DROP_M - 0.1,
    rightHandHeightM: 1.2
  });
  assert.ok(seen.every((d) => d.stop.justReleased === false));
  assert.equal(rig.decision.stop.latched, true);
});

test("a dip shorter than the stability window does not release", () => {
  const rig = latched();
  const low = 1.2 - STOP_RELEASE_DROP_M - 0.05;
  rig.hold(STOP_RELEASE_STABILITY_MS - 90, { leftHandHeightM: low, rightHandHeightM: low });
  assert.equal(rig.decision.stop.latched, true, "still down there, not for long enough");
  // Back up, and the clock restarts rather than resuming where it left off.
  rig.hold(200, {});
  rig.hold(STOP_RELEASE_STABILITY_MS - 90, { leftHandHeightM: low, rightHandHeightM: low });
  assert.equal(rig.decision.stop.latched, true);
});

test("keeping the palms out while lowering still releases", () => {
  // The anchor is captured ONCE. If it followed the hands down (a re-capture on
  // every re-posed frame) a user who lowers their hands still facing outward —
  // the natural motion — could never let go.
  const rig = latched();
  const low = 1.2 - STOP_RELEASE_DROP_M - 0.05;
  const seen = rig.hold(STOP_RELEASE_STABILITY_MS + 100, {
    ...STOP_POSE,
    leftHandHeightM: low,
    rightHandHeightM: low
  });
  assert.ok(seen.some((d) => d.stop.justReleased), "the drop still counted");
  assert.equal(rig.decision.stop.latched, false);

  // ...and it stays released. The pose is still being held, just lower down, so
  // without the re-arm guard this would pause again on the very next frame.
  const after = rig.hold(1000, {
    ...STOP_POSE,
    leftHandHeightM: low,
    rightHandHeightM: low
  });
  assert.ok(after.every((d) => d.stop.justEngaged === false), "no instant re-pause");
  assert.equal(rig.decision.stop.latched, false);

  // Dropping the pose and making it again DOES arm it, at the new height.
  rig.hold(300, {});
  rig.hold(STOP_POSE_STABILITY_MS + 100, {
    ...STOP_POSE,
    leftHandHeightM: low,
    rightHandHeightM: low
  });
  assert.equal(rig.decision.stop.latched, true, "a fresh pose still works");
});

test("losing both hands releases, on the longer tracking grace", () => {
  const rig = latched();
  const gone = { leftPositioned: false, rightPositioned: false, leftHandHeightM: NaN, rightHandHeightM: NaN };
  // Shorter than the grace: a dropped frame or two is not a lowered hand.
  const blip = rig.hold(STOP_RELEASE_TRACKING_GRACE_MS - 150, gone);
  assert.ok(blip.every((d) => d.stop.justReleased === false), "a dropout is not a release");
  const seen = rig.hold(300, gone);
  const exit = seen.find((d) => d.stop.justReleased);
  assert.ok(exit, "a latch with no way out would be worse than a spurious resume");
  assert.equal(exit.stop.releaseReason, "tracking-lost");
});

test("leaving the sphere drops the latch", () => {
  const rig = latched();
  const seen = rig.hold(100, { appState: APP_STATE_TUNNEL });
  const exit = seen.find((d) => d.stop.justReleased);
  assert.ok(exit);
  assert.equal(exit.stop.releaseReason, "left-sphere");
  assert.equal(exit.stop.setPaused, null, "the pause means nothing outside the sphere");
});

test("the distance gesture comes BACK once the latch is up but the pose is not", () => {
  // The pose and the latch are deliberately different states: while the pose is
  // held the distance gesture stands down (they share a hand pose), but a user
  // whose sphere is latched-paused is moving their hands normally again and must
  // be able to zoom.
  const rig = latched();
  rig.hold(300, {});
  assert.equal(rig.decision.stop.latched, true);
  assert.equal(rig.decision.stop.active, false);
  rig.hold(200, { handDistanceM: 0.4 });
  rig.hold(150, { handDistanceM: 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1) });
  assert.equal(rig.decision.distance.active, true, "zoom is available while latched");
});

test("re-posing while latched neither re-fires the pause nor moves the anchor", () => {
  const rig = latched();
  rig.hold(300, {});
  const rePosed = rig.hold(STOP_POSE_STABILITY_MS + 100, STOP_POSE);
  assert.ok(rePosed.every((d) => d.stop.justEngaged === false), "engaging is once per latch");
  assert.ok(rePosed.every((d) => d.stop.setPaused === null));
  // ...and the original anchor still governs the release.
  const low = 1.2 - STOP_RELEASE_DROP_M - 0.05;
  rig.hold(STOP_RELEASE_STABILITY_MS + 100, { leftHandHeightM: low, rightHandHeightM: low });
  assert.equal(rig.decision.stop.latched, false);
});

test("the stop signal is sphere-only and never fires behind a panel or a poke", () => {
  for (const overrides of [
    { appState: APP_STATE_TUNNEL },
    { panelOpen: true },
    { launcherCapturing: true }
  ]) {
    const rig = makeRig(overrides);
    const seen = rig.hold(STOP_POSE_STABILITY_MS + 300, STOP_POSE);
    assert.ok(
      seen.every((d) => d.stop.active === false),
      `${JSON.stringify(overrides)}: no pause`
    );
  }
});

test("one palm away is not the stop pose", () => {
  const rig = makeRig();
  const seen = rig.hold(STOP_POSE_STABILITY_MS + 300, {
    leftPalmForwardDot: 0.95,
    rightPalmForwardDot: 0.1
  });
  assert.ok(seen.every((d) => d.stop.active === false));
});

test("a pinch is not the stop pose, however the palms are turned", () => {
  const rig = makeRig();
  const seen = rig.hold(STOP_POSE_STABILITY_MS + 300, { ...STOP_POSE, leftPinch: true });
  assert.ok(seen.every((d) => d.stop.active === false));
});

// --- the tree: one gesture, read through appState ----------------------------

test("the distance gesture names tunnel speed or sphere zoom by app state", () => {
  for (const [appState, target] of [
    [APP_STATE_TUNNEL, "tunnelSpeed"],
    [APP_STATE_INSIDE_SPHERE, "sphereZoom"]
  ]) {
    const rig = makeRig({ appState });
    rig.hold(200, { handDistanceM: 0.4 });
    rig.hold(100, { handDistanceM: 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1) });
    assert.equal(rig.decision.distance.active, true, appState);
    assert.equal(rig.decision.distance.target, target);
  }
});

test("the distance gesture is refused outside the two navigable states", () => {
  const rig = makeRig({ appState: "transition_to_sphere" });
  rig.hold(300, { handDistanceM: 0.4 });
  const seen = rig.hold(300, { handDistanceM: 0.4 * 1.6 });
  assert.ok(seen.every((d) => d.distance.active === false));
});

test("the distance gesture needs BOTH hands positioned, not merely present", () => {
  const rig = makeRig({ rightPositioned: false });
  rig.hold(300, { handDistanceM: 0.4 });
  const seen = rig.hold(300, { handDistanceM: 0.4 * 1.6 });
  assert.ok(seen.every((d) => d.distance.active === false));
});

// --- the module cannot drift from the app's own enum -------------------------

test("the copied AppState strings still match constants.js", () => {
  const constants = fs.readFileSync(path.join(HERE, "..", "src", "constants.js"), "utf8");
  assert.match(constants, new RegExp(`TUNNEL:\\s*"${APP_STATE_TUNNEL}"`));
  assert.match(constants, new RegExp(`INSIDE_SPHERE:\\s*"${APP_STATE_INSIDE_SPHERE}"`));
});

test("the superseded absolute distance thresholds are gone from constants.js", () => {
  const constants = fs.readFileSync(path.join(HERE, "..", "src", "constants.js"), "utf8");
  assert.ok(
    !/TWO_HAND_GESTURE_(ENGAGE|RELEASE)_DISTANCE\s*=/.test(constants),
    "revision 2 replaces the 0.65 m / 0.9 m model with relative hysteresis"
  );
});

test("microgestures stand down while a direct gesture is engaged", async () => {
  const { resolveMicrogestureAction } = await import("../src/xr-microgestures.js");
  const engaged = resolveMicrogestureAction({
    gesture: "swipeForward",
    appState: APP_STATE_TUNNEL,
    panelOpen: false,
    launcherCapturing: false,
    genAiPending: false,
    directGestureActive: true
  });
  assert.equal(engaged.type, "none");
  assert.equal(engaged.reason, "direct-gesture");

  const idle = resolveMicrogestureAction({
    gesture: "swipeForward",
    appState: APP_STATE_TUNNEL,
    panelOpen: false,
    launcherCapturing: false,
    genAiPending: false,
    directGestureActive: false
  });
  assert.equal(idle.type, "tunnelSpeed");
});

// --- Dropouts and a variable frame rate --------------------------------------
// Everything below is derived from a measurement pass over a real hand-tracking
// diagnostics log (2546 events, 19 sessions, a Quest 3 with real hands). The log
// is not in the repo; the numbers it produced are quoted here and the fixtures
// are synthesised from them.
//
//   * 691 changes to the set of present hand sources.
//   * Per-hand absence gaps: left 196 gaps, median 207 ms, p10 18 ms, min 1 ms;
//     right 185 gaps, median 514 ms, p10 14 ms. 205 gaps under 500 ms.
//   * Both-hands-present runs: 168 of them, p25 58 ms, median 540 ms; 42% are
//     shorter than 250 ms (= DISTANCE_TRACKING_SETTLE_MS) and 51% shorter than
//     570 ms.
//   * Hand sources are `oculus-hand`, buttonCount 10, jointCount 25. The only
//     pressed indices ever observed are 0 (971 records) and 4-9 (52). Index 1
//     NEVER fires on this runtime, so the `buttons[1]` term in input.js's pinch
//     read is inert — noted, not removed, because a different runtime may use it.
//
// A rig that can be stepped at an arbitrary, per-frame dt. The 30 Hz makeRig()
// above cannot express any of the frame-rate questions below.
function makeStepRig(overrides = {}) {
  let gestureState = createHandGestureState();
  let now = 1000;
  let last = null;
  return {
    get decision() {
      return last;
    },
    step(dtMs, input = {}) {
      now += dtMs;
      last = resolveHandGestures(gestureState, { ...BASE, ...overrides, ...input, now });
      gestureState = last.state;
      return last;
    },
    hold(ms, dtMs, input = {}) {
      const seen = [];
      for (let elapsed = 0; elapsed < ms; elapsed += dtMs) {
        seen.push(this.step(dtMs, input));
      }
      return seen;
    }
  };
}

const HZ72_MS = 1000 / 72;
const HZ20_MS = 50;

// --- rule 4's plumbing, on its own -------------------------------------------

test("minWindowSamples states the frame floor every threshold inherits", () => {
  // The property: no window in this file can be satisfied by one long frame.
  for (const thresholdMs of [
    PINCH_DEBOUNCE_MS,
    GENAI_CONFIRM_HOLD_MS,
    DISTANCE_RELEASE_GRACE_MS,
    DISTANCE_TRACKING_SETTLE_MS,
    DISTANCE_COMMIT_MS,
    DISTANCE_REARM_STILL_MS,
    DISTANCE_TRACK_SLOT_MS,
    STOP_POSE_STABILITY_MS,
    STOP_RELEASE_STABILITY_MS,
    STOP_RELEASE_TRACKING_GRACE_MS,
    HAND_DROPOUT_GRACE_MS
  ]) {
    assert.ok(
      minWindowSamples(thresholdMs) >= 2,
      `${thresholdMs} ms must need at least two frames, not one long one`
    );
    assert.equal(minWindowSamples(thresholdMs), Math.ceil(thresholdMs / MAX_GESTURE_STEP_MS));
  }
  assert.equal(minWindowSamples(0), 1);
  assert.equal(minWindowSamples(NaN), 1);
});

test("the gesture clock clamps a long frame and refuses a hitch outright", () => {
  let clock = createFrameClock();
  // Seed: the first frame has no predecessor, so it just anchors.
  let step = stepFrameClock(clock, 1000);
  assert.equal(step.clockMs, 1000);
  assert.equal(step.hitch, false);
  clock = step.state;

  // A steady 72 Hz run. The clock tracks wall time exactly.
  let now = 1000;
  for (let i = 0; i < 12; i += 1) {
    now += HZ72_MS;
    step = stepFrameClock(clock, now);
    clock = step.state;
    assert.equal(step.hitch, false);
  }
  assert.ok(Math.abs(step.clockMs - now) < 1e-6, "no clamping at a healthy rate");

  // One 350 ms loading hitch: far out of line with the median, so it is not
  // evidence and buys no time at all.
  const before = step.clockMs;
  now += 350;
  step = stepFrameClock(clock, now);
  clock = step.state;
  assert.equal(step.hitch, true);
  assert.equal(step.clockMs, before, "a hitch advances nothing");

  // A merely long frame, inside the hitch limit, is clamped rather than dropped.
  const beforeLong = step.clockMs;
  now += 120;
  step = stepFrameClock(clock, now);
  assert.ok(step.clockMs - beforeLong <= MAX_GESTURE_STEP_MS + 1e-9);
});

test("a sustained low frame rate is adapted to, not classified as one long hitch", () => {
  // The failure this guards: if hitch frames were kept out of the median, a
  // session that genuinely settles at 8 Hz would flag every frame forever and
  // the clock would never advance again.
  let clock = createFrameClock();
  let now = 1000;
  let step = stepFrameClock(clock, now);
  clock = step.state;
  for (let i = 0; i < 12; i += 1) {
    now += HZ72_MS;
    clock = stepFrameClock(clock, now).state;
  }
  let hitches = 0;
  for (let i = 0; i < 30; i += 1) {
    now += 125;
    step = stepFrameClock(clock, now);
    clock = step.state;
    if (step.hitch) {
      hitches += 1;
    }
  }
  assert.ok(hitches > 0, "the transition itself is noticed");
  assert.ok(hitches < 12, "but it settles rather than sticking");
  assert.equal(step.hitch, false, "and the last frames are ordinary again");
});

test("medianOf handles both parities and an empty history", () => {
  assert.equal(medianOf([]), 0);
  assert.equal(medianOf([5]), 5);
  assert.equal(medianOf([9, 1, 5]), 5);
  assert.equal(medianOf([4, 1, 3, 2]), 2.5);
});

test("a graced window tells FALSE from UNKNOWN", () => {
  let win = stepGracedWindow(createGracedWindow(), { now: 0, active: true, unknown: false });
  assert.equal(win.sinceMs, 0 || win.sinceMs);
  win = stepGracedWindow(win, { now: 100, active: true, unknown: false });
  const opened = win.sinceMs;
  // Unknown inside the grace holds the clock.
  win = stepGracedWindow(win, { now: 200, active: false, unknown: true });
  assert.equal(win.sinceMs, opened);
  win = stepGracedWindow(win, { now: 200 + HAND_DROPOUT_GRACE_MS, active: false, unknown: true });
  assert.equal(win.sinceMs, opened, "still inside the grace");
  // Past it, it gives up.
  win = stepGracedWindow(win, { now: 400 + HAND_DROPOUT_GRACE_MS, active: false, unknown: true });
  assert.equal(win.sinceMs, 0);
  // And a plain FALSE resets immediately, grace or no grace.
  win = stepGracedWindow(createGracedWindow(), { now: 0, active: true, unknown: false });
  win = stepGracedWindow(win, { now: 10, active: false, unknown: false });
  assert.equal(win.sinceMs, 0);
});

// --- rule 1: a blink is not a release ----------------------------------------

test("a pinch survives a sub-grace dropout without producing an edge", () => {
  const rig = makeRig();
  const pressed = rig.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
  assert.ok(pressed.some((d) => d.select), "the select is up");
  assert.equal(rig.decision.select, true);

  // The right source vanishes. Nothing about the hand changed; we simply cannot
  // see it. p10 of the measured right-hand gaps is 14 ms and the minimum is
  // 1 ms, so this is the common case, not the exotic one.
  const blink = rig.hold(HAND_DROPOUT_GRACE_MS - 60, {
    rightPresent: false,
    rightPositioned: false,
    rightPinch: false
  });
  assert.ok(blink.every((d) => d.select), "the pinch verdict is carried, not re-decided");
  assert.ok(blink.every((d) => d.interacting), "so the dwell stays reset too");

  // Coming back still pressed continues the SAME contact — no new select edge.
  const back = rig.hold(100, { rightPinch: true });
  assert.ok(back.every((d) => d.select));
  assert.ok(
    back.every((d) => d.events.every((e) => e.decision !== "select")),
    "one contact, one select edge"
  );
});

test("a dropout longer than the grace really does release", () => {
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
  const gone = rig.hold(HAND_DROPOUT_GRACE_MS + 200, {
    rightPresent: false,
    rightPositioned: false,
    rightPinch: false
  });
  assert.equal(gone[gone.length - 1].select, false, "silence eventually means gone");
  assert.ok(
    gone.some((d) => d.events.some((e) => e.decision === "presence" && e.outcome === "grace-expired")),
    "and it says so in the diagnostics"
  );
});

// --- rules 1 + 3: THE BUG. GenAI from a left tap alone -----------------------

test("a presence blink cannot fire GenAI without a real select-hand pinch", () => {
  // THE REGRESSION THIS FILE EXISTS FOR: the GenAI chord firing from a LEFT tap
  // alone. Mechanism: the right source disappears for a moment and comes back with
  // button 0 ALREADY pressed while the left source holds button 0 throughout (seen
  // in real logs, with gaps of 136, 206 and 116 ms). If `pinching[select]` goes
  // false -> true across the gap, the arming branch re-runs against the still-held
  // left pinch and ~200 ms later a four-image batch is billed to a user who never
  // pinched right.
  //
  // The user here does right-then-left, which is a SELECT and never a chord.
  for (const gapMs of [116, 136, 206]) {
    const rig = makeRig();
    // Right pinches first...
    rig.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
    // ...then the left joins. Right-then-left bills nobody.
    rig.hold(300, { rightPinch: true, leftPinch: true });
    assert.equal(rig.decision.genAi, false, `${gapMs}: right-then-left is not a chord`);

    // The right source blinks, with the button still down on both sides of it.
    rig.hold(gapMs, {
      rightPresent: false,
      rightPositioned: false,
      rightPinch: false,
      leftPinch: true
    });
    const after = rig.hold(GENAI_CONFIRM_HOLD_MS + 400, { rightPinch: true, leftPinch: true });
    assert.ok(
      after.every((d) => d.genAi === false),
      `${gapMs} ms blink must not manufacture a chord`
    );
  }
});

test("the guard holds for gaps on both sides of the dropout grace", () => {
  // Two different mechanisms cover the two regimes, and this pins which is which
  // so a future change to HAND_DROPOUT_GRACE_MS cannot silently remove one.
  const shortGap = makeRig();
  shortGap.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
  shortGap.hold(200, { rightPinch: true, leftPinch: true });
  shortGap.hold(HAND_DROPOUT_GRACE_MS - 60, { rightPresent: false, rightPinch: false, leftPinch: true });
  // Inside the grace the contact was never interrupted at all.
  assert.equal(shortGap.decision.state.pinch.right.pressed, true);

  const longGap = makeRig();
  longGap.hold(PINCH_DEBOUNCE_MS + 60, { rightPinch: true });
  longGap.hold(200, { rightPinch: true, leftPinch: true });
  longGap.hold(HAND_DROPOUT_GRACE_MS + 200, { rightPresent: false, rightPinch: false, leftPinch: true });
  const back = longGap.hold(GENAI_CONFIRM_HOLD_MS + 400, { rightPinch: true, leftPinch: true });
  // Past the grace the contact really did end — but its restart was never
  // WATCHED, so it cannot arm the chord.
  assert.equal(back[back.length - 1].diag.selectObservedStart, false);
  assert.ok(back.every((d) => d.genAi === false), "an unwatched press bills nobody");
  assert.ok(back.some((d) => d.select), "it is still a perfectly good select");
});

test("one physical chord bills exactly once, blink or no blink", () => {
  // Resolving "exactly once per chord" must not rest on `!pinching[selectHand]`,
  // which a dropout produces for free; what stops a repeat bill downstream is
  // `genAiPending`.
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 120, { leftPinch: true });
  const first = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });
  assert.equal(first.filter((d) => d.genAi).length, 1, "it fires once");

  // Now the select hand blinks and comes back, still pinched, still with the
  // rotate pinch held. Nothing physical happened.
  rig.hold(80, { leftPinch: true, rightPresent: false, rightPositioned: false, rightPinch: false });
  const second = rig.hold(GENAI_CONFIRM_HOLD_MS + 400, { leftPinch: true, rightPinch: true });
  assert.ok(second.every((d) => d.genAi === false), "and only once");
  assert.equal(second[second.length - 1].diag.chordSpent, true);

  // An OBSERVED release re-arms it, because that is a real second chord.
  rig.hold(200, { leftPinch: true });
  const third = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });
  assert.ok(third.some((d) => d.genAi), "a deliberate second chord still works");
});

// --- rule 2: the chord is ordered by timestamp, not by frame -----------------

test("the chord means the same thing at 72 Hz and at 20 Hz", () => {
  // `wasPinching[rotate] && pinching[rotate]` would encode "strictly earlier" as
  // "true on the previous EVALUATION", i.e. one frame period (13.9 ms at 72 Hz,
  // 50 ms at 20 Hz), so the same two-handed pinch would be GenAI or Select
  // depending on the frame rate.
  for (const dtMs of [HZ72_MS, HZ20_MS]) {
    // A deliberate chord: the rotate pinch leads by comfortably more than
    // CHORD_LEAD_MS.
    const deliberate = makeStepRig();
    deliberate.hold(CHORD_LEAD_MS + 200, dtMs, { leftPinch: true });
    const fired = deliberate.hold(GENAI_CONFIRM_HOLD_MS + 400, dtMs, {
      leftPinch: true,
      rightPinch: true
    });
    assert.ok(fired.some((d) => d.genAi), `${Math.round(1000 / dtMs)} Hz: a real chord fires`);

    // A near-simultaneous grab: one frame apart, whatever a frame is worth.
    const together = makeStepRig();
    together.step(dtMs, { leftPinch: true });
    const notAChord = together.hold(GENAI_CONFIRM_HOLD_MS + 400, dtMs, {
      leftPinch: true,
      rightPinch: true
    });
    assert.ok(
      notAChord.every((d) => d.genAi === false),
      `${Math.round(1000 / dtMs)} Hz: one frame of lead is not a chord`
    );
    assert.ok(notAChord.some((d) => d.select), "it reads as the select it looks like");
  }
});

test("an exact tie resolves to Select, deliberately", () => {
  // The tie is a CHOICE rather than an artefact of the frame period, and the choice
  // is the reading that cannot spend money.
  const rig = makeStepRig();
  const seen = rig.hold(GENAI_CONFIRM_HOLD_MS + 400, HZ72_MS, {
    leftPinch: true,
    rightPinch: true
  });
  assert.ok(seen.every((d) => d.genAi === false));
  assert.ok(seen.some((d) => d.select));
  assert.equal(seen[seen.length - 1].diag.chordLeadMs, 0, "a tie is a zero lead, not a missing one");
});

test("the lead required is CHORD_LEAD_MS, not a frame", () => {
  const justUnder = makeStepRig();
  justUnder.hold(CHORD_LEAD_MS - 30, 10, { leftPinch: true });
  const under = justUnder.hold(GENAI_CONFIRM_HOLD_MS + 400, 10, { leftPinch: true, rightPinch: true });
  assert.ok(under.every((d) => d.genAi === false), "under the lead is a select");

  const justOver = makeStepRig();
  justOver.hold(CHORD_LEAD_MS + 30, 10, { leftPinch: true });
  const over = justOver.hold(GENAI_CONFIRM_HOLD_MS + 400, 10, { leftPinch: true, rightPinch: true });
  assert.ok(over.some((d) => d.genAi), "over it is a chord");
});

// --- rule 4: a long frame is not a long hold ---------------------------------

test("no gesture threshold can be satisfied by a single long frame", () => {
  // One 350 ms loading hitch must not satisfy GENAI_CONFIRM_HOLD_MS (200),
  // DISTANCE_COMMIT_MS (320) and STOP_POSE_STABILITY_MS (250) in ONE sample.

  // The money guard.
  const chord = makeStepRig();
  chord.hold(CHORD_LEAD_MS + 200, HZ72_MS, { leftPinch: true });
  chord.hold(PINCH_DEBOUNCE_MS + 40, HZ72_MS, { leftPinch: true, rightPinch: true });
  assert.equal(chord.decision.diag.chordArmed, true, "armed, and waiting on the hold");
  const hitch = chord.step(350, { leftPinch: true, rightPinch: true });
  assert.equal(hitch.diag.hitch, true, "the frame is recognised as a stall");
  assert.equal(hitch.genAi, false, "a stall is not a confirm hold");
  // ...and it still fires once real frames deliver the evidence.
  const later = chord.hold(GENAI_CONFIRM_HOLD_MS + 200, HZ72_MS, { leftPinch: true, rightPinch: true });
  assert.ok(later.some((d) => d.genAi), "the chord is deferred, not cancelled");

  // The stop signal's stability window.
  const stop = makeStepRig();
  stop.step(HZ72_MS, STOP_POSE);
  const stopHitch = stop.step(350, STOP_POSE);
  assert.equal(stopHitch.stop.active, false, "a stall is not a held pose");
  assert.equal(stopHitch.stop.latched, false);
});

test("the pinch debounce keeps a frame floor as well as a millisecond one", () => {
  // PINCH_DEBOUNCE_MS is sized against a disturbance counted in FRAMES ("1-3
  // frames at 30 Hz"), so at a low rate the millisecond figure alone stops
  // meaning what it says: at 20 Hz, 80 ms is two samples.
  const rig = makeStepRig();
  const early = rig.hold(PINCH_DEBOUNCE_MS + 20, HZ20_MS, { rightPinch: true });
  assert.ok(
    early.filter((d) => d.select).length === 0
      || early.findIndex((d) => d.select) >= PINCH_DEBOUNCE_MIN_SAMPLES - 1,
    "no select before the frame floor is met"
  );
  const settled = rig.hold(200, HZ20_MS, { rightPinch: true });
  assert.ok(settled.some((d) => d.select), "and it does still select");
});

// --- rule 5: the settle gates tolerate a blink -------------------------------

test("the distance settle gate survives a blink instead of restarting", () => {
  // 42% of the measured both-hands-present runs are shorter than
  // DISTANCE_TRACKING_SETTLE_MS, so a gate that zeroed on one bad frame would
  // almost never open on the real stream.
  const rig = makeRig();
  rig.hold(DISTANCE_TRACKING_SETTLE_MS - 80, { handDistanceM: 0.4 });
  // One unpositioned frame in the middle of the settle.
  rig.step({ leftPositioned: false, handDistanceM: NaN });
  rig.hold(120, { handDistanceM: 0.4 });
  const spread = rig.hold(120, { handDistanceM: 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1) });
  assert.ok(spread.some((d) => d.distance.active), "the blink did not reset the gate");
});

test("a real loss of tracking still closes the settle gate", () => {
  const rig = makeRig();
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 200, { handDistanceM: 0.4 });
  rig.hold(HAND_DROPOUT_GRACE_MS + 120, {
    leftPositioned: false,
    leftPresent: false,
    handDistanceM: NaN
  });
  const tooSoon = rig.hold(DISTANCE_TRACKING_SETTLE_MS - 120, { handDistanceM: 0.5 });
  assert.ok(tooSoon.every((d) => d.distance.active === false), "the gate really did close");
});

test("the stop pose's stability window is graced too", () => {
  const rig = makeRig();
  rig.hold(STOP_POSE_STABILITY_MS - 100, STOP_POSE);
  // Both hands blink out mid-pose: unreadable palms, no positions.
  rig.step({ leftPositioned: false, rightPositioned: false, handDistanceM: NaN });
  const back = rig.hold(160, STOP_POSE);
  assert.ok(back.some((d) => d.stop.latched), "a blink does not restart the pose window");
});

// --- rule 6: the diagnostics event -------------------------------------------

test("decision edges are emitted once, with the reason and the context", () => {
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 120, { leftPinch: true });
  const chord = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });

  const fired = chord.flatMap((d) => d.events).filter(
    (e) => e.decision === "chord" && e.outcome === "fired"
  );
  assert.equal(fired.length, 1, "one line per decision, never per frame");
  assert.equal(typeof fired[0].note, "string");

  const armed = chord.flatMap((d) => d.events).filter(
    (e) => e.decision === "chord" && e.outcome === "armed"
  );
  assert.equal(armed.length, 1);
  assert.ok(armed[0].leadMs >= CHORD_LEAD_MS, "the line carries the lead it measured");

  // The overwhelming majority of frames say nothing at all.
  const quiet = rig.hold(400, { leftPinch: true, rightPinch: true });
  assert.ok(quiet.every((d) => d.events.length === 0), "no per-frame chatter");

  // And the context block is complete enough to diagnose from one line.
  const diag = rig.decision.diag;
  for (const key of [
    "selectHand", "rotateHand", "present", "pinching", "rawPinch", "graceHeld",
    "pinchStartMs", "chordLeadMs", "chordArmed", "chordSpent", "selectObservedStart",
    "bothPositioned", "handsTrackedMs", "appState", "panelOpen", "launcherCapturing",
    "genAiPending", "dtMs", "medianDtMs", "hitch"
  ]) {
    assert.ok(key in diag, `diag.${key} is what stops the next round of guessing`);
  }
});

test("a refusal is reported with the reason it was refused", () => {
  const rig = makeRig({ genAiPending: true });
  rig.hold(PINCH_DEBOUNCE_MS + 120, { leftPinch: true });
  const chord = rig.hold(GENAI_CONFIRM_HOLD_MS + 200, { leftPinch: true, rightPinch: true });
  const ignored = chord.flatMap((d) => d.events).filter(
    (e) => e.decision === "chord" && e.outcome === "ignored"
  );
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].reason, "genai-pending");
});

// ============================================================================
// A PINCH IS A GRAB.
// Hold the sphere still and it stops; throw it and it spins again; the distance
// gesture only hears horizontal, and only inside the viewport.
// ============================================================================

// --- the brake ---------------------------------------------------------------

test("an ENGAGED drag held inside the deadzone brakes the sphere", () => {
  // An engaged drag inside the rotate deadzones gives zero deflection, which the
  // sphere reads as "no rotation input", so the auto-drift would keep turning under
  // a hand the user believes is holding it still.
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  assert.equal(rig.decision.rotate.active, true, "the drag engaged");
  assert.equal(rig.decision.rotate.braking, false, "and does not brake instantly");

  const seen = rig.hold(ROTATE_BRAKE_HOLD_MS + 120, {
    leftPinch: true,
    // Inside the deadzone on both axes, i.e. a hand parked on the anchor.
    rotateLateralM: ROTATE_YAW_DEADZONE_M * 0.4,
    rotateVerticalM: -ROTATE_PITCH_DEADZONE_M * 0.4
  });
  const braked = seen.filter((d) => d.rotate.braking);
  assert.ok(braked.length > 0, "the hold brakes");
  assert.equal(braked[0].stop.setPaused, true, "and pauses the auto-drift");
  assert.equal(braked[0].stop.pauseSource, "brake", "through the one pause channel");

  // The pause is written ONCE, on the rising edge — the level stays true but
  // input.js must not be told again every frame.
  const brakeEvents = seen.flatMap((d) => d.events)
    .filter((e) => e.decision === "rotate" && e.outcome === "braking");
  assert.equal(brakeEvents.length, 1, "one edge, not one per frame");
  assert.ok(
    seen.filter((d) => d.rotate.braking).slice(1).every((d) => d.stop.setPaused === null),
    "and it stops writing once it has written"
  );
});

test("the brake needs the FULL hold, not a moment inside the deadzone", () => {
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true, rotateLateralM: 0.1 });
  // A drag that reverses passes through the deadzone on its way. 100 ms of that
  // must not kill the momentum.
  const passing = rig.hold(100, { leftPinch: true, rotateLateralM: 0 });
  assert.ok(passing.every((d) => d.rotate.braking === false), "a crossing is not a hold");
  const away = rig.hold(200, { leftPinch: true, rotateLateralM: -0.1 });
  assert.ok(away.every((d) => d.rotate.braking === false), "and the clock restarted");
});

test("a drag OUTSIDE the deadzone never brakes, however long it is held", () => {
  const rig = makeRig();
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const seen = rig.hold(1200, { leftPinch: true, rotateLateralM: ROTATE_YAW_FULL_DEFLECTION_M });
  assert.ok(seen.every((d) => d.rotate.braking === false));
  assert.ok(seen.every((d) => d.stop.setPaused !== true), "and pauses nothing");
});

test("a pinch that is NOT an engaged drag never brakes", () => {
  // Every reason the drag stands down is also a reason the brake must: it is
  // one gesture, and a pinch behind a panel is not a hand on the sphere.
  for (const overrides of [
    { appState: APP_STATE_TUNNEL },
    { panelOpen: true },
    { launcherCapturing: true },
    { rotatePalmUp: true }
  ]) {
    const rig = makeRig(overrides);
    const seen = rig.hold(ROTATE_BRAKE_HOLD_MS + 400, { leftPinch: true });
    assert.ok(
      seen.every((d) => d.rotate.braking === false),
      `${JSON.stringify(overrides)}: no brake`
    );
    assert.ok(
      seen.every((d) => d.stop.setPaused !== true),
      `${JSON.stringify(overrides)}: and no pause`
    );
  }
});

// --- the throw ---------------------------------------------------------------

// Drive an already-engaged drag at a constant hand speed, returning every
// decision. `perFrameM` is metres of displacement added per 30 Hz frame, so
// 0.008 is ~0.24 m/s (exploring) and 0.04 is ~1.2 m/s (a fling).
function dragAt(rig, perFrameM, frames, input = {}) {
  const seen = [];
  let lateral = rig.lastLateralM || 0;
  for (let i = 0; i < frames; i += 1) {
    lateral += perFrameM;
    seen.push(rig.step({ leftPinch: true, rotateLateralM: lateral, ...input }));
  }
  rig.lastLateralM = lateral;
  return seen;
}

test("a slow long drag explores and KEEPS the pause; a fast flick hands rotation back", () => {
  // A small pinch-and-drag stays paused in rotation, but a lot of it lets rotation
  // continue. The discriminator is VELOCITY, not distance travelled, which is why
  // both halves of this test travel a comparable distance.
  const slow = makeRig({ sphereRotationPaused: true });
  slow.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const exploring = dragAt(slow, 0.008, 30);
  const travelled = exploring[exploring.length - 1].rotate.travelM;
  assert.ok(travelled > 0.2, `a long drag: ${travelled.toFixed(3)} m`);
  assert.ok(exploring.every((d) => d.rotate.thrown === false), "no throw");
  assert.ok(
    exploring.every((d) => d.stop.setPaused !== false),
    "and the pause survives the whole sweep"
  );

  const fast = makeRig({ sphereRotationPaused: true });
  fast.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const flick = dragAt(fast, 0.04, 8);
  const thrown = flick.filter((d) => d.rotate.thrown);
  assert.equal(thrown.length, 1, "one fling, one throw");
  assert.equal(thrown[0].stop.setPaused, false, "rotation is handed back");
  assert.equal(thrown[0].stop.pauseSource, "throw");
  assert.ok(
    thrown[0].rotate.speedMps >= ROTATE_THROW_SPEED_MPS,
    "and it was above the threshold when it fired"
  );
});

test("a throw is the THIRD release of the stop latch, not a second kind of pause", () => {
  // An incidental left pinch must not resume. A deliberate fling is a different
  // statement, and it releases the same latch "both hands down" and "both hands
  // lost" release.
  const rig = makeRig();
  rig.hold(STOP_POSE_STABILITY_MS + 100, STOP_POSE);
  assert.equal(rig.decision.stop.latched, true, "the latch is up");

  // Pinching does not release it.
  const holding = rig.hold(PINCH_DEBOUNCE_MS + 60, {
    leftPinch: true,
    sphereRotationPaused: true
  });
  assert.ok(holding.every((d) => d.stop.latched), "a pinch alone does not resume");

  const flick = dragAt(rig, 0.04, 8, { sphereRotationPaused: true });
  const released = flick.find((d) => d.stop.justReleased);
  assert.ok(released, "the throw released it");
  assert.equal(released.stop.releaseReason, "thrown");
  assert.equal(released.stop.setPaused, false);
  assert.equal(released.stop.latched, false);
  const event = released.events.find((e) => e.outcome === "thrown");
  assert.ok(event, "and it is on the wire");
  assert.equal(event.reason, "stop-latch");
});

test("one fling is one throw, until the hand slows down again", () => {
  const rig = makeRig({ sphereRotationPaused: true });
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const sweep = dragAt(rig, 0.04, 24);
  assert.equal(
    sweep.filter((d) => d.rotate.thrown).length,
    1,
    "a long fast sweep is not a stream of throws"
  );
  // Stop the hand: the Schmitt lower bound re-arms it.
  const still = dragAt(rig, 0, 6);
  assert.ok(still.every((d) => d.rotate.thrown === false));
  const again = dragAt(rig, 0.04, 8);
  assert.equal(again.filter((d) => d.rotate.thrown).length, 1, "a second fling re-arms");
});

// A recognised throw must act even when rotation is already running, not only as
// the stop latch's third exit; otherwise it logs `outcome:"ignored"
// reason:"not-paused"`. The threshold was never the problem, the action was.
test("a throw with NOTHING paused still imparts momentum", () => {
  const rig = makeRig({ sphereRotationPaused: false });
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  // ~1.2 m/s, squarely inside the 1.0-2.2 m/s band measured on real throws.
  const flick = dragAt(rig, 0.04, 8);
  const thrown = flick.find((d) => d.rotate.thrown);
  assert.ok(thrown, "the throw is recognised");
  assert.ok(thrown.rotate.throwSpin, "and it produces spin");
  assert.ok(Math.abs(thrown.rotate.throwSpin.yawRadPerS) > 0.5, "a real amount of it");
  assert.equal(thrown.stop.setPaused, null, "without touching a pause that does not exist");
  const event = thrown.events.find((e) => e.decision === "rotate" && e.outcome === "thrown");
  assert.ok(event, "and it is on the wire as a throw, not as a refusal");
  assert.equal(event.reason, "momentum");
  assert.ok(
    !thrown.events.some((e) => e.reason === "not-paused"),
    "the 'ignored / not-paused' branch is gone"
  );
});

test("a throw at 1.4 m/s is worth about a full-deflection drag", () => {
  // The calibration. 30 Hz frames, so 1.4 m/s is 1.4/30 m per frame.
  const rig = makeRig({ sphereRotationPaused: false });
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const flick = dragAt(rig, 1.4 / 30, 8);
  const thrown = flick.find((d) => d.rotate.thrown);
  assert.ok(thrown, "1.4 m/s is a throw");
  assert.ok(Math.abs(thrown.rotate.speedMps - 1.4) < 0.05, "measured at ~1.4 m/s");
  const spin = Math.abs(thrown.rotate.throwSpin.yawRadPerS);
  const expected = Math.min(1.4 * ROTATE_THROW_SPIN_GAIN_RAD_PER_MPS, ROTATE_THROW_SPIN_MAX_RAD_PER_S);
  assert.ok(Math.abs(spin - expected) < 0.05, `${spin.toFixed(2)} rad/s`);
  assert.ok(spin > 1.5 && spin < 2.5, "i.e. about what a full-deflection drag commands");
});

test("the flung speed scales with the throw and is clamped", () => {
  const spinFor = (mps) => {
    const rig = makeRig({ sphereRotationPaused: false });
    rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
    const thrown = dragAt(rig, mps / 30, 10).find((d) => d.rotate.thrown);
    assert.ok(thrown, `${mps} m/s throws`);
    return Math.abs(thrown.rotate.throwSpin.yawRadPerS);
  };
  const gentle = spinFor(0.9);
  const firm = spinFor(1.6);
  assert.ok(firm > gentle, "harder throw, faster spin");
  // ...and no harder than the ceiling, however violent the fling.
  assert.ok(spinFor(6) <= ROTATE_THROW_SPIN_MAX_RAD_PER_S + 1e-9, "clamped");
});

test("the thrown direction matches the drag direction, on both axes", () => {
  // The rotation continues in the direction of the hand throw. The signs mirror
  // applyHandRotateDrag(): a drag to the RIGHT (positive lateral) is NEGATIVE yaw,
  // a drag UP is positive pitch.
  const throwWith = (perFrameLateral, perFrameVertical) => {
    const rig = makeRig({ sphereRotationPaused: false });
    rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
    let lateral = 0;
    let vertical = 0;
    let thrown = null;
    for (let i = 0; i < 10 && !thrown; i += 1) {
      lateral += perFrameLateral;
      vertical += perFrameVertical;
      const d = rig.step({ leftPinch: true, rotateLateralM: lateral, rotateVerticalM: vertical });
      if (d.rotate.thrown) {
        thrown = d;
      }
    }
    assert.ok(thrown, "it threw");
    return thrown.rotate.throwSpin;
  };

  assert.ok(throwWith(0.04, 0).yawRadPerS < 0, "rightward fling -> negative yaw");
  assert.ok(throwWith(-0.04, 0).yawRadPerS > 0, "leftward fling -> positive yaw");
  // ...and the mirror image is genuinely the mirror image, not a second rule.
  assert.ok(
    Math.abs(throwWith(0.04, 0).yawRadPerS + throwWith(-0.04, 0).yawRadPerS) < 1e-9
  );
  assert.ok(throwWith(0, 0.04).pitchRadPerS > 0, "upward fling -> positive pitch");
  assert.ok(throwWith(0, -0.04).pitchRadPerS < 0, "downward fling -> negative pitch");
  // A diagonal splits between the axes rather than picking one.
  const diagonal = throwWith(0.03, 0.03);
  assert.ok(diagonal.yawRadPerS < 0 && diagonal.pitchRadPerS > 0, "both axes carry it");
});

test("a throw that ALSO has a pause to release still does both", () => {
  // Releasing the pause is still one of a throw's effects, just not the only one.
  const rig = makeRig({ sphereRotationPaused: true });
  rig.hold(PINCH_DEBOUNCE_MS + 40, { leftPinch: true });
  const thrown = dragAt(rig, 0.04, 8, { sphereRotationPaused: true })
    .find((d) => d.rotate.thrown);
  assert.ok(thrown);
  assert.equal(thrown.stop.setPaused, false, "rotation is handed back");
  assert.equal(thrown.stop.pauseSource, "throw");
  assert.ok(thrown.rotate.throwSpin, "AND it spins");
  const event = thrown.events.find((e) => e.outcome === "thrown");
  assert.equal(event.reason, "was-paused");
});

test("input.js feeds the throw into the existing rotation path, after the drag", () => {
  // Not a parallel mechanism: the same two speeds the drag and the sticks
  // write. Ordering matters — stepHandDragSpeed() is a smoother chasing the
  // hand's current displacement, so a throw applied BEFORE it would be eaten.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const dragCall = input.indexOf("applyHandRotateDrag(handGesture.rotate,");
  const spinWrite = input.indexOf("handGesture.rotate.throwSpin.yawRadPerS");
  assert.ok(dragCall > 0 && spinWrite > dragCall, "the throw is applied after the drag");
  assert.match(
    input,
    /state\.sphereYRotSpeed = handGesture\.rotate\.throwSpin\.yawRadPerS;/,
    "into the same speed the drag steers"
  );
  assert.match(
    input,
    /state\.sphereXRotSpeed = handGesture\.rotate\.throwSpin\.pitchRadPerS;/
  );
  // It also points the idle drift the same way, so the sphere carries on rather
  // than reversing once the momentum decays.
  assert.match(
    input,
    /setSphereDriftDirectionFromRotation\(\s*\n\s*handGesture\.rotate\.throwSpin\.yawRadPerS,/
  );
});

test("sphere.js signs the idle drift, and stands it down under a steering hand", () => {
  // Existing inertial rotation of the sphere must not override the hand gesture
  // (it would sometimes go back in the other direction).
  const sphere = fs.readFileSync(path.join(HERE, "..", "src", "sphere.js"), "utf8");
  assert.match(
    sphere,
    /const autoDelta = SPHERE_BASE_ROTATION_SPEED\s*\n\s*\* state\.sphereDriftDirection\s*\n\s*\* state\.sphereDriftGain\s*\n\s*\* dt;/,
    "the drift carries a direction AND a gain"
  );
  // Standing down under a steering hand is stepDriftResume()'s `grabbed` input
  // rather than a branch condition, so it can also hold the gain at zero for a
  // while AFTER the hand lets go.
  assert.match(sphere, /grabbed: state\.sphereRotationInputActive,/);
  assert.match(sphere, /paused: state\.sphereRotationPaused,/);
  // The direction is a +/-1 multiplier, chosen against the constant's own sign,
  // so the magnitude stays a single look-and-feel decision — and the CHOICE
  // itself lives in the pure module, which is what the tests below can reach.
  assert.match(
    sphere,
    /driftDirectionAfterRotation\(\s*\n\s*yawSpeed,\s*\n\s*pitchSpeed,\s*\n\s*SPHERE_BASE_ROTATION_SPEED\s*\n\s*\)/
  );
  // ...and a fresh sphere forgets the last one's throw.
  assert.match(sphere, /state\.sphereDriftDirection = 1;/);

  // An ENGAGED drag claims the frame even when it commands zero speed: a hand
  // parked on the anchor is holding the sphere still, and the drift turning
  // underneath it is the failure.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const drag = input.slice(input.indexOf("function applyHandRotateDrag("));
  const body = drag.slice(0, drag.indexOf("\nfunction "));
  assert.match(
    body,
    /if \(!rotate\.active\) \{\s*\n\s*return;\s*\n\s*\}[\s\S]{0,900}?state\.sphereRotationInputActive = true;/,
    "claimed unconditionally on every engaged frame"
  );
});

// --- the release is not countered, and both axes are easy --------------------

// The post-release model, read out of sphere.js rather than restated here, so
// the numbers this file reasons about cannot drift away from the ones the app
// runs: the manual speed decays while the idle drift, which does not decay at
// all, is added underneath it.
const SPHERE_SRC = fs.readFileSync(path.join(HERE, "..", "src", "sphere.js"), "utf8");
const CONSTANTS_SRC = fs.readFileSync(path.join(HERE, "..", "src", "constants.js"), "utf8");
const BASE_DRIFT_RAD_PER_S = Number(
  /const SPHERE_BASE_ROTATION_SPEED = (-?[\d.]+);/.exec(SPHERE_SRC)[1]
);
// THE COAST IS TIME-BASED: exp(-dt/tau), with the tau chosen by whoever wrote the
// speed, so the simulations below take the tau as an argument. A legacy fixed
// 0.95-per-FRAME factor survives in exactly one place: the demonstration of the
// bug it caused, which would not reproduce under the time-based decay.
const LEGACY_DECAY_PER_FRAME = 0.95;
const YAW_SPEED_MAX = Number(
  /export const HAND_SPHERE_YAW_SPEED_MAX = ([\d.]+);/.exec(CONSTANTS_SRC)[1]
);
const PITCH_SPEED_MAX = Number(
  /export const HAND_SPHERE_PITCH_SPEED_MAX = ([\d.]+);/.exec(CONSTANTS_SRC)[1]
);

// What the viewer sees after the pinch opens: the decaying manual speed plus
// the drift, frame by frame at 72 Hz. A hand release hands the sphere the THROW
// time constant, so that is the default here; the drift is added at full
// magnitude from the first frame, which is deliberately pessimistic (the real
// one is gated and ramped — see stepDriftResume() and the end-to-end test).
function coastAfterRelease(
  releaseSpeed,
  driftDirection,
  frames = 400,
  tauS = SPHERE_COAST_TAU_HAND_THROW_S
) {
  let speed = releaseSpeed;
  const net = [];
  for (let i = 0; i < frames; i += 1) {
    speed = stepCoastSpeed(speed, { dtS: FRAME_S, tauS });
    net.push(speed + (BASE_DRIFT_RAD_PER_S * driftDirection));
  }
  return net;
}

// The same coast under the legacy per-frame decay, kept for the one test that
// documents the bug it caused.
function legacyCoastAfterRelease(releaseSpeed, driftDirection, frames = 400) {
  let speed = releaseSpeed;
  const net = [];
  for (let i = 0; i < frames; i += 1) {
    speed *= LEGACY_DECAY_PER_FRAME;
    net.push(speed + (BASE_DRIFT_RAD_PER_S * driftDirection));
  }
  return net;
}

test("the drift direction follows the axis the release was actually moving in", () => {
  // Yaw-dominant, both ways round. The answer is the multiplier that makes
  // SPHERE_BASE_ROTATION_SPEED agree in sign with the hand.
  assert.equal(driftDirectionAfterRotation(1.2, 0, BASE_DRIFT_RAD_PER_S), -1);
  assert.equal(driftDirectionAfterRotation(-1.2, 0, BASE_DRIFT_RAD_PER_S), 1);
  // Pitch-dominant: the drift is ONE signed scalar applied to both iris axes,
  // so a diagonal cannot satisfy both — it follows the larger component, which
  // is the one the user would notice reversing.
  assert.equal(driftDirectionAfterRotation(0.05, -0.9, BASE_DRIFT_RAD_PER_S), 1);
  assert.equal(driftDirectionAfterRotation(0.05, 0.9, BASE_DRIFT_RAD_PER_S), -1);
  // A tie goes to yaw, deliberately — it is the axis with the shorter travel
  // and the one a sweep is usually about.
  assert.equal(driftDirectionAfterRotation(0.4, -0.4, BASE_DRIFT_RAD_PER_S), -1);
  // NO OPINION. A release with nothing left in it says nothing about which way
  // the sphere should drift, which is what makes the BRAKE safe to route
  // through the same call: it lets go at zero.
  assert.equal(driftDirectionAfterRotation(0, 0, BASE_DRIFT_RAD_PER_S), 0);
  assert.equal(driftDirectionAfterRotation(NaN, undefined, BASE_DRIFT_RAD_PER_S), 0);
  assert.equal(driftDirectionAfterRotation(1.2, 0, 0), 0);
});

test("a plain release coasts the way the hand was going and never reverses", () => {
  for (const [yaw, pitch] of [[1.4, 0], [-1.4, 0], [0.1, 1.1], [0.1, -1.1], [0.6, 0.6]]) {
    const dominant = Math.abs(yaw) >= Math.abs(pitch) ? yaw : pitch;
    const direction = driftDirectionAfterRotation(yaw, pitch, BASE_DRIFT_RAD_PER_S);
    const net = coastAfterRelease(dominant, direction);
    assert.ok(
      net.every((v) => Math.sign(v) === Math.sign(dominant)),
      `release ${yaw}/${pitch}: the sphere never crosses back the other way`
    );
    // ...and it does settle rather than running on at the release speed.
    assert.ok(Math.abs(net[net.length - 1]) < Math.abs(dominant));
  }
});

test("...which is a real change: the un-aimed drift DID reverse half of them", () => {
  // The teeth in the test above. If a plain drag never touched
  // state.sphereDriftDirection, the drift would resume in its default sense at full
  // magnitude while the manual speed decayed, and inside about half a second the
  // constant term won. Simulated under the legacy decay (0.95/frame) because the
  // longer time-based coast hides that symptom.
  const net = legacyCoastAfterRelease(1.4, 1);
  assert.ok(net.some((v) => v < 0), "the old behaviour turns the sphere back");
  const flipFrame = net.findIndex((v) => v < 0);
  assert.ok(flipFrame / 72 < 1, `and quickly: ${(flipFrame / 72).toFixed(2)} s`);
  // A drag that happened to agree with the default drift always looked fine, which
  // is why the symptom was "sometimes".
  assert.ok(legacyCoastAfterRelease(-1.4, 1).every((v) => v < 0));
});

// --- the throw goes somewhere ------------------------------------------------
// The handoff must not be eaten by a decay that is too short: flicks have to spin
// the sphere after a grab.

// How far the sphere actually turns after a release, in radians, integrating the
// same way sphere.js does: apply this frame's delta at the current speed, then
// decay.
function coastTravelRad(releaseSpeed, tauS, dtS, seconds = 15) {
  let speed = releaseSpeed;
  let angle = 0;
  const frames = Math.round(seconds / dtS);
  for (let i = 0; i < frames; i += 1) {
    angle += speed * dtS;
    speed = stepCoastSpeed(speed, { dtS, tauS });
  }
  return angle;
}

// ...and the speed left after `seconds`, counted in whole frames so the two
// frame rates cover exactly the same wall-clock second.
function coastSpeedAfter(releaseSpeed, tauS, dtS, seconds) {
  let speed = releaseSpeed;
  const frames = Math.round(seconds / dtS);
  for (let i = 0; i < frames; i += 1) {
    speed = stepCoastSpeed(speed, { dtS, tauS });
  }
  return speed;
}

test("the coast is TIME-BASED: 72 Hz and 90 Hz agree, the old one did not", () => {
  // A 90 Hz headset (median dt 11 ms) would stop 2.5x sooner than a 72 Hz one under
  // a per-frame factor. Nothing about how a throw feels should depend on the frame
  // rate.
  const seconds = 1;
  for (const tauS of [SPHERE_COAST_TAU_STICK_S, SPHERE_COAST_TAU_HAND_THROW_S]) {
    const at72 = coastSpeedAfter(2, tauS, 1 / 72, seconds);
    const at90 = coastSpeedAfter(2, tauS, 1 / 90, seconds);
    assert.ok(
      Math.abs(at72 - at90) < 1e-9,
      `tau ${tauS}: ${at72.toFixed(6)} vs ${at90.toFixed(6)} rad/s after 1 s`
    );
    // ...and the same is true of the distance travelled, to within a frame.
    const travel72 = coastTravelRad(2, tauS, 1 / 72, 8);
    const travel90 = coastTravelRad(2, tauS, 1 / 90, 8);
    assert.ok(Math.abs(travel72 - travel90) < 0.02);
  }
  // THE TEETH: the legacy per-frame model.
  const legacy72 = 2 * (LEGACY_DECAY_PER_FRAME ** 72);
  const legacy90 = 2 * (LEGACY_DECAY_PER_FRAME ** 90);
  assert.ok(legacy72 / legacy90 > 2, "the old decay was 2.5x faster at 90 Hz");
});

test("a hand throw coasts about omega*tau — a flick crosses the sphere", () => {
  // The number that decides whether a flick reads as a throw at all. At
  // tau 2.2 s a 2 rad/s release travels 4.4 rad: two thirds of a turn, past
  // several panels, fading into the drift rather than stopping dead.
  for (const omega of [0.5, 1, 2, 3]) {
    const travel = coastTravelRad(omega, SPHERE_COAST_TAU_HAND_THROW_S, 1 / 90);
    const expected = omega * SPHERE_COAST_TAU_HAND_THROW_S;
    assert.ok(
      Math.abs(travel - expected) < expected * 0.03,
      `${omega} rad/s -> ${travel.toFixed(2)} rad (expected ~${expected.toFixed(2)})`
    );
  }
  assert.ok(coastTravelRad(2, SPHERE_COAST_TAU_HAND_THROW_S, 1 / 90) > 4);
  // THE TEETH: the same 2 rad/s handoff under the legacy decay at 90 Hz moves the
  // sphere less than half a radian, under a panel's width, and is gone in half a
  // second.
  let legacySpeed = 2;
  let legacyTravel = 0;
  for (let t = 0; t < 15; t += 1 / 90) {
    legacyTravel += legacySpeed * (1 / 90);
    legacySpeed *= LEGACY_DECAY_PER_FRAME;
  }
  assert.ok(legacyTravel < 0.5, `the old coast: ${legacyTravel.toFixed(2)} rad`);
});

test("the STICK's coast is the old one, to within a frame — nothing to relearn", () => {
  // The stick feel stays put: 0.22 s IS 0.95 per frame at 90 Hz.
  const perFrame90 = Math.exp(-(1 / 90) / SPHERE_COAST_TAU_STICK_S);
  assert.ok(
    Math.abs(perFrame90 - LEGACY_DECAY_PER_FRAME) < 0.005,
    `${perFrame90.toFixed(4)} vs ${LEGACY_DECAY_PER_FRAME}`
  );
  // Over half a second — long enough for the difference to show if there were
  // one — the two models are within 5 % of each other.
  let stick = 3;
  let legacy = 3;
  for (let t = 0; t < 0.5; t += 1 / 90) {
    stick = stepCoastSpeed(stick, { dtS: 1 / 90, tauS: SPHERE_COAST_TAU_STICK_S });
    legacy *= LEGACY_DECAY_PER_FRAME;
  }
  assert.ok(Math.abs(stick - legacy) < 0.05 * 3);
  // And it is an order of magnitude shorter than the throw's, which is the
  // point of having two: a spring-centred stick with a 2.2 s tail reads as lag.
  assert.ok(SPHERE_COAST_TAU_HAND_THROW_S / SPHERE_COAST_TAU_STICK_S > 5);
});

test("the drift stays dead until the throw's coast falls below it, then ramps", () => {
  // Interaction with the drift ramp: a longer coast means a LONGER silence from the
  // drift, because stepDriftResume() holds the gain at zero while the sphere is
  // still turning faster than the drift would. After a 2 rad/s throw that is
  // 2.2 * ln(2 / 0.12) = 6.2 s, then the 1.5 s ramp: about 7.7 s before the drift
  // is at full strength.
  const driftSpeed = Math.abs(BASE_DRIFT_RAD_PER_S);
  let speed = 2;
  let gain = 0;
  let hold = DRIFT_RESUME_DELAY_S;
  let firstGainS = null;
  let fullGainS = null;
  for (let i = 0; i < 90 * 12; i += 1) {
    const seconds = i / 90;
    speed = stepCoastSpeed(speed, {
      dtS: 1 / 90,
      tauS: SPHERE_COAST_TAU_HAND_THROW_S
    });
    gain = stepDriftResume(gain, {
      dtS: 1 / 90,
      grabbed: false,
      paused: false,
      holdSeconds: hold,
      manualSpeed: speed,
      driftSpeed: BASE_DRIFT_RAD_PER_S
    });
    hold = Math.max(0, hold - (1 / 90));
    if (gain > 0) {
      // THE PROPERTY: the gate is the momentum itself, not a timer.
      assert.ok(
        Math.abs(speed) <= driftSpeed + 1e-9,
        `${seconds.toFixed(2)} s: the drift started while the sphere still had ${speed.toFixed(3)} rad/s`
      );
      if (firstGainS === null) {
        firstGainS = seconds;
      }
    }
    if (gain >= 1 && fullGainS === null) {
      fullGainS = seconds;
    }
  }
  assert.ok(firstGainS > 5.5 && firstGainS < 7, `drift woke at ${firstGainS.toFixed(2)} s`);
  assert.ok(
    fullGainS - firstGainS > DRIFT_RESUME_SECONDS - 0.1,
    "and still arrives on the full ramp rather than switching on"
  );
});

test("sphere.js decays through stepCoastSpeed, and every writer names its tau", () => {
  assert.ok(
    !/RotSpeed \*= /.test(SPHERE_SRC),
    "the per-frame factor is gone from sphere.js"
  );
  assert.match(
    SPHERE_SRC,
    /state\.sphereXRotSpeed = stepCoastSpeed\(state\.sphereXRotSpeed, \{ dtS: dt, tauS \}\);/
  );
  assert.match(
    SPHERE_SRC,
    /state\.sphereYRotSpeed = stepCoastSpeed\(state\.sphereYRotSpeed, \{ dtS: dt, tauS \}\);/
  );
  // The acceleration model — both sticks, the arrow keys, the microgesture
  // nudge — hands the coast back, so a throw's 2.2 s tail is never inherited by
  // a stick spin that then refuses to stop.
  const delta = SPHERE_SRC.slice(SPHERE_SRC.indexOf("function applySphereRotationDelta("));
  assert.match(
    delta.slice(0, delta.indexOf("\n}")),
    /state\.sphereCoastTauS = SPHERE_COAST_TAU_STICK_S;/
  );
  // ...and a fresh sphere forgets the last one's throw.
  const reset = SPHERE_SRC.slice(SPHERE_SRC.indexOf("function resetSphereAnimationState("));
  assert.match(
    reset.slice(0, reset.indexOf("\n}")),
    /state\.sphereCoastTauS = SPHERE_COAST_TAU_STICK_S;/
  );
  // The release is the one writer that asks for the long coast.
  const inputSrc = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const releaseBlock = inputSrc.slice(
    inputSrc.indexOf("if (handGesture.rotate.justReleased) {")
  );
  assert.match(
    releaseBlock.slice(0, 2000),
    /state\.sphereCoastTauS = SPHERE_COAST_TAU_HAND_THROW_S;/
  );
});

test("input.js aims the drift on EVERY release, from the handoff it just made", () => {
  // The falling edge of a drag, not only a throw, has to point the drift. It aims
  // from the HANDOFF rather than from the sphere's current speed, because under a
  // position map the sphere is not carrying a speed at the moment of release: the
  // drag was angles.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const releaseCall = input.indexOf("if (handGesture.rotate.justReleased) {");
  assert.ok(releaseCall > 0, "the falling edge is handled");
  assert.match(
    input,
    /setSphereDriftDirectionFromRotation\(\s*\n\s*releaseSpin\.aimYawRadPerS,\s*\n\s*releaseSpin\.aimPitchRadPerS\s*\n\s*\)/,
    "aimed from the handoff"
  );
  // The velocity model's read-back survives on the ?drag=vel branch, so the A/B
  // is a genuine A/B rather than half a rewrite.
  assert.match(
    input,
    /setSphereDriftDirectionFromRotation\(state\.sphereYRotSpeed, state\.sphereXRotSpeed\);/
  );
  const dragCall = input.indexOf("applyHandRotateDrag(handGesture.rotate,");
  assert.ok(dragCall > 0 && releaseCall > dragCall, "after the drag has run");
});

test("THE DRIFT NEVER OPPOSES THE RELEASE, over a swept range and both signs", () => {
  // The property is swept rather than sampled, because "sometimes it goes back the
  // other way" is exactly what a handful of cases would miss.
  for (const gainScale of [1, 0.5]) {
    for (const mps of [0.0, 0.1, 0.19, 0.25, 0.4, 0.8, 1.5, 3.0]) {
      for (const sign of [1, -1]) {
        const handoff = releaseHandoff({
          velLateralMps: sign * mps,
          velVerticalMps: 0,
          netLateralM: sign * 0.1,
          yawGainRadPerM: YAW_RAD_PER_M,
          pitchGainRadPerM: PITCH_RAD_PER_M,
          zoomGain: gainScale
        });
        // The aim is always non-zero and always agrees with the hand — even at
        // 0 m/s, where the handoff itself is nothing and the net drag direction
        // is what the drift is pointed down instead.
        assert.ok(handoff.aimYawRadPerS !== 0, `${mps} m/s: the drift has an opinion`);
        assert.equal(
          Math.sign(handoff.aimYawRadPerS),
          -sign,
          `${mps} m/s sign ${sign}: aimed with the hand, not against it`
        );
        const direction = driftDirectionAfterRotation(
          handoff.aimYawRadPerS,
          handoff.aimPitchRadPerS,
          BASE_DRIFT_RAD_PER_S
        );
        assert.equal(
          Math.sign(BASE_DRIFT_RAD_PER_S * direction),
          Math.sign(handoff.aimYawRadPerS),
          "and the drift itself turns that way"
        );
        // And the coast never crosses back, which is the visible symptom.
        const net = coastAfterRelease(handoff.yawRadPerS, direction);
        assert.ok(
          net.every((v) => Math.sign(v) === -sign),
          `${mps} m/s sign ${sign}: the sphere never turns back`
        );
      }
    }
  }
});

// --- the same stroke, measured as an ANGLE -----------------------------------
// Making the same displacement worth more SPEED was the last thing the velocity
// model could do for "easier to drag in both directions", and a speed that has to
// be paid back by dragging the other way is not easier, just faster to get wrong.

// The legacy mapping, kept as the thing to beat. Linear, and 0.15 m / 0.22 m of
// travel to full deflection. legacy ?drag=vel
function fifthPassDeflection(displacementM, deadzoneM, fullM) {
  const magnitude = Math.abs(displacementM);
  if (magnitude <= deadzoneM) {
    return 0;
  }
  return Math.min(1, (magnitude - deadzoneM) / (fullM - deadzoneM));
}

// One frame of the legacy chain, so the ?drag=vel branch keeps a number attached
// to it: deflection -> stepHandDragSpeed -> sphere.js's own decay. legacy
// ?drag=vel
function settledSphereSpeed(deflection, maxSpeed, seconds = 0.5) {
  const dt = 1 / 72;
  let speed = 0;
  for (let t = 0; t < seconds; t += dt) {
    speed = stepHandDragSpeed(speed, { deflection, maxSpeed, dt });
    // The ?drag=vel branch never writes a throw tau, so it decays on the STICK
    // one — which is the old 0.95/frame to within a frame, by construction.
    speed = stepCoastSpeed(speed, { dtS: dt, tauS: SPHERE_COAST_TAU_STICK_S });
  }
  return speed;
}

test("a MODEST drag moves the sphere a PREDICTABLE amount, on both axes", () => {
  // 4 cm sideways and 5 cm vertically are movements made from the elbow with the
  // upper arm still, the stroke people actually make. Under a grab model the
  // question is "how far does that move it", which has an answer that does not
  // depend on how long you hold the pose.
  const yawRad = Math.abs(grabAngleTarget(0.04, ROTATE_YAW_DEADZONE_M, YAW_RAD_PER_M));
  const pitchRad = Math.abs(grabAngleTarget(0.05, ROTATE_PITCH_DEADZONE_M, PITCH_RAD_PER_M));
  assert.ok(yawRad > 0.08, `4 cm sideways -> ${(yawRad * 57.3).toFixed(0)} deg`);
  assert.ok(pitchRad > 0.08, `5 cm vertically -> ${(pitchRad * 57.3).toFixed(0)} deg`);
  // The two strokes agree to within the deadzone difference, so a diagonal made
  // of them reads as one movement.
  assert.ok(Math.abs(yawRad - pitchRad) < 0.05);
  // A quarter turn is a stroke and a half, not a marathon and not a twitch.
  const quarterTurnM = ((Math.PI / 2) / YAW_RAD_PER_M) + ROTATE_YAW_DEADZONE_M;
  assert.ok(quarterTurnM > 0.2 && quarterTurnM < 0.6, `${(quarterTurnM * 100).toFixed(0)} cm`);
});

test("the measured device strokes map to sensible arcs", () => {
  // Real logs: median stroke 0.10 m, p90 0.39 m. Neither should be useless and
  // neither should be a whole turn.
  const arc = (m) => Math.abs(grabAngleTarget(m, ROTATE_YAW_DEADZONE_M, YAW_RAD_PER_M));
  const median = arc(0.10);
  const p90 = arc(0.39);
  assert.ok(median > 0.25 && median < 0.6, `median stroke = ${(median * 57.3).toFixed(0)} deg`);
  assert.ok(p90 > 1.2 && p90 < 2.0, `p90 stroke = ${(p90 * 57.3).toFixed(0)} deg`);
  assert.ok(p90 < 2 * Math.PI, "even the long ones are not a full turn");
});

test("the DEADZONES are untouched, because the brake is measured against them", () => {
  // The deadzones are separate knobs: they are what "hold it still and it stops"
  // is tested against, and hand tracking jitters a few millimetres.
  assert.equal(ROTATE_YAW_DEADZONE_M, 0.015);
  assert.equal(ROTATE_PITCH_DEADZONE_M, 0.02);
  // ...and they are the only asymmetry left between the two axes.
  assert.equal(YAW_RAD_PER_M, PITCH_RAD_PER_M);
  // The response smoother is the CATCH's time constant, not the drag's: 83 ms,
  // three of which is the brake's hold.
  assert.equal(HAND_DRAG_SPEED_RESPONSE_PER_S, 12);
  assert.ok(Math.abs((3000 / HAND_DRAG_SPEED_RESPONSE_PER_S) - ROTATE_BRAKE_HOLD_MS) < 10);
});

test("the SUPERSEDED velocity model is still whole behind ?drag=vel", () => {
  // The A/B has to be a real A/B: every number the legacy path reads is still there
  // and still means what it was tuned to mean. This test goes when the flag does.
  assert.match(CONSTANTS_SRC, /HAND_SPHERE_YAW_SPEED_MAX\s*=/);
  assert.match(CONSTANTS_SRC, /HAND_SPHERE_PITCH_SPEED_MAX\s*=/);
  assert.equal(YAW_SPEED_MAX, 2.2);
  assert.equal(PITCH_SPEED_MAX, 2.2);
  assert.ok(ROTATE_RESPONSE_EXPONENT > 0 && ROTATE_RESPONSE_EXPONENT < 1);
  assert.equal(rotateYawDeflection(0.10), 1);
  assert.equal(rotatePitchDeflection(0.12), 1);
  // ...including the legacy path's own claim, which is what a comparison needs.
  for (const [label, now, before, maxSpeed] of [
    ["yaw 4 cm", rotateYawDeflection(0.04), fifthPassDeflection(0.04, 0.015, 0.15), YAW_SPEED_MAX],
    ["pitch 5 cm", rotatePitchDeflection(0.05), fifthPassDeflection(0.05, 0.02, 0.22), PITCH_SPEED_MAX]
  ]) {
    const ratio = settledSphereSpeed(now, maxSpeed) / settledSphereSpeed(before, maxSpeed);
    assert.ok(ratio >= 2, `${label}: ${ratio.toFixed(2)}x`);
  }
});

// --- THE DRIFT'S RE-ENTRY ----------------------------------------------------
// Aiming the drift was necessary and not sufficient. It also arrived at FULL
// magnitude the instant the pinch opened, on top of a sphere still carrying the
// release, and since a constant does not decay while the manual speed does, it
// won inside about half a second: the release was visibly "countered".

const DRIFT_SPEED = Math.abs(BASE_DRIFT_RAD_PER_S);

// Run the ramp forward at 72 Hz and return the gain each frame.
function driftGains(frames, opts = {}) {
  let gain = opts.from ?? 0;
  let hold = opts.holdSeconds ?? 0;
  const seen = [];
  for (let i = 0; i < frames; i += 1) {
    gain = stepDriftResume(gain, {
      dtS: FRAME_S,
      grabbed: false,
      paused: false,
      holdSeconds: hold,
      manualSpeed: 0,
      driftSpeed: BASE_DRIFT_RAD_PER_S,
      ...opts.each
    });
    hold = Math.max(0, hold - FRAME_S);
    seen.push(gain);
  }
  return seen;
}

test("THE DRIFT CAN NEVER BE LARGER THAN THE MOMENTUM IT REPLACES", () => {
  // The structural property. While the sphere is still turning faster than the
  // drift would, the drift contributes exactly nothing.
  for (const manual of [3.0, 1.5, 0.5, DRIFT_SPEED + 0.001]) {
    assert.equal(
      stepDriftResume(1, {
        dtS: FRAME_S,
        grabbed: false,
        paused: false,
        holdSeconds: 0,
        manualSpeed: manual,
        driftSpeed: BASE_DRIFT_RAD_PER_S
      }),
      0,
      `${manual} rad/s of momentum leaves no room for the drift`
    );
  }
  // At and below the drift's own speed it may start.
  assert.ok(stepDriftResume(0, {
    dtS: FRAME_S,
    grabbed: false,
    paused: false,
    holdSeconds: 0,
    manualSpeed: DRIFT_SPEED,
    driftSpeed: BASE_DRIFT_RAD_PER_S
  }) > 0);
  // Sign-blind: it is a magnitude comparison, not a direction one.
  assert.equal(
    stepDriftResume(1, { dtS: FRAME_S, manualSpeed: -1.5, driftSpeed: BASE_DRIFT_RAD_PER_S }),
    0
  );
});

test("a GRAB zeroes the gain instantly, and a pause does too", () => {
  assert.equal(stepDriftResume(1, { dtS: FRAME_S, grabbed: true, driftSpeed: BASE_DRIFT_RAD_PER_S }), 0);
  assert.equal(stepDriftResume(1, { dtS: FRAME_S, paused: true, driftSpeed: BASE_DRIFT_RAD_PER_S }), 0);
  // No ramp down: a hand on the sphere is not a gradual statement.
  assert.equal(
    stepDriftResume(0.9, { dtS: 1e-6, grabbed: true, driftSpeed: BASE_DRIFT_RAD_PER_S }),
    0
  );
});

test("the hold, then the ramp — and the ramp takes DRIFT_RESUME_SECONDS", () => {
  const frames = Math.ceil((DRIFT_RESUME_DELAY_S + DRIFT_RESUME_SECONDS + 0.5) * 72);
  const gains = driftGains(frames, { holdSeconds: DRIFT_RESUME_DELAY_S });
  // Nothing at all until the hold expires.
  const holdFrames = Math.floor(DRIFT_RESUME_DELAY_S * 72) - 1;
  assert.ok(gains.slice(0, holdFrames).every((g) => g === 0), "silent for the hold");
  // Monotonic, and it reaches 1 about a ramp later.
  assert.ok(gains.every((g, i) => i === 0 || g >= gains[i - 1] - 1e-12), "monotonic");
  const full = gains.findIndex((g) => g >= 1);
  assert.ok(full > 0, "it does get there");
  const rampSeconds = (full / 72) - DRIFT_RESUME_DELAY_S;
  assert.ok(
    Math.abs(rampSeconds - DRIFT_RESUME_SECONDS) < 0.1,
    `ramp took ${rampSeconds.toFixed(2)} s`
  );
  assert.ok(gains[gains.length - 1] === 1, "and stays there");
});

test("the ramp never exceeds the momentum it is replacing, end to end", () => {
  // The whole timeline after a 1.5 rad/s throw, at 72 Hz: the manual speed coasts
  // on the THROW time constant, the gated drift is added underneath, and the net
  // motion must never cross back the other way. The window is 12 s because the
  // coast is long: at tau 2.2 s a 1.5 rad/s throw does not fall below the drift
  // speed for about 5.6 s, and the gate holds the drift at exactly zero for all of
  // it.
  for (const release of [1.5, 0.6, 0.2, 0.05, 0]) {
    for (const sign of [1, -1]) {
      const speedSigned = sign * release;
      const direction = driftDirectionAfterRotation(
        speedSigned !== 0 ? speedSigned : sign,
        0,
        BASE_DRIFT_RAD_PER_S
      );
      let speed = speedSigned;
      let gain = 0;
      let hold = DRIFT_RESUME_DELAY_S;
      for (let i = 0; i < 72 * 12; i += 1) {
        speed = stepCoastSpeed(speed, {
          dtS: FRAME_S,
          tauS: SPHERE_COAST_TAU_HAND_THROW_S
        });
        gain = stepDriftResume(gain, {
          dtS: FRAME_S,
          grabbed: false,
          paused: false,
          holdSeconds: hold,
          manualSpeed: speed,
          driftSpeed: BASE_DRIFT_RAD_PER_S
        });
        hold = Math.max(0, hold - FRAME_S);
        const drift = BASE_DRIFT_RAD_PER_S * direction * gain;
        // THE PROPERTY: while the drift is running at all, it is never larger
        // than what the manual channel is still carrying at the moment it
        // starts, and the net never opposes the release.
        assert.ok(
          Math.abs(drift) <= DRIFT_SPEED + 1e-12,
          `release ${speedSigned}: drift stayed within its own magnitude`
        );
        const net = speed + drift;
        if (net !== 0) {
          assert.equal(
            Math.sign(net),
            sign,
            `release ${speedSigned}, frame ${i}: the sphere never turns back`
          );
        }
      }
    }
  }
});

test("sphere.js counts the hold down and gates the drift on the gain", () => {
  const sphere = fs.readFileSync(path.join(HERE, "..", "src", "sphere.js"), "utf8");
  assert.match(sphere, /state\.sphereDriftGain = stepDriftResume\(state\.sphereDriftGain, \{/);
  assert.match(sphere, /state\.sphereDriftHoldSeconds = Math\.max\(0, state\.sphereDriftHoldSeconds - dt\);/);
  assert.match(sphere, /if \(state\.sphereDriftGain > 0\) \{/);
  // A fresh sphere drifts from the first frame: the ramp exists to get out of
  // the way of a release, and there has not been one yet.
  assert.match(sphere, /state\.sphereDriftGain = 1;/);
  assert.match(sphere, /state\.sphereDriftHoldSeconds = 0;/);
  const stateSrc = fs.readFileSync(path.join(HERE, "..", "src", "state.js"), "utf8");
  assert.match(stateSrc, /sphereDriftGain: 1,/);
  assert.match(stateSrc, /sphereDriftHoldSeconds: 0,/);
  // input.js arms the hold on the falling edge of a DRAG, and nowhere else. There
  // are TWO drags with a falling edge, the hand grab and the touch grab (the same
  // grab model fed from a finger), and each arms it exactly once, inside its own
  // release branch. The count is what stops a third writer appearing somewhere that
  // is not a release.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const releaseCall = input.indexOf("if (handGesture.rotate.justReleased) {");
  const holdCall = input.indexOf("holdSphereDriftResume();");
  assert.ok(releaseCall > 0 && holdCall > releaseCall, "armed inside the release branch");
  const touchRelease = input.indexOf("if (rotate.justReleased && rotate.releaseSpin) {");
  assert.ok(touchRelease > holdCall, "the touch path has its own release branch, after the hand one");
  assert.ok(
    input.indexOf("holdSphereDriftResume();", touchRelease) > touchRelease,
    "...and arms the hold inside it"
  );
  assert.equal(input.match(/holdSphereDriftResume\(\);/g).length, 2);
});

// --- The layer differential --------------------------------------------------

const SPHERE_PANEL_COUNT = 12;

test("no two shells share a rate, and NEIGHBOURS are the pair furthest apart", () => {
  const mults = Array.from({ length: SPHERE_PANEL_COUNT }, (_, i) => sphereLayerSpreadMultiplier(i));
  assert.equal(new Set(mults).size, SPHERE_PANEL_COUNT, "every layer has its own multiplier");
  assert.ok(Math.abs(mults[0] - 1.05) < 1e-9);
  assert.ok(Math.abs(mults[SPHERE_PANEL_COUNT - 1] - 4.3) < 1e-9);
  // The parity term is the point: a monotone 1.05 + 0.1i ramp would leave adjacent
  // panels 0.1 apart, i.e. effectively locked, with one surface stuck behind
  // another.
  for (let i = 1; i < SPHERE_PANEL_COUNT; i += 1) {
    assert.ok(
      Math.abs(mults[i] - mults[i - 1]) > 0.5,
      `layers ${i - 1} and ${i} must not track each other (${mults[i - 1]} vs ${mults[i]})`
    );
  }
  // Defensive: the render loop only ever passes 0..11, but a negative or
  // non-finite index must not produce NaN into a quaternion.
  assert.equal(sphereLayerSpreadMultiplier(-3), mults[0]);
  assert.equal(sphereLayerSpreadMultiplier(Number.NaN), mults[0]);
});

test("the differential follows the rotation, not the drift, and never opposes it", () => {
  const yaw = manualLayerDifferential(0, 0.5);
  assert.equal(yaw.irisXRad, 0, "a pure yaw spreads about Y only");
  assert.ok(yaw.irisYRad > 0 && Math.sign(yaw.irisYRad) === Math.sign(0.5));
  const pitch = manualLayerDifferential(-0.4, 0);
  assert.equal(pitch.irisYRad, 0, "a pure pitch spreads about X only");
  assert.ok(Math.sign(pitch.irisXRad) === Math.sign(-0.4));
  // Linear in the delta, so a stroke twice as long unstacks twice as much and
  // the SAME angle turned in one frame or in fifty spends the same amount.
  const half = manualLayerDifferential(0, 0.25).irisYRad;
  assert.ok(Math.abs(yaw.irisYRad - 2 * half) < 1e-12);
  // No rotation, no spread — a sphere sitting still does not come apart.
  assert.deepEqual(manualLayerDifferential(0, 0), { irisXRad: 0, irisYRad: 0 });
  assert.deepEqual(
    manualLayerDifferential(Number.NaN, undefined),
    { irisXRad: 0, irisYRad: 0 }
  );
});

test("a turn of the sphere makes the outer shell LEAD the inner one visibly", () => {
  // The observable: panel i ends up rotated by group + iris*mult(i), so its
  // effective rate is (1 + coupling*mult(i)) times the group's. Simulate one second
  // of a 1 rad/s coast with no drift at all, the state a hand throw leaves the
  // sphere in for ~6 s, and the state in which the layers could read as rigid.
  const dt = 1 / 90;
  let groupYaw = 0;
  let irisY = 0;
  for (let f = 0; f < 90; f += 1) {
    const deltaYaw = 1.0 * dt;
    groupYaw += deltaYaw;
    irisY += manualLayerDifferential(0, deltaYaw).irisYRad;
  }
  assert.ok(Math.abs(groupYaw - 1) < 1e-9);
  const inner = groupYaw + (irisY * sphereLayerSpreadMultiplier(0));
  const outer = groupYaw + (irisY * sphereLayerSpreadMultiplier(SPHERE_PANEL_COUNT - 1));
  assert.ok(outer > inner, "the outer shell leads");
  // ~0.26 rad (15 deg) of relative travel per radian of sphere rotation: enough
  // that a panel hidden behind its neighbour comes out on a normal stroke.
  assert.ok(outer - inner > 0.2, `relative travel too small: ${outer - inner}`);
  // Every shell moves the SAME way as the sphere. The differential can lead the
  // rotation but must never run backwards through it, which is the failure mode the
  // drift channel can produce.
  for (let i = 0; i < SPHERE_PANEL_COUNT; i += 1) {
    const rate = 1 + (SPHERE_MANUAL_LAYER_COUPLING * sphereLayerSpreadMultiplier(i));
    assert.ok(rate > 1, "no shell trails or reverses");
    assert.ok(rate < 1.5, "and none of them runs away from the sphere either");
  }
});

test("EVERY rotation writer feeds the differential — the drift is no longer its only source", () => {
  const sphere = fs.readFileSync(path.join(HERE, "..", "src", "sphere.js"), "utf8");
  assert.match(sphere, /function applyManualLayerDifferential\(deltaPitch, deltaYaw\) \{/);
  // The grab (the hand drag), the momentum path (thumbsticks, arrow keys, the
  // microgesture nudge, and every coasting frame of a throw) and the desktop
  // pointer. Three call sites plus the definition.
  assert.equal(
    sphere.match(/applyManualLayerDifferential\(deltaPitch, deltaYaw\);/g).length,
    3,
    "grab + momentum coast + desktop pointer"
  );
  const grab = sphere.slice(sphere.indexOf("function applySphereGrabRotation("));
  assert.match(
    grab.slice(0, grab.indexOf("\n}\n")),
    /applyManualLayerDifferential\(deltaPitch, deltaYaw\);/
  );
  const pointer = sphere.slice(sphere.indexOf("function applySpherePointerRotation("));
  assert.match(
    pointer.slice(0, pointer.indexOf("\n}\n")),
    /applyManualLayerDifferential\(deltaPitch, deltaYaw\);/
  );
  // The render loop reads the shared pure multiplier rather than its old inline
  // copy, so the tested property is the one that ships.
  assert.match(sphere, /const layerSpread = sphereLayerSpreadMultiplier\(i\);/);
  assert.ok(!/proceduralMultiplier/.test(sphere), "the inline copy is gone");
  assert.equal(sphere.match(/state\.irisXRot \* layerSpread/g).length, 1);
  assert.equal(sphere.match(/state\.irisYRot \* layerSpread/g).length, 1);
  // The drift must not re-open during a coast: that is the counter-rotation bug.
  // The gate stays exactly where it is.
  assert.match(sphere, /if \(state\.sphereDriftGain > 0\) \{/);
});

// --- brake only near the centre ----------------------------------------------

test("the brake's centre gate SHIPS OFF, so the brake still arms from anywhere", () => {
  // Deliberately unresolved: "near the centre" could mean the centre of view, the
  // centre of the sphere or the selected image, and a brake that silently refuses
  // to arm reads as broken. The mechanism is here and tested; the flag ships off.
  assert.equal(ROTATE_BRAKE_CENTER_GATE, false);
  const rig = makeRig();
  const seen = rig.hold(ROTATE_BRAKE_HOLD_MS + 200, {
    leftPinch: true,
    // Hard off centre — well outside ROTATE_BRAKE_CENTER_MAX_NDC_R.
    rotateHandNdc: { x: 0.95, y: -0.9, behind: false }
  });
  assert.ok(seen.some((d) => d.rotate.braking), "the brake still arms");
  assert.ok(seen.some((d) => d.stop.pauseSource === "brake"));
});

test("handWithinNdcRadius refuses off-centre and permits an UNKNOWN", () => {
  const r = ROTATE_BRAKE_CENTER_MAX_NDC_R;
  assert.equal(handWithinNdcRadius({ x: 0, y: 0, behind: false }), true);
  assert.equal(handWithinNdcRadius({ x: r, y: 0, behind: false }), true, "the bound is inclusive");
  assert.equal(handWithinNdcRadius({ x: r + 0.01, y: 0, behind: false }), false);
  // A RADIUS, not a box: the corner of the square is outside it.
  assert.equal(handWithinNdcRadius({ x: r * 0.8, y: r * 0.8, behind: false }), false);
  // The three defaults, same rule the dropout grace follows — an unknown is
  // never read as a deliberate act, and here that means PERMIT.
  assert.equal(handWithinNdcRadius(null), true);
  assert.equal(handWithinNdcRadius({ x: NaN, y: 0, behind: false }), true);
  // ...but `behind` IS information.
  assert.equal(handWithinNdcRadius({ x: 0, y: 0, behind: true }), false);
});

test("the gate, when ON, refuses at the radius and LATCHES for the contact", () => {
  // Exercised through the pure helper plus the tree's own latch, because the
  // constant ships false and a test that flipped it would be testing a
  // different build. The latch is what the tree owns.
  const rig = makeRig();
  // Engage near centre, then wander off while holding still: the brake must
  // survive, because the question is where the GRAB was made.
  rig.hold(PINCH_DEBOUNCE_MS + 40, {
    leftPinch: true,
    rotateHandNdc: { x: 0.1, y: 0.1, behind: false }
  });
  const engaged = rig.decision;
  assert.equal(engaged.state.rotateBrakeGateOk, true);
  const wandered = rig.hold(ROTATE_BRAKE_HOLD_MS + 100, {
    leftPinch: true,
    rotateHandNdc: { x: 1.2, y: 1.2, behind: false }
  });
  assert.ok(
    wandered.every((d) => d.state.rotateBrakeGateOk === true),
    "the verdict is latched, not re-evaluated per frame"
  );
  assert.ok(wandered.some((d) => d.rotate.braking));
  // ...and it resets once the contact ends, so the next grab is judged afresh.
  const released = rig.step({ leftPinch: false });
  assert.equal(released.state.rotateBrakeGateOk, true);
});

test("input.js reads the rotate hand's NDC even with the other hand gone", () => {
  // The gate is a one-hand question and the other hand is routinely untracked
  // during a drag; the distance gesture's pair is only read when BOTH are.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  const rotateRead = input.indexOf("rotateHandNdc = readHandNdc(rotateHandAnchor");
  const bothBlock = input.indexOf("if (leftHandTracked && rightHandTracked) {");
  assert.ok(rotateRead > 0, "the rotate hand is projected");
  assert.ok(rotateRead < bothBlock, "outside the both-hands block");
  assert.match(input, /if \(rotateHandTracked\) \{/);
  // Its own scratch object, so it cannot alias either of the pair.
  assert.match(input, /const _rotateHandNdcRead = \{ x: NaN, y: NaN, behind: false \};/);
});

test("a frame hitch cannot manufacture a throw out of a stall", () => {
  // Rule 4, applied to the newest window: a hitch advances the gesture clock by
  // nothing, so dividing the frame's displacement by it would report an
  // enormous speed. It carries the previous reading instead.
  let gestureState = createHandGestureState();
  let now = 1000;
  const step = (input) => {
    const out = resolveHandGestures(gestureState, { ...BASE, ...input, now });
    gestureState = out.state;
    return out;
  };
  // Steady 30 Hz, pinch engaged, hand still.
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    last = step({ leftPinch: true });
    now += 1000 / 30;
  }
  assert.equal(last.rotate.active, true);
  // One 400 ms stall that arrives with the hand 30 cm from the anchor.
  now += 400;
  const hitched = step({ leftPinch: true, rotateLateralM: 0.3 });
  assert.equal(hitched.diag.hitch, true, "the frame really was a hitch");
  assert.equal(hitched.rotate.thrown, false, "and it threw nothing");
  assert.equal(hitched.rotate.speedMps, 0, "the stall contributed no speed reading");
});

// --- horizontal-only separation ---------------------------------------------

test("horizontalSeparationM hears sideways and is deaf to up/down", () => {
  const right = { x: 1, y: 0, z: 0 };
  assert.equal(horizontalSeparationM({ x: 0.4, y: 0, z: 0 }, right), 0.4);
  // Both hands lowered together: the vector between them is unchanged.
  assert.equal(horizontalSeparationM({ x: 0.4, y: -0.3, z: 0 }, right), 0.4);
  // One hand above the other, no sideways component at all.
  assert.equal(horizontalSeparationM({ x: 0, y: 0.5, z: 0 }, right), 0);
  // Sign-free: which hand is on the left does not matter.
  assert.equal(horizontalSeparationM({ x: -0.4, y: 0, z: 0 }, right), 0.4);
  // A turned viewer: camera-right is what "horizontal" means.
  const turned = { x: 0, y: 0, z: 1 };
  assert.equal(horizontalSeparationM({ x: 0.4, y: 0, z: 0 }, turned), 0);
  assert.ok(Number.isNaN(horizontalSeparationM(null, right)));
});

test("lowering both hands together moves no zoom, but spreading them does", () => {
  // End to end, driven through the tree with the separations input.js would
  // actually have measured.
  const right = { x: 1, y: 0, z: 0 };
  const sep = (leftPos, rightPos) => horizontalSeparationM({
    x: rightPos.x - leftPos.x,
    y: rightPos.y - leftPos.y,
    z: rightPos.z - leftPos.z
  }, right);

  const rig = makeRig();
  const rest = sep({ x: -0.2, y: 1.2, z: -0.4 }, { x: 0.2, y: 1.2, z: -0.4 });
  assert.ok(Math.abs(rest - 0.4) < 1e-12);
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 200, { handDistanceM: rest });

  // Both hands drop 40 cm, together, over ten frames — well past the 25% band
  // the raw 3-D distance would have crossed.
  const lowering = [];
  for (let i = 1; i <= 10; i += 1) {
    const y = 1.2 - (i * 0.04);
    lowering.push(rig.step({
      handDistanceM: sep({ x: -0.2, y, z: -0.4 }, { x: 0.2, y, z: -0.4 }),
      leftHandHeightM: y,
      rightHandHeightM: y
    }));
  }
  assert.ok(lowering.every((d) => d.distance.active === false), "no zoom from moving down");

  // The same hands spread sideways DO engage it, so the gate is not simply off.
  // The heights are held at where the lowering left them: the intent test reads the
  // COMMON vertical rate, so teleporting the hands back up to BASE's 1.2 m between
  // the two halves would be a metre-per-second sweep and would (correctly) refuse.
  //
  // The 40 cm drop above also trips the LOWERING VETO, which disarms until the
  // hands have been held at a steady height for DISTANCE_REARM_STILL_MS, so the
  // pause here is the re-arm, and it has to outlast the 600 ms path window as well.
  rig.hold(900, {
    handDistanceM: sep({ x: -0.2, y: 0.8, z: -0.4 }, { x: 0.2, y: 0.8, z: -0.4 }),
    leftHandHeightM: 0.8,
    rightHandHeightM: 0.8
  });
  assert.equal(rig.decision.diag.armed, true, "steady hands re-arm it");

  const spread = rig.hold(200, {
    handDistanceM: sep({ x: -0.3, y: 0.8, z: -0.4 }, { x: 0.3, y: 0.8, z: -0.4 }),
    leftHandHeightM: 0.8,
    rightHandHeightM: 0.8
  });
  assert.ok(spread.some((d) => d.distance.active), "sideways still works");
});

// --- THE INTENT TEST ---------------------------------------------------------
//
// Zoom must tell horizontal gestures that should be tracked from moving the hands
// out of the scene (down plus some horizontal), which should not. Position gates
// cannot see this: dropping your arms swings the hands apart as they fall, so the
// separation reading is indistinguishable from a spread. Only the MOTION tells
// them apart: a spread is differential, a drop is common-mode.

// Both hands, described the way a body does it, driven through the whole tree.
// `armDrop` is "down plus some horizontal": 0.6 m of fall in 0.8 s while the
// shoulders swing the hands 0.25 m further apart. `spread` is the gesture. The
// rig runs at 30 Hz, so `frames` IS the duration: 24 frames = 0.8 s. Kept that
// way rather than interpolated onto a wall clock, because holding a sample for
// two frames halves the stroke's speed and the REST TRACKER follows a slow enough
// stroke instead of letting the deviation build (a property of
// DISTANCE_STABILITY_* that a fixture should not trip over by accident).
function twoHandStroke(rig, {
  fromSeparationM,
  toSeparationM,
  fromHeightM,
  toHeightM,
  frames
}) {
  const seen = [];
  for (let i = 1; i <= frames; i += 1) {
    const k = i / frames;
    const heightM = fromHeightM + ((toHeightM - fromHeightM) * k);
    seen.push(rig.step({
      handDistanceM: fromSeparationM + ((toSeparationM - fromSeparationM) * k),
      leftHandHeightM: heightM,
      rightHandHeightM: heightM
    }));
  }
  return seen;
}

function settledRig(separationM = 0.4, heightM = 1.2) {
  const rig = makeRig();
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 300, {
    handDistanceM: separationM,
    leftHandHeightM: heightM,
    rightHandHeightM: heightM
  });
  return rig;
}

test("the intent test is a share of the motion, not a speed", () => {
  // Pure, so the arithmetic is checkable without the tree. Same dominance from
  // a slow stroke and a fast one — a threshold on absolute speed would not have
  // that property, and a careful spread has to be allowed.
  const step = (state, { sep, height, dtMs }) => updateDistanceIntent(state, {
    nowMs: state.lastMs === null ? 0 : state.lastMs + dtMs,
    readable: true,
    separationM: sep,
    meanHeightM: height
  });

  let fast = createDistanceIntentState();
  let slow = createDistanceIntentState();
  let sepFast = 0.4;
  let sepSlow = 0.4;
  for (let i = 0; i < 30; i += 1) {
    sepFast += 0.02;
    sepSlow += 0.005;
    fast = step(fast, { sep: sepFast, height: 1.2, dtMs: 1000 / 30 });
    slow = step(slow, { sep: sepSlow, height: 1.2, dtMs: 1000 / 30 });
  }
  assert.ok(fast.separationRateMps > 3.5 * slow.separationRateMps, "the speeds differ");
  assert.ok(fast.allowed && slow.allowed, "both are pure separation, both allowed");
  assert.ok(Math.abs(fast.ratio - slow.ratio) < 1e-6, "the SHARE is identical");
});

test("a frame with no motion holds the previous verdict rather than guessing", () => {
  // It matters at the top of a stroke: the hands stop, DISTANCE_COMMIT_MS starts
  // counting, and the intent test must not change its mind about a stroke that
  // has already finished.
  let state = createDistanceIntentState();
  for (let i = 0; i < 20; i += 1) {
    state = updateDistanceIntent(state, {
      nowMs: i * (1000 / 30),
      readable: true,
      separationM: 0.4 + (i * 0.02),
      meanHeightM: 1.2
    });
  }
  assert.equal(state.allowed, true);
  const still = { ...state };
  let held = state;
  for (let i = 20; i < 60; i += 1) {
    held = updateDistanceIntent(held, {
      nowMs: i * (1000 / 30),
      readable: true,
      separationM: still.lastSeparationM,
      meanHeightM: 1.2
    });
  }
  assert.equal(held.allowed, true, "stillness never revokes a verdict");
  assert.ok(Math.abs(held.separationRateMps) < DISTANCE_INTENT_MIN_RATE_MPS);
});

test("a tracking gap holds the verdict but drops the samples", () => {
  // The same split every other rule in this file makes between "this stopped"
  // and "we cannot see it" — and dropping the samples is what stops the frame
  // after a gap reading as a teleport.
  let state = createDistanceIntentState();
  for (let i = 0; i < 20; i += 1) {
    state = updateDistanceIntent(state, {
      nowMs: i * (1000 / 30),
      readable: true,
      separationM: 0.4 + (i * 0.02),
      meanHeightM: 1.2
    });
  }
  const gapped = updateDistanceIntent(state, {
    nowMs: 1000,
    readable: false,
    separationM: NaN,
    meanHeightM: NaN
  });
  assert.equal(gapped.allowed, state.allowed, "verdict survives");
  assert.equal(gapped.lastMs, null, "samples do not");
  const resumed = updateDistanceIntent(gapped, {
    nowMs: 1033,
    readable: true,
    separationM: 1.4,
    meanHeightM: 0.4
  });
  assert.equal(resumed.separationRateMps, 0, "the frame across the gap is a seed, not a rate");
});

test("ARMS DROPPING does not engage the zoom, even though they swing apart", () => {
  // Down plus some horizontal must not be tracked, and the separation really does
  // cross the engage band, which is why no position test could refuse it.
  const rig = settledRig(0.4, 1.2);
  const drop = twoHandStroke(rig, {
    fromSeparationM: 0.4,
    toSeparationM: 0.65,
    fromHeightM: 1.2,
    toHeightM: 0.6,
    frames: 24 // 0.8 s at 30 Hz
  });
  assert.ok(0.65 / 0.4 - 1 > DISTANCE_ENGAGE_REL, "the spread alone would have engaged");
  assert.ok(drop.every((d) => d.distance.active === false), "but the motion says otherwise");
  assert.equal(drop[drop.length - 1].diag.intentOk, false);
  assert.ok(drop[drop.length - 1].diag.intentRatio < 0.6, "dominantly a common sweep");

  // THE COUNTERFACTUAL, and the point of the whole exercise: the SAME
  // separation profile, with the hands held at one height, does engage. So the
  // refusal above cannot have come from anything about where the hands were or
  // how far apart they got — the only difference between the two runs is the
  // vertical motion, which is exactly the discriminator that was missing.
  const control = settledRig(0.4, 1.2);
  const level = twoHandStroke(control, {
    fromSeparationM: 0.4,
    toSeparationM: 0.65,
    fromHeightM: 1.2,
    toHeightM: 1.2,
    frames: 24
  });
  assert.ok(level.some((d) => d.distance.active), "the same spread, not falling, engages");
});

test("...while the same hands SPREADING at one height engage it", () => {
  const rig = settledRig(0.4, 1.2);
  const spread = twoHandStroke(rig, {
    fromSeparationM: 0.4,
    toSeparationM: 0.7,
    fromHeightM: 1.2,
    toHeightM: 1.16,
    frames: 18 // 0.6 s
  });
  assert.ok(spread.some((d) => d.distance.active), "the gesture still works");
  assert.equal(spread[spread.length - 1].diag.intentOk, true);
});

// --- the share is an ENGAGE gate only ----------------------------------------
//
// A running stroke must not be released when the share dips (`releaseReason:
// "not-intent"`): in real logs every such release had a separation rate inside
// -0.10 .. +0.07 m/s, i.e. the stroke had simply FINISHED, and the collapse of
// the share was the numerator going to zero rather than the arms going down. A
// release has to be authorised by positive evidence of lowering (the path
// layer's job); nothing intent-shaped may drop a stroke.

test("a stroke that merely STOPS is never released by the intent test", () => {
  // The failure seen in real logs: the hands spread, then hold. The share goes to
  // noise because there is no motion left to take a share OF.
  const rig = settledRig(0.4, 1.2);
  const spread = twoHandStroke(rig, {
    fromSeparationM: 0.4,
    toSeparationM: 0.62,
    fromHeightM: 1.2,
    toHeightM: 1.18,
    frames: 15 // 0.5 s
  });
  assert.ok(spread.some((d) => d.distance.active), "engaged first");

  // Hold — a stopping hand, plus the sub-millimetre wobble of holding two arms
  // out in front of you, which is what produced the 0.06-0.10 m/s readings.
  const held = [];
  for (let i = 0; i < 12; i += 1) {
    held.push(rig.step({
      handDistanceM: 0.62 + ((i % 2) * 0.001),
      leftHandHeightM: 1.18 - ((i % 3) * 0.001),
      rightHandHeightM: 1.18 - ((i % 3) * 0.001)
    }));
  }
  assert.ok(
    held.every((d) => d.distance.releaseReason !== "not-intent"),
    "the reason does not exist any more"
  );
  // It may COMMIT (the ratchet could not fire while the intent test pre-empted it),
  // but it must not be dropped by the share before it gets there.
  const dropped = held.find((d) => d.distance.releaseReason === "rest");
  assert.equal(dropped, undefined, "and it was not unwound either");
});

test("an ENGAGED stroke is not dropped by an arm-drop's share, pending the path layer", () => {
  // Pinned deliberately: the share alone never drops a stroke. Releasing on
  // lowering is the path layer's job, which reads net vertical DISPLACEMENT.
  const rig = settledRig(0.4, 1.2);
  twoHandStroke(rig, {
    fromSeparationM: 0.4,
    toSeparationM: 0.62,
    fromHeightM: 1.2,
    toHeightM: 1.18,
    frames: 15
  });
  assert.ok(rig.decision.state.distance.engaged, "engaged first");

  const drop = twoHandStroke(rig, {
    fromSeparationM: 0.62,
    toSeparationM: 0.8,
    fromHeightM: 1.18,
    toHeightM: 0.6,
    frames: 21 // 0.7 s
  });
  assert.ok(
    drop.every((d) => d.distance.releaseReason !== "not-intent"),
    "no share-driven release survives"
  );
  assert.equal(drop[drop.length - 1].diag.intentOk, false, "the verdict still SAYS no");
});

test("the intent verdict expires back to neutral once the hands go quiet", () => {
  // A spread earns `allowed`, the hands stop, and the arm-drop that follows would
  // inherit the permission the finished spread earned. Holding a stale refusal is
  // safe; holding a stale PERMISSION is not, so the held verdict has a shelf life.
  let state = createDistanceIntentState();
  const stepAt = (s, sep, height, ms) => updateDistanceIntent(s, {
    nowMs: ms,
    readable: true,
    separationM: sep,
    meanHeightM: height
  });
  // A clean spread, so the verdict is a real `allowed` and not just the
  // default. The 1 mm/frame sag is the incidental vertical drift of holding two
  // arms out in front of you — it keeps the share off exactly 1, so "the share
  // was reset" is distinguishable from "the share never moved".
  let t = 0;
  let sep = 0.4;
  let height = 1.2;
  for (let i = 0; i < 20; i += 1) {
    t += 1000 / 30;
    sep += 0.02;
    height -= 0.001;
    state = stepAt(state, sep, height, t);
  }
  assert.equal(state.allowed, true);
  assert.ok(state.ratio > 0.9 && state.ratio < 1, "earned on a real measurement");

  // Now stop, and keep feeding frames at 30 Hz. The stroke's smoothed rate has
  // to decay under the floor before the shelf life even starts counting, so the
  // verdict is held well past DISTANCE_COMMIT_MS — which is the property the
  // ratchet needs.
  let quiet = state;
  let expiredAtMs = null;
  for (let i = 0; i < 40; i += 1) {
    t += 1000 / 30;
    const before = quiet;
    quiet = stepAt(quiet, sep, height, t);
    if (expiredAtMs === null && before.ratio !== 1 && quiet.ratio === 1) {
      expiredAtMs = t;
    }
  }
  assert.ok(expiredAtMs !== null, "it does expire");
  assert.ok(
    expiredAtMs - state.lastMs > DISTANCE_INTENT_STALE_MS,
    "and not before the shelf life, because the rate has to decay under the floor first"
  );
  assert.equal(quiet.allowed, true, "expiry is to the NEUTRAL default...");
  assert.equal(quiet.ratio, 1, "...which is what a fresh state carries");

  // And the same shelf life applies to a REFUSAL, which is what makes it a
  // neutral reset rather than a bias: an arm-drop's `false` does not outlive
  // the arm-drop, so the hands can be brought back up and used immediately.
  let refused = createDistanceIntentState();
  let t2 = 0;
  let sep2 = 0.4;
  let h2 = 1.2;
  for (let i = 0; i < 24; i += 1) {
    t2 += 1000 / 30;
    sep2 += 0.25 / 24;
    h2 -= 0.6 / 24;
    refused = stepAt(refused, sep2, h2, t2);
  }
  assert.equal(refused.allowed, false, "the drop is refused");
  let recovered = refused;
  for (let i = 0; i < 24; i += 1) {
    t2 += 1000 / 30;
    recovered = stepAt(recovered, sep2, h2, t2);
  }
  assert.equal(recovered.allowed, true, "and the refusal expires too");
});

test("the noise floor is above the residue of a stroke that has stopped", () => {
  // The floor has to be above the decelerating tail of a real stroke (stopping
  // strokes read 0.06-0.33 m/s combined) or the share is arithmetic on noise.
  assert.ok(
    DISTANCE_INTENT_MIN_RATE_MPS >= 0.12,
    "a stopping stroke reads 0.06-0.10 m/s combined; the floor must clear it"
  );
  // ...and not so high that a slow deliberate spread stops being evidence at all.
  assert.ok(DISTANCE_INTENT_MIN_RATE_MPS <= 0.25);
});

// --- THE PATH LAYER ----------------------------------------------------------
//
// Net DISPLACEMENT over a 600 ms window, rather than a smoothed rate. It
// answers the two questions the rates could not: it is phase-invariant (a
// lowering that begins with an outward swing does not score well for its first
// 150 ms) and it separates an arm-drop from a spread by about 5x, because an
// arm drop moves the mean hand height 0.4-0.6 m and the incidental sag of a
// spread moves it 0.05-0.10 m.

test("the ring measures displacement across the window, not per frame", () => {
  let track = createDistanceTrack();
  let out = null;
  let t = 0;
  // A spread at 0.6 m/s and a simultaneous 0.05 m/s sag, sampled at 30 Hz.
  for (let i = 0; i < 30; i += 1) {
    out = stepDistanceTrack(track, {
      nowMs: t,
      separationM: 0.4 + (t * 0.0006),
      heightM: 1.2 - (t * 0.00005)
    });
    track = out.track;
    t += 1000 / 30;
  }
  assert.ok(out.spanMs >= DISTANCE_TRACK_WINDOW_MS - DISTANCE_TRACK_SLOT_MS);
  assert.ok(out.spanMs <= DISTANCE_TRACK_WINDOW_MS, "the window does not grow past its length");
  assert.ok(Math.abs(out.netSeparationM - (0.6 * out.spanMs / 1000)) < 1e-6);
  assert.ok(out.pathRatio > 0.9, "a level spread is dominantly separation");

  // A slot is only appended once per DISTANCE_TRACK_SLOT_MS, so the ring stays
  // the same six samples whatever the frame rate — which is what makes 600 ms
  // mean 600 ms at 20 Hz and at 90 Hz alike.
  assert.ok(track.slots.length <= 6, `got ${track.slots.length} slots`);

  // No motion is NO EVIDENCE, hence 0 rather than 1: a perfectly still pair of
  // hands must not inherit a path verdict it did not earn.
  let still = createDistanceTrack();
  let flat = null;
  for (let i = 0; i < 30; i += 1) {
    flat = stepDistanceTrack(still, { nowMs: i * (1000 / 30), separationM: 0.4, heightM: 1.2 });
    still = flat.track;
  }
  assert.equal(flat.pathRatio, 0);
});

test("the ring keeps its samples across a tracking gap; the RATES do not", () => {
  // The one measure in the file that survives a dropout intact, and
  // deliberately so: a displacement across a blink really did happen, whereas a
  // rate across one reads as a teleport.
  let state = createDistanceIntentState();
  const feed = (s, sep, height, ms) => updateDistanceIntent(s, {
    nowMs: ms, readable: true, separationM: sep, meanHeightM: height
  });
  let t = 0;
  for (let i = 0; i < 20; i += 1) {
    t += 1000 / 30;
    state = feed(state, 0.4 + (i * 0.01), 1.2, t);
  }
  const slots = state.track.slots.length;
  const gapped = updateDistanceIntent(state, {
    nowMs: t + 200, readable: false, separationM: NaN, meanHeightM: NaN
  });
  assert.equal(gapped.lastMs, null, "the rate samples are dropped");
  assert.equal(gapped.track.slots.length, slots, "the ring is not");
});

test("THE LOWERING VETO releases an engaged stroke on positive evidence", () => {
  // The replacement for "not-intent", and the difference that matters: this
  // fires because the hands ARE 0.18 m lower than they were, not because the
  // share went quiet.
  const rig = settledRig(0.4, 1.2);
  twoHandStroke(rig, {
    fromSeparationM: 0.4,
    toSeparationM: 0.62,
    fromHeightM: 1.2,
    toHeightM: 1.18,
    frames: 15
  });
  assert.ok(rig.decision.state.distance.engaged, "engaged first");

  const drop = twoHandStroke(rig, {
    fromSeparationM: 0.62,
    toSeparationM: 0.8,
    fromHeightM: 1.18,
    toHeightM: 0.6,
    frames: 21 // 0.7 s
  });
  const released = drop.find((d) => d.distance.releaseReason === "lowering");
  assert.ok(released, "the running stroke let go");
  // Keeps the value, like "out-of-view" and unlike the "rest" cancel: nothing
  // unwinds on the way down.
  assert.equal(released.distance.deltaM, 0);
  assert.notEqual(released.distance.releaseReason, "rest");
  assert.ok(
    released.diag.netDropM <= -DISTANCE_LOWERING_DROP_M,
    `and the log says by how much: ${released.diag.netDropM}`
  );
  assert.ok(
    drop.slice(drop.indexOf(released) + 1).every((d) => d.distance.active === false),
    "and nothing re-engages on the way down"
  );
});

test("...and it takes a STILLNESS to re-arm, not a movement", () => {
  const rig = settledRig(0.4, 1.2);
  twoHandStroke(rig, {
    fromSeparationM: 0.4, toSeparationM: 0.62, fromHeightM: 1.2, toHeightM: 1.18, frames: 15
  });
  twoHandStroke(rig, {
    fromSeparationM: 0.62, toSeparationM: 0.8, fromHeightM: 1.18, toHeightM: 0.6, frames: 21
  });
  assert.equal(rig.decision.diag.armed, false, "disarmed by the drop");

  // Arms straight back up and immediately spreading, with no steady moment:
  // still refused, because the veto is not lifted by more arm movement.
  const straightBackUp = twoHandStroke(rig, {
    fromSeparationM: 0.8, toSeparationM: 1.1, fromHeightM: 0.6, toHeightM: 1.2, frames: 18
  });
  assert.ok(straightBackUp.every((d) => d.distance.active === false), "no engage on the way back up");

  // Held at a working height: re-armed, and then a plain spread works again.
  rig.hold(900, { handDistanceM: 1.1, leftHandHeightM: 1.2, rightHandHeightM: 1.2 });
  assert.equal(rig.decision.diag.armed, true, "steady hands re-arm it");
});

test("REPLAY: hands enter from the sides converging, then spread, with no stillness", () => {
  // Hands coming into the scene from both sides must engage. A rest promoted only
  // after a candidate held within 6% for 100 ms (24 mm at 0.4 m) never settles for
  // anything converging faster than 0.24 m/s. There is no still frame anywhere in
  // this fixture.
  const rig = makeRig();
  // Both hands come in from the edges at 0.55 m/s. Not far enough to be a
  // zoom-out stroke of its own — this is the approach, not the gesture.
  const inbound = twoHandStroke(rig, {
    fromSeparationM: 0.62,
    toSeparationM: 0.50,
    fromHeightM: 1.2,
    toHeightM: 1.2,
    frames: 7
  });
  assert.ok(inbound.every((d) => d.distance.active === false), "the approach is not the gesture");

  // Straight into the spread, with no pause at the turn. A rest-based baseline
  // could not engage here: 0.55 m/s never holds within 6% for 100 ms, so there
  // would be nothing to deviate 25% from.
  const outbound = twoHandStroke(rig, {
    fromSeparationM: 0.50,
    toSeparationM: 0.90,
    fromHeightM: 1.2,
    toHeightM: 1.2,
    frames: 22
  });
  const engaged = outbound.find((d) => d.distance.justEngaged);
  assert.ok(engaged, "the turn IS the baseline");
  assert.ok(
    engaged.diag.baselineM < 0.62,
    `measured from the minimum they reached, not from where they came in: ${engaged.diag.baselineM}`
  );
  assert.ok(
    outbound.some((d) => d.distance.deltaM > 0),
    "and it drives the zoom outward, the way the hands are going"
  );
});

test("...and a long converging entry is itself a zoom-out, tracked continuously", () => {
  // The other half of "no stillness required": if the hands come a LONG way in,
  // that is a real stroke and the gesture must follow it — again with no still
  // frame anywhere. Reversing it before it commits is the CANCEL, which is the
  // documented meaning of "put your hands back where you started".
  const rig = makeRig();
  const inbound = twoHandStroke(rig, {
    fromSeparationM: 1.0, toSeparationM: 0.4, fromHeightM: 1.2, toHeightM: 1.2, frames: 30
  });
  assert.ok(inbound.some((d) => d.distance.active), "0.6 m/s of closing is a zoom-out");
  assert.ok(inbound.some((d) => d.distance.deltaM < 0), "and it reads as closing");
  const back = twoHandStroke(rig, {
    fromSeparationM: 0.4, toSeparationM: 1.0, fromHeightM: 1.2, toHeightM: 1.2, frames: 30
  });
  assert.ok(back.some((d) => d.distance.releaseReason === "rest"), "and coming back cancels it");
});

test("REPLAY: spread, stop, then drop the arms — it releases and does not re-engage", () => {
  const rig = settledRig(0.4, 1.2);
  const spread = twoHandStroke(rig, {
    fromSeparationM: 0.4, toSeparationM: 0.62, fromHeightM: 1.2, toHeightM: 1.19, frames: 15
  });
  assert.ok(spread.some((d) => d.distance.active), "engaged");

  // STOP. The share collapsing here must not be read as an arm-drop.
  const stopped = rig.hold(400, {
    handDistanceM: 0.62, leftHandHeightM: 1.19, rightHandHeightM: 1.19
  });
  assert.ok(
    stopped.every((d) => d.distance.releaseReason !== "lowering"),
    "stopping is not lowering"
  );

  // NOW drop the arms, swinging them apart as they fall.
  const dropped = twoHandStroke(rig, {
    fromSeparationM: 0.62, toSeparationM: 0.85, fromHeightM: 1.19, toHeightM: 0.55, frames: 24
  });
  assert.ok(
    dropped.every((d) => d.distance.active === false),
    "and nothing engages on the way down, even though the hands swing apart"
  );
  assert.equal(rig.decision.diag.armed, false);
});

test("REPLAY: the 10:28:41-43 lock — commit, lower, RAISE and spread, and it engages", () => {
  // The zoom must not lock: zoom gesture in the tunnel, move hands down, move hands
  // back up and do a different zoom gesture, after which the tunnel speed could
  // not be changed again. This is that sequence, timed off a real log.
  const rig = settledRig(0.5, 1.2);

  // A converging stroke commits.
  const converge = twoHandStroke(rig, {
    fromSeparationM: 0.5, toSeparationM: 0.14, fromHeightM: 1.2, toHeightM: 1.18, frames: 16
  });
  assert.ok(converge.some((d) => d.distance.active), "the first stroke ran");

  // The hands come down to be repositioned (netDropM -0.184); the veto fires and
  // disarms.
  twoHandStroke(rig, {
    fromSeparationM: 0.14, toSeparationM: 0.18, fromHeightM: 1.18, toHeightM: 0.95, frames: 12
  });
  assert.equal(rig.decision.diag.armed, false, "lowering disarmed the gesture");

  // Hands come back UP and spread, in one continuous motion with no still phase
  // anywhere in it. A two-sided |netHeightM| < 0.05 band (netHeightM +0.055) would
  // refuse this with reason:"rearm", and there would be nothing the user could do.
  const raiseAndSpread = twoHandStroke(rig, {
    fromSeparationM: 0.18, toSeparationM: 0.75, fromHeightM: 0.95, toHeightM: 1.18, frames: 20
  });
  assert.ok(
    raiseAndSpread.some((d) => d.distance.active),
    "raising the hands re-arms, and the spread engages"
  );
  assert.ok(
    raiseAndSpread.some((d) => d.distance.deltaM > 0),
    "and it drives the speed the other way"
  );
});

test("...but lowering with NO raise still refuses, so the veto is not just deleted", () => {
  const rig = settledRig(0.5, 1.2);
  twoHandStroke(rig, {
    fromSeparationM: 0.5, toSeparationM: 0.14, fromHeightM: 1.2, toHeightM: 1.18, frames: 16
  });
  // The stroke commits and lets go.
  rig.hold(450, { handDistanceM: 0.14, leftHandHeightM: 1.18, rightHandHeightM: 1.18 });
  // Straight down, swinging apart on the way, and never coming back up: the
  // arm-drop the veto exists for.
  const drop = twoHandStroke(rig, {
    fromSeparationM: 0.14, toSeparationM: 0.62, fromHeightM: 1.18, toHeightM: 0.6, frames: 24
  });
  assert.ok(drop.every((d) => d.distance.active === false), "nothing engages on the way down");
  assert.equal(rig.decision.diag.armed, false, "and it is still disarmed at the bottom");
});

test("the re-arm rule itself: rising is immediate, level takes the sustain", () => {
  // Pure, against updateDistanceIntent, so the two paths are separable from the
  // tree's other six gates.
  const step = (state, { sep, height, dtMs }) => updateDistanceIntent(state, {
    nowMs: state.lastMs === null ? 0 : state.lastMs + dtMs,
    readable: true,
    separationM: sep,
    meanHeightM: height
  });
  const disarmed = (() => {
    let st = createDistanceIntentState();
    for (let i = 0; i <= 12; i += 1) {
      st = step(st, { sep: 0.4, height: 1.2 - (i * 0.025), dtMs: 33 });
    }
    assert.equal(st.armed, false, "the fixture really did disarm");
    return st;
  })();

  // RISING RE-ARMS ON THE FRAME IT IS SEEN, with no sustain at all. Without this
  // rule the lock above is possible (netHeightM +0.055 on a 0.53 m spread,
  // refused).
  const rising = step(disarmed, { sep: 0.4, height: 1.35, dtMs: 33 });
  assert.ok(rising.netHeightM >= DISTANCE_LOWERING_STEADY_M, "the fixture really is rising");
  assert.equal(rising.armed, true, "one frame of rising is enough");

  // LEVEL DOES NOT. The same frame count held at the bottom re-arms only once
  // the window has stopped showing the drop, and then only after the sustain.
  let level = step(disarmed, { sep: 0.4, height: 0.9, dtMs: 33 });
  assert.equal(level.armed, false, "standing still is not a statement yet");
  const levelStart = level.lastMs;
  while (!level.armed && level.lastMs - levelStart < 4000) {
    level = step(level, { sep: 0.4, height: 0.9, dtMs: 33 });
  }
  assert.equal(level.armed, true, "but it does get there");
  assert.ok(level.lastMs - levelStart >= DISTANCE_REARM_STILL_MS, "and it paid the sustain");
  assert.ok(DISTANCE_REARM_STILL_MS > 0 && DISTANCE_REARM_STILL_MS <= 250);
});

test("REPLAY: zoom out, then lower the arms so they swing apart — the reversal guard", () => {
  // The pose the guard exists for. An arm-drop's outward swing always follows
  // an inward stroke, and it is a real spread by every position and share test
  // there is; what disqualifies it is that it reverses a stroke that has only
  // just ended.
  const rig = settledRig(0.7, 1.2);
  const zoomOut = twoHandStroke(rig, {
    fromSeparationM: 0.7, toSeparationM: 0.44, fromHeightM: 1.2, toHeightM: 1.19, frames: 16
  });
  assert.ok(zoomOut.some((d) => d.distance.active), "the zoom-out stroke ran");
  assert.ok(zoomOut.some((d) => d.distance.deltaM < 0), "and it really was inward");

  // Hands stop; the stroke commits or cancels. Either way the guard is armed.
  const settled = rig.hold(450, {
    handDistanceM: 0.44, leftHandHeightM: 1.19, rightHandHeightM: 1.19
  });
  assert.ok(settled.some((d) => d.distance.releaseReason), "it let go");

  // The arms come down, swinging apart. Same separation profile as a re-spread.
  const swing = twoHandStroke(rig, {
    fromSeparationM: 0.44, toSeparationM: 0.70, fromHeightM: 1.19, toHeightM: 0.75, frames: 18
  });
  assert.ok(swing.every((d) => d.distance.active === false), "the swing does not zoom back in");
});

test("...but a deliberate re-spread after a zoom-out still works", () => {
  // The counterfactual the guard has to survive, or it is just a lockout. Same
  // reversal, at one height, and after the blackout: it must engage.
  const rig = settledRig(0.7, 1.2);
  twoHandStroke(rig, {
    fromSeparationM: 0.7, toSeparationM: 0.44, fromHeightM: 1.2, toHeightM: 1.19, frames: 16
  });
  rig.hold(DISTANCE_REARM_MS + 200, {
    handDistanceM: 0.44, leftHandHeightM: 1.19, rightHandHeightM: 1.19
  });
  const respread = twoHandStroke(rig, {
    fromSeparationM: 0.44, toSeparationM: 0.95, fromHeightM: 1.19, toHeightM: 1.19, frames: 22
  });
  assert.ok(respread.some((d) => d.distance.active), "a level re-spread clears 0.80");
});

test("no engage inside the post-release blackout", () => {
  assert.ok(DISTANCE_REARM_MS > 0 && DISTANCE_REARM_MS < DISTANCE_REVERSAL_GUARD_MS);
  assert.ok(DISTANCE_REARM_STILL_MS > 0);
  assert.ok(
    DISTANCE_PATH_REVERSE_RATIO > DISTANCE_PATH_ENGAGE_RATIO,
    "a reversal has to be more convincing than a first stroke, or the guard is nothing"
  );

  const state = createDistanceIntentState();
  const ended = noteDistanceStrokeEnd(state, { nowMs: 1000, strokeDirection: -1 });
  assert.equal(ended.rearmUntilMs, 1000 + DISTANCE_REARM_MS);
  assert.equal(ended.reversalGuardUntilMs, 1000 + DISTANCE_REVERSAL_GUARD_MS);
  assert.equal(ended.lastStrokeDirection, -1);
  // A release with no direction (the "rest" cancel ends where it started) keeps
  // the previous one rather than clearing the guard.
  const cancelled = noteDistanceStrokeEnd(ended, { nowMs: 1200, strokeDirection: 0 });
  assert.equal(cancelled.lastStrokeDirection, -1);
});

test("a refusal while nothing is running does not wipe the rest tracker", () => {
  // The trap this ordering exists to avoid: if a refused frame reset the rest
  // candidate, then after an arm-drop the user could never settle a new rest
  // (stillness produces no motion to change the verdict back) and the gesture
  // would be dead until something unrelated moved it.
  const rig = settledRig(0.4, 1.2);
  twoHandStroke(rig, {
    fromSeparationM: 0.4,
    toSeparationM: 0.6,
    fromHeightM: 1.2,
    toHeightM: 0.6,
    frames: 24
  });
  // Arms back up and held still, then an honest spread from there.
  rig.hold(600, { handDistanceM: 0.6, leftHandHeightM: 1.2, rightHandHeightM: 1.2 });
  const recovered = twoHandStroke(rig, {
    fromSeparationM: 0.6,
    toSeparationM: 0.95,
    fromHeightM: 1.2,
    toHeightM: 1.18,
    frames: 18
  });
  assert.ok(recovered.some((d) => d.distance.active), "the gesture recovers");
});

// --- the viewport gate -------------------------------------------------------
//
// An angular cone around head-forward destroys the gesture: a cone is a circle
// and SPREADING THE HANDS pushes them out of it. The gate is the real viewport:
// each hand projected through the active camera to NDC.

// The Quest's combined XR frustum, near enough for a fixture: ~110 deg
// horizontal by ~96 deg vertical. `ndcFor` turns a hand position expressed
// relative to the eyes into the { x, y } input.js would have measured, so the
// numbers below are body positions rather than magic constants.
const TAN_HALF_H = Math.tan((55 * Math.PI) / 180);
const TAN_HALF_V = Math.tan((48 * Math.PI) / 180);
function ndcFor({ lateralM, verticalM, forwardM }) {
  return {
    x: (lateralM / forwardM) / TAN_HALF_H,
    y: (verticalM / forwardM) / TAN_HALF_V,
    behind: forwardM <= 0
  };
}

// THE POSE THAT HAS TO SURVIVE: a 0.6-0.8 m spread at chest height, which is the
// gesture itself.
const CHEST_SPREADS = [
  { spreadM: 0.6, forwardM: 0.45, dropM: 0.35 },
  { spreadM: 0.7, forwardM: 0.45, dropM: 0.40 },
  { spreadM: 0.8, forwardM: 0.40, dropM: 0.45 }
];

function chestSpreadNdc({ spreadM, forwardM, dropM }, side) {
  return ndcFor({
    lateralM: (side === "left" ? -1 : 1) * (spreadM / 2),
    verticalM: -dropM,
    forwardM
  });
}

test("a 0.6-0.8 m hand spread at chest height stays IN VIEW", () => {
  // The regression that matters more than any other line in this file: if this
  // fails, the distance gesture is unusable.
  for (const pose of CHEST_SPREADS) {
    for (const side of ["left", "right"]) {
      const ndc = chestSpreadNdc(pose, side);
      assert.equal(
        handWithinViewport(ndc),
        true,
        `${pose.spreadM} m spread, ${side} hand: ndc ${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)}`
      );
    }
  }
});

test("...and the gate still refuses hands that really are out of frame", () => {
  // Otherwise the fix is just "delete the gate". Hands dropped to the lap are out.
  const lap = ndcFor({ lateralM: 0.2, verticalM: -0.9, forwardM: 0.4 });
  assert.equal(handWithinViewport(lap), false, "lap-height hands are out");
  // An arm flung sideways is NOT refused on x at all: the horizontal test is gone,
  // because widening it was never enough (NDC x explodes for a hand near the near
  // plane). The backstop for a genuine fling is `ndc.behind`, tested immediately
  // below.
  const wide = ndcFor({ lateralM: 1.4, verticalM: -0.2, forwardM: 0.3 });
  assert.equal(handWithinViewport(wide), true, "sideways is no longer disqualifying on its own");
  // Behind the head is out however plausible the projected x/y look; going
  // properly wide means going behind the shoulder.
  assert.equal(handWithinViewport({ x: 0, y: 0, behind: true }), false);
});

test("the viewport gate is VERTICAL ONLY now, and asymmetric above/below", () => {
  // The horizontal axis is deleted, not widened: the gesture only ever travels
  // along x, and NDC x explodes for a hand near the near plane (legitimate
  // 1.0-1.2 m tunnel spreads were seen at x = 3.02, -3.14 and 4.12 against a bound
  // of 3.0).
  const boundAbove = 1 + DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE;
  const boundBelow = 1 + DISTANCE_VIEW_NDC_MARGIN_Y_BELOW;
  for (const x of [3.02, -3.14, 4.12, 50, -50]) {
    assert.equal(handWithinViewport({ x, y: 0 }), true, `x ${x} no longer disqualifies anything`);
  }
  assert.equal(handWithinViewport({ x: 0, y: boundAbove }), true);
  assert.equal(handWithinViewport({ x: 0, y: boundAbove + 0.01 }), false);
  assert.equal(handWithinViewport({ x: 0, y: -boundBelow }), true, "exactly on the bound is inside");
  assert.equal(handWithinViewport({ x: 0, y: -boundBelow - 0.01 }), false);
  // THE ASYMMETRY ITSELF: the same distance below the frame is refused where
  // above it is allowed. Lowering the hands leaves the gesture; raising them
  // over your head does not, because nobody does that.
  assert.equal(handWithinViewport({ x: 0, y: 1.3 }), true);
  assert.equal(handWithinViewport({ x: 0, y: -1.3 }), false);
  // Generous, but not so generous that either direction means nothing.
  assert.ok(DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE > 0 && DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE < 1);
  assert.ok(DISTANCE_VIEW_NDC_MARGIN_Y_BELOW > 0 && DISTANCE_VIEW_NDC_MARGIN_Y_BELOW < 0.5);
  // `behind` is the whole backstop for a hand taken out sideways in earnest now.
  assert.equal(handWithinViewport({ x: 0.1, y: 0, behind: true }), false);
});

test("...and the strokes the tight bottom bound was killing now survive", () => {
  // Legitimate spreads were recorded at y = -1.15 and -1.16, so the bottom bound
  // (_BELOW) must clear them.
  for (const y of [-0.2, -0.6, -0.9, -1.13, -1.15, -1.16, -1.24]) {
    assert.equal(handWithinViewport({ x: 0.9, y }), true, `a stroke at y ${y} survives`);
  }
  // ...and the pose the band still exists to shed: hands parked at lap height,
  // which is y = -2.03 at 0.9 m below eye level and 0.4 m out.
  for (const y of [-1.3, -1.6, -2.03]) {
    assert.equal(handWithinViewport({ x: 0.9, y }), false, `parked hands at y ${y} leave`);
  }
});

// --- 16 real out-of-view releases --------------------------------------------
//
// Every `handNdc` pair logged next to a `reason:"out-of-view"` release in one
// session, copied verbatim from the diagnostics log. This measurement shows the
// horizontal axis is not "never close": eleven of these sixteen died on x.
const LOGGED_OUT_OF_VIEW_RELEASES = [
  { left: { x: -0.87, y: -0.51 }, right: { x: 1.39, y: -0.59 } },
  { left: { x: -1.36, y: -0.74 }, right: { x: 1.33, y: -0.59 } },
  { left: { x: -0.20, y: -1.31 }, right: { x: 0.82, y: -1.39 } },
  { left: { x: -1.41, y: -0.37 }, right: { x: 1.25, y: 0.03 } },
  { left: { x: -1.35, y: -0.59 }, right: { x: 1.08, y: -0.23 } },
  { left: { x: -0.55, y: -1.35 }, right: { x: 1.04, y: -1.20 } },
  { left: { x: -0.34, y: -0.09 }, right: { x: 1.35, y: -0.05 } },
  { left: { x: -0.63, y: -1.10 }, right: { x: 1.36, y: -1.14 } },
  { left: { x: -0.27, y: -1.30 }, right: { x: 0.76, y: -1.36 } },
  { left: { x: -0.67, y: -1.35 }, right: { x: 1.16, y: -1.20 } },
  { left: { x: -0.02, y: -1.33 }, right: { x: 0.41, y: -1.37 } },
  { left: { x: -1.41, y: -1.04 }, right: { x: 1.38, y: -0.44 } },
  { left: { x: -1.36, y: -0.26 }, right: { x: 1.37, y: 0.05 } },
  { left: { x: -1.27, y: -0.37 }, right: { x: 1.41, y: -0.02 } },
  { left: { x: -1.03, y: -0.19 }, right: { x: 1.40, y: 0.00 } },
  { left: { x: -0.91, y: -0.77 }, right: { x: 1.41, y: -0.91 } }
];

test("REPLAY: the 16 logged out-of-view releases, and which of them were wrong", () => {
  assert.equal(LOGGED_OUT_OF_VIEW_RELEASES.length, 16);
  // The shared 1 + 0.35 these were measured against, less half a rounding step:
  // the diag rounds NDC to two decimals, so a logged -1.35 was anything down to
  // -1.354999 in the frame that actually refused it.
  const OLD_BOUND = 1.35 - 0.005;

  // First, the diagnosis itself: under a shared margin every one of these was out
  // of view (that is why they are in the log), and eleven of them died on the x
  // axis.
  const worst = (pair, axis) => Math.max(Math.abs(pair.left[axis]), Math.abs(pair.right[axis]));
  const oldVerdict = LOGGED_OUT_OF_VIEW_RELEASES.map((pair) => ({
    onX: worst(pair, "x") >= OLD_BOUND,
    onY: worst(pair, "y") >= OLD_BOUND
  }));
  assert.ok(oldVerdict.every((v) => v.onX || v.onY), "all sixteen really were refused");
  assert.equal(oldVerdict.filter((v) => v.onX).length, 11, "eleven died on X");
  assert.equal(oldVerdict.filter((v) => v.onY).length, 5, "and only five on Y");

  // Nothing may fail on x any more...
  for (const { left, right } of LOGGED_OUT_OF_VIEW_RELEASES) {
    assert.equal(
      handWithinViewport({ x: left.x, y: 0 }),
      true,
      `left.x ${left.x} must no longer disqualify the stroke`
    );
    assert.equal(
      handWithinViewport({ x: right.x, y: 0 }),
      true,
      `right.x ${right.x} must no longer disqualify the stroke`
    );
  }

  // ...so most of the sixteen now stay engaged, and every one that still does
  // not is refused on the VERTICAL axis, with a hand at lap height. That is the
  // gate working, not the gate failing: y is the only axis left.
  const stillOut = LOGGED_OUT_OF_VIEW_RELEASES.filter(
    ({ left, right }) => !handWithinViewport(left) || !handWithinViewport(right)
  );
  assert.ok(stillOut.length <= 5, "at least eleven of the sixteen recovered");
  // The bottom bound moved from 0.15 to 0.25, which pulls y = -1.14 and -1.20 back
  // inside, but each of those pairs has its OTHER hand at -1.35/-1.36, so the five
  // refused pairs are still the same five.
  assert.equal(
    stillOut.length,
    oldVerdict.filter((v) => v.onY).length,
    "exactly the y-axis refusals survive"
  );
  for (const pair of stillOut) {
    assert.ok(
      worst(pair, "y") > 1 + DISTANCE_VIEW_NDC_MARGIN_Y_BELOW,
      "and every survivor is refused on the VERTICAL axis, which is what it is for"
    );
  }
});

test("an unreadable projection counts as in view, not as out of it", () => {
  // Same default as the dropout grace, and for the same reason: an unknown must
  // not be read as a deliberate act. Most tests in this file omit the NDC
  // entirely, which is the case this pins.
  assert.equal(handWithinViewport(null), true);
  assert.equal(handWithinViewport(undefined), true);
  assert.equal(handWithinViewport({ x: NaN, y: NaN }), true);
});

// Two readings for the tree-level tests below: comfortably on screen, and
// clearly off the side of it.
const IN_VIEW_NDC = ndcFor({ lateralM: 0.3, verticalM: -0.35, forwardM: 0.45 });
// Dropped to the lap and off the side of the frame at once, so it is out on BOTH
// axes (the x margin is generous enough that a fixture leaning on x alone would
// be a hair from the bound).
const OUT_OF_VIEW_NDC = ndcFor({ lateralM: 1.1, verticalM: -0.9, forwardM: 0.3 });

test("the log's own failing session would now engage and STAY engaged", () => {
  // Engage, then spread further, which is exactly what a cone-based release fired
  // on (engaged with handsInView:true, then released with reason:"out-of-view").
  const pose = (spreadM) => ({
    leftHandNdc: chestSpreadNdc({ spreadM, forwardM: 0.45, dropM: 0.40 }, "left"),
    rightHandNdc: chestSpreadNdc({ spreadM, forwardM: 0.45, dropM: 0.40 }, "right"),
    handDistanceM: spreadM
  });
  const rig = makeRig();
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 200, pose(0.4));
  const spreading = [
    ...rig.hold(120, pose(0.55)),
    ...rig.hold(120, pose(0.7)),
    ...rig.hold(120, pose(0.8))
  ];
  assert.ok(spreading.some((d) => d.distance.active), "the gesture engaged");
  assert.ok(
    spreading.every((d) => d.diag.handsInView === true),
    "and the widest spread is still in view"
  );
  assert.ok(
    spreading.every((d) => d.distance.releaseReason !== "out-of-view"),
    "no out-of-view release anywhere in the sweep"
  );
});

test("a hand leaving the viewport disengages the gesture WITHOUT snapping it back", () => {
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: IN_VIEW_NDC });
  const rest = 0.4;
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 200, { handDistanceM: rest });
  const spread = rest * (1 + DISTANCE_ENGAGE_REL + 0.2);
  const engaged = rig.hold(100, { handDistanceM: spread });
  assert.ok(engaged.some((d) => d.distance.active), "the gesture is running");
  const travelled = engaged[engaged.length - 1].distance.deltaM;
  assert.ok(travelled > 0, "and has written some travel");

  // The right hand swings out of frame, still perfectly tracked.
  const gone = rig.step({ handDistanceM: spread, rightHandNdc: OUT_OF_VIEW_NDC });
  assert.equal(gone.distance.active, false, "it lets go");
  assert.equal(gone.distance.releaseReason, "out-of-view");
  // Freezing, not snapping: the release writes NOTHING, so the caller keeps the
  // value the stroke gave it. The "rest" cancel is the exit that unwinds, and
  // this is deliberately not that one.
  assert.equal(gone.distance.deltaM, 0, "no farewell delta to snap the control");
  assert.notEqual(gone.distance.releaseReason, "rest");
});

test("a hand out of the viewport cannot start a gesture", () => {
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: OUT_OF_VIEW_NDC });
  const rest = 0.4;
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 300, { handDistanceM: rest });
  const spread = rig.hold(300, { handDistanceM: rest * (1 + DISTANCE_ENGAGE_REL + 0.2) });
  assert.ok(spread.every((d) => d.distance.active === false), "out of frame, no gesture");
  assert.equal(spread[spread.length - 1].diag.refusedGate, "view", "and it says so");
});

// --- the zoom does not fire on things that are not zooms ---------------------
// Misfires of zoom while reaching to capture.

test("hands closer than DISTANCE_MIN_SEPARATION_M cannot start a zoom", () => {
  // A separation gate, not a travel gate: the relative test is scale-free, so
  // at 10 cm apart a 3 cm wobble is a 30 % "stroke" and engages. Hands that
  // close together are doing something to each other, not to the sphere.
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: IN_VIEW_NDC });
  const rest = 0.10;
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 300, { handDistanceM: rest });
  const wobble = rig.hold(400, { handDistanceM: rest * (1 + DISTANCE_ENGAGE_REL + 0.4) });
  assert.ok(
    wobble.every((d) => d.distance.active === false),
    "no engage while the hands are inside the minimum separation"
  );
  assert.equal(wobble[wobble.length - 1].diag.refusedGate, "near", "and it says which gate");
  // ...and the gate is a floor, not a ban: open the same hands past it and the
  // very same motion works. The extremum kept tracking underneath, which is why
  // there is no second settle to pay.
  const opened = rig.hold(400, { handDistanceM: 0.5 });
  assert.ok(opened.some((d) => d.distance.active), "past the floor it engages normally");
});

test("REPLAY: reaching for the other wrist to poke Capture is NOT a zoom-out", () => {
  // The misfire itself: around `wristpoke itemId:"capture"` events the logged hand
  // separations run 0.074-0.136 m, one hand travelling to the other wrist, which to
  // a gesture that only sees the gap between the hands is a converging stroke
  // performed with conviction. Those separations are replayed here, with the
  // fingertip inside the panel's band for the last of them, exactly as it would be.
  //
  // NOTE the scope: this covers the END of the reach. The first half of a reach
  // that starts from a wide resting pose is a genuine converging stroke by every
  // measure the gesture has, and is stopped by the wrist gate only once the
  // fingertip is near the panel.
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: IN_VIEW_NDC });
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 300, { handDistanceM: 0.136 });
  const converging = [];
  for (const sep of [0.136, 0.128, 0.115, 0.102, 0.092, 0.081, 0.074]) {
    converging.push(...rig.hold(80, { handDistanceM: sep, wristPokeNear: sep <= 0.102 }));
  }
  assert.ok(
    converging.every((d) => d.distance.active === false),
    "the approach to a wrist panel never drives the zoom"
  );
  // And the log says why, by name, rather than going quiet the way
  // launcherCapturing does.
  assert.ok(
    converging.some((d) => d.diag.refusedGate === "wrist"),
    "the wrist gate is named in the diag"
  );
  assert.ok(converging.every((d) => d.diag.wristPokeNear === (d.diag.refusedGate === "wrist")));
});

test("the wrist gate suppresses the zoom on its own, before the freeze latches", () => {
  // Separate from the separation floor on purpose: the two cover different
  // halves of a poke. This one is the half where the hands are still far apart
  // — a fingertip already on the panel while the other arm happens to be out
  // wide — and it has to work without launcherCapturing, which only latches
  // once the panel's freeze has.
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: IN_VIEW_NDC });
  const rest = 0.4;
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 300, { handDistanceM: rest });
  const poking = rig.hold(400, {
    handDistanceM: rest * (1 + DISTANCE_ENGAGE_REL + 0.3),
    wristPokeNear: true,
    launcherCapturing: false
  });
  assert.ok(poking.every((d) => d.distance.active === false), "no zoom while poking a wrist");
  assert.equal(poking[poking.length - 1].diag.refusedGate, "wrist");
  // The moment the finger retreats, the control is available again — a fresh
  // stroke, because the suppression wiped the gesture's own state rather than
  // freezing it (same as an open panel, and unlike a dropout).
  rig.hold(200, { handDistanceM: rest });
  const after = rig.hold(400, { handDistanceM: rest * (1 + DISTANCE_ENGAGE_REL + 0.3) });
  assert.ok(after.some((d) => d.distance.active), "and it comes straight back");
});

test("the refusal vocabulary orders wrist before everything it could mask", () => {
  // distanceRefusalGate() is the log's only account of a refused engage, so the
  // order it reports gates in has to match the order the gesture applies them —
  // and `wrist` is named even though it shuts the same outer door
  // `launcherCapturing` does, which reports nothing at all.
  assert.equal(distanceRefusalGate({ engaged: true, wristNear: true }), "");
  assert.equal(distanceRefusalGate({ wristNear: true, unobservable: true }), "wrist");
  assert.equal(distanceRefusalGate({ unobservable: true }), "");
  assert.equal(
    distanceRefusalGate({ inView: false, wristNear: true }),
    "wrist",
    "a poke outranks a hand out of frame: it is the more specific answer"
  );
  assert.equal(
    distanceRefusalGate({
      inView: true,
      settled: true,
      armed: true,
      intent: true,
      pathOk: true,
      nearHands: true,
      hasBaseline: true
    }),
    "near"
  );
  // ...and `near` is the LAST engage-condition gate before the baseline, so a
  // stroke that has everything else right still reports the interesting reason.
  assert.equal(
    distanceRefusalGate({
      inView: true,
      settled: true,
      armed: true,
      intent: false,
      nearHands: true
    }),
    "intent"
  );
  assert.ok(DISTANCE_MIN_SEPARATION_M > 0.136, "wider than every wrist poke in the log");
  assert.ok(DISTANCE_MIN_SEPARATION_M < 0.25, "and narrower than any deliberate two-handed pose");
});

test("...but coming back into frame does NOT restart the tracking settle", () => {
  // The settle clock is about how long the TRACKING has been trustworthy; a hand
  // crossing the frame edge says nothing about that. Resetting it on the view
  // transition would make hands brought in from the sides pay a fresh 250 ms after
  // they were already on screen, on top of the stroke they still had to travel.
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: OUT_OF_VIEW_NDC });
  const rest = 0.4;
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 300, { handDistanceM: rest });
  assert.equal(rig.decision.diag.refusedGate, "view");

  // The hand comes back into frame and the pair immediately spreads, with no
  // still moment anywhere. The tracking gate must already be open.
  const back = rig.hold(200, {
    handDistanceM: rest,
    rightHandNdc: IN_VIEW_NDC
  });
  assert.ok(
    back.every((d) => d.diag.refusedGate !== "settle"),
    "the settle clock kept running while the hand was out of frame"
  );
  assert.ok(back[back.length - 1].diag.handsTrackedMs > DISTANCE_TRACKING_SETTLE_MS);
});

test("a short tracking DROPOUT still does not disengage — the grace survives the gate", () => {
  // An untracked hand has no projection at all, and reading that as "out of view"
  // would undo the dropout handling.
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: IN_VIEW_NDC });
  const rest = 0.4;
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 200, { handDistanceM: rest });
  const spread = rest * (1 + DISTANCE_ENGAGE_REL + 0.2);
  rig.hold(100, { handDistanceM: spread });
  assert.equal(rig.decision.distance.active, true);

  // One blink: no position, no projection, NaN separation.
  const blink = rig.step({
    rightPositioned: false,
    handDistanceM: NaN,
    rightHandNdc: null
  });
  assert.equal(blink.distance.active, false, "it freezes, as it always did");
  assert.equal(blink.distance.releaseReason, "", "but it is NOT a release");
  assert.equal(blink.state.distance.engaged, true, "and the gesture is still engaged");

  const back = rig.step({ handDistanceM: spread });
  assert.equal(back.distance.active, true, "and it continues where it was");
});

// --- WHY IT IS NOT ENGAGING --------------------------------------------------
//
// A log that records engagements and releases but says nothing about a refusal
// leaves the sessions where the gesture never fired with no evidence in them.
// These tests cover the refusal diagnostics.

test("the refusal gate names the FIRST binding condition, in the tree's own order", () => {
  const open = {
    engaged: false,
    unobservable: false,
    inView: true,
    settled: true,
    intent: true,
    hasBaseline: true
  };
  assert.equal(distanceRefusalGate(open), "", "nothing binding is not a refusal");
  assert.equal(distanceRefusalGate({ ...open, inView: false }), "view");
  assert.equal(distanceRefusalGate({ ...open, settled: false }), "settle");
  assert.equal(distanceRefusalGate({ ...open, intent: false }), "intent");
  assert.equal(distanceRefusalGate({ ...open, hasBaseline: false }), "no-baseline");
  // Ordering: the outermost gate wins, so the line names the one you have to
  // clear FIRST rather than whichever happens to be checked last.
  assert.equal(
    distanceRefusalGate({ ...open, inView: false, settled: false, intent: false }),
    "view"
  );
  // An engaged gesture is refusing nothing, and neither is a frame where the
  // gesture is not even being asked for — logging those would bury the rest.
  assert.equal(distanceRefusalGate({ ...open, inView: false, engaged: true }), "");
  assert.equal(distanceRefusalGate({ ...open, inView: false, unobservable: true }), "");
});

test("a refusal is logged ONCE per transition, not once per frame", () => {
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: OUT_OF_VIEW_NDC });
  const held = rig.hold(600, { handDistanceM: 0.4 });
  const refusals = held.flatMap((d) => d.events.filter((e) => e.outcome === "refused"));
  assert.equal(refusals.length, 1, "one line for a hand held out of frame for 600 ms");
  assert.equal(refusals[0].decision, "distance");
  assert.equal(refusals[0].reason, "view");
  assert.equal(refusals[0].target, "sphereZoom");

  // A different gate binding IS a new transition, and gets its own line.
  const back = rig.hold(400, { handDistanceM: 0.4, rightHandNdc: IN_VIEW_NDC });
  const next = back.flatMap((d) => d.events.filter((e) => e.outcome === "refused"));
  assert.deepEqual(
    next.map((e) => e.reason),
    ["path"],
    "the view gate handed over to the one that is now binding"
  );
});

test("the diag carries the three numbers the engage test is actually made of", () => {
  const rig = makeRig({ leftHandNdc: IN_VIEW_NDC, rightHandNdc: IN_VIEW_NDC });
  const rest = 0.4;

  // Nothing seen yet: no separation has been read, so travelRel has no
  // reference and must read differently from a travel of zero.
  const blind = rig.step({ leftPositioned: false, handDistanceM: NaN });
  assert.equal(blind.diag.restM, 0);
  assert.equal(blind.diag.travelRel, null, "null, not Infinity, and not 0");

  // One readable frame is enough to have a baseline: no stillness, no settle
  // window, just the turning point the hands are currently sitting on.
  const first = rig.step({ handDistanceM: rest });
  assert.ok(Math.abs(first.diag.restM - rest) < 1e-9, "a baseline from the first reading");

  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 200, { handDistanceM: rest });
  const settled = rig.decision;
  assert.ok(Math.abs(settled.diag.restM - rest) < 1e-9, "the turning point is on the line");
  assert.equal(settled.diag.baselineM, 0, "and nothing is engaged, so no baseline");
  assert.equal(settled.diag.travelRel, 0, "sitting exactly on it");

  // Halfway to the engage band: the number that says "the gesture is fine, the
  // hands just have not gone far enough yet".
  const partway = rig.step({ handDistanceM: rest * (1 + (DISTANCE_ENGAGE_REL / 2)) });
  assert.ok(partway.diag.travelRel > 0.1 && partway.diag.travelRel < DISTANCE_ENGAGE_REL);
  assert.equal(partway.diag.refusedGate, "", "nothing is refusing it");

  const engaged = rig.hold(100, { handDistanceM: rest * (1 + DISTANCE_ENGAGE_REL + 0.2) });
  const live = engaged.find((d) => d.distance.active);
  assert.ok(live, "engaged");
  assert.ok(live.diag.baselineM > 0 && live.diag.baselineM < rest * 1.1, "measuring from the baseline");
  assert.equal(live.diag.refusedGate, "");
  // The path layer's own two numbers, which is what a `lowering` release has to
  // be checkable against.
  assert.ok(live.diag.pathRatio > 0.9, "a level spread is almost pure separation");
  assert.ok(Math.abs(live.diag.netDropM) < 0.01, "and the hands did not go down");
  assert.equal(live.diag.armed, true);
});

test("the tree no longer imports the wrist summon's cone", () => {
  // "Is that ONE hand held in front of me" and "are BOTH hands still on screen" are
  // different questions, and answering the second with the first stops the gesture
  // working. withinCone() stays where it belongs.
  const src = fs.readFileSync(path.join(HERE, "..", "src", "xr-hand-gestures.js"), "utf8");
  assert.ok(!/^import /m.test(src), "the decision tree is dependency-free again");
  const summon = fs.readFileSync(path.join(HERE, "..", "src", "wrist-summon.js"), "utf8");
  assert.match(summon, /function withinCone/, "and the cone still exists for the summon");
});

test("input.js projects the hands through the ACTIVE camera, not through an angle", () => {
  // Source-level because it needs a live XR frame and a camera; the same reason
  // applyHandDistanceGesture()'s direction is asserted this way.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(input, /applyMatrix4\(camera\.matrixWorldInverse\)/, "into view space first");
  assert.match(input, /applyMatrix4\(camera\.projectionMatrix\)/, "then into NDC");
  assert.match(input, /out\.behind = _handNdc\.z >= 0;/, "with behind-the-head observed");
  assert.match(input, /leftHandNdc,\s+rightHandNdc,/, "and that is what the tree is given");
  assert.ok(
    !/handGazeCos/.test(input),
    "the angular cone measurement is gone, not merely unused"
  );
});

test("input.js feeds the tree the HORIZONTAL separation, not the raw 3-D distance", () => {
  // The tree only ever sees one scalar, so the "lowering both hands must do
  // nothing" property is only true if the measurement upstream is the projected
  // one. Source-level because it needs a live XR frame and a camera; the same
  // reason applyHandDistanceGesture()'s direction is asserted this way above.
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(
    input,
    /handSeparationM = horizontalSeparationM\(\s*_handSeparation,\s*twoHandGestureState\.separationAxis\s*\)/,
    "the separation is projected onto the viewer's horizontal axis"
  );
  assert.match(input, /handDistanceM: handSeparationM,/, "and that is what the tree is given");
  assert.ok(
    !/_leftHandAnchor\.distanceTo\(_rightHandAnchor\)/.test(input),
    "the raw 3-D distance is gone, not merely unused"
  );
  // The axis is frozen for the duration of a stroke: a head turn mid-gesture
  // would otherwise shorten the projection and write a zoom nobody performed.
  assert.match(
    input,
    /if \(!state\.xrHandGesture\.distance\.engaged\) \{\s*\n\s*twoHandGestureState\.separationAxis\.crossVectors\(_handViewForward, AXIS_Y\);/,
    "camera-right is refreshed only while the gesture is not engaged"
  );
});

// ============================================================================
// THE EYE-LEVEL POSE GATE. Looking around must not turn a hand coming into view
// into a zoom: the distance gesture only ENGAGES with both hands raised to about
// eye level, level with each other, in front of the head.
// ============================================================================

const POSE_HEAD_Y = 1.6;
const LOOK_AHEAD = { x: 0, y: 0, z: -1 };

// Head at the origin looking down -Z; hands `spreadM` apart. Heights are eye
// offsets, forward is metres in front of the head.
function eyeLevelPose({
  headY = POSE_HEAD_Y,
  leftOffsetM = -0.1,
  rightOffsetM = -0.1,
  leftForwardM = 0.35,
  rightForwardM = 0.35,
  spreadM = 0.4,
  headForward = LOOK_AHEAD
} = {}) {
  return {
    headPosition: { x: 0, y: headY, z: 0 },
    headForward,
    leftHandPosition: { x: -spreadM / 2, y: headY + leftOffsetM, z: -leftForwardM },
    rightHandPosition: { x: spreadM / 2, y: headY + rightOffsetM, z: -rightForwardM }
  };
}

test("the pose check passes hands raised to eye level, level, in front", () => {
  const verdict = distancePoseCheck(eyeLevelPose());
  assert.equal(verdict.readable, true);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.failed, "");
  assert.ok(Math.abs(verdict.leftForwardM - 0.35) < 1e-9);
});

test("the pose check refuses one hand low, uneven hands, and a hand beside or behind the head", () => {
  assert.equal(
    distancePoseCheck(eyeLevelPose({ rightOffsetM: -(DISTANCE_POSE_EYE_BELOW_M + 0.2) })).failed,
    "height",
    "a hand hanging below the chest"
  );
  const uneven = distancePoseCheck(eyeLevelPose({
    leftOffsetM: -0.02,
    rightOffsetM: -0.02 - (DISTANCE_POSE_LEVEL_M + 0.04)
  }));
  assert.equal(uneven.failed, "level", "both inside the eye band, but not level");
  assert.ok(uneven.heightDiffM > DISTANCE_POSE_LEVEL_M);
  assert.equal(distancePoseCheck(eyeLevelPose({ rightForwardM: 0 })).failed, "front", "beside the head");
  assert.equal(distancePoseCheck(eyeLevelPose({ leftForwardM: -0.2 })).failed, "front", "behind it");
});

test("REPLAY: looking around, a hand at the edge of a turned head's view cannot qualify", () => {
  // Hands in front of the BODY (-Z), head turned 60° to the right. The left hand is
  // beside the head as far as the head is concerned.
  const turned = { x: Math.sin(Math.PI / 3), y: 0, z: -Math.cos(Math.PI / 3) };
  const verdict = distancePoseCheck(eyeLevelPose({ headForward: turned, leftForwardM: 0.35, spreadM: 0.4 }));
  assert.equal(verdict.failed, "front");
  // ...while an ordinary 30° glance with the hands up still passes.
  const glance = { x: Math.sin(Math.PI / 6), y: 0, z: -Math.cos(Math.PI / 6) };
  assert.equal(distancePoseCheck(eyeLevelPose({ headForward: glance })).ok, true);
  // A 1.2 m tunnel spread keeps its wrists well in front: no cone failure.
  assert.equal(distancePoseCheck(eyeLevelPose({ spreadM: 1.2, leftForwardM: 0.3, rightForwardM: 0.3 })).ok, true);
});

test("the pose is RELATIVE to the head, not a world height", () => {
  for (const headY of [1.15, 1.6, 2.1, -0.4]) {
    assert.equal(distancePoseCheck(eyeLevelPose({ headY })).ok, true, `seated/standing/offset head at ${headY}`);
    assert.equal(
      distancePoseCheck(eyeLevelPose({ headY, rightOffsetM: -0.6 })).failed,
      "height",
      `and a low hand is low at ${headY} too`
    );
  }
  // Same WORLD hand heights, head raised 0.6 m: the hands are now at the chest.
  const standing = eyeLevelPose({ headY: POSE_HEAD_Y + 0.6, leftOffsetM: -0.7, rightOffsetM: -0.7 });
  assert.equal(distancePoseCheck(standing).failed, "height");
});

test("an unreadable pose is not a refusal, and looking straight down skips only the forward test", () => {
  assert.equal(distancePoseCheck({}).ok, true);
  assert.equal(distancePoseCheck({ ...eyeLevelPose(), headPosition: null }).ok, true);
  const down = { x: 0, y: -1, z: 0 };
  assert.equal(distancePoseCheck(eyeLevelPose({ headForward: down, leftForwardM: -0.3 })).ok, true);
  assert.equal(distancePoseCheck(eyeLevelPose({ headForward: down, rightOffsetM: -0.8 })).failed, "height");
});

test("an engaged stroke is held to the looser release margins", () => {
  const drifted = eyeLevelPose({
    leftOffsetM: -0.1,
    rightOffsetM: -0.1 - ((DISTANCE_POSE_LEVEL_M + DISTANCE_POSE_LEVEL_RELEASE_M) / 2)
  });
  assert.equal(distancePoseCheck(drifted).failed, "level", "too uneven to START a stroke");
  assert.equal(distancePoseCheck({ ...drifted, engaged: true }).ok, true, "but not to end one");
  assert.ok(DISTANCE_POSE_LEVEL_RELEASE_M > DISTANCE_POSE_LEVEL_M);
  assert.ok(DISTANCE_POSE_EYE_BELOW_RELEASE_M > DISTANCE_POSE_EYE_BELOW_M);
});

// Settle, then spread, all in one pose. Returns the rig.
function poseStroke(pose, overrides = {}) {
  const rig = makeRig(overrides);
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 120, { handDistanceM: 0.4, ...pose });
  rig.hold(100, { handDistanceM: 0.4 * 1.6, ...pose });
  return rig;
}

test("the tree engages at eye level, in the sphere and in the tunnel", () => {
  for (const [appState, target] of [
    [APP_STATE_INSIDE_SPHERE, "sphereZoom"],
    [APP_STATE_TUNNEL, "tunnelSpeed"]
  ]) {
    const rig = poseStroke(eyeLevelPose(), { appState });
    assert.equal(rig.decision.distance.active, true, appState);
    assert.equal(rig.decision.distance.target, target);
    assert.equal(rig.decision.diag.poseOk, true);
  }
});

test("the tree refuses a stroke with one hand low, in the sphere and in the tunnel", () => {
  for (const appState of [APP_STATE_INSIDE_SPHERE, APP_STATE_TUNNEL]) {
    const low = eyeLevelPose({ rightOffsetM: -0.7 });
    const rig = makeRig({ appState });
    const seen = [
      ...rig.hold(DISTANCE_TRACKING_SETTLE_MS + 120, { handDistanceM: 0.4, ...low }),
      ...rig.hold(400, { handDistanceM: 0.4 * 1.6, ...low })
    ];
    assert.ok(seen.every((d) => d.distance.active === false), `${appState}: no stroke`);
    const refusals = seen.flatMap((d) => d.events).filter((e) => e.outcome === "refused");
    assert.deepEqual(refusals.map((e) => e.reason), ["pose-height"], "one line naming the condition");
    const { diag } = rig.decision;
    assert.equal(diag.refusedGate, "pose-height");
    assert.equal(diag.poseFailed, "height");
    assert.ok(Math.abs(diag.poseEyeOffsetM.right + 0.7) < 1e-6, "the measured offset is on the line");
    assert.ok(Math.abs(diag.poseHeightDiffM - 0.6) < 1e-6);
    assert.ok(Math.abs(diag.poseForwardM.left - 0.35) < 1e-6);
  }
});

test("the tree refuses uneven hands and a hand beside the head", () => {
  const uneven = poseStroke(eyeLevelPose({ leftOffsetM: 0, rightOffsetM: -0.2 }));
  assert.equal(uneven.decision.distance.active, false);
  assert.equal(uneven.decision.diag.refusedGate, "pose-level");
  const beside = poseStroke(eyeLevelPose({ rightForwardM: -0.05 }));
  assert.equal(beside.decision.distance.active, false);
  assert.equal(beside.decision.diag.refusedGate, "pose-front");
});

test("hysteresis: an engaged stroke survives drift, and leaving the pose releases KEEPING the value", () => {
  const rig = poseStroke(eyeLevelPose());
  assert.equal(rig.decision.distance.active, true);
  // Keep the stroke moving so the ratchet does not commit underneath the test.
  let flip = false;
  const moving = (pose, ms) => {
    const seen = [];
    const end = rig.now + ms;
    while (rig.now <= end) {
      flip = !flip;
      seen.push(rig.step({ handDistanceM: 0.4 * (flip ? 1.6 : 1.75), ...pose }));
    }
    return seen;
  };
  // Drift past every ENGAGE margin, inside every RELEASE margin.
  const drift = eyeLevelPose({ leftOffsetM: -0.2, rightOffsetM: -0.38, rightForwardM: 0.05 });
  assert.equal(distancePoseCheck(drift).ok, false, "the drift could not start a stroke");
  const drifting = moving(drift, 400);
  assert.ok(drifting.every((d) => d.distance.active), "but the running stroke never flickers off");

  // Now really leave: the hand drops to the side.
  const gone = eyeLevelPose({ rightOffsetM: -0.8 });
  const leaving = moving(gone, DISTANCE_POSE_RELEASE_MS + 100);
  assert.equal(leaving[0].distance.active, true, "one frame is not a release");
  const release = leaving.find((d) => d.distance.releaseReason);
  assert.ok(release, "it releases");
  assert.equal(release.distance.releaseReason, "pose", "as a keep-the-value exit, not the rest cancel");
  const released = leaving.flatMap((d) => d.events).filter((e) => e.outcome === "released");
  assert.deepEqual(released.map((e) => e.reason), ["pose"]);
});

test("the stop signal still outranks the distance gesture at eye level", () => {
  const pose = eyeLevelPose();
  const rig = makeRig();
  rig.hold(200, { handDistanceM: 0.4, ...pose });
  const seen = rig.hold(STOP_POSE_STABILITY_MS + 200, {
    ...STOP_POSE,
    ...pose,
    handDistanceM: 0.4 * (1 + DISTANCE_ENGAGE_REL + 0.1)
  });
  assert.ok(seen.every((d) => d.distance.active === false), "no zoom while the stop pose is held");
  assert.ok(seen.some((d) => d.stop.justEngaged), "the stop signal latches");
  // And the pose gate does not stand in for it: a stop pose with the hands at
  // chest height still latches.
  const chest = makeRig();
  chest.hold(STOP_POSE_STABILITY_MS + 100, { ...STOP_POSE, ...eyeLevelPose({ leftOffsetM: -0.5, rightOffsetM: -0.5 }) });
  assert.equal(chest.decision.stop.latched, true);
});

test("the refusal vocabulary puts the pose after the viewport and before the settle", () => {
  const open = { inView: true, settled: true, intent: true, hasBaseline: true };
  assert.equal(distanceRefusalGate({ ...open, poseFailed: "front" }), "pose-front");
  assert.equal(distanceRefusalGate({ ...open, inView: false, poseFailed: "height" }), "view");
  assert.equal(distanceRefusalGate({ ...open, settled: false, poseFailed: "level" }), "pose-level");
  assert.equal(distanceRefusalGate({ ...open, poseFailed: "height", engaged: true }), "");
  assert.equal(distanceRefusalGate({ ...open, poseFailed: "height", unobservable: true }), "");
});

test("a pose flickering across its bound logs at most one line per interval", () => {
  const rig = makeRig();
  const ok = eyeLevelPose();
  const low = eyeLevelPose({ rightOffsetM: -0.7 });
  rig.hold(DISTANCE_TRACKING_SETTLE_MS + 120, { handDistanceM: 0.4, ...ok });
  const lines = (ms) => {
    const seen = [];
    const end = rig.now + ms;
    let frame = 0;
    while (rig.now <= end) {
      frame += 1;
      seen.push(rig.step({ handDistanceM: 0.4, ...(frame % 2 ? low : ok) }));
    }
    return seen.flatMap((d) => d.events).filter((e) => e.reason.startsWith("pose-"));
  };
  assert.equal(lines(DISTANCE_POSE_DIAG_INTERVAL_MS - 100).length, 1, "jitter is not a flood");
  assert.equal(lines(DISTANCE_POSE_DIAG_INTERVAL_MS).length, 1, "and the next interval gets its line");
});

test("input.js feeds the pose gate the camera's head pose and both wrist anchors", () => {
  const input = fs.readFileSync(path.join(HERE, "..", "src", "input.js"), "utf8");
  assert.match(input, /camera\.getWorldPosition\(_handHeadPosition\);/, "the head is the active camera");
  assert.match(input, /headPosition: leftHandTracked && rightHandTracked \? _handHeadPosition : null,/);
  assert.match(input, /headForward: leftHandTracked && rightHandTracked \? _handViewForward : null,/);
  assert.match(input, /leftHandPosition: leftHandTracked \? _leftHandAnchor : null,/);
  assert.match(input, /rightHandPosition: rightHandTracked \? _rightHandAnchor : null,/);
});
