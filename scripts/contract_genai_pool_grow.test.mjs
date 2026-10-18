// Contract tests for the grown pool store: fresh images from GenAI bookmark
// lineages (rounds 1 and 2) kept under GENAI_POOL_GROW_DIR and drawn again.
//
// Every test but the last runs with NO baked pack (a fresh deployment). The
// provider is the mock fal; its request log is what was bought.
//
// Not covered here: a site-image chord. Importing a web image needs a public
// URL through the SSRF guard, so the rule (origin "url"/"image_search" is never
// kept) is asserted in genai_pool_grow.test.mjs instead.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { startServer, startMockFal } from "./contract_helpers.mjs";
import { buildPoolKey } from "../server/genai-pool.js";

// A GENAI_PROMPT bookmark in src/bookmark-presets.js.
const BOOKMARK = "otters";
const COUNT = 4;
const MODEL = "fal-ai/flux-2/klein/4b";

const FAL_ENV = {
  GENAI_PROVIDER: "fal",
  FAL_KEY: "test-key",
  GENAI_FAL_TEXT_MODEL: MODEL,
  GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
  GENAI_WIDTH: "640",
  GENAI_HEIGHT: "512",
  GENAI_COUNT: String(COUNT),
  GENAI_VARY_MODIFIERS: "🦄 🧊",
  GENAI_SAVE_IMAGES_TO_DISK: "0"
};
const ALL_FROM_POOL = { GENAI_POOL_FRESH_MIN: "0", GENAI_POOL_FRESH_MAX: "0" };

const temps = [];
after(() => {
  for (const dir of temps) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `surface-browser-${label}-`));
  temps.push(dir);
  return dir;
}

// --- helpers -------------------------------------------------------------

async function withGrowServer({ growDir, env = {}, mockEnv = {} }, fn) {
  const mock = await startMockFal(mockEnv);
  const server = await startServer({
    ...FAL_ENV,
    GENAI_FAL_BASE_URL: mock.base,
    GENAI_POOL_GROW_DIR: growDir,
    GENAI_POOL_SUPPRESS_FILE: path.join(tempDir("grow-suppress"), "suppressed.json"),
    ...env
  });
  try {
    await fn({ server, mock });
  } finally {
    await server.stop();
    await mock.stop();
  }
}

async function postGenAi(server, body) {
  const res = await fetch(`${server.base}/api/genai`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

async function providerImages(mock) {
  const log = await (await fetch(`${mock.base}/requests`)).json();
  return log.requests
    .filter((entry) => entry.path.startsWith("/fal-ai/"))
    .reduce((total, entry) => total + (Number(entry.body?.num_images) || 1), 0);
}

async function addressOf(server, item) {
  const res = await fetch(`${server.base}${item.imageUrl}`);
  assert.equal(res.status, 200);
  return createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex").slice(0, 32);
}

function readManifest(growDir) {
  const file = path.join(growDir, "manifest.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

// Every kept member, flattened, with the key and entry it is filed under.
function kept(growDir) {
  const manifest = readManifest(growDir);
  return Object.entries(manifest?.keys || {}).flatMap(([key, entry]) => entry.members.map((member) => ({ key, entry, member })));
}

// The server appends to the query log asynchronously, after the response, so
// a read straight after a request can miss the newest lines.
async function logEvents(server, prefix, atLeast = 1) {
  const read = () => (fs.existsSync(server.queryLogPath)
    ? fs.readFileSync(server.queryLogPath, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => String(entry.event).startsWith(prefix))
    : []);
  const deadline = Date.now() + 2000;
  let events = read();
  while (events.length < atLeast && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    events = read();
  }
  return events;
}

function variationsOf(json, source) {
  return json.items.filter((item) => item.genai?.parentId === source.genai.id);
}

async function pollJob(server, jobId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const payload = await (await fetch(`${server.base}/api/genai/job/${jobId}`)).json();
    if (["complete", "failed", "cancelled"].includes(payload.status)) {
      return payload;
    }
  }
  assert.fail("job never settled");
  return null;
}

// --- round 1 -------------------------------------------------------------

test("round 1: a bookmark's fresh images are kept under the key the baker would compute", async () => {
  const growDir = tempDir("grow");
  await withGrowServer({ growDir }, async ({ server, mock }) => {
    const { status, json } = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    assert.equal(status, 200);
    assert.equal(json.items.length, COUNT);

    const members = kept(growDir);
    assert.equal(members.length, COUNT, "a cold key keeps every fresh image");
    const [{ key, entry }] = members;
    assert.equal(new Set(members.map((m) => m.key)).size, 1, "a text-to-image batch is one key");
    assert.equal(entry.kind, "base");
    assert.equal(entry.sourceKey, "");
    assert.equal(key, buildPoolKey({ model: MODEL, prompt: BOOKMARK, width: entry.width, height: entry.height, steps: 0 }),
      "prebake_pool.mjs's baseKeyFor would file these under the same key");

    const served = new Set(await Promise.all(json.items.map((item) => addressOf(server, item))));
    for (const { member } of members) {
      assert.ok(served.has(member.sha256), "a kept member is one of the images shown");
      const bytes = fs.readFileSync(path.join(growDir, member.file));
      assert.equal(createHash("sha256").update(bytes).digest("hex").slice(0, 32), member.sha256, "named by content address");
      assert.equal(member.round, 1);
      assert.ok(Number.isFinite(Date.parse(member.bakedAt)));
    }

    // Keeping an image buys nothing extra.
    const complete = (await logEvents(server, "genai.complete")).at(-1);
    assert.equal(complete.fresh, COUNT);
    assert.equal(await providerImages(mock), COUNT);
    assert.equal((await logEvents(server, "pool.grown", COUNT)).length, COUNT);
  });
});

test("the round trip: a kept member is drawn by the next identical request, live and after a restart", async () => {
  const growDir = tempDir("grow");
  let keptAddresses;
  await withGrowServer({ growDir, env: ALL_FROM_POOL }, async ({ server, mock }) => {
    const first = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    assert.equal(first.status, 200);
    keptAddresses = new Set(kept(growDir).map((m) => m.member.sha256));
    assert.equal(keptAddresses.size, COUNT);
    const spent = await providerImages(mock);

    const second = await postGenAi(server, { prompt: `  ${BOOKMARK.toUpperCase()} `, count: COUNT });
    assert.equal(second.status, 200);
    assert.equal(await providerImages(mock), spent, "drawn from memory, nothing bought");
    for (const item of second.json.items) {
      assert.ok(keptAddresses.has(await addressOf(server, item)));
    }
    assert.equal((await logEvents(server, "genai.complete")).at(-1).pooled, COUNT);
  });

  await withGrowServer({ growDir, env: ALL_FROM_POOL }, async ({ server, mock }) => {
    assert.match(server.stdout(), new RegExp(`GenAI pool growth: ${COUNT} members in 1 keys`));
    const { status, json } = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    assert.equal(status, 200);
    assert.equal(await providerImages(mock), 0, "a restart kept every member");
    for (const item of json.items) {
      assert.ok(keptAddresses.has(await addressOf(server, item)));
    }
  });
});

test("the async job path keeps images too", async () => {
  const growDir = tempDir("grow");
  await withGrowServer({ growDir }, async ({ server }) => {
    const accepted = await postGenAi(server, { prompt: BOOKMARK, count: COUNT, async: true });
    assert.equal(accepted.status, 202);
    const job = await pollJob(server, accepted.json.jobId);
    assert.equal(job.status, "complete");
    assert.equal(kept(growDir).length, COUNT);
  });
});

// --- round 2 -------------------------------------------------------------

test("round 2: chording a round-1 image keeps its variations, whether that base was fresh or drawn", async () => {
  const growDir = tempDir("grow");
  await withGrowServer({ growDir, env: ALL_FROM_POOL }, async ({ server, mock }) => {
    const round1 = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    const freshBase = round1.json.items[0];
    const freshBaseAddress = await addressOf(server, freshBase);

    const vary = await postGenAi(server, { source: { id: freshBase.genai.id }, count: COUNT });
    assert.equal(vary.status, 200);
    assert.equal(variationsOf(vary.json, freshBase).length, COUNT);
    const fromFresh = kept(growDir).filter((m) => m.entry.sourceKey === freshBaseAddress);
    assert.equal(fromFresh.length, COUNT);
    for (const { entry, member } of fromFresh) {
      assert.equal(entry.kind, "variation");
      assert.equal(member.round, 2);
      assert.equal(member.baseId, freshBaseAddress);
      assert.equal(entry.emoji, member.emoji);
    }

    // Round trip for round 2: the same base again. Every slot whose emoji key
    // already holds a member is drawn, and from the right key.
    const before = await providerImages(mock);
    const again = await postGenAi(server, { source: { id: freshBase.genai.id }, count: COUNT });
    const event = (await logEvents(server, "genai.complete")).at(-1);
    assert.ok(event.pooled > 0, "a kept variation was never drawn");
    assert.equal(await providerImages(mock) - before, event.fresh);
    const byAddress = new Map(kept(growDir).map((m) => [m.member.sha256, m]));
    let drawn = 0;
    for (const item of variationsOf(again.json, freshBase)) {
      const found = byAddress.get(await addressOf(server, item));
      if (found && fromFresh.some((m) => m.member.sha256 === found.member.sha256)) {
        drawn += 1;
        assert.equal(found.entry.emoji, item.genai.modifier.emoji, "drawn from another emoji's key");
        assert.equal(found.entry.sourceKey, freshBaseAddress, "drawn from another base's key");
      }
    }
    assert.equal(drawn, event.pooled);

    // A base DRAWN from the pool: another round-1 member, served back.
    const drawnRound1 = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    let drawnBase = null;
    for (const item of drawnRound1.json.items) {
      const itemAddress = await addressOf(server, item);
      if (itemAddress !== freshBaseAddress) {
        drawnBase = { item, address: itemAddress };
        break;
      }
    }
    assert.ok(drawnBase);
    await postGenAi(server, { source: { id: drawnBase.item.genai.id }, count: COUNT });
    assert.equal(kept(growDir).filter((m) => m.entry.sourceKey === drawnBase.address).length, COUNT);
  });
});

// --- never kept ----------------------------------------------------------

test("not kept: a typed prompt, a negative prompt, and round 3", async () => {
  const growDir = tempDir("grow");
  await withGrowServer({ growDir }, async ({ server, mock }) => {
    const typed = await postGenAi(server, { prompt: "kangaroos on a tram", count: COUNT });
    assert.equal(typed.status, 200);
    assert.equal(typed.json.items.length, COUNT);
    assert.equal(await providerImages(mock), COUNT, "a typed prompt keeps its one batched request");
    const negative = await postGenAi(server, { prompt: BOOKMARK, negativePrompt: "blurry", count: COUNT });
    assert.equal(negative.status, 200);
    assert.equal(readManifest(growDir), null, "nothing was kept");

    const round1 = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    const base = round1.json.items[0];
    const round2 = await postGenAi(server, { source: { id: base.genai.id }, count: COUNT });
    const variation = variationsOf(round2.json, base)[0];
    const keptBefore = kept(growDir).length;
    assert.ok(keptBefore > COUNT);

    const round3 = await postGenAi(server, { source: { id: variation.genai.id }, count: COUNT });
    assert.equal(round3.status, 200);
    assert.equal(kept(growDir).length, keptBefore, "a variation of a variation was kept");
    const variationAddress = await addressOf(server, variation);
    assert.equal(kept(growDir).some((m) => m.entry.sourceKey === variationAddress), false);
  });
});

test("a drawn member is never re-written, and the same bytes are never kept twice", async () => {
  const growDir = tempDir("grow");
  await withGrowServer({ growDir, env: ALL_FROM_POOL }, async ({ server }) => {
    await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    const manifestBefore = fs.readFileSync(path.join(growDir, "manifest.json"), "utf8");
    const { status } = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    assert.equal(status, 200);
    assert.equal(fs.readFileSync(path.join(growDir, "manifest.json"), "utf8"), manifestBefore);
    assert.equal(fs.readdirSync(path.join(growDir, "images")).length, COUNT);
  });

  // The mock is a pure function of prompt and seed, so the same seed makes the
  // same bytes: slots 0 and 1 of the second request repeat the first request.
  const sameBytesDir = tempDir("grow");
  await withGrowServer({ growDir: sameBytesDir, env: { GENAI_POOL_FRESH_MIN: "4", GENAI_POOL_FRESH_MAX: "4" } }, async ({ server }) => {
    await postGenAi(server, { prompt: BOOKMARK, count: 2, seed: 1234 });
    assert.equal(kept(sameBytesDir).length, 2);
    await postGenAi(server, { prompt: BOOKMARK, count: 3, seed: 1234 });
    assert.equal(kept(sameBytesDir).length, 3);
  });
});

test("the per-key cap holds, and the batch is still full", async () => {
  const growDir = tempDir("grow");
  await withGrowServer({
    growDir,
    env: { GENAI_POOL_GROW_MAX_PER_KEY: "3", GENAI_POOL_FRESH_MIN: "4", GENAI_POOL_FRESH_MAX: "4" }
  }, async ({ server, mock }) => {
    for (let round = 0; round < 2; round += 1) {
      const { status, json } = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
      assert.equal(status, 200);
      assert.equal(json.items.length, COUNT, "a full key still shows fresh images");
      assert.equal(kept(growDir).length, 3);
    }
    assert.equal(await providerImages(mock), COUNT * 2);
  });
});

test("a provider-flagged image is shown but not kept", async () => {
  const growDir = tempDir("grow");
  await withGrowServer({ growDir, mockEnv: { MOCK_FAL_NSFW: "1" } }, async ({ server }) => {
    const { status, json } = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    assert.equal(status, 200);
    assert.equal(json.items.length, COUNT);
    assert.equal(readManifest(growDir), null);
    const skipped = await logEvents(server, "pool.grow_skipped", COUNT);
    assert.equal(skipped.length, COUNT);
    assert.equal(skipped[0].reason, "provider_flagged");
  });
});

test("a corrupt manifest is refused with a warning and never overwritten", async () => {
  const growDir = tempDir("grow");
  const corrupt = "{ \"version\": 2, \"keys\": { \"abc\": ";
  fs.writeFileSync(path.join(growDir, "manifest.json"), corrupt);
  await withGrowServer({ growDir }, async ({ server }) => {
    assert.match(server.stderr(), /GenAI pool growth DISABLED/);
    const { status, json } = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    assert.equal(status, 200);
    assert.equal(json.items.length, COUNT);
  });
  assert.equal(fs.readFileSync(path.join(growDir, "manifest.json"), "utf8"), corrupt);
  assert.equal(fs.existsSync(path.join(growDir, "images")), false);
});

// --- review and deletion -------------------------------------------------

test("the review page lists grown members with a date the range filter uses, and deletes them", async () => {
  const growDir = tempDir("grow");
  const suppressFile = path.join(tempDir("grow-suppress"), "suppressed.json");
  const startedDay = new Date().toISOString().slice(0, 10);
  let hidden;
  await withGrowServer({ growDir, env: { ...ALL_FROM_POOL, GENAI_POOL_SUPPRESS_FILE: suppressFile } }, async ({ server }) => {
    await postGenAi(server, { prompt: BOOKMARK, count: 2 });
    const { json } = await (async () => {
      const res = await fetch(`${server.base}/api/pool/members`);
      assert.equal(res.status, 200);
      return { json: await res.json() };
    })();
    assert.equal(json.pack.dir, "");
    assert.equal(json.pack.grownMembers, 2);
    assert.equal(json.grow.dir, growDir);
    const members = json.keys.flatMap((key) => key.members);
    assert.equal(members.length, 2);
    for (const member of members) {
      assert.equal(member.store, "grown");
      assert.ok(Number.isFinite(Date.parse(member.bakedAt)));
    }
    const listed = async (params) => (await (await fetch(`${server.base}/api/pool/members${params}`)).json())
      .keys.flatMap((key) => key.members).length;
    assert.equal(await listed(`?from=${startedDay}`), 2);
    assert.equal(await listed("?to=2020-01-01"), 0);
    assert.equal((await fetch(`${server.base}/admin/pool`)).status, 200);
    const image = await fetch(`${server.base}/api/pool/image/${members[0].id}`);
    assert.equal(createHash("sha256").update(Buffer.from(await image.arrayBuffer())).digest("hex").slice(0, 32), members[0].id);

    hidden = members[0].id;
    const suppress = await fetch(`${server.base}/api/pool/suppress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [hidden], suppressed: true })
    });
    assert.equal((await suppress.json()).changed, 1);
    for (let round = 0; round < 4; round += 1) {
      const { json: batch } = await postGenAi(server, { prompt: BOOKMARK, count: 2 });
      for (const item of batch.items) {
        assert.notEqual(await addressOf(server, item), hidden, "a deleted grown member was drawn");
      }
    }
  });

  await withGrowServer({ growDir, env: { ...ALL_FROM_POOL, GENAI_POOL_SUPPRESS_FILE: suppressFile } }, async ({ server }) => {
    const json = await (await fetch(`${server.base}/api/pool/members`)).json();
    const member = json.keys.flatMap((key) => key.members).find((m) => m.id === hidden);
    assert.equal(member.suppressed, true, "the deletion survived a restart");
    for (let round = 0; round < 4; round += 1) {
      const { json: batch } = await postGenAi(server, { prompt: BOOKMARK, count: 2 });
      for (const item of batch.items) {
        assert.notEqual(await addressOf(server, item), hidden);
      }
    }
  });
});

test("the review page still 404s with neither directory configured", async () => {
  const mock = await startMockFal();
  const server = await startServer({ ...FAL_ENV, GENAI_FAL_BASE_URL: mock.base });
  try {
    assert.equal((await fetch(`${server.base}/admin/pool`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/pool/members`)).status, 404);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

// --- with a baked pack ---------------------------------------------------

test("with a baked pack: one key draws from both, and bytes already baked are not kept again", async () => {
  // A grown directory is a valid pack, so one is shipped as the "baked" pack.
  const seedDir = tempDir("grow");
  await withGrowServer({ growDir: seedDir, env: ALL_FROM_POOL }, async ({ server }) => {
    await postGenAi(server, { prompt: BOOKMARK, count: 2 });
  });
  const packDir = path.join(tempDir("pack-parent"), "v1");
  fs.cpSync(seedDir, packDir, { recursive: true });
  const baked = kept(packDir);
  const bakedAddresses = new Set(baked.map((m) => m.member.sha256));
  const firstSeed = Math.min(...baked.map((m) => m.member.seed));

  const growDir = tempDir("grow");
  await withGrowServer({
    growDir,
    env: { GENAI_POOL_DIR: packDir, GENAI_POOL_FRESH_MIN: "4", GENAI_POOL_FRESH_MAX: "4" }
  }, async ({ server }) => {
    // Seeds firstSeed and firstSeed+1 reproduce the two baked images exactly.
    await postGenAi(server, { prompt: BOOKMARK, count: COUNT, seed: firstSeed });
    const grown = kept(growDir);
    assert.equal(grown.length, 2, "only the two images the pack does not already hold");
    assert.equal(grown.some((m) => bakedAddresses.has(m.member.sha256)), false);
    assert.equal(grown[0].key, baked[0].key, "baked and grown share the key");
  });

  await withGrowServer({ growDir, env: { GENAI_POOL_DIR: packDir, ...ALL_FROM_POOL } }, async ({ server, mock }) => {
    const { json } = await postGenAi(server, { prompt: BOOKMARK, count: COUNT });
    assert.equal(await providerImages(mock), 0);
    const served = new Set(await Promise.all(json.items.map((item) => addressOf(server, item))));
    const grownAddresses = new Set(kept(growDir).map((m) => m.member.sha256));
    assert.deepEqual([...served].sort(), [...bakedAddresses, ...grownAddresses].sort(), "a batch of 4 draws all 2 baked + 2 grown");

    const review = await (await fetch(`${server.base}/api/pool/members`)).json();
    assert.equal(review.pack.dir, packDir);
    assert.equal(review.pack.totalMembers, 4);
    assert.equal(review.pack.grownMembers, 2);
    const stores = review.keys.flatMap((key) => key.members).map((m) => m.store).sort();
    assert.deepEqual(stores, ["baked", "baked", "grown", "grown"]);
  });
});
