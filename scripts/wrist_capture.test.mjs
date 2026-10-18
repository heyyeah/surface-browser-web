// Screen capture from the right wrist panel, offline.
//
// Two pieces of pure logic:
//
//   * the SYSTEM ROW SET and the outcome each poked row resolves to
//     (wrist-poke.js). The row index IS the poke target index and the exit hold
//     keys off it, so a reorder or a renamed id is a real bug; the outcome string
//     is what reaches the `wristpoke` diagnostic.
//   * the CAPTURE HIDE/RESTORE contract (capture-hide.js). The capture hides the
//     hands and every UI surface for a single offscreen render, and if that
//     render throws, a user in a headset with invisible hands and no menus has no
//     way out. The restore is therefore asserted against a THROWING render, not
//     just the happy path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveWristPokeOutcome,
  WRIST_SYSTEM_ROW_IDS,
  WRIST_SYSTEM_HOLD_ROW_ID
} from "../src/wrist-poke.js";
import {
  registerCaptureHideables,
  collectCaptureHideables,
  hideForCapture
} from "../src/capture-hide.js";

// A stand-in for anything three parents to the scene. hideForCapture() only
// ever reads and writes `.visible`, which is the whole reason it is testable
// here without a WebGL context.
function obj(visible = true) {
  return { visible };
}

// --- the system row set -----------------------------------------------------

test("the right wrist is Help, Capture, Exit VR — in that order", () => {
  // The order is load-bearing twice over: it is the poke target index, and it is
  // the reading order the help panel describes.
  assert.deepEqual(WRIST_SYSTEM_ROW_IDS, ["help", "capture", "exit"]);
});

test("Settings is gone from the wrist", () => {
  // Its only action (the info/status-footer toggle) lives on the world panel's
  // "Show info" cell, which is the sole route.
  assert.ok(!WRIST_SYSTEM_ROW_IDS.includes("settings"));
});

test("Exit VR is the only hold row, and Capture is not one", () => {
  assert.equal(WRIST_SYSTEM_HOLD_ROW_ID, "exit");
  assert.notEqual(WRIST_SYSTEM_HOLD_ROW_ID, "capture");
  // The exit hold's holdIndex is derived from this, so it must resolve.
  assert.equal(WRIST_SYSTEM_ROW_IDS.indexOf(WRIST_SYSTEM_HOLD_ROW_ID), 2);
});

// --- poke outcomes ----------------------------------------------------------

const SYSTEM = { role: "system" };

test("poking Capture resolves to the capture branch", () => {
  // Named "capture" on purpose: this is the string the wristpoke diagnostic
  // carries, so its absence in a device log separates "the poke never
  // registered" from "the capture ran and produced no file".
  assert.equal(
    resolveWristPokeOutcome({ id: "capture", enabled: true }, SYSTEM),
    "capture"
  );
});

test("Capture is a single poke — it never resolves to the hold row", () => {
  const outcome = resolveWristPokeOutcome({ id: "capture", enabled: true }, SYSTEM);
  assert.notEqual(outcome, "hold-row");
});

test("Exit VR still refuses a single poke", () => {
  // updateSystemHold() owns it; the poke edge must resolve to nothing.
  assert.equal(
    resolveWristPokeOutcome({ id: "exit", enabled: true, hold: true }, SYSTEM),
    "hold-row"
  );
});

test("Help still shows help", () => {
  assert.equal(
    resolveWristPokeOutcome({ id: "help", enabled: true }, SYSTEM),
    "help"
  );
});

test("a row with no branch is reported rather than silently ignored", () => {
  assert.equal(
    resolveWristPokeOutcome({ id: "settings", enabled: true }, SYSTEM),
    "unhandled"
  );
});

test("a missing or gated-off row is named, not collapsed", () => {
  assert.equal(resolveWristPokeOutcome(undefined, SYSTEM), "no-item");
  assert.equal(
    resolveWristPokeOutcome({ id: "capture", enabled: false }, SYSTEM),
    "disabled"
  );
});

test("content rows keep the promote/switch decision they had", () => {
  const item = { id: "genai", enabled: true };
  assert.equal(
    resolveWristPokeOutcome(item, { role: "content", mainPanelOpen: false }),
    "promote"
  );
  assert.equal(
    resolveWristPokeOutcome(item, { role: "content", mainPanelOpen: true }),
    "switch"
  );
});

test("a disabled content row never promotes", () => {
  // The GenAI server gate: greyed, and poking it must not open the panel.
  assert.equal(
    resolveWristPokeOutcome(
      { id: "genai", enabled: false },
      { role: "content", mainPanelOpen: false }
    ),
    "disabled"
  );
});

// --- hide / restore ---------------------------------------------------------

test("everything given is hidden for the capture", () => {
  const hand = obj(true);
  const quad = obj(true);
  const restore = hideForCapture([hand, quad]);
  assert.equal(hand.visible, false);
  assert.equal(quad.visible, false);
  restore();
});

test("restore puts back each object's PREVIOUS value, not `true`", () => {
  // Most of these surfaces are hidden most of the time — the world panel, the
  // ray dot, the exit ring. Forcing them visible would be a worse bug than the
  // one the restore guards against.
  const visibleHand = obj(true);
  const hiddenPanel = obj(false);
  const restore = hideForCapture([visibleHand, hiddenPanel]);
  restore();
  assert.equal(visibleHand.visible, true);
  assert.equal(hiddenPanel.visible, false);
});

test("EVERYTHING is restored even when the render throws", () => {
  // A failed capture must never leave a user wearing a headset with no hands and
  // no UI. This is the shape screenshot.js uses: hide, render inside a try,
  // restore in a finally.
  const objects = [obj(true), obj(false), obj(true)];
  const before = objects.map((object) => object.visible);
  let restore = () => {};

  assert.throws(() => {
    try {
      restore = hideForCapture(objects);
      throw new Error("readRenderTargetPixels blew up");
    } finally {
      restore();
    }
  }, /blew up/);

  assert.deepEqual(objects.map((object) => object.visible), before);
});

test("restoring twice cannot re-apply a stale value", () => {
  // The finally may run alongside a belt-and-braces caller; the second call has
  // to be a no-op rather than stamping an old value over a newer one.
  const panel = obj(false);
  const restore = hideForCapture([panel]);
  restore();
  panel.visible = true; // the app legitimately opened it after the capture
  restore();
  assert.equal(panel.visible, true);
});

test("nulls and gaps are skipped — lazily-built UI does not exist yet", () => {
  // A controller-only session never builds the wrist quads or their cursors; a
  // hands-only session never builds the ray visuals. Providers report those as
  // null rather than filtering, so this is the normal case, not an edge one.
  const real = obj(true);
  const restore = hideForCapture([null, real, undefined, null]);
  assert.equal(real.visible, false);
  restore();
  assert.equal(real.visible, true);
});

test("an empty or missing hide list is harmless", () => {
  assert.doesNotThrow(() => hideForCapture([])());
  assert.doesNotThrow(() => hideForCapture(undefined)());
});

// --- the registry -----------------------------------------------------------

test("registered providers are flattened into one list", () => {
  const hand = obj(true);
  const quad = obj(true);
  const unregisterHands = registerCaptureHideables(() => [hand]);
  const unregisterWrist = registerCaptureHideables(() => [quad, null]);
  try {
    const collected = collectCaptureHideables();
    assert.ok(collected.includes(hand));
    assert.ok(collected.includes(quad));
    assert.ok(!collected.includes(null));
  } finally {
    unregisterHands();
    unregisterWrist();
  }
});

test("a provider that throws does not cost the user the screenshot", () => {
  // A capture is worth more than a complete hide list; the throw would
  // otherwise surface as a failed capture.
  const hand = obj(true);
  const unregisterBad = registerCaptureHideables(() => {
    throw new Error("module not ready");
  });
  const unregisterGood = registerCaptureHideables(() => [hand]);
  try {
    const collected = collectCaptureHideables();
    assert.ok(collected.includes(hand));
  } finally {
    unregisterBad();
    unregisterGood();
  }
});

test("unregistering leaves nothing behind", () => {
  const stray = obj(true);
  const unregister = registerCaptureHideables(() => [stray]);
  unregister();
  assert.ok(!collectCaptureHideables().includes(stray));
});
