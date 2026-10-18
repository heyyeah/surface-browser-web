// Thumb microgestures (offline). Covers the parts a device pass cannot prove by
// hand: that a 30 Hz button pulse fires exactly once however long it lasts, that
// the state gating and the swallow rules send each gesture where it belongs, that
// the tunnel-speed clamp holds, and that a repeat tap while a variation is
// already launching is REFUSED rather than queued. Same split as
// wrist_poke.test.mjs / xr_trigger_chord.test.mjs: the XR frame reading itself
// lives in src/input.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isHandLikeSource,
  MICROGESTURE_BUTTON_INDEX,
  MICROGESTURE_COMPONENT_NAME,
  MICROGESTURE_IDS,
  MICROGESTURE_SPEED_MIN,
  MICROGESTURE_SPEED_MAX,
  APP_STATE_TUNNEL,
  APP_STATE_INSIDE_SPHERE,
  hasMicrogestureSupport,
  readMicrogesturePressed,
  createMicrogestureLatch,
  updateMicrogestureLatch,
  stepTunnelSpeed,
  resolveMicrogestureAction
} from "../src/xr-microgestures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A fake hand input source: `down` names the gesture buttons currently pressed.
function handSource(down = [], {
  profiles = ["oculus-hand", "generic-hand"],
  buttonCount = 10
} = {}) {
  const buttons = [];
  for (let i = 0; i < buttonCount; i += 1) {
    buttons.push({ pressed: false });
  }
  for (const id of down) {
    const index = MICROGESTURE_BUTTON_INDEX[id];
    if (index < buttonCount) {
      buttons[index] = { pressed: true };
    }
  }
  return { profiles, gamepad: { buttons }, hand: {} };
}

// One frame of the pump for a single hand.
function frame(latch, down) {
  return updateMicrogestureLatch(latch, readMicrogesturePressed(handSource(down)));
}

function resolve(gesture, overrides = {}) {
  return resolveMicrogestureAction({
    gesture,
    appState: APP_STATE_TUNNEL,
    panelOpen: false,
    launcherCapturing: false,
    genAiPending: false,
    ...overrides
  });
}

// --- registry facts ---------------------------------------------------------

test("button indices match the oculus-hand profile in the registry", () => {
  // webxr-input-profiles oculus-hand.json v1.0.5. Same indices on both hands;
  // [0] is pinch/select and [4] is the left-hand-only menu, neither of which
  // this module may claim.
  assert.deepEqual(MICROGESTURE_BUTTON_INDEX, {
    swipeLeft: 5,
    swipeRight: 6,
    swipeForward: 7,
    swipeBackward: 8,
    tapThumb: 9
  });
  assert.ok(
    Math.min(...Object.values(MICROGESTURE_BUTTON_INDEX)) > 4,
    "nothing here may claim [0] pinch/select or [4] menu"
  );
});

test("every gesture id has a registry component name for the DEV readout", () => {
  for (const id of MICROGESTURE_IDS) {
    assert.equal(typeof MICROGESTURE_COMPONENT_NAME[id], "string");
    assert.match(MICROGESTURE_COMPONENT_NAME[id], /^(swipe-(left|right|forward|backward)|tap-thumb)$/);
  }
});

test("the mirrored AppState literals still match constants.js", () => {
  // The dispatch is dependency-free on purpose (constants.js pulls in three), so
  // the two state names are copied. Read the source as text rather than import
  // it, and fail loudly if the enum is ever renamed underneath the copy.
  const source = fs.readFileSync(path.join(HERE, "..", "src", "constants.js"), "utf8");
  assert.match(source, new RegExp(`TUNNEL:\\s*"${APP_STATE_TUNNEL}"`));
  assert.match(source, new RegExp(`INSIDE_SPHERE:\\s*"${APP_STATE_INSIDE_SPHERE}"`));
});

// --- feature detection ------------------------------------------------------

test("microgestures need a hand-like source and the extra buttons", () => {
  assert.equal(hasMicrogestureSupport(handSource()), true);
  assert.equal(
    hasMicrogestureSupport(handSource([], { buttonCount: 5 })),
    false,
    "an older runtime exposes the profile with a short button array"
  );
  // A real controller has no `hand` — handSource() always sets one, so this
  // case has to be built by hand or it is not testing what it claims.
  assert.equal(
    hasMicrogestureSupport({
      profiles: ["meta-quest-touch-plus", "oculus-touch-v3", "generic-trigger-squeeze-thumbstick"],
      gamepad: { buttons: new Array(12).fill({ pressed: false }) }
    }),
    false,
    "controllers never carry microgestures"
  );
  // When the runtime withholds hand-tracking the hands report `meta-fixed-hand` and
  // carry no joints, yet every microgesture button still fires. Gating on the
  // registry's `oculus-hand` string would keep the gestures dead on real hardware.
  assert.equal(
    hasMicrogestureSupport(handSource([], {
      profiles: ["meta-fixed-hand", "generic-fixed-hand", "generic-hand-select", "generic-trigger"]
    })),
    true,
    "a jointless Quest hand still carries the full button set"
  );
});

test("hand-like classification keeps jointless hands out of the controller map", () => {
  assert.equal(isHandLikeSource({ hand: {}, profiles: [] }), true, "articulated hand");
  assert.equal(
    isHandLikeSource({ profiles: ["meta-fixed-hand", "generic-hand-select"] }),
    true,
    "jointless hand: recognised by profile alone"
  );
  assert.equal(
    isHandLikeSource({ profiles: ["meta-quest-touch-plus", "oculus-touch-v3", "generic-trigger-squeeze-thumbstick"] }),
    false,
    "a held controller must still reach the controller button map"
  );
  assert.equal(isHandLikeSource(null), false);
  assert.equal(isHandLikeSource({}), false);
  assert.equal(isHandLikeSource({ profiles: "meta-fixed-hand" }), false, "a string is not a profile list");
});

test("a malformed or absent source degrades to no support, never throws", () => {
  assert.equal(hasMicrogestureSupport(null), false);
  assert.equal(hasMicrogestureSupport(undefined), false);
  assert.equal(hasMicrogestureSupport({}), false);
  assert.equal(hasMicrogestureSupport({ profiles: ["oculus-hand"] }), false, "no gamepad at all");
  assert.equal(hasMicrogestureSupport({ profiles: "oculus-hand" }), false, "a string is not a profile list");
});

test("unsupported sources read as null, which is a dropped frame not a release", () => {
  assert.equal(readMicrogesturePressed(handSource([], { buttonCount: 5 })), null);
  const pressed = readMicrogesturePressed(handSource(["tapThumb"]));
  assert.equal(pressed.tapThumb, true);
  assert.equal(pressed.swipeLeft, false);
});

// --- edge latching (30 Hz, pulses of 1-2 frames) ----------------------------

test("a one-frame pulse fires exactly once", () => {
  let latch = createMicrogestureLatch();
  let step = frame(latch, []);
  assert.deepEqual(step.edges, []);

  step = frame(step.latch, ["swipeForward"]);
  assert.deepEqual(step.edges, ["swipeForward"], "fires on the frame it goes down");

  step = frame(step.latch, []);
  assert.deepEqual(step.edges, [], "and never again from the same pulse");
});

test("a two-frame pulse still fires exactly once", () => {
  let step = frame(createMicrogestureLatch(), ["swipeBackward"]);
  assert.deepEqual(step.edges, ["swipeBackward"]);
  step = frame(step.latch, ["swipeBackward"]);
  assert.deepEqual(step.edges, [], "held is not re-pressed");
  step = frame(step.latch, ["swipeBackward"]);
  assert.deepEqual(step.edges, []);
});

test("releasing re-arms for the next pulse", () => {
  let step = frame(createMicrogestureLatch(), ["swipeLeft"]);
  assert.deepEqual(step.edges, ["swipeLeft"]);
  step = frame(step.latch, []);
  step = frame(step.latch, ["swipeLeft"]);
  assert.deepEqual(step.edges, ["swipeLeft"], "a second deliberate swipe fires");
});

test("each button latches independently", () => {
  let step = frame(createMicrogestureLatch(), ["swipeLeft"]);
  assert.deepEqual(step.edges, ["swipeLeft"]);
  step = frame(step.latch, ["swipeLeft", "swipeRight"]);
  assert.deepEqual(step.edges, ["swipeRight"], "the held one stays latched, the new one fires");
});

test("a dropped frame keeps the latch instead of re-arming", () => {
  let step = frame(createMicrogestureLatch(), ["tapThumb"]);
  assert.deepEqual(step.edges, ["tapThumb"]);

  step = updateMicrogestureLatch(step.latch, null);
  assert.deepEqual(step.edges, [], "nothing fires from a frame with no reading");
  assert.equal(step.latch.tapThumb, true, "a blip must not re-arm a button that never released");

  step = frame(step.latch, ["tapThumb"]);
  assert.deepEqual(step.edges, [], "and the recovered frame must not re-fire");
});

test("a tap swallows a swipe reported on the same frame, and does not queue it", () => {
  let step = frame(createMicrogestureLatch(), ["tapThumb", "swipeRight"]);
  assert.deepEqual(step.edges, ["tapThumb"], "the tap is the only thing that happened");
  assert.equal(step.latch.swipeRight, true, "the swipe was latched, so it cannot fire late");
  step = frame(step.latch, ["swipeRight"]);
  assert.deepEqual(step.edges, [], "still latched after the tap released");
});

test("the input latch is never mutated", () => {
  const latch = createMicrogestureLatch();
  const snapshot = { ...latch };
  frame(latch, ["swipeForward"]);
  updateMicrogestureLatch(latch, null);
  assert.deepEqual(latch, snapshot);
});

// --- state-mapped dispatch --------------------------------------------------

test("TUNNEL: swipe forward speeds up, swipe backward slows down", () => {
  assert.deepEqual(resolve("swipeForward"), {
    type: "tunnelSpeed", direction: 1, reason: "", swallowSelect: true
  });
  assert.deepEqual(resolve("swipeBackward"), {
    type: "tunnelSpeed", direction: -1, reason: "", swallowSelect: true
  });
});

test("TUNNEL: sphere gestures do nothing there", () => {
  for (const gesture of ["swipeLeft", "swipeRight", "tapThumb"]) {
    const decision = resolve(gesture);
    assert.equal(decision.type, "none", gesture);
    assert.equal(decision.reason, "wrong-state", gesture);
  }
});

test("INSIDE_SPHERE: swipe left/right are yaw impulses, signed like the stick", () => {
  const inSphere = { appState: APP_STATE_INSIDE_SPHERE };
  // input.js feeds `direction * impulse` to applySphereRotationDelta, where the
  // stick path uses -horizontalAxis: stick-right (+1) is a negative delta, so
  // swipe-right must be negative too.
  assert.deepEqual(resolve("swipeLeft", inSphere), {
    type: "sphereYaw", direction: 1, reason: "", swallowSelect: true
  });
  assert.deepEqual(resolve("swipeRight", inSphere), {
    type: "sphereYaw", direction: -1, reason: "", swallowSelect: true
  });
});

test("INSIDE_SPHERE: no pitch is reachable from any microgesture", () => {
  // Comfort rule: hands get yaw only. Nothing in the mapping may ever return a
  // pitch action, whatever the state.
  for (const appState of [APP_STATE_TUNNEL, APP_STATE_INSIDE_SPHERE, "exiting_sphere"]) {
    for (const gesture of MICROGESTURE_IDS) {
      assert.notEqual(resolve(gesture, { appState }).type, "spherePitch");
    }
  }
});

test("INSIDE_SPHERE: tunnel gestures do nothing there", () => {
  for (const gesture of ["swipeForward", "swipeBackward"]) {
    const decision = resolve(gesture, { appState: APP_STATE_INSIDE_SPHERE });
    assert.equal(decision.type, "none", gesture);
    assert.equal(decision.reason, "wrong-state", gesture);
  }
});

test("transition states are dead ground for every gesture", () => {
  for (const appState of ["transition_to_sphere", "exiting_sphere"]) {
    for (const gesture of MICROGESTURE_IDS) {
      assert.equal(resolve(gesture, { appState }).type, "none", `${gesture} in ${appState}`);
    }
  }
});

test("an unmapped gesture id resolves to nothing", () => {
  const decision = resolve("swipeDiagonal");
  assert.equal(decision.type, "none");
  assert.equal(decision.reason, "unmapped");
});

// --- swallow rules ----------------------------------------------------------

test("a wrist-launcher poke swallows every gesture, from either hand", () => {
  for (const appState of [APP_STATE_TUNNEL, APP_STATE_INSIDE_SPHERE]) {
    for (const gesture of MICROGESTURE_IDS) {
      const decision = resolve(gesture, { appState, launcherCapturing: true });
      assert.equal(decision.type, "none", `${gesture} in ${appState}`);
      assert.equal(decision.reason, "launcher-poke");
    }
  }
});

test("an open world panel swallows every gesture, tap-thumb included", () => {
  for (const appState of [APP_STATE_TUNNEL, APP_STATE_INSIDE_SPHERE]) {
    for (const gesture of MICROGESTURE_IDS) {
      const decision = resolve(gesture, { appState, panelOpen: true });
      assert.equal(decision.type, "none", `${gesture} in ${appState}`);
      assert.equal(decision.reason, "panel-open");
    }
  }
});

test("the poke gate is checked before the panel gate, so a poke reads as a poke", () => {
  // Both are true whenever the launcher is used to switch an already-open panel;
  // the readout should name the thing the user is actually doing.
  const decision = resolve("tapThumb", {
    appState: APP_STATE_INSIDE_SPHERE,
    panelOpen: true,
    launcherCapturing: true
  });
  assert.equal(decision.reason, "launcher-poke");
});

// --- GenAI variation --------------------------------------------------------

test("INSIDE_SPHERE: tap-thumb fires the GenAI variation", () => {
  assert.deepEqual(resolve("tapThumb", { appState: APP_STATE_INSIDE_SPHERE }), {
    type: "genAiVariation", direction: 0, reason: "", swallowSelect: true
  });
});

test("a repeat tap while a variation is pending is refused, not queued", () => {
  const decision = resolve("tapThumb", {
    appState: APP_STATE_INSIDE_SPHERE,
    genAiPending: true
  });
  assert.equal(decision.type, "none");
  assert.equal(decision.reason, "genai-pending");
  // Refusal must still swallow the select — a tap is never a pinch, whether or
  // not the tap itself got anywhere.
  assert.equal(decision.swallowSelect, true);
});

test("a tap always suppresses that frame's Select, whatever else it does", () => {
  const cases = [
    { appState: APP_STATE_INSIDE_SPHERE },
    { appState: APP_STATE_INSIDE_SPHERE, genAiPending: true },
    { appState: APP_STATE_TUNNEL },
    { appState: APP_STATE_INSIDE_SPHERE, panelOpen: true },
    { appState: APP_STATE_INSIDE_SPHERE, launcherCapturing: true }
  ];
  for (const overrides of cases) {
    assert.equal(resolve("tapThumb", overrides).swallowSelect, true, JSON.stringify(overrides));
  }
});

// On Quest 3 / OculusBrowser 150 a swipe fires the pinch button alongside its own
// (`pressed:[0,5]` for swipe-left, `[0,8]` for swipe-backward), so in the sphere a
// left swipe would navigate away instead of rotating. Every microgesture
// therefore swallows its frame's Select.
test("every microgesture suppresses Select, because a swipe co-fires the pinch", () => {
  for (const gesture of ["swipeLeft", "swipeRight", "swipeForward", "swipeBackward", "tapThumb"]) {
    for (const appState of [APP_STATE_TUNNEL, APP_STATE_INSIDE_SPHERE]) {
      assert.equal(resolve(gesture, { appState }).swallowSelect, true, `${gesture} in ${appState}`);
    }
  }
});

// --- tunnel speed clamp -----------------------------------------------------

test("a speed step is clamped to the same 4..45 the stick path uses", () => {
  assert.equal(stepTunnelSpeed(20, 1, 4), 24);
  assert.equal(stepTunnelSpeed(20, -1, 4), 16);
  assert.equal(stepTunnelSpeed(MICROGESTURE_SPEED_MAX - 1, 1, 4), MICROGESTURE_SPEED_MAX);
  assert.equal(stepTunnelSpeed(MICROGESTURE_SPEED_MIN + 1, -1, 4), MICROGESTURE_SPEED_MIN);
  assert.equal(stepTunnelSpeed(MICROGESTURE_SPEED_MAX, 1, 4), MICROGESTURE_SPEED_MAX, "saturates, no drift");
  assert.equal(stepTunnelSpeed(MICROGESTURE_SPEED_MIN, -1, 4), MICROGESTURE_SPEED_MIN);
});

test("repeated swipes cross the whole range and saturate there", () => {
  // 4 -> 45 in 4-unit steps is eleven swipes; the rest must not drift past it.
  let speed = MICROGESTURE_SPEED_MIN;
  for (let i = 0; i < 11; i += 1) {
    speed = stepTunnelSpeed(speed, 1, 4);
  }
  assert.equal(speed, MICROGESTURE_SPEED_MAX);
  assert.equal(stepTunnelSpeed(speed, 1, 4), MICROGESTURE_SPEED_MAX);
});

test("a NaN speed falls back to the floor rather than poisoning the tunnel", () => {
  // state.cameraSpeed is read back from the flat speed input, which can be
  // empty (and therefore NaN) for a frame.
  assert.equal(stepTunnelSpeed(Number.NaN, 1, 4), MICROGESTURE_SPEED_MIN);
  assert.equal(stepTunnelSpeed(undefined, -1, 4), MICROGESTURE_SPEED_MIN);
});
