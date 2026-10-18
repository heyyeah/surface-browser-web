// Thumb microgestures. Pure and dependency-free (no three, no DOM, no `state`) so
// the per-button edge latch and the state-mapped dispatch are unit-testable
// offline; applyXrControllerInput (src/input.js) reads the live input sources and
// runs the actions resolved here.
//
// Meta's thumb-on-index microgestures reach WebXR through the `oculus-hand` input
// profile as plain Gamepad buttons on the HAND input source, same indices on both
// hands:
//   [0] pinch / xr-standard-trigger (select, not ours)
//   [4] menu (left-hand layout only; deliberately unbound here)
//   [5] swipe-left     [6] swipe-right
//   [7] swipe-forward  [8] swipe-backward
//   [9] tap-thumb
// Sources without those buttons (controllers, older runtimes) must degrade to
// nothing, which is what hasMicrogestureSupport() is for; the two-hand distance
// gesture then keeps owning tunnel speed.
//
// Hand tracking runs at 30 Hz and a microgesture is a short pulse, often one or
// two frames, so every button is latched per hand and fires on its rising edge
// only.
//
// Mapping: TUNNEL gets swipe forward/back on speed; INSIDE_SPHERE gets swipe
// left/right on yaw (no pitch: multi-axis rotation worsens simulator sickness) and
// tap-thumb on the GenAI variation.

const MICROGESTURE_PROFILE = "oculus-hand";
// Button 9 is the highest index read, so a source reporting fewer than ten buttons
// cannot carry microgestures. Checked alongside the profile string, not instead of
// it: an older runtime can match the profile with a short button array.
const MICROGESTURE_MIN_BUTTONS = 10;

// Gesture id -> Gamepad button index. Insertion order is the order edges are
// reported in, and so the order input.js applies them.
const MICROGESTURE_BUTTON_INDEX = Object.freeze({
  swipeLeft: 5,
  swipeRight: 6,
  swipeForward: 7,
  swipeBackward: 8,
  tapThumb: 9
});

const MICROGESTURE_IDS = Object.freeze(Object.keys(MICROGESTURE_BUTTON_INDEX));

// The registry's own component names, used verbatim by the DEV readout.
const MICROGESTURE_COMPONENT_NAME = Object.freeze({
  swipeLeft: "swipe-left",
  swipeRight: "swipe-right",
  swipeForward: "swipe-forward",
  swipeBackward: "swipe-backward",
  tapThumb: "tap-thumb"
});

// Mirrors AppState from ./constants.js. Copied because constants.js pulls in
// three and this module must run under plain `node --test`;
// scripts/xr_microgestures.test.mjs asserts the two agree.
const APP_STATE_TUNNEL = "tunnel";
const APP_STATE_INSIDE_SPHERE = "inside_sphere";

// Tunnel speed clamp, the same 4..45 the thumbstick and two-hand paths use in
// input.js.
const MICROGESTURE_SPEED_MIN = 4;
const MICROGESTURE_SPEED_MAX = 45;

// Is this input source a HAND rather than a held controller? `source.hand` is the
// spec answer, but it is only populated when `hand-tracking` was granted; Quest
// reports non-articulated hands (profile `meta-fixed-hand`) with no `hand` and no
// joints while still carrying the full microgesture button set. They must still be
// recognised as hands: if one reached the controller button map, a thumb swipe
// (button 5) would read as Y/B and exit VR.
// Matching "hand" in any profile id is deliberately broad: every hand profile
// carries it (`oculus-hand`, `meta-fixed-hand`, `generic-hand`,
// `generic-hand-select`) and no controller profile does.
function isHandLikeSource(source) {
  if (source?.hand) {
    return true;
  }
  const profiles = source?.profiles;
  if (!profiles || typeof profiles.some !== "function") {
    return false;
  }
  return profiles.some((profile) => typeof profile === "string" && profile.includes("hand"));
}

// Feature detection, per source and per frame. Defensive about shape: profiles is
// a FrozenArray in the spec but a plain object in a mock, and only the length of
// `buttons` matters.
// Does NOT require the literal `oculus-hand` profile: devices report
// `meta-fixed-hand` with the same button layout, and gating on the string left the
// gestures dead on real hardware.
function hasMicrogestureSupport(source) {
  if (!isHandLikeSource(source)) {
    return false;
  }
  const buttonCount = Number(source?.gamepad?.buttons?.length ?? 0);
  return buttonCount >= MICROGESTURE_MIN_BUTTONS;
}

// Raw pressed state for every mapped gesture, or null when this source is not
// carrying microgestures this frame. null is meaningful downstream:
// updateMicrogestureLatch() treats it as a dropped frame, not "everything
// released".
function readMicrogesturePressed(source) {
  if (!hasMicrogestureSupport(source)) {
    return null;
  }
  const buttons = source.gamepad.buttons;
  const pressed = {};
  for (const id of MICROGESTURE_IDS) {
    pressed[id] = Boolean(buttons[MICROGESTURE_BUTTON_INDEX[id]]?.pressed);
  }
  return pressed;
}

function createMicrogestureLatch() {
  const latch = {};
  for (const id of MICROGESTURE_IDS) {
    latch[id] = false;
  }
  return latch;
}

// Returns { latch, edges }; never mutates `prev`. `edges` names the gestures that
// went down THIS frame, so a one-frame pulse and a ten-frame pulse each fire once.
function updateMicrogestureLatch(prev, pressed) {
  if (!pressed) {
    // Dropped frame / hand gone. The latch is kept, not cleared, as in
    // updateWristPokeState(): hand tracking blips constantly, and re-arming on a blip
    // risks a phantom second fire of a gesture that never released.
    return { latch: { ...prev }, edges: [] };
  }

  const latch = {};
  const edges = [];
  for (const id of MICROGESTURE_IDS) {
    const down = Boolean(pressed[id]);
    if (down && !prev[id]) {
      edges.push(id);
    }
    latch[id] = down;
  }

  // A thumb tap resolves to exactly one thing. If a swipe rises on the same frame as
  // the tap, the swipe is dropped, not queued; the latch already recorded it as
  // down, so it cannot fire late either.
  if (edges.length > 1 && edges.includes("tapThumb")) {
    return { latch, edges: ["tapThumb"] };
  }
  return { latch, edges };
}

// One discrete tunnel-speed step, clamped like the stick path. NaN gets the floor
// rather than propagating: state.cameraSpeed is read back from the flat speed
// input, which can be empty for a frame.
function stepTunnelSpeed(currentSpeed, direction, stepPerSwipe) {
  const next = Number(currentSpeed) + (direction * stepPerSwipe);
  if (Number.isNaN(next)) {
    return MICROGESTURE_SPEED_MIN;
  }
  return Math.min(MICROGESTURE_SPEED_MAX, Math.max(MICROGESTURE_SPEED_MIN, next));
}

// What one gesture edge means right now. Returns
//   { type, direction, reason, swallowSelect }
// where type is "tunnelSpeed" | "sphereYaw" | "genAiVariation" | "none",
// direction is +1/-1 for the two continuous actions (0 otherwise), and reason says
// why a "none" is a none (the DEV readout prints it).
//
//   appState            state.appState
//   panelOpen           isPanelVisible(): main, help or the idle start panel
//   launcherCapturing   isWristLauncherCapturingSelect(): a poke is in progress
//   genAiPending        a variation batch is already launching or in flight
//   directGestureActive a direct-manipulation gesture owns the same control now
//                       (distance gesture driving speed/zoom, or a pinch-drag
//                       driving sphere yaw)
//
// Gates refuse every gesture, tap included:
//   * launcher poke: the free hand is reaching for the wrist launcher, and thumb
//     noise in that posture is not intent. The launcher already swallows
//     pinch-select then, so this keeps one rule.
//   * world panel open: the panel hand is still near it, and firing a GenAI batch
//     (which exits the sphere) from behind an open menu is the worst case. Speed
//     and yaw are refused with it. Controller thumbsticks keep working with the
//     panel open: a stick needs a deliberate push, a microgesture is one twitch
//     from the poke pose.
//   * direct manipulation engaged: the distance gesture rewrites state.cameraSpeed
//     from its own baseline every frame, so a swipe's speed step would be erased
//     next tick; sphere yaw has the same shape against a pinch-drag. Direct
//     manipulation wins; microgestures remain the path whenever nothing is engaged,
//     the only case on a runtime with no articulated hands.
function resolveMicrogestureAction({
  gesture,
  appState,
  panelOpen,
  launcherCapturing,
  genAiPending,
  directGestureActive
}) {
  // A tap-thumb is millimetres from a pinch, so its frame never also counts as a
  // Select. EVERY microgesture swallows that frame's select, not just the tap: a
  // swipe fires the pinch button alongside its own (`pressed: [0,5]` for swipe-left,
  // `[0,8]` for swipe-backward; swipe-right fires [6] alone), so a left swipe in the
  // sphere would otherwise navigate away.
  const swallowSelect = true;
  const none = (reason) => ({ type: "none", direction: 0, reason, swallowSelect });

  if (launcherCapturing) {
    return none("launcher-poke");
  }
  if (panelOpen) {
    return none("panel-open");
  }
  if (directGestureActive) {
    return none("direct-gesture");
  }

  switch (gesture) {
    case "swipeForward":
    case "swipeBackward":
      if (appState !== APP_STATE_TUNNEL) {
        return none("wrong-state");
      }
      return {
        type: "tunnelSpeed",
        direction: gesture === "swipeForward" ? 1 : -1,
        reason: "",
        swallowSelect
      };

    case "swipeLeft":
    case "swipeRight":
      if (appState !== APP_STATE_INSIDE_SPHERE) {
        return none("wrong-state");
      }
      // Sign matches the stick and arrow-key paths in input.js: swipe-right reads like
      // stick-right / ArrowRight, i.e. a NEGATIVE yaw delta.
      return {
        type: "sphereYaw",
        direction: gesture === "swipeLeft" ? 1 : -1,
        reason: "",
        swallowSelect
      };

    case "tapThumb":
      if (appState !== APP_STATE_INSIDE_SPHERE) {
        return none("wrong-state");
      }
      // Mirrors the first guard in activateSelectedSphereImageForGenAi(): one launch,
      // one provider batch, and a repeat tap is refused rather than queued. That
      // function stays the authority (it also owns the "no usable image/source"
      // refusals); this early copy keeps the refusal testable offline and lets the DEV
      // readout say "genai-pending".
      if (genAiPending) {
        return none("genai-pending");
      }
      return { type: "genAiVariation", direction: 0, reason: "", swallowSelect };

    default:
      return none("unmapped");
  }
}

export {
  MICROGESTURE_PROFILE,
  isHandLikeSource,
  MICROGESTURE_MIN_BUTTONS,
  MICROGESTURE_BUTTON_INDEX,
  MICROGESTURE_COMPONENT_NAME,
  MICROGESTURE_IDS,
  MICROGESTURE_SPEED_MIN,
  MICROGESTURE_SPEED_MAX,
  APP_STATE_TUNNEL,
  APP_STATE_INSIDE_SPHERE,
  hasMicrogestureSupport,
  readMicrogesturePressed,
  createMicrogestureLatch,
  updateMicrogestureLatch,
  stepTunnelSpeed,
  resolveMicrogestureAction
};
