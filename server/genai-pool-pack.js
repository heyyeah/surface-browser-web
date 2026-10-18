// Reading side of a pre-baked curated pack (baked by scripts/prebake_pool.mjs).
//
// Read-only by design: nothing writes a pack or folds a generated image back
// into one. Releases are immutable, which makes them safe to cache forever and
// roll back to. Deletion is therefore a tombstone: applyPoolSuppression() hides
// members by content address from a list kept outside the pack (see
// genai-pool-suppression.js).
//
// Split out of index.js, which starts a listening server on import.
//
// A broken pack must not take the server down: every failure here (missing
// directory, unparseable manifest, wrong version, a member whose file is
// missing) degrades to pool-off, or one fewer member, with a reason string.

import fs from "node:fs";
import path from "node:path";

// The manifest shape this can read. v1 keyed variations on the prompt lineage,
// with width/height/steps zero, so its keys cannot be reproduced by a runtime
// lookup. Refused rather than mixed in.
export const POOL_MANIFEST_VERSION = 2;

const POOL_OFF = Object.freeze({
  active: false,
  dir: "",
  keyCount: 0,
  memberCount: 0,
  suppressedCount: 0,
  missingFiles: 0,
  error: "",
  keys: new Map(),
  entries: new Map(),
  byId: new Map()
});

const CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

export function loadPoolPack(dir) {
  const root = String(dir || "").trim();
  if (!root) {
    return POOL_OFF;
  }
  const manifestPath = path.join(root, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ...POOL_OFF, dir: root, error: `${manifestPath}: ${err.message}` };
  }
  if (manifest?.version !== POOL_MANIFEST_VERSION) {
    return {
      ...POOL_OFF,
      dir: root,
      error: `${manifestPath} is manifest v${manifest?.version}; this server reads v${POOL_MANIFEST_VERSION} only — re-bake the pack rather than mixing them`
    };
  }
  if (!manifest.keys || typeof manifest.keys !== "object") {
    return { ...POOL_OFF, dir: root, error: `${manifestPath} has no keys` };
  }

  const { entries, byId, memberCount, missingFiles } = loadPoolEntries(root, manifest.keys, "baked");

  if (!entries.size) {
    return { ...POOL_OFF, dir: root, missingFiles, error: `${manifestPath} lists no usable members` };
  }
  return applyPoolSuppression(
    { active: true, dir: root, keyCount: entries.size, memberCount, suppressedCount: 0, missingFiles, error: "", keys: new Map(), entries, byId },
    null
  );
}

// The drawable view of a loaded pack: `keys` holds only what may be served, so
// poolMemberCount() (pool depth, including the "cannot fill more slots than
// members" clamp) never counts a suppressed member. `entries` keeps every
// member so the review page can show and restore it.
//
// A pack whose every member is suppressed stays `active` with an empty `keys`:
// the request is then fully generated, as for a cold key.
export function applyPoolSuppression(pack, suppressedIds) {
  if (!pack?.entries?.size) {
    return pack;
  }
  const ids = suppressedIds instanceof Set ? suppressedIds : new Set(suppressedIds || []);
  const keys = new Map();
  let memberCount = 0;
  let suppressedCount = 0;
  for (const [key, entry] of pack.entries) {
    const active = [];
    for (const member of entry.members) {
      member.suppressed = ids.has(member.id);
      if (member.suppressed) {
        suppressedCount += 1;
      } else {
        active.push(member);
      }
    }
    if (active.length) {
      keys.set(key, active);
      memberCount += active.length;
    }
  }
  return { ...pack, keys, keyCount: keys.size, memberCount, suppressedCount };
}

// Shared by the pack and the grown store (genai-pool-grow.js), which writes
// the same manifest shape. `store` says which one a member was loaded from.
export function loadPoolEntries(root, manifestKeys, store) {
  const entries = new Map();
  const byId = new Map();
  let memberCount = 0;
  let missingFiles = 0;
  for (const [key, entry] of Object.entries(manifestKeys || {})) {
    const members = [];
    for (const member of entry?.members || []) {
      const loaded = loadPoolMember(root, key, entry, member, store);
      if (!loaded) {
        missingFiles += 1;
        continue;
      }
      members.push(loaded);
      if (!byId.has(loaded.id)) {
        byId.set(loaded.id, loaded);
      }
    }
    if (!members.length) {
      continue;
    }
    entries.set(key, toPoolEntry(key, entry, members));
    memberCount += members.length;
  }
  return { entries, byId, memberCount, missingFiles };
}

// null when the member's file is missing or escapes the root.
export function loadPoolMember(root, key, entry, member, store) {
  const resolved = resolveMemberFile(root, member?.file);
  if (!resolved) {
    return null;
  }
  // Content address is the identity a suppression survives a re-bake on; the
  // relative path is only a fallback for a manifest without sha256.
  return {
    id: String(member.sha256 || member.file),
    key,
    store,
    file: String(member.file),
    path: resolved,
    contentType: CONTENT_TYPES.get(path.extname(resolved).toLowerCase()) || "image/png",
    bytes: Number.isFinite(Number(member.bytes)) ? Number(member.bytes) : null,
    width: toDimension(member.width),
    height: toDimension(member.height),
    seed: Number.isFinite(Number(member.seed)) ? Number(member.seed) : null,
    strength: member.strength ?? null,
    emoji: member.emoji || null,
    model: member.model || entry?.model || null,
    baseId: member.baseId ?? null,
    // Creation instant in both stores; the review page's date range reads it.
    bakedAt: typeof member.bakedAt === "string" ? member.bakedAt : "",
    sentPrompt: member.sentPrompt ?? null
  };
}

export function toPoolEntry(key, entry, members) {
  return {
    key,
    kind: entry?.kind || "",
    model: entry?.model || null,
    prompt: entry?.prompt || "",
    emoji: entry?.emoji || null,
    sourceKey: entry?.sourceKey || "",
    width: toDimension(entry?.width),
    height: toDimension(entry?.height),
    steps: Number.isFinite(Number(entry?.steps)) ? Number(entry.steps) : null,
    strength: entry?.strength ?? null,
    members
  };
}

// The pack and the grown store as one pool. Bytes present in both count once,
// so a re-bake that absorbed grown images does not make them twice as likely.
// Unsuppressed; the caller applies the tombstones.
export function mergePools(baked, grown) {
  if (!grown?.active) {
    return baked;
  }
  const entries = new Map();
  const byId = new Map();
  for (const source of [baked, grown]) {
    for (const [key, entry] of source?.entries || []) {
      for (const member of entry.members) {
        if (source === grown && baked?.byId?.has(member.id)) {
          continue;
        }
        if (!entries.has(key)) {
          entries.set(key, { ...entry, members: [] });
        }
        entries.get(key).members.push(member);
        if (!byId.has(member.id)) {
          byId.set(member.id, member);
        }
      }
    }
  }
  return applyPoolSuppression({
    active: true,
    dir: baked?.dir || "",
    keyCount: 0,
    memberCount: 0,
    suppressedCount: 0,
    missingFiles: (baked?.missingFiles || 0) + (grown.missingFiles || 0),
    error: baked?.error || "",
    keys: new Map(),
    entries,
    byId
  }, null);
}

export function poolMemberCount(pack, key) {
  return pack?.keys?.get(key)?.length || 0;
}

// The bytes of one member, or null when unreadable. Callers treat null as "not
// pooled after all": a vanished pack file costs one generated image, not a 500.
export function readPoolMember(pack, key, index) {
  const member = pack?.keys?.get(key)?.[index];
  if (!member) {
    return null;
  }
  try {
    const buffer = fs.readFileSync(member.path);
    return buffer.length ? { buffer, contentType: member.contentType, member } : null;
  } catch {
    return null;
  }
}

// A manifest is untrusted data: a `file` of "../../etc/shadow" must not become a
// path this server reads and serves.
function resolveMemberFile(root, file) {
  const relative = String(file || "");
  if (!relative || path.isAbsolute(relative)) {
    return null;
  }
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return fs.existsSync(resolved) ? resolved : null;
}

function toDimension(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}
