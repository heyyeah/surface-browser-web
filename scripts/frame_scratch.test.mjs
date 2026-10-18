// Per-frame allocation changes that are pure enough to test offline.
//
// Both stop allocating in the render path, and both carry the same risk: a shared
// scratch buffer that outlives the call, or a cached value that goes stale. That
// is what is locked down here. (The world-panel redraw gate lives inside
// vrpanel.js, which imports scene.js and therefore a WebGLRenderer, so it is not
// reachable from a Node test.)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildTunnel, sampleAlongPath } from "../src/tunnel-geometry.js";
import { resolveWristSummonTier, withinCone } from "../src/wrist-summon.js";

// A small tunnel: enough rings to interpolate between, cheap to build.
const { samples } = buildTunnel({ rings: 40, pathRings: 48, segments: 8 });

function freshOut() {
  return {
    pos: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    up: new THREE.Vector3(),
    right: new THREE.Vector3()
  };
}

// --- sampleAlongPath's `out` parameter --------------------------------------

test("sampleAlongPath with `out` returns exactly the values it returns without one", () => {
  const out = freshOut();
  for (const progress of [0, 0.5, 1, 3.25, 12.75, 41.9]) {
    const allocated = sampleAlongPath(samples, progress);
    const written = sampleAlongPath(samples, progress, out);
    assert.ok(written === out, "it returns the caller's object, not a new one");
    for (const key of ["pos", "forward", "up", "right"]) {
      assert.ok(
        written[key].distanceTo(allocated[key]) < 1e-12,
        `${key} diverged at progress ${progress}`
      );
    }
  }
});

test("`out` is optional, and omitting it still allocates fresh vectors", () => {
  // getRingVectors() republishes sampleAlongPath's vectors as its own return
  // value, so the no-`out` path MUST keep handing out objects nobody else can
  // overwrite. This is the aliasing bug the optional parameter exists to avoid.
  const a = sampleAlongPath(samples, 4);
  const b = sampleAlongPath(samples, 9);
  assert.ok(a.pos !== b.pos && a.forward !== b.forward);
  const aPos = a.pos.clone();
  sampleAlongPath(samples, 21);
  assert.deepEqual(a.pos.toArray(), aPos.toArray(), "an unrelated call must not disturb it");
});

test("sampleAlongPath never mutates the path samples it reads from", () => {
  // .lerp() and .normalize() are in-place operations, so a copy() that went the
  // wrong way would corrupt the tunnel geometry permanently rather than draw
  // one bad frame.
  const before = samples.centers.slice(0, 6).map((v) => v.toArray());
  const forwardsBefore = samples.forwards.slice(0, 6).map((v) => v.toArray());
  const out = freshOut();
  for (let i = 0; i < 12; i += 1) {
    sampleAlongPath(samples, i * 0.37, out);
  }
  assert.deepEqual(samples.centers.slice(0, 6).map((v) => v.toArray()), before);
  assert.deepEqual(samples.forwards.slice(0, 6).map((v) => v.toArray()), forwardsBefore);
});

test("reusing one `out` across calls yields the same answer as a fresh one each time", () => {
  const shared = freshOut();
  for (const progress of [2.1, 7.6, 19.4, 2.1]) {
    const fresh = freshOut();
    sampleAlongPath(samples, progress, shared);
    sampleAlongPath(samples, progress, fresh);
    for (const key of ["pos", "forward", "up", "right"]) {
      assert.ok(shared[key].distanceTo(fresh[key]) < 1e-12, `${key} carried state at ${progress}`);
    }
  }
});

test("the direction vectors come back normalized, `out` or not", () => {
  const out = sampleAlongPath(samples, 5.5, freshOut());
  for (const key of ["forward", "up", "right"]) {
    assert.ok(Math.abs(out[key].length() - 1) < 1e-6, `${key} is not unit length`);
  }
});

// --- resolveWristSummonTier's hoisted cosines -------------------------------

const ANGLES = { viewMaxAngleDeg: 50, focusMaxAngleDeg: 15 };
const cosAt = (deg) => Math.cos((deg * Math.PI) / 180);

test("the hoisted cosines agree with withinCone(), bit for bit", () => {
  for (let deg = 0; deg <= 90; deg += 0.5) {
    const tier = resolveWristSummonTier(cosAt(deg), ANGLES);
    assert.equal(tier.inView, withinCone(cosAt(deg), ANGLES.viewMaxAngleDeg), `inView at ${deg}`);
    assert.equal(tier.focused, withinCone(cosAt(deg), ANGLES.focusMaxAngleDeg), `focused at ${deg}`);
  }
});

test("the cosine cache does not go stale when the angles change", () => {
  // The cache is keyed on the DEGREE VALUE, not on the angles object's
  // identity, so a caller that widens a cone in place still gets the new cone.
  // A stale cache here would silently change the summon behaviour on device,
  // which is a far worse outcome than two Math.cos calls.
  const wide = { viewMaxAngleDeg: 80, focusMaxAngleDeg: 70 };
  const narrow = { viewMaxAngleDeg: 20, focusMaxAngleDeg: 5 };
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(
      resolveWristSummonTier(cosAt(60), wide),
      { inView: true, focused: true },
      "60 deg is inside an 80/70 pair"
    );
    assert.deepEqual(
      resolveWristSummonTier(cosAt(60), narrow),
      { inView: false, focused: false },
      "60 deg is outside a 20/5 pair"
    );
  }

  // And in place, on one mutated object.
  const mutable = { viewMaxAngleDeg: 50, focusMaxAngleDeg: 15 };
  assert.equal(resolveWristSummonTier(cosAt(40), mutable).inView, true);
  mutable.viewMaxAngleDeg = 30;
  assert.equal(resolveWristSummonTier(cosAt(40), mutable).inView, false, "the cache did not update");
});

test("the documented boundary still holds: exactly on the edge counts as inside", () => {
  assert.equal(resolveWristSummonTier(cosAt(50), ANGLES).inView, true);
  assert.equal(resolveWristSummonTier(cosAt(50.001), ANGLES).inView, false);
  assert.equal(resolveWristSummonTier(cosAt(15), ANGLES).focused, true);
  assert.equal(resolveWristSummonTier(cosAt(15.001), ANGLES).focused, false);
});
