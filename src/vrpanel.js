// In-world VR panel: a single CanvasTexture quad anchored in front of the viewer,
// rendering a status line, a bookmark grid (from bookmarks.js) and text-entry
// launchers. Deliberately not a general menu system: one canvas, a flat rect list,
// ray/mouse hit-testing, and the existing load code paths. History back lives on
// the left stick press and panel open/close on left Y, not on panel rows.
//
// Anchoring: the quad is parented to `scene` (NOT `worldGroup`), so the world-moves
// locomotion in updateWorldTransform() scrolls the content past it without dragging
// the panel along. On open it is placed in front of the camera's current yaw and
// left put (head-locked panels induce nausea).
//
// Interaction reuses input.js's XR input path and the bookmark load functions
// (loadAndExtractUrl / loadImageSearch / loadGenAiPrompt).

import * as THREE from "three";
import { DEFAULT_BOOKMARKS, BookmarkKind, bookmarkTitle, startFavoriteBookmarks } from "./bookmarks.js";
import { canGoBack, goBack, loadAndExtractUrl, loadGenAiPrompt, loadImageSearch } from "./api.js";
import { urlInput } from "./dom.js";
import { menuStatusText } from "./tunnel-progress.js";
import { t, getLanguage } from "./i18n.js";
import { renderer, scene, camera } from "./scene.js";
import { state } from "./state.js";
import { AppState } from "./constants.js";
import { getActiveCamera } from "./sphere.js";
import {
  setAddressFeedback,
  focusSceneCanvas,
  isStatusFooterEnabled,
  setStatusFooterEnabled,
  exitVrSession
} from "./ui.js";
import {
  isVoiceSupported,
  startVoiceDictation,
  isServerSttEnabled,
  startServerStt,
  mediaRecordingSupported
} from "./voice.js";
import { drawKeyboard, applyKeyAction } from "./vrkeyboard.js";
import {
  selectRaySlotSources,
  fillSlotRayTargets,
  slotSelectEdge,
  slotSelectHeld,
  createRayHoldState,
  updateRayHoldState,
  rayHoldAborted,
  pickPointerSlot
} from "./xr-ray-sources.js";
import { resolveXrInputAffordances } from "./xr-input-mode.js";
// resolveFreeHand(), not wristui.js's freeHand(): same answer from the same setting,
// but wristui.js imports this module, so using its wrapper would close an import cycle.
import { resolveFreeHand } from "./wrist-poke.js";
import { drawControllerMapCanvas } from "./controllermap.js";
import { registerCaptureHideables } from "./capture-hide.js";
import { drawIcon, iconHalfWidth } from "./ui-icons.js";
import { isPassthroughOn, passthroughAvailable, togglePassthrough } from "./passthrough.js";

// Tunables (size, distance, colors, grid layout)

// World placement of the quad (meters). The panel is anchored in front of the
// viewer at open time, offset down slightly so it does not block the horizon.
const PANEL_DISTANCE = 2.4;
const PANEL_HEIGHT_OFFSET = -0.35;
const PANEL_ANCHOR_STABILIZE_MS = 750;
// Physical size of the quad in world meters (width, height).
const PANEL_WIDTH_M = 1.6;
const PANEL_HEIGHT_M = 1.2;

// Canvas backing-store resolution (pixels). Aspect matches the quad.
const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 768;

// Help is deliberately a separate, larger surface. The controller map needs
// room for direct callouts, and enlarging the backing store by the same factor
// keeps its text sharp instead of magnifying the menu texture.
const HELP_PANEL_SCALE = 1.5;
const HELP_PANEL_WIDTH_M = PANEL_WIDTH_M * HELP_PANEL_SCALE;
const HELP_PANEL_HEIGHT_M = PANEL_HEIGHT_M * HELP_PANEL_SCALE;
const HELP_CANVAS_WIDTH = Math.round(CANVAS_WIDTH * HELP_PANEL_SCALE);
const HELP_CANVAS_HEIGHT = Math.round(CANVAS_HEIGHT * HELP_PANEL_SCALE);

// Colors (canvas 2D CSS strings — this surface never sees Three color-space).
const COLOR_BG = "#101727ee";
const COLOR_BORDER = "#23314a";
const COLOR_TEXT = "#dbe6ff";
const COLOR_MUTED = "#8ea1c2";
const COLOR_STATUS_BAR = "#0b1220";
const COLOR_CELL = "#182238";
const COLOR_CELL_HOVER = "#22406e";
const COLOR_CELL_BORDER = "#2c3d5c";
// ~45% of the mode colour.
const BOOKMARK_OUTLINE_ALPHA_HEX = "73";
const COLOR_MODE_WEB = "#53a9ff";
const COLOR_MODE_SEARCH = "#64e29b";
const COLOR_MODE_GENAI = "#c98bff";
const COLOR_BACK = "#1c2a44";
const COLOR_BACK_HOVER = "#2b4370";
// Mode-selector cells: inactive vs. active (active borrows the mode's accent).
const COLOR_MODE_CELL = "#141d30";
const COLOR_MODE_CELL_HOVER = "#1d2b46";
const COLOR_MODE_CELL_ACTIVE = "#28406e";
// Disabled cell treatment (mirrors the flat GenAI button: greyed + dim text).
const COLOR_CELL_DISABLED = "#141a26";
const COLOR_TEXT_DISABLED = "#546079";
// Mic (voice) cell.
const COLOR_MIC = "#243657";
const COLOR_MIC_HOVER = "#325082";
const COLOR_MIC_LISTENING = "#8a3b52";
const COLOR_CONFIRM = "#245b44";
const COLOR_CONFIRM_HOVER = "#2f7a5b";
const COLOR_CANCEL = "#553247";
const COLOR_CANCEL_HOVER = "#74445f";
// Keyboard-launcher cell.
const COLOR_KBD = "#243657";
const COLOR_KBD_HOVER = "#325082";
const COLOR_KBD_ACTIVE = "#28406e";
const COLOR_STATUS_TOGGLE = "#1f3542";
const COLOR_STATUS_TOGGLE_HOVER = "#2a5062";
const COLOR_EXIT = "#593247";
const COLOR_EXIT_ARC = "#ff8a9a";
const COLOR_EXIT_TRACK = "#2d1720";

// Layout (canvas pixels).
const PAD = 28;
const STATUS_BAR_H = 64;
const MODE_BAR_H = 84;
const MODE_BAR_GAP = 20;
const MODE_COLS = 3;
const BACK_BAR_H = 96;
// Menu toolbar: Passthrough, Type, Status, then Exit VR at the right end. Each
// cell is icon + label; Passthrough is widest because its label is longest.
const KBD_CELL_W = 160;
// Gap between a help row's key text and the icon that follows it.
const HELP_ICON_GAP_PX = 14;
const STATUS_TOGGLE_CELL_W = 190;
// Shown ONLY in a session that can actually composite the room (passthrough.js);
// a plain immersive-vr session gets no control for something it cannot do.
const PASSTHROUGH_CELL_W = 250;
const TOOLBAR_ICON_PX = 40;
const BOTTOM_GAP = 18;
const GRID_COLS = 3;
const CELL_GAP = 18;
// The top row's corner buttons: history back on the left, close (×) on the
// right. Left stick press and left Y do the same, but nothing on the panel said
// so. The status bar, or the mode row when there is none, sits between them.
const CLOSE_BTN_SIZE = 52;
const TOP_ROW_INSET = CLOSE_BTN_SIZE + CELL_GAP;

// Idle start panel (VR): the world-anchored equivalent of the desktop start panel.
// It shows the three favorite tiles (reusing drawStartFavoritesRegion) plus three
// labeled buttons whose glyphs mirror the controller buttons: X opens the full menu
// ("More…"), A Help, B exits VR (hold). Shown only while idle in the tunnel with no
// other panel open.
//
// It shares the menu's quad and canvas: applyPanelCrop() shows only the top
// IDLE_CANVAS_HEIGHT rows and scales the mesh to match, so the ray's UV maps onto
// that height, not 768.
const IDLE_BTN_H = BACK_BAR_H;
const IDLE_GLYPH_RADIUS = 30;
const IDLE_BTN_GAP = 18;
const IDLE_TILE_H = 220;
const IDLE_TILES_TOP = PAD;
const IDLE_TILES_BOTTOM = IDLE_TILES_TOP + 54 + IDLE_TILE_H;
const IDLE_BTN_Y = IDLE_TILES_BOTTOM + 24;
const IDLE_CANVAS_HEIGHT = IDLE_BTN_Y + IDLE_BTN_H + PAD;
const IDLE_PANEL_HEIGHT_M = PANEL_HEIGHT_M * (IDLE_CANVAS_HEIGHT / CANVAS_HEIGHT);
const COLOR_IDLE_BTN = "#182238";
const COLOR_IDLE_BTN_HOVER = "#22406e";
const COLOR_IDLE_GLYPH = "#dbe6ff";
// Exit VR from the launcher row is hold-to-activate, never a click. 1.5 s is
// input.js's XR_EXIT_HOLD_SECONDS and wristui.js's WRIST_EXIT_HOLD_SECONDS; all
// three must agree so "hold to exit" means the same on every control.
const PANEL_EXIT_HOLD_SECONDS = 1.5;
// How long the aborted-hold hint stays on the button. Matches the dwell
// flashExitHoldHint() gives the B-button tap.
const PANEL_EXIT_HINT_MS = 850;
// Quantisation of the button's progress ring, so a 1.5 s hold costs ~24
// repaints rather than one per frame — the same trade the confirm arc makes.
const PANEL_EXIT_PROGRESS_STEPS = 24;
const IDLE_EXIT_RING_RADIUS = IDLE_GLYPH_RADIUS + 9;
const IDLE_EXIT_RING_WIDTH = 6;
// The menu toolbar's Exit cell, sized to hold the glyph plus "Hold to exit" at the
// toolbar's smaller label size.
const EXIT_CELL_W = 256;

// Ray/pointer hit marker size (canvas pixels), drawn where the ray crosses.
const CURSOR_RADIUS = 14;

// Transcript confirmation tunables.
// Auto-confirm delay; the OK arc fills over exactly this window.
const CONFIRM_AUTO_MS = 3000;
// OK button geometry (canvas pixels): a circular button whose ring fills.
const CONFIRM_OK_RADIUS = 96;
const CONFIRM_ARC_WIDTH = 14;
const COLOR_CONFIRM_ARC = "#64e29b";
const COLOR_CONFIRM_ARC_TRACK = "#1b2b22";
// Cancel + re-record pill dimensions.
const CONFIRM_BTN_W = 260;
const CONFIRM_BTN_H = 84;

// Hold-to-exit overlay. Separate from the menu panel so it can appear even when no
// panel is open.
const EXIT_CANVAS_SIZE = 384;
const EXIT_OVERLAY_WIDTH_M = 0.55;
const EXIT_OVERLAY_HEIGHT_M = 0.55;
const EXIT_OVERLAY_DISTANCE = 1.7;
const EXIT_OK_RADIUS = 118;
const EXIT_ARC_WIDTH = 18;

// Controller ray visualization.
const RAY_LENGTH_M = 3.0;
const RAY_COLOR = 0x70d7ff;
const RAY_HIT_COLOR = 0xffffff;
const RAY_OPACITY = 0.78;
const RAY_DOT_RADIUS_M = 0.018;

// Active-mode → BookmarkKind the preset grid filters to, plus its accent color.
// `label` is a getter so it follows the active language at draw time.
const MODES = Object.freeze([
  { id: "web", get label() { return t("vr.mode.web"); }, kind: BookmarkKind.WEB_PAGE, color: COLOR_MODE_WEB, requiresGenAi: false },
  { id: "image", get label() { return t("vr.mode.image"); }, kind: BookmarkKind.IMAGE_SEARCH, color: COLOR_MODE_SEARCH, requiresGenAi: false },
  { id: "genai", get label() { return t("vr.mode.genai"); }, kind: BookmarkKind.GENAI_PROMPT, color: COLOR_MODE_GENAI, requiresGenAi: true }
]);
const DEFAULT_MODE_ID = "web";

// Help panel: the in-headset cheat sheet. Every list is filtered by
// resolveXrInputAffordances() (granted features plus what is live in frame, no
// headset-model sniffing); an unknown answer lists everything.
// Rows hold i18n keys, resolved by helpRows() at draw time:
// [key, description, icon?, inlineIcon?].
const HELP_LINES_SHARED = Object.freeze([
  ["key.thumbstick", "vrhelp.thumbstickDesc"]
]);
// Basic is the five things you do, plus the one line that says where to find
// everything else; nothing here repeats in Advanced.
// A row may carry a third element: an icon from ui-icons.js drawn right after the
// key, pairing a letter ("Left X") with the icon physically on that button. Only
// the four lettered buttons need it.
const HELP_LINES_CONTROLLERS = Object.freeze([
  ["vrhelp.trigger", "act.select"],
  ["vrhelp.leftX", "act.menuPanel", "menu"],
  ["vrhelp.rightA", "nav.help", "question"],
  ["vrhelp.rightB", "vrhelp.holdExitVr", "exit"],
  ["vrhelp.lookController", "vrhelp.expandedLabels"]
]);
const HELP_LINES_HANDS = Object.freeze([
  ["vrhelp.pinch", "act.select"],
  ["vrhelp.raiseWrist", "vrhelp.raiseWristDesc"]
]);
// Advanced adds, it never repeats.
//
// The panel exit route is not listed: the cells that carry it say "Exit VR" on
// themselves, next to a B-in-a-circle. The route itself is updateExitHold().
const HELP_ADVANCED_CONTROLLERS = Object.freeze([
  ["vrhelp.rightStickClick", "vrhelp.jumpSphereTunnel"],
  ["vrhelp.leftStickClick", "vrhelp.historyBack"],
  ["key.rightGrip", "vrhelp.pauseRotationSphere"],
  ["key.gripTrigger", "vrhelp.emojiVariationsWeb"],
  ["vrhelp.leftY", "vrhelp.screenshotToken", "camera"]
]);
const HELP_ADVANCED_HANDS = Object.freeze([
  ["vrhelp.handsEyeLevel", "vrhelp.handsEyeLevelDesc"],
  ["vrhelp.leftPinchThenRight", "vrhelp.emojiVariationsHold"],
  // Same chord, second meaning: in the tunnel it is the jump. A separate row because
  // the two never apply at the same time.
  ["vrhelp.leftPinchThenRight", "vrhelp.jumpToSphere"],
  ["vrhelp.wristSystemPanel", "vrhelp.wristSystemDesc"]
]);
const HELP_HAND_GROUPS = Object.freeze([
  {
    title: "vrhelp.group.direct",
    rows: [
      ["vrhelp.rightPinch", "vrhelp.rightPinchDesc"],
      ["vrhelp.leftPinchDrag", "vrhelp.leftPinchDragDesc"],
      ["vrhelp.leftPinchThenRight", "vrhelp.emojiConfirmDesc"],
      ["vrhelp.leftPinchThenRight", "vrhelp.tunnelInsteadDesc"],
      ["vrhelp.noPinchBoth", "vrhelp.noPinchBothDesc"],
      ["vrhelp.bothPalms", "vrhelp.bothPalmsDesc"]
    ]
  },
  {
    title: "vrhelp.group.wrist",
    rows: [
      ["vrhelp.lookWrist", "vrhelp.lookWristDesc"],
      // Naming the system rows here is the only in-headset discoverability Capture
      // has on hands; controllers have their own route (left Y, token-gated).
      ["vrhelp.systemWrist", "vrhelp.systemWristDesc"]
    ]
  },
  {
    title: "vrhelp.group.secondary",
    rows: [
      ["vrhelp.thumbGestures", "vrhelp.thumbGesturesDesc"]
    ]
  }
]);

function helpRows(rows) {
  return rows.map(([key, desc, ...rest]) => [t(key), t(desc), ...rest]);
}
// The controller equivalent of the Hands page, so the tab is never a dead end
// for a visitor who has no hands to read about.

// The live answer, re-read whenever the help canvas is drawn.
function helpAffordances() {
  const session = renderer.xr.getSession?.();
  return resolveXrInputAffordances({
    enabledFeatures: session?.enabledFeatures,
    inputSources: session?.inputSources
  });
}

// X, A and B name controller buttons; to a visitor using hands they are noise.
// Shown unless the session is known to have no controllers.
function showButtonLetters() {
  const affordances = helpAffordances();
  return !affordances.known || affordances.controllers;
}

// Placeholder for a row's inline icon. Its measured width stands in for the
// icon's when the description is wrapped.
const HELP_INLINE_ICON = "{icon}";

function helpBasicLines(affordances) {
  const lines = [];
  if (affordances.controllers) {
    lines.push(...helpRows(HELP_LINES_CONTROLLERS));
  }
  if (affordances.hands) {
    lines.push(...helpRows(HELP_LINES_HANDS));
  }
  lines.push(...helpRows(HELP_LINES_SHARED));
  // The toolbar cell is icon-only — the bar has no width for a label — so this
  // is where it gets named. Gated on the session actually being able to show
  // the room, so it is never a row about a cell that is not there.
  // Fourth element: an icon drawn in place of HELP_INLINE_ICON in the text.
  if (passthroughAvailable()) {
    lines.push([
      t("vr.tb.passthrough"),
      t(affordances.controllers ? "vrhelp.passthroughControllers" : "vrhelp.passthroughHands"),
      null,
      "menu"
    ]);
  }
  return lines;
}

function helpAdvancedLines(affordances) {
  const lines = [];
  if (affordances.controllers) {
    lines.push(...helpRows(HELP_ADVANCED_CONTROLLERS));
  }
  if (affordances.hands) {
    lines.push(...helpRows(HELP_ADVANCED_HANDS));
  }
  return lines;
}

// The Hands page shows hand gestures always. It is reached by a button labelled
// "Hands", so the affordance rule that filters the first page must not edit it.
function helpGestureGroups() {
  return HELP_HAND_GROUPS.map((group) => ({ title: t(group.title), rows: helpRows(group.rows) }));
}

// Whether a Hands page is worth offering at all: not "are hands the live
// input" (that is affordances.hands, and it is false whenever controllers are
// up) but "could this visitor use hands". A headset that never granted
// hand-tracking has nothing to show on that page.
function handsPageAvailable(affordances) {
  return !affordances.known || affordances.handTrackingGranted || affordances.handsLive;
}

// Module state

const bookmarkModeColor = {
  [BookmarkKind.WEB_PAGE]: COLOR_MODE_WEB,
  [BookmarkKind.IMAGE_SEARCH]: COLOR_MODE_SEARCH,
  [BookmarkKind.GENAI_PROMPT]: COLOR_MODE_GENAI
};

const bookmarkModeLabelKey = {
  [BookmarkKind.WEB_PAGE]: "vr.mode.web",
  [BookmarkKind.IMAGE_SEARCH]: "vr.chip.search",
  [BookmarkKind.GENAI_PROMPT]: "vr.mode.genai"
};
function bookmarkModeLabel(kind) {
  return t(bookmarkModeLabelKey[kind] || "vr.mode.web");
}

let genAiEnabled = false;

// Active mode drives both the preset-grid filter and the voice load routing.
let activeModeId = DEFAULT_MODE_ID;

// Has the user EXPLICITLY chosen a mode for this panel session (a wrist-panel
// section, or the panel's own mode row)? Before any choice shouldShowStartFavorites()
// is true and the main panel renders the same start-favourites list as the idle
// panel, so picking "Web" would switch modes with no visible change. The idle panel
// must keep showing start favourites, so only an explicit choice overrides it;
// closing the panel or returning to the idle launcher forgets it.
let modeChosenExplicitly = false;

// Voice dictation session state. `voiceSession` is the handle from voice.js
// (null when idle/unsupported); `voiceStatusText` overrides the status line
// while listening / after an error, cleared once a load kicks off.
let voiceSession = null;
let voiceStatusText = null;

// Server STT capability, probed lazily from /api/health. undefined = not
// yet known; the mic cell renders optimistically enabled if EITHER Web Speech
// or Web Audio capture is present, and the actual routing decides at press time.
let serverSttEnabled = false;

// Canvas keyboard (fallback) state. When `keyboardOpen`, the panel draws the
// keyboard over the bookmark grid and composes into `keyboardText`.
let keyboardOpen = false;
let keyboardText = "";
let panelMode = "main";
// Help uses pages rather than squeezing every controller binding into one canvas.
let helpView = "basic";
let helpControllerSide = "left";
let pendingTranscript = null;
let transcriptConfirmTimer = null;
let transcriptConfirmRaf = null;

let panelCanvas = null;
let panelCtx = null;
let panelTexture = null;
let panelMesh = null;
let helpCanvas = null;
let helpCtx = null;
let helpTexture = null;
let helpMesh = null;
let panelVisible = false;
let panelAnchorStabilizeUntil = 0;

let exitCanvas = null;
let exitCtx = null;
let exitTexture = null;
let exitMesh = null;
let exitHoldHideTimer = null;

// Interactive rects in canvas pixel space: { x, y, w, h, action }.
let hitRects = [];
// Canvas-space cursor position for the on-panel pointer dot (or null).
let cursorUV = null;
let hoverIndex = -1;

const _raycaster = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _rayEnd = new THREE.Vector3();
const _rayMatrix = new THREE.Matrix4();

// Controller ray visuals: one line and one cursor dot per slot, since each trigger
// acts on its own ray. Created lazily, visible while any selection surface is open.
// No per-frame allocation: geometries update in place from shared scratch vectors.
let rayVisualsBuilt = false;
const _rayLines = [null, null];
// How far ahead of the aim pose the drawn beam begins — roughly the trigger.
const RAY_VISUAL_START_M = 0.045;
const _rayVisualStart = new THREE.Vector3();
const _rayDots = [null, null];
// Where each slot's ray ended this frame; its dot sits there.
const _rayEnds = [new THREE.Vector3(), new THREE.Vector3()];

// Bookmark visibility (respects the same genai gating as the flat menu)

function activeMode() {
  return MODES.find((mode) => mode.id === activeModeId) || MODES[0];
}

function modeEnabled(mode) {
  return !mode.requiresGenAi || genAiEnabled;
}

// Grid shows only the presets matching the active mode's BookmarkKind. GenAI
// presets stay hidden entirely unless the server reports GenAI enabled (so a
// disabled-GenAI mode selection yields an empty grid, never live GenAI cells).
function visibleBookmarks() {
  const kind = activeMode().kind;
  return DEFAULT_BOOKMARKS.filter((bookmark) => {
    if (bookmark.kind !== kind) {
      return false;
    }
    return bookmark.kind !== BookmarkKind.GENAI_PROMPT || genAiEnabled;
  });
}

function shouldShowStartFavorites() {
  return !(urlInput.value || "").trim()
    && !state.currentQuery
    && state.extractedItems.length === 0
    && !state.autoGalleryMode;
}

// Actions: reuse the flat-mode load paths, then re-anchor/hide.

async function activateBookmark(bookmark) {
  hidePanel();
  urlInput.value = bookmark.value;
  setAddressFeedback(null);
  window.dispatchEvent(new CustomEvent("surface-browser:bookmark-activated", {
    detail: { kind: bookmark.kind }
  }));
  if (bookmark.kind === BookmarkKind.IMAGE_SEARCH) {
    await loadImageSearch({ query: bookmark.value });
  } else if (bookmark.kind === BookmarkKind.GENAI_PROMPT) {
    await loadGenAiPrompt({ query: bookmark.value });
  } else {
    await loadAndExtractUrl({ query: bookmark.value });
  }
  focusSceneCanvas();
}

// Route a free-text transcript through the active mode's load function, matching
// the flat-mode behavior of each (Web treats it as URL-or-search, etc.).
async function activateQueryForActiveMode(query) {
  const resolved = (query || "").trim();
  if (!resolved) {
    return;
  }
  hidePanel();
  urlInput.value = resolved;
  setAddressFeedback(null);
  const mode = activeMode();
  if (mode.kind === BookmarkKind.IMAGE_SEARCH) {
    await loadImageSearch({ query: resolved });
  } else if (mode.kind === BookmarkKind.GENAI_PROMPT) {
    await loadGenAiPrompt({ query: resolved });
  } else {
    await loadAndExtractUrl({ query: resolved });
  }
  focusSceneCanvas();
}

// The one chokepoint for "the user picked a mode", whether from the panel's own
// mode row or from a wrist-panel section — so the explicit-choice flag is set
// here rather than at either call site.
function setActiveMode(modeId) {
  const mode = MODES.find((candidate) => candidate.id === modeId);
  if (!mode || !modeEnabled(mode)) {
    return;
  }
  const changed = activeModeId !== modeId || !modeChosenExplicitly;
  activeModeId = modeId;
  modeChosenExplicitly = true;
  if (!changed) {
    return;
  }
  // Redraw even when the mode id is unchanged: if this is the first explicit
  // choice, the panel was showing start favourites and now owes the user this
  // mode's bookmarks.
  drawPanel();
}

function runAction(action) {
  if (!action) {
    return;
  }
  if (action.type === "mode") {
    setActiveMode(action.modeId);
    return;
  }
  if (action.type === "voice") {
    startVoice();
    return;
  }
  if (action.type === "keyboard") {
    openKeyboard();
    return;
  }
  if (action.type === "statusFooter") {
    setStatusFooterEnabled(!isStatusFooterEnabled(), { persist: true });
    drawPanel();
    return;
  }
  if (action.type === "kbKey" || action.type === "kbBackspace") {
    keyboardText = applyKeyAction(keyboardText, action);
    drawPanel();
    return;
  }
  if (action.type === "kbDone") {
    const text = keyboardText;
    closeKeyboard();
    void activateQueryForActiveMode(text);
    return;
  }
  if (action.type === "kbCancel") {
    closeKeyboard();
    drawPanel();
    return;
  }
  if (action.type === "openMenu") {
    // Idle-panel launcher → full menu (same as physical left X).
    showMenuFromIdle();
    return;
  }
  if (action.type === "openHelp") {
    // Idle-panel launcher → help (same as physical right A).
    showHelpPanel();
    return;
  }
  if (action.type === "passthrough") {
    togglePassthrough();
    // The cell's own fill IS the state, so the panel has to repaint for the
    // press to read as having done anything.
    drawPanel();
    return;
  }
  if (action.type === "exitHold") {
    // Deliberately inert. Exit is timed by updateExitHold() from the trigger's
    // LEVEL; routing it through here would let one ray click — or one desktop
    // mouse click — end the session. This guard is what makes "Exit VR is never
    // a click" true rather than merely intended.
    return;
  }
  if (action.type === "historyBack") {
    void goBack();
    return;
  }
  if (action.type === "closePanel") {
    hidePanel();
    return;
  }
  if (action.type === "helpClose") {
    hideHelpPanel();
    return;
  }
  if (action.type === "helpView") {
    helpView = action.view;
    drawPanel();
    return;
  }
  if (action.type === "helpControllerSide") {
    helpControllerSide = action.side;
    drawPanel();
    return;
  }
  if (action.type === "confirmOk") {
    confirmTranscript();
    return;
  }
  if (action.type === "confirmCancel") {
    cancelTranscript();
    return;
  }
  if (action.type === "confirmReRecord") {
    reRecordTranscript();
    return;
  }
  if (action.type === "bookmark") {
    void activateBookmark(action.bookmark);
  }
}

// Canvas keyboard open/close. Layout and drawing live in vrkeyboard.js; this owns
// the open state and the composed-text buffer.

function openKeyboard() {
  // Opening the keyboard cancels any in-flight dictation.
  stopVoiceSession();
  voiceStatusText = null;
  keyboardOpen = true;
  keyboardText = "";
  drawPanel();
}

function closeKeyboard() {
  keyboardOpen = false;
  keyboardText = "";
}

// Voice dictation entry chain: Web Speech -> server STT (if stt.enabled and
// MediaRecorder exist) -> canvas keyboard. Nothing here throws; failures surface in
// the status line.

// True when the mic cell has *some* voice path (Web Speech or server STT).
// Used only for rendering; the actual path is chosen at press time.
function micHasVoicePath() {
  return isVoiceSupported() || (serverSttEnabled && mediaRecordingSupported());
}

function stopVoiceSession() {
  if (voiceSession) {
    const session = voiceSession;
    voiceSession = null;
    session.stop();
  }
}

async function startVoice() {
  if (voiceSession) {
    // Second press = stop/cancel the in-flight session.
    stopVoiceSession();
    voiceStatusText = null;
    drawPanel();
    return;
  }

  // 1) Web Speech, when the browser exposes it (desktop dev, some browsers).
  if (isVoiceSupported()) {
    startWebSpeechVoice();
    return;
  }

  // 2) Server STT, when the server reports it and Web Audio capture is available
  //    (the Quest path). Falls through to the keyboard on any hard failure.
  if (serverSttEnabled && mediaRecordingSupported()) {
    startServerSttVoice();
    return;
  }

  // If startup capabilities have not reached the panel yet, refresh at press time so
  // the first mic press on Quest is not turned into the keyboard fallback while
  // /api/health is still racing the panel open.
  if (mediaRecordingSupported()) {
    voiceStatusText = t("vr.voice.checking");
    drawPanel();
    const enabled = await isServerSttEnabled({ refresh: true });
    serverSttEnabled = enabled;
    if (!panelVisible || voiceSession) {
      return;
    }
    if (enabled) {
      startServerSttVoice();
      return;
    }
    voiceStatusText = null;
  }

  // 3) No voice path — open the keyboard as the fallback.
  openKeyboard();
}

function startWebSpeechVoice() {
  voiceStatusText = t("vr.voice.listening");
  drawPanel();

  voiceSession = startVoiceDictation({
    onInterim(text) {
      voiceStatusText = t("vr.voice.heard", { text });
      drawPanel();
    },
    onFinal(text) {
      voiceSession = null;
      voiceStatusText = null;
      // Never fire straight from STT: show the understood text for confirmation
      // first (mishears produce expensive wrong runs).
      beginTranscriptConfirm(text);
    },
    onError(message) {
      voiceStatusText = message || t("vr.voice.error");
      drawPanel();
    },
    onEnd() {
      voiceSession = null;
      if (voiceStatusText && voiceStatusText === t("vr.voice.listening")) {
        voiceStatusText = null;
      }
      if (panelVisible) {
        drawPanel();
      }
    }
  });
}

function startServerSttVoice() {
  voiceStatusText = t("vr.voice.recording");
  drawPanel();

  voiceSession = startServerStt({
    onRecording() {
      voiceStatusText = t("vr.voice.recording");
      drawPanel();
    },
    onTranscribing() {
      voiceStatusText = t("vr.voice.transcribing");
      drawPanel();
    },
    onFinal(text) {
      voiceSession = null;
      voiceStatusText = null;
      // Confirm before executing (see startWebSpeechVoice).
      beginTranscriptConfirm(text);
    },
    onError(message) {
      voiceSession = null;
      voiceStatusText = message || t("vr.voice.error");
      drawPanel();
    },
    onEnd() {
      voiceSession = null;
      if (voiceStatusText && (voiceStatusText.startsWith("●") || voiceStatusText === t("vr.voice.transcribing"))) {
        voiceStatusText = null;
      }
      if (panelVisible) {
        drawPanel();
      }
    }
  });
}

// Transcript confirmation: after STT returns, show the understood text with an OK
// button whose radial arc fills over CONFIRM_AUTO_MS and auto-confirms if untouched.
// Cancel routes nothing; the mic re-records. Both voice paths funnel here via onFinal.

// Timestamp (performance.now) the current confirm arc started; drives the sweep.
let transcriptConfirmStartedAt = 0;

function clearTranscriptTimers() {
  if (transcriptConfirmTimer !== null) {
    clearTimeout(transcriptConfirmTimer);
    transcriptConfirmTimer = null;
  }
  if (transcriptConfirmRaf !== null) {
    cancelAnimationFrame(transcriptConfirmRaf);
    transcriptConfirmRaf = null;
  }
}

function beginTranscriptConfirm(text) {
  const resolved = (text || "").trim();
  if (!resolved) {
    // Nothing understood — stay on the panel.
    drawPanel();
    return;
  }
  if (keyboardOpen) {
    // Spoken from the keyboard: the words land in its text field, where they
    // can be checked and edited before Done.
    keyboardText = resolved;
    voiceStatusText = null;
    drawPanel();
    return;
  }
  clearTranscriptTimers();
  pendingTranscript = resolved;
  panelMode = "confirm";
  transcriptConfirmStartedAt = now();
  // Auto-confirm if the user does nothing before the arc completes.
  transcriptConfirmTimer = setTimeout(() => {
    transcriptConfirmTimer = null;
    confirmTranscript();
  }, CONFIRM_AUTO_MS);
  // Animate the arc sweep — redraw the canvas each frame while confirming.
  const tick = () => {
    if (panelMode !== "confirm" || !panelVisible) {
      transcriptConfirmRaf = null;
      return;
    }
    drawPanel();
    transcriptConfirmRaf = requestAnimationFrame(tick);
  };
  transcriptConfirmRaf = requestAnimationFrame(tick);
  drawPanel();
}

function confirmTranscript() {
  const text = pendingTranscript;
  clearTranscriptTimers();
  pendingTranscript = null;
  panelMode = "main";
  if (text) {
    void activateQueryForActiveMode(text);
  }
}

function cancelTranscript() {
  clearTranscriptTimers();
  pendingTranscript = null;
  panelMode = "main";
  drawPanel();
}

// Re-record: discard the pending transcript and start dictation again.
function reRecordTranscript() {
  clearTranscriptTimers();
  pendingTranscript = null;
  panelMode = "main";
  startVoice();
}

// performance.now shim (kept tiny; some headless envs lack it).
function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

// Fraction (0→1) of the auto-confirm arc that has elapsed.
function transcriptConfirmProgress() {
  if (panelMode !== "confirm") {
    return 0;
  }
  return Math.max(0, Math.min(1, (now() - transcriptConfirmStartedAt) / CONFIRM_AUTO_MS));
}

// Canvas rendering

function ensurePanel() {
  if (!panelMesh) {
    const surface = createPanelSurface(
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      PANEL_WIDTH_M,
      PANEL_HEIGHT_M
    );
    panelCanvas = surface.canvas;
    panelCtx = surface.ctx;
    panelTexture = surface.texture;
    panelMesh = surface.mesh;
  }
  if (!helpMesh) {
    const surface = createPanelSurface(
      HELP_CANVAS_WIDTH,
      HELP_CANVAS_HEIGHT,
      HELP_PANEL_WIDTH_M,
      HELP_PANEL_HEIGHT_M
    );
    helpCanvas = surface.canvas;
    helpCtx = surface.ctx;
    helpTexture = surface.texture;
    helpMesh = surface.mesh;
  }
}

function createPanelSurface(canvasWidth, canvasHeight, widthM, heightM) {
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Applies to every flat UI canvas in the app (exit overlay, VR status footer in
  // ui.js, wrist quads in wristui.js): no mip chain and no anisotropy. The panel is
  // ~640 texels/m read near head-on at about texel parity, where mips and anisotropic
  // taps buy nothing, and regenerating the chain adds +33% to every upload.
  //
  // minFilter MUST move with generateMipmaps: the default LinearMipmapLinearFilter on a
  // texture with no mip chain renders black.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 1;

  const geometry = new THREE.PlaneGeometry(widthM, heightM);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10000;
  mesh.visible = false;
  scene.add(mesh);
  return { canvas, ctx, texture, mesh };
}

function activePanelSurface() {
  if (panelMode === "help") {
    return {
      canvas: helpCanvas,
      ctx: helpCtx,
      texture: helpTexture,
      mesh: helpMesh,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: CANVAS_HEIGHT,
      backingCanvasWidth: HELP_CANVAS_WIDTH,
      backingCanvasHeight: HELP_CANVAS_HEIGHT,
      widthM: HELP_PANEL_WIDTH_M,
      heightM: HELP_PANEL_HEIGHT_M
    };
  }
  if (panelMode === "idle") {
    return {
      canvas: panelCanvas,
      ctx: panelCtx,
      texture: panelTexture,
      mesh: panelMesh,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: IDLE_CANVAS_HEIGHT,
      backingCanvasWidth: CANVAS_WIDTH,
      backingCanvasHeight: CANVAS_HEIGHT,
      widthM: PANEL_WIDTH_M,
      heightM: IDLE_PANEL_HEIGHT_M
    };
  }
  return {
    canvas: panelCanvas,
    ctx: panelCtx,
    texture: panelTexture,
    mesh: panelMesh,
    canvasWidth: CANVAS_WIDTH,
    canvasHeight: CANVAS_HEIGHT,
    backingCanvasWidth: CANVAS_WIDTH,
    backingCanvasHeight: CANVAS_HEIGHT,
    widthM: PANEL_WIDTH_M,
    heightM: PANEL_HEIGHT_M
  };
}

// The idle launcher uses only the top rows of the menu's canvas; show just
// those and shrink the quad to match, so nothing is stretched.
function applyPanelCrop() {
  const fraction = panelMode === "idle" ? IDLE_CANVAS_HEIGHT / CANVAS_HEIGHT : 1;
  panelMesh.scale.y = fraction;
  panelTexture.repeat.set(1, fraction);
  panelTexture.offset.set(0, 1 - fraction);
}

function drawRoundedRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draw the three mode toggles and push their hit-rects. GenAI is greyed and
// non-interactive when the server reports GenAI disabled (mirrors the flat
// GenAI button). The active mode is highlighted with its accent border.
function drawModeRow(ctx) {
  const rowTop = contentTop();
  // Without a status bar this is the top row, and shares it with the corner buttons.
  const inset = statusBarShown ? 0 : TOP_ROW_INSET;
  const rowLeft = PAD + inset;
  const rowWidth = CANVAS_WIDTH - PAD * 2 - inset * 2;
  const cellW = (rowWidth - CELL_GAP * (MODE_COLS - 1)) / MODE_COLS;

  for (let i = 0; i < MODES.length; i += 1) {
    const mode = MODES[i];
    const x = rowLeft + i * (cellW + CELL_GAP);
    const enabled = modeEnabled(mode);
    const isActive = enabled && mode.id === activeModeId;
    const rectIndex = hitRects.length;
    const hovered = hoverIndex === rectIndex;

    let fill = COLOR_MODE_CELL;
    if (!enabled) {
      fill = COLOR_CELL_DISABLED;
    } else if (isActive) {
      fill = COLOR_MODE_CELL_ACTIVE;
    } else if (hovered) {
      fill = COLOR_MODE_CELL_HOVER;
    }
    ctx.fillStyle = fill;
    drawRoundedRect(ctx, x, rowTop, cellW, MODE_BAR_H, 14);
    ctx.fill();
    ctx.lineWidth = isActive ? 4 : 2;
    ctx.strokeStyle = isActive ? mode.color : COLOR_CELL_BORDER;
    ctx.stroke();

    ctx.fillStyle = enabled ? (isActive ? mode.color : COLOR_TEXT) : COLOR_TEXT_DISABLED;
    ctx.font = "700 30px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mode.label, x + cellW / 2, rowTop + (enabled ? MODE_BAR_H / 2 : MODE_BAR_H / 2 - 10));
    if (!enabled) {
      ctx.font = "500 18px 'Segoe UI', sans-serif";
      ctx.fillText(t("vr.configureFlat"), x + cellW / 2, rowTop + MODE_BAR_H / 2 + 22);
    }
    ctx.textAlign = "left";

    hitRects.push({
      x,
      y: rowTop,
      w: cellW,
      h: MODE_BAR_H,
      // A disabled (gated-off GenAI) mode registers a hit-rect for hover, but
      // its action is null so selecting it is a no-op.
      action: enabled ? { type: "mode", modeId: mode.id } : null
    });
  }
}

function drawPanelBackdrop(ctx, height = CANVAS_HEIGHT) {
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = COLOR_BG;
  drawRoundedRect(ctx, 4, 4, CANVAS_WIDTH - 8, height - 8, 26);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLOR_BORDER;
  ctx.stroke();
}

// Whether the status bar is drawn in the current repaint. Set once per
// drawPanel() so every region below agrees on where the content starts.
let statusBarShown = true;

function contentTop() {
  return statusBarShown ? PAD + STATUS_BAR_H + MODE_BAR_GAP : PAD;
}

function drawPanelStatus(ctx) {
  statusBarShown = Boolean(panelStatusText());
  if (!statusBarShown) {
    return;
  }
  ctx.fillStyle = COLOR_STATUS_BAR;
  drawRoundedRect(ctx, PAD + TOP_ROW_INSET, PAD, CANVAS_WIDTH - PAD * 2 - TOP_ROW_INSET * 2, STATUS_BAR_H, 14);
  ctx.fill();
  // While dictating, the voice status text takes over the status line.
  const failed = !voiceStatusText && state.menuLoad?.failed;
  ctx.fillStyle = voiceStatusText ? COLOR_MODE_SEARCH : failed ? COLOR_EXIT_ARC : COLOR_TEXT;
  ctx.font = "500 32px 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(panelStatusText(), PAD + TOP_ROW_INSET + 22, PAD + STATUS_BAR_H / 2);
}

function drawBackButton(ctx) {
  const x = PAD;
  const y = statusBarShown ? PAD + (STATUS_BAR_H - CLOSE_BTN_SIZE) / 2 : PAD;
  const enabled = canGoBack();
  const hovered = enabled && hoverIndex === hitRects.length;
  ctx.fillStyle = hovered ? COLOR_BACK_HOVER : COLOR_BACK;
  drawRoundedRect(ctx, x, y, CLOSE_BTN_SIZE, CLOSE_BTN_SIZE, 12);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR_CELL_BORDER;
  ctx.stroke();
  // The flat toolbar's chevron (index.html #back-btn, a 24-unit path), scaled.
  const scale = 26 / 24;
  const ox = x + CLOSE_BTN_SIZE / 2 - 12 * scale;
  const oy = y + CLOSE_BTN_SIZE / 2 - 12 * scale;
  ctx.beginPath();
  ctx.moveTo(ox + 15 * scale, oy + 4.5 * scale);
  ctx.lineTo(ox + 7.5 * scale, oy + 12 * scale);
  ctx.lineTo(ox + 15 * scale, oy + 19.5 * scale);
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = enabled ? COLOR_TEXT : COLOR_MUTED;
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.lineWidth = 2;
  if (enabled) {
    hitRects.push({ x, y, w: CLOSE_BTN_SIZE, h: CLOSE_BTN_SIZE, action: { type: "historyBack" } });
  }
}

function drawCloseButton(ctx) {
  const x = CANVAS_WIDTH - PAD - CLOSE_BTN_SIZE;
  const y = statusBarShown ? PAD + (STATUS_BAR_H - CLOSE_BTN_SIZE) / 2 : PAD;
  const hovered = hoverIndex === hitRects.length;
  ctx.fillStyle = hovered ? COLOR_BACK_HOVER : COLOR_BACK;
  drawRoundedRect(ctx, x, y, CLOSE_BTN_SIZE, CLOSE_BTN_SIZE, 12);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR_CELL_BORDER;
  ctx.stroke();
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "600 30px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("✕", x + CLOSE_BTN_SIZE / 2, y + CLOSE_BTN_SIZE / 2 + 1);
  ctx.textAlign = "left";
  hitRects.push({ x, y, w: CLOSE_BTN_SIZE, h: CLOSE_BTN_SIZE, action: { type: "closePanel" } });
}

// The one place the panel's status line is composed. Factored out so
// refreshPanelAnimation() can ask "has this changed since the last repaint?"
// without duplicating the rule.
function panelStatusText() {
  return menuStatusText({
    appState: state.appState,
    menuLoad: state.menuLoad,
    requestInFlight: state.cycleRequestInFlight,
    voiceText: voiceStatusText
  });
}

// What the last drawPanel() baked into the canvas, for refreshPanelAnimation().
let lastDrawnStatusText = null;
let lastDrawnConfirmStep = -1;
let lastDrawnVoiceActive = false;
let lastDrawnExitStep = -1;
// The language can change between sessions, so a panel kept from a previous
// session must repaint rather than show the old language.
let lastDrawnLanguage = null;
let lastDrawnButtonLetters = true;
let lastDrawnCanGoBack = false;

// The launcher's Exit VR hold. Progress is timed in updateExitHold() from the
// ray pump; everything here is only what the canvas and the head-locked ring
// need to read back.
let exitHold = createRayHoldState();
let exitHintUntilMs = 0;
// True only while THIS panel is the one showing the shared head-locked exit
// ring, so releasing it can never blank a ring the wrist panel or right B owns.
let panelExitRingOwned = false;

// -1 = nothing to show, -2 = the aborted-hold hint, otherwise the quantised
// ring position. Compared against lastDrawnExitStep the same way the confirm
// arc is, so the ring animates without a per-frame texture upload.
function currentExitStep() {
  if (exitHintUntilMs > now()) {
    return -2;
  }
  if (exitHold.fired || exitHold.progress <= 0) {
    return -1;
  }
  return Math.round(exitHold.progress * PANEL_EXIT_PROGRESS_STEPS);
}

// Repaints the canvas when the live status line or the confirm arc changed since
// the last draw. Both depend on load state / wall time and have no invalidation
// hook of their own, so this is one string compare and one integer compare per
// frame instead of a full texture upload. The arc is quantised to 1/60 of its
// travel (~60 redraws over CONFIRM_AUTO_MS, none once the confirm view closes).
// Called once per frame from renderFrame().
function refreshPanelAnimation() {
  // Published for the status footer, which has to sit below whatever panel is up.
  // Written here rather than imported by ui.js, which would close an import cycle
  // (see state.vrPanelBottomOffset).
  state.vrPanelBottomOffset = visiblePanelBottomOffset();
  if (!panelVisible) {
    return;
  }
  if (
    panelStatusText() === lastDrawnStatusText
    && currentConfirmStep() === lastDrawnConfirmStep
    && Boolean(voiceSession) === lastDrawnVoiceActive
    && currentExitStep() === lastDrawnExitStep
    && getLanguage() === lastDrawnLanguage
    && showButtonLetters() === lastDrawnButtonLetters
    && canGoBack() === lastDrawnCanGoBack
  ) {
    return;
  }
  drawPanel();
}

function currentConfirmStep() {
  return panelMode === "confirm" ? Math.round(transcriptConfirmProgress() * 60) : -1;
}

function drawPanel() {
  // Snapshot what this repaint bakes in, at the single entry point so every
  // drawPanel() call site keeps refreshPanelAnimation() honest.
  lastDrawnStatusText = panelStatusText();
  lastDrawnConfirmStep = currentConfirmStep();
  // voiceSession drives the mic cell's "● Recording" label and is assigned AFTER the
  // drawPanel() that announces "Listening…", so the label would sit one state behind
  // until the next callback; track it here.
  lastDrawnVoiceActive = Boolean(voiceSession);
  lastDrawnExitStep = currentExitStep();
  lastDrawnLanguage = getLanguage();
  lastDrawnButtonLetters = showButtonLetters();
  lastDrawnCanGoBack = canGoBack();
  if (panelMode === "help") {
    drawHelpPanel();
    return;
  }
  if (!panelCtx) {
    return;
  }
  const ctx = panelCtx;
  hitRects = [];
  applyPanelCrop();

  // Idle start panel: favorite tiles + More/Help/Exit launchers. No status
  // bar — before anything is asked for it has nothing to report.
  if (panelMode === "idle") {
    drawPanelBackdrop(ctx, IDLE_CANVAS_HEIGHT);
    drawIdleRegion(ctx);
    drawPointerDot(ctx);
    panelTexture.needsUpdate = true;
    return;
  }

  drawPanelBackdrop(ctx);
  drawPanelStatus(ctx);
  if (panelMode !== "confirm") {
    drawBackButton(ctx);
    drawCloseButton(ctx);
  }

  // When a transcript is awaiting confirmation it takes over the whole panel
  // below the status bar (no mode row / grid): the understood text, an OK button
  // with a radial auto-confirm arc, Cancel, and a re-record affordance.
  if (panelMode === "confirm") {
    drawConfirmRegion(ctx);
    drawPointerDot(ctx);
    panelTexture.needsUpdate = true;
    return;
  }

  // The start-favourites shortcut: one tile per mode, for a viewer who has not asked
  // for anything yet. `modeChosenExplicitly` overrides it: once a mode is picked the
  // viewer gets that mode's bookmarks.
  if (!keyboardOpen && !modeChosenExplicitly && shouldShowStartFavorites()) {
    // Without a status bar the label shares the top row with the corner buttons.
    drawStartFavoritesRegion(ctx, undefined, undefined, statusBarShown ? 0 : TOP_ROW_INSET);
    drawBottomBar(ctx);
    drawPointerDot(ctx);
    panelTexture.needsUpdate = true;
    return;
  }

  // --- Mode selector row (Web / Image / GenAI) ------------------------------
  drawModeRow(ctx);

  // When the keyboard is open it replaces the bookmark grid + bottom bar; it
  // carries its own Done/Cancel keys so no separate Back row is needed.
  if (keyboardOpen) {
    drawKeyboardRegion(ctx);
    drawPointerDot(ctx);
    panelTexture.needsUpdate = true;
    return;
  }

  // --- Bookmark grid --------------------------------------------------------
  const bookmarks = visibleBookmarks();
  const gridTop = contentTop() + MODE_BAR_H + 24;
  const gridBottom = CANVAS_HEIGHT - PAD - BACK_BAR_H - 24;
  const gridLeft = PAD;
  const gridWidth = CANVAS_WIDTH - PAD * 2;
  const rows = Math.ceil(bookmarks.length / GRID_COLS);
  const cellW = (gridWidth - CELL_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const cellH = rows > 0
    ? (gridBottom - gridTop - CELL_GAP * (rows - 1)) / rows
    : 0;

  for (let i = 0; i < bookmarks.length; i += 1) {
    const bookmark = bookmarks[i];
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    const x = gridLeft + col * (cellW + CELL_GAP);
    const y = gridTop + row * (cellH + CELL_GAP);
    const action = { type: "bookmark", bookmark };
    const rectIndex = hitRects.length;
    const hovered = hoverIndex === rectIndex;

    const modeColor = bookmarkModeColor[bookmark.kind] || COLOR_MODE_WEB;
    ctx.fillStyle = hovered ? COLOR_CELL_HOVER : COLOR_CELL;
    drawRoundedRect(ctx, x, y, cellW, cellH, 12);
    ctx.fill();
    // The section's colour, faded: a hint of which mode the cell belongs to
    // that stays quieter than the active mode cell's full-strength outline.
    ctx.lineWidth = 2;
    ctx.strokeStyle = `${modeColor}${BOOKMARK_OUTLINE_ALPHA_HEX}`;
    ctx.stroke();

    // Mode chip.
    ctx.fillStyle = modeColor;
    ctx.font = "700 20px 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(bookmarkModeLabel(bookmark.kind), x + 16, y + 14);

    // Title (single line, clipped to cell).
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = "500 26px 'Segoe UI', sans-serif";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 14, y + 44, cellW - 28, cellH - 52);
    ctx.clip();
    ctx.fillText(bookmarkTitle(bookmark), x + 16, y + 50);
    ctx.restore();

    hitRects.push({ x, y, w: cellW, h: cellH, action });
  }

  // Empty-state hint when the active mode has no presets (e.g. GenAI gated off,
  // or a mode with no matching bookmarks). Voice still works as an entry path.
  if (bookmarks.length === 0) {
    ctx.fillStyle = COLOR_MUTED;
    ctx.font = "400 28px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      t("vr.noPresets"),
      CANVAS_WIDTH / 2,
      (gridTop + gridBottom) / 2
    );
    ctx.textAlign = "left";
  }

  // --- Bottom bar: mic + keyboard (left) + Back (right) ---------------------
  drawBottomBar(ctx);

  // --- Pointer dot ----------------------------------------------------------
  drawPointerDot(ctx);
  panelTexture.needsUpdate = true;
}

// Render the help UI in logical menu coordinates onto its larger backing
// canvas. The 1.5x transform gives the CanvasTexture the matching pixel
// density of the larger quad while keeping hit rectangles and layout values
// shared with the readable 1024x768 design space.
function drawHelpPanel() {
  if (!helpCtx || !helpCanvas) {
    return;
  }
  const ctx = helpCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, helpCanvas.width, helpCanvas.height);
  ctx.setTransform(HELP_PANEL_SCALE, 0, 0, HELP_PANEL_SCALE, 0, 0);
  hitRects = [];
  drawPanelBackdrop(ctx);
  drawPanelStatus(ctx);
  drawHelpRegion(ctx);
  drawPointerDot(ctx);
  helpTexture.needsUpdate = true;
}

function drawStartFavoritesRegion(
  ctx,
  top = contentTop(),
  bottom = CANVAS_HEIGHT - PAD - BACK_BAR_H - 24,
  labelInset = 0
) {
  const gridLeft = PAD;
  const gridWidth = CANVAS_WIDTH - PAD * 2;
  const favorites = startFavoriteBookmarks();
  const cellW = (gridWidth - CELL_GAP * (favorites.length - 1)) / favorites.length;
  const cellH = bottom - top - 54;

  ctx.fillStyle = COLOR_MUTED;
  ctx.font = "700 26px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(t("vr.favorites"), PAD + 6 + labelInset, top);

  for (let i = 0; i < favorites.length; i += 1) {
    const bookmark = favorites[i];
    const x = gridLeft + i * (cellW + CELL_GAP);
    const y = top + 54;
    const isGenAi = bookmark.kind === BookmarkKind.GENAI_PROMPT;
    const enabled = !isGenAi || genAiEnabled;
    const rectIndex = hitRects.length;
    const hovered = enabled && hoverIndex === rectIndex;
    const color = bookmarkModeColor[bookmark.kind] || COLOR_MODE_WEB;

    ctx.fillStyle = enabled ? (hovered ? COLOR_CELL_HOVER : COLOR_CELL) : COLOR_CELL_DISABLED;
    drawRoundedRect(ctx, x, y, cellW, cellH, 14);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = enabled ? color : COLOR_CELL_BORDER;
    ctx.stroke();

    ctx.fillStyle = enabled ? color : COLOR_TEXT_DISABLED;
    ctx.font = "700 22px 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(bookmarkModeLabel(bookmark.kind), x + 18, y + 18);

    ctx.fillStyle = enabled ? COLOR_TEXT : COLOR_TEXT_DISABLED;
    ctx.font = "700 32px 'Segoe UI', sans-serif";
    const title = enabled ? bookmarkTitle(bookmark) : t("vr.configureInSettings");
    wrapLeftText(ctx, title, x + 18, y + 62, cellW - 36, 40, y + cellH - 80);

    ctx.fillStyle = COLOR_MUTED;
    ctx.font = "400 22px 'Segoe UI', sans-serif";
    const value = enabled ? bookmark.value : t("vr.useFlatSettings");
    // URLs commonly have no natural word boundaries, so wrapLeftText() would
    // still paint one oversized line across the rounded card. A middle
    // ellipsis keeps both the origin and useful final path/filename visible.
    ctx.fillText(middleEllipsizeCanvasText(ctx, value, cellW - 36), x + 18, y + cellH - 76);

    hitRects.push({
      x,
      y,
      w: cellW,
      h: cellH,
      action: enabled ? { type: "bookmark", bookmark } : null
    });
  }
}

function middleEllipsizeCanvasText(ctx, text, maxWidth) {
  const value = String(text || "").trim();
  if (ctx.measureText(value).width <= maxWidth) {
    return value;
  }
  const ellipsis = "…";
  let left = value.slice(0, Math.ceil(value.length / 2));
  let right = value.slice(Math.ceil(value.length / 2));
  // Drop from the middle, alternating sides so both the site/origin and the
  // final filename stay recognisable. Canvas measurement is the authority:
  // fixed character counts fail for proportional fonts and Unicode.
  while (left || right) {
    const candidate = `${left}${ellipsis}${right}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      return candidate;
    }
    if (left.length >= right.length && left) {
      left = left.slice(0, -1);
    } else {
      right = right.slice(1);
    }
  }
  return ellipsis;
}

// Idle start panel: three favorite tiles (reused) + three glyph buttons. No
// mode row, voice or keyboard: a visitor picks a category (More…) before they
// can speak or type into one.
function drawIdleRegion(ctx) {
  drawStartFavoritesRegion(ctx, IDLE_TILES_TOP, IDLE_TILES_BOTTOM);
  drawIdleGlyphButtons(ctx);
}

// The three launcher buttons along the bottom: More… (X), Help (A) and Exit VR
// (B). The circled letters mirror the physical controller buttons (left X opens
// the menu, right A toggles help, right B exits) so the hint is self-documenting.
//
// Exit is here because the physical exit is right B and the menu is a different
// button, so a visitor holding one controller had one or the other, never both. The
// panel is ray-selectable from either hand. It is the only HOLD button on the panel;
// see updateExitHold() and the "exitHold" no-op in runAction() that keeps a click
// from ever ending the session.
function drawIdleGlyphButtons(ctx) {
  const bottomY = IDLE_BTN_Y;
  const totalW = CANVAS_WIDTH - PAD * 2;
  const btnW = (totalW - IDLE_BTN_GAP * 2) / 3;
  const step = btnW + IDLE_BTN_GAP;
  const buttons = [
    // X and A: the menu is X, and Help is A on every build (Y is Help only when no
    // capture token is configured).
    { x: PAD, glyph: "X", label: t("vr.more"), action: { type: "openMenu" } },
    { x: PAD + step, glyph: "A", label: t("nav.help"), action: { type: "openHelp" } },
    { x: PAD + step * 2, glyph: "B", label: t("vr.exitShort"), action: { type: "exitHold" }, hold: true }
  ];

  for (const button of buttons) {
    const rectIndex = hitRects.length;
    const hovered = hoverIndex === rectIndex;
    ctx.fillStyle = hovered ? COLOR_IDLE_BTN_HOVER : COLOR_IDLE_BTN;
    drawRoundedRect(ctx, button.x, bottomY, btnW, IDLE_BTN_H, 16);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLOR_CELL_BORDER;
    ctx.stroke();

    if (button.hold) {
      drawExitHoldContent(ctx, button.x, bottomY, IDLE_BTN_H, { inset: 36, gap: 24, labelPx: 34 });
    } else {
      const glyphCx = button.x + 36 + IDLE_GLYPH_RADIUS;
      const glyphCy = bottomY + IDLE_BTN_H / 2;
      const letters = showButtonLetters();
      if (letters) {
        drawCircledGlyph(ctx, glyphCx, glyphCy, IDLE_GLYPH_RADIUS, button.glyph);
      }
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = "700 34px 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(button.label, letters ? glyphCx + IDLE_GLYPH_RADIUS + 24 : button.x + 36, glyphCy);
    }

    hitRects.push({ x: button.x, y: bottomY, w: btnW, h: IDLE_BTN_H, action: button.action });
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

// The Exit VR cell's contents — circled B, hold ring, and the label that turns
// into the hint after an aborted hold. Shared by the launcher row and the menu's
// bottom toolbar so the two are one control drawn in two places, not two
// controls that have to be kept in step. The caller owns the cell background and
// the hit-rect; only the sizes differ between them.
//
// The aborted-hold cue lives HERE rather than on the head-locked overlay: that
// overlay renders the literal text "Hold B", which is the wrong instruction for
// a ray, and input.js's per-frame hideExitHoldIndicator() would clear it on the
// very next frame anyway.
function drawExitHoldContent(ctx, x, y, h, { inset, gap, labelPx }) {
  const exitStep = currentExitStep();
  const glyphCx = x + inset + IDLE_GLYPH_RADIUS;
  const glyphCy = y + h / 2;
  // Without the letter the empty ring stays: it carries the hold's progress.
  drawCircledGlyph(ctx, glyphCx, glyphCy, IDLE_GLYPH_RADIUS, showButtonLetters() ? "B" : "");
  drawIdleHoldRing(ctx, glyphCx, glyphCy, exitStep > 0 ? exitHold.progress : 0);

  const hinting = exitStep === -2;
  ctx.fillStyle = hinting ? COLOR_EXIT_ARC : COLOR_TEXT;
  ctx.font = `700 ${hinting ? labelPx - 8 : labelPx}px 'Segoe UI', sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(hinting ? t("vr.holdToExit") : t("vr.exitShort"), glyphCx + IDLE_GLYPH_RADIUS + gap, glyphCy);
}

// The progress ring the Exit button wears while it is being held: an arc around
// its glyph, in the head-locked exit overlay's own colours so the two read as
// one control. Same shape the wrist panel's Exit row uses.
function drawIdleHoldRing(ctx, cx, cy, progress) {
  ctx.lineWidth = IDLE_EXIT_RING_WIDTH;
  ctx.lineCap = "round";
  ctx.strokeStyle = COLOR_EXIT_TRACK;
  ctx.beginPath();
  ctx.arc(cx, cy, IDLE_EXIT_RING_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  if (progress > 0) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = COLOR_EXIT_ARC;
    ctx.beginPath();
    ctx.arc(cx, cy, IDLE_EXIT_RING_RADIUS, start, start + Math.min(1, progress) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
  ctx.lineWidth = 2;
}

// A single letter inside a circle, canvas-drawn to match the panel's flat style
// (thin ring + centered letter). Used for the physical-button hints (Y / X / B).
function drawCircledGlyph(ctx, cx, cy, radius, letter) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLOR_IDLE_GLYPH;
  ctx.stroke();
  ctx.fillStyle = COLOR_IDLE_GLYPH;
  ctx.font = "700 34px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Nudge down 1px so the optical center of the cap-height letter sits centered.
  ctx.fillText(letter, cx, cy + 1);
}

// Bottom bar: the mic launcher, the keyboard launcher, the status-footer toggle
// and Exit VR.
// One toolbar cell: an icon (from ui-icons.js, or a text glyph where none
// exists) and a label, with the state carried by fill and outline.
function drawToolbarCell(ctx, x, y, w, h, { icon, glyph, label, active, hovered }) {
  ctx.fillStyle = active ? COLOR_KBD_ACTIVE : (hovered ? COLOR_KBD_HOVER : COLOR_KBD);
  drawRoundedRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = active ? COLOR_MODE_SEARCH : COLOR_CELL_BORDER;
  ctx.stroke();
  const color = active ? COLOR_MODE_SEARCH : COLOR_TEXT;
  const iconCx = x + 22 + TOOLBAR_ICON_PX / 2;
  if (icon) {
    drawIcon(ctx, icon, iconCx, y + h / 2, TOOLBAR_ICON_PX, color);
  } else {
    ctx.fillStyle = color;
    ctx.font = "700 34px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, iconCx, y + h / 2);
  }
  ctx.fillStyle = color;
  ctx.font = "700 26px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, iconCx + TOOLBAR_ICON_PX / 2 + 12, y + h / 2);
}

function drawBottomBar(ctx) {
  const bottomY = CANVAS_HEIGHT - PAD - BACK_BAR_H;
  let x = PAD;

  // Passthrough first and widest — the toggle visitors liked most. The idle
  // launcher deliberately does not carry it: the tunnel and sphere come first.
  if (passthroughAvailable()) {
    const ptHovered = hoverIndex === hitRects.length;
    drawToolbarCell(ctx, x, bottomY, PASSTHROUGH_CELL_W, BACK_BAR_H, {
      icon: "passthrough",
      label: t("vr.tb.passthrough"),
      active: isPassthroughOn(),
      hovered: ptHovered
    });
    hitRects.push({ x, y: bottomY, w: PASSTHROUGH_CELL_W, h: BACK_BAR_H, action: { type: "passthrough" } });
    x += PASSTHROUGH_CELL_W + BOTTOM_GAP;
  }

  // Opens the keyboard, which carries the voice entry.
  const kbdHovered = hoverIndex === hitRects.length;
  drawToolbarCell(ctx, x, bottomY, KBD_CELL_W, BACK_BAR_H, {
    glyph: "⌨",
    label: t("vr.tb.type"),
    active: keyboardOpen,
    hovered: kbdHovered
  });
  hitRects.push({ x, y: bottomY, w: KBD_CELL_W, h: BACK_BAR_H, action: { type: "keyboard" } });
  x += KBD_CELL_W + BOTTOM_GAP;

  const statusHovered = hoverIndex === hitRects.length;
  drawToolbarCell(ctx, x, bottomY, STATUS_TOGGLE_CELL_W, BACK_BAR_H, {
    icon: "info",
    label: t("vr.tb.status"),
    active: isStatusFooterEnabled(),
    hovered: statusHovered
  });
  hitRects.push({ x, y: bottomY, w: STATUS_TOGGLE_CELL_W, h: BACK_BAR_H, action: { type: "statusFooter" } });

  // Exit VR takes the right end of the row, where the launcher row puts it.
  const exitX = CANVAS_WIDTH - PAD - EXIT_CELL_W;

  // The SECOND place the "exitHold" rect is drawn. The pump finds it by action
  // type rather than by hit-rect index, so one implementation serves both
  // surfaces; a hold cannot cross between them because updateExitHold() scopes
  // it to `panelMode` (see updateRayHoldState).
  const exitRectIndex = hitRects.length;
  const exitHovered = hoverIndex === exitRectIndex;
  ctx.fillStyle = exitHovered ? COLOR_IDLE_BTN_HOVER : COLOR_IDLE_BTN;
  drawRoundedRect(ctx, exitX, bottomY, EXIT_CELL_W, BACK_BAR_H, 16);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR_CELL_BORDER;
  ctx.stroke();
  drawExitHoldContent(ctx, exitX, bottomY, BACK_BAR_H, { inset: 22, gap: 18, labelPx: 28 });
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  hitRects.push({
    x: exitX,
    y: bottomY,
    w: EXIT_CELL_W,
    h: BACK_BAR_H,
    action: { type: "exitHold" }
  });
}

// Draw the canvas keyboard filling the region below the mode row. Delegates
// layout/drawing to vrkeyboard.js and appends its keys to the shared hit-rects.
function drawKeyboardRegion(ctx) {
  const top = contentTop() + MODE_BAR_H + 24;
  const region = {
    x: PAD,
    y: top,
    w: CANVAS_WIDTH - PAD * 2,
    h: CANVAS_HEIGHT - PAD - top
  };
  const keyRects = drawKeyboard(ctx, region, {
    text: keyboardText,
    hoverIndex,
    baseRectIndex: hitRects.length,
    voice: micHasVoicePath(),
    recording: Boolean(voiceSession)
  });
  for (const rect of keyRects) {
    hitRects.push(rect);
  }
}

// Draw the transcript-confirmation view: heading, the understood text large and
// centered, a circular OK button with a radial fill arc (auto-confirm progress),
// and Cancel + re-record pills. Pushes hit-rects for OK / Cancel / re-record.
function drawConfirmRegion(ctx) {
  const top = contentTop();
  const regionBottom = CANVAS_HEIGHT - PAD;

  // Heading.
  ctx.fillStyle = COLOR_MUTED;
  ctx.font = "600 24px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(t("vr.confirm.heard"), CANVAS_WIDTH / 2, top + 8);

  // Understood text, prominent and word-wrapped within the panel width.
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "700 46px 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  const textTop = top + 58;
  const textBottomLimit = CANVAS_HEIGHT / 2 + 20;
  wrapCenteredText(ctx, pendingTranscript || "", CANVAS_WIDTH / 2, textTop, CANVAS_WIDTH - PAD * 4, 54, textBottomLimit);

  // OK button (circular) with radial auto-confirm arc.
  const okCx = CANVAS_WIDTH / 2;
  const okCy = regionBottom - CONFIRM_BTN_H - 40 - CONFIRM_OK_RADIUS;
  const okRectIndex = hitRects.length;
  const okHovered = hoverIndex === okRectIndex;

  // Filled disc.
  ctx.beginPath();
  ctx.arc(okCx, okCy, CONFIRM_OK_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = okHovered ? COLOR_CONFIRM_HOVER : COLOR_CONFIRM;
  ctx.fill();

  // Progress track + sweep (12 o'clock clockwise).
  const progress = transcriptConfirmProgress();
  const arcRadius = CONFIRM_OK_RADIUS - CONFIRM_ARC_WIDTH / 2 - 4;
  ctx.lineWidth = CONFIRM_ARC_WIDTH;
  ctx.lineCap = "round";
  ctx.strokeStyle = COLOR_CONFIRM_ARC_TRACK;
  ctx.beginPath();
  ctx.arc(okCx, okCy, arcRadius, 0, Math.PI * 2);
  ctx.stroke();
  if (progress > 0) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = COLOR_CONFIRM_ARC;
    ctx.beginPath();
    ctx.arc(okCx, okCy, arcRadius, start, start + progress * Math.PI * 2);
    ctx.stroke();
  }

  // OK label.
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "700 40px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("OK", okCx, okCy);

  // A square hit-rect covering the OK disc (rect hit-test is fine for aiming).
  hitRects.push({
    x: okCx - CONFIRM_OK_RADIUS,
    y: okCy - CONFIRM_OK_RADIUS,
    w: CONFIRM_OK_RADIUS * 2,
    h: CONFIRM_OK_RADIUS * 2,
    action: { type: "confirmOk" }
  });

  // Cancel (left) + re-record (right) pills along the bottom.
  const pillY = regionBottom - CONFIRM_BTN_H;
  const cancelX = CANVAS_WIDTH / 2 - CONFIRM_BTN_W - BOTTOM_GAP;
  const recordX = CANVAS_WIDTH / 2 + BOTTOM_GAP;

  const cancelRectIndex = hitRects.length;
  const cancelHovered = hoverIndex === cancelRectIndex;
  ctx.fillStyle = cancelHovered ? COLOR_CANCEL_HOVER : COLOR_CANCEL;
  drawRoundedRect(ctx, cancelX, pillY, CONFIRM_BTN_W, CONFIRM_BTN_H, 16);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR_CELL_BORDER;
  ctx.stroke();
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "700 30px 'Segoe UI', sans-serif";
  ctx.fillText(t("vr.confirm.cancel"), cancelX + CONFIRM_BTN_W / 2, pillY + CONFIRM_BTN_H / 2);
  hitRects.push({ x: cancelX, y: pillY, w: CONFIRM_BTN_W, h: CONFIRM_BTN_H, action: { type: "confirmCancel" } });

  const recordRectIndex = hitRects.length;
  const recordHovered = hoverIndex === recordRectIndex;
  ctx.fillStyle = recordHovered ? COLOR_MIC_HOVER : COLOR_MIC;
  drawRoundedRect(ctx, recordX, pillY, CONFIRM_BTN_W, CONFIRM_BTN_H, 16);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR_CELL_BORDER;
  ctx.stroke();
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText(t("vr.confirm.rerecord"), recordX + CONFIRM_BTN_W / 2, pillY + CONFIRM_BTN_H / 2);
  hitRects.push({ x: recordX, y: pillY, w: CONFIRM_BTN_W, h: CONFIRM_BTN_H, action: { type: "confirmReRecord" } });

  ctx.textAlign = "left";
}

// Draw the help panel as separate pages (basic / advanced / controller) so every
// binding gets a full-size row. The controller page shows one static Quest Touch
// Plus controller at a time with direct callouts.
function drawHelpRegion(ctx) {
  const top = contentTop();
  const buttonH = 64;
  const buttonGap = 14;
  const bottomY = CANVAS_HEIGHT - PAD - BACK_BAR_H;
  const switchY = bottomY - buttonH - 16;
  const buttonW = (CANVAS_WIDTH - PAD * 2 - buttonGap * 2) / 3;
  const affordances = helpAffordances();
  // Hand tracking can be revoked mid-session (or never granted), and the reader
  // may already be standing on the Hands page when it goes.
  if (helpView === "hands" && !handsPageAvailable(affordances)) {
    helpView = "basic";
  }
  const isDiagram = helpView === "controllers";
  const isHands = helpView === "hands";
  const title = t(helpView === "advanced"
    ? "vr.help.advanced"
    : isDiagram
      ? (helpControllerSide === "left" ? "vr.help.leftController" : "vr.help.rightController")
      : isHands ? "vr.help.hands" : "vr.help.controls");

  ctx.fillStyle = COLOR_MUTED;
  ctx.font = "700 26px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, PAD + 6, top);

  if (isDiagram) {
    drawControllerHelpDiagram(ctx, top + 42, switchY - 16, helpControllerSide, affordances);
  } else if (isHands) {
    drawHandsHelpPage(ctx, top + 42, switchY - 16, affordances);
  } else {
    const lines = helpView === "advanced"
      ? helpAdvancedLines(affordances)
      : helpBasicLines(affordances);
    const listTop = top + 44;
    const keyX = PAD + 6;
    // The key column is as wide as its widest key and no wider; descriptions
    // take the rest and wrap, rather than starting mid-panel and running off it.
    const availableH = switchY - listTop - 16;
    let fontPx = 24;
    let layout = layoutHelpList(ctx, lines, keyX, fontPx, availableH);
    if (layout.height > availableH) {
      fontPx = 22;
      layout = layoutHelpList(ctx, lines, keyX, fontPx, availableH);
    }
    const { descX, rows } = layout;
    for (let i = 0; i < lines.length; i += 1) {
      const [key, , icon, inlineIcon] = lines[i];
      const y = listTop + rows[i].y;
      ctx.fillStyle = COLOR_MODE_WEB;
      ctx.font = `700 ${fontPx}px 'Segoe UI', sans-serif`;
      ctx.fillText(key, keyX, y);
      // The same drawing that is sitting on that physical button, right after
      // its letter. Drawn from the key's measured width so it follows the text
      // rather than sitting at a guessed column.
      if (icon) {
        const iconSize = fontPx * 1.15;
        // Aligned by the icon's LEFT EDGE, not its centre: the drawings differ
        // in width by more than two to one, so a constant centre offset makes
        // the gap after the text visibly uneven.
        const left = keyX + ctx.measureText(key).width + HELP_ICON_GAP_PX;
        drawIcon(
          ctx,
          icon,
          left + (iconHalfWidth(icon) * iconSize),
          y + (fontPx / 2),
          iconSize,
          COLOR_TEXT
        );
      }
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = `400 ${fontPx}px 'Segoe UI', sans-serif`;
      rows[i].descLines.forEach((line, j) => {
        const lineY = y + j * layout.lineH;
        if (!inlineIcon || !line.includes(HELP_INLINE_ICON)) {
          ctx.fillText(line, descX, lineY);
          return;
        }
        const [before, after] = line.split(HELP_INLINE_ICON);
        const iconSize = fontPx * 1.15;
        const left = descX + ctx.measureText(before).width;
        drawIcon(ctx, inlineIcon, left + (iconHalfWidth(inlineIcon) * iconSize), lineY + (fontPx / 2), iconSize, COLOR_TEXT);
        ctx.fillText(before, descX, lineY);
        ctx.fillText(after, left + (iconHalfWidth(inlineIcon) * iconSize * 2), lineY);
      });
    }
  }

  if (isDiagram) {
    drawHelpSwitchButton(
      ctx,
      PAD,
      switchY,
      buttonW,
      buttonH,
      t(helpControllerSide === "left" ? "vr.help.switch.rightController" : "vr.help.switch.leftController"),
      "helpControllerSide",
      helpControllerSide === "left" ? "right" : "left"
    );
    drawHelpSwitchButton(
      ctx,
      PAD + buttonW + buttonGap,
      switchY,
      buttonW,
      buttonH,
      t("vr.help.switch.basic"),
      "helpView",
      "basic"
    );
    if (handsPageAvailable(affordances)) {
      drawHelpSwitchButton(
        ctx,
        PAD + (buttonW + buttonGap) * 2,
        switchY,
        buttonW,
        buttonH,
        t("vr.help.switch.hands"),
        "helpView",
        "hands"
      );
    }
  } else if (isHands) {
    drawHelpSwitchButton(
      ctx,
      PAD,
      switchY,
      buttonW,
      buttonH,
      t("vr.help.switch.basic"),
      "helpView",
      "basic"
    );
    drawHelpSwitchButton(
      ctx,
      PAD + buttonW + buttonGap,
      switchY,
      buttonW,
      buttonH,
      t("vr.help.switch.advanced"),
      "helpView",
      "advanced"
    );
    drawHelpSwitchButton(
      ctx,
      PAD + (buttonW + buttonGap) * 2,
      switchY,
      buttonW,
      buttonH,
      t("vr.help.switch.controllers"),
      "helpView",
      "controllers"
    );
  } else {
    drawHelpSwitchButton(
      ctx,
      PAD,
      switchY,
      buttonW,
      buttonH,
      t(helpView === "advanced" ? "vr.help.switch.basicBindings" : "vr.help.switch.advancedBindings"),
      "helpView",
      helpView === "advanced" ? "basic" : "advanced"
    );
    drawHelpSwitchButton(
      ctx,
      PAD + buttonW + buttonGap,
      switchY,
      buttonW,
      buttonH,
      t("vr.help.switch.controllers"),
      "helpView",
      "controllers"
    );
    if (handsPageAvailable(affordances)) {
      drawHelpSwitchButton(
        ctx,
        PAD + (buttonW + buttonGap) * 2,
        switchY,
        buttonW,
        buttonH,
        t("vr.help.switch.hands"),
        "helpView",
        "hands"
      );
    }
  }

  const closeRectIndex = hitRects.length;
  const closeHovered = hoverIndex === closeRectIndex;
  ctx.fillStyle = closeHovered ? COLOR_BACK_HOVER : COLOR_BACK;
  drawRoundedRect(ctx, PAD, bottomY, CANVAS_WIDTH - PAD * 2, BACK_BAR_H, 16);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR_CELL_BORDER;
  ctx.stroke();
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "700 34px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(t("vr.help.close"), CANVAS_WIDTH / 2, bottomY + BACK_BAR_H / 2);
  ctx.textAlign = "left";
  hitRects.push({ x: PAD, y: bottomY, w: CANVAS_WIDTH - PAD * 2, h: BACK_BAR_H, action: { type: "helpClose" } });
}

const HELP_LIST_COLUMN_GAP_PX = 28;

// Row geometry for the Basic/Advanced list at one font size: key column width,
// each row's wrapped description and its y offset, and the total height. The
// gap between rows gives way first, so nine rows (hands AND controllers, when
// the input is unknown) still clear the switch buttons.
function layoutHelpList(ctx, lines, keyX, fontPx, availableH) {
  ctx.font = `700 ${fontPx}px 'Segoe UI', sans-serif`;
  const iconSize = fontPx * 1.15;
  let keyW = 0;
  for (const [key, , icon] of lines) {
    const iconW = icon ? HELP_ICON_GAP_PX + (iconHalfWidth(icon) * iconSize * 2) : 0;
    keyW = Math.max(keyW, ctx.measureText(key).width + iconW);
  }
  const descX = keyX + keyW + HELP_LIST_COLUMN_GAP_PX;
  const descW = CANVAS_WIDTH - PAD - 6 - descX;
  const lineH = Math.round(fontPx * 1.25);
  ctx.font = `400 ${fontPx}px 'Segoe UI', sans-serif`;
  const wrapped = lines.map(([, desc]) => wrapTextLines(ctx, desc, descW));
  const textH = wrapped.reduce((total, l) => total + Math.max(1, l.length) * lineH, 0);
  const gaps = Math.max(1, lines.length - 1);
  const rowGap = Math.max(4, Math.min(Math.round(fontPx * 0.8), Math.floor((availableH - textH) / gaps)));
  const rows = [];
  let y = 0;
  for (const descLines of wrapped) {
    rows.push({ y, descLines });
    y += Math.max(1, descLines.length) * lineH + rowGap;
  }
  return { descX, rows, lineH, height: y - rowGap };
}

function drawHelpSwitchButton(ctx, x, y, w, h, label, type, value) {
  const rectIndex = hitRects.length;
  const hovered = hoverIndex === rectIndex;
  ctx.fillStyle = hovered ? COLOR_MODE_CELL_HOVER : COLOR_MODE_CELL;
  drawRoundedRect(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR_CELL_BORDER;
  ctx.stroke();
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "700 22px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const action = type === "helpControllerSide"
    ? { type, side: value }
    : { type, view: value };
  hitRects.push({ x, y, w, h, action });
}

function drawControllerHelpDiagram(ctx, top, bottom, side, affordances) {
  drawControllerMapCanvas(ctx, {
    x: PAD + 6,
    y: top,
    width: CANVAS_WIDTH - (PAD + 6) * 2,
    height: bottom - top,
    side
  });
}

// Row height is derived from what is left after the group headings rather than
// fixed, so the page keeps clearing the view-switch buttons below it. Details are
// short enough to sit on one line at this width.
function drawHandsHelpPage(ctx, top, bottom, affordances) {
  const keyX = PAD + 6;
  const detailX = 390;
  const detailWidth = CANVAS_WIDTH - detailX - PAD;
  const groupGap = 10;
  const headerH = 28;
  const groups = helpGestureGroups();
  const rowCount = groups.reduce((total, group) => total + group.rows.length, 0);
  const available = bottom - top - (groups.length * (headerH + groupGap));
  const rowH = Math.max(26, Math.min(42, Math.floor(available / Math.max(1, rowCount))));
  let y = top;

  for (const group of groups) {
    ctx.fillStyle = COLOR_MODE_WEB;
    ctx.font = "700 22px 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(group.title, keyX, y);
    y += headerH;

    for (const [key, detail] of group.rows) {
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = "700 20px 'Segoe UI', sans-serif";
      ctx.fillText(key, keyX, y + 3);
      ctx.fillStyle = COLOR_MUTED;
      ctx.font = "400 19px 'Segoe UI', sans-serif";
      drawWrappedHelpText(ctx, detail, detailX, y, detailWidth, 23, y + rowH - 4);
      y += rowH;
    }
    y += groupGap;
  }
}

function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

function drawWrappedHelpText(ctx, text, x, top, maxWidth, lineHeight, bottom) {
  const lines = wrapTextLines(ctx, text, maxWidth);
  let y = top;
  for (const value of lines) {
    if (y > bottom) {
      break;
    }
    ctx.fillText(value, x, y + 3);
    y += lineHeight;
  }
}

// Word-wrap centered text, clipping to a max number of lines by the y limit.
function wrapCenteredText(ctx, text, cx, top, maxWidth, lineHeight, bottomLimit) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  let y = top;
  for (const l of lines) {
    if (y > bottomLimit) {
      break;
    }
    ctx.fillText(l, cx, y);
    y += lineHeight;
  }
}

function wrapLeftText(ctx, text, x, top, maxWidth, lineHeight, bottomLimit) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  let y = top;
  for (const l of lines) {
    if (y > bottomLimit) {
      break;
    }
    ctx.fillText(l, x, y);
    y += lineHeight;
  }
}

function drawPointerDot(ctx) {
  if (cursorUV) {
    ctx.beginPath();
    ctx.arc(cursorUV.x, cursorUV.y, CURSOR_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffffcc";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#53a9ff";
    ctx.stroke();
  }
}

// Placement: anchor in front of the active camera's yaw at open time.

function anchorPanel() {
  const surface = activePanelSurface();
  const cam = getActiveCamera();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  cam.getWorldPosition(camPos);
  cam.getWorldDirection(camDir);
  // Flatten forward onto the horizontal plane so the panel stands upright.
  camDir.y = 0;
  if (camDir.lengthSq() < 1e-6) {
    camDir.set(0, 0, -1);
  }
  camDir.normalize();

  surface.mesh.position
    .copy(camPos)
    .addScaledVector(camDir, PANEL_DISTANCE);
  surface.mesh.position.y = camPos.y + PANEL_HEIGHT_OFFSET;

  const lookTarget = new THREE.Vector3().copy(surface.mesh.position).sub(camDir);
  lookTarget.y = surface.mesh.position.y;
  surface.mesh.lookAt(lookTarget);
}

// Re-anchor the open panel in front of the viewer for THIS frame. Same call
// stabilizePanelAnchor() makes, exposed because the panel is world-anchored and
// during the rush toward the sphere the world moves several metres a second, so a
// panel left where it was opened would slide past (or through) the viewer's head.
// Driving it every frame keeps the menus reachable through the transition. No-op
// when nothing is open.
function followPanelAnchorToViewer() {
  if (!panelVisible || !activePanelSurface().mesh) {
    return;
  }
  anchorPanel();
}

function stabilizePanelAnchor() {
  if (!panelVisible || !activePanelSurface().mesh || panelAnchorStabilizeUntil <= 0) {
    return;
  }
  if (now() > panelAnchorStabilizeUntil) {
    panelAnchorStabilizeUntil = 0;
    return;
  }
  anchorPanel();
}

// A Meta-button recenter resets the reference space, which moves the world —
// and an open panel with it — relative to the viewer. Re-run the stabilize
// window so the panel lands in front of the new forward, not where it was.
renderer.xr.addEventListener("sessionstart", () => {
  renderer.xr.getReferenceSpace()?.addEventListener?.("reset", () => {
    if (panelVisible) {
      panelAnchorStabilizeUntil = now() + PANEL_ANCHOR_STABILIZE_MS;
    }
  });
});

function ensureExitOverlay() {
  if (exitMesh) {
    return;
  }
  exitCanvas = document.createElement("canvas");
  exitCanvas.width = EXIT_CANVAS_SIZE;
  exitCanvas.height = EXIT_CANVAS_SIZE;
  exitCtx = exitCanvas.getContext("2d");
  exitTexture = new THREE.CanvasTexture(exitCanvas);
  exitTexture.colorSpace = THREE.SRGBColorSpace;
  // Flat head-on UI quad, ~700 texels/m against ~590 screen px/m; see
  // createPanelSurface(). It redraws every frame of the exit hold, so skipping mip
  // regeneration matters.
  exitTexture.generateMipmaps = false;
  exitTexture.minFilter = THREE.LinearFilter;
  exitTexture.magFilter = THREE.LinearFilter;

  const geometry = new THREE.PlaneGeometry(EXIT_OVERLAY_WIDTH_M, EXIT_OVERLAY_HEIGHT_M);
  const material = new THREE.MeshBasicMaterial({
    map: exitTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  exitMesh = new THREE.Mesh(geometry, material);
  exitMesh.renderOrder = 10002;
  exitMesh.visible = false;
  scene.add(exitMesh);
}

function anchorExitOverlay() {
  const cam = getActiveCamera();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  cam.getWorldPosition(camPos);
  cam.getWorldDirection(camDir);
  if (camDir.lengthSq() < 1e-6) {
    camDir.set(0, 0, -1);
  }
  camDir.normalize();
  exitMesh.position.copy(camPos).addScaledVector(camDir, EXIT_OVERLAY_DISTANCE);
  exitMesh.position.y = camPos.y - 0.06;
  exitMesh.lookAt(camPos);
}

function drawExitOverlay(progress, hintOnly = false) {
  if (!exitCtx) {
    return;
  }
  const ctx = exitCtx;
  const cx = EXIT_CANVAS_SIZE / 2;
  const cy = EXIT_CANVAS_SIZE / 2;
  ctx.clearRect(0, 0, EXIT_CANVAS_SIZE, EXIT_CANVAS_SIZE);

  ctx.beginPath();
  ctx.arc(cx, cy, EXIT_OK_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = COLOR_EXIT;
  ctx.fill();

  const arcRadius = EXIT_OK_RADIUS - EXIT_ARC_WIDTH / 2 - 4;
  ctx.lineWidth = EXIT_ARC_WIDTH;
  ctx.lineCap = "round";
  ctx.strokeStyle = COLOR_EXIT_TRACK;
  ctx.beginPath();
  ctx.arc(cx, cy, arcRadius, 0, Math.PI * 2);
  ctx.stroke();
  if (progress > 0) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = COLOR_EXIT_ARC;
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, start, start + Math.min(1, progress) * Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "700 42px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(hintOnly ? t("key.holdB") : t("callout.exit"), cx, cy - 8);
  ctx.fillStyle = COLOR_MUTED;
  ctx.font = "500 24px 'Segoe UI', sans-serif";
  ctx.fillText(t("vr.exitOverlay.hold"), cx, cy + 44);
  exitTexture.needsUpdate = true;
}

function setExitHoldProgress(progress) {
  ensureExitOverlay();
  if (exitHoldHideTimer !== null) {
    clearTimeout(exitHoldHideTimer);
    exitHoldHideTimer = null;
  }
  anchorExitOverlay();
  exitMesh.visible = progress > 0;
  if (progress > 0) {
    drawExitOverlay(progress, false);
  }
}

function flashExitHoldHint() {
  ensureExitOverlay();
  if (exitHoldHideTimer !== null) {
    clearTimeout(exitHoldHideTimer);
  }
  anchorExitOverlay();
  exitMesh.visible = true;
  drawExitOverlay(0, true);
  exitHoldHideTimer = setTimeout(() => {
    exitHoldHideTimer = null;
    if (exitMesh) {
      exitMesh.visible = false;
    }
  }, 850);
}

function hideExitHoldIndicator() {
  if (exitHoldHideTimer !== null) {
    clearTimeout(exitHoldHideTimer);
    exitHoldHideTimer = null;
  }
  if (exitMesh) {
    exitMesh.visible = false;
  }
}

// Advance (or cancel) the launcher's Exit VR hold from the per-slot flags the
// ray pump just filled in. Runs on EVERY frame the pump runs, including its
// early returns, so there is no path on which a started hold keeps its timer
// after the thing driving it went away.
//
// The head-locked ring is the same one right B and the wrist panel use. Setting
// it here is safe despite input.js calling hideExitHoldIndicator() every frame B
// is not pressed: that runs earlier in the same frame than this pump does.
function updateExitHold(dtS) {
  const prev = exitHold;
  const next = updateRayHoldState(prev, {
    engaged: _slotExitEngaged,
    armed: _slotExitArmed,
    // Exit VR is drawn on two surfaces (launcher row and menu toolbar) and the
    // pump finds it by action type, so without a scope a hold begun on one could
    // be finished by the other if the mode changed under a held trigger.
    scope: panelMode,
    dtS,
    holdSeconds: PANEL_EXIT_HOLD_SECONDS
  });
  exitHold = next;

  if (next.holding && next.progress > 0 && !next.fired) {
    panelExitRingOwned = true;
    setExitHoldProgress(next.progress);
  } else if (!next.holding && next.elapsedS === 0) {
    releasePanelExitRing();
  }
  if (rayHoldAborted(prev, next)) {
    exitHintUntilMs = now() + PANEL_EXIT_HINT_MS;
  }
  // The ring and the hint are both quantised, so this repaints ~24 times across
  // a 1.5 s hold and not at all once the button is idle.
  if (
    panelVisible
    && (panelMode === "idle" || panelMode === "main")
    && currentExitStep() !== lastDrawnExitStep
  ) {
    drawPanel();
  }
  if (next.fired && !prev.fired) {
    releasePanelExitRing();
    void exitVrSession();
  }
}

function releasePanelExitRing() {
  if (!panelExitRingOwned) {
    return;
  }
  panelExitRingOwned = false;
  hideExitHoldIndicator();
}

// Drop any in-flight hold and its cues. Called when the panel goes away under
// the ray — the pump stops running for a hidden panel, so nothing else would.
function resetExitHold() {
  clearSlotExitFlags();
  exitHold = createRayHoldState();
  exitHintUntilMs = 0;
  releasePanelExitRing();
}

// Hit testing

// Map a world-space ray onto the panel and return { x: pixelX, y: pixelY,
// distance } in canvas coordinates, or null if the ray misses the quad. The
// distance lets the ray visual clamp its length and place the cursor dot at the
// hit point without a second raycast.
function rayToCanvas(origin, direction) {
  const mesh = panelMode === "help" ? helpMesh : panelMesh;
  if (!mesh || !panelVisible) {
    return null;
  }
  _raycaster.set(origin, direction);
  const hits = _raycaster.intersectObject(mesh, false);
  if (hits.length === 0) {
    return null;
  }
  const uv = hits[0].uv;
  if (!uv) {
    return null;
  }
  // PlaneGeometry UV: (0,0) bottom-left, (1,1) top-right. Canvas y is
  // top-down, so flip v.
  return {
    // Both surfaces share the same logical 1024x768 layout. Help's physical
    // backing canvas is larger, but its UVs still map to these logical units.
    x: uv.x * CANVAS_WIDTH,
    y: (1 - uv.y) * activePanelSurface().canvasHeight,
    distance: hits[0].distance
  };
}

function hitRectIndexAt(canvasPoint) {
  for (let i = 0; i < hitRects.length; i += 1) {
    const rect = hitRects[i];
    if (
      canvasPoint.x >= rect.x
      && canvasPoint.x <= rect.x + rect.w
      && canvasPoint.y >= rect.y
      && canvasPoint.y <= rect.y + rect.h
    ) {
      return i;
    }
  }
  return -1;
}

// Feed a world-space ray each frame for hover feedback (no click). Desktop
// (DEV) mouse path only — `drawCursor` is true here because there is no
// world-space ray dot on desktop (updateRayVisual() is XR-only), so the canvas
// dot is the pointer feedback. It is event-driven, not per-frame.
function updatePanelRayHover(origin, direction) {
  if (!panelVisible) {
    return false;
  }
  const point = rayToCanvas(origin, direction);
  if (!point) {
    setPanelCursor(null, -1, true);
    return false;
  }
  const index = hitRectIndexAt(point);
  setPanelCursor(point, index, true);
  return true;
}

// `drawCursor` stops the panel repainting its whole canvas every frame. A raw
// raycast UV in float pixels never repeats under hand tracking, so including it in
// the redraw test would cost a full rasterisation and texture upload per frame. In
// XR the canvas dot is redundant: the slot's world-space ray dot is placed at the
// same hit point from the SAME raycast by updateRayVisual(). So the XR pump passes
// drawCursor=false, cursorUV stays null, and the repaint reduces to
// `index !== hoverIndex`. The desktop mouse path keeps the canvas dot.
//
// cursorUV is nulled deliberately rather than left alone: a dot painted by a desktop
// hover would otherwise stay burned into the texture after an XR session takes over.
function setPanelCursor(point, index, drawCursor = false) {
  const nextCursor = drawCursor ? point : null;
  const cursorChanged = nextCursor
    ? (!cursorUV || cursorUV.x !== nextCursor.x || cursorUV.y !== nextCursor.y)
    : Boolean(cursorUV);
  const changed = index !== hoverIndex || cursorChanged;
  cursorUV = nextCursor;
  hoverIndex = index;
  if (changed) {
    drawPanel();
  }
}

// Activate whatever the given world-space ray is currently pointing at.
// Returns true if the ray hit the panel (so the caller can suppress the
// default trigger behavior, e.g. sphere-link activation).
function activatePanelRay(origin, direction) {
  if (!panelVisible) {
    return false;
  }
  const point = rayToCanvas(origin, direction);
  if (!point) {
    return false;
  }
  const index = hitRectIndexAt(point);
  if (index >= 0) {
    runAction(hitRects[index].action);
  }
  return true;
}

// XR controller ray helper (used by input.js)

// Lazily build the two ray lines and the cursor dot. Parented to `scene` (like the
// panel) so world-moves locomotion does not drag them. Each line is a two-vertex
// segment along -Z whose endpoints are rewritten each frame from the controller
// pose; the dot is a small sphere at the panel hit point.
//
// Because they live under `scene`, the WebGL context-restore handler
// (markSceneResourcesForContextRestore in main.js) reaches them via
// scene.traverse() and re-flags their geometry and materials, so GPU buffers are
// re-uploaded after a context loss without rebuilding these JS objects. The
// self-heal in updatePanelXrInput also re-shows them regardless.
function ensureRayVisuals() {
  if (rayVisualsBuilt) {
    return;
  }
  for (let i = 0; i < 2; i += 1) {
    const geometry = new THREE.BufferGeometry();
    // Two vertices: origin and endpoint. Filled per frame.
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({
      color: RAY_COLOR,
      transparent: true,
      opacity: RAY_OPACITY,
      depthTest: false,
      depthWrite: false
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 10001;
    line.visible = false;
    scene.add(line);
    _rayLines[i] = line;
  }
  const dotGeometry = new THREE.SphereGeometry(RAY_DOT_RADIUS_M, 12, 12);
  for (let i = 0; i < _rayDots.length; i += 1) {
    // One material per dot: a shared one could not be tinted per slot later, and
    // disposal is per-mesh anyway.
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: RAY_HIT_COLOR,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false
    });
    const dot = new THREE.Mesh(dotGeometry, dotMaterial);
    dot.renderOrder = 10002;
    dot.frustumCulled = false;
    dot.visible = false;
    scene.add(dot);
    _rayDots[i] = dot;
  }
  // A session can end with a panel still open (Exit VR button, system menu,
  // headset removed): the input pump stops, so nothing else would clear the
  // lines and they would linger in the desktop view. Registered once, here,
  // because the visuals only exist from this point on.
  renderer.xr.addEventListener("sessionend", hideRayVisuals);
  rayVisualsBuilt = true;
}

// Position ray line `index` from origin along direction for RAY_LENGTH_M,
// clamped to `hitDistance` when the caller's raycast produced one (reused — no
// second cast). The endpoint is recorded in `_rayEnds[index]` for the dot.
function updateRayVisual(index, origin, direction, hitDistance) {
  if (!rayVisualsBuilt) {
    return;
  }
  const line = _rayLines[index];
  if (!line) {
    return;
  }
  const length = hitDistance != null ? hitDistance : RAY_LENGTH_M;
  _rayEnd.copy(origin).addScaledVector(direction, length);
  // The line starts ahead of the aim pose, not at it: WebXR's targetRaySpace origin
  // sits back in the hand, so a line drawn from it emerges from the middle of the
  // controller model rather than the front. Only the DRAWING moves; the cast still
  // starts at the true origin. A fixed push along the aim direction rather than the
  // model's trigger node, because the ray must draw for profiles with no model at
  // all (hands.js degrades to ray-only outside the vendored profiles). Beam still
  // sprouts from the hand -> raise; it floats ahead of the controller -> lower.
  _rayVisualStart.copy(origin).addScaledVector(direction, RAY_VISUAL_START_M);
  const positions = line.geometry.getAttribute("position");
  positions.setXYZ(0, _rayVisualStart.x, _rayVisualStart.y, _rayVisualStart.z);
  positions.setXYZ(1, _rayEnd.x, _rayEnd.y, _rayEnd.z);
  positions.needsUpdate = true;
  line.visible = true;
  if (_rayEnds[index]) {
    _rayEnds[index].copy(_rayEnd);
  }
}

// Hide all ray visuals (called when no controller is aiming or the panel closes).
function hideRayVisuals() {
  if (!rayVisualsBuilt) {
    return;
  }
  for (const line of _rayLines) {
    if (line) {
      line.visible = false;
    }
  }
  for (const dot of _rayDots) {
    if (dot) {
      dot.visible = false;
    }
  }
}

// Reads an input source's target-ray pose into the shared scratch vectors and
// returns true if a pose landed this frame. Expressed in the reference space the rest
// of the XR input pump uses, which is the space the panel and lines live in.
//
// The pose comes straight from the XRFrame rather than renderer.xr.getController(index):
// three binds an input source to a controller slot only if that slot object ALREADY
// EXISTS when `inputsourceschange` fires, and drops the whole event otherwise, which
// leaves controller matrices at identity and draws no ray for the session. The frame
// pose sidesteps that and is handedness-correct (getController() indexes by
// connection order, not by hand).
function getSourceRay(source, frame, referenceSpace, outOrigin, outDirection) {
  if (!source || !frame || !referenceSpace) {
    return false;
  }
  const pose = frame.getPose(source.targetRaySpace, referenceSpace);
  if (!pose) {
    return false;
  }
  _rayMatrix.fromArray(pose.transform.matrix);
  outOrigin.setFromMatrixPosition(_rayMatrix);
  outDirection.set(0, 0, -1).transformDirection(_rayMatrix).normalize();
  return true;
}

// Which hand's ray the panel draws, cached on the setting it comes from (same
// pattern as the cosine cache in wrist-summon.js): read every frame, and
// resolveFreeHand() allocates. Keyed on the raw setting value so a change takes
// effect immediately. The sentinel is an object so the first call can never match a
// real value, including `undefined`.
const _SELECT_HAND_UNSET = {};
let _selectHandSetting = _SELECT_HAND_UNSET;
let _selectHandValue = null;
function selectHandedness() {
  if (_selectHandSetting !== state.wristPanelHand) {
    _selectHandSetting = state.wristPanelHand;
    _selectHandValue = resolveFreeHand(state.wristPanelHand);
  }
  return _selectHandValue;
}

// Extra ray-selectable surfaces (the wrist panels)

// wristui.js imports this module, so the import edge can only run one way; the
// wrist panels therefore hand their quads to the pump below through a PROVIDER
// rather than being imported here. Same registry shape, and the same reason, as
// capture-hide.js.
//
// The provider is asked once per ray SOURCE per frame, with that source's
// handedness, for the surfaces that source may select right now — so every
// eligibility rule (is the panel summoned, is this the arm wearing it) stays in
// the module that holds the facts. A surface is
// `{ mesh, hover(uv, ray), activate(uv, ray) }`; `uv` is the plane's own 0..1
// hit coordinate, which keeps wrist geometry out of this file.
//
// `ray` is `{ slot, held }` — which ray slot is on the surface and whether that
// slot's trigger is still down. A surface with a HOLD-to-activate control needs
// both: `activate` is an edge and can never complete a hold, so the surface
// times one from the level (updateRayHoldState in xr-ray-sources.js) with the
// slot as the per-ray key. Surfaces without one ignore the second argument.
const EMPTY_RAY_TARGETS = Object.freeze([]);
let extraRayTargetProvider = null;

function registerRayTargets(provider) {
  extraRayTargetProvider = typeof provider === "function" ? provider : null;
  return () => {
    if (extraRayTargetProvider === provider) {
      extraRayTargetProvider = null;
    }
  };
}

// A provider that throws costs the frame its extra targets, never the world
// panel's own ray — the same "the important thing still happens" posture
// collectCaptureHideables() takes.
function extraRayTargetsFor(handedness) {
  if (!extraRayTargetProvider) {
    return EMPTY_RAY_TARGETS;
  }
  try {
    return extraRayTargetProvider(handedness) || EMPTY_RAY_TARGETS;
  } catch {
    return EMPTY_RAY_TARGETS;
  }
}

// ONE cast per ray source, over every surface that source may select this
// frame, nearest hit wins. That ordering IS the wrist panel's priority rule: a
// summoned panel sits ~0.4 m from the ray origin and the world panel at 2.4 m,
// so a small near-field surface the user has deliberately raised into view can
// never be shot through. The single result drives hover, the ray's clamped
// length and the cursor dot — casting a second time for any of those is the bug
// this shape exists to prevent.
//
// Returns null on a miss, `{ distance, target, uv }` for an extra surface, or
// `{ distance, point }` in canvas pixels for the world panel.
const _rayMeshes = [];
function castSelectionRay(origin, direction, extras) {
  _rayMeshes.length = 0;
  for (const target of extras) {
    if (target?.mesh) {
      _rayMeshes.push(target.mesh);
    }
  }
  const worldMesh = panelVisible ? (panelMode === "help" ? helpMesh : panelMesh) : null;
  if (worldMesh) {
    _rayMeshes.push(worldMesh);
  }
  if (_rayMeshes.length === 0) {
    return null;
  }
  _raycaster.set(origin, direction);
  const hit = _raycaster.intersectObjects(_rayMeshes, false)[0];
  if (!hit || !hit.uv) {
    return null;
  }
  if (hit.object === worldMesh) {
    // PlaneGeometry UV: (0,0) bottom-left, (1,1) top-right. Canvas y is
    // top-down, so flip v. Both world surfaces share the same logical
    // 1024x768 layout; help's backing canvas is larger but its UVs still map to
    // these logical units.
    return {
      distance: hit.distance,
      point: {
        x: hit.uv.x * CANVAS_WIDTH,
        y: (1 - hit.uv.y) * activePanelSurface().canvasHeight,
        distance: hit.distance
      }
    };
  }
  for (const target of extras) {
    if (target?.mesh === hit.object) {
      return { distance: hit.distance, target, uv: hit.uv };
    }
  }
  return null;
}

// Per-frame XR hover + optional trigger activation. Called from input.js so there is
// a single XR input pump. `selectEdges` is
// `{ left, right, any, held: { left, right, any }, dtS }`: per-handedness select
// EDGES from input.js's latches, the same flags as LEVELS, and the frame delta for
// the launcher's one hold-to-activate control. A slot activates only on its OWN
// hand's edge (slotSelectEdge). Returns true if a ray-selectable surface consumed
// this frame's input (so sphere-link activation should be skipped).
//
// Runs whether or not the WORLD panel is open: the wrist panels are a second
// ray-targetable surface, summonable in every app state. input.js only swallows a
// missed trigger while the world panel is open; see its call site.
const _slotExtras = [];
const _slotHits = [null, null];
// The subset of _slotHits that landed on the WORLD panel, for the one thing
// still arbitrated across slots: its canvas draws a single hover highlight.
const _slotWorldHits = [null, null];
// Per-slot inputs to the Exit VR hold, refilled every frame. Cleared on every
// early return below, so a frame that never reaches the cast cancels a hold in
// progress instead of freezing its timer.
const _slotExitEngaged = [false, false];
const _slotExitArmed = [false, false];
// The second argument to a ray target's hover()/activate(). Reused and mutated
// rather than allocated per hit — the callee reads it synchronously.
const _ray = { slot: -1, held: false };
function clearSlotExitFlags() {
  for (let slot = 0; slot < _slotExitEngaged.length; slot += 1) {
    _slotExitEngaged[slot] = false;
    _slotExitArmed[slot] = false;
  }
}
function updatePanelXrInput(selectEdges) {
  const dtS = Number.isFinite(selectEdges?.dtS) ? selectEdges.dtS : 0;
  const session = renderer.xr.getSession?.();
  // Slot 0 is the SELECT hand, slot 1 the other; a null slot has no live source.
  // Passing the select hand also silences the ray of a tracked hand that cannot
  // select — see the header of xr-ray-sources.js. Controllers keep both rays.
  const slotSources = selectRaySlotSources(session?.inputSources, _rayLines.length, {
    selectHandedness: selectHandedness()
  });
  // Copied into per-slot buffers rather than held by reference — the provider
  // hands back one shared array. See fillSlotRayTargets().
  fillSlotRayTargets(slotSources, extraRayTargetsFor, _slotExtras);
  let anyTarget = panelVisible;
  for (const extras of _slotExtras) {
    anyTarget = anyTarget || extras.length > 0;
  }
  if (!anyTarget) {
    // Nothing on screen to point at. No visuals, and — importantly for the
    // tunnel — no cast and no allocation either.
    hideRayVisuals();
    clearSlotExitFlags();
    updateExitHold(dtS);
    return false;
  }
  if (panelVisible) {
    stabilizePanelAnchor();
  }
  // Self-heal: while any selection surface (main panel / keyboard / help / a
  // summoned wrist panel) is open and a ray source exists, make sure the visuals
  // are built. This is idempotent — ensureRayVisuals() no-ops once built, so
  // there's no per-frame allocation. It covers the ordering where the panel
  // opened before the controllers connected (first-session entry): the lines get
  // built the first frame a source appears rather than staying absent for the
  // whole session.
  if (slotSources.some(Boolean)) {
    ensureRayVisuals();
  }
  if (!rayVisualsBuilt) {
    // No source yet (controllers still connecting, or gaze/screen input only).
    // Nothing to draw this frame; try again next frame.
    clearSlotExitFlags();
    updateExitHold(dtS);
    return false;
  }
  const frame = renderer.xr.getFrame();
  const referenceSpace = renderer.xr.getReferenceSpace();
  // Cast every live slot — still exactly ONE cast per source. Everything below
  // reads those results; nothing casts again.
  for (let slot = 0; slot < _rayLines.length; slot += 1) {
    _slotHits[slot] = null;
    if (!getSourceRay(slotSources[slot], frame, referenceSpace, _rayOrigin, _rayDir)) {
      // Hide every slot without a live pose, not just the ones we tried to read:
      // a controller that disconnects mid-session (or never existed) must not
      // leave its last line frozen on screen.
      if (_rayLines[slot]) {
        _rayLines[slot].visible = false;
      }
      continue;
    }
    const hit = castSelectionRay(_rayOrigin, _rayDir, _slotExtras[slot]);
    _slotHits[slot] = hit;
    updateRayVisual(slot, _rayOrigin, _rayDir, hit ? hit.distance : null);
  }

  // Hover, per slot: both rays highlight what they are on at the same time.
  // Only the world panel's single hover index has to be arbitrated, because its
  // canvas can draw one. A wrist panel needs no arbitration — isWristRaySelectable()
  // already gives each panel to exactly one arm's ray.
  let anyHit = false;
  for (let slot = 0; slot < _slotHits.length; slot += 1) {
    const hit = _slotHits[slot];
    _slotWorldHits[slot] = hit && !hit.target ? hit : null;
    const dot = _rayDots[slot];
    if (dot) {
      dot.visible = Boolean(hit);
      if (hit) {
        dot.position.copy(_rayEnds[slot]);
      }
    }
    if (!hit) {
      continue;
    }
    anyHit = true;
    if (hit.target) {
      // The wrist panel draws its own hover from this and clears it each frame,
      // so a ray that has moved off stops highlighting with no release path here.
      // The trigger LEVEL rides along because the surface may carry a hold-to-
      // activate row, and a hold has to keep asking; a ray that leaves the
      // surface simply stops reporting, which is the cancel.
      _ray.slot = slot;
      _ray.held = slotSelectHeld(slotSources[slot], selectEdges?.held);
      hit.target.hover(hit.uv, _ray);
    }
  }
  if (panelVisible) {
    const cursorSlot = pickPointerSlot(_slotWorldHits);
    const worldHit = cursorSlot >= 0 ? _slotWorldHits[cursorSlot] : null;
    // drawCursor is left false on purpose (see setPanelCursor): the per-slot
    // dots, positioned above from those same raycasts, ARE the cursor in XR.
    // Passing true would repaint the whole panel canvas every frame, because the
    // float UV never repeats under hand tracking.
    setPanelCursor(
      worldHit ? worldHit.point : null,
      worldHit ? hitRectIndexAt(worldHit.point) : -1
    );
  }

  // Exit VR hold, per slot. Reads the hits the loop above already produced —
  // no second cast — and the trigger's LEVEL for that slot, because a hold has
  // to keep asking. A slot whose source vanished resolves to false on both
  // flags, so a disconnect cancels the hold rather than freezing it.
  for (let slot = 0; slot < _slotHits.length; slot += 1) {
    const worldHit = _slotWorldHits[slot];
    const rect = worldHit ? hitRects[hitRectIndexAt(worldHit.point)] : null;
    const onExit = rect?.action?.type === "exitHold";
    _slotExitArmed[slot] = onExit && slotSelectEdge(slotSources[slot], selectEdges);
    _slotExitEngaged[slot] = onExit && slotSelectHeld(slotSources[slot], selectEdges?.held);
  }
  updateExitHold(dtS);

  // Activation, per slot and on that slot's OWN trigger. A slot whose trigger
  // fired at nothing leaves the edge UNCONSUMED, which is what lets an ordinary
  // sphere select through — the other controller may well be resting on a menu
  // at the time, and that is not this trigger's business.
  let consumedEdge = false;
  let unconsumedEdge = false;
  for (let slot = 0; slot < _slotHits.length; slot += 1) {
    if (!slotSelectEdge(slotSources[slot], selectEdges)) {
      continue;
    }
    const hit = _slotHits[slot];
    if (!hit) {
      unconsumedEdge = true;
      continue;
    }
    // A hit anywhere on a surface counts as consumed even between its buttons:
    // that is the "no navigating behind the menu" rule, not an accident.
    consumedEdge = true;
    if (hit.target) {
      // The press EDGE, which is what ARMS a hold on the surface as well as
      // what fires its ordinary rows — see the ray-target contract above.
      _ray.slot = slot;
      _ray.held = true;
      hit.target.activate(hit.uv, _ray);
      continue;
    }
    const hitIndex = hitRectIndexAt(hit.point);
    if (hitIndex >= 0) {
      runAction(hitRects[hitIndex].action);
    }
  }
  if (unconsumedEdge) {
    return false;
  }
  return consumedEdge || anyHit;
}

// Desktop (DEV) mouse hit-testing, verifiable without a headset

// Cast a ray from the desktop camera through a normalized device coordinate
// and try to activate the panel. Returns true if it hit the panel.
function handleDesktopPointer(ndcX, ndcY, activate) {
  if (!panelVisible) {
    return false;
  }
  _ndc.set(ndcX, ndcY);
  _raycaster.setFromCamera(_ndc, camera);
  const hovered = updatePanelRayHover(_raycaster.ray.origin, _raycaster.ray.direction);
  if (hovered && activate) {
    return activatePanelRay(_raycaster.ray.origin, _raycaster.ray.direction);
  }
  return hovered;
}

// Visibility control

function showPanel() {
  // Opening the main panel supersedes any help view (ONE panel at a time).
  panelMode = "main";
  ensurePanel();
  panelVisible = true;
  panelMesh.visible = true;
  helpMesh.visible = false;
  anchorPanel();
  panelAnchorStabilizeUntil = now() + PANEL_ANCHOR_STABILIZE_MS;
  setPanelCursor(null, -1);
  // Probe server STT capability once the panel is shown; redraw the mic label
  // if it flips. Guarded and best-effort — the keyboard fallback covers failure.
  if (!isVoiceSupported()) {
    void isServerSttEnabled().then((enabled) => {
      if (enabled !== serverSttEnabled) {
        serverSttEnabled = enabled;
        if (panelVisible) {
          drawPanel();
        }
      }
    });
  }
  drawPanel();
}

// Help panel: reuses the same quad; one panel open at a time. Opening help closes
// the main panel content (switches panelMode) and vice versa.

function showHelpPanel() {
  ensurePanel();
  // Cancel any in-flight text-entry / dictation / confirm before switching.
  stopVoiceSession();
  voiceStatusText = null;
  clearTranscriptTimers();
  pendingTranscript = null;
  closeKeyboard();
  helpView = "basic";
  helpControllerSide = "left";
  panelMode = "help";
  panelVisible = true;
  panelMesh.visible = false;
  helpMesh.visible = true;
  anchorPanel();
  panelAnchorStabilizeUntil = now() + PANEL_ANCHOR_STABILIZE_MS;
  setPanelCursor(null, -1);
  drawPanel();
}

function hideHelpPanel() {
  // Closing help closes the panel entirely (symmetric with a fresh toggle).
  if (panelMode === "help") {
    hidePanel();
  }
}

function toggleHelpPanel() {
  if (panelVisible && panelMode === "help") {
    hidePanel();
  } else {
    showHelpPanel();
  }
}

function isHelpVisible() {
  return panelVisible && panelMode === "help";
}

// Idle start panel (VR): the auto-shown launcher. Shares the quad and ray/hit-test
// path with the menu; its lifecycle is driven per-frame from updateVrIdlePanel(), so
// it appears whenever the viewer is idle in the tunnel and vanishes when content
// loads or the menu/help opens.

function isIdlePanelVisible() {
  return panelVisible && panelMode === "idle";
}

function showIdlePanel() {
  ensurePanel();
  // The idle launcher is the "you have not asked for anything yet" screen, so
  // arriving at it drops any earlier mode choice — otherwise the next promote
  // would inherit a stale one.
  modeChosenExplicitly = false;
  panelMode = "idle";
  panelVisible = true;
  panelMesh.visible = true;
  helpMesh.visible = false;
  anchorPanel();
  panelAnchorStabilizeUntil = now() + PANEL_ANCHOR_STABILIZE_MS;
  setPanelCursor(null, -1);
  drawPanel();
}

// True when the idle launcher should currently be up: only in an active XR
// session, only while in the tunnel, only with nothing loaded/queued, and only
// when no other panel (menu/help/keyboard/confirm) is already open.
function shouldShowIdlePanel() {
  return renderer.xr.isPresenting
    && state.appState === AppState.TUNNEL
    && shouldShowStartFavorites()
    && (!panelVisible || panelMode === "idle");
}

// Per-frame idle-panel driver (called from renderFrame). Opens the launcher
// when the idle conditions hold and closes it the instant they stop — e.g. a
// tile/voice load fills extractedItems, or the viewer opens the menu/help.
function updateVrIdlePanel() {
  const want = shouldShowIdlePanel();
  if (want && !isIdlePanelVisible()) {
    showIdlePanel();
  } else if (!want && isIdlePanelVisible()) {
    hidePanel();
  }
}

// DEV-only test bridge: exposes the hit-rects and a canvas-point→world-point
// mapper so a headless-browser harness can project a bookmark cell to screen
// coordinates and drive the real desktop mouse path. Never referenced in prod.
function __devTestBridge() {
  return {
    visible: panelVisible,
    mesh: activePanelSurface().mesh,
    activeMode: activeModeId,
    genAiEnabled,
    voiceSupported: isVoiceSupported(),
    voiceListening: Boolean(voiceSession),
    serverSttEnabled,
    keyboardOpen,
    keyboardText,
    // Transcript confirmation.
    panelMode,
    pendingTranscript,
    confirmProgress: transcriptConfirmProgress(),
    // Ray visuals: report built/visible state so a harness can assert the
    // lines/dot exist and toggle with panel visibility.
    rayVisualsBuilt,
    rayLinesVisible: _rayLines.map((line) => Boolean(line && line.visible)),
    rayDotsVisible: _rayDots.map((dot) => Boolean(dot && dot.visible)),
    // Disabled cells carry a null action; report type "disabled" so a harness
    // can still see (and skip) them.
    hitRects: hitRects.map((r) => ({
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      type: r.action?.type || "disabled",
      modeId: r.action?.modeId || null,
      view: r.action?.view || null,
      side: r.action?.side || null,
      char: r.action?.char ?? null
    })),
    canvasWidth: activePanelSurface().canvasWidth,
    canvasHeight: activePanelSurface().canvasHeight,
    panelWidthM: activePanelSurface().widthM,
    panelHeightM: activePanelSurface().heightM,
    backingCanvasWidth: activePanelSurface().backingCanvasWidth,
    backingCanvasHeight: activePanelSurface().backingCanvasHeight,
    helpPanelScale: HELP_PANEL_SCALE,
    // Map a canvas pixel (px, py) to a world point on the quad surface.
    // Local units are the unscaled geometry's: matrixWorld already carries the
    // idle crop's scale.y.
    canvasToWorld(px, py) {
      const surface = activePanelSurface();
      const u = px / surface.canvasWidth;
      const v = 1 - py / surface.canvasHeight;
      const local = new THREE.Vector3((u - 0.5) * surface.widthM, (v - 0.5) * (surface.heightM / surface.mesh.scale.y), 0);
      return local.applyMatrix4(surface.mesh.matrixWorld).toArray();
    },
    // Project a canvas pixel on the quad to normalized device coords using the
    // real desktop camera, so a harness can dispatch an accurate mouse event.
    canvasToNdc(px, py) {
      const surface = activePanelSurface();
      const u = px / surface.canvasWidth;
      const v = 1 - py / surface.canvasHeight;
      const world = new THREE.Vector3((u - 0.5) * surface.widthM, (v - 0.5) * (surface.heightM / surface.mesh.scale.y), 0)
        .applyMatrix4(surface.mesh.matrixWorld);
      world.project(camera);
      return { x: world.x, y: world.y };
    },
    // Harness-only controls so a headless test can open the panel and drive the
    // keyboard/routing path without synthesizing an XR controller pose. These go
    // through the SAME runAction() the real ray/pointer path uses.
    open() {
      showPanel();
    },
    close() {
      hidePanel();
    },
    setMode(modeId) {
      setActiveMode(modeId);
    },
    // Harness hooks: help panel.
    helpVisible: isHelpVisible(),
    helpView,
    helpControllerSide,
    toggleHelp() {
      toggleHelpPanel();
    },
    // Harness hooks: drive the confirmation UI without a live mic.
    simulateTranscript(text) {
      beginTranscriptConfirm(text);
    },
    confirmTranscript() {
      confirmTranscript();
    },
    cancelTranscript() {
      cancelTranscript();
    },
    // Activate whatever hit-rect covers canvas pixel (px, py) — the real click
    // outcome, minus the raycast (which needs a live camera the harness lacks
    // headlessly). Returns the fired action type, or null on a miss.
    activateCanvas(px, py) {
      for (let i = 0; i < hitRects.length; i += 1) {
        const rect = hitRects[i];
        if (px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h) {
          runAction(rect.action);
          return rect.action?.type || null;
        }
      }
      return null;
    }
  };
}

function hidePanel() {
  panelVisible = false;
  panelAnchorStabilizeUntil = 0;
  cursorUV = null;
  hoverIndex = -1;
  resetExitHold();
  // Cancel any in-flight dictation so the mic isn't left listening off-screen.
  stopVoiceSession();
  voiceStatusText = null;
  // Discard any pending transcript-confirmation so its auto-confirm timer/RAF
  // can't fire a query after the panel is gone.
  clearTranscriptTimers();
  pendingTranscript = null;
  helpView = "basic";
  helpControllerSide = "left";
  panelMode = "main";
  // A mode choice belongs to the panel session it was made in: a viewer who
  // closed the panel and comes back with still nothing loaded gets the start
  // favourites again, which is the right first screen.
  modeChosenExplicitly = false;
  // Close the keyboard so it doesn't reopen mid-composition next time.
  closeKeyboard();
  if (panelMesh) {
    panelMesh.visible = false;
  }
  if (helpMesh) {
    helpMesh.visible = false;
  }
  hideRayVisuals();
}

function togglePanel() {
  // If help or the idle launcher is up, the main-panel toggle switches to the
  // full menu rather than just closing (all three share the quad; ONE shown at
  // a time). From the idle panel this makes left X "open the menu" as labeled.
  if (panelVisible && panelMode === "idle") {
    showMenuFromIdle();
    return;
  }
  if (panelVisible && panelMode === "help") {
    showPanel();
    return;
  }
  if (panelVisible) {
    hidePanel();
  } else {
    showPanel();
  }
}

function isPanelVisible() {
  return panelVisible;
}

// How far below eye level the visible panel's BOTTOM edge sits, or null when no
// panel is up. The status footer (ui.js) uses it to get out of the way: both are
// anchored at 2.4 m, so the footer would otherwise cross the menu and the taller
// help page. Published as a number so the footer never re-derives panel geometry.
function visiblePanelBottomOffset() {
  if (!panelVisible) {
    return null;
  }
  return PANEL_HEIGHT_OFFSET - (activePanelSurface().heightM / 2);
}

function setVrPanelGenAiEnabled(enabled) {
  genAiEnabled = Boolean(enabled);
  // If GenAI just got gated off while it was the active mode, fall back to the
  // default so the grid never sits empty on a now-disabled mode.
  if (!genAiEnabled && !modeEnabled(activeMode())) {
    activeModeId = DEFAULT_MODE_ID;
  }
  if (panelVisible) {
    drawPanel();
  }
}

// Wrist launcher bridge
// The launcher is a summon surface, not a second menu: it owns no panel state and
// duplicates no panel logic. It reads the mode list through this accessor (the same
// MODES array and modeEnabled() server gate as the panel's own mode row, so a
// GenAI-disabled server greys the wrist item and the panel tab identically) and
// promotes through showPanelForMode().
//
// runAction({type:"statusFooter"}) is still exported: the panel's own "Show info"
// cell calls it and is the only route to the toggle. Do not remove it.
//
// The launcher can be summoned while the panel is already open, so it doubles as
// the hands-only close/switch control: wristui.js reads `active` off
// launcherSections(), then calls hidePanel() directly or routes a plain
// runAction({type:"mode"}) (setActiveMode() only, no second showPanel()/re-anchor);
// Help gets the same via toggleHelpPanel(). All three stay exported for this.

function launcherSections() {
  return MODES.map((mode) => ({
    id: mode.id,
    label: mode.label,
    color: mode.color,
    enabled: modeEnabled(mode),
    active: mode.id === activeModeId
  }));
}

// Open the world panel with a mode tab already selected. setActiveMode() keeps
// its own guards (unknown id, gated-off mode) and is where the explicit-choice
// flag is set, which is what makes this show the mode's BOOKMARKS rather than
// the start-favourites shortcut (see modeChosenExplicitly).
//
// `reanchor: false` is the switch-in-place case: the world panel is already open
// in front of the user and calling showPanel() again would re-anchor a panel
// they can see perfectly well. setActiveMode() has already redrawn it.
// From the launcher, the menu opens on a category's full favourites with the
// Web/Image/GenAI row above it — never on the same three tiles again, which
// would make "More…" change only the bottom row.
function showMenuFromIdle() {
  showPanelForMode(activeModeId);
}

function showPanelForMode(modeId, { reanchor = true } = {}) {
  setActiveMode(modeId);
  if (reanchor || !panelVisible || panelMode !== "main") {
    showPanel();
  }
}

// Diagnostics only (the `wristpoke` event in wristui.js): which mode the panel is
// on, and whether it is showing the start-favourites shortcut rather than that
// mode's bookmarks.
function activeVrPanelMode() {
  return activeModeId;
}

function isStartFavoritesShowing() {
  return panelVisible
    && panelMode === "main"
    && !keyboardOpen
    && !modeChosenExplicitly
    && shouldShowStartFavorites();
}

// Where the open world panel IS, for the wrist panels' "is the user looking at the
// world menu?" test, so they collapse to icons while it is read. Deliberately a
// POSITION rather than a second answer to "is the user looking at it": wristui.js owns the
// head pose and cone test (withinCone()), and two notions that could disagree must
// not exist. Writes into the caller's vector (no allocation on the frame path) and
// returns false when nothing is open, including the help view mid-fade and the
// never-built case.
function readPanelWorldPosition(out) {
  if (!panelVisible) {
    return false;
  }
  const mesh = activePanelSurface().mesh;
  if (!mesh) {
    return false;
  }
  mesh.getWorldPosition(out);
  return true;
}

function setVrPanelSttEnabled(enabled) {
  const next = Boolean(enabled);
  if (serverSttEnabled === next) {
    return;
  }
  serverSttEnabled = next;
  if (panelVisible) {
    drawPanel();
  }
}

// Screen capture: every surface this module parents to the scene, in one accessor,
// so screenshot.js never reaches into module-private meshes: the main panel, the
// help panel, the head-locked exit-hold ring and the controller ray visuals. Any
// can be null (built lazily; a hands-only session never creates the rays), which
// hideForCapture() skips.
function panelCaptureHideables() {
  return [panelMesh, helpMesh, exitMesh, _rayLines[0], _rayLines[1], _rayDots[0], _rayDots[1]];
}

registerCaptureHideables(panelCaptureHideables);

export {
  togglePanel,
  showPanel,
  hidePanel,
  isPanelVisible,
  visiblePanelBottomOffset,
  toggleHelpPanel,
  hideHelpPanel,
  isHelpVisible,
  isIdlePanelVisible,
  updateVrIdlePanel,
  setVrPanelGenAiEnabled,
  setVrPanelSttEnabled,
  setExitHoldProgress,
  flashExitHoldHint,
  hideExitHoldIndicator,
  followPanelAnchorToViewer,
  refreshPanelAnimation,
  updatePanelXrInput,
  registerRayTargets,
  handleDesktopPointer,
  // Wrist launcher bridge: see the block above.
  launcherSections,
  showPanelForMode,
  showHelpPanel,
  activeVrPanelMode,
  isStartFavoritesShowing,
  readPanelWorldPosition,
  runAction as runPanelAction,
  __devTestBridge
};
