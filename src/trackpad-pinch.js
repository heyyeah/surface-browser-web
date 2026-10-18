// Trackpad pinch -> the same distance gesture the hands and the touchscreen use.
//
// On macOS and Windows precision touchpads a pinch arrives as a `wheel` event
// with `ctrlKey: true`, not as touch events. The handler must preventDefault,
// or the browser zooms the whole document.
//
// The hand/touch distance gesture is a stroke (engage, running total, release);
// a wheel stream has no end event. So the stroke is manufactured: the first
// event after idle engages, each event adds to a running total, and the stroke
// ends after TRACKPAD_PINCH_IDLE_MS without events.
//
// Pure and clock-injected like touch-gestures.js, since the release is a timeout.

// App-state strings are imported from their owner; a local copy with a
// different spelling silently disabled the gesture.
import { APP_STATE_INSIDE_SPHERE, APP_STATE_TUNNEL } from "./xr-hand-gestures.js";

// Scale knob: metres of distance-gesture travel per wheel unit. A comfortable
// pinch is about 100 units end to end; 0.003 gives roughly the authority of
// spreading the hands (~0.3 m).
export const TRACKPAD_PINCH_METERS_PER_WHEEL_UNIT = 0.003;

// A gap in the wheel stream this long ends the stroke. Long enough to bridge
// the coarser burst timing on Windows, short enough that a pause reads as
// "let go" (a trackpad exposes no contact state).
export const TRACKPAD_PINCH_IDLE_MS = 140;

// Cap on a single event's magnitude. A ctrl+wheel mouse notch arrives as one
// large jump (100+ or a DOM_DELTA_LINE) rather than a fine stream; clamping
// keeps it usable as a coarse zoom instead of teleporting.
export const TRACKPAD_PINCH_MAX_UNITS_PER_EVENT = 60;


const IDLE_DISTANCE = Object.freeze({
  active: false,
  justEngaged: false,
  target: null,
  deltaM: 0
});

export function createTrackpadPinchState() {
  return {
    // Non-null only while a stroke is live.
    stroke: null
  };
}

function idleDecision() {
  return { distance: { ...IDLE_DISTANCE } };
}

function targetForAppState(appState) {
  if (appState === APP_STATE_INSIDE_SPHERE) {
    return "sphereZoom";
  }
  if (appState === APP_STATE_TUNNEL) {
    return "tunnelSpeed";
  }
  return null;
}

// Returns { state, handled }; `handled` tells the caller whether to
// preventDefault, so an unconsumed wheel still scrolls or zooms the page.
export function applyTrackpadWheelEvent(prev, {
  deltaY,
  ctrlKey = false,
  nowMs,
  enabled = true,
  appState,
  metersPerWheelUnit = TRACKPAD_PINCH_METERS_PER_WHEEL_UNIT,
  maxUnitsPerEvent = TRACKPAD_PINCH_MAX_UNITS_PER_EVENT
} = {}) {
  const state = { ...(prev || createTrackpadPinchState()) };
  if (!ctrlKey || !Number.isFinite(nowMs) || !Number.isFinite(deltaY)) {
    return { state, handled: false };
  }
  const target = targetForAppState(appState);
  if (!enabled || !target) {
    // NOT handled outside the tunnel and sphere: swallowing the event would
    // break browser page zoom on the start panel.
    return { state, handled: false };
  }

  // A pinch OPEN reports a negative deltaY; negate so fingers apart read like
  // hands and touch (faster in the tunnel, zoom in within the sphere).
  const units = -clampMagnitude(deltaY, maxUnitsPerEvent);

  if (!state.stroke || nowMs - state.stroke.lastAt > TRACKPAD_PINCH_IDLE_MS) {
    // metersPerWheelUnit is carried on the stroke so the stepper honours the
    // value the stroke started with.
    state.stroke = {
      totalUnits: units,
      lastAt: nowMs,
      engaged: false,
      target,
      metersPerWheelUnit
    };
  } else {
    state.stroke = {
      ...state.stroke,
      // A stroke keeps the target it engaged with across a tunnel/sphere
      // crossing; its baseline belongs to that target.
      totalUnits: state.stroke.totalUnits + units,
      lastAt: nowMs
    };
  }
  return { state, handled: true };
}

// The stepper, called once per rendered frame. It ends the stroke and is the
// only place `justEngaged` is true, so engage and first travel reach the
// applier in one decision.
export function stepTrackpadPinch(prev, { nowMs } = {}) {
  const state = { ...(prev || createTrackpadPinchState()) };
  const decision = idleDecision();
  if (!state.stroke || !Number.isFinite(nowMs)) {
    return { state, decision };
  }
  if (nowMs - state.stroke.lastAt > TRACKPAD_PINCH_IDLE_MS) {
    // The stroke ended. Reporting inactive makes the applier drop its baseline.
    state.stroke = null;
    return { state, decision };
  }
  const justEngaged = !state.stroke.engaged;
  state.stroke = { ...state.stroke, engaged: true };
  decision.distance = {
    active: true,
    justEngaged,
    target: state.stroke.target,
    deltaM: state.stroke.totalUnits * state.stroke.metersPerWheelUnit
  };
  return { state, decision };
}

function clampMagnitude(value, limit) {
  if (value > limit) {
    return limit;
  }
  if (value < -limit) {
    return -limit;
  }
  return value;
}
