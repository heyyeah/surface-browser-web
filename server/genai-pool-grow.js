// The writable half of the pool: fresh images from bookmarked GenAI prompts.
//
// Separate from the baked pack, which is an immutable, root-owned release the
// service user cannot write. Grown members use the same manifest-v2 shape, so
// index.js draws from both as one pool (mergePools).
//
// index.js files each image under the key its slot was planned against, which
// is the key the draw looks up; nothing here derives a key.
//
// A corrupt manifest is not an empty one: it is refused (store off, reason in
// `error`) and never rewritten, since starting fresh would discard every member.
// Only a missing manifest is an empty store.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { normalizeText } from "./genai-pool.js";
import { POOL_MANIFEST_VERSION, loadPoolEntries, loadPoolMember, toPoolEntry } from "./genai-pool-pack.js";

const GROW_OFF = Object.freeze({
  active: false,
  dir: "",
  error: "",
  manifest: null,
  keyCount: 0,
  memberCount: 0,
  missingFiles: 0,
  entries: new Map(),
  byId: new Map()
});

const EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"]
]);

export function loadGrowStore(dir) {
  const root = String(dir || "").trim();
  if (!root) {
    return GROW_OFF;
  }
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      ...GROW_OFF,
      active: true,
      dir: root,
      manifest: { version: POOL_MANIFEST_VERSION, createdAt: new Date().toISOString(), keys: {} }
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ...GROW_OFF, dir: root, error: `${manifestPath}: ${err.message}` };
  }
  if (manifest?.version !== POOL_MANIFEST_VERSION || !manifest.keys || typeof manifest.keys !== "object" || Array.isArray(manifest.keys)) {
    return { ...GROW_OFF, dir: root, error: `${manifestPath} is not a v${POOL_MANIFEST_VERSION} pool manifest with keys` };
  }
  const loaded = loadPoolEntries(root, manifest.keys, "grown");
  return { ...GROW_OFF, active: true, dir: root, manifest, ...loaded, keyCount: loaded.entries.size };
}

export function bookmarkPromptSet(prompts) {
  return new Set((prompts || []).map((prompt) => normalizeText(prompt)).filter(Boolean));
}

// Which round of a bookmark lineage a request is: 1 to `maxRound`, or 0 (not
// pooled).
//
// The lineage's starting prompt decides, not who clicked: later rounds are
// pooled whoever triggered them. Never pooled: a prompt that is not a bookmark
// (normalized as the pool key normalizes it), a negative prompt, an imported
// raster (`origin` "url"/"image_search") anywhere in the lineage, and rounds
// past `maxRound`.
export function poolGrowthRound({ prompt, negativePrompt = "", sourceRecord = null, bookmarkPrompts, maxRound = 2 }) {
  const normalized = normalizeText(prompt);
  if (!normalized || !bookmarkPrompts?.has(normalized) || normalizeText(negativePrompt)) {
    return 0;
  }
  if (!sourceRecord) {
    return 1;
  }
  // null is a generated image; "pool" a drawn one. Anything else was imported.
  const origin = sourceRecord.origin ?? null;
  if (origin !== null && origin !== "pool") {
    return 0;
  }
  if (normalizeText(sourceRecord.genai?.prompt) !== normalized) {
    return 0;
  }
  // genai.round is 0 when the lineage was imported. A record without one
  // predates it, and only a parentless one is known to be round 1.
  const sourceRound = sourceRecord.genai?.round ?? (sourceRecord.genai?.parentId ? 0 : 1);
  const round = sourceRound ? sourceRound + 1 : 0;
  return round <= maxRound ? round : 0;
}

// Write one image and its manifest entry, then return the updated store.
// Never throws: `{ store, error }` leaves the store (and memory) unchanged.
//
// Both writes are temp + rename, so a crash can leave an orphaned image file but
// never a half-written manifest. Files are named by content address, so a retry
// of the same bytes reuses one.
export function addGrownMember(store, { key, entry, member, buffer, contentType }) {
  if (!store?.active) {
    return { store, error: store?.error || "grown store is off" };
  }
  const file = `images/${member.sha256}.${EXTENSIONS.get(contentType) || "png"}`;
  const absolute = path.join(store.dir, file);
  const raw = { ...member, file, bytes: buffer.length };
  const previous = store.manifest.keys[key];
  const nextEntry = { ...(previous || entry), members: [...(previous?.members || []), raw] };
  const manifest = {
    ...store.manifest,
    updatedAt: new Date().toISOString(),
    keys: { ...store.manifest.keys, [key]: nextEntry }
  };
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!fs.existsSync(absolute)) {
      writeAtomically(absolute, buffer);
    }
    writeAtomically(path.join(store.dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  } catch (err) {
    return { store, error: err.message };
  }

  const loaded = loadPoolMember(store.dir, key, nextEntry, raw, "grown");
  const entries = new Map(store.entries);
  const current = entries.get(key);
  entries.set(key, current ? { ...current, members: [...current.members, loaded] } : toPoolEntry(key, nextEntry, [loaded]));
  const byId = new Map(store.byId);
  if (!byId.has(loaded.id)) {
    byId.set(loaded.id, loaded);
  }
  return {
    store: { ...store, manifest, entries, byId, keyCount: entries.size, memberCount: store.memberCount + 1 },
    member: loaded
  };
}

function writeAtomically(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
