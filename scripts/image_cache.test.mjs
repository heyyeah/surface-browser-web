// Unit tests for the /api/proxy/image disk cache (server/image-cache.js).
// In-process for the same reason as proxy_image_resize.test.mjs: the route's
// SSRF guard rejects every loopback fixture host.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createImageDiskCache } from "../server/image-cache.js";

const DAY = 24 * 60 * 60 * 1000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sb-image-cache-"));
}

// Evictions and drops delete files without being awaited.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("unset directory means disabled: nothing is stored or returned", async () => {
  const cache = createImageDiskCache({ dir: "", maxBytes: 1000, ttlMs: DAY });
  assert.equal(cache.enabled, false);
  assert.equal(await cache.set("https://a.test/1.jpg", "v", Buffer.from("abc"), "image/jpeg"), false);
  assert.equal(await cache.get("https://a.test/1.jpg", "v"), null);
});

test("a stored image comes back with its bytes and content type", async () => {
  const cache = createImageDiskCache({ dir: tempDir(), maxBytes: 1000, ttlMs: DAY });
  const bytes = Buffer.from("jpeg bytes");
  assert.equal(await cache.set("https://a.test/1.jpg", "v", bytes, "image/jpeg"), true);
  const hit = await cache.get("https://a.test/1.jpg", "v");
  assert.deepEqual(hit.buffer, bytes);
  assert.equal(hit.contentType, "image/jpeg");
  assert.equal(await cache.get("https://a.test/2.jpg", "v"), null);
  assert.equal(await cache.get("https://a.test/1.jpg", "other-variant"), null);
  const { hits, misses, entries } = cache.snapshot();
  assert.deepEqual({ hits, misses, entries }, { hits: 1, misses: 2, entries: 1 });
});

test("a content type the route cannot produce is never stored", async () => {
  const dir = tempDir();
  const cache = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: DAY });
  assert.equal(await cache.set("https://a.test/x.svg", "v", Buffer.from("<svg/>"), "image/svg+xml"), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an entry past its TTL is a miss and its file is deleted", async () => {
  const dir = tempDir();
  let clock = 1_000_000;
  const cache = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: 500, now: () => clock });
  await cache.set("https://a.test/1.png", "v", Buffer.from("png"), "image/png");
  clock += 400;
  assert.ok(await cache.get("https://a.test/1.png", "v"));
  clock += 200;
  assert.equal(await cache.get("https://a.test/1.png", "v"), null);
  await settle();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("over the byte cap, the least recently USED entry goes first", async () => {
  const dir = tempDir();
  const cache = createImageDiskCache({ dir, maxBytes: 250, ttlMs: DAY });
  const block = Buffer.alloc(100, 1);
  await cache.set("https://a.test/a", "v", block, "image/webp");
  await cache.set("https://a.test/b", "v", block, "image/webp");
  await cache.get("https://a.test/a", "v");
  await cache.set("https://a.test/c", "v", block, "image/webp");
  assert.ok(await cache.get("https://a.test/a", "v"), "a was read after b, so it stays");
  assert.equal(await cache.get("https://a.test/b", "v"), null);
  assert.ok(await cache.get("https://a.test/c", "v"));
  assert.equal(cache.snapshot().bytes, 200);
  await settle();
  assert.equal(fs.readdirSync(dir).length, 2);
});

test("an image larger than the whole cap is not stored", async () => {
  const cache = createImageDiskCache({ dir: tempDir(), maxBytes: 50, ttlMs: DAY });
  assert.equal(await cache.set("https://a.test/big", "v", Buffer.alloc(51), "image/jpeg"), false);
  assert.equal(cache.snapshot().entries, 0);
});

test("the index is rebuilt from the directory, so a restart keeps the cache", async () => {
  const dir = tempDir();
  const first = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: DAY });
  await first.set("https://a.test/1.jpg", "v", Buffer.from("kept"), "image/jpeg");
  fs.writeFileSync(path.join(dir, "abandoned.jpg.123.tmp"), "half a write");
  fs.writeFileSync(path.join(dir, "README"), "not ours");

  const second = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: DAY });
  const hit = await second.get("https://a.test/1.jpg", "v");
  assert.equal(hit.buffer.toString(), "kept");
  assert.equal(second.snapshot().bytes, 4);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["README", fs.readdirSync(dir).find((n) => n.endsWith(".jpg"))].sort());
});

test("a restart drops expired entries, including those under an old key variant", async () => {
  const dir = tempDir();
  let clock = 1_000_000;
  const first = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: 500, now: () => clock });
  await first.set("https://a.test/old.png", "v", Buffer.from("old"), "image/png");
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.utimesSync(file, new Date(clock / 1000), new Date(clock / 1000));
  clock += 1000;
  const second = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: 500, now: () => clock });
  assert.equal(second.snapshot().entries, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a restart with a smaller cap trims the directory to fit", async () => {
  const dir = tempDir();
  const first = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: DAY });
  await first.set("https://a.test/a", "v", Buffer.alloc(100), "image/png");
  await first.set("https://a.test/b", "v", Buffer.alloc(100), "image/png");
  const second = createImageDiskCache({ dir, maxBytes: 150, ttlMs: DAY });
  assert.equal(second.snapshot().entries, 1);
  await settle();
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("a file deleted behind the cache's back is a miss, not an error", async () => {
  const dir = tempDir();
  const cache = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: DAY });
  await cache.set("https://a.test/1.jpg", "v", Buffer.from("gone"), "image/jpeg");
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name));
  }
  assert.equal(await cache.get("https://a.test/1.jpg", "v"), null);
  assert.equal(cache.snapshot().entries, 0);
});

test("an unwritable directory fails the store quietly", async () => {
  const dir = tempDir();
  const cache = createImageDiskCache({ dir, maxBytes: 1000, ttlMs: DAY });
  fs.rmSync(dir, { recursive: true });
  assert.equal(await cache.set("https://a.test/1.jpg", "v", Buffer.from("x"), "image/jpeg"), false);
  assert.equal(await cache.get("https://a.test/1.jpg", "v"), null);
});

// --- route wiring, asserted against the source (see proxy_image_resize.test.mjs)

const serverSource = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

test("the cache lookup is mounted ahead of the image slot pool", () => {
  const lookup = serverSource.indexOf("imageProxyCache.get(");
  const guard = serverSource.indexOf('app.use("/api/proxy/image", imageProxyConcurrencyGuard)');
  assert.ok(lookup > 0 && guard > 0);
  assert.ok(lookup < guard, "a hit must not need a concurrency slot");
});

test("only sniffed, downscaled bytes are stored", () => {
  assert.match(serverSource, /imageProxyCache\.set\(imageUrl, PROXY_IMAGE_CACHE_VARIANT, downscaled\.buffer, downscaled\.contentType\)/);
});
