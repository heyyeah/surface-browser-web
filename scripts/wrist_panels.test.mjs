// Two wrist panels, offline. Covers three pieces of pure logic the device pass
// cannot usefully prove by hand:
//
//   * role resolution: `wristPanelHand` is a mirror flag, not "which wrist has
//     the panel" (both do), and getting it wrong would put Exit VR on the wrist
//     the user is reaching WITH;
//   * the Exit VR hold: a fingertip must never end a session on a single
//     contact, must survive the tracking dropouts and millimetre jitter that a
//     1.5 s hold guarantees, and must fire exactly once;
//   * the label tier: it can change while a finger is already travelling toward
//     a target, so it is driven by gaze rather than by the second hand.
//
// The poke latch itself, and the close/switch/promote decision, are covered in
// wrist_poke.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWristHoldState,
  updateWristHoldState,
  wristHoldAborted,
  resolveWristLabelMode,
  resolveWristPanelRole,
  resolveFreeHand,
  isWristRaySelectable,
  nearestPokeTarget,
  DEFAULT_WRIST_PANEL_HAND
} from "../src/wrist-poke.js";
import {
  createRayHoldState,
  updateRayHoldState
} from "../src/xr-ray-sources.js";

const EXIT_INDEX = 2;
const CONTACT_M = 0.010;
const RELEASE_M = 0.026;
const HOLD_S = 1.5;
const FRAME_S = 1 / 30; // hand tracking runs at 30 Hz; design for it.

function hold(state, { index = EXIT_INDEX, approachM = 0.004, tracked = true, dtS = FRAME_S } = {}) {
  return updateWristHoldState(state, {
    tracked,
    index,
    approachM,
    holdIndex: EXIT_INDEX,
    contactRadiusM: CONTACT_M,
    releaseRadiusM: RELEASE_M,
    dtS,
    holdSeconds: HOLD_S
  });
}

// Hold for `seconds` of frames and return the state plus whether it ever fired.
function holdFor(state, seconds, opts) {
  let fired = false;
  const frames = Math.ceil(seconds / FRAME_S);
  for (let i = 0; i < frames; i += 1) {
    const next = hold(state, opts);
    if (next.fired && !state.fired) {
      fired = true;
    }
    state = next;
  }
  return { state, fired };
}

// --- panel roles ------------------------------------------------------------

test("the default mirror puts content on the left wrist and system on the right", () => {
  // Layout: left = Web/Image/GenAI, right = Help/Settings/Exit VR.
  assert.equal(DEFAULT_WRIST_PANEL_HAND, "left");
  assert.equal(resolveWristPanelRole("left", "left"), "content");
  assert.equal(resolveWristPanelRole("right", "left"), "system");
});

test("flipping the setting mirrors both panels together", () => {
  assert.equal(resolveWristPanelRole("left", "right"), "system");
  assert.equal(resolveWristPanelRole("right", "right"), "content");
});

test("the two wrists never carry the same role, for any setting value", () => {
  for (const value of ["left", "right", "LEFT", " Right ", "", null, undefined, "middle", 7]) {
    assert.notEqual(
      resolveWristPanelRole("left", value),
      resolveWristPanelRole("right", value),
      `both wrists resolved to the same role for ${JSON.stringify(value)}`
    );
  }
});

test("the hand that pokes the content panel is the one opposite it", () => {
  // input.js resolves sphere Select from resolveFreeHand(); with the default that
  // is the right hand, and it must stay the hand NOT wearing the content panel.
  for (const value of ["left", "right"]) {
    assert.equal(resolveWristPanelRole(resolveFreeHand(value), value), "system");
  }
});

// --- Exit VR hold -----------------------------------------------------------

test("a single frame of contact does not exit", () => {
  const state = hold(createWristHoldState());
  assert.equal(state.fired, false);
  assert.ok(state.progress > 0 && state.progress < 0.1, "it has started, that is all");
});

test("brief contact well short of the hold does not exit", () => {
  // Half a second is a firm, deliberate poke — and must still do nothing.
  const { state, fired } = holdFor(createWristHoldState(), 0.5);
  assert.equal(fired, false);
  assert.equal(state.fired, false);
  assert.ok(state.progress > 0.3 && state.progress < 0.4);
});

test("a sustained hold fires once, at the hold time, and never again", () => {
  const { state, fired } = holdFor(createWristHoldState(), HOLD_S + FRAME_S);
  assert.equal(fired, true);
  assert.equal(state.fired, true);
  assert.equal(state.progress, 1);

  // Keeping the finger there must not fire a second session-end.
  let s = state;
  for (let i = 0; i < 30; i += 1) {
    const next = hold(s);
    assert.equal(next.fired && !s.fired, false, "no re-fire while the finger stays");
    s = next;
  }
  assert.equal(s.elapsedS, state.elapsedS, "the timer stops once it has fired");
});

test("lifting off before the hold completes abandons it, and says so", () => {
  const { state } = holdFor(createWristHoldState(), 1.0);
  assert.ok(state.elapsedS > 0.9);
  const next = hold(state, { approachM: 0.05 });
  assert.equal(next.elapsedS, 0, "the timer resets");
  assert.equal(next.fired, false);
  assert.equal(wristHoldAborted(state, next), true, "and reports the abort for the UI cue");
});

test("an abandoned hold starts from zero, not from where it left off", () => {
  const first = holdFor(createWristHoldState(), 1.2).state;
  const released = hold(first, { approachM: 0.05 });
  const { fired } = holdFor(released, 1.0);
  assert.equal(fired, false, "1.2 s + 1.0 s must not add up to an exit");
});

test("millimetre jitter inside the release band neither advances nor resets", () => {
  // 30 Hz tracking over 1.5 s: a fingertip WILL drift in and out of the contact
  // radius. Resetting on every wobble would make the hold impossible to finish.
  const held = holdFor(createWristHoldState(), 1.0).state;
  const wobble = hold(held, { approachM: 0.018 });
  assert.equal(wobble.elapsedS, held.elapsedS, "the timer pauses rather than resets");
  assert.equal(wobble.holding, false, "but it is no longer counted as contact");
  const resumed = hold(wobble);
  assert.ok(resumed.elapsedS > held.elapsedS, "and it resumes on re-contact");
});

test("a tracking dropout freezes the timer instead of completing it", () => {
  // The dangerous failure: the hand vanishes at 1.4 s and the hold runs on to
  // end the session by itself. It must neither advance nor reset.
  const held = holdFor(createWristHoldState(), 1.4).state;
  const { state, fired } = holdFor(held, 2.0, { tracked: false });
  assert.equal(fired, false, "a vanished hand must never exit VR");
  assert.equal(state.elapsedS, held.elapsedS);
  assert.equal(wristHoldAborted(held, state), false, "and it is not an abort either");
});

test("sliding onto a different row abandons the hold", () => {
  const held = holdFor(createWristHoldState(), 1.0).state;
  const moved = hold(held, { index: 0 });
  assert.equal(moved.elapsedS, 0);
  assert.equal(moved.fired, false);
});

test("a panel with no hold row keeps no hold state at all", () => {
  const state = updateWristHoldState(createWristHoldState(), {
    tracked: true,
    index: 1,
    approachM: 0.001,
    holdIndex: -1,
    contactRadiusM: CONTACT_M,
    releaseRadiusM: RELEASE_M,
    dtS: FRAME_S,
    holdSeconds: HOLD_S
  });
  assert.deepEqual(state, createWristHoldState());
});

test("the hold state object is never mutated", () => {
  const state = createWristHoldState();
  const snapshot = { ...state };
  hold(state);
  assert.deepEqual(state, snapshot);
});

// --- label tier: gaze-to-expand ----------------------------------------------
// Labels expand on gaze, not on "both hands in view": that trigger fired
// mid-reach, as the other hand came across to poke, whereas looking at a wrist
// happens before the reach.

test("a hand merely in view shows icons; looking at it brings the text", () => {
  assert.equal(
    resolveWristLabelMode("icons", { pinned: false, gazeFocused: false, frozen: false }),
    "icons"
  );
  assert.equal(
    resolveWristLabelMode("icons", { pinned: false, gazeFocused: true, frozen: false }),
    "labels"
  );
  assert.equal(
    resolveWristLabelMode("labels", { pinned: false, gazeFocused: false, frozen: false }),
    "icons",
    "looking away collapses it back to the minimal state"
  );
});

test("the other hand arriving no longer expands anything by itself", () => {
  // The retired rule, stated as a test so it cannot creep back: nothing about
  // the poking hand may feed the label tier. Only gaze (and the pin) may.
  assert.equal(
    resolveWristLabelMode("icons", {
      pinned: false,
      gazeFocused: false,
      frozen: false,
      bothHandsTracked: true
    }),
    "icons"
  );
});

test("an approach in progress pins the tier, in both directions", () => {
  // Freeze-on-approach governs the label tier for the same reason it governs the
  // pose. Poking your own wrist means looking down at your finger, which drops the
  // focus cone, so without this pin an expanded panel would collapse to icons (and
  // the rows narrow) under a finger already travelling toward one.
  assert.equal(
    resolveWristLabelMode("labels", { pinned: false, gazeFocused: false, frozen: true }),
    "labels",
    "a panel being poked must not collapse from labels to icons"
  );
  assert.equal(
    resolveWristLabelMode("icons", { pinned: false, gazeFocused: true, frozen: true }),
    "icons",
    "nor grow mid-reach"
  );
});

test("?wristlabels=1 beats everything, including a frozen approach", () => {
  for (const gazeFocused of [false, true]) {
    for (const frozen of [false, true]) {
      assert.equal(
        resolveWristLabelMode("icons", { pinned: true, gazeFocused, frozen }),
        "labels"
      );
      assert.equal(
        resolveWristLabelMode("labels", { pinned: true, gazeFocused, frozen }),
        "labels"
      );
    }
  }
});

// --- the world-menu gaze collapse --------------------------------------------
// The wrist menus collapse to icons while the user looks at the world menu.

test("reading the world menu collapses the wrist panels to icons", () => {
  assert.equal(
    resolveWristLabelMode("labels", {
      pinned: false,
      gazeFocused: true,
      frozen: false,
      worldMenuGaze: true
    }),
    "icons",
    "the world menu outranks the ordinary wrist-gaze tier"
  );
  assert.equal(
    resolveWristLabelMode("icons", {
      pinned: false,
      gazeFocused: false,
      frozen: false,
      worldMenuGaze: false
    }),
    "icons"
  );
  assert.equal(
    resolveWristLabelMode("icons", {
      pinned: false,
      gazeFocused: true,
      frozen: false,
      worldMenuGaze: false
    }),
    "labels",
    "looking back at the wrist brings the words straight back"
  );
});

test("THE COLLAPSE LOSES TO A POKE IN PROGRESS", () => {
  // The one ordering that matters on device: with the world menu open and a
  // finger already travelling toward a wrist row, collapsing would shrink the
  // target under the finger — the exact failure freeze-on-approach exists to
  // prevent. Freeze pins the tier; the collapse waits its turn.
  assert.equal(
    resolveWristLabelMode("labels", {
      pinned: false,
      gazeFocused: false,
      frozen: true,
      worldMenuGaze: true
    }),
    "labels"
  );
  // ...and it does not grow one either: frozen means "whatever it already was".
  assert.equal(
    resolveWristLabelMode("icons", {
      pinned: false,
      gazeFocused: true,
      frozen: true,
      worldMenuGaze: true
    }),
    "icons"
  );
});

test("the label tier resolves the same way for all sixteen input combinations", () => {
  // The whole precedence, stated once as a table so a reordering has to change this
  // file rather than merely pass it: pinned > frozen > worldMenuGaze > gazeFocused.
  // Pinned over frozen is runtime-identical (`?wristlabels=1` is a load-time flag,
  // so under it `prev` is always "labels" and the frozen branch returns "labels"
  // too), but pinned-first cannot be wrong on a first frame.
  const expected = (prev, { pinned, frozen, worldMenuGaze, gazeFocused }) => {
    if (pinned) return "labels";
    if (frozen) return prev;
    if (worldMenuGaze) return "icons";
    return gazeFocused ? "labels" : "icons";
  };
  for (const prev of ["icons", "labels"]) {
    for (const pinned of [false, true]) {
      for (const frozen of [false, true]) {
        for (const worldMenuGaze of [false, true]) {
          for (const gazeFocused of [false, true]) {
            const inputs = { pinned, frozen, worldMenuGaze, gazeFocused };
            assert.equal(
              resolveWristLabelMode(prev, inputs),
              expected(prev, inputs),
              `${prev} + ${JSON.stringify(inputs)}`
            );
          }
        }
      }
    }
  }
});

test("an omitted worldMenuGaze behaves exactly as a false one", () => {
  // wristui.js always passes it; nothing else should have to.
  assert.equal(
    resolveWristLabelMode("icons", { pinned: false, gazeFocused: true, frozen: false }),
    "labels"
  );
});

test("an unrecognised previous mode falls back to icons rather than sticking", () => {
  assert.equal(
    resolveWristLabelMode(undefined, { pinned: false, gazeFocused: true, frozen: true }),
    "icons"
  );
});

// --- where the panel sits on the arm -----------------------------------------
// Placement is pose maths that needs a live XR frame, but the NUMBERS that decide
// it are plain constants, and the arithmetic they imply (which row ends up where
// along the forearm) is checkable. Source-level for the same reason
// activateTarget() is tested that way in wrist_poke.test.mjs.
async function wristGeometry() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
  const num = (name) => {
    const match = src.match(new RegExp(`const ${name} = (-?[0-9.]+);`));
    assert.ok(match, `${name} is missing or no longer a literal`);
    return Number(match[1]);
  };
  const rowH = num("WRIST_ROW_H_M");
  const gap = num("WRIST_TARGET_GAP_M");
  const pad = num("WRIST_PAD_M");
  const rows = 3;
  const heightM = (pad * 2) + (rowH * rows) + (gap * (rows - 1));
  const centreDistalM = num("WRIST_QUAD_OFFSET_DISTAL_M");
  // Row 0 is drawn at the DISTAL end (layoutRectToLocalRect flips y), so the
  // last row — GenAI on the content panel, Exit VR on the system one — is the
  // most proximal and the hardest to reach across.
  const rowDistalM = (i) => centreDistalM + (heightM / 2) - (pad + (i * (rowH + gap)) + (rowH / 2));
  return { heightM, centreDistalM, rowDistalM, palmOffsetM: num("WRIST_QUAD_OFFSET_PALM_M") };
}

test("the panel spans palm-to-wrist rather than sitting up the forearm", async () => {
  const g = await wristGeometry();
  // Distances are along `distal` from the WRIST JOINT: positive is toward the
  // fingers, negative toward the elbow.
  const distalEdgeM = g.centreDistalM + (g.heightM / 2);
  const proximalEdgeM = g.centreDistalM - (g.heightM / 2);
  assert.ok(distalEdgeM > 0.04, `the panel reaches over the palm (${distalEdgeM.toFixed(3)} m)`);
  // The MCP knuckles sit ~0.09 m from the wrist joint. Stopping short of them
  // is what keeps the wearing hand's own extended fingers out of the panel's
  // footprint — the panel floats WRIST_QUAD_OFFSET_PALM_M off the palm, so a
  // panel that ran past the knuckles would be read through them.
  assert.ok(distalEdgeM < 0.085, `and stops short of the knuckles (${distalEdgeM.toFixed(3)} m)`);
  // ...while its proximal half is still on the forearm, not floating in space
  // beyond the hand.
  assert.ok(proximalEdgeM < 0, `the panel still sits on the arm (${proximalEdgeM.toFixed(3)} m)`);
  assert.ok(proximalEdgeM > -0.07, `but not out at the elbow (${proximalEdgeM.toFixed(3)} m)`);
});

test("the far row is within reach of the wrist, which is the complaint", async () => {
  const g = await wristGeometry();
  const farRowM = g.rowDistalM(2);
  // The panel's centre sits near the wrist joint rather than up the forearm; the
  // exact number is tuned on device.
  assert.ok(farRowM > -0.045, `GenAI/Exit is near the wrist (${farRowM.toFixed(3)} m)`);
  // ...and the near row has not been pushed out past the fingers to buy it.
  assert.ok(g.rowDistalM(0) < 0.07, `and the near row stays on the palm`);
  // The rows are still in distal order, which is what makes "row 2 is the far
  // one" true at all.
  assert.ok(g.rowDistalM(0) > g.rowDistalM(1));
  assert.ok(g.rowDistalM(1) > g.rowDistalM(2));
});

// --- Controller ray on the wrist panel ---------------------------------------
// Hand tracking is off by default on a Quest 2 and Capture lives only on the
// system wrist panel, so a controller-only visitor must be able to reach it by
// ray. The cast itself is vrpanel's and needs a live XR frame; what is checkable
// offline is the RULE about which panels a ray may reach, and the "containment,
// not nearest" convention the row hit uses.

test("a summoned panel is offered to the OTHER arm's ray, never its own", () => {
  const left = { visible: true, handedness: "left" };
  assert.equal(isWristRaySelectable(left, "right"), true);
  assert.equal(isWristRaySelectable(left, "left"), false);
});

test("a panel that is not summoned absorbs nothing", () => {
  // The hazard this guards is invisible on device: a hidden quad left in the
  // cast eats picks meant for the world panel or the sphere.
  assert.equal(isWristRaySelectable({ visible: false, handedness: "left" }, "right"), false);
  assert.equal(isWristRaySelectable({ visible: false, handedness: "left" }, "left"), false);
});

test("a source with no handedness cannot claim either panel's own-arm exemption", () => {
  // "none"/undefined is a real WebXR value (xr-ray-sources.js places such a
  // source in whatever slot is free); it is not either arm, so both panels stay
  // selectable rather than both being refused.
  assert.equal(isWristRaySelectable({ visible: true, handedness: "left" }, undefined), true);
  assert.equal(isWristRaySelectable({ visible: true, handedness: "right" }, "none"), true);
});

test("a missing panel is refused rather than throwing", () => {
  assert.equal(isWristRaySelectable(undefined, "left"), false);
});

// The ray reads a row by CONTAINMENT — nearestPokeTarget()'s approach distance
// is zero only over a rect's face — where a fingertip is scored by proximity.
// A ray is precise; the padding between rows must select nothing, exactly as the
// world panel's own hitRectIndexAt() does.
test("a ray between two rows selects neither", () => {
  const rects = [
    { x: -0.012, y: 0.012, w: 0.024, h: 0.024 },
    { x: -0.012, y: -0.036, w: 0.024, h: 0.024 }
  ];
  const onRow = nearestPokeTarget({ x: 0, y: 0.024, z: 0 }, rects);
  assert.equal(onRow.index, 0);
  assert.ok(onRow.approachM <= 1e-6, "over a row's face the approach is zero");
  const inGap = nearestPokeTarget({ x: 0, y: 0, z: 0 }, rects);
  assert.ok(inGap.approachM > 1e-6, "the padding between rows is not a target");
});

// --- Controller anchor -------------------------------------------------------
// Hand tracking is off by default on a Quest 2, so a controller-only visitor is
// the common case. The pose maths needs a live XR frame; the clearance the panel
// is placed with is arithmetic on two constants.

async function controllerGeometry() {
  const g = await wristGeometry();
  const src = await wristSource();
  const match = src.match(/const CONTROLLER_QUAD_OFFSET_BACK_M = (-?[0-9.]+);/);
  assert.ok(match, "CONTROLLER_QUAD_OFFSET_BACK_M is missing or no longer a literal");
  return { ...g, backM: Number(match[1]) };
}

// How far a vendored controller model reaches along one grip-space axis, from the
// GLB's own accessor bounds with every node transform applied. Measured rather
// than quoted: hand-taken numbers are easily short by tens of millimetres, which
// shows up as a menu buried in a controller.
async function modelExtentM(glbPath, axis) {
  const fs = await import("node:fs");
  const buf = fs.readFileSync(glbPath);
  const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
  const compose = (node) => {
    if (node.matrix) return node.matrix.slice();
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      tx, ty, tz, 1
    ];
  };
  const multiply = (a, b) => {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c += 1) {
      for (let r = 0; r < 4; r += 1) {
        for (let k = 0; k < 4; k += 1) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
      }
    }
    return out;
  };
  let extent = -Infinity;
  const visit = (index, parent) => {
    const node = gltf.nodes[index];
    const m = multiply(parent, compose(node));
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const acc = gltf.accessors[prim.attributes.POSITION];
        if (!acc?.min || !acc?.max) continue;
        // Every corner of the accessor's own box, through this node's world
        // matrix: a rotated node's max corner is not the box's max corner.
        for (let i = 0; i < 8; i += 1) {
          const p = [
            (i & 1) ? acc.max[0] : acc.min[0],
            (i & 2) ? acc.max[1] : acc.min[1],
            (i & 4) ? acc.max[2] : acc.min[2]
          ];
          const v = m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis];
          if (v > extent) extent = v;
        }
      }
    }
    for (const child of node.children || []) visit(child, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const index of gltf.scenes[gltf.scene || 0].nodes) visit(index, identity);
  return extent;
}

async function controllerModelPaths() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.join(root, "public", "webxr-assets", "profiles");
  const paths = [];
  for (const profile of fs.readdirSync(dir)) {
    // The hand mesh is not a controller and is not what the panel clears.
    if (profile === "generic-hand" || !fs.statSync(path.join(dir, profile)).isDirectory()) continue;
    for (const hand of ["left.glb", "right.glb"]) paths.push(path.join(dir, profile, hand));
  }
  assert.ok(paths.length >= 6, "the vendored controller profiles are missing");
  return paths;
}

test("the controller panel sits clear of every vendored model, not inside one", async () => {
  const g = await controllerGeometry();
  let deepest = 0;
  for (const glb of await controllerModelPaths()) {
    // +Z in grip space: back toward the visitor, the axis the panel hangs off.
    deepest = Math.max(deepest, await modelExtentM(glb, 2));
  }
  // Worst orientation — the controller held across the view, which puts the
  // back axis in the panel's own plane, so the panel reaches half its height
  // toward the hardware. In the ordinary aiming pose the panel is nearly
  // perpendicular to this axis and the whole offset is clearance.
  const nearEdgeM = g.backM - (g.heightM / 2);
  assert.ok(
    nearEdgeM > deepest,
    `the panel clears the deepest model (${nearEdgeM.toFixed(3)} m vs ${deepest.toFixed(3)} m)`
  );
  // ...and still reads as belonging to the hand holding it rather than as a
  // second world panel hanging in the air.
  assert.ok(g.backM < 0.25, `but stays with the controller (${g.backM.toFixed(3)} m)`);
});

test("behind is taken from the grip, not from the head", async () => {
  const src = await wristSource();
  // A head-relative "behind" would swim across the controller every time the
  // visitor turned. Grip -Z is where the controller points, so +Z is behind it.
  assert.match(src, /hf\.back\.set\(0, 0, 1\)\.applyQuaternion\(_gripQuaternion\)/);
  assert.match(src, /addScaledVector\(hf\.back, CONTROLLER_QUAD_OFFSET_BACK_M\)/);
  // The panel still faces the head and still levels its up against world up —
  // moving it must not cost readability.
  assert.match(src, /hf\.palmNormal\.copy\(_headPosition\)\.sub\(hf\.wrist\)/);
  assert.match(src, /hf\.distal\.copy\(WORLD_UP\)/);
});

test("the controller offset is its own axis, not the wrist's forearm slide", async () => {
  const g = await controllerGeometry();
  // The wrist panel slides along the forearm; the controller panel sits back
  // behind the hardware. Sharing the number would put the panel inside it.
  assert.ok(g.backM > g.centreDistalM * 5, "the two offsets are independent numbers");
});

test("the two-tier summon rule is untouched by the move", async () => {
  const src = await wristSource();
  assert.match(src, /const WRIST_SUMMON_VIEW_MAX_ANGLE_DEG = 50;/);
  assert.match(src, /const WRIST_SUMMON_FOCUS_MAX_ANGLE_DEG = 15;/);
});

// --- Solid back face ---------------------------------------------------------
// The panel shows whichever way the arm is turned, so a visitor WILL meet its
// back; it must not be the menu mirrored and read through the balls of their own
// hand. Materials need a GL context, so the invariants are checked at source
// level; each of these breaks something the panel already depends on.

async function wristSource() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, "..", "src", "wristui.js"), "utf8");
}

test("the front is front-only, which is also what keeps the back out of the cast", async () => {
  const src = await wristSource();
  assert.ok(!src.includes("THREE.DoubleSide"), "a double-sided quad shows the menu mirrored");
  assert.match(src, /side: THREE\.FrontSide/);
  assert.match(src, /side: THREE\.BackSide/);
});

test("the back is solid, never a hole, and never a control", async () => {
  const src = await wristSource();
  const block = src.match(/const backMaterial = [\s\S]*?panel\.quad\.add\(panel\.back\);/);
  assert.ok(block, "the back-face block is missing");
  // depthWrite off: it must not punch a hole in anything drawn after it.
  assert.match(block[0], /depthWrite: false/);
  // Same renderOrder as the front — it is the same surface, seen the other way.
  assert.match(block[0], /panel\.back\.renderOrder = WRIST_PANEL_RENDER_ORDER/);
  // A ray that hits the back must pass through, never activate a row the user
  // cannot see.
  assert.match(block[0], /panel\.back\.raycast = \(\) => \{\}/);
});

test("the back reuses the panel's own background colour", async () => {
  const src = await wristSource();
  const bg = src.match(/const COLOR_BG = "#([0-9a-f]{6})/);
  const back = src.match(/const COLOR_BACK_FACE = 0x([0-9a-f]{6});/);
  assert.ok(bg && back, "one of the two colours is no longer a literal");
  assert.equal(back[1], bg[1], "the back must not introduce a second chrome");
  const opacity = Number(src.match(/const BACK_FACE_OPACITY = ([0-9.]+);/)[1]);
  // Solid, and at least as opaque as the front (COLOR_BG's own alpha).
  assert.ok(opacity >= 0.949 && opacity <= 1, `back opacity ${opacity}`);
});

// --- Draw order against the world panel --------------------------------------
// The wrist panels are ~0.4 m away and the world panel is at 2.4 m, but the world
// panel is depthTest:false, so nothing about depth decides the pair: only
// renderOrder does, and the wrist quad must sort above the world panel's. The
// cursor dot has to keep landing ON the wrist panel, so the quad also has to stay
// under the ray visuals: this is a window, not a ceiling.

async function panelSource() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, "..", "src", "vrpanel.js"), "utf8");
}

test("a wrist panel draws in FRONT of the world menu, and behind the ray dot", async () => {
  const wrist = await wristSource();
  const panel = await panelSource();
  const num = (src, re, what) => {
    const match = src.match(re);
    assert.ok(match, `${what} is missing or no longer a literal`);
    return Number(match[1]);
  };
  const wristOrder = num(
    wrist,
    /const WRIST_PANEL_RENDER_ORDER = ([0-9.]+);/,
    "WRIST_PANEL_RENDER_ORDER"
  );
  const worldOrder = num(panel, /mesh\.renderOrder = ([0-9]+);/, "the world panel's renderOrder");
  const lineOrder = num(panel, /line\.renderOrder = ([0-9]+);/, "the ray line's renderOrder");
  const dotOrder = num(panel, /dot\.renderOrder = ([0-9]+);/, "the ray dot's renderOrder");
  assert.ok(wristOrder > worldOrder, `wrist ${wristOrder} draws after world ${worldOrder}`);
  assert.ok(wristOrder < lineOrder, `wrist ${wristOrder} draws before the ray ${lineOrder}`);
  assert.ok(wristOrder < dotOrder, `wrist ${wristOrder} draws before the dot ${dotOrder}`);
  // The front and the back are one surface seen two ways; splitting them here
  // would let the back sort in front of the menu while the front did not.
  const assignments = wrist.match(/panel\.(quad|back)\.renderOrder = ([^;]+);/g) || [];
  assert.equal(assignments.length, 2);
  for (const line of assignments) {
    assert.match(line, /WRIST_PANEL_RENDER_ORDER/);
  }
});

test("the world panel really is depth-blind, which is why draw order decides", async () => {
  const panel = await panelSource();
  // If this ever became depthTest:true the wrist quad could go back to sorting
  // by distance — and the fractional renderOrder above would stop being needed.
  const block = panel.match(/const material = new THREE\.MeshBasicMaterial\(\{[\s\S]*?\}\);\n  const mesh = new THREE\.Mesh/);
  assert.ok(block, "createPanelSurface's material block moved");
  assert.match(block[0], /depthTest: false/);
});

test("the pump copies each slot's targets and every slot hovers its own hit", async () => {
  const panel = await panelSource();
  // Both are one-line regressions to reintroduce, and both fail invisibly on
  // device — the first as "no hover from either controller", the second as "no
  // hover from the second one".
  assert.match(panel, /fillSlotRayTargets\(slotSources, extraRayTargetsFor, _slotExtras\)/);
  assert.ok(
    !/_slotExtras\[slot\] = /.test(panel),
    "holding the provider's own array aliases every slot to the last one asked"
  );
  // Hover is per slot; the nearest-hit arbitration is narrowed to the ONE thing
  // still shared, the world panel's single hover index.
  assert.match(panel, /pickPointerSlot\(_slotWorldHits\)/);
  assert.ok(
    !/pickPointerSlot\(_slotHits\)/.test(panel),
    "a single pointer owner would starve the other ray of hover again"
  );
});

// --- Exit VR from a controller ray -------------------------------------------
// The Exit row is hold-to-activate, and the ray path activates through a single
// one-shot call, an EDGE, which can never complete a hold. The ray therefore gets
// the world panel's own ray hold machine, timed off the trigger LEVEL.
//
// The machine itself is covered in panel_exit_hold.test.mjs; what matters here is
// the SCOPE, which has to be the panel rather than the kind of surface, because
// there are two wrist panels and the mirror setting can move Exit between them.

const RAY_FRAME_S = 1 / 72;

function rayStep(state, { slot = 0, edge = false, scope = "right", dtS = RAY_FRAME_S } = {}) {
  const engaged = [false, false];
  const armed = [false, false];
  if (slot >= 0) {
    engaged[slot] = true;
    armed[slot] = edge;
  }
  return updateRayHoldState(state, { engaged, armed, scope, dtS, holdSeconds: HOLD_S });
}

function rayHoldFor(state, seconds, opts = {}) {
  let fires = 0;
  let next = rayStep(state, { ...opts, edge: true });
  fires += next.fired && !state.fired ? 1 : 0;
  let current = next;
  for (let i = 0; i < Math.ceil(seconds / RAY_FRAME_S); i += 1) {
    next = rayStep(current, opts);
    fires += next.fired && !current.fired ? 1 : 0;
    current = next;
  }
  return { state: current, fires };
}

test("a trigger tap on the wrist Exit row is not an exit", () => {
  let state = rayStep(createRayHoldState(), { edge: true });
  state = rayStep(state);
  assert.equal(state.fired, false);
  const released = rayStep(state, { slot: -1 });
  assert.equal(released.fired, false);
  assert.equal(released.elapsedS, 0);
});

test("holding the trigger on the wrist Exit row exits exactly once", () => {
  const { state, fires } = rayHoldFor(createRayHoldState(), HOLD_S);
  assert.equal(state.fired, true);
  assert.equal(fires, 1);
});

test("the ray leaving the wrist panel cancels the hold", () => {
  // The pump only reports a slot while its ray is ON the row, so a ray that
  // drifts off — or a controller that disconnects — arrives here as silence.
  const { state } = rayHoldFor(createRayHoldState(), 1.0);
  const off = rayStep(state, { slot: -1 });
  assert.equal(off.elapsedS, 0);
  assert.equal(off.fired, false);
});

test("a hold on one wrist cannot be finished on the other", () => {
  // `?wrist=` mirrors the pair, so the Exit row can move to the opposite arm
  // under a trigger that never came up. Scoping by panel is what stops the
  // in-flight hold finishing on a row that is now GenAI.
  const { state } = rayHoldFor(createRayHoldState(), 1.4, { scope: "right" });
  assert.ok(state.progress > 0.9);
  const swapped = rayStep(state, { scope: "left" });
  assert.equal(swapped.elapsedS, 0);
  assert.equal(swapped.fired, false);
});

test("the wrist ray hold is wired to the trigger level, the panel and the same duration", async () => {
  const wrist = await wristSource();
  const panel = await panelSource();
  // The pump has to hand hover() the LEVEL: an edge cannot time a hold.
  assert.match(panel, /_ray\.held = slotSelectHeld\(slotSources\[slot\], selectEdges\?\.held\)/);
  assert.match(panel, /hit\.target\.hover\(hit\.uv, _ray\)/);
  assert.match(panel, /hit\.target\.activate\(hit\.uv, _ray\)/);
  // Scope is the panel, not "wrist" — see the mirror case above.
  const call = wrist.match(/updateRayHoldState\(prevRay, \{[\s\S]*?\}\);/);
  assert.ok(call, "the wrist ray hold call moved");
  assert.match(call[0], /scope: panel\.handedness/);
  assert.match(call[0], /holdSeconds: WRIST_EXIT_HOLD_SECONDS/);
  // Both routes drive the same ring and the same row ring, so they look alike.
  assert.match(wrist, /setExitHoldProgress\(progress\)/);
  assert.match(wrist, /Math\.max\(panel\.hold\.progress, panel\.rayHold\.progress\)/);
});

test("the poke path is untouched by the ray hold", async () => {
  const wrist = await wristSource();
  // updateWristHoldState still owns the fingertip, with its own radii — the two
  // machines share a duration and a ring, never a cancel rule.
  const poke = wrist.match(/const next = updateWristHoldState\(prev, \{[\s\S]*?\}\);/);
  assert.ok(poke, "the poke hold call moved");
  assert.match(poke[0], /contactRadiusM: WRIST_POKE_ACTIVATE_M/);
  assert.match(poke[0], /releaseRadiusM: WRIST_HOLD_RELEASE_M/);
  assert.match(poke[0], /holdIndex: SYSTEM_EXIT_INDEX/);
});

test("Exit VR is still the only hold-shaped row on either panel", async () => {
  const wrist = await wristSource();
  // A second hold row would need the same ray treatment, and would silently do
  // nothing from a controller until it got it.
  const rows = wrist.match(/hold: true/g) || [];
  assert.equal(rows.length, 1, "one hold row in the system table");
  assert.match(wrist, /exit: \{ labelKey: "vr\.exitShort"[^}]*hold: true \}/);
  // The content rows are built with hold: false, so the mirror cannot make one.
  assert.match(wrist, /hold: false/);
});
