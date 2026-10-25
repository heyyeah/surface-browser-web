// Pure tests for server/genai-pool.js, the content-addressed pool that replaces
// a cache keyed on a value that is fresh every time.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPoolKey,
  planPoolDraw,
  drawPoolIndexes,
  planPoolFallback,
  poolSourceAddress,
  POOL_KEY_VERSION
} from "../server/genai-pool.js";
import { loadPoolPack, poolMemberCount, readPoolMember } from "../server/genai-pool-pack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const poolSource = fs.readFileSync(path.join(here, "../server/genai-pool.js"), "utf8");
// Block comments first: several assertions below are about what the code does,
// and a comment quoting the same words would answer for it.
const bakerSource = fs
  .readFileSync(path.join(here, "prebake_pool.mjs"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
// Line comments only. The server has no block comments, and stripping them
// anyway would swallow most of index.js: an Accept header in it contains
// "image/*,*/*", which the naive pattern reads as a comment that never ends.
const readServerSource = (file) => fs
  .readFileSync(path.join(here, "../server", file), "utf8")
  .replace(/^\s*\/\/.*$/gm, "");
const plannerSource = readServerSource("genai-pool-runtime.js");
const generatorSource = readServerSource("genai-jobs.js");

// --- the key -------------------------------------------------------------

test("THE BUG: the seed cannot influence the key", () => {
  // This is the entire point of the module. buildSeededGenAiCacheKey() includes
  // the seed, GENAI_VARY_SEED_MODE=fresh hands out a new one every variation,
  // and the hit rate is therefore exactly zero. If a seed ever reaches this key
  // the cache silently stops working again and nothing else fails.
  const base = { model: "flux-2/klein/4b", prompt: "otters", modifierStack: ["kangaroo"] };
  assert.equal(buildPoolKey({ ...base, seed: 1 }), buildPoolKey({ ...base, seed: 999999 }));
  assert.equal(buildPoolKey({ ...base, seed: 1 }), buildPoolKey(base));
  // And it must not be readable from the key inputs at all.
  const keyBuilder = poolSource.slice(
    poolSource.indexOf("export function buildPoolKey"),
    poolSource.indexOf("function normalizeText")
  );
  assert.doesNotMatch(keyBuilder, /seed/i, "seed must not appear anywhere in the key builder");
});

test("prompts differing only in case or whitespace share a pool", () => {
  assert.equal(buildPoolKey({ prompt: "a cat" }), buildPoolKey({ prompt: "  A   CAT " }));
});

test("emoji order does not fork the pool", () => {
  // Otter-then-kangaroo and kangaroo-then-otter are the same request. Without
  // the sort they would build two pools that never see each other's images —
  // halving the hit rate for no reason a visitor could perceive.
  assert.equal(
    buildPoolKey({ prompt: "x", modifierStack: ["otter", "kangaroo"] }),
    buildPoolKey({ prompt: "x", modifierStack: ["kangaroo", "otter"] })
  );
});

test("empty and non-string modifiers are ignored, not stringified", () => {
  assert.equal(
    buildPoolKey({ prompt: "x", modifierStack: ["a", "", null, undefined, 7] }),
    buildPoolKey({ prompt: "x", modifierStack: ["a"] })
  );
});

test("every keyed input actually changes the key", () => {
  const base = {
    model: "flux-2/klein/4b", prompt: "p", negativePrompt: "n", modifierStack: ["m"],
    sourceKey: "s", width: 320, height: 256, steps: 5, strength: 0.95
  };
  const baseline = buildPoolKey(base);
  for (const [field, value] of Object.entries({
    model: "other-model", prompt: "q", negativePrompt: "z", modifierStack: ["mm"],
    sourceKey: "t", width: 321, height: 257, steps: 6, strength: 0.6
  })) {
    assert.notEqual(buildPoolKey({ ...base, [field]: value }), baseline, `${field} must be in the key`);
  }
});

test("field boundaries cannot collide", () => {
  // ("ab","c") and ("a","bc") must not hash to one pool.
  assert.notEqual(
    buildPoolKey({ model: "ab", prompt: "c" }),
    buildPoolKey({ model: "a", prompt: "bc" })
  );
});

test("a pack baked locally is findable by a server configured for fal", () => {
  // THE reason the key holds the model and not the provider: a pack baked locally
  // with local weights must serve the same model through a hosted provider. Those
  // must be one pool, or the whole pack is invisible in production and every lookup
  // falls through to paid generation.
  const baked  = buildPoolKey({ model: "flux-2/klein/4b", prompt: "otters", modifierStack: ["x"] });
  const served = buildPoolKey({ model: "flux-2/klein/4b", prompt: "otters", modifierStack: ["x"] });
  assert.equal(baked, served);
  // And the key builder must not have grown a provider field again.
  assert.doesNotMatch(poolSource.slice(
    poolSource.indexOf("export function buildPoolKey"),
    poolSource.indexOf("function normalizeText")
  ), /\bprovider\b/, "provider must not be part of the key");
});

test("the key version is in the key, so a rules change retires old entries", () => {
  assert.equal(typeof POOL_KEY_VERSION, "number");
  assert.match(poolSource, /`v\$\{POOL_KEY_VERSION\}`/);
  // Strength is part of the key and variations use per-base pools, so v1 entries
  // no longer mean what they say.
  assert.ok(POOL_KEY_VERSION >= 2, "the key's meaning changed; the version must have moved with it");
});

// --- strength ------------------------------------------------------------

test("strength is absent on Klein and real everywhere else", () => {
  const base = { model: "m", prompt: "p", modifierStack: ["x"] };
  // Klein has no denoising dial — varyImagesViaFal stores null — so a Klein
  // pack must key identically whether the field is passed or omitted.
  assert.equal(buildPoolKey({ ...base, strength: null }), buildPoolKey(base));
  assert.equal(buildPoolKey({ ...base, strength: undefined }), buildPoolKey(base));
  // But absent is not zero: 0 is a real denoising request on the sdapi path.
  assert.notEqual(buildPoolKey({ ...base, strength: 0 }), buildPoolKey(base));
  // A pool baked at 0.95 must not answer a 0.6 request.
  assert.notEqual(buildPoolKey({ ...base, strength: 0.95 }), buildPoolKey({ ...base, strength: 0.6 }));
});

test("strength is rounded the way roundStrength rounds it", () => {
  // getVariationStrengthRamp already emits 3dp values; float drift past that
  // must not split one pool into two.
  assert.equal(
    buildPoolKey({ prompt: "p", strength: 0.95 }),
    buildPoolKey({ prompt: "p", strength: 0.9500001 })
  );
  assert.equal(
    buildPoolKey({ prompt: "p", strength: 0.95 }),
    buildPoolKey({ prompt: "p", strength: "0.95" })
  );
  assert.notEqual(
    buildPoolKey({ prompt: "p", strength: 0.95 }),
    buildPoolKey({ prompt: "p", strength: 0.951 })
  );
});

// --- the source address --------------------------------------------------

test("a base's identity is its bytes, so both sides can derive it alone", () => {
  const bytes = Buffer.from("an image");
  assert.equal(poolSourceAddress(bytes), poolSourceAddress(Buffer.from("an image")));
  assert.notEqual(poolSourceAddress(bytes), poolSourceAddress(Buffer.from("another image")));
  assert.equal(poolSourceAddress(Buffer.alloc(0)), "");
  assert.equal(poolSourceAddress(null), "");
});

test("variations of two different bases are two different pools", () => {
  // Keying a variation on the PROMPT would put every base made from one bookmark
  // into a single pool, so a visitor who picked one image would be shown emoji
  // variations of a different one.
  const vary = (address) => buildPoolKey({
    model: "m", prompt: "otters", modifierStack: ["🦦"], sourceKey: address, width: 640, height: 512
  });
  assert.notEqual(vary(poolSourceAddress(Buffer.from("base one"))), vary(poolSourceAddress(Buffer.from("base two"))));
});

// --- the baker -----------------------------------------------------------

test("the baker keys variations on the base image, not on the prompt", () => {
  assert.match(bakerSource, /sourceKey:\s*base\.address/, "a variation's sourceKey is its base's content address");
  assert.doesNotMatch(bakerSource, /sourceKey:\s*baseKey/, "prompt-lineage keying must not come back");
  assert.match(bakerSource, /poolSourceAddress\(buffer\)/, "the address is hashed from the image's own bytes");
});

test("the baker keys on the sizes, steps and strength the server used", () => {
  // Zero defaults here would bake a pack whose keys no runtime lookup can
  // produce: every lookup misses, silently, and every request is paid for.
  for (const field of ["width: size.width", "height: size.height", "steps", "strength"]) {
    assert.ok(bakerSource.includes(field), `${field} must reach buildPoolKey`);
  }
  assert.match(bakerSource, /item\.width \?\? null/, "the size comes back off the API response");
});

test("the baker stores the bases themselves as pool members", () => {
  // The first image a visitor sees should be able to come from the pool too.
  assert.match(bakerSource, /function baseKeyFor/);
  assert.match(bakerSource, /kind: "base"/);
});

// --- the draw ------------------------------------------------------------

test("a warm pool costs exactly the guaranteed-new quota", () => {
  assert.deepEqual(planPoolDraw({ poolSize: 10, count: 4, newCount: 1 }),
    { reuse: 3, generate: 1, coldStart: false });
});

test("a cold pool fills the batch rather than showing gaps", () => {
  // The sphere lays out the panels it is given. Handing back 1 image because
  // the pool is empty would make an empty-pool start look broken.
  assert.deepEqual(planPoolDraw({ poolSize: 0, count: 4, newCount: 1 }),
    { reuse: 0, generate: 4, coldStart: true });
  assert.deepEqual(planPoolDraw({ poolSize: 2, count: 4, newCount: 1 }),
    { reuse: 2, generate: 2, coldStart: true });
});

test("newCount 0 is fully cached, and newCount >= count is fully new", () => {
  assert.deepEqual(planPoolDraw({ poolSize: 10, count: 4, newCount: 0 }),
    { reuse: 4, generate: 0, coldStart: false });
  assert.deepEqual(planPoolDraw({ poolSize: 10, count: 4, newCount: 9 }),
    { reuse: 0, generate: 4, coldStart: false });
});

test("nonsense counts degrade to doing nothing, not to generating", () => {
  for (const bad of [undefined, null, -1, NaN, "x", Infinity]) {
    assert.deepEqual(planPoolDraw({ poolSize: 10, count: bad, newCount: 1 }),
      { reuse: 0, generate: 0, coldStart: false }, `count=${String(bad)}`);
  }
  // A broken poolSize must not become a broken batch: still fills the count.
  assert.equal(planPoolDraw({ poolSize: NaN, count: 4, newCount: 1 }).generate, 4);
});

// --- drawing members -----------------------------------------------------

test("a draw never repeats an image inside one sphere", () => {
  for (let trial = 0; trial < 200; trial += 1) {
    const picked = drawPoolIndexes({ poolSize: 8, want: 3 });
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3, "duplicate panel in one batch");
    for (const i of picked) {
      assert.ok(i >= 0 && i < 8);
    }
  }
});

test("a draw larger than the pool returns the whole pool, not padding", () => {
  const picked = drawPoolIndexes({ poolSize: 2, want: 5 });
  assert.equal(picked.length, 2);
  assert.equal(new Set(picked).size, 2);
});

test("the draw is injectable, so it can be asserted", () => {
  const picked = drawPoolIndexes({ poolSize: 5, want: 2, random: () => 0 });
  assert.deepEqual(picked, [0, 1]);
});

test("the draw reaches every member", () => {
  // A biased shuffle that never picked the last member would quietly shrink the
  // pool to N-1 and nobody would notice.
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    for (const index of drawPoolIndexes({ poolSize: 6, want: 2 })) {
      seen.add(index);
    }
  }
  assert.equal(seen.size, 6);
});

// --- provider failure ----------------------------------------------------

test("a failed provider falls back to the pool, not to a gap", () => {
  const plan = planPoolDraw({ poolSize: 10, count: 4, newCount: 1 });
  const outcome = planPoolFallback({ plan, delivered: 0, poolSize: 10, alreadyDrawn: 3 });
  assert.equal(outcome.fromPool, 4, "the visitor still gets a full sphere");
  assert.equal(outcome.generated, 0);
  assert.equal(outcome.shortfall, 0);
});

test("a partial delivery is topped up from the pool", () => {
  const plan = planPoolDraw({ poolSize: 10, count: 4, newCount: 2 });
  const outcome = planPoolFallback({ plan, delivered: 1, poolSize: 10, alreadyDrawn: 2 });
  assert.equal(outcome.generated, 1);
  assert.equal(outcome.extraFromPool, 1);
  assert.equal(outcome.fromPool + outcome.generated, 4);
});

test("a cold pool AND a dead provider reports a shortfall rather than lying", () => {
  const plan = planPoolDraw({ poolSize: 0, count: 4, newCount: 1 });
  const outcome = planPoolFallback({ plan, delivered: 0, poolSize: 0, alreadyDrawn: 0 });
  assert.equal(outcome.shortfall, 4);
  assert.equal(outcome.fromPool, 0);
});

// --- money ---------------------------------------------------------------

test("MONEY: a warm pool makes cost flat in visits, not linear", () => {
  const COUNT = 4;
  const RUNS = 1000;
  let withPool = 0;
  let poolSize = 40;
  for (let run = 0; run < RUNS; run += 1) {
    const plan = planPoolDraw({ poolSize, count: COUNT, newCount: 1 });
    withPool += plan.generate;
    poolSize += plan.generate;
  }
  const withoutPool = RUNS * COUNT;
  assert.equal(withoutPool, 4000);
  assert.equal(withPool, 1000, "one guaranteed-new image per run, and no more");
  assert.ok(withPool < withoutPool / 3.9);
});

test("MONEY: the cold start is bounded and pays itself off", () => {
  // An empty pool at launch. Cost must converge to the new-quota, not
  // stay at a full batch forever.
  const COUNT = 4;
  let poolSize = 0;
  let spent = 0;
  const perRun = [];
  for (let run = 0; run < 20; run += 1) {
    const plan = planPoolDraw({ poolSize, count: COUNT, newCount: 1 });
    spent += plan.generate;
    perRun.push(plan.generate);
    poolSize += plan.generate;
  }
  assert.equal(perRun[0], 4, "the first run has nothing to draw on");
  assert.equal(perRun.at(-1), 1, "later runs cost only the guaranteed-new quota");
  assert.ok(spent <= 24, `cold start should settle quickly, spent ${spent}`);
});

test("MONEY: newCount is the only paid dial once warm", () => {
  for (const newCount of [0, 1, 2, 4]) {
    const plan = planPoolDraw({ poolSize: 500, count: 4, newCount });
    assert.equal(plan.generate, newCount, `newCount=${newCount}`);
  }
});

// --- reading a shipped pack ----------------------------------------------

function writePack(contents, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-pack-unit-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

test("a v1 pack is refused with a reason, never mixed in", () => {
  const pack = loadPoolPack(writePack({ version: 1, keys: { a: { members: [{ file: "images/x.png" }] } } }));
  assert.equal(pack.active, false);
  assert.match(pack.error, /v1/);
  assert.equal(pack.keyCount, 0);
});

test("an unreadable, absent or empty pack is pool-off, not an exception", () => {
  for (const pack of [
    loadPoolPack(""),
    loadPoolPack(path.join(os.tmpdir(), "surface-browser-no-such-pack")),
    loadPoolPack(writePack("{ not json")),
    loadPoolPack(writePack({ version: 2 })),
    loadPoolPack(writePack({ version: 2, keys: { a: { members: [] } } }))
  ]) {
    assert.equal(pack.active, false);
    assert.equal(poolMemberCount(pack, "a"), 0);
    assert.equal(readPoolMember(pack, "a", 0), null);
  }
});

test("a member whose file never arrived is dropped, not served as a hole", () => {
  const dir = writePack({
    version: 2,
    keys: { a: { members: [{ file: "images/here.png" }, { file: "images/gone.png" }] } }
  }, { "images/here.png": "PNG" });
  const pack = loadPoolPack(dir);
  assert.equal(pack.active, true);
  assert.equal(pack.memberCount, 1);
  assert.equal(pack.missingFiles, 1);
  assert.equal(readPoolMember(pack, "a", 0).buffer.toString(), "PNG");
  assert.equal(readPoolMember(pack, "a", 1), null);
});

test("a manifest cannot name a file outside its own pack", () => {
  // The manifest arrives from another machine. `file` becomes a path this
  // server reads and then SERVES, so an escape is an arbitrary-file-read.
  const dir = writePack({
    version: 2,
    keys: {
      a: {
        members: [
          { file: "../../../../etc/passwd" },
          { file: "/etc/passwd" },
          { file: "images/ok.png" }
        ]
      }
    }
  }, { "images/ok.png": "PNG" });
  const pack = loadPoolPack(dir);
  assert.equal(pack.memberCount, 1);
  assert.equal(readPoolMember(pack, "a", 0).buffer.toString(), "PNG");
});

// --- slot alignment, structurally ----------------------------------------

test("ALIGNMENT: the pool key and the generated image read the same seed and salt", () => {
  // The failure this guards is silent: if the planner picks slot N's modifier
  // from a different seed or salt than the generator does, the image in slot N
  // is made with one emoji and filed under another's key, and every later
  // lookup of that key returns the wrong picture. Both sides must derive it
  // from composeVaryModifier(batchSeed, index) and nothing else.
  const planner = plannerSource.slice(
    plannerSource.indexOf("function buildGenAiPoolSlots"),
    plannerSource.indexOf("function planGenAiPoolBatch")
  );
  assert.match(planner, /composeVaryModifier\(\{[^}]*seed: batchSeed[^}]*salt: index/s);
  // The generator's loop index is the salt, and the batch seed is handed in
  // rather than minted a second time.
  assert.match(generatorSource, /const baseSeed = batchSeed \?\? seed \?\? createGenAiSeed\(\)/);
  assert.match(generatorSource, /modifierSeed: baseSeed,\s*modifierIndexBase: index/);
  // And the batch stays `count` long whatever the pool covers, so the strength
  // ramp and the salt still correspond to the slot each image occupies.
  assert.match(generatorSource, /for \(let index = 0; index < count; index \+= 1\) \{/);
});
