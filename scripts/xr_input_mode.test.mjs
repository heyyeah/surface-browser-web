// Which input the visitor actually has: the fact the help surfaces switch on.
// Hand tracking is off by default on a Quest 2, and a help panel about pinches
// and palms is wrong for someone holding two controllers. No headset-model
// differentiation is involved: the whole decision is granted features plus what
// is live in frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveXrInputAffordances } from "../src/xr-input-mode.js";

const controller = (handedness) => ({
  handedness,
  profiles: ["meta-quest-touch-plus", "oculus-touch-v3"],
  gripSpace: {},
  targetRaySpace: {}
});
const articulatedHand = (handedness) => ({
  handedness,
  hand: new Map(),
  profiles: ["generic-hand"],
  targetRaySpace: {}
});
// The jointless profile a session gets when hand-tracking was REFUSED but the
// runtime still reports hands (see ui.js).
const fixedHand = (handedness) => ({
  handedness,
  profiles: ["meta-fixed-hand"],
  gripSpace: {},
  targetRaySpace: {}
});

test("no session at all is unknown, and unknown lists everything", () => {
  const a = resolveXrInputAffordances();
  assert.equal(a.known, false);
  assert.equal(a.hands, true);
  assert.equal(a.controllers, true);
});

test("a session with no live sources yet is still unknown", () => {
  // Every frame between entry and the first inputsourceschange. Hiding half the
  // help for those frames would be a worse answer than listing a spare row.
  const a = resolveXrInputAffordances({
    enabledFeatures: ["local-floor", "hand-tracking"],
    inputSources: []
  });
  assert.equal(a.known, false);
  assert.equal(a.hands, true);
  assert.equal(a.controllers, true);
});

test("THE QUEST 2 CASE: hand tracking refused, two controllers live", () => {
  const a = resolveXrInputAffordances({
    enabledFeatures: ["local", "viewer", "local-floor", "layers"],
    inputSources: [controller("left"), controller("right")]
  });
  assert.equal(a.known, true);
  assert.equal(a.controllers, true);
  assert.equal(a.hands, false, "nothing about pinching or palms is true here");
});

test("hands live are hands, granted or not", () => {
  const a = resolveXrInputAffordances({
    enabledFeatures: ["local-floor", "hand-tracking"],
    inputSources: [articulatedHand("left"), articulatedHand("right")]
  });
  assert.equal(a.hands, true);
  assert.equal(a.controllers, false);
});

test("a jointless hand still counts as a hand, not as a controller", () => {
  // It has a gripSpace and no XRHand, which is exactly the shape a controller
  // has; only the profile string separates them.
  const a = resolveXrInputAffordances({
    enabledFeatures: ["local-floor"],
    inputSources: [fixedHand("left"), fixedHand("right")]
  });
  assert.equal(a.hands, true);
  assert.equal(a.controllers, false);
});

// Granted hand tracking does not keep the hand bindings listed while controllers
// are in use: it can be granted whether or not it is used, so that rule would
// only show pinches and palms to someone holding two controllers.
test("holding controllers drops the hand bindings, even with hand tracking granted", () => {
  const a = resolveXrInputAffordances({
    enabledFeatures: ["local-floor", "hand-tracking"],
    inputSources: [controller("left"), controller("right")]
  });
  assert.equal(a.known, true);
  assert.equal(a.hands, false, "what is in your hands wins over what the headset could do");
  assert.equal(a.controllers, true);
  assert.equal(a.handsLive, false);
  assert.equal(a.handTrackingGranted, true, "the grant is still reported, just not decisive");
});

// Put the controllers down and the hand bindings come straight back, with no
// session restart.
test("putting the controllers down brings the hand bindings back", () => {
  const a = resolveXrInputAffordances({
    enabledFeatures: ["local-floor", "hand-tracking"],
    inputSources: []
  });
  assert.equal(a.hands, true);
  // Nothing live at all is "unknown", which lists everything — the safe answer.
  assert.equal(a.known, false);

  const b = resolveXrInputAffordances({
    enabledFeatures: ["local-floor", "hand-tracking"],
    inputSources: [articulatedHand("left")]
  });
  assert.equal(b.known, true);
  assert.equal(b.hands, true);
  assert.equal(b.controllers, false);
});

test("multimodal — a hand and a controller at once — reports both", () => {
  const a = resolveXrInputAffordances({
    enabledFeatures: ["local-floor", "hand-tracking"],
    inputSources: [articulatedHand("left"), controller("right")]
  });
  assert.equal(a.hands, true);
  assert.equal(a.controllers, true);
});

test("a source with no pose is not a controller", () => {
  // "gaze" / transient screen input carries neither space; it must not make the
  // help claim there is a Touch controller in the room.
  const a = resolveXrInputAffordances({
    enabledFeatures: [],
    inputSources: [{ handedness: "none", profiles: [] }]
  });
  assert.equal(a.known, false);
});

test("enabledFeatures being unreported is not the same as refused", () => {
  // A runtime may omit the list entirely; with controllers live the answer is
  // still "controllers", never a crash.
  const a = resolveXrInputAffordances({ inputSources: [controller("right")] });
  assert.equal(a.known, true);
  assert.equal(a.controllers, true);
  assert.equal(a.hands, false);
});
