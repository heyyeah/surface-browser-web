// Wrist panels: two small canvas-textured quads, one per ARM, each summoned
// independently by the two-tier in-view/gaze rule (wrist-summon.js). With hands
// they sit on the wrist and are selected by POKING them with the index fingertip
// of the other hand; with controllers (hand tracking is off by default on a
// Quest 2) they float behind the controller and are selected by the other
// controller's ray. Same rows, same decisions, two ways in.
//
//   CONTENT panel: chain/Web, magnifier/Image, spark/GenAI. These map 1:1 onto
//     vrpanel's own MODES.
//   SYSTEM panel: "?"/Help, camera/Capture, exit/Exit VR.
//
// `wristPanelHand` is a MIRROR flag naming the wrist that carries CONTENT
// (resolveWristPanelRole() in wrist-poke.js). Exit VR is poke-AND-HOLD, never a
// single poke; it reuses the controller path's hold contract and progress ring
// (updateSystemHold() below).
//
// Summon tiers: tier 1 (icons) when the hand is tracked and roughly in view, no
// palm test; tier 2 (icon + text) when the user LOOKS at that wrist. Gaze-to-expand
// is self-triggered before the reach, so it cannot grow targets while a finger is
// already travelling toward one. `?wristlabels=1` pins labels on as an A/B.
//
// Rules that shape the code:
//   * Selection is a POKE for hands and a CONTROLLER RAY for controllers: two
//     routes to the same activateTarget(). A quad is only offered to the ray cast
//     while it is SUMMONED, and never to the arm it is strapped to.
//   * A panel freezes its pose while a finger approaches so the target cannot
//     chase the finger aiming at it; the freeze pins the LABEL MODE too.
//   * The panels own no app logic. Sections and their gating come from vrpanel's
//     MODES via launcherSections(); promotion is showPanelForMode(); Capture is
//     screenshot.js's saveScreenshotWithStatus(); Help is vrpanel's
//     showHelpPanel(); Exit is ui.js's exitVrSession(). This file draws,
//     hit-tests and times a hold.
//   * Icons are drawn procedurally on the canvas: no fetch, no asset tree, so the
//     app stays usable offline (the constraint HAND_MODEL_PROFILE documents in
//     hands.js).
//
// A CONTENT row means what it is drawn to mean: a row that is not showing is shown
// (promote, or switch in place); the row that IS showing closes the world panel
// (it draws a close glyph). The glyph and the close are decided from the same pair
// of facts (panel open AND showing this mode), so they cannot drift apart; see
// resolveSectionPoke() in wrist-poke.js. The world panel has no close control of
// its own, so repoke-to-close is the hands-only way to dismiss it.
//
// HELP still SHOWS rather than toggles on this panel: help carries its own Close
// bar inside the view.
//
// Feedback is visual only (the client creates no AudioContext except the STT
// capture path). Hands have no haptics, hence the two-step hover -> contact
// highlight standing in for a click.

import * as THREE from "three";
import {
  WRIST_PANEL_HAND_OVERRIDE,
  WRIST_LAUNCHER_ENABLED,
  WRIST_LAUNCHER_FORCE_SUMMON,
  WRIST_LABELS_PINNED
} from "./config.js";
import { renderer, scene } from "./scene.js";
import { state } from "./state.js";
import { getActiveCamera } from "./sphere.js";
import { exitVrSession } from "./ui.js";
import { saveScreenshotWithStatus } from "./screenshot.js";
import {
  isPanelVisible,
  isHelpVisible,
  isIdlePanelVisible,
  hidePanel,
  launcherSections,
  showPanelForMode,
  activeVrPanelMode,
  isStartFavoritesShowing,
  showHelpPanel,
  hideHelpPanel,
  setExitHoldProgress,
  hideExitHoldIndicator,
  readPanelWorldPosition,
  registerRayTargets
} from "./vrpanel.js";
import {
  createWristSummonState,
  updateWristSummonState,
  resolveWristSummonTier,
  gazeCosTo,
  withinCone
} from "./wrist-summon.js";
import {
  createRayHoldState,
  updateRayHoldState
} from "./xr-ray-sources.js";
import { logXrEvent } from "./xr-diag.js";
import { registerCaptureHideables } from "./capture-hide.js";
import { drawIcon, drawRoundedRect } from "./ui-icons.js";
import { t, getLanguage } from "./i18n.js";
import { isHandLikeSource } from "./xr-microgestures.js";
import {
  layoutRectToLocalRect,
  nearestPokeTarget,
  createWristPokeState,
  updateWristPokeState,
  resolveWristPokeOutcome,
  isWristRaySelectable,
  WRIST_SYSTEM_ROW_IDS,
  WRIST_SYSTEM_HOLD_ROW_ID,
  createWristHoldState,
  updateWristHoldState,
  createWristFreezeState,
  updateWristFreezeState,
  isOwnerOccludingPanel,
  resolveWristLabelMode,
  resolveWristPanelRole,
  DEFAULT_WRIST_PANEL_HAND,
  normalizeWristPanelHand,
  resolveWristPanelHand,
  resolveFreeHand
} from "./wrist-poke.js";

// Everything to adjust after a headset trial lives in this block. Distances are
// metres, angles degrees, times ms.
//
// Offsets are expressed in a wrist frame derived from joint POSITIONS (below), not
// from the wrist joint's own quaternion, so they mean the same thing on both hands
// and on any runtime's joint-axis convention:
//   palm   out of the palm side of the hand (negative = out of the back)
//   ulnar  toward the pinky edge of the wrist (negative = thumb side)
//   distal toward the fingers (negative = toward the elbow)
const WRIST_QUAD_OFFSET_PALM_M = 0.035;
const WRIST_QUAD_OFFSET_ULNAR_M = 0.012;
// The panel is QUAD_HEIGHT_M = 0.110 tall and its three row centres sit at +0.036
// / 0 / -0.036 from its centre. Measured along `distal` from the wrist joint, +0.010
// spans -0.045 .. +0.065: GenAI (row 2, the most proximal) at -0.026, just
// proximal of the wrist; Web (row 0, drawn at the distal end) at +0.046, over the
// middle of the palm.
//
// The MCP knuckles are ~0.09 from the wrist joint, so a distal edge at +0.065
// stops short of them: the wearing hand's own extended fingers never enter the
// panel's footprint. (The wearing hand never pokes its own panel, so this is about
// occlusion and legibility.) Poke rects, freeze-on-approach and the exit ring all
// measure from the quad, so they follow this number.
// Knob: hard to reach -> raise toward +0.020; panel gets in the way over the
// hand -> lower.
const WRIST_QUAD_OFFSET_DISTAL_M = 0.010;
// The same offset for a CONTROLLER. There is no palm to turn toward the face and
// no fingertip to poke with, so the panel hangs off the grip, facing the head, and
// is selected by the other controller's ray.
//
// It runs along the grip's own BACKWARD axis (grip space points -Z the way the
// controller points, so +Z is back toward the visitor), over the hand and forearm
// rather than up into the view. Taken from the GRIP POSE, not the head: a
// head-relative "behind" would swim across the controller as the visitor turns.
// The panel's orientation is normal at the head, up levelled against world up
// (readControllerFrame).
//
// Clearance: the vendored controller models reach 80.1 mm (Quest 3), 73.6 mm
// (Quest 2) and 84.6 mm (Pico 4) along +Z in grip space. The panel is 110 mm tall,
// so in the worst orientation (controller across the view, back axis in the
// panel's plane) a centre at 160 mm leaves the near edge 105 mm out, 20 mm clear
// of the tallest.
// Knob: panel clips into the controller -> raise; drifts up the forearm -> lower.
//
// Currently unreachable: updatePanel() refuses a controller frame outright, so
// nothing below this line runs in controller mode (the callouts in
// controller-callouts.js replaced it). It is kept so that removing one
// `if (hf.controller)` guard restores it exactly.
const CONTROLLER_QUAD_OFFSET_BACK_M = 0.16;
// Roll about the quad's own normal. 0 keeps "up" pointing at the fingers (watch
// convention: 12 o'clock is distal); +-90 turns the panel across the forearm.
const WRIST_QUAD_ROLL_DEG = 0;
// 0 = fully hand-locked (rotates with the forearm), 1 = billboards at the head.
// Hand-locked faces the user whenever the palm is turned toward the face.
const WRIST_QUAD_FACE_HEAD_BLEND = 0;
// Per-frame smoothing weights, applied to the raw joint pose. Hand tracking runs at
// 30 Hz, so these are deliberately heavy.
const WRIST_POSITION_LERP = 0.25;
const WRIST_ORIENTATION_SLERP = 0.25;
// Two-tier summon, both tiers measured off the same angle: how far the hand sits
// from the centre of view. Each wrist runs its own pair of machines, so raising
// one arm summons one panel.
//
// Tier 1: the panel is there at all. A wide cone, deliberately generous: erring
// toward showing it is the correct error. There is no palm term (see
// wrist-summon.js).
const WRIST_SUMMON_VIEW_MAX_ANGLE_DEG = 50;
// Tier 2: the panel expands from icons to icon + text. Narrow enough to mean "I am
// looking at my wrist" rather than "my wrist is somewhere ahead of me".
const WRIST_SUMMON_FOCUS_MAX_ANGLE_DEG = 15;
const WRIST_SUMMON_SHOW_DELAY_MS = 150;
const WRIST_SUMMON_HIDE_DELAY_MS = 400;
// Tier 2 gets its own sustain/hysteresis pair. The tiers fail differently: a panel
// appearing a beat late is barely noticed, but a label block that grows and shrinks
// as the eyes drift is very noticeable, so expansion is slower to commit and much
// slower to let go.
const WRIST_EXPAND_SHOW_DELAY_MS = 220;
const WRIST_EXPAND_HIDE_DELAY_MS = 700;
// Collapse the wrist menu to icons while looking at the world menu. The cone is
// around the head->world-panel direction, and wider than tier 2's because the
// world panel is a 1.6 x 1.2 m surface at 2.4 m (vrpanel.js): its edges are 18.4
// deg horizontally and 14 deg vertically from its centre, so anything under ~15
// would only fire while staring at the middle. 20 covers reading across the whole
// panel. Labels vanish while the panel is only near -> tighten; they still crowd
// the menu -> widen. This rule LOSES to freeze-on-approach (resolveWristLabelMode),
// so it never shrinks a row under a finger already reaching for it.
const WRIST_WORLD_MENU_GAZE_MAX_ANGLE_DEG = 20;

// Target sizing, for a panel read and poked at ~42-46 cm. Meta's hand-menu guidance
// is >=22 mm targets with >=12 mm gaps; the row height sits just above that floor
// and the quad's own size is DERIVED from it (below), so shrinking the panel cannot
// silently shrink a touch target under the floor.
const WRIST_PAD_M = 0.007;
const WRIST_TARGET_GAP_M = 0.012;
const WRIST_ROW_H_M = 0.024;
// The icon cell is square and its width is what an icons-only panel measures.
const WRIST_ICON_CELL_W_M = 0.024;
const WRIST_ICON_LABEL_GAP_M = 0.006;
const WRIST_LABEL_W_M = 0.048;

// Poke radii, measured from the fingertip to the nearest button rect. Hover:
// proximity highlight. Activate: contact, fires once. Release: how far the finger
// must retreat before the next activation can fire (hysteresis; without it a
// resting finger machine-guns the button).
const WRIST_POKE_HOVER_M = 0.025;
const WRIST_POKE_ACTIVATE_M = 0.010;
const WRIST_POKE_RELEASE_M = 0.020;
// Freeze-on-approach: fingertip -> panel centre distance, with hysteresis.
const WRIST_FREEZE_ENTER_M = 0.10;
const WRIST_FREEZE_RELEASE_M = 0.13;
// The three releases that stop a freeze STRANDING the panel; the rules are in
// updateWristFreezeState() (wrist-poke.js), these are the numbers.
//
// How far the panel's LIVE target pose may be from the frozen quad before the
// panel is judged to have been left behind by its own arm. Measured from the
// target, not the wrist, so no fixed wrist->panel offset eats the budget: 6 cm is
// all arm movement. A poke pushes the wearing arm 1-2 cm and a 45 deg forearm roll
// moves the target ~3 cm, so this still holds for a poke.
// Knob: the panel snaps back to the wrist while being poked -> raise; it still gets
// left behind the arm -> lower.
const WRIST_FREEZE_ANCHOR_MAX_M = 0.06;
// How long the wearing hand may be UNTRACKED before the freeze lets go. Longer than
// HAND_DROPOUT_GRACE_MS (150 ms, xr-hand-gestures.js) on purpose: poking your own
// wrist occludes it, and surviving that is the freeze's job. This is the "the arm
// is actually gone" threshold.
const WRIST_FREEZE_HAND_LOST_MS = 700;
// A backstop only: no honest approach holds a panel this long. If this releases a
// freeze on device, the `wristfreeze` diagnostic says so (reason:"watchdog") and
// there is a real latch to find.
const WRIST_FREEZE_MAX_HOLD_MS = 6000;
// The panel behind the hand: a cylinder around the head->quad ray. The rules and
// ordering are isOwnerOccludingPanel() / updateWristFreezeState() in wrist-poke.js;
// these are the numbers.
//
// How much NEARER the head than the panel the wearing hand must be to count as in
// front of it rather than beside it. The natural standoff is the 35 mm palm offset,
// so 0.05 sits clear of the designed pose and fires only once the hand has got
// ahead of the panel.
const WRIST_OCCLUSION_MIN_DEPTH_M = 0.05;
// How far off that ray the hand may be and still be in the way. A hand is ~0.09 m
// across the knuckles and the measurement is taken at the WRIST, so this is a
// hand-width radius: wide enough to catch the rendered model covering the rows,
// tight enough that a hand a palm's width to the side does not count. Panels
// re-anchor while nothing covers them -> lower it.
const WRIST_OCCLUSION_MAX_RADIUS_M = 0.09;

// Exit VR is hold-to-activate. This equals the controller path's
// XR_EXIT_HOLD_SECONDS (input.js); the two must agree or the help panel's "hold to
// exit" would be wrong for one input type. Duplicated rather than imported to avoid
// an import edge into input.js; if one moves, move the other.
const WRIST_EXIT_HOLD_SECONDS = 1.5;
// The hold tolerates more wander than a poke: a long time to hold a fingertip still
// against a target at 30 Hz tracking.
const WRIST_HOLD_RELEASE_M = 0.026;

// The poke cursor: a small dot drawn at whatever point is doing the poking. Without
// joints there is no rendered hand and the "fingertip" is a synthesised point, so
// nothing on screen would say where the contact test is made; it stays useful with
// real hands because the synthesised point and the real index tip differ. Each hand
// has its own, since each pokes the opposite panel.
const POKE_CURSOR_RADIUS_M = 0.006;
const POKE_CURSOR_IDLE_COLOR = 0x9aa3ab;
const POKE_CURSOR_HOVER_COLOR = 0xf2f6f9;
const POKE_CURSOR_PRESSED_COLOR = 0x6fd08c;

// Canvas pixel density. The world panel lives at 2.4 m and gets ~640 px/m; this one
// is read at ~35-45 cm, so it needs roughly seven times that to look equally sharp.
// Everything drawn is sized in metres and converted through px().
const WRIST_CANVAS_PX_PER_M = 4400;
// Text sizes as physical heights, the meaningful unit at arm's length.
const WRIST_LABEL_FONT_M = 0.0068;
const WRIST_NOTE_FONT_M = 0.0038;

// Colours: the world panel's palette, so the surfaces read as one system.
const COLOR_BG = "#101727f2";
// The back face is COLOR_BG's own colour, carried as a number because it is a
// material, not a canvas fill. Its alpha (f2 = 0.949) is the front's; the back goes
// a little higher so it reads as solid rather than as a menu seen dimly through the
// hand.
const COLOR_BACK_FACE = 0x101727;
const BACK_FACE_OPACITY = 0.98;

// ABOVE the world panel, BELOW the ray visuals (vrpanel.js: panel 10000, ray line
// 10001, cursor dot 10002). The world panel is depthTest:false, so depth cannot
// decide the pair and draw order is the whole of it. Fractional on purpose: a slot
// between two existing orders, and the dot must land ON this surface rather than
// behind it.
const WRIST_PANEL_RENDER_ORDER = 10000.5;
const COLOR_BORDER = "#23314a";
const COLOR_TEXT = "#dbe6ff";
const COLOR_TEXT_DISABLED = "#546079";
const COLOR_CELL = "#182238";
const COLOR_CELL_HOVER = "#22406e";
const COLOR_CELL_PRESSED = "#3d69b0";
const COLOR_CELL_DISABLED = "#141a26";
const COLOR_CELL_BORDER = "#2c3d5c";
// "Open": this row's target IS the thing currently showing on the world panel.
// Matches the world panel's own COLOR_MODE_CELL_ACTIVE fill (vrpanel.js). The fill
// says "this is what is showing"; the close glyph is a SEPARATE flag (`closable`)
// saying "poking it again closes it", because on the system panel Help shows
// without being closable, and a cross there would be a lie.
const COLOR_CELL_OPEN = "#28406e";
// Exit: vrpanel's own exit-overlay palette, so the wrist row and the head-locked
// ring shown while it is held read as the same control.
const COLOR_EXIT_ARC = "#ff8a9a";
const COLOR_EXIT_TRACK = "#2d1720";
// System-row icon tints. Help/Capture borrow the panel's muted blue; Exit takes the
// warning colour, since it is the one row here that ends the session.
const COLOR_SYSTEM_ICON = "#8ea1c2";
const COLOR_EXIT_ICON = "#ff8a9a";
// --- end tunables ---

// Jointless-hand fallback: a session that did not get the `hand-tracking` feature
// reports hands as `meta-fixed-hand`, a pose but no joints. The wrist frame is
// reconstructed from the grip pose instead; the panels need only a place to hang,
// not articulation.
// How far behind the grip centroid the wrist sits, along the hand's own axis.
const GRIP_WRIST_BACK_M = 0.045;
// How far ahead of the grip centroid to synthesise a "fingertip" for poking.
const GRIP_FINGERTIP_FORWARD_M = 0.075;

// Joints that define a wrist frame, plus the poking fingertip. All come from the
// XRFrame every frame (the readTrackedHandAnchor pattern in input.js), not from
// cached slot matrices: cached slot matrices go stale.
const WRIST_JOINT = "wrist";
const INDEX_METACARPAL_JOINT = "index-finger-metacarpal";
const PINKY_METACARPAL_JOINT = "pinky-finger-metacarpal";
const INDEX_TIP_JOINT = "index-finger-tip";

const HANDS = Object.freeze(["left", "right"]);

// Items
//
// Three rows per panel, fixed order: the row index IS the poke target index, so
// nothing here may be reordered without the draw and activate paths agreeing. The
// content panel's rows come from vrpanel's MODES at runtime (so the GenAI
// server-gate stays vrpanel's business); only the icon is chosen here.

const ROWS_PER_PANEL = 3;

const CONTENT_ICONS = Object.freeze({ web: "globe", image: "magnifier", genai: "spark" });

// How each system row LOOKS. The row ORDER lives in wrist-poke.js
// (WRIST_SYSTEM_ROW_IDS) beside the outcome resolver that keys off the same ids, so
// this table cannot drift out of step with the behaviour.
const SYSTEM_ROW_STYLE = Object.freeze({
  help: { labelKey: "nav.help", icon: "question", color: COLOR_SYSTEM_ICON },
  // Capture is a SINGLE POKE with deliberately no countdown, delay or ring in front
  // of the shutter. A clean frame is bought instead by hiding the hands and every UI
  // surface from the offscreen render (capture-hide.js). This row is the only
  // capture route in VR.
  capture: { labelKey: "vr.wrist.capture", icon: "camera", color: COLOR_SYSTEM_ICON },
  // The only hold-to-activate row anywhere in the hand UI.
  exit: { labelKey: "vr.exitShort", icon: "exit", color: COLOR_EXIT_ICON, hold: true }
});
const SYSTEM_ITEMS = Object.freeze(
  WRIST_SYSTEM_ROW_IDS.map((id) => Object.freeze({ id, ...SYSTEM_ROW_STYLE[id] }))
);
const SYSTEM_EXIT_INDEX = WRIST_SYSTEM_ROW_IDS.indexOf(WRIST_SYSTEM_HOLD_ROW_ID);

// Layout. Rows are laid out top-left/y-down in metres and converted once to the
// quad's local frame for hit-testing (wrist-poke.js owns that conversion) and to
// canvas pixels for drawing. There are two layouts, one per label mode, and they
// differ ONLY in width: same row count, height and vertical positions. When the
// mode flips no target moves up or down or shrinks; rows only get wider, growing
// away from the icon column (see pinOffsetM below). A finger already travelling
// toward a row still lands on the row it was aimed at.

const CONTENT_HEIGHT_M = (WRIST_ROW_H_M * ROWS_PER_PANEL)
  + (WRIST_TARGET_GAP_M * (ROWS_PER_PANEL - 1));
const QUAD_HEIGHT_M = (WRIST_PAD_M * 2) + CONTENT_HEIGHT_M;
// Where the icon column's centre sits, measured from the panel's left edge. Same in
// both modes; it is the point the quad is anchored by.
const ICON_COLUMN_CENTRE_M = WRIST_PAD_M + (WRIST_ICON_CELL_W_M / 2);

function buildLayout(mode) {
  const rowWidthM = mode === "labels"
    ? WRIST_ICON_CELL_W_M + WRIST_ICON_LABEL_GAP_M + WRIST_LABEL_W_M
    : WRIST_ICON_CELL_W_M;
  const widthM = (WRIST_PAD_M * 2) + rowWidthM;
  const rects = [];
  for (let i = 0; i < ROWS_PER_PANEL; i += 1) {
    rects.push({
      x: WRIST_PAD_M,
      y: WRIST_PAD_M + (i * (WRIST_ROW_H_M + WRIST_TARGET_GAP_M)),
      w: rowWidthM,
      h: WRIST_ROW_H_M
    });
  }
  return {
    mode,
    widthM,
    heightM: QUAD_HEIGHT_M,
    rects,
    localRects: rects.map((rect) => layoutRectToLocalRect(rect, { widthM, heightM: QUAD_HEIGHT_M })),
    // How far along the quad's +right axis its CENTRE must sit for the icon column to
    // stay put. Zero for icons; positive for labels, so the label area extends outward
    // from a stationary icon column instead of sliding it across.
    pinOffsetM: (widthM / 2) - ICON_COLUMN_CENTRE_M,
    canvasWidth: Math.round(widthM * WRIST_CANVAS_PX_PER_M),
    canvasHeight: Math.round(QUAD_HEIGHT_M * WRIST_CANVAS_PX_PER_M)
  };
}

const LAYOUTS = Object.freeze({ icons: buildLayout("icons"), labels: buildLayout("labels") });
// One canvas per panel, allocated at the widest layout and drawn left-aligned; the
// icons layout maps only its left portion onto the quad through the texture's
// repeat.x. Cheaper than swapping canvases when a second hand comes into view.
const CANVAS_WIDTH = LAYOUTS.labels.canvasWidth;
const CANVAS_HEIGHT = LAYOUTS.labels.canvasHeight;

function px(metres) {
  return metres * WRIST_CANVAS_PX_PER_M;
}

// Icons come from the shared set in ui-icons.js so the controller callouts draw the
// same picture for the same meaning.

// Per-hand pose. One record per hand, allocated once: two panels means two wrist
// frames alive at once, so module-level scratch vectors cannot be shared between
// them.

function createHandFrame(handedness) {
  return {
    handedness,
    source: null,
    // Wrist frame: origin plus the three axes the offsets are expressed in.
    wrist: new THREE.Vector3(),
    distal: new THREE.Vector3(),
    radial: new THREE.Vector3(),
    palmNormal: new THREE.Vector3(),
    // CONTROLLERS ONLY: the grip's backward axis (+Z, the reverse of where the
    // controller points), which the panel hangs off. A wrist has no use for it; its
    // panel slides along the forearm instead.
    back: new THREE.Vector3(),
    // Head-relative directions, for the summon test and the facing blend.
    toHand: new THREE.Vector3(),
    toHead: new THREE.Vector3(),
    // The index fingertip this hand pokes the OTHER wrist's panel with.
    fingertip: new THREE.Vector3(),
    tracked: false,
    posed: false,
    fingertipTracked: false,
    // This source is a CONTROLLER, not a hand of any kind (articulated or the jointless
    // `meta-fixed-hand` fallback). It changes where the panel hangs and nothing else;
    // see readControllerFrame().
    controller: false,
    // When this hand stopped being tracked (null while it is). Freeze-on-approach is
    // the only reader: it must tell the self-occlusion dropout of poking your own wrist
    // from an arm that has left, which is a question about DURATION.
    untrackedSinceMs: null
  };
}

const HAND_FRAMES = Object.freeze({
  left: createHandFrame("left"),
  right: createHandFrame("right")
});

const _indexMetacarpal = new THREE.Vector3();
const _pinkyMetacarpal = new THREE.Vector3();
const _targetPosition = new THREE.Vector3();
const _headPosition = new THREE.Vector3();
const _headForward = new THREE.Vector3();
const _gripPosition = new THREE.Vector3();
const _gripQuaternion = new THREE.Quaternion();
const _gripScale = new THREE.Vector3();
const _gripMatrix = new THREE.Matrix4();
const _fingertipLocal = new THREE.Vector3();
const WORLD_UP = Object.freeze(new THREE.Vector3(0, 1, 0));
const _quadUp = new THREE.Vector3();
const _quadRight = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _targetQuaternion = new THREE.Quaternion();
const _headFacingQuaternion = new THREE.Quaternion();
const _rollQuaternion = new THREE.Quaternion();
// The world panel's position and the head->panel direction, for the world-menu gaze
// collapse. Scratch, like everything else here.
const _worldMenuPosition = new THREE.Vector3();
const _toWorldMenu = new THREE.Vector3();
// Where the panel's centre would be this frame, for the tier-2 gaze cone
// (panelGazeCosFor). Its own scratch rather than _targetPosition, because the cone
// is evaluated BEFORE the pose is written and _targetPosition still holds last
// frame's answer.
const _panelGazeCentre = new THREE.Vector3();
// The wearing hand's position and the head->quad ray, for the occlusion test.
const _occlusionToQuad = new THREE.Vector3();
const _occlusionToHand = new THREE.Vector3();
// Where the panel would sit now if it were not frozen, for anchor drift.
const _anchorTarget = new THREE.Vector3();

// Panels

// One record per WRIST, not per role: the quad, canvas and summon machine belong to
// an arm, while the role (content vs system) is re-read from the mirror setting
// every frame, so flipping `?wrist=` swaps what the panels show without rebuilding
// either.
function createPanel(handedness) {
  return {
    handedness,
    quad: null,
    // Solid back face, a child of the quad — see ensurePanelQuad().
    back: null,
    canvas: null,
    ctx: null,
    texture: null,
    cursor: null,
    layout: LAYOUTS.icons,
    labelMode: "icons",
    // Tier 1: is the panel on screen at all. Tier 2: is it expanded to labels.
    // Two instances of the same machine, so both inherit its anti-flicker rules.
    summon: createWristSummonState(),
    expand: createWristSummonState(),
    poke: createWristPokeState(true),
    hold: createWristHoldState(),
    // Controller ray, set by vrpanel's pump EARLIER in the same frame
    // (applyXrControllerInput runs before updateWristLauncher) and consumed and cleared
    // by updatePanel() below. One frame, never carried: a ray that moves off the panel
    // stops writing them.
    rayHoverIndex: -1,
    rayActivateIndex: -1,
    // Exit VR from a controller ray. Same shape as the world panel's own hold
    // (xr-ray-sources.js) and filled from the same pump: `engaged` is per slot "this
    // ray is on the Exit row and its trigger is still down", `armed` is "its press edge
    // landed there this frame". Both are cleared per frame beside the two indices above.
    rayHold: createRayHoldState(),
    rayHoldEngaged: [false, false],
    rayHoldArmed: [false, false],
    rayTarget: null,
    anchorInitialized: false,
    visible: false,
    // Last frame's fingertip->panel distance and the "the poke has arrived" verdict
    // built from it, mirrored out of updatePanel() for isWristPokeNear().
    // Infinity/false while nothing is reaching for it.
    pokeApproachM: Infinity,
    pokeCommitted: false,
    // Freeze-on-approach, as a state machine with real release rules
    // (updateWristFreezeState in wrist-poke.js).
    freeze: createWristFreezeState(),
    // Its live verdict, mirrored onto the panel because four things read it: the pose
    // pin, the summon machine's `tracked`, the label tier and input.js's select
    // swallow. Always `panel.freeze.frozen`; never assigned from anywhere else.
    approachFrozen: false,
    // Cheap redraw gate: the canvas is only re-rendered when something on it changed,
    // so a stationary panel costs one texture upload total.
    lastDrawKey: ""
  };
}

const PANELS = Object.freeze({
  left: createPanel("left"),
  right: createPanel("right")
});

// True only while THIS module is the one showing vrpanel's exit ring. Without it,
// hiding the ring when a wrist hold ends would also stamp on a controller B-hold
// that happened to be running. input.js drives the same overlay every frame from
// the B button; this file runs later in the frame (main.js:
// applyXrControllerInput() then updateWristLauncher()), so while a wrist hold is
// live its progress is what the user sees.
let exitRingOwned = false;
// Frame clock for the hold. Kept internal so updateWristLauncher()'s call shape in
// main.js does not change.
let lastFrameMs = 0;

// Applied through a setter, like every other server-owned toggle (see
// setStatusFooterEnabled in ui.js): the server value arrives with the /api/health
// capabilities at boot. The `?wrist=` query override always wins, so a handedness
// swap needs neither a UI nor a save.
function setWristPanelHand(value) {
  state.wristPanelHand = WRIST_PANEL_HAND_OVERRIDE
    || normalizeWristPanelHand(value)
    || DEFAULT_WRIST_PANEL_HAND;
  return state.wristPanelHand;
}

// Names the wrist carrying the CONTENT panel (Web/Image/GenAI); the other wrist
// carries the system panel. See resolveWristPanelRole().
function wristPanelHand() {
  return resolveWristPanelHand(state.wristPanelHand);
}

// The hand opposite the content panel: the hand that pokes it and whose pinch
// drives Select in input.js. With the default "left" that is the right hand, so
// neither side hardcodes a handedness.
function freeHand() {
  return resolveFreeHand(state.wristPanelHand);
}

function panelRole(handedness) {
  return resolveWristPanelRole(handedness, state.wristPanelHand);
}

// Quad + canvas

function ensurePanelQuad(panel) {
  if (panel.quad) {
    return panel.quad;
  }
  panel.canvas = document.createElement("canvas");
  panel.canvas.width = CANVAS_WIDTH;
  panel.canvas.height = CANVAS_HEIGHT;
  panel.ctx = panel.canvas.getContext("2d");

  panel.texture = new THREE.CanvasTexture(panel.canvas);
  panel.texture.colorSpace = THREE.SRGBColorSpace;
  // Mipmaps are off (see createPanelSurface() in vrpanel.js). WRIST_CANVAS_PX_PER_M =
  // 4400 against ~2000-2600 screen px/m at the 35-46 cm read distance is a ~1.7-2.2x
  // minification, so with the mip chain the wrist text was sampled mostly at half
  // resolution. Dropping the chain makes it sharper at the cost of some edge crawl on
  // thin strokes as the wrist moves. If shimmer is the problem, restore
  // `anisotropy = getMaxAnisotropy()` here; better still, lower WRIST_CANVAS_PX_PER_M
  // toward the screen density.
  panel.texture.generateMipmaps = false;
  panel.texture.minFilter = THREE.LinearFilter;
  panel.texture.magFilter = THREE.LinearFilter;
  panel.texture.anisotropy = 1;

  const material = new THREE.MeshBasicMaterial({
    map: panel.texture,
    transparent: true,
    // Depth-tested (so it sits in the world honestly, behind a hand that passes in
    // front of it) but never depth-writing, so it cannot punch a hole in anything drawn
    // after it.
    depthWrite: false,
    // FRONT ONLY. Seen from behind, a double-sided transparent texture shows the menu
    // mirrored and read through the balls of the visitor's own hand. The back is its own
    // solid quad, below. FrontSide also keeps the BACK out of the ray cast: three tests
    // material.side, so a ray arriving from behind passes through to whatever is beyond
    // rather than activating a row nobody can see.
    side: THREE.FrontSide
  });
  panel.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  panel.quad.renderOrder = WRIST_PANEL_RENDER_ORDER;
  panel.quad.visible = false;
  // Ray-selectable, because hand tracking is off by default on a Quest 2 and Capture
  // exists nowhere else. The invariant is not "any ray may hit this": wristRayTargets()
  // below only offers a panel that is SUMMONED and visible, and never to the arm
  // wearing it (the poke rule's "use the other hand"), so an aiming hand cannot eat
  // its own view of the world. Priority over the world panel falls out of distance
  // (see castSelectionRay in vrpanel.js).
  //
  // The back: the panel is shown whichever way the arm is turned, so the back is a
  // face a visitor will meet. It stays a deliberate blank surface in the panel's own
  // background colour, which invites turning the hand over. Slightly more opaque than
  // the front so it reads as solid rather than as a dimmed menu.
  //
  // A CHILD of the quad, so it inherits the pose, visibility and matrixWorld update
  // the quad already gets and leaves the capture-hide list and the context-restore
  // traversal unchanged. depthWrite stays off as on the front, and it is never
  // raycastable: the back is not a control.
  const backMaterial = new THREE.MeshBasicMaterial({
    color: COLOR_BACK_FACE,
    transparent: true,
    opacity: BACK_FACE_OPACITY,
    depthWrite: false,
    side: THREE.BackSide
  });
  panel.back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backMaterial);
  panel.back.renderOrder = WRIST_PANEL_RENDER_ORDER;
  panel.back.raycast = () => {};
  panel.quad.add(panel.back);
  scene.add(panel.quad);
  applyLayout(panel, panel.layout, true);
  return panel.quad;
}

// Switch a panel between the icons and labels layouts. The geometry is rebuilt
// rather than scaled: worldToLocal() divides by scale, so a scaled quad would
// silently distort every lateral poke distance while leaving depth alone. Mode
// changes are rare (behind a hysteresis), so one geometry allocation is the cheaper
// mistake.
function applyLayout(panel, layout, force = false) {
  if (!force && panel.layout === layout) {
    return;
  }
  panel.layout = layout;
  if (!panel.quad) {
    return;
  }
  panel.quad.geometry.dispose();
  panel.quad.geometry = new THREE.PlaneGeometry(layout.widthM, layout.heightM);
  if (panel.back) {
    panel.back.geometry.dispose();
    panel.back.geometry = new THREE.PlaneGeometry(layout.widthM, layout.heightM);
  }
  // The canvas is always the widest layout; show only the part in use.
  panel.texture.repeat.set(layout.canvasWidth / CANVAS_WIDTH, 1);
  panel.texture.offset.set(0, 0);
  panel.lastDrawKey = "";
}

// Controller ray
// A second route in, not a replacement: the poke path above is untouched and is the
// only thing hands use. Hand tracking is off by default on a Quest 2, which would
// otherwise leave the system panel (Help, Capture, Exit VR) unreachable.
//
// The cast itself belongs to vrpanel.js, which does one per ray source and drives
// hover, ray length and cursor dot from that single result. This side contributes
// the surfaces and reads back a hit.

const PANEL_LIST = Object.freeze([PANELS.left, PANELS.right]);
const _rayTargets = [];
const _rayLocal = new THREE.Vector3();

// Which row a plane-local hit lands on, or -1 for the padding between rows.
// Containment, not nearest: a ray is precise where a fingertip is not, and the
// world panel's hitRectIndexAt() is exact for the same reason.
function rayRowIndex(panel, uv) {
  const layout = panel.layout;
  _rayLocal.set((uv.x - 0.5) * layout.widthM, (uv.y - 0.5) * layout.heightM, 0);
  const nearest = nearestPokeTarget(_rayLocal, layout.localRects);
  return nearest.approachM <= 1e-6 ? nearest.index : -1;
}

// Which row on THIS panel is hold-to-activate this frame, or -1. The row index only
// means Exit VR while the panel wears the system role; the mirror setting can move
// that role to the other wrist between frames, and row 2 on the content panel is
// GenAI. Reading the role here stops a hold begun on Exit from being finished by a
// row that is no longer Exit.
function holdRowIndexFor(panel) {
  return panelRole(panel.handedness) === "system" ? SYSTEM_EXIT_INDEX : -1;
}

function rayTargetFor(panel) {
  if (!panel.rayTarget) {
    panel.rayTarget = {
      mesh: panel.quad,
      hover: (uv, ray) => {
        const index = rayRowIndex(panel, uv);
        panel.rayHoverIndex = index;
        // The trigger LEVEL, per ray slot, for the one hold row. Written on every frame the
        // ray is on it and never otherwise, so a ray that drifts off, or a controller that
        // disconnects, cancels the hold by going quiet. See updateSystemHold().
        if (index >= 0 && index === holdRowIndexFor(panel) && ray?.slot >= 0) {
          panel.rayHoldEngaged[ray.slot] = Boolean(ray.held);
        }
      },
      // DEFERRED, not run here. updatePanel() dispatches it later in the frame through
      // activateTarget(), so a ray and a poke take the identical path (same
      // close/switch/promote decision, `wristpoke` diagnostic and draw-then-activate
      // ordering).
      activate: (uv, ray) => {
        const index = rayRowIndex(panel, uv);
        panel.rayActivateIndex = index;
        // The press edge ARMS the hold. A hold that could start from the level alone would
        // begin the moment a trigger pulled for something else swept across Exit.
        if (index >= 0 && index === holdRowIndexFor(panel) && ray?.slot >= 0) {
          panel.rayHoldEngaged[ray.slot] = true;
          panel.rayHoldArmed[ray.slot] = true;
        }
      }
    };
  }
  return panel.rayTarget;
}

// The surfaces this ray source may select. The rule is isWristRaySelectable() in
// wrist-poke.js; the quad check is only "has this panel ever been built".
function wristRayTargets(handedness) {
  _rayTargets.length = 0;
  for (const panel of PANEL_LIST) {
    if (!panel.quad || !isWristRaySelectable(panel, handedness)) {
      continue;
    }
    _rayTargets.push(rayTargetFor(panel));
  }
  return _rayTargets;
}

registerRayTargets(wristRayTargets);

// Built lazily alongside the quad, and only ever by a POKE, so a controller-only
// session never allocates it. Depth-writing and low renderOrder are deliberate: the
// dot is a physical object at the finger, not an overlay, and must be occluded by
// the panel when it passes behind it; that occlusion is the depth cue for how far
// there is still to reach.
function ensurePokeCursor(panel) {
  if (panel.cursor) {
    return panel.cursor;
  }
  const geometry = new THREE.SphereGeometry(POKE_CURSOR_RADIUS_M, 12, 8);
  const material = new THREE.MeshBasicMaterial({ color: POKE_CURSOR_IDLE_COLOR });
  panel.cursor = new THREE.Mesh(geometry, material);
  panel.cursor.visible = false;
  panel.cursor.raycast = () => {};
  scene.add(panel.cursor);
  return panel.cursor;
}

function setPokeCursor(panel, position, visible, hovered, pressed) {
  if (!visible) {
    if (panel.cursor) {
      panel.cursor.visible = false;
    }
    return;
  }
  const cursor = ensurePokeCursor(panel);
  cursor.visible = true;
  cursor.position.copy(position);
  let color = POKE_CURSOR_IDLE_COLOR;
  if (pressed) {
    color = POKE_CURSOR_PRESSED_COLOR;
  } else if (hovered) {
    color = POKE_CURSOR_HOVER_COLOR;
  }
  cursor.material.color.set(color);
  // Growing on contact gives the press a second, non-colour cue; colour alone is easy
  // to miss in peripheral vision against the tunnel.
  cursor.scale.setScalar(pressed ? 1.5 : 1);
}

// Drawing

function cellFill(enabled, hovered, pressed) {
  if (!enabled) {
    return COLOR_CELL_DISABLED;
  }
  if (pressed) {
    return COLOR_CELL_PRESSED;
  }
  return hovered ? COLOR_CELL_HOVER : COLOR_CELL;
}

// The progress ring the Exit row wears while held: an arc around its icon, in
// vrpanel's exit-overlay colours. The head-locked ring says how long is left; this
// one says WHICH control is counting.
function drawHoldRing(ctx, cx, cy, radius, progress) {
  ctx.save();
  ctx.lineWidth = radius * 0.22;
  ctx.lineCap = "round";
  ctx.strokeStyle = COLOR_EXIT_TRACK;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (progress > 0) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = COLOR_EXIT_ARC;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + (Math.min(1, progress) * Math.PI * 2));
    ctx.stroke();
  }
  ctx.restore();
}

// One row: an icon cell, and in labels mode its text.
//
// `open` means the world panel is showing THIS row's thing right now: it takes the
// world panel's "active" fill. `closable` means a repoke would CLOSE that thing and
// is the only thing that draws the cross (labels mode only, where there is room).
// They are separate on purpose; see COLOR_CELL_OPEN above and resolveSectionPoke()
// in wrist-poke.js. In icons mode the open FILL is the whole cue; repoke-to-close
// still works, unlabelled.
function drawRow(ctx, rect, item, opts) {
  const { hovered, pressed, open, closable, enabled, labels, holdProgress } = opts;
  const x = px(rect.x);
  const y = px(rect.y);
  const w = px(rect.w);
  const h = px(rect.h);

  ctx.fillStyle = open ? COLOR_CELL_OPEN : cellFill(enabled, hovered, pressed);
  drawRoundedRect(ctx, x, y, w, h, px(0.004));
  ctx.fill();
  ctx.lineWidth = (open || hovered) ? px(0.0012) : px(0.0005);
  if (!enabled) {
    ctx.strokeStyle = COLOR_CELL_BORDER;
  } else if (open || hovered) {
    ctx.strokeStyle = item.color;
  } else {
    ctx.strokeStyle = COLOR_CELL_BORDER;
  }
  ctx.stroke();

  const iconSize = px(WRIST_ICON_CELL_W_M) * 0.62;
  const iconCx = x + (px(WRIST_ICON_CELL_W_M) / 2);
  const iconCy = y + (h / 2);
  const iconColor = enabled ? item.color : COLOR_TEXT_DISABLED;
  drawIcon(ctx, item.icon, iconCx, iconCy, iconSize, iconColor);
  if (holdProgress !== null) {
    drawHoldRing(ctx, iconCx, iconCy, px(WRIST_ICON_CELL_W_M) * 0.42, holdProgress);
  }

  if (!labels) {
    return;
  }

  const textX = x + px(WRIST_ICON_CELL_W_M + WRIST_ICON_LABEL_GAP_M);
  ctx.fillStyle = enabled ? COLOR_TEXT : COLOR_TEXT_DISABLED;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(px(WRIST_LABEL_FONT_M))}px 'Segoe UI', sans-serif`;
  // A disabled row (GenAI without a relay endpoint) carries the same "Configure flat"
  // note as the world panel's gated mode tab, so the two never disagree about why it
  // cannot be poked. No room for it in icons mode; the greyed icon carries the message.
  if (!enabled) {
    ctx.fillText(item.label, textX, y + (h * 0.36));
    ctx.font = `500 ${Math.round(px(WRIST_NOTE_FONT_M))}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = COLOR_TEXT_DISABLED;
    ctx.fillText(t("vr.configureFlat"), textX, y + (h * 0.7));
  } else {
    ctx.fillText(item.label, textX, y + (h / 2));
  }

  if (closable) {
    ctx.fillStyle = item.color;
    ctx.textAlign = "right";
    ctx.font = `700 ${Math.round(px(WRIST_LABEL_FONT_M * 0.9))}px 'Segoe UI', sans-serif`;
    ctx.fillText("✕", x + w - px(0.006), y + (h / 2));
    ctx.textAlign = "left";
  }
}

// The rows a panel shows this frame, as a uniform shape the draw and activate paths
// both read. Content rows come from vrpanel (labels, colours and the GenAI gate are
// its business); system rows are the fixed table above.
function panelItems(panel, sections) {
  if (panelRole(panel.handedness) === "content") {
    return sections.map((section) => ({
      id: section.id,
      label: section.label,
      color: section.color,
      icon: CONTENT_ICONS[section.id] || "globe",
      enabled: section.enabled,
      active: section.active,
      hold: false
    }));
  }
  return SYSTEM_ITEMS.map((item) => ({ ...item, label: t(item.labelKey), enabled: true, active: false, hold: Boolean(item.hold) }));
}

function drawPanel(panel, items, ctxState) {
  if (!panel.ctx) {
    return;
  }
  const ctx = panel.ctx;
  const layout = panel.layout;
  const w = layout.canvasWidth;
  const h = layout.canvasHeight;
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = COLOR_BG;
  drawRoundedRect(ctx, 2, 2, w - 4, h - 4, px(0.006));
  ctx.fill();
  ctx.lineWidth = px(0.0006);
  ctx.strokeStyle = COLOR_BORDER;
  ctx.stroke();

  const labels = layout.mode === "labels";
  for (let i = 0; i < layout.rects.length; i += 1) {
    const item = items[i];
    if (!item) {
      continue;
    }
    // A finger on the panel outranks a ray pointing at it: the poke is the nearer, more
    // deliberate act, and only one of the two can be pressed.
    const hovered = panel.poke.hoverIndex >= 0
      ? panel.poke.hoverIndex === i
      : panel.rayHoverIndex === i;
    // EXACTLY the conditions resolveWristPokeOutcome() closes on, so the cross and the
    // behaviour cannot disagree: a content row whose mode the panel is showing
    // ("close"), or the Help row while help is up ("help-close"). A row drawn open
    // without a cross when a repoke closes it would be a lie.
    const closable = Boolean(
      (item.active && ctxState.mainOpen)
      || (item.id === "help" && ctxState.helpOpen)
    );
    drawRow(ctx, layout.rects[i], item, {
      hovered,
      pressed: hovered && panel.poke.pressed,
      open: closable,
      closable,
      enabled: item.enabled,
      labels,
      // Either route's progress; only one of the two can be running.
      holdProgress: item.hold ? Math.max(panel.hold.progress, panel.rayHold.progress) : null
    });
  }

  panel.texture.needsUpdate = true;
}

function drawPanelIfChanged(panel, items, ctxState) {
  const key = [
    panel.layout.mode,
    panel.poke.hoverIndex,
    panel.rayHoverIndex,
    panel.poke.pressed ? 1 : 0,
    // Quantised: the ring is 4400 px/m, so sub-percent steps are invisible and would
    // cost a texture upload every frame of the hold.
    Math.round(Math.max(panel.hold.progress, panel.rayHold.progress) * 40),
    ctxState.mainOpen ? 1 : 0,
    ctxState.helpOpen ? 1 : 0,
    getLanguage(),
    items.map((item) => `${item.id}${item.enabled ? 1 : 0}${item.active ? 1 : 0}`).join("")
  ].join("|");
  if (key === panel.lastDrawKey) {
    return;
  }
  panel.lastDrawKey = key;
  drawPanel(panel, items, ctxState);
}

// Pose

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

// Pose of a hand that has no joints. `gripSpace` is the WebXR grip centroid
// (roughly the palm); `targetRaySpace` is the last resort: it is what draws the
// visible rays, so if a ray renders, this resolves.
function readGripPose(source, frame, referenceSpace) {
  const space = source.gripSpace || source.targetRaySpace;
  if (!space) {
    return false;
  }
  const pose = frame.getPose(space, referenceSpace);
  if (!pose) {
    return false;
  }
  _gripMatrix.fromArray(pose.transform.matrix);
  _gripMatrix.decompose(_gripPosition, _gripQuaternion, _gripScale);
  return true;
}

// Wrist frame reconstructed from the grip pose. Grip space points -Z the way the
// hand points, which gives the forearm axis; the palm normal is NOT recoverable
// without joints, so rather than guess a handedness-dependent axis (and risk the
// panel facing into the user's arm) it aims at the head. The summon rule has no
// palm term, so gaze-at-hand is the trigger here.
function readWristFrameFromGrip(hf, frame, referenceSpace) {
  if (!readGripPose(hf.source, frame, referenceSpace)) {
    return false;
  }
  hf.distal.set(0, 0, -1).applyQuaternion(_gripQuaternion);
  if (hf.distal.lengthSq() < 1e-8) {
    return false;
  }
  hf.distal.normalize();
  hf.wrist.copy(_gripPosition).addScaledVector(hf.distal, -GRIP_WRIST_BACK_M);

  getActiveCamera().getWorldPosition(_headPosition);
  hf.palmNormal.copy(_headPosition).sub(hf.wrist);
  if (hf.palmNormal.lengthSq() < 1e-8) {
    return false;
  }
  hf.palmNormal.normalize();

  hf.radial.crossVectors(hf.distal, hf.palmNormal);
  if (hf.radial.lengthSq() < 1e-8) {
    return false;
  }
  hf.radial.normalize();
  if (hf.handedness !== "left") {
    hf.radial.negate();
  }
  return true;
}

// Anchor frame for a CONTROLLER. Not a wrist frame in disguise: there is no palm,
// so nothing asks the visitor to turn one toward their face. The quad's normal
// points at the head and its up is world up, so the panel reads level however the
// controller is rolled, and `hf.wrist` is the grip centroid itself, which both
// summon tiers measure off.
//
// gripSpace, not targetRaySpace: grip is where the hand is, target-ray is where it
// points, and this is a place to hang UI rather than an aim. readGripPose() falls
// back to targetRaySpace when a runtime reports no grip.
//
// `back` is the axis the panel hangs off (CONTROLLER_QUAD_OFFSET_BACK_M); the distal
// axis is world up and is only the quad's own up here. Every consumer downstream
// (summon, pin offset, freeze, draw) is unchanged.
function readControllerFrame(hf, frame, referenceSpace) {
  if (!readGripPose(hf.source, frame, referenceSpace)) {
    return false;
  }
  hf.wrist.copy(_gripPosition);
  // +Z out of the grip: the reverse of where the controller points, i.e. back over the
  // hand toward the visitor.
  hf.back.set(0, 0, 1).applyQuaternion(_gripQuaternion);
  if (hf.back.lengthSq() < 1e-8) {
    return false;
  }
  hf.back.normalize();
  hf.palmNormal.copy(_headPosition).sub(hf.wrist);
  if (hf.palmNormal.lengthSq() < 1e-8) {
    return false;
  }
  hf.palmNormal.normalize();
  // World up flattened against the normal. Degenerate only when the head is directly
  // above or below the controller, where there is no level "up" and the panel is
  // edge-on anyway.
  hf.distal.copy(WORLD_UP).addScaledVector(hf.palmNormal, -WORLD_UP.dot(hf.palmNormal));
  if (hf.distal.lengthSq() < 1e-8) {
    return false;
  }
  hf.distal.normalize();
  hf.radial.crossVectors(hf.distal, hf.palmNormal);
  if (hf.radial.lengthSq() < 1e-8) {
    return false;
  }
  hf.radial.normalize();
  if (hf.handedness !== "left") {
    hf.radial.negate();
  }
  return true;
}

// Builds the wrist frame from joint positions. Deriving the palm normal from
// geometry rather than the wrist quaternion keeps the offsets meaningful whatever a
// runtime does with its joint axes; the only handedness-dependent term is the sign,
// known from the input source.
function readWristFrame(hf, frame, referenceSpace) {
  if (hf.controller) {
    return readControllerFrame(hf, frame, referenceSpace);
  }
  const hand = hf.source.hand;
  if (!hand) {
    return readWristFrameFromGrip(hf, frame, referenceSpace);
  }
  if (
    !readJointPosition(hand, frame, referenceSpace, WRIST_JOINT, hf.wrist)
    || !readJointPosition(hand, frame, referenceSpace, INDEX_METACARPAL_JOINT, _indexMetacarpal)
    || !readJointPosition(hand, frame, referenceSpace, PINKY_METACARPAL_JOINT, _pinkyMetacarpal)
  ) {
    return readWristFrameFromGrip(hf, frame, referenceSpace);
  }

  // Wrist -> knuckles: along the hand, away from the elbow.
  hf.distal
    .copy(_indexMetacarpal)
    .add(_pinkyMetacarpal)
    .multiplyScalar(0.5)
    .sub(hf.wrist);
  // Pinky -> index: across the hand, ulnar edge to radial (thumb) edge.
  hf.radial.copy(_indexMetacarpal).sub(_pinkyMetacarpal);
  if (hf.distal.lengthSq() < 1e-8 || hf.radial.lengthSq() < 1e-8) {
    return false;
  }
  hf.distal.normalize();
  hf.radial.normalize();

  // distal x radial points out of the BACK of a right hand and out of the PALM
  // of a left hand, so the right hand flips.
  hf.palmNormal.crossVectors(hf.distal, hf.radial);
  if (hf.handedness !== "left") {
    hf.palmNormal.negate();
  }
  if (hf.palmNormal.lengthSq() < 1e-8) {
    return false;
  }
  hf.palmNormal.normalize();
  return true;
}

// Head-relative directions this hand's summon test and facing blend need.
function readHandHeadDirections(hf) {
  hf.toHand.copy(hf.wrist).sub(_headPosition);
  if (hf.toHand.lengthSq() < 1e-8 || _headForward.lengthSq() < 1e-8) {
    return false;
  }
  hf.toHand.normalize();
  hf.toHead.copy(hf.toHand).negate();
  return true;
}

// Both summon tiers for one hand, from the one thing they both measure: the angle
// between where the head is looking and where the hand is. The decision is
// resolveWristSummonTier() in wrist-summon.js; this is only the dot product that
// feeds it.
const SUMMON_TIER_ANGLES = Object.freeze({
  viewMaxAngleDeg: WRIST_SUMMON_VIEW_MAX_ANGLE_DEG,
  focusMaxAngleDeg: WRIST_SUMMON_FOCUS_MAX_ANGLE_DEG
});
const NO_SUMMON_TIER = Object.freeze({ inView: false, focused: false });

// Is the user looking at the world menu? Same machinery as summonTierFor() above:
// one head pose (read by readHands()), one direction, and withinCone() from
// wrist-summon.js, so there is one notion of "looking at" in this file.
//
// No sustain or hysteresis, unlike the summon tiers, on purpose: the world panel is
// a large surface the gaze rests on rather than a wrist glanced at, and the
// collapse is the SAFE direction (an early collapse costs a smaller panel). Where
// a hazard exists, collapsing under a finger mid-reach, freeze-on-approach outranks
// this outright.
function readWorldMenuGaze() {
  if (!readPanelWorldPosition(_worldMenuPosition)) {
    return false;
  }
  _toWorldMenu.copy(_worldMenuPosition).sub(_headPosition);
  if (_toWorldMenu.lengthSq() < 1e-8 || _headForward.lengthSq() < 1e-8) {
    return false;
  }
  _toWorldMenu.normalize();
  return withinCone(_headForward.dot(_toWorldMenu), WRIST_WORLD_MENU_GAZE_MAX_ANGLE_DEG);
}

// What tier 2 is aimed at: the PANEL centre, not the wrist joint. The panel does not
// sit on the wrist (WRIST_QUAD_OFFSET_DISTAL_M +0.010 on top of the 35 mm palm and
// 12 mm ulnar offsets). At a 35-40 cm read distance with the labels layout's 27 mm
// pin offset:
//
//   wrist -> panel CENTRE   ~38 mm icons / ~53 mm labels
//   wrist -> the far ROW    the quad is 110 mm tall, so a row centre is up to 55 mm
//                           from the centre along the forearm
//   wrist -> the row being read, worst case
//                           hypot(55, 39) = 67 mm: 10.9 deg at 0.35 m, 12.6 deg at
//                           0.30 m
//
// Against a 15 deg cone that leaves one to four degrees for head jitter, and the
// error is a fixed BIAS, present every frame in the same direction. Once the cone
// breaks, WRIST_EXPAND_HIDE_DELAY_MS (700 ms) is all that stands between a steady
// gaze and the labels vanishing.
//
// Aiming at the panel centre removes the bias: what is left is the +-55 mm row
// spread, symmetric about the thing looked at (+-9 deg at 0.35 m). Tier 1 stays on
// the hand: it asks "is that hand in front of me", and its cone is 50 deg wide
// where none of this matters.
//
// `panel.layout` is last frame's, which is right: it is the layout the user is
// looking at, and the pin offset differs between the two by 27 mm.
function panelGazeCosFor(hf, panel) {
  computePanelCentre(hf, panel.layout, _panelGazeCentre);
  return gazeCosTo(_headPosition, _panelGazeCentre, _headForward);
}

function summonTierFor(hf, panel) {
  if (!hf.posed) {
    return NO_SUMMON_TIER;
  }
  const focusCos = panelGazeCosFor(hf, panel);
  return resolveWristSummonTier(
    _headForward.dot(hf.toHand),
    SUMMON_TIER_ANGLES,
    Number.isFinite(focusCos) ? focusCos : _headForward.dot(hf.toHand)
  );
}

// Where the panel's CENTRE would sit for this wrist frame and layout, written into
// `out`. Split out of computeTargetPose() because the tier-2 gaze cone needs the
// same point one step earlier in the frame (see panelGazeCosFor()); computing the
// offset chain twice by hand would let the cone and the panel drift apart.
//
// Leaves the quad basis in _quadRight / _quadUp, which computeTargetPose() reuses.
function computePanelCentre(hf, layout, out) {
  out
    .copy(hf.wrist)
    .addScaledVector(hf.palmNormal, WRIST_QUAD_OFFSET_PALM_M)
    .addScaledVector(hf.radial, -WRIST_QUAD_OFFSET_ULNAR_M);
  // Two different axes, not one number with two meanings: a wrist panel slides along
  // the forearm, a controller panel sits back behind the hardware.
  if (hf.controller) {
    out.addScaledVector(hf.back, CONTROLLER_QUAD_OFFSET_BACK_M);
  } else {
    out.addScaledVector(hf.distal, WRIST_QUAD_OFFSET_DISTAL_M);
  }

  // Plane geometry faces +Z, so the quad's normal is the palm normal and its up runs
  // along the forearm toward the fingers.
  _quadUp.copy(hf.distal);
  _quadRight.crossVectors(_quadUp, hf.palmNormal).normalize();
  _quadUp.crossVectors(hf.palmNormal, _quadRight).normalize();

  // Anchor the panel by its ICON COLUMN rather than its centre: switching to the
  // labels layout then extends the panel outward along +right instead of sliding
  // every target sideways under a finger already reaching for one. That, plus
  // identical row heights and positions in both layouts, keeps the gaze-to-expand
  // tier from breaking freeze-on-approach.
  if (layout.pinOffsetM !== 0) {
    out.addScaledVector(_quadRight, layout.pinOffsetM);
  }
  return out;
}

function computeTargetPose(hf, layout) {
  computePanelCentre(hf, layout, _targetPosition);
  _basis.makeBasis(_quadRight, _quadUp, hf.palmNormal);
  _targetQuaternion.setFromRotationMatrix(_basis);

  if (WRIST_QUAD_ROLL_DEG !== 0) {
    _rollQuaternion.setFromAxisAngle(hf.palmNormal, THREE.MathUtils.degToRad(WRIST_QUAD_ROLL_DEG));
    _targetQuaternion.premultiply(_rollQuaternion);
  }

  if (WRIST_QUAD_FACE_HEAD_BLEND > 0) {
    // Same quad, but with its normal aimed at the head and its up still rolled along the
    // forearm, blended in by the tunable weight.
    _quadRight.crossVectors(hf.distal, hf.toHead);
    if (_quadRight.lengthSq() > 1e-8) {
      _quadRight.normalize();
      _quadUp.crossVectors(hf.toHead, _quadRight).normalize();
      _basis.makeBasis(_quadRight, _quadUp, hf.toHead);
      _headFacingQuaternion.setFromRotationMatrix(_basis);
      _targetQuaternion.slerp(_headFacingQuaternion, WRIST_QUAD_FACE_HEAD_BLEND);
    }
  }
}

// What this arm's panel hangs on. A hand of any kind wins; a CONTROLLER is the
// fallback (hand tracking is off by default on a Quest 2, and the system panel is
// the only route to Capture). Meta's multimodal mode reports a hand AND a
// controller on the same arm, hence the full scan rather than a first match.
function handSourceFor(session, handedness) {
  let controller = null;
  // Pico Browser nulls inputSources while the session ends.
  for (const source of session.inputSources || []) {
    if (source.handedness !== handedness) {
      continue;
    }
    if (isHandLikeSource(source)) {
      return source;
    }
    if (!controller && (source.gripSpace || source.targetRaySpace)) {
      controller = source;
    }
  }
  return controller;
}

// Visibility + activation

function setPanelVisible(panel, visible) {
  if (visible && !panel.visible) {
    // A panel that appears under a finger must not read that finger as a press: it
    // starts latched, so the first activation needs a real retreat first. The draw key
    // is cleared too, to force one fresh render.
    panel.poke = createWristPokeState(true);
    panel.hold = createWristHoldState();
    panel.rayHold = createRayHoldState();
    panel.lastDrawKey = "";
  }
  panel.visible = visible;
  if (!visible) {
    // A ray reading taken while the panel was up must not survive it; the two
    // updatePanel() early-returns above the per-frame clear both land here.
    clearRayFrameInputs(panel);
    // Nothing on screen, nothing pinned, and the freeze machine returns to its start
    // state, re-arm included. This is also the session-end / non-XR path
    // (hideAllPanels -> hidePanelFor -> here), so a freeze never outlives the surface
    // it was freezing.
    panel.freeze = createWristFreezeState();
    panel.approachFrozen = false;
    if (panel.hold.elapsedS > 0 || panel.rayHold.elapsedS > 0) {
      // A panel that vanishes mid-hold takes its progress ring with it: the control the
      // ring belongs to is no longer on screen to be held.
      releaseExitRing();
    }
    panel.hold = createWristHoldState();
    panel.rayHold = createRayHoldState();
  }
  if (panel.quad) {
    panel.quad.visible = visible;
  }
  if (!visible && panel.cursor) {
    // The cursor exists to aim at a panel; with nothing to aim at it is just a dot
    // following the user's hand around the tunnel.
    panel.cursor.visible = false;
  }
}

// Full reset for one panel, used whenever there is nothing to anchor it against.
// Guarded so the flat-mode path does not churn state objects.
function hidePanelFor(panel) {
  setPanelVisible(panel, false);
  if (panel.summon.visible || panel.summon.satisfiedSinceMs !== null || panel.summon.lostSinceMs !== null) {
    panel.summon = createWristSummonState();
  }
  if (panel.expand.visible || panel.expand.satisfiedSinceMs !== null || panel.expand.lostSinceMs !== null) {
    panel.expand = createWristSummonState();
  }
  panel.anchorInitialized = false;
}

function hideAllPanels() {
  hidePanelFor(PANELS.left);
  hidePanelFor(PANELS.right);
  releaseExitRing();
}

function releaseExitRing() {
  if (!exitRingOwned) {
    return;
  }
  exitRingOwned = false;
  hideExitHoldIndicator();
}

// True while the world panel is open showing its MAIN content (bookmarks/mode grid)
// rather than the help or idle view. Composed from vrpanel's three read-only
// accessors rather than a new export: panelMode stays private to vrpanel.js, and
// "visible but neither help nor idle" is the only remaining case. Drives both the
// close-vs-switch choice and the "open" draw treatment.
function mainPanelOpen() {
  return isPanelVisible() && !isHelpVisible() && !isIdlePanelVisible();
}

// Poke instrumentation. The Quest console is not readable mid-session (see
// xr-diag.js), so what we want to know travels to the workstation by itself, and
// arrives complete enough to answer follow-up questions.
//
// ONE event per activation, never per frame: the diagnostics stream is
// change-based, and a per-frame poke event would bury the session. Disabled rows
// log too: a GenAI row gated off by a missing relay endpoint is indistinguishable
// from a broken promote until the `enabled` field is visible.
//
// The panel-state context is captured BEFORE the action runs, because it is what
// the close/switch/promote decision read; `after` is sampled once the action has
// run, which says whether the world panel obeyed.
//
// `outcome` names every branch of activateTarget(), including the do-nothings:
// "promote"/"switch"/"close" (content), "capture", "help", and
// "no-item"/"disabled"/"hold-row"/"unhandled". "capture" in the log with no file on
// disk points at the /api/screenshot round trip; no line at all points at the poke.
// A repoke on the showing section should log `outcome:"close"` with
// `sectionActive:true` and an `after` block where `panelVisible` is false.
function logWristPoke(panel, index, item, role, context, outcome) {
  logXrEvent({
    event: "wristpoke",
    wrist: panel.handedness,
    panel: role,
    index,
    itemId: item ? item.id : null,
    enabled: item ? Boolean(item.enabled) : false,
    sectionActive: item ? Boolean(item.active) : false,
    holdRow: item ? Boolean(item.hold) : false,
    outcome,
    labelMode: panel.labelMode,
    // What the decision saw.
    mainPanelOpen: context.mainPanelOpen,
    helpOpen: context.helpOpen,
    idlePanelVisible: context.idlePanelVisible,
    // What the world panel did about it. `activeMode` and `startFavorites` identify the
    // case where a poke promoted correctly but the panel drew the start-favourites
    // shortcut over the mode it had just switched to. `startFavorites: true` after a
    // content poke is a bug.
    after: {
      panelVisible: isPanelVisible(),
      mainPanelOpen: mainPanelOpen(),
      helpOpen: isHelpVisible(),
      idlePanelVisible: isIdlePanelVisible(),
      activeMode: activeVrPanelMode(),
      startFavorites: isStartFavoritesShowing()
    }
  });
}

// Every activation routes into an entry point that already exists elsewhere;
// nothing here duplicates what the world panel does.
function activateTarget(panel, index, items) {
  const item = items[index];
  const role = panelRole(panel.handedness);
  const context = {
    mainPanelOpen: mainPanelOpen(),
    helpOpen: isHelpVisible(),
    idlePanelVisible: isIdlePanelVisible()
  };
  // ONE pure decision (wrist-poke.js), then one dispatch. The outcome string that
  // chooses the branch is the one the `wristpoke` diagnostic reports, so a device log
  // cannot describe a decision the code did not make.
  const outcome = resolveWristPokeOutcome(item, {
    role,
    mainPanelOpen: context.mainPanelOpen,
    // The help row is a TOGGLE, so the decision needs the same fact the cross on that
    // row is drawn from.
    helpOpen: context.helpOpen
  });

  switch (outcome) {
    case "close":
      // Repoking the row the panel is already showing CLOSES it (see
      // resolveSectionPoke()); this is the only reason the close glyph is honest.
      //
      // hidePanel(), not togglePanel(): the decision has established that the main panel
      // is open on this mode, so toggle's help/idle special-cases could only get it
      // wrong.
      //
      // "Unselect the selected item" is a DRAWING consequence, not a state change: the
      // cross and the open fill are drawn from `item.active && ctxState.mainOpen`, so
      // hiding the panel leaves no row showing either. vrpanel's activeModeId is
      // deliberately NOT cleared: it is also the panel's own mode-tab selection and its
      // loading / bookmark context. (hidePanel() does clear `modeChosenExplicitly`, which
      // should reset: reopening with nothing loaded gives the start favourites again, as
      // a left-Y close does.)
      hidePanel();
      break;
    case "promote":
    case "switch":
      // A content poke on a section that is NOT the one showing always SHOWS that
      // section. What is left to decide is whether the world panel needs opening and
      // anchoring ("promote") or is already in front of the user and just needs its mode
      // changed ("switch"), which must not re-anchor it.
      //
      // showPanelForMode() -> setActiveMode() also marks the mode as explicitly chosen,
      // which makes the panel draw THAT MODE'S BOOKMARKS instead of the start-favourites
      // list shown before anything has been typed; without it a promote looks like it did
      // nothing.
      showPanelForMode(item.id, { reanchor: outcome !== "switch" });
      break;
    case "capture":
      // screenshot.js is the one capture path; this row, the toolbar cell and controller
      // left Y all call it when the capture token is set. Fire-and-forget:
      // saveScreenshotWithStatus() reports success and failure through setStatus() itself
      // and never rejects. No countdown; capture-hide.js keeps the hands out of the
      // frame.
      void saveScreenshotWithStatus();
      break;
    case "help":
      showHelpPanel();
      break;
    case "help-close":
      // The row toggles. The row draws a cross while help is open, from the same fact
      // this branch is chosen by, so ignoring the poke would be the confusing behaviour.
      //
      // hideHelpPanel(), not togglePanel(): the decision has established that help is
      // what is showing, as the content rows' "close" branch calls hidePanel(). The
      // physical left-X / right-A binding still toggles.
      hideHelpPanel();
      break;
    default:
      // "no-item", "disabled" (a gated-off row is drawn greyed and does nothing when
      // poked, like the panel's disabled mode tab), "hold-row" (updateSystemHold() owns
      // Exit VR; this guard makes "Exit VR is never a single poke" true) and "unhandled"
      // (a row added to WRIST_SYSTEM_ROW_IDS with no branch here) all deliberately do
      // nothing. They are still LOGGED individually, because on device they are four
      // different bugs.
      break;
  }

  logWristPoke(panel, index, item, role, context, outcome);
}

// Exit VR, the one hold-to-activate control on either panel. Reuses the controller
// path's contract exactly (XR_EXIT_HOLD_SECONDS, the same head-locked progress ring
// from vrpanel), so both input types end a session the same way.
//
// vrpanel's flashExitHoldHint() is deliberately NOT used for an aborted wrist hold:
// it renders the literal text "Hold B", the wrong instruction for a fingertip, and
// works by leaving the overlay up on an 850 ms timer that input.js's per-frame
// hideExitHoldIndicator() (earlier in the frame whenever B is not pressed) would
// clear on the next frame. The abort cue lives on the wrist row instead: the ring
// around the Exit icon winds back to zero, right where the finger is.
//
// Two routes, one contract. The ray path exists because a ray activation is a
// one-shot EDGE, and an edge can never complete a hold, so a controller-only
// visitor had no way out but the B-button. The ray gets the world panel's hold
// machine (updateRayHoldState), timed off the trigger LEVEL the pump hands to
// hover(). They stay two machines because their cancel rules differ (a fingertip
// must tolerate 30 Hz jitter and tracking dropouts, a trigger need not), but they
// share the duration, ring and fire.
function updateSystemHold(panel, hit, dtS) {
  // Only the system panel may touch the shared exit ring. Without the early return
  // the content panel would call releaseExitRing() every frame it ran, and with the
  // mirror setting flipped it runs AFTER the system panel and would blank the ring a
  // user was two-thirds of the way through.
  if (holdRowIndexFor(panel) < 0) {
    if (panel.hold.elapsedS !== 0 || panel.hold.fired) {
      panel.hold = createWristHoldState();
    }
    if (panel.rayHold.elapsedS !== 0 || panel.rayHold.fired) {
      panel.rayHold = createRayHoldState();
    }
    return;
  }
  const prev = panel.hold;
  const next = updateWristHoldState(prev, {
    tracked: hit.tracked,
    index: hit.index,
    approachM: hit.approachM,
    holdIndex: SYSTEM_EXIT_INDEX,
    contactRadiusM: WRIST_POKE_ACTIVATE_M,
    releaseRadiusM: WRIST_HOLD_RELEASE_M,
    dtS,
    holdSeconds: WRIST_EXIT_HOLD_SECONDS
  });
  panel.hold = next;

  const prevRay = panel.rayHold;
  const nextRay = updateRayHoldState(prevRay, {
    engaged: panel.rayHoldEngaged,
    armed: panel.rayHoldArmed,
    // The PANEL, not the kind of surface: the mirror setting can move Exit between the
    // two wrist panels, so a hold begun on one must never be finished by the other.
    scope: panel.handedness,
    dtS,
    holdSeconds: WRIST_EXIT_HOLD_SECONDS
  });
  panel.rayHold = nextRay;

  // The middle case (not holding but the timer is non-zero) is the jitter band or a
  // tracking dropout: leave the ring as it was, because the user has not let go.
  const progress = Math.max(next.progress, nextRay.progress);
  const holding = (next.holding && !next.fired) || (nextRay.holding && !nextRay.fired);
  if (holding && progress > 0) {
    exitRingOwned = true;
    setExitHoldProgress(progress);
  } else if (
    !next.holding && next.elapsedS === 0
    && !nextRay.holding && nextRay.elapsedS === 0
  ) {
    // Covers the abort too: a hold that was let go of has its timer back at zero, and
    // the ring winding away is the "that one needs a hold" cue.
    releaseExitRing();
  }

  if ((next.fired && !prev.fired) || (nextRay.fired && !prevRay.fired)) {
    releaseExitRing();
    void exitVrSession();
  }
}

// Per-frame driver, called from the render loop next to the other per-frame
// updates. Cheap no-op outside XR.

function readHands(session, frame, referenceSpace, nowMs) {
  const camera = getActiveCamera();
  camera.getWorldPosition(_headPosition);
  camera.getWorldDirection(_headForward);
  _headForward.normalize();

  for (const handedness of HANDS) {
    const hf = HAND_FRAMES[handedness];
    hf.source = handSourceFor(session, handedness);
    hf.controller = Boolean(hf.source) && !isHandLikeSource(hf.source);
    hf.tracked = Boolean(hf.source) && readWristFrame(hf, frame, referenceSpace);
    hf.posed = hf.tracked && readHandHeadDirections(hf);
    // Rising edge only: the timestamp is when tracking was LOST, so it keeps measuring
    // the same dropout across every frame of it.
    hf.untrackedSinceMs = hf.tracked
      ? null
      : (hf.untrackedSinceMs === null ? nowMs : hf.untrackedSinceMs);

    // With joints, the real index tip. Without them, a point projected ahead of the
    // hand's grip centroid: poking then means bringing the whole hand to the panel,
    // coarse but usable, and it keeps one poke/latch path instead of two.
    hf.fingertipTracked = false;
    if (!hf.source || hf.controller) {
      // A controller gets NO synthesised fingertip: it selects by ray, and a phantom tip
      // 75 mm ahead of it would drive freeze-on-approach, swallow the select
      // (isWristLauncherCapturingSelect) and misfire the two-hand zoom (isWristPokeNear)
      // whenever the two controllers came near each other. Poke is a hand thing.
      continue;
    }
    if (hf.source.hand) {
      hf.fingertipTracked = readJointPosition(
        hf.source.hand, frame, referenceSpace, INDEX_TIP_JOINT, hf.fingertip
      );
    }
    if (!hf.fingertipTracked && readGripPose(hf.source, frame, referenceSpace)) {
      hf.fingertip
        .set(0, 0, -1)
        .applyQuaternion(_gripQuaternion)
        .multiplyScalar(GRIP_FINGERTIP_FORWARD_M)
        .add(_gripPosition);
      hf.fingertipTracked = true;
    }
  }
}

function updatePanel(panel, poker, nowMs, dtS, sections, ctxState) {
  const hf = HAND_FRAMES[panel.handedness];

  // No panel on a controller. A wrist panel works because there is an arm for it to
  // lie along; a controller has no such surface, so any offset from it floats in
  // mid-air. controller-callouts.js (glyph marks on the real buttons) replaces it.
  // The hands path below is unaffected, and in Meta's multimodal mode an arm that
  // swaps a controller for a hand gets its panel back on the next frame.
  if (hf.controller) {
    hidePanelFor(panel);
    return;
  }

  // Freeze-on-approach, measured against the panel's CURRENT position rather than the
  // wrist, so the decision cannot chase the thing it is deciding about.
  // `panel.visible` is last frame's value, so a never-placed quad at the origin can
  // never freeze. The rules (and the releases for a stranded panel) are
  // updateWristFreezeState() in wrist-poke.js; this is only the geometry it needs.
  const quadPlaced = Boolean(panel.quad) && panel.anchorInitialized;
  const pokeApproachM = quadPlaced && poker.fingertipTracked
    ? poker.fingertip.distanceTo(panel.quad.position)
    : Infinity;
  // "The poke has arrived": the fingertip is in the hover band, or already pressed,
  // or an Exit VR hold is running. The occlusion release is gated on this (see
  // updateWristFreezeState()). It is the HOVER radius (25 mm), not the freeze's own
  // 100 mm enter radius: the freeze latches while the hand is still travelling, and a
  // target behind a hand is worth re-aiming right up until the finger is on it.
  const pokeCommitted = (pokeApproachM <= WRIST_POKE_HOVER_M)
    || panel.poke.pressed
    || panel.hold.holding;
  const ownerMeasured = quadPlaced && hf.posed;
  const ownerDriftM = ownerMeasured
    ? computePanelCentre(hf, panel.layout, _anchorTarget).distanceTo(panel.quad.position)
    : 0;
  const nextFreeze = updateWristFreezeState(panel.freeze, {
    panelVisible: panel.visible,
    quadPlaced,
    pokerTracked: poker.fingertipTracked,
    approachM: pokeApproachM,
    enterRadiusM: WRIST_FREEZE_ENTER_M,
    releaseRadiusM: WRIST_FREEZE_RELEASE_M,
    ownerPosed: hf.posed,
    ownerDriftM,
    maxAnchorDriftM: WRIST_FREEZE_ANCHOR_MAX_M,
    ownerLostMs: hf.untrackedSinceMs === null ? 0 : nowMs - hf.untrackedSinceMs,
    ownerLostGraceMs: WRIST_FREEZE_HAND_LOST_MS,
    nowMs,
    maxHoldMs: WRIST_FREEZE_MAX_HOLD_MS,
    ownerOccluding: ownerMeasured && isOwnerOccludingPanel(
      _headPosition,
      hf.wrist,
      panel.quad.position,
      {
        minDepthM: WRIST_OCCLUSION_MIN_DEPTH_M,
        maxRadiusM: WRIST_OCCLUSION_MAX_RADIUS_M
      }
    ),
    pokeCommitted
  });
  // One line per ABNORMAL release, never per frame and never for the ordinary
  // retreat: these are the stuck-panel evidence, and a log showing none of them says
  // the strand is elsewhere.
  if (nextFreeze.reason && nextFreeze.reason !== "retreat") {
    logXrEvent({
      event: "wristfreeze",
      wrist: panel.handedness,
      reason: nextFreeze.reason,
      ownerPosed: hf.posed,
      ownerDriftM: ownerMeasured ? Number(ownerDriftM.toFixed(3)) : null,
      ownerLostMs: hf.untrackedSinceMs === null ? 0 : Math.round(nowMs - hf.untrackedSinceMs),
      // The two the OCCLUSION release needs and the others do not: how far the poking
      // finger still was (so `reason:"occluded"` can be read against the pokeCommitted
      // gate) and whether the panel was re-anchored as a result.
      pokerApproachM: Number.isFinite(pokeApproachM)
        ? Number(pokeApproachM.toFixed(3))
        : null,
      reanchored: nextFreeze.reason === "occluded",
      labelMode: panel.labelMode
    });
  }
  panel.freeze = nextFreeze;
  panel.approachFrozen = nextFreeze.frozen;
  // Mirrored for isWristPokeNear(): the ZOOM gesture needs to know a poke is
  // happening, from the geometry rather than from the freeze latch, which is later
  // and stickier. Written here because this is where the measurement already is.
  panel.pokeApproachM = pokeApproachM;
  panel.pokeCommitted = pokeCommitted;
  if (nextFreeze.reason === "occluded") {
    // RE-ANCHOR, not merely release: simply unfreezing would leave the panel crawling
    // back to the wrist at WRIST_POSITION_LERP (0.25/frame, ~0.15 s) from behind the
    // hand covering it. Clearing `anchorInitialized` routes the pose write below
    // through its SNAP branch, the same path a fresh summon takes. The freeze cannot
    // immediately re-latch and strand it again: an abnormal release sets
    // `rearmRequired`, so the poking finger has to leave the release radius first.
    panel.anchorInitialized = false;
  }

  const tier = summonTierFor(hf, panel);
  const tracked = hf.tracked || panel.approachFrozen;

  panel.summon = updateWristSummonState(panel.summon, {
    // A frozen panel survives a dropout of the hand underneath it (poking your own wrist
    // is the most self-occluding pose hand tracking has) and survives losing the summon
    // pose, which poking itself breaks (the head looks at the finger, the forearm
    // rolls). It cannot cause a spurious show: freezing requires an already-visible
    // panel.
    tracked,
    conditionMet: panel.approachFrozen || WRIST_LAUNCHER_FORCE_SUMMON || tier.inView,
    nowMs,
    showDelayMs: WRIST_SUMMON_SHOW_DELAY_MS,
    hideDelayMs: WRIST_SUMMON_HIDE_DELAY_MS
  });

  // Tier 2 runs every frame, including while frozen, but its answer is ignored for as
  // long as the freeze lasts (resolveWristLabelMode() pins the mode); it is kept warm
  // for when the finger backs off.
  panel.expand = updateWristSummonState(panel.expand, {
    tracked,
    conditionMet: tier.focused,
    nowMs,
    showDelayMs: WRIST_EXPAND_SHOW_DELAY_MS,
    hideDelayMs: WRIST_EXPAND_HIDE_DELAY_MS
  });

  if (!panel.summon.visible || (!hf.posed && !panel.approachFrozen)) {
    setPanelVisible(panel, false);
    if (!hf.tracked) {
      panel.anchorInitialized = false;
    }
    return;
  }

  // Tier 2: gaze-to-expand. Icons are the resting state, so the panel can be ignored
  // while navigating the sphere; looking at the wrist asks for the words. The freeze
  // term inside resolveWristLabelMode() pins the tier while a poke is underway, so
  // the panel cannot collapse to icons under a finger already travelling toward a row
  // (looking down at your own finger drops the gaze cone). `?wristlabels=1` pins
  // labels on, to A/B the whole rule.
  const labelMode = resolveWristLabelMode(panel.labelMode, {
    pinned: WRIST_LABELS_PINNED,
    gazeFocused: panel.expand.visible,
    frozen: panel.approachFrozen,
    // Collapse to icons while looking at the world menu: one measurement for both
    // panels, taken once per frame in updateWristLauncher. It loses to the freeze above
    // it; see resolveWristLabelMode.
    worldMenuGaze: ctxState.worldMenuGaze
  });
  panel.labelMode = labelMode;

  // Built on first use, so a session that never summons a panel allocates no canvas.
  const quad = ensurePanelQuad(panel);
  applyLayout(panel, LAYOUTS[labelMode]);
  setPanelVisible(panel, true);

  if (hf.posed && !panel.approachFrozen) {
    computeTargetPose(hf, panel.layout);
    if (!panel.anchorInitialized) {
      // First frame of a summon: snap, so the panel does not fly in from wherever the
      // hand was last seen.
      quad.position.copy(_targetPosition);
      quad.quaternion.copy(_targetQuaternion);
      panel.anchorInitialized = true;
    } else {
      quad.position.lerp(_targetPosition, WRIST_POSITION_LERP);
      quad.quaternion.slerp(_targetQuaternion, WRIST_ORIENTATION_SLERP);
    }
  }
  // The quad was just moved and worldToLocal is about to be used on it; the
  // scene-wide update does not happen until render.
  quad.updateMatrixWorld();

  const hit = { tracked: poker.fingertipTracked, index: -1, approachM: Infinity };
  if (poker.fingertipTracked) {
    _fingertipLocal.copy(poker.fingertip);
    quad.worldToLocal(_fingertipLocal);
    const nearest = nearestPokeTarget(_fingertipLocal, panel.layout.localRects);
    hit.index = nearest.index;
    hit.approachM = nearest.approachM;
  }
  panel.poke = updateWristPokeState(panel.poke, {
    tracked: hit.tracked,
    index: hit.index,
    approachM: hit.approachM,
    hoverRadiusM: WRIST_POKE_HOVER_M,
    activateRadiusM: WRIST_POKE_ACTIVATE_M,
    releaseRadiusM: WRIST_POKE_RELEASE_M
  });
  setPokeCursor(
    panel,
    poker.fingertip,
    poker.fingertipTracked,
    panel.poke.hoverIndex >= 0,
    panel.poke.pressed
  );

  updateSystemHold(panel, hit, dtS);

  const items = panelItems(panel, sections);
  // Draw before activating: the pressed highlight lands on the same frame as the
  // press. An activation does not hide this quad (a mode switch, a close-repoke and a
  // promote all leave the wrist panel up).
  drawPanelIfChanged(panel, items, ctxState);
  if (panel.poke.activatedIndex >= 0) {
    activateTarget(panel, panel.poke.activatedIndex, items);
  } else if (panel.rayActivateIndex >= 0) {
    // The ray takes the same dispatch, one branch later: a poke already on the row is
    // the nearer act and must not fire twice.
    activateTarget(panel, panel.rayActivateIndex, items);
  }
  // All four are single-frame values written by vrpanel's ray pump earlier this frame;
  // clearing them here makes a ray that has moved away stop hovering and drop its
  // hold, with no second place to get the release wrong.
  clearRayFrameInputs(panel);
}

function clearRayFrameInputs(panel) {
  panel.rayHoverIndex = -1;
  panel.rayActivateIndex = -1;
  for (let slot = 0; slot < panel.rayHoldEngaged.length; slot += 1) {
    panel.rayHoldEngaged[slot] = false;
    panel.rayHoldArmed[slot] = false;
  }
}

function updateWristLauncher() {
  const nowMs = performance.now();
  // Clamped so a backgrounded tab (or the first frame after entry) cannot advance a
  // 1.5 s exit hold by a whole second in one step.
  const dtS = lastFrameMs === 0 ? 0 : Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000));
  lastFrameMs = nowMs;

  if (!WRIST_LAUNCHER_ENABLED) {
    return;
  }
  if (!renderer.xr.isPresenting) {
    hideAllPanels();
    return;
  }
  const session = renderer.xr.getSession();
  const frame = renderer.xr.getFrame();
  const referenceSpace = renderer.xr.getReferenceSpace();
  if (!session || !frame || !referenceSpace) {
    hideAllPanels();
    return;
  }
  // No isPanelVisible() gate here, and no state.appState gate either. The panels must
  // be reachable in EVERY app state: tunnel, the transitions, inside the sphere, and
  // while content is still loading. The content panel is the hands equivalent of the
  // controller's menu toggle, so it must be summonable over the main, help and idle
  // panels alike, or a hands-only user who promoted into the world panel could not
  // close it. activateTarget() keeps the two surfaces coherent once both can be up
  // (close-on-repoke / switch-in-place). Do not add a gate here.

  // Controllers reach this too: handSourceFor() falls back to a controller source.
  // A session with neither still holds both summon machines hidden.
  readHands(session, frame, referenceSpace, nowMs);

  const sections = launcherSections();
  const ctxState = {
    mainOpen: mainPanelOpen(),
    helpOpen: isHelpVisible(),
    // Once per frame, for both panels: is the user reading the world menu?
    worldMenuGaze: readWorldMenuGaze()
  };

  // Each panel is poked by the hand on the OTHER arm, always. Nothing reads its own
  // hand for selection, so a panel can never be activated by the wrist it is strapped
  // to.
  updatePanel(PANELS.left, HAND_FRAMES.right, nowMs, dtS, sections, ctxState);
  updatePanel(PANELS.right, HAND_FRAMES.left, nowMs, dtS, sections, ctxState);
}

// True while a poke is in progress on EITHER wrist: that panel is up and the hand
// poking it is inside the approach radius. input.js swallows the hand-pinch
// sphere-select for exactly this window, mirroring the trigger-swallow an open
// world panel does, so a stray pinch while poking a wrist cannot also navigate the
// sphere. A wrist panel and the world panel can be visible at once, and this flag
// reaches the panel path too: the hand tree resolves the pinch to a select before
// either branch sees it, so suppressing it there swallows a stray panel-ray
// activation as well. (The panel ray takes a per-hand edge, but the hand pinch's
// edge is the one this suppression removes.)
function isWristLauncherCapturingSelect() {
  return (PANELS.left.visible && PANELS.left.approachFrozen)
    || (PANELS.right.visible && PANELS.right.approachFrozen);
}

// A poke is happening, told from the geometry. One hand travelling to the other
// wrist brings the pair to 0.074-0.136 m, which to the distance gesture (it only
// looks at the gap between the hands) is a converging zoom-out stroke performed
// with conviction; this lets it hold off.
//
// Not the same question as isWristLauncherCapturingSelect(), though the two
// overlap: that one is the freeze LATCH, which arrives after the approach and
// survives things the approach does not (the occlusion re-anchor clears `frozen`
// mid-poke, and a panel whose quad was never placed can never freeze at all). This
// is the union of every reading that says a fingertip is on or arriving at a
// visible panel, and introduces no new radius: the hover band and the freeze's
// enter radius are the two the poke path already uses.
function isWristPokeNear() {
  for (const panel of [PANELS.left, PANELS.right]) {
    if (!panel.visible) {
      continue;
    }
    if (panel.approachFrozen || panel.pokeCommitted) {
      return true;
    }
    if (panel.pokeApproachM <= WRIST_FREEZE_ENTER_M) {
      return true;
    }
  }
  return false;
}

// Screen capture: both quads and both poke cursors leave the frame for the offscreen
// render. Capture is fired WITH a wrist panel up and either a fingertip on it or a
// ray at it, so these are guaranteed to be in shot. Either can be null: both are
// built lazily, and the poke cursor is never built in a controller-only session.
// Registered here rather than imported by screenshot.js because this module imports
// screenshot.js, and that would be a cycle.
function wristCaptureHideables() {
  const objects = [];
  for (const panel of [PANELS.left, PANELS.right]) {
    objects.push(panel.quad, panel.cursor);
  }
  return objects;
}

registerCaptureHideables(wristCaptureHideables);

export {
  setWristPanelHand,
  wristPanelHand,
  freeHand,
  updateWristLauncher,
  isWristLauncherCapturingSelect,
  isWristPokeNear,
  normalizeWristPanelHand,
  DEFAULT_WRIST_PANEL_HAND
};
