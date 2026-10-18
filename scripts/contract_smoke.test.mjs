// Headless smoke: load the app and assert the state machine reaches
// INSIDE_SPHERE.
//
// Playwright IS a dependency (optionalDependencies, installed with a chromium
// browser), so this is implemented rather than stubbed. It is nonetheless
// OPT-IN (run with SMOKE=1) and skipped by default, because a real end-to-end
// run requires:
//   - a running vite dev server with DEV=1 (to enable the `j` debug jump),
//   - the real API to extract images, which needs network access to the
//     browserfood corpus (the SSRF guard forbids a loopback fixture, so there
//     is no deterministic offline source of extracted images), and
//   - headless WebGL + a >14s tunnel budget.
// That combination is neither offline nor deterministic, so keeping it out of
// the default `npm test` protects the <60s / deterministic contract. Run it
// deliberately with:  SMOKE=1 npm test
//
// The app does not expose appState on window, so this observes the visible
// #status-label, which reads "Inside sphere (Ns)" once INSIDE_SPHERE is entered
// (no source change required). When enabled it drives: type the browserfood
// bookmark URL -> wait for extraction -> press `j` (dev jump) -> poll the status
// label until it reports the sphere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePort, startServer, waitForTcp, sleep, killProc } from "./contract_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = path.resolve(__dirname, "..");
const SMOKE_ENABLED = process.env.SMOKE === "1";
const BROWSERFOOD_URL = "https://www.boxc.net/browserfood.html";

test("headless smoke: app reaches INSIDE_SPHERE", { skip: SMOKE_ENABLED ? false : "set SMOKE=1 to run (needs network + vite + WebGL)" }, async () => {
  const { chromium } = await import("playwright");
  const api = await startServer();
  const vitePort = await findFreePort();
  const vite = spawn(
    process.execPath,
    [path.join(MVP_ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(vitePort), "--strictPort"],
    {
      cwd: MVP_ROOT,
      env: { ...process.env, DEV: "1", VITE_API_TARGET: api.base },
      stdio: "ignore"
    }
  );

  let browser;
  try {
    await waitForTcp(vitePort, 20000);
    browser = await chromium.launch();
    const page = await browser.newPage();
    // Route /api through our test API instance (vite's proxy points at 8788).
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      route.continue({ url: `${api.base}${url.pathname}${url.search}` });
    });

    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: "domcontentloaded" });

    // Enter the browserfood URL and submit.
    await page.fill("#url-input", BROWSERFOOD_URL);
    await page.keyboard.press("Enter");

    // Wait for extraction to populate the tunnel (status leaves "Idle"/loading),
    // then repeatedly press `j` (dev jump) until the sphere is entered. The
    // #status-label reads "Inside sphere (Ns)" once INSIDE_SPHERE is reached.
    const readStatus = () => page.$eval("#status-label", (el) => el.textContent || "");
    const deadline = Date.now() + 45000;
    let reached = false;
    while (Date.now() < deadline) {
      const status = await readStatus().catch(() => "");
      if (/inside sphere/i.test(status)) {
        reached = true;
        break;
      }
      // The canvas must have focus for the `j` shortcut; click it then press.
      await page.click("canvas").catch(() => {});
      await page.keyboard.press("j").catch(() => {});
      await sleep(500);
    }
    assert.ok(reached, "state machine reached INSIDE_SPHERE (status label)");
  } finally {
    if (browser) await browser.close();
    await killProc(vite);
    await api.stop();
  }
});
