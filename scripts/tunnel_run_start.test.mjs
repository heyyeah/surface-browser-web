// Where a new run starts on the tunnel path.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  tunnelRunStartRing,
  TUNNEL_RUN_START_RING,
  TUNNEL_RUN_RUNWAY_RINGS,
  easeTunnelSpeed,
  TUNNEL_SPEED_EASE_EPSILON
} from "../src/tunnel-run.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// A 2200-ring tunnel, minus the wrap safety margin.
const MAX = 2200 - (60 + 25 + 60);

test("a run continues from where the camera already is", () => {
  // The reset must not be ring 5 unconditionally: it lands on the same frame the
  // request goes out, so the tunnel would jump backwards and change shape exactly
  // as the status footer appears.
  assert.equal(tunnelRunStartRing({ currentRing: 480, maxCameraRing: MAX }), 480);
  assert.equal(tunnelRunStartRing({ currentRing: 1200, maxCameraRing: MAX }), 1200);
});

test("...unless there is not enough path left for a whole cycle", () => {
  // A run needs the lead-in, the panels and the exit flight ahead of it.
  const tooLate = MAX - TUNNEL_RUN_RUNWAY_RINGS + 1;
  assert.equal(tunnelRunStartRing({ currentRing: tooLate, maxCameraRing: MAX }), TUNNEL_RUN_START_RING);
  const justFits = MAX - TUNNEL_RUN_RUNWAY_RINGS;
  assert.equal(tunnelRunStartRing({ currentRing: justFits, maxCameraRing: MAX }), justFits);
});

test("the first run, and any nonsense, starts at the beginning", () => {
  assert.equal(tunnelRunStartRing({ currentRing: 5, maxCameraRing: MAX }), TUNNEL_RUN_START_RING);
  assert.equal(tunnelRunStartRing({ currentRing: 0, maxCameraRing: MAX }), TUNNEL_RUN_START_RING);
  for (const bad of [undefined, null, NaN, "x", Infinity, -1]) {
    assert.equal(tunnelRunStartRing({ currentRing: bad, maxCameraRing: MAX }), TUNNEL_RUN_START_RING);
    assert.equal(tunnelRunStartRing({ currentRing: 400, maxCameraRing: bad }), TUNNEL_RUN_START_RING);
  }
  assert.equal(tunnelRunStartRing(), TUNNEL_RUN_START_RING);
});

test("the runway covers what a cycle actually consumes", () => {
  // Lead-in and exit come from constants.js; the rest is room for the panels
  // that spawn between them. If a cycle ever needs more, it runs off the path.
  assert.ok(TUNNEL_RUN_RUNWAY_RINGS >= 60 + 25, "at least the lead-in and the exit");
});

test("the cycle reset uses it instead of hard-coding ring 5", () => {
  const transitions = read("src/transitions.js");
  const fn = transitions.slice(transitions.indexOf("function prepareForTunnelRun"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /state\.currentRingFloat = nextTunnelRunStartRing\(\)/);
  assert.doesNotMatch(body, /currentRingFloat = 5/);
});

test("the wrap and the run start agree on where the path ends", () => {
  // Two different ideas of the last usable ring would put a run in a stretch
  // the wrap is about to yank it out of.
  const tunnel = read("src/tunnel.js");
  assert.match(tunnel, /function maxCameraRing\(\)/);
  const wrap = tunnel.slice(tunnel.indexOf("if (state.appState === AppState.TUNNEL)"));
  assert.match(wrap.slice(0, 600), /const maxRing = maxCameraRing\(\)/);
  const next = tunnel.slice(tunnel.indexOf("function nextTunnelRunStartRing"));
  assert.match(next.slice(0, 300), /maxCameraRing: maxCameraRing\(\)/);
});

// --- the speed the exit borrows -------------------------------------------

test("the exit's speed is given back over time, not in one frame", () => {
  // Without easing, the speed steps abruptly (22 -> 13) between two frames on the
  // frame the request goes out.
  let speed = 22;
  const frames = [];
  for (let i = 0; i < 200; i += 1) {
    const eased = easeTunnelSpeed(speed, 13, 1 / 60);
    speed = eased.speed;
    frames.push(speed);
    if (eased.done) break;
  }
  assert.ok(frames[0] < 22 && frames[0] > 21, `first frame moved too far: ${frames[0]}`);
  assert.equal(frames.at(-1), 13, "it must actually land on the target");
  // Long enough not to read as a snap, short enough that the run is at its
  // own speed almost immediately: about 1.4 s at 60 Hz.
  assert.ok(frames.length > 30 && frames.length < 110, `took ${frames.length} frames`);
  // Monotonic: a speed that overshoots and comes back would read as a lurch.
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(frames[i] <= frames[i - 1] + 1e-9, `not monotonic at ${i}`);
  }
});

test("the ease is frame-rate independent", () => {
  // A headset at 90 Hz and a laptop at 60 Hz must decelerate over the same
  // wall-clock time, or the piece feels different on each.
  const run = (hz) => {
    let speed = 22;
    let seconds = 0;
    for (let i = 0; i < hz * 10; i += 1) {
      const eased = easeTunnelSpeed(speed, 13, 1 / hz);
      speed = eased.speed;
      seconds += 1 / hz;
      if (eased.done) break;
    }
    return seconds;
  };
  assert.ok(Math.abs(run(60) - run(90)) < 0.05, `${run(60)}s vs ${run(90)}s`);
});

test("nonsense hands back the target rather than a stuck speed", () => {
  for (const bad of [undefined, null, NaN, "x", Infinity, 0, -1]) {
    const eased = easeTunnelSpeed(22, 13, bad);
    assert.equal(eased.speed, 13, `dt=${String(bad)}`);
    assert.equal(eased.done, true);
  }
  assert.equal(easeTunnelSpeed("x", 13, 1 / 60).speed, 13);
});

test("only a run that is actually faster eases", () => {
  // Arriving at or below the default must not start an ease that then has to be
  // detected as already-done; the reset stays a plain assignment.
  const transitions = read("src/transitions.js");
  const fn = transitions.slice(transitions.indexOf("function prepareForTunnelRun"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /state\.tunnelSpeedEasing = state\.cameraSpeed > DEFAULT_CAMERA_SPEED \+ TUNNEL_SPEED_EASE_EPSILON/);
  assert.match(body, /if \(!state\.tunnelSpeedEasing\) \{\s*state\.cameraSpeed = DEFAULT_CAMERA_SPEED;/);
  assert.ok(TUNNEL_SPEED_EASE_EPSILON > 0);
});

test("the speed control still wins once the ease has landed", () => {
  // The input is the authority in flat mode; the ease is a brief exception, not
  // a new owner of the value.
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function applyTunnelSpeed"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /if \(!state\.tunnelSpeedEasing\)[\s\S]*state\.cameraSpeed = target;/);
  assert.match(body, /state\.tunnelSpeedEasing = !eased\.done/);
  // ...and the exit's own ramp is left alone.
  assert.match(body, /if \(state\.appState === AppState\.EXITING_SPHERE\) \{\s*return;/);
});
