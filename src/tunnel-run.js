// Where a new tunnel run starts along the path.
//
// A new run continues from where the exit flight left the camera; resetting to
// a fixed ring would teleport it the moment a request is issued. Ring 5 is only
// the fallback: the path is finite, so when too little remains for the panels,
// lead-in and exit, the camera goes back to the start.
//
// Pure: no DOM, no three.js, no state.

import { SPHERE_ENTRY_LEAD_RINGS, SPHERE_EXIT_DISTANCE_RINGS } from "./constants.js";

export const TUNNEL_RUN_START_RING = 5;

// Lead-in, exit flight, and room for the panels that spawn between them.
export const TUNNEL_RUN_RUNWAY_RINGS =
  SPHERE_ENTRY_LEAD_RINGS + SPHERE_EXIT_DISTANCE_RINGS + 200;

export function tunnelRunStartRing({
  currentRing = TUNNEL_RUN_START_RING,
  maxCameraRing = 0,
  runwayRings = TUNNEL_RUN_RUNWAY_RINGS
} = {}) {
  const ring = Number(currentRing);
  const max = Number(maxCameraRing);
  const runway = Number(runwayRings);
  if (!Number.isFinite(ring) || ring <= TUNNEL_RUN_START_RING) {
    return TUNNEL_RUN_START_RING;
  }
  if (!Number.isFinite(max) || !Number.isFinite(runway)) {
    return TUNNEL_RUN_START_RING;
  }
  return ring + runway <= max ? ring : TUNNEL_RUN_START_RING;
}

// The sphere exit accelerates to SPHERE_EXIT_MAX_SPEED but the next run wants
// DEFAULT_CAMERA_SPEED; snapping between them is a visible jump, so ease the
// speed back over about a second.
export const TUNNEL_SPEED_EASE_TAU_S = 0.3;
export const TUNNEL_SPEED_EASE_EPSILON = 0.1;

export function easeTunnelSpeed(current, target, dt, tau = TUNNEL_SPEED_EASE_TAU_S) {
  const from = Number(current);
  const to = Number(target);
  const step = Number(dt);
  const time = Number(tau);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { speed: Number.isFinite(to) ? to : 0, done: true };
  }
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(time) || time <= 0) {
    return { speed: to, done: true };
  }
  // Frame-rate independent: the same curve at 60 Hz and at 90 Hz.
  const blended = to + (from - to) * Math.exp(-step / time);
  if (Math.abs(blended - to) <= TUNNEL_SPEED_EASE_EPSILON) {
    return { speed: to, done: true };
  }
  return { speed: blended, done: false };
}
