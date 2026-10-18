// Touch controls (phone and tablet), resolved as pure functions.
//
// The existing VR gesture vocabulary is projected onto touch rather than
// inventing a mobile one:
//
//   Tap                       -> Select            (the same call the VR pinch makes)
//   One-finger drag           -> the GRAB model    (grabAngleTarget / stepGrabAngle /
//                                                   stepReleaseVelocity / releaseHandoff)
//   One finger held still     -> the drag BRAKE    (ROTATE_BRAKE_HOLD_MS, deadzone)
//   Two-finger pinch          -> the DISTANCE gesture (tunnel speed / sphere zoom)
//   Two-finger press and hold -> the GenAI chord, with a confirm hold
//
// There is no new rotation maths here. Screen pixels become the metres the VR
// pipeline uses (TOUCH_DRAG_HAND_METERS_PER_SHORT_EDGE) and everything downstream
// is the hand path's, so a feel constant moves for the headset too.
//
// Shape: `applyTouchPointerEvent()` is a decision-free recorder (pointer events
// are async and carry no dt) and `stepTouchGestures()` makes every decision once
// per frame from an injected clock, which makes tap/drag discrimination, the
// confirm hold and the money-safety property testable offline.
//
// DOM concerns live elsewhere: `touch-action: none` and friends on the canvas
// (styles.css), pointer capture and listener wiring (main.js), the
// devicePixelRatio cap (scene.js). Here: pointers tracked by pointerId so a third
// finger cannot corrupt the pair, and a dropout grace so a missing `pointercancel`
// (iOS does not reliably send it) cannot strand the gesture state.

import {
  APP_STATE_INSIDE_SPHERE,
  APP_STATE_TUNNEL,
  ROTATE_YAW_DEADZONE_M,
  ROTATE_PITCH_DEADZONE_M,
  ROTATE_BRAKE_HOLD_MS,
  ROTATE_THROW_SPEED_MPS,
  MAX_GESTURE_STEP_MS,
  createGrabState,
  stepGrabDisplacement,
  grabAngleTarget,
  stepGrabAngle,
  stepReleaseVelocity,
  releaseHandoff
} from "./xr-hand-gestures.js";

// --- The touch-only tunables -------------------------------------------------

// Tap vs drag. A tap is movement UNDER this many CSS pixels AND duration UNDER
// TOUCH_TAP_MAX_MS; the two tests are exact complements, so boundary values
// (10 px, 300 ms) read as drag.
const TOUCH_TAP_MAX_MOVE_PX = 10;
const TOUCH_TAP_MAX_MS = 300;

// Either finger travelling this far from where it landed makes the two-finger
// gesture a zoom and cancels the confirm hold for good. Just above the tap slop.
const TOUCH_PINCH_SLOP_PX = 12;

// Confirm hold for the chord. The VR chord's GENAI_CONFIRM_HOLD_MS is 200 ms but
// sits behind an ordered two-hand pinch; two fingers on a screen happen by
// accident, so touch asks for ~600 ms and a visible ring. This is the only
// touch number that legitimately differs from its VR counterpart.
const TOUCH_CHORD_HOLD_MS = 600;

// Delay before the confirm ring is drawn. A pinch-zoom and the chord both start
// with two fingers down and only diverge once one travels past
// TOUCH_PINCH_SLOP_PX, so drawing at once would flash the ring on every zoom.
// Delays drawing only: the hold clock starts at contact and the chord fires at
// TOUCH_CHORD_HOLD_MS regardless.
const TOUCH_CHORD_RING_DELAY_MS = 200;

// Hand travel (metres) that one short screen edge of finger travel is worth.
// At HAND_SPHERE_YAW_RAD_PER_M = 4.0, 0.35 m is 1.4 rad (~80 deg) of sphere.
// Deadzone, brake and throw threshold are in metres too, so raising this makes
// drags more sensitive and flicks easier to trigger, as a faster hand does in VR.
const TOUCH_DRAG_HAND_METERS_PER_SHORT_EDGE = 0.35;

// Backstop for a missing `pointercancel`: a contact with no event for this long
// is ended as if cancelled, so it can never fire a tap. A stranded pointer would
// hold sphereRotationInputActive, suppress idle drift and refuse every tap. It
// must outlast every legitimate hold, since a still finger emits no move events
// (the brake latches at TOUCH_TAP_MAX_MS + ROTATE_BRAKE_HOLD_MS = 550 ms, the
// chord at 600 ms).
const TOUCH_POINTER_STALE_MS = 4000;

// --- Small helpers -----------------------------------------------------------

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : (value > 1 ? 1 : value);
}

function distancePx(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function travelPx(pointer) {
  return Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY);
}

// Screen pixels -> the metres the VR pipeline uses. The SHORT edge, so rotating
// a phone to landscape does not change the drag feel.
function touchMetersPerPixel(shortEdgePx, metersPerShortEdge = TOUCH_DRAG_HAND_METERS_PER_SHORT_EDGE) {
  const edge = Number.isFinite(shortEdgePx) && shortEdgePx > 0 ? shortEdgePx : 0;
  const metres = Number.isFinite(metersPerShortEdge) ? metersPerShortEdge : 0;
  if (edge === 0) {
    return 0;
  }
  return metres / edge;
}

// --- The state ---------------------------------------------------------------

function createTouchGestureState() {
  return {
    // Tracked contacts in ARRIVAL ORDER (id field = pointerId); the order makes
    // "the pair is the first two fingers" well defined and a third finger harmless.
    pointers: [],
    // A multi-finger episode owns the screen until every finger has lifted, so
    // lifting one of two fingers can neither fire a tap nor start a drag.
    multiTouch: false,
    // One pinch pair per episode: once a member lifts it does not re-form.
    pinchDone: false,
    drag: null,
    pinch: null,
    braking: false
  };
}

const IDLE_ROTATE = {
  active: false,
  justEngaged: false,
  justReleased: false,
  deltaYawRad: 0,
  deltaPitchRad: 0,
  releaseSpin: null,
  braking: false
};

const IDLE_DISTANCE = {
  active: false,
  justEngaged: false,
  target: null,
  deltaM: 0
};

const IDLE_CHORD = {
  active: false,
  progress: 0,
  x: 0,
  y: 0,
  target: null
};

function idleDecision() {
  return {
    select: false,
    // Canvas-relative point where the tap landed, or null. The resolver stays
    // pure and only reports the point; the applier hit-tests, since a raycast
    // needs the scene.
    selectPoint: null,
    rotate: { ...IDLE_ROTATE },
    distance: { ...IDLE_DISTANCE },
    chord: { ...IDLE_CHORD },
    setPaused: null,
    pauseSource: ""
  };
}

// Decision-free: it writes down where a finger is and nothing else, so one fake
// clock drives every rule in stepTouchGestures().
function applyTouchPointerEvent(prev, { type, pointerId, x, y, now } = {}) {
  const state = prev || createTouchGestureState();
  if (!Number.isFinite(now)) {
    return state;
  }
  const pointers = state.pointers.slice();
  const index = pointers.findIndex((pointer) => pointer.id === pointerId);
  if (type === "down") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return state;
    }
    if (index >= 0) {
      // A second `down` for a live id means the previous contact was never ended
      // (missing pointercancel); treat it as this finger starting again.
      pointers.splice(index, 1);
    }
    pointers.push({
      id: pointerId,
      downX: x,
      downY: y,
      x,
      y,
      downAt: now,
      lastAt: now,
      up: false,
      upAt: 0,
      cancelled: false,
      // Set when this contact engages a drag, so its lift is never also a tap (a
      // drag out and back can end inside the tap slop).
      wasDrag: false
    });
    return { ...state, pointers };
  }
  if (index < 0) {
    // An event for a contact we are not tracking (started over the toolbar, or
    // already swept) is ignored so a stray `pointerup` cannot disturb a live gesture.
    return state;
  }
  const pointer = pointers[index];
  if (pointer.up) {
    return state;
  }
  if (type === "move") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return state;
    }
    pointers[index] = { ...pointer, x, y, lastAt: now };
    return { ...state, pointers };
  }
  if (type === "up" || type === "cancel") {
    pointers[index] = {
      ...pointer,
      x: Number.isFinite(x) ? x : pointer.x,
      y: Number.isFinite(y) ? y : pointer.y,
      lastAt: now,
      up: true,
      upAt: now,
      cancelled: type === "cancel"
    };
    return { ...state, pointers };
  }
  return state;
}

// --- The step ----------------------------------------------------------------
// One frame. Returns { state, decision }; the caller applies the decision through
// the existing appliers (applyHandDistanceGesture, applySphereGrabRotation,
// vrPauseSphereRotation, activateSelectedSphereLink,
// activateSelectedSphereImageForGenAi) and writes nothing of its own.
function stepTouchGestures(prev, {
  nowMs,
  dtS,
  enabled = true,
  appState,
  shortEdgePx,
  metersPerShortEdge = TOUCH_DRAG_HAND_METERS_PER_SHORT_EDGE,
  sphereRotationPaused = false,
  // Does the server have a GenAI relay? Defaults FALSE, the safe way round: a
  // caller that forgets gets no chord rather than one that spends. Arming is
  // refused outright so a build without GenAI never shows a ring that fills and
  // then does nothing.
  genAiAvailable = false,
  sphereYawSpeedRadPerS = 0,
  spherePitchSpeedRadPerS = 0,
  yawGainRadPerM = 0,
  pitchGainRadPerM = 0,
  zoomGain = 1,
  tapMaxMovePx = TOUCH_TAP_MAX_MOVE_PX,
  tapMaxMs = TOUCH_TAP_MAX_MS,
  pinchSlopPx = TOUCH_PINCH_SLOP_PX,
  chordHoldMs = TOUCH_CHORD_HOLD_MS,
  chordRingDelayMs = TOUCH_CHORD_RING_DELAY_MS,
  brakeHoldMs = ROTATE_BRAKE_HOLD_MS,
  throwSpeedMps = ROTATE_THROW_SPEED_MPS,
  staleMs = TOUCH_POINTER_STALE_MS
} = {}) {
  const state = {
    ...(prev || createTouchGestureState()),
    pointers: (prev?.pointers || []).map((pointer) => ({ ...pointer }))
  };
  const decision = idleDecision();
  if (!Number.isFinite(nowMs)) {
    return { state, decision };
  }
  // Same clamp as the hand tree: a hitch must not be integrated as a real frame,
  // and an injected clock must not manufacture a teleport for the rate clamp.
  const step = Number.isFinite(dtS) && dtS > 0 ? Math.min(dtS, MAX_GESTURE_STEP_MS / 1000) : 0;
  const metersPerPixel = touchMetersPerPixel(shortEdgePx, metersPerShortEdge);

  // 1. Dropout sweep: before anything reads the pointer list, end every contact
  //    silent for longer than a real gesture can be (TOUCH_POINTER_STALE_MS).
  for (const pointer of state.pointers) {
    if (!pointer.up && nowMs - pointer.lastAt > staleMs) {
      pointer.up = true;
      pointer.upAt = nowMs;
      pointer.cancelled = true;
    }
  }

  const inSphere = appState === APP_STATE_INSIDE_SPHERE;
  const inTunnel = appState === APP_STATE_TUNNEL;
  const gatesOpen = Boolean(enabled) && (inSphere || inTunnel) && metersPerPixel > 0;
  const active = state.pointers.filter((pointer) => !pointer.up);

  // 2. Multi-finger latch: two contacts at once stand down everything
  //    one-finger until the screen is clear.
  //
  //    Counted over every contact this step can see, not just live ones: released
  //    contacts are pruned at the end of each step, so a two-finger tap whose
  //    fingers both landed and lifted inside one frame is still two fingers and
  //    must not resolve to a select.
  if (state.pointers.length >= 2) {
    state.multiTouch = true;
  }

  // 3. Two-finger gestures: the pinch (distance) and the chord (GenAI).
  const pairIntact = state.pinch
    && active.some((pointer) => pointer.id === state.pinch.idA)
    && active.some((pointer) => pointer.id === state.pinch.idB);
  if (state.pinch && !pairIntact) {
    // A member lifted or was swept: the pair is finished for this episode and
    // does not re-form from the fingers that are left.
    state.pinch = null;
    state.pinchDone = true;
  }
  if (!state.pinch && !state.pinchDone && active.length >= 2 && gatesOpen) {
    // The pair is the first two fingers by arrival; a third is tracked but takes
    // no part.
    const first = active[0];
    const second = active[1];
    state.pinch = {
      idA: first.id,
      idB: second.id,
      // The hold runs from the instant the second finger landed, not the frame
      // that noticed, so it gains no extra frame and the ring starts at zero.
      downAt: Math.max(first.downAt, second.downAt),
      // Baselines are where each finger was when the pair formed, not where it
      // landed: a finger that dragged for seconds says nothing about whether the
      // two-finger gesture is holding still.
      startAX: first.x,
      startAY: first.y,
      startBX: second.x,
      startBY: second.y,
      startSeparationPx: distancePx(first, second),
      engaged: false,
      // The chord exists only inside the sphere, and only where there is
      // something for it to buy.
      chordArmed: inSphere && genAiAvailable,
      chordSpent: false,
      // Latched: a pinch read as a zoom never becomes a paid generation.
      chordCancelled: false
    };
  }
  if (state.pinch) {
    const first = state.pointers.find((pointer) => pointer.id === state.pinch.idA);
    const second = state.pointers.find((pointer) => pointer.id === state.pinch.idB);
    if (first && second && !first.up && !second.up) {
      const wasEngaged = state.pinch.engaged;
      // Moving either finger past the pinch threshold cancels the hold and
      // becomes a zoom: one test, two consequences, so zoom and chord are
      // mutually exclusive by construction rather than by a race.
      const movedPastSlop =
        Math.hypot(first.x - state.pinch.startAX, first.y - state.pinch.startAY) >= pinchSlopPx
        || Math.hypot(second.x - state.pinch.startBX, second.y - state.pinch.startBY) >= pinchSlopPx;
      if (movedPastSlop) {
        state.pinch.engaged = true;
        state.pinch.chordCancelled = true;
      }
      if (!gatesOpen) {
        state.pinch.chordCancelled = true;
      }

      if (state.pinch.engaged && gatesOpen) {
        const separationPx = distancePx(first, second);
        decision.distance = {
          active: true,
          justEngaged: !wasEngaged,
          // Read through appState exactly as the hand path does. Fingers apart
          // = hands apart: faster in the tunnel, zoomed IN in the sphere.
          target: inSphere ? "sphereZoom" : "tunnelSpeed",
          deltaM: (separationPx - state.pinch.startSeparationPx) * metersPerPixel
        };
      }

      // Confirm hold. Firing requires the hold to run to completion with neither
      // finger past the pinch slop, so a zoom-length pinch and a two-finger tap
      // that did not travel are both structurally unable to reach it.
      const chordLive = state.pinch.chordArmed
        && !state.pinch.chordCancelled
        && !state.pinch.chordSpent
        && inSphere
        && gatesOpen;
      if (chordLive) {
        const heldMs = nowMs - state.pinch.downAt;
        const midX = (first.x + second.x) / 2;
        const midY = (first.y + second.y) / 2;
        if (heldMs >= chordHoldMs) {
          state.pinch.chordSpent = true;
          decision.chord = { active: false, progress: 1, x: midX, y: midY, target: "genai" };
        } else if (heldMs >= chordRingDelayMs) {
          // Progress runs across the visible span so the arc starts empty and
          // reaches full exactly as the chord fires.
          const span = Math.max(1, chordHoldMs - chordRingDelayMs);
          const progress = clamp01((heldMs - chordRingDelayMs) / span);
          decision.chord = { active: true, progress, x: midX, y: midY, target: null };
        }
        // Before the delay: no ring; the hold is still running.
      }
    }
  }

  // 4. One-finger drag: the grab model, with the brake inside it.
  //
  // Engage first, so the grab is anchored on the step it engages (as the hand
  // tree does); deferring a frame would let the re-anchor swallow that motion.
  let dragJustEngaged = false;
  if (!state.drag && active.length === 1 && !state.multiTouch && gatesOpen && inSphere) {
    const pointer = active[0];
    // Exact complement of the tap test below: movement AT the slop, or duration
    // AT the limit, is a drag.
    const isDrag = travelPx(pointer) >= tapMaxMovePx || nowMs - pointer.downAt >= tapMaxMs;
    if (isDrag) {
      pointer.wasDrag = true;
      state.drag = {
        id: pointer.id,
        // The DOWN point, not the current one: stepGrabDisplacement()'s re-anchor
        // zeroes displacement on this step, absorbing the slop instead of a jump.
        anchorX: pointer.downX,
        anchorY: pointer.downY,
        grab: createGrabState(),
        brakeSinceMs: 0
      };
      state.braking = false;
      dragJustEngaged = true;
    }
  }

  if (state.drag) {
    const pointer = state.pointers.find((item) => item.id === state.drag.id);
    const stillLive = Boolean(pointer) && !pointer.up;
    const soloLive = stillLive && active.length === 1;
    if (!soloLive || !gatesOpen || !inSphere) {
      // Release. Every way a drag can end runs through here (finger lifted,
      // second finger, sweep, app left the sphere), so there is one handoff.
      const grab = state.drag.grab;
      const releaseSpin = releaseHandoff({
        velLateralMps: grab.velLateralMps,
        velVerticalMps: grab.velVerticalMps,
        netLateralM: grab.lateralM,
        netVerticalM: grab.verticalM,
        yawSpeedRadPerS: sphereYawSpeedRadPerS,
        pitchSpeedRadPerS: spherePitchSpeedRadPerS,
        yawGainRadPerM,
        pitchGainRadPerM,
        zoomGain
      });
      decision.rotate = {
        ...IDLE_ROTATE,
        justReleased: true,
        releaseSpin
      };
      // A release hard enough to be a throw hands the pause back; otherwise a
      // braked sphere could only be restarted by flinging without letting go.
      if (releaseSpin.speedMps >= throwSpeedMps && sphereRotationPaused) {
        decision.setPaused = false;
        decision.pauseSource = "release-throw";
      }
      state.drag = null;
      state.braking = false;
    } else {
      const rawLateralM = (pointer.x - state.drag.anchorX) * metersPerPixel;
      const rawVerticalM = -(pointer.y - state.drag.anchorY) * metersPerPixel;
      const grabPrev = state.drag.grab;
      // `positioned: true` always: an existing touch contact is visible. A finger
      // the browser stops reporting is ended by the sweep rather than
      // extrapolated, because it is genuinely absent.
      let grab = stepGrabDisplacement(grabPrev, {
        positioned: true,
        rawLateralM,
        rawVerticalM,
        dtS: step
      });
      // Signs match the hand grab and the desktop mouse
      // (input.js applyDesktopSpherePointerDelta): finger right turns the sphere
      // so content moves right (negative yaw), finger up moves content up
      // (positive pitch). Screen y grows downward, hence the one negation.
      const targetYawRad = -grabAngleTarget(
        grab.lateralM,
        ROTATE_YAW_DEADZONE_M,
        yawGainRadPerM,
        zoomGain
      );
      const targetPitchRad = grabAngleTarget(
        grab.verticalM,
        ROTATE_PITCH_DEADZONE_M,
        pitchGainRadPerM,
        zoomGain
      );
      const yawStep = stepGrabAngle(grab.appliedYawRad, targetYawRad, { dtS: step });
      const pitchStep = stepGrabAngle(grab.appliedPitchRad, targetPitchRad, { dtS: step });
      const sampleable = grabPrev.positioned && step > 0;
      grab = {
        ...grab,
        appliedYawRad: yawStep.appliedRad,
        appliedPitchRad: pitchStep.appliedRad,
        velLateralMps: stepReleaseVelocity(grab.velLateralMps, {
          sampleMps: sampleable ? (grab.lateralM - grabPrev.lateralM) / step : NaN,
          dtS: step
        }),
        velVerticalMps: stepReleaseVelocity(grab.velVerticalMps, {
          sampleMps: sampleable ? (grab.verticalM - grabPrev.verticalM) / step : NaN,
          dtS: step
        })
      };
      state.drag.grab = grab;

      // Brake: "no separate stop gesture". A drag parked inside both per-axis
      // deadzones for ROTATE_BRAKE_HOLD_MS latches the pause, as the pinch-hold
      // does in VR. Measured on the offset-corrected displacement (from where
      // the drag engaged; on touch the offset is only the one-time tap slop).
      const insideDeadzone = Math.abs(grab.lateralM) <= ROTATE_YAW_DEADZONE_M
        && Math.abs(grab.verticalM) <= ROTATE_PITCH_DEADZONE_M;
      state.drag.brakeSinceMs = insideDeadzone
        ? (state.drag.brakeSinceMs || nowMs)
        : 0;
      const braking = insideDeadzone
        && Boolean(state.drag.brakeSinceMs)
        && nowMs - state.drag.brakeSinceMs >= brakeHoldMs;
      if (braking && !state.braking) {
        decision.setPaused = true;
        decision.pauseSource = "brake";
      }
      state.braking = braking;

      decision.rotate = {
        active: true,
        justEngaged: dragJustEngaged,
        justReleased: false,
        deltaYawRad: yawStep.deltaRad,
        deltaPitchRad: pitchStep.deltaRad,
        releaseSpin: null,
        braking
      };
    }
  }

  // 5. Tap: resolved on the lift, only for a contact that was alone on the
  //    screen for its whole life, was not cancelled, and never engaged a drag.
  for (const pointer of state.pointers) {
    if (!pointer.up || pointer.cancelled || pointer.wasDrag) {
      continue;
    }
    if (state.multiTouch || !gatesOpen || !inSphere) {
      continue;
    }
    const movedPx = travelPx(pointer);
    const heldMs = pointer.upAt - pointer.downAt;
    if (movedPx < tapMaxMovePx && heldMs < tapMaxMs) {
      decision.select = true;
      decision.selectPoint = { x: pointer.x, y: pointer.y };
    }
  }

  // 6. Prune, then clear the episode latches once the screen is empty.
  state.pointers = state.pointers.filter((pointer) => !pointer.up);
  if (state.pointers.length === 0) {
    state.multiTouch = false;
    state.pinchDone = false;
    state.pinch = null;
  }

  return { state, decision };
}

export {
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
};
