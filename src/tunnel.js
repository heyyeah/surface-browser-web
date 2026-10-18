// Tunnel: geometry build/dispose, render state, panel spawning & fading,
// camera advance along the path, and the world transform / portal clip plane.

import * as THREE from "three";
import { loadProxiedTexture } from "./proxied-texture.js";
import {
  IMAGE_SPAWN_INTERVAL_MS,
  MAX_PANELS,
  SPHERE_ENTRY_LEAD_RINGS,
  SPHERE_EXIT_DISTANCE_RINGS,
  TUNNEL_FADE_IN_SECONDS,
  TUNNEL_TUBE_OPACITY,
  AppState
} from "./constants.js";
import { state } from "./state.js";
import { tunnelRunStartRing } from "./tunnel-run.js";
import { ringsInput, segmentsInput } from "./dom.js";
import {
  renderer,
  scene,
  camera,
  ambientLight,
  worldGroup,
  imageGroup,
  sphereGroup,
  imagePanels,
  tunnelTexture,
  tunnelPortalClipPlane,
  sphereAnchorForward
} from "./scene.js";
import { buildTunnel, sampleAlongPath } from "./tunnel-geometry.js";
import { buildCurvedPlaneGeometry } from "./curved-plane-geometry.js";
import { disposeMaterial } from "./helpers.js";
import { DEBUG_UI, TUNNEL_CLIP_ALWAYS, TUNNEL_RINGS_OVERRIDE, TUNNEL_WALL_OPAQUE, TUNNEL_WALL_UNLIT } from "./config.js";
import { setStatus } from "./ui.js";

const TUNNEL_WRAP_START_RING = 5;

// The furthest ring the camera may reach before the path runs out. Shared by
// the in-tunnel wrap and by the run-start decision below.
function maxCameraRing() {
  if (!state.tunnelConfig) {
    return TUNNEL_WRAP_START_RING + 1;
  }
  return Math.max(
    TUNNEL_WRAP_START_RING + 1,
    state.tunnelConfig.rings - TUNNEL_WRAP_SAFETY_RINGS
  );
}

// A new run continues from where the camera is, unless the path is running out.
function nextTunnelRunStartRing() {
  return tunnelRunStartRing({
    currentRing: state.currentRingFloat,
    maxCameraRing: maxCameraRing()
  });
}
const TUNNEL_WRAP_SAFETY_RINGS = SPHERE_ENTRY_LEAD_RINGS + SPHERE_EXIT_DISTANCE_RINGS + 60;
const TUNNEL_PANEL_MIN_FORWARD_RINGS = 90;
const TUNNEL_PANEL_SPACING_RINGS = 15;
let tunnelPanelGeneration = 0;
let pendingTunnelPanelLoads = 0;
const _xrHeadPosition = new THREE.Vector3();
const _xrHeadCentering = new THREE.Matrix4();

// Scratch for updateWorldTransform() and sampleAlongPath(), which run every
// frame. None of it escapes: worldGroup.matrix is copied from the result.
const _pathSample = {
  pos: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3()
};
const _worldRight = new THREE.Vector3();
const _worldNegForward = new THREE.Vector3();
const _worldRotation = new THREE.Matrix4();
const _worldInverseRotation = new THREE.Matrix4();
const _worldTranslation = new THREE.Matrix4();
const _worldFinalTransform = new THREE.Matrix4();

function disposeTunnel() {
  if (!state.tunnelMesh) {
    return;
  }
  worldGroup.remove(state.tunnelMesh);
  state.tunnelMesh.geometry.dispose();
  if (state.tunnelMesh.material?.map === tunnelTexture) {
    state.tunnelMesh.material.map = null;
  }
  disposeMaterial(state.tunnelMesh.material);
  state.tunnelMesh = null;
}

// n·x + c > 0 everywhere the scene reaches, so it clips nothing.
const keepAllClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
const idleClipPlanes = () => (TUNNEL_CLIP_ALWAYS ? [keepAllClipPlane] : null);

function buildTunnelMaterial() {
  const shared = {
    clippingPlanes: idleClipPlanes(),
    map: tunnelTexture,
    side: THREE.DoubleSide,
    transparent: !TUNNEL_WALL_OPAQUE,
    opacity: TUNNEL_WALL_OPAQUE ? 1 : TUNNEL_TUBE_OPACITY,
    depthWrite: true
  };
  if (TUNNEL_WALL_UNLIT) {
    // Same pixels as the Phong wall: with only an ambient light and no
    // specular, Phong comes out as map * ambient / PI.
    return new THREE.MeshBasicMaterial({
      ...shared,
      color: new THREE.Color().setScalar(ambientLight.intensity / Math.PI)
    });
  }
  return new THREE.MeshPhongMaterial({
    ...shared,
    color: 0xffffff,
    specular: 0xffffff,
    shininess: 0
  });
}

function setTunnelRenderState({ opacity = TUNNEL_TUBE_OPACITY, visible = true, depthWrite = true } = {}) {
  if (!state.tunnelMesh?.material) {
    return;
  }
  state.tunnelMesh.visible = visible;
  state.tunnelMesh.material.opacity = opacity;
  state.tunnelMesh.material.depthWrite = depthWrite;
  state.tunnelMesh.material.needsUpdate = true;
}

function setTunnelClipPlane(active) {
  state.tunnelPortalClipActive = active;
  if (!state.tunnelMesh?.material) {
    return;
  }
  state.tunnelMesh.material.clippingPlanes = active ? [tunnelPortalClipPlane] : idleClipPlanes();
  state.tunnelMesh.material.clipIntersection = false;
  state.tunnelMesh.material.needsUpdate = true;
}

function rebuildTunnel() {
  const rings = Math.max(300, Math.min(10000, TUNNEL_RINGS_OVERRIDE || Number(ringsInput.value) || 2200));
  const segments = TUNNEL_RINGS_OVERRIDE ? 64 : Math.max(8, Math.min(256, Number(segmentsInput.value) || 256));

  disposeTunnel();

  const built = buildTunnel({
    rings,
    pathRings: rings + 300,
    segments,
    radius: 2,
    distBetweenRings: 0.8
  });

  state.tunnelSamples = built.samples;
  state.tunnelConfig = built.config;
  state.currentRingFloat = 5;
  state.lastSpawnedPanelRing = state.currentRingFloat + 20;

  state.tunnelMesh = new THREE.Mesh(built.geometry, buildTunnelMaterial());
  worldGroup.add(state.tunnelMesh);

  // "Tunnel rebuilt (N rings, M segments)" is a dev diagnostic that would leak
  // into the public status footer / VR status line, so it is gated
  // (DEBUG_UI === DEV_TOOLS_ENABLED, off in production).
  if (DEBUG_UI) {
    setStatus(`Tunnel rebuilt (${rings} rings, ${segments} segments)`, true);
  }
}

// Only the rings the fog leaves visible are drawn. The wall is ~2,200 rings and
// fog hides all but ~70 of them; drawing the rest held Pico 4 Ultra near 30 fps
// against 90 (and its right eye then dropped the wall). The margin is what makes
// this safe on a curve: at the path's tightest radius (30 m, tunnel-path.js) a
// ring 1.6x the fog distance along the path is still past the fog in a straight
// line; 2x leaves room for fog being measured as view depth, not distance. In
// passthrough the fog is off, so the whole wall is drawn as before.
const TUNNEL_DRAW_REACH_FACTOR = 2;

// The wall is 85% opaque, so without a cap the sphere waiting at the far end
// showed through the cut that the culled rings used to hide. A fogged disc at
// each end is pure fog colour that far out, which is what those rings drew.
const TUNNEL_CAP_RADIUS_FACTOR = 1.2;
let tunnelCaps = null;

function ensureTunnelCaps(radius) {
  if (!tunnelCaps) {
    const geometry = new THREE.CircleGeometry(radius * TUNNEL_CAP_RADIUS_FACTOR, 32);
    const material = new THREE.MeshBasicMaterial({ color: scene.fog?.color ?? 0x000000, side: THREE.DoubleSide, fog: true });
    tunnelCaps = [new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material)];
    for (const cap of tunnelCaps) {
      worldGroup.add(cap);
    }
  }
  return tunnelCaps;
}

function placeTunnelCap(cap, ringIndex) {
  const ring = getRingVectorsAtIndex(ringIndex);
  cap.position.copy(ring.center);
  cap.quaternion.setFromUnitVectors(_capNormal, ring.forward);
  cap.visible = true;
}
const _capNormal = new THREE.Vector3(0, 0, 1);

function updateTunnelDrawRange() {
  const mesh = state.tunnelMesh;
  const config = state.tunnelConfig;
  if (!mesh?.geometry.index || !config) {
    return;
  }
  const caps = ensureTunnelCaps(config.radius);
  const indicesPerRing = config.segments * 6;
  const fogFar = scene.fog ? scene.fog.far : Infinity;
  const reach = Math.ceil((fogFar * TUNNEL_DRAW_REACH_FACTOR) / config.distBetweenRings);
  if (!mesh.visible || !Number.isFinite(reach) || reach * 2 >= config.rings) {
    mesh.geometry.setDrawRange(0, Infinity);
    caps[0].visible = false;
    caps[1].visible = false;
    return;
  }
  // Ring r's triangles join it to ring r - 1, so they start at (r - 1) strips.
  const ring = Math.round(state.currentRingFloat);
  const first = Math.max(0, ring - reach - 1);
  const last = Math.min(config.rings - 1, ring + reach);
  mesh.geometry.setDrawRange(first * indicesPerRing, Math.max(0, last - first) * indicesPerRing);
  caps[0].material.color.copy(scene.fog.color);
  placeTunnelCap(caps[0], first);
  placeTunnelCap(caps[1], last);
}

function disposeImagePanel(panel) {
  imageGroup.remove(panel.root);
  panel.mesh.geometry.dispose();
  disposeMaterial(panel.mesh.material);
}

function disposeDetachedImagePanel(root, mesh) {
  if (root.parent) {
    root.parent.remove(root);
  }
  mesh.geometry.dispose();
  disposeMaterial(mesh.material);
}

function clearPanels() {
  tunnelPanelGeneration += 1;
  pendingTunnelPanelLoads = 0;
  state.pendingPanelItems = [];
  state.spawnAccumulatorMs = 0;
  for (const panel of imagePanels) {
    disposeImagePanel(panel);
  }
  imagePanels.length = 0;
}

function clearSpawnedPanels() {
  tunnelPanelGeneration += 1;
  pendingTunnelPanelLoads = 0;
  for (const panel of imagePanels) {
    disposeImagePanel(panel);
  }
  imagePanels.length = 0;
}

function getRingVectors(ringFloat) {
  if (!state.tunnelSamples) {
    return null;
  }
  const sample = sampleAlongPath(state.tunnelSamples, ringFloat);
  if (sample) {
    return {
      center: sample.pos,
      forward: sample.forward,
      up: sample.up,
      right: sample.right
    };
  }
  const ringIndex = Math.max(0, Math.min(Math.floor(ringFloat), state.tunnelSamples.centers.length - 2));
  return {
    center: state.tunnelSamples.centers[ringIndex],
    forward: state.tunnelSamples.forwards[ringIndex],
    up: state.tunnelSamples.ups[ringIndex],
    right: state.tunnelSamples.rights[ringIndex]
  };
}

function getRingVectorsAtIndex(ringIndex) {
  if (!state.tunnelSamples) {
    return null;
  }
  const clampedIndex = Math.max(0, Math.min(ringIndex, state.tunnelSamples.centers.length - 2));
  return {
    center: state.tunnelSamples.centers[clampedIndex],
    forward: state.tunnelSamples.forwards[clampedIndex],
    up: state.tunnelSamples.ups[clampedIndex],
    right: state.tunnelSamples.rights[clampedIndex]
  };
}

function applySwiftPanelOrientation(mesh, forward, up) {
  const zAxis = forward.clone().normalize();
  const xAxis = up.clone().cross(zAxis).normalize();
  const yAxis = zAxis.clone().cross(xAxis).normalize();
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.rotateZ(Math.random() * Math.PI * 2);
}

function spawnPanel(item, index) {
  const generation = tunnelPanelGeneration;
  const geometry = buildCurvedPlaneGeometry({
    radius: 1.9,
    arcLength: 3.85,
    height: 3.3,
    segments: 48
  });
  const hasLink = Boolean(item.linkUrl);

  const material = new THREE.MeshBasicMaterial({
    color: hasLink ? 0xffffff : 0x5f6b9f,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0
  });

  const root = new THREE.Group();

  const mesh = new THREE.Mesh(geometry, material);
  root.add(mesh);

  const panel = {
    root,
    mesh,
    linkUrl: item.linkUrl,
    hasLink,
    index,
    spawnRing: null,
    currentOpacity: 0,
    targetOpacity: hasLink ? 0.92 : 0.72,
    failed: false
  };
  let loadTracked = true;
  pendingTunnelPanelLoads += 1;
  const finishLoad = () => {
    if (!loadTracked) {
      return;
    }
    loadTracked = false;
    pendingTunnelPanelLoads = Math.max(0, pendingTunnelPanelLoads - 1);
  };

  const attachPanel = () => {
    if (generation !== tunnelPanelGeneration) {
      return false;
    }
    if (!root.parent) {
      const targetRing = Math.max(
        state.currentRingFloat + TUNNEL_PANEL_MIN_FORWARD_RINGS,
        state.lastSpawnedPanelRing + TUNNEL_PANEL_SPACING_RINGS
      );
      const ringIndex = Math.floor(targetRing);
      const ringVectors = getRingVectorsAtIndex(ringIndex);
      if (!ringVectors) {
        return false;
      }
      state.lastSpawnedPanelRing = ringIndex;
      panel.spawnRing = ringIndex;
      root.position.copy(ringVectors.center);
      applySwiftPanelOrientation(root, ringVectors.forward, ringVectors.up);
      imageGroup.add(root);
      imagePanels.push(panel);
      // This is deliberately not imagePanels.length: panels are removed once
      // they pass the camera, while the loading footer must report cumulative
      // progress for this load.
      state.tunnelSpawnedPanelCount += 1;
    }
    if (!root.parent) {
      return false;
    }
    return true;
  };

  const proxyUrl = item.imageUrl.startsWith("data:image/") || item.imageUrl.startsWith("/")
    ? item.imageUrl
    : `/api/proxy/image?url=${encodeURIComponent(item.imageUrl)}`;
  loadProxiedTexture(
    proxyUrl,
    (texture) => {
      finishLoad();
      if (generation !== tunnelPanelGeneration) {
        texture.dispose();
        disposeDetachedImagePanel(root, mesh);
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      material.map = texture;
      material.color.set(hasLink ? 0xffffff : 0x5f6b9f);
      material.needsUpdate = true;
      if (attachPanel()) {
        panel.targetOpacity = hasLink ? 1.0 : 0.78;
      } else {
        disposeDetachedImagePanel(root, mesh);
      }
    },
    () => {
      finishLoad();
      // Image couldn't be fetched/decoded (source 403, oversized, etc.).
      if (generation !== tunnelPanelGeneration) {
        disposeDetachedImagePanel(root, mesh);
        return;
      }
      if (DEBUG_UI) {
        console.warn("[Surface Browser] skipped tunnel image that failed to load", item.imageUrl);
      }
      // Only attach tunnel panels after a real texture loads. A visible failure
      // tile reads as a placeholder in motion, especially for image search.
      disposeDetachedImagePanel(root, mesh);
    }
  );
}

function updatePanelFades(dt) {
  const fadeStep = dt / TUNNEL_FADE_IN_SECONDS;
  for (let i = imagePanels.length - 1; i >= 0; i -= 1) {
    const panel = imagePanels[i];
    if (panel.currentOpacity < panel.targetOpacity) {
      panel.currentOpacity = Math.min(panel.targetOpacity, panel.currentOpacity + fadeStep);
    } else if (panel.currentOpacity > panel.targetOpacity) {
      panel.currentOpacity = Math.max(panel.targetOpacity, panel.currentOpacity - fadeStep);
    }
    panel.mesh.material.opacity = panel.currentOpacity;

    if (panel.failed && panel.currentOpacity <= 0.001) {
      disposeImagePanel(panel);
      imagePanels.splice(i, 1);
    }
  }
}

function setImagePanels(items) {
  clearPanels();
  // setImagePanels replaces a complete non-progressive load. Start its status
  // count afresh even when invoked outside the normal request path.
  state.tunnelSpawnedPanelCount = 0;
  const maxPanels = Math.min(items.length, MAX_PANELS);
  state.lastSpawnedPanelRing = state.currentRingFloat + 20;
  state.pendingPanelItems = items.slice(0, maxPanels);
  state.spawnAccumulatorMs = IMAGE_SPAWN_INTERVAL_MS;
}

function appendImagePanels(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const visibleAndPending = imagePanels.length + state.pendingPanelItems.length + pendingTunnelPanelLoads;
  const remaining = Math.max(0, MAX_PANELS - visibleAndPending);
  if (remaining === 0) {
    return;
  }
  state.pendingPanelItems.push(...items.slice(0, remaining));
  if (state.pendingPanelItems.length > 0 && imagePanels.length === 0) {
    state.spawnAccumulatorMs = IMAGE_SPAWN_INTERVAL_MS;
  }
}

function updatePanelSpawning(dt) {
  if (state.pendingPanelItems.length === 0) {
    return;
  }
  state.spawnAccumulatorMs += dt * 1000;
  while (state.pendingPanelItems.length > 0 && state.spawnAccumulatorMs >= IMAGE_SPAWN_INTERVAL_MS) {
    state.spawnAccumulatorMs -= IMAGE_SPAWN_INTERVAL_MS;
    const item = state.pendingPanelItems.shift();
    spawnPanel(item, imagePanels.length);
  }
}

function flushPendingPanelSpawnsForDebug() {
  while (state.pendingPanelItems.length > 0 && imagePanels.length < MAX_PANELS) {
    const item = state.pendingPanelItems.shift();
    spawnPanel(item, imagePanels.length);
    const panel = imagePanels[imagePanels.length - 1];
    if (panel) {
      panel.currentOpacity = panel.targetOpacity;
      panel.mesh.material.opacity = panel.targetOpacity;
    }
  }
  state.spawnAccumulatorMs = 0;
}

function removeExpiredPanels() {
  if (imagePanels.length === 0) {
    return;
  }
  for (let i = imagePanels.length - 1; i >= 0; i -= 1) {
    const panel = imagePanels[i];
    if (state.currentRingFloat - panel.spawnRing <= 65) {
      continue;
    }
    disposeImagePanel(panel);
    imagePanels.splice(i, 1);
  }
}

function advanceTunnel(dt) {
  if (!state.tunnelConfig || state.appState === AppState.INSIDE_SPHERE) {
    return;
  }
  if (!Number.isFinite(dt) || dt <= 0) {
    return;
  }
  const ringsToAdvance = (state.cameraSpeed * dt) / state.tunnelConfig.distBetweenRings;
  state.currentRingFloat += ringsToAdvance;

  if (state.appState === AppState.TUNNEL) {
    const maxRing = maxCameraRing();
    if (state.currentRingFloat > maxRing) {
      const loopSpan = Math.max(1, maxRing - TUNNEL_WRAP_START_RING);
      const overshoot = state.currentRingFloat - maxRing;
      state.currentRingFloat = TUNNEL_WRAP_START_RING + (overshoot % loopSpan);
      state.lastSpawnedPanelRing = state.currentRingFloat + 20;
      state.tunnelSettledMs = 0;
      clearSpawnedPanels();
    }
    return;
  }

  if (state.currentRingFloat > state.tunnelConfig.pathRings - 2) {
    state.currentRingFloat = state.tunnelConfig.pathRings - 2;
  }
}

function updateWorldTransform() {
  if (!state.tunnelSamples) {
    return;
  }

  // `_pathSample` is safe to pass here (and only here): the result is consumed
  // into worldGroup.matrix before this function returns and never handed out.
  const sample = sampleAlongPath(state.tunnelSamples, state.currentRingFloat, _pathSample);
  if (!sample) {
    return;
  }

  // Note the copies: sample.forward and sample.up are the shared scratch vectors,
  // so neither .cross() nor .negate() may run on them in place.
  const right = _worldRight.copy(sample.forward).cross(sample.up).normalize();
  const negatedForward = _worldNegForward.copy(sample.forward).negate();
  const rotation = _worldRotation.makeBasis(right, sample.up, negatedForward);
  const inverseRotation = _worldInverseRotation.copy(rotation).invert();
  const translation = _worldTranslation.makeTranslation(-sample.pos.x, -sample.pos.y, -sample.pos.z);
  const finalTransform = _worldFinalTransform.multiplyMatrices(inverseRotation, translation);

  if (renderer.xr.isPresenting) {
    const xrCamera = renderer.xr.getCamera(camera);
    xrCamera.updateMatrixWorld();
    _xrHeadPosition.setFromMatrixPosition(xrCamera.matrixWorld);
    if (
      Number.isFinite(_xrHeadPosition.x)
      && Number.isFinite(_xrHeadPosition.y)
      && Number.isFinite(_xrHeadPosition.z)
    ) {
      _xrHeadCentering.makeTranslation(_xrHeadPosition.x, _xrHeadPosition.y, _xrHeadPosition.z);
      finalTransform.premultiply(_xrHeadCentering);
    }
  }

  worldGroup.matrix.copy(finalTransform);
  worldGroup.matrixWorldNeedsUpdate = true;
}

function updateTunnelPortalClipPlane() {
  if (!state.tunnelPortalClipActive) {
    return;
  }
  sphereGroup.updateMatrixWorld(true);
  const portalPoint = sphereGroup.position.clone();
  // Three.js clipping keeps the half-space the normal points toward (`n·x + c > 0`).
  // We keep the tunnel on the camera's side of the portal and clip the part beyond
  // the sphere. The sphere's local forward points further down the tunnel (away
  // from the camera), so it must be negated; otherwise the near tunnel is clipped,
  // exposing the raw background as a pale wash and leaving the far tunnel visible
  // past the portal.
  const portalNormal = sphereAnchorForward
    .clone()
    .transformDirection(worldGroup.matrix)
    .normalize()
    .negate();
  tunnelPortalClipPlane.setFromNormalAndCoplanarPoint(portalNormal, portalPoint);
}

export {
  disposeTunnel,
  nextTunnelRunStartRing,
  buildTunnelMaterial,
  setTunnelRenderState,
  setTunnelClipPlane,
  rebuildTunnel,
  clearPanels,
  getRingVectors,
  getRingVectorsAtIndex,
  applySwiftPanelOrientation,
  spawnPanel,
  updatePanelFades,
  setImagePanels,
  appendImagePanels,
  updatePanelSpawning,
  flushPendingPanelSpawnsForDebug,
  removeExpiredPanels,
  advanceTunnel,
  updateTunnelDrawRange,
  updateWorldTransform,
  updateTunnelPortalClipPlane
};
