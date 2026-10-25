// /admin/generated: the saved images, with the prompt and emoji each was made
// from, for the operator only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startServer, startMockFal } from "./contract_helpers.mjs";

const temps = [];
after(() => {
  for (const dir of temps) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function postGenAi(server, body) {
  const res = await fetch(`${server.base}/api/genai`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test("lists saved images with prompt, emoji stack and generation, and serves them", async () => {
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-generated-"));
  temps.push(imageDir);
  const mock = await startMockFal();
  const server = await startServer({
    GENAI_PROVIDER: "fal",
    FAL_KEY: "test-key",
    GENAI_FAL_BASE_URL: mock.base,
    GENAI_FAL_TEXT_MODEL: "fal-ai/flux-2/klein/4b",
    GENAI_FAL_IMAGE_MODEL: "fal-ai/flux-2/klein/4b/edit",
    GENAI_COUNT: "2",
    GENAI_VARY_MODIFIERS: "🦄",
    GENAI_SAVE_IMAGES_TO_DISK: "1",
    GENAI_IMAGE_RETENTION_DAYS: "3",
    GENAI_IMAGE_DIR_PATH: imageDir
  });
  try {
    const base = await postGenAi(server, { prompt: "a lighthouse", count: 2 });
    assert.equal(base.status, 200);
    const vary = await postGenAi(server, { source: { id: base.json.items[0].genai.id }, count: 1 });
    assert.equal(vary.status, 200);

    const listing = await (await fetch(`${server.base}/admin/generated.json`)).json();
    assert.equal(listing.saving, true);
    assert.equal(listing.items.length, 3);
    assert.ok(listing.items.every((item) => item.prompt === "a lighthouse"));
    const variation = listing.items.find((item) => item.round === 2);
    assert.deepEqual(variation.stack, ["🦄"]);
    assert.equal(variation.parentId, base.json.items[0].genai.id);

    const image = await fetch(`${server.base}/admin/generated/image/${encodeURIComponent(variation.file)}`);
    assert.equal(image.status, 200);
    assert.equal((await fetch(`${server.base}/admin/generated/image/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${server.base}/admin/generated`)).status, 200);
  } finally {
    await server.stop();
    await mock.stop();
  }
});
