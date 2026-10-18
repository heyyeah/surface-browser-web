// Shift + click-drag on the desktop: zoom while dragging, generate while still.
//
// Pure and clock-injected, because one pointer stroke decides between "free"
// (zoom) and "spends money" (the GenAI chord). Travelling past the slop latches
// the chord off for the whole stroke, and firing requires the hold to run to
// completion, so a drag can never become a purchase. Same rule as the touch
// chord in touch-gestures.js.

import { APP_STATE_INSIDE_SPHERE, APP_STATE_TUNNEL } from "./xr-hand-gestures.js";

// Past this much travel the stroke is a zoom, permanently.
export const SHIFT_DRAG_SLOP_PX = 8;
// Same hold as the touch chord.
export const SHIFT_DRAG_CHORD_HOLD_MS = 600;
// Screen pixels to "hand metres" for the distance gesture, normalised to the
// window's short edge so a zoom is the same size on any window.
export const SHIFT_DRAG_METERS_PER_SHORT_EDGE = 0.5;

const IDLE = Object.freeze({
  distance: Object.freeze({ active: false, justEngaged: false, target: null, deltaM: 0 }),
  chord: Object.freeze({ active: false, progress: 0, x: 0, y: 0, target: null })
});

export function createShiftDragState() {
  return { stroke: null };
}

function idleDecision() {
  return { distance: { ...IDLE.distance }, chord: { ...IDLE.chord } };
}

function targetForAppState(appState) {
  if (appState === APP_STATE_INSIDE_SPHERE) return "sphereZoom";
  if (appState === APP_STATE_TUNNEL) return "tunnelSpeed";
  return null;
}

// `handled` tells the caller whether to preventDefault.
export function applyShiftDragEvent(prev, {
  type,
  pointerId,
  x,
  y,
  nowMs,
  shiftKey = false,
  enabled = true,
  appState
} = {}) {
  const state = { ...(prev || createShiftDragState()) };
  if (!Number.isFinite(nowMs) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { state, handled: false };
  }

  if (type === "down") {
    if (!shiftKey || !enabled || !targetForAppState(appState)) {
      return { state, handled: false };
    }
    state.stroke = {
      pointerId,
      anchorX: x,
      anchorY: y,
      x,
      y,
      downAt: nowMs,
      engaged: false,
      // Latched: a stroke read as a zoom never becomes a paid generation.
      chordCancelled: false,
      chordSpent: false,
      target: targetForAppState(appState)
    };
    return { state, handled: true };
  }

  if (!state.stroke || state.stroke.pointerId !== pointerId) {
    return { state, handled: false };
  }

  if (type === "move") {
    const travel = Math.hypot(x - state.stroke.anchorX, y - state.stroke.anchorY);
    state.stroke = {
      ...state.stroke,
      x,
      y,
      engaged: state.stroke.engaged || travel >= SHIFT_DRAG_SLOP_PX,
      chordCancelled: state.stroke.chordCancelled || travel >= SHIFT_DRAG_SLOP_PX
    };
    return { state, handled: true };
  }

  if (type === "up" || type === "cancel") {
    state.stroke = null;
    return { state, handled: true };
  }
  return { state, handled: false };
}

// Releasing shift mid-stroke ends it, so the stroke stops zooming off a
// modifier that is no longer held.
export function releaseShiftDrag(prev) {
  const state = { ...(prev || createShiftDragState()) };
  state.stroke = null;
  return state;
}

// The ring appears this long after the press. A shift+click that becomes a drag
// and a shift+hold that becomes a chord start identically, so drawing at once
// would flash the ring on every zoom. Delays drawing only; the hold clock and
// the firing moment are unchanged.
export const SHIFT_DRAG_CHORD_RING_DELAY_MS = 200;

export function stepShiftDrag(prev, {
  nowMs,
  shortEdgePx,
  metersPerShortEdge = SHIFT_DRAG_METERS_PER_SHORT_EDGE,
  genAiAvailable = false,
  chordHoldMs = SHIFT_DRAG_CHORD_HOLD_MS,
  chordRingDelayMs = SHIFT_DRAG_CHORD_RING_DELAY_MS
} = {}) {
  const state = { ...(prev || createShiftDragState()) };
  const decision = idleDecision();
  if (!state.stroke || !Number.isFinite(nowMs)) {
    return { state, decision };
  }
  const stroke = { ...state.stroke };

  if (stroke.engaged) {
    const metersPerPixel = shortEdgePx > 0 ? metersPerShortEdge / shortEdgePx : 0;
    // Dragging UP zooms IN, the same sense as hands moving apart.
    const deltaM = (stroke.anchorY - stroke.y) * metersPerPixel;
    decision.distance = {
      active: true,
      justEngaged: !stroke.reported,
      target: stroke.target,
      deltaM
    };
    stroke.reported = true;
    state.stroke = stroke;
    return { state, decision };
  }

  // The chord is live only inside the sphere, only where there is a relay to
  // buy from, and only until the stroke travels.
  const chordLive = !stroke.chordCancelled
    && !stroke.chordSpent
    && genAiAvailable
    && stroke.target === "sphereZoom";
  if (chordLive) {
    const heldMs = nowMs - stroke.downAt;
    if (heldMs >= chordHoldMs) {
      stroke.chordSpent = true;
      decision.chord = { active: false, progress: 1, x: stroke.x, y: stroke.y, target: "genai" };
    } else if (heldMs >= chordRingDelayMs) {
      // Same delay as the touch chord. Progress runs across the visible span so
      // the arc starts empty.
      const span = Math.max(1, chordHoldMs - chordRingDelayMs);
      const progress = Math.min(1, Math.max(0, (heldMs - chordRingDelayMs) / span));
      decision.chord = { active: true, progress, x: stroke.x, y: stroke.y, target: null };
    }
  }
  state.stroke = stroke;
  return { state, decision };
}
