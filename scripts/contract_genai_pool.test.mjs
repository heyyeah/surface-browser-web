// Contract tests for serving a pre-baked curated pack (server/genai-pool.js,
// server/genai-pool-pack.js, the /api/genai wiring).
//
// The pack these run against is BAKED, not fabricated: a first server generates
// it through scripts/prebake_pool.mjs, and a second
// server is pointed at the result. Handwriting a manifest would let a wrong key
// derivation agree with itself — which is the one failure this whole feature
// cannot survive, because a mis-keyed pack misses silently and pays anyway.
//
// The provider is the mock fal (scripts/mock_fal.mjs). Every request it records
// is one image that would have been bought, so counting them is how "spends
// only the fresh quota" is asserted.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { startServer, startMockFal } from "./contract_helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(here, "..");
const BAKED_PROMPT = "otters";
const BAKE_EMOJI = "🦄 🧊";
const COUNT = 4;

// Klein: the pair the pool key's model label names, no steps in the request, no
// strength dial.
const FAL_ENV = {
  GENAI_PROVIDER: "fal",
  FAL_KEY: "test-key",
  GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
  GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
  GENAI_WIDTH: "640",
  GENAI_HEIGHT: "512",
  GENAI_COUNT: String(COUNT),
  GENAI_VARY_MODIFIERS: BAKE_EMOJI,
  GENAI_SAVE_IMAGES_TO_DISK: "0"
};

let pack = null;

before(async () => {
  pack = await bakePack();
});

// --- helpers -------------------------------------------------------------

async function bakePack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-pack-"));
  const mock = await startMockFal();
  const server = await startServer({ ...FAL_ENV, GENAI_FAL_BASE_URL: mock.base });
  try {
    const baked = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [
        "scripts/prebake_pool.mjs",
        "--api", server.base,
        "--out", dir,
        "--depth", "2",
        "--bases", "1",
        "--count", String(COUNT),
        "--prompts", BAKED_PROMPT,
        "--limit", "12"
      ], { cwd: CLIENT_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (chunk) => { out += chunk; });
      proc.stderr.on("data", (chunk) => { out += chunk; });
      proc.on("exit", (code) => resolve({ code, out }));
    });
    assert.equal(baked.code, 0, `prebake_pool.mjs failed:\n${baked.out}`);
  } finally {
    await server.stop();
    await mock.stop();
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const entries = Object.entries(manifest.keys);
  const base = entries.find(([, entry]) => entry.kind === "base");
  const variations = entries.filter(([, entry]) => entry.kind === "variation");
  assert.ok(base, "the bake produced no base image");
  assert.equal(variations.length, 2, "expected one variation pool per emoji");
  for (const [, entry] of variations) {
    assert.equal(entry.members.length, 2, "expected each variation pool at depth 2");
  }
  // These tests recognise a served image by its bytes, so two members that
  // happen to be identical would make "which pool did this come from"
  // ambiguous and the suite intermittently wrong.
  const addresses = Object.values(manifest.keys).flatMap((entry) => entry.members.map((member) => member.sha256));
  assert.equal(new Set(addresses).size, addresses.length, "the mock baked two identical images");
  return { dir, manifest, baseKey: base[0], baseEntry: base[1] };
}

async function withPoolServer(extraEnv, fn, mockEnv = {}) {
  const mock = await startMockFal(mockEnv);
  const server = await startServer({
    ...FAL_ENV,
    GENAI_FAL_BASE_URL: mock.base,
    GENAI_POOL_DIR: pack.dir,
    ...extraEnv
  });
  try {
    await fn({ server, mock });
  } finally {
    await server.stop();
    await mock.stop();
  }
}

async function postGenAi(server, body, clientId = null) {
  const res = await fetch(`${server.base}/api/genai`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(clientId ? { "x-genai-client-id": clientId } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

// Images the provider was asked for, which is what fal bills. Not requests: a
// text-to-image call that is not slot-by-slot asks for the whole batch at once.
async function providerImages(mock) {
  const log = await (await fetch(`${mock.base}/requests`)).json();
  return log.requests
    .filter((entry) => entry.path.startsWith("/fal-ai/"))
    .reduce((total, entry) => total + (Number(entry.body?.num_images) || 1), 0);
}

async function contentAddress(server, item) {
  const res = await fetch(`${server.base}${item.imageUrl}`);
  assert.equal(res.status, 200, `pooled and fresh images share one route: ${item.imageUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

// Which baked pool a served image came out of, by its bytes. null for a fresh
// one.
function poolEntryForAddress(address) {
  for (const [, entry] of Object.entries(pack.manifest.keys)) {
    if ((entry.members || []).some((member) => member.sha256 === address)) {
      return entry;
    }
  }
  return null;
}

function genAiLogEvents(server) {
  return fs.readFileSync(server.queryLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => String(entry.event).startsWith("genai."));
}

// Generate a batch and return the item whose bytes ARE the baked base image.
// Chording that one is what a visitor does, and it is the only source whose
// content address the pack's variations were keyed on.
async function drawPooledBase(server) {
  const { status, json } = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
  assert.equal(status, 200);
  const wanted = pack.baseEntry.members[0].sha256;
  for (const item of json.items) {
    if (await contentAddress(server, item) === wanted) {
      return item;
    }
  }
  assert.fail("the baked base image was never drawn from the pool");
  return null;
}

async function pollJob(server, jobId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const res = await fetch(`${server.base}/api/genai/job/${jobId}`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    if (payload.status === "complete" || payload.status === "failed" || payload.status === "cancelled") {
      return payload;
    }
  }
  assert.fail("job never settled");
  return null;
}

// --- the read path -------------------------------------------------------

test("a warm pool fills the batch and buys only the fresh quota", async () => {
  await withPoolServer({}, async ({ server, mock }) => {
    const source = await drawPooledBase(server);
    const before = await providerImages(mock);

    const { status, json } = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT });
    assert.equal(status, 200);
    const variations = json.items.filter((item) => item.genai?.parentId === source.genai.id);
    assert.equal(variations.length, COUNT, "the sphere gets a full batch");

    const spent = await providerImages(mock) - before;
    const event = genAiLogEvents(server).filter((entry) => entry.event === "genai.complete").at(-1);
    assert.equal(event.fresh, spent, "the provider was called exactly once per fresh image");
    assert.ok(event.pooled >= 2, `expected most of the batch from the pool, got ${event.pooled}`);
    assert.equal(event.pooled + event.fresh, COUNT);
    assert.ok(spent <= 2, `a warm batch must not buy more than the fresh quota, bought ${spent}`);
  });
});

test("pooled and fresh images interleave and are indistinguishable to the client", async () => {
  await withPoolServer({}, async ({ server }) => {
    const source = await drawPooledBase(server);
    const { json } = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT });
    const variations = json.items.filter((item) => item.genai?.parentId === source.genai.id);

    const shapes = new Set();
    const origins = [];
    for (const item of variations) {
      assert.match(item.imageUrl, /^\/api\/genai\/image\/[A-Za-z0-9_-]+$/);
      assert.ok(item.genai.modifier?.emoji, "every variation carries its modifier");
      shapes.add(Object.keys(item).sort().join(","));
      origins.push(poolEntryForAddress(await contentAddress(server, item)) ? "pool" : "fresh");
    }
    assert.equal(shapes.size, 1, "a pooled item must look exactly like a generated one");
    assert.ok(origins.includes("pool") && origins.includes("fresh"), `expected a mix, got ${origins}`);
    // Two blocks would be pool,pool,pool,fresh or fresh,pool,pool,pool every
    // time; the fresh slots are chosen across the batch instead.
    assert.equal(new Set(origins).size, 2);
  });
});

test("SLOT ALIGNMENT: the image in slot N was baked with slot N's own modifier", async () => {
  // The trap this guards. A slot's pool key is built from the emoji the
  // generator will pick for that slot; if the two disagree, the batch still
  // looks fine and every future lookup for that key is poisoned. Here the
  // emoji the served bytes were BAKED with (read from the manifest, not from
  // the server) must equal the emoji the item claims, for every pooled slot.
  await withPoolServer({ GENAI_POOL_FRESH_MIN: "0", GENAI_POOL_FRESH_MAX: "0" }, async ({ server, mock }) => {
    const source = await drawPooledBase(server);
    const sourceAddress = await contentAddress(server, source);
    const before = await providerImages(mock);

    const { json } = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT });
    const variations = json.items.filter((item) => item.genai?.parentId === source.genai.id);
    assert.equal(variations.length, COUNT);
    assert.equal(await providerImages(mock) - before, 0, "a fresh quota of 0 must buy nothing");

    for (const item of variations) {
      const entry = poolEntryForAddress(await contentAddress(server, item));
      assert.ok(entry, "every slot should be pooled here");
      assert.equal(entry.emoji, item.genai.modifier.emoji, "served from another emoji's pool");
      assert.equal(entry.sourceKey, sourceAddress, "served from another base image's pool");
      assert.equal(entry.width, 640);
      assert.equal(entry.height, 512);
      assert.equal(entry.steps, 0, "Klein is sent no steps, so its pack keys on 0");
      assert.equal(entry.strength, null, "Klein has no denoising dial");
    }
  });
});

test("the spend reservation is the fresh count, not the batch size", async () => {
  // The pack holds one base, so a text-to-image batch of 4 is 1 pooled + 3
  // fresh. Under a cap of 3 a whole-batch reservation would be
  // refused outright; the second request proves it reserved 3 and not less.
  await withPoolServer({
    GENAI_DAILY_IMAGE_CAP: "3",
    GENAI_POOL_FRESH_MIN: "1",
    GENAI_POOL_FRESH_MAX: "1"
  }, async ({ server }) => {
    const first = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
    assert.equal(first.status, 200, "a batch of 4 with 3 fresh must fit a cap of 3");
    assert.equal(first.json.items.length, COUNT);

    const second = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
    assert.equal(second.status, 429, "the fresh images still count against the cap");
    assert.equal(second.json.error, "budget");
  });
});

test("a cold pool still returns a full batch, and pays for all of it", async () => {
  await withPoolServer({}, async ({ server, mock }) => {
    const { status, json } = await postGenAi(server, { prompt: "kangaroos on a tram", count: COUNT });
    assert.equal(status, 200);
    assert.equal(json.items.length, COUNT, "a short pool does not mean a short batch");
    assert.equal(await providerImages(mock), COUNT);
    const event = genAiLogEvents(server).at(-1);
    assert.equal(event.pooled, undefined, "no pool answered, so nothing to report");
  });
});

test("a provider outage falls back to pooled images rather than gaps", async () => {
  await withPoolServer({}, async ({ server, mock }) => {
    // The mock refuses every generation from the start, so nothing in either
    // batch below can have been bought.
    const base = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
    assert.equal(base.status, 200, "an outage must not fail a request the pack can answer");
    assert.equal(base.json.items.length, 1, "the pack holds one base, so one is what it can serve");
    const source = base.json.items[0];
    assert.equal(await contentAddress(server, source), pack.baseEntry.members[0].sha256);

    const vary = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT });
    assert.equal(vary.status, 200);
    const variations = vary.json.items.filter((item) => item.genai?.parentId === source.genai.id);
    assert.equal(variations.length, COUNT, "the outage degrades the piece to fully-cached, not to gaps");
    for (const item of variations) {
      assert.ok(poolEntryForAddress(await contentAddress(server, item)), "every slot came from the pack");
    }
    const events = genAiLogEvents(server);
    assert.ok(events.some((entry) => entry.event === "genai.pooled"), "the outage is still in the log");
  }, { MOCK_FAL_FAIL_AFTER: "0" });
});

test("the async job path pools too, and reports done", async () => {
  await withPoolServer({}, async ({ server, mock }) => {
    const source = await drawPooledBase(server);
    const before = await providerImages(mock);

    const accepted = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT, async: true });
    assert.equal(accepted.status, 202);
    const job = await pollJob(server, accepted.json.jobId);
    assert.equal(job.status, "complete");
    assert.equal(job.done, true);
    const variations = job.items.filter((item) => item.genai?.parentId === source.genai.id);
    assert.equal(variations.length, COUNT);

    const spent = await providerImages(mock) - before;
    const event = genAiLogEvents(server).filter((entry) => entry.event === "genai.complete").at(-1);
    assert.equal(event.async, true);
    assert.equal(event.fresh, spent);
    assert.ok(event.pooled >= 2);
  });
});

test("pooled images cost the store no bytes; fresh ones are evicted by bytes", async () => {
  // A byte cap smaller than one image: every fresh image pushes the previous
  // fresh one out, and the pooled base must survive all of it.
  await withPoolServer({ GENAI_IMAGE_CACHE_MAX_BYTES: "1" }, async ({ server }) => {
    const first = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
    assert.equal(first.json.items.length, COUNT);
    await postGenAi(server, { prompt: "kangaroos on a tram", count: COUNT });

    const wanted = pack.baseEntry.members[0].sha256;
    const statuses = [];
    for (const item of first.json.items) {
      const res = await fetch(`${server.base}${item.imageUrl}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const pooled = res.status === 200 && createHash("sha256").update(buffer).digest("hex").slice(0, 32) === wanted;
      statuses.push(pooled ? "pooled" : res.status);
    }
    assert.deepEqual(statuses.filter((status) => status === "pooled").length, 1, `the pooled image stays: ${statuses}`);
    assert.equal(statuses.filter((status) => status === 410).length, COUNT - 1, `every fresh image went by bytes: ${statuses}`);
  });
});

// --- a busy generator ---------------------------------------------------

// A cold prompt the pack cannot answer: every image is bought, so it holds the
// generator for COUNT mock round-trips. Another visitor's, since a visitor's
// next prompt cancels their last job.
async function occupyGenerator(server) {
  const busy = await postGenAi(server, { prompt: "kangaroos on a tram", count: COUNT, async: true }, "other-visitor");
  assert.equal(busy.status, 202);
  return busy.json.jobId;
}

test("a queued job shows its pooled images before its turn, and keeps them first", async () => {
  await withPoolServer({ GENAI_PARALLEL_JOBS: "1" }, async ({ server }) => {
    const busyJob = await occupyGenerator(server);
    // The pack holds one base, so this batch is 1 pooled + 3 fresh and must wait.
    const queued = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT, async: true });
    assert.equal(queued.status, 202);
    assert.equal(queued.json.items.length, 1, "the pooled image is there while the job waits");
    const early = queued.json.items[0];
    assert.equal(await contentAddress(server, early), pack.baseEntry.members[0].sha256);

    const job = await pollJob(server, queued.json.jobId);
    assert.equal(job.status, "complete");
    assert.equal(job.items.length, COUNT);
    assert.equal(job.items[0].genai.id, early.genai.id, "the client reads by index: the early image stays first");
    assert.equal(new Set(job.items.map((item) => item.genai.id)).size, COUNT, "no image delivered twice");
    assert.equal((await pollJob(server, busyJob)).status, "complete");
  }, { MOCK_FAL_DELAY_MS: "300" });
});

test("a batch the pool covers is served at once while the generator is busy, and buys nothing", async () => {
  await withPoolServer({ GENAI_PARALLEL_JOBS: "1" }, async ({ server, mock }) => {
    const source = await drawPooledBase(server);
    const busyJob = await occupyGenerator(server);
    const before = await providerImages(mock);

    const accepted = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT, async: true });
    assert.equal(accepted.status, 202);
    const job = await pollJob(server, accepted.json.jobId);
    assert.equal(job.status, "complete");
    const busy = await (await fetch(`${server.base}/api/genai/job/${busyJob}`)).json();
    assert.equal(busy.status, "running", "it finished while the paid job was still running");

    const variations = job.items.filter((item) => item.genai?.parentId === source.genai.id);
    assert.equal(variations.length, COUNT);
    for (const item of variations) {
      assert.ok(poolEntryForAddress(await contentAddress(server, item)), "every slot came from the pack");
    }
    const event = genAiLogEvents(server).filter((entry) => entry.event === "genai.complete" && entry.pooled === COUNT).at(-1);
    assert.ok(event, "logged as a fully pooled batch");
    assert.equal(event.fresh, 0);
    // Only the busy job's own calls may land in this window.
    assert.ok(await providerImages(mock) - before <= COUNT);
  }, { MOCK_FAL_DELAY_MS: "300" });
});

test("fal runs three jobs at once by default; the fourth waits", async () => {
  await withPoolServer({ GENAI_QUEUE_MAX_PENDING: "0" }, async ({ server }) => {
    const prompts = ["kangaroos on a tram", "a lighthouse of jelly", "owls in a library", "a moss piano"];
    const accepted = [];
    for (const [index, prompt] of prompts.entries()) {
      accepted.push(await postGenAi(server, { prompt, count: COUNT, async: true }, `visitor-${index}`));
    }
    const jobs = [];
    for (const { json } of accepted) {
      jobs.push(await pollJob(server, json.jobId));
    }
    assert.deepEqual(jobs.slice(0, 3).map((job) => job.status), ["complete", "complete", "complete"]);
    assert.equal(jobs[3].status, "failed", "with no queue, the fourth is turned away while three run");
  }, { MOCK_FAL_DELAY_MS: "300" });
});

// --- degrading safely ----------------------------------------------------

test("pool off is exactly today's behaviour", async () => {
  const mock = await startMockFal();
  const server = await startServer({ ...FAL_ENV, GENAI_FAL_BASE_URL: mock.base });
  try {
    const { status, json } = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
    assert.equal(status, 200);
    assert.equal(json.items.length, COUNT);
    assert.equal(await providerImages(mock), COUNT, "every image is bought when there is no pool");
    assert.doesNotMatch(server.stdout(), /GenAI pool/, "an unconfigured pool says nothing at boot");
    const event = genAiLogEvents(server).at(-1);
    assert.equal(event.pooled, undefined);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("a good pack logs its key and member counts once at boot", async () => {
  await withPoolServer({}, async ({ server }) => {
    const lines = server.stdout().split("\n").filter((line) => line.includes("GenAI pool"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^GenAI pool: 3 keys, 5 members from ${pack.dir}`));
  });
});

test("a v1 or unreadable pack degrades to pool-off instead of taking the box down", async () => {
  const broken = {
    "manifest v1": JSON.stringify({ version: 1, keys: {}, prompts: {} }),
    "unparseable manifest": "{ this is not json",
    "no keys": JSON.stringify({ version: 2 })
  };
  for (const [label, contents] of Object.entries(broken)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-badpack-"));
    fs.writeFileSync(path.join(dir, "manifest.json"), contents);
    const mock = await startMockFal();
    const server = await startServer({ ...FAL_ENV, GENAI_FAL_BASE_URL: mock.base, GENAI_POOL_DIR: dir });
    try {
      assert.match(server.stderr(), /GenAI pool DISABLED/, `${label}: the reason must be logged`);
      const { status, json } = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
      assert.equal(status, 200, `${label}: the piece keeps working`);
      assert.equal(json.items.length, COUNT);
    } finally {
      await server.stop();
      await mock.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a missing pack directory is pool-off, not a crash", async () => {
  const mock = await startMockFal();
  const server = await startServer({
    ...FAL_ENV,
    GENAI_FAL_BASE_URL: mock.base,
    GENAI_POOL_DIR: path.join(os.tmpdir(), "surface-browser-pack-that-was-never-shipped")
  });
  try {
    assert.match(server.stderr(), /GenAI pool DISABLED/);
    const { status } = await postGenAi(server, { prompt: BAKED_PROMPT, count: 1 });
    assert.equal(status, 200);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

// --- reviewing and pruning a pack -----------------------------------------
//
// Deleting is a TOMBSTONE, not an unlink: the store lives outside the pack, so
// none of this may ever change a byte of the baked release. Every test here
// checks the pack directory is untouched afterwards.

const suppressionStores = [];

after(() => {
  for (const file of suppressionStores) {
    fs.rmSync(file, { force: true });
  }
});

function suppressionStorePath() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-suppress-")), "suppressed.json");
  suppressionStores.push(file);
  return file;
}

// A fingerprint of the pack directory: every file's relative path and size.
// Suppression must not move a single byte of an immutable release.
function packFingerprint() {
  const walk = (dir, prefix = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => (
    item.isDirectory()
      ? walk(path.join(dir, item.name), `${prefix}${item.name}/`)
      : [`${prefix}${item.name}:${fs.statSync(path.join(dir, item.name)).size}`]
  ));
  return walk(pack.dir).sort().join("\n");
}

async function poolReview(server, params = "", init = {}) {
  const res = await fetch(`${server.base}/api/pool/members${params}`, init);
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  return { status: res.status, json: body };
}

async function postSuppress(server, ids, suppressed) {
  const res = await fetch(`${server.base}/api/pool/suppress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, suppressed })
  });
  return { status: res.status, json: await res.json() };
}

function reviewKey(json, key) {
  return json.keys.find((entry) => entry.key === key);
}

function manifestMemberCount() {
  return Object.values(pack.manifest.keys).reduce((total, entry) => total + entry.members.length, 0);
}

// The variation pool the pruning tests operate on: two members baked from the
// same base with the same emoji, so hiding one leaves a sibling behind and
// "never drawn" is distinguishable from "nothing to draw".
function variationKeyWithSiblings() {
  const found = Object.entries(pack.manifest.keys)
    .find(([, entry]) => entry.kind === "variation" && entry.members.length >= 2);
  assert.ok(found, "the bake produced no variation pool with a sibling");
  return { key: found[0], entry: found[1] };
}

test("the review listing reflects the manifest, and the page is served", async () => {
  await withPoolServer({ GENAI_POOL_SUPPRESS_FILE: suppressionStorePath() }, async ({ server }) => {
    const { status, json } = await poolReview(server);
    assert.equal(status, 200);
    assert.equal(json.pack.dir, pack.dir);
    assert.equal(json.pack.keyCount, Object.keys(pack.manifest.keys).length);
    assert.equal(json.pack.totalMembers, manifestMemberCount());
    assert.equal(json.pack.memberCount, manifestMemberCount(), "nothing is suppressed yet");
    assert.equal(json.pack.suppressedCount, 0);
    assert.equal(json.keys.length, Object.keys(pack.manifest.keys).length);

    for (const key of json.keys) {
      const entry = pack.manifest.keys[key.key];
      assert.ok(entry, `${key.key} is not a manifest key`);
      assert.equal(key.kind, entry.kind);
      assert.equal(key.prompt, entry.prompt);
      assert.equal(key.emoji, entry.emoji);
      assert.equal(key.sourceKey, entry.sourceKey || "");
      assert.equal(key.depth, entry.members.length, "depth is the drawable member count");
      assert.equal(key.suppressedDepth, 0);
      assert.deepEqual(
        key.members.map((member) => member.id).sort(),
        entry.members.map((member) => member.sha256).sort()
      );
      for (const member of key.members) {
        const baked = entry.members.find((candidate) => candidate.sha256 === member.id);
        assert.equal(member.file, baked.file);
        assert.equal(member.emoji, baked.emoji);
        assert.equal(member.bakedAt, baked.bakedAt, "the page can filter on a real timestamp");
        assert.equal(member.suppressed, false);
      }
    }

    // Grouping the page relies on: every variation names a base member.
    const baseIds = new Set(pack.baseEntry.members.map((member) => member.sha256));
    for (const key of json.keys.filter((entry) => entry.kind === "variation")) {
      assert.ok(baseIds.has(key.sourceKey), "a variation pool with no base to hang under");
    }

    const id = reviewKey(json, pack.baseKey).members[0].id;
    const thumb = await fetch(`${server.base}/api/pool/image/${id}?w=128`);
    assert.equal(thumb.status, 200);
    assert.ok(Number(thumb.headers.get("content-length")) > 0);
    const full = await fetch(`${server.base}/api/pool/image/${id}`);
    assert.equal(createHash("sha256").update(Buffer.from(await full.arrayBuffer())).digest("hex").slice(0, 32), id);

    const page = await fetch(`${server.base}/admin/pool`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Curated pool review/);
  });
});

test("the date range filters on bakedAt", async () => {
  await withPoolServer({ GENAI_POOL_SUPPRESS_FILE: suppressionStorePath() }, async ({ server }) => {
    const all = Object.values(pack.manifest.keys)
      .flatMap((entry) => entry.members)
      .sort((a, b) => a.bakedAt.localeCompare(b.bakedAt));
    const pivot = all[Math.floor(all.length / 2)].bakedAt;
    const listed = async (params) => {
      const { json } = await poolReview(server, params);
      return json.keys.flatMap((key) => key.members.map((member) => member.id)).sort();
    };
    const expect = (predicate) => all.filter(predicate).map((member) => member.sha256).sort();

    assert.deepEqual(await listed(`?from=${encodeURIComponent(pivot)}`), expect((m) => m.bakedAt >= pivot));
    assert.deepEqual(await listed(`?to=${encodeURIComponent(pivot)}`), expect((m) => m.bakedAt <= pivot));
    assert.deepEqual(await listed(`?from=${encodeURIComponent(pivot)}&to=${encodeURIComponent(pivot)}`), expect((m) => m.bakedAt === pivot));

    // A bare date is the whole UTC day, not its first instant.
    const day = pivot.slice(0, 10);
    assert.deepEqual(await listed(`?from=${day}&to=${day}`), expect((m) => m.bakedAt.slice(0, 10) === day));
    assert.deepEqual(await listed("?from=2020-01-01&to=2020-01-02"), []);
    assert.deepEqual(await listed("?from=2999-01-01"), []);
  });
});

test("a deleted member leaves the draw and the depth, and a restore brings it back", async () => {
  const store = suppressionStorePath();
  const { key, entry } = variationKeyWithSiblings();
  const hidden = entry.members[0].sha256;
  const sibling = entry.members[1].sha256;
  const before = packFingerprint();

  await withPoolServer({
    GENAI_POOL_SUPPRESS_FILE: store,
    GENAI_POOL_FRESH_MIN: "0",
    GENAI_POOL_FRESH_MAX: "0"
  }, async ({ server }) => {
    const source = await drawPooledBase(server);

    const deleted = await postSuppress(server, [hidden], true);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.changed, 1);

    const after = (await poolReview(server)).json;
    assert.equal(after.pack.suppressedCount, 1);
    assert.equal(after.pack.memberCount, manifestMemberCount() - 1, "a tombstone drops the drawable count");
    assert.equal(after.pack.totalMembers, manifestMemberCount(), "and never the baked count");
    assert.equal(reviewKey(after, key).depth, entry.members.length - 1, "and never counts toward depth");
    assert.equal(reviewKey(after, key).suppressedDepth, 1);
    assert.equal(reviewKey(after, key).members.find((member) => member.id === hidden).suppressed, true);

    // Hidden by default only from the DRAW; the page still lists it so it can
    // be restored, and hides it on request.
    const visibleOnly = (await poolReview(server, "?suppressed=0")).json;
    assert.equal(reviewKey(visibleOnly, key).members.some((member) => member.id === hidden), false);
    assert.equal(reviewKey(visibleOnly, key).members.some((member) => member.id === sibling), true);

    const drawn = new Set();
    for (let round = 0; round < 6; round += 1) {
      const { json } = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT });
      for (const item of json.items) {
        drawn.add(await contentAddress(server, item));
      }
    }
    assert.equal(drawn.has(hidden), false, "a suppressed member was served to a visitor");
    assert.equal(drawn.has(sibling), true, "its sibling is still drawn, so the pool itself still works");

    const restored = await postSuppress(server, [hidden], false);
    assert.equal(restored.status, 200);
    assert.equal(restored.json.changed, 1);
    const back = (await poolReview(server)).json;
    assert.equal(back.pack.suppressedCount, 0);
    assert.equal(reviewKey(back, key).depth, entry.members.length);

    const afterRestore = new Set();
    for (let round = 0; round < 14 && !afterRestore.has(hidden); round += 1) {
      const { json } = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT });
      for (const item of json.items) {
        afterRestore.add(await contentAddress(server, item));
      }
    }
    assert.equal(afterRestore.has(hidden), true, "a restored member is drawable again");
  });

  assert.equal(packFingerprint(), before, "the pack must be byte-for-byte untouched");
});

test("suppression survives a restart, and lives outside the pack", async () => {
  const store = suppressionStorePath();
  const hidden = pack.baseEntry.members[0].sha256;

  await withPoolServer({ GENAI_POOL_SUPPRESS_FILE: store }, async ({ server }) => {
    assert.equal((await postSuppress(server, [hidden], true)).json.changed, 1);
  });

  assert.ok(fs.existsSync(store), "the tombstone was never written");
  assert.equal(path.relative(pack.dir, store).startsWith(".."), true, "the store must not live inside the release");
  const written = JSON.parse(fs.readFileSync(store, "utf8"));
  assert.equal(written.version, 1);
  assert.deepEqual(Object.keys(written.suppressed), [hidden]);
  assert.equal(written.suppressed[hidden].file, pack.baseEntry.members[0].file);

  await withPoolServer({ GENAI_POOL_SUPPRESS_FILE: store }, async ({ server }) => {
    const { json } = await poolReview(server);
    assert.equal(json.pack.suppressedCount, 1, "a reload forgot the deletion");
    assert.equal(reviewKey(json, pack.baseKey).depth, pack.baseEntry.members.length - 1);
    assert.match(server.stdout(), /1 suppressed by/, "the boot log says what is hidden");
    // A pack whose only base is hidden can no longer answer that prompt, so the
    // batch is generated: no pooled slot is reported at all. (Bytes cannot say
    // this here — the mock is a pure function of prompt and seed, so a fresh
    // text-to-image of the baked prompt reproduces the baked base exactly.)
    const { status } = await postGenAi(server, { prompt: BAKED_PROMPT, count: COUNT });
    assert.equal(status, 200);
    let events = [];
    for (let attempt = 0; attempt < 40 && !events.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      events = fs.existsSync(server.queryLogPath) ? genAiLogEvents(server) : [];
    }
    assert.equal(events.at(-1).pooled, undefined, "a deleted member was still drawn");
  });
});

test("the review routes 404 for a non-local request, under both TRUST_PROXY settings", async () => {
  const routes = ["/admin/pool", "/api/pool/members"];
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address || "";

  for (const trustProxy of ["", "1"]) {
    await withPoolServer({
      GENAI_POOL_SUPPRESS_FILE: suppressionStorePath(),
      TRUST_PROXY: trustProxy,
      BIND_HOST: "0.0.0.0"
    }, async ({ server }) => {
      for (const route of routes) {
        assert.equal((await fetch(`${server.base}${route}`)).status, 200, `${route} from loopback, TRUST_PROXY=${trustProxy || "unset"}`);
      }
      // A real non-local peer. Its source address is the machine's own LAN
      // address, which is not loopback whichever way TRUST_PROXY is set.
      if (lan) {
        for (const route of routes) {
          const res = await fetch(`http://${lan}:${server.port}${route}`).catch((err) => err);
          assert.ok(res instanceof Response, `no route to ${lan}: ${res?.message}`);
          assert.equal(res.status, 404, `${route} from ${lan}, TRUST_PROXY=${trustProxy || "unset"}`);
        }
        assert.equal(
          (await fetch(`http://${lan}:${server.port}/api/pool/suppress`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [pack.baseEntry.members[0].sha256], suppressed: true })
          })).status,
          404,
          "a remote caller must not be able to prune the pool"
        );
      }
      // Behind a proxy the peer IS loopback, so only TRUST_PROXY makes
      // X-Forwarded-For the address the gate reads.
      const forwarded = await fetch(`${server.base}/api/pool/members`, {
        headers: { "x-forwarded-for": "203.0.113.9" }
      });
      assert.equal(forwarded.status, trustProxy ? 404 : 200);
    });
  }
});

test("a pack with no suppression store behaves exactly as it does today", async () => {
  const sibling = `${pack.dir}.suppressed.json`;
  assert.equal(fs.existsSync(sibling), false, "a previous test leaked a store next to the pack");
  await withPoolServer({}, async ({ server, mock }) => {
    const { json } = await poolReview(server);
    assert.equal(json.suppression.path, sibling, "the default store is a sibling of the pack, not a child");
    assert.equal(json.suppression.error, "");
    assert.equal(json.pack.suppressedCount, 0);
    assert.equal(json.pack.memberCount, manifestMemberCount());
    assert.doesNotMatch(server.stdout(), /suppressed by/, "nothing hidden, nothing said");

    const source = await drawPooledBase(server);
    const before = await providerImages(mock);
    const { status, json: batch } = await postGenAi(server, { source: { id: source.genai.id }, count: COUNT });
    assert.equal(status, 200);
    assert.equal(batch.items.filter((item) => item.genai?.parentId === source.genai.id).length, COUNT);
    assert.ok(await providerImages(mock) - before <= 2);
  });
  assert.equal(fs.existsSync(sibling), false, "reading a pack must not create a store beside it");
});
