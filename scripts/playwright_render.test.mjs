// The Playwright fallback's network lockdown (server/playwright-render.js).
//
// The unit tests run by default. The real-Chromium test is opt-in
// (RENDER_E2E=1) like the other Playwright tests; it is offline and takes a
// few seconds. It launches Chromium with the production lockdown flags, so
// Chromium cannot resolve or dial anything itself: every byte the page gets
// must come from the test's fetchUpstream, which pins hostnames to a loopback
// fixture the same way createPinnedDispatcher() does.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Agent as UndiciAgent } from "undici";
import {
  CHROMIUM_LAUNCH_OPTIONS,
  CONTEXT_LOCKDOWN_OPTIONS,
  createSharedBrowser,
  requestHeadersForUpstream,
  responseHeadersForFulfil,
  routeContextThroughNode,
  withRenderDeadline,
  RenderTimeoutError
} from "../server/playwright-render.js";
import { encodePng } from "./png.mjs";

const SERVER_SOURCE = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const E2E = process.env.RENDER_E2E === "1";

test("server wiring: the fallback fulfils from Node, never route.continue()s to the network", () => {
  const start = SERVER_SOURCE.indexOf("async function extractViaPlaywright");
  const body = SERVER_SOURCE.slice(start, SERVER_SOURCE.indexOf("\nconst ", start));
  assert.ok(start > 0);
  assert.doesNotMatch(body, /route\.continue|chromium\.launch\(/);
  assert.match(body, /routeContextThroughNode\(context, \{\s*fetchUpstream: fetchForRender/);
  assert.match(body, /CONTEXT_LOCKDOWN_OPTIONS/);
  assert.match(SERVER_SOURCE, /chromium\.launch\(CHROMIUM_LAUNCH_OPTIONS\)/);
  // fetchForRender goes through the pinned, per-hop-validated fetch.
  assert.match(SERVER_SOURCE, /async function fetchForRender[\s\S]{0,200}fetchWithTimeout\(/);
});

test("lockdown options: no DNS, no WebRTC UDP, no service workers, no signal takeover", () => {
  assert.ok(CHROMIUM_LAUNCH_OPTIONS.args.includes("--host-resolver-rules=MAP * ~NOTFOUND"));
  assert.ok(CHROMIUM_LAUNCH_OPTIONS.args.some((arg) => arg.startsWith("--force-webrtc-ip-handling-policy=")));
  assert.equal(CONTEXT_LOCKDOWN_OPTIONS.serviceWorkers, "block");
  assert.equal(CHROMIUM_LAUNCH_OPTIONS.handleSIGTERM, false);
  // Page script runs in this browser: keep its sandbox, and keep the keys out.
  assert.equal(CHROMIUM_LAUNCH_OPTIONS.chromiumSandbox, true);
  for (const key of Object.keys(CHROMIUM_LAUNCH_OPTIONS.env)) {
    assert.doesNotMatch(key, /KEY|TOKEN|SECRET|PASSWORD/i);
  }
});

test("headers: hop-by-hop and encoding headers are dropped both ways", () => {
  assert.deepEqual(
    requestHeadersForUpstream({
      Host: "x", "Accept-Encoding": "br", Connection: "keep-alive", "If-None-Match": "\"a\"",
      Accept: "image/*", Referer: "https://a.example/", Cookie: "a=1"
    }),
    { accept: "image/*", referer: "https://a.example/", cookie: "a=1" }
  );
  const upstream = new Headers([
    ["content-type", "image/png"], ["content-encoding", "gzip"], ["content-length", "10"],
    ["transfer-encoding", "chunked"], ["set-cookie", "a=1"], ["set-cookie", "b=2"]
  ]);
  assert.deepEqual(responseHeadersForFulfil(upstream), { "content-type": "image/png", "set-cookie": "a=1\nb=2" });
});

function fakeBrowser() {
  const browser = new EventEmitter();
  browser.connected = true;
  browser.closed = 0;
  browser.isConnected = () => browser.connected;
  browser.close = async () => {
    browser.closed += 1;
    browser.connected = false;
    browser.emit("disconnected");
  };
  return browser;
}

test("shared browser: one launch for racing renders, relaunch after a crash, close when idle", async () => {
  const launched = [];
  const shared = createSharedBrowser({
    idleMs: 30,
    launch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const browser = fakeBrowser();
      launched.push(browser);
      return browser;
    }
  });

  const [a, b] = await Promise.all([shared.acquire(), shared.acquire()]);
  assert.equal(a, b);
  assert.equal(launched.length, 1, "two concurrent renders share one launch");
  shared.release();
  shared.release();

  // A crash (disconnect) between renders forces a fresh launch.
  const c = await shared.acquire();
  assert.equal(c, a, "reused while idle timer is pending");
  c.connected = false;
  c.emit("disconnected");
  shared.release();
  const d = await shared.acquire();
  assert.notEqual(d, c);
  assert.equal(launched.length, 2);

  // Held: the idle timer does not close it.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(d.closed, 0);
  shared.release();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(d.closed, 1, "closed after idleMs with no holder");
  assert.equal(shared.running, false);

  // A failed launch is not cached.
  let fail = true;
  const flaky = createSharedBrowser({
    launch: async () => {
      if (fail) {
        throw new Error("no chromium");
      }
      return fakeBrowser();
    }
  });
  await assert.rejects(flaky.acquire(), /no chromium/);
  fail = false;
  const ok = await flaky.acquire();
  assert.ok(ok.isConnected());
  flaky.release();
  await flaky.close();
});

test("render deadline: rejects with a clear error and runs the cleanup", async () => {
  let cleaned = false;
  let sawExpired = false;
  await assert.rejects(
    withRenderDeadline(async (deadline) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      sawExpired = deadline.expired;
    }, 20, () => {
      cleaned = true;
    }),
    (err) => err instanceof RenderTimeoutError && /timed out after 20 ms/.test(err.message)
  );
  assert.equal(cleaned, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sawExpired, true);
  assert.equal(await withRenderDeadline(async () => 7, 1000, () => {}), 7);
});

// --- real Chromium -------------------------------------------------------

class PolicyError extends Error {}

const PNG = encodePng(4, 4, Buffer.alloc(4 * 4 * 3, 180));
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

async function startFixture() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method, viaNode: req.headers["x-via-node"] === "1" });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/page" });
      res.end();
    } else if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>fixture</title>
        <img id="pinned" src="http://img.pinned.test:${server.address().port}/a.png">
        <img id="inline" src="${PNG_DATA_URL}">
        <img id="blocked" src="http://blocked.test:${server.address().port}/b.png">`);
    } else if (req.url === "/hostile") {
      // Runs before any extraction: tries to unbind the clip, patches the
      // intrinsics it relies on, and grows the title past anything sane.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title><script>
        try { window.__sbClip = null; } catch {}
        try { Object.defineProperty(window, "__sbClip", { value: null }); } catch {}
        String.prototype.slice = function () { return "x".repeat(1e6); };
        Reflect.apply = () => "x".repeat(1e6);
        document.title = "y".repeat(5e6);
      </script>`);
    } else if (req.url === "/a.png" || req.url === "/b.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  let upgrades = 0;
  server.on("upgrade", (_req, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    hits,
    port: server.address().port,
    get upgrades() {
      return upgrades;
    },
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

// The test's stand-in for fetchForRender: *.test pins to 127.0.0.1, blocked.test
// is refused, and redirects are followed hop by hop in Node.
function pinnedUpstream(calls) {
  const dispatcher = new UndiciAgent({
    connect: { lookup: (_host, _opts, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) }
  });
  return async (url, { method, headers, body }) => {
    let next = url;
    for (let hop = 0; hop < 5; hop += 1) {
      calls.push(next);
      if (new URL(next).hostname === "blocked.test") {
        throw new PolicyError(`blocked: ${next}`);
      }
      const response = await fetch(next, {
        method, body, redirect: "manual", dispatcher,
        headers: { ...headers, "x-via-node": "1" }
      });
      if (response.status >= 300 && response.status < 400) {
        next = new URL(response.headers.get("location"), next).toString();
        continue;
      }
      return { url: next, status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
    }
    throw new PolicyError("too many redirects");
  };
}

test("real Chromium: sub-requests are answered from Node's pinned fetch; blocked and direct traffic never lands", {
  skip: E2E ? false : "set RENDER_E2E=1 to run (needs the Playwright Chromium)"
}, async () => {
  const { chromium } = await import("playwright");
  const fixture = await startFixture();
  const shared = createSharedBrowser({ idleMs: 1000, launch: () => chromium.launch(CHROMIUM_LAUNCH_OPTIONS) });
  const browser = await shared.acquire();
  const context = await browser.newContext(CONTEXT_LOCKDOWN_OPTIONS);
  try {
    const calls = [];
    const routing = await routeContextThroughNode(context, { fetchUpstream: pinnedUpstream(calls) });
    const page = await context.newPage();
    const site = `http://site.test:${fixture.port}`;

    // A redirect is followed in Node; the second goto lands on the final URL
    // and is served from the kept response.
    routing.expectGoto();
    await assert.rejects(page.goto(`${site}/redirect`));
    assert.equal(routing.redirectTo, `${site}/page`);
    const finalUrl = routing.redirectTo;
    const fetchesBefore = calls.length;
    routing.expectGoto();
    await page.goto(finalUrl, { waitUntil: "load" });
    assert.ok(!calls.slice(fetchesBefore).includes(finalUrl), "the final page is not fetched twice");
    assert.equal(page.url(), `${site}/page`);
    assert.equal(await page.title(), "fixture");

    const sizes = await page.evaluate(() => Object.fromEntries(
      [...document.images].map((img) => [img.id, img.naturalWidth])
    ));
    assert.deepEqual(sizes, { pinned: 4, inline: 4, blocked: 0 });

    // Traffic that bypasses page.route: a hostname or an IP literal both fail
    // in Chromium's own resolver, WebSocket is routed and closed.
    const escapes = await page.evaluate(async (port) => {
      const tryFetch = (url) => fetch(url).then(() => "reached", () => "failed");
      const ws = await new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
        socket.onopen = () => resolve("open");
        socket.onclose = () => resolve("closed");
        setTimeout(() => resolve("timeout"), 3000);
      });
      return { literal: await tryFetch(`http://127.0.0.1:${port}/direct`), ws };
    }, fixture.port);
    assert.equal(escapes.ws, "closed");
    // fetch() to an IP literal still goes through the route (and Node), so the
    // proof is that the fixture only ever saw requests that Node made.
    assert.ok(fixture.hits.length > 0);
    assert.deepEqual(fixture.hits.filter((hit) => !hit.viaNode), [], "nothing reached the fixture except via Node");
    assert.equal(fixture.upgrades, 0, "no WebSocket upgrade reached the fixture");
    assert.ok(!fixture.hits.some((hit) => hit.url === "/b.png"), "the blocked host was never fetched");
    assert.ok(calls.some((url) => url.startsWith("http://img.pinned.test")));
    assert.equal(escapes.literal, "reached");

    // A blocked top-level navigation is reported, not loaded.
    routing.expectGoto();
    await assert.rejects(page.goto(`http://blocked.test:${fixture.port}/page`));
    assert.ok(routing.navigationError instanceof PolicyError);
  } finally {
    await context.close();
    shared.release();
    await shared.close();
    await fixture.stop();
  }
});

test("real Chromium: page scripts cannot unbind or defeat the clip, and non-GET requests never leave", {
  skip: E2E ? false : "set RENDER_E2E=1 to run (needs the Playwright Chromium)"
}, async () => {
  const { chromium } = await import("playwright");
  const fixture = await startFixture();
  const shared = createSharedBrowser({ idleMs: 1000, launch: () => chromium.launch(CHROMIUM_LAUNCH_OPTIONS) });
  const browser = await shared.acquire();
  const context = await browser.newContext(CONTEXT_LOCKDOWN_OPTIONS);
  try {
    const routing = await routeContextThroughNode(context, { fetchUpstream: pinnedUpstream([]) });
    const page = await context.newPage();
    routing.expectGoto();
    await page.goto(`http://site.test:${fixture.port}/hostile`, { waitUntil: "load" });
    const clipped = await page.evaluate(() => {
      const clip = window.__sbClip;
      return { type: typeof clip, title: clip(document.title, 1000).length, other: clip({ toString: () => "z" }, 10) };
    });
    assert.deepEqual(clipped, { type: "function", title: 1000, other: "" });

    const posted = await page.evaluate((port) => fetch(`http://site.test:${port}/a.png`, { method: "POST", body: "spam" })
      .then(() => "reached", () => "failed"), fixture.port);
    assert.equal(posted, "failed");
    assert.deepEqual(fixture.hits.filter((hit) => hit.method !== "GET"), [], "no POST reached the fixture");
  } finally {
    await context.close();
    shared.release();
    await shared.close();
    await fixture.stop();
  }
});

test("real Chromium: with nothing routed, the launch flags alone stop direct connections", {
  skip: E2E ? false : "set RENDER_E2E=1 to run (needs the Playwright Chromium)"
}, async () => {
  const { chromium } = await import("playwright");
  const fixture = await startFixture();
  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  try {
    const page = await browser.newPage();
    for (const target of [`http://127.0.0.1:${fixture.port}/page`, `http://localhost:${fixture.port}/page`]) {
      await assert.rejects(page.goto(target, { timeout: 5000 }), /ERR_NAME_NOT_RESOLVED/);
    }
    assert.equal(fixture.hits.length, 0);
  } finally {
    await browser.close();
    await fixture.stop();
  }
});
