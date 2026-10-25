import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  detectRasterImage,
  encodeWebpForDelivery,
  inspectImportedRasterImage,
  looksLikeSvg,
  normalizeImportedRasterImage,
  PROXY_IMAGE_MAX_EDGE_PX,
  rasterizeSvg
} from "./images.js";
import { firstString, parseNonNegativeInteger, parsePositiveInteger } from "./env.js";
import { isAllowedImageUrl, isAllowedLink, parseDimension } from "./extract.js";
import { GenAiSourceTooLargeError, RequestPolicyError, sendPolicyError } from "./errors.js";
import {
  REQUEST_TIMEOUT_MS,
  browserUserAgent,
  fetchWithTimeout,
  normalizeAndAssertTargetUrl,
  readResponseBuffer
} from "./net-policy.js";
import { normalizeSearchQuery } from "./search.js";
import {
  getGenAiCleanupImages,
  getGenAiImageRetentionDays,
  getGenAiProvider,
  getGenAiSaveImagesToDisk,
  getGenAiVaryModifierMode,
  getIntegerSetting,
  isGenAiEnabled,
  resolveGenAiEndpoint
} from "./settings.js";

// GenAI images are ~500 KB PNGs. Above 0, a browser that accepts WebP is sent a
// WebP copy at this quality. Only the response changes: the stored buffer stays
// the provider's bytes, because a pool key is the content address of exactly
// those bytes and a variation is made from them.
const GENAI_DELIVERY_WEBP_QUALITY = Math.min(100, parseNonNegativeInteger(process.env.GENAI_DELIVERY_WEBP_QUALITY, 0));

// Lives here, not in genai-providers.js, so the source import can use it
// without an import cycle. fal's size floor (FAL_MIN_IMAGE_*) is per axis; fal
// bills per megapixel. Raising a 1:2 portrait until both axes clear 640x512
// gives 640x1152, 2.25x the baseline's area and price. This caps the area such a raise may reach by clamping the aspect (see
// fitImageSizeToBox); the floor itself is never traded away. 0 disables the
// ceiling. Default 589824 = 768x768.
export const GENAI_MAX_REQUEST_PIXELS = parseNonNegativeInteger(process.env.GENAI_MAX_REQUEST_PIXELS, 768 * 768);

// External search/web images are first copied into the same short-lived image
// store used by GenAI. This is a download backstop against an absurd payload,
// not a size policy: ordinary web photos exceed it and are resized on import
// (normalizeImportedRasterImage) instead of being refused.
const GENAI_SOURCE_IMPORT_MAX_BYTES = parseNonNegativeInteger(process.env.GENAI_SOURCE_IMPORT_MAX_BYTES, 20 * 1024 * 1024);

const GENERATED_IMAGES_DIR = process.env.GENAI_IMAGE_DIR_PATH || new URL("../generated-images/", import.meta.url);

export const genAiImageStore = new Map();
export let genAiImageStoreBytes = 0;

const SERVER_STARTED_AT = Date.now();

export async function handleGenAiImage(req, res) {
  const record = getStoredGenAiImage(req.params.id);
  if (!record) {
    res.status(410).json({ error: "Generated image expired or not found" });
    return;
  }

  res.setHeader("cache-control", "private, max-age=1800");
  // As on /api/proxy/image: whatever these bytes are, they never run as a page
  // on this origin.
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
  // Scripts (the baker, the bake-off) fetch without this Accept and get the
  // original bytes, whose hash they depend on.
  const wantsWebp = GENAI_DELIVERY_WEBP_QUALITY > 0
    && record.contentType !== "image/webp"
    && /\bimage\/webp\b/.test(String(req.headers.accept || ""));
  if (wantsWebp) {
    res.vary("accept");
    const holder = record.shared || record;
    holder.deliveryWebp ??= encodeWebpForDelivery(record.buffer, GENAI_DELIVERY_WEBP_QUALITY);
    const webp = await holder.deliveryWebp;
    if (webp) {
      res.setHeader("content-type", "image/webp");
      res.send(webp);
      return;
    }
  }
  res.setHeader("content-type", record.contentType);
  res.send(record.buffer);
}

export function listSavedGenAiImages(sinceMs) {
  if (!fs.existsSync(GENERATED_IMAGES_DIR)) {
    return [];
  }
  const items = [];
  for (const entry of fs.readdirSync(GENERATED_IMAGES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const file = entry.name.slice(0, -".json".length);
    try {
      const meta = JSON.parse(fs.readFileSync(generatedImageFilePath(entry.name), "utf8"));
      if (Date.parse(meta.at) >= sinceMs && fs.existsSync(generatedImageFilePath(file))) {
        items.push({ ...meta, file });
      }
    } catch {
      // A half-written or foreign file; skip it.
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export function getGenAiResponseMaxBytes() {
  return parsePositiveInteger(process.env.GENAI_RESPONSE_MAX_BYTES, 50 * 1024 * 1024);
}

// Count and bytes both bound the store; bytes is the one that protects memory.
// Pooled records count toward the first only.
function getGenAiImageCacheMax() {
  return parsePositiveInteger(process.env.GENAI_IMAGE_CACHE_MAX, 3000);
}

export function getGenAiImageCacheMaxBytes() {
  return parsePositiveInteger(process.env.GENAI_IMAGE_CACHE_MAX_BYTES, 300 * 1024 * 1024);
}

export function getGenAiImageCacheTtlMs() {
  return parsePositiveInteger(process.env.GENAI_IMAGE_CACHE_TTL_MS, 30 * 60_000);
}

export function getGeneratedImagesDirDisplayPath() {
  if (GENERATED_IMAGES_DIR instanceof URL) {
    return decodeURIComponent(GENERATED_IMAGES_DIR.pathname);
  }
  return path.resolve(String(GENERATED_IMAGES_DIR));
}

export function measureRasterImageSize(buffer) {
  try {
    const detected = detectRasterImage(buffer);
    return detected ? { width: detected.width, height: detected.height } : null;
  } catch {
    // Malformed or pathological header: treat as unmeasurable.
    return null;
  }
}

export async function normalizeGenAiPayload(payload, context) {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.items || payload?.images || payload?.results || [];
  const items = [];

  for (let index = 0; index < candidates.length; index += 1) {
    if (items.length >= context.limit) {
      break;
    }
    const candidate = candidates[index];
    const item = normalizeGenAiItem(candidate);
    if (!item || !isAllowedGeneratedImageUrl(item.imageUrl)) {
      continue;
    }
    const stored = await storeGenAiImageItem(item, {
      ...context,
      seed: context.seeds[index] ?? null,
      providerFlagged: Array.isArray(context.providerFlags) && context.providerFlags[index] === true
    });
    if (stored) {
      items.push(stored);
    }
  }

  return items;
}

function normalizeGenAiItem(candidate) {
  if (typeof candidate === "string") {
    return {
      imageUrl: normalizeGeneratedImageString(candidate),
      linkUrl: null,
      width: null,
      height: null
    };
  }
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const imageUrl = firstString(
    candidate.imageUrl,
    candidate.image,
    candidate.dataUrl,
    candidate.url,
    candidate.src,
    candidate.b64_json,
    candidate.base64
  );
  if (!imageUrl) {
    return null;
  }

  const linkUrl = firstString(candidate.link, candidate.linkUrl, candidate.source, candidate.sourceUrl);
  return {
    imageUrl: normalizeGeneratedImageString(imageUrl),
    linkUrl: linkUrl && isAllowedLink(linkUrl) ? linkUrl : null,
    width: parseDimension(firstString(candidate.imageWidth, candidate.width)),
    height: parseDimension(firstString(candidate.imageHeight, candidate.height))
  };
}

function normalizeGeneratedImageString(value) {
  const str = String(value || "").trim();
  if (!str) {
    return null;
  }
  if (/^data:image\//i.test(str) || /^https?:\/\//i.test(str)) {
    return str;
  }
  return `data:image/png;base64,${str}`;
}

function isAllowedGeneratedImageUrl(imageUrl) {
  if (!imageUrl) {
    return false;
  }
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(imageUrl)) {
    return true;
  }
  return isAllowedImageUrl(imageUrl);
}

async function storeGenAiImageItem(item, context) {
  const fetched = await readGeneratedImageSource(item.imageUrl);
  if (!fetched) {
    return null;
  }
  const source = await toServableGeneratedImage(fetched);

  return storeGenAiImageSource({
    source,
    context: {
      ...context,
      width: item.width || context.width || null,
      height: item.height || context.height || null
    }
  });
}

// mode "url" has no search query to borrow: the client sends the page URL as
// `query`. A constant would put no content into the lineage prompt, which the UI
// shows and which a cache-expired source is re-fired with via txt2img, so derive
// a description from the image's filename plus the page host. This is the
// lineage prompt: under the default replace-style modifier the string sent to
// the provider is the emoji payload alone (see composeVaryModifier).
export function describeImportedWebImage(imageUrl, pageUrl) {
  const name = readableImageFileName(imageUrl);
  const host = readableUrlHost(pageUrl) || readableUrlHost(imageUrl);
  if (name && host) {
    return `${name} from ${host}`;
  }
  return name || (host ? `image from ${host}` : "selected web image");
}

function readableImageFileName(imageUrl) {
  let pathname;
  try {
    pathname = new URL(imageUrl).pathname;
  } catch {
    return "";
  }
  let stem;
  try {
    stem = decodeURIComponent(pathname.split("/").pop() || "");
  } catch {
    stem = pathname.split("/").pop() || "";
  }
  const words = stem
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_+\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // CDN hashes and bare serial numbers describe nothing; prefer the host-only
  // fallback over feeding "3f9a1c07e2" to a text encoder.
  if (!words || !/[a-z]{3}/i.test(words) || /^[0-9a-f ]+$/i.test(words)) {
    return "";
  }
  return words.slice(0, 80).trim();
}

function readableUrlHost(urlValue) {
  try {
    return new URL(urlValue).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export async function handleGenAiSourceImport(req, res) {
  // This endpoint is only the trusted-image handoff; generation stays on the
  // async /api/genai path with its queue, progress and modifier semantics.
  const sourceUrl = String(req.body?.imageUrl || "").trim();
  const sourceMode = req.body?.mode === "image_search" ? "image_search" : req.body?.mode === "url" ? "url" : null;
  if (!sourceUrl || !sourceMode) {
    res.status(400).json({ error: "Missing selected image or source mode" });
    return;
  }
  if (!isGenAiEnabled()) {
    res.status(501).json({ error: "GenAI is not configured" });
    return;
  }
  if (getGenAiVaryModifierMode() === "off") {
    res.status(400).json({ error: "Emoji variations are disabled in GenAI settings" });
    return;
  }

  try {
    const imageUrl = await normalizeAndAssertTargetUrl(sourceUrl, "selected image url");
    const upstream = await fetchWithTimeout(
      imageUrl,
      { headers: { "user-agent": browserUserAgent(), accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" } },
      REQUEST_TIMEOUT_MS
    );
    if (!upstream.ok) {
      res.status(502).json({ error: `Selected image returned HTTP ${upstream.status}` });
      return;
    }
    let buffer;
    try {
      buffer = await readResponseBuffer(upstream, GENAI_SOURCE_IMPORT_MAX_BYTES);
    } catch (err) {
      if (err instanceof RequestPolicyError && /exceeds/.test(err.message)) {
        throw new GenAiSourceTooLargeError(`selected image exceeds ${GENAI_SOURCE_IMPORT_MAX_BYTES} byte import limit`);
      }
      throw err;
    }
    let declaredType = upstream.headers.get("content-type");
    if (looksLikeSvg(buffer)) {
      buffer = await rasterizeSvg(buffer, PROXY_IMAGE_MAX_EDGE_PX);
      declaredType = "image/png";
    }
    const inspected = inspectImportedRasterImage(buffer, declaredType);
    const normalized = await normalizeImportedRasterImage(buffer, inspected, {
      boxWidth: getIntegerSetting("GENAI_WIDTH"),
      boxHeight: getIntegerSetting("GENAI_HEIGHT"),
      maxPixels: GENAI_MAX_REQUEST_PIXELS
    });
    const prompt = sourceMode === "image_search"
      ? normalizeSearchQuery(req.body?.query) || "selected image"
      : describeImportedWebImage(imageUrl, req.body?.query);
    const item = storeImportedGenAiImage({
      source: { buffer: normalized.buffer, contentType: normalized.contentType },
      prompt,
      width: normalized.width,
      height: normalized.height,
      origin: sourceMode
    });
    res.status(201).json({ ok: true, prompt, source: item });
  } catch (err) {
    if (err instanceof GenAiSourceTooLargeError) {
      res.status(413).json({ error: err.message });
      return;
    }
    if (sendPolicyError(res, err)) {
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not import selected image" });
  }
}

export function storeImportedGenAiImage({ source, prompt, width, height, origin }) {
  return storeGenAiImageSource({
    source,
    context: {
      prompt,
      seed: null,
      strength: null,
      parentId: null,
      provider: "external",
      width,
      height,
      origin
    }
  });
}

export function storeGenAiImageSource({ source, context }) {
  const id = createGenAiImageId();
  const now = Date.now();
  // Measure the stored bytes; the requested/declared size is only a fallback. A
  // provider need not honour the size it was asked for, and these numbers are
  // load-bearing twice: Draw Things answers HTTP 422 when a later vary's init image
  // disagrees with the width/height declared beside it, and the sphere lays panels
  // out from them.
  const measured = measureRasterImageSize(source.buffer);
  const width = measured?.width || context.width || null;
  const height = measured?.height || context.height || null;
  // Generation within the lineage: 1 for a base, +1 per variation, 0 once an
  // imported image is in it. Stored rather than walked because ancestors leave
  // the image store long before their descendants are varied.
  const parent = context.parentId ? genAiImageStore.get(context.parentId) : null;
  const isGeneratedRoot = !context.origin || context.origin === "pool";
  const genai = {
    id,
    prompt: context.prompt,
    seed: context.seed,
    strength: context.strength,
    parentId: context.parentId,
    round: context.parentId ? (parent?.genai?.round ? parent.genai.round + 1 : 0) : (isGeneratedRoot ? 1 : 0)
  };
  // Additive vary emoji modifier. Only set on variation items that received a
  // modifier; absent on generate/off-mode. `sentPrompt` is the exact string sent
  // to the provider (the modifier alone in replace style, or the compounded prompt
  // in append style); genai.prompt keeps the base lineage prompt for re-fire.
  if (context.modifier) {
    genai.modifier = {
      emoji: context.modifier.emoji,
      phrase: context.modifier.phrase ?? null,
      sentPrompt: context.modifier.sentPrompt ?? null,
      stack: Array.isArray(context.modifier.stack) ? [...context.modifier.stack] : [context.modifier.emoji].filter(Boolean)
    };
  }
  const savedFile = context.saveToDisk === false
    ? null
    : saveGeneratedImageFile({
      id,
      source,
      prompt: context.prompt,
      now,
      meta: { genai, origin: context.origin || null }
    });

  // A pooled record's bytes belong to the pool (readSharedPoolMember), not to it.
  const ownBytes = source.shared ? 0 : source.buffer.length;
  genAiImageStoreBytes += ownBytes;
  genAiImageStore.set(id, {
    id,
    buffer: source.buffer,
    shared: source.shared || null,
    ownBytes,
    contentType: source.contentType,
    createdAt: now,
    expiresAt: now + getGenAiImageCacheTtlMs(),
    genai,
    provider: context.provider,
    origin: context.origin || null,
    providerFlagged: context.providerFlagged === true,
    width,
    height,
    savedFile
  });
  pruneGenAiImageStore(now);

  return {
    imageUrl: `/api/genai/image/${id}`,
    linkUrl: null,
    width,
    height,
    genai
  };
}

function saveGeneratedImageFile({ id, source, prompt, now, meta = null }) {
  if (!getGenAiSaveImagesToDisk()) {
    return null;
  }

  try {
    pruneGeneratedImageFiles(now);
    ensureGeneratedImagesDir();

    const timestamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const slug = slugifyFilePart(prompt || "image");
    const ext = imageExtensionForContentType(source.contentType);
    const fileName = `${timestamp}_${id}_${slug}.${ext}`;
    fs.writeFileSync(generatedImageFilePath(fileName), source.buffer);
    // What /admin/generated lists. Beside the image so the retention sweep,
    // which goes by mtime, removes both.
    if (meta) {
      const { genai } = meta;
      fs.writeFileSync(generatedImageFilePath(`${fileName}.json`), JSON.stringify({
        id,
        at: new Date(now).toISOString(),
        prompt: genai.prompt,
        stack: genai.modifier?.stack || [],
        sentPrompt: genai.modifier?.sentPrompt || null,
        round: genai.round,
        parentId: genai.parentId,
        origin: meta.origin
      }));
    }
    return fileName;
  } catch (err) {
    console.warn(`Could not save generated image ${id}: ${err.message}`);
    return null;
  }
}

export function pruneGeneratedImageFiles(now = Date.now(), { includeSession = false } = {}) {
  if (!getGenAiCleanupImages() || !fs.existsSync(GENERATED_IMAGES_DIR)) {
    return;
  }

  const retentionDays = getGenAiImageRetentionDays();
  if (retentionDays <= 0 && !includeSession) {
    return;
  }

  const cutoffMs = retentionDays <= 0
    ? SERVER_STARTED_AT
    : now - (retentionDays * 24 * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(GENERATED_IMAGES_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = generatedImageFilePath(entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup; another process may have removed the file.
    }
  }
}

function ensureGeneratedImagesDir() {
  fs.mkdirSync(GENERATED_IMAGES_DIR, { recursive: true });
}

export function generatedImageFilePath(fileName) {
  if (GENERATED_IMAGES_DIR instanceof URL) {
    return new URL(fileName, GENERATED_IMAGES_DIR);
  }
  return path.join(GENERATED_IMAGES_DIR, fileName);
}

function slugifyFilePart(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "image";
}

function imageExtensionForContentType(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  return "png";
}

function genAiEndpointHost() {
  try {
    return new URL(resolveGenAiEndpoint(getGenAiProvider())).host;
  } catch {
    return null;
  }
}

// These bytes are served from the app's own origin (/api/genai/image/:id), so
// their type comes from the bytes, never from a provider's header or data-URL
// label: an HTML or SVG document there would run script as the app.
async function toServableGeneratedImage(source) {
  if (looksLikeSvg(source.buffer)) {
    return { buffer: await rasterizeSvg(source.buffer, PROXY_IMAGE_MAX_EDGE_PX), contentType: "image/png" };
  }
  const detected = detectRasterImage(source.buffer);
  if (!detected) {
    throw new Error("Generated image is not a PNG, JPEG, WebP or GIF");
  }
  return { buffer: source.buffer, contentType: detected.contentType };
}

async function readGeneratedImageSource(imageUrl) {
  if (/^data:image\//i.test(imageUrl)) {
    return readDataImageUrl(imageUrl);
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    // The private-address/non-standard-port exemption is scoped to the
    // operator-configured provider endpoint; image URLs in a provider
    // response inherit it only when they point back at that same host.
    let sameHostAsEndpoint = false;
    try {
      sameHostAsEndpoint = new URL(imageUrl).host === genAiEndpointHost();
    } catch {
      sameHostAsEndpoint = false;
    }
    const response = await fetchWithTimeout(
      imageUrl,
      {
        headers: {
          "user-agent": browserUserAgent()
        }
      },
      getIntegerSetting("GENAI_TIMEOUT_MS"),
      {
        applyHostAllowlist: false,
        allowPrivateAddress: sameHostAsEndpoint,
        allowNonStandardPort: sameHostAsEndpoint
      }
    );
    if (!response.ok) {
      throw new Error(`Generated image fetch returned HTTP ${response.status}`);
    }
    return {
      buffer: await readResponseBuffer(response, getGenAiResponseMaxBytes()),
      contentType: response.headers.get("content-type") || "image/png"
    };
  }
  return null;
}

function readDataImageUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }
  return {
    buffer: Buffer.from(match[2], "base64"),
    contentType: match[1].toLowerCase()
  };
}

function createGenAiImageId() {
  return `g_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function getStoredGenAiImage(id) {
  pruneGenAiImageStore();
  const record = genAiImageStore.get(id);
  if (!record) {
    return null;
  }
  // Sliding: each vary walks the lineage through here, so a lineage still being
  // explored (and listed for download) outlives the TTL from its creation.
  record.expiresAt = Date.now() + getGenAiImageCacheTtlMs();
  genAiImageStore.delete(id);
  genAiImageStore.set(id, record);
  return record;
}

function deleteStoredGenAiImage(id) {
  const record = genAiImageStore.get(id);
  if (record) {
    genAiImageStore.delete(id);
    genAiImageStoreBytes -= record.ownBytes || 0;
  }
}

function pruneGenAiImageStore(now = Date.now()) {
  for (const [id, record] of genAiImageStore) {
    if (now >= record.expiresAt) {
      deleteStoredGenAiImage(id);
    }
  }
  while (genAiImageStore.size > getGenAiImageCacheMax()) {
    deleteStoredGenAiImage(genAiImageStore.keys().next().value);
  }
  // Over bytes, only records that own bytes go: evicting a pooled one frees nothing.
  const maxBytes = getGenAiImageCacheMaxBytes();
  for (const [id, record] of genAiImageStore) {
    if (genAiImageStoreBytes <= maxBytes) {
      break;
    }
    if (record.ownBytes) {
      deleteStoredGenAiImage(id);
    }
  }
}
