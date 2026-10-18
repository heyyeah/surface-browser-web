// Contract tests for GET /api/search/images.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, startImageSearchMock } from "./contract_helpers.mjs";

test("/api/search/images: missing query -> 400", async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.base}/api/search/images`);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /query/i);
  } finally {
    await server.stop();
  }
});

test("/api/search/images: custom provider returns the normalized envelope", async () => {
  const mock = await startImageSearchMock();
  // IMAGE_SEARCH_PROVIDER defaults to "ddg", so we select `custom` explicitly
  // and point it at the local endpoint (operator-configured endpoints are exempt
  // from the loopback/port SSRF guard).
  const server = await startServer({
    IMAGE_SEARCH_PROVIDER: "custom",
    IMAGE_SEARCH_ENDPOINT: mock.endpoint
  });
  try {
    const res = await fetch(`${server.base}/api/search/images?q=otters`);
    assert.equal(res.status, 200);
    const json = await res.json();

    // Shared envelope shape.
    assert.equal(json.sourceUrl, "image-search:otters");
    assert.equal(json.title, "Image search: otters");
    assert.ok(Array.isArray(json.items), "items is an array");
    assert.ok(json.items.length >= 1, "at least one item");
    assert.equal(json.meta.method, "image_search_custom");
    assert.ok(Array.isArray(json.meta.warnings), "meta.warnings is an array");

    // Item shape: imageUrl required, other fields normalized from mixed inputs.
    const item = json.items[0];
    assert.match(item.imageUrl, /^https:\/\/example\.test\//);
    assert.ok("linkUrl" in item, "linkUrl present (may be null)");
    assert.ok("width" in item && "height" in item, "dimensions present");
    assert.equal(item.width, 640);
    assert.equal(item.height, 480);
  } finally {
    await server.stop();
    await mock.stop();
  }
});
