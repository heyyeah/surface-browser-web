// Sphere: build/clear, animation, selection, zoom/rotation deltas, link
// activation, exit, and per-frame placement.

import * as THREE from "three";
import { loadProxiedTexture } from "./proxied-texture.js";
import {
  SPHERE_IDLE_COLOR,
  SPHERE_SELECTION_HYSTERESIS_RAD,
  SPHERE_IMAGE_COUNT,
  SPHERE_ENTRY_LEAD_RINGS,
  SPHERE_ENTRY_AFTER_LAST_PANEL_RINGS,
  SPHERE_EXIT_DISTANCE_RINGS,
  SPHERE_IRIS_OPEN_SECONDS,
  SPHERE_IRIS_OPEN_START_SCALE,
  SPHERE_PREVIEW_MIN_SCALE,
  SPHERE_PREVIEW_MAX_SCALE,
  SPHERE_EXIT_MIN_SPEED,
  TUNNEL_TUBE_OPACITY,
  SPHERE_VIEW_OFFSET_INWARD_MAX,
  SPHERE_VIEW_OFFSET_OUTWARD_MAX,
  SPHERE_NO_LINK_COLOR,
  SPHERE_ROTATION_BRAKE,
  AppState,
  AXIS_X,
  AXIS_Y,
  AXIS_Z
} from "./constants.js";
import { state } from "./state.js";
import { urlInput, speedInput } from "./dom.js";
import {
  renderer,
  camera,
  worldGroup,
  imageGroup,
  sphereGroup,
  sphereContentGroup,
  spherePanels,
  sphereViewOffset,
  sphereOrientation,
  sphereAnchorPosition,
  sphereAnchorForward,
  sphereAnchorUp,
  sphereAnchorRight,
  TMP_DIR,
  DEFAULT_CAMERA_SPEED,
  _sphereZoomPerp
} from "./scene.js";
import { clamp, disposeMaterial } from "./helpers.js";
import { DEBUG_UI } from "./config.js";
import { setStatus, sphereIdentityForItem, isStatusFooterEnabled } from "./ui.js";
import { t } from "./i18n.js";
import { getRingVectorsAtIndex, setTunnelClipPlane, setTunnelRenderState } from "./tunnel.js";
import { buildCurvedPlaneGeometry } from "./curved-plane-geometry.js";
import { shortSourceLabel } from "./tunnel-progress.js";
import { genAiAddressText } from "./navigation.js";
import { genAiBatchCount } from "./settings.js";
import { SESSION_HEADERS } from "./session-id.js";
import {
  driftDirectionAfterRotation,
  sphereLayerSpreadMultiplier,
  manualLayerDifferential,
  stepDriftResume,
  stepCoastSpeed,
  SPHERE_COAST_TAU_STICK_S,
  DRIFT_RESUME_DELAY_S,
  DRIFT_RESUME_SECONDS
} from "./xr-hand-gestures.js";

const SPHERE_PANEL_BASE_RADIUS = 9.5;
const SPHERE_PANEL_RADIUS_STEP = 0.18;
const SPHERE_PANEL_BASE_ARC = 7.0;
const SPHERE_PANEL_BASE_HEIGHT = 5.5;
const SPHERE_PANEL_BASE_AREA = SPHERE_PANEL_BASE_ARC * SPHERE_PANEL_BASE_HEIGHT;
// Selection border width. A build-time geometry constant (baked into borderMesh
// at panel creation or layout change), not a per-frame cost; see
// SPHERE_SELECTION_PULSE_* for the per-frame animated part.
const SPHERE_PANEL_BORDER_PAD = 0.4;
const SPHERE_PANEL_MIN_ASPECT = 0.55;
const SPHERE_PANEL_MAX_ASPECT = 2.2;
const SPHERE_PANEL_MIN_ARC = 4.7;
const SPHERE_PANEL_MAX_ARC = 8.6;
const SPHERE_PANEL_MIN_HEIGHT = 4.1;
const SPHERE_PANEL_MAX_HEIGHT = 7.2;
const SPHERE_PANEL_CURVE_SEGMENTS = 32;
// Selection-marker prominence. Base opacity keeps linked panels more prominent
// than unlinked; the pulse layers a brief, decaying scale-pop and opacity flash
// whenever the gaze selection changes, so a flip reads as motion. Driven off
// elapsed seconds (state.sphereSelectionPulseElapsed): a smoothstep and a few
// scalar writes on the one selected panel, no geometry rebuild.
const SPHERE_BORDER_OPACITY_LINKED = 0.95;
const SPHERE_BORDER_OPACITY_UNLINKED = 0.65;
const SPHERE_SELECTION_PULSE_SECONDS = 0.35;
const SPHERE_SELECTION_PULSE_SCALE = 0.22;
const SPHERE_SELECTION_PULSE_OPACITY_BOOST = 0.35;
const SPHERE_PREVIEW_FAN_SPACING = -0.54;
const SPHERE_PREVIEW_FAN_CENTER = 0.35;
const SPHERE_PREVIEW_FAN_PIVOT_Y = -2.2;
const SPHERE_PREVIEW_FAN_OPEN_MULTIPLIER = 1.28;
const SPHERE_SHUTTER_FORMING_SPREAD = -0.18;
// Single-clock "bloom" entry: one shared sweep about the view axis (the camera-
// shutter rotation) decays exponentially while scale, fan spacing, pivot
// release and the fan-to-sphere rotation all ride one eased clock. The decay
// runs on the UNCLAMPED clock, so the roll never "ends": it crosses the
// idle-drift speed near the nominal clock end and keeps fading beneath it, which
// makes the swipe-to-rotation handoff seamless.
const SPHERE_BLOOM_SWEEP_RADIANS = Math.PI / 2;
// e-foldings per clock length. 3.4 puts the sweep's angular rate at about the
// cruise drift speed exactly when the clock reaches 1 (rate = k*SWEEP*e^-k/T).
const SPHERE_BLOOM_SWEEP_DECAY = 3.4;
// Idle sphere drift (rad/s). Runs underneath the bloom from its first frame so
// the opening decays into cruise with no velocity jump at the handoff.
//
// Signed by state.sphereDriftDirection: a fixed sense would reassert itself once
// a throw or drag release had decayed and reverse the viewer's motion. Both
// exits aim it to match the release; see driftDirectionAfterRotation() in
// xr-hand-gestures.js for why the choice is made there.
const SPHERE_BASE_ROTATION_SPEED = -0.12;
// Which pole the closed fan gathers on. 'near' = the entry side (touching the
// tunnel mouth), so the bloom peels panels away from the entry point, like the
// original Java (axis-projected textures dilated radially off the tunnel axis).
// 'far' = the wall straight ahead (Swift port): panels open across the view
// centre.
const SPHERE_BLOOM_GATHER_SIDE = "near";

// Outer bound on the img2img source import. The exit is already flying when the
// request goes out and EXITING_SPHERE clamps the camera at the end of the path,
// so a request that never settles would strand the viewer at a dead stop. The
// server's upstream fetch times out at 15 s; this covers that plus the resize.
const GENAI_SOURCE_IMPORT_TIMEOUT_MS = 25000;

// Per-image caption: the mode-dependent identity line renders as a thin curved
// child plane hugging the aimed panel's bottom border. Only the aimed panel
// shows one. A separate child plane is cheaper than compositing text into the
// image texture, and inherits the panel's world transform.
const SPHERE_CAPTION_HEIGHT_M = 0.54;   // vertical extent of the caption plane
const SPHERE_CAPTION_GAP_M = 0.12;      // gap between panel bottom and caption
const SPHERE_CAPTION_CANVAS_H = 96;     // backing-store height (px)
const SPHERE_CAPTION_MAX_CHARS = 72;    // clip length for the identity line
const SPHERE_CAPTION_CURVE_SEGMENTS = 24;
// Every image panel (and its border) must render before the selected caption,
// which is then depth-tested against the completed panel depth buffer.
const SPHERE_CAPTION_RENDER_ORDER = 1000;
// Captions sit on a stable shell just inside the innermost image layer, so
// normal viewing is free of far-side occlusion without chasing the camera or
// changing the caption's apparent size during zoom.
const SPHERE_CAPTION_VIEWER_INSET_M = 1.50;
const _pointerRotX = new THREE.Quaternion();
const _pointerRotY = new THREE.Quaternion();

function clearSphere() {
  for (const panel of spherePanels) {
    panel.textureRequestId += 1;
  }
  sphereContentGroup.traverse((child) => {
    if (!child.isMesh && !child.isLine) {
      return;
    }
    if (child.geometry) {
      child.geometry.dispose();
    }
    disposeMaterial(child.material);
  });
  spherePanels.length = 0;
  sphereAnchorPosition.set(0, 0, 0);
  sphereAnchorForward.set(0, 0, -1);
  sphereAnchorUp.set(0, 1, 0);
  sphereAnchorRight.set(1, 0, 0);
  setTunnelClipPlane(false);

  while (sphereContentGroup.children.length > 0) {
    sphereContentGroup.remove(sphereContentGroup.children[0]);
  }
  sphereContentGroup.position.set(0, 0, 0);
  sphereContentGroup.quaternion.identity();
  sphereGroup.position.set(0, 0, 0);
  sphereGroup.quaternion.identity();
  sphereGroup.visible = false;
  resetSphereAnimationState();
}

function resetSphereAnimationState() {
  state.irisXRot = 0;
  state.irisYRot = 0;
  state.irisXSpeed = 0.3;
  state.irisYSpeed = 0.3;
  state.irisForming = true;
  state.sphereSelectedIndex = 0;
  state.sphereSelectionPulseElapsed = 0;
  state.sphereXRotSpeed = 0;
  state.sphereYRotSpeed = 0;
  // The coast forgets the last sphere's throw along with the speed it was
  // decaying: a fresh sphere starts at stick feel.
  state.sphereCoastTauS = SPHERE_COAST_TAU_STICK_S;
  state.sphereRotationPaused = false;
  // Back to the default drift sense: a throw in the last sphere must not decide
  // which way the next one turns.
  state.sphereDriftDirection = 1;
  // A fresh sphere drifts from the first frame rather than ramping in; the ramp
  // exists to get out of the way of a release.
  state.sphereDriftGain = 1;
  state.sphereDriftHoldSeconds = 0;
  state.sphereTextureCursor = 0;
  state.sphereTextureCycleRadians = 0;
  sphereOrientation.identity();
  sphereContentGroup.position.set(0, 0, 0);
  sphereContentGroup.quaternion.identity();
  sphereContentGroup.scale.setScalar(1);
  state.sphereIrisOpenElapsed = 0;
}

function getImageAspectRatio(width, height) {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight) || parsedWidth <= 0 || parsedHeight <= 0) {
    return SPHERE_PANEL_BASE_ARC / SPHERE_PANEL_BASE_HEIGHT;
  }
  return clamp(parsedWidth / parsedHeight, SPHERE_PANEL_MIN_ASPECT, SPHERE_PANEL_MAX_ASPECT);
}

function getSpherePanelLayout(width, height) {
  const aspect = getImageAspectRatio(width, height);
  return {
    aspect,
    arcLength: clamp(Math.sqrt(SPHERE_PANEL_BASE_AREA * aspect), SPHERE_PANEL_MIN_ARC, SPHERE_PANEL_MAX_ARC),
    height: clamp(Math.sqrt(SPHERE_PANEL_BASE_AREA / aspect), SPHERE_PANEL_MIN_HEIGHT, SPHERE_PANEL_MAX_HEIGHT)
  };
}

function smoothstep(t) {
  const clamped = clamp(t, 0, 1);
  return clamped * clamped * (3 - (2 * clamped));
}

function smootherstep(t) {
  const clamped = clamp(t, 0, 1);
  return clamped * clamped * clamped * (clamped * ((clamped * 6) - 15) + 10);
}

function buildSpherePanelGeometry(radius, layout, border = false) {
  const pad = border ? SPHERE_PANEL_BORDER_PAD : 0;
  return buildCurvedPlaneGeometry({
    radius,
    arcLength: layout.arcLength + pad,
    height: layout.height + pad,
    segments: SPHERE_PANEL_CURVE_SEGMENTS
  });
}

function applySpherePanelLayout(panel, width, height) {
  const layout = getSpherePanelLayout(width, height);
  if (panel.layoutAspect !== undefined && Math.abs(panel.layoutAspect - layout.aspect) < 0.02) {
    return;
  }

  panel.mesh.geometry.dispose();
  panel.mesh.geometry = buildSpherePanelGeometry(panel.radius, layout);
  panel.borderMesh.geometry.dispose();
  panel.borderMesh.geometry = buildSpherePanelGeometry(panel.radius, layout, true);
  panel.layout = layout;
  panel.layoutAspect = layout.aspect;
  // The image's true aspect changed the panel height/arc; re-fit the caption
  // plane to the new bottom border.
  positionSphereCaption(panel);
}

// ---------------------------------------------------------------------------
// Per-image caption. A thin curved child plane of panel.mesh just below the
// panel's bottom edge, carrying the identity line for the aimed image only. Its
// canvas texture is redrawn only when the text changes.
// ---------------------------------------------------------------------------

function ensureSphereCaption(panel) {
  if (panel.caption) {
    return panel.caption;
  }
  const canvas = document.createElement("canvas");
  // Width tracks the panel arc so text isn't stretched; height is fixed.
  const arc = panel.layout ? panel.layout.arcLength : SPHERE_PANEL_BASE_ARC;
  canvas.width = Math.max(256, Math.round(arc * 128));
  canvas.height = SPHERE_CAPTION_CANVAS_H;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // The one canvas texture deliberately left with its mip chain (the flat UI
  // quads dropped theirs; see vrpanel.js createPanelSurface()). The caption is
  // curved geometry seen at oblique angles from inside the sphere, which is what
  // mipmaps and anisotropy are for, and it uploads only when its text changes
  // (panel.caption.lastText), so there is no upload cost to save. Do not "make
  // it consistent".
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    // depthTest stays ON: the image matters more than its label, so on any
    // overlap the depth buffer must cut the caption. Overlap with the parent is
    // prevented geometrically in orientSphereCaption(), which keeps the caption
    // below the panel's lowest on-screen extent at any roll.
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.visible = false;
  // Do not inherit the parent panel's renderOrder: a later panel could
  // painter-overwrite an earlier panel's caption where no depth fragment
  // exists. Render every caption after the complete image stack; depthTest stays
  // ON and orientSphereCaption keeps it outside the selected image's perimeter.
  mesh.renderOrder = SPHERE_CAPTION_RENDER_ORDER;
  panel.mesh.add(mesh);
  panel.caption = { mesh, canvas, ctx, texture, lastText: null };
  positionSphereCaption(panel);
  return panel.caption;
}

// Build/replace the caption's curved geometry. panel.mesh's local frame has z
// as the vertical axis with the panel centred at z=0 (see
// curved-plane-geometry.js). The panel can be rolled to any clock position, so
// local -z is NOT reliably the visually-lower edge; the real placement and
// upright orientation are recomputed each frame in orientSphereCaption(). The
// local bottom seeds a fallback for when orient runs before a world matrix exists.
function positionSphereCaption(panel) {
  if (!panel.caption) {
    return;
  }
  const layout = panel.layout || { arcLength: SPHERE_PANEL_BASE_ARC, height: SPHERE_PANEL_BASE_HEIGHT };
  // A panel is built at the fallback aspect, then re-laid out once its image
  // reports real dimensions. Resize the raster with its geometry and force a
  // redraw so text and box share a centre for portrait and landscape images.
  const canvasWidth = Math.max(256, Math.round(layout.arcLength * 128));
  if (panel.caption.canvas.width !== canvasWidth) {
    panel.caption.canvas.width = canvasWidth;
    panel.caption.ctx = panel.caption.canvas.getContext("2d");
    panel.caption.lastText = null;
    // Resizing the backing canvas does NOT resize the GPU texture: three.js
    // allocates immutable storage (texStorage2D) at the first upload and later
    // uploads go through texSubImage2D at the ORIGINAL dimensions. After a
    // shrink the old wider label survives as a phantom beside the new box (a
    // grow logs glTexSubImage2D "Offset overflows texture dimensions").
    // dispose() drops the GL object so the next upload re-allocates.
    panel.caption.texture.dispose();
  }
  // The eight panel layers are only 0.18 m apart, so a caption offset from its
  // own radius can end up behind inner panels. Anchor it just inside the
  // innermost active layer: a stable sphere-relative shell that zoom cannot
  // resize or pull through the selected image.
  const innermostPanelRadius = spherePanels.reduce(
    (nearest, candidate) => Math.min(nearest, candidate.radius),
    panel.radius
  );
  const geometry = buildCurvedPlaneGeometry({
    radius: Math.max(0.1, innermostPanelRadius - SPHERE_CAPTION_VIEWER_INSET_M),
    arcLength: layout.arcLength,
    height: SPHERE_CAPTION_HEIGHT_M,
    segments: SPHERE_CAPTION_CURVE_SEGMENTS
  });
  const captionRadius = Math.max(0.1, innermostPanelRadius - SPHERE_CAPTION_VIEWER_INSET_M);
  // Curved-plane geometry is authored around the sphere origin (vertices at
  // y=radius). Re-centre it on the caption mesh origin and carry that radius on
  // the mesh position so caption transforms stay local.
  geometry.translate(0, -captionRadius, 0);
  panel.caption.mesh.geometry.dispose();
  panel.caption.mesh.geometry = geometry;
  panel.caption.radius = captionRadius;
  panel.caption.edgeOffset = layout.height / 2 + SPHERE_CAPTION_GAP_M + SPHERE_CAPTION_HEIGHT_M / 2;
  panel.caption.mesh.position.set(0, captionRadius, -panel.caption.edgeOffset);
  panel.caption.mesh.quaternion.identity();
}

// Scratch objects for orientSphereCaption: no per-frame allocation (runs for the
// single aimed panel each visible frame).
const _capPanelQuat = new THREE.Quaternion();
const _capPanelQuatInv = new THREE.Quaternion();
const _capNormalWorld = new THREE.Vector3();
const _capUpWorld = new THREE.Vector3();
const _capTargetUp = new THREE.Vector3();
const _capDesiredWorldQuat = new THREE.Quaternion();
const _capLocalQuat = new THREE.Quaternion();
const _capBasis = new THREE.Matrix4();
const _capRight = new THREE.Vector3();
const _capUp = new THREE.Vector3();
const _capFwd = new THREE.Vector3();
const _capDownLocal = new THREE.Vector3();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// Place the caption below the panel's visually-lowest extent with upright text,
// whatever the panel's roll. The caption is a child of panel.mesh, which is
// rolled by panel.container, so its LOCAL bottom (-z) may point up or sideways
// in the world. Steps:
//   1. read panel.mesh's world orientation,
//   2. project world-down into the panel plane and slide the caption along it,
//      just past the panel rectangle's half-extent in that direction, so the bar
//      hugs the lowest edge or corner and never overlaps the image (a rolled
//      panel's lowest point can be a corner),
//   3. build a world orientation whose up is world-up (projected into the panel
//      plane) and whose forward is the panel's viewing normal, then convert it
//      to a caption-local quaternion so the text is upright.
function orientSphereCaption(panel) {
  const caption = panel.caption;
  if (!caption) {
    return;
  }

  panel.mesh.getWorldQuaternion(_capPanelQuat);
  _capPanelQuatInv.copy(_capPanelQuat).invert();

  // World directions of the panel's local vertical axis (+z = local top).
  _capUpWorld.set(0, 0, 1).applyQuaternion(_capPanelQuat).normalize();
  // Panel viewing normal: geometry normal at centre is local -y (curves inward);
  // the caption faces the same way as the panel.
  _capNormalWorld.set(0, -1, 0).applyQuaternion(_capPanelQuat).normalize();

  // Desired world up for the text: world-up projected into the panel plane, so
  // the line stays horizontal for the viewer. Degenerate when the panel faces
  // straight up/down; fall back to the panel's own up to avoid dividing by ~0.
  _capTargetUp.copy(_WORLD_UP).addScaledVector(_capNormalWorld, -_WORLD_UP.dot(_capNormalWorld));
  if (_capTargetUp.lengthSq() < 1e-6) {
    _capTargetUp.copy(_capUpWorld);
  } else {
    _capTargetUp.normalize();
  }

  // Slide the caption around the panel perimeter: offset from the panel centre
  // along in-plane world-down, past the rectangle's half-extent in that
  // direction. At 0/90 deg roll that is height/2 or arc/2 (hugging an edge); in
  // between it is the support of the rotated rectangle (hugging the lowest
  // corner). The caption is upright, so its own clearance is its half-height.
  // Continuous in roll, no side flip.
  const layout = panel.layout || { arcLength: SPHERE_PANEL_BASE_ARC, height: SPHERE_PANEL_BASE_HEIGHT };
  _capDownLocal.copy(_capTargetUp).negate().applyQuaternion(_capPanelQuatInv);
  _capDownLocal.y = 0; // in-plane by construction; drop numerical residue
  if (_capDownLocal.lengthSq() < 1e-6) {
    _capDownLocal.set(0, 0, -1);
  }
  _capDownLocal.normalize();
  const halfExtentDown = ((layout.arcLength / 2) * Math.abs(_capDownLocal.x))
    + ((layout.height / 2) * Math.abs(_capDownLocal.z));
  const dropDistance = halfExtentDown + SPHERE_CAPTION_GAP_M + (SPHERE_CAPTION_HEIGHT_M / 2);
  caption.mesh.position.set(
    _capDownLocal.x * dropDistance,
    caption.radius || panel.radius,
    _capDownLocal.z * dropDistance
  );

  // Build the caption's desired WORLD orientation from an orthonormal basis.
  // Caption local frame (same as the panel geometry): +z = texture up, +x =
  // texture right, +y points INTO the panel = -outwardNormal. makeBasis wants
  // columns (xAxis, yAxis, zAxis); a y-column of -normal keeps the caption
  // facing the viewer, and right = (yCol x up) makes a proper rotation (det +1).
  // Using +normal or right = up x fwd yields a reflection and mirrors the glyphs.
  _capFwd.copy(_capNormalWorld).negate();   // caption local +y world image
  _capUp.copy(_capTargetUp);                // caption local +z world image
  _capRight.crossVectors(_capFwd, _capUp).normalize();
  // Re-orthogonalize the into-panel axis against right/up in case normal and
  // target-up drifted off-perpendicular.
  _capFwd.crossVectors(_capUp, _capRight).normalize();
  _capBasis.makeBasis(_capRight, _capFwd, _capUp);
  _capDesiredWorldQuat.setFromRotationMatrix(_capBasis);

  // Convert to a LOCAL quaternion (parent is panel.mesh):
  // localQ = inverse(panelWorldQ) * worldQ.
  _capLocalQuat.copy(_capPanelQuatInv).multiply(_capDesiredWorldQuat);
  caption.mesh.quaternion.copy(_capLocalQuat);
}

function drawSphereCaption(panel, text) {
  const caption = ensureSphereCaption(panel);
  if (caption.lastText === text) {
    return;
  }
  caption.lastText = text;
  const ctx = caption.ctx;
  const w = caption.canvas.width;
  const h = caption.canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!text) {
    caption.texture.needsUpdate = true;
    return;
  }
  ctx.fillStyle = "rgba(7, 12, 20, 0.78)";
  roundRectPath(ctx, 4, 6, w - 8, h - 12, 16);
  ctx.fill();
  ctx.strokeStyle = "rgba(83, 169, 255, 0.42)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#dbe6ff";
  ctx.font = "600 44px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // `textAlign = center` centres the font's advance width, which can be
  // asymmetric for fallback colour-emoji glyphs. Centre the painted bounds
  // instead.
  const metrics = ctx.measureText(text);
  const visualCenterOffset = (
    Number.isFinite(metrics.actualBoundingBoxLeft)
    && Number.isFinite(metrics.actualBoundingBoxRight)
  )
    ? (metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2
    : 0;
  ctx.fillText(text, (w / 2) + visualCenterOffset, h / 2 + 2);
  caption.texture.needsUpdate = true;
}

function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Show the identity caption only under the currently aimed panel; hide the
// rest. Called whenever selection or readiness changes. Off entirely when the
// "Show info" setting is disabled.
function updateSphereCaptions() {
  const footerOn = isStatusFooterEnabled();
  for (let i = 0; i < spherePanels.length; i += 1) {
    const panel = spherePanels[i];
    const isSelected = i === state.sphereSelectedIndex;
    if (!footerOn || !isSelected || !panel.ready) {
      if (panel.caption) {
        panel.caption.mesh.visible = false;
      }
      continue;
    }
    const item = state.extractedItems[panel.itemIndex];
    const text = sphereIdentityForItem(item, panel, state.currentLoadMode, SPHERE_CAPTION_MAX_CHARS);
    drawSphereCaption(panel, text);
    const visible = Boolean(text);
    panel.caption.mesh.visible = visible;
    // Re-hug the lowest edge every frame so it tracks the panel's animated roll.
    // Cheap: only the one aimed panel gets here.
    if (visible) {
      orientSphereCaption(panel);
    }
  }
}

function spawnSphereFromExtractedItems() {
  if (state.extractedItems.length === 0 || state.appState !== AppState.TUNNEL) {
    return;
  }

  const safeRing = Math.max(
    state.currentRingFloat + SPHERE_ENTRY_LEAD_RINGS,
    state.lastSpawnedPanelRing + SPHERE_ENTRY_AFTER_LAST_PANEL_RINGS
  );
  const ringVectors = getRingVectorsAtIndex(Math.floor(safeRing));
  if (!ringVectors) {
    return;
  }

  clearSphere();
  state.pendingPanelItems = [];

  sphereAnchorPosition.copy(ringVectors.center);
  sphereAnchorForward.copy(ringVectors.forward).normalize();
  sphereAnchorUp.copy(ringVectors.up).normalize();
  sphereAnchorRight.copy(ringVectors.right).normalize();
  sphereGroup.position.set(0, 0, 0);
  sphereGroup.quaternion.identity();
  sphereContentGroup.position.set(0, 0, 0);
  sphereContentGroup.quaternion.identity();
  sphereGroup.visible = true;
  const panelCount = Math.min(SPHERE_IMAGE_COUNT, state.extractedItems.length);
  state.sphereTextureCursor = panelCount;
  state.sphereSelectedIndex = Math.max(
    0,
    state.extractedItems.slice(0, panelCount).findIndex((item) => item.linkUrl || (item.navigationMode && item.navigationQuery))
  );

  for (let i = 0; i < panelCount; i += 1) {
    const itemIndex = i;
    const item = state.extractedItems[itemIndex];
    const hasLink = Boolean(item.linkUrl || (item.navigationMode && item.navigationQuery));
    const panelRadius = SPHERE_PANEL_BASE_RADIUS - i * SPHERE_PANEL_RADIUS_STEP;
    const panelLayout = getSpherePanelLayout(item.width, item.height);
    const geometry = buildSpherePanelGeometry(panelRadius, panelLayout);
    const material = new THREE.MeshBasicMaterial({
      color: i === state.sphereSelectedIndex ? 0xffffff : (hasLink ? SPHERE_IDLE_COLOR : SPHERE_NO_LINK_COLOR),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      depthTest: true
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.renderOrder = (SPHERE_IMAGE_COUNT - i) * 10;

    const borderGeometry = buildSpherePanelGeometry(panelRadius, panelLayout, true);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: true
    });
    const borderMesh = new THREE.Mesh(borderGeometry, borderMaterial);
    borderMesh.visible = i === state.sphereSelectedIndex;
    borderMesh.renderOrder = ((SPHERE_IMAGE_COUNT - i) * 10) - 1;
    mesh.add(borderMesh);

    const panelContainer = new THREE.Group();
    panelContainer.add(mesh);
    sphereContentGroup.add(panelContainer);

    spherePanels.push({
      container: panelContainer,
      mesh,
      material,
      borderMesh,
      radius: panelRadius,
      layout: panelLayout,
      imageUrl: item.imageUrl,
      linkUrl: item.linkUrl || null,
      navigationMode: item.navigationMode || null,
      navigationQuery: item.navigationQuery || null,
      navigationSource: item.navigationSource || null,
      hasLink: hasLink || Boolean(item.navigationMode && item.navigationQuery),
      itemIndex,
      layoutAspect: panelLayout.aspect,
      ready: false,
      textureRequestId: 0
    });

    loadSpherePanelTexture(spherePanels[spherePanels.length - 1], item, itemIndex);
  }

  state.targetSphereRing = safeRing;
  state.sphereDwellSeconds = 0;
  state.appState = AppState.TRANSITION_TO_SPHERE;
  setTunnelClipPlane(false);
  setStatus(t("status.transitioning"), true);
}

// Returns the active viewing camera (the XR camera rig in immersive VR, else the
// desktop camera). The XR camera tracks the headset, so panel directions are
// dotted against its live forward vector for look-to-select.
function getActiveCamera() {
  return renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
}

function spherePanelIdleColor(panel) {
  return panel.hasLink ? SPHERE_IDLE_COLOR : SPHERE_NO_LINK_COLOR;
}

function setSpherePanelSelected(panel, selected) {
  panel.material.color.set(selected ? 0xffffff : spherePanelIdleColor(panel));
  panel.borderMesh.visible = selected;
  if (panel.borderMesh.material) {
    panel.borderMesh.material.opacity = panel.hasLink
      ? SPHERE_BORDER_OPACITY_LINKED
      : SPHERE_BORDER_OPACITY_UNLINKED;
  }
  // While INSIDE_SPHERE, updateSphereTransitionAppearance() re-derives
  // colour/border visibility/opacity (and selection pulse scale) for every panel
  // from state.sphereSelectedIndex each frame, right after this runs. These
  // writes are a defensive baseline (same constants as that function) and keep a
  // deselected or recycled panel from carrying a stale pulse scale.
  if (!selected) {
    panel.borderMesh.scale.setScalar(1);
  }
}

function loadSpherePanelTexture(panel, item, itemIndex) {
  panel.textureRequestId += 1;
  const requestId = panel.textureRequestId;
  panel.imageUrl = item.imageUrl;
  panel.linkUrl = item.linkUrl || null;
  panel.navigationMode = item.navigationMode || null;
  panel.navigationQuery = item.navigationQuery || null;
  panel.navigationSource = item.navigationSource || null;
  panel.hasLink = Boolean(item.linkUrl || (item.navigationMode && item.navigationQuery));
  panel.itemIndex = itemIndex;
  applySpherePanelLayout(panel, item.width, item.height);
  panel.material.color.set(spherePanelIdleColor(panel));
  panel.material.needsUpdate = true;
  panel.mesh.visible = false;
  panel.borderMesh.visible = false;
  panel.ready = false;

  const proxyUrl = item.imageUrl.startsWith("data:image/") || item.imageUrl.startsWith("/")
    ? item.imageUrl
    : `/api/proxy/image?url=${encodeURIComponent(item.imageUrl)}`;
  loadProxiedTexture(
    proxyUrl,
    (texture) => {
      if (!panel.container.parent || panel.textureRequestId !== requestId) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      applySpherePanelLayout(
        panel,
        texture.image?.naturalWidth || texture.image?.videoWidth || texture.image?.width,
        texture.image?.naturalHeight || texture.image?.videoHeight || texture.image?.height
      );
      const oldMap = panel.material.map;
      panel.material.map = texture;
      if (oldMap && oldMap !== texture) {
        oldMap.dispose();
      }
      panel.material.color.set(
        spherePanels[state.sphereSelectedIndex] === panel ? 0xffffff : spherePanelIdleColor(panel)
      );
      panel.material.needsUpdate = true;
      panel.ready = true;
      panel.mesh.visible = true;
    },
    () => {
      if (!panel.container.parent || panel.textureRequestId !== requestId) {
        return;
      }
      if (DEBUG_UI) {
        console.warn("[Surface Browser] skipped sphere image that failed to load", item.imageUrl);
      }
      // Hide the panel rather than showing a failure-coloured tile. mesh.visible
      // follows panel.ready, so clearing ready keeps it out of the visible sphere
      // and gaze selection.
      if (panel.material.map) {
        panel.material.map.dispose();
      }
      panel.material.map = null;
      panel.material.needsUpdate = true;
      panel.ready = false;
      panel.mesh.visible = false;
      panel.borderMesh.visible = false;
    }
  );
}

// Scratch vectors for gaze selection; no per-frame allocation in the
// INSIDE_SPHERE update loop.
const _gazeCameraPos = new THREE.Vector3();
const _gazeCameraForward = new THREE.Vector3();
const _gazePanelPos = new THREE.Vector3();
const _gazePanelDir = new THREE.Vector3();
const _previewBasePivot = new THREE.Vector3();
const _previewPanelPivot = new THREE.Vector3();

// Bloom/preview pose scratch. The panel loop at the end of
// updateSphereAnimation() would otherwise allocate eight quaternions per panel
// per frame in the hottest loop. Each is written before it is read and dead by
// the end of its iteration, so shared scratch is safe: slerpQuaternions() reads
// both operands and writes the panel's own quaternion, and nothing escapes the
// loop body.
const _bloomFanRot = new THREE.Quaternion();
const _bloomClockRot = new THREE.Quaternion();
const _bloomXSpread = new THREE.Quaternion();
const _bloomYSpread = new THREE.Quaternion();
const _bloomFanPose = new THREE.Quaternion();
const _bloomSpherePose = new THREE.Quaternion();
// Loop- and frame-invariant: both are fixed +/-90 deg rotations about AXIS_X, so
// they are built once at module load.
const _TILT_TO_FAR_WALL = new THREE.Quaternion().setFromAxisAngle(AXIS_X, -Math.PI / 2);
const _TILT_TO_NEAR_WALL = new THREE.Quaternion().setFromAxisAngle(AXIS_X, Math.PI / 2);

// Manual sphere rotation, once per frame (same reasoning).
const _manualRotX = new THREE.Quaternion();
const _manualRotY = new THREE.Quaternion();

// pullSelectedImageToFront() scratch. Private to that function: TMP_DIR is
// shared with the zoom clamp in adjustSphereViewOffset(), so reusing it would
// require clones to avoid aliasing.
const _pullPanelPos = new THREE.Vector3();
const _pullCurrentDir = new THREE.Vector3();
const _pullTargetDir = new THREE.Vector3();
const _pullAxis = new THREE.Vector3();
const _pullRot = new THREE.Quaternion();

// updateSpherePlacement() TRANSITION_TO_SPHERE basis scratch.
const _poseRight = new THREE.Vector3();
const _poseUp = new THREE.Vector3();
const _poseZAxis = new THREE.Vector3();
const _poseBasis = new THREE.Matrix4();

function updateSphereSelectionTint(dt) {
  if (spherePanels.length === 0) {
    return;
  }
  sphereGroup.updateMatrixWorld(true);
  // Advance the selection-pulse clock unconditionally (one add); it is snapped
  // back to 0 below on a flip. updateSphereTransitionAppearance reads it each
  // frame to fade the border pop (see SPHERE_SELECTION_PULSE_*).
  state.sphereSelectionPulseElapsed += dt;

  // Use the live viewing camera so in VR selection follows the headset's real
  // forward direction. On desktop the camera sits at the origin looking down -Z.
  const activeCamera = getActiveCamera();
  activeCamera.getWorldPosition(_gazeCameraPos);
  activeCamera.getWorldDirection(_gazeCameraForward); // already normalized

  let nextSelected = state.sphereSelectedIndex;
  let bestDot = -Infinity;
  let currentDot = -Infinity;

  for (let i = 0; i < spherePanels.length; i += 1) {
    const panel = spherePanels[i];
    if (!panel.ready) {
      continue;
    }
    // Every ready panel is selectable, linked or not: the image nearest the
    // view centre must always be highlighted and captioned. No-link panels keep
    // a dimmer border/tint, and activating one safely does nothing
    // (getSelectedSphereNavigationRequest() returns null; auto-gallery mode
    // falls back to the current query).
    _gazePanelPos.set(0, panel.radius, 0);
    panel.container.localToWorld(_gazePanelPos);
    _gazePanelDir.copy(_gazePanelPos).sub(_gazeCameraPos).normalize();
    const dot = _gazePanelDir.dot(_gazeCameraForward);
    if (i === state.sphereSelectedIndex) {
      currentDot = dot;
    }
    if (dot > bestDot) {
      bestDot = dot;
      nextSelected = i;
    }
  }

  // Hysteresis: two panels almost equally near the view centre would otherwise
  // trade the selection every frame under head tremor or the idle drift.
  if (
    nextSelected !== state.sphereSelectedIndex
    && currentDot > -Infinity
    && Math.acos(Math.min(1, currentDot)) - Math.acos(Math.min(1, bestDot)) < SPHERE_SELECTION_HYSTERESIS_RAD
  ) {
    nextSelected = state.sphereSelectedIndex;
  }

  if (nextSelected !== state.sphereSelectedIndex) {
    markSphereInteraction();
    setSpherePanelSelected(spherePanels[state.sphereSelectedIndex], false);

    state.sphereSelectedIndex = nextSelected;
    setSpherePanelSelected(spherePanels[state.sphereSelectedIndex], true);
    state.sphereSelectionPulseElapsed = 0;

    for (let i = 0; i < spherePanels.length; i += 1) {
      if (i === state.sphereSelectedIndex) {
        continue;
      }
      spherePanels[i].material.color.set(spherePanelIdleColor(spherePanels[i]));
    }
  }

  // Refresh the per-image caption every call (redraw is text-diff guarded) so a
  // newly-ready panel or a settings toggle applies even if the aimed index did
  // not change.
  updateSphereCaptions();
}

function updateSphereTransitionAppearance(fadeProgress, isInsideSphere, irisOpenT = 0) {
  const clampedFade = clamp(fadeProgress, 0, 1);
  // Once the pre-entry bloom starts, panel opacity rides the same eased clock up
  // to full; otherwise the 0.45 -> 1.0 snap at the threshold reads as "the
  // animation only starts now".
  const bloomEase = smoothstep(clamp(irisOpenT, 0, 1));
  // Selection pulse: 1 right after a gaze flip, decaying to 0 over
  // SPHERE_SELECTION_PULSE_SECONDS (state.sphereSelectionPulseElapsed is reset
  // in updateSphereSelectionTint on every flip). One smoothstep per frame,
  // applied only to the selected panel below.
  const selectionPulseStrength = 1 - smoothstep(
    clamp(state.sphereSelectionPulseElapsed / SPHERE_SELECTION_PULSE_SECONDS, 0, 1)
  );
  for (let i = 0; i < spherePanels.length; i += 1) {
    const panel = spherePanels[i];
    if (isInsideSphere) {
      const isSelected = i === state.sphereSelectedIndex;
      panel.mesh.visible = panel.ready;
      panel.material.opacity = 1.0;
      if (!panel.material.depthTest || !panel.material.depthWrite) {
        panel.material.depthTest = true;
        panel.material.depthWrite = true;
        panel.material.needsUpdate = true;
      }
      panel.borderMesh.visible = panel.ready && isSelected;
      // The scale-pop is a Vector3.set on the unchanged border geometry, never a
      // rebuild. curved-plane-geometry.js bakes the sphere radius into each
      // vertex around the SPHERE centre, so local x is the in-plane arc axis, z
      // the in-plane height axis, and y the depth from the sphere centre (~9.5
      // m). A uniform scale would inflate that radial offset and fling the
      // border off the panel, so scale x/z only. Reset to (1,1,1) for every
      // non-selected panel so a deselected or recycled panel carries no stale pop.
      if (isSelected) {
        const popScale = 1 + (SPHERE_SELECTION_PULSE_SCALE * selectionPulseStrength);
        panel.borderMesh.scale.set(popScale, 1, popScale);
      } else {
        panel.borderMesh.scale.set(1, 1, 1);
      }
      if (panel.borderMesh.material) {
        if (!panel.borderMesh.material.depthTest || panel.borderMesh.material.depthWrite) {
          panel.borderMesh.material.depthTest = true;
          panel.borderMesh.material.depthWrite = false;
          panel.borderMesh.material.needsUpdate = true;
        }
        const baseBorderOpacity = panel.hasLink ? SPHERE_BORDER_OPACITY_LINKED : SPHERE_BORDER_OPACITY_UNLINKED;
        panel.borderMesh.material.opacity = isSelected
          ? Math.min(1, baseBorderOpacity + (SPHERE_SELECTION_PULSE_OPACITY_BOOST * selectionPulseStrength))
          : baseBorderOpacity;
      }
      panel.material.color.set(isSelected ? 0xffffff : spherePanelIdleColor(panel));
      continue;
    }
    panel.mesh.visible = panel.ready;
    panel.material.opacity = THREE.MathUtils.lerp(0.18 + (clampedFade * 0.27), 1.0, bloomEase);
    if (panel.material.depthTest || panel.material.depthWrite) {
      panel.material.depthTest = false;
      panel.material.depthWrite = false;
      panel.material.needsUpdate = true;
    }
    // Captions belong to the INSIDE_SPHERE aim experience only; off during the
    // fan/preview and the exit transition.
    if (panel.caption) {
      panel.caption.mesh.visible = false;
    }
    panel.borderMesh.visible = panel.ready;
    if (panel.borderMesh.material) {
      if (panel.borderMesh.material.depthTest || panel.borderMesh.material.depthWrite) {
        panel.borderMesh.material.depthTest = false;
        panel.borderMesh.material.depthWrite = false;
        panel.borderMesh.material.needsUpdate = true;
      }
      panel.borderMesh.material.opacity = 0.3 + (clampedFade * 0.34);
    }
    panel.material.color.set(spherePanelIdleColor(panel));
  }
}

// The pointer hit test. Selection is GAZE (updateSphereSelection() picks the
// panel nearest the camera's forward axis every frame), which suits a headset
// but not a flat screen with a cursor. This does not replace gaze (the
// highlight still follows the centre, the fallback when no cursor or tap is
// present); it answers one question for one click: which panel is under this
// point?
//
// Non-recursive on purpose: panel.mesh carries a caption child, and a hit on the
// caption is a hit on the panel, not a separate target.
const _hitRaycaster = new THREE.Raycaster();
const _hitNdc = new THREE.Vector2();
const _hitMeshes = [];

function spherePanelIndexAtCanvasPoint(x, y, width, height) {
  if (
    state.appState !== AppState.INSIDE_SPHERE
    || spherePanels.length === 0
    || !(width > 0)
    || !(height > 0)
    || !Number.isFinite(x)
    || !Number.isFinite(y)
  ) {
    return -1;
  }
  _hitNdc.set((x / width) * 2 - 1, -((y / height) * 2 - 1));
  const camera = getActiveCamera();
  if (!camera) {
    return -1;
  }
  _hitRaycaster.setFromCamera(_hitNdc, camera);
  _hitMeshes.length = 0;
  for (const panel of spherePanels) {
    // An unready panel has no image or link; letting it swallow the hit would
    // turn a click on the image BEHIND it into "no link".
    if (panel?.mesh && panel.ready) {
      _hitMeshes.push(panel.mesh);
    }
  }
  if (_hitMeshes.length === 0) {
    return -1;
  }
  const hits = _hitRaycaster.intersectObjects(_hitMeshes, false);
  if (hits.length === 0) {
    return -1;
  }
  const hitMesh = hits[0].object;
  for (let i = 0; i < spherePanels.length; i += 1) {
    if (spherePanels[i]?.mesh === hitMesh) {
      return i;
    }
  }
  return -1;
}

function getSelectedSphereNavigationRequest(panelIndex = state.sphereSelectedIndex) {
  if (spherePanels.length === 0) {
    return null;
  }
  const panel = spherePanels[panelIndex];
  if (!panel) {
    return null;
  }
  if (panel.navigationMode && panel.navigationQuery) {
    return {
      mode: panel.navigationMode,
      query: panel.navigationQuery,
      source: panel.navigationSource || null
    };
  }
  if (panel.linkUrl) {
    const item = state.extractedItems[panel.itemIndex];
    return {
      mode: "url",
      query: panel.linkUrl,
      source: null,
      label: item?.title || item?.alt || ""
    };
  }
  return null;
}

function getSelectedSphereLink() {
  return getSelectedSphereNavigationRequest()?.query || null;
}

function getSphereNavigationRequest(panelIndex = state.sphereSelectedIndex) {
  const selectedRequest = getSelectedSphereNavigationRequest(panelIndex);
  if (selectedRequest) {
    return selectedRequest;
  }
  if (state.autoGalleryMode && state.currentQuery) {
    return {
      mode: state.currentLoadMode || "url",
      query: state.currentQuery,
      source: null
    };
  }
  return null;
}

function getSphereNavigationTarget() {
  return getSphereNavigationRequest()?.query || null;
}

function markSphereInteraction() {
  if (state.appState === AppState.INSIDE_SPHERE) {
    state.sphereDwellSeconds = 0;
  }
}

// Which way the idle drift turns. Called with the rotation the sphere has been
// left with (a throw's momentum, or an ordinary drag release's final speed), so
// once that momentum decays the sphere keeps going the way it was going instead
// of the fixed SPHERE_BASE_ROTATION_SPEED pulling it back.
//
// state.sphereDriftDirection is +/-1, a MULTIPLIER on the constant rather than a
// second speed: the drift magnitude lives in one place. The choice is
// driftDirectionAfterRotation() in xr-hand-gestures.js, pure so "a release never
// reverses the hand" is provable offline; its 0 means "no opinion" and leaves
// the direction untouched, which makes the BRAKE safe to route through here (a
// drag held still releases at zero speed).
function setSphereDriftDirectionFromRotation(yawSpeed, pitchSpeed = 0) {
  const direction = driftDirectionAfterRotation(
    yawSpeed,
    pitchSpeed,
    SPHERE_BASE_ROTATION_SPEED
  );
  if (direction !== 0) {
    state.sphereDriftDirection = direction;
  }
}

// The post-release silence. Called on the falling edge of a rotate drag, from
// input.js, so the constant stays beside the ramp it belongs to.
function holdSphereDriftResume() {
  state.sphereDriftGain = 0;
  state.sphereDriftHoldSeconds = DRIFT_RESUME_DELAY_S;
}

function toggleSphereRotation() {
  if (state.appState !== AppState.INSIDE_SPHERE) {
    return false;
  }
  state.sphereRotationPaused = !state.sphereRotationPaused;
  if (state.sphereRotationPaused) {
    state.sphereXRotSpeed = 0;
    state.sphereYRotSpeed = 0;
  }
  markSphereInteraction();
  setStatus(t(state.sphereRotationPaused ? "status.rotationPaused" : "status.rotationResumed"), true);
  return true;
}

function clampSphereViewOffsetToAxis(axis) {
  const projected = sphereViewOffset.dot(axis);
  const clampedProjected = clamp(
    projected,
    -SPHERE_VIEW_OFFSET_INWARD_MAX,
    SPHERE_VIEW_OFFSET_OUTWARD_MAX
  );
  if (clampedProjected !== projected) {
    _sphereZoomPerp.copy(sphereViewOffset).addScaledVector(axis, -projected);
    sphereViewOffset.copy(_sphereZoomPerp).addScaledVector(axis, clampedProjected);
  }
}

function applySphereZoomDelta(delta) {
  if (delta === 0) {
    return;
  }
  getActiveCamera().getWorldDirection(TMP_DIR);
  if (TMP_DIR.lengthSq() < 1e-6) {
    TMP_DIR.set(0, 0, -1);
  } else {
    TMP_DIR.normalize();
  }
  sphereViewOffset.addScaledVector(TMP_DIR, delta);
  clampSphereViewOffsetToAxis(TMP_DIR);
}

// Every acceleration-model writer goes through here (both thumbsticks, the
// desktop arrow keys, the microgesture nudge), so this is the one place that
// hands the coast back to the STICK time constant. Without it a hand throw's
// 2.2 s tail would be inherited by the next stick spin, which would refuse to
// stop when the stick was released.
function applySphereRotationDelta(currentSpeed, delta, dt) {
  state.sphereCoastTauS = SPHERE_COAST_TAU_STICK_S;
  let nextSpeed = currentSpeed;
  if (delta !== 0 && nextSpeed !== 0 && Math.sign(delta) !== Math.sign(nextSpeed)) {
    const brakeStep = SPHERE_ROTATION_BRAKE * dt;
    if (Math.abs(nextSpeed) <= brakeStep) {
      nextSpeed = 0;
    } else {
      nextSpeed -= Math.sign(nextSpeed) * brakeStep;
    }
  }
  nextSpeed += delta;
  return clamp(nextSpeed, -4, 4);
}

// The two side effects a DIRECT angle write shares with the momentum path in
// updateSphereAnimation(), extracted so the grab does not lose them (the desktop
// pointer drag omits both).
//
// The iris coupling only applies while rotation is PAUSED: there the panels' own
// spread is the only motion available, so a rotation input still has to show.
// Unpaused, updateSphereAnimation() is already turning the whole group.
function applyPausedIrisCoupling(deltaPitch, deltaYaw) {
  if (!state.sphereRotationPaused) {
    return;
  }
  const manualDelta = Math.abs(deltaPitch) + Math.abs(deltaYaw);
  if (manualDelta <= 0) {
    return;
  }
  state.irisXRot += (deltaPitch * 0.7) + (deltaYaw * 0.35);
  state.irisYRot += (deltaYaw * 0.5) - (deltaPitch * 0.25);
}

// The layer differential, attached to the rotation rather than to the drift.
// irisXRot / irisYRot are the only thing that moves the twelve shells relative
// to each other (see sphereLayerSpreadMultiplier() in xr-hand-gestures.js). The
// idle drift was their only unpaused writer, and it is held at zero for a whole
// grab and ~6 s after a hand throw, so the sphere would turn rigidly with panels
// staying stacked.
//
// Every rotation writer calls this with the same (deltaPitch, deltaYaw) it just
// applied to sphereOrientation: the momentum path in updateSphereAnimation()
// (sticks, arrow keys, microgesture nudge, every coasting frame of a throw),
// applySphereGrabRotation() and applySpherePointerRotation(). So the
// differential exists whenever the sphere turns, from any source, in the
// direction it is turning.
//
// Skipped while irisForming, where the bloom owns irisXRot/irisYRot (it assigns
// rather than accumulates) and a contribution would be overwritten.
function applyManualLayerDifferential(deltaPitch, deltaYaw) {
  if (state.irisForming) {
    return;
  }
  const { irisXRad, irisYRad } = manualLayerDifferential(deltaPitch, deltaYaw);
  if (irisXRad === 0 && irisYRad === 0) {
    return;
  }
  state.irisXRot += irisXRad;
  state.irisYRot += irisYRad;
}

// Rotation, in radians, spends into the texture-cycling budget: every PI/3 of
// accumulated turn swaps one panel's texture, which is what keeps a sphere of
// twelve panels showing more than twelve images. Called from both rotation
// paths so the budget cannot depend on which input turned the sphere.
function advanceSphereTextureCycle(radians) {
  if (!(radians > 0) || state.appState !== AppState.INSIDE_SPHERE) {
    return;
  }
  state.sphereTextureCycleRadians += radians;
  while (state.sphereTextureCycleRadians >= Math.PI / 3) {
    state.sphereTextureCycleRadians -= Math.PI / 3;
    cycleOneSphereTexture();
  }
}

function applySpherePointerRotation(deltaPitch, deltaYaw) {
  if (
    state.appState !== AppState.INSIDE_SPHERE
    || state.irisForming
    || (!deltaPitch && !deltaYaw)
  ) {
    return false;
  }
  _pointerRotX.setFromAxisAngle(AXIS_X, deltaPitch);
  _pointerRotY.setFromAxisAngle(AXIS_Y, deltaYaw);
  sphereOrientation.premultiply(_pointerRotX);
  sphereOrientation.premultiply(_pointerRotY);
  sphereOrientation.normalize();
  sphereContentGroup.quaternion.copy(sphereOrientation);
  applyManualLayerDifferential(deltaPitch, deltaYaw);
  state.sphereXRotSpeed = 0;
  state.sphereYRotSpeed = 0;
  // A mouse drag has no momentum model, so it also hands the coast back to the
  // stick constant; nothing here inherits a throw's tail.
  state.sphereCoastTauS = SPHERE_COAST_TAU_STICK_S;
  state.sphereRotationInputActive = true;
  markSphereInteraction();
  return true;
}

// The grab's rotation write. Same premultiply as the pointer drag (the hand's
// displacement names an ANGLE, so it goes straight onto sphereOrientation
// rather than through a speed), with three differences:
//
//   * Momentum is kept. applySpherePointerRotation() zeroes both speeds, right
//     for a mouse but wrong here: the grab adds to the rotation, the residual
//     spin being steered to zero by the catch in applyHandRotateDrag() over
//     ~250 ms. Zeroing it would make every grab a hard kill.
//   * The paused iris coupling and the texture-cycle budget are applied, so a
//     paused sphere still answers the hand and a long drag still cycles panels.
//   * No markSphereInteraction(): applyXrControllerInput() already resets the
//     dwell from `handGesture.interacting` and both drag edges; doing it twice
//     would hide a regression in that path.
//
// Ordering: this runs from applyXrControllerInput() and updateSphereAnimation()
// premultiplies the momentum delta later. Two writers to sphereOrientation in
// one frame are safe only because that order is fixed (input first, animation
// second, one sphereContentGroup.quaternion.copy() at the end of each).
function applySphereGrabRotation(deltaPitch, deltaYaw) {
  if (
    state.appState !== AppState.INSIDE_SPHERE
    || state.irisForming
    || (!deltaPitch && !deltaYaw)
  ) {
    return false;
  }
  _pointerRotX.setFromAxisAngle(AXIS_X, deltaPitch);
  _pointerRotY.setFromAxisAngle(AXIS_Y, deltaYaw);
  sphereOrientation.premultiply(_pointerRotX);
  sphereOrientation.premultiply(_pointerRotY);
  sphereOrientation.normalize();
  sphereContentGroup.quaternion.copy(sphereOrientation);
  applyPausedIrisCoupling(deltaPitch, deltaYaw);
  applyManualLayerDifferential(deltaPitch, deltaYaw);
  advanceSphereTextureCycle(Math.abs(deltaPitch) + Math.abs(deltaYaw));
  state.sphereRotationInputActive = true;
  return true;
}

// `panelIndex` is the pointer's answer when there is one. Omitted (or -1) it
// falls back to the gaze selection, which the keyboard, gamepad and every VR
// path pass, so the flat pointer is an extra way to name a panel, not a
// different way to travel.
function activateSelectedSphereLink(panelIndex = -1) {
  if (state.appState !== AppState.INSIDE_SPHERE) {
    return;
  }
  const index = panelIndex >= 0 && spherePanels[panelIndex]
    ? panelIndex
    : state.sphereSelectedIndex;
  const nextRequest = getSphereNavigationRequest(index);
  if (!nextRequest || state.cycleRequestInFlight) {
    setStatus(t("status.noLink"), "warning");
    return;
  }
  state.pendingExitQuery = nextRequest.query;
  state.pendingExitMode = nextRequest.mode;
  state.pendingExitSource = nextRequest.source || null;
  state.followedLabel = { query: nextRequest.query, text: nextRequest.label || "" };
  const addressText = nextRequest.mode === "genai"
    ? genAiAddressText(nextRequest.query, nextRequest.source?.stack)
    : nextRequest.query;
  if (urlInput.value !== addressText) {
    urlInput.value = addressText;
  }
  startSphereExit({
    steerToSelection: false
  });
}

// Move first, work second. On a hosted provider POST /api/genai/source/import
// is a multi-second round-trip; awaiting it before the exit would leave the
// sphere static and read as a missed trigger. So the exit starts on this frame
// and the import runs while the viewer flies. Leaving INSIDE_SPHERE
// synchronously also neutralises a repeat trigger: every later press fails this
// guard (appState, then state.genAiLaunch once the cycle restarts), so no
// second import or provider batch is queued.
// `panelIndex` as in activateSelectedSphereLink(): the flat pointer's answer
// when there is one, the gaze selection otherwise. Without it, desktop
// shift+click would vary whatever is centred rather than the image under the
// cursor.
function activateSelectedSphereImageForGenAi(panelIndex = -1) {
  if (state.appState !== AppState.INSIDE_SPHERE || state.genAiLaunch || state.cycleRequestInFlight) {
    return false;
  }
  // The server gate belongs here, not in each caller: six paths reach this
  // function (both-trigger chord, thumb tap, ordered hand chord, desktop
  // shift+click, the VR panel button, the touch two-finger hold). With no relay
  // configured the chord would fly the viewer out, announce "Preparing selected
  // image for emoji variations..." and fire a request that can only fail.
  // Refusing here keeps the sphere still and says the true thing.
  if (!state.genAiActionsEnabled) {
    setStatus(t("status.variationsUnavailable"), "warning");
    return false;
  }
  const mode = state.currentLoadMode;
  if (mode !== "url" && mode !== "image_search") {
    setStatus(t("status.variationsKinds"), "warning");
    return false;
  }
  const index = panelIndex >= 0 && spherePanels[panelIndex]
    ? panelIndex
    : state.sphereSelectedIndex;
  const panel = spherePanels[index];
  const item = panel ? state.extractedItems[panel.itemIndex] : null;
  if (!panel?.ready || !item?.imageUrl || !/^https?:\/\//i.test(item.imageUrl)) {
    setStatus(t("status.imageNotReady"), "warning");
    return false;
  }

  state.genAiLaunch = {
    status: "importing",
    label: shortSourceLabel(item.linkUrl || item.imageUrl)
  };
  // The batch total is known from the count setting before any job exists, so
  // the footer reads "0/5" rather than counting up from "?".
  state.genAiBatchReceived = 0;
  state.genAiBatchExpected = genAiBatchCount();
  // The prompt and source id only exist once the import answers; until then the
  // handoff carries nothing and restartCycleFromCurrentQuery waits on the launch
  // status rather than firing a request with no source.
  state.pendingExitQuery = null;
  state.pendingExitMode = null;
  state.pendingExitSource = null;
  startSphereExit({ steerToSelection: false });
  // After the exit, whose own status line would otherwise overwrite this one.
  setStatus(t("status.preparingImage"));
  void importSelectedSphereImageForGenAi({
    imageUrl: item.imageUrl,
    mode,
    query: state.currentQuery
  });
  return true;
}

async function importSelectedSphereImageForGenAi({ imageUrl, mode, query }) {
  // The launch this import belongs to, by identity. Both exits below check it:
  // the round trip is up to 25 s (GENAI_SOURCE_IMPORT_TIMEOUT_MS) while the
  // viewer flies, so anything that starts a new request (a wrist poke, a
  // bookmark, the omnibar, voice) can land first, and beginLoadRequest() clears
  // the launch when it does.
  const launch = state.genAiLaunch;
  try {
    const response = await fetch("/api/genai/source/import", {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION_HEADERS },
      body: JSON.stringify({ imageUrl, mode, query }),
      signal: AbortSignal.timeout(GENAI_SOURCE_IMPORT_TIMEOUT_MS)
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not import selected image");
    }
    const sourceId = payload.source?.genai?.id;
    const prompt = String(payload.prompt || "").trim();
    if (!sourceId || !prompt) {
      throw new Error("Imported image did not return a GenAI source");
    }
    if (state.genAiLaunch !== launch) {
      // Superseded: something else already reset the cycle while this import was
      // open. The import never reaches a provider, so dropping it is free and
      // avoids handing a stale source to the run that took over. Compared by
      // identity, not for null, so a launch that was cleared and replaced is
      // caught too.
      return false;
    }
    state.pendingExitQuery = prompt;
    state.pendingExitMode = "genai";
    state.pendingExitSource = { id: sourceId };
    state.genAiLaunch = { ...state.genAiLaunch, status: "ready" };
    if (urlInput.value !== prompt) {
      urlInput.value = prompt;
    }
    return true;
  } catch (err) {
    const message = err?.name === "TimeoutError"
      ? "Selected image import timed out"
      : (err instanceof Error ? err.message : String(err));
    // Superseded failures say nothing. A rejected import (e.g. an NSFW source)
    // that resolves after the viewer started a NEW GenAI prompt would otherwise
    // put the previous input's refusal on the new request's loading message. If
    // this launch is no longer current, its failure belongs to a cycle nobody is
    // in.
    if (state.genAiLaunch !== launch) {
      return false;
    }
    // The viewer is already flying, so the failure must surface where they are:
    // genAiJobError is the tunnel/VR footer path, and the "failed" status makes
    // the cycle land in the tunnel instead of silently reloading the page they
    // left. Nothing here fakes a successful batch.
    if (state.genAiLaunch) {
      state.genAiLaunch = { ...state.genAiLaunch, status: "failed" };
    }
    state.genAiJobError = message;
    state.genAiJobErrorIsBudget = false;
    setStatus(t("status.prepareFailed", { message }), "error");
    return false;
  }
}

// Mirrors SphereGroup.swift `pullSelectedImageToFront`. During EXITING_SPHERE
// the whole sphere content rotates so the selected panel swings onto the active
// camera's forward axis, so the plunge targets whatever the viewer was looking
// at. Up to 5 rad/s of rotation per frame until aligned.
function pullSelectedImageToFront(dt) {
  const panel = spherePanels[state.sphereSelectedIndex];
  if (!panel) {
    return;
  }
  sphereGroup.updateMatrixWorld(true);

  // The selected panel's local centre is (0, radius, 0) before the tilt/clock
  // rotations on its container. Convert it into sphereGroup-local space (same as
  // world space rotation-wise, since sphereGroup.quaternion is identity during
  // exit). One scratch chain instead of clones: _pullPanelPos is private to this
  // function, while TMP_DIR is module-shared (adjustSphereViewOffset uses it).
  // sphereContentGroup applies sphereOrientation as its local rotation, so
  // applying it to the content-local vector gives the sphereContentGroup-parent
  // frame without a basis change.
  const currentDir = _pullCurrentDir
    .copy(_pullPanelPos.set(0, panel.radius, 0).applyMatrix4(panel.container.matrix))
    .applyQuaternion(sphereContentGroup.quaternion)
    .normalize();

  // Target: the active camera's forward direction in world space ((0,0,-1) in
  // non-VR, the headset pose in VR). sphereGroup.quaternion is identity during
  // exit, so world and sphereGroup-local directions coincide.
  const activeCamera = getActiveCamera();
  const targetDir = _pullTargetDir;
  activeCamera.getWorldDirection(targetDir);

  const dotP = clamp(currentDir.dot(targetDir), -1, 1);
  if (dotP > 0.999) {
    return;
  }
  const axis = _pullAxis.crossVectors(currentDir, targetDir);
  const axisLen = axis.length();
  if (axisLen < 0.001) {
    return;
  }
  axis.divideScalar(axisLen);

  const angle = Math.acos(dotP);
  const maxAngle = 5.0 * dt;
  const step = Math.min(angle, maxAngle);

  const rot = _pullRot.setFromAxisAngle(axis, step);
  sphereOrientation.premultiply(rot);
  sphereOrientation.normalize();
  sphereContentGroup.quaternion.copy(sphereOrientation);
}

function nextCycleItem() {
  const itemCount = state.extractedItems.length;
  if (itemCount <= spherePanels.length) {
    return null;
  }

  const visibleImageUrls = new Set(spherePanels.map((panel) => panel.imageUrl));
  for (let attempts = 0; attempts < itemCount; attempts += 1) {
    const itemIndex = state.sphereTextureCursor % itemCount;
    state.sphereTextureCursor = (state.sphereTextureCursor + 1) % itemCount;
    const item = state.extractedItems[itemIndex];
    if (!visibleImageUrls.has(item.imageUrl) || attempts >= itemCount - spherePanels.length) {
      return { item, itemIndex };
    }
  }

  return null;
}

function cycleOneSphereTexture() {
  const next = nextCycleItem();
  if (!next) {
    return;
  }

  sphereGroup.updateMatrixWorld(true);
  const activeCamera = getActiveCamera();
  activeCamera.getWorldPosition(_gazeCameraPos);
  activeCamera.getWorldDirection(_gazeCameraForward);

  let hiddenIndex = -1;
  let hiddenDot = Infinity;
  for (let i = 0; i < spherePanels.length; i += 1) {
    if (i === state.sphereSelectedIndex && spherePanels.length > 1) {
      continue;
    }
    const panel = spherePanels[i];
    _gazePanelPos.set(0, panel.radius, 0);
    panel.container.localToWorld(_gazePanelPos);
    _gazePanelDir.copy(_gazePanelPos).sub(_gazeCameraPos).normalize();
    const dot = _gazePanelDir.dot(_gazeCameraForward);
    if (dot < hiddenDot) {
      hiddenDot = dot;
      hiddenIndex = i;
    }
  }

  if (hiddenIndex < 0) {
    return;
  }

  const panel = spherePanels[hiddenIndex];
  loadSpherePanelTexture(panel, next.item, next.itemIndex);
  setSpherePanelSelected(panel, hiddenIndex === state.sphereSelectedIndex);
}

function updateSphereAnimation(dt, isInsideSphere, transitionProgress = 1, isExitingSphere = false, irisOpenT = 1) {
  if (spherePanels.length === 0) {
    return;
  }

  // During EXITING_SPHERE the sphere renders at the same full scale and layout as
  // INSIDE_SPHERE: the camera flies outward through the centre along the tunnel
  // path, so panels must stay at their real positions. Only TRANSITION_TO_SPHERE
  // uses the tiny "preview" scale.
  const fullScale = isInsideSphere || isExitingSphere;
  const clampedIrisT = clamp(irisOpenT, 0, 1);
  // The image panels start as a swatch-like fan around a shared hinge, then
  // slide outward before rotating into the sphere-clock distribution.
  const approachEase = smoothstep(transitionProgress);
  // Two-movement entry: the approach plunge delivers the closed fan; on entry
  // one "bloom" plays. Scale, fan spacing, pivot release and the fan-to-sphere
  // rotation ride a single eased clock, while a shared shutter sweep (extra
  // rotation about the view axis, identical for every panel) unwinds to zero
  // with a flat landing. The idle drift runs underneath from the first frame
  // (see the forming branch below), so when the sweep dies the sphere is at
  // cruise.
  // No fullScale gate: irisOpenT is 0 through most of the approach and starts
  // climbing pre-entry (transitions.js pre-open), so the bloom begins while the
  // camera is still closing on the near wall and continues across the threshold
  // on the same clock.
  // smoothstep, not smootherstep: its tail keeps more motion alive near the end.
  // The sweep decays exponentially on the UNCLAMPED clock, reaching about cruise
  // speed as the clock hits 1 and fading beneath the drift afterwards, so the
  // roll has no end point the eye can catch.
  const bloomEase = smoothstep(clampedIrisT);
  const sweepT = state.sphereIrisOpenElapsed / SPHERE_IRIS_OPEN_SECONDS;
  const extraSweep = SPHERE_BLOOM_SWEEP_RADIANS * Math.exp(-SPHERE_BLOOM_SWEEP_DECAY * Math.max(0, sweepT));
  const centerCompensation = 1 - bloomEase;
  let textureCycleDelta = 0;

  if (state.irisForming) {
    // Idle drift accumulates from the first frame of the bloom (including the
    // pre-entry stretch), so the opening's end velocity already equals cruise
    // speed. Before the pre-open begins, irisT is 0 and this holds at zero.
    const driftSeconds = clampedIrisT * SPHERE_IRIS_OPEN_SECONDS;
    const drift = state.sphereRotationPaused
      ? 0
      : SPHERE_BASE_ROTATION_SPEED * state.sphereDriftDirection * driftSeconds;
    state.irisXRot = (SPHERE_SHUTTER_FORMING_SPREAD * bloomEase) + drift;
    state.irisYRot = (SPHERE_SHUTTER_FORMING_SPREAD * 0.75 * bloomEase) + drift;
    if (fullScale && clampedIrisT >= 1) {
      state.irisForming = false;
    }
  } else {
    // The drift stands down under a steering hand. sphereRotationInputActive is
    // set by every rotation input (hand drag on each engaged frame, sticks,
    // microgestures, desktop keys) and cleared at the top of every renderFrame(),
    // so it means "somebody is driving right now", not a latch. The pause
    // (sphereRotationPaused) is what outlives the input.
    //
    // It comes back on a ramp: resuming at full magnitude the instant the pinch
    // opened would beat the decaying manual speed (0.95/frame) within about half
    // a second and turn the sphere back. stepDriftResume() holds the gain at zero
    // while anything is steering, while the sphere is turning faster than the
    // drift would, and for DRIFT_RESUME_DELAY_S after release, then ramps it in
    // over DRIFT_RESUME_SECONDS. The drift is never larger than the momentum it
    // replaces.
    state.sphereDriftGain = stepDriftResume(state.sphereDriftGain, {
      dtS: dt,
      grabbed: state.sphereRotationInputActive,
      paused: state.sphereRotationPaused,
      holdSeconds: state.sphereDriftHoldSeconds,
      manualSpeed: Math.max(
        Math.abs(state.sphereXRotSpeed),
        Math.abs(state.sphereYRotSpeed)
      ),
      driftSpeed: SPHERE_BASE_ROTATION_SPEED,
      resumeSeconds: DRIFT_RESUME_SECONDS
    });
    state.sphereDriftHoldSeconds = Math.max(0, state.sphereDriftHoldSeconds - dt);
    if (state.sphereDriftGain > 0) {
      const autoDelta = SPHERE_BASE_ROTATION_SPEED
        * state.sphereDriftDirection
        * state.sphereDriftGain
        * dt;
      state.irisXRot += autoDelta;
      state.irisYRot += autoDelta;
      textureCycleDelta += Math.abs(autoDelta) * 2;
    }
  }

  if (fullScale) {
    // Iris-diaphragm scale rides the same bloom clock: one movement.
    const scaleNow = THREE.MathUtils.lerp(SPHERE_IRIS_OPEN_START_SCALE, 1.0, bloomEase);
    sphereContentGroup.scale.setScalar(scaleNow);

    // Freeze user rotation momentum while the iris opens so the shutter reads as
    // a clean mechanical splay. Once fully open, input resumes normally.
    if (clampedIrisT >= 1) {
      const deltaPitch = state.sphereXRotSpeed * dt;
      const deltaYaw = state.sphereYRotSpeed * dt;
      applyPausedIrisCoupling(deltaPitch, deltaYaw);
      // The coast is the only motion on screen for ~6 s after a throw (the drift
      // is held down), so every coasting frame spends into the layer spread.
      applyManualLayerDifferential(deltaPitch, deltaYaw);
      textureCycleDelta += Math.abs(deltaPitch) + Math.abs(deltaYaw);
      _manualRotX.setFromAxisAngle(AXIS_X, deltaPitch);
      _manualRotY.setFromAxisAngle(AXIS_Y, deltaYaw);
      sphereOrientation.premultiply(_manualRotX);
      sphereOrientation.premultiply(_manualRotY);
      sphereOrientation.normalize();
      sphereContentGroup.quaternion.copy(sphereOrientation);
      if (state.sphereRotationPaused) {
        if (!state.sphereRotationInputActive) {
          state.sphereXRotSpeed = 0;
          state.sphereYRotSpeed = 0;
        }
      } else {
        // The coast: a time constant, not a per-frame factor (which is
        // frame-rate dependent and far too short for a throw). It comes from
        // whoever last wrote the speed: the stick keeps a short coast, a hand
        // throw gets a globe-like one. See stepCoastSpeed().
        const tauS = state.sphereCoastTauS;
        state.sphereXRotSpeed = stepCoastSpeed(state.sphereXRotSpeed, { dtS: dt, tauS });
        state.sphereYRotSpeed = stepCoastSpeed(state.sphereYRotSpeed, { dtS: dt, tauS });
      }
    } else {
      // Hold the current orientation steady through the opening
      sphereContentGroup.quaternion.copy(sphereOrientation);
      state.sphereXRotSpeed = 0;
      state.sphereYRotSpeed = 0;
    }

    if (isExitingSphere && state.sphereExitSteersToSelection) {
      // Magnetically steer the selected image onto the camera forward axis so the
      // plunge targets the chosen link (Swift parity).
      pullSelectedImageToFront(dt);
    }

    if (isInsideSphere && clampedIrisT >= 1) {
      advanceSphereTextureCycle(textureCycleDelta);
    }
  } else {
    const previewScale = THREE.MathUtils.lerp(
      SPHERE_PREVIEW_MIN_SCALE,
      SPHERE_PREVIEW_MAX_SCALE,
      approachEase
    );
    // Once the pre-entry bloom starts, the iris scale curve (starting at
    // SPHERE_PREVIEW_MAX_SCALE) takes over from the approach curve; max() keeps
    // growth continuous and monotonic through the threshold.
    const bloomScale = THREE.MathUtils.lerp(SPHERE_IRIS_OPEN_START_SCALE, 1.0, bloomEase);
    sphereContentGroup.scale.setScalar(Math.max(previewScale, bloomScale));
    sphereContentGroup.quaternion.identity();
  }

  const tiltToFarWall = _TILT_TO_FAR_WALL;
  // The closed fan can gather on either pole; the sphere pose stays centred on
  // the far wall, so a near-side gather makes each panel travel a near-half great
  // circle away from the entry hole as the bloom opens.
  const gatherNear = SPHERE_BLOOM_GATHER_SIDE === "near";
  const gatherTilt = gatherNear ? _TILT_TO_NEAR_WALL : _TILT_TO_FAR_WALL;
  const gatherPivotZ = gatherNear ? 1 : -1;

  for (let i = 0; i < spherePanels.length; i += 1) {
    const panel = spherePanels[i];
    const clockAngle = -(2.0 * Math.PI * i) / spherePanels.length;
    const fanIndex = i - ((spherePanels.length - 1) / 2);
    const fanSpacing = SPHERE_PREVIEW_FAN_SPACING * THREE.MathUtils.lerp(
      1.0,
      SPHERE_PREVIEW_FAN_OPEN_MULTIPLIER,
      bloomEase
    );
    const fanAngle = SPHERE_PREVIEW_FAN_CENTER + (fanIndex * fanSpacing);
    // 1.05 (innermost) to 4.30 (outermost), with a parity term making
    // neighbours the pair furthest apart in rate. Pure, in xr-hand-gestures.js,
    // so "no two shells turn together" is testable without three.js.
    const layerSpread = sphereLayerSpreadMultiplier(i);

    // Shared scratch, not fresh objects (see the _bloom* declarations). Order
    // matters: fanPose/spherePose are composed from the four above, which must be
    // written before either compose reads them.
    const fanRot = _bloomFanRot.setFromAxisAngle(AXIS_Z, fanAngle);
    const clockRot = _bloomClockRot.setFromAxisAngle(AXIS_Z, clockAngle + extraSweep);
    const xSpread = _bloomXSpread.setFromAxisAngle(
      AXIS_X,
      state.irisXRot * layerSpread
    );
    const ySpread = _bloomYSpread.setFromAxisAngle(
      AXIS_Y,
      state.irisYRot * layerSpread
    );
    const fanPose = _bloomFanPose.copy(fanRot).multiply(gatherTilt);
    const spherePose = _bloomSpherePose.copy(tiltToFarWall).multiply(clockRot).multiply(xSpread).multiply(ySpread);

    panel.container.quaternion.slerpQuaternions(fanPose, spherePose, bloomEase);

    if (centerCompensation > 0.001) {
      _previewBasePivot.set(0, SPHERE_PREVIEW_FAN_PIVOT_Y, gatherPivotZ * panel.radius);
      _previewPanelPivot.set(
        -panel.layout.arcLength * 0.43,
        panel.radius,
        -panel.layout.height * 0.43
      ).applyQuaternion(panel.container.quaternion);
      panel.container.position.copy(_previewBasePivot).sub(_previewPanelPivot).multiplyScalar(centerCompensation);
    } else {
      panel.container.position.set(0, 0, 0);
    }
  }

  if (isInsideSphere) {
    updateSphereSelectionTint(dt);
  }
}

function startSphereExit({
  steerToSelection = true
} = {}) {
  if (state.appState !== AppState.INSIDE_SPHERE) {
    return;
  }
  state.appState = AppState.EXITING_SPHERE;
  state.sphereExitSteersToSelection = steerToSelection;
  state.sphereExitTargetRing = state.currentRingFloat + SPHERE_EXIT_DISTANCE_RINGS;
  state.sphereExitStartRing = state.currentRingFloat;
  const userSpeed = Number(speedInput.value) || DEFAULT_CAMERA_SPEED;
  state.cameraSpeed = Math.max(userSpeed, SPHERE_EXIT_MIN_SPEED);
  if (!steerToSelection) {
    // Manual activation preserves the current sphere framing and plunges through
    // the centre of the current view, not rotating the room toward the selected
    // image or coasting on inertia.
    state.sphereXRotSpeed = 0;
    state.sphereYRotSpeed = 0;
  }
  if (state.tunnelMesh?.material) {
    state.tunnelMesh.material.opacity = TUNNEL_TUBE_OPACITY;
  }
  imageGroup.visible = true;

  // Disable depth-test on all sphere panels for the exit so they render over the
  // re-enabled tunnel mesh; otherwise the tunnel wall at radius 2 occludes the
  // panels at radius 10 and the exit reads as an abrupt cut. The panels are
  // destroyed on cycle reset, so state is not restored.
  for (const panel of spherePanels) {
    panel.material.depthTest = false;
    panel.material.depthWrite = false;
    panel.material.transparent = true;
    panel.material.needsUpdate = true;
    if (panel.borderMesh?.material) {
      panel.borderMesh.material.depthTest = false;
      panel.borderMesh.material.depthWrite = false;
      panel.borderMesh.material.transparent = true;
      panel.borderMesh.material.needsUpdate = true;
    }
    // Raise renderOrder so panels draw strictly after the tunnel mesh.
    panel.mesh.renderOrder = 1000 + (panel.mesh.renderOrder || 0);
    if (panel.borderMesh) {
      panel.borderMesh.renderOrder = panel.mesh.renderOrder - 1;
    }
  }

  setStatus(t("status.exitingSphere"), true);
}

function updateSpherePlacement() {
  if (!sphereGroup.visible) {
    return;
  }

  // During EXITING_SPHERE do NOT override the sphere's position with a gaze-axis
  // slide. The sphere is anchored at a tunnel ring (sphereAnchorPosition); as
  // `advanceTunnel` grows state.currentRingFloat past state.targetSphereRing,
  // `worldGroup.matrix` carries the anchor from the origin to past the camera, so
  // the sphere recedes along the same axis and rate as the tunnel walls, as one
  // rigid world transform. A separate gaze-axis slide decouples them and reads as
  // "sphere drifting" rather than "camera plunging". `pullSelectedImageToFront`
  // still rotates the sphere so the gaze-aligned image is the one passing
  // through the camera.
  sphereGroup.position.copy(sphereAnchorPosition).applyMatrix4(worldGroup.matrix);
  if ((state.appState === AppState.INSIDE_SPHERE || state.appState === AppState.EXITING_SPHERE) && sphereViewOffset.lengthSq() > 1e-6) {
    sphereGroup.position.add(sphereViewOffset);
  }
  if (state.appState === AppState.TRANSITION_TO_SPHERE) {
    // Scratch, not clones. The sphereAnchor* vectors are module state holding the
    // captured entry basis and must not be mutated; copying into scratch
    // protects them.
    const right = _poseRight.copy(sphereAnchorRight).transformDirection(worldGroup.matrix).normalize();
    const up = _poseUp.copy(sphereAnchorUp).transformDirection(worldGroup.matrix).normalize();
    const zAxis = _poseZAxis.copy(sphereAnchorForward).transformDirection(worldGroup.matrix).normalize().negate();
    const basis = _poseBasis.makeBasis(right, up, zAxis);
    sphereGroup.quaternion.setFromRotationMatrix(basis);
    return;
  }
  sphereGroup.quaternion.identity();
}

export {
  clearSphere,
  resetSphereAnimationState,
  spawnSphereFromExtractedItems,
  getActiveCamera,
  updateSphereSelectionTint,
  updateSphereTransitionAppearance,
  getSelectedSphereLink,
  getSphereNavigationTarget,
  getSphereNavigationRequest,
  markSphereInteraction,
  setSphereDriftDirectionFromRotation,
  holdSphereDriftResume,
  toggleSphereRotation,
  clampSphereViewOffsetToAxis,
  applySphereZoomDelta,
  applySphereRotationDelta,
  applySpherePointerRotation,
  applySphereGrabRotation,
  activateSelectedSphereLink,
  activateSelectedSphereImageForGenAi,
  spherePanelIndexAtCanvasPoint,
  pullSelectedImageToFront,
  updateSphereAnimation,
  startSphereExit,
  updateSpherePlacement
};
