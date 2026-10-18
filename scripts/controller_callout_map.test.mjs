// Which binding is annotated on which button, in which tier, and whether it
// does anything in the current app state.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveControllerCallouts,
  controllerCalloutKey,
  TIER_PRIMARY,
  GLYPH_UP_DOWN,
  GLYPH_FOUR_WAY
} from "../src/controller-callout-map.js";

const TUNNEL = "tunnel";
const SPHERE = "inside_sphere";

const byId = (items) => new Map(items.map((item) => [item.id, item]));

test("a hand with no controller gets nothing", () => {
  assert.deepEqual(resolveControllerCallouts({ handedness: "none", appState: TUNNEL }), []);
  assert.deepEqual(resolveControllerCallouts(), []);
});

test("everything on the glance is a primary-tier mark", () => {
  for (const handedness of ["left", "right"]) {
    for (const appState of [TUNNEL, SPHERE]) {
      const items = resolveControllerCallouts({ handedness, appState });
      assert.ok(items.length > 0);
      assert.ok(items.every((item) => item.tier === TIER_PRIMARY));
    }
  }
});

// Help adds no marks of its own (neither stick press is annotated); it only stops
// hiding bindings that are inert right now. The marks are a reading of the
// hardware, always; the Help panel carries the full list.
test("the Help panel does not change what is on the controller", () => {
  for (const handedness of ["left", "right"]) {
    for (const appState of [TUNNEL, SPHERE]) {
      const items = resolveControllerCallouts({
        handedness, appState, captureEnabled: true, genaiEnabled: true
      });
      assert.ok(items.every((item) => item.available), "nothing inert is ever drawn");
      // Neither stick press is annotated anywhere.
      assert.ok(!items.some((item) => item.id.endsWith("-stick-press")));
    }
  }
});

// The glyph is the part that cannot be got from the button map: input.js reads
// only axis Y on the left stick inside the sphere, so a four-way there would
// promise a movement that does nothing.
test("only the right stick is four-way, and only inside the sphere", () => {
  const leftTunnel = byId(resolveControllerCallouts({ handedness: "left", appState: TUNNEL }));
  const leftSphere = byId(resolveControllerCallouts({ handedness: "left", appState: SPHERE }));
  const rightTunnel = byId(resolveControllerCallouts({ handedness: "right", appState: TUNNEL }));
  const rightSphere = byId(resolveControllerCallouts({ handedness: "right", appState: SPHERE }));

  assert.equal(leftTunnel.get("left-stick-axes").glyph, GLYPH_UP_DOWN);
  assert.equal(leftSphere.get("left-stick-axes").glyph, GLYPH_UP_DOWN);
  assert.equal(rightTunnel.get("right-stick-axes").glyph, GLYPH_UP_DOWN);
  assert.equal(rightSphere.get("right-stick-axes").glyph, GLYPH_FOUR_WAY);
});

test("the stick labels follow the state", () => {
  const leftTunnel = byId(resolveControllerCallouts({ handedness: "left", appState: TUNNEL }));
  const leftSphere = byId(resolveControllerCallouts({ handedness: "left", appState: SPHERE }));
  assert.equal(leftTunnel.get("left-stick-axes").labelKey, "callout.speed");
  assert.equal(leftSphere.get("left-stick-axes").labelKey, "callout.zoom");

  const rightSphere = byId(resolveControllerCallouts({ handedness: "right", appState: SPHERE }));
  assert.equal(rightSphere.get("right-stick-axes").labelKey, "callout.rotate");
});

// Dimmed in place rather than removed: a callout that vanished would teach the
// visitor the button does not exist.
test("state-specific bindings appear only where they work", () => {
  const ids = (appState) => resolveControllerCallouts({
    handedness: "right", appState, genaiEnabled: true
  }).map((item) => item.id);

  // Pause rotation is sphere-only.
  assert.ok(!ids(TUNNEL).includes("right-grip"));
  assert.ok(ids(SPHERE).includes("right-grip"));
  // Jump to the sphere is not annotated at all, in either state.
  assert.ok(!ids(TUNNEL).concat(ids(SPHERE)).includes("right-stick-press"));
});

test("the GenAI chord needs a relay and a sphere", () => {
  const has = (opts) => resolveControllerCallouts({ handedness: "left", ...opts })
    .some((item) => item.id === "left-grip");

  assert.equal(has({ appState: SPHERE }), false, "a sphere with no relay offers nothing");
  assert.equal(has({ appState: SPHERE, genaiEnabled: true }), true);
  assert.equal(has({ appState: TUNNEL, genaiEnabled: true }), false,
    "a relay with no sphere to work from is still nothing to offer");
});

// Y is Capture only where a capture token is configured; without one it is the
// second Help button. X is the menu either way.
test("Y is Capture only behind a token, and X is always the menu", () => {
  const plain = byId(resolveControllerCallouts({ handedness: "left", appState: TUNNEL }));
  assert.equal(plain.get("left-y").labelKey, "callout.help");

  const admin = byId(resolveControllerCallouts({
    handedness: "left", appState: TUNNEL, captureEnabled: true
  }));
  assert.equal(admin.get("left-y").labelKey, "callout.screenshot");
  assert.equal(plain.get("left-x").labelKey, "callout.menu");
  assert.equal(admin.get("left-x").labelKey, "callout.menu");
});

test("every callout names a component the model can be asked for", () => {
  const known = new Set([
    "xr-standard-trigger", "xr-standard-squeeze", "xr-standard-thumbstick",
    "a-button", "b-button", "x-button", "y-button"
  ]);
  for (const handedness of ["left", "right"]) {
    for (const item of resolveControllerCallouts({ handedness, appState: TUNNEL })) {
      assert.ok(known.has(item.component), `${item.id} -> ${item.component}`);
      assert.ok(item.labelKey.startsWith("callout."), `${item.id} label key`);
    }
  }
});

// The renderer re-rasters its label canvases only when this string changes, so
// anything that alters a label or a glyph has to alter the key too.
test("the redraw key tracks every input that changes a label", () => {
  const base = { handedness: "left", appState: TUNNEL };
  const key = controllerCalloutKey(base);
  assert.notEqual(key, controllerCalloutKey({ ...base, appState: SPHERE }));
  assert.notEqual(key, controllerCalloutKey({ ...base, panelOpen: true }));
  assert.notEqual(key, controllerCalloutKey({ ...base, captureEnabled: true }));
  assert.notEqual(key, controllerCalloutKey({ ...base, genaiEnabled: true }));
  assert.notEqual(key, controllerCalloutKey({ ...base, handedness: "right" }));
  assert.equal(key, controllerCalloutKey({ ...base }));
});

// The glance is a reading of the hardware in front of you; a mark that does
// nothing competes with four that do.
test("the glance drops what does nothing, Help keeps it dimmed", () => {
  const tunnel = resolveControllerCallouts({
    handedness: "right", appState: TUNNEL, genaiEnabled: true
  });
  assert.equal(tunnel.find((item) => item.id === "right-grip"), undefined,
    "pause rotation is sphere-only, so it is not on the tunnel glance");
  assert.ok(tunnel.every((item) => item.available), "nothing on the glance is inert");

  const sphere = resolveControllerCallouts({
    handedness: "right", appState: SPHERE, genaiEnabled: true
  });
  assert.ok(sphere.some((item) => item.id === "right-grip"), "and it is back in the sphere");

});

test("the tunnel glance is four marks, the sphere five", () => {
  for (const handedness of ["left", "right"]) {
    // With a panel up, so this stays a test about the GRIP rather than about
    // select — which has its own case below.
    const tunnel = resolveControllerCallouts({
      handedness, appState: TUNNEL, captureEnabled: true, genaiEnabled: true, panelOpen: true
    });
    const sphere = resolveControllerCallouts({
      handedness, appState: SPHERE, captureEnabled: true, genaiEnabled: true, panelOpen: true
    });
    assert.equal(tunnel.length, 4, `${handedness} in the tunnel`);
    assert.equal(sphere.length, 5, `${handedness} in the sphere`);
    // The grip is the whole difference — everything else works in both states.
    const added = sphere.filter((s) => !tunnel.some((t) => t.id === s.id)).map((s) => s.id);
    assert.deepEqual(added, [`${handedness}-grip`]);
  }
});

// The trigger drives a panel's cells and the sphere's gaze target; in an empty
// tunnel it drives nothing, so its marks are hidden.
test("select is on the glance only where something is selectable", () => {
  const ids = (opts) => resolveControllerCallouts(opts).map((item) => item.id);

  for (const handedness of ["left", "right"]) {
    assert.ok(
      !ids({ handedness, appState: TUNNEL }).includes(`${handedness}-trigger`),
      "an empty tunnel has nothing to select"
    );
    assert.ok(
      ids({ handedness, appState: TUNNEL, panelOpen: true }).includes(`${handedness}-trigger`),
      "a panel's cells are selectable, tunnel or not"
    );
    assert.ok(
      ids({ handedness, appState: SPHERE }).includes(`${handedness}-trigger`),
      "the sphere's gaze target is selectable with no panel at all"
    );
  }

});

test("opening a panel changes the redraw key", () => {
  const base = { handedness: "right", appState: TUNNEL };
  assert.notEqual(controllerCalloutKey(base), controllerCalloutKey({ ...base, panelOpen: true }));
});

// Only A, B, X and Y carry a moulded letter, and their marks are nudged in off
// the cap so it stays readable under them.
test("the lettered buttons are the only ones flagged for an inset", () => {
  const lettered = resolveControllerCallouts({
    handedness: "left", appState: SPHERE, captureEnabled: true, genaiEnabled: true
  }).filter((item) => item.lettered).map((item) => item.id);
  assert.deepEqual(lettered.sort(), ["left-x", "left-y"]);

  const right = resolveControllerCallouts({
    handedness: "right", appState: SPHERE, genaiEnabled: true
  }).filter((item) => item.lettered).map((item) => item.id);
  assert.deepEqual(right.sort(), ["right-a", "right-b"]);
});

// In the sphere the trigger does something more specific than "select".
test("the trigger says what it does once you are in the sphere", () => {
  for (const handedness of ["left", "right"]) {
    const sphere = byId(resolveControllerCallouts({ handedness, appState: SPHERE }));
    assert.equal(sphere.get(`${handedness}-trigger`).labelKey, "callout.navigate");
    const tunnel = byId(resolveControllerCallouts({ handedness, appState: TUNNEL, panelOpen: true }));
    assert.equal(tunnel.get(`${handedness}-trigger`).labelKey, "callout.select");
  }
});
