// Button callouts on the controller model: glyph marks on the real buttons, with
// leaders and labels that grow when the visitor looks at the controller. A
// controller has no arm for a panel to lie along, so the buttons are annotated
// where they are.
//
// Visibility reuses wrist-summon.js (pure: two cone tests plus sustain/hysteresis
// pairs), fed a controller instead of a wrist:
//   tier 1  controller in view       -> glyph marks sit on the buttons
//   tier 2  gaze at the controller   -> each mark grows a leader and a label
// Tier 2 keeps the asymmetric 220/700 ms: labels that grow and shrink as the eyes
// drift are more noticeable than ones that arrive late. There is no third tier;
// the marks are a reading of the hardware and the Help panel lists everything.
//
// Nothing is parented to the button nodes. three's XRControllerModelFactory lerps
// each `*_pressed_value` node as the button travels, and pico-4's right.glb mirrors
// the whole rig with a root `scale: [-1, 1, 1]`, which would render labels
// back-to-front. Marks live in a flat group under the scene and take world
// positions from getWorldPosition() each frame.
//
// Node names are never hardcoded: they differ across the vendored profiles and
// profile.json's `rootNodeName` disagrees with the GLB. Ask the live
// `motionController` for its components instead.

import * as THREE from "three";
import { renderer, scene } from "./scene.js";
import { getActiveCamera } from "./sphere.js";
import { controllerPresenceSlots } from "./hands.js";
import { registerCaptureHideables } from "./capture-hide.js";
import { CAPTURE_CONTROL_ENABLED } from "./config.js";
import { state } from "./state.js";
import { isPanelVisible } from "./vrpanel.js";
import { t } from "./i18n.js";
import { drawIcon } from "./ui-icons.js";
import {
  createWristSummonState,
  updateWristSummonState,
  gazeCosTo,
  resolveWristSummonTier
} from "./wrist-summon.js";
import { resolveControllerCallouts, controllerCalloutKey } from "./controller-callout-map.js";
import { isControllerSource } from "./xr-input-mode.js";

// Same cones and sustains as the wrist panels (wristui.js): one gesture, one set of numbers.
const VIEW_MAX_ANGLE_DEG = 50;
// Tier 2 is wider than the wrist panel's 15° and aimed at the marks, not the grip.
// The marks sit up to ~40 mm off the grip and the cluster is ~170 mm across, so a
// narrow cone around the grip loses the eyes while they read the outermost label.
// 22° covers an 85 mm radius at 30 cm. Labels expand on a mere glance -> tighten;
// they collapse while being read -> widen.
const FOCUS_MAX_ANGLE_DEG = 22;
const VIEW_SHOW_DELAY_MS = 150;
const VIEW_HIDE_DELAY_MS = 400;
const EXPAND_SHOW_DELAY_MS = 220;
const EXPAND_HIDE_DELAY_MS = 700;

// A mark is the size of the button under it (11 mm is the Touch A/B cap); the quad
// is larger than the icon so the artwork is not clipped.
const MARK_SIZE_M = 0.016;
const MARK_CANVAS_SCALE = 1.6;
// How far out from the button its label sits, along the radial direction derived
// below. Clears the widest part of the controller body without putting the text at
// a different focal distance from the hardware.
const LABEL_GAP_M = 0.055;
// How far a mark on a LETTERED button (A/B/X/Y) is moved SIDEWAYS off the cap so
// the moulded letter stays readable. Along the grip's lateral axis, mirrored by
// hand: the mark sits right of its button on the left controller, left on the
// right one, where the top face has spare room.
const LETTERED_SIDE_OFFSET_M = 0.013;
// ...and a little DOWN THE FACE: the top face is raked back, so a purely lateral
// move climbs away from the cap. Grip space has -Y down and +Z back toward the
// hand, so their sum is "down the face, toward me" on any profile.
const LETTERED_DOWN_OFFSET_M = 0.004;
const _gripRight = new THREE.Vector3();
const _gripDownFace = new THREE.Vector3();
const _scratchAxis = new THREE.Vector3();
// A button on the FAR side of the controller (the trigger seen from above, a grip
// seen from the other side). depthTest is off, so its mark would show through the
// body and sit among the top buttons; such a mark is moved just past the
// controller's outline, away from its centre, with a thin pointer back to the
// button.
//
// "Hidden" is a line-of-sight test from the eye to the button against the BODY mesh
// only. A direction test from the model's centre fails: in grip space the face
// buttons sit at the front of the model, not on top. Rays run every
// HIDDEN_CHECK_EVERY_FRAMES frames and a mark changes state only after two checks
// agree, so it cannot flicker on the silhouette. OUT_M too small -> the moved mark
// still overlaps the body; SLACK_M too small -> marks on visible buttons jump out.
const HIDDEN_CHECK_EVERY_FRAMES = 4;
const HIDDEN_RAY_SLACK_M = 0.006;
const HIDDEN_MARK_OUT_M = 0.05;
const _hiddenRaycaster = new THREE.Raycaster();
const _hiddenHits = [];
const COLOR_POINTER = 0x8ea1c2;
const _modelCenter = new THREE.Vector3();
const _outward = new THREE.Vector3();
const _buttonWorld = new THREE.Vector3();
const LABEL_HEIGHT_M = 0.012;
// Text is rasterised at this density and minified slightly at the ~45-60 cm a held
// controller sits at.
const CANVAS_PX_PER_M = 4400;
const LABEL_PAD_PX = 10;

// Above the world but below the wrist panels, which must still win when both are up.
const CALLOUT_RENDER_ORDER = 10000.2;

const COLOR_TEXT = "#dbe6ff";
const COLOR_TEXT_DIM = "#546079";
const COLOR_BG = "#101727f2";
const COLOR_BORDER = "#23314a";
const COLOR_ICON = "#cfdcf5";
const COLOR_ICON_DIM = "#5b6780";
const COLOR_LEADER = 0x4a5b7d;
// The exit palette, so the ring on the controller and the head-locked one match
// (COLOR_EXIT_ARC in wristui.js).
const COLOR_HOLD_RING = 0xff8a9a;

const HANDEDNESS = Object.freeze(["left", "right"]);

// Scratch: no allocation in the per-frame path.
const _headPosition = new THREE.Vector3();
const _headForward = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _markWorld = new THREE.Vector3();
const _radial = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _labelWorld = new THREE.Vector3();
const _controllerWorld = new THREE.Vector3();
const _box = new THREE.Box3();
// Billboarding uses the camera's WORLD orientation, not camera.quaternion: they
// differ if the camera ever gains a rig parent, and the marks live in world space.
const _headQuaternion = new THREE.Quaternion();

const CONTROLLERS = Object.freeze({
  left: createControllerCallouts("left"),
  right: createControllerCallouts("right")
});

function createControllerCallouts(handedness) {
  return {
    handedness,
    group: null,
    // One entry per callout the map returned, rebuilt only when `key` changes.
    entries: [],
    key: "",
    view: createWristSummonState(),
    expand: createWristSummonState(),
    // Last frame's mark centroid, which is what tier 2 is aimed at. Null until
    // the first frame that places anything.
    focusPoint: null
  };
}

// Icons come from ui-icons.js, the same drawings the wrist panel uses for the same meanings.

function makeCanvasTexture(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // No mip chain: at this density the chain gets sampled and text comes out at half resolution.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 1;
  return { canvas, texture };
}

// Depth-testing is OFF, unlike the wrist panel: a mark sits on a button, coplanar
// with hardware a few millimetres away, so depth-testing it z-fights with the thing
// it labels. Labels follow the marks. If a label reads as floating in front of the
// sphere, depthTest could return for the label quads only; the marks cannot have it.
function makeQuad(widthM, heightM, texture) {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), material);
  quad.renderOrder = CALLOUT_RENDER_ORDER;
  // Never a ray target: a callout is a caption, not a control.
  quad.raycast = () => {};
  return quad;
}

function buildMark(entry) {
  const px = Math.round(MARK_SIZE_M * CANVAS_PX_PER_M);
  // The canvas is bigger than the icon so the hold ring and round caps are not clipped.
  const canvasPx = Math.round(px * MARK_CANVAS_SCALE);
  const { canvas, texture } = makeCanvasTexture(canvasPx, canvasPx);
  const ctx = canvas.getContext("2d");
  const centre = canvasPx / 2;
  const color = entry.available ? COLOR_ICON : COLOR_ICON_DIM;
  drawIcon(ctx, entry.glyph, centre, centre, px * 0.62, color);
  texture.needsUpdate = true;
  return makeQuad(MARK_SIZE_M * MARK_CANVAS_SCALE, MARK_SIZE_M * MARK_CANVAS_SCALE, texture);
}


// The hold ring is not part of the mark: it is its own object, invisible until a
// hold is running, and it fills as the hold progresses.
//
// A line strip of fixed points with setDrawRange, not a regenerated arc: the
// geometry is built once and a partial ring costs one integer per frame, where
// rebuilding a RingGeometry would allocate in the render path.
const HOLD_RING_SEGMENTS = 48;
const HOLD_RING_RADIUS_M = MARK_SIZE_M * 0.62 * 0.78;

function buildHoldRing() {
  const points = new Float32Array((HOLD_RING_SEGMENTS + 1) * 3);
  for (let i = 0; i <= HOLD_RING_SEGMENTS; i += 1) {
    // From 12 o'clock, clockwise: the direction a progress ring is read.
    const angle = (i / HOLD_RING_SEGMENTS) * Math.PI * 2 - (Math.PI / 2);
    points[i * 3] = Math.cos(angle) * HOLD_RING_RADIUS_M;
    points[i * 3 + 1] = -Math.sin(angle) * HOLD_RING_RADIUS_M;
    points[i * 3 + 2] = 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
  const material = new THREE.LineBasicMaterial({
    color: COLOR_HOLD_RING,
    transparent: true,
    depthWrite: false,
    depthTest: false
  });
  const ring = new THREE.Line(geometry, material);
  ring.renderOrder = CALLOUT_RENDER_ORDER;
  ring.frustumCulled = false;
  ring.raycast = () => {};
  ring.visible = false;
  return ring;
}

function buildLabel(entry) {
  const text = t(entry.labelKey);
  const fontPx = Math.round(LABEL_HEIGHT_M * CANVAS_PX_PER_M * 0.52);
  // Measured on a throwaway context so the canvas fits the string; unused quad is occlusion.
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textWidth = probe.measureText(text).width;
  const width = Math.ceil(textWidth + LABEL_PAD_PX * 4);
  const height = Math.ceil(fontPx * 1.9);

  const { canvas, texture } = makeCanvasTexture(width, height);
  const ctx = canvas.getContext("2d");
  const radius = height / 2;
  ctx.fillStyle = COLOR_BG;
  ctx.strokeStyle = COLOR_BORDER;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(1, 1, width - 2, height - 2, radius);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = entry.available ? COLOR_TEXT : COLOR_TEXT_DIM;
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2 + 1);
  texture.needsUpdate = true;

  const heightM = height / CANVAS_PX_PER_M;
  const widthM = width / CANVAS_PX_PER_M;
  return makeQuad(widthM, heightM, texture);
}

function buildLeader() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
  const material = new THREE.LineBasicMaterial({
    color: COLOR_LEADER,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    depthTest: false
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = CALLOUT_RENDER_ORDER;
  line.frustumCulled = false;
  line.raycast = () => {};
  return line;
}

function buildPointer() {
  const line = buildLeader();
  line.material.color.setHex(COLOR_POINTER);
  line.visible = false;
  return line;
}

function disposeEntry(entry) {
  for (const object of [entry.mark, entry.label, entry.leader, entry.pointer, entry.ring]) {
    if (!object) {
      continue;
    }
    object.removeFromParent();
    object.geometry?.dispose();
    const material = object.material;
    material?.map?.dispose();
    material?.dispose();
  }
}

function clearEntries(controller) {
  for (const entry of controller.entries) {
    disposeEntry(entry);
  }
  controller.entries = [];
}

// Rebuilt only when the callout key changes; a gaze that comes and goes only
// toggles `visible` and never re-rasters a glyph.
function rebuildEntries(controller, items) {
  clearEntries(controller);
  if (!controller.group) {
    controller.group = new THREE.Group();
    controller.group.matrixAutoUpdate = false;
    scene.add(controller.group);
  }
  for (const item of items) {
    const entry = {
      id: item.id,
      component: item.component,
      tier: item.tier,
      available: item.available,
      hold: Boolean(item.hold),
      lettered: Boolean(item.lettered),
      mark: buildMark(item),
      label: buildLabel(item),
      leader: buildLeader(),
      pointer: buildPointer(),
      hidden: false,
      ring: item.hold ? buildHoldRing() : null,
      node: null,
      // The motionController `node` was resolved from, so a swapped model re-resolves.
      motionController: null,
      // What the mark rides on, and the centre of the button in its local
      // space; see markAnchorFor().
      anchor: null,
      // Allocated here, never in the frame loop.
      markWorld: new THREE.Vector3(),
      markOffset: new THREE.Vector3()
    };
    controller.group.add(entry.mark);
    controller.group.add(entry.label);
    controller.group.add(entry.leader);
    controller.group.add(entry.pointer);
    if (entry.ring) {
      controller.group.add(entry.ring);
    }
    controller.entries.push(entry);
  }
}

// Finding the buttons

// The XRControllerModel three attaches to a grip, once its GLB has loaded. Before
// that there is no motionController, which is ordinary for the first frames of a
// session; callouts simply do not draw yet.
function findMotionController(slot) {
  const model = findControllerModel(slot);
  return model ? model.motionController : null;
}

function findControllerModel(slot) {
  let found = null;
  slot.traverse((child) => {
    if (!found && child.motionController?.components) {
      found = child;
    }
  });
  return found;
}

// Centre of the controller's mesh in the SLOT's local space, resolved once per
// model: the geometry does not change, only the slot's pose does.
function modelCenterLocal(controller, slot, motionController) {
  if (controller.centerFor === motionController && controller.centerLocal) {
    return controller.centerLocal;
  }
  const model = findControllerModel(slot);
  if (!model) {
    return null;
  }
  _box.setFromObject(model);
  if (_box.isEmpty()) {
    return null;
  }
  controller.centerLocal = slot.worldToLocal(_box.getCenter(new THREE.Vector3()));
  controller.centerFor = motionController;
  // The body is the biggest mesh; the buttons are small separate meshes.
  let body = null;
  let bodyTriangles = 0;
  model.traverse((child) => {
    const geometry = child.isMesh ? child.geometry : null;
    const count = geometry ? (geometry.index ? geometry.index.count : geometry.attributes.position.count) : 0;
    if (count > bodyTriangles) {
      body = child;
      bodyTriangles = count;
    }
  });
  controller.bodyMesh = body;
  return controller.centerLocal;
}

// True when the controller's body is between the eye and the button.
function buttonHiddenByBody(controller, buttonWorld) {
  const body = controller.bodyMesh;
  if (!body) {
    return false;
  }
  _outward.copy(buttonWorld).sub(_headPosition);
  const distance = _outward.length();
  if (distance < 1e-6) {
    return false;
  }
  _hiddenRaycaster.set(_headPosition, _outward.multiplyScalar(1 / distance));
  _hiddenRaycaster.far = distance - HIDDEN_RAY_SLACK_M;
  _hiddenHits.length = 0;
  body.raycast(_hiddenRaycaster, _hiddenHits);
  return _hiddenHits.length > 0;
}

// A component's animated node: `*_pressed_value` in every vendored profile. Not
// the component's `rootNodeName`: the bare mesh nodes (`trigger`, `squeeze`,
// `a_button`...) carry a local translation that cancels their parent's, so their
// world position collapses to the controller origin. Not resolved by name either,
// because profile.json's rootNodeName disagrees with the GLB.
//
// Where on that node the mark goes: a `*_pressed_value` node is a PIVOT, and for a
// lever it is the HINGE, not the part the finger touches (pivot to mesh centre is
// up to 42 mm for a squeeze). So the mark is placed at the centre of the mesh
// under the node.
//
// When the node has exactly one mesh, the mark rides that mesh: the thumbstick's
// pressed_value node sits ABOVE its x/y tilt nodes, so an offset cached in that
// node's frame would bake in wherever the stick was pushed on first sight. The
// mesh's geometry centre is fixed in the mesh frame, so reading it through
// mesh.matrixWorld each frame follows the stick. Local, not world, so pico-4's
// mirrored right rig still composes. Several meshes (or none): fall back to the
// node's box, cached in its frame.
function markAnchorFor(node, out) {
  let mesh = null;
  let meshes = 0;
  node.traverse((child) => {
    if (child.isMesh) {
      mesh = child;
      meshes += 1;
    }
  });
  if (meshes === 1 && mesh.geometry) {
    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }
    mesh.geometry.boundingBox.getCenter(out);
    return mesh;
  }
  _box.setFromObject(node);
  if (_box.isEmpty()) {
    // A pivot with no mesh under it: the node's own origin is all there is.
    out.set(0, 0, 0);
    return node;
  }
  _box.getCenter(out);
  node.worldToLocal(out);
  return node;
}

function valueNodeFor(motionController, componentId) {
  const component = motionController.components?.[componentId];
  if (!component?.visualResponses) {
    return null;
  }
  for (const response of Object.values(component.visualResponses)) {
    if (response?.valueNode) {
      return response.valueNode;
    }
  }
  return null;
}

// Per-frame

function hideController(controller) {
  if (controller.group) {
    controller.group.visible = false;
  }
  controller.view = createWristSummonState();
  controller.expand = createWristSummonState();
  // Drop the cached button nodes with the controller that owned them; the next
  // connection may attach a different model.
  for (const entry of controller.entries) {
    entry.node = null;
    entry.anchor = null;
    entry.motionController = null;
  }
  // focusPoint survives: a controller that left view and came back is in much the
  // same place, and resetting would aim tier 2 at the grip for a frame.
}

function setEntryVisible(entry, markVisible, labelVisible) {
  if (entry.ring) {
    // Only while a hold is running; below one segment a lone vertex shows as a stray dot.
    const progress = markVisible ? Math.min(1, Math.max(0, state.xrExitHoldProgress || 0)) : 0;
    const drawn = Math.round(progress * HOLD_RING_SEGMENTS);
    entry.ring.visible = drawn >= 1;
    entry.ring.geometry.setDrawRange(0, drawn + 1);
  }
  if (entry.mark) {
    entry.mark.visible = markVisible;
  }
  if (entry.label) {
    entry.label.visible = labelVisible;
  }
  if (entry.leader) {
    entry.leader.visible = labelVisible;
  }
  if (entry.pointer) {
    entry.pointer.visible = markVisible && entry.hidden;
  }
}

// Places one entry. `radial` is the direction from the controller's origin out
// through the button, flattened into the plane facing the head, so labels spread
// around the hardware like a clock face without a per-profile table of offsets.
function placeEntry(entry, outDirection = null) {
  _markWorld.copy(entry.markWorld);
  entry.mark.position.copy(_markWorld);
  entry.mark.quaternion.copy(_headQuaternion);

  _viewDir.copy(_markWorld).sub(_headPosition);
  if (_viewDir.lengthSq() < 1e-8) {
    _viewDir.set(0, 0, -1);
  }
  _viewDir.normalize();

  if (outDirection) {
    _radial.copy(outDirection);
  } else {
    _radial.copy(_markWorld).sub(_origin);
  }
  // Remove whatever points at the head, leaving what spreads across the view. A
  // button dead-on to the eye has no usable radial, so it is pushed up.
  _radial.addScaledVector(_viewDir, -_radial.dot(_viewDir));
  if (_radial.lengthSq() < 1e-8) {
    _radial.set(0, 1, 0).addScaledVector(_viewDir, -_viewDir.y);
    if (_radial.lengthSq() < 1e-8) {
      _radial.set(1, 0, 0);
    }
  }
  _radial.normalize();

  _labelWorld.copy(_markWorld).addScaledVector(_radial, LABEL_GAP_M);
  entry.label.position.copy(_labelWorld);
  entry.label.quaternion.copy(_headQuaternion);

  if (entry.ring) {
    entry.ring.position.copy(_markWorld);
    entry.ring.quaternion.copy(_headQuaternion);
  }

  // The leader starts outside the mark QUAD, not the icon's nominal size: the quad
  // is larger so the hold ring is not clipped.
  const leaderStartM = MARK_SIZE_M * MARK_CANVAS_SCALE * 0.5;
  const positions = entry.leader.geometry.getAttribute("position");
  positions.setXYZ(
    0,
    _markWorld.x + _radial.x * leaderStartM,
    _markWorld.y + _radial.y * leaderStartM,
    _markWorld.z + _radial.z * leaderStartM
  );
  positions.setXYZ(1, _labelWorld.x, _labelWorld.y, _labelWorld.z);
  positions.needsUpdate = true;

  if (entry.hidden) {
    // From the edge of the moved mark back to the button it stands for.
    const pointer = entry.pointer.geometry.getAttribute("position");
    pointer.setXYZ(
      0,
      _markWorld.x - _radial.x * leaderStartM,
      _markWorld.y - _radial.y * leaderStartM,
      _markWorld.z - _radial.z * leaderStartM
    );
    pointer.setXYZ(1, _buttonWorld.x, _buttonWorld.y, _buttonWorld.z);
    pointer.needsUpdate = true;
  }
}

function updateController(controller, slot, motionController, nowMs) {
  slot.getWorldPosition(_controllerWorld);
  // The grip's own lateral axis in world space, for the lettered-button offset.
  _gripRight.setFromMatrixColumn(slot.matrixWorld, 0).normalize();
  // Down the raked top face: grip -Y plus grip +Z, normalised.
  _gripDownFace.setFromMatrixColumn(slot.matrixWorld, 1).normalize().multiplyScalar(-1);
  _scratchAxis.setFromMatrixColumn(slot.matrixWorld, 2).normalize();
  _gripDownFace.add(_scratchAxis).normalize();
  // Tier 1 asks whether the CONTROLLER is in front of the eye, so it is aimed at the
  // controller. Tier 2 asks whether the eyes are on the labels, so it is aimed at
  // last frame's mark centroid (the arrangement the eyes are on); before anything
  // is placed the grip stands in.
  const gazeCos = gazeCosTo(_headPosition, _controllerWorld, _headForward);
  const focusCos = controller.focusPoint
    ? gazeCosTo(_headPosition, controller.focusPoint, _headForward)
    : gazeCos;
  const tier = resolveWristSummonTier(
    Number.isFinite(gazeCos) ? gazeCos : -1,
    { viewMaxAngleDeg: VIEW_MAX_ANGLE_DEG, focusMaxAngleDeg: FOCUS_MAX_ANGLE_DEG },
    Number.isFinite(focusCos) ? focusCos : -1
  );

  controller.view = updateWristSummonState(controller.view, {
    tracked: true,
    conditionMet: tier.inView,
    nowMs,
    showDelayMs: VIEW_SHOW_DELAY_MS,
    hideDelayMs: VIEW_HIDE_DELAY_MS
  });
  controller.expand = updateWristSummonState(controller.expand, {
    tracked: true,
    conditionMet: tier.focused,
    nowMs,
    showDelayMs: EXPAND_SHOW_DELAY_MS,
    hideDelayMs: EXPAND_HIDE_DELAY_MS
  });

  if (!controller.view.visible) {
    if (controller.group) {
      controller.group.visible = false;
    }
    return;
  }

  const options = {
    handedness: controller.handedness,
    appState: state.appState,
    captureEnabled: CAPTURE_CONTROL_ENABLED,
    genaiEnabled: Boolean(state.genAiActionsEnabled),
    // Covers the menu, the help page and the idle start panel.
    panelOpen: isPanelVisible()
  };
  const key = controllerCalloutKey(options);
  if (key !== controller.key) {
    rebuildEntries(controller, resolveControllerCallouts(options));
    controller.key = key;
  }
  if (controller.entries.length === 0) {
    hideController(controller);
    return;
  }

  controller.group.visible = true;
  const labelsVisible = controller.expand.visible;

  // PASS 1: locate every mark and take their centroid. Label directions radiate
  // from the centroid, not the grip: the vendored profiles put their buttons in
  // quite different places relative to the grip, so radiating from it would fan
  // labels on one controller and pile them up on another.
  _origin.set(0, 0, 0);
  let located = 0;
  for (const entry of controller.entries) {
    if (!entry.node || !entry.node.parent || entry.motionController !== motionController) {
      entry.node = valueNodeFor(motionController, entry.component);
      entry.anchor = entry.node ? markAnchorFor(entry.node, entry.markOffset) : null;
      entry.motionController = motionController;
    }
    if (!entry.node) {
      continue;
    }
    entry.markWorld.copy(entry.markOffset).applyMatrix4(entry.anchor.matrixWorld);
    _origin.add(entry.markWorld);
    located += 1;
  }
  if (located === 0) {
    hideController(controller);
    return;
  }
  _origin.multiplyScalar(1 / located);
  if (!controller.focusPoint) {
    controller.focusPoint = new THREE.Vector3();
  }
  controller.focusPoint.copy(_origin);

  const centerLocal = modelCenterLocal(controller, slot, motionController);
  if (centerLocal) {
    _modelCenter.copy(centerLocal).applyMatrix4(slot.matrixWorld);
  }
  controller.frame = ((controller.frame || 0) + 1) % HIDDEN_CHECK_EVERY_FRAMES;
  const checkHidden = controller.frame === 0;

  // PASS 2: place. A mark whose node never resolved stays hidden rather than drawn
  // at the origin inside the controller.
  for (const entry of controller.entries) {
    if (!entry.node) {
      setEntryVisible(entry, false, false);
      continue;
    }
    let outDirection = null;
    if (!centerLocal) {
      entry.hidden = false;
      entry.hiddenVotes = 0;
    } else if (checkHidden) {
      // Two agreeing checks in a row before the mark changes state.
      const hiddenNow = buttonHiddenByBody(controller, entry.markWorld);
      entry.hiddenVotes = hiddenNow === entry.hidden ? 0 : (entry.hiddenVotes || 0) + 1;
      if (entry.hiddenVotes >= 2) {
        entry.hidden = hiddenNow;
        entry.hiddenVotes = 0;
      }
    }
    if (entry.hidden) {
      _buttonWorld.copy(entry.markWorld);
      _outward.copy(entry.markWorld).sub(_modelCenter);
      _viewDir.copy(entry.markWorld).sub(_headPosition).normalize();
      _outward.addScaledVector(_viewDir, -_outward.dot(_viewDir));
      if (_outward.lengthSq() > 1e-10) {
        _outward.normalize();
        entry.markWorld.addScaledVector(_outward, HIDDEN_MARK_OUT_M);
        outDirection = _outward;
      } else {
        entry.hidden = false;
      }
    }
    if (entry.lettered && !entry.hidden) {
      // One pair of constants for all four, so every lettered mark stands off its
      // button equally. Grip space's +X is the visitor's right when the controller
      // is held normally, so one axis and a sign by hand covers both controllers.
      entry.markWorld.addScaledVector(
        _gripRight,
        controller.handedness === "left" ? LETTERED_SIDE_OFFSET_M : -LETTERED_SIDE_OFFSET_M
      );
      entry.markWorld.addScaledVector(_gripDownFace, LETTERED_DOWN_OFFSET_M);
    }
    setEntryVisible(entry, true, labelsVisible);
    placeEntry(entry, outDirection);
  }
}

// Per-frame driver, called from the render loop beside updateWristLauncher().
// Cheap no-op outside XR and whenever no controller model has loaded.
function updateControllerCallouts(isPresenting) {
  if (!isPresenting) {
    for (const handedness of HANDEDNESS) {
      hideController(CONTROLLERS[handedness]);
    }
    return;
  }
  const camera = getActiveCamera();
  camera.getWorldPosition(_headPosition);
  camera.getWorldQuaternion(_headQuaternion);
  camera.getWorldDirection(_headForward);
  _headForward.normalize();

  // The live session is the authority on what is in the visitor's hands. The
  // slot's `visible` flag is not enough: three clears it on 'disconnected', but the
  // XRControllerModel keeps its `motionController`, which still reads back from a
  // gone input source. `session.inputSources` is rebuilt by the runtime every
  // frame, so identity in that list cannot go stale (xr-input-mode.js uses the same).
  const session = renderer.xr.getSession();
  const liveSources = new Set();
  for (const source of session?.inputSources || []) {
    if (isControllerSource(source)) {
      liveSources.add(source);
    }
  }

  const nowMs = performance.now();
  // Handedness comes from the motion controller, not the slot: three binds input
  // sources to its slots in arrival order, so slot index says nothing about the
  // hand. A slot holding a hand, or nothing, has no motionController and is skipped.
  const seen = { left: false, right: false };
  for (const slot of controllerPresenceSlots()) {
    if (!slot || !slot.visible) {
      continue;
    }
    const motionController = findMotionController(slot);
    if (!motionController || !liveSources.has(motionController.xrInputSource)) {
      continue;
    }
    const handedness = motionController.xrInputSource.handedness;
    const controller = handedness ? CONTROLLERS[handedness] : null;
    if (!controller || seen[handedness]) {
      continue;
    }
    seen[handedness] = true;
    updateController(controller, slot, motionController, nowMs);
  }
  for (const handedness of HANDEDNESS) {
    if (!seen[handedness]) {
      hideController(CONTROLLERS[handedness]);
    }
  }
}

// Screen capture: the capture is a fresh render pass over the same scene graph, so
// hiding the two groups is the whole job (capture-hide.js).
registerCaptureHideables(() => [CONTROLLERS.left.group, CONTROLLERS.right.group]);

export {
  updateControllerCallouts
};
