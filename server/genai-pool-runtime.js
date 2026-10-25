import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { downscaleProxiedImage } from "./images.js";
import { buildPoolKey, drawPoolIndexes, planPoolDraw, planPoolFallback, poolSourceAddress } from "./genai-pool.js";
import { applyPoolSuppression, loadPoolPack, mergePools, poolMemberCount, readPoolMember } from "./genai-pool-pack.js";
import { addGrownMember, bookmarkPromptSet, loadGrowStore, poolGrowthRound } from "./genai-pool-grow.js";
import { defaultSuppressionPath, readSuppression, writeSuppression } from "./genai-pool-suppression.js";
import { clampNumber, parseBoolean, parseNonNegativeInteger, parsePositiveInteger } from "./env.js";
import { logApiQuery } from "./query-log.js";
import { getFalTextModel, getGenAiProvider, getIntegerSetting, getOptionalIntegerSetting } from "./settings.js";
import { genAiImageStore, storeGenAiImageSource } from "./genai-store.js";
import { composeVaryModifier } from "./genai-vary.js";
import {
  FAL_FLUX_2_KLEIN_4B_TEXT_MODEL,
  getVariationStrengthRamp,
  resolveFalKleinEditImageSize,
  resolveFalRequestImageSize
} from "./genai-providers.js";
import { genAiBookmarkPrompts } from "../shared/bookmark-presets.js";
// The pre-baked curated pack this server draws from. Unset (the default) means
// no pool and every GenAI request is generated; a dev checkout needs no pack.
// Production points it at one shipped release directory.
export const GENAI_POOL_DIR = process.env.GENAI_POOL_DIR ? path.resolve(process.env.GENAI_POOL_DIR) : "";
// The guaranteed-new quota per batch, picked in this range per request. It is
// the only paid part of a warm run and keeps the piece producing unseen images
// once the pool is deep. 0/0 would make a warm sphere fully pre-baked and static.
const GENAI_POOL_FRESH_MIN = parseNonNegativeInteger(process.env.GENAI_POOL_FRESH_MIN, 1);
const GENAI_POOL_FRESH_MAX = parseNonNegativeInteger(process.env.GENAI_POOL_FRESH_MAX, 2);
// The writable half of the pool (server/genai-pool-grow.js): fresh images from
// GenAI bookmark lineages (up to GENAI_POOL_GROW_MAX_ROUND), kept and drawn like baked ones. Unset =
// nothing is kept. Works with or without GENAI_POOL_DIR. Unlike the pack, this
// directory must be owned by the service user.
export const GENAI_POOL_GROW_DIR = process.env.GENAI_POOL_GROW_DIR ? path.resolve(process.env.GENAI_POOL_GROW_DIR) : "";
// Drawable members per key before a key stops growing. 8: a batch draws at most
// GENAI_COUNT (5) from one key, so repeat visits rarely replay the same sphere.
const GENAI_POOL_GROW_MAX_PER_KEY = parseNonNegativeInteger(process.env.GENAI_POOL_GROW_MAX_PER_KEY, 8);
// Images a day that grow the pool are charged to one shared bucket of this size
// instead of the visitor's per-IP cap. Round 2 keys are base × emoji, so the
// per-key cap alone does not bound the money; this does. The global cap still
// applies. 0 = growth is charged to the visitor like any other request.
export const GENAI_POOL_GROW_DAILY_CAP = parseNonNegativeInteger(process.env.GENAI_POOL_GROW_DAILY_CAP, 300);
export const POOL_GROW_SPEND_KEY = "pool-grow";
// Generations of a bookmark lineage that are kept: 1 is the bookmark's own
// images, 2 their variations, and so on.
const GENAI_POOL_GROW_MAX_ROUND = parseNonNegativeInteger(process.env.GENAI_POOL_GROW_MAX_ROUND, 4);
// Where the review page's deletions are recorded. Default: a SIBLING of the
// pack, "<pack dir>.suppressed.json" — outside the release, so push-curated.sh
// neither refuses to write because of it nor overwrites it. Point several
// releases at one file to carry a curation across a re-bake.
const GENAI_POOL_SUPPRESS_FILE = process.env.GENAI_POOL_SUPPRESS_FILE
  ? path.resolve(process.env.GENAI_POOL_SUPPRESS_FILE)
  : defaultSuppressionPath(GENAI_POOL_DIR || GENAI_POOL_GROW_DIR);

// Loaded once, at boot: the pack is immutable. The suppression list and the grown
// store are the mutable parts: read at boot, then updated in memory as they are
// written, with genAiPool rebuilt from all three.
let bakedGenAiPool;
let grownGenAiPool;
let poolSuppression;
let GENAI_BOOKMARK_PROMPTS;

// The live pool. Growth and suppression replace it, so every reader goes through
// this holder rather than keeping its own reference.
export const genAiPool = {
  pool: null,
  rebuild() {
    this.pool = rebuildGenAiPool();
    return this.pool;
  }
};

// genai-jobs.js state, handed over by index.js: genai-jobs imports this module.
let isGenAiQueueFull;
let genAiResultCache;

// Boot: returns the bookmark prompt set, which the query log needs too.
export function initGenAiPoolRuntime(deps) {
  ({ isGenAiQueueFull, genAiResultCache } = deps);
  bakedGenAiPool = loadPoolPack(GENAI_POOL_DIR);
  grownGenAiPool = loadGrowStore(GENAI_POOL_GROW_DIR);
  poolSuppression = readSuppression(GENAI_POOL_SUPPRESS_FILE);
  genAiPool.rebuild();
  GENAI_BOOKMARK_PROMPTS = bookmarkPromptSet(genAiBookmarkPrompts());
  return GENAI_BOOKMARK_PROMPTS;
}

export function handlePoolReviewPage(_req, res) {
  let html;
  try {
    html = fs.readFileSync(new URL("./pool-review.html", import.meta.url), "utf8");
  } catch (err) {
    res.status(500).type("text/plain").send(`pool-review.html could not be read: ${err.message}`);
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.type("html").send(html);
}

export function handlePoolMembers(req, res) {
  res.setHeader("cache-control", "no-store");
  res.json(buildPoolReview(req.query));
}

export async function handlePoolImage(req, res) {
  const member = genAiPool.pool.byId?.get(String(req.params.id));
  if (!member) {
    res.status(404).json({ error: "No such pool member" });
    return;
  }
  const edge = clampNumber(req.query.w, 64, 2048, 0);
  try {
    const image = await readPoolReviewImage(member, edge);
    res.setHeader("content-type", image.contentType);
    res.setHeader("cache-control", "no-store");
    res.send(image.buffer);
  } catch (err) {
    res.status(404).json({ error: `Pool member unreadable: ${err.message}` });
  }
}

export function handlePoolSuppress(req, res) {
  // Refusing rather than starting a fresh list: overwriting a store we could
  // not parse would silently discard every deletion already in it.
  if (poolSuppression.error) {
    res.status(500).json({ error: `Suppression list unreadable (${poolSuppression.error}) — fix or remove that file before deleting anything` });
    return;
  }
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => String(id)).filter(Boolean) : [];
  if (!ids.length) {
    res.status(400).json({ error: "No members given" });
    return;
  }
  const suppress = req.body?.suppressed !== false;
  const reason = String(req.body?.reason || "").slice(0, 200);
  const records = new Map(poolSuppression.records);
  let changed = 0;
  for (const id of ids) {
    const member = genAiPool.pool.byId?.get(id);
    if (!member) {
      continue;
    }
    if (suppress) {
      if (records.has(id)) {
        continue;
      }
      records.set(id, { at: new Date().toISOString(), file: member.file, reason });
    } else if (!records.delete(id)) {
      continue;
    }
    changed += 1;
  }
  if (changed) {
    try {
      writeSuppression(poolSuppression.path, records);
    } catch (err) {
      res.status(500).json({ error: `Could not write ${poolSuppression.path}: ${err.message}` });
      return;
    }
    poolSuppression = { ...poolSuppression, records, ids: new Set(records.keys()) };
    genAiPool.rebuild();
    // A cached result replays above the draw, so a deleted image could
    // otherwise still come back for the rest of the cache's TTL.
    genAiResultCache.clear();
  }
  res.json({ ok: true, changed, suppressedCount: genAiPool.pool.suppressedCount, memberCount: genAiPool.pool.memberCount });
}

// --- the curated pool ------------------------------------------------------
//
// A batch is mostly images drawn from the pre-baked pack plus one or two
// guaranteed-new ones, interleaved and indistinguishable in the response. A
// slot's key must be built from the same values the provider would have been
// sent for that slot.

export function logGenAiPoolStartup() {
  if (GENAI_POOL_DIR) {
    if (!bakedGenAiPool.active) {
      const fallback = grownGenAiPool.active ? "drawing from the grown store only" : "every image will be generated";
      console.warn(`GenAI pool DISABLED (${fallback}): ${bakedGenAiPool.error}`);
    } else {
      const baked = applyPoolSuppression(bakedGenAiPool, poolSuppression.ids);
      const missing = baked.missingFiles
        ? `, ${baked.missingFiles} manifest entries had no file`
        : "";
      const hidden = baked.suppressedCount
        ? `, ${baked.suppressedCount} suppressed by ${poolSuppression.path}`
        : "";
      console.log(`GenAI pool: ${baked.keyCount} keys, ${baked.memberCount} members from ${baked.dir}${missing}${hidden}`);
    }
  }
  if (GENAI_POOL_GROW_DIR) {
    if (!grownGenAiPool.active) {
      console.warn(`GenAI pool growth DISABLED (nothing is kept and the store is not rewritten): ${grownGenAiPool.error}`);
    } else {
      console.log(`GenAI pool growth: ${grownGenAiPool.memberCount} members in ${grownGenAiPool.keyCount} keys at ${grownGenAiPool.dir}, at most ${GENAI_POOL_GROW_MAX_PER_KEY} per key, from ${GENAI_BOOKMARK_PROMPTS.size} bookmark prompts`);
    }
  }
  if ((GENAI_POOL_DIR || GENAI_POOL_GROW_DIR) && poolSuppression.error) {
    console.warn(`GenAI pool suppression list unreadable, nothing is hidden and it will not be written: ${poolSuppression.error}`);
  }
}

function rebuildGenAiPool() {
  return applyPoolSuppression(mergePools(bakedGenAiPool, grownGenAiPool), poolSuppression.ids);
}

// The one string a baker and this server have to agree on (see buildPoolKey).
// For fal it is the text model, which names the pair (getFalModelCapabilities
// refuses a config whose edit model is not its sibling). Other providers publish
// no model identity over their API, so the label degrades to the provider name;
// a pack baked on local weights of a hosted model is baked with an explicit
// --model.
function poolModelLabel() {
  const provider = getGenAiProvider();
  return provider === "fal" ? getFalTextModel() : provider;
}

function isFalKleinConfigured() {
  return getGenAiProvider() === "fal" && getFalTextModel() === FAL_FLUX_2_KLEIN_4B_TEXT_MODEL;
}

// Steps as the REQUEST will carry them, not as configured: addFalOptionalInputs
// sends Klein none at all (it is distilled and selects its own default), so a
// Klein pack keys on 0. Mirrors resolveEffectiveSteps in prebake_pool.mjs.
function poolRequestSteps() {
  if (isFalKleinConfigured()) {
    return 0;
  }
  return getOptionalIntegerSetting("GENAI_STEPS") ?? 0;
}

// The size this request will ask for. The baker keys on the size that came back;
// they agree because Klein edit is sent an explicit image_size and honours it. A
// provider that returns another size costs hit rate, not correctness.
function poolRequestImageSize(sourceRecord) {
  const boxSize = () => ({
    width: sourceRecord?.width || getIntegerSetting("GENAI_WIDTH"),
    height: sourceRecord?.height || getIntegerSetting("GENAI_HEIGHT")
  });
  if (getGenAiProvider() !== "fal") {
    return boxSize();
  }
  if (!sourceRecord) {
    return resolveFalRequestImageSize(null, null);
  }
  // Only Klein is sent an image_size; FLUX.1 img2img derives it from the input.
  return isFalKleinConfigured() ? resolveFalKleinEditImageSize(sourceRecord) : boxSize();
}

// One key per slot, not one per request. A vary batch picks a different emoji
// per image, so a slot's pool is unknown until its modifier is chosen, with
// exactly the seed and salt the generator will use for that slot. Otherwise slot
// N's image is made with a different emoji than the key it was drawn against,
// which silently poisons every future lookup. Both sides call
// composeVaryModifier(batchSeed, index); nothing else may pick it.
function buildGenAiPoolSlots({ prompt, negativePrompt, count, sourceRecord, batchSeed }) {
  const model = poolModelLabel();
  const size = poolRequestImageSize(sourceRecord);
  const steps = poolRequestSteps();
  const strengths = sourceRecord ? getVariationStrengthRamp(count) : [];
  const sourceKey = sourceRecord ? poolSourceAddress(sourceRecord.buffer) : "";
  const slots = [];
  for (let index = 0; index < count; index += 1) {
    // `style` only rewrites the sent prompt, never which emoji is picked, so the
    // provider's style override is not needed here.
    const modifier = sourceRecord
      ? composeVaryModifier({ basePrompt: prompt, sourceRecord, seed: batchSeed, salt: index }).modifier
      : null;
    // Klein has no denoising dial and varyImagesViaFal stores null rather than
    // inventing one, so the key has to say null too.
    const strength = sourceRecord && !isFalKleinConfigured() ? (strengths[index] ?? null) : null;
    slots.push({
      index,
      modifier,
      strength,
      pooled: null,
      grow: 0,
      // What a grown member's manifest entry records, in the baker's shape.
      entry: {
        kind: sourceRecord ? "variation" : "base",
        model,
        prompt,
        emoji: modifier?.emoji || null,
        sourceKey,
        width: size.width,
        height: size.height,
        steps,
        strength
      },
      key: buildPoolKey({
        model,
        prompt,
        negativePrompt,
        modifierStack: modifier ? (modifier.stack || [modifier.emoji]) : [],
        sourceKey,
        width: size.width,
        height: size.height,
        steps,
        strength
      })
    });
  }
  return slots;
}

export function planGenAiPoolBatch({ prompt, negativePrompt, count, sourceRecord, batchSeed }) {
  const growRound = grownGenAiPool.active
    ? poolGrowthRound({ prompt, negativePrompt, sourceRecord, bookmarkPrompts: GENAI_BOOKMARK_PROMPTS, maxRound: GENAI_POOL_GROW_MAX_ROUND })
    : 0;
  if (!genAiPool.pool.active && !growRound) {
    return null;
  }
  const pool = genAiPool.pool;
  const slots = buildGenAiPoolSlots({ prompt, negativePrompt, count, sourceRecord, batchSeed });
  for (const slot of slots) {
    slot.grow = growRound;
  }

  const capacity = new Map();
  for (const slot of slots) {
    capacity.set(slot.key, (capacity.get(slot.key) || 0) + 1);
  }
  let reusable = 0;
  for (const [key, wanted] of capacity) {
    // A pool cannot fill more slots than it has members: the same picture twice
    // in one sphere is worse than paying for the second.
    const usable = Math.min(poolMemberCount(pool, key), wanted);
    capacity.set(key, usable);
    reusable += usable;
  }
  // A request that grows the pool stays on the slotted path even when cold:
  // only there is each slot generated with the seed its key was planned with.
  if (reusable === 0 && !growRound) {
    // Nothing in the pack answers this request. Leave the existing paths
    // untouched rather than routing a fully-paid batch through here.
    return null;
  }

  const drawers = new Map();
  const drawFor = (slot) => {
    if (!drawers.has(slot.key)) {
      drawers.set(slot.key, createPoolDrawer(pool, slot.key));
    }
    return drawers.get(slot.key)();
  };

  // A bookmark key that has stopped growing buys nothing more: the pool is the
  // whole answer, so the request is free and no quota can refuse it.
  const growing = Boolean(growRound) && GENAI_POOL_GROW_MAX_PER_KEY > 0 &&
    slots.some((slot) => poolMemberCount(pool, slot.key) < GENAI_POOL_GROW_MAX_PER_KEY);
  const grownOut = Boolean(growRound) && !growing;

  // While every generator slot is busy, a fresh image costs this visitor a
  // 20-40 s wait in the queue, so the pool covers every slot it can.
  const plan = planPoolDraw({
    poolSize: reusable,
    count,
    newCount: isGenAiQueueFull() || grownOut ? 0 : Math.min(count, randomGenAiPoolFreshQuota())
  });

  // Pooled slots are chosen at random across the batch so pooled and fresh
  // interleave; taking the first N would put every new image at one end.
  let pooledCount = 0;
  for (const index of drawPoolIndexes({ poolSize: count, want: count })) {
    if (pooledCount >= plan.reuse) {
      break;
    }
    const slot = slots[index];
    if ((capacity.get(slot.key) || 0) <= 0) {
      continue;
    }
    // Read the bytes NOW, before the spend reservation: a member whose file has
    // vanished must become a generated slot while that is still free to decide.
    const payload = drawFor(slot);
    if (!payload) {
      continue;
    }
    capacity.set(slot.key, capacity.get(slot.key) - 1);
    slot.pooled = payload;
    pooledCount += 1;
  }

  return {
    slots,
    plan,
    reusable,
    pooledCount,
    freshCount: count - pooledCount,
    growing,
    drawFor
  };
}

// The pooled slots alone, renumbered: a smaller sphere that costs nothing.
export function poolOnlyGenAiBatch(poolBatch) {
  const slots = poolBatch.slots
    .filter((slot) => slot.pooled)
    .map((slot, index) => ({ ...slot, index }));
  return { ...poolBatch, slots, pooledCount: slots.length, freshCount: 0, growing: false };
}

// Every record drawn from one member file shares one Buffer and one WebP, so a
// pooled sphere costs the image store nothing however many visitors are shown
// it. Bounded by bytes: a grown pool has no fixed size.
const poolMemberBytes = new Map();
export let poolMemberBytesTotal = 0;
const POOL_MEMBER_BYTES_MAX = parsePositiveInteger(process.env.GENAI_POOL_MEMORY_MAX_BYTES, 150 * 1024 * 1024);

function readSharedPoolMember(pool, key, index) {
  const member = pool?.keys?.get(key)?.[index];
  const cached = member ? poolMemberBytes.get(member.path) : null;
  if (cached) {
    return { buffer: cached.buffer, contentType: member.contentType, member, shared: cached };
  }
  const payload = readPoolMember(pool, key, index);
  if (!payload) {
    return null;
  }
  const shared = { buffer: payload.buffer, deliveryWebp: null };
  poolMemberBytes.set(member.path, shared);
  poolMemberBytesTotal += payload.buffer.length;
  while (poolMemberBytesTotal > POOL_MEMBER_BYTES_MAX && poolMemberBytes.size > 1) {
    const [oldestPath, oldest] = poolMemberBytes.entries().next().value;
    poolMemberBytes.delete(oldestPath);
    poolMemberBytesTotal -= oldest.buffer.length;
  }
  return { ...payload, shared };
}

// One shuffle per key per request, consumed at most once each, so a batch that
// draws twice from the same pool cannot show one member twice.
//
// `pool` is the pool as planned. Growth replaces genAiPool mid-batch, and an
// image this batch just kept must not be drawn back into it by the fallback.
function createPoolDrawer(pool, key) {
  const size = poolMemberCount(pool, key);
  const order = drawPoolIndexes({ poolSize: size, want: size });
  let cursor = 0;
  return () => {
    while (cursor < order.length) {
      const payload = readSharedPoolMember(pool, key, order[cursor]);
      cursor += 1;
      if (payload) {
        return payload;
      }
    }
    return null;
  };
}

// --- what the review page reads --------------------------------------------

// Everything the review page needs to group a pack (prompt, then base image,
// then that base's emoji variations) without re-deriving a pool key. Depth is
// the drawable count and is never filtered; the suppressed count sits beside it
// so a thin key and a heavily pruned one are distinguishable.
function buildPoolReview(query = {}) {
  const filters = {
    from: parsePoolReviewDate(query.from, "start"),
    to: parsePoolReviewDate(query.to, "end"),
    prompt: String(query.prompt || "").trim().toLowerCase(),
    emoji: String(query.emoji || "").trim(),
    includeSuppressed: parseBoolean(query.suppressed, true)
  };
  const narrowed = filters.from !== null || filters.to !== null || Boolean(filters.prompt) || Boolean(filters.emoji);
  const prompts = new Set();
  const emoji = new Set();
  const keys = [];
  let totalMembers = 0;
  let grownMembers = 0;

  for (const entry of genAiPool.pool.entries?.values() || []) {
    if (entry.prompt) {
      prompts.add(entry.prompt);
    }
    let depth = 0;
    let suppressedDepth = 0;
    const members = [];
    for (const member of entry.members) {
      totalMembers += 1;
      if (member.store === "grown") {
        grownMembers += 1;
      }
      if (member.emoji) {
        emoji.add(member.emoji);
      }
      if (member.suppressed) {
        suppressedDepth += 1;
      } else {
        depth += 1;
      }
      if (poolReviewMemberMatches(member, entry, filters)) {
        members.push({
          id: member.id,
          file: member.file,
          bytes: member.bytes,
          width: member.width,
          height: member.height,
          seed: member.seed,
          strength: member.strength,
          emoji: member.emoji,
          model: member.model,
          baseId: member.baseId,
          store: member.store || "baked",
          bakedAt: member.bakedAt,
          sentPrompt: member.sentPrompt,
          suppressed: Boolean(member.suppressed),
          suppressedAt: poolSuppression.records.get(member.id)?.at || ""
        });
      }
    }
    // A key with nothing left to draw is the signal that it needs more baking,
    // so it stays listed even when the filter matched none of its members.
    if (members.length || (depth === 0 && !narrowed)) {
      keys.push({
        key: entry.key,
        kind: entry.kind,
        prompt: entry.prompt,
        emoji: entry.emoji,
        sourceKey: entry.sourceKey,
        model: entry.model,
        width: entry.width,
        height: entry.height,
        steps: entry.steps,
        strength: entry.strength,
        depth,
        suppressedDepth,
        members
      });
    }
  }

  return {
    ok: true,
    pack: {
      dir: genAiPool.pool.dir,
      active: Boolean(genAiPool.pool.active),
      error: genAiPool.pool.error || "",
      missingFiles: genAiPool.pool.missingFiles || 0,
      keyCount: genAiPool.pool.entries?.size || 0,
      totalMembers,
      grownMembers,
      memberCount: genAiPool.pool.memberCount || 0,
      suppressedCount: genAiPool.pool.suppressedCount || 0
    },
    grow: {
      dir: GENAI_POOL_GROW_DIR,
      active: Boolean(grownGenAiPool.active),
      error: grownGenAiPool.error || "",
      maxPerKey: GENAI_POOL_GROW_MAX_PER_KEY
    },
    suppression: { path: poolSuppression.path, error: poolSuppression.error || "" },
    filters: { ...filters, from: query.from || "", to: query.to || "" },
    facets: { prompts: [...prompts].sort(), emoji: [...emoji].sort() },
    keys
  };
}

function poolReviewMemberMatches(member, entry, filters) {
  if (!filters.includeSuppressed && member.suppressed) {
    return false;
  }
  if (filters.from !== null || filters.to !== null) {
    // A member with no bakedAt cannot be placed on the timeline, so a date
    // range excludes it rather than guessing which side it belongs on.
    const at = member.bakedAt ? Date.parse(member.bakedAt) : NaN;
    if (!Number.isFinite(at)) {
      return false;
    }
    if (filters.from !== null && at < filters.from) {
      return false;
    }
    if (filters.to !== null && at > filters.to) {
      return false;
    }
  }
  if (filters.prompt && !String(entry.prompt || "").toLowerCase().includes(filters.prompt)) {
    return false;
  }
  if (filters.emoji && (member.emoji || entry.emoji || "") !== filters.emoji) {
    return false;
  }
  return true;
}

// A bare YYYY-MM-DD covers the whole UTC day, so a range from a date to the same
// date is that day rather than its first instant. bakedAt is an ISO UTC instant.
function parsePoolReviewDate(value, edge) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${edge === "end" ? "23:59:59.999" : "00:00:00.000"}Z`
    : raw;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Thumbnails come off sharp and are worth keeping: a review pass scrolls the
// same grid repeatedly, and a pack is hundreds of full-size PNGs.
const poolReviewThumbnails = new Map();
const POOL_REVIEW_THUMBNAIL_CACHE_MAX = 600;

async function readPoolReviewImage(member, edge) {
  if (!edge) {
    return { buffer: fs.readFileSync(member.path), contentType: member.contentType };
  }
  const cacheKey = `${member.id}:${edge}`;
  const cached = poolReviewThumbnails.get(cacheKey);
  if (cached) {
    return cached;
  }
  const original = fs.readFileSync(member.path);
  const scaled = await downscaleProxiedImage(original, member.contentType, edge);
  const entry = { buffer: scaled.buffer, contentType: scaled.contentType };
  if (poolReviewThumbnails.size >= POOL_REVIEW_THUMBNAIL_CACHE_MAX) {
    poolReviewThumbnails.delete(poolReviewThumbnails.keys().next().value);
  }
  poolReviewThumbnails.set(cacheKey, entry);
  return entry;
}

// The hit rate, per request, in the query log. Absent (not zeroed) when no pool
// is configured, so a pool-off log is unchanged.
export function genAiPoolLogDetails(poolBatch) {
  return poolBatch ? { pooled: poolBatch.pooledCount, fresh: poolBatch.freshCount } : {};
}

function randomGenAiPoolFreshQuota() {
  const min = Math.min(GENAI_POOL_FRESH_MIN, GENAI_POOL_FRESH_MAX);
  const max = Math.max(GENAI_POOL_FRESH_MIN, GENAI_POOL_FRESH_MAX);
  return min === max ? min : randomInt(min, max + 1);
}

// Keeps a slot's fresh images, filed under the key that slot was PLANNED
// against — the key the draw looks up — so the next identical request draws
// them. Never throws: a full disk costs the pool an image, not the visitor one.
export function growGenAiPool(slot, items) {
  for (const item of items) {
    const record = item?.genai?.id ? genAiImageStore.get(item.genai.id) : null;
    if (!record?.buffer?.length) {
      continue;
    }
    const address = poolSourceAddress(record.buffer);
    // Shown as usual (fal blacks it out itself); never kept.
    if (record.providerFlagged) {
      logApiQuery("pool.grow_skipped", { reason: "provider_flagged", key: slot.key, id: address });
      continue;
    }
    // Filing an image made with another emoji under this key would poison it.
    if ((slot.modifier?.emoji || null) !== (item.genai.modifier?.emoji || null)) {
      console.warn(`GenAI pool growth: slot ${slot.index} was planned with ${slot.modifier?.emoji || "no emoji"} but made with ${item.genai.modifier?.emoji || "none"}; not kept`);
      continue;
    }
    // byId holds suppressed members too, so a deleted image is not kept again.
    if (genAiPool.pool.byId?.has(address) || poolMemberCount(genAiPool.pool, slot.key) >= GENAI_POOL_GROW_MAX_PER_KEY) {
      continue;
    }
    const result = addGrownMember(grownGenAiPool, {
      key: slot.key,
      entry: slot.entry,
      buffer: record.buffer,
      contentType: record.contentType,
      member: {
        sha256: address,
        width: record.width ?? null,
        height: record.height ?? null,
        seed: item.genai.seed ?? null,
        strength: slot.strength,
        emoji: slot.modifier?.emoji || null,
        model: slot.entry.model,
        baseId: slot.entry.sourceKey || null,
        sentPrompt: item.genai.modifier?.sentPrompt ?? null,
        bakedAt: new Date(record.createdAt).toISOString(),
        round: slot.grow
      }
    });
    if (result.error) {
      console.warn(`GenAI pool growth: could not keep ${address} in ${grownGenAiPool.dir}: ${result.error}`);
      continue;
    }
    grownGenAiPool = result.store;
    genAiPool.rebuild();
    logApiQuery("pool.grown", { key: slot.key, id: address, round: slot.grow, depth: poolMemberCount(genAiPool.pool, slot.key) });
  }
}

// A pooled image enters the same store as a generated one and is served by the
// same /api/genai/image/:id route, so the client needs no change and cannot
// tell them apart. That matters beyond tidiness: chording a pooled image varies
// from ITS bytes, whose content address is the sourceKey its own baked
// variations were keyed on.
export function storePooledGenAiItem(slot, { prompt, sourceRecord }) {
  const { buffer, contentType, member, shared } = slot.pooled;
  return storeGenAiImageSource({
    source: { buffer, contentType, shared },
    context: {
      prompt,
      seed: member.seed,
      strength: slot.strength,
      parentId: sourceRecord?.id || null,
      provider: getGenAiProvider(),
      width: member.width,
      height: member.height,
      origin: "pool",
      modifier: slot.modifier
        ? { ...slot.modifier, sentPrompt: member.sentPrompt ?? slot.modifier.sentPrompt }
        : null,
      // The bytes are already on disk in the pack; a second copy in
      // generated-images/ is not a record of what the piece made and only gives
      // the retention sweep more to carry.
      saveToDisk: false
    }
  });
}

// A failed generation falls back to the pool rather than to a gap, so a provider
// outage degrades the piece to fully-cached instead of breaking it. `delivered`
// counts generated images only; the pooled slots already drawn are plan.reuse
// and are not missing.
export function completeGenAiBatchFromPool({ poolBatch, fromIndex, delivered, prompt, sourceRecord }) {
  const fallback = planPoolFallback({
    plan: poolBatch.plan,
    delivered,
    poolSize: poolBatch.reusable,
    alreadyDrawn: poolBatch.plan.reuse
  });
  let extra = fallback.extraFromPool;
  const items = [];
  for (const slot of poolBatch.slots.slice(fromIndex)) {
    if (slot.preDelivered) {
      continue;
    }
    if (!slot.pooled) {
      if (extra <= 0) {
        continue;
      }
      slot.pooled = poolBatch.drawFor(slot);
      if (!slot.pooled) {
        continue;
      }
      extra -= 1;
    }
    items.push(storePooledGenAiItem(slot, { prompt, sourceRecord }));
  }
  return items;
}
