// Contract tests for the daily spend caps and the operator kill switch.
//
// The unit tests in spend_guard.test.mjs cover the counter itself; these prove
// the wiring — that the caps are reserved on the real paid routes, that the
// refusal is a 429 the client can already render, that a kill switch file 503s
// both paid endpoints with no restart, and that a cached search neither calls
// the provider nor spends quota.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, startMockSdapi, startImageSearchMock, findFreePort } from "./contract_helpers.mjs";
import { encodePng } from "./png.mjs";

// The build line is read from the checkout's .git directory. A copy of the
// source without one (a release archive, a linked worktree) has no commit to
// report, so the two tests about it do not apply there.
const HAS_GIT_DIR = fs.existsSync(path.join(import.meta.dirname, "..", "..", "..", ".git", "HEAD"));

// Blank the spend vars so a developer's server/.env cannot arm a cap mid-test.
const CLEAN = {
  GENAI_DAILY_IMAGE_CAP: "",
  GENAI_DAILY_IMAGES_PER_IP: "",
  SEARCH_DAILY_QUERY_CAP: "",
  SEARCH_DAILY_QUERIES_PER_IP: "",
  SPEND_STATE_PATH: "",
  KILL_SWITCH_PATH: "",
  KILL_SWITCH_CACHE_MS: "",
  SEARCH_CACHE_MAX: "",
  SEARCH_CACHE_TTL_MS: ""
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-spend-e2e-"));
}

function genai(server, body) {
  return fetch(`${server.base}/api/genai`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("/api/health names the commit it is serving", { skip: !HAS_GIT_DIR }, async () => {
  // The first question when a device report and the working tree disagree:
  // which commit is being served.
  const server = await startServer({ ...CLEAN });
  try {
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.ok(health.build, "health must carry a build block");
    // Read from the git plumbing FILES, not by running git: the checkout is
    // root-owned while the service runs as `surface`, and git refuses a repo it
    // does not own. A subprocess would pass here and fail in production.
    assert.match(health.build.commit, /^[0-9a-f]{7}$/, "a short sha");
    assert.equal(typeof health.build.branch, "string");
    // TWO commits, and the distinction matters. `commit` is the CHECKOUT (what
    // the client was built from) and is re-read, because a client-only deploy
    // does not restart Node. `running` is what the process booted at.
    assert.match(health.build.running, /^[0-9a-f]{7}$/, "the running process's sha");
    assert.equal(health.build.commit, health.build.running,
      "a server just started has not had time to diverge");
  } finally {
    await server.stop();
  }
});

test("the checkout sha is re-read, not frozen at boot", { skip: !HAS_GIT_DIR }, async () => {
  const serverSource = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  // The boot value must stay a constant, and the checkout value must not be one.
  assert.match(serverSource, /const GIT_BUILD_AT_BOOT = readGitBuild\(\);/);
  assert.match(serverSource, /function currentGitBuild\(now = Date\.now\(\)\)/);
  // Cached, because /api/health is polled and two file reads per request is
  // waste — but briefly, because a deploy must show up in seconds.
  assert.match(serverSource, /GIT_BUILD_CACHE_MS = 5000/);
  assert.match(serverSource, /build: \{ \.\.\.currentGitBuild\(\), running: GIT_BUILD_AT_BOOT\.commit \}/);
  const server = await startServer({ ...CLEAN });
  try {
    assert.ok((await (await fetch(`${server.base}/api/health`)).json()).build.commit);
  } finally {
    await server.stop();
  }
});

test("/api/health publishes whether image-list rows are links", async () => {
  const server = await startServer({ ...CLEAN });
  try {
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.imageList.links, true, "dev default keeps the rows clickable");
  } finally {
    await server.stop();
  }
});

test("GENAI_IMAGE_LIST_LINKS=0 reaches the client", async () => {
  // A generated image's URL addresses one specific image; off, the rows are
  // readable but not shareable.
  const server = await startServer({ ...CLEAN, GENAI_IMAGE_LIST_LINKS: "0" });
  try {
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.imageList.links, false);
    assert.equal(health.imageList.enabled, true, "the two switches are independent");
  } finally {
    await server.stop();
  }
});

test("GENAI_DAILY_IMAGE_CAP: the global cap counts images and answers 429 budget/daily", async () => {
  const dir = tempDir();
  const mock = await startMockSdapi();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base,
    GENAI_DAILY_IMAGE_CAP: "4",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const first = await genai(server, { prompt: "otters", count: 3 });
    assert.equal(first.status, 200);

    // 3 spent, 4 capped: a 3-image request cannot fit, and the reservation is
    // taken before the provider is called, so nothing is billed.
    const refused = await genai(server, { prompt: "otters two", count: 3 });
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: "budget", scope: "daily" });

    // The remaining single image still goes through.
    const last = await genai(server, { prompt: "otters three", count: 1 });
    assert.equal(last.status, 200);
    assert.equal((await genai(server, { prompt: "otters four", count: 1 })).status, 429);
  } finally {
    await server.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GENAI_DAILY_IMAGES_PER_IP: a per-client cap answers 429 budget/ip", async () => {
  const dir = tempDir();
  const mock = await startMockSdapi();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base,
    GENAI_DAILY_IMAGES_PER_IP: "2",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    assert.equal((await genai(server, { prompt: "a", count: 2 })).status, 200);
    const refused = await genai(server, { prompt: "b", count: 1 });
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: "budget", scope: "ip" });
  } finally {
    await server.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/admin/live shows who is capped, and a reset frees that client", async () => {
  const dir = tempDir();
  const mock = await startMockSdapi();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base,
    GENAI_DAILY_IMAGES_PER_IP: "2",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  const reset = (body) => fetch(`${server.base}/api/admin/quota/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    assert.equal((await genai(server, { prompt: "a", count: 2 })).status, 200);
    const { quota } = await (await fetch(`${server.base}/admin/live.json`)).json();
    assert.equal(quota.genai.used, 2);
    const [client] = quota.genai.clients;
    assert.deepEqual([client.used, client.limit], [2, 2]);
    assert.equal((await genai(server, { prompt: "b", count: 1 })).status, 429);

    const freed = await reset({ scope: "genai", key: client.key });
    assert.equal(freed.status, 200);
    assert.equal((await freed.json()).quota.genai.used, 0);
    assert.equal((await genai(server, { prompt: "b", count: 1 })).status, 200);
    assert.equal((await reset({ scope: "nope" })).status, 400);
  } finally {
    await server.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing provider releases the reservation instead of burning quota", async () => {
  const dir = tempDir();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    // A port with nothing on it: the request fails before any image exists.
    GENAI_ENDPOINT: "http://127.0.0.1:1",
    GENAI_DAILY_IMAGE_CAP: "2",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const failed = await genai(server, { prompt: "unreachable", count: 2 });
    assert.ok(failed.status >= 500, `provider failure surfaced (${failed.status})`);

    // Had the failure kept its reservation, the whole cap would be gone and
    // this would come back 429. It still fails (same dead endpoint) — but with
    // a 5xx, which is the proof that the quota came back.
    const retry = await genai(server, { prompt: "unreachable", count: 2 });
    assert.notEqual(retry.status, 429, "quota was released after the failure");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("genai: a fal response that answers 200 but fails to parse is billed, not refunded", async () => {
  const dir = tempDir();
  const http = await import("node:http");
  const port = await findFreePort();
  // fal said yes (200) before our own JSON.parse choked on it — a naive
  // handler would treat this identically to the connection-refused case above and
  // hand the quota back, but fal may already have run (and billed) the job.
  const badFal = http.default.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not actually json");
  });
  await new Promise((resolve) => badFal.listen(port, "127.0.0.1", resolve));
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "fal",
    FAL_KEY: "test-key",
    GENAI_FAL_BASE_URL: `http://127.0.0.1:${port}`,
    GENAI_DAILY_IMAGE_CAP: "2",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const broken = await genai(server, { prompt: "otters", count: 2 });
    assert.ok(broken.status >= 500, `malformed fal response surfaced as a failure (${broken.status})`);

    const next = await genai(server, { prompt: "otters two", count: 1 });
    assert.equal(next.status, 429, "quota was NOT refunded for a billed-but-unparsable response");
    assert.deepEqual(await next.json(), { error: "budget", scope: "daily" });
  } finally {
    await server.stop();
    await new Promise((resolve) => badFal.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("genai async job: a mid-batch 200-but-unparsable image is billed, not refunded", async () => {
  const dir = tempDir();
  const http = await import("node:http");
  const port = await findFreePort();
  let calls = 0;
  // The async progress job (startGenAiProgressJob) generates one image per
  // provider round-trip. The first call succeeds and is delivered; the second
  // says 200 (fal already billed it) but the body is not JSON, so it never
  // reaches job.items. The naive "release count minus delivered" refund would
  // hand that second credit back even though it was billed — the same trap as
  // the synchronous route above, hidden behind the per-image loop.
  const flakyFal = http.default.createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 3, 128));
      const body = JSON.stringify({ images: [{ url: `data:image/png;base64,${png.toString("base64")}` }], seed: 1 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not actually json");
  });
  await new Promise((resolve) => flakyFal.listen(port, "127.0.0.1", resolve));
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "fal",
    FAL_KEY: "test-key",
    GENAI_FAL_BASE_URL: `http://127.0.0.1:${port}`,
    GENAI_DAILY_IMAGE_CAP: "2",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const start = await genai(server, { prompt: "otters", count: 2, async: true });
    assert.equal(start.status, 202);
    let payload = await start.json();
    assert.match(payload.jobId, /^gj_/);

    for (let attempt = 0; attempt < 30 && payload.status !== "failed" && payload.status !== "complete"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await fetch(`${server.base}/api/genai/job/${payload.jobId}`);
      assert.equal(poll.status, 200);
      payload = await poll.json();
    }

    assert.equal(payload.status, "failed", payload.error || "the second image's bad body should fail the job");
    assert.equal(payload.items.length, 1, "the first image was delivered before the failure");

    // Both reserved credits are gone: one for the delivered image, one for the
    // billed-but-unparsable second call. If that second credit had been
    // refunded, this next single-image request would succeed instead of 429.
    const next = await genai(server, { prompt: "otters two", count: 1 });
    assert.equal(next.status, 429, "quota was NOT refunded for the billed-but-unparsable second image");
    assert.deepEqual(await next.json(), { error: "budget", scope: "daily" });
  } finally {
    await server.stop();
    await new Promise((resolve) => flakyFal.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("genai async job: a 200 whose body then stalls past the deadline is billed, not refunded", async () => {
  const dir = tempDir();
  const http = await import("node:http");
  const port = await findFreePort();
  let calls = 0;
  // The sibling test above covers a body that arrives and is garbage. This one
  // covers a body deadline: fal answers 200 (billed) and
  // then stops writing, so the abort fires DURING the body read. The failure
  // surfaces as an AbortError with the billing flag already set; treating
  // AbortError as "refund" would hand back an image fal already charged for. A user cancel is GenAiAbortError, not AbortError, so
  // this does not make cancelling expensive.
  const stallingFal = http.default.createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      const png = encodePng(8, 8, Buffer.alloc(8 * 8 * 3, 128));
      const body = JSON.stringify({ images: [{ url: `data:image/png;base64,${png.toString("base64")}` }], seed: 1 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    // Headers only, then silence: never end, never write another byte.
    res.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
    res.write("{");
  });
  await new Promise((resolve) => stallingFal.listen(port, "127.0.0.1", resolve));
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "fal",
    FAL_KEY: "test-key",
    GENAI_FAL_BASE_URL: `http://127.0.0.1:${port}`,
    GENAI_TIMEOUT_MS: "1500",
    REQUEST_TIMEOUT_MS: "1500",
    GENAI_DAILY_IMAGE_CAP: "2",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const start = await genai(server, { prompt: "otters", count: 2, async: true });
    assert.equal(start.status, 202);
    let payload = await start.json();

    for (let attempt = 0; attempt < 80 && payload.status !== "failed" && payload.status !== "complete"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const poll = await fetch(`${server.base}/api/genai/job/${payload.jobId}`);
      assert.equal(poll.status, 200);
      payload = await poll.json();
    }

    assert.equal(payload.status, "failed", payload.error || "the stalled body should fail the job");
    assert.equal(payload.items.length, 1, "the first image was delivered before the stall");

    const next = await genai(server, { prompt: "otters two", count: 1 });
    assert.equal(next.status, 429, "quota was NOT refunded for the billed-then-aborted second image");
    assert.deepEqual(await next.json(), { error: "budget", scope: "daily" });
  } finally {
    await server.stop();
    await new Promise((resolve) => stallingFal.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("search: a provider response that answers 200 but fails to parse is billed, not refunded", async () => {
  const dir = tempDir();
  const http = await import("node:http");
  const port = await findFreePort();
  const badSearch = http.default.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not actually json");
  });
  await new Promise((resolve) => badSearch.listen(port, "127.0.0.1", resolve));
  const server = await startServer({
    ...CLEAN,
    IMAGE_SEARCH_PROVIDER: "custom",
    IMAGE_SEARCH_ENDPOINT: `http://127.0.0.1:${port}/search`,
    SEARCH_DAILY_QUERY_CAP: "1",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const broken = await fetch(`${server.base}/api/search/images?q=otters`);
    assert.ok(broken.status >= 500, `malformed search response surfaced as a failure (${broken.status})`);

    const next = await fetch(`${server.base}/api/search/images?q=badgers`);
    assert.equal(next.status, 429, "quota was NOT refunded for a billed-but-unparsable response");
    assert.deepEqual(await next.json(), { error: "budget", scope: "daily" });
  } finally {
    await server.stop();
    await new Promise((resolve) => badSearch.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SEARCH_DAILY_QUERY_CAP: cache hits are free, new queries are not", async () => {
  const dir = tempDir();
  const mock = await startImageSearchMock();
  const server = await startServer({
    ...CLEAN,
    IMAGE_SEARCH_PROVIDER: "custom",
    IMAGE_SEARCH_ENDPOINT: mock.endpoint,
    SEARCH_DAILY_QUERY_CAP: "1",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const first = await fetch(`${server.base}/api/search/images?q=otters`);
    assert.equal(first.status, 200);

    // Same query again: served from the in-memory cache, so it must not count.
    const cached = await fetch(`${server.base}/api/search/images?q=otters`);
    assert.equal(cached.status, 200, "a repeat query is not a budget refusal");
    const cachedJson = await cached.json();
    assert.equal(cachedJson.sourceUrl, "image-search:otters");
    assert.ok(cachedJson.items.length >= 1);

    // A different query has to hit the provider and the day's single query is
    // already spent.
    const refused = await fetch(`${server.base}/api/search/images?q=badgers`);
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: "budget", scope: "daily" });
  } finally {
    await server.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kill switch: the file 503s both paid routes and lifts without a restart", async () => {
  const dir = tempDir();
  const killPath = path.join(dir, "KILL_SWITCH");
  fs.writeFileSync(killPath, "");
  const mock = await startMockSdapi();
  const searchMock = await startImageSearchMock();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base,
    IMAGE_SEARCH_PROVIDER: "custom",
    IMAGE_SEARCH_ENDPOINT: searchMock.endpoint,
    KILL_SWITCH_PATH: killPath,
    KILL_SWITCH_CACHE_MS: "50"
  });
  try {
    const killedGenai = await genai(server, { prompt: "otters", count: 1 });
    assert.equal(killedGenai.status, 503);
    assert.deepEqual(await killedGenai.json(), { error: "disabled" });

    const killedSearch = await fetch(`${server.base}/api/search/images?q=otters`);
    assert.equal(killedSearch.status, 503);
    assert.deepEqual(await killedSearch.json(), { error: "disabled" });

    // Health stays up so the server still looks alive to a monitor.
    const health = await fetch(`${server.base}/api/health`);
    assert.equal(health.status, 200);

    fs.rmSync(killPath);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await genai(server, { prompt: "otters", count: 1 })).status, 200);
    assert.equal((await fetch(`${server.base}/api/search/images?q=otters`)).status, 200);
  } finally {
    await server.stop();
    await mock.stop();
    await searchMock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spend state survives a restart: the budget is not refilled by a bounce", async () => {
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  const mock = await startMockSdapi();
  const env = {
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base,
    GENAI_DAILY_IMAGE_CAP: "2",
    SPEND_STATE_PATH: statePath,
    SPEND_PERSIST_DELAY_MS: "0"
  };
  const first = await startServer(env);
  try {
    assert.equal((await genai(first, { prompt: "otters", count: 2 })).status, 200);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !fs.existsSync(statePath)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(statePath), "state persisted");
  } finally {
    await first.stop();
  }

  const second = await startServer(env);
  try {
    const refused = await genai(second, { prompt: "otters", count: 1 });
    assert.equal(refused.status, 429, "today's spend is remembered across a restart");
  } finally {
    await second.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/health does not leak budget numbers", async () => {
  const dir = tempDir();
  const server = await startServer({
    ...CLEAN,
    GENAI_DAILY_IMAGE_CAP: "10",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    const body = await (await fetch(`${server.base}/api/health`)).text();
    assert.doesNotMatch(body, /budget|cap|spend|quota/i);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Cost control: the idle auto-advance suspension. The client
// decides when to stop, but only the server decides whether it may — an
// operator must be able to turn the piece into an unattended kiosk, or tighten
// the timeout, without shipping a new build.
test("/api/health publishes the idle auto-advance timeout", async () => {
  const server = await startServer({ ...CLEAN, AUTO_ADVANCE_IDLE_TIMEOUT_MS: "" });
  try {
    const body = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(
      body.autoAdvance?.idleTimeoutMs,
      300_000,
      "the shipped default suspends idle auto-advance; it must not be off by omission"
    );
  } finally {
    await server.stop();
  }
});

test("AUTO_ADVANCE_IDLE_TIMEOUT_MS=0 reaches the client as the kiosk opt-out", async () => {
  const server = await startServer({ ...CLEAN, AUTO_ADVANCE_IDLE_TIMEOUT_MS: "0" });
  try {
    const body = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(body.autoAdvance.idleTimeoutMs, 0);
  } finally {
    await server.stop();
  }
});

test("the budget refusal carries the scope the client needs to explain it", async () => {
  const dir = tempDir();
  const mock = await startMockSdapi();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_A1111_ENDPOINT: mock.base,
    GENAI_DAILY_IMAGES_PER_IP: "1",
    SPEND_STATE_PATH: path.join(dir, "spend-state.json")
  });
  try {
    await genai(server, { prompt: "otters", count: 1 });
    const refused = await genai(server, { prompt: "otters", count: 1 });
    assert.equal(refused.status, 429);
    const body = await refused.json();
    assert.equal(body.error, "budget");
    // Without this the client can only say "GenAI failed: budget", which reads
    // as a malfunction rather than as one visitor's daily share running out.
    assert.equal(body.scope, "ip");
  } finally {
    await server.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
