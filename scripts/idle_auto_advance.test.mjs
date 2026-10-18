// Cost control: the dwell auto-advance must stop when nobody is there.
// The property that matters is on the EDGES — one status message per
// suspension, and a resume that cannot fire an overdue paid advance.

import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS,
  AUTO_ADVANCE_FREE_IDLE_TIMEOUT_DEFAULT_MS,
  normalizeIdleTimeoutMs,
  stepAutoAdvanceIdle
} from "../src/idle-auto-advance.js";

const T = 300_000;

test("does not suspend while input is recent", () => {
  const r = stepAutoAdvanceIdle({ nowMs: 10_000, lastInputMs: 9_000, timeoutMs: T });
  assert.equal(r.suspended, false);
  assert.equal(r.justSuspended, false);
  assert.equal(r.idleMs, 1_000);
});

test("suspends exactly at the timeout, not one frame late", () => {
  const justUnder = stepAutoAdvanceIdle({ nowMs: T - 1, lastInputMs: 0, timeoutMs: T });
  assert.equal(justUnder.suspended, false);
  const atIt = stepAutoAdvanceIdle({ nowMs: T, lastInputMs: 0, timeoutMs: T });
  assert.equal(atIt.suspended, true);
  assert.equal(atIt.justSuspended, true);
});

test("justSuspended fires ONCE, not every frame after", () => {
  let suspended = false;
  let announcements = 0;
  // 60 frames of continued silence well past the timeout.
  for (let frame = 0; frame < 60; frame += 1) {
    const r = stepAutoAdvanceIdle({
      nowMs: T + frame * 16,
      lastInputMs: 0,
      timeoutMs: T,
      suspended
    });
    suspended = r.suspended;
    if (r.justSuspended) {
      announcements += 1;
    }
  }
  assert.equal(announcements, 1);
  assert.equal(suspended, true);
});

test("any input resumes it, and reports the resume edge once", () => {
  let suspended = stepAutoAdvanceIdle({ nowMs: T, lastInputMs: 0, timeoutMs: T }).suspended;
  assert.equal(suspended, true);

  // The visitor comes back at T + 5000 and touches something.
  const resumed = stepAutoAdvanceIdle({
    nowMs: T + 5_000,
    lastInputMs: T + 5_000,
    timeoutMs: T,
    suspended
  });
  assert.equal(resumed.suspended, false);
  assert.equal(resumed.justResumed, true);
  suspended = resumed.suspended;

  const nextFrame = stepAutoAdvanceIdle({
    nowMs: T + 5_016,
    lastInputMs: T + 5_000,
    timeoutMs: T,
    suspended
  });
  assert.equal(nextFrame.justResumed, false);
});

test("timeout 0 means never suspend (attended kiosk / ?auto=)", () => {
  const r = stepAutoAdvanceIdle({ nowMs: 86_400_000, lastInputMs: 0, timeoutMs: 0 });
  assert.equal(r.suspended, false);
  assert.equal(r.justSuspended, false);
});

test("turning the timeout off releases an already-suspended sphere", () => {
  const r = stepAutoAdvanceIdle({ nowMs: 86_400_000, lastInputMs: 0, timeoutMs: 0, suspended: true });
  assert.equal(r.suspended, false);
  assert.equal(r.justResumed, true);
});

test("a lastInput in the future reads as no idle, never as a huge one", () => {
  const r = stepAutoAdvanceIdle({ nowMs: 1_000, lastInputMs: 5_000, timeoutMs: T });
  assert.equal(r.idleMs, 0);
  assert.equal(r.suspended, false);
});

test("an unusable clock fails towards keeping the piece running", () => {
  for (const bad of [NaN, undefined, null, "nope"]) {
    assert.equal(stepAutoAdvanceIdle({ nowMs: bad, lastInputMs: 0, timeoutMs: T }).suspended, false);
    assert.equal(stepAutoAdvanceIdle({ nowMs: 10_000, lastInputMs: bad, timeoutMs: T }).suspended, false);
  }
});

test("normalizeIdleTimeoutMs keeps 0 (explicitly off) but rejects nonsense", () => {
  assert.equal(normalizeIdleTimeoutMs(0), 0);
  assert.equal(normalizeIdleTimeoutMs(60_000), 60_000);
  assert.equal(normalizeIdleTimeoutMs("60000"), 60_000);
  assert.equal(normalizeIdleTimeoutMs(1234.9), 1234);
  for (const bad of [undefined, null, "", -1, NaN, "abc", {}]) {
    assert.equal(normalizeIdleTimeoutMs(bad), AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS);
  }
});

test("the shipped default is on, and long enough to watch several dwell cycles", () => {
  assert.ok(AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS > 0);
  // SPHERE_DWELL_SECONDS is 20; a viewer must get several uninterrupted hops.
  assert.ok(AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS >= 5 * 20_000);
});

// MONEY SAFETY. A GenAI sphere auto-advances into another PAID batch, so an
// abandoned tab must reach a bounded number of them and then stop for good.
test("MONEY SAFETY: an abandoned tab stops generating and stays stopped", () => {
  const DWELL_MS = 20_000;
  let suspended = false;
  let paidBatches = 0;
  let dwellMs = 0;
  const lastInputMs = 0;

  // Eight hours of a forgotten tab, stepped at the dwell granularity.
  for (let nowMs = 0; nowMs <= 8 * 60 * 60 * 1000; nowMs += 1_000) {
    const r = stepAutoAdvanceIdle({ nowMs, lastInputMs, timeoutMs: T, suspended });
    suspended = r.suspended;
    if (suspended) {
      continue;
    }
    dwellMs += 1_000;
    if (dwellMs >= DWELL_MS) {
      dwellMs = 0;
      paidBatches += 1;
    }
  }

  // 5 min of grace / 20 s per hop = 15 hops, then silence for the other 7h55m.
  assert.equal(paidBatches, 15);
  assert.equal(suspended, true);
});

test("MONEY SAFETY: with the guard disabled the same tab never stops", () => {
  // The inverse of the test above: proves the assertion there is measuring the
  // guard and not the loop's own arithmetic.
  const DWELL_MS = 20_000;
  let paidBatches = 0;
  let dwellMs = 0;
  for (let nowMs = 0; nowMs <= 8 * 60 * 60 * 1000; nowMs += 1_000) {
    if (stepAutoAdvanceIdle({ nowMs, lastInputMs: 0, timeoutMs: 0 }).suspended) {
      continue;
    }
    dwellMs += 1_000;
    if (dwellMs >= DWELL_MS) {
      dwellMs = 0;
      paidBatches += 1;
    }
  }
  assert.equal(paidBatches, 1440);
});

// WIRING. The pure tests above prove the decision; these prove it is actually
// consulted.
import fs from "node:fs";
import { translate } from "../src/i18n.js";

const transitionsJs = fs.readFileSync(new URL("../src/transitions.js", import.meta.url), "utf8");
const inputJs = fs.readFileSync(new URL("../src/input.js", import.meta.url), "utf8");
const sphereJs = fs.readFileSync(new URL("../src/sphere.js", import.meta.url), "utf8");
const mainJs = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("the dwell clock freezes while suspended AND the paid branch re-checks", () => {
  assert.match(transitionsJs, /if \(!state\.sphereInteractionHold && !state\.sphereDwellHeldByOnboarding && !idle\.suspended\) \{/);
  assert.match(transitionsJs, /state\.sphereDwellSeconds >= SPHERE_DWELL_SECONDS && !idle\.suspended/);
});

test("gaze selection is NOT counted as a person", () => {
  // The idle sphere drifts, so the gaze-nearest panel changes on its own. If
  // sphere.js's own markSphereInteraction() stamped the idle clock, an
  // abandoned tab would look permanently occupied and the guard would never
  // fire — the exact failure this module exists to prevent.
  assert.doesNotMatch(sphereJs, /markUserInput/);
  assert.match(sphereJs, /function markSphereInteraction\(\)/);
});

test("the input pump stamps the idle clock for every interaction it reports", () => {
  // One wrapper, not twenty call sites: adding a 21st interaction must not
  // require remembering this exists.
  assert.match(inputJs, /markSphereInteraction as markSphereInteractionOnly/);
  assert.match(
    inputJs,
    /function markSphereInteraction\(\) \{\s*markUserInput\(\);\s*markSphereInteractionOnly\(\);\s*\}/
  );
});

test("the DOM half covers pointer, key and touch, passively", () => {
  assert.match(mainJs, /"pointerdown", "pointermove", "keydown", "touchstart", "wheel"/);
  assert.match(mainJs, /addEventListener\(inputEventType, markUserInput, \{ passive: true, capture: true \}\)/);
});

test("the server's timeout is read, and a health failure keeps the safe default", () => {
  assert.match(mainJs, /state\.autoAdvanceIdleTimeoutMs = normalizeIdleTimeoutMs\(capabilities\.autoAdvance\?\.idleTimeoutMs\)/);
  // The catch branch must NOT reset it to 0 — an unreachable server is not a
  // licence to let an idle tab keep generating.
  const fn = mainJs.slice(mainJs.indexOf("async function configureApiCapabilities()"));
  const catchBranch = fn.slice(fn.indexOf("  } catch {"), fn.indexOf("\n}\n"));
  assert.doesNotMatch(catchBranch, /autoAdvanceIdleTimeoutMs\s*=/);
});

// --- what it is allowed to pause ------------------------------------------

test("only a hop that would SPEND is ever suspended", () => {
  // The guard exists because a GenAI sphere's dwell exit buys another paid batch;
  // on a web or search sphere the same advance is free, and stopping it takes away
  // the one thing the piece does unattended.
  assert.match(transitionsJs, /const paidHop = getSphereNavigationRequest\(\)\?\.mode === "genai"/);
  // A free hop is not exempt, only patient: an hour instead of five minutes.
  assert.match(transitionsJs, /timeoutMs: paidHop\s*\?\s*state\.autoAdvanceIdleTimeoutMs\s*:\s*state\.autoAdvanceFreeIdleTimeoutMs/);
  assert.ok(AUTO_ADVANCE_FREE_IDLE_TIMEOUT_DEFAULT_MS > AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS * 5,
    "the free leash must be much longer, or it is the same guard twice");
});

test("a disabled timeout still reports the resume edge", () => {
  // That is what lets a free hop clear a suspension left over from a paid one,
  // rather than stranding the sphere with a stale status line.
  const resumed = stepAutoAdvanceIdle({ nowMs: 1000, lastInputMs: 0, timeoutMs: 0, suspended: true });
  assert.equal(resumed.suspended, false);
  assert.equal(resumed.justResumed, true);
});

test("the pause names what actually paused", () => {
  // A pause warning must not read "GenAI failed: Paused — no activity" on a plain
  // web page: the footer must not route every warning through the provider-failure
  // formatter.
  const ui = fs.readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
  assert.match(transitionsJs, /setStatus\(t\(paidHop \? "status\.pausedGenerating" : "status\.paused"\)/);
  assert.match(translate("status.pausedGenerating"), /^Generating paused/);
  assert.match(translate("status.paused"), /^Paused — no activity/, "a free pause must not claim to be generating");
  const notice = ui.slice(ui.indexOf("if (footerNotice) {"));
  assert.match(notice.slice(0, 200), /trimForFooter\(footerNotice/);
  assert.doesNotMatch(notice.slice(0, 200), /tunnelErrorText/, "not the GenAI formatter");
});
