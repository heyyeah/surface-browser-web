// GenAI tunnel→sphere handoff regression guard.
//
// Guards against GenAI mode transitioning tunnel → sphere after only the FIRST
// generated image has loaded while generation is still in flight (late-arriving
// images would land on the already-formed sphere, stacking / alternating the
// sphere texture).
//
// The contract: keep the tunnel visible until the GenAI batch is COMPLETE (all N
// images); images append progressively to the TUNNEL; only then does the sphere
// form, with exactly N distinct panels. A time floor is optional theatrical polish
// and defaults to 0. Correctness is carried by explicit job progress: received,
// expected, done.
//
// OPT-IN (set GENAIE2E=1): it needs Playwright's chromium + a vite dev server +
// WebGL, so it is skipped by default to keep `npm test` offline and fast. It
// drives the REAL app (a1111 provider + the mock sdapi provider paced with
// MOCK_SDAPI_DELAY_MS so images arrive one at a time, like a real slow generator).
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findFreePort,
  startServer,
  startMockSdapi,
  waitForTcp,
  sleep,
  killProc
} from "./contract_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = path.resolve(__dirname, "..");
const ENABLED = process.env.GENAIE2E === "1";

const GENAI_COUNT = 6;
const SPHERE_IMAGE_COUNT = 8; // must match constants.js
const EXPECTED_SPHERE_PANELS = Math.min(GENAI_COUNT, SPHERE_IMAGE_COUNT);
// Per-image generation latency, so images demonstrably arrive one at a time
// across several client poll cycles (the client polls every 500 ms).
const PER_IMAGE_DELAY_MS = 800;

async function withApp(fn, { serverEnv = {} } = {}) {
  const { chromium } = await import("playwright");
  const sdapi = await startMockSdapi({ MOCK_SDAPI_DELAY_MS: String(PER_IMAGE_DELAY_MS) });
  const api = await startServer({
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: sdapi.base,
    GENAI_COUNT: String(GENAI_COUNT),
    GENAI_SAVE_IMAGES_TO_DISK: "false",
    ...serverEnv
  });
  const vitePort = await findFreePort();
  const vite = spawn(
    process.execPath,
    [path.join(MVP_ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(vitePort), "--strictPort"],
    { cwd: MVP_ROOT, env: { ...process.env, DEV: "1", VITE_API_TARGET: api.base }, stdio: "ignore" }
  );
  let browser;
  try {
    await waitForTcp(vitePort, 20000);
    // Software WebGL for headless: `--use-gl=swiftshader` alone no longer creates
    // a GL context on recent Chromium (needs the ANGLE/swiftshader backend and the
    // explicit `--enable-unsafe-swiftshader` opt-in); the extra flags make the
    // software renderer available cross-environment without a real GPU.
    browser = await chromium.launch({
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist"
      ]
    });
    const page = await browser.newPage();
    page.__vitePort = vitePort;
    await fn({ page, api, sdapi, vitePort });
  } finally {
    if (browser) await browser.close();
    await killProc(vite);
    await api.stop();
    await sdapi.stop();
  }
}

function snapshot(page) {
  return page.evaluate(() => ({
    appState: window.__sbState.appState,
    extracted: window.__sbState.extractedItems.length,
    pending: window.__sbState.pendingPanelItems.length,
    spherePanels: window.__sbSpherePanels.length,
    cyc: window.__sbState.cycleRequestInFlight,
    floor: window.__sbState.minTunnelDisplayUntilMs,
    genAiReceived: window.__sbState.genAiBatchReceived,
    genAiExpected: window.__sbState.genAiBatchExpected,
    genAiComplete: window.__sbState.genAiBatchComplete,
    tunnelSettledMs: window.__sbState.tunnelSettledMs,
    currentRing: window.__sbState.currentRingFloat,
    lastSpawnedPanelRing: window.__sbState.lastSpawnedPanelRing,
    targetSphereRing: window.__sbState.targetSphereRing,
    now: performance.now()
  }));
}

async function boot(page) {
  await page.goto(`http://127.0.0.1:${page.__vitePort}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForFunction(() => typeof window.__sbState === "object" && window.__sbState !== null, null, { timeout: 15000 });
}

test(
  "GenAI keeps the tunnel until the whole batch completes, then forms exactly N sphere panels",
  { skip: ENABLED ? false : "set GENAIE2E=1 (needs playwright + vite + WebGL)", timeout: 60000 },
  async () => {
    await withApp(async ({ page }) => {
      await boot(page);

      // Kick off a GenAI generation through the real production path (the same
      // call the GenAI button makes). Fire-and-forget so we can observe the
      // tunnel while generation is still in flight.
      await page.evaluate((prompt) => { window.__sbLoadGenAi({ query: prompt }); }, "a field of poppies at dawn");

      // Phase 1 — while the batch is generating (cyc === true), the scene must
      // NEVER leave the tunnel (the sphere must not form after just the first image).
      let sawGenerating = false;
      let sawPartialExtract = false;
      const genDeadline = Date.now() + 25000;
      while (Date.now() < genDeadline) {
        const s = await snapshot(page);
        if (s.cyc) {
          sawGenerating = true;
          assert.equal(s.appState, "tunnel", "left the tunnel while GenAI was still generating");
          assert.equal(s.floor, 0, "default GenAI floor should be disabled; completeness is the gate");
          assert.equal(s.genAiComplete, false, "batch was marked complete while request was still in flight");
          if (s.extracted > 0 && s.extracted < GENAI_COUNT) {
            sawPartialExtract = true; // confirms images really do stream in progressively
          }
        } else if (sawGenerating) {
          // Batch just completed.
          assert.equal(s.extracted, GENAI_COUNT, `batch completed with ${s.extracted} images, expected ${GENAI_COUNT}`);
          assert.equal(s.genAiReceived, GENAI_COUNT);
          assert.equal(s.genAiExpected, GENAI_COUNT);
          assert.equal(s.genAiComplete, true);
          break;
        }
        await sleep(80);
      }
      assert.ok(sawGenerating, "never observed the generating phase");
      assert.ok(sawPartialExtract, "images did not arrive progressively (mock pacing broken?)");

      // Phase 2 — the batch is complete but queued tunnel panels may still be
      // loading/spawning: the scene must remain in the tunnel until the panel
      // queue drains.
      const post = await snapshot(page);
      assert.equal(post.cyc, false, "expected generation to be complete");
      assert.equal(post.floor, 0, "default GenAI floor should remain disabled");

      // Phase 3 — drain the tunnel pipeline deterministically
      // (swiftshader texture decode is too slow to rely on real cadence), then
      // let the state machine form the sphere.
      await page.evaluate(() => window.__sbFlushTunnelPanels());
      // Headless Chromium can throttle requestAnimationFrame heavily; dt is
      // capped in production, so give the 1200 ms settle timer enough frames.
      const sphereDeadline = Date.now() + 45000;
      let formed = false;
      let lastSphereWait = null;
      while (Date.now() < sphereDeadline) {
        const s = await snapshot(page);
        lastSphereWait = s;
        if (s.appState === "transition_to_sphere" || s.appState === "inside_sphere") {
          formed = true;
          break;
        }
        await sleep(150);
      }
      assert.ok(formed, `sphere never formed after batch completion: ${JSON.stringify(lastSphereWait)}`);

      // At the moment the tunnel is left, all N images are present (never one).
      const atTransition = await snapshot(page);
      assert.equal(atTransition.extracted, GENAI_COUNT, "sphere formed without the full batch");

      // Phase 4 — the sphere must hold exactly min(N, SPHERE_IMAGE_COUNT) panels
      // and stay stable: no late GenAI straggler may grow/alter it. Sample the
      // panel count across a window after entering the sphere.
      const counts = new Set();
      for (let i = 0; i < 10; i += 1) {
        const s = await snapshot(page);
        if (s.appState === "inside_sphere") {
          counts.add(s.spherePanels);
        }
        await sleep(150);
      }
      assert.ok(counts.size <= 1, `sphere panel count changed after forming (saw ${[...counts].join(", ")}) — a late image landed on the sphere`);

      const finalPanels = await page.evaluate(() => window.__sbSpherePanels.length);
      assert.equal(finalPanels, EXPECTED_SPHERE_PANELS, `sphere should hold exactly ${EXPECTED_SPHERE_PANELS} panels, got ${finalPanels}`);
    });
  }
);
