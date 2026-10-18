// Three.js scene graph + shared runtime singletons.
//
// This is a leaf module: it imports only THREE / VRButton / constants.js /
// state.js / dom.js. Feature modules import the singletons from here.

import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { TUNNEL_FOG_COLOR } from "./constants.js";
import { state } from "./state.js";
import { canvas, speedInput } from "./dom.js";
import { XR_HAND_TRACKING_ENABLED, XR_LAYERS_ENABLED } from "./config.js";

// DOM-derived default camera speed and a reusable scratch direction vector.
export const DEFAULT_CAMERA_SPEED = Number(speedInput.value);
export const TMP_DIR = new THREE.Vector3();

export const scene = new THREE.Scene();
// A single persistent background Color, mutated in place every frame so
// mid-transition blends do not tear on reference swaps.
// transition blends don't tear due to reference swaps).
scene.background = TUNNEL_FOG_COLOR.clone();
scene.fog = new THREE.Fog(TUNNEL_FOG_COLOR.clone(), 10, 55);

// Reusable scratch color used by the transition fog blender.
export const _fogBlendColor = new THREE.Color();

export const camera = new THREE.PerspectiveCamera(75, 2, 0.1, 2000);
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -10);

export const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance"
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.localClippingEnabled = true;
// This hidden button is not decoration: VRButton also calls
// navigator.xr.offerSession() and registers a session-granted listener, which is
// how Quest Browser's own VR affordance (and a URL opened straight into VR)
// starts the app. That path never runs enterVrSession(), so the features passed
// here are the features that session gets. With no sessionInit VRButton asks
// only for [local-floor, bounded-floor, layers] and never requests hand-tracking.
//
// Strictly additive to three's defaults; every feature stays optional.
// `?hands=0` must strip the feature here as well, since this is the path most
// sessions arrive through.
// Exported so the passthrough AR offer can replace VRButton's with the same
// features; main.js does that because scene.js importing passthrough.js would
// close a cycle (scene -> passthrough -> scene).
export const VR_SESSION_OPTIONS = {
  optionalFeatures: [
    "local-floor",
    "bounded-floor",
    ...(XR_LAYERS_ENABLED ? ["layers"] : []),
    ...(XR_HAND_TRACKING_ENABLED ? ["hand-tracking"] : [])
  ]
};
export const vrSystemButton = VRButton.createButton(renderer, VR_SESSION_OPTIONS);
// VRButton sets `display` itself once isSessionSupported() resolves, so an
// inline style set now is overwritten a tick later; the stylesheet's
// `#VRButton { display: none !important }` is what actually keeps it hidden.
vrSystemButton.style.display = "none";
document.body.appendChild(vrSystemButton);

export const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

export const worldGroup = new THREE.Group();
worldGroup.matrixAutoUpdate = false;
scene.add(worldGroup);

export const imageGroup = new THREE.Group();
worldGroup.add(imageGroup);

export const sphereGroup = new THREE.Group();
sphereGroup.visible = false;
scene.add(sphereGroup);

export const sphereContentGroup = new THREE.Group();
sphereGroup.add(sphereContentGroup);

// Reassignable runtime state lives on the shared `state` object
// (./state.js). The const objects below are mutated in place, so they remain
// plain module-level shared references.
export const imagePanels = [];
export const spherePanels = [];
export const sphereViewOffset = new THREE.Vector3();
export const sphereOrientation = new THREE.Quaternion();
export const keyState = {
  ArrowLeft: false,
  ArrowRight: false,
  ArrowUp: false,
  ArrowDown: false,
  "+": false,
  "=": false,
  "-": false,
  "_": false,
  a: false,
  y: false,
  z: false,
  // Not a binding of its own: read live by applyDesktopSphereInput() so
  // shift+ArrowUp/Down zooms where a bare arrow pitches.
  Shift: false
};
// Vector baselines for the two-hand distance gesture. Its decision state is pure
// and lives on state.xrHandGesture; only the values that must be three.js
// vectors are here, captured on the frame the gesture engages. `active` is kept
// because transitions.js clears it as part of a cycle reset.
export const twoHandGestureState = {
  active: false,
  controlAxis: new THREE.Vector3(0, 0, -1),
  baselineSpeed: DEFAULT_CAMERA_SPEED,
  baselineSphereOffset: new THREE.Vector3(),
  // Camera-right: the axis the horizontal hand separation is measured along. It is
  // refreshed only while the gesture is not engaged; a per-frame camera-right
  // would let head turns shorten the projected separation and write a phantom zoom.
  separationAxis: new THREE.Vector3(1, 0, 0)
};

// Yaw-drag scratch: where the panel hand was when the drag engaged, and the
// camera-right axis the sideways component is measured along.
export const handRotateDragState = {
  anchor: new THREE.Vector3(),
  axis: new THREE.Vector3(1, 0, 0)
};

export const sphereAnchorPosition = new THREE.Vector3();
export const sphereAnchorForward = new THREE.Vector3(0, 0, -1);
export const sphereAnchorUp = new THREE.Vector3(0, 1, 0);
export const sphereAnchorRight = new THREE.Vector3(1, 0, 0);
export const tunnelPortalClipPlane = new THREE.Plane();
export const _handThumbTip = new THREE.Vector3();
export const _handIndexTip = new THREE.Vector3();
// Palm-centroid fallback for a hand anchor whose WRIST joint did not read: one
// accumulator and one per-joint read, so metacarpals average without allocating.
// See readTrackedHandAnchor().
export const _handPalmCentroid = new THREE.Vector3();
export const _handJointRead = new THREE.Vector3();
export const _leftHandAnchor = new THREE.Vector3();
export const _rightHandAnchor = new THREE.Vector3();
// Palm-frame scratch for the rotate drag's palm-up refusal and the stop signal's
// palms-away test.
export const _handWrist = new THREE.Vector3();
export const _handIndexMetacarpal = new THREE.Vector3();
export const _handPinkyMetacarpal = new THREE.Vector3();
export const _handDistal = new THREE.Vector3();
export const _handRadial = new THREE.Vector3();
export const _handPalmNormal = new THREE.Vector3();
export const _handDragDelta = new THREE.Vector3();
// View direction, read once per frame for the palms-away test. Its own vector
// because _handDragDelta is live while a drag runs.
export const _handViewForward = new THREE.Vector3();
// Distance-gesture scratch: the hand-to-hand vector (projected onto
// twoHandGestureState.separationAxis), the head position, and the vector the
// viewport gate projects into NDC. Separate because they are live at once.
export const _handSeparation = new THREE.Vector3();
export const _handHeadPosition = new THREE.Vector3();
export const _handNdc = new THREE.Vector3();
export const _sphereZoomPerp = new THREE.Vector3();

export const textureLoader = new THREE.TextureLoader();
export const tunnelTexture = textureLoader.load("/seamless_detail.jpg", (texture) => {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  if (state.tunnelMesh?.material) {
    state.tunnelMesh.material.map = texture;
    state.tunnelMesh.material.needsUpdate = true;
  }
});

// Timer replaces the deprecated Clock. `timer.update()` is called once per frame
// at the top of the render loop; getDelta()/getElapsed() are then stable for it.
export const timer = new THREE.Timer();
