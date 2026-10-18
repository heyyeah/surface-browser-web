// Tracked-hand and controller presence.
//
// Passive presence only: hands and controller models are drawn wherever an input
// source is active; they never point, select, or compete with gaze. An immersive
// WebXR session draws its own framebuffer, so nothing draws the controller unless
// XRControllerModelFactory does.
//
// Both model factories need self-hosted assets (no CDN fetch, so the app works in
// an offline gallery): public/webxr-assets/ vendors a trimmed copy of
// @webxr-input-profiles/assets (MIT; LICENSE.md sits next to it). It is served at
// the same path in `npm run dev` (Vite's publicDir) and in the built `dist/`.
//
// Only oculus-touch-v2 (Quest 2), meta-quest-touch-plus (Quest 3 / 3S), pico-4 and
// pico-4u are vendored, and profilesList.json must list ONLY vendored folders:
// fetchProfile() takes the first of the source's profiles the list names, so a
// listed but missing folder 404s into the SPA's index.html (a JSON parse error,
// no model) instead of falling through to the next profile. Pico 4 Ultra lost
// its models that way until 2026-10-22. A headset none of the list names gets
// no model, ray line only. Nothing in this file may throw or block VR entry over
// a missing or slow-loading asset.

import * as THREE from "three";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { renderer, scene } from "./scene.js";
import { registerCaptureHideables } from "./capture-hide.js";

// HAND_MODEL_PROFILE picks which branch of three's (unmodified) factory runs; the
// "mesh" branch would statically pull in GLTFLoader + SkeletonUtils.
const HAND_MODEL_PROFILE = "mesh";
const HAND_ASSET_PATH = "/webxr-assets/profiles/generic-hand/";
const CONTROLLER_ASSET_PATH = "/webxr-assets/profiles/";

// One slot per possible input source, not per hand/controller. Meta's multimodal
// mode reports hands AND controllers at once, and three assigns sources to slots
// in arrival order: with only two slots, a pair of controllers waking first would
// leave both hands unbound and invisible. Slots bound to the wrong kind of source
// never build a model, so spare slots cost nothing.
const XR_INPUT_SLOT_COUNT = 4;

// Unobtrusive: a soft translucent grey that reads as presence in the periphery.
// The scene has one ambient light, so a MeshStandardMaterial's colour is what
// shows.
const HAND_JOINT_COLOR = 0xbfc6cc;
const HAND_JOINT_OPACITY = 0.72;

const handSlots = [];
const controllerGripSlots = [];
let handPresenceReady = false;
let controllerPresenceReady = false;

// Styles the loaded hand mesh in place. Runs from XRHandModelFactory's shared
// onLoad, so it fires once per handedness the first time that hand connects (and
// again, harmlessly, on later reconnects; see the caching note below).
function styleHandMesh(object) {
  const mesh = object?.getObjectByProperty?.("type", "SkinnedMesh");
  const material = mesh?.material;
  if (!material) {
    return;
  }
  material.color.set(HAND_JOINT_COLOR);
  material.roughness = 1;
  material.metalness = 0;
  material.transparent = true;
  material.opacity = HAND_JOINT_OPACITY;
  // depthWrite STAYS ON despite the transparent material. Hand groups keep
  // renderOrder 0 while every panel draws far later (wrist launcher 9000, VR panel
  // 10000, status footer 10003), so a hand that wrote no depth would be painted over
  // by any later panel even when nearer. The wrist launcher is anchored on the hand,
  // so that overlap is guaranteed. (Raising renderOrder above the panels instead
  // breaks occlusion the other way: a hand behind a panel would show through.)
  material.depthWrite = true;
  material.needsUpdate = true;
}

// XRHandMeshModel caches the loaded gltf by handedness and clones a NEW skeleton
// off it on every connect. Geometry and material are shared by reference, but the
// per-clone Skeleton (and the boneTexture it lazily allocates on the GPU) is not.
// Hands drift out of frame often, so that skeleton must be disposed per disconnect
// or it leaks a DataTexture each time. The shared geometry and material must NOT
// be disposed here, or the next reconnect's clone binds to freed GPU resources.
function disposeHandSkeleton(loadedObject) {
  const mesh = loadedObject?.getObjectByProperty?.("type", "SkinnedMesh");
  mesh?.skeleton?.dispose?.();
}

// Must run BEFORE any XR session can start. three binds an input source to
// `renderer.xr.getController(i)` / `getControllerGrip(i)` / `getHand(i)` only if
// slot i already exists when `inputsourceschange` fires, so a slot created lazily
// on first use never receives its source and controller rays can stay missing for
// a whole session. Called once from main.js boot.
function setupHandPresence() {
  if (handPresenceReady) {
    return;
  }
  handPresenceReady = true;

  // One shared factory: its _assetCache means left.glb and right.glb are each
  // fetched and parsed once however many slots bind a hand or reconnect.
  const handModelFactory = new XRHandModelFactory(null, (object) => {
    styleHandMesh(object);
    // object.parent is already the owning XRHandModel here (three's factory adds it
    // before calling onLoad); stash it there rather than threading a per-slot callback
    // through a factory whose onLoad is shared.
    if (object?.parent) {
      object.parent.userData.loadedHandMesh = object;
    }
  });
  handModelFactory.setPath(HAND_ASSET_PATH);

  for (let slot = 0; slot < XR_INPUT_SLOT_COUNT; slot += 1) {
    const hand = renderer.xr.getHand(slot);
    const handModel = handModelFactory.createHandModel(hand, HAND_MODEL_PROFILE);
    // The model tracks its own joints; three drives the group's visibility from the
    // frame pose, so an untracked or controller-bound slot renders nothing.
    hand.add(handModel);
    scene.add(hand);

    hand.addEventListener("disconnected", () => {
      // Runs after the factory's own 'disconnected' listener, which already cleared
      // handModel's children; this only releases the GPU resource clear() does not.
      disposeHandSkeleton(handModel.userData.loadedHandMesh);
      handModel.userData.loadedHandMesh = null;
    });

    handSlots.push(hand);
  }
}

// Why the controller models get an environment map: the scene has ONE AmbientLight
// and the controller GLBs are PBR. Flat ambient is diffuse only, so dark plastic
// renders as a dark blob; an environment map gives the specular that makes the
// shape legible.
//
// No light is added and `scene.environment` is deliberately not used. The tunnel
// TUBE is MeshPhongMaterial with specular white and shininess 0 (tunnel.js), so a
// directional/point light would lay a flat full-strength specular over the tube,
// an ambient/hemisphere light would change its brightness, and three applies
// scene.environment to Phong as well as Standard. Setting the map on the
// controller MATERIALS cannot reach anything else. The hands are left as they are.
//
// The map is generated, not fetched (the gallery may be offline) and costs no
// bundle: the renderer already carries PMREMGenerator and prefilters any
// equirectangular envMap on assignment, so this is one 16x32 gradient.
//
// Neutral greys on purpose: a tinted sky would recolour hardware the visitor is
// holding. sRGB bytes; the vertical run is the point, the horizontal is constant.
const CONTROLLER_ENV_SKY = 235;
const CONTROLLER_ENV_HORIZON = 150;
const CONTROLLER_ENV_GROUND = 60;
const CONTROLLER_ENV_WIDTH = 16;
const CONTROLLER_ENV_HEIGHT = 32;

function buildControllerEnvironment() {
  const data = new Uint8Array(CONTROLLER_ENV_WIDTH * CONTROLLER_ENV_HEIGHT * 4);
  for (let y = 0; y < CONTROLLER_ENV_HEIGHT; y += 1) {
    // Row 0 is straight up; the horizon is the middle row.
    const t = (y + 0.5) / CONTROLLER_ENV_HEIGHT;
    const value = t < 0.5
      ? CONTROLLER_ENV_SKY + ((CONTROLLER_ENV_HORIZON - CONTROLLER_ENV_SKY) * (t * 2))
      : CONTROLLER_ENV_HORIZON + ((CONTROLLER_ENV_GROUND - CONTROLLER_ENV_HORIZON) * ((t - 0.5) * 2));
    const level = Math.round(value);
    for (let x = 0; x < CONTROLLER_ENV_WIDTH; x += 1) {
      const i = ((y * CONTROLLER_ENV_WIDTH) + x) * 4;
      data[i] = level;
      data[i + 1] = level;
      data[i + 2] = level;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(
    data,
    CONTROLLER_ENV_WIDTH,
    CONTROLLER_ENV_HEIGHT,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  // Equirectangular triggers the renderer's own PMREM conversion; sRGB makes the
  // byte levels above mean what they read as.
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// Mirrors setupHandPresence() for the same 4 slots: getHand(i) and
// getControllerGrip(i) are two views onto the one input source bound to slot i, so
// this shares the boot-before-session timing constraint and slot count, and costs
// nothing for a slot bound to a hand (XRControllerModelFactory's 'connected'
// handler bails when `xrInputSource.hand` is set).
function setupControllerPresence() {
  if (controllerPresenceReady) {
    return;
  }
  controllerPresenceReady = true;

  const controllerModelFactory = new XRControllerModelFactory();
  controllerModelFactory.setPath(CONTROLLER_ASSET_PATH);
  // One texture for all four slots; three caches the prefiltered result per texture,
  // so the PMREM render happens once.
  const envMap = buildControllerEnvironment();

  for (let slot = 0; slot < XR_INPUT_SLOT_COUNT; slot += 1) {
    const grip = renderer.xr.getControllerGrip(slot);
    const model = controllerModelFactory.createControllerModel(grip);
    // Set before the profile is fetched: the factory applies a stored envMap to the
    // glTF scene as it attaches it, covering every later load and reconnect.
    model.setEnvironmentMap(envMap);
    grip.add(model);
    scene.add(grip);
    controllerGripSlots.push(grip);
  }
}

// Exposed for debugging and for anchoring UI next to the tracked hand; the render
// loop needs nothing from here.
function handPresenceSlots() {
  return handSlots;
}

function controllerPresenceSlots() {
  return controllerGripSlots;
}

// Screen capture: hands and controller models must leave the frame, since they
// depend on how the visitor holds the headset, not on the artwork. Each slot is
// the group three re-poses every frame; hiding it hides the whole model, and three
// restores nothing, so the visible flags are ours to borrow. Slots bound to the
// other kind of source, or unbound, are already invisible and get their own value
// put back (see hideForCapture()).
registerCaptureHideables(handPresenceSlots);
registerCaptureHideables(controllerPresenceSlots);

export {
  setupHandPresence,
  setupControllerPresence,
  handPresenceSlots,
  controllerPresenceSlots,
  HAND_MODEL_PROFILE,
  XR_INPUT_SLOT_COUNT
};
