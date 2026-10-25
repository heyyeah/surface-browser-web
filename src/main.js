import "./styles.css";
import { AppState, SPHERE_EXIT_ACCEL, SPHERE_EXIT_MAX_SPEED } from "./constants.js";
import { DEV_TOOLS_ENABLED, MIC_PREWARM_ENABLED, PASSTHROUGH_ENABLED } from "./config.js";
import { state } from "./state.js";
import { easeTunnelSpeed } from "./tunnel-run.js";
import {
  activateBookmark,
  BookmarkKind,
  bookmarkModeLabel,
  bookmarkTitle,
  isGenAiBookmarksEnabled,
  setBookmarksMenuOpen,
  setGenAiBookmarksEnabled,
  setupBookmarks,
  startFavoriteBookmarks
} from "./bookmarks.js";
import { createControllerMap } from "./controllermap.js";
import {
  bookmarksBtn,
  buildLabel,
  canvas,
  exitVrBtn,
  languageBtn,
  languageMenu,
  focusUrlBtn,
  jumpSphereBtn,
  modeGenAiBtn,
  modeSearchBtn,
  modeUrlBtn,
  rebuildBtn,
  settingsBtn,
  shortcutsBtn,
  shortcutsMenu,
  speedInput,
  sphereOnboarding,
  startPanel,
  urlInput
} from "./dom.js";
import {
  renderer,
  scene,
  camera,
  timer,
  keyState,
  spherePanels,
  imagePanels,
  DEFAULT_CAMERA_SPEED,
  VR_SESSION_OPTIONS,
  vrSystemButton
} from "./scene.js";
import { clamp } from "./helpers.js";
import { hasNavigableUrlShape } from "../shared/url-shape.js";
import {
  loadAndExtractUrl,
  loadApiCapabilities,
  loadGenAiPrompt,
  loadImageSearch,
  loadRequestByMode
} from "./api.js";
import {
  rebuildTunnel,
  updatePanelSpawning,
  removeExpiredPanels,
  updatePanelFades,
  advanceTunnel,
  updateTunnelDrawRange,
  updateWorldTransform,
  updateTunnelPortalClipPlane,
  flushPendingPanelSpawnsForDebug
} from "./tunnel.js";
import { setupSettings, openSettings, isSettingsOpen } from "./settings.js";
import { jumpToSphereEntryForDebug, updateStateMachine } from "./transitions.js";
import {
  updateSpherePlacement,
  activateSelectedSphereLink,
  activateSelectedSphereImageForGenAi,
  toggleSphereRotation,
  spawnSphereFromExtractedItems
} from "./sphere.js";
import {
  resetTwoHandGesture,
  applyXrControllerInput,
  applyDesktopSphereInput,
  isDesktopSpherePointer,
  recordShiftDragEvent,
  endShiftDragIfShiftReleased,
  applyShiftDragInput,
  recordDesktopPointerEvent,
  applyDesktopPointerSphereInput,
  recordTouchPointerEvent,
  applyTouchSphereInput,
  setupTrackpadPinch,
  applyTrackpadPinchInput,
  markUserInput,
  resetTouchGestures,
  applyNonXrGamepadInput,
  vrJumpToSphere,
  vrPauseSphereRotation
} from "./input.js";
import {
  togglePanel,
  hidePanel,
  toggleHelpPanel,
  isHelpVisible,
  followPanelAnchorToViewer,
  isPanelVisible,
  setVrPanelGenAiEnabled,
  setVrPanelSttEnabled,
  hideExitHoldIndicator,
  handleDesktopPointer,
  refreshPanelAnimation,
  updateVrIdlePanel,
  __devTestBridge
} from "./vrpanel.js";
import {
  normalizeIdleTimeoutMs,
  AUTO_ADVANCE_FREE_IDLE_TIMEOUT_DEFAULT_MS
} from "./idle-auto-advance.js";
import { t, initLanguage, setLanguage, getLanguage, SUPPORTED_LANGUAGES, LANGUAGE_NAMES } from "./i18n.js";
import { createOnboardingState, stepOnboarding, onboardingRowKeys } from "./onboarding.js";
import { setupHandPresence, setupControllerPresence } from "./hands.js";
import { setWristPanelHand, updateWristLauncher } from "./wristui.js";
import { updateControllerCallouts } from "./controller-callouts.js";
import {
  beginPassthroughSession,
  endPassthroughSession,
  offerPassthroughSession,
  passthroughAvailable,
  updatePassthrough
} from "./passthrough.js";
import { startXrDiagnostics, updateXrDiagnostics , logXrEvent } from "./xr-diag.js";
import { prewarmServerSttPermission } from "./voice.js";
import {
  setStatus,
  configureDebugUi,
  updateVrButtonLabel,
  updateVrButtonAvailability,
  isVrUnavailable,
  onVrAvailabilityChange,
  setAddressFeedback,
  focusUrlInput,
  focusSceneCanvas,
  exitVrSession,
  enterVrSession,
  resize,
  updatePerfLabel,
  updateStatusFooter,
  setStatusFooterEnabled,
  setImageListEnabled
} from "./ui.js";

if (DEV_TOOLS_ENABLED) {
  // DEV-only hook for headless harnesses: inspect the in-world panel (hit-rects,
  // quad-to-world projection) and drive the desktop pointer path.
  window.__sbVrPanel = __devTestBridge;

  // DEV-only bridges for the headless GenAI tunnel-to-sphere handoff test: live
  // runtime state and the sphere-panel array (mutated in place by the render
  // loop), plus a direct entry into the production GenAI load path.
  window.__sbState = state;
  window.__sbSpherePanels = spherePanels;
  window.__sbImagePanels = imagePanels;
  window.__sbLoadGenAi = (opts) => loadGenAiPrompt(opts);
  // Force queued tunnel panels to spawn and attach immediately (bypassing the
  // 1300 ms cadence and async texture decode). Same helper as the debug
  // "jump to sphere".
  window.__sbFlushTunnelPanels = () => flushPendingPanelSpawnsForDebug();

  // DEV-only bridge for the VR controller logical actions. Every hook routes
  // through the function the real controller pump calls, not a copy.
  window.__sbVrInput = () => ({
    appState: state.appState,
    panelVisible: isPanelVisible(),
    helpVisible: isHelpVisible(),
    sphereRotationPaused: state.sphereRotationPaused,
    // Right A / Left X — toggle help. Left Y — toggle menu panel.
    toggleHelp: () => toggleHelpPanel(),
    togglePanel: () => togglePanel(),
    // Right stick press — jump to sphere (tunnel only). Returns whether it fired.
    jumpToSphere: () => vrJumpToSphere(),
    // Right grip — pause/resume rotation (sphere only). Returns whether it fired.
    pauseRotation: () => vrPauseSphereRotation(),
    // Left grip held + right trigger: img2img from the aimed image. Returns
    // whether the launch started, so a repeat trigger can be asserted refused.
    genAiChord: () => activateSelectedSphereImageForGenAi()
  });

  // Builds one ordinary web sphere for the desktop Shift+click smoke. The click
  // listener and source-import handoff are production code; only acquisition and
  // transition setup are test scaffolding.
  window.__sbPrepareWebSphereForTest = (item, { forceReady = false } = {}) => {
    if (!state.tunnelSamples) {
      rebuildTunnel();
    }
    state.extractedItems = [item];
    state.currentLoadMode = "url";
    state.currentQuery = item.linkUrl || "https://example.test/page";
    state.cycleRequestInFlight = false;
    state.appState = AppState.TUNNEL;
    state.currentRingFloat = 5;
    state.lastSpawnedPanelRing = 5;
    spawnSphereFromExtractedItems();
    state.appState = AppState.INSIDE_SPHERE;
    state.irisForming = false;
    state.sphereIrisOpenElapsed = Infinity;
    if (forceReady) {
      for (const panel of spherePanels) {
        panel.ready = true;
        panel.mesh.visible = true;
        panel.borderMesh.visible = true;
      }
    }
    return { panelCount: spherePanels.length, appState: state.appState };
  };
}

const buildTimestamp = import.meta.env.DEV ? new Date() : new Date(__BUILD_TIMESTAMP__);
const buildSuffix = import.meta.env.DEV ? " (dev)" : "";
buildLabel.textContent = `Build ${buildTimestamp.toLocaleString()}${buildSuffix}`;
configureDebugUi();

const MAX_FRAME_DT_SECONDS = 1 / 20;
const MATERIAL_TEXTURE_KEYS = [
  "map",
  "alphaMap",
  "aoMap",
  "bumpMap",
  "displacementMap",
  "emissiveMap",
  "envMap",
  "gradientMap",
  "lightMap",
  "metalnessMap",
  "normalMap",
  "roughnessMap",
  "specularMap",
  "transmissionMap"
];

let webGlContextLost = false;
let activeOmnibarMode = "url";
let genAiModeEnabled = false;
let genAiModeVisible = true;

function markMaterialForContextRestore(material) {
  if (!material) {
    return;
  }
  if (Array.isArray(material)) {
    for (const entry of material) {
      markMaterialForContextRestore(entry);
    }
    return;
  }

  for (const key of MATERIAL_TEXTURE_KEYS) {
    if (material[key]?.isTexture) {
      material[key].needsUpdate = true;
    }
  }
  material.needsUpdate = true;
}

function markSceneResourcesForContextRestore() {
  scene.traverse((object) => {
    if (object.geometry) {
      const { attributes, morphAttributes } = object.geometry;
      for (const attribute of Object.values(attributes)) {
        // Interleaved attributes upload through their shared buffer.
        (attribute.data || attribute).needsUpdate = true;
      }
      for (const list of Object.values(morphAttributes || {})) {
        for (const attribute of list) {
          (attribute.data || attribute).needsUpdate = true;
        }
      }
      if (object.geometry.index) {
        object.geometry.index.needsUpdate = true;
      }
    }
    markMaterialForContextRestore(object.material);
  });
}

function setupWebGlContextRecovery() {
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    webGlContextLost = true;
    setStatus(t("status.glLost"), "warning");
  });

  canvas.addEventListener("webglcontextrestored", () => {
    webGlContextLost = false;
    // Swallow the gap accumulated while the context was lost so the first
    // restored frame sees no huge delta.
    timer.reset();
    markSceneResourcesForContextRestore();
    resize();
    setStatus(t("status.glRestored"), true);
  });
}

function inputLooksLikeUrl(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/\s/.test(text) && hasNavigableUrlShape(text);
}

function setActiveOmnibarMode(mode) {
  if (mode === "genai" && !genAiModeEnabled) {
    if (!genAiModeVisible) {
      return;
    }
    void openSettings();
    return;
  }
  if (!["url", "image_search", "genai"].includes(mode)) {
    return;
  }
  activeOmnibarMode = mode;
  updateModeToggleUi();
}

function omnibarModeForBookmarkKind(kind) {
  if (kind === BookmarkKind.IMAGE_SEARCH) {
    return "image_search";
  }
  if (kind === BookmarkKind.GENAI_PROMPT) {
    return "genai";
  }
  return "url";
}

function updateModeToggleUi() {
  const entries = [
    [modeUrlBtn, "url"],
    [modeSearchBtn, "image_search"],
    [modeGenAiBtn, "genai"]
  ];
  for (const [button, mode] of entries) {
    if (!button) {
      continue;
    }
    const active = activeOmnibarMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (modeGenAiBtn) {
    modeGenAiBtn.hidden = !genAiModeVisible;
    modeGenAiBtn.classList.toggle("is-unconfigured", genAiModeVisible && !genAiModeEnabled);
    modeGenAiBtn.setAttribute("aria-disabled", genAiModeEnabled ? "false" : "true");
    modeGenAiBtn.title = t(genAiModeEnabled ? "mode.genai" : "mode.genai.configure");
  }
  if (urlInput) {
    // The placeholder is the only instruction most visitors read, so it offers a
    // GenAI prompt only once the server says a relay exists. index.html ships the
    // shorter string so a public build never flashes the GenAI wording.
    urlInput.placeholder = t(genAiModeVisible ? "omnibar.placeholder.genai" : "omnibar.placeholder");
  }
}

async function runActiveOmnibarMode() {
  hideStartPanel();
  if (activeOmnibarMode === "image_search") {
    await loadImageSearch();
  } else if (activeOmnibarMode === "genai") {
    if (!genAiModeEnabled) {
      await openSettings();
      return;
    }
    await loadGenAiPrompt();
  } else {
    await loadAndExtractUrl();
  }
  focusSceneCanvas();
}

function hideStartPanel() {
  if (startPanel) {
    startPanel.hidden = true;
  }
}

function shouldShowStartPanel() {
  const hasStartupQuery = Boolean((urlInput.value || "").trim());
  // The HTML start panel is hidden behind the in-world idle panel in XR, so a VR
  // bookmark can begin a load without touching this DOM. Treat any extracted
  // content or non-idle state as an active scene, so the panel does not reappear
  // over a live sphere when the session ends.
  const hasLiveScene = state.extractedItems.length > 0 || state.appState !== AppState.TUNNEL;
  return !hasStartupQuery
    && !state.currentQuery
    && !hasLiveScene
    && !state.autoGalleryMode;
}

function renderStartPanel() {
  if (!startPanel) {
    return;
  }
  startPanel.textContent = "";

  const title = document.createElement("h1");
  title.textContent = t("start.aria");
  startPanel.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "start-grid";
  startPanel.appendChild(grid);

  for (const bookmark of startFavoriteBookmarks()) {
    const isGenAi = bookmark.kind === BookmarkKind.GENAI_PROMPT;
    // No relay and no settings cog (a public build): "Configure in settings"
    // would point at a panel that 404s, so drop the tile. Where settings are
    // reachable it stays as the way in to configuring GenAI.
    if (isGenAi && !genAiModeVisible) {
      continue;
    }
    const configured = !isGenAi || isGenAiBookmarksEnabled();
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = `start-tile start-tile-${bookmark.kind}`;
    tile.disabled = false;
    tile.title = configured ? bookmark.value : "Configure GenAI in settings";

    const mode = document.createElement("span");
    mode.className = "start-tile-mode";
    mode.textContent = bookmarkModeLabel(bookmark.kind);
    tile.appendChild(mode);

    const name = document.createElement("span");
    name.className = "start-tile-title";
    name.textContent = configured ? bookmarkTitle(bookmark) : t("vr.configureInSettings");
    tile.appendChild(name);

    const value = document.createElement("span");
    value.className = "start-tile-value";
    value.textContent = bookmark.value;
    tile.appendChild(value);

    tile.addEventListener("click", () => {
      if (isGenAi && !isGenAiBookmarksEnabled()) {
        void openSettings();
        return;
      }
      hideStartPanel();
      void activateBookmark(bookmark);
    });
    grid.appendChild(tile);
  }

  startPanel.hidden = !shouldShowStartPanel();
}

function setShortcutsMenuOpen(open) {
  if (!shortcutsBtn || !shortcutsMenu) {
    return;
  }
  shortcutsMenu.hidden = !open;
  shortcutsBtn.setAttribute("aria-expanded", open ? "true" : "false");
  // Both toggles stopPropagation on their own button so neither window-level
  // close listener hears the other's click; otherwise the panels stack.
  if (open) {
    setBookmarksMenuOpen(false);
    setLanguageMenuOpen(false);
  }
}

function setLanguageMenuOpen(open) {
  if (!languageBtn || !languageMenu) {
    return;
  }
  languageMenu.hidden = !open;
  languageBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    setBookmarksMenuOpen(false);
    setShortcutsMenuOpen(false);
  }
}

function renderLanguageMenu() {
  if (!languageMenu) {
    return;
  }
  languageMenu.textContent = "";
  for (const code of SUPPORTED_LANGUAGES) {
    const button = document.createElement("button");
    button.type = "button";
    // The bookmarks list's row, so the two menus read as one kind of thing.
    button.className = "bookmark-menu-item language-menu-item";
    button.role = "menuitemradio";
    // Each in its own language: a reader looking for German looks for "Deutsch".
    button.textContent = LANGUAGE_NAMES[code];
    button.setAttribute("lang", code);
    button.setAttribute("aria-checked", code === getLanguage() ? "true" : "false");
    button.addEventListener("click", () => {
      setLanguage(code);
      // applyStaticTranslations just reset the placeholder to the non-GenAI string.
      updateModeToggleUi();
      // Rebuild rather than patch: both panels are built from t() at render time.
      renderShortcutsMenu();
      renderLanguageMenu();
      // Re-renders the Bookmarks menu, whose mode chips are translated.
      setGenAiBookmarksEnabled(isGenAiBookmarksEnabled());
      if (!startPanel?.hidden) {
        renderStartPanel();
      }
      setLanguageMenuOpen(false);
    });
    languageMenu.appendChild(button);
  }
}

function toggleShortcutsMenu() {
  setShortcutsMenuOpen(Boolean(shortcutsMenu?.hidden));
}

// Whether the Advanced disclosure was open, so an async re-render (VR
// availability, GenAI capability) does not fold it back up.
let shortcutsAdvancedOpen = false;

// Touch-primary: a phone or tablet with no mouse and no keyboard. `pointer:
// coarse` alone is also true of a touchscreen laptop, which keeps the keyboard
// section.
function isTouchPrimary() {
  try {
    return Boolean(window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches);
  } catch {
    // matchMedia absent or throwing: assume the fuller help.
    return false;
  }
}

function renderShortcutsMenu() {
  if (!shortcutsMenu) {
    return;
  }
  // Both are async and change what belongs in this panel: VR rows for a reader
  // with no headset, or GenAI rows on a server with no relay, promise things
  // that are not available.
  const vrAvailable = !isVrUnavailable();
  const genAiAvailable = genAiModeVisible;

  shortcutsMenu.textContent = "";

  const addRows = (rows, parent = shortcutsMenu) => {
    for (const [key, label] of rows) {
      const row = document.createElement("div");
      row.className = "shortcut-menu-item";
      row.role = "menuitem";

      const keySpan = document.createElement("span");
      keySpan.className = "shortcut-key";
      keySpan.textContent = key;
      row.appendChild(keySpan);

      const labelSpan = document.createElement("span");
      labelSpan.className = "shortcut-label";
      labelSpan.textContent = label;
      row.appendChild(labelSpan);

      parent.appendChild(row);
    }
  };

  const addTitle = (text, parent = shortcutsMenu) => {
    const title = document.createElement("div");
    title.className = "shortcut-section-title";
    title.textContent = text;
    parent.appendChild(title);
  };

  // Where you start: the flat UI says nowhere else that a website, image search
  // or a GenAI prompt can be the starting point.
  const intro = document.createElement("p");
  intro.className = "shortcut-intro";
  intro.textContent = t(genAiAvailable ? "help.intro.genai" : "help.intro");
  // (About) ends the intro sentence and stays in this tab; it is meant to become
  // an overlay here.
  const aboutLink = document.createElement("a");
  aboutLink.href = "https://boxc.net/surfacebrowser.html";
  aboutLink.textContent = t("help.about");
  const githubLink = document.createElement("a");
  githubLink.href = "https://github.com/heyyeah/surface-browser-web";
  githubLink.target = "_blank";
  githubLink.rel = "noopener noreferrer";
  githubLink.className = "shortcut-github";
  githubLink.setAttribute("aria-label", "GitHub");
  githubLink.title = "GitHub";
  const svgNS = "http://www.w3.org/2000/svg";
  const githubIcon = document.createElementNS(svgNS, "svg");
  githubIcon.setAttribute("viewBox", "0 0 16 16");
  githubIcon.setAttribute("aria-hidden", "true");
  const githubPath = document.createElementNS(svgNS, "path");
  // GitHub's mark-github octicon.
  githubPath.setAttribute("d", "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.37A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z");
  githubIcon.appendChild(githubPath);
  githubLink.appendChild(githubIcon);
  intro.append(" (", aboutLink, ") ", githubLink);
  shortcutsMenu.appendChild(intro);

  // Organised by where you are (tunnel, sphere), not by device: the same gesture
  // means different things in the two states (a pinch is speed in the tunnel and
  // zoom in the sphere).
  const touchOnly = isTouchPrimary();
  // On a phone, naming the mouse describes hardware the reader does not have.
  const tapWord = t(touchOnly ? "key.tap" : "key.clickOrTap");

  addTitle(t("help.tunnel.title"));
  // The tunnel has one control per device, and they differ. Pinch does not work
  // on a desktop, so listing it there would be an instruction that does nothing.
  addRows(touchOnly
    ? [[t("key.pinch"), t("act.speed")]]
    : [[t("key.arrowsUpDown"), t("act.speed")]]);

  addTitle(t("help.sphere.title"));
  // Ordered by what a reader on this device reaches for first: on desktop the
  // keyboard, so arrows lead; on a phone only the pointer. Neither list mentions
  // a gesture the device cannot perform.
  const sphereRows = touchOnly
    ? [
      [t("key.tap"), t("act.travel")],
      [t("key.drag"), t("act.turn")],
      [t("key.dragRelease"), t("act.throw")],
      [t("key.pinch"), t("act.zoom")]
    ]
    : [
      // Plain verb: the pause clause belongs to the drag, and Space is below.
      [t("key.arrows"), t("act.turnPlain")],
      [t("key.shiftArrows"), t("act.zoom")],
      [t("key.clickDrag"), t("act.turn")],
      [t("key.clickThrow"), t("act.throw")],
      [t("key.clickEnter"), t("act.travelSelected")],
      [t("key.space"), t("act.pauseRotation")]
    ];
  if (genAiAvailable) {
    sphereRows.push(touchOnly
      ? [t("key.twoFingerHold"), t("act.variations")]
      : [t("key.shiftHold"), t("act.variations")]);
  }
  addRows(sphereRows);

  // VR rows only where there is VR: they answer a question a refused visitor
  // cannot ask. The "why can't I press Enter VR?" answer lives in the VR
  // Unavailable modal (openVrUnavailableDialog in ui.js).
  if (vrAvailable) {
    addTitle(t("help.vr.title"));
    // The two stick presses rhyme (right jumps into the sphere, left back
    // through history), and the GenAI chord is a modifier, so a plain select
    // does not wait for a second trigger.
    const vrRows = [
      [t("key.trigger"), t("act.select")],
      [t("key.thumbstick"), t("act.speedRotate")],
      [t("key.rightStickPress"), t("act.jumpSphere")],
      [t("key.leftStickPress"), t("act.back")],
      [t("key.rightGrip"), t("act.pauseRotation")]
    ];
    if (genAiAvailable) {
      vrRows.push([t("key.gripTrigger"), t("act.variations")]);
    }
    vrRows.push(
      [t("key.holdB"), t("act.exitVr")],
      [t("key.x"), t("act.menuPanel")],
      [t("key.ay"), t("act.helpPanel")]
    );
    addRows(vrRows);
  }

  // Keep in step with the localStorage keys (language, results list, sphere hint).
  addTitle(t("help.privacy.title"));
  const privacy = document.createElement("p");
  privacy.className = "shortcut-intro";
  privacy.textContent = t(genAiAvailable ? "help.privacy.genai" : "help.privacy");
  shortcutsMenu.appendChild(privacy);

  // Advanced is keyboard shortcuts only, so desktop-only: a touch reader would
  // find nothing they can press.
  if (!touchOnly) {
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "shortcut-reveal-btn";
  reveal.textContent = t("help.extraKeys");
  reveal.setAttribute("aria-expanded", shortcutsAdvancedOpen ? "true" : "false");
  shortcutsMenu.appendChild(reveal);

  const advanced = document.createElement("div");
  advanced.className = "shortcut-advanced";
  advanced.hidden = !shortcutsAdvancedOpen;
  shortcutsMenu.appendChild(advanced);
  const advancedRows = [
    // No "," row: the toolbar has a visible Back button.
    ["?", t("nav.help")],
    ["/", t("help.focusUrl")],
    ["Tab", t("help.stepToolbar")],
    // Second spellings of the sphere zoom row.
    [t("key.zoomIn"), t("act.zoomInSphere")],
    [t("key.zoomOut"), t("act.zoomOutSphere")]
  ];
  if (DEV_TOOLS_ENABLED) {
    advancedRows.push(["J", "Jump to sphere entry"]);
    advancedRows.push(["P", "Toggle in-world VR panel"]);
  }
  if (vrAvailable) {
    advancedRows.push([t("vrhelp.rightStickClick"), t("help.adv.jumpTunnel")]);
    advancedRows.push([t("vrhelp.leftStickClick"), t("vrhelp.historyBack")]);
    advancedRows.push([t("key.rightGrip"), t("help.adv.pauseRotation")]);
    // Hands and controller ray both drive this row.
    advancedRows.push([t("help.adv.systemPanel"), t("help.adv.capture")]);
    advancedRows.push([t("help.adv.handsNoPinch"), t("help.adv.handsNoPinchDesc")]);
    if (genAiAvailable) {
      advancedRows.push([t("vrhelp.leftPinchThenRight"), t("vrhelp.emojiVariationsHold")]);
    }
  }
  addRows(advancedRows, advanced);

  reveal.addEventListener("click", (event) => {
    event.stopPropagation();
    shortcutsAdvancedOpen = advanced.hidden;
    advanced.hidden = !shortcutsAdvancedOpen;
    reveal.setAttribute("aria-expanded", shortcutsAdvancedOpen ? "true" : "false");
  });

  // The controller map is a picture of hardware the reader does not have.
  if (vrAvailable) {
    addTitle(t("help.controllerMap"), advanced);
    advanced.appendChild(createControllerMap());
  }
  }

  const credit = document.createElement("div");
  credit.className = "shortcut-copyright";
  credit.append("Surface Browser \u00A9 ");
  const nameLink = document.createElement("a");
  nameLink.href = "https://boxc.net";
  nameLink.target = "_blank";
  nameLink.rel = "noopener noreferrer";
  nameLink.textContent = "Tim Plaisted";
  credit.appendChild(nameLink);
  credit.append(" 2003-2026");
  shortcutsMenu.appendChild(credit);

  // Which build the reader is looking at. The dev-row build label is hidden in a
  // public build, so this is the only place the answer exists. Same
  // buildTimestamp/buildSuffix as the dev row.
  const build = document.createElement("div");
  build.className = "shortcut-build";
  build.textContent = `Build ${compactBuildStamp(buildTimestamp)}${buildSuffix}`;
  shortcutsMenu.appendChild(build);
}

// "29 Aug 2026, 18:10" rather than ISO: readable at a glance, not parseable.
function compactBuildStamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "unknown";
  }
  try {
    return date.toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function setupShortcutsMenu() {
  if (!shortcutsBtn || !shortcutsMenu) {
    return;
  }
  renderShortcutsMenu();
  shortcutsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleShortcutsMenu();
  });
  shortcutsMenu.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  window.addEventListener("click", () => {
    setShortcutsMenuOpen(false);
  });
  // Fires alongside the bookmarks toggle's own handler: stopPropagation stops
  // ancestors, not other listeners on the same element.
  bookmarksBtn?.addEventListener("click", () => {
    setShortcutsMenuOpen(false);
    setLanguageMenuOpen(false);
  });

  if (!languageBtn || !languageMenu) {
    return;
  }
  renderLanguageMenu();
  languageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setLanguageMenuOpen(Boolean(languageMenu.hidden));
  });
  languageMenu.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  window.addEventListener("click", () => {
    setLanguageMenuOpen(false);
  });
}

function keyStateKeyForEvent(event) {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

// First-run sphere onboarding (src/onboarding.js). The persisted flag records
// that the visitor has driven the sphere, not that they saw the overlay, so a
// visitor who watches and does nothing gets it again next sphere.
const SPHERE_INTERACTED_KEY = "surfaceBrowser.sphereInteracted";
let onboardingState = createOnboardingState();
let sphereVisibleSeconds = 0;
let sphereInteractedEver = readSphereInteracted();

function readSphereInteracted() {
  try {
    return window.localStorage?.getItem(SPHERE_INTERACTED_KEY) === "1";
  } catch {
    // A private window throws on read. Showing the overlay twice is a smaller
    // failure than withholding it, so an unreadable store means "no interaction".
    return false;
  }
}

// `?onboarding=1` is the test switch: the stored flag is ignored and forgotten,
// input neither suppresses nor persists, and the delay drops to a second.
const ONBOARDING_FORCE_DELAY_SECONDS = 1;

function readOnboardingForce() {
  try {
    const value = new URLSearchParams(window.location.search).get("onboarding");
    return value === "1" || value === "reset" || value === "force";
  } catch {
    return false;
  }
}

function forgetSphereInteracted() {
  sphereInteractedEver = false;
  try {
    window.localStorage?.removeItem(SPHERE_INTERACTED_KEY);
  } catch {
    // Nothing to forget if the store cannot be reached.
  }
}

const onboardingForced = readOnboardingForce();
if (onboardingForced) {
  forgetSphereInteracted();
}

function stepSphereOnboarding(dt) {
  if (!sphereOnboarding) {
    state.sphereDwellHeldByOnboarding = false;
    return;
  }
  // Must not appear in an immersive session (a DOM element with no
  // `dom-overlay` feature requested in ui.js, so a stalled sphere would be
  // invisible) nor in `?auto=` gallery mode (runs unattended). Treating both as
  // "not in a sphere" also restarts the delay on the way out of VR.
  const inSphere = state.appState === AppState.INSIDE_SPHERE
    && !renderer.xr.isPresenting
    && !state.autoGalleryMode;
  sphereVisibleSeconds = inSphere ? sphereVisibleSeconds + dt : 0;
  // Cleared at the top of every frame and set only by real input paths, so
  // together they mean "the visitor is driving the sphere". Not
  // markSphereInteraction(), which the gaze selector fires itself as the sphere
  // drifts.
  const interactedNow = inSphere
    && (state.sphereRotationInputActive || state.sphereInteractionHold);

  const stepped = stepOnboarding(onboardingState, {
    inSphere,
    elapsedSeconds: sphereVisibleSeconds,
    hasInteractedEver: onboardingForced ? false : sphereInteractedEver,
    interactedNow,
    delaySeconds: onboardingForced ? ONBOARDING_FORCE_DELAY_SECONDS : undefined
  });
  onboardingState = stepped.state;
  // Set before updateStateMachine() runs later this frame, so the hold takes
  // effect on the frame the overlay appears.
  state.sphereDwellHeldByOnboarding = Boolean(stepped.decision.holdDwell);

  if (!onboardingForced && interactedNow && !sphereInteractedEver) {
    sphereInteractedEver = true;
    try {
      window.localStorage?.setItem(SPHERE_INTERACTED_KEY, "1");
    } catch {
      // A failed save must not keep nagging this session.
    }
  }

  if (stepped.decision.justShown || stepped.decision.phaseChanged) {
    renderSphereOnboarding(stepped.decision.phase);
    sphereOnboarding.hidden = false;
  } else if (stepped.decision.justHidden) {
    sphereOnboarding.hidden = true;
  }
}

function renderSphereOnboarding(phase = "full") {
  sphereOnboarding.textContent = "";
  const rows = phase === "tail" ? [] : onboardingRowKeys(isTouchPrimary());
  for (const [keyKey, actionKey] of rows) {
    const row = document.createElement("div");
    row.className = "sphere-onboarding-row";
    const key = document.createElement("span");
    key.className = "sphere-onboarding-key";
    key.textContent = t(keyKey);
    const label = document.createElement("span");
    label.textContent = t(actionKey);
    row.append(key, label);
    sphereOnboarding.appendChild(row);
  }
  const more = document.createElement("div");
  more.className = "sphere-onboarding-more";
  more.textContent = t("onboarding.more");
  sphereOnboarding.appendChild(more);
}

// The speed control is the authority in flat mode, except while a new run is
// giving back what the sphere exit borrowed. In VR there is no input to read,
// so the ease runs against the default directly.
function applyTunnelSpeed(dt) {
  if (state.appState === AppState.EXITING_SPHERE) {
    return;
  }
  const target = renderer.xr.isPresenting
    ? DEFAULT_CAMERA_SPEED
    : Number(speedInput.value);
  if (!state.tunnelSpeedEasing) {
    if (!renderer.xr.isPresenting) {
      state.cameraSpeed = target;
    }
    return;
  }
  const eased = easeTunnelSpeed(state.cameraSpeed, target, dt);
  state.cameraSpeed = eased.speed;
  state.tunnelSpeedEasing = !eased.done;
}

function renderFrame() {
  if (webGlContextLost) {
    return;
  }

  timer.update();
  const dt = Math.min(timer.getDelta(), MAX_FRAME_DT_SECONDS);

  applyTunnelSpeed(dt);
  state.sphereRotationInputActive = false;
  // Both per-frame claims are cleared before any input runs, so neither survives
  // a frame in which nobody set it: sphereRotationInputActive stands down the
  // sphere's idle drift, sphereInteractionHold freezes the dwell clock.
  state.sphereInteractionHold = false;
  applyXrControllerInput(dt);
  applyNonXrGamepadInput(dt);
  applyDesktopSphereInput(dt);
  // The touch path is a per-frame integrator (the grab model needs a dt), so it
  // runs here; the listeners only record where fingers are. It runs after
  // applyXrControllerInput(), which returns immediately when not presenting, so
  // the two are never both live.
  applyTouchSphereInput(dt);
  applyDesktopPointerSphereInput(dt);
  applyShiftDragInput();
  stepSphereOnboarding(dt);
  // The trackpad pinch is stepped per frame because a wheel stream has no end
  // event: its release is a timeout only a frame can notice. The wheel listener
  // only records.
  applyTrackpadPinchInput();

  if (state.appState === AppState.EXITING_SPHERE) {
    state.cameraSpeed = clamp(state.cameraSpeed + SPHERE_EXIT_ACCEL * dt, 4, SPHERE_EXIT_MAX_SPEED);
  }

  // The in-world panel stays up through sphere entry/exit transitions. It is
  // world-anchored where it was opened and a transition flies the viewer metres
  // through it, so it is re-anchored in front of the viewer every frame for the
  // duration and is fixed again once the transition settles. Bookmark/Back
  // activation still hides it directly (see vrpanel.js).
  if (
    isPanelVisible()
    && state.appState !== AppState.TUNNEL
    && state.appState !== AppState.INSIDE_SPHERE
  ) {
    followPanelAnchorToViewer();
  }

  advanceTunnel(dt);

  if (state.appState === AppState.TUNNEL) {
    updatePanelSpawning(dt);
  }
  if (state.appState !== AppState.INSIDE_SPHERE) {
    removeExpiredPanels();
  }
  updatePanelFades(dt);
  updateStateMachine(dt);

  // Drive the VR idle start panel: show it when idle in the tunnel, hide it when
  // content loads or a panel opens. Runs after the state machine so
  // appState/extractedItems are current.
  updateVrIdlePanel();

  // The world panel does not repaint every frame (see setPanelCursor in
  // vrpanel.js). This cheap check keeps its live status line and transcript
  // auto-confirm arc current: two comparisons, repaint only on change.
  refreshPanelAnimation();

  // Passthrough runs after the transition has written this frame's fog, which it
  // must push out of range to stop the blue washing the real room. The wrist
  // launcher (summon/freeze/poke; close/switch/promote the open panel; a
  // controller anchors a panel too) runs after updateVrIdlePanel() so its
  // idle-panel read is current. No-op outside XR.
  updatePassthrough();
  updateWristLauncher();
  // The controller equivalent of the wrist panel: glyph marks on the real
  // buttons, labels on gaze. Runs after it so a multimodal session (hands and
  // controllers) resolves the wrist panels first.
  updateControllerCallouts(renderer.xr.isPresenting);
  updateXrDiagnostics();

  resize();
  updateWorldTransform();
  updateSpherePlacement();
  updateTunnelPortalClipPlane();
  // After updatePassthrough(), which may have pushed the fog out of range.
  updateTunnelDrawRange();
  updateStatusFooter();
  renderer.render(scene, camera);
  updatePerfLabel();
}

focusUrlBtn.addEventListener("click", () => {
  focusUrlInput();
});

modeUrlBtn?.addEventListener("click", () => {
  setActiveOmnibarMode("url");
  focusUrlInput();
});

modeSearchBtn?.addEventListener("click", () => {
  setActiveOmnibarMode("image_search");
  focusUrlInput();
});

modeGenAiBtn?.addEventListener("click", () => {
  setActiveOmnibarMode("genai");
  if (genAiModeEnabled) {
    focusUrlInput();
  }
});

window.addEventListener("surface-browser:bookmark-activated", (event) => {
  setActiveOmnibarMode(omnibarModeForBookmarkKind(event.detail?.kind));
  // Every route into a load closes the start panel, including the bookmarks dropdown.
  hideStartPanel();
});

jumpSphereBtn.addEventListener("click", () => {
  if (!DEV_TOOLS_ENABLED) {
    return;
  }
  jumpToSphereEntryForDebug();
  focusSceneCanvas();
});

rebuildBtn.addEventListener("click", () => {
  rebuildTunnel();
  if (state.currentQuery && !state.cycleRequestInFlight) {
    void loadRequestByMode({
      mode: state.currentLoadMode,
      query: state.currentQuery
    });
  }
});

exitVrBtn.addEventListener("click", () => {
  if (renderer.xr.isPresenting) {
    void exitVrSession();
    return;
  }
  void enterVrSession();
});

// Passthrough is set up here, not in enterVrSession(): a session starts either
// from the app's Enter VR button or three's hidden VRButton (Quest's own VR
// affordance, and per scene.js the path most sessions take). Wiring only the
// app button left `?passthrough=1` inert for the other path. sessionstart fires
// for both, and the session it hands back is the authority on blend mode.
//
// Takes the system VR button's offer over with an AR one. VRButton offers
// `immersive-vr` and the mode is fixed in the offer, so without this the common
// path could never show the room. Done here because scene.js must stay a leaf
// module (see VR_SESSION_OPTIONS).
if (PASSTHROUGH_ENABLED) {
  offerPassthroughSession(vrSystemButton, VR_SESSION_OPTIONS, (session) => {
    void renderer.xr.setSession(session);
  });
}

renderer.xr.addEventListener("sessionstart", () => {
  const session = renderer.xr.getSession();
  beginPassthroughSession(session);
  logXrEvent({
    event: "passthrough.session",
    blendMode: session?.environmentBlendMode || "unknown",
    requested: PASSTHROUGH_ENABLED,
    available: passthroughAvailable()
  });
  // A silent no-op is unhelpful: if passthrough was asked for and the session
  // cannot do it, say so, and say the one thing that might fix it.
  if (PASSTHROUGH_ENABLED && !passthroughAvailable()) {
    setStatus(t("status.passthroughUnavailable"), "warning");
  }
});

renderer.xr.addEventListener("sessionstart", () => {
  updateVrButtonLabel();
});

renderer.xr.addEventListener("sessionend", () => {
  updateVrButtonLabel();
});

updateVrButtonLabel();
// Hand-tracking and controller presence models. Must be set up at boot: three
// only binds an input source to a hand/grip slot that exists when
// `inputsourceschange` fires (see hands.js).
setupHandPresence();
setupControllerPresence();
setupTrackpadPinch();
// The idle clock's DOM half. Capture-phase and passive on `window`, so it sees
// input whichever element handles it and never delays a scroll or gesture. The
// XR/controller half is stamped inside the input pump (input.js).
//
// `pointermove` is included on purpose: a hand nudging the mouse is the
// cheapest true signal that somebody is there, and a still mouse emits nothing,
// so an abandoned tab still goes quiet.
for (const inputEventType of ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"]) {
  window.addEventListener(inputEventType, markUserInput, { passive: true, capture: true });
}
markUserInput();
startXrDiagnostics();
setupBookmarks();
// Before the first render of anything with words in it: applyStaticTranslations
// rewrites the markup's English in place and renderShortcutsMenu reads t() as it
// builds.
initLanguage();
setupShortcutsMenu();
// Both of the panel's conditions are async: isSessionSupported() answers after
// boot, and /api/health decides whether GenAI rows belong
// (configureApiCapabilities re-renders for that).
onVrAvailabilityChange(() => renderShortcutsMenu());

// Cheap and permissionless: isSessionSupported prompts for nothing.
async function supportsImmersiveVr() {
  try {
    return Boolean(await navigator.xr?.isSessionSupported?.("immersive-vr"));
  } catch {
    return false;
  }
}

async function configureApiCapabilities(preloaded = null) {
  try {
    const capabilities = preloaded || await loadApiCapabilities();
    const genAiEnabled = Boolean(capabilities.genai?.enabled);
    genAiModeEnabled = genAiEnabled;
    genAiModeVisible = genAiEnabled || !settingsBtn.hidden;
    if (!genAiModeVisible && activeOmnibarMode === "genai") {
      activeOmnibarMode = "url";
    }
    updateModeToggleUi();
    state.genAiActionsEnabled = genAiEnabled;
    setGenAiBookmarksEnabled(genAiEnabled);
    setVrPanelGenAiEnabled(genAiEnabled);
    setVrPanelSttEnabled(Boolean(capabilities.stt?.enabled));
    setStatusFooterEnabled(capabilities.statusFooter?.enabled !== false);
    setImageListEnabled(capabilities.imageList?.enabled !== false);
    state.imageListLinksEnabled = capabilities.imageList?.links !== false;
    state.imageDownloadsEnabled = capabilities.settings?.enabled === true;
    state.autoAdvanceIdleTimeoutMs = normalizeIdleTimeoutMs(capabilities.autoAdvance?.idleTimeoutMs);
    state.autoAdvanceFreeIdleTimeoutMs = normalizeIdleTimeoutMs(
      capabilities.autoAdvance?.freeIdleTimeoutMs,
      AUTO_ADVANCE_FREE_IDLE_TIMEOUT_DEFAULT_MS
    );
    setWristPanelHand(capabilities.wristPanelHand?.value);
    renderStartPanel();
    renderShortcutsMenu();
    // Only where the mic button exists. The prewarm speeds up the VR panel's mic
    // key; elsewhere it would ask for the microphone for a button nobody sees,
    // and interrupts automated checks.
    if (
      capabilities.stt?.enabled
      && !renderer.xr.isPresenting
      && MIC_PREWARM_ENABLED
      && await supportsImmersiveVr()
    ) {
      void prewarmServerSttPermission();
    }
  } catch {
    genAiModeEnabled = false;
    genAiModeVisible = !settingsBtn.hidden;
    if (!genAiModeVisible && activeOmnibarMode === "genai") {
      activeOmnibarMode = "url";
    }
    updateModeToggleUi();
    state.genAiActionsEnabled = false;
    setGenAiBookmarksEnabled(false);
    setVrPanelGenAiEnabled(false);
    setVrPanelSttEnabled(false);
    setStatusFooterEnabled(true);
    setImageListEnabled(true);
    // Leave autoAdvanceIdleTimeoutMs at its safe default: an unreachable server
    // is not a reason to let an idle tab run.
    // No server value: falls back to the `?wrist=` override, then the default.
    setWristPanelHand(null);
    renderShortcutsMenu();
    renderStartPanel();
  }
}

// Reveal the settings cog unless the server hides it, and refresh capabilities
// after a save so the GenAI button updates live.
const bootCapabilities = await loadApiCapabilities().catch(() => null);
await setupSettings({
  onSaved: () => configureApiCapabilities(),
  // A server too old to say probes as before.
  enabled: bootCapabilities?.settings?.enabled !== false
});
await configureApiCapabilities(bootCapabilities);

const startupParams = new URLSearchParams(window.location.search);
const startupAutoQuery = startupParams.get("auto");
if (startupAutoQuery) {
  state.autoGalleryMode = true;
  urlInput.value = startupAutoQuery;
}
renderStartPanel();

// ?url= / ?search= / ?prompt= open straight into that request: /admin/queries
// links each row here.
const startupRequest = [["url", "url"], ["search", "image_search"], ["prompt", "genai"]]
  .map(([param, mode]) => ({ mode, query: (startupParams.get(param) || "").trim() }))
  .find((request) => request.query);
if (startupRequest && !startupAutoQuery) {
  setActiveOmnibarMode(startupRequest.mode);
  urlInput.value = startupRequest.query;
  hideStartPanel();
  void loadRequestByMode(startupRequest);
}

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runActiveOmnibarMode();
  }
});

urlInput.addEventListener("input", () => {
  setAddressFeedback(null);
  if ((urlInput.value || "").trim()) {
    hideStartPanel();
  } else {
    renderStartPanel();
  }
  if (inputLooksLikeUrl(urlInput.value)) {
    setActiveOmnibarMode("url");
  }
});

window.addEventListener("keydown", (event) => {
  // The settings overlay owns the keyboard while open (its own Escape closes
  // it); don't steal scene keys or the URL-focus shortcut underneath it.
  if (isSettingsOpen()) {
    return;
  }
  if (event.key === "Escape" && languageMenu && !languageMenu.hidden) {
    event.preventDefault();
    setLanguageMenuOpen(false);
    languageBtn.focus();
    return;
  }
  if (event.key === "Escape" && shortcutsMenu && !shortcutsMenu.hidden) {
    event.preventDefault();
    setShortcutsMenuOpen(false);
    shortcutsBtn.focus();
    return;
  }
  if (event.key === "/" && document.activeElement !== urlInput) {
    event.preventDefault();
    setShortcutsMenuOpen(false);
    focusUrlInput();
    return;
  }
  if (event.key === "?" && document.activeElement !== urlInput) {
    event.preventDefault();
    toggleShortcutsMenu();
    return;
  }
  if (event.key.toLowerCase() === "j" && document.activeElement !== urlInput) {
    event.preventDefault();
    jumpToSphereEntryForDebug();
    focusSceneCanvas();
    return;
  }
  // DEV-only: toggle the in-world VR panel so canvas rendering and
  // controller-ray hit-testing can be exercised on desktop with the mouse.
  if (DEV_TOOLS_ENABLED && event.key.toLowerCase() === "p" && document.activeElement !== urlInput) {
    event.preventDefault();
    togglePanel();
    focusSceneCanvas();
    return;
  }
  if (
    (event.code === "Space" || event.key === " ")
    && document.activeElement !== urlInput
    && state.appState === AppState.INSIDE_SPHERE
  ) {
    event.preventDefault();
    toggleSphereRotation();
    return;
  }
  // Tunnel speed. Writes the speed control, which applyTunnelSpeed() reads
  // every frame; key repeat makes a held arrow keep going.
  if (
    (event.key === "ArrowUp" || event.key === "ArrowDown")
    && document.activeElement !== urlInput
    && state.appState === AppState.TUNNEL
  ) {
    event.preventDefault();
    const next = clamp(Number(speedInput.value) + (event.key === "ArrowUp" ? 2 : -2), 4, 45);
    speedInput.value = String(next);
    return;
  }
  const stateKey = keyStateKeyForEvent(event);
  if (stateKey in keyState && document.activeElement !== urlInput && state.appState === AppState.INSIDE_SPHERE) {
    keyState[stateKey] = true;
    event.preventDefault();
    return;
  }
  if (event.key === "Enter" && document.activeElement !== urlInput && state.appState === AppState.INSIDE_SPHERE) {
    event.preventDefault();
    activateSelectedSphereLink();
  }
});

window.addEventListener("keyup", (event) => {
  const stateKey = keyStateKeyForEvent(event);
  if (stateKey in keyState) {
    keyState[stateKey] = false;
  }
});

// A key released while the page is not listening stays down. Only keydown is
// gated on being inside the sphere, so a Shift held through a chord and let go
// after switching window leaves keyState.Shift true, and every later arrow
// reads as shift+arrow. Nothing here is worth preserving across a blur.
function clearKeyState() {
  for (const key of Object.keys(keyState)) {
    keyState[key] = false;
  }
}

window.addEventListener("blur", clearKeyState);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearKeyState();
  }
});

// DEV-only desktop pointer bridge for the in-world panel: converts the mouse
// position over the canvas to normalized device coords and raycasts the panel
// quad. Real headset input goes through the XR controller path in input.js.
if (DEV_TOOLS_ENABLED) {
  const pointerNdc = (event) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((event.clientY - rect.top) / rect.height) * 2 - 1)
    };
  };

  canvas.addEventListener("mousemove", (event) => {
    if (!isPanelVisible()) {
      return;
    }
    const ndc = pointerNdc(event);
    if (ndc) {
      handleDesktopPointer(ndc.x, ndc.y, false);
    }
  });

  canvas.addEventListener("click", (event) => {
    if (!isPanelVisible()) {
      return;
    }
    const ndc = pointerNdc(event);
    if (ndc && handleDesktopPointer(ndc.x, ndc.y, true)) {
      event.preventDefault();
    }
  });
}

// --- Shift + click-drag ------------------------------------------------------
//
// One stroke, two meanings: moving it zooms, holding it still runs the GenAI
// chord behind the same confirm ring as the two-finger touch hold. There is no
// bare shift+click chord, which would fire a paid batch with no confirmation.
//
// These listeners only record. Every decision is made per frame in
// applyShiftDragInput(), because the confirm hold is a clock and a pointer
// event carries none.
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !event.shiftKey || !isDesktopSpherePointer(event)) {
    return;
  }
  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that ended between the event and this call.
    }
  }
  if (recordShiftDragEvent(event, "down")) {
    event.preventDefault();
  }
});
canvas.addEventListener("pointermove", (event) => recordShiftDragEvent(event, "move"));
canvas.addEventListener("pointerup", (event) => recordShiftDragEvent(event, "up"));
canvas.addEventListener("pointercancel", (event) => recordShiftDragEvent(event, "cancel"));
// Shift released mid-stroke, from anywhere: the stroke must not outlive it.
window.addEventListener("keyup", endShiftDragIfShiftReleased);
window.addEventListener("blur", () => endShiftDragIfShiftReleased({ shiftKey: false }));

// --- The desktop pointer path ------------------------------------------------
//
// The mouse twin of the touch listeners below: they only record, and every
// decision is made once per frame in applyDesktopPointerSphereInput() from the
// same pure resolver the fingers use. Drag steers through the grab model (see
// input.js), so the layers keep parting after a throw.
//
// Shift is excluded: shift+drag is handled separately and must not also start
// this drag. Not named handleDesktopPointer(), which is the DEV bridge above.
function recordDesktopSpherePointer(event, type) {
  if (!isDesktopSpherePointer(event) || event.shiftKey) {
    return;
  }
  recordDesktopPointerEvent(event, type);
}

canvas.addEventListener("pointerdown", (event) => {
  if (
    event.button !== 0
    || !isDesktopSpherePointer(event)
    || event.shiftKey
    || renderer.xr.isPresenting
    || state.appState !== AppState.INSIDE_SPHERE
    || isPanelVisible()
  ) {
    return;
  }
  // Captured so a drag that runs off the canvas (over the toolbar, out of the
  // window) keeps steering and still delivers its up; otherwise the sphere
  // sticks mid-throw.
  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that ended between the event and this call.
    }
  }
  recordDesktopPointerEvent(event, "down");
  // Suppresses the text-selection drag and the browser's image-drag ghost.
  event.preventDefault();
});

canvas.addEventListener("pointermove", (event) => recordDesktopSpherePointer(event, "move"));
canvas.addEventListener("pointerup", (event) => recordDesktopSpherePointer(event, "up"));
canvas.addEventListener("pointercancel", (event) => recordDesktopSpherePointer(event, "cancel"));
canvas.addEventListener("lostpointercapture", (event) => {
  if (isDesktopSpherePointer(event)) {
    recordDesktopPointerEvent(event, "cancel");
  }
});

// --- The touch path ----------------------------------------------------------
//
// Pointer Events with setPointerCapture, not touch events: one code path for any
// number of fingers, and up/cancel reach the canvas even if the finger has
// travelled over the toolbar. These listeners only record; every decision is
// made once per frame in applyTouchSphereInput(), because the grab model is an
// integrator and a pointer event carries no dt.
//
// preventDefault() suppresses compatibility mouse events, double-tap zoom and
// the iOS long-press callout; it is skipped while the world panel is up so the
// DEV flat-mode `click` path into the panel still works.
function handleTouchPointer(event, type) {
  if (event.pointerType !== "touch") {
    return;
  }
  recordTouchPointerEvent(event, type);
  if (!isPanelVisible()) {
    event.preventDefault();
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") {
    return;
  }
  // Captured per pointer, so extra fingers are independent. Also half the answer
  // to iOS's unreliable `pointercancel`: a captured pointer's up/cancel always
  // reaches this element.
  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that ended between the event and this call.
    }
  }
  handleTouchPointer(event, "down");
});
canvas.addEventListener("pointermove", (event) => handleTouchPointer(event, "move"));
canvas.addEventListener("pointerup", (event) => handleTouchPointer(event, "up"));
canvas.addEventListener("pointercancel", (event) => handleTouchPointer(event, "cancel"));
// Second half of the missing-`pointercancel` answer. Losing capture without an
// up or cancel is the shape the iOS dropout takes; an already-ended contact
// ignores this, so it is a backstop, never a double-end. The pure resolver's
// staleness sweep is the third layer.
canvas.addEventListener("lostpointercapture", (event) => {
  if (event.pointerType === "touch") {
    recordTouchPointerEvent(event, "cancel");
  }
});

window.addEventListener("resize", resize);

renderer.xr.addEventListener("sessionstart", () => {
  exitVrBtn.disabled = false;
  // Whatever was mid-gesture on the flat screen is not a VR input: drop the
  // tracked contacts and the confirm ring.
  resetTouchGestures();
  setStatus(t("status.xrStarted"), true);
  // The world-anchored idle start panel is driven per frame by
  // updateVrIdlePanel() (see renderFrame), so no explicit open is needed.
});

renderer.xr.addEventListener("sessionend", () => {
  // Puts scene.background back and drops passthrough so the flat page never
  // keeps its sky switched off. No-op after an opaque session.
  endPassthroughSession();
  state.xrExitLatch = false;
  state.xrExitHoldSeconds = 0;
  state.xrSelectLatch = false;
  state.xrSelectLatchHands.left = false;
  state.xrSelectLatchHands.right = false;
  hideExitHoldIndicator();
  resetTwoHandGesture();
  // An open menu or help page would stay in the scene and draw behind the flat
  // page's bookmarks; the idle launcher already closes itself once not presenting.
  hidePanel();
  // Restore the flat UI for the scene that was already running; never let the
  // initial launcher cover a sphere created while in VR.
  if (shouldShowStartPanel()) {
    renderStartPanel();
  } else {
    hideStartPanel();
  }
  setStatus(t("status.xrEnded"), true);
  void updateVrButtonAvailability();
});

state.currentQuery = (urlInput.value || "").trim();
state.cameraSpeed = DEFAULT_CAMERA_SPEED;
state.fpsAccumulatorStart = performance.now();

void updateVrButtonAvailability();
setupWebGlContextRecovery();
rebuildTunnel();
if (state.currentQuery) {
  void loadAndExtractUrl({ query: state.currentQuery });
}
renderer.setAnimationLoop(renderFrame);
