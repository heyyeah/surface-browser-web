// Desktop (DEV) verification: the in-VR canvas keyboard composes text and
// routes it through the ACTIVE mode's load function, and the server-STT record→
// POST→route path fires the right endpoint. OPT-IN (set C3E2E=1) because it
// needs Playwright's chromium + a vite dev server + WebGL, the same constraints
// as contract_smoke. It is skipped by default so `npm test` stays offline/fast.
//
// It drives the panel through window.__sbVrPanel (the DEV bridge): open the
// panel, pick a mode, tap keyboard keys, press Done, and assert which /api/*
// endpoint the routing hit. All /api/* calls are intercepted and stubbed so the
// test is deterministic and offline — we only care WHICH endpoint fires.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePort, startServer, startMockStt, waitForTcp, sleep, killProc } from "./contract_helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = path.resolve(__dirname, "..");
const ENABLED = process.env.C3E2E === "1";

async function withApp(fn, { serverEnv = {} } = {}) {
  const { chromium } = await import("playwright");
  const api = await startServer(serverEnv);
  const vitePort = await findFreePort();
  const vite = spawn(
    process.execPath,
    [path.join(MVP_ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(vitePort), "--strictPort"],
    { cwd: MVP_ROOT, env: { ...process.env, DEV: "1", VITE_API_TARGET: api.base }, stdio: "ignore" }
  );
  let browser;
  try {
    await waitForTcp(vitePort, 20000);
    browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--ignore-gpu-blocklist"] });
    const page = await browser.newPage();
    await fn({ page, api, vitePort });
  } finally {
    if (browser) await browser.close();
    await killProc(vite);
    await api.stop();
  }
}

// Stub every /api/* call and record the pathname of the last routing call, so a
// Done/record action's endpoint choice is observable without a live backend.
async function installApiRecorder(page, healthBody = { ok: true, stt: { enabled: false }, genai: { enabled: true } }) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p.endsWith("/api/health")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(healthBody) });
      return;
    }
    // Record ONLY the three mode routing endpoints (not incidental startup calls
    // like GET /api/settings), so "which endpoint did routing hit" is clean.
    if (/\/api\/(extract|search\/images|genai)(\?|$)/.test(p + url.search)) {
      await page.evaluate((pathname) => { window.__c3LastApi = pathname; }, p);
    }
    const body = JSON.stringify({ ok: true, items: [], meta: { method: "test", warnings: [] }, title: "t", sourceUrl: "t" });
    await route.fulfill({ status: 200, contentType: "application/json", body });
  });
}

async function openPanel(page) {
  await page.goto(`http://127.0.0.1:${page.__vitePort}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForFunction(() => typeof window.__sbVrPanel === "function", null, { timeout: 15000 });
  await page.evaluate(() => window.__sbVrPanel().open());
}

// Tap a sequence of characters on the keyboard, then a terminal key.
async function typeOnKeyboard(page, chars) {
  for (const ch of chars) {
    await page.evaluate((c) => {
      const b = window.__sbVrPanel();
      const key = b.hitRects.find((r) => r.type === "kbKey" && r.char === c);
      if (!key) throw new Error(`no key for ${JSON.stringify(c)}`);
      b.activateCanvas(key.x + key.w / 2, key.y + key.h / 2);
    }, ch);
  }
}

async function pressKeyType(page, type) {
  await page.evaluate((t) => {
    const b = window.__sbVrPanel();
    const key = b.hitRects.find((r) => r.type === t);
    if (!key) throw new Error(`no ${t} key`);
    b.activateCanvas(key.x + key.w / 2, key.y + key.h / 2);
  }, type);
}

async function openKeyboard(page) {
  await page.evaluate(() => {
    const b = window.__sbVrPanel();
    const cell = b.hitRects.find((r) => r.type === "keyboard");
    b.activateCanvas(cell.x + cell.w / 2, cell.y + cell.h / 2);
  });
}

const ROUTES = [
  { mode: "web", chars: "abc", endpoint: "/api/extract" },
  { mode: "image", chars: "cat", endpoint: "/api/search/images" },
  { mode: "genai", chars: "sky", endpoint: "/api/genai" }
];

for (const { mode, chars, endpoint } of ROUTES) {
  test(`keyboard Done routes to ${endpoint} in ${mode} mode`, { skip: ENABLED ? false : "set C3E2E=1 (needs playwright + vite + WebGL)" }, async () => {
    await withApp(async ({ page, vitePort }) => {
      page.__vitePort = vitePort;
      await installApiRecorder(page);
      await openPanel(page);
      await page.evaluate((m) => window.__sbVrPanel().setMode(m), mode);
      await openKeyboard(page);
      // Confirm the keyboard opened.
      assert.equal(await page.evaluate(() => window.__sbVrPanel().keyboardOpen), true);
      await typeOnKeyboard(page, chars);
      assert.equal(await page.evaluate(() => window.__sbVrPanel().keyboardText), chars, "text composed");
      await pressKeyType(page, "kbDone");
      await sleep(300);
      const last = await page.evaluate(() => window.__c3LastApi || "");
      assert.ok(last.endsWith(endpoint), `expected ${endpoint}, got ${last}`);
      // Keyboard closed after Done.
      assert.equal(await page.evaluate(() => window.__sbVrPanel().keyboardOpen), false);
    });
  });
}

test("without a voice path the keyboard has no Speak key", { skip: ENABLED ? false : "set C3E2E=1 (needs playwright + vite + WebGL)" }, async () => {
  await withApp(async ({ page, vitePort }) => {
    page.__vitePort = vitePort;
    // Health reports STT disabled; the headless page has no SpeechRecognition,
    // so pressing the mic must open the keyboard.
    await installApiRecorder(page, { ok: true, stt: { enabled: false }, genai: { enabled: true } });
    await page.addInitScript(() => {
      delete window.SpeechRecognition;
      delete window.webkitSpeechRecognition;
    });
    await openPanel(page);
    assert.equal(await page.evaluate(() => window.__sbVrPanel().voiceSupported), false);
    await openKeyboard(page);
    assert.equal(await page.evaluate(() => window.__sbVrPanel().keyboardOpen), true);
    assert.equal(
      await page.evaluate(() => window.__sbVrPanel().hitRects.some((r) => r.type === "voice")),
      false,
      "no Speak key without a voice path"
    );
  });
});

test("keyboard Cancel discards text and closes without routing", { skip: ENABLED ? false : "set C3E2E=1 (needs playwright + vite + WebGL)" }, async () => {
  await withApp(async ({ page, vitePort }) => {
    page.__vitePort = vitePort;
    await installApiRecorder(page);
    await openPanel(page);
    await openKeyboard(page);
    await typeOnKeyboard(page, "abc");
    await pressKeyType(page, "kbCancel");
    assert.equal(await page.evaluate(() => window.__sbVrPanel().keyboardOpen), false);
    assert.equal(await page.evaluate(() => window.__c3LastApi || ""), "", "cancel routed nothing");
  });
});

test("Help uses a larger sharp surface and keeps bindings paged", { skip: ENABLED ? false : "set C3E2E=1 (needs playwright + vite + WebGL)" }, async () => {
  await withApp(async ({ page, vitePort }) => {
    page.__vitePort = vitePort;
    await installApiRecorder(page);
    await openPanel(page);
    const menuSurface = await page.evaluate(() => {
      const b = window.__sbVrPanel();
      return {
        canvasWidth: b.canvasWidth,
        canvasHeight: b.canvasHeight,
        backingCanvasWidth: b.backingCanvasWidth,
        backingCanvasHeight: b.backingCanvasHeight,
        panelWidthM: b.panelWidthM,
        panelHeightM: b.panelHeightM
      };
    });
    await page.evaluate(() => window.__sbVrPanel().toggleHelp());
    assert.equal(await page.evaluate(() => window.__sbVrPanel().helpView), "basic");
    const helpSurface = await page.evaluate(() => {
      const b = window.__sbVrPanel();
      return {
        canvasWidth: b.canvasWidth,
        canvasHeight: b.canvasHeight,
        backingCanvasWidth: b.backingCanvasWidth,
        backingCanvasHeight: b.backingCanvasHeight,
        panelWidthM: b.panelWidthM,
        panelHeightM: b.panelHeightM,
        helpPanelScale: b.helpPanelScale
      };
    });
    assert.deepEqual(menuSurface, {
      canvasWidth: 1024,
      canvasHeight: 768,
      backingCanvasWidth: 1024,
      backingCanvasHeight: 768,
      panelWidthM: 1.6,
      panelHeightM: 1.2
    });
    assert.deepEqual(helpSurface, {
      canvasWidth: 1024,
      canvasHeight: 768,
      backingCanvasWidth: 1536,
      backingCanvasHeight: 1152,
      helpPanelScale: 1.5
    });
    assert.ok(Math.abs(helpSurface.panelWidthM - 2.4) < 1e-9, "Help quad is 1.5x the menu width");
    assert.ok(Math.abs(helpSurface.panelHeightM - 1.8) < 1e-9, "Help quad keeps the 4:3 aspect ratio");
    await page.evaluate(() => {
      const b = window.__sbVrPanel();
      const advanced = b.hitRects.find((r) => r.type === "helpView" && r.view === "advanced");
      b.activateCanvas(advanced.x + advanced.w / 2, advanced.y + advanced.h / 2);
    });
    assert.equal(await page.evaluate(() => window.__sbVrPanel().helpView), "advanced");
    await page.evaluate(() => {
      const b = window.__sbVrPanel();
      const controllers = b.hitRects.find((r) => r.type === "helpView" && r.view === "controllers");
      b.activateCanvas(controllers.x + controllers.w / 2, controllers.y + controllers.h / 2);
    });
    assert.equal(await page.evaluate(() => window.__sbVrPanel().helpView), "controllers");
    assert.equal(await page.evaluate(() => window.__sbVrPanel().helpControllerSide), "left");
    await page.evaluate(() => {
      const b = window.__sbVrPanel();
      const right = b.hitRects.find((r) => r.type === "helpControllerSide" && r.side === "right");
      b.activateCanvas(right.x + right.w / 2, right.y + right.h / 2);
    });
    assert.equal(await page.evaluate(() => window.__sbVrPanel().helpControllerSide), "right");
    await page.evaluate(() => {
      const b = window.__sbVrPanel();
      const hands = b.hitRects.find((r) => r.type === "helpView" && r.view === "hands");
      if (!hands) throw new Error("missing hands page");
      b.activateCanvas(hands.x + hands.w / 2, hands.y + hands.h / 2);
    });
    assert.equal(await page.evaluate(() => window.__sbVrPanel().helpView), "hands");
    assert.equal(
      await page.evaluate(() => window.__sbVrPanel().hitRects.filter((r) => r.type === "helpView").length),
      3,
      "hands page exposes Basic, Advanced, and Controllers navigation"
    );
  });
});
