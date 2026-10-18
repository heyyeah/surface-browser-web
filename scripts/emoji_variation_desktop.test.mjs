// Desktop equivalent of the VR both-trigger chord: Shift+click must use the
// selected web image as a GenAI source and begin the normal sphere-exit handoff.
// OPT-IN because this drives Vite/WebGL in Chromium; its endpoint responses are
// intercepted so it is deterministic and never calls a real image host/provider.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePort, startServer, startMockSdapi, waitForTcp, killProc, sleep } from "./contract_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = path.resolve(__dirname, "..");
const ENABLED = process.env.EMOJI_VARIATION_E2E === "1";
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WAAAAABJRU5ErkJggg==", "base64");

const TEST_ITEM = {
  imageUrl: "https://images.example.test/selected.png",
  linkUrl: "https://example.test/bfood/24hrCoverage.html",
  width: 1,
  height: 1,
  title: "Selected image"
};

// Shift and HOLD, not shift+click: the chord needs the press held still past
// SHIFT_DRAG_CHORD_HOLD_MS, behind the same ring the two-finger touch hold draws,
// because moving the same press is the zoom gesture. A bare shift+click is a no-op.
async function shiftHoldOnCanvas(page, holdMs = 900) {
  const box = await page.locator("#scene-canvas").boundingBox();
  const x = box.x + 30;
  const y = box.y + 30;
  await page.mouse.move(x, y);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  // Held STILL: any movement past the slop latches the chord off for good.
  await sleep(holdMs);
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

// Boots the real app on throwaway ports with a one-image web sphere already
// formed and its panel forced ready, so each test starts from INSIDE_SPHERE.
async function withWebSphere(fn) {
  const { chromium } = await import("playwright");
  // The server must report GenAI as configured: the client refuses the chord
  // outright when /api/capabilities says there is no relay (state.genAiActionsEnabled),
  // and a bare startServer() has GENAI_PROVIDER="". The mock sdapi is never reached
  // (every /api/genai* call is intercepted in the page), but a real one keeps the
  // capability honest.
  const sdapi = await startMockSdapi();
  const api = await startServer({
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: sdapi.base,
    GENAI_SAVE_IMAGES_TO_DISK: "false"
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
    browser = await chromium.launch({
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route("**/api/proxy/image?*", (route) => route.fulfill({
      status: 200,
      contentType: "image/png",
      body: TINY_PNG
    }));
    const gotoSphere = async () => {
      await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof window.__sbPrepareWebSphereForTest === "function", null, { timeout: 15000 });
      const prepared = await page.evaluate(
        (item) => window.__sbPrepareWebSphereForTest(item, { forceReady: true }),
        TEST_ITEM
      );
      assert.equal(prepared.panelCount, 1, `test sphere did not build: ${JSON.stringify(prepared)}`);
      await page.waitForFunction(() => window.__sbSpherePanels?.[0]?.ready === true, null, { timeout: 15000 });
    };
    await fn({ page, api, vitePort, gotoSphere });
  } finally {
    if (browser) await browser.close();
    await killProc(vite);
    await api.stop();
    await sdapi.stop();
  }
}

test(
  "Shift+click in a web sphere imports the selected image and exits into GenAI",
  { skip: ENABLED ? false : "set EMOJI_VARIATION_E2E=1 (needs playwright + vite + WebGL)", timeout: 45000 },
  async () => {
    await withWebSphere(async ({ page, gotoSphere }) => {
      let importBody = null;
      await page.route("**/api/genai/source/import", async (route) => {
        importBody = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            prompt: "selected web image",
            source: { genai: { id: "g_shiftclick_source" } }
          })
        });
      });
      await gotoSphere();

      await shiftHoldOnCanvas(page);
      await page.waitForFunction(() => (
        window.__sbState?.appState === "exiting_sphere"
        && window.__sbState?.pendingExitMode === "genai"
        && window.__sbState?.pendingExitSource?.id === "g_shiftclick_source"
      ), null, { timeout: 10000 });

      assert.equal(importBody.imageUrl, "https://images.example.test/selected.png");
      assert.equal(importBody.mode, "url");
    });
  }
);

// While POST /api/genai/source/import is open the chord must not retrigger, or
// retries stack up provider work. Asserted here:
//   1. the sphere exit begins BEFORE the import resolves, and
//   2. every repeat trigger during the launch is refused, so exactly one import
//      and one POST /api/genai leave the client.
// The import is held open far longer than the exit flight, so a regression that
// re-awaits the network before transitioning fails assertion 1.
test(
  "the exit starts before the import resolves, and repeat triggers never stack a second batch",
  { skip: ENABLED ? false : "set EMOJI_VARIATION_E2E=1 (needs playwright + vite + WebGL)", timeout: 90000 },
  async () => {
    await withWebSphere(async ({ page, gotoSphere }) => {
      // Comfortably longer than the ~1.6 s sphere-exit flight, so "the exit
      // began before the network answered" cannot pass by accident.
      const IMPORT_DELAY_MS = 6000;
      let importCount = 0;
      let genAiPostCount = 0;
      await page.route("**/api/genai/source/import", async (route) => {
        importCount += 1;
        await sleep(IMPORT_DELAY_MS);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            prompt: "selected web image",
            source: { genai: { id: "g_slow_source" } }
          })
        });
      });
      await page.route("**/api/genai", async (route) => {
        genAiPostCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            items: [{
              imageUrl: "https://images.example.test/gen.png",
              width: 1,
              height: 1,
              genai: { id: "g_out_1", prompt: "selected web image" }
            }],
            meta: { method: "genai" }
          })
        });
      });
      await gotoSphere();

      const started = await page.evaluate(() => window.__sbVrInput().genAiChord());
      assert.equal(started, true, "the chord did not start a launch");

      // The whole point: motion first. Well inside the import's 3 s the app has
      // already left the sphere, and the footer already acknowledges the launch.
      await page.waitForFunction(
        () => window.__sbState?.appState === "exiting_sphere",
        null,
        { timeout: 500 }
      );
      // The footer is painted by the render loop, and swiftshader stalls for
      // about a second recompiling the sphere-panel materials the exit flips —
      // so allow for that, while staying inside the import.
      await page.waitForFunction(
        () => (document.querySelector("#status-footer")?.textContent || "").startsWith("Variations on"),
        null,
        { timeout: 4000 }
      );
      const ack = await page.evaluate(() => ({
        launch: window.__sbState.genAiLaunch,
        pendingExitMode: window.__sbState.pendingExitMode,
        footer: document.querySelector("#status-footer")?.textContent || ""
      }));
      assert.equal(ack.launch?.status, "importing", "exit began without an in-flight launch record");
      assert.equal(ack.pendingExitMode, null, "the import cannot have resolved yet");
      assert.match(
        ack.footer,
        /^Variations on example\.test\/…\/24hrCoverage · 0\/\d+$/,
        `footer read "${ack.footer}"`
      );

      // Mash the trigger while the import is still open.
      const repeats = [];
      for (let i = 0; i < 4; i += 1) {
        repeats.push(await page.evaluate(() => window.__sbVrInput().genAiChord()));
        await sleep(120);
      }
      assert.deepEqual(repeats, [false, false, false, false], "a repeat trigger started a second launch");
      assert.equal(importCount, 1, `repeat triggers issued ${importCount} imports`);

      // Let the import land and the cycle restart into the GenAI run.
      await page.waitForFunction(
        () => window.__sbState?.currentLoadMode === "genai",
        null,
        { timeout: 30000 }
      );
      await sleep(1000);
      assert.equal(importCount, 1, `ended with ${importCount} imports`);
      assert.equal(genAiPostCount, 1, `ended with ${genAiPostCount} provider batches`);
    });
  }
);

// The exit has already started by the time an import can fail, so the viewer is
// mid-flight when it does: the failure has to arrive where they are (the tunnel
// footer) and the app has to settle in a usable state — never a half
// transition, a frozen progress readout, or a faked batch.
test(
  "a failed import surfaces in the tunnel instead of stranding the viewer mid-flight",
  { skip: ENABLED ? false : "set EMOJI_VARIATION_E2E=1 (needs playwright + vite + WebGL)", timeout: 60000 },
  async () => {
    await withWebSphere(async ({ page, gotoSphere }) => {
      let genAiPostCount = 0;
      await page.route("**/api/genai/source/import", (route) => route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Selected image returned HTTP 404" })
      }));
      await page.route("**/api/genai", (route) => {
        genAiPostCount += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, items: [] }) });
      });
      await gotoSphere();

      assert.equal(await page.evaluate(() => window.__sbVrInput().genAiChord()), true);
      await page.waitForFunction(
        () => window.__sbState?.appState === "tunnel" && !window.__sbState?.genAiLaunch,
        null,
        { timeout: 20000 }
      );
      const landed = await page.evaluate(() => ({
        footer: document.querySelector("#status-footer")?.textContent || "",
        batchComplete: window.__sbState.genAiBatchComplete,
        error: window.__sbState.genAiJobError,
        loadMode: window.__sbState.currentLoadMode
      }));
      assert.equal(landed.footer, "GenAI failed: Selected image returned HTTP 404", `footer read "${landed.footer}"`);
      assert.equal(landed.batchComplete, true, "a failed launch must not leave a batch pending forever");
      assert.equal(landed.loadMode, "url", "no GenAI run was ever established");
      assert.equal(genAiPostCount, 0, "a failed import must not reach the provider");
      // Still usable: a fresh trigger is accepted once the app is back in the
      // tunnel (it needs a sphere again, so this only asserts the app is live).
      assert.equal(await page.evaluate(() => window.__sbVrInput().genAiChord()), false);
    });
  }
);
