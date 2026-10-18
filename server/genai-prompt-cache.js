// Disk cache for whole text-to-image batches, keyed on the prompt and every
// setting that shapes the result, so a second visitor typing the same prompt
// within `ttlMs` is served the first one's images and nothing is bought.
//
// The bytes go through the same store as the image proxy (expiry, byte cap,
// least recently used out). A small manifest per batch carries what the bytes
// cannot: how many images there were, and each one's seed and size. A batch
// with any image evicted is a miss. Neither file holds the prompt text.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createImageDiskCache } from "./image-cache.js";

const MANIFEST_NAME = /^[A-Za-z0-9_-]{8,160}\.json$/;

export function createGenAiPromptCache({ dir, maxBytes, ttlMs, now = Date.now }) {
  const images = createImageDiskCache({ dir: dir ? path.join(dir, "images") : "", maxBytes, ttlMs, now });
  const enabled = images.enabled;
  const manifestDir = dir ? path.join(dir, "batches") : "";
  const stats = { hits: 0, misses: 0, stored: 0 };

  if (enabled) {
    fs.mkdirSync(manifestDir, { recursive: true });
    sweepManifests();
  }

  function manifestPath(key) {
    return path.join(manifestDir, `${key}.json`);
  }

  // Boot only: a manifest whose images were evicted is otherwise removed on its
  // next lookup, and one nobody asks for again would stay for good.
  function sweepManifests() {
    const cutoff = now() - ttlMs;
    for (const name of fs.readdirSync(manifestDir)) {
      const file = path.join(manifestDir, name);
      try {
        if (!MANIFEST_NAME.test(name) || fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }

  async function get(key) {
    if (!enabled || !key) {
      return null;
    }
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath(key), "utf8"));
    } catch {
      stats.misses += 1;
      return null;
    }
    const entries = Array.isArray(manifest.images) ? manifest.images : [];
    const loaded = now() - Number(manifest.storedAt) <= ttlMs && entries.length > 0
      ? await Promise.all(entries.map((_, index) => images.get(`${key}/${index}`)))
      : [];
    if (!loaded.length || loaded.some((image) => !image)) {
      fsp.rm(manifestPath(key), { force: true }).catch(() => {});
      stats.misses += 1;
      return null;
    }
    stats.hits += 1;
    return {
      provider: String(manifest.provider || ""),
      images: loaded.map((image, index) => ({ ...entries[index], ...image }))
    };
  }

  // Never throws, and writes the manifest last: a batch is only findable once
  // every image is on disk.
  async function set(key, { provider, images: batch }) {
    if (!enabled || !key || !batch.length) {
      return false;
    }
    try {
      for (const [index, image] of batch.entries()) {
        if (!(await images.set(`${key}/${index}`, "", image.buffer, image.contentType))) {
          return false;
        }
      }
      const manifest = {
        storedAt: now(),
        provider,
        images: batch.map(({ seed, width, height }) => ({ seed, width, height }))
      };
      const target = manifestPath(key);
      const temp = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(manifest));
      await fsp.rename(temp, target);
    } catch (err) {
      console.warn(`GenAI prompt cache write failed: ${err.message}`);
      return false;
    }
    stats.stored += 1;
    return true;
  }

  function snapshot() {
    const { enabled: _enabled, hits: _hits, misses: _misses, stored: _stored, ...disk } = images.snapshot();
    return { enabled, ...disk, ...stats };
  }

  return { enabled, get, set, snapshot };
}
