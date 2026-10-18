// Contract tests for POST /api/genai via the mock sdapi provider.
//
// Provider config: GENAI_PROVIDER=a1111 + GENAI_ENDPOINT=<mock base>. The server
// appends /sdapi/v1/txt2img|img2img to the base (buildSdApiUrl). The mock bakes
// deterministic PNGs and reports per-image seeds via info.all_seeds, so the
// lineage block is fully populated without a real model.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, startMockSdapi, startMockFal } from "./contract_helpers.mjs";

async function withA1111(extraEnv, fn, mockEnv = {}) {
  const mock = await startMockSdapi(mockEnv);
  const server = await startServer({
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base,
    ...extraEnv
  });
  try {
    await fn({ server, mock });
  } finally {
    await server.stop();
    await mock.stop();
  }
}

async function withDrawThings(extraEnv, fn, mockEnv = {}) {
  const mock = await startMockSdapi(mockEnv);
  const server = await startServer({
    GENAI_PROVIDER: "drawthings",
    GENAI_DRAWTHINGS_ENDPOINT: mock.base,
    ...extraEnv
  });
  try {
    await fn({ server, mock });
  } finally {
    await server.stop();
    await mock.stop();
  }
}

// Fal adapter over the mock fal.run provider. The mock routes by pathname, so we
// pin single-segment model names to keep the URL simple, and blank the base
// (GENAI_FAL_BASE_URL) to the mock so callFalModel posts there.
async function withFal(extraEnv, fn, mockEnv = {}) {
  const mock = await startMockFal(mockEnv);
  const server = await startServer({
    GENAI_PROVIDER: "fal",
    FAL_KEY: "test-key",
    GENAI_FAL_BASE_URL: mock.base,
    GENAI_FAL_TEXT_MODEL: "txt2img",
    GENAI_FAL_IMAGE_MODEL: "img2img",
    ...extraEnv
  });
  try {
    await fn({ server, mock });
  } finally {
    await server.stop();
    await mock.stop();
  }
}

test("/api/genai generate: envelope + per-image genai lineage with seeds", async () => {
  await withA1111({}, async ({ server }) => {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a glowing tunnel", count: 3 })
    });
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.sourceUrl, "genai:a glowing tunnel");
    assert.equal(json.title, "GenAI: a glowing tunnel");
    assert.equal(json.meta.method, "genai_a1111");
    assert.equal(json.meta.cached, false);
    assert.ok(json.meta.genaiCacheKey, "cache key present");
    assert.equal(json.items.length, 3, "count honored");
    const savedFiles = fs.readdirSync(server.generatedImagesDir);
    assert.equal(savedFiles.length, 3, "generated images saved to disk");
    assert.ok(savedFiles.every((name) => name.includes("g_") && /\.(png|jpg|webp|gif)$/.test(name)), "saved files are image files");

    const seeds = new Set();
    for (const item of json.items) {
      assert.match(item.imageUrl, /^\/api\/genai\/image\/g_/, "served via image id");
      assert.ok(item.genai, "lineage block present");
      assert.match(item.genai.id, /^g_/);
      assert.equal(item.genai.prompt, "a glowing tunnel");
      assert.equal(item.genai.strength, null, "txt2img has no strength");
      assert.equal(item.genai.parentId, null, "txt2img has no parent");
      assert.ok(Number.isInteger(item.genai.seed), "per-image seed set");
      seeds.add(item.genai.seed);
    }
    assert.equal(seeds.size, 3, "distinct per-image seeds");

    // The served image id actually resolves.
    const imgRes = await fetch(`${server.base}${json.items[0].imageUrl}`);
    assert.equal(imgRes.status, 200);
    assert.match(imgRes.headers.get("content-type") || "", /^image\//);
  });
});

test("/api/genai generate: respects save-to-disk off", async () => {
  await withA1111({ GENAI_SAVE_IMAGES_TO_DISK: "0" }, async ({ server }) => {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "an ephemeral image", count: 1 })
    });
    assert.equal(res.status, 200);
    const savedFiles = fs.readdirSync(server.generatedImagesDir);
    assert.equal(savedFiles.length, 0, "generated images are not saved when disk persistence is off");
  });
});

test("/api/genai generate: saved settings affect the next provider request", async () => {
  await withA1111({ GENAI_WIDTH: "256", GENAI_HEIGHT: "256", GENAI_STEPS: "3" }, async ({ server, mock }) => {
    const first = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "before settings", count: 1 })
    });
    assert.equal(first.status, 200);

    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_WIDTH: 640, GENAI_HEIGHT: 384, GENAI_STEPS: 8 } })
    });
    assert.equal(put.status, 200);

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const second = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "after settings", count: 1 })
    });
    assert.equal(second.status, 200);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const call = log.requests.find((r) => r.path === "/sdapi/v1/txt2img");
    assert.ok(call, "txt2img call recorded");
    assert.equal(call.body.width, 640);
    assert.equal(call.body.height, 384);
    assert.equal(call.body.steps, 8);
    assert.equal(call.body.guidance_embed, undefined, "plain A1111 does not receive Draw Things guidance_embed");
  });
});

test("/api/genai drawthings: sends Klein-tuned guidance_embed on generate and vary", async () => {
  await withDrawThings({}, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "guidance source", count: 1 })
    });
    assert.equal(gen.status, 200);
    const genJson = await gen.json();
    const parent = genJson.items[0].genai.id;

    let log = await (await fetch(`${mock.base}/requests`)).json();
    const txt2img = log.requests.find((r) => r.path === "/sdapi/v1/txt2img");
    assert.equal(txt2img.body.steps, 8);
    assert.equal(txt2img.body.guidance_embed, 5);

    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_DRAWTHINGS_GUIDANCE_EMBED: 3.5 } })
    });
    assert.equal(put.status, 200);

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 1 })
    });
    assert.equal(vary.status, 200);

    log = await (await fetch(`${mock.base}/requests`)).json();
    const img2img = log.requests.find((r) => r.path === "/sdapi/v1/img2img");
    assert.equal(img2img.body.steps, 8);
    assert.equal(img2img.body.guidance_embed, 3.5);
  });
});

test("/api/genai generate: provider-specific endpoint overrides legacy endpoint", async () => {
  const legacyMock = await startMockSdapi();
  const a1111Mock = await startMockSdapi();
  const server = await startServer({
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: legacyMock.base
  });
  try {
    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_A1111_ENDPOINT: a1111Mock.base } })
    });
    assert.equal(put.status, 200);

    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "provider endpoint memory", count: 1 })
    });
    assert.equal(res.status, 200);

    const legacyLog = await (await fetch(`${legacyMock.base}/requests`)).json();
    const a1111Log = await (await fetch(`${a1111Mock.base}/requests`)).json();
    assert.equal(legacyLog.requests.filter((r) => r.path === "/sdapi/v1/txt2img").length, 0);
    assert.equal(a1111Log.requests.filter((r) => r.path === "/sdapi/v1/txt2img").length, 1);
  } finally {
    await server.stop();
    await legacyMock.stop();
    await a1111Mock.stop();
  }
});

test("/api/genai generate: logs provider settings and duration", async () => {
  await withA1111({ GENAI_WIDTH: "320", GENAI_HEIGHT: "256", GENAI_STEPS: "5" }, async ({ server }) => {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "log probe", count: 1 })
    });
    assert.equal(res.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = fs.readFileSync(server.queryLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const entry = lines.find((line) => line.event === "genai.complete" && line.prompt === "log probe");
    assert.ok(entry, "genai.complete log entry recorded");
    assert.equal(entry.provider, "a1111");
    assert.equal(entry.width, 320);
    assert.equal(entry.height, 256);
    assert.equal(entry.steps, 5);
    assert.equal(typeof entry.durationMs, "number");
  });
});

test("/api/genai async job: polls generated images to completion", async () => {
  await withA1111({}, async ({ server }) => {
    const start = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "progressive tunnel", count: 3, async: true })
    });
    assert.equal(start.status, 202);
    let payload = await start.json();
    assert.match(payload.jobId, /^gj_/);
    assert.ok(["queued", "running", "complete"].includes(payload.status));

    for (let attempt = 0; attempt < 20 && payload.status !== "complete"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const poll = await fetch(`${server.base}/api/genai/job/${payload.jobId}`);
      assert.equal(poll.status, 200);
      payload = await poll.json();
      assert.notEqual(payload.status, "failed", payload.error || "job failed");
    }

    assert.equal(payload.status, "complete");
    assert.equal(payload.items.length, 3);
    assert.equal(payload.received, 3);
    assert.equal(payload.expected, 3);
    assert.equal(payload.done, true);
    assert.equal(payload.meta.complete, true);
    assert.equal(payload.meta.cached, false);
    assert.ok(payload.meta.genaiCacheKey, "final cache key present");
    for (const item of payload.items) {
      assert.match(item.imageUrl, /^\/api\/genai\/image\/g_/);
      assert.ok(item.genai?.id, "lineage id present");
    }
  });
});

test("/api/genai async job: newer same-client request supersedes an older active job", async () => {
  await withA1111({}, async ({ server }) => {
    const clientId = "supersede-client";
    const first = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-genai-client-id": clientId },
      body: JSON.stringify({ prompt: "old prompt", count: 3, async: true })
    });
    assert.equal(first.status, 202);
    const firstJob = await first.json();
    assert.match(firstJob.jobId, /^gj_/);

    const second = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-genai-client-id": clientId },
      body: JSON.stringify({ prompt: "new prompt", count: 2, async: true })
    });
    assert.equal(second.status, 202);
    let secondJob = await second.json();
    assert.match(secondJob.jobId, /^gj_/);
    assert.notEqual(secondJob.jobId, firstJob.jobId);

    const oldPoll = await fetch(`${server.base}/api/genai/job/${firstJob.jobId}`);
    assert.equal(oldPoll.status, 200);
    const oldPayload = await oldPoll.json();
    assert.equal(oldPayload.status, "cancelled");
    assert.equal(oldPayload.ok, false);

    for (let attempt = 0; attempt < 30 && secondJob.status !== "complete"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const poll = await fetch(`${server.base}/api/genai/job/${secondJob.jobId}`);
      assert.equal(poll.status, 200);
      secondJob = await poll.json();
      assert.notEqual(secondJob.status, "failed", secondJob.error || "job failed");
    }

    assert.equal(secondJob.status, "complete");
    assert.equal(secondJob.received, 2);
    assert.equal(secondJob.expected, 2);
    assert.equal(secondJob.done, true);
    assert.equal(secondJob.items.length, 2);
    assert.ok(secondJob.items.every((item) => item.genai?.prompt === "new prompt"));
  }, { MOCK_SDAPI_DELAY_MS: "120" });
});

test("/api/genai async job: cancellation marks job cancelled", async () => {
  await withA1111({}, async ({ server }) => {
    const start = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cancelled tunnel", count: 3, async: true })
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    assert.match(started.jobId, /^gj_/);

    const cancel = await fetch(`${server.base}/api/genai/job/${started.jobId}`, {
      method: "DELETE"
    });
    assert.equal(cancel.status, 200);
    const cancelled = await cancel.json();
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.ok, false);

    const poll = await fetch(`${server.base}/api/genai/job/${started.jobId}`);
    assert.equal(poll.status, 200);
    const payload = await poll.json();
    assert.equal(payload.status, "cancelled");
  }, { MOCK_SDAPI_RESPONSE_DELAY_MS: "200" });
});

test("/api/genai vary: uses source image dimensions after size settings change", async () => {
  await withA1111({ GENAI_WIDTH: "448", GENAI_HEIGHT: "448", GENAI_STEPS: "3" }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "fixed source size", count: 1 })
    });
    assert.equal(gen.status, 200);
    const genJson = await gen.json();
    const parent = genJson.items[0].genai.id;

    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_WIDTH: 576, GENAI_HEIGHT: 576, GENAI_STEPS: 8 } })
    });
    assert.equal(put.status, 200);

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 1 })
    });
    assert.equal(vary.status, 200);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const call = log.requests.find((r) => r.path === "/sdapi/v1/img2img");
    assert.ok(call, "img2img call recorded");
    assert.equal(call.body.width, 448);
    assert.equal(call.body.height, 448);
    assert.equal(call.body.steps, 8);
    assert.equal(call.body.guidance_embed, undefined, "plain A1111 does not receive Draw Things guidance_embed");
  });
});

test("/api/genai vary: fixed seed mode reuses one seed across the strength ramp", async () => {
  await withA1111({}, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "seed mode source", count: 1 })
    });
    assert.equal(gen.status, 200);
    const genJson = await gen.json();
    const parent = genJson.items[0].genai.id;

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const fresh = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 3, seed: 1234 })
    });
    assert.equal(fresh.status, 200);
    const freshLog = await (await fetch(`${mock.base}/requests`)).json();
    const freshSeeds = freshLog.requests
      .filter((r) => r.path === "/sdapi/v1/img2img")
      .map((r) => r.body.seed);
    assert.deepEqual(freshSeeds, [1234, 1235, 1236], "fresh mode keeps the existing per-variation seed behavior");

    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_SEED_MODE: "fixed" } })
    });
    assert.equal(put.status, 200);

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const fixed = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 3, seed: 4321 })
    });
    assert.equal(fixed.status, 200);
    const fixedLog = await (await fetch(`${mock.base}/requests`)).json();
    const fixedSeeds = fixedLog.requests
      .filter((r) => r.path === "/sdapi/v1/img2img")
      .map((r) => r.body.seed);
    assert.deepEqual(fixedSeeds, [4321, 4321, 4321], "fixed mode varies only denoising strength");
  });
});

test("/api/genai vary: source.id -> ascending strength ramp with parentId", async () => {
  await withA1111({}, async ({ server }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "seed image", count: 1 })
    });
    assert.equal(gen.status, 200);
    const genJson = await gen.json();
    const parent = genJson.items[0].genai.id;
    const parentImageUrl = genJson.items[0].imageUrl;

    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 3 })
    });
    assert.equal(vary.status, 200);
    const varyJson = await vary.json();
    assert.equal(varyJson.items.length, 4, "source image plus requested variations");
    assert.equal(varyJson.items[0].genai.id, parent, "source image stays first");
    assert.equal(varyJson.items[0].imageUrl, parentImageUrl, "source image URL is preserved");
    assert.equal(varyJson.items[0].genai.strength, null, "source image is not a variation");

    const variations = varyJson.items.slice(1);
    const strengths = variations.map((it) => it.genai.strength);
    for (const s of strengths) {
      assert.ok(typeof s === "number" && s >= 0 && s <= 1, `valid strength ${s}`);
    }
    // Ascending (closest-first): subtle -> divergent.
    for (let i = 1; i < strengths.length; i += 1) {
      assert.ok(strengths[i] >= strengths[i - 1], `strengths ascend: ${strengths}`);
    }
    assert.ok(strengths[strengths.length - 1] > strengths[0], "ramp actually spreads");

    for (const item of variations) {
      assert.equal(item.genai.parentId, parent, "parentId set to source");
      assert.ok(Number.isInteger(item.genai.seed), "per-image seed set");
    }

    const nextParent = variations[0].genai.id;
    const secondVary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: nextParent }, count: 3 })
    });
    assert.equal(secondVary.status, 200);
    const secondVaryJson = await secondVary.json();
    assert.equal(secondVaryJson.items.length, 5, "ancestor chain plus requested variations");
    assert.equal(secondVaryJson.items[0].genai.id, parent, "root source remains first");
    assert.equal(secondVaryJson.items[1].genai.id, nextParent, "selected variation appears before new variants");
    for (const item of secondVaryJson.items.slice(2)) {
      assert.equal(item.genai.parentId, nextParent, "new variants branch from selected variation");
    }

    const nextParent2 = secondVaryJson.items[3].genai.id;
    const thirdVary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: nextParent2 }, count: 3 })
    });
    assert.equal(thirdVary.status, 200);
    const thirdVaryJson = await thirdVary.json();
    assert.equal(thirdVaryJson.items.length, 6, "full selected path plus requested variations");
    assert.equal(thirdVaryJson.items[0].genai.id, parent, "root source remains first at depth 3");
    assert.equal(thirdVaryJson.items[1].genai.id, nextParent, "first selected variation remains second");
    assert.equal(thirdVaryJson.items[2].genai.id, nextParent2, "latest selected variation appears before new variants");
    for (const item of thirdVaryJson.items.slice(3)) {
      assert.equal(item.genai.parentId, nextParent2, "depth-3 variants branch from latest selected variation");
    }
  });
});

test("/api/genai: unknown/expired source id -> 410", async () => {
  await withA1111({}, async ({ server }) => {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x", source: { id: "g_does_not_exist" } })
    });
    assert.equal(res.status, 410);
    const json = await res.json();
    assert.match(json.error, /expired|not found/i);
  });
});

test("/api/genai: unconfigured provider -> 501 (documented disabled behavior)", async () => {
  // No GENAI_ENDPOINT / GENAI_PROVIDER. Health reports genai.enabled=false;
  // per api_contract the endpoint is "hidden or disabled". The server's actual
  // POST behavior is a 501 ProviderConfigError ("GENAI_ENDPOINT is not
  // configured"). This test documents the actual behavior.
  const server = await startServer();
  try {
    const health = await fetch(`${server.base}/api/health`);
    const healthJson = await health.json();
    assert.equal(healthJson.genai.enabled, false);
    assert.equal(healthJson.genai.provider, "disabled");

    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "anything" })
    });
    assert.equal(res.status, 501);
    const json = await res.json();
    assert.match(json.error, /GENAI_ENDPOINT is not configured/i);
  } finally {
    await server.stop();
  }
});

test("/api/genai museum-safe: blocked prompt -> 400 neutral; negative injected into provider call", async () => {
  await withA1111({ GENAI_MUSEUM_SAFE: "1" }, async ({ server, mock }) => {
    // Blocklisted term -> 400 with a neutral message (no echo of the term).
    const blocked = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "an nsfw scene" })
    });
    assert.equal(blocked.status, 400);
    const blockedJson = await blocked.json();
    assert.match(blockedJson.error, /museum-safe/i);
    assert.doesNotMatch(blockedJson.error, /nsfw/i, "neutral message, no term echo");

    // A clean prompt succeeds AND the museum-safe negative prompt reaches the
    // provider. Reset the mock's request log first, then inspect it.
    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const ok = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a calm landscape", count: 1 })
    });
    assert.equal(ok.status, 200);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    assert.ok(log.requests.length >= 1, "provider was called");
    const call = log.requests.find((r) => r.path === "/sdapi/v1/txt2img");
    assert.ok(call, "txt2img call recorded");
    assert.match(
      String(call.body.negative_prompt || ""),
      /nsfw|nudity|explicit/i,
      "museum-safe negative prompt injected into provider request"
    );
  });
});

test("/api/genai fal vary: under the source cap inlines the image and calls img2img", async () => {
  // Small txt2img output -> stored source well under FAL_VARY_MAX_SOURCE_BYTES,
  // so the vary succeeds and forwards the source as an inlined image_url.
  await withFal({}, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a small fal source", count: 1 })
    });
    assert.equal(gen.status, 200);
    const parent = (await gen.json()).items[0].genai.id;

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 2 })
    });
    assert.equal(vary.status, 200);
    const varyJson = await vary.json();
    assert.ok(varyJson.items.length >= 2, "vary produced variations");

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const img2img = log.requests.filter((r) => r.path === "/img2img");
    assert.ok(img2img.length >= 1, "img2img was called for the vary");
    assert.match(String(img2img[0].body.image_url || ""), /^data-url\(/, "source inlined as a data URL");
  });
});

test("/api/genai fal vary: FLUX.1 dev image-to-image clamps local low steps to 10", async () => {
  await withFal({
    GENAI_STEPS: "5",
    GENAI_FAL_IMAGE_MODEL: "fal-ai/flux/dev/image-to-image"
  }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a low-step fal source", count: 1 })
    });
    assert.equal(gen.status, 200);
    const parent = (await gen.json()).items[0].genai.id;

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 1 })
    });
    assert.equal(vary.status, 200);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const img2img = log.requests.find((request) => request.path === "/fal-ai/flux/dev/image-to-image");
    assert.ok(img2img, "FLUX.1 dev img2img was called");
    assert.equal(img2img.body.num_inference_steps, 10, "hosted img2img minimum is enforced");
  });
});

test("/api/genai fal FLUX.2 Klein 4B uses its paired schema and emoji variation lineage", async () => {
  await withFal({
    GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
    GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
    GENAI_STEPS: "8",
    GENAI_CFG_SCALE: "7",
    GENAI_VARY_MODIFIERS: "🧊",
    GENAI_VARY_MODIFIER_MODE: "per-image"
  }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a Klein source", count: 1, seed: 42 })
    });
    assert.equal(gen.status, 200);
    const parent = (await gen.json()).items[0].genai.id;

    let log = await (await fetch(`${mock.base}/requests`)).json();
    const txt2img = log.requests.find((request) => request.path === "/fal-ai/flux-2/klein/4b");
    assert.ok(txt2img, "Klein text endpoint was called");
    assert.equal(txt2img.body.num_inference_steps, undefined, "Klein uses Fal's four-step default");
    assert.equal(txt2img.body.guidance_scale, undefined, "FLUX.1 guidance is not sent to Klein");

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 2, seed: 42 })
    });
    assert.equal(vary.status, 200);
    const varyJson = await vary.json();
    const variations = varyJson.items.filter((item) => item.genai.parentId === parent);
    assert.equal(variations.length, 2);
    for (const item of variations) {
      assert.equal(item.genai.strength, null, "Klein does not fabricate a FLUX.1 strength");
      assert.equal(item.genai.modifier.emoji, "🧊", "existing emoji variation policy is retained");
    }

    log = await (await fetch(`${mock.base}/requests`)).json();
    const edits = log.requests.filter((request) => request.path === "/fal-ai/flux-2/klein/4b/edit");
    assert.equal(edits.length, 2, "one Klein edit call per requested variation");
    for (const edit of edits) {
      assert.deepEqual(edit.body.image_urls.map((value) => value.startsWith("data-url(")), [true]);
      assert.equal(edit.body.image_url, undefined, "Klein uses plural image_urls");
      assert.equal(edit.body.strength, undefined, "Klein accepts no FLUX.1 strength");
      assert.equal(edit.body.guidance_scale, undefined, "Klein accepts no FLUX.1 guidance");
      assert.equal(edit.body.num_inference_steps, undefined, "Klein uses Fal's four-step default");
      // Regression: a 320x256-configured vary came back 1120x896 because the
      // edit request carried no image_size at all. The default box here is 512x512 (square), under Fal's 640x512
      // minimum, so the square is scaled up rather than reshaped, and the
      // second-level fit of that 640x640 source reproduces it exactly.
      assert.deepEqual(edit.body.image_size, { width: 640, height: 640 }, "Klein edit sends an explicit image_size at or above Fal's minimum");
      // Klein edit exposes no denoising-strength dial, so the emoji cannot be
      // the whole prompt: with nothing of the source in the text the model
      // replaced the picture with the emoji's subject. The
      // lineage prompt is carried alongside the modifier on this path even
      // though GENAI_VARY_MODIFIER_STYLE is still its default `replace`.
      assert.equal(edit.body.prompt, "a Klein source, icy, frozen", "Klein edit anchors the emoji to the source's lineage prompt");
    }
  });
});

test("/api/genai fal raises a below-minimum request to Fal's floor; local Draw Things keeps the small box", async () => {
  // Fal's minimum image size is 640x512. A 320x256 box is fine locally but
  // rejected hosted, so the floor is per-provider, not a new global size.
  await withFal({
    GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
    GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
    GENAI_WIDTH: "320",
    GENAI_HEIGHT: "256"
  }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a floor-raised Klein source", count: 1, seed: 11 })
    });
    assert.equal(gen.status, 200);
    const generated = (await gen.json()).items[0];

    const genLog = await (await fetch(`${mock.base}/requests`)).json();
    const txt2img = genLog.requests.find((request) => request.path === "/fal-ai/flux-2/klein/4b");
    // 320x256 is aspect 1.25, exactly 2x under the 640x512 floor: scaled up,
    // not stretched to it.
    assert.deepEqual(txt2img.body.image_size, { width: 640, height: 512 }, "hosted generate is raised to Fal's minimum");
    // The stored dimensions must be the returned bytes' real ones (the mock
    // bakes at the requested size), not the configured box — Draw Things
    // answers 422 when a later vary's init image disagrees with them.
    assert.equal(generated.width, 640);
    assert.equal(generated.height, 512);

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: generated.genai.id }, count: 1, seed: 11 })
    });
    assert.equal(vary.status, 200);
    const log = await (await fetch(`${mock.base}/requests`)).json();
    const edits = log.requests.filter((request) => request.path === "/fal-ai/flux-2/klein/4b/edit");
    assert.equal(edits.length, 1);
    // A 640x512 source is already legal: the policy is stable across levels
    // rather than growing the image on every vary.
    assert.deepEqual(edits[0].body.image_size, { width: 640, height: 512 }, "an already-legal source is not grown further");
  });

  await withDrawThings({
    GENAI_WIDTH: "320",
    GENAI_HEIGHT: "256"
  }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a local Klein source", count: 1 })
    });
    assert.equal(gen.status, 200);
    const log = await (await fetch(`${mock.base}/requests`)).json();
    const txt2img = log.requests.find((request) => request.path === "/sdapi/v1/txt2img");
    assert.equal(txt2img.body.width, 320, "the hosted floor never reaches local generation");
    assert.equal(txt2img.body.height, 256);
  });
});

test("/api/genai fal rescales a sub-minimum edit source, not only the requested size", async () => {
  // Fal's documented `image_too_small` 422 names "the provided image
  // dimensions", which on an edit endpoint is the inlined source as much as
  // the requested image_size, so both are raised. A locally generated or
  // imported source (a small configured box) is the realistic case; the mock's
  // payload-bytes mode stands in for it with a 32x32 source.
  await withFal({
    GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
    GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
    GENAI_WIDTH: "320",
    GENAI_HEIGHT: "256"
  }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a tiny Klein source", count: 1, seed: 5 })
    });
    assert.equal(gen.status, 200);
    const generated = (await gen.json()).items[0];
    assert.deepEqual([generated.width, generated.height], [32, 32], "stored dimensions are the returned bytes', not the request's");

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: generated.genai.id }, count: 1, seed: 5 })
    });
    assert.equal(vary.status, 200);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const edit = log.requests.find((request) => request.path === "/fal-ai/flux-2/klein/4b/edit");
    // 32x32 is square, so the smallest legal square clears the wider axis: 640.
    assert.deepEqual(edit.body.image_size, { width: 640, height: 640 });
    // The mock logs the inlined source as "data-url(<n> chars)". A 32x32 PNG is
    // a couple of kB; anything near that means the stored bytes went up
    // untouched and Fal would answer image_too_small.
    const inlinedChars = Number(/data-url\((\d+) chars\)/.exec(edit.body.image_urls[0])?.[1] || 0);
    assert.ok(inlinedChars > 20_000, `sub-minimum source was rescaled before inlining (got ${inlinedChars} chars)`);
  }, { MOCK_FAL_TXT_PAYLOAD_BYTES: "3072" });
});

test("/api/genai fal raises an odd-aspect source to the floor with the aspect and 64-alignment intact", async () => {
  // Portrait source (768x1024, aspect 0.75) varied under a small box: the
  // fit lands at 192x256, far under the floor, so the SOURCE shape is scaled
  // up instead — the box's own shape would be wrong to stretch to, and the
  // already-snapped fit would compound its rounding error.
  await withFal({
    GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
    GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
    GENAI_WIDTH: "768",
    GENAI_HEIGHT: "1024",
    // Ceiling off: this box is 0.79 MP and would otherwise be capped before the
    // floor is reached, which is a different test (the fit unit tests own it).
    GENAI_MAX_REQUEST_PIXELS: "0"
  }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a portrait Klein source", count: 1, seed: 3 })
    });
    assert.equal(gen.status, 200);
    const parent = (await gen.json()).items[0].genai.id;

    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_WIDTH: 320, GENAI_HEIGHT: 256 } })
    });
    assert.equal(put.status, 200);

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 1, seed: 3 })
    });
    assert.equal(vary.status, 200);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const edit = log.requests.find((request) => request.path === "/fal-ai/flux-2/klein/4b/edit");
    // upscale = max(640/768, 512/1024) = 0.8333 -> 640 x 853.3, snapped to the
    // nearest multiple of 64 (Draw Things crashed on a non-64 size) = 640x832.
    const size = edit.body.image_size;
    assert.deepEqual(size, { width: 640, height: 832 });
    assert.ok(size.width >= 640 && size.height >= 512, "both axes clear Fal's minimum");
    assert.equal(size.width % 64, 0);
    assert.equal(size.height % 64, 0);
    // 0.769 vs the source's 0.75: the only distortion is the 64 grid itself.
    assert.ok(Math.abs((size.width / size.height) - (768 / 1024)) < 0.03, "aspect is preserved, not squared off");
  });
});

test("/api/genai fal Klein edit fits a differently-shaped source inside the box instead of stretching it", async () => {
  // Reproduces a live bug shape offline: generate a source at one
  // (rectangular) box, then shrink the configured box to a squarer one before
  // varying. The stored source's real aspect ratio (measured from the mock's
  // baked PNG bytes, not trusted metadata) then differs from the new box, so
  // the Klein edit request must fit-not-stretch: preserve aspect, never
  // upscale past the box, snap to a multiple of 64. Both boxes sit above Fal's
  // 640x512 floor so this exercises the fit, not the floor (raising a
  // below-minimum box is covered by its own test above).
  await withFal({
    GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
    GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
    GENAI_WIDTH: "1024",
    GENAI_HEIGHT: "768",
    // Both boxes here are over the 589824 area ceiling, which would cap them
    // before the fit is visible. The ceiling has its own tests.
    GENAI_MAX_REQUEST_PIXELS: "0"
  }, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a 1024x768 Klein source", count: 1, seed: 7 })
    });
    assert.equal(gen.status, 200);
    const parent = (await gen.json()).items[0].genai.id;

    const genLog = await (await fetch(`${mock.base}/requests`)).json();
    const txt2img = genLog.requests.find((request) => request.path === "/fal-ai/flux-2/klein/4b");
    assert.deepEqual(txt2img.body.image_size, { width: 1024, height: 768 }, "a box above the floor is requested unchanged");

    // Shrink the box to a square before varying: the stored 1024x768 source
    // (aspect 1.333) no longer matches the (now 768x768, aspect 1) box.
    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_WIDTH: 768, GENAI_HEIGHT: 768 } })
    });
    assert.equal(put.status, 200);

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 1, seed: 7 })
    });
    assert.equal(vary.status, 200);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const edits = log.requests.filter((request) => request.path === "/fal-ai/flux-2/klein/4b/edit");
    assert.equal(edits.length, 1);
    // scale = min(768/1024, 768/768, 1) = 0.75 -> 1024*0.75=768, 768*0.75=576,
    // both already multiples of 64 (the step Draw Things crashed without).
    // Neither the untouched source (1024x768) nor the raw box (768x768) —
    // fitted inside it, not stretched to it.
    assert.deepEqual(edits[0].body.image_size, { width: 768, height: 576 }, "differently-shaped source is fitted inside the box, not stretched to it");
  });
});

test("/api/genai fal rejects a mixed FLUX.2 Klein model pair before calling Fal", async () => {
  await withFal({
    GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
    GENAI_FAL_IMAGE_MODEL: "img2img"
  }, async ({ server, mock }) => {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "mismatched Klein config", count: 1 })
    });
    assert.equal(res.status, 501);
    const json = await res.json();
    assert.match(json.error, /requires paired Fal models/i);
    const log = await (await fetch(`${mock.base}/requests`)).json();
    assert.equal(log.requests.length, 0, "no paid provider call for invalid pair");
  });
});

test("/api/genai/source/import rejects blocked targets and disabled emoji variations", async () => {
  await withA1111({}, async ({ server }) => {
    const blocked = await fetch(`${server.base}/api/genai/source/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: "http://127.0.0.1/private.png", mode: "image_search", query: "test" })
    });
    assert.equal(blocked.status, 400, "selected image import keeps SSRF protections");
    const blockedJson = await blocked.json();
    assert.match(blockedJson.error, /blocked address/i);
  });

  await withA1111({ GENAI_VARY_MODIFIER_MODE: "off" }, async ({ server }) => {
    const disabled = await fetch(`${server.base}/api/genai/source/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: "https://example.com/image.png", mode: "url" })
    });
    assert.equal(disabled.status, 400);
    const disabledJson = await disabled.json();
    assert.match(disabledJson.error, /Emoji variations are disabled/i);
  });
});

// Test-target note (same reasoning as the header comment in
// contract_extract.test.mjs and server/images.js): the target URL this route
// downloads is untrusted client input, not an operator-configured provider
// endpoint, so it gets the full SSRF guard with no loopback/private-address
// exemption. That makes two things structurally unreachable from an HTTP
// contract test with a local fixture:
//   - the 201 happy path (accepts a raster, returns source.genai.id + prompt)
//   - the GENAI_SOURCE_IMPORT_MAX_BYTES download-cap 413, which only fires
//     after a real upstream fetch succeeds
// Both are covered elsewhere instead: the raster inspection/resize pipeline
// (including "oversized" photos, which are RESIZED on import rather than
// rejected — see fitImageSizeToBox) is unit-tested directly against
// server/images.js in scripts/genai_source_import.test.mjs; the full client
// round-trip through this route is exercised (with the route's response
// mocked, since it must stay hermetic) by the opt-in desktop smoke in
// scripts/emoji_variation_desktop.test.mjs (EMOJI_VARIATION_E2E=1).
//
// What IS reachable here, and covered below: the field-validation and
// GenAI-not-configured guards that fire before any network fetch, plus (in
// the test above) the SSRF guard itself and the disabled-variations guard.
test("/api/genai/source/import rejects missing fields and non-http(s) URLs before any network fetch", async () => {
  await withA1111({}, async ({ server }) => {
    const missingBoth = await fetch(`${server.base}/api/genai/source/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingBoth.status, 400);
    assert.match((await missingBoth.json()).error, /missing selected image or source mode/i);

    const missingMode = await fetch(`${server.base}/api/genai/source/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: "https://example.com/image.png" })
    });
    assert.equal(missingMode.status, 400);
    assert.match((await missingMode.json()).error, /missing selected image or source mode/i);

    // These do not merely fail an allowlist check: a scheme other than
    // http(s) never reaches the DNS/SSRF stage at all. normalizeUrl only
    // recognizes a leading "http://"/"https://"; anything else gets
    // "https://" blindly prepended, and for these two schemes that produces
    // a syntactically invalid URL (no parseable host), so normalizeUrl
    // returns null deterministically rather than resolving a mangled
    // hostname (which would make the test depend on DNS behavior).
    for (const nonHttpUrl of ["javascript:alert(1)", "data:image/png;base64,AAAA"]) {
      const res = await fetch(`${server.base}/api/genai/source/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageUrl: nonHttpUrl, mode: "url" })
      });
      assert.equal(res.status, 400, `${nonHttpUrl} must be rejected`);
      assert.match((await res.json()).error, /missing or invalid selected image url/i);
    }
  });
});

test("/api/genai/source/import 501s when GenAI is not configured, before validating the target URL", async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.base}/api/genai/source/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: "https://example.com/image.png", mode: "url" })
    });
    assert.equal(res.status, 501);
    assert.match((await res.json()).error, /GenAI is not configured/i);
  } finally {
    await server.stop();
  }
});

test("/api/genai fal vary: oversized source -> 413 GenAI error, no img2img call", async () => {
  // Force the txt2img output past the 4 MB (default) FAL_VARY_MAX_SOURCE_BYTES
  // cap via the mock's payload knob. The stored source then exceeds the cap, so
  // the vary must be rejected BEFORE any img2img request is inlined/sent.
  await withFal({}, async ({ server, mock }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "an oversized fal source", count: 1 })
    });
    assert.equal(gen.status, 200);
    const parent = (await gen.json()).items[0].genai.id;

    await fetch(`${mock.base}/__reset`, { method: "POST" });
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 2 })
    });
    assert.equal(vary.status, 413, "oversized source rejected with 413-style status");
    const json = await vary.json();
    assert.match(json.error, /source image too large for hosted vary/i);

    const log = await (await fetch(`${mock.base}/requests`)).json();
    const img2img = log.requests.filter((r) => r.path === "/img2img");
    assert.equal(img2img.length, 0, "no img2img call once the source is over the cap");
  }, { MOCK_FAL_TXT_PAYLOAD_BYTES: String(6 * 1024 * 1024) });
});

// GENAI_DELIVERY_WEBP_QUALITY changes the response only. The mock's image is
// too small for WebP to beat, so the encoder itself is tested in-process.
test("/api/genai/image: without a WebP Accept, the original bytes are served", async () => {
  await withA1111({ GENAI_DELIVERY_WEBP_QUALITY: "85" }, async ({ server }) => {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a glowing tunnel", count: 1 })
    });
    const { items } = await res.json();
    const plain = await fetch(`${server.base}${items[0].imageUrl}`, { headers: { accept: "*/*" } });
    assert.equal(plain.headers.get("content-type"), "image/png");
    const saved = fs.readFileSync(path.join(server.generatedImagesDir, fs.readdirSync(server.generatedImagesDir)[0]));
    assert.deepEqual(Buffer.from(await plain.arrayBuffer()), saved);

    const browser = await fetch(`${server.base}${items[0].imageUrl}`, { headers: { accept: "image/avif,image/webp,*/*" } });
    assert.equal(browser.status, 200);
    // Appended, so the CORS middleware's Origin survives alongside it.
    assert.deepEqual(browser.headers.get("vary").split(/,\s*/).map((v) => v.toLowerCase()).sort(), ["accept", "origin"]);
    assert.equal(browser.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.match(browser.headers.get("content-type"), /^image\/(webp|png)$/);
  });
});

test("encodeWebpForDelivery: smaller WebP, or null rather than a throw", async () => {
  const { default: sharp } = await import("sharp");
  const { encodeWebpForDelivery, detectRasterImage } = await import("../server/images.js");
  const png = await sharp({
    create: { width: 256, height: 256, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 30 } }
  }).png().toBuffer();
  const webp = await encodeWebpForDelivery(png, 85);
  assert.ok(webp && webp.length < png.length);
  assert.deepEqual(detectRasterImage(webp), { contentType: "image/webp", width: 256, height: 256 });
  assert.equal(await encodeWebpForDelivery(Buffer.from("not an image"), 85), null);
});

async function postGenAi(server, body) {
  const res = await fetch(`${server.base}/api/genai`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

async function txt2imgCalls(mock) {
  const log = await (await fetch(`${mock.base}/requests`)).json();
  return log.requests.filter((r) => r.path === "/sdapi/v1/txt2img").length;
}

async function waitForPromptCacheStored(server, stored) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const live = await (await fetch(`${server.base}/admin/live.json`)).json();
    if (live.genaiPromptCache.stored >= stored) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("prompt cache never stored the batch");
}

test("/api/genai prompt cache: off by default, an identical prompt is generated again", async () => {
  await withA1111({}, async ({ server, mock }) => {
    await postGenAi(server, { prompt: "a quiet harbour", count: 2 });
    const second = await postGenAi(server, { prompt: "a quiet harbour", count: 2 });
    assert.equal(second.json.meta.cached, false);
    assert.equal(await txt2imgCalls(mock), 4, "the provider is called once per image");
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.genaiPromptCache.enabled, false);
  });
});

test("/api/genai prompt cache: an identical prompt is served from disk, across a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-prompt-cache-"));
  try {
    let firstSeeds;
    await withA1111({ GENAI_PROMPT_CACHE_DIR: dir }, async ({ server, mock }) => {
      const first = await postGenAi(server, { prompt: "a quiet harbour", count: 2 });
      assert.equal(first.json.meta.cached, false);
      firstSeeds = first.json.items.map((item) => item.genai.seed);
      await waitForPromptCacheStored(server, 1);

      const second = await postGenAi(server, { prompt: "a quiet harbour", count: 2 });
      assert.equal(second.status, 200);
      assert.equal(second.json.meta.cached, true);
      assert.deepEqual(second.json.items.map((item) => item.genai.seed), firstSeeds);
      assert.equal(second.json.items[0].genai.prompt, "a quiet harbour");
      const image = await fetch(`${server.base}${second.json.items[0].imageUrl}`);
      assert.equal(image.status, 200);

      // A different prompt, a different count and a variation all miss.
      const other = await postGenAi(server, { prompt: "a loud harbour", count: 2 });
      assert.equal(other.json.meta.cached, false);
      const three = await postGenAi(server, { prompt: "a quiet harbour", count: 3 });
      assert.equal(three.json.meta.cached, false);
      const vary = await postGenAi(server, { source: { id: first.json.items[0].genai.id }, count: 2 });
      assert.equal(vary.json.meta.cached, false);
      assert.equal(await txt2imgCalls(mock), 7, "2 + 2 + 3 images bought; the repeat bought none");
    });

    await withA1111({ GENAI_PROMPT_CACHE_DIR: dir }, async ({ server, mock }) => {
      const afterRestart = await postGenAi(server, { prompt: "a quiet harbour", count: 2 });
      assert.equal(afterRestart.json.meta.cached, true);
      assert.deepEqual(afterRestart.json.items.map((item) => item.genai.seed), firstSeeds);
      assert.equal(await txt2imgCalls(mock), 0);
    });
    const names = fs.readdirSync(path.join(dir, "batches")).join(" ");
    const manifests = fs.readdirSync(path.join(dir, "batches"))
      .map((name) => fs.readFileSync(path.join(dir, "batches", name), "utf8")).join(" ");
    assert.doesNotMatch(`${names} ${manifests}`, /harbour/, "the prompt text is not written to disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/genai prompt cache: an expired batch is generated again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-prompt-cache-"));
  try {
    await withA1111({ GENAI_PROMPT_CACHE_DIR: dir, GENAI_PROMPT_CACHE_TTL_MS: "1" }, async ({ server, mock }) => {
      await postGenAi(server, { prompt: "a quiet harbour", count: 1 });
      await waitForPromptCacheStored(server, 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await postGenAi(server, { prompt: "a quiet harbour", count: 1 });
      assert.equal(second.json.meta.cached, false);
      assert.equal(await txt2imgCalls(mock), 2);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/genai prompt cache: an async job stores its batch and the repeat arrives complete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-prompt-cache-"));
  try {
    await withA1111({ GENAI_PROMPT_CACHE_DIR: dir }, async ({ server, mock }) => {
      const first = await postGenAi(server, { prompt: "a quiet harbour", count: 2, async: true });
      assert.equal(first.status, 202);
      await waitForPromptCacheStored(server, 1);

      const second = await postGenAi(server, { prompt: "a quiet harbour", count: 2, async: true });
      assert.equal(second.status, 202);
      assert.equal(second.json.status, "complete");
      assert.equal(second.json.items.length, 2);
      assert.equal(second.json.meta.cached, true);
      assert.equal(await txt2imgCalls(mock), 2);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/genai: a provider image URL that serves a page is never served as one", async () => {
  // The stored type used to be the provider's own header, served from the app's
  // origin: an HTML (or SVG) "image" there would run script as the app.
  const http = await import("node:http");
  const provider = http.createServer((req, res) => {
    if (req.url === "/gen") {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ images: [`http://127.0.0.1:${provider.address().port}/img`] }));
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><body><script>document.title='pwned'</script></body></html>");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const server = await startServer({
    GENAI_PROVIDER: "custom",
    GENAI_ENDPOINT: `http://127.0.0.1:${provider.address().port}/gen`
  });
  try {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a red apple", count: 1 })
    });
    const body = await res.json();
    for (const item of body.items || []) {
      const image = await fetch(`${server.base}${item.imageUrl}`);
      assert.doesNotMatch(image.headers.get("content-type") || "", /html|svg/);
    }
    assert.ok(!res.ok || !(body.items || []).length, "the page is refused rather than stored");
  } finally {
    await server.stop();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("GENAI_PROGRESS_JOBS_MAX: free cache replays cannot evict another visitor's running job", async () => {
  // Eviction used to be oldest-first whatever the status, so a stream of free
  // cache replays pushed live jobs out and their polls went 410.
  await withA1111({ GENAI_PROGRESS_JOBS_MAX: "5" }, async ({ server }) => {
    const post = (body, client) => fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-genai-client-id": client },
      body: JSON.stringify(body)
    }).then((res) => res.json());
    const seed = await post({ prompt: "attacker seed", count: 1 }, "attacker");
    assert.ok(seed.meta?.genaiCacheKey, "a cache key to replay");

    const victim = await post({ prompt: "victim prompt", count: 3, async: true }, "victim");
    assert.match(victim.jobId, /^gj_/);
    for (let i = 0; i < 8; i += 1) {
      await post({ cacheKey: seed.meta.genaiCacheKey, async: true }, `attacker-${i}`);
    }
    const poll = await fetch(`${server.base}/api/genai/job/${victim.jobId}`);
    assert.equal(poll.status, 200, "the running job is still there");
  }, { MOCK_SDAPI_DELAY_MS: "1500" });
});
