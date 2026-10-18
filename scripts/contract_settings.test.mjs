// Contract tests for the settings service.
//
// startServer() points SETTINGS_FILE_PATH at a disposable temp file, so PUT
// tests never read or mutate the developer's real settings.local.json. PUT is
// allowed here because tests connect over 127.0.0.1 (isLocalRequest).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./contract_helpers.mjs";

test("GET /api/settings: 200 on fresh state with no provider env", async () => {
  // Regression: an empty provider once caused a 500; getPublicSettings must not
  // throw when IMAGE_SEARCH_PROVIDER / GENAI_PROVIDER are empty.
  const server = await startServer();
  try {
    const res = await fetch(`${server.base}/api/settings`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.settings && typeof json.settings === "object");
    // Empty GenAI provider coerces to "" without error.
    assert.equal(json.settings.GENAI_PROVIDER.value, "");
    assert.equal(json.settings.IMAGE_SEARCH_PROVIDER.value, "ddg");
    assert.equal(json.settings.GENAI_SAVE_IMAGES_TO_DISK.value, true);
    assert.equal(json.settings.GENAI_CLEANUP_IMAGES.value, true);
    assert.equal(json.settings.GENAI_IMAGE_RETENTION_DAYS.value, 0);
    assert.equal(json.settings.GENAI_VARY_SEED_MODE.value, "fresh");
    assert.equal(json.settings.GENAI_COUNT.value, 5);
    assert.equal(json.settings.GENAI_STEPS.value, 8);
    assert.equal(json.settings.GENAI_DRAWTHINGS_GUIDANCE_EMBED.value, 5);
    assert.equal(json.settings.GENAI_VARIATION_STRENGTH_MIN.value, 0.95);
    assert.equal(json.settings.GENAI_VARIATION_STRENGTH_MAX.value, 1);
    // Vary emoji modifiers: surfaced, unmasked (not a secret), defaulting to
    // the expanded branch palette.
    assert.equal(json.settings.GENAI_VARY_MODIFIERS.value, "🧊 🌶️ 🦄 🎆 🍦 🧀 🌹 😎 🪩 🦦 🦘 ❄️ 🌊 🌕 🌲 🍌 💡 🕯️ 🚿");
    assert.equal(json.settings.GENAI_VARY_MODIFIERS.secret, false);
    assert.equal(json.settings.GENAI_VARY_MODIFIER_MODE.value, "per-image");
    assert.equal(json.settings.GENAI_VARY_MODIFIER_MODE.secret, false);
    // Style + payload: replace is the default; payload defaults to text phrases.
    assert.equal(json.settings.GENAI_VARY_MODIFIER_STYLE.value, "replace");
    assert.equal(json.settings.GENAI_VARY_MODIFIER_STYLE.secret, false);
    assert.equal(json.settings.GENAI_VARY_MODIFIER_PAYLOAD.value, "text");
    assert.equal(json.settings.GENAI_VARY_MODIFIER_PAYLOAD.secret, false);
    assert.equal(json.settings.SHOW_STATUS_FOOTER.value, true);
    assert.equal(json.settings.LOG_API_QUERIES.value, true);
    assert.match(json.meta.generatedImagesDir, /surface-browser-generated-|generated-images/);
  } finally {
    await server.stop();
  }
});

test("PUT /api/settings: accepts fixed GenAI vary seed mode", async () => {
  const server = await startServer();
  try {
    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_SEED_MODE: "fixed" } })
    });
    assert.equal(put.status, 200);
    const putJson = await put.json();
    assert.equal(putJson.settings.GENAI_VARY_SEED_MODE.value, "fixed");

    const bad = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_SEED_MODE: "wobbly" } })
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.stop();
  }
});

test("PUT /api/settings: accepts vary modifier mode + emoji set, rejects bad mode", async () => {
  const server = await startServer();
  try {
    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_MODIFIER_MODE: "per-image", GENAI_VARY_MODIFIERS: "🌶️ 🧊" } })
    });
    assert.equal(put.status, 200);
    const putJson = await put.json();
    assert.equal(putJson.settings.GENAI_VARY_MODIFIER_MODE.value, "per-image");
    assert.equal(putJson.settings.GENAI_VARY_MODIFIERS.value, "🌶️ 🧊");

    const off = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_MODIFIER_MODE: "off" } })
    });
    assert.equal(off.status, 200);
    assert.equal((await off.json()).settings.GENAI_VARY_MODIFIER_MODE.value, "off");

    const bad = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_MODIFIER_MODE: "sometimes" } })
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.stop();
  }
});

test("PUT /api/settings: accepts vary modifier style + payload, rejects bad values", async () => {
  const server = await startServer();
  try {
    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_MODIFIER_STYLE: "append", GENAI_VARY_MODIFIER_PAYLOAD: "text" } })
    });
    assert.equal(put.status, 200);
    const putJson = await put.json();
    assert.equal(putJson.settings.GENAI_VARY_MODIFIER_STYLE.value, "append");
    assert.equal(putJson.settings.GENAI_VARY_MODIFIER_PAYLOAD.value, "text");

    const badStyle = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_MODIFIER_STYLE: "merge" } })
    });
    assert.equal(badStyle.status, 400);

    const badPayload = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_MODIFIER_PAYLOAD: "sticker" } })
    });
    assert.equal(badPayload.status, 400);
  } finally {
    await server.stop();
  }
});

test("PUT /api/settings: saved built-in GenAI provider clears stale legacy endpoint", async () => {
  const server = await startServer();
  try {
    const legacy = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_ENDPOINT: "http://127.0.0.1:8022" } })
    });
    assert.equal(legacy.status, 200);

    const provider = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_PROVIDER: "drawthings" } })
    });
    assert.equal(provider.status, 200);
    const json = await provider.json();
    assert.equal(json.settings.GENAI_PROVIDER.value, "drawthings");
    assert.equal(json.settings.GENAI_PROVIDER.source, "override");
    assert.equal(json.settings.GENAI_ENDPOINT.value, "");
    assert.equal(json.settings.GENAI_ENDPOINT.source, "default");
  } finally {
    await server.stop();
  }
});

test("startup with retention 0 prunes previous-session generated image files", async () => {
  const generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-generated-session-"));
  const oldFile = path.join(generatedDir, "old.png");
  fs.writeFileSync(oldFile, "old");
  const beforeThisSession = new Date(Date.now() - 2000);
  fs.utimesSync(oldFile, beforeThisSession, beforeThisSession);

  const server = await startServer({
    GENAI_IMAGE_DIR_PATH: generatedDir,
    GENAI_IMAGE_RETENTION_DAYS: "0"
  });
  try {
    assert.equal(fs.existsSync(oldFile), false, "previous-session generated image removed");
  } finally {
    await server.stop();
    fs.rmSync(generatedDir, { recursive: true, force: true });
  }
});

test("startup prunes generated image files older than retention days", async () => {
  const generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-generated-retention-"));
  const oldFile = path.join(generatedDir, "old.png");
  const freshFile = path.join(generatedDir, "fresh.png");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(freshFile, "fresh");
  const twoDaysAgo = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000));
  fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

  const server = await startServer({
    GENAI_IMAGE_DIR_PATH: generatedDir,
    GENAI_IMAGE_RETENTION_DAYS: "1"
  });
  try {
    assert.equal(fs.existsSync(oldFile), false, "old generated image removed");
    assert.equal(fs.existsSync(freshFile), true, "fresh generated image kept");
  } finally {
    await server.stop();
    fs.rmSync(generatedDir, { recursive: true, force: true });
  }
});

test("startup keeps generated image files when cleanup is disabled", async () => {
  const generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-generated-no-cleanup-"));
  const oldFile = path.join(generatedDir, "old.png");
  fs.writeFileSync(oldFile, "old");
  const twoDaysAgo = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000));
  fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

  const server = await startServer({
    GENAI_IMAGE_DIR_PATH: generatedDir,
    GENAI_CLEANUP_IMAGES: "0",
    GENAI_IMAGE_RETENTION_DAYS: "1"
  });
  try {
    assert.equal(fs.existsSync(oldFile), true, "cleanup disabled keeps old generated image");
  } finally {
    await server.stop();
    fs.rmSync(generatedDir, { recursive: true, force: true });
  }
});

test("PUT /api/settings: rejects unknown keys", async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { TOTALLY_MADE_UP: "x" } })
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /unknown setting/i);
  } finally {
    await server.stop();
  }
});

test("PUT /api/settings: rejects security-critical keys", async () => {
  const server = await startServer();
  try {
    for (const key of ["ALLOWED_TARGET_HOSTS", "SETTINGS_TOKEN", "HIDE_SETTINGS"]) {
      const res = await fetch(`${server.base}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { [key]: "1" } })
      });
      assert.equal(res.status, 400, `${key} must be rejected`);
      const json = await res.json();
      // They are not in SETTING_DEFINITIONS, so the server reports them unknown
      // (i.e. they are not editable via the settings API by design).
      assert.match(json.error, /unknown setting/i, `${key} error`);
    }
  } finally {
    await server.stop();
  }
});

test("GET /api/settings: masks secrets after a PUT sets one", async () => {
  const server = await startServer();
  try {
    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { SERPER_API_KEY: "supersecretapikey1234" } })
    });
    assert.equal(put.status, 200);
    const putJson = await put.json();
    // The response is already masked and never echoes the raw secret.
    assert.equal(putJson.settings.SERPER_API_KEY.secret, true);
    assert.notEqual(putJson.settings.SERPER_API_KEY.value, "supersecretapikey1234");
    assert.match(putJson.settings.SERPER_API_KEY.value, /\.\.\./);

    const get = await fetch(`${server.base}/api/settings`);
    const getJson = await get.json();
    assert.equal(getJson.settings.SERPER_API_KEY.source, "override");
    assert.notEqual(getJson.settings.SERPER_API_KEY.value, "supersecretapikey1234");
    assert.match(getJson.settings.SERPER_API_KEY.value, /^sup\.\.\.1234$/);
  } finally {
    await server.stop();
  }
});

test("HIDE_SETTINGS=1: settings endpoints 404", async () => {
  const server = await startServer({ HIDE_SETTINGS: "1" });
  try {
    const get = await fetch(`${server.base}/api/settings`);
    assert.equal(get.status, 404);

    const put = await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { SERPER_API_KEY: "x" } })
    });
    assert.equal(put.status, 404);
  } finally {
    await server.stop();
  }
});
