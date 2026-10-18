// Shared mutable runtime state.
//
// ES-module imports are read-only live bindings, so any value that is
// reassigned (not mutated in place) must live on a shared object to be writable
// across modules. Fixed config lives in constants.js; the scene graph, scratch
// vectors and panel arrays are `const` objects mutated in place.
//
// DOM-derived and time-based initial values (currentQuery, cameraSpeed,
// fpsAccumulatorStart) are set during boot in main.js; the defaults here are
// placeholders so the object shape is complete from module load.

import { AppState } from "./constants.js";
import { createMicrogestureLatch } from "./xr-microgestures.js";
import { createXrButtonState } from "./xr-trigger-chord.js";
import {
  createHandGestureState,
  SPHERE_COAST_TAU_STICK_S
} from "./xr-hand-gestures.js";
import {
  AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS,
  AUTO_ADVANCE_FREE_IDLE_TIMEOUT_DEFAULT_MS
} from "./idle-auto-advance.js";

export const state = {
  // Tunnel mesh + path — rebuilt by rebuildTunnel().
  tunnelMesh: null,
  tunnelSamples: null,
  tunnelConfig: null,

  // Tunnel image-panel spawn pipeline.
  pendingPanelItems: [],
  spawnAccumulatorMs: 0,
  lastSpawnedPanelRing: 25,
  // Successful tunnel-panel attachments during the current load. Unlike the live
  // scene array, this stays monotonic when panels scroll behind the camera.
  tunnelSpawnedPanelCount: 0,

  // Extraction / current page.
  extractedItems: [],
  currentQuery: "",
  currentLoadMode: "url",
  lastSuccessfulQuery: "",
  lastSuccessfulRequest: null,
  // The latest load asked for, { mode, query, failed }, which the VR menu's status
  // line names. Unlike currentQuery it exists before, and after a failed, load.
  menuLoad: null,
  navigationHistory: [],
  sessionVisitLog: [],
  minTunnelDisplayUntilMs: 0,
  // Whether this server has a GenAI relay configured, mirrored from
  // /api/capabilities (async). It gates the img2img chord in
  // activateSelectedSphereImageForGenAi(), where all trigger paths converge, and
  // stops the touch confirm ring arming (a ring that fills and does nothing reads
  // as broken). Defaults false: before capabilities lands the answer is "not yet".
  genAiActionsEnabled: false,
  // Which image of the previous batch this round grew from, 1-based, or null on a
  // fresh prompt. Labels the image list `otters #3 (2/5)`; see describeItemNode()
  // in api.js.
  genAiLineageOrdinal: null,
  // Whether generated image-list rows are clickable. Mirrors
  // GENAI_IMAGE_LIST_LINKS from /api/health; see linkOrText() in api.js.
  imageListLinksEnabled: true,
  genAiBatchReceived: 0,
  genAiBatchExpected: 0,
  genAiBatchComplete: true,
  // Short message set when the most recent GenAI job ended without a usable batch
  // (failed status, poll-time network error, or a complete job with zero items),
  // so the status footer shows the failure instead of a stale "Generating N of M".
  // Cleared at the start of every new load request.
  genAiJobError: null,
  // The error is a spend-cap message: shown whole and without the GenAI-failed
  // framing, like its notice (api.js reportLoadError).
  genAiJobErrorIsBudget: false,
  // Client-only origin label for the run currently generating (e.g. the page a
  // selected img2img source came from), so the footer can name the source.
  // Cleared with genAiJobError at the start of every load request.
  genAiVariationLabel: "",
  // Img2img launch from a selected sphere image (both-trigger chord / shift+click):
  // { status: "importing" | "ready" | "failed", label }. The sphere exit starts on
  // the trigger itself so the source import overlaps the flight. Non-null for the
  // whole launch, which also makes a repeat trigger a no-op (one launch, one
  // provider batch). Reset in prepareForTunnelRun, the single cycle reset point.
  genAiLaunch: null,
  // { query, text }: title or alt of the sphere image whose link is loading.
  followedLabel: null,
  // { query, text }: the loaded page's own title.
  pageTitle: null,
  cycleRequestInFlight: false,
  autoGalleryMode: false,

  // State machine.
  appState: AppState.TUNNEL,
  tunnelSettledMs: 0,
  targetSphereRing: -1,
  sphereExitTargetRing: -1,
  sphereDwellSeconds: 0,
  pendingExitQuery: null,
  pendingExitMode: null,
  pendingExitSource: null,
  sphereExitSteersToSelection: true,
  // Seconds since crossing into the sphere, for the fog envelope alone. Separate
  // from sphereIrisOpenElapsed below, which starts during the approach.
  sphereFogOpenSeconds: 0,
  // Seconds elapsed since entering INSIDE_SPHERE — drives the iris-diaphragm
  // animation that splays the 8 panels outward to their clock positions.
  sphereIrisOpenElapsed: 0,
  // World-space ring float at which EXITING_SPHERE started, so panel fade
  // progress (0→1) can be parameterized regardless of cameraSpeed.
  sphereExitStartRing: 0,

  // Iris / sphere rotation animation.
  irisXRot: 0,
  irisYRot: 0,
  irisXSpeed: 0.3,
  irisYSpeed: 0.3,
  irisForming: true,
  sphereSelectedIndex: 0,
  // Seconds since sphereSelectedIndex last changed; drives the border scale/opacity
  // pulse in sphere.js. Reset on every selection flip and whenever the sphere
  // resets.
  sphereSelectionPulseElapsed: 0,
  sphereXRotSpeed: 0,
  sphereYRotSpeed: 0,
  // How fast the two speeds above coast away once nothing drives them, as a time
  // constant in seconds (sphere.js stepCoastSpeed). It depends on the momentum's
  // source: a spring-centred stick uses SPHERE_COAST_TAU_STICK_S (0.22 s), a hand
  // throw SPHERE_COAST_TAU_HAND_THROW_S (2.2 s). Every writer of sphere*RotSpeed
  // sets it; resetSphereAnimationState() restores the stick value.
  sphereCoastTauS: SPHERE_COAST_TAU_STICK_S,
  sphereRotationPaused: false,
  sphereRotationInputActive: false,
  // Which way the idle drift turns: +1 = SPHERE_BASE_ROTATION_SPEED as written,
  // -1 = the other way. Both exits of the rotate drag (throw and ordinary release;
  // sphere.js setSphereDriftDirectionFromRotation) aim it so the sphere continues
  // the hand's direction instead of the fixed drift reversing the decaying manual
  // speed. Reset with the rest of the sphere animation state.
  sphereDriftDirection: 1,
  // How much of the idle drift is currently running, 0..1. Without it the drift
  // resumed at full magnitude the instant the pinch opened, countering the
  // release. stepDriftResume() (xr-hand-gestures.js, pure) holds it at 0 while
  // anything is steering, while the sphere turns faster than the drift would, and
  // for the hold below, then ramps it over DRIFT_RESUME_SECONDS. A grab zeroes it.
  sphereDriftGain: 1,
  // Seconds of enforced silence after a rotate release before the ramp may start.
  // Set from DRIFT_RESUME_DELAY_S on the falling edge of a drag and counted down
  // in updateSphereAnimation().
  sphereDriftHoldSeconds: 0,
  // The dwell must not advance at all during a drag. Set by the hand-gesture pump
  // for any engaged gesture, cleared at the top of every renderFrame(), and read
  // by updateStateMachine(), which then skips adding dt to sphereDwellSeconds.
  sphereInteractionHold: false,
  // The first-run overlay holds the dwell while it is up, so the sphere waits for
  // the visitor it is teaching. It cannot reuse sphereInteractionHold above:
  // stepSphereOnboarding() reads that flag as "the visitor is driving", so the
  // overlay would dismiss itself. Written by stepSphereOnboarding() every frame,
  // and only while the overlay is on a screen someone can see (never in an
  // immersive session or gallery mode).
  sphereDwellHeldByOnboarding: false,
  // Cost control: dwell auto-advance is unbounded in time and, in a GenAI sphere,
  // in spend (see idle-auto-advance.js). These three suspend it once nobody is
  // there.
  //
  // lastUserInputAtMs is a performance.now() reading written by real input only
  // (DOM listeners in main.js, the input pump's interactions). Not gaze selection,
  // which changes by itself as the idle sphere drifts.
  lastUserInputAtMs: 0,
  // Overwritten from /api/health. Seeded with the module default so a failed
  // capability fetch leaves the safe behaviour in place.
  autoAdvanceIdleTimeoutMs: AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS,
  // The same, for a hop that costs nothing but bandwidth. Much longer: only
  // spending needs a short leash.
  autoAdvanceFreeIdleTimeoutMs: AUTO_ADVANCE_FREE_IDLE_TIMEOUT_DEFAULT_MS,
  autoAdvanceSuspended: false,
  sphereTextureCursor: 0,
  sphereTextureCycleRadians: 0,

  // Input latches. One edge-latch per logical action so a held button fires once.
  xrExitLatch: false,
  xrExitHoldSeconds: 0,
  // 0..1, written by input.js beside the head-locked indicator. Published as a
  // number so surfaces do not each divide by their own copy of
  // XR_EXIT_HOLD_SECONDS (a duplicated-constant trap wristui.js warns about).
  xrExitHoldProgress: 0,
  // Passthrough shows the real room instead of the backdrop. Only true inside a
  // session whose blend mode is not "opaque"; see passthrough.js.
  passthroughOn: false,
  // How far below eye level the visible world panel's bottom edge sits, or null
  // when no panel is up. Published by vrpanel.js each frame and read by the status
  // footer. A number on `state` rather than an import because ui.js importing
  // vrpanel.js closes a cycle (ui -> vrpanel -> ui) that the dev server cannot
  // resolve ("Cannot access 'BookmarkKind' before initialization").
  vrPanelBottomOffset: null,
  xrSelectLatch: false,
  // The same edge, split by hand. The panel ray activates on the edge from the
  // controller that is aiming it, so it cannot read the shared latch above: with
  // both triggers latched, a held left trigger would eat the right one's edge. The
  // shared latch still owns the sphere path.
  xrSelectLatchHands: { left: false, right: false },
  // The controller chord, select and capture decisions, all replaced wholesale
  // each frame by resolveXrButtonActions() (pure).
  xrButtons: createXrButtonState(),
  nonVrSelectLatch: false,
  xrPanelToggleLatch: false,   // left Y — toggle main menu panel.
  xrHelpToggleLatch: false,    // right A, and left Y unless capture-gated — toggle help panel.
  xrCaptureLatch: false,       // left Y — capture, when CAPTURE_CONTROL_ENABLED.
  xrBackLatch: false,          // left stick press — history back.
  xrJumpLatch: false,          // right stick press — jump to sphere (tunnel).
  xrPauseRotationLatch: false, // right grip — pause/resume (sphere).

  // Thumb microgestures: one edge latch per gesture button per hand, so either
  // hand can fire and neither double-fires. The container is mutated in place;
  // each hand's latch is replaced every frame by updateMicrogestureLatch(), which
  // never mutates its input. Absent hands keep their last latch rather than
  // re-arming (see xr-microgestures.js).
  xrMicrogestureLatch: {
    left: createMicrogestureLatch(),
    right: createMicrogestureLatch()
  },

  // Direct-manipulation hand gestures. The whole decision tree (per-hand pinch
  // contacts, the GenAI confirm hold, the select block, the yaw drag and the
  // relative-hysteresis distance gesture) lives in xr-hand-gestures.js and is
  // pure: this field is replaced wholesale every frame by resolveHandGestures(),
  // never mutated.
  xrHandGesture: createHandGestureState(),

  // Which hand carries the wrist UI: "left" | "right". Applied from the server
  // capability at boot and overridable per page load with `?wrist=` (see wristui.js
  // setWristPanelHand()). Default "left" so the dominant hand stays free to poke.
  wristPanelHand: "left",

  // Camera traverse along the tunnel path.
  currentRingFloat: 5,
  cameraSpeed: 0,
  // True while a new run is giving back the speed the sphere exit borrowed (see
  // easeTunnelSpeed() in tunnel-run.js). Set by prepareForTunnelRun, cleared by
  // the ease itself once it lands on the target.
  tunnelSpeedEasing: false,

  // Tunnel portal clip toggle.
  tunnelPortalClipActive: false,

  // Perf HUD accumulators.
  frameCounter: 0,
  fpsAccumulatorStart: 0
};
