#!/usr/bin/env node
//
// Pre-bake a curated image pack for the GenAI pool.
//
//   node scripts/prebake_pool.mjs --dry-run
//   node scripts/prebake_pool.mjs --out ../curated/v1 --depth 10
//
// WHY IT DRIVES THE RUNNING SERVER instead of calling a model directly.
// The bytes are not the hard part; matching what the runtime would have made is.
// Sizing, the sampler, museum-safe, the modifier vocabulary, the replace-vs-append
// style and the image-to-image lineage all live in server/index.js, and a script
// that reimplemented any of them would bake a pack that looks subtly unlike the
// live piece and keys differently from it. So: start the API however you like —
// local weights, fal, anything — and this drives it.
//
//   npm run dev:api          # with GENAI_PROVIDER set to whatever you are baking on
//   node scripts/prebake_pool.mjs --dry-run
//
// WHAT A PACK CONTAINS: X bases per bookmark prompt, and Y emoji variations of
// each base. The bases are pool members too, under their own text-to-image key,
// so the FIRST image a visitor sees can come from the pool as well.
//
// AND HOW IT IS KEYED. Every variation records the content address of the base
// image it was actually made from as its `sourceKey`, so the emoji variations of
// one specific base are that base's own pool. Keying them on the prompt instead
// would pour every base made from a bookmark into one bucket, and a visitor who
// picked one image would then be shown variations of a different one. The
// address is the bytes' hash (poolSourceAddress), so the serving side can derive
// the same key from the same image without any of this script's bookkeeping.
//
// Sizes, steps and strength go into the key as the values the SERVER used, read
// back off the API response wherever the response carries them. Leaving them at
// buildPoolKey's zero defaults bakes a pack whose keys no runtime lookup can ever
// produce: every lookup misses, silently, and every request is paid for anyway.
//
// TWO WAYS TO GET A SPECIFIC EMOJI, and the default is the safe one.
//
// There is no request field for "use this modifier" — the server picks from
// GENAI_VARY_MODIFIERS. So:
//
//   default (sampling)  fire vary requests and bucket each returned image by the
//                       emoji the server ACTUALLY used, read back off the item.
//                       Touches no configuration at all. Coverage is random, so
//                       it fills a pool unevenly and needs more requests for the
//                       last few keys — but it is correct by construction, since
//                       the key records what was used rather than what was asked.
//
//   --pin               PUT a single-emoji vocabulary through /api/settings
//                       before each pass, restoring it in a `finally`. Exact
//                       coverage, one request per key.
//                       WARNING: /api/settings PERSISTS — it rewrites
//                       server/settings.local.json, the live device config. An
//                       interrupted run leaves a one-emoji vocabulary in it.
//                       Opt-in.
//
// RESUMABLE. Everything is keyed and the manifest is re-read on start, so an
// interrupted run — and a 1200-image run WILL be interrupted — picks up where it
// stopped. Re-running a finished pack is a no-op, not a second charge. The one
// limit: a base can only be topped up while the server still holds it, because
// varying from it needs its source id. A base whose source has expired keeps the
// images it already has and is reported, not silently re-bought.
//
// SAFETY. --dry-run makes no request and spends nothing; run it first. The
// summary it prints is the request count you are about to pay for.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPoolKey, poolSourceAddress } from "../server/genai-pool.js";
import { genAiBookmarkPrompts } from "../src/bookmark-presets.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoClient = path.join(here, "..");

const args = parseArgs(process.argv.slice(2));
const API = args.api || "http://127.0.0.1:8788";
const OUT = path.resolve(args.out || path.join(repoClient, "curated", "v1"));
const DEPTH = Number(args.depth || 10);        // members per key
const BASE_COUNT = Number(args.bases || 1);    // text-to-image roots per prompt
const VARY_COUNT = Number(args.count || 4);    // images per vary request
const DRY = Boolean(args["dry-run"]);
// Pinning rewrites settings.local.json. Off unless explicitly asked for.
const PIN = Boolean(args.pin);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
// The model LABEL that goes in the pool key. It must match poolModelLabel() in
// server/index.js exactly, or a pack baked here is invisible there — every
// lookup misses, silently, and every request is paid for anyway. On fal that
// label is the TEXT model, which names the pair (the edit sibling is validated
// against it), and it covers both the bases and their variations. NOT the
// provider: the same weights local and hosted answer the same request, so they
// are one pool — bake against local weights with --model set to the hosted
// model's label.
const MODEL = args.model || "fal-ai/flux-2/klein/4b";
// Consecutive sampling rounds that produce nothing new before giving up on
// the tail. Random emoji fill a pool fast and then stop; paying for rounds
// that land entirely in full keys is how a bake quietly burns budget.
const SAMPLE_STALL_LIMIT = Number(args.stall || 4);
// v1 manifest keys predate per-base variation pools and are unreachable, so a v1
// manifest is refused rather than mixed in.
const MANIFEST_VERSION = 2;

let requests = 0;
let made = 0;
let skipped = 0;

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

async function main() {
  const prompts = args.prompts ? String(args.prompts).split("|") : genAiBookmarkPrompts();
  const emojis = args.emoji ? splitEmoji(String(args.emoji)) : await readServerEmojiSet();

  if (!prompts.length) throw new Error("no prompts — pass --prompts 'a|b|c'");
  if (!emojis.length) throw new Error("no emoji — pass --emoji or configure GENAI_VARY_MODIFIERS");

  const steps = await resolveEffectiveSteps();
  const keys = prompts.length * BASE_COUNT * emojis.length;
  console.log(`prompts ${prompts.length} x bases ${BASE_COUNT} x emoji ${emojis.length} = ${keys} keys, depth ${DEPTH}`);
  console.log(`target  ${keys * DEPTH} variations + ${prompts.length * BASE_COUNT} bases  ->  ${OUT}`);
  console.log(`api     ${API}${DRY ? "   (DRY RUN — nothing is generated)" : ""}`);
  console.log(`mode    ${PIN ? "PIN (rewrites settings.local.json)" : "sampling (touches no config)"}`);
  console.log(`model   ${MODEL}   (must match the serving side)`);
  console.log(`steps   ${steps}   (0 = the request sends none)\n`);

  const manifest = readManifest();

  if (DRY) {
    for (const prompt of prompts) {
      reportDryRun(manifest, prompt, emojis, steps);
    }
    summarize();
    return;
  }

  // Settings are restored in `finally` — an interrupted bake must not leave the
  // dev server with a one-emoji vocabulary and no sign of why.
  const restore = PIN ? await readSettingValue("GENAI_VARY_MODIFIERS") : null;
  try {
    for (const prompt of prompts) {
      if (requests >= LIMIT) break;
      const state = promptState(manifest, prompt);
      const bases = await ensureBases(prompt, state, steps);
      if (!bases.length) console.log(`${prompt}  nothing to do`);
      for (const base of bases) {
        if (requests >= LIMIT) break;
        if (PIN) {
          await fillBasePinned(prompt, base, emojis, steps);
        } else {
          await fillBaseSampling(prompt, base, emojis, steps);
        }
        writeManifest(manifest);
      }
    }
  } finally {
    if (restore !== null) {
      await setSettingValue("GENAI_VARY_MODIFIERS", restore);
      console.log("\nrestored GENAI_VARY_MODIFIERS");
    }
  }

  writeManifest(manifest);
  summarize();
}

function summarize() {
  console.log(`\n${DRY ? "WOULD MAKE" : "made"} ${made} images in ${requests} requests`);
  console.log(`${skipped} keys already at depth`);
  if (DRY) {
    console.log(`\nrun again without --dry-run to bake. --limit N caps the requests.`);
  }
}

// --- keys ----------------------------------------------------------------

// A base is a text-to-image root: no modifier, no source, and the size the
// server produced it at.
function baseKeyFor(prompt, size, steps) {
  return buildPoolKey({ model: MODEL, prompt, width: size.width, height: size.height, steps });
}

// A variation belongs to the pool of the ONE base image it was made from.
function varyKeyFor(prompt, base, { emoji, size, steps, strength }) {
  return buildPoolKey({
    model: MODEL,
    prompt,
    modifierStack: [emoji],
    sourceKey: base.address,
    width: size.width,
    height: size.height,
    steps,
    strength
  });
}

// The strengths a batch actually used are only knowable from a returned batch:
// getVariationStrengthRamp derives them from the batch size, and Klein has no
// strength at all (null). So the coverage grid is emoji x strengths, and the
// strengths half is learned from the first round rather than assumed.
function varyBasis(base) {
  return base.vary || null;
}

function unitDepth(manifest, prompt, base, emoji, strength, steps) {
  const basis = varyBasis(base);
  if (!basis) return 0;
  const key = varyKeyFor(prompt, base, { emoji, size: basis, steps, strength });
  return (manifest.keys[key]?.members || []).length;
}

// A base has covered an emoji when its shallowest strength for that emoji is at
// depth — on Klein there is exactly one (null), so this is just the depth.
function emojiDepth(manifest, prompt, base, emoji, steps) {
  const basis = varyBasis(base);
  if (!basis) return 0;
  return Math.min(...basis.strengths.map((strength) => unitDepth(manifest, prompt, base, emoji, strength, steps)));
}

function learnVaryBasis(base, items) {
  if (base.vary || !items.length) return;
  const strengths = [...new Set(items.map((item) => item.genai?.strength ?? null))];
  base.vary = {
    width: items[0].width ?? null,
    height: items[0].height ?? null,
    strengths
  };
}

// --- bases ---------------------------------------------------------------

function promptState(manifest, prompt) {
  manifest.prompts[prompt] ||= { bases: [] };
  return manifest.prompts[prompt];
}

// The bases this run can still work on, generating whatever the pack is short.
async function ensureBases(prompt, state, steps) {
  const usable = [];
  let lost = 0;
  for (const base of state.bases) {
    if (base.done) continue;
    if (await sourceIsAlive(base.sourceId)) usable.push(base);
    else lost += 1;
  }
  if (lost) {
    console.warn(`${prompt}  ${lost} unfinished base(s) expired from the server store; their images stay in the pack but cannot be topped up — raise --bases to add more`);
  }
  const shortfall = BASE_COUNT - state.bases.length;
  if (shortfall > 0 && requests < LIMIT) {
    const items = await generateBases(prompt, shortfall);
    requests += 1;
    for (const item of items) {
      const base = await saveBase(prompt, item, steps);
      if (!base) continue;
      state.bases.push(base);
      usable.push(base);
      made += 1;
    }
  }
  return usable;
}

async function saveBase(prompt, item, steps) {
  const size = { width: item.width ?? null, height: item.height ?? null };
  const key = baseKeyFor(prompt, size, steps);
  const address = await saveItem(item, key, {
    kind: "base",
    prompt,
    emoji: null,
    sourceKey: "",
    size,
    steps,
    strength: item.genai?.strength ?? null,
    baseId: null
  });
  if (!address) return null;
  return { address, sourceId: item.genai.id, key, width: size.width, height: size.height, vary: null, done: false };
}

// --- filling a base ------------------------------------------------------

// SAMPLING. The server picks the emoji; we read back which one it used and file
// the image under that key. Nothing is configured, so nothing has to be
// restored — and the key cannot disagree with the image, because every field in
// it is derived from the image's own recorded metadata.
async function fillBaseSampling(prompt, base, emojis, steps) {
  const manifest = readManifest();
  let stall = 0;
  while (requests < LIMIT && stall < SAMPLE_STALL_LIMIT) {
    const short = varyBasis(base)
      ? emojis.filter((emoji) => emojiDepth(manifest, prompt, base, emoji, steps) < DEPTH)
      : emojis;
    if (!short.length) {
      console.log(`${prompt}  base ${base.address.slice(0, 8)}: all ${emojis.length} keys at depth`);
      base.done = true;
      skipped += emojis.length;
      return;
    }
    const items = await varyFrom(base.sourceId, VARY_COUNT);
    requests += 1;
    if (!items.length) { console.warn("  provider returned nothing; moving on"); return; }
    learnVaryBasis(base, items);

    let usedThisRound = 0;
    for (const item of items) {
      if (await saveVariation(manifest, prompt, base, item, steps)) {
        made += 1;
        usedThisRound += 1;
      }
    }
    // Every image landed in an already-full key. A few rounds of that means
    // the tail is only reachable by pinning, so say so instead of spending.
    stall = usedThisRound === 0 ? stall + 1 : 0;
    console.log(`${prompt}  base ${base.address.slice(0, 8)} request ${requests}: kept ${usedThisRound}/${items.length}, ${short.length} keys still short`);
    writeManifest(manifest);
  }
  if (stall >= SAMPLE_STALL_LIMIT) {
    console.warn(`  sampling stalled on "${prompt}" — the remaining keys need --pin`);
  }
}

// Exact coverage: one emoji vocabulary at a time, per base, reading its depth
// from the same per-base grid.
async function fillBasePinned(prompt, base, emojis, steps) {
  const manifest = readManifest();
  for (const emoji of emojis) {
    if (requests >= LIMIT) break;
    if (varyBasis(base) && emojiDepth(manifest, prompt, base, emoji, steps) >= DEPTH) { skipped += 1; continue; }
    console.log(`${prompt}  ${emoji}  base ${base.address.slice(0, 8)}`);
    await setSettingValue("GENAI_VARY_MODIFIERS", emoji);
    while (requests < LIMIT) {
      if (varyBasis(base) && emojiDepth(manifest, prompt, base, emoji, steps) >= DEPTH) break;
      const items = await varyFrom(base.sourceId, VARY_COUNT);
      requests += 1;
      if (!items.length) { console.warn("  provider returned nothing; moving on"); return; }
      learnVaryBasis(base, items);
      for (const item of items) {
        if (await saveVariation(manifest, prompt, base, item, steps)) made += 1;
      }
    }
    writeManifest(manifest);
  }
}

async function saveVariation(manifest, prompt, base, item, steps) {
  // What the server ACTUALLY applied. Without it we would be guessing.
  const emoji = item.genai?.modifier?.emoji;
  if (!emoji) return false;
  const size = { width: item.width ?? null, height: item.height ?? null };
  const strength = item.genai?.strength ?? null;
  const key = varyKeyFor(prompt, base, { emoji, size, steps, strength });
  if ((manifest.keys[key]?.members || []).length >= DEPTH) return false;  // that key is full
  const address = await saveItem(item, key, {
    kind: "variation",
    prompt,
    emoji,
    sourceKey: base.address,
    size,
    steps,
    strength,
    baseId: base.address
  });
  return Boolean(address);
}

// --- the API -------------------------------------------------------------

async function generateBases(prompt, count) {
  const body = await postJson("/api/genai", { prompt, count });
  const items = (body.items || []).filter((item) => item.genai?.id);
  if (!items.length) throw new Error(`no base image for "${prompt}"`);
  return items.slice(0, count);
}

async function varyFrom(sourceId, count) {
  const body = await postJson("/api/genai", { source: { id: sourceId }, count });
  // The lineage item (the source itself) comes back in the list on some paths;
  // keep only images this request actually produced.
  return (body.items || []).filter((item) => item.genai?.id && item.genai.id !== sourceId);
}

// A base can only be varied from while the server still holds its bytes; the
// store expires them and a restart drops them all.
async function sourceIsAlive(sourceId) {
  if (!sourceId) return false;
  try {
    const res = await fetch(`${API}/api/genai/image/${sourceId}`, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function postJson(route, payload) {
  const res = await fetch(`${API}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function readSettingValue(key) {
  const res = await fetch(`${API}/api/settings`);
  if (!res.ok) throw new Error(`GET /api/settings ${res.status} — is the dev API running, and HIDE_SETTINGS unset?`);
  const body = await res.json();
  return body.settings?.[key]?.value ?? "";
}

async function setSettingValue(key, value) {
  const res = await fetch(`${API}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { [key]: value } })
  });
  if (!res.ok) throw new Error(`PUT /api/settings ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Steps are a key input, so they have to be what the request carried.
// addFalOptionalInputs sends NO step count for Klein — it is distilled, and
// omitting steps selects its own default — so a Klein pack keys on 0. Reading
// GENAI_STEPS and keying on it there would bake a pack the serving side can
// never look up.
async function resolveEffectiveSteps() {
  if (args.steps !== undefined) return Number(args.steps) || 0;
  if (/klein/i.test(MODEL)) return 0;
  const raw = DRY ? (process.env.GENAI_STEPS || "") : await readSettingValue("GENAI_STEPS");
  return Number(raw) || 0;
}

// --- storage -------------------------------------------------------------

// Fetch the image, file it under `key`, and return its content address (which
// is what a base's variations use as their sourceKey). null on a failed fetch.
async function saveItem(item, key, meta) {
  const res = await fetch(`${API}${item.imageUrl}`);
  if (!res.ok) {
    console.warn(`  could not fetch ${item.imageUrl}: ${res.status}`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/png";
  const ext = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
  const address = poolSourceAddress(buffer);
  // NAME FORMAT: prompt_seed[_emoji]
  //
  // Deterministic and complete: those three are exactly what it takes to make
  // the image again, so a name is a recipe rather than a label. No hash tail —
  // a collision means the same prompt, the same seed AND the same emoji, which
  // is the same image, so overwriting it costs nothing.
  //
  // The emoji goes in as the GLYPH. It survives APFS, rsync and Finder; the cost
  // is that quoting one in a shell is awkward, which falls on whoever greps the
  // directory.
  const emoji = item.genai?.modifier?.emoji || "";
  const label = [slugify(meta.prompt, 48), `seed${item.genai?.seed ?? "none"}`]
    .concat(emoji ? [emoji] : [])
    .join("_");
  const rel = path.join("images", `${label}.${ext}`);
  const abs = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer);

  const manifest = readManifest();
  const entry = manifest.keys[key] || (manifest.keys[key] = {
    kind: meta.kind,
    model: MODEL,
    prompt: meta.prompt,
    emoji: meta.emoji,
    sourceKey: meta.sourceKey,
    width: meta.size.width,
    height: meta.size.height,
    steps: meta.steps,
    strength: meta.strength,
    members: []
  });
  if (!entry.members.some((m) => m.file === rel)) {
    // Enough per member for a review page to show what it is looking at
    // without re-deriving anything: when, which emoji, which model, what size,
    // and which base it came out of.
    entry.members.push({
      file: rel,
      sha256: address,
      bytes: buffer.length,
      width: item.width ?? null,
      height: item.height ?? null,
      seed: item.genai?.seed ?? null,
      strength: meta.strength,
      emoji: emoji || null,
      model: MODEL,
      baseId: meta.baseId,
      sentPrompt: item.genai?.modifier?.sentPrompt ?? null,
      bakedAt: new Date().toISOString()
    });
  }
  writeManifest(manifest);
  return address;
}

let manifestCache = null;
function readManifest() {
  if (manifestCache) return manifestCache;
  const file = path.join(OUT, "manifest.json");
  if (fs.existsSync(file)) {
    manifestCache = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifestCache.version !== MANIFEST_VERSION) {
      throw new Error(`${file} is manifest v${manifestCache.version}; its keys predate per-base variation pools and cannot be topped up. Bake into a fresh --out.`);
    }
    manifestCache.keys ||= {};
    manifestCache.prompts ||= {};
  } else {
    manifestCache = { version: MANIFEST_VERSION, createdAt: new Date().toISOString(), keys: {}, prompts: {} };
  }
  return manifestCache;
}

function writeManifest(manifest) {
  if (DRY) return;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "manifest.json");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, file);
}

// --- dry run -------------------------------------------------------------

// Counts only, and offline: a base that does not exist yet has no content
// address, so its keys cannot be computed and its grid is assumed empty.
function reportDryRun(manifest, prompt, emojis, steps) {
  const state = manifest.prompts[prompt] || { bases: [] };
  const newBases = Math.max(0, BASE_COUNT - state.bases.length);
  let wantImages = newBases * emojis.length * DEPTH;
  for (const base of state.bases) {
    for (const emoji of emojis) {
      const have = varyBasis(base) ? emojiDepth(manifest, prompt, base, emoji, steps) : 0;
      if (have >= DEPTH) { skipped += 1; continue; }
      wantImages += DEPTH - have;
    }
  }
  console.log(`${prompt}  bases ${state.bases.length}/${BASE_COUNT}, ${wantImages} variations short`);
  if (newBases) requests += 1;
  requests += Math.ceil(wantImages / VARY_COUNT);
  made += wantImages + newBases;
}

// --- inputs --------------------------------------------------------------

async function readServerEmojiSet() {
  const raw = DRY
    ? (process.env.GENAI_VARY_MODIFIERS || "")
    : await readSettingValue("GENAI_VARY_MODIFIERS");
  return splitEmoji(raw);
}

function splitEmoji(raw) {
  // Same grapheme rule as server/vary-modifiers.js: one emoji is often several
  // code points, so splitting on code points would shatter them.
  const parts = String(raw).split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts;
  const seg = typeof Intl?.Segmenter === "function"
    ? Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(String(raw)), (s) => s.segment)
    : Array.from(String(raw));
  return seg.filter((s) => s.trim().length > 0);
}

// ASCII-only and stable, for the prompt half of a filename. The emoji half is
// added as a glyph by the caller, so this only has to make arbitrary prompt text
// safe to put in a path.
function slugify(value, max = 40) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[name] = next;
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}
