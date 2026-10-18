// Passthrough: the backdrop goes away and the images hang in the real room.
//
// `environmentBlendMode` is fixed when a session is created and an
// `immersive-vr` session is opaque for its whole life, so passthrough cannot be
// toggled on inside one. Instead the app enters as `immersive-ar` where offered
// (ui.js) and covers the composited room with an opaque backdrop in the fog
// colour; the menu toggle hides it. With it up the session looks like the plain
// opaque one. If AR is refused or `?passthrough=0` is set, none of this runs.
//
// Fog blends toward a colour, not toward transparent, so it would wash the real
// room at distance. It is pushed out of range while passthrough shows, which
// costs the tunnel some depth cue.

import * as THREE from "three";
import { renderer, scene } from "./scene.js";
import { state } from "./state.js";

// Big enough to sit outside anything the tunnel draws (camera far is 2000) and
// small enough to stay well inside it.
const BACKDROP_RADIUS = 1200;

// While passthrough shows, fog is pushed out of range rather than deleted:
// transitions.js writes `scene.fog.color/near/far` every transition frame and
// would throw on a null. updatePassthrough() re-applies it after those writes.
const FOG_OFF_NEAR = 1e6;
const FOG_OFF_FAR = 1e7;

let backdrop = null;
// The session's own blend mode, read once at entry. Null outside a session.
let blendMode = null;
let savedBackground = null;

function ensureBackdrop() {
  if (backdrop) {
    return backdrop;
  }
  const geometry = new THREE.SphereGeometry(BACKDROP_RADIUS, 24, 16);
  const material = new THREE.MeshBasicMaterial({
    color: scene.fog ? scene.fog.color.clone() : new THREE.Color(0x000000),
    side: THREE.BackSide,
    // Not fogged, and not depth-tested: this is a skybox standing in for
    // scene.background, and a background does not participate in depth.
    fog: false,
    depthTest: false,
    depthWrite: false
  });
  backdrop = new THREE.Mesh(geometry, material);
  backdrop.renderOrder = -10000;
  backdrop.frustumCulled = false;
  backdrop.raycast = () => {};
  backdrop.visible = false;
  scene.add(backdrop);
  return backdrop;
}

// Called by ui.js once a session exists. A session whose blend mode is "opaque"
// gets none of this, and passthroughAvailable() then answers false so no surface
// offers a toggle that could not do anything.
function beginPassthroughSession(session) {
  blendMode = session?.environmentBlendMode || "opaque";
  if (blendMode === "opaque") {
    return;
  }
  // The background has to be removed, not just hidden: three clears the
  // framebuffer to `scene.background` when it is a Color, which would paint over
  // the composited room. The backdrop mesh takes over its job.
  savedBackground = scene.background;
  scene.background = null;
  ensureBackdrop().visible = !state.passthroughOn;
}

function endPassthroughSession() {
  if (blendMode && blendMode !== "opaque") {
    scene.background = savedBackground;
    savedBackground = null;
  }
  blendMode = null;
  if (backdrop) {
    backdrop.visible = false;
  }
  // Leaving VR with passthrough showing must not strand the flat page with its
  // fog switched off.
  state.passthroughOn = false;
  restoreFog();
}

// True when this session could actually show the room. Surfaces that offer the
// toggle gate on it.
function passthroughAvailable() {
  return Boolean(blendMode) && blendMode !== "opaque";
}

function isPassthroughOn() {
  return passthroughAvailable() && Boolean(state.passthroughOn);
}

function setPassthrough(on) {
  if (!passthroughAvailable()) {
    return false;
  }
  state.passthroughOn = Boolean(on);
  if (!state.passthroughOn) {
    restoreFog();
  }
  return state.passthroughOn;
}

function togglePassthrough() {
  return setPassthrough(!state.passthroughOn);
}

// The fog values transitions.js believes in, restored when passthrough is turned
// off.
let savedFogNear = null;
let savedFogFar = null;

function restoreFog() {
  if (scene.fog && savedFogNear !== null) {
    scene.fog.near = savedFogNear;
    scene.fog.far = savedFogFar;
  }
  savedFogNear = null;
  savedFogFar = null;
}

// Per-frame, after the transition has written its fog for this frame; otherwise
// the transition would put the haze straight back.
function updatePassthrough() {
  if (!passthroughAvailable()) {
    return;
  }
  const on = Boolean(state.passthroughOn);
  if (backdrop) {
    backdrop.visible = !on;
    // The backdrop is the fog colour; keeping them in step makes the covered-up
    // state match the opaque session, including through the tunnel-to-sphere blend.
    if (!on && scene.fog) {
      backdrop.material.color.copy(scene.fog.color);
    }
  }
  if (!scene.fog) {
    return;
  }
  if (on) {
    if (savedFogNear === null) {
      savedFogNear = scene.fog.near;
      savedFogFar = scene.fog.far;
    }
    scene.fog.near = FOG_OFF_NEAR;
    scene.fog.far = FOG_OFF_FAR;
  }
}

// Whether to ask for an AR session at all (ui.js).
async function passthroughSessionSupported() {
  try {
    return Boolean(await navigator.xr?.isSessionSupported?.("immersive-ar"));
  } catch {
    return false;
  }
}


// --- The system's own VR button ---------------------------------------------
//
// three's VRButton hardcodes `immersive-vr` in both requestSession and
// offerSession. offerSession is what Quest's URL-bar "Enter VR" accepts, and the
// mode is baked into the offer, so a session started that way would be opaque.
//
// A page has one outstanding offer and a later call replaces the earlier one,
// so this re-offers the same options as `immersive-ar` after VRButton's offer.
// VRButton offers from inside its isSessionSupported() callback, so an offer
// made at boot would be replaced; instead wait for its label to change to
// "ENTER VR", which happens in the same synchronous call as its offer.
//
// If our offer fails the old one is put back: the system button is an
// affordance we do not own, and leaving it broken would cost a visitor their
// way in.
function offerPassthroughSession(systemButton, sessionOptions, onSession) {
  if (typeof navigator === "undefined" || !navigator.xr?.offerSession) {
    return;
  }
  const offerAr = () => {
    navigator.xr.offerSession("immersive-ar", sessionOptions).then(
      (session) => {
        onSession(session);
        // The offer is consumed by acceptance; re-arm for the next entry.
        session.addEventListener("end", offerAr, { once: true });
      },
      () => {
        // Hand the system button back to VRButton's own immersive-vr offer.
        navigator.xr.offerSession("immersive-vr", sessionOptions).then(onSession, () => {});
      }
    );
  };
  const vrButtonHasOffered = () => systemButton?.textContent === "ENTER VR";
  if (!systemButton || vrButtonHasOffered()) {
    offerAr();
    return;
  }
  const observer = new MutationObserver(() => {
    if (vrButtonHasOffered()) {
      observer.disconnect();
      offerAr();
    }
  });
  observer.observe(systemButton, { childList: true, characterData: true, subtree: true });
}

export {
  beginPassthroughSession,
  offerPassthroughSession,
  endPassthroughSession,
  passthroughAvailable,
  passthroughSessionSupported,
  isPassthroughOn,
  setPassthrough,
  togglePassthrough,
  updatePassthrough
};
