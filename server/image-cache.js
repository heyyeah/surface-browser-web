// Disk cache for /api/proxy/image, shared by every visitor. Holds the bytes the
// route was about to send (already sniffed and downscaled), so a hit costs one
// file read: no upstream fetch, no sharp, no concurrency slot.
//
// The index lives in memory and is rebuilt from the directory at boot, so the
// cache survives a restart. Bounded two ways: entries expire after `ttlMs`, and
// the least recently used are deleted once the total passes `maxBytes`.

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// The content type is carried in the file extension, and only these are ever
// served back — the same four the route's sniffer can produce.
const EXTENSION_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};
const TYPE_BY_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSION_BY_TYPE).map(([type, extension]) => [extension, type])
);
const ENTRY_NAME = /^([0-9a-f]{64})\.(jpg|png|webp|gif)$/;
const TEMP_NAME = /\.tmp$/;

export function createImageDiskCache({ dir, maxBytes, ttlMs, now = Date.now }) {
  const enabled = Boolean(dir) && maxBytes > 0 && ttlMs > 0;
  // key -> { extension, size, storedAt }. Map order is recency: a hit re-inserts
  // its entry, so the first key is always the least recently used.
  const index = new Map();
  const stats = { hits: 0, misses: 0, stored: 0, evicted: 0 };
  let totalBytes = 0;

  if (enabled) {
    loadIndex();
  }

  function keyFor(url, variant) {
    return createHash("sha256").update(`${variant}\n${url}`).digest("hex");
  }

  function filePath(key, extension) {
    return path.join(dir, `${key}.${extension}`);
  }

  function loadIndex() {
    fs.mkdirSync(dir, { recursive: true });
    const found = [];
    for (const name of fs.readdirSync(dir)) {
      const match = ENTRY_NAME.exec(name);
      if (!match) {
        // A write the last process never finished.
        if (TEMP_NAME.test(name)) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
        continue;
      }
      try {
        const stat = fs.statSync(path.join(dir, name));
        found.push({ key: match[1], extension: match[2], size: stat.size, storedAt: stat.mtimeMs });
      } catch {
        // Vanished between readdir and stat.
      }
    }
    found.sort((a, b) => a.storedAt - b.storedAt);
    const cutoff = now() - ttlMs;
    for (const { key, ...entry } of found) {
      // Expired, or filed under a variant no longer asked for.
      if (entry.storedAt < cutoff) {
        fs.rmSync(filePath(key, entry.extension), { force: true });
        continue;
      }
      index.set(key, entry);
      totalBytes += entry.size;
    }
    evictOverBudget();
  }

  function drop(key) {
    const entry = index.get(key);
    if (!entry) {
      return;
    }
    index.delete(key);
    totalBytes -= entry.size;
    fsp.rm(filePath(key, entry.extension), { force: true }).catch(() => {});
  }

  function evictOverBudget() {
    for (const key of index.keys()) {
      if (totalBytes <= maxBytes) {
        break;
      }
      drop(key);
      stats.evicted += 1;
    }
  }

  async function get(url, variant = "") {
    if (!enabled) {
      return null;
    }
    const key = keyFor(url, variant);
    const entry = index.get(key);
    if (!entry) {
      stats.misses += 1;
      return null;
    }
    if (now() - entry.storedAt > ttlMs) {
      drop(key);
      stats.misses += 1;
      return null;
    }
    let buffer;
    try {
      buffer = await fsp.readFile(filePath(key, entry.extension));
    } catch {
      // Deleted underneath us (an operator clearing the directory).
      drop(key);
      stats.misses += 1;
      return null;
    }
    if (index.get(key) === entry) {
      index.delete(key);
      index.set(key, entry);
    }
    stats.hits += 1;
    return { buffer, contentType: TYPE_BY_EXTENSION[entry.extension] };
  }

  // Never throws: a full disk or a permissions error must not fail a request
  // whose image is already in hand.
  async function set(url, variant, buffer, contentType) {
    const extension = EXTENSION_BY_TYPE[contentType];
    if (!enabled || !extension || !buffer.length || buffer.length > maxBytes) {
      return false;
    }
    const key = keyFor(url, variant);
    const target = filePath(key, extension);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // Rename, so a reader never sees a half-written image.
      await fsp.writeFile(temp, buffer);
      await fsp.rename(temp, target);
    } catch (err) {
      fsp.rm(temp, { force: true }).catch(() => {});
      console.warn(`Image cache write failed: ${err.message}`);
      return false;
    }
    const previous = index.get(key);
    if (previous) {
      index.delete(key);
      totalBytes -= previous.size;
      // A GIF that now arrives as a PNG would otherwise leave its old file behind.
      if (previous.extension !== extension) {
        fsp.rm(filePath(key, previous.extension), { force: true }).catch(() => {});
      }
    }
    index.set(key, { extension, size: buffer.length, storedAt: now() });
    totalBytes += buffer.length;
    stats.stored += 1;
    evictOverBudget();
    return true;
  }

  function snapshot() {
    return { enabled, entries: index.size, bytes: totalBytes, maxBytes, ttlMs, ...stats };
  }

  return { enabled, get, set, snapshot };
}
