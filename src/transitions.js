// Scene color / fog transitions, the tunnel->sphere transition trigger,
// the per-frame state machine, and cycle (re)start.

import * as THREE from "three";
import {
  TUNNEL_FOG_COLOR,
  SPHERE_FOG_COLOR,
  SPHERE_DWELL_SECONDS,
  SPHERE_ENTRY_SETTLE_MS,
  SPHERE_EXIT_DISTANCE_RINGS,
  SPHERE_IRIS_OPEN_SECONDS,
  SPHERE_IRIS_PREOPEN_START,
  SPHERE_IRIS_PREOPEN_END,
  SPHERE_IRIS_PREOPEN_MAX_T,
  SPHERE_TRANSITION_FADE_RINGS,
  SPHERE_TRANSITION_FOG_FAR,
  SPHERE_FOG_OPEN_SECONDS,
  TUNNEL_TUBE_OPACITY,
  AppState,
  TUNNEL_FOG_SRGB,
  SPHERE_FOG_SRGB
} from "./constants.js";
import { state } from "./state.js";
import { speedInput } from "./dom.js";
import {
  scene,
  imageGroup,
  spherePanels,
  sphereViewOffset,
  twoHandGestureState,
  _fogBlendColor,
  DEFAULT_CAMERA_SPEED
} from "./scene.js";
import { clamp } from "./helpers.js";
import { setStatus } from "./ui.js";
import { t } from "./i18n.js";
import { TUNNEL_SPEED_EASE_EPSILON } from "./tunnel-run.js";
import {
  setTunnelRenderState,
  setTunnelClipPlane,
  clearPanels,
  flushPendingPanelSpawnsForDebug,
  nextTunnelRunStartRing
} from "./tunnel.js";
import {
  clearSphere,
  getSphereNavigationRequest,
  spawnSphereFromExtractedItems,
  updateSphereAnimation,
  updateSphereTransitionAppearance,
  startSphereExit
} from "./sphere.js";
import { loadRequestByMode } from "./api.js";
import { createHandGestureState } from "./xr-hand-gestures.js";
import { stepAutoAdvanceIdle } from "./idle-auto-advance.js";
import { isSettingsOpen } from "./settings.js";

const SPHERE_PORTAL_REVEAL_PROGRESS = 0.42;
// Lead long enough that the J-key jump replays the whole pre-entry bloom (which
// starts at SPHERE_IRIS_PREOPEN_START of the 60-ring fade).
const DEBUG_SPHERE_JUMP_LEAD_RINGS = 36;

function setSceneBackgroundColor(color) {
  if (scene.background && scene.background.isColor) {
    scene.background.copy(color);
  } else {
    scene.background = color.clone();
  }
}

function setSceneToTunnelColors() {
  scene.fog.color.copy(TUNNEL_FOG_COLOR);
  setSceneBackgroundColor(TUNNEL_FOG_COLOR);
  scene.fog.near = 10;
  scene.fog.far = 55;
}

// `openT` is 0 at the threshold and 1 once the envelope has fully opened. The
// approach pulls the fog envelope in to (5, 20) to hide the region beyond the
// clipped portal; inside there is nothing to hide, and opening it in one frame
// flashes, so it opens with the iris on the same clock.
function setSceneToSphereColors(openT = 1) {
  scene.fog.color.copy(SPHERE_FOG_COLOR);
  setSceneBackgroundColor(SPHERE_FOG_COLOR);
  setSphereFogEnvelope(openT);
}

// The envelope is separate from the palette because the exit needs one without
// the other: the exit changes colour, but the envelope it inherits from the
// sphere is already the tunnel's, so touching it would flash.
function setSphereFogEnvelope(openT) {
  const t = clamp(openT, 0, 1);
  scene.fog.near = THREE.MathUtils.lerp(5, 10, t);
  scene.fog.far = THREE.MathUtils.lerp(SPHERE_TRANSITION_FOG_FAR, 55, t);
}

// `towardTunnel` is 0 at the sphere palette and 1 at the tunnel's: the return
// leg of updateTransitionFog below, same easing and sRGB blend.
function blendFogColourTowardTunnel(towardTunnel) {
  const eased = 1 - Math.pow(1 - clamp(towardTunnel, 0, 1), 2.2);
  const r = SPHERE_FOG_SRGB.r + (TUNNEL_FOG_SRGB.r - SPHERE_FOG_SRGB.r) * eased;
  const g = SPHERE_FOG_SRGB.g + (TUNNEL_FOG_SRGB.g - SPHERE_FOG_SRGB.g) * eased;
  const b = SPHERE_FOG_SRGB.b + (TUNNEL_FOG_SRGB.b - SPHERE_FOG_SRGB.b) * eased;
  _fogBlendColor.setRGB(r, g, b, THREE.SRGBColorSpace);
  scene.fog.color.copy(_fogBlendColor);
  setSceneBackgroundColor(_fogBlendColor);
}

// Interpolates fog color, background color and fog distances from the tunnel
// palette toward the sphere palette as the camera approaches the portal.
// `fadeProgress` is 0 at the start of the transition and 1 at the portal ring.
// Without it the background stays pale and, because the tunnel is clipped at the
// portal, the area beyond reads as a near-white wash instead of deep blue.
function updateTransitionFog(fadeProgress) {
  const t = clamp(fadeProgress, 0, 1);

  // Ease-out: stays near the tunnel color for the first ~25%, then darkens
  // decisively, so it already looks dark on entering the sphere.
  const eased = 1 - Math.pow(1 - t, 2.2);

  // Blend in sRGB (display) space, then convert back to linear via
  // THREE.Color.setRGB(..., SRGBColorSpace); a linear lerp looks washed out after
  // gamma encoding.
  const r = TUNNEL_FOG_SRGB.r + (SPHERE_FOG_SRGB.r - TUNNEL_FOG_SRGB.r) * eased;
  const g = TUNNEL_FOG_SRGB.g + (SPHERE_FOG_SRGB.g - TUNNEL_FOG_SRGB.g) * eased;
  const b = TUNNEL_FOG_SRGB.b + (SPHERE_FOG_SRGB.b - TUNNEL_FOG_SRGB.b) * eased;
  _fogBlendColor.setRGB(r, g, b, THREE.SRGBColorSpace);

  scene.fog.color.copy(_fogBlendColor);
  setSceneBackgroundColor(_fogBlendColor);

  // Pull the fog envelope in on approach so the clipped region beyond the portal
  // is hidden behind the deepening wash instead of raw background.
  scene.fog.near = THREE.MathUtils.lerp(10, 5, eased);
  scene.fog.far = THREE.MathUtils.lerp(55, SPHERE_TRANSITION_FOG_FAR, eased);
}

function maybeTransitionFromTunnelToSphere(dt) {
  if (state.appState !== AppState.TUNNEL) {
    return;
  }
  // Open settings keep the viewer where they are: the tunnel flies on but does
  // not hand over to the sphere.
  if (state.cycleRequestInFlight || state.extractedItems.length === 0 || isSettingsOpen()) {
    state.tunnelSettledMs = 0;
    return;
  }
  if (state.minTunnelDisplayUntilMs > 0 && performance.now() < state.minTunnelDisplayUntilMs) {
    state.tunnelSettledMs = 0;
    return;
  }
  if (!state.genAiBatchComplete || (
    state.genAiBatchExpected > 0
    && state.genAiBatchReceived < state.genAiBatchExpected
  )) {
    state.tunnelSettledMs = 0;
    return;
  }
  if (state.pendingPanelItems.length > 0) {
    state.tunnelSettledMs = 0;
    return;
  }
  state.tunnelSettledMs += dt * 1000;
  if (state.tunnelSettledMs < SPHERE_ENTRY_SETTLE_MS) {
    return;
  }
  state.tunnelSettledMs = 0;
  spawnSphereFromExtractedItems();
}

function prepareForTunnelRun() {
  clearSphere();
  clearPanels();

  state.appState = AppState.TUNNEL;
  state.tunnelSettledMs = 0;
  state.targetSphereRing = -1;
  state.sphereExitTargetRing = -1;
  state.sphereDwellSeconds = 0;
  state.pendingExitQuery = null;
  state.pendingExitMode = null;
  state.pendingExitSource = null;
  // Single reset point for the img2img launch: any load that resets the cycle
  // supersedes an in-flight launch, whose import then drops its result instead of
  // handing a stale source to the run that took over.
  state.genAiLaunch = null;
  state.sphereExitSteersToSelection = true;
  state.minTunnelDisplayUntilMs = 0;
  state.genAiBatchReceived = 0;
  state.genAiBatchExpected = 0;
  state.genAiBatchComplete = true;
  sphereViewOffset.set(0, 0, 0);
  twoHandGestureState.active = false;
  // Tunnel speed resets with the cycle: the two-hand gesture writes straight into
  // speedInput.value (input.js), which would otherwise carry a prior tunnel's
  // speed into this one.
  twoHandGestureState.baselineSpeed = DEFAULT_CAMERA_SPEED;
  // Also reset the pure half of the hand-gesture tree, so a cycle restart cannot
  // resume mid-gesture. (Assigned here rather than through input.js
  // resetTwoHandGesture() because input.js already imports this module.)
  state.xrHandGesture = createHandGestureState();

  // Continue down the path rather than teleporting to its start, which would jump
  // the tunnel as the footer appears. Back to ring 5 only when too little path
  // remains for a whole cycle.
  state.currentRingFloat = nextTunnelRunStartRing();
  // The exit hands over at up to SPHERE_EXIT_MAX_SPEED; give the difference back
  // over about a second rather than in one frame.
  state.tunnelSpeedEasing = state.cameraSpeed > DEFAULT_CAMERA_SPEED + TUNNEL_SPEED_EASE_EPSILON;
  if (!state.tunnelSpeedEasing) {
    state.cameraSpeed = DEFAULT_CAMERA_SPEED;
  }
  speedInput.value = String(DEFAULT_CAMERA_SPEED.toFixed(1));
  state.lastSpawnedPanelRing = state.currentRingFloat + 20;
  state.extractedItems = [];

  imageGroup.visible = true;
  setTunnelClipPlane(false);
  setTunnelRenderState({
    opacity: TUNNEL_TUBE_OPACITY,
    visible: true,
    depthWrite: true
  });
  setSceneToTunnelColors();
}

function restartCycleFromCurrentQuery() {
  const launch = state.genAiLaunch;
  if (launch?.status === "importing") {
    // Flying first is the point: the exit can reach its target ring before the
    // source import answers. Keep coasting and restart on a later frame rather than
    // firing a request whose prompt and source do not exist yet.
    return;
  }
  if (launch?.status === "failed") {
    // Land in the tunnel with the failure on the footer (state.genAiJobError, which
    // prepareForTunnelRun deliberately does not clear) instead of quietly reloading
    // the page the viewer just left.
    prepareForTunnelRun();
    return;
  }
  const nextQuery = (state.pendingExitQuery ?? state.currentQuery ?? "").trim();
  const nextMode = state.pendingExitMode || state.currentLoadMode || "url";
  const nextSource = state.pendingExitSource;
  // Client-only origin label, read before prepareForTunnelRun clears the launch.
  const variationLabel = launch?.label || "";
  if (!nextQuery || state.cycleRequestInFlight) {
    return;
  }
  state.pendingExitQuery = null;
  state.pendingExitMode = null;
  state.pendingExitSource = null;
  prepareForTunnelRun();
  void loadRequestByMode({
    mode: nextMode,
    query: nextQuery,
    source: nextSource,
    variationLabel,
    resetTunnel: false,
    cycleReload: true
  });
}

function jumpToSphereEntryForDebug() {
  if (state.cycleRequestInFlight) {
    setStatus(t("status.waitExtraction"), "warning");
    return false;
  }
  if (state.extractedItems.length === 0) {
    setStatus(t("status.loadFirst"), "warning");
    return false;
  }
  if (state.appState === AppState.EXITING_SPHERE) {
    setStatus(t("status.waitExit"), "warning");
    return false;
  }

  if (state.appState === AppState.TUNNEL) {
    flushPendingPanelSpawnsForDebug();
    spawnSphereFromExtractedItems();
  } else if (state.appState === AppState.INSIDE_SPHERE && state.targetSphereRing >= 0) {
    state.appState = AppState.TRANSITION_TO_SPHERE;
  }

  if (state.appState !== AppState.TRANSITION_TO_SPHERE || state.targetSphereRing < 0) {
    setStatus(t("status.entryNotReady"), "warning");
    return false;
  }

  // Forward-only: skip ahead to the lead-in point when far out (replaying the
  // pre-entry bloom), but never rewind rings already passed.
  const leadEntryRing = Math.max(5, state.targetSphereRing - DEBUG_SPHERE_JUMP_LEAD_RINGS);
  state.currentRingFloat = Math.max(state.currentRingFloat, leadEntryRing);
  state.sphereIrisOpenElapsed = 0;
  state.sphereDwellSeconds = 0;
  state.tunnelSettledMs = 0;
  imageGroup.visible = true;
  setTunnelClipPlane(false);
  setTunnelRenderState({
    opacity: TUNNEL_TUBE_OPACITY,
    visible: true,
    depthWrite: true
  });
  setStatus(t("status.jumped"), true);
  return true;
}

function updateStateMachine(dt) {
  if (state.appState === AppState.TUNNEL) {
    imageGroup.visible = true;
    setTunnelRenderState({
      opacity: TUNNEL_TUBE_OPACITY,
      visible: true,
      depthWrite: true
    });
    maybeTransitionFromTunnelToSphere(dt);
    return;
  }

  if (state.appState === AppState.TRANSITION_TO_SPHERE) {
    const ringsRemaining = Math.max(0, state.targetSphereRing - state.currentRingFloat);
    const fadeProgress = 1 - clamp(ringsRemaining / SPHERE_TRANSITION_FADE_RINGS, 0, 1);
    const portalProgress = clamp(
      (fadeProgress - SPHERE_PORTAL_REVEAL_PROGRESS) / (1 - SPHERE_PORTAL_REVEAL_PROGRESS),
      0,
      1
    );
    // Pre-entry bloom: map the last stretch of the approach onto the first
    // SPHERE_IRIS_PREOPEN_MAX_T of the iris clock (distance-locked, monotonic via
    // max), so the same clock keeps running once inside with no restart or seam.
    const preOpenT = clamp(
      (fadeProgress - SPHERE_IRIS_PREOPEN_START)
        / (SPHERE_IRIS_PREOPEN_END - SPHERE_IRIS_PREOPEN_START),
      0,
      1
    ) * SPHERE_IRIS_PREOPEN_MAX_T;
    state.sphereIrisOpenElapsed = Math.max(
      state.sphereIrisOpenElapsed,
      preOpenT * SPHERE_IRIS_OPEN_SECONDS
    );
    const approachIrisT = clamp(state.sphereIrisOpenElapsed / SPHERE_IRIS_OPEN_SECONDS, 0, 1);
    updateSphereAnimation(dt, false, fadeProgress, false, approachIrisT);
    updateTransitionFog(portalProgress);
    updateSphereTransitionAppearance(fadeProgress, false, approachIrisT);
    setTunnelClipPlane(portalProgress > 0);
    imageGroup.visible = fadeProgress < 0.85;
    setTunnelRenderState({
      opacity: TUNNEL_TUBE_OPACITY,
      visible: true,
      depthWrite: true
    });

    if (state.currentRingFloat >= state.targetSphereRing) {
      state.currentRingFloat = state.targetSphereRing;
      state.appState = AppState.INSIDE_SPHERE;
      state.sphereDwellSeconds = 0;
      // Not resetting sphereIrisOpenElapsed: the bloom clock started during the
      // approach and continues across the threshold.
      setTunnelClipPlane(false);
      // Starts where the approach left it, then opens on its own clock.
      state.sphereFogOpenSeconds = 0;
      setSceneToSphereColors(0);
      updateSphereTransitionAppearance(1, true);
      setStatus(t("status.insideSphere", { seconds: SPHERE_DWELL_SECONDS }), true);
    }
    return;
  }

  if (state.appState === AppState.INSIDE_SPHERE) {
    state.sphereIrisOpenElapsed += dt;
    const irisOpenT = clamp(state.sphereIrisOpenElapsed / SPHERE_IRIS_OPEN_SECONDS, 0, 1);
    state.sphereFogOpenSeconds += dt;
    setSceneToSphereColors(state.sphereFogOpenSeconds / SPHERE_FOG_OPEN_SECONDS);
    updateSphereAnimation(dt, true, 1, false, irisOpenT);
    updateSphereTransitionAppearance(1, true);
    // The dwell does not advance under a hand: markSphereInteraction() zeroes it
    // from input.js, and this freezes it too, so a drag can never fire a
    // SPHERE_DWELL_SECONDS exit through startSphereExit().
    //
    // It also does not advance with nobody there (cost control, see
    // idle-auto-advance.js). Both freeze the clock rather than resetting it, so no
    // ordering accident slips a tick past. Inside a GenAI sphere every auto-advance
    // is a paid batch, so a forgotten tab would bill until the daily cap; a timeout
    // of 0 disables this for an attended kiosk. It applies only where the next hop
    // costs money; a free browse is left running.
    const paidHop = getSphereNavigationRequest()?.mode === "genai";
    const idle = stepAutoAdvanceIdle({
      nowMs: performance.now(),
      lastInputMs: state.lastUserInputAtMs,
      timeoutMs: paidHop
        ? state.autoAdvanceIdleTimeoutMs
        : state.autoAdvanceFreeIdleTimeoutMs,
      suspended: state.autoAdvanceSuspended
    });
    state.autoAdvanceSuspended = idle.suspended;
    if (idle.justSuspended) {
      // Say so: a piece that silently stops reads as broken.
      setStatus(t(paidHop ? "status.pausedGenerating" : "status.paused"), "warning");
    }
    if (idle.justResumed) {
      // Restart the dwell rather than firing the advance that was already overdue the
      // instant they return; the waking input may have been a keystroke in the URL
      // bar, which never touches the dwell.
      state.sphereDwellSeconds = 0;
    }

    // The third freeze is the first-run overlay (onboarding.js), the fourth the
    // settings panel: the sphere waits rather than carrying the reader out.
    if (!state.sphereInteractionHold && !state.sphereDwellHeldByOnboarding && !isSettingsOpen() && !idle.suspended) {
      state.sphereDwellSeconds += dt;
    }

    setTunnelRenderState({
      opacity: 0,
      visible: false,
      depthWrite: false
    });
    imageGroup.visible = false;

    // Belt and braces, as with sphereInteractionHold: the one branch that spends
    // money should not depend on the clock freeze alone.
    if (state.sphereDwellSeconds >= SPHERE_DWELL_SECONDS && !idle.suspended) {
      const nextRequest = getSphereNavigationRequest();
      if (!nextRequest) {
        state.sphereDwellSeconds = 0;
        setStatus(t("status.noLinkedSelected"), "warning");
        return;
      }
      state.pendingExitQuery = nextRequest.query;
      state.pendingExitMode = nextRequest.mode;
      state.pendingExitSource = nextRequest.source || null;
      state.followedLabel = { query: nextRequest.query, text: nextRequest.label || "" };
      startSphereExit();
    }
    return;
  }

  if (state.appState === AppState.EXITING_SPHERE) {
    // Render the sphere at full scale with its full inside-sphere layout (not the
    // preview) so the camera plunge passes through real panel geometry.
    // `pullSelectedImageToFront` aligns the selected panel with the camera forward.
    updateSphereAnimation(dt, false, 1, true);

    // Fade sphere panels out over the exit so they dissolve as the camera passes
    // through, rather than popping off when the cycle restarts.
    const exitProgress = clamp(
      (state.currentRingFloat - state.sphereExitStartRing) / SPHERE_EXIT_DISTANCE_RINGS,
      0,
      1
    );
    // Colour only on the way out; otherwise the palette would hold sphere navy for
    // the whole plunge and cut to tunnel pale on the first frame of the new run.
    // The envelope keeps opening on its own clock, so at exit end both match what
    // setSceneToTunnelColors() sets and the restart changes nothing.
    blendFogColourTowardTunnel(exitProgress);
    state.sphereFogOpenSeconds += dt;
    setSphereFogEnvelope(state.sphereFogOpenSeconds / SPHERE_FOG_OPEN_SECONDS);

    const panelAlpha = clamp(1 - Math.pow(exitProgress, 1.6), 0, 1);
    for (const panel of spherePanels) {
      panel.material.opacity = panelAlpha;
      if (panel.borderMesh?.material) {
        panel.borderMesh.material.opacity = panelAlpha;
      }
    }

    imageGroup.visible = true;
    setTunnelRenderState({
      opacity: TUNNEL_TUBE_OPACITY,
      visible: true,
      depthWrite: true
    });

    if (state.currentRingFloat >= state.sphereExitTargetRing) {
      restartCycleFromCurrentQuery();
    }
  }
}

export {
  setSceneBackgroundColor,
  setSceneToTunnelColors,
  setSceneToSphereColors,
  updateTransitionFog,
  maybeTransitionFromTunnelToSphere,
  updateStateMachine,
  prepareForTunnelRun,
  restartCycleFromCurrentQuery,
  jumpToSphereEntryForDebug
};
