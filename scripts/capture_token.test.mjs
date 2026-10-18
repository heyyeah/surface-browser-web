// The capture token (`?cap=`) and what it switches on, offline.
//
// The token authorises a WRITE on the server, so the client half has two
// obligations beyond "remember it": the URL must not keep it (history, and the
// Referer that goes out with every subsequent request), and the POST must carry
// it as a header rather than a query parameter. Both are asserted here, because
// neither is visible in a headset when it goes wrong.
//
// config.js reads `window` at module evaluation, so each case installs a fake
// one and re-imports the module under a fresh specifier.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translate } from "../src/i18n.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function read(relative) {
  return fs.readFileSync(path.join(SRC, relative), "utf8");
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

const throwingStorage = {
  getItem() { throw new Error("storage disabled"); },
  setItem() { throw new Error("storage disabled"); },
  removeItem() { throw new Error("storage disabled"); }
};

let importSeq = 0;

// Installs a fake window, imports a fresh copy of config.js, and hands back the
// module plus whatever the module did to the URL.
async function loadConfig({ search = "", storage = memoryStorage(), hash = "" } = {}) {
  const replaced = [];
  globalThis.__SURFACE_BROWSER_DEV__ = false;
  globalThis.window = {
    location: { search, pathname: "/", hash },
    history: { replaceState: (_state, _title, url) => replaced.push(url) },
    localStorage: storage
  };
  try {
    importSeq += 1;
    const module = await import(`../src/config.js?capture=${importSeq}`);
    return { module, replaced, storage };
  } finally {
    delete globalThis.window;
    delete globalThis.__SURFACE_BROWSER_DEV__;
  }
}

// --- resolving the token ----------------------------------------------------

test("`?cap=` is remembered and stripped out of the URL", async () => {
  const { module, replaced, storage } = await loadConfig({ search: "?cap=abc123" });
  assert.equal(module.CAPTURE_TOKEN, "abc123");
  assert.equal(module.CAPTURE_CONTROL_ENABLED, true);
  assert.equal(storage.map.get("surfaceBrowser.captureToken"), "abc123");
  // The whole point of the strip: no token in history, none in a Referer.
  assert.equal(replaced.length, 1);
  assert.ok(!String(replaced[0]).includes("cap"), `token survived in ${replaced[0]}`);
});

test("the other query flags survive the strip", async () => {
  const { module, replaced } = await loadConfig({ search: "?log=1&cap=abc123&hands=0" });
  assert.equal(module.CAPTURE_TOKEN, "abc123");
  assert.equal(replaced[0], "/?log=1&hands=0");
  // And they still mean what they meant.
  assert.equal(module.XR_DIAG_ENABLED, true);
  assert.equal(module.XR_HAND_TRACKING_ENABLED, false);
});

test("`?layers=0` is off by default and opt-in only", async () => {
  assert.equal((await loadConfig({})).module.XR_LAYERS_ENABLED, true);
  assert.equal((await loadConfig({ search: "?layers=1" })).module.XR_LAYERS_ENABLED, true);
  assert.equal((await loadConfig({ search: "?layers=0" })).module.XR_LAYERS_ENABLED, false);
});

test("`?wall=basic` is opt-in only", async () => {
  assert.equal((await loadConfig({ search: "" })).module.TUNNEL_WALL_UNLIT, false);
  assert.equal((await loadConfig({ search: "?wall=basic" })).module.TUNNEL_WALL_UNLIT, true);
});

test("a later page load gets the token back from storage", async () => {
  // The headset reloads with a clean URL, so the token must persist without retyping.
  const storage = memoryStorage({ "surfaceBrowser.captureToken": "abc123" });
  const { module, replaced } = await loadConfig({ storage });
  assert.equal(module.CAPTURE_TOKEN, "abc123");
  assert.equal(replaced.length, 0, "nothing to strip, so no history rewrite");
});

test("`?cap=` with no value forgets the stored token", async () => {
  // The way to clear a stored token from a headset.
  const storage = memoryStorage({ "surfaceBrowser.captureToken": "abc123" });
  const { module } = await loadConfig({ search: "?cap=", storage });
  assert.equal(module.CAPTURE_TOKEN, "");
  assert.equal(module.CAPTURE_CONTROL_ENABLED, false);
  assert.equal(storage.map.has("surfaceBrowser.captureToken"), false);
});

test("no token anywhere means no capture control", async () => {
  const { module } = await loadConfig({});
  assert.equal(module.CAPTURE_TOKEN, "");
  assert.equal(module.CAPTURE_CONTROL_ENABLED, false);
});

test("storage that throws costs the page load nothing", async () => {
  // Private modes throw on access rather than returning null. The URL token
  // still has to work for this session.
  const { module } = await loadConfig({ search: "?cap=abc123", storage: throwingStorage });
  assert.equal(module.CAPTURE_TOKEN, "abc123");

  const stored = await loadConfig({ storage: throwingStorage });
  assert.equal(stored.module.CAPTURE_TOKEN, "");
});

test("config.js still imports where there is no window at all", async () => {
  // Node, and any pre-render. Every reader is inside a try/catch for this.
  globalThis.__SURFACE_BROWSER_DEV__ = false;
  try {
    importSeq += 1;
    const module = await import(`../src/config.js?nowindow=${importSeq}`);
    assert.equal(module.CAPTURE_TOKEN, "");
  } finally {
    delete globalThis.__SURFACE_BROWSER_DEV__;
  }
});

// --- what goes on the wire --------------------------------------------------

test("the capture is posted as an encoded JPEG, not as base64 JSON", async () => {
  const source = read("screenshot.js");
  assert.match(source, /canvas\.toBlob\(/, "the client encodes the JPEG itself");
  assert.match(source, /"image\/jpeg"/);
  assert.match(source, /"content-type": "image\/jpeg"/);
  assert.match(source, /body: blob/);
  // A base64 JSON body would be ~24 MB for one Quest eye buffer, against a 1 MB
  // JSON limit on the server.
  assert.doesNotMatch(source, /btoa\(/);
  assert.doesNotMatch(source, /JSON\.stringify/);
  assert.doesNotMatch(source, /rgba:/);
});

test("the token travels as a header, never in the URL", async () => {
  const source = read("screenshot.js");
  assert.match(source, /headers\["x-capture-token"\] = CAPTURE_TOKEN/);
  assert.match(source, /fetch\("\/api\/screenshot"/);
  assert.doesNotMatch(source, /screenshot\?/, "no query string on the capture POST");
  assert.doesNotMatch(source, /cap=\$\{/);
});

// --- the trigger ------------------------------------------------------------

test("the menu toolbar has no capture cell", async () => {
  // Capture lives only on the wrist row (hands) and left X (controllers,
  // token-gated); the toolbar has no capture button.
  const panel = read("vrpanel.js");
  assert.doesNotMatch(panel, /📷/);
  assert.doesNotMatch(panel, /action:\s*\{\s*type:\s*"capture"\s*\}/);
  assert.doesNotMatch(panel, /if \(action\.type === "capture"\)/);
  assert.doesNotMatch(panel, /CAPTURE_CONTROL_ENABLED/);
  assert.doesNotMatch(panel, /CAPTURE_CELL_W/);
  assert.doesNotMatch(panel, /saveScreenshotWithStatus/);
});

// --- ?capui=1 --------------------------------------------------
// The debug capture that KEEPS the UI, so a panel or a callout can be
// photographed at all. Its whole risk is the name: `?cap=` is the token, and a
// value there is stored as one.

test("capui is off unless asked for, and is never persisted", async () => {
  const off = await loadConfig({ search: "" });
  assert.equal(off.module.CAPTURE_KEEP_UI, false);

  const storage = memoryStorage();
  const on = await loadConfig({ search: "?capui=1", storage });
  assert.equal(on.module.CAPTURE_KEEP_UI, true);
  // One page load only — nothing about it may survive into the next session.
  assert.equal(storage.map.size, 0, "capui must not be stored");
  assert.deepEqual(on.replaced, [], "capui must not be stripped from the URL either");

  // Only the exact opt-in counts; a bare `?capui` is not it.
  assert.equal((await loadConfig({ search: "?capui" })).module.CAPTURE_KEEP_UI, false);
  assert.equal((await loadConfig({ search: "?capui=0" })).module.CAPTURE_KEEP_UI, false);
});

test("capui and the token are separate parameters", async () => {
  const storage = memoryStorage();
  const { module } = await loadConfig({ search: "?cap=secret&capui=1", storage });
  assert.equal(module.CAPTURE_TOKEN, "secret");
  assert.equal(module.CAPTURE_KEEP_UI, true);
  // The token still works normally alongside it.
  assert.equal(storage.map.get("surfaceBrowser.captureToken"), "secret");

  // And capui alone must not be mistaken for a token — that would overwrite a
  // stored one and 404 every capture until it was reset by hand.
  const kept = memoryStorage({ "surfaceBrowser.captureToken": "real" });
  const solo = await loadConfig({ search: "?capui=1", storage: kept });
  assert.equal(solo.module.CAPTURE_TOKEN, "real");
});

test("capui skips the hide list, and says so on the status line", () => {
  const source = read("screenshot.js");
  // Conditional, not removed: without the flag the hide must still happen.
  assert.match(source, /if \(!CAPTURE_KEEP_UI\) \{\s*\n\s*restoreVisibility = hideForCapture\(collectCaptureHideables\(\)\);/);
  // A UI capture that announced itself as an ordinary one would be read later
  // as the hide list having silently failed.
  assert.match(source, /t\(CAPTURE_KEEP_UI \? "status\.savedScreenshotUi" : "status\.savedScreenshot"/);
  assert.match(translate("status.savedScreenshotUi"), /^Saved screenshot \(UI kept\)/);
  assert.match(translate("status.savedScreenshot"), /^Saved screenshot: /);
});
