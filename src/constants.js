// Shared constants.
//
// Read-only configuration: tunable feel parameters, the app-state enum, fixed
// axis directions and the fog palette. DOM-derived values (e.g. the default
// camera speed) and mutable scratch vectors stay in their owning modules.

import * as THREE from "three";

// The reference ports specify fog colors in sRGB / display space, but
// `new THREE.Color(r, g, b)` treats the args as linear RGB and three then
// gamma-encodes on output, brightening everything (deep navy (0.11, 0.12, 0.50)
// shows as pale periwinkle). `setRGB` with an explicit sRGB color space tag
// converts correctly.
export const TUNNEL_FOG_COLOR = new THREE.Color().setRGB(0.69, 0.80, 0.97, THREE.SRGBColorSpace);
export const SPHERE_FOG_COLOR = new THREE.Color().setRGB(0.11, 0.12, 0.50, THREE.SRGBColorSpace);
export const SPHERE_IDLE_COLOR = 0x90a8ff;
export const SPHERE_NO_LINK_COLOR = 0x3f4f9c;

export const IMAGE_SPAWN_INTERVAL_MS = 1300;
export const MAX_PANELS = 15;
export const SPHERE_IMAGE_COUNT = 8;
export const SPHERE_DWELL_SECONDS = 20;
export const SPHERE_ENTRY_SETTLE_MS = 1200;
// The GenAI tunnel handoff is gated by job completeness, not a timer. The
// default must be 0 (transition once all expected images have arrived and the
// panel queue has drained); a non-zero value is a theatrical floor.
export const GENAI_MIN_TUNNEL_DISPLAY_MS = 0;
export const SPHERE_ENTRY_LEAD_RINGS = 60;
export const SPHERE_ENTRY_AFTER_LAST_PANEL_RINGS = 40;
export const SPHERE_EXIT_DISTANCE_RINGS = 25;
// Length of the camera-iris "shutter opening" animation on arriving inside the
// sphere. The start scale matches SPHERE_PREVIEW_MAX_SCALE so the approach
// preview does not shrink to a dot at the tunnel/sphere threshold.
export const SPHERE_IRIS_OPEN_SECONDS = 1.4;
export const SPHERE_IRIS_OPEN_START_SCALE = 0.2;
// Pre-entry bloom: the shutter starts opening during the approach. The camera
// visually crosses the wall well before fadeProgress reaches 1 (the sphere is
// only ~0.2–0.7 scale then), so the pre-open must complete by PREOPEN_END, not
// 1.0. Distance-locked: the open amount tracks proximity, whatever the speed.
// PREOPEN_MAX_T is how much of the clock elapses by PREOPEN_END; the rest plays
// out inside on real time.
export const SPHERE_IRIS_PREOPEN_START = 0.65;
export const SPHERE_IRIS_PREOPEN_END = 0.9;
export const SPHERE_IRIS_PREOPEN_MAX_T = 0.6;
// Ring distance over which fog color + sphere panel appearance fade from tunnel
// to sphere during TRANSITION_TO_SPHERE. Matching SPHERE_ENTRY_LEAD_RINGS makes
// the blend span the whole transition.
export const SPHERE_TRANSITION_FADE_RINGS = 60;
export const SPHERE_TUNNEL_HIDE_PROGRESS = 0.35;
export const SPHERE_TRANSITION_FOG_FAR = 20;
// How long the fog envelope takes to open once inside the sphere. It cannot ride
// the iris clock, which pre-opens during the approach and would make it jump.
export const SPHERE_FOG_OPEN_SECONDS = 1.2;
export const SPHERE_PREVIEW_MIN_SCALE = 0.12;
export const SPHERE_PREVIEW_MAX_SCALE = 0.2;
export const SPHERE_EXIT_MIN_SPEED = 16;
export const SPHERE_EXIT_ACCEL = 6;
export const SPHERE_EXIT_MAX_SPEED = 22;
export const TUNNEL_FADE_IN_SECONDS = 2.0;
export const TUNNEL_TUBE_OPACITY = 0.85;
// Two-hand distance gesture output gains: control travel per metre of hand
// travel. The engage/release thresholds live with the decision tree in
// src/xr-hand-gestures.js. Effective travel is roughly 0.5–0.7 m either side of
// the engage deadband; at 40 units/m that is most of the 4..45 speed range.
export const HAND_SPHERE_ZOOM_UNITS_PER_METER = 26;
export const HAND_TUNNEL_SPEED_UNITS_PER_METER = 40;
// Rotate drag: full deflection (ROTATE_FULL_DEFLECTION_M = 0.22 m of hand travel
// from the anchor) is worth this much rotation speed, in radians/second. The
// hand drag is velocity-proportional while the thumbstick is acceleration-based
// (see src/xr-hand-gestures.js), so the two numbers are deliberately unrelated.
//
// 2.2 rad/s is ~126°/s: just under three seconds per full turn at maximum
// deflection, against the +/-4 rad/s the stick can reach and the 0.12 rad/s the
// sphere drifts at by itself. This is the main knob for "the drag is too fast /
// too slow"; the model cannot run away whatever it is set to. A running sphere
// also applies its own 0.95-per-frame decay in sphere.js, so the settled speed
// is roughly three quarters of this at 72 Hz.
//
// Pitch is kept equal to yaw so a diagonal drag reads as one movement.
// Used only by ?drag=vel.
export const HAND_SPHERE_YAW_SPEED_MAX = 2.2;
// Used only by ?drag=vel.
export const HAND_SPHERE_PITCH_SPEED_MAX = 2.2;

// The grab model: hand displacement names an angle, not a speed. Drag 0.1 m and
// the sphere turns 0.4 rad and stops there, however long the hand is held. (The
// velocity model above turns the sphere forever while a displacement is held.)
//
// 4.0 rad/m is calibrated to the sphere's geometry: one image subtends ~0.74 rad
// (7.0 m of arc at the 9.5 m panel radius), so moving one image across takes
// 0.185 m of hand. A full turn is 1.57 m, deliberately more than one stroke;
// long sweeps are what the release throw is for.
//
// Main knob for "the drag moves too little / too much per stroke". The mapping
// is linear: a position map should track the hand, and a curve would make the
// same stroke worth different amounts depending on where it started.
export const HAND_SPHERE_YAW_RAD_PER_M = 4.0;
// Kept equal to yaw: unequal gains skew a diagonal drag away from the hand, and
// "the sphere follows my hand" is the property wanted. The horizontal axis gets
// its compensation from the smaller deadzone instead. Raising YAW to ~4.6 would
// favour horizontal at the cost of that skew.
export const HAND_SPHERE_PITCH_RAD_PER_M = 4.0;
export const SPHERE_VIEW_OFFSET_INWARD_MAX = 4.5;
export const SPHERE_VIEW_OFFSET_OUTWARD_MAX = 34;
export const CONTROLLER_SPHERE_ZOOM_SPEED = 10;
export const SPHERE_ROTATION_ACCEL = 22.4;
export const SPHERE_ROTATION_BRAKE = 32;

export const AppState = Object.freeze({
  TUNNEL: "tunnel",
  TRANSITION_TO_SPHERE: "transition_to_sphere",
  INSIDE_SPHERE: "inside_sphere",
  EXITING_SPHERE: "exiting_sphere"
});

export const AXIS_X = new THREE.Vector3(1, 0, 0);
export const AXIS_Y = new THREE.Vector3(0, 1, 0);
export const AXIS_Z = new THREE.Vector3(0, 0, 1);
export const NEG_Z = new THREE.Vector3(0, 0, -1);

// sRGB (display space) copies of the fog palette. The tunnel to sphere
// transition blends in sRGB because THREE.Color.lerp works in linear RGB, whose
// midpoints look washed out (navy <-> pale sky at t=0.5 is surprisingly bright).
export const TUNNEL_FOG_SRGB = { r: 0.69, g: 0.80, b: 0.97 };
export const SPHERE_FOG_SRGB = { r: 0.11, g: 0.12, b: 0.50 };
