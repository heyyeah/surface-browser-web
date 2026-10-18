// Input: two-hand gesture, XR controller/hand input, desktop sphere keys,
// and non-XR gamepad input.

import {
  HAND_SPHERE_ZOOM_UNITS_PER_METER,
  HAND_TUNNEL_SPEED_UNITS_PER_METER,
  HAND_SPHERE_YAW_SPEED_MAX,
  HAND_SPHERE_PITCH_SPEED_MAX,
  HAND_SPHERE_YAW_RAD_PER_M,
  HAND_SPHERE_PITCH_RAD_PER_M,
  CONTROLLER_SPHERE_ZOOM_SPEED,
  SPHERE_ROTATION_ACCEL,
  SPHERE_VIEW_OFFSET_OUTWARD_MAX,
  AXIS_Y,
  AppState
} from "./constants.js";
import { state } from "./state.js";
import { canvas, speedInput } from "./dom.js";
import {
  renderer,
  sphereViewOffset,
  keyState,
  twoHandGestureState,
  handRotateDragState,
  _handThumbTip,
  _handIndexTip,
  _handPalmCentroid,
  _handJointRead,
  _leftHandAnchor,
  _rightHandAnchor,
  _handWrist,
  _handIndexMetacarpal,
  _handPinkyMetacarpal,
  _handDistal,
  _handRadial,
  _handPalmNormal,
  _handDragDelta,
  _handViewForward,
  _handSeparation,
  _handHeadPosition,
  _handNdc
} from "./scene.js";
import { clamp } from "./helpers.js";
import {
  getActiveCamera,
  markSphereInteraction as markSphereInteractionOnly,
  setSphereDriftDirectionFromRotation,
  holdSphereDriftResume,
  clampSphereViewOffsetToAxis,
  applySphereZoomDelta,
  applySphereRotationDelta,
  applySpherePointerRotation,
  applySphereGrabRotation,
  activateSelectedSphereLink,
  activateSelectedSphereImageForGenAi
} from "./sphere.js";

// Every markSphereInteraction() in this file is a person (a hand, controller,
// key, pointer or touch), so this module also stamps the idle clock that
// idle-auto-advance.js reads, once, rather than at ~20 call sites.
//
// The import is aliased so the shadowing is visible. sphere.js keeps calling the
// plain version internally: its gaze-selection call fires on its own as the idle
// sphere drifts past a panel boundary and must not count as a person.
function markSphereInteraction() {
  markUserInput();
  markSphereInteractionOnly();
}

// The idle clock's only writer. Cheap enough to call from a pointermove.
function markUserInput() {
  state.lastUserInputAtMs = performance.now();
}
import { exitVrSession, setDevFooterNote, updateTouchChordRing } from "./ui.js";
import { DEBUG_UI, HAND_DRAG_VELOCITY_MODEL, CAPTURE_CONTROL_ENABLED } from "./config.js";
import { saveScreenshotWithStatus } from "./screenshot.js";
import {
  updatePanelXrInput,
  togglePanel,
  toggleHelpPanel,
  isPanelVisible,
  setExitHoldProgress,
  flashExitHoldHint,
  hideExitHoldIndicator
} from "./vrpanel.js";
import { goBack } from "./api.js";
import { isWristLauncherCapturingSelect, isWristPokeNear, freeHand } from "./wristui.js";
import {
  createHandGestureState,
  horizontalSeparationM,
  isPalmFacingUp,
  reanchorBaselineAfterClamp,
  resolveHandGestures,
  stepHandDragSpeed,
  SPHERE_COAST_TAU_HAND_THROW_S
} from "./xr-hand-gestures.js";
import {
  createTouchGestureState,
  applyTouchPointerEvent,
  stepTouchGestures
} from "./touch-gestures.js";
import {
  createShiftDragState,
  applyShiftDragEvent,
  releaseShiftDrag,
  stepShiftDrag
} from "./shift-drag-zoom.js";
import {
  createTrackpadPinchState,
  applyTrackpadWheelEvent,
  stepTrackpadPinch
} from "./trackpad-pinch.js";
import { logXrEvent } from "./xr-diag.js";
import { toggleSphereRotation, spherePanelIndexAtCanvasPoint } from "./sphere.js";
import { jumpToSphereEntryForDebug } from "./transitions.js";
import { resolveXrButtonActions } from "./xr-trigger-chord.js";
import {
  isHandLikeSource,
  MICROGESTURE_COMPONENT_NAME,
  readMicrogesturePressed,
  updateMicrogestureLatch,
  stepTunnelSpeed,
  resolveMicrogestureAction
} from "./xr-microgestures.js";

// Controller button map. xr-standard gamepad layout:
//   [0] trigger  [1] squeeze/grip  [3] thumbstick press
//   [4] primary face (X on left, A on right)
//   [5] secondary face (Y on left, B on right)
//
// Bindings (also listed in the in-headset help panel):
//   Right trigger / pinch  Select
//   Right A                Toggle help
//   Right B                Hold to exit VR
//   Right stick press      Jump to sphere (tunnel only)
//   Right grip             Pause/resume sphere rotation (sphere only)
//   Left  X                Toggle help
//   Left  Y                Toggle menu panel
//   Left  stick press      History back
//   Left  grip             Modifier only: held + right trigger = GenAI variations
//
// Screen capture has no controller binding; it is the wrist panel's Capture row
// (wristui.js), hands only.

// --- Logical actions ---------------------------------------------------------
// Each physical binding routes through one of these so the DEV bridge and the
// controller pump exercise the same code path. State-dependence is guarded here
// via existing state machine values (never new states).

// Jump to the sphere entry: the same path as the DEV `J` key / jump button, but
// callable from the production VR binding. No-op outside the tunnel.
function vrJumpToSphere() {
  if (state.appState !== AppState.TUNNEL) {
    return false;
  }
  return jumpToSphereEntryForDebug();
}

// Pause/resume sphere rotation: the same path as desktop Space.
// toggleSphereRotation already refuses outside INSIDE_SPHERE.
function vrPauseSphereRotation() {
  if (state.appState !== AppState.INSIDE_SPHERE) {
    return false;
  }
  return toggleSphereRotation();
}

const PAUSED_ROTATION_ACCEL_SCALE = 0.55;
const PAUSED_ZOOMED_ROTATION_ACCEL_SCALE = 0.08;
const PAUSED_ZOOMED_SLOWDOWN_START = 0.35;
const ZOOMED_ROTATION_ACCEL_SCALE = 0.12;
const ZOOMED_SLOWDOWN_START = 0.28;
// The floor on the GRAB path's zoom gain. Separate from
// ZOOMED_ROTATION_ACCEL_SCALE on purpose; see handDragGainScale().
const POSITION_GAIN_ZOOM_MIN = 0.5;
const XR_EXIT_HOLD_SECONDS = 1.5;
const DESKTOP_SPHERE_POINTER_RADIANS_PER_PIXEL = 0.006;
// The desktop drag's scale (metres of hand travel per short screen edge), seeded
// with the touch value (TOUCH_DRAG_HAND_METERS_PER_SHORT_EDGE) but separate so
// they can diverge. Normalised to the short edge so "the same drag" is the same
// arc on a 390px phone and a 1400px window.
const DESKTOP_DRAG_HAND_METERS_PER_SHORT_EDGE = 0.35;

// --- Thumb microgesture tunables ---------------------------------------------
// Microgestures are discrete events, not axes, so both values are per swipe and
// neither is scaled by dt. The DEV readout (reportMicrogesture below) prints the
// resulting value after every gesture.
//
// Speed: the stick moves 20 units/second at full deflection, so ~4 units a swipe
// is about a fifth of a second of stick: roughly ten swipes across the 4..45
// range, which keeps a single accidental swipe cheap.
//
// (Hand-pinch select arbitration lives in the decision tree in
// src/xr-hand-gestures.js. Controllers are unaffected.)
const MICROGESTURE_TUNNEL_SPEED_STEP = 4;
// Yaw: fed through applySphereRotationDelta(), so it inherits the reversal
// brake, the inertia and the +/-4 speed clamp. 1.2 is a bit under a third of
// that clamp: deliberate, with three or four swipes to reach full spin. Scaled
// by sphereRotationAccelScale() like every other rotation input.
const MICROGESTURE_SPHERE_YAW_IMPULSE = 1.2;

function sphereRotationAccelScale() {
  const zoomFraction = clamp(sphereViewOffset.length() / SPHERE_VIEW_OFFSET_OUTWARD_MAX, 0, 1);
  const zoomSlowdown = clamp((zoomFraction - ZOOMED_SLOWDOWN_START) / (1 - ZOOMED_SLOWDOWN_START), 0, 1);
  const activeScale = 1 + ((ZOOMED_ROTATION_ACCEL_SCALE - 1) * zoomSlowdown);
  if (!state.sphereRotationPaused) {
    return activeScale;
  }
  const pausedZoomSlowdown = clamp((zoomFraction - PAUSED_ZOOMED_SLOWDOWN_START) / (1 - PAUSED_ZOOMED_SLOWDOWN_START), 0, 1);
  return PAUSED_ROTATION_ACCEL_SCALE
    + ((PAUSED_ZOOMED_ROTATION_ACCEL_SCALE - PAUSED_ROTATION_ACCEL_SCALE) * pausedZoomSlowdown);
}

// The position path's own zoom gain, deliberately not sphereRotationAccelScale():
//
// That bottoms out at 0.08, a hard cap on a velocity path (0.08 x 2.2 rad/s is
// 0.18 rad/s, half a minute per turn); on a position path a low scale just means
// the same rotation costs twelve times the hand travel.
//
// And its paused factor (0.55) exists to keep the thumbstick's acceleration
// gentle while paused; a position map has no runaway to protect against, and a
// hand holding a paused sphere expects it to follow.
//
// So: the same 0.28 zoom knee, floored at POSITION_GAIN_ZOOM_MIN and blind to
// the pause. Lower the floor toward 0.35 if zoomed-in drag is twitchy, raise it
// toward 0.7 if stiff.
function handDragGainScale() {
  const zoomFraction = clamp(sphereViewOffset.length() / SPHERE_VIEW_OFFSET_OUTWARD_MAX, 0, 1);
  const zoomSlowdown = clamp((zoomFraction - ZOOMED_SLOWDOWN_START) / (1 - ZOOMED_SLOWDOWN_START), 0, 1);
  return 1 + ((POSITION_GAIN_ZOOM_MIN - 1) * zoomSlowdown);
}

// DEV-only readout of raw microgesture edges, including the ones the swallow
// rules discarded and why: otherwise "never reached WebXR" and "arrived and was
// ignored" look the same on device. Same gating as the other dev diagnostics
// (DEBUG_UI === DEV_TOOLS_ENABLED, off in the public build); rides the status
// footer drawn in VR plus a console line.
function reportMicrogesture(hand, gesture, decision) {
  if (!DEBUG_UI) {
    return;
  }
  let effect;
  switch (decision.type) {
    case "tunnelSpeed":
      effect = `speed ${state.cameraSpeed.toFixed(1)}`;
      break;
    case "sphereYaw":
      effect = `yaw ${state.sphereYRotSpeed.toFixed(2)}`;
      break;
    case "genAiVariation":
      effect = "genai variation";
      break;
    default:
      effect = `ignored (${decision.reason})`;
      break;
  }
  const line = `gesture ${hand} ${MICROGESTURE_COMPONENT_NAME[gesture] || gesture} -> ${effect}`;
  console.debug(`[Surface Browser] ${line}`);
  setDevFooterNote(line);
}

// Run one microgesture edge. The mapping decision is pure (xr-microgestures.js);
// this carries it out through the same functions the controller bindings use, so
// nothing here is a second implementation of an action.
function applyMicrogesture(hand, gesture, dt, directGestureActive) {
  const decision = resolveMicrogestureAction({
    gesture,
    appState: state.appState,
    // A direct-manipulation gesture that is engaged owns the control this swipe
    // would step and rewrites it from its own baseline every frame, so the step
    // would vanish. See the swallow rules in xr-microgestures.js.
    directGestureActive,
    // Any world panel (main, help, idle start). See the swallow rules in
    // xr-microgestures.js for why all three, and why the controller sticks keep
    // working there.
    panelOpen: isPanelVisible(),
    launcherCapturing: isWristLauncherCapturingSelect(),
    // The same condition activateSelectedSphereImageForGenAi() refuses on, read
    // early so a repeat tap is refused rather than queued and the readout can say
    // so. That function re-checks and stays the authority.
    genAiPending: Boolean(state.genAiLaunch) || state.cycleRequestInFlight
  });

  if (decision.swallowSelect) {
    // A thumb tap happens millimetres from a pinch. Forcing the select latch
    // means this frame's pinch (if the runtime reports one) cannot fire a sphere
    // navigation, and since the latch only clears on release, neither can the
    // rest of that contact. Fires before the select-edge block below reads the
    // latch (see applyXrControllerInput). Both hands, since either thumb is near
    // either pinch.
    state.xrSelectLatch = true;
    state.xrSelectLatchHands.left = true;
    state.xrSelectLatchHands.right = true;
  }

  switch (decision.type) {
    case "tunnelSpeed":
      state.cameraSpeed = stepTunnelSpeed(
        state.cameraSpeed,
        decision.direction,
        MICROGESTURE_TUNNEL_SPEED_STEP
      );
      speedInput.value = String(state.cameraSpeed.toFixed(1));
      break;

    case "sphereYaw":
      markSphereInteraction();
      state.sphereRotationInputActive = true;
      state.sphereYRotSpeed = applySphereRotationDelta(
        state.sphereYRotSpeed,
        decision.direction * MICROGESTURE_SPHERE_YAW_IMPULSE * sphereRotationAccelScale(),
        dt
      );
      break;

    case "genAiVariation":
      // Same entry point as the both-trigger chord, so the guards (image sphere
      // only, one batch, repeat refused) are the same code.
      logXrEvent({ event: "genaiFired", via: "microgesture.tapThumb" });
      void activateSelectedSphereImageForGenAi();
      break;

    default:
      break;
  }

  reportMicrogesture(hand, gesture, decision);
}

// Last frame's rotate-drag displacement, so a hand-tracking blink does not read
// as "the hand came back to the anchor". The tree carries a pinch through a
// short dropout, so `rotate.active` stays true across the gap; without this
// cache the deflection would collapse to zero and the drag stutter on every
// blink. Cleared with the rest of the gesture state.
let lastRotateLateralM = 0;
let lastRotateVerticalM = 0;

function resetTwoHandGesture() {
  twoHandGestureState.active = false;
  // The pure half of the gesture tree (pinch contacts, hysteresis clocks, the
  // GenAI confirm hold) goes with it, or a session ending mid-gesture would
  // resume half-engaged.
  state.xrHandGesture = createHandGestureState();
  lastRotateLateralM = 0;
  lastRotateVerticalM = 0;
}

// The four metacarpals (the back of the palm): after the wrist, the most
// reliably tracked joints. They barely move relative to each other, the runtime
// can infer them from the hand's silhouette, and curling or pointing the fingers
// does not hide them.
const PALM_CENTROID_JOINTS = [
  "index-finger-metacarpal",
  "middle-finger-metacarpal",
  "ring-finger-metacarpal",
  "pinky-finger-metacarpal"
];

// Where is this hand? Gross position only, the answer the distance gesture, the
// rotate drag's displacement and the stop latch's heights are built on.
//
// Tiers: the wrist; else the centroid of whichever metacarpals read (within a
// couple of centimetres of the wrist and rigid with it, well inside the ~10 cm
// engage band, and it survives a fist, a point or a hand seen edge-on); else the
// midpoint of the thumb and index tips, the least reliable joints and the first
// hidden by a turned-away or curled hand. A two-hand DISTANCE gesture needs
// nothing finer than where each hand is. Pinch detection does need the fingers
// and is unaffected: it comes off the input source's buttons.
function readTrackedHandAnchor(source, frame, referenceSpace, outPosition) {
  const hand = source.hand;
  if (!hand) {
    return false;
  }
  if (readJointPosition(hand, frame, referenceSpace, "wrist", outPosition)) {
    return true;
  }

  let palmJoints = 0;
  _handPalmCentroid.set(0, 0, 0);
  for (const jointName of PALM_CENTROID_JOINTS) {
    if (readJointPosition(hand, frame, referenceSpace, jointName, _handJointRead)) {
      _handPalmCentroid.add(_handJointRead);
      palmJoints += 1;
    }
  }
  if (palmJoints > 0) {
    outPosition.copy(_handPalmCentroid).divideScalar(palmJoints);
    return true;
  }

  if (
    !readJointPosition(hand, frame, referenceSpace, "thumb-tip", _handThumbTip)
    || !readJointPosition(hand, frame, referenceSpace, "index-finger-tip", _handIndexTip)
  ) {
    return false;
  }
  outPosition.copy(_handThumbTip).add(_handIndexTip).multiplyScalar(0.5);
  return true;
}

function readJointPosition(hand, frame, referenceSpace, jointName, out) {
  const joint = hand?.get(jointName);
  if (!joint) {
    return false;
  }
  const pose = frame.getJointPose(joint, referenceSpace);
  if (!pose) {
    return false;
  }
  out.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
  return true;
}

// Unit palm normal for `source`, left in _handPalmNormal; false when the pose is
// not readable at all. Two callers want it against two references (world up for
// the drag's palm-up refusal, the view direction for the stop signal), so the
// construction lives here once and each caller takes its own dot.
//
// Derived from joint geometry rather than the wrist joint's quaternion (the same
// construction as wristui.js), so it means the same thing whatever a runtime
// does with its joint axes. wrist -> metacarpal midpoint gives the along-hand
// axis; pinky -> index metacarpal the across-hand axis; their cross product
// points out of the BACK of a right hand and the PALM of a left one, so the
// right hand flips.
function readHandPalmNormal(source, frame, referenceSpace) {
  const hand = source?.hand;
  if (!hand || !frame || !referenceSpace) {
    return false;
  }
  if (
    !readJointPosition(hand, frame, referenceSpace, "wrist", _handWrist)
    || !readJointPosition(hand, frame, referenceSpace, "index-finger-metacarpal", _handIndexMetacarpal)
    || !readJointPosition(hand, frame, referenceSpace, "pinky-finger-metacarpal", _handPinkyMetacarpal)
  ) {
    return false;
  }
  _handDistal
    .copy(_handIndexMetacarpal)
    .add(_handPinkyMetacarpal)
    .multiplyScalar(0.5)
    .sub(_handWrist);
  _handRadial.copy(_handIndexMetacarpal).sub(_handPinkyMetacarpal);
  if (_handDistal.lengthSq() < 1e-8 || _handRadial.lengthSq() < 1e-8) {
    return false;
  }
  _handDistal.normalize();
  _handRadial.normalize();
  _handPalmNormal.crossVectors(_handDistal, _handRadial);
  if (source.handedness !== "left") {
    _handPalmNormal.negate();
  }
  if (_handPalmNormal.lengthSq() < 1e-8) {
    return false;
  }
  _handPalmNormal.normalize();
  return true;
}

// How far the palm is turned toward world-up (the palm normal's y). NaN when
// unreadable, which isPalmFacingUp() treats as palm-up and so refuses the rotate
// drag: the safe direction, since Meta's palm-up pinch can steal the WebXR
// session.
function readHandPalmUpDot(source, frame, referenceSpace) {
  return readHandPalmNormal(source, frame, referenceSpace)
    ? _handPalmNormal.dot(AXIS_Y)
    : NaN;
}

// How squarely the palm faces away from the head (the palm normal's dot with the
// view direction). This is the stop signal's only discriminator against the
// distance gesture, which wants the same "both hands up, open, no pinch" pose.
// NaN when unreadable, which isPalmFacingAway() reads as "not the stop pose" (the
// opposite default to palm-up): a pose we could not see must not pause the sphere.
function readHandPalmForwardDot(source, frame, referenceSpace, forward) {
  return readHandPalmNormal(source, frame, referenceSpace)
    ? _handPalmNormal.dot(forward)
    : NaN;
}

// Is this hand on screen? The hand's world position is projected through the
// ACTIVE camera into normalised device coordinates. Not an angular cone around
// head-forward: hands at chest height are already 40-60 degrees below the view
// axis and spreading them (the gesture itself) pushes them further out, so a
// cone kills the gesture. The frustum is wide horizontally, the axis this
// gesture moves along.
//
// Two steps rather than Vector3.project(), because the sign of the perspective
// divide must be observed before it happens: a hand BEHIND the near plane comes
// back through the divide with plausible-looking flipped coordinates. The camera
// looks down -Z in view space, so `z >= 0` is behind.
//
// Mutates and returns `out`: one object per hand, reused every frame, never
// retained by the pure tree.
function readHandNdc(handPosition, camera, out) {
  _handNdc.copy(handPosition).applyMatrix4(camera.matrixWorldInverse);
  out.behind = _handNdc.z >= 0;
  // Vector3.applyMatrix4 performs the perspective divide, so this is NDC.
  _handNdc.applyMatrix4(camera.projectionMatrix);
  out.x = _handNdc.x;
  out.y = _handNdc.y;
  return out;
}

// The two reusable readings. Plain objects, not Vector3s: the tree wants
// { x, y, behind } and nothing vector-shaped is done with them.
const _leftHandNdcRead = { x: NaN, y: NaN, behind: false };
const _rightHandNdcRead = { x: NaN, y: NaN, behind: false };
// A third, for the rotate hand alone. The pair above is only read when BOTH
// hands are tracked, but the brake's centre gate is a one-hand question and must
// still be answered when the other hand is missing.
const _rotateHandNdcRead = { x: NaN, y: NaN, behind: false };

// The two-hand distance gesture. One code path with a state switch: the pure
// tree already resolved which control this frame's separation drives
// (`decision.target`), and the two targets belong to mutually exclusive app
// states.
//
// `decision.deltaM` is signed metres of effective travel from the baseline
// separation, deadband removed, so it is exactly zero on the frame the gesture
// engages and grows continuously from there.
//
// Direction: hands apart is MORE of the thing in both states.
//
//   tunnel speed: `baselineSpeed + delta * gain`.
//   sphere zoom:  sphereViewOffset displaces the SPHERE, not the camera
//                 (sphere.js: `sphereGroup.position.add(sphereViewOffset)`), so
//                 a POSITIVE offset along the view axis pushes the sphere away
//                 and makes everything smaller. That is why the outward clamp is
//                 the big one (SPHERE_VIEW_OFFSET_OUTWARD_MAX = 34, far enough to
//                 see the whole sphere from outside) and the inward one is about
//                 a panel radius. Apart therefore writes a NEGATIVE offset.
//
// Re-baselining: `justEngaged` takes the baseline from whatever the control
// reads right now, so a stroke that committed (see updateDistanceGesture's
// "committed" release) is continued by the next one instead of undone.
function applyHandDistanceGesture(decision) {
  if (!decision.active) {
    twoHandGestureState.active = false;
    return;
  }

  if (decision.justEngaged) {
    twoHandGestureState.active = true;
    getActiveCamera().getWorldDirection(twoHandGestureState.controlAxis);
    if (twoHandGestureState.controlAxis.lengthSq() < 1e-6) {
      twoHandGestureState.controlAxis.set(0, 0, -1);
    } else {
      twoHandGestureState.controlAxis.normalize();
    }
    twoHandGestureState.baselineSpeed = state.cameraSpeed;
    twoHandGestureState.baselineSphereOffset.copy(sphereViewOffset);
  }

  if (decision.target === "sphereZoom") {
    // Negated: hands apart must zoom IN, which is an offset toward the viewer.
    const travel = -decision.deltaM * HAND_SPHERE_ZOOM_UNITS_PER_METER;
    const axis = twoHandGestureState.controlAxis;
    const baselineProjection = twoHandGestureState.baselineSphereOffset.dot(axis);
    sphereViewOffset
      .copy(twoHandGestureState.baselineSphereOffset)
      .addScaledVector(axis, travel);
    clampSphereViewOffsetToAxis(axis);
    // Anti-windup: one stroke can ask for twice the range the clamp allows, and
    // without this the baseline keeps the overshoot, so coming back does nothing
    // until it has been unwound by hand.
    const reanchored = reanchorBaselineAfterClamp(
      baselineProjection,
      travel,
      sphereViewOffset.dot(axis)
    );
    if (reanchored !== baselineProjection) {
      twoHandGestureState.baselineSphereOffset
        .addScaledVector(axis, reanchored - baselineProjection);
    }
    return;
  }

  const speedTravel = decision.deltaM * HAND_TUNNEL_SPEED_UNITS_PER_METER;
  state.cameraSpeed = clamp(twoHandGestureState.baselineSpeed + speedTravel, 4, 45);
  // Same anti-windup as the zoom branch, against the 4..45 clamp.
  twoHandGestureState.baselineSpeed = reanchorBaselineAfterClamp(
    twoHandGestureState.baselineSpeed,
    speedTravel,
    state.cameraSpeed
  );
  speedInput.value = String(state.cameraSpeed.toFixed(1));
}

// Rotate-hand pinch + drag -> sphere yaw and pitch.
//
// Velocity-proportional: the pinching hand's displacement from the drag anchor
// names a rotation SPEED, which stepHandDragSpeed() converges on; bringing the
// hand back toward the anchor brings the speed to zero, and holding a
// displacement holds a speed. See the model note in the header of
// src/xr-hand-gestures.js for why this differs from the thumbstick path below,
// which is acceleration-based and MUST STAY so: a stick springs back to centre
// and a hand does not.
//
// Inherited from the old model: the deadzone, the zoom-based calming from
// sphereRotationAccelScale(), and release behaviour. Release is implicit: the
// drag stops writing, leaving the speed it had, and sphere.js's 0.95/frame decay
// carries the momentum out as for the stick. Not inherited:
// applySphereRotationDelta()'s reversal brake, since the smoother is already the
// reversal behaviour (a drag through the anchor passes through zero) and a brake
// on a target speed would fight the hand.
//
// Signs follow the controller map: the stick applies -horizontalAxis /
// -verticalAxis, and stick-right is +horizontal while stick-UP is -vertical. So
// a drag right (positive lateral deflection) negates like the stick, and a drag
// UP (positive pitch deflection) does not.
function applyHandRotateDrag(rotate, handPosition, dt) {
  if (!rotate.active) {
    return;
  }
  // An engaged drag owns the sphere. Claimed on every engaged frame, including
  // those commanding zero speed: a hand parked on the anchor is holding the
  // sphere still and the auto-drift must not turn underneath it. sphere.js reads
  // this flag and stands the drift down; it is cleared at the top of every
  // renderFrame(). Not the brake: the brake latches state.sphereRotationPaused
  // and survives the release; this lasts only as long as the pinch.
  state.sphereRotationInputActive = true;
  if (rotate.justEngaged) {
    handRotateDragState.anchor.copy(handPosition);
    // Camera-right, so "sideways" is relative to the viewer rather than the
    // world and keeps its meaning after the user turns. The pitch axis is world
    // up, the axis the sphere itself pitches about.
    getActiveCamera().getWorldDirection(_handDragDelta);
    handRotateDragState.axis.crossVectors(_handDragDelta, AXIS_Y);
    if (handRotateDragState.axis.lengthSq() < 1e-6) {
      handRotateDragState.axis.set(1, 0, 0);
    } else {
      handRotateDragState.axis.normalize();
    }
    return;
  }
  // The dwell reset is driven from `handGesture.interacting` in
  // applyXrControllerInput() for every engaged gesture, moving or not (a guard
  // on non-zero deflection let a pinch held still for 20 s read as idle and
  // auto-advance; see `interacting` in xr-hand-gestures.js).
  // state.sphereRotationInputActive above is claimed unconditionally, so both
  // models feed the drift stand-down and the dwell hold identically.
  if (HAND_DRAG_VELOCITY_MODEL) {
    // Legacy velocity model, kept for ?drag=vel.
    //
    // Displacement names a SPEED. Runs on every dragging frame, including zero
    // deflection: a hand returned to the anchor is asking for a stop, and only
    // stepping toward the zero target delivers one.
    const calmScale = sphereRotationAccelScale();
    state.sphereYRotSpeed = stepHandDragSpeed(state.sphereYRotSpeed, {
      deflection: -rotate.deflection,
      maxSpeed: HAND_SPHERE_YAW_SPEED_MAX,
      scale: calmScale,
      dt
    });
    state.sphereXRotSpeed = stepHandDragSpeed(state.sphereXRotSpeed, {
      deflection: rotate.pitchDeflection,
      maxSpeed: HAND_SPHERE_PITCH_SPEED_MAX,
      scale: calmScale,
      dt
    });
    return;
  }

  // The grab model (default). Two channels, both run on every engaged frame.
  //
  // (a) The catch. The velocity channel is commanded to ZERO through the same
  //     smoother the old model used, so whatever the sphere carried when the hand
  //     closed decays with a ~83 ms time constant (~5% left after 250 ms). Both
  //     axes, always. On the dragged axis a same-direction grab reads as ADDING
  //     (the residual is still there and the position map is already pushing)
  //     and an opposing one as "stop it and start going my way". Not a hard
  //     kill: killing 3 rad/s in one frame gets the end state right and the
  //     transient wrong.
  //
  // (b) The position map. The tree has already turned the hand's displacement
  //     into a rate-clamped angle delta for this frame; applying it is a
  //     premultiply straight onto sphereOrientation. A held displacement holds
  //     an ANGLE: the sphere stops where the hand put it.
  state.sphereYRotSpeed = stepHandDragSpeed(state.sphereYRotSpeed, {
    deflection: 0,
    maxSpeed: 0,
    dt
  });
  state.sphereXRotSpeed = stepHandDragSpeed(state.sphereXRotSpeed, {
    deflection: 0,
    maxSpeed: 0,
    dt
  });
  const grab = rotate.grab;
  if (grab && (grab.deltaPitchRad !== 0 || grab.deltaYawRad !== 0)) {
    applySphereGrabRotation(grab.deltaPitchRad, grab.deltaYawRad);
  }
}

// DEV-only readout for the hand gestures, same gating and footer as the
// microgesture readout. Only mode changes are reported: the distance gesture and
// the yaw drag are continuous, and a per-frame line would bury the discrete
// GenAI event that matters.
function reportHandGesture(line) {
  if (!DEBUG_UI) {
    return;
  }
  console.debug(`[Surface Browser] ${line}`);
  setDevFooterNote(line);
}

// The half of that readout that reaches the workstation. The footer and console
// line only exist inside the headset, so this mirrors the `wristpoke` pattern in
// wristui.js: one line per decision edge, never per frame, naming the decision
// and the reason it was or was not taken, posted through logXrEvent() to
// `server/xr-diag.log`.
//
// The events come from resolveHandGestures() itself, so a line can never
// describe a decision the tree did not make. `diag` is the context the decision
// was made from, attached to every line so an entry is self-contained: which
// hand selects, each hand's pinch and presence, the measured chord lead against
// CHORD_LEAD_MS, whether the chord was already spent, and the frame health
// (`dtMs` / `medianDtMs` / `hitch`) that says whether an odd decision is a
// gesture problem or a frame-rate one.
//
// The absence of a line is informative: a reported GenAI fire with no
// `decision:"chord"` line came from the thumb tap or the controller chord.
function logHandGestureEvents(handGesture) {
  const events = handGesture.events;
  if (!events || events.length === 0) {
    return;
  }
  for (const item of events) {
    logXrEvent({
      event: "handgesture",
      decision: item.decision,
      outcome: item.outcome,
      reason: item.reason || "",
      hand: item.hand || null,
      target: item.target || null,
      leadMs: Number.isFinite(item.leadMs) ? Math.round(item.leadMs) : null,
      ...handGesture.diag
    });
  }
}

function applyXrControllerInput(dt) {
  if (!renderer.xr.isPresenting) {
    return;
  }
  const session = renderer.xr.getSession();
  if (!session) {
    return;
  }

  let anySelectPressed = false;
  let leftTriggerPressed = false;
  let rightTriggerPressed = false;
  // Button map, collected per hand.
  let leftXPressed = false;         // left [4] — toggle the menu panel.
  let leftYPressed = false;         // left [5] — Capture, or Help without a token.
  let leftGripPressed = false;      // left [1] — GenAI chord modifier only.
  let leftStickPressed = false;     // left [3] — history back.
  let rightAPressed = false;        // right [4] — toggle Help.
  let rightBPressed = false;        // right [5] — exit VR.
  let rightGripPressed = false;     // right [1] — pause/resume sphere rotation.
  let rightStickPressed = false;    // right [3] — jump to sphere.
  const frame = renderer.xr.getFrame();
  const referenceSpace = renderer.xr.getReferenceSpace();
  let leftHandTracked = false;
  let rightHandTracked = false;
  // Hand-gesture inputs, collected per hand and resolved as ONE tree after the
  // loop. `present` is "a hand input source exists" (true even for the
  // non-articulated `meta-fixed-hand` profile, which has buttons but no joints);
  // `tracked` is the stronger "a usable anchor position was read", which the
  // distance gesture and the yaw drag need.
  let leftHandPresent = false;
  let rightHandPresent = false;
  let leftPinchPressed = false;
  let rightPinchPressed = false;
  let leftMicrogestureEdge = false;
  let rightMicrogestureEdge = false;
  // The hand whose pinch counts as Select is always the one NOT carrying the
  // wrist launcher (the `wristPanelHand` setting). Meta reserves palm-pinch on
  // both hands for the system menu, so a pinch from the panel hand can eject the
  // WebXR session and must never select. With the default panel hand "left" this
  // resolves to "right".
  const selectHandedness = freeHand();
  // The other hand's pinch-drag yaws the sphere. Same setting, so flipping
  // `wristPanelHand` mirrors the whole gesture set.
  const rotateHandedness = selectHandedness === "left" ? "right" : "left";
  // Both sources are kept: the rotate hand's palm answers the palm-up refusal,
  // and both palms answer the stop signal's palms-away test.
  let leftHandSource = null;
  let rightHandSource = null;
  // Microgesture edges are collected in the loop and dispatched after it: a tap
  // suppresses that frame's Select, and the select edge is computed from all
  // sources at once, so the decision must be known before any of it is read.
  const microgestureEdges = [];
  // Pico Browser nulls inputSources while the session ends.
  for (const source of session.inputSources || []) {
    // isHandLikeSource(), not `source.hand`: when the runtime withholds
    // hand-tracking the hands still arrive as the non-articulated
    // `meta-fixed-hand` profile with the full button set and no joints. Treating
    // them as controllers would map button 5 to Y/B, so a thumb swipe-left would
    // open the exit-VR hold.
    if (isHandLikeSource(source)) {
      // Thumb microgestures: hand sources only, feature-detected per source per
      // frame. A runtime without the buttons falls through and the two-hand
      // distance gesture keeps owning tunnel speed. EITHER hand fires: the panel
      // hand is held up in the summon pose and the free hand pokes, so insisting
      // on one thumb would break the gesture in half the poses. Nothing else is
      // bound to a thumb, so there is no collision.
      const handKey = source.handedness === "left" || source.handedness === "right"
        ? source.handedness
        : null;
      if (handKey) {
        if (handKey === "left") {
          leftHandPresent = true;
        } else {
          rightHandPresent = true;
        }
        if (handKey === "left") {
          leftHandSource = source;
        } else {
          rightHandSource = source;
        }
        // readMicrogesturePressed() answers null when this source carries no
        // microgestures, which the latch reads as a dropped frame rather than
        // "everything released", so an unsupported runtime never produces an edge.
        const microgestures = updateMicrogestureLatch(
          state.xrMicrogestureLatch[handKey],
          readMicrogesturePressed(source)
        );
        state.xrMicrogestureLatch[handKey] = microgestures.latch;
        for (const gesture of microgestures.edges) {
          microgestureEdges.push({ hand: handKey, gesture });
          if (handKey === "left") {
            leftMicrogestureEdge = true;
          } else {
            rightMicrogestureEdge = true;
          }
        }
      }

      if (source.hand && frame && referenceSpace) {
        if (source.handedness === "left") {
          leftHandTracked = readTrackedHandAnchor(source, frame, referenceSpace, _leftHandAnchor) || leftHandTracked;
        } else if (source.handedness === "right") {
          rightHandTracked = readTrackedHandAnchor(source, frame, referenceSpace, _rightHandAnchor) || rightHandTracked;
        }
      }

      // Raw pinch, both hands, ungated here: what a pinch MEANS is decided by the
      // hand tree below (by the ORDER the pinches arrived), together with the
      // launcher swallow, the debounce against a swipe's incidental button-0 press
      // and the select hold.
      const pinchPressed = Boolean(
        source.gamepad?.buttons?.[0]?.pressed
        || source.gamepad?.buttons?.[1]?.pressed
      );
      if (handKey === "left") {
        leftPinchPressed = leftPinchPressed || pinchPressed;
      } else if (handKey === "right") {
        rightPinchPressed = rightPinchPressed || pinchPressed;
      }
      continue;
    }
    if (!source.gamepad) {
      continue;
    }
    const buttons = source.gamepad.buttons || [];
    // Select = trigger only (either hand). Grips are reserved: left grip is the
    // GenAI chord modifier, right grip toggles rotation, so neither selects.
    const selectPressed = Boolean(buttons[0]?.pressed);
    anySelectPressed = anySelectPressed || selectPressed;
    if (source.handedness === "left") {
      leftTriggerPressed = leftTriggerPressed || selectPressed;
      leftXPressed = leftXPressed || Boolean(buttons[4]?.pressed);
      leftYPressed = leftYPressed || Boolean(buttons[5]?.pressed);
      leftGripPressed = leftGripPressed || Boolean(buttons[1]?.pressed);
      leftStickPressed = leftStickPressed || Boolean(buttons[3]?.pressed);
    } else if (source.handedness === "right") {
      rightTriggerPressed = rightTriggerPressed || selectPressed;
      rightAPressed = rightAPressed || Boolean(buttons[4]?.pressed);
      rightBPressed = rightBPressed || Boolean(buttons[5]?.pressed);
      rightGripPressed = rightGripPressed || Boolean(buttons[1]?.pressed);
      rightStickPressed = rightStickPressed || Boolean(buttons[3]?.pressed);
    }
    if (!Array.isArray(source.gamepad.axes) || source.gamepad.axes.length < 2) {
      continue;
    }
    const horizontalAxis = source.gamepad.axes[2] ?? source.gamepad.axes[0] ?? 0;
    const verticalAxis = source.gamepad.axes[3] ?? source.gamepad.axes[1] ?? 0;
    if (state.appState === AppState.INSIDE_SPHERE) {
      if (source.handedness === "left") {
        if (Math.abs(verticalAxis) >= 0.12) {
          markSphereInteraction();
          applySphereZoomDelta(-verticalAxis * CONTROLLER_SPHERE_ZOOM_SPEED * dt);
        }
        continue;
      }
      const accelStep = SPHERE_ROTATION_ACCEL * sphereRotationAccelScale() * dt;
      if (Math.abs(verticalAxis) >= 0.12) {
        markSphereInteraction();
        state.sphereRotationInputActive = true;
        state.sphereXRotSpeed = applySphereRotationDelta(state.sphereXRotSpeed, -verticalAxis * accelStep, dt);
      }
      if (Math.abs(horizontalAxis) >= 0.12) {
        markSphereInteraction();
        state.sphereRotationInputActive = true;
        state.sphereYRotSpeed = applySphereRotationDelta(state.sphereYRotSpeed, -horizontalAxis * accelStep, dt);
      }
      continue;
    }
    if (Math.abs(verticalAxis) >= 0.12) {
      state.cameraSpeed = clamp(state.cameraSpeed + (-verticalAxis * 20 * dt), 4, 45);
      speedInput.value = String(state.cameraSpeed.toFixed(1));
      break;
    }
  }

  // --- Direct-manipulation hand gestures ------------------------------------
  // One tree, resolved in src/xr-hand-gestures.js, ordered by the SEQUENCE the
  // two pinches arrived in. It subsumes the two-hand distance gesture, the
  // free-hand pinch select arbitration, and the GenAI entry that only the thumb
  // tap and the controller chord could reach.
  const rotateHandTracked = rotateHandedness === "left" ? leftHandTracked : rightHandTracked;
  const rotateHandAnchor = rotateHandedness === "left" ? _leftHandAnchor : _rightHandAnchor;
  const rotateHandPinchPressed = rotateHandedness === "left" ? leftPinchPressed : rightPinchPressed;
  // Measured against the PREVIOUS frame's drag anchor, because the anchor is set
  // on the frame the drag engages and the tree returns a zero deflection then.
  //
  // A drag whose hand is momentarily untracked keeps the LAST displacement
  // rather than falling to zero: zero means "the hand is back at the anchor,
  // stop turning", a statement about the hand that a blink does not make. The
  // tree carries the pinch through the same dropout, so the halves agree.
  let rotateLateralM = 0;
  let rotateVerticalM = 0;
  if (state.xrHandGesture.rotateActive) {
    if (rotateHandTracked) {
      _handDragDelta.copy(rotateHandAnchor).sub(handRotateDragState.anchor);
      lastRotateLateralM = _handDragDelta.dot(handRotateDragState.axis);
      lastRotateVerticalM = _handDragDelta.dot(AXIS_Y);
    }
    rotateLateralM = lastRotateLateralM;
    rotateVerticalM = lastRotateVerticalM;
  } else {
    lastRotateLateralM = 0;
    lastRotateVerticalM = 0;
  }

  // The viewer frame, read once for three consumers that all need both hands
  // tracked: the stop signal's palms-away test, the distance gesture's
  // horizontal separation, and the in-view cone that gates it.
  //
  // Palms-away is additionally gated on neither pinch button being down: a cheap
  // physical gate (the tree still owns app state, panels and the pose's
  // stability window) that keeps six getJointPose() calls out of frames where
  // the pose is physically impossible. An unread palm is NaN, which
  // isPalmFacingAway() reads as "not the stop pose".
  let leftPalmForwardDot = NaN;
  let rightPalmForwardDot = NaN;
  // Horizontal separation only: the hand-to-hand vector projected onto
  // camera-right makes lowering both hands together a no-op by construction
  // rather than via a tuned threshold. NaN when either hand is missing.
  let handSeparationM = NaN;
  // Whether each hand is on screen, as normalised device coordinates through the
  // active camera (see readHandNdc above). The tree applies the bound
  // (DISTANCE_VIEW_NDC_MARGIN, through handWithinViewport) so the rule stays
  // offline-testable.
  let leftHandNdc = null;
  let rightHandNdc = null;
  // The rotate hand's own projection, independent of the pair below: "pinch and
  // hold near the centre" is a question about one hand, and the other is
  // routinely untracked mid-drag.
  let rotateHandNdc = null;
  if (rotateHandTracked) {
    rotateHandNdc = readHandNdc(rotateHandAnchor, getActiveCamera(), _rotateHandNdcRead);
  }
  if (leftHandTracked && rightHandTracked) {
    const camera = getActiveCamera();
    camera.getWorldDirection(_handViewForward);
    if (_handViewForward.lengthSq() < 1e-6) {
      _handViewForward.set(0, 0, -1);
    } else {
      _handViewForward.normalize();
    }
    if (!leftPinchPressed && !rightPinchPressed) {
      leftPalmForwardDot = readHandPalmForwardDot(leftHandSource, frame, referenceSpace, _handViewForward);
      rightPalmForwardDot = readHandPalmForwardDot(rightHandSource, frame, referenceSpace, _handViewForward);
    }
    // Camera-right, refreshed only while the gesture is NOT engaged. Turning the
    // head mid-stroke would shorten the projection and write a zoom the hands
    // never asked for (a 45 degree turn on a 50 cm spread is a 30% change, past
    // DISTANCE_ENGAGE_REL). Frozen for a stroke, the axis means "horizontal as
    // the viewer had it at the start", the same promise applyHandRotateDrag() makes.
    if (!state.xrHandGesture.distance.engaged) {
      twoHandGestureState.separationAxis.crossVectors(_handViewForward, AXIS_Y);
      if (twoHandGestureState.separationAxis.lengthSq() < 1e-6) {
        twoHandGestureState.separationAxis.set(1, 0, 0);
      } else {
        twoHandGestureState.separationAxis.normalize();
      }
    }
    _handSeparation.copy(_rightHandAnchor).sub(_leftHandAnchor);
    handSeparationM = horizontalSeparationM(_handSeparation, twoHandGestureState.separationAxis);
    camera.getWorldPosition(_handHeadPosition);
    // The XR camera is the ArrayCamera whose projection is the union of the two
    // eyes: the whole headset viewport, the right frustum for "can the user see
    // their hands". matrixWorldInverse and projectionMatrix are maintained by
    // WebXRManager.
    leftHandNdc = readHandNdc(_leftHandAnchor, camera, _leftHandNdcRead);
    rightHandNdc = readHandNdc(_rightHandAnchor, camera, _rightHandNdcRead);
  }

  const handGesture = resolveHandGestures(state.xrHandGesture, {
    now: performance.now(),
    appState: state.appState,
    // Any world panel (main, help, idle start). Select is the one gesture NOT
    // refused behind an open panel: it routes to the panel ray below, which is
    // how a hands-only user works the menu they just opened.
    panelOpen: isPanelVisible(),
    launcherCapturing: isWristLauncherCapturingSelect(),
    // A fingertip on, or arriving at, a wrist panel. Suppresses the DISTANCE
    // gesture only: reaching across to the other wrist converges the hands, which
    // reads as a zoom-out. See isWristPokeNear() for why this is not the same
    // question as launcherCapturing.
    wristPokeNear: isWristPokeNear(),
    // The same condition activateSelectedSphereImageForGenAi() refuses on, read
    // early so a repeat is refused rather than queued and the readout can say so.
    genAiPending: Boolean(state.genAiLaunch) || state.cycleRequestInFlight,
    // The stop signal latches the pause and restores it on release, so it has to
    // see the flag it is about to drive.
    sphereRotationPaused: state.sphereRotationPaused,
    // Mirrored from /api/capabilities. activateSelectedSphereImageForGenAi()
    // refuses too; this keeps the confirm ring from drawing a promise the server
    // cannot keep.
    genAiAvailable: state.genAiActionsEnabled,
    selectHandedness,
    leftPresent: leftHandPresent,
    rightPresent: rightHandPresent,
    leftPositioned: leftHandTracked,
    rightPositioned: rightHandTracked,
    leftPinch: leftPinchPressed,
    rightPinch: rightPinchPressed,
    leftMicrogestureEdge,
    rightMicrogestureEdge,
    leftPalmForwardDot,
    rightPalmForwardDot,
    // Hand heights for the stop latch's release test. The latch stores the two it
    // sees on the frame it engages and asks for a drop from THOSE, so absolute
    // values (and the reference space's floor offset) never matter; see the latch
    // note in xr-hand-gestures.js. NaN when the hand is not tracked, which the
    // latch reads as "that hand is gone", one of its two exits.
    leftHandHeightM: leftHandTracked ? _leftHandAnchor.y : NaN,
    rightHandHeightM: rightHandTracked ? _rightHandAnchor.y : NaN,
    // Horizontal separation only (see the projection above); the raw 3-D
    // distance would let two hands lowered together keep driving the zoom.
    handDistanceM: handSeparationM,
    // The viewport gate. Null when the hand was not read this frame, which the
    // tree treats as "unknown", i.e. in view: an untracked hand belongs to the
    // dropout grace, not to this gate.
    leftHandNdc,
    rightHandNdc,
    // The eye-level pose gate. Same frame the NDC projection above relies on; the
    // head pose is only refreshed when both hands were read.
    headPosition: leftHandTracked && rightHandTracked ? _handHeadPosition : null,
    headForward: leftHandTracked && rightHandTracked ? _handViewForward : null,
    leftHandPosition: leftHandTracked ? _leftHandAnchor : null,
    rightHandPosition: rightHandTracked ? _rightHandAnchor : null,
    // A palm-up pinch is Meta's system wrist-menu gesture and can eject the WebXR
    // session, so the drag does not engage in that pose. An unreadable palm counts
    // as palm-up: refusing costs a gesture, guessing costs the session (so a hand
    // with no joints, the `meta-fixed-hand` profile, never drags). Only read when
    // the panel hand is pinching; nothing else consumes the answer.
    rotatePalmUp: rotateHandPinchPressed
      ? isPalmFacingUp(readHandPalmUpDot(
        rotateHandedness === "left" ? leftHandSource : rightHandSource,
        frame,
        referenceSpace
      ))
      : true,
    rotateHandNdc,
    rotateLateralM,
    rotateVerticalM,
    // The grab model's inputs. The two gains live in constants.js and the tree is
    // dependency-free, so they travel in as data (as stepHandDragSpeed()'s
    // `maxSpeed` does).
    rotateYawGainRadPerM: HAND_SPHERE_YAW_RAD_PER_M,
    rotatePitchGainRadPerM: HAND_SPHERE_PITCH_RAD_PER_M,
    rotateGainScale: handDragGainScale(),
    // What the sphere is carrying right now, because the release handoff ADDS to
    // it. Read before applyHandRotateDrag() runs.
    sphereYawSpeedRadPerS: state.sphereYRotSpeed,
    spherePitchSpeedRadPerS: state.sphereXRotSpeed
  });
  state.xrHandGesture = handGesture.state;

  // The sphere dwell clock. SPHERE_DWELL_SECONDS of no interaction auto-advances
  // to the linked image (transitions.js) through the same startSphereExit() a
  // select fires, so it would read as a phantom select part-way through a
  // pinch-drag. Any engaged hand gesture counts as interaction, including one
  // held perfectly still; the tree owns that judgement (`interacting`) so it is
  // testable offline.
  // Three guarantees, because the level alone let a phantom auto-advance through:
  //
  //   1. the level, below: every engaged frame resets the clock;
  //   2. `state.sphereInteractionHold`, which stops updateStateMachine()
  //      INCREMENTING it this frame (transitions.js), so no ordering accident
  //      between the input pump and the state machine slips a tick past the reset;
  //   3. both EDGES, explicitly, so the clock is zeroed on the frame a drag
  //      engages and again on the frame it lets go.
  if (handGesture.interacting) {
    markSphereInteraction();
    state.sphereInteractionHold = true;
  }
  if (handGesture.rotate.justEngaged || handGesture.rotate.justReleased) {
    markSphereInteraction();
    state.sphereInteractionHold = true;
  }

  applyHandDistanceGesture(handGesture.distance);
  applyHandRotateDrag(handGesture.rotate, rotateHandAnchor, dt);
  // The throw's momentum. Written AFTER the drag so the fling wins the frame it
  // fires on: stepHandDragSpeed() is a smoother chasing the hand's displacement
  // and running afterwards would eat the impulse. It writes the same two speeds
  // the drag does (one rotation path), and sphere.js's 0.95/frame decay carries
  // it out.
  //
  // The drift direction goes with it: once the momentum decays, the sphere
  // carries on the way it was thrown instead of the fixed
  // SPHERE_BASE_ROTATION_SPEED reversing the user's gesture.
  if (HAND_DRAG_VELOCITY_MODEL && handGesture.rotate.throwSpin) {
    // Legacy velocity model, kept for ?drag=vel.
    state.sphereYRotSpeed = handGesture.rotate.throwSpin.yawRadPerS;
    state.sphereXRotSpeed = handGesture.rotate.throwSpin.pitchRadPerS;
    state.sphereRotationInputActive = true;
    setSphereDriftDirectionFromRotation(
      handGesture.rotate.throwSpin.yawRadPerS,
      handGesture.rotate.throwSpin.pitchRadPerS
    );
    markSphereInteraction();
  }
  // An ordinary release aims the drift too. A plain drag, released, would
  // otherwise let go into a drift of fixed sense at full magnitude; the manual
  // speed decays (0.95/frame, ~0.27 s) while a constant does not, so the drift
  // would overtake it within about half a second and turn the sphere back. Aiming
  // it the way the hand was going makes the release a coast into a drift.
  //
  // Read from state, not from the gesture: state.sphere*RotSpeed is what the
  // sphere is ACTUALLY carrying out of the drag (smoother, zoom calming and all),
  // and the drift must agree with the motion on screen. `justReleased` and
  // `throwSpin` cannot both fire on one frame (a throw requires an engaged
  // drag), so these writers never race.
  //
  // The grab model replaces the read-back with an explicit HANDOFF. Under a
  // position map the sphere carries no speed (the drag was angles), so the fling
  // is reconstituted from the hand's own velocity, which is why the tree keeps a
  // persisting EMA (`dragSpeedMps` is 0 on every release frame because
  // `dragging` is already false).
  //
  // `releaseSpin` is ADDITIVE and already clamped, so consecutive flicks
  // accumulate and a below-threshold release imparts exactly nothing, which is
  // what makes placing an image, and re-gripping to drag further, possible.
  if (handGesture.rotate.justReleased) {
    const releaseSpin = handGesture.rotate.releaseSpin;
    if (releaseSpin && !HAND_DRAG_VELOCITY_MODEL) {
      state.sphereYRotSpeed = releaseSpin.yawRadPerS;
      state.sphereXRotSpeed = releaseSpin.pitchRadPerS;
      // The throw gets the long coast. Under the grab model this release is the
      // only spin the sphere ever gets, so it coasts like a thrown globe (tau 2.2
      // s) instead of a stick just let go (a 0.21 s decay would make flicks
      // evaporate). Set for every release, including a gain-0 one: that writes
      // ~0 rad/s so the constant is inert until the next throw, and any
      // stick/key/pointer input hands it back (sphere.js).
      state.sphereCoastTauS = SPHERE_COAST_TAU_HAND_THROW_S;
      if (releaseSpin.gain > 0) {
        state.sphereRotationInputActive = true;
      }
      setSphereDriftDirectionFromRotation(
        releaseSpin.aimYawRadPerS,
        releaseSpin.aimPitchRadPerS
      );
    } else {
      setSphereDriftDirectionFromRotation(state.sphereYRotSpeed, state.sphereXRotSpeed);
    }
    // The drift also stays out of the way while the release plays out: it must
    // not arrive at full magnitude the instant the pinch opens, or a constant
    // term overtakes the decaying manual speed within about half a second. See
    // stepDriftResume().
    holdSphereDriftResume();
    markSphereInteraction();
  }
  // The pause channel drives the same flag the right grip does, through the same
  // wrapper: one pause in the app. The tree hands back the value it wants the
  // flag to have (or null for "leave it alone"), and toggleSphereRotation() is a
  // toggle, so drive it only on a mismatch.
  //
  // This one field carries three writers, named by `stop.pauseSource`: the
  // palms-out stop signal, the pinch-and-hold BRAKE, and the THROW that hands
  // rotation back. The brake needs no separate momentum decay: the drag's
  // velocity model already steers the manual speed to zero inside the deadzone
  // (stepHandDragSpeed), and toggleSphereRotation() zeroes the remaining sliver
  // when it pauses. Only the auto-drift was missing, which is this flag.
  if (
    handGesture.stop.setPaused !== null
    && state.sphereRotationPaused !== handGesture.stop.setPaused
  ) {
    vrPauseSphereRotation();
  }
  // The ordered chord has two meanings. The tree has resolved which one this
  // frame is; both branches are existing entry points, so the guards (image
  // sphere only / tunnel only, one batch, repeat refused) are the same code
  // every other binding runs.
  if (handGesture.chord.target === "genai") {
    // Same entry point as the both-trigger chord and the thumb tap, so the guards
    // (image sphere only, one batch, repeat refused) are the same code.
    logXrEvent({ event: "genaiFired", via: "hands.orderedChord" });
    void activateSelectedSphereImageForGenAi();
  } else if (handGesture.chord.target === "tunnelJump") {
    // The same path as the right stick press and the DEV `J` key. It refuses
    // outside the tunnel on its own, so the state test here states intent rather
    // than keeping it safe.
    vrJumpToSphere();
  }
  if (handGesture.select) {
    anySelectPressed = true;
  }

  // Microgestures stand down while any direct gesture is engaged, including the
  // stop signal, which is a held pose and would leave both thumbs free to nudge
  // the rotation the pose just paused.
  const directGestureActive = handGesture.distance.active
    || handGesture.rotate.active
    || handGesture.stop.active;
  // One list of decision edges, two consumers: the in-world footer (DEV-only,
  // inside the headset) and the diagnostics event that travels to the
  // workstation (gated separately by `?log=1`). Both read the same
  // `handGesture.events`, so they cannot disagree, and neither can drift from the
  // decision because the tree emits them as it makes it.
  //
  // The reasons matter on device. Stop signal: "hands-down" is the intended
  // release, "tracking-lost" the escape hatch (seeing it where "hands-down" was
  // expected means the drop threshold is wrong). Distance gesture: "committed"
  // means the ratchet kept the stroke's value and the next continues from it,
  // "rest" means the hands came back and undid it. A `presence` line means the
  // dropout grace held a pinch that would otherwise have read as a release.
  logHandGestureEvents(handGesture);
  if (DEBUG_UI) {
    for (const item of handGesture.events) {
      if (item.note) {
        reportHandGesture(item.note);
      }
    }
  }

  // Thumb microgestures. Dispatched after the hands are read and before the
  // button-map latches and the select edge, because a tap must be able to
  // suppress this frame's Select and a speed/yaw step should land in the frame
  // the gesture was seen.
  for (const edge of microgestureEdges) {
    applyMicrogesture(edge.hand, edge.gesture, dt, directGestureActive);
  }

  // --- Button map ------------------------------------------------------------
  // Every action is edge-latched: it fires once on the press edge and re-arms on
  // release. X is the menu and Y is Capture: X is the lower, more reachable
  // button and the menu is opened repeatedly, where capture is an admin action.
  // Y is Capture only when CAPTURE_CONTROL_ENABLED (config.js); without a token
  // it falls back to Help alongside right A, so the public build has two Help
  // buttons and no capture affordance.

  // Exit VR: hold right B for ~1.5s. A tap intentionally does not exit.
  if (rightBPressed) {
    state.xrExitHoldSeconds += dt;
    const progress = Math.min(1, state.xrExitHoldSeconds / XR_EXIT_HOLD_SECONDS);
    state.xrExitHoldProgress = progress;
    setExitHoldProgress(progress);
    if (progress >= 1 && !state.xrExitLatch) {
      state.xrExitLatch = true;
      hideExitHoldIndicator();
      void exitVrSession();
    }
  } else {
    if (state.xrExitHoldSeconds > 0 && state.xrExitHoldSeconds < XR_EXIT_HOLD_SECONDS && !state.xrExitLatch) {
      flashExitHoldHint();
    } else {
      hideExitHoldIndicator();
    }
    state.xrExitHoldSeconds = 0;
    state.xrExitHoldProgress = 0;
    state.xrExitLatch = false;
  }

  // Toggle Help panel: right A always; left Y too, unless Capture has claimed it
  // below. Keeps the one-panel rule between help and menu; toggleHelpPanel closes
  // the menu when opening.
  const helpTogglePressed = rightAPressed || (leftYPressed && !CAPTURE_CONTROL_ENABLED);
  if (helpTogglePressed && !state.xrHelpToggleLatch) {
    state.xrHelpToggleLatch = true;
    toggleHelpPanel();
  }
  if (!helpTogglePressed) {
    state.xrHelpToggleLatch = false;
  }

  // Capture: left Y, only once a capture token is configured; it is an admin
  // capability (screenshot.js), not a visitor button.
  const capturePressed = leftYPressed && CAPTURE_CONTROL_ENABLED;
  if (capturePressed && !state.xrCaptureLatch) {
    state.xrCaptureLatch = true;
    void saveScreenshotWithStatus();
  }
  if (!capturePressed) {
    state.xrCaptureLatch = false;
  }

  // Toggle the main menu panel: left X.
  if (leftXPressed && !state.xrPanelToggleLatch) {
    state.xrPanelToggleLatch = true;
    togglePanel();
  }
  if (!leftXPressed) {
    state.xrPanelToggleLatch = false;
  }

  // The two stick presses rhyme: right jumps FORWARD into the sphere, left jumps
  // BACK through history, which is why Back needs no wrist row.
  if (rightStickPressed && !state.xrJumpLatch) {
    state.xrJumpLatch = true;
    vrJumpToSphere();
  }
  if (!rightStickPressed) {
    state.xrJumpLatch = false;
  }

  if (leftStickPressed && !state.xrBackLatch) {
    state.xrBackLatch = true;
    void goBack();
  }
  if (!leftStickPressed) {
    state.xrBackLatch = false;
  }

  // Pause/resume rotation is on the right grip, the most accidentally-pressed
  // button on a Touch controller, so a toggle fits: a stray squeeze costs a
  // paused sphere, where Back would cost an unwanted navigation.
  if (rightGripPressed && !state.xrPauseRotationLatch) {
    state.xrPauseRotationLatch = true;
    vrPauseSphereRotation();
  }
  if (!rightGripPressed) {
    state.xrPauseRotationLatch = false;
  }

  // Select (trigger) edge. With the panel open it consumes the trigger for
  // controller-ray activation; otherwise the trigger activates the sphere link.
  const selectEdge = anySelectPressed && !state.xrSelectLatch;
  if (anySelectPressed) {
    state.xrSelectLatch = true;
  } else {
    state.xrSelectLatch = false;
  }

  // The same edge per hand, for the panel ray only. A ray is aimed by one
  // controller, so only that controller's trigger may fire it (`anySelectPressed`
  // is either trigger, so aiming left and pulling right would activate the left
  // ray's target). A hand pinch belongs to the select hand, the only hand with a
  // ray under hand tracking, so it lands on that hand's edge.
  const handSelectHand = handGesture.select ? selectHandedness : null;
  const leftSelectPressed = leftTriggerPressed || handSelectHand === "left";
  const rightSelectPressed = rightTriggerPressed || handSelectHand === "right";
  const panelSelectEdges = {
    left: leftSelectPressed && !state.xrSelectLatchHands.left,
    right: rightSelectPressed && !state.xrSelectLatchHands.right,
    // The fallback for a ray source with no usable handedness; see slotSelectEdge().
    any: selectEdge,
    // The same three flags as LEVELS, plus this frame's delta, for the panel's
    // hold-to-activate control (Exit VR on the launcher row). An edge cannot time
    // a hold and the panel has no clock. Carried in this bundle so the pump keeps
    // one input object.
    held: { left: leftSelectPressed, right: rightSelectPressed, any: anySelectPressed },
    dtS: dt
  };
  state.xrSelectLatchHands.left = leftSelectPressed;
  state.xrSelectLatchHands.right = rightSelectPressed;

  if (isPanelVisible()) {
    // While the panel is open the trigger drives the panel ray. A trigger that
    // misses the panel is swallowed rather than firing a sphere navigation
    // "behind" the menu.
    updatePanelXrInput(panelSelectEdges);
    return;
  }

  // With no world panel open a summoned wrist panel is still ray-selectable, so
  // the same pump runs. The swallow differs: a trigger that missed is not eaten,
  // since no menu is in front of the user; it is an ordinary sphere select.
  // "Missed" is per controller: the other ray resting on a wrist panel does not
  // eat this trigger. The pump returns false without casting when nothing is
  // summoned.
  if (updatePanelXrInput(panelSelectEdges)) {
    return;
  }

  // Left grip is a modifier, not a partner. Requiring both triggers would make a
  // lone trigger wait XR_TRIGGER_CHORD_GRACE_MS to prove its partner was not
  // coming, so every ordinary select would pay for a gesture almost nobody
  // fires. Grip-then-trigger is observable in one frame, so select is immediate
  // and there is no timer. Hand pinch never touches these buttons and still
  // selects through `selectEdge` below.
  const buttons = resolveXrButtonActions(state.xrButtons, {
    leftGripPressed,
    rightTriggerPressed,
    selectEdge,
    // The same condition activateSelectedSphereImageForGenAi() refuses on, read
    // early so a grip+trigger with no relay configured falls through to an
    // ordinary select rather than being swallowed by a chord that cannot fire.
    genAiAvailable: state.genAiActionsEnabled
  });
  state.xrButtons = buttons.state;
  if (buttons.decision.fireChord) {
    // Which path fired: three bindings reach this one function and a headset
    // cannot tell them apart from outside. Inert unless ?log=1 and the server's
    // diag route are both on.
    logXrEvent({ event: "genaiFired", via: "controllers.gripChord" });
    void activateSelectedSphereImageForGenAi();
  }
  if (buttons.decision.fireSelect) {
    activateSelectedSphereLink();
  }
}

function applyDesktopSphereInput(dt) {
  if (state.appState !== AppState.INSIDE_SPHERE) {
    return;
  }
  const step = SPHERE_ROTATION_ACCEL * sphereRotationAccelScale() * dt;
  // Shift + up/down is zoom, mirroring the desktop Shift+drag. A/Y/Z/+/- keep
  // working. Left and right still yaw under shift.
  if (keyState.Shift && (keyState.ArrowUp || keyState.ArrowDown)) {
    markSphereInteraction();
    state.sphereInteractionHold = true; // zoom is driving the sphere (cleared each frame)
    applySphereZoomDelta(
      (keyState.ArrowUp ? 1 : -1) * CONTROLLER_SPHERE_ZOOM_SPEED * dt
    );
  } else if (keyState.ArrowUp) {
    markSphereInteraction();
    state.sphereRotationInputActive = true;
    state.sphereXRotSpeed = applySphereRotationDelta(state.sphereXRotSpeed, step, dt);
  } else if (keyState.ArrowDown) {
    markSphereInteraction();
    state.sphereRotationInputActive = true;
    state.sphereXRotSpeed = applySphereRotationDelta(state.sphereXRotSpeed, -step, dt);
  }
  if (keyState.ArrowLeft) {
    markSphereInteraction();
    state.sphereRotationInputActive = true;
    state.sphereYRotSpeed = applySphereRotationDelta(state.sphereYRotSpeed, step, dt);
  }
  if (keyState.ArrowRight) {
    markSphereInteraction();
    state.sphereRotationInputActive = true;
    state.sphereYRotSpeed = applySphereRotationDelta(state.sphereYRotSpeed, -step, dt);
  }
  if (keyState["+"] || keyState["="] || keyState.a) {
    markSphereInteraction();
    state.sphereInteractionHold = true;
    applySphereZoomDelta(CONTROLLER_SPHERE_ZOOM_SPEED * dt);
  }
  if (keyState["-"] || keyState["_"] || keyState.y || keyState.z) {
    markSphereInteraction();
    state.sphereInteractionHold = true;
    applySphereZoomDelta(-CONTROLLER_SPHERE_ZOOM_SPEED * dt);
  }
}

// Legacy paused-only desktop drag. Nothing imports it: the desktop drag goes
// through the touch grab model (applyDesktopPointerSphereInput below). Kept as
// the whole of the old behaviour in a few lines, and because the layer-
// differential invariant guarded by scripts/xr_hand_gestures.test.mjs is
// expressed through its callee.
function applyDesktopSpherePointerDelta(deltaX, deltaY) {
  if (renderer.xr.isPresenting || state.appState !== AppState.INSIDE_SPHERE || !state.sphereRotationPaused) {
    return false;
  }
  return applySpherePointerRotation(
    -deltaY * DESKTOP_SPHERE_POINTER_RADIANS_PER_PIXEL,
    -deltaX * DESKTOP_SPHERE_POINTER_RADIANS_PER_PIXEL
  );
}

// Which panel a flat tap or click means. One helper for both pointer paths:
// click/tap on an image selects that image and its link; with no cursor or tap
// it falls back to the centre image. The fallback is not an error case (a tap on
// the gap between panels is ordinary) and should still travel.
function activateSphereLinkAtPoint(point) {
  let index = -1;
  if (point) {
    const rect = canvas.getBoundingClientRect();
    index = spherePanelIndexAtCanvasPoint(point.x, point.y, rect.width, rect.height);
  }
  activateSelectedSphereLink(index);
}

// --- Touch controls ----------------------------------------------------------
//
// Every rule lives in the pure src/touch-gestures.js, tested against a fake
// clock in scripts/touch_gestures.test.mjs; everything here is application, and
// it applies through the existing appliers: applySphereGrabRotation(),
// applyHandDistanceGesture(), vrPauseSphereRotation(),
// activateSelectedSphereLink() and activateSelectedSphereImageForGenAi(), the
// same five calls the hands drive. There is no touch-specific rotation maths.
//
// main.js routes `pointerType === "touch"` here and everything else to the
// desktop pointer path, so the mouse feel is unaffected.
let touchGestureState = createTouchGestureState();

function resetTouchGestures() {
  touchGestureState = createTouchGestureState();
  updateTouchChordRing({ active: false });
}

// The recorder half. Coordinates are made canvas-relative here and nowhere else,
// so the pure step and the progress ring speak the same space.
function recordTouchPointerEvent(event, type) {
  const rect = canvas.getBoundingClientRect();
  touchGestureState = applyTouchPointerEvent(touchGestureState, {
    type,
    pointerId: event.pointerId,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    now: performance.now()
  });
}

function applyTouchSphereInput(dt) {
  const idle = touchGestureState.pointers.length === 0
    && !touchGestureState.drag
    && !touchGestureState.pinch;
  if (renderer.xr.isPresenting) {
    if (!idle) {
      resetTouchGestures();
    }
    return;
  }
  if (idle) {
    // Nothing is touching the screen and nothing is mid-release. Skipping keeps a
    // getBoundingClientRect() out of every frame of the common flat path.
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const stepped = stepTouchGestures(touchGestureState, {
    nowMs: performance.now(),
    dtS: dt,
    // The world panel owns the pointer while it is up, as for the desktop drag
    // and the shift+click chord.
    enabled: !isPanelVisible(),
    appState: state.appState,
    // `genAiAvailable` must be passed here: the shared resolver defaults it false
    // so a build without GenAI never shows a ring that fills and does nothing,
    // which means omitting it leaves the touch chord permanently off.
    genAiAvailable: state.genAiActionsEnabled,
    shortEdgePx: Math.min(rect.width, rect.height),
    sphereRotationPaused: state.sphereRotationPaused,
    // The residual the handoff adds to, read as the hand path reads it: what the
    // sphere is actually carrying on the release frame.
    sphereYawSpeedRadPerS: state.sphereYRotSpeed,
    spherePitchSpeedRadPerS: state.sphereXRotSpeed,
    yawGainRadPerM: HAND_SPHERE_YAW_RAD_PER_M,
    pitchGainRadPerM: HAND_SPHERE_PITCH_RAD_PER_M,
    zoomGain: handDragGainScale()
  });
  touchGestureState = stepped.state;
  applyTouchGestureDecision(stepped.decision, dt);
}

function applyTouchGestureDecision(decision, dt, { chordRing = true } = {}) {
  const rotate = decision.rotate;
  if (rotate.justEngaged || rotate.justReleased) {
    markSphereInteraction();
    state.sphereInteractionHold = true;
  }
  if (rotate.active) {
    // An engaged drag owns the sphere: claimed on every engaged frame, including
    // those commanding nothing, because a finger parked on the anchor is holding
    // the sphere still and the auto-drift must not turn underneath it. Cleared at
    // the top of renderFrame().
    state.sphereRotationInputActive = true;
    state.sphereInteractionHold = true;
    // The catch, identical to applyHandRotateDrag(): the velocity channel is
    // commanded to zero through the same smoother while the position map does the
    // real work, so a same-direction grab ADDS and an opposing one stops the
    // sphere and starts going the gesture's way.
    state.sphereYRotSpeed = stepHandDragSpeed(state.sphereYRotSpeed, {
      deflection: 0,
      maxSpeed: 0,
      dt
    });
    state.sphereXRotSpeed = stepHandDragSpeed(state.sphereXRotSpeed, {
      deflection: 0,
      maxSpeed: 0,
      dt
    });
    if (rotate.deltaPitchRad !== 0 || rotate.deltaYawRad !== 0) {
      applySphereGrabRotation(rotate.deltaPitchRad, rotate.deltaYawRad);
    }
  }

  applyHandDistanceGesture(decision.distance);

  // The release handoff, written after the drag as the hand path does: the
  // smoother above chases a target of zero and would eat the flick.
  if (rotate.justReleased && rotate.releaseSpin) {
    const releaseSpin = rotate.releaseSpin;
    state.sphereYRotSpeed = releaseSpin.yawRadPerS;
    state.sphereXRotSpeed = releaseSpin.pitchRadPerS;
    state.sphereCoastTauS = SPHERE_COAST_TAU_HAND_THROW_S;
    if (releaseSpin.gain > 0) {
      state.sphereRotationInputActive = true;
    }
    setSphereDriftDirectionFromRotation(
      releaseSpin.aimYawRadPerS,
      releaseSpin.aimPitchRadPerS
    );
    holdSphereDriftResume();
  }

  // The same pause channel and wrapper: one pause in the app.
  if (decision.setPaused !== null && state.sphereRotationPaused !== decision.setPaused) {
    vrPauseSphereRotation();
  }

  if (decision.chord.target === "genai") {
    // The same entry point the both-trigger chord, thumb tap, ordered hand chord
    // and desktop shift+click use, so the guards (image sphere only, one batch,
    // repeat refused) are the same code.
    void activateSelectedSphereImageForGenAi();
  }
  if (decision.select) {
    activateSphereLinkAtPoint(decision.selectPoint);
  }
  if (chordRing) {
    updateTouchChordRing(decision.chord);
  }
}

// --- Trackpad pinch (src/trackpad-pinch.js) ----------------------------------
//
// A trackpad pinch is a `wheel` with ctrlKey set, not a touch event, so it needs
// its own recorder but no zoom maths of its own. It goes through
// applyHandDistanceGesture(), the call the hands, touchscreen and thumbsticks
// all end up in, and so inherits the clamp, the anti-windup and the
// tunnel/sphere split.
let trackpadPinchState = createTrackpadPinchState();

function setupTrackpadPinch() {
  canvas.addEventListener("wheel", (event) => {
    if (renderer.xr.isPresenting) {
      return;
    }
    const applied = applyTrackpadWheelEvent(trackpadPinchState, {
      deltaY: event.deltaY,
      ctrlKey: event.ctrlKey,
      nowMs: performance.now(),
      // The world panel owns the pointer while it is up, as for the desktop drag,
      // the shift+click chord and the touch path.
      enabled: !isPanelVisible(),
      appState: state.appState
    });
    trackpadPinchState = applied.state;
    if (applied.handled) {
      // Mandatory when we consume it: ctrl+wheel is the browser's own page-zoom
      // gesture, and without this the whole document zooms out from under the
      // canvas. Only on events we took, so an ordinary scroll and a pinch on the
      // start panel still behave.
      event.preventDefault();
    }
    // The listener is registered { passive: false } for exactly that call.
  }, { passive: false });

  // Safari on macOS reports a trackpad pinch as gesture events, never as
  // ctrl+wheel. Converted to the wheel units Chrome would have sent
  // (scale = exp(-deltaY / 100)) so both browsers share one path. Not on touch
  // devices: iOS fires the same events for a two-finger pinch, which the touch
  // path already handles.
  if (navigator.maxTouchPoints > 0) {
    return;
  }
  let lastGestureScale = 1;
  canvas.addEventListener("gesturestart", (event) => {
    lastGestureScale = 1;
    event.preventDefault();
  });
  canvas.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    const scale = Number(event.scale);
    if (renderer.xr.isPresenting || !(scale > 0)) {
      return;
    }
    const deltaY = -100 * Math.log(scale / lastGestureScale);
    lastGestureScale = scale;
    trackpadPinchState = applyTrackpadWheelEvent(trackpadPinchState, {
      deltaY,
      ctrlKey: true,
      nowMs: performance.now(),
      enabled: !isPanelVisible(),
      appState: state.appState
    }).state;
  });
  canvas.addEventListener("gestureend", (event) => {
    event.preventDefault();
  });
}

function applyTrackpadPinchInput() {
  if (renderer.xr.isPresenting) {
    if (trackpadPinchState.stroke) {
      trackpadPinchState = createTrackpadPinchState();
      applyHandDistanceGesture({ active: false });
    }
    return;
  }
  if (!trackpadPinchState.stroke) {
    // Nothing live: skipping keeps this off the hot path on frames nobody is
    // pinching.
    return;
  }
  const stepped = stepTrackpadPinch(trackpadPinchState, { nowMs: performance.now() });
  trackpadPinchState = stepped.state;
  if (stepped.decision.distance.active) {
    markSphereInteraction();
  }
  applyHandDistanceGesture(stepped.decision.distance);
}

// --- Desktop click-and-drag --------------------------------------------------
//
// The same resolver as touch, a second instance fed by mouse and pen pointers,
// rather than a second implementation of the feel. The mouse gets the grab
// model, the drag brake, the release throw and the aimed drift resume.
//
// applySphereGrabRotation() spends every applied delta into the layer
// differential (SPHERE_MANUAL_LAYER_COUPLING), so a small drag parts the layers a
// little and a thrown one keeps them turning over each other while it coasts. The
// older applySpherePointerRotation() zeroes both rotation speeds every frame (no
// throw, no coast) and needs the sphere paused first.
//
// The chord is structurally unreachable here (two simultaneous pointers needed),
// but genAiAvailable is passed false anyway and the ring is not driven from this
// instance, so a touchscreen laptop cannot see a mouse frame blank a ring its
// fingers are drawing.
let desktopPointerGestureState = createTouchGestureState();
let desktopPointerDragging = false;

function isDesktopSpherePointer(event) {
  return event.pointerType !== "touch" && event.isPrimary !== false;
}

function resetDesktopPointerGestures() {
  desktopPointerGestureState = createTouchGestureState();
  setDesktopDragCursor(false);
}

function setDesktopDragCursor(dragging) {
  if (dragging === desktopPointerDragging) {
    return;
  }
  desktopPointerDragging = dragging;
  canvas.classList.toggle("sphere-dragging", dragging);
}

function recordDesktopPointerEvent(event, type) {
  const rect = canvas.getBoundingClientRect();
  desktopPointerGestureState = applyTouchPointerEvent(desktopPointerGestureState, {
    type,
    pointerId: event.pointerId,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    now: performance.now()
  });
}

function applyDesktopPointerSphereInput(dt) {
  const idle = desktopPointerGestureState.pointers.length === 0
    && !desktopPointerGestureState.drag
    && !desktopPointerGestureState.pinch;
  if (renderer.xr.isPresenting) {
    if (!idle) {
      resetDesktopPointerGestures();
    }
    return;
  }
  if (idle) {
    setDesktopDragCursor(false);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const stepped = stepTouchGestures(desktopPointerGestureState, {
    nowMs: performance.now(),
    dtS: dt,
    enabled: !isPanelVisible(),
    appState: state.appState,
    shortEdgePx: Math.min(rect.width, rect.height),
    // Its own knob, seeded with the touch value so the feel starts identical.
    // Normalised to the short edge, so a drag across it is the same arc on a
    // 390px phone and a 1400px window.
    metersPerShortEdge: DESKTOP_DRAG_HAND_METERS_PER_SHORT_EDGE,
    sphereRotationPaused: state.sphereRotationPaused,
    genAiAvailable: false,
    sphereYawSpeedRadPerS: state.sphereYRotSpeed,
    spherePitchSpeedRadPerS: state.sphereXRotSpeed,
    yawGainRadPerM: HAND_SPHERE_YAW_RAD_PER_M,
    pitchGainRadPerM: HAND_SPHERE_PITCH_RAD_PER_M,
    zoomGain: handDragGainScale()
  });
  desktopPointerGestureState = stepped.state;
  setDesktopDragCursor(stepped.decision.rotate.active);
  applyTouchGestureDecision(stepped.decision, dt, { chordRing: false });
}

// --- Shift + click-drag ------------------------------------------------------
//
// Zoom while the drag moves; the GenAI chord while it holds still, with the same
// confirm ring as the two-finger touch hold. There is no bare shift+click chord
// (it would fire a paid batch with no confirmation).
//
// Every rule is in the pure src/shift-drag-zoom.js; this applies the answer
// through applyHandDistanceGesture(), the same call the hands, touchscreen,
// trackpad and thumbsticks use.
let shiftDragState = createShiftDragState();

function recordShiftDragEvent(event, type) {
  const rect = canvas.getBoundingClientRect();
  const applied = applyShiftDragEvent(shiftDragState, {
    type,
    pointerId: event.pointerId,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    nowMs: performance.now(),
    shiftKey: event.shiftKey,
    enabled: !isPanelVisible() && !renderer.xr.isPresenting,
    appState: state.appState
  });
  shiftDragState = applied.state;
  return applied.handled;
}

// Letting go of shift ends the stroke, so it cannot keep zooming off a modifier
// that is no longer held.
function endShiftDragIfShiftReleased(event) {
  if (!event.shiftKey && shiftDragState.stroke) {
    shiftDragState = releaseShiftDrag(shiftDragState);
    updateTouchChordRing({ active: false });
  }
}

// Tracks whether WE put a ring on screen, so the frame the stroke disappears can
// take it down. Releasing the pointer nulls the stroke and this function would
// early-return forever, leaving the ring. The other two ways a stroke ends
// (letting go of shift, entering XR) clear it explicitly; clearing here covers
// every way a stroke can end, including ones added later.
let shiftDragChordRingShown = false;

function applyShiftDragInput() {
  if (!shiftDragState.stroke) {
    if (shiftDragChordRingShown) {
      updateTouchChordRing({ active: false });
      shiftDragChordRingShown = false;
    }
    return;
  }
  if (renderer.xr.isPresenting) {
    shiftDragState = releaseShiftDrag(shiftDragState);
    updateTouchChordRing({ active: false });
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const stepped = stepShiftDrag(shiftDragState, {
    nowMs: performance.now(),
    shortEdgePx: Math.min(rect.width, rect.height),
    genAiAvailable: state.genAiActionsEnabled
  });
  shiftDragState = stepped.state;
  const { distance, chord } = stepped.decision;
  if (distance.active) {
    markSphereInteraction();
    state.sphereInteractionHold = true;
  }
  applyHandDistanceGesture(distance);
  if (chord.target === "genai") {
    void activateSelectedSphereImageForGenAi();
  }
  updateTouchChordRing(chord);
  shiftDragChordRingShown = Boolean(chord.active);
}

function applyNonXrGamepadInput(dt) {
  if (renderer.xr.isPresenting || state.appState !== AppState.INSIDE_SPHERE || !navigator.getGamepads) {
    state.nonVrSelectLatch = false;
    return;
  }
  let anySelectPressed = false;
  const pads = navigator.getGamepads();
  for (const pad of pads) {
    if (!pad || !pad.connected) {
      continue;
    }
    const horizontalAxis = pad.axes?.[0] ?? 0;
    const verticalAxis = pad.axes?.[1] ?? 0;
    const accelStep = SPHERE_ROTATION_ACCEL * sphereRotationAccelScale() * dt;
    if (Math.abs(verticalAxis) >= 0.12) {
      markSphereInteraction();
      state.sphereRotationInputActive = true;
      state.sphereXRotSpeed = applySphereRotationDelta(state.sphereXRotSpeed, -verticalAxis * accelStep, dt);
    }
    if (Math.abs(horizontalAxis) >= 0.12) {
      markSphereInteraction();
      state.sphereRotationInputActive = true;
      state.sphereYRotSpeed = applySphereRotationDelta(state.sphereYRotSpeed, -horizontalAxis * accelStep, dt);
    }
    anySelectPressed = anySelectPressed || Boolean(pad.buttons?.[0]?.pressed || pad.buttons?.[1]?.pressed);
  }
  if (anySelectPressed && !state.nonVrSelectLatch) {
    state.nonVrSelectLatch = true;
    activateSelectedSphereLink();
  }
  if (!anySelectPressed) {
    state.nonVrSelectLatch = false;
  }
}

export {
  markUserInput,
  resetTwoHandGesture,
  readTrackedHandAnchor,
  applyHandDistanceGesture,
  applyHandRotateDrag,
  applyXrControllerInput,
  applyDesktopSphereInput,
  applyDesktopSpherePointerDelta,
  recordTouchPointerEvent,
  applyTouchSphereInput,
  resetTouchGestures,
  setupTrackpadPinch,
  applyTrackpadPinchInput,
  isDesktopSpherePointer,
  recordShiftDragEvent,
  endShiftDragIfShiftReleased,
  applyShiftDragInput,
  recordDesktopPointerEvent,
  applyDesktopPointerSphereInput,
  resetDesktopPointerGestures,
  applyNonXrGamepadInput,
  // Logical VR actions, exported so the DEV bridge drives the same paths the
  // controller pump does (jump-to-sphere in tunnel, pause-rotation in sphere).
  vrJumpToSphere,
  vrPauseSphereRotation
};
