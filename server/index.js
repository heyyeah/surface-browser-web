import "dotenv/config";
import express from "express";
import cors from "cors";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent as UndiciAgent } from "undici";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { load as loadHtml } from "cheerio";
import { setupStt, isSttEnabled } from "./stt.js";
import {
  detectRasterImage,
  looksLikeSvg,
  rasterizeSvg,
  downscaleProxiedImage,
  encodeWebpForDelivery,
  fitImageSizeToBox,
  inspectImportedRasterImage,
  normalizeImportedRasterImage,
  PROXY_IMAGE_MAX_EDGE_PX,
  resizeRasterImageToSize
} from "./images.js";
import { createImageDiskCache } from "./image-cache.js";
import { createGenAiPromptCache } from "./genai-prompt-cache.js";
import { createLiveMonitor, describeEvent, deviceFromUserAgent, parseSessionId } from "./live-monitor.js";
import { Reader as MmdbReader } from "mmdb-lib";
import { splitVaryModifierEntries } from "./vary-modifiers.js";
import { buildPoolKey, drawPoolIndexes, planPoolDraw, planPoolFallback, poolSourceAddress } from "./genai-pool.js";
import { createInFlightRequests } from "./in-flight.js";
import { applyPoolSuppression, loadPoolPack, mergePools, poolMemberCount, readPoolMember } from "./genai-pool-pack.js";
import { addGrownMember, bookmarkPromptSet, loadGrowStore, poolGrowthRound } from "./genai-pool-grow.js";
import { defaultSuppressionPath, readSuppression, writeSuppression } from "./genai-pool-suppression.js";
import { createSpendGuard, createKillSwitch, spendClientKey } from "./spend-guard.js";
import { hasNavigableUrlShape } from "../shared/url-shape.js";
import { isBlockedIpAddress } from "./ip-blocklist.js";
import {
  CHROMIUM_LAUNCH_OPTIONS,
  CONTEXT_LOCKDOWN_OPTIONS,
  createSharedBrowser,
  routeContextThroughNode,
  withRenderDeadline
} from "./playwright-render.js";
import { genAiBookmarkPrompts } from "../src/bookmark-presets.js";

const PORT = Number(process.env.PORT || 8788);
// Unset binds every interface (dev: the Vite proxy and a tunnelled headset reach
// it). In production set BIND_HOST=127.0.0.1 behind a reverse proxy: a publicly
// reachable port lets anyone connect directly and forge X-Forwarded-For, which
// defeats TRUST_PROXY, every per-IP limit and the localhost check.
const BIND_HOST = (process.env.BIND_HOST || "").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const MAX_RESPONSE_BYTES = parseNonNegativeInteger(process.env.MAX_RESPONSE_BYTES, 10 * 1024 * 1024);
const MAX_REDIRECTS = parseNonNegativeInteger(process.env.MAX_REDIRECTS, 5);
const DEFAULT_LIMIT = 15;
const DEFAULT_THRESHOLD = 5;
const DEFAULT_GENAI_ENDPOINTS = Object.freeze({
  drawthings: "http://127.0.0.1:7860",
  a1111: "http://127.0.0.1:8022"
});
const RATE_LIMIT_REQUESTS_PER_WINDOW = parseNonNegativeInteger(
  process.env.RATE_LIMIT_REQUESTS_PER_WINDOW || process.env.RATE_LIMIT_PER_MINUTE,
  0
);
const RATE_LIMIT_WINDOW_MS = parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
// Rate-limit buckets are per IP and live until their window rolls over. The map
// is capped and the single oldest entry is evicted at the cap, so a flood of
// distinct IPs cannot grow it without bound or force a full scan per request.
const RATE_LIMIT_MAX_TRACKED_IPS = parsePositiveInteger(process.env.RATE_LIMIT_MAX_TRACKED_IPS, 5_000);
// Two tiers, because one number cannot describe both kinds of request.
//
// The limiter is mounted on the "/api/genai" prefix, so it also sees
// /api/genai/job/:id, which the client polls every GENAI_JOB_POLL_MS = 500 ms
// for the 20-60 s a hosted batch takes; a low limit would be spent in seconds
// and no hosted generation could finish. /api/proxy/image has the same shape:
// one tunnel is dozens of images.
//
// A job poll and a proxied image are cheap reads of work already paid for and
// capped by the spend guard, so they get a much larger bucket. The expensive
// entry points (extract, search, POST /api/genai, source import, stt) keep the
// configured number.
const RATE_LIMIT_READ_REQUESTS_PER_WINDOW = parseNonNegativeInteger(
  process.env.RATE_LIMIT_READ_REQUESTS_PER_WINDOW,
  RATE_LIMIT_REQUESTS_PER_WINDOW ? RATE_LIMIT_REQUESTS_PER_WINDOW * 30 : 0
);
// Matched against req.originalUrl, so unaffected by the mount path express
// strips. /api/genai/source/import is deliberately not here: it downloads a
// remote image and belongs with the expensive routes.
// XR diag rides the high tier: a headset session posts in bursts, but it must
// not be unlimited.
const CHEAP_READ_ROUTE = /^\/api\/(?:genai\/(?:job|image)\/|proxy\/image|debug\/xr)/;
// /api/extract's cheerio parse and /api/proxy/image's sharp decode each cost a
// real chunk of heap per in-flight request, so a burst of scrapes can OOM a small
// host. This ceiling is global, unlike the per-IP RATE_LIMIT: it protects memory
// from the sum of all visitors. 4 leaves headroom on 2 vCPU without serialising
// ordinary gallery traffic.
const SCRAPE_CONCURRENCY_MAX = parseNonNegativeInteger(process.env.SCRAPE_CONCURRENCY_MAX, 3);
// The image proxy's own pool: each request is ~0.1–0.5 s and a tunnel asks for
// one image every 1.3 s per visitor.
const IMAGE_PROXY_CONCURRENCY_MAX = parseNonNegativeInteger(process.env.IMAGE_PROXY_CONCURRENCY_MAX, 6);
// Slots one address may hold at once, so a single visitor feeding slow links
// cannot take every slot. Raise both for a venue where everyone shares an IP.
const SCRAPE_CONCURRENCY_PER_CLIENT = parseNonNegativeInteger(process.env.SCRAPE_CONCURRENCY_PER_CLIENT, 2);
const IMAGE_PROXY_CONCURRENCY_PER_CLIENT = parseNonNegativeInteger(process.env.IMAGE_PROXY_CONCURRENCY_PER_CLIENT, 4);
// Only for a guarded handler that never settles; normally the slot frees when it
// returns. Longer than a fetch deadline plus a decode.
const CONCURRENCY_SLOT_BACKSTOP_MS = 60_000;
// Unset (the default) means no disk cache. See server/image-cache.js.
const imageProxyCache = createImageDiskCache({
  dir: process.env.IMAGE_PROXY_CACHE_DIR ? path.resolve(process.env.IMAGE_PROXY_CACHE_DIR) : "",
  maxBytes: parseNonNegativeInteger(process.env.IMAGE_PROXY_CACHE_MAX_BYTES, 2 * 1024 * 1024 * 1024),
  ttlMs: parseNonNegativeInteger(process.env.IMAGE_PROXY_CACHE_TTL_MS, 24 * 60 * 60 * 1000)
});
// Unset (the default) means identical prompts are generated again each time.
// See server/genai-prompt-cache.js.
const genAiPromptCache = createGenAiPromptCache({
  dir: process.env.GENAI_PROMPT_CACHE_DIR ? path.resolve(process.env.GENAI_PROMPT_CACHE_DIR) : "",
  maxBytes: parseNonNegativeInteger(process.env.GENAI_PROMPT_CACHE_MAX_BYTES, 512 * 1024 * 1024),
  ttlMs: parseNonNegativeInteger(process.env.GENAI_PROMPT_CACHE_TTL_MS, 24 * 60 * 60 * 1000)
});
// Browser renders are 3–12 s of CPU and 200–400 MB each on a 2-CPU box. Over the
// limit a page waits up to PLAYWRIGHT_WAIT_MS for a render (at most
// PLAYWRIGHT_WAIT_MAX waiting), then falls back to its plain-HTML result.
const PLAYWRIGHT_CONCURRENCY_MAX = parseNonNegativeInteger(process.env.PLAYWRIGHT_CONCURRENCY_MAX, 1);
const PLAYWRIGHT_WAIT_MS = parseNonNegativeInteger(process.env.PLAYWRIGHT_WAIT_MS, 8000);
const PLAYWRIGHT_WAIT_MAX = parseNonNegativeInteger(process.env.PLAYWRIGHT_WAIT_MAX, 3);
let activeRenders = 0;
const renderWaiters = [];

// Resolves true once the caller holds a render slot; false on timeout, a full
// wait list, or the visitor leaving.
function acquireRenderSlot(res) {
  if (PLAYWRIGHT_CONCURRENCY_MAX === 0 || activeRenders < PLAYWRIGHT_CONCURRENCY_MAX) {
    activeRenders += 1;
    return Promise.resolve(true);
  }
  if (!PLAYWRIGHT_WAIT_MS || renderWaiters.length >= PLAYWRIGHT_WAIT_MAX) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const settle = (granted) => {
      clearTimeout(timer);
      res.off("close", onClose);
      const index = renderWaiters.indexOf(settle);
      if (index >= 0) {
        renderWaiters.splice(index, 1);
      }
      resolve(granted);
    };
    const onClose = () => settle(false);
    const timer = setTimeout(() => settle(false), PLAYWRIGHT_WAIT_MS);
    res.once("close", onClose);
    renderWaiters.push(settle);
  });
}

// Hands the slot straight to the next waiter, so a new arrival cannot take it
// between the release and the waiter waking.
function releaseRenderSlot() {
  const next = renderWaiters.shift();
  if (next) {
    next(true);
  } else {
    activeRenders = Math.max(0, activeRenders - 1);
  }
}
// /admin/live. Per-day counts persist here; visitors are memory only.
const liveMonitor = createLiveMonitor({
  statsPath: resolveFilePath(process.env.LIVE_STATS_PATH || new URL("./live-stats.json", import.meta.url))
});
const liveSessionContext = new AsyncLocalStorage();
// An mmdb country database (DB-IP "IP to Country Lite", CC BY 4.0). Unset or
// unreadable = no countries. The address is looked up and dropped, never kept.
const geoIpReader = loadGeoIpReader(process.env.GEOIP_COUNTRY_DB);
// GenAI images are ~500 KB PNGs. Above 0, a browser that accepts WebP is sent a
// WebP copy at this quality. Only the response changes: the stored buffer stays
// the provider's bytes, because a pool key is the content address of exactly
// those bytes and a variation is made from them.
const GENAI_DELIVERY_WEBP_QUALITY = Math.min(100, parseNonNegativeInteger(process.env.GENAI_DELIVERY_WEBP_QUALITY, 0));
// Part of the cache key, so changing the cap cannot serve images sized for the
// old one. The host allowlist is in it too: a hit skips the policy check, so
// tightening the list must not leave earlier images reachable.
const ALLOWED_TARGET_HOSTS = parseAllowedTargetHosts(process.env.ALLOWED_TARGET_HOSTS);
const PROXY_IMAGE_CACHE_VARIANT = `edge${PROXY_IMAGE_MAX_EDGE_PX}|${[...ALLOWED_TARGET_HOSTS].sort().join(",")}`;
const GENAI_QUEUE_MAX_PENDING = parseNonNegativeInteger(process.env.GENAI_QUEUE_MAX_PENDING, 2);
// The fal img2img adapter inlines the whole source image as a base64 data URL in
// the request body (no upload API), so a larger source is rejected rather than
// ballooning the request. Pre-encoding bytes; base64 inflates ~4/3. Imported
// sources are downscaled into the GENAI_WIDTH x GENAI_HEIGHT box before storing,
// so this only fires for a provider-generated source.
const FAL_VARY_MAX_SOURCE_BYTES = parseNonNegativeInteger(process.env.FAL_VARY_MAX_SOURCE_BYTES, 4 * 1024 * 1024);
// External search/web images are first copied into the same short-lived image
// store used by GenAI. This is a download backstop against an absurd payload,
// not a size policy: ordinary web photos exceed it and are resized on import
// (normalizeImportedRasterImage) instead of being refused.
const GENAI_SOURCE_IMPORT_MAX_BYTES = parseNonNegativeInteger(process.env.GENAI_SOURCE_IMPORT_MAX_BYTES, 20 * 1024 * 1024);
const FAL_FLUX_DEV_IMAGE_TO_IMAGE_MODEL = "fal-ai/flux/dev/image-to-image";
const FAL_FLUX_DEV_IMAGE_TO_IMAGE_MIN_STEPS = 10;
const FAL_FLUX_2_KLEIN_4B_TEXT_MODEL = "fal-ai/flux-2/klein/4b";
const FAL_FLUX_2_KLEIN_4B_EDIT_MODEL = "fal-ai/flux-2/klein/4b/edit";
// Hosted Fal refuses an undersized image with HTTP 422 `image_too_small`, whose
// context carries per-endpoint `min_width`/`min_height`. The model schemas
// publish no numeric bound, so these defaults (640x512 for the Klein pair) were
// observed from a live call; override if another Fal model reports different
// values. Hosted-only: local Draw Things has no floor. fitImageSizeToBox rounds
// these up to its 64 alignment.
const FAL_MIN_IMAGE_WIDTH = parsePositiveInteger(process.env.FAL_MIN_IMAGE_WIDTH, 640);
const FAL_MIN_IMAGE_HEIGHT = parsePositiveInteger(process.env.FAL_MIN_IMAGE_HEIGHT, 512);
// The floor above is per axis; fal bills per megapixel. Raising a 1:2 portrait
// until both axes clear 640x512 gives 640x1152, 2.25x the baseline's area and
// price. This caps the area such a raise may reach by clamping the aspect (see
// fitImageSizeToBox); the floor itself is never traded away. 0 disables the
// ceiling. Default 589824 = 768x768.
const GENAI_MAX_REQUEST_PIXELS = parseNonNegativeInteger(process.env.GENAI_MAX_REQUEST_PIXELS, 768 * 768);
// The pre-baked curated pack this server draws from. Unset (the default) means
// no pool and every GenAI request is generated; a dev checkout needs no pack.
// Production points it at one shipped release directory.
const GENAI_POOL_DIR = process.env.GENAI_POOL_DIR ? path.resolve(process.env.GENAI_POOL_DIR) : "";
// The guaranteed-new quota per batch, picked in this range per request. It is
// the only paid part of a warm run and keeps the piece producing unseen images
// once the pool is deep. 0/0 would make a warm sphere fully pre-baked and static.
const GENAI_POOL_FRESH_MIN = parseNonNegativeInteger(process.env.GENAI_POOL_FRESH_MIN, 1);
const GENAI_POOL_FRESH_MAX = parseNonNegativeInteger(process.env.GENAI_POOL_FRESH_MAX, 2);
// The writable half of the pool (server/genai-pool-grow.js): fresh images from
// GenAI bookmarks, rounds 1 and 2, kept and drawn like baked ones. Unset =
// nothing is kept. Works with or without GENAI_POOL_DIR. Unlike the pack, this
// directory must be owned by the service user.
const GENAI_POOL_GROW_DIR = process.env.GENAI_POOL_GROW_DIR ? path.resolve(process.env.GENAI_POOL_GROW_DIR) : "";
// Drawable members per key before a key stops growing. 8: a batch draws at most
// GENAI_COUNT (5) from one key, so repeat visits rarely replay the same sphere.
const GENAI_POOL_GROW_MAX_PER_KEY = parseNonNegativeInteger(process.env.GENAI_POOL_GROW_MAX_PER_KEY, 8);
// Where the review page's deletions are recorded. Default: a SIBLING of the
// pack, "<pack dir>.suppressed.json" — outside the release, so push-curated.sh
// neither refuses to write because of it nor overwrites it. Point several
// releases at one file to carry a curation across a re-bake.
const GENAI_POOL_SUPPRESS_FILE = process.env.GENAI_POOL_SUPPRESS_FILE
  ? path.resolve(process.env.GENAI_POOL_SUPPRESS_FILE)
  : defaultSuppressionPath(GENAI_POOL_DIR || GENAI_POOL_GROW_DIR);
const SETTINGS_FILE_PATH = process.env.SETTINGS_FILE_PATH || new URL("./settings.local.json", import.meta.url);
const API_QUERY_LOG_FILE = process.env.LOG_API_QUERIES_FILE || new URL("./query.log", import.meta.url);
const XR_DIAG_LOG_FILE = process.env.XR_DIAG_LOG_FILE || new URL("./xr-diag.log", import.meta.url);
// Public-deployment hardening. Every default is the permissive dev behaviour: no
// proxy trust, reflected CORS, XR diag on.
//
// TRUST_PROXY drives app.set("trust proxy"). isLocalRequest() is the
// settings/screenshot authorisation check, and behind a reverse proxy every
// request arrives from 127.0.0.1. Off (the default) that check is correct
// because there is no proxy; set to 1 behind Caddy/nginx so req.ip is the real
// client and the check is correct again.
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
// Comma-separated origin allowlist. Unset = reflect any origin (dev default).
const CORS_ALLOWED_ORIGINS = parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
// The XR diag route is an unauthenticated append-to-disk. Keep it in dev, turn
// it off in public deployments, and cap the file either way.
const XR_DIAG_ENABLED = parseBoolean(process.env.XR_DIAG_ENABLED, true);
const XR_DIAG_MAX_BYTES = parseNonNegativeInteger(process.env.XR_DIAG_MAX_BYTES, 20 * 1024 * 1024);
// The body limit allows 1 MB; a real diag event is well under 2 KB.
const XR_DIAG_MAX_LINE_CHARS = parsePositiveInteger(process.env.XR_DIAG_MAX_LINE_CHARS, 8192);
// Text length ceilings. Both truncate rather than reject: a clipped prompt still
// produces images, where a 400 mid-session does not.
const SEARCH_QUERY_MAX_CHARS = parsePositiveInteger(process.env.SEARCH_QUERY_MAX_CHARS, 200);
const GENAI_PROMPT_MAX_CHARS = parsePositiveInteger(process.env.GENAI_PROMPT_MAX_CHARS, 1000);
// Daily spend caps. All default to 0 = unlimited, which leaves the guard inert:
// no counting, no state file, no spend log. See server/spend-guard.js for why
// the unit counted is images/queries, not requests.
const SPEND_STATE_PATH = process.env.SPEND_STATE_PATH || new URL("./spend-state.json", import.meta.url);
const KILL_SWITCH_PATH = process.env.KILL_SWITCH_PATH || new URL("./KILL_SWITCH", import.meta.url);
const KILL_SWITCH_CACHE_MS = parseNonNegativeInteger(process.env.KILL_SWITCH_CACHE_MS, 5_000);
// In-memory search LRU. A cache hit costs nothing and is deliberately not
// counted against a cap.
const SEARCH_CACHE_MAX = parseNonNegativeInteger(process.env.SEARCH_CACHE_MAX, 500);
const SEARCH_CACHE_TTL_MS = parseNonNegativeInteger(process.env.SEARCH_CACHE_TTL_MS, 24 * 60 * 60_000);
// Bounds genAiProgressJobs: TTL alone is not a bound, and polling extends its
// own TTL.
const GENAI_PROGRESS_JOBS_MAX = parseNonNegativeInteger(process.env.GENAI_PROGRESS_JOBS_MAX, 500);
// Unset = no static serving, the dev shape (Vite serves the client and proxies
// /api here). Set it to a built dist/ and this process serves the whole app on
// its own.
const SERVE_STATIC_DIR = process.env.SERVE_STATIC_DIR ? path.resolve(process.env.SERVE_STATIC_DIR) : "";
const GENERATED_IMAGES_DIR = process.env.GENAI_IMAGE_DIR_PATH || new URL("../generated-images/", import.meta.url);
const SCREENSHOTS_DIR = process.env.SCREENSHOT_DIR_PATH || new URL("../screenshots/", import.meta.url);
// Screen capture is an admin capability: the route writes files to this host's
// disk. Unset (the default) leaves the local-only rule in place. Set, it matches
// canWriteSettings(): the token from anywhere, or loopback. Setting it on a
// public host opens a write path.
const SCREENSHOT_TOKEN = process.env.SCREENSHOT_TOKEN || "";
// The client clamps its long edge to 1920 before encoding, so the largest honest
// capture is 1920x1920 RGBA = 14.7 MB raw, and PNG cannot beat raw by more than
// deflate's stored-block overhead. 16 MB is a sanity bound on an authorised
// caller, not a spend control; the gate below keeps strangers out.
const SCREENSHOT_MAX_BYTES = parsePositiveInteger(process.env.SCREENSHOT_MAX_BYTES, 16 * 1024 * 1024);
// Dimension clamp on the file's own header (JPEG SOF or PNG IHDR): the bytes are
// not ours, and a 60000px-square header is cheap to send.
const SCREENSHOT_MAX_EDGE_PX = 4096;
const MUSEUM_SAFE_BLOCKLIST_URL = new URL("./museum-safe-blocklist.txt", import.meta.url);
const HIDE_SETTINGS = parseBoolean(process.env.HIDE_SETTINGS, false);
const SETTINGS_TOKEN = process.env.SETTINGS_TOKEN || "";
let settingsOverrides = loadSettingsOverrides();
const museumSafeBlockedTerms = loadMuseumSafeBlocklist();
const spendGuard = createSpendGuard({
  caps: {
    genaiDaily: process.env.GENAI_DAILY_IMAGE_CAP,
    genaiDailyPerIp: process.env.GENAI_DAILY_IMAGES_PER_IP,
    searchDaily: process.env.SEARCH_DAILY_QUERY_CAP,
    searchDailyPerIp: process.env.SEARCH_DAILY_QUERIES_PER_IP
  },
  statePath: resolveFilePath(SPEND_STATE_PATH),
  spendLogPath: resolveSpendLogPath(),
  usdPerImage: Number(process.env.GENAI_USD_PER_IMAGE || 0.003125),
  usdPerQuery: Number(process.env.SEARCH_USD_PER_QUERY || 0.001),
  persistDelayMs: parseNonNegativeInteger(process.env.SPEND_PERSIST_DELAY_MS, 2_000),
  onWarn: (message) => console.warn(message)
});
const killSwitch = createKillSwitch({
  filePath: resolveFilePath(KILL_SWITCH_PATH),
  cacheMs: KILL_SWITCH_CACHE_MS
});
// A paid provider (fal, Serper) can bill us the moment it answers with a usable
// response, before our own code has done anything with it, and reading the body
// or decoding can still fail afterward. readJsonResponse() flips `billed` the
// instant it sees response.ok so a route's catch block knows a release would
// refund something already paid for. AsyncLocalStorage (not a plain variable)
// because requests run concurrently; AsyncResource.bind is used at the genai
// queue boundary because a queued job's fetch happens later, off a different
// job's continuation, which would lose this context.
const providerBillingContext = new AsyncLocalStorage();
// Loaded once, at boot: the pack is immutable. The suppression list and the grown
// store are the mutable parts: read at boot, then updated in memory as they are
// written, with genAiPool rebuilt from all three.
const bakedGenAiPool = loadPoolPack(GENAI_POOL_DIR);
let grownGenAiPool = loadGrowStore(GENAI_POOL_GROW_DIR);
let poolSuppression = readSuppression(GENAI_POOL_SUPPRESS_FILE);
let genAiPool = rebuildGenAiPool();
const GENAI_BOOKMARK_PROMPTS = bookmarkPromptSet(genAiBookmarkPrompts());
const genAiImageStore = new Map();
let genAiImageStoreBytes = 0;
const searchResultCache = new Map();
const genAiResultCache = new Map();
const genAiProgressJobs = new Map();
const genAiQueue = {
  active: new Set(),
  pending: []
};
const SERVER_STARTED_AT = Date.now();

const EXCLUDED_CONTENT_EXTENSIONS = new Set([
  ".asf", ".avi", ".flv", ".m4v", ".mkv", ".mov", ".mp4", ".mpg", ".mpeg", ".swf", ".webm", ".wmv",
  ".atom", ".feed", ".rss", ".xml",
  ".csv", ".doc", ".docx", ".epub", ".odt", ".pdf", ".ppt", ".pptx", ".rtf", ".txt", ".xls", ".xlsx",
  ".7z", ".gz", ".rar", ".tar", ".zip",
  ".css", ".js", ".json", ".sql", ".yaml", ".yml",
  ".dll", ".exe", ".ico", ".iso", ".msi"
]);

const SETTING_DEFINITIONS = Object.freeze({
  IMAGE_SEARCH_PROVIDER: { defaultValue: "ddg", type: "imageSearchProvider" },
  IMAGE_SEARCH_ENDPOINT: { defaultValue: "", type: "url" },
  SERPER_API_KEY: { defaultValue: "", type: "secret" },
  BRAVE_SEARCH_API_KEY: { defaultValue: "", type: "secret" },
  GENAI_PROVIDER: { defaultValue: "", type: "genAiProvider" },
  GENAI_ENDPOINT: { defaultValue: "", type: "url" },
  GENAI_DRAWTHINGS_ENDPOINT: { defaultValue: "", type: "url" },
  GENAI_A1111_ENDPOINT: { defaultValue: "", type: "url" },
  GENAI_CUSTOM_ENDPOINT: { defaultValue: "", type: "url" },
  GENAI_API_KEY: { defaultValue: "", type: "secret" },
  FAL_KEY: { defaultValue: "", type: "secret" },
  GENAI_FAL_BASE_URL: { defaultValue: "https://fal.run", type: "url" },
  GENAI_FAL_TEXT_MODEL: { defaultValue: "fal-ai/flux/schnell", type: "string" },
  GENAI_FAL_IMAGE_MODEL: { defaultValue: "fal-ai/flux/dev/image-to-image", type: "string" },
  GENAI_COUNT: { defaultValue: 5, type: "integer", min: 1, max: DEFAULT_LIMIT },
  GENAI_WIDTH: { defaultValue: 512, type: "integer", min: 64, max: 2048 },
  GENAI_HEIGHT: { defaultValue: 512, type: "integer", min: 64, max: 2048 },
  GENAI_TIMEOUT_MS: { defaultValue: 120_000, type: "integer", min: 1_000, max: 600_000 },
  GENAI_SAVE_IMAGES_TO_DISK: { defaultValue: true, type: "boolean" },
  GENAI_CLEANUP_IMAGES: { defaultValue: true, type: "boolean" },
  GENAI_IMAGE_RETENTION_DAYS: { defaultValue: 0, type: "integer", min: 0, max: 3650 },
  GENAI_MUSEUM_SAFE: { defaultValue: false, type: "boolean" },
  GENAI_STEPS: { defaultValue: 8, type: "optionalInteger", min: 1, max: 150 },
  GENAI_CFG_SCALE: { defaultValue: "", type: "optionalNumber", min: 0.1, max: 30 },
  GENAI_DRAWTHINGS_GUIDANCE_EMBED: { defaultValue: 5, type: "optionalNumber", min: 0.1, max: 30 },
  GENAI_VARIATION_STRENGTH_MIN: { defaultValue: 0.95, type: "number", min: 0, max: 1 },
  GENAI_VARIATION_STRENGTH_MAX: { defaultValue: 1, type: "number", min: 0, max: 1 },
  GENAI_VARY_SEED_MODE: { defaultValue: "fresh", type: "genAiVarySeedMode" },
  GENAI_VARY_MODIFIERS: { defaultValue: "🧊 🌶️ 🦄 🎆 🍦 🧀 🌹 😎 🪩 🦦 🦘 ❄️ 🌊 🌕 🌲 🍌 💡 🕯️ 🚿", type: "string" },
  GENAI_VARY_MODIFIER_MODE: { defaultValue: "per-image", type: "genAiVaryModifierMode" },
  GENAI_VARY_MODIFIER_STYLE: { defaultValue: "replace", type: "genAiVaryModifierStyle" },
  GENAI_VARY_MODIFIER_PAYLOAD: { defaultValue: "text", type: "genAiVaryModifierPayload" },
  // Milliseconds of no client-side input after which the sphere's dwell
  // auto-advance suspends. Inside a GenAI sphere every auto-advance is a paid
  // batch, so a forgotten tab would generate until the daily cap. 0 disables the
  // suspension (attended kiosk / ?auto= gallery).
  AUTO_ADVANCE_IDLE_TIMEOUT_MS: { defaultValue: 300_000, type: "integer", min: 0, max: 86_400_000 },
  // The same guard for a free hop: a web or search sphere's dwell exit is a page
  // fetch, so an abandoned tab only spends bandwidth, but forever. Longer default.
  AUTO_ADVANCE_FREE_IDLE_TIMEOUT_MS: { defaultValue: 3_600_000, type: "integer", min: 0, max: 86_400_000 },
  SHOW_STATUS_FOOTER: { defaultValue: true, type: "boolean" },
  SHOW_IMAGE_LIST: { defaultValue: true, type: "boolean" },
  // Whether the image list's generated rows are clickable links. Off makes them
  // inert text, so a visitor cannot hand out a same-origin URL pointing at one
  // specific generated image.
  //
  // Only generated images produce a same-origin URL: the list shows extracted web
  // or image-search results at their original absolute URL (the /api/proxy/image
  // rewrite happens at texture-load time and never reaches the list), and those
  // links are not ours to gate.
  GENAI_IMAGE_LIST_LINKS: { defaultValue: true, type: "boolean" },
  // Which hand carries the VR wrist UI. Desktop-owned: VR exposes only the wrist
  // toggles, not handedness.
  WRIST_PANEL_HAND: { defaultValue: "left", type: "wristPanelHand" },
  LOG_API_QUERIES: { defaultValue: true, type: "boolean" }
});

// clients/browser -> clients -> repo root.
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
// What this process booted at; fixed for its lifetime.
const GIT_BUILD_AT_BOOT = readGitBuild();
// What is checked out now. Cached briefly: /api/health is polled, but a deploy
// must show up in seconds rather than at the next restart.
const GIT_BUILD_CACHE_MS = 5000;
let gitBuildCache = { at: 0, value: GIT_BUILD_AT_BOOT };

function currentGitBuild(now = Date.now()) {
  if (now - gitBuildCache.at < GIT_BUILD_CACHE_MS) {
    return gitBuildCache.value;
  }
  gitBuildCache = { at: now, value: readGitBuild() };
  return gitBuildCache.value;
}

const app = express();
app.set("trust proxy", TRUST_PROXY);
app.use(cors(buildCorsOptions()));
// Ahead of every body parser, deliberately: a capture is multiple megabytes, and
// an unauthorised caller must not make this process buffer one before being
// refused. Express runs middleware in registration order, so a refusal here
// returns before express.json() or the route's own express.raw() reads the
// stream.
app.use("/api/screenshot", screenshotAuthGate);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));
app.use("/api", liveMonitorMiddleware);
app.use(["/api/extract", "/api/proxy/image", "/api/search/images", "/api/genai", "/api/stt", "/api/debug/xr"], rateLimitRequests);
// Separate pools, so page loads (and the renders inside them, seconds each) can
// never use up the slots images need.
const scrapeConcurrencyGuard = createConcurrencyGuard(SCRAPE_CONCURRENCY_MAX, SCRAPE_CONCURRENCY_PER_CLIENT);
const imageProxyConcurrencyGuard = createConcurrencyGuard(IMAGE_PROXY_CONCURRENCY_MAX, IMAGE_PROXY_CONCURRENCY_PER_CLIENT);
const inFlightExtracts = createInFlightRequests();
const inFlightProxyImages = createInFlightRequests();
const inFlightSearches = createInFlightRequests();

// Cache hits are answered ahead of the slot pools, so they are never turned
// away as busy. They skip the target-URL policy check too, which is safe
// because nothing is fetched and an entry only exists for a URL that passed it.
// Hits are not marked in the response: that would tell anyone what another
// visitor loaded today. res.locals carries it to the live monitor instead.
app.get("/api/extract", async (req, res, next) => {
  const cacheKey = hasNavigableUrlShape(req.query.url) ? extractCacheKey(normalizeUrl(req.query.url), req.query) : null;
  const cached = cacheKey ? readCachedExtract(cacheKey) : null;
  if (!cached) {
    if (!await inFlightExtracts.follow(cacheKey, res)) {
      next();
    }
    return;
  }
  logApiQuery("extract.cached", { url: cached.sourceUrl, items: cached.items.length });
  res.json(cached);
});
app.use(["/api/extract", "/api/genai/source/import"], scrapeConcurrencyGuard);
app.get("/api/extract", (req, res, next) => {
  inFlightExtracts.lead(hasNavigableUrlShape(req.query.url) ? extractCacheKey(normalizeUrl(req.query.url), req.query) : null, res);
  next();
});
app.get("/api/proxy/image", async (req, res, next) => {
  const imageUrl = normalizeUrl(req.query.url);
  const cached = imageUrl ? await imageProxyCache.get(imageUrl, PROXY_IMAGE_CACHE_VARIANT) : null;
  if (!cached) {
    if (!await inFlightProxyImages.follow(imageUrl, res)) {
      next();
    }
    return;
  }
  res.locals.imageCacheHit = true;
  sendProxiedImage(res, cached.buffer, cached.contentType);
});
app.use("/api/proxy/image", imageProxyConcurrencyGuard);
app.get("/api/proxy/image", (req, res, next) => {
  inFlightProxyImages.lead(normalizeUrl(req.query.url), res);
  next();
});
// Built-in Whisper is on by default and pins the CPU per request; one at a time.
app.use("/api/stt", createConcurrencyGuard(parsePositiveInteger(process.env.STT_CONCURRENCY_MAX, 1)));
setupStt(app, { killSwitch });

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "surface-browser-mvp-api",
    // `commit` is the checkout (what the client was built from, and whether a deploy
    // landed). `running` is what this Node process booted at; it lags after a
    // client-only deploy, which does not restart. Local callers only: in public
    // it would show which published fixes are not deployed yet.
    ...(isLocalRequest(req) ? { build: { ...currentGitBuild(), running: GIT_BUILD_AT_BOOT.commit } } : {}),
    playwright: isPlaywrightEnabled(),
    genai: {
      enabled: isGenAiEnabled(),
      provider: getGenAiProvider()
    },
    stt: { enabled: isSttEnabled() },
    // Lets a public build skip probing /api/settings, whose 404 reads as an error.
    settings: { enabled: !HIDE_SETTINGS },
    // Counters stay on the localhost-only /admin/live.json.
    imageCache: { enabled: imageProxyCache.enabled },
    genaiPromptCache: { enabled: genAiPromptCache.enabled },
    statusFooter: { enabled: getBooleanSetting("SHOW_STATUS_FOOTER") },
    imageList: {
      enabled: getBooleanSetting("SHOW_IMAGE_LIST"),
      links: getBooleanSetting("GENAI_IMAGE_LIST_LINKS")
    },
    autoAdvance: {
      idleTimeoutMs: getIntegerSetting("AUTO_ADVANCE_IDLE_TIMEOUT_MS"),
      freeIdleTimeoutMs: getIntegerSetting("AUTO_ADVANCE_FREE_IDLE_TIMEOUT_MS")
    },
    wristPanelHand: { value: getWristPanelHand() }
  });
});

// Client XR diagnostics. The headset browser's console is hard to read
// mid-session, so the client posts what the XR runtime handed it and it is
// logged here and in server/xr-diag.log. Unauthenticated and best-effort; it
// only writes a log line. XR_DIAG_ENABLED=0 removes the route (404) for public
// deployments; the file is size-capped either way (XR_DIAG_MAX_BYTES, one .1
// generation).
app.post("/api/debug/xr", (req, res) => {
  if (!XR_DIAG_ENABLED) {
    res.status(404).json({ error: "XR diagnostics are disabled" });
    return;
  }
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }).slice(0, XR_DIAG_MAX_LINE_CHARS);
  console.info(`[XR diag] ${line}`);
  appendXrDiagLine(`${line}\n`);
  res.status(204).end();
});

// The client posts a JPEG (canvas.toBlob): an opaque 3D frame has no alpha to
// lose, and JPEG is several times smaller than PNG. PNG is still accepted. Raw
// RGBA as base64 inside JSON would not fit: a Quest 3S eye buffer is ~18 MB of
// RGBA and ~24 MB base64'd, over the JSON limit.
//
// Authorisation happened above, ahead of the parser (see screenshotAuthGate).
const SCREENSHOT_EXTENSIONS = Object.freeze({ "image/jpeg": "jpg", "image/png": "png" });

app.post("/api/screenshot", readScreenshotBody, (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : null;
  if (!body || body.length === 0) {
    res.status(400).json({ error: "Missing screenshot image" });
    return;
  }

  let detected = null;
  try {
    detected = detectRasterImage(body);
  } catch {
    // Absurd declared dimensions.
    detected = null;
  }
  // MAGIC BYTES, not the content-type header. The client's declared type is a
  // claim, not evidence; detectRasterImage reads the signature and the
  // format's own header, which is also where the dimensions below come from.
  const extension = detected ? SCREENSHOT_EXTENSIONS[detected.contentType] : undefined;
  if (!extension) {
    res.status(400).json({ error: "Screenshot must be a JPEG or PNG" });
    return;
  }
  if (detected.width > SCREENSHOT_MAX_EDGE_PX || detected.height > SCREENSHOT_MAX_EDGE_PX) {
    res.status(400).json({ error: "Screenshot dimensions out of range" });
    return;
  }

  try {
    const dir = getScreenshotsDirPath();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `surface-browser-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, body);
    res.json({ ok: true, filename, path: filePath, width: detected.width, height: detected.height });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.use("/api/settings", (req, res, next) => {
  if (HIDE_SETTINGS) {
    res.status(404).json({ error: "Settings are disabled" });
    return;
  }
  next();
});

app.get("/api/settings", (_req, res) => {
  res.json({
    ok: true,
    settings: getPublicSettings(),
    meta: getSettingsMeta()
  });
});

app.put("/api/settings", (req, res) => {
  if (!canWriteSettings(req)) {
    res.status(403).json({ error: "Settings are read-only on this deployment" });
    return;
  }

  try {
    const nextOverrides = validateSettingsUpdate(req.body?.settings || req.body || {});
    settingsOverrides = nextOverrides;
    writeSettingsOverrides(settingsOverrides);
    genAiResultCache.clear();
    genAiProgressJobs.clear();
    // A settings write can change the search provider or museum-safe mode, both
    // of which are baked into a cached result.
    searchResultCache.clear();
    res.json({
      ok: true,
      settings: getPublicSettings(),
      meta: getSettingsMeta()
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/settings/test", async (req, res) => {
  if (!canWriteSettings(req)) {
    res.status(403).json({ error: "Settings tests are disabled on this deployment" });
    return;
  }

  const target = String(req.body?.target || "").trim();
  const stage = String(req.body?.stage || "").trim();
  const started = Date.now();
  try {
    const result = await runSettingsTest(target, stage);
    res.json({
      ok: true,
      latencyMs: Date.now() - started,
      ...result
    });
  } catch (err) {
    const status = err instanceof ProviderConfigError ? 501 : 502;
    res.status(status).json({
      ok: false,
      latencyMs: Date.now() - started,
      error: err.message
    });
  }
});

app.get("/api/proxy/image", holdSlotUntilSettled(async (req, res) => {
  let imageUrl;
  try {
    imageUrl = await normalizeAndAssertTargetUrl(req.query.url, "image url");
  } catch (err) {
    sendPolicyError(res, err, "Missing or invalid image url");
    return;
  }

  try {
    const upstream = await fetchWithTimeout(imageUrl, {
      headers: {
        "user-agent": browserUserAgent()
      }
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream image error: ${upstream.status}` });
      return;
    }

    const buffer = await readResponseBuffer(upstream);
    // The response content type is decided from the bytes, not from upstream.
    //
    // This route serves attacker-influenced bytes from our own origin, so what the
    // browser is told they are is a security decision. Forwarding the upstream
    // header would let a remote host return `image/svg+xml` and run script on our
    // origin; `nosniff` does not help, since it enforces the declared type.
    //
    // detectRasterImage() reads magic bytes and returns a canonical type for
    // PNG/JPEG/WebP/GIF only. SVG is drawn to a PNG (rasterizeSvg sanitises it
    // first) and only the PNG is served. Anything else (HTML, a PDF, an empty
    // body) is refused.
    if (looksLikeSvg(buffer)) {
      let png;
      try {
        png = await rasterizeSvg(buffer, PROXY_IMAGE_MAX_EDGE_PX);
      } catch (err) {
        logApiQuery("proxyImage.refused", { url: imageUrl, upstreamType: "svg", bytes: buffer.length, error: err.message });
        res.status(415).json({ error: "Unsupported image format" });
        return;
      }
      imageProxyCache.set(imageUrl, PROXY_IMAGE_CACHE_VARIANT, png, "image/png");
      sendProxiedImage(res, png, "image/png");
      return;
    }
    let detected = null;
    try {
      detected = detectRasterImage(buffer);
    } catch {
      // Absurd declared dimensions. Refused for the same reason.
      detected = null;
    }
    if (!detected) {
      logApiQuery("proxyImage.refused", {
        url: imageUrl,
        upstreamType: upstream.headers.get("content-type") || "",
        bytes: buffer.length
      });
      res.status(415).json({ error: "Unsupported image format" });
      return;
    }
    // Cap the long edge before the bytes reach a GPU: THREE.TextureLoader decodes
    // and uploads on the frame the material first renders, so a large source
    // stutters the tunnel. downscaleProxiedImage never throws: anything it cannot
    // handle comes back untouched. See server/images.js for the rationale.
    const downscaled = await downscaleProxiedImage(buffer, detected.contentType, PROXY_IMAGE_MAX_EDGE_PX);
    // Not awaited: the visitor should not wait on the disk.
    imageProxyCache.set(imageUrl, PROXY_IMAGE_CACHE_VARIANT, downscaled.buffer, downscaled.contentType);
    sendProxiedImage(res, downscaled.buffer, downscaled.contentType);
  } catch (err) {
    if (sendPolicyError(res, err)) {
      return;
    }
    res.status(502).json({ error: `Image proxy failed: ${err.message}` });
  }
}));

function sendProxiedImage(res, buffer, contentType) {
  res.setHeader("content-type", contentType);
  // Defence in depth for a route that serves third-party bytes: even if a
  // future format slipped past the sniffer, it can load nothing and run
  // nothing. Scoped to this response, so it cannot affect the app's own pages.
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
  // A day, as the disk cache. The URL names the source, not the resize, so a
  // change to the resize reaches a browser only once its copy expires.
  res.setHeader("cache-control", "public, max-age=86400");
  res.send(buffer);
}

app.get("/api/genai/image/:id", async (req, res) => {
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
});

app.get("/api/genai/job/:id", (req, res) => {
  const job = getGenAiProgressJob(req.params.id);
  if (!job) {
    res.status(410).json({ error: "GenAI job expired or not found" });
    return;
  }
  res.json(buildGenAiProgressJobResponse(job));
});

app.delete("/api/genai/job/:id", (req, res) => {
  const job = getGenAiProgressJob(req.params.id);
  if (!job) {
    res.status(410).json({ error: "GenAI job expired or not found" });
    return;
  }
  cancelGenAiProgressJob(job);
  res.json(buildGenAiProgressJobResponse(job));
});

// --- the pool review page (local only) -------------------------------------
//
// A local admin tool for reviewing a baked pack and deleting from it. It is not
// part of the piece: the page lives in server/, is absent from the Vite entry
// points and dist/, and is reachable only through this gate, so a public host
// has no file to hand a visitor even if the gate were wrong.
//
// The gate is isLocalRequest(), the same check that authorises settings writes
// and screenshots. It answers 404 rather than 403 so a public deployment does
// not advertise the page. It reads req.ip, so it is only as correct as
// TRUST_PROXY: behind a reverse proxy with TRUST_PROXY unset every forwarded
// request looks local, which is why BIND_HOST=127.0.0.1 and TRUST_PROXY=1 belong
// together in production.
//
// Grown members (GENAI_POOL_GROW_DIR) are listed beside baked ones; a round-2
// grown member can have been triggered by a visitor, hence the review.
function poolReviewGate(req, res, next) {
  if ((!GENAI_POOL_DIR && !GENAI_POOL_GROW_DIR) || !isLocalRequest(req)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

// Same gate as the pool page, minus the pool condition: localhost only, 404 to
// everyone else.
function localOnlyGate(req, res, next) {
  if (!isLocalRequest(req)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

app.get("/admin/live", localOnlyGate, (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.type("html").send(fs.readFileSync(new URL("./live-monitor.html", import.meta.url), "utf8"));
});

// Copied each minute, not only when the page asks, so the last minutes before
// UTC midnight reach the totals.
function syncLiveImagesMade() {
  if (spendGuard.active) {
    const spend = spendGuard.snapshot();
    liveMonitor.syncPaidImages({ day: spend.day, total: spend.genai.total });
  }
}
setInterval(syncLiveImagesMade, 60_000).unref();

app.get("/admin/live.json", localOnlyGate, (_req, res) => {
  syncLiveImagesMade();
  const spend = spendGuard.snapshot();
  res.setHeader("cache-control", "no-store");
  res.json({
    ...liveMonitor.snapshot(),
    spend: { active: spendGuard.active, limits: spend.limits, estimatedUsd: spend.estimatedUsd },
    imageCache: imageProxyCache.snapshot(),
    genaiPromptCache: genAiPromptCache.snapshot(),
    genaiImageStore: {
      images: genAiImageStore.size,
      bytes: genAiImageStoreBytes,
      maxBytes: getGenAiImageCacheMaxBytes(),
      poolBytes: poolMemberBytesTotal
    },
    geoIp: Boolean(geoIpReader)
  });
});

app.get("/admin/pool", poolReviewGate, (_req, res) => {
  let html;
  try {
    html = fs.readFileSync(new URL("./pool-review.html", import.meta.url), "utf8");
  } catch (err) {
    res.status(500).type("text/plain").send(`pool-review.html could not be read: ${err.message}`);
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.type("html").send(html);
});

app.get("/api/pool/members", poolReviewGate, (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json(buildPoolReview(req.query));
});

app.get("/api/pool/image/:id", poolReviewGate, async (req, res) => {
  const member = genAiPool.byId?.get(String(req.params.id));
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
});

app.post("/api/pool/suppress", poolReviewGate, (req, res) => {
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
    const member = genAiPool.byId?.get(id);
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
    genAiPool = rebuildGenAiPool();
    // A cached result replays above the draw, so a deleted image could
    // otherwise still come back for the rest of the cache's TTL.
    genAiResultCache.clear();
  }
  res.json({ ok: true, changed, suppressedCount: genAiPool.suppressedCount, memberCount: genAiPool.memberCount });
});

// Every extracted page is cached, typed URLs included, so a news page can be up
// to EXTRACT_CACHE_TTL_MS stale. 0 disables. In memory, so a restart empties it;
// `fallback=force` always fetches fresh.
const EXTRACT_CACHE_TTL_MS = parseNonNegativeInteger(process.env.EXTRACT_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
const EXTRACT_CACHE_MAX_ENTRIES = parsePositiveInteger(process.env.EXTRACT_CACHE_MAX_ENTRIES, 500);
// Bounded by bytes too: a page's title and URLs are its author's to make huge,
// and 500 entries of 10 MB each would exhaust memory. An ordinary result is a
// few KB.
const EXTRACT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const EXTRACT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const extractCache = new Map();
let extractCacheBytes = 0;

function extractCacheKey(sourceUrl, query) {
  const fallbackMode = normalizeFallback(query.fallback);
  if (!sourceUrl || EXTRACT_CACHE_TTL_MS <= 0 || fallbackMode === "force") {
    return null;
  }
  const limit = clampNumber(query.limit, 1, DEFAULT_LIMIT, DEFAULT_LIMIT);
  const threshold = clampNumber(query.threshold, 1, 30, DEFAULT_THRESHOLD);
  return `${sourceUrl}|${limit}|${threshold}|${fallbackMode}`;
}

function readCachedExtract(key) {
  const hit = extractCache.get(key);
  if (!hit) {
    return null;
  }
  if (hit.expiresAt <= Date.now()) {
    dropCachedExtract(key);
    return null;
  }
  return hit.body;
}

function dropCachedExtract(key) {
  const hit = extractCache.get(key);
  if (hit) {
    extractCache.delete(key);
    extractCacheBytes -= hit.bytes;
  }
}

function writeCachedExtract(key, body) {
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > EXTRACT_CACHE_MAX_ENTRY_BYTES) {
    return;
  }
  dropCachedExtract(key);
  extractCache.set(key, { expiresAt: Date.now() + EXTRACT_CACHE_TTL_MS, body, bytes });
  extractCacheBytes += bytes;
  while (extractCache.size > EXTRACT_CACHE_MAX_ENTRIES || extractCacheBytes > EXTRACT_CACHE_MAX_BYTES) {
    dropCachedExtract(extractCache.keys().next().value);
  }
}

// Render when the HTML has too few linked images, once: a page whose static
// HTML yields fewer than this many linked images is also rendered in a browser
// (if Playwright is available). A render that did not improve on the HTML is
// remembered for an hour so visitors do not re-render the same page.
const MIN_LINKED_BEFORE_RENDER = 3;
const RENDER_NO_GAIN_TTL_MS = 60 * 60 * 1000;
const RENDER_NO_GAIN_MAX_ENTRIES = 200;
const renderNoGain = new Map();

function renderRecentlyUseless(url) {
  const until = renderNoGain.get(url);
  if (!until) {
    return false;
  }
  if (until <= Date.now()) {
    renderNoGain.delete(url);
    return false;
  }
  return true;
}

function rememberRenderUseless(url) {
  renderNoGain.delete(url);
  renderNoGain.set(url, Date.now() + RENDER_NO_GAIN_TTL_MS);
  while (renderNoGain.size > RENDER_NO_GAIN_MAX_ENTRIES) {
    renderNoGain.delete(renderNoGain.keys().next().value);
  }
}

function linkedItemCount(result) {
  return result ? result.items.filter((item) => item.linkUrl).length : 0;
}

app.get("/api/extract", holdSlotUntilSettled(async (req, res) => {
  let sourceUrl;
  try {
    if (!hasNavigableUrlShape(req.query.url)) {
      throw new RequestPolicyError("URL must include http(s), a web host, or a path");
    }
    sourceUrl = await normalizeAndAssertTargetUrl(req.query.url, "url query parameter");
  } catch (err) {
    sendPolicyError(res, err, "Missing or invalid url query parameter");
    return;
  }

  const limit = clampNumber(req.query.limit, 1, DEFAULT_LIMIT, DEFAULT_LIMIT);
  const threshold = clampNumber(req.query.threshold, 1, 30, DEFAULT_THRESHOLD);
  const fallbackMode = normalizeFallback(req.query.fallback);
  const startedAt = Date.now();
  // Looked up ahead of the slot pool (see the app.get above the guards).
  let cacheKey = extractCacheKey(sourceUrl, req.query);

  const warnings = [];
  let primary = null;
  let fallback = null;
  // Set when the site itself refused us (401/403/429), so an empty result can
  // say "blocked" rather than "no images".
  let blockedBy = null;

  try {
    primary = await extractViaHtmlFetch(sourceUrl, limit);
  } catch (err) {
    if (sendPolicyError(res, err)) {
      return;
    }
    if (/^HTTP (401|403|429)$/.test(err.message)) {
      blockedBy = new URL(sourceUrl).hostname.replace(/^www\./, "");
    }
    warnings.push(`Primary extraction failed: ${err.message}`);
  }

  const shouldFallback = fallbackMode === "force"
    || (fallbackMode === "auto"
      && (!primary || primary.items.length < threshold || linkedItemCount(primary) < MIN_LINKED_BEFORE_RENDER)
      && !renderRecentlyUseless(sourceUrl));

  let rendering = false;
  if (shouldFallback) {
    // The render has its own limit (activeRenders); holding a page-load slot for
    // its wait and 4-25 s as well would leave other visitors 2 slots for
    // second-long loads.
    res.locals.releaseConcurrencySlot?.();
    rendering = await acquireRenderSlot(res);
    if (!rendering) {
      // A day of the HTML-only result is the wrong thing to remember.
      cacheKey = null;
      warnings.push("Render skipped: the renderer is busy");
      logApiQuery("extract.renderBusy", { url: sourceUrl });
    }
  }
  if (rendering) {
    try {
      fallback = await extractViaPlaywright(sourceUrl, limit);
      if (chooseResult(primary, fallback) === fallback) {
        warnings.push(primary ? "Using fallback extraction result" : "Primary unavailable; using fallback extraction");
      } else {
        warnings.push("Fallback extraction was no better; keeping primary result");
      }
    } catch (err) {
      if (sendPolicyError(res, err)) {
        return;
      }
      warnings.push(`Fallback extraction unavailable: ${err.message}`);
    } finally {
      releaseRenderSlot();
    }
    if (fallbackMode === "auto" && chooseResult(primary, fallback) !== fallback) {
      rememberRenderUseless(sourceUrl);
    }
  }

  const selected = chooseResult(primary, fallback);
  if (blockedBy && !selected?.items.length) {
    logApiQuery("extract.blocked", { url: sourceUrl, durationMs: Date.now() - startedAt });
    res.status(502).json({
      error: `${blockedBy} blocks requests from this server`,
      code: "blocked",
      meta: { warnings }
    });
    return;
  }
  if (!selected) {
    logApiQuery("extract.failed", {
      url: sourceUrl,
      limit,
      fallback: fallbackMode,
      durationMs: Date.now() - startedAt,
      error: "No extraction result available"
    });
    res.status(502).json({
      error: "No extraction result available",
      meta: { warnings }
    });
    return;
  }

  logApiQuery("extract.complete", {
    url: sourceUrl,
    limit,
    fallback: fallbackMode,
    method: selected.method,
    items: selected.items.length,
    durationMs: Date.now() - startedAt
  });
  const body = {
    sourceUrl,
    title: selected.title,
    // An image with no link of its own links back to its page (as the original Java
    // ImageLoader did). Done last, so the linked/unlinked filters above still apply.
    items: selected.items.slice(0, limit).map((item) => (item.linkUrl ? item : { ...item, linkUrl: sourceUrl })),
    meta: {
      method: selected.method,
      warnings
    }
  };
  if (cacheKey && body.items.length > 0) {
    writeCachedExtract(cacheKey, body);
  }
  res.json(body);
}));

app.get("/api/search/images", async (req, res) => {
  if (killSwitch.isEngaged()) {
    res.status(503).json({ error: "disabled" });
    return;
  }
  const query = normalizeSearchQuery(req.query.q || req.query.query);
  if (!query) {
    res.status(400).json({ error: "Missing image search query" });
    return;
  }
  if (isMuseumSafeTextBlocked(query)) {
    res.status(400).json({ error: "This request is not available in museum-safe mode" });
    return;
  }

  const limit = clampNumber(req.query.limit, 1, DEFAULT_LIMIT, DEFAULT_LIMIT);
  const startedAt = Date.now();

  // Cache first, budget second: a repeat query costs the provider nothing, so
  // it must not consume the day's quota either.
  const cacheKey = buildSearchCacheKey(getImageSearchProvider(), query, limit);
  const cachedSelection = getCachedSearchResult(cacheKey);
  if (cachedSelection) {
    logApiQuery("imageSearch.cached", {
      query,
      provider: cachedSelection.provider,
      limit,
      items: cachedSelection.items.length,
      durationMs: Date.now() - startedAt
    });
    res.json(buildImageSearchResponse(query, cachedSelection, limit));
    return;
  }
  if (await inFlightSearches.follow(cacheKey, res)) {
    return;
  }

  const reservation = spendGuard.reserve("search", { key: getSpendClientKey(req), amount: 1 });
  if (!reservation.ok) {
    logApiQuery("imageSearch.budget", {
      query,
      provider: getImageSearchProvider(),
      limit,
      scope: reservation.reason,
      durationMs: Date.now() - startedAt
    });
    res.status(429).json({ error: "budget", scope: reservation.reason });
    return;
  }
  inFlightSearches.lead(cacheKey, res);

  const providerBilling = { billed: false };
  try {
    const selected = await providerBillingContext.run(providerBilling, () => searchImages(query, limit));
    storeSearchResult(cacheKey, selected);
    logApiQuery("imageSearch.complete", {
      query,
      provider: selected.provider,
      limit,
      items: selected.items.length,
      durationMs: Date.now() - startedAt
    });
    res.json(buildImageSearchResponse(query, selected, limit));
  } catch (err) {
    // Refund only if the provider never sent a usable response. Once it has
    // (providerBilling.billed), or the failure is an abort/timeout with an unknown
    // outcome, the query may already be billed; releasing on any error would let a
    // flaky decode or slow response double as a free requery.
    if (!providerBilling.billed && err?.name !== "AbortError") {
      spendGuard.release(reservation);
    }
    if (sendPolicyError(res, err)) {
      return;
    }
    const status = err instanceof ProviderConfigError ? 501 : 502;
    logApiQuery("imageSearch.failed", {
      query,
      provider: getImageSearchProvider(),
      limit,
      status,
      durationMs: Date.now() - startedAt,
      error: err.message
    });
    res.status(status).json({ error: `Image search failed: ${err.message}` });
  }
});

app.post("/api/genai/source/import", holdSlotUntilSettled(async (req, res) => {
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
}));

app.post("/api/genai", async (req, res) => {
  const routeStartedAt = Date.now();
  if (killSwitch.isEngaged()) {
    res.status(503).json({ error: "disabled" });
    return;
  }
  const wantsAsync = req.body?.async === true || req.query.async === "1";
  const clientKey = getGenAiClientKey(req);
  if (wantsAsync) {
    cancelActiveGenAiProgressJobs(clientKey);
  }
  const requestedPrompt = normalizeGenAiPrompt(req.body?.prompt);
  const requestedCacheKey = normalizeGenAiCacheKey(req.body?.cacheKey);
  const replay = getCachedGenAiResult(requestedCacheKey);
  if (
    replay
    && (!requestedPrompt || replay.prompt === requestedPrompt)
    && !isMuseumSafeTextBlocked(replay.prompt)
  ) {
    logApiQuery("genai.cached", {
      ...genAiQueryLogDetails({
        provider: replay.provider,
        prompt: replay.prompt,
        count: replay.items.length
      }),
      async: wantsAsync,
      durationMs: Date.now() - routeStartedAt
    });
    if (wantsAsync) {
      const job = createCompletedGenAiProgressJob({
        prompt: replay.prompt,
        selected: replay,
        cacheKey: requestedCacheKey,
        cached: true
      });
      res.status(202).json(buildGenAiProgressJobResponse(job));
      return;
    }
    res.json(buildGenAiResponse({
      prompt: replay.prompt,
      count: replay.items.length,
      selected: replay,
      cacheKey: requestedCacheKey,
      cached: true
    }));
    return;
  }

  const source = normalizeGenAiSource(req.body?.source);
  const sourceRecord = source?.id ? getStoredGenAiImage(source.id) : null;
  if (source?.id && !sourceRecord) {
    res.status(410).json({ error: "Generated image source expired or not found" });
    return;
  }

  const prompt = requestedPrompt || sourceRecord?.genai?.prompt || "";
  if (!prompt) {
    res.status(400).json({ error: "Missing GenAI prompt" });
    return;
  }
  if (isMuseumSafeTextBlocked(prompt)) {
    res.status(400).json({ error: "This request is not available in museum-safe mode" });
    return;
  }

  const negativePrompt = normalizeGenAiPrompt(req.body?.negativePrompt);
  const count = clampNumber(req.body?.count, 1, DEFAULT_LIMIT, getIntegerSetting("GENAI_COUNT"));
  const provider = getGenAiProvider();
  const requestLogDetails = genAiQueryLogDetails({
    provider,
    prompt,
    count,
    sourceRecord
  });
  let seed = null;
  try {
    seed = normalizeGenAiSeed(req.body?.seed);
  } catch (err) {
    sendPolicyError(res, err, "Invalid GenAI seed");
    return;
  }
  const seededCacheKey = seed === null
    ? ""
    : buildSeededGenAiCacheKey({
      provider: getGenAiProvider(),
      prompt,
      negativePrompt,
      count,
      sourceRecord,
      seed
    });
  const seededReplay = getCachedGenAiResult(seededCacheKey);
  if (seededReplay) {
    logApiQuery("genai.cached", {
      ...requestLogDetails,
      async: wantsAsync,
      durationMs: Date.now() - routeStartedAt
    });
    if (wantsAsync) {
      const job = createCompletedGenAiProgressJob({
        prompt,
        selected: seededReplay,
        cacheKey: seededCacheKey,
        cached: true
      });
      res.status(202).json(buildGenAiProgressJobResponse(job));
      return;
    }
    res.json(buildGenAiResponse({
      prompt,
      count,
      selected: seededReplay,
      cacheKey: seededCacheKey,
      cached: true
    }));
    return;
  }

  // Draw before you pay. The pool is consulted after the museum-safe check and
  // before the reservation, so a warm batch reserves (and can be refused for) only
  // the images it will buy. Both cache replays above return earlier and stay free.
  // The batch seed is minted here because the planner must choose each slot's
  // modifier with the seed the generator will then use.
  const batchSeed = seed ?? createGenAiSeed();
  const poolBatch = planGenAiPoolBatch({ prompt, negativePrompt, count, sourceRecord, batchSeed });
  const billableCount = poolBatch ? poolBatch.freshCount : count;
  Object.assign(requestLogDetails, genAiPoolLogDetails(poolBatch));

  const promptCacheKey = buildGenAiPromptCacheKey({ prompt, negativePrompt, count, sourceRecord, seed, poolBatch });
  const promptReplay = await restoreGenAiPromptBatch(promptCacheKey, prompt);
  if (promptReplay) {
    const cacheKey = storeGenAiResultCache(createGenAiResultCacheKey(), { prompt, selected: promptReplay });
    logApiQuery("genai.cached", {
      ...requestLogDetails,
      async: wantsAsync,
      promptCache: true,
      durationMs: Date.now() - routeStartedAt
    });
    if (wantsAsync) {
      const job = createCompletedGenAiProgressJob({ prompt, selected: promptReplay, cacheKey, cached: true });
      res.status(202).json(buildGenAiProgressJobResponse(job));
      return;
    }
    res.json(buildGenAiResponse({ prompt, count, selected: promptReplay, cacheKey, cached: true }));
    return;
  }

  // Reserve the whole billable batch before the provider is touched (one call can
  // be 15 images); released below for whatever is not delivered.
  const spendReservation = spendGuard.reserve("genai", {
    key: getSpendClientKey(req),
    amount: billableCount
  });
  if (!spendReservation.ok) {
    logApiQuery("genai.budget", {
      ...requestLogDetails,
      async: wantsAsync,
      scope: spendReservation.reason,
      durationMs: Date.now() - routeStartedAt
    });
    res.status(429).json({ error: "budget", scope: spendReservation.reason });
    return;
  }

  if (wantsAsync) {
    const job = createGenAiProgressJob({
      clientKey,
      prompt,
      count,
      provider,
      initialItems: sourceRecord ? buildGenAiLineageItems(sourceRecord) : []
    });
    logApiQuery("genai.accepted", {
      ...requestLogDetails,
      async: true,
      jobId: job.id,
      durationMs: Date.now() - routeStartedAt
    });
    startGenAiProgressJob(job, {
      prompt,
      negativePrompt,
      count,
      sourceRecord,
      seed,
      seededCacheKey,
      promptCacheKey,
      spendReservation,
      batchSeed,
      poolBatch,
      billableCount
    });
    res.status(202).json(buildGenAiProgressJobResponse(job));
    return;
  }

  const providerBilling = { billed: false };
  // Where a failure would have to resume from, and how much of it was paid for.
  // A pooled batch is generated slot by slot (the pool decides per slot), so on
  // a provider failure these say which slots never arrived.
  const progress = { slots: 0, generated: 0, items: [] };
  try {
    const selected = await providerBillingContext.run(providerBilling, () => enqueueGenAiBatch(clientKey, poolBatch, () => (
      poolBatch
        ? generateImagesProgressive({
          prompt,
          negativePrompt,
          count,
          sourceRecord,
          seed,
          batchSeed,
          poolSlots: poolBatch.slots,
          onItems: (items, index) => {
            progress.slots = index + 1;
            progress.items.push(...items);
            if (!poolBatch.slots[index]?.pooled) {
              progress.generated += items.length;
            }
          }
        })
        : generateImages({
          prompt,
          negativePrompt,
          count,
          sourceRecord,
          seed
        })
    )));
    // Providers may return fewer images than asked for; only charge for what
    // arrived.
    spendGuard.release(spendReservation, Math.max(0, billableCount - (poolBatch ? progress.generated : selected.items.length)));
    const cacheKey = storeGenAiResultCache(seededCacheKey || createGenAiResultCacheKey(), {
      prompt,
      selected
    });
    rememberGenAiPromptBatch(promptCacheKey, selected, count);
    logApiQuery("genai.complete", {
      ...requestLogDetails,
      provider: selected.provider,
      async: false,
      items: selected.items.length,
      cached: false,
      durationMs: Date.now() - routeStartedAt
    });
    res.json(buildGenAiResponse({
      prompt,
      count,
      selected,
      cacheKey,
      cached: false
    }));
  } catch (err) {
    // Refund the whole batch only if the provider never sent a usable response.
    // Once it has (providerBilling.billed), or the failure is an abort/timeout with
    // an unknown outcome, the images may be billed, and a response can be billed
    // yet still fail on our side (bad body, decode, normalize).
    if (!providerBilling.billed && err?.name !== "AbortError") {
      spendGuard.release(spendReservation);
    }
    // The provider is down, busy, or refused; the pack is not. Fill the slots that
    // never arrived from the pool so an outage degrades to fully-cached, not gaps.
    // A user cancel is excluded: the client cancels on every new prompt.
    if (poolBatch && !(err instanceof GenAiAbortError)) {
      const filled = completeGenAiBatchFromPool({
        poolBatch,
        fromIndex: progress.slots,
        delivered: progress.generated,
        prompt,
        sourceRecord
      });
      // Anything at all beats a 502 here: the pool already put images in this
      // batch, and the sphere lays out the panels it is given.
      if (filled.length + progress.items.length > 0) {
        const selected = {
          provider,
          warnings: [],
          items: [
            ...(sourceRecord ? buildGenAiLineageItems(sourceRecord) : []),
            ...progress.items,
            ...filled
          ]
        };
        logApiQuery("genai.pooled", {
          ...requestLogDetails,
          async: false,
          items: selected.items.length,
          filled: filled.length,
          durationMs: Date.now() - routeStartedAt,
          error: err.message
        });
        res.json(buildGenAiResponse({
          prompt,
          count,
          selected,
          cacheKey: storeGenAiResultCache(seededCacheKey || createGenAiResultCacheKey(), { prompt, selected }),
          cached: false
        }));
        return;
      }
    }
    if (sendPolicyError(res, err)) {
      return;
    }
    const status = err instanceof ProviderConfigError
      ? 501
      : err instanceof GenAiBusyError
        ? 503
        : err instanceof GenAiAbortError
          ? 409
          : err instanceof GenAiSourceTooLargeError
            ? 413
          : 502;
    logApiQuery("genai.failed", {
      ...requestLogDetails,
      async: false,
      status,
      durationMs: Date.now() - routeStartedAt,
      error: err.message
    });
    res.status(status).json({ error: `GenAI failed: ${err.message}` });
  }
});

// Mounted last, after every /api route, so it can never shadow the API.
if (SERVE_STATIC_DIR) {
  mountStaticClient(SERVE_STATIC_DIR);
}

// Express's own last handler prints the stack (absolute install paths) unless
// NODE_ENV=production; malformed JSON to any route reached it.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = Number(err?.status || err?.statusCode);
  const code = status >= 400 && status < 600 ? status : 500;
  if (code >= 500) {
    console.error(err);
  }
  res.status(code).json({ error: code < 500 ? "Bad request" : "Internal error" });
});

app.listen(...(BIND_HOST ? [PORT, BIND_HOST] : [PORT]), () => {
  ensureStateDirectories();
  pruneGeneratedImageFiles(Date.now(), { includeSession: true });
  console.log(`Surface Browser MVP API listening on http://${BIND_HOST || "localhost"}:${PORT}`);
  console.log(formatStartupSettingsSummary());
  logGenAiPoolStartup();
});

process.once("exit", () => liveMonitor.flush());

// Only when caps are configured: an inert guard writes no state file.
if (spendGuard.active) {
  process.once("exit", () => spendGuard.shutdown());
}
// Route signals through exit(): a default signal death skips the exit hooks,
// which bank the spend guard's day line and kill the shared Chromium (Playwright's
// own hook).
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => process.exit(0));
}
// A stray rejection from detached work (a GenAI job, a cache write) would kill
// the process anyway; exiting here runs those same hooks first. systemd restarts.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.once(event, (err) => {
    console.error(`[fatal] ${event}:`, err);
    process.exit(1);
  });
}

// Serve a built client from this process. Two cache policies: Vite's asset
// filenames carry a content hash so they are immutable for a year, while
// index.html names those hashes and must never be cached, or a deployed fix
// fails to reach a headset.
function mountStaticClient(distDir) {
  app.use(express.static(distDir, {
    index: false,
    maxAge: "1y",
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("cache-control", "no-cache");
      }
    }
  }));

  // SPA fallback. Express 5 removed the "*" / "/*" string wildcards, so this
  // has to be a RegExp; the negative lookahead keeps /api/* on its own 404s
  // instead of answering an API call with the HTML shell.
  app.get(/^\/(?!api\/).*$/, (req, res, next) => {
    res.setHeader("cache-control", "no-cache");
    res.sendFile(path.join(distDir, "index.html"), (err) => {
      if (err) {
        next(err);
      }
    });
  });
}

// What commit is running.
//
// Read from the git plumbing files rather than by running git: a deployment may
// leave the checkout root-owned while the service runs as another user, and git
// refuses to operate on a repo it does not own ("dubious ownership"). Plain
// reads work if the checkout is world-readable.
//
// Two commits, not one: `commit` is the checkout, re-read with a short cache, and
// `running` is what this process booted at. A client-only deploy rebuilds dist/
// without restarting Node, so they differ afterwards; that difference says the
// served client is newer than the running server.
//
// Best effort: a tarball deploy with no .git reports null rather than refusing
// to start.
function readGitBuild() {
  try {
    const gitDir = path.join(REPO_ROOT, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) {
      // Detached HEAD is possible after a deploy.
      return { commit: head.slice(0, 7), branch: null };
    }
    const ref = head.slice(4).trim();
    const branch = ref.replace(/^refs\/heads\//, "");
    const looseRef = path.join(gitDir, ref);
    if (fs.existsSync(looseRef)) {
      return { commit: fs.readFileSync(looseRef, "utf8").trim().slice(0, 7), branch };
    }
    // A fresh clone packs its refs, so the loose file is often absent.
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha) {
        return { commit: sha.slice(0, 7), branch };
      }
    }
    return { commit: null, branch };
  } catch {
    return { commit: null, branch: null };
  }
}

// Every writable path is env-overridable so state can live outside the checkout.
// Created once at boot so a misconfigured path is a startup warning, not a later 500.
function ensureStateDirectories() {
  const targets = [
    // Only when something will actually be written there.
    ...(getGenAiSaveImagesToDisk() ? [getGeneratedImagesDirDisplayPath()] : []),
    path.dirname(getApiQueryLogFilePath()),
    path.dirname(resolveSpendLogPath()),
    path.dirname(resolveFilePath(SPEND_STATE_PATH)),
    path.dirname(resolveFilePath(SETTINGS_FILE_PATH)),
    path.dirname(getXrDiagLogFilePath())
  ];
  for (const dir of new Set(targets)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`Could not prepare directory ${dir}: ${err.message}`);
    }
  }
}

class RequestPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequestPolicyError";
  }
}

class ProviderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

class GenAiBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GenAiBusyError";
  }
}

class GenAiAbortError extends Error {
  constructor(message) {
    super(message);
    this.name = "GenAiAbortError";
  }
}

// Raised when a vary source image is too large to inline into the hosted
// (fal) img2img request. Surfaces as a 413-style GenAI error.
class GenAiSourceTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "GenAiSourceTooLargeError";
  }
}

function sendPolicyError(res, err, fallbackMessage = null) {
  if (err instanceof RequestPolicyError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (fallbackMessage && err) {
    res.status(400).json({ error: fallbackMessage });
    return true;
  }
  return false;
}

function getGenAiClientKey(req) {
  return String(req.get("x-genai-client-id") || req.ip || req.socket.remoteAddress || "unknown");
}

function enqueueGenAiJob(clientKey, run) {
  abortPendingGenAiJobs(clientKey);

  // A job queued behind an active one runs later, off that other job's
  // continuation (see startNextGenAiJob), so plain AsyncLocalStorage propagation
  // would hand readJsonResponse() the wrong request's providerBilling. Bind so
  // `run` re-enters the context live when the job was enqueued.
  const boundRun = AsyncResource.bind(run);

  return new Promise((resolve, reject) => {
    const job = {
      clientKey,
      run: boundRun,
      resolve,
      reject,
      aborted: false
    };

    if (!isGenAiQueueFull()) {
      startGenAiJob(job);
      return;
    }

    if (genAiQueue.pending.length >= GENAI_QUEUE_MAX_PENDING) {
      reject(new GenAiBusyError("Generator busy"));
      return;
    }

    genAiQueue.pending.push(job);
  });
}

// A batch the pool fills entirely buys nothing, so it never waits behind a
// paid one.
function enqueueGenAiBatch(clientKey, poolBatch, run) {
  if (poolBatch?.freshCount === 0) {
    abortPendingGenAiJobs(clientKey);
    return Promise.resolve().then(run);
  }
  return enqueueGenAiJob(clientKey, run);
}

function abortPendingGenAiJobs(clientKey) {
  if (!clientKey || genAiQueue.pending.length === 0) {
    return;
  }

  const pending = [];
  for (const job of genAiQueue.pending) {
    if (job.clientKey === clientKey) {
      job.aborted = true;
      job.reject(new GenAiAbortError("GenAI request superseded"));
    } else {
      pending.push(job);
    }
  }
  genAiQueue.pending = pending;
}

// fal runs requests in parallel and bills per image, so only the daily caps
// bound it; a local GPU (Draw Things, A1111) or an unknown endpoint gets one.
function getGenAiParallelJobs() {
  const fallback = getGenAiProvider() === "fal" ? 3 : 1;
  return parsePositiveInteger(process.env.GENAI_PARALLEL_JOBS, fallback);
}

function isGenAiQueueFull() {
  return genAiQueue.active.size >= getGenAiParallelJobs();
}

function startGenAiJob(job) {
  genAiQueue.active.add(job);
  Promise.resolve()
    .then(() => {
      if (job.aborted) {
        throw new GenAiAbortError("GenAI request superseded");
      }
      return job.run();
    })
    .then(job.resolve, job.reject)
    .finally(() => {
      genAiQueue.active.delete(job);
      startNextGenAiJob();
    });
}

function startNextGenAiJob() {
  while (!isGenAiQueueFull() && genAiQueue.pending.length > 0) {
    const next = genAiQueue.pending.shift();
    if (next.aborted) {
      continue;
    }
    startGenAiJob(next);
    break;
  }
}

function createGenAiProgressJob({
  clientKey = "unknown",
  prompt,
  count,
  provider,
  expected = null,
  initialItems = []
}) {
  pruneGenAiProgressJobs();
  const now = Date.now();
  const job = {
    id: `gj_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    clientKey,
    prompt,
    count,
    expected: expected ?? (initialItems.length + count),
    provider,
    warnings: [],
    items: cloneGenAiItems(initialItems),
    status: "queued",
    cacheKey: null,
    cached: false,
    error: null,
    cancelled: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + getGenAiResultCacheTtlMs()
  };
  genAiProgressJobs.set(job.id, job);
  enforceGenAiProgressJobsCap();
  return job;
}

// TTL pruning alone is not a bound: every poll extends a job's own TTL, so a
// polling client keeps entries alive and could inflate the map for free. Past
// GENAI_PROGRESS_JOBS_MAX, evict oldest-first in order of what is cheapest to
// lose: cached replays (free to make, so the way to flood the map), then other
// finished jobs, and a live one only if nothing else is left. Oldest-first alone
// let a stream of free replays expire other visitors' running jobs. An evicted
// poll 410s, which the client treats as "expired".
const GENAI_JOB_EVICTION_TIERS = [
  (job) => job.cached && job.status === "complete",
  (job) => job.status === "complete" || job.status === "failed" || job.status === "cancelled",
  () => true
];

function enforceGenAiProgressJobsCap() {
  if (!GENAI_PROGRESS_JOBS_MAX) {
    return;
  }
  for (const evictable of GENAI_JOB_EVICTION_TIERS) {
    for (const [id, job] of genAiProgressJobs) {
      if (genAiProgressJobs.size <= GENAI_PROGRESS_JOBS_MAX) {
        return;
      }
      if (evictable(job)) {
        genAiProgressJobs.delete(id);
      }
    }
  }
}

function createCompletedGenAiProgressJob({ prompt, selected, cacheKey, cached }) {
  const job = createGenAiProgressJob({
    prompt,
    count: selected.items?.length || 0,
    provider: selected.provider,
    expected: selected.items?.length || 0,
    initialItems: selected.items || []
  });
  job.status = "complete";
  job.warnings = [...(selected.warnings || [])];
  job.cacheKey = cacheKey || null;
  job.cached = Boolean(cached);
  job.updatedAt = Date.now();
  return job;
}

function getGenAiProgressJob(id) {
  pruneGenAiProgressJobs();
  const job = genAiProgressJobs.get(String(id || ""));
  if (!job) {
    return null;
  }
  job.expiresAt = Date.now() + getGenAiResultCacheTtlMs();
  return job;
}

function pruneGenAiProgressJobs(now = Date.now()) {
  for (const [jobId, job] of genAiProgressJobs) {
    if (now >= job.expiresAt) {
      genAiProgressJobs.delete(jobId);
    }
  }
}

function touchGenAiProgressJob(job) {
  const now = Date.now();
  job.updatedAt = now;
  job.expiresAt = now + getGenAiResultCacheTtlMs();
}

function appendGenAiProgressItems(job, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const knownIds = new Set(job.items.map((item) => item.genai?.id).filter(Boolean));
  for (const item of cloneGenAiItems(items)) {
    const id = item.genai?.id;
    if (id && knownIds.has(id)) {
      continue;
    }
    if (id) {
      knownIds.add(id);
    }
    job.items.push(item);
  }
  touchGenAiProgressJob(job);
}

function cancelGenAiProgressJob(job) {
  if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
    return;
  }
  job.cancelled = true;
  job.status = "cancelled";
  job.error = "GenAI job cancelled";
  touchGenAiProgressJob(job);
  logApiQuery("genai.cancelled", {
    ...genAiQueryLogDetails({
      provider: job.provider,
      prompt: job.prompt,
      count: job.count
    }),
    async: true,
    jobId: job.id,
    durationMs: Date.now() - job.createdAt
  });
}

function cancelActiveGenAiProgressJobs(clientKey) {
  if (!clientKey) {
    return;
  }
  for (const job of genAiProgressJobs.values()) {
    if (job.clientKey === clientKey) {
      cancelGenAiProgressJob(job);
    }
  }
}

function startGenAiProgressJob(job, params) {
  // What this job has generated, which is not what it has delivered: a pooled slot
  // arrives as an item but was never bought, so counting job.items would charge
  // for the pack.
  const progress = { slots: 0, generated: 0 };
  // Lineage items are seeded before generation starts, so an empty batch is this
  // baseline, not zero.
  const initialItemCount = job.items.length;
  // Same billed-failure trap as the search/sync-genai routes (see
  // providerBillingContext), except this job generates one image per provider
  // round-trip (count:1), so at most one image can be billed-but-undelivered: the
  // call in flight. onItems resets `billed` once an image is appended to
  // job.items, since from then the billed work is the delivered count; only a
  // failure on the next call should suppress a refund.
  const providerBilling = { billed: false };
  const releaseUndelivered = (extraBilled = 0) => {
    spendGuard.release(
      params.spendReservation,
      Math.max(0, params.billableCount - progress.generated - extraBilled)
    );
  };
  // A job that will wait in the queue shows its pooled images now rather than an
  // empty tunnel. They go first and stay first: the client reads items by index.
  if (params.poolBatch?.freshCount > 0 && isGenAiQueueFull()) {
    for (const slot of params.poolBatch.slots) {
      if (slot.pooled) {
        slot.preDelivered = storePooledGenAiItem(slot, { prompt: params.prompt, sourceRecord: params.sourceRecord });
        appendGenAiProgressItems(job, [slot.preDelivered]);
      }
    }
  }
  providerBillingContext.run(providerBilling, () => enqueueGenAiBatch(job.clientKey, params.poolBatch, async () => {
    if (job.cancelled) {
      throw new GenAiAbortError("GenAI job cancelled");
    }
    const startedAt = Date.now();
    job.status = "running";
    touchGenAiProgressJob(job);
    logApiQuery("genai.started", {
      ...genAiQueryLogDetails({
        provider: job.provider,
        prompt: params.prompt,
        count: params.count,
        sourceRecord: params.sourceRecord
      }),
      async: true,
      jobId: job.id
    });
    const selected = await generateImagesProgressive({
      ...params,
      poolSlots: params.poolBatch?.slots || null,
      shouldCancel: () => job.cancelled,
      onItems: (items, index) => {
        appendGenAiProgressItems(job, items);
        progress.slots = index + 1;
        if (!params.poolBatch?.slots[index]?.pooled) {
          progress.generated += items.length;
        }
        providerBilling.billed = false;
      }
    });
    if (job.cancelled) {
      throw new GenAiAbortError("GenAI job cancelled");
    }
    job.provider = selected.provider;
    job.warnings = [...(selected.warnings || [])];
    job.items = cloneGenAiItems(selected.items);
    job.cacheKey = storeGenAiResultCache(params.seededCacheKey || createGenAiResultCacheKey(), {
      prompt: params.prompt,
      selected
    });
    rememberGenAiPromptBatch(params.promptCacheKey, selected, params.count);
    job.cached = false;
    job.status = "complete";
    releaseUndelivered();
    touchGenAiProgressJob(job);
    logApiQuery("genai.complete", {
      ...genAiQueryLogDetails({
        provider: selected.provider,
        prompt: params.prompt,
        count: params.count,
        sourceRecord: params.sourceRecord
      }),
      ...genAiPoolLogDetails(params.poolBatch),
      async: true,
      jobId: job.id,
      items: selected.items.length,
      cached: false,
      durationMs: Date.now() - startedAt,
      totalDurationMs: Date.now() - job.createdAt
    });
    return selected;
  })).catch((err) => {
    if (job.cancelled || err instanceof GenAiAbortError) {
      job.cancelled = true;
      job.status = "cancelled";
    } else {
      job.status = "failed";
    }
    // Fill the slots the provider never delivered from the pool, so an outage ends
    // as a fully-cached sphere rather than a failed job. Not for a cancel: the
    // client cancels on every new prompt.
    const poolFilled = params.poolBatch && job.status === "failed"
      ? completeGenAiBatchFromPool({
        poolBatch: params.poolBatch,
        fromIndex: progress.slots,
        delivered: progress.generated,
        prompt: params.prompt,
        sourceRecord: params.sourceRecord
      })
      : [];
    if (poolFilled.length) {
      appendGenAiProgressItems(job, poolFilled);
    }
    // A batch with images in it is a batch, however it was assembled.
    const recovered = Boolean(params.poolBatch) && job.status === "failed" && job.items.length > initialItemCount;
    if (recovered) {
      job.status = "complete";
      job.expected = job.items.length;
      job.cacheKey = storeGenAiResultCache(params.seededCacheKey || createGenAiResultCacheKey(), {
        prompt: params.prompt,
        selected: { provider: job.provider, warnings: [], items: job.items }
      });
      job.cached = false;
    }
    // Give back only the images that never arrived and were never billed. A cancel
    // at image 3 of 4 still spent 3, so crediting the full batch would make the cap
    // avoidable. If the in-flight call already got a 2xx (providerBilling.billed),
    // that image is billed too even though it never reached job.items.
    //
    // An abort counts as billed, as on the sync route: the outcome is unknown, and
    // the body read has its own deadline, so an AbortError can fire after the
    // provider returned 2xx. A user cancel raises GenAiAbortError instead, not
    // AbortError, and must not be charged.
    const abortedMidFlight = err?.name === "AbortError";
    releaseUndelivered(providerBilling.billed || abortedMidFlight ? 1 : 0);
    const message = err instanceof Error ? err.message : String(err);
    // A pool-filled job completed; `error` would surface an outage the visitor
    // was deliberately shielded from. The query log still carries it.
    job.error = recovered ? null : message;
    touchGenAiProgressJob(job);
    logApiQuery(recovered ? "genai.pooled" : "genai.failed", {
      ...genAiQueryLogDetails({
        provider: job.provider,
        prompt: params.prompt,
        count: params.count,
        sourceRecord: params.sourceRecord
      }),
      ...genAiPoolLogDetails(params.poolBatch),
      async: true,
      jobId: job.id,
      status: job.status,
      filled: poolFilled.length,
      durationMs: Date.now() - job.createdAt,
      error: message
    });
  });
}

function buildGenAiProgressJobResponse(job) {
  const received = job.items.length;
  const expected = Math.max(Number(job.expected || 0), received);
  const done = job.status === "complete" && received >= expected;
  return {
    ok: job.status !== "failed" && job.status !== "cancelled",
    jobId: job.id,
    status: job.status,
    count: job.count,
    received,
    expected,
    done,
    sourceUrl: `genai:${job.prompt}`,
    title: `GenAI: ${job.prompt}`,
    items: cloneGenAiItems(job.items),
    error: job.error,
    meta: {
      method: `genai_${job.provider}`,
      warnings: [...(job.warnings || [])],
      genaiCacheKey: job.cacheKey || null,
      cached: Boolean(job.cached),
      complete: done
    }
  };
}

function buildGenAiResponse({ prompt, selected, cacheKey, cached }) {
  return {
    sourceUrl: `genai:${prompt}`,
    title: `GenAI: ${prompt}`,
    items: cloneGenAiItems(selected.items),
    meta: {
      method: `genai_${selected.provider}`,
      warnings: [...(selected.warnings || [])],
      genaiCacheKey: cacheKey || null,
      cached: Boolean(cached)
    }
  };
}

function normalizeGenAiCacheKey(raw) {
  const value = String(raw || "").trim();
  if (!/^(gr|gd)_[a-zA-Z0-9_-]{8,160}$/.test(value)) {
    return "";
  }
  return value;
}

function createGenAiResultCacheKey() {
  return `gr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function buildSeededGenAiCacheKey({ provider, prompt, negativePrompt, count, sourceRecord, seed }) {
  const payload = {
    provider,
    prompt,
    negativePrompt,
    count,
    seed,
    sourceId: sourceRecord?.id || null,
    width: sourceRecord?.width || getIntegerSetting("GENAI_WIDTH"),
    height: sourceRecord?.height || getIntegerSetting("GENAI_HEIGHT"),
    steps: getOptionalIntegerSetting("GENAI_STEPS"),
    cfgScale: getOptionalNumberSetting("GENAI_CFG_SCALE"),
    drawThingsGuidanceEmbed: provider === "drawthings" ? getOptionalNumberSetting("GENAI_DRAWTHINGS_GUIDANCE_EMBED") : null,
    museumSafe: getBooleanSetting("GENAI_MUSEUM_SAFE"),
    variationStrengthMin: sourceRecord ? getNumberSetting("GENAI_VARIATION_STRENGTH_MIN") : null,
    variationStrengthMax: sourceRecord ? getNumberSetting("GENAI_VARIATION_STRENGTH_MAX") : null,
    varySeedMode: sourceRecord ? getGenAiVarySeedMode() : null,
    varyModifiers: sourceRecord ? getStringSetting("GENAI_VARY_MODIFIERS") : null,
    varyModifierMode: sourceRecord ? getGenAiVaryModifierMode() : null,
    varyModifierStyle: sourceRecord ? getGenAiVaryModifierStyle() : null,
    varyModifierPayload: sourceRecord ? getGenAiVaryModifierPayload() : null
  };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("base64url").slice(0, 32);
  return `gd_${digest}`;
}

// The day-long prompt cache covers plain text prompts only. A variation is
// meant to differ each time, a seeded request has its own replay above, and a
// prompt the pool serves or is still growing is better left to the pool, which
// mixes its draw and keeps buying one or two fresh images.
function buildGenAiPromptCacheKey({ prompt, negativePrompt, count, sourceRecord, seed, poolBatch }) {
  if (!genAiPromptCache.enabled || sourceRecord || seed !== null) {
    return "";
  }
  if (poolBatch?.slots.some((slot) => slot.pooled || slot.grow)) {
    return "";
  }
  return buildSeededGenAiCacheKey({
    provider: getGenAiProvider(),
    prompt,
    negativePrompt,
    count,
    sourceRecord: null,
    seed: "prompt-cache"
  });
}

async function restoreGenAiPromptBatch(key, prompt) {
  const batch = key ? await genAiPromptCache.get(key) : null;
  if (!batch) {
    return null;
  }
  return {
    provider: batch.provider || getGenAiProvider(),
    warnings: [],
    items: batch.images.map((image) => storeGenAiImageSource({
      source: { buffer: image.buffer, contentType: image.contentType },
      context: {
        prompt,
        seed: image.seed ?? null,
        strength: null,
        parentId: null,
        provider: batch.provider || getGenAiProvider(),
        width: image.width,
        height: image.height,
        origin: "prompt-cache",
        saveToDisk: false
      }
    }))
  };
}

// Only a full batch the provider did not flag is worth serving to the next
// visitor; a short or flagged one is generated again.
function rememberGenAiPromptBatch(key, selected, count) {
  if (!key || selected.items.length !== count) {
    return;
  }
  const records = selected.items.map((item) => genAiImageStore.get(item.genai?.id));
  if (records.some((record) => !record || record.providerFlagged || record.origin)) {
    return;
  }
  void genAiPromptCache.set(key, {
    provider: selected.provider,
    images: records.map((record) => ({
      buffer: record.buffer,
      contentType: record.contentType,
      seed: record.genai?.seed ?? null,
      width: record.width,
      height: record.height
    }))
  });
}

function getCachedGenAiResult(cacheKey) {
  if (!cacheKey) {
    return null;
  }

  const now = Date.now();
  pruneGenAiResultCache(now);
  const entry = genAiResultCache.get(cacheKey);
  if (!entry || now >= entry.expiresAt || !canServeCachedGenAiItems(entry.items)) {
    genAiResultCache.delete(cacheKey);
    return null;
  }

  genAiResultCache.delete(cacheKey);
  genAiResultCache.set(cacheKey, entry);
  return {
    provider: entry.provider,
    warnings: [...entry.warnings],
    prompt: entry.prompt,
    items: cloneGenAiItems(entry.items)
  };
}

function storeGenAiResultCache(cacheKey, { prompt, selected }) {
  if (!cacheKey) {
    return null;
  }

  const now = Date.now();
  genAiResultCache.set(cacheKey, {
    provider: selected.provider,
    warnings: [...(selected.warnings || [])],
    prompt,
    items: cloneGenAiItems(selected.items),
    createdAt: now,
    expiresAt: now + getGenAiResultCacheTtlMs()
  });
  pruneGenAiResultCache(now);
  return cacheKey;
}

function canServeCachedGenAiItems(items) {
  return items.every((item) => item.genai?.id && getStoredGenAiImage(item.genai.id));
}

function pruneGenAiResultCache(now = Date.now()) {
  for (const [cacheKey, entry] of genAiResultCache) {
    if (now >= entry.expiresAt || !canServeCachedGenAiItems(entry.items)) {
      genAiResultCache.delete(cacheKey);
    }
  }
  while (genAiResultCache.size > getGenAiResultCacheMax()) {
    const oldestKey = genAiResultCache.keys().next().value;
    genAiResultCache.delete(oldestKey);
  }
}

function cloneGenAiItems(items) {
  return (items || []).map((item) => ({
    ...item,
    genai: item.genai
      ? {
        ...item.genai,
        modifier: item.genai.modifier
          ? {
            ...item.genai.modifier,
            stack: Array.isArray(item.genai.modifier.stack) ? [...item.genai.modifier.stack] : undefined
          }
          : undefined
      }
      : null
  }));
}

function buildGenAiItemFromStoredRecord(record) {
  return {
    imageUrl: `/api/genai/image/${record.id}`,
    linkUrl: null,
    width: record.width || null,
    height: record.height || null,
    genai: record.genai ? { ...record.genai } : null
  };
}

function buildGenAiLineageItems(record) {
  const lineage = [];
  const seen = new Set();
  let current = record;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    lineage.push(current);
    const parentId = current.genai?.parentId;
    current = parentId ? getStoredGenAiImage(parentId) : null;
  }

  return lineage.reverse().map(buildGenAiItemFromStoredRecord);
}

function normalizeGenAiSeed(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RequestPolicyError("Invalid GenAI seed");
  }
  return parsed;
}

function parseNonNegativeInteger(raw, defaultValue) {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

function parsePositiveInteger(raw, defaultValue) {
  const parsed = parseNonNegativeInteger(raw, defaultValue);
  return parsed > 0 ? parsed : defaultValue;
}

function parseOptionalPositiveInteger(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function parseOptionalPositiveNumber(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseBoolean(raw, defaultValue = false) {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// TRUST_PROXY accepts what express's "trust proxy" accepts: a hop count ("1"
// behind one reverse proxy), a boolean word, or a proxy-addr spec such as
// "loopback" or a comma-separated subnet list. Unset/empty is 0 = trust nothing.
function parseTrustProxy(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return 0;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") {
    return true;
  }
  if (lower === "false" || lower === "no" || lower === "off") {
    return 0;
  }
  return value;
}

function parseCorsAllowedOrigins(raw) {
  if (!raw) {
    return new Set();
  }
  return new Set(
    String(raw)
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean)
  );
}

// Unset CORS_ALLOWED_ORIGINS keeps `origin: true` (reflect anything), which dev,
// the E2E suite and a same-origin deployment all want. Set, the header is sent
// only for a listed origin; others get no CORS header and the browser refuses
// the response. Same-origin and non-browser callers send no Origin and are
// unaffected.
function buildCorsOptions() {
  if (CORS_ALLOWED_ORIGINS.size === 0) {
    return { origin: true };
  }
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, CORS_ALLOWED_ORIGINS.has(String(origin).replace(/\/+$/, "").toLowerCase()));
    }
  };
}

// Every configurable path may be a file: URL (the in-checkout default) or an
// operator-supplied string pointing anywhere, so a deploy that replaces the
// checkout does not wipe state.
function resolveFilePath(value) {
  if (value instanceof URL) {
    return decodeURIComponent(value.pathname);
  }
  return path.resolve(String(value));
}

// spend.log lives next to query.log by default.
function resolveSpendLogPath() {
  if (process.env.SPEND_LOG_FILE) {
    return path.resolve(process.env.SPEND_LOG_FILE);
  }
  return path.join(path.dirname(getApiQueryLogFilePath()), "spend.log");
}

function getXrDiagLogFilePath() {
  return resolveFilePath(XR_DIAG_LOG_FILE);
}

// Single-generation rotation: at the cap the current log becomes `<file>.1`
// (replacing any previous .1) and a fresh file starts. Bounded disk use with no
// logrotate dependency and no truncation mid-line.
//
// Serialised on one promise chain: each line waits for the previous line's whole
// stat/rotate/append. Otherwise concurrent requests each measure the file before
// anyone rotates, all decide there is room, and the log passes its cap. Appends
// are occasional diagnostics, so the ordering costs nothing.
let xrDiagWriteChain = Promise.resolve();

function appendXrDiagLine(line) {
  const filePath = getXrDiagLogFilePath();
  xrDiagWriteChain = xrDiagWriteChain.then(async () => {
    try {
      if (XR_DIAG_MAX_BYTES) {
        let size = 0;
        try {
          ({ size } = await fsp.stat(filePath));
        } catch {
          size = 0; // No file yet: nothing to rotate.
        }
        if (size && size + Buffer.byteLength(line) > XR_DIAG_MAX_BYTES) {
          await fsp.rename(filePath, `${filePath}.1`);
        }
      }
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.appendFile(filePath, line);
    } catch (err) {
      // A diagnostic log must never take the request path down with it.
      console.warn(`Could not write XR diag log: ${err.message}`);
    }
  });
}

function parseAllowedTargetHosts(raw) {
  if (!raw) {
    return new Set();
  }
  return new Set(
    String(raw)
      .split(",")
      .map((host) => normalizeHostname(host.trim()))
      .filter(Boolean)
  );
}

const rateLimitBuckets = new Map();

function rateLimitRequests(req, res, next) {
  const isCheapRead = CHEAP_READ_ROUTE.test(req.originalUrl || "");
  const limit = isCheapRead
    ? RATE_LIMIT_READ_REQUESTS_PER_WINDOW
    : RATE_LIMIT_REQUESTS_PER_WINDOW;
  if (!limit) {
    next();
    return;
  }

  const now = Date.now();
  // The tier is part of the key, so a burst of job polls cannot spend the budget
  // the next extract or generation needs.
  // Keyed like the spend caps: per IPv6 address, one /64 could rotate past it.
  const client = getSpendClientKey(req) || "unknown";
  const key = isCheapRead ? `${client}|read` : client;
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    // A stale bucket for this key self-heals on next access; the size cap below
    // reclaims memory from other quiet keys. Map insertion order is stable on
    // re-set, so the entry evicted here is the longest-tracked IP, not necessarily
    // the most idle: a coarse O(1) approximation that keeps the map bounded.
    if (!bucket && rateLimitBuckets.size >= RATE_LIMIT_MAX_TRACKED_IPS) {
      const oldestKey = rateLimitBuckets.keys().next().value;
      rateLimitBuckets.delete(oldestKey);
    }
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    next();
    return;
  }

  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("retry-after", String(retryAfterSeconds));
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  bucket.count += 1;
  next();
}

// A global concurrency ceiling across /api/extract, /api/proxy/image and the
// GenAI source import: the three routes that hand an arbitrary remote body to
// cheerio (full DOM parse) or sharp (native decode/resize), the actual memory
// risk. Unlike RATE_LIMIT above this is not per-IP: a few visitors browsing
// normally can produce the same burst as one attacker. 0 disables it, as for
// every *_MAX env in this file.
function liveMonitorMiddleware(req, res, next) {
  const tracked = liveMonitor.touch(parseSessionId(req.get("x-session-id")), () => ({
    country: lookupCountry(req.ip),
    device: deviceFromUserAgent(req.get("user-agent"))
  }), getSpendClientKey(req));
  res.once("finish", () => countLiveRequest(req, res));
  liveSessionContext.run(tracked ? tracked.id : "", next);
}

function countLiveRequest(req, res) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return;
  }
  const route = req.originalUrl.split("?")[0];
  if (route === "/api/extract") {
    liveMonitor.count("pages");
  } else if (route === "/api/search/images") {
    liveMonitor.count("searches");
  } else if (route === "/api/genai" && req.method === "POST") {
    liveMonitor.count("aiRequests");
  } else if (route.startsWith("/api/genai/image/")) {
    liveMonitor.count("aiImagesShown");
  } else if (route === "/api/proxy/image") {
    liveMonitor.count("imagesShown");
    if (res.locals.imageCacheHit) {
      liveMonitor.count("imageCacheHits");
    }
  }
}

function loadGeoIpReader(file) {
  if (!file) {
    return null;
  }
  try {
    return new MmdbReader(fs.readFileSync(file));
  } catch (err) {
    console.warn(`GeoIP database ${file} not loaded: ${err.message}`);
    return null;
  }
}

function lookupCountry(address) {
  if (!geoIpReader) {
    return "";
  }
  try {
    return geoIpReader.get(String(address || "").replace(/^::ffff:/, ""))?.country?.iso_code || "";
  } catch {
    return "";
  }
}

function createConcurrencyGuard(max, perClientMax = 0) {
  let active = 0;
  const activeByClient = new Map();
  return function concurrencyGuard(req, res, next) {
    if (!max) {
      next();
      return;
    }
    const client = getSpendClientKey(req);
    const clientActive = activeByClient.get(client) || 0;
    if (active >= max || (perClientMax && clientActive >= perClientMax)) {
      res.setHeader("retry-after", "1");
      res.status(503).json({ error: "Server busy, try again shortly" });
      return;
    }
    active += 1;
    activeByClient.set(client, clientActive + 1);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      active = Math.max(0, active - 1);
      const remaining = (activeByClient.get(client) || 1) - 1;
      if (remaining > 0) {
        activeByClient.set(client, remaining);
      } else {
        activeByClient.delete(client);
      }
    };
    // The slot is held until the admitted work ends, not until the client goes:
    // a disconnect leaves the fetch and decode running, so releasing on 'close'
    // let a client that kept disconnecting stack work past the ceiling. Guarded
    // handlers are wrapped in holdSlotUntilSettled, which releases when they
    // return. A client that leaves before its handler starts (mid-upload) frees
    // the slot at once; otherwise 'close' only arms a backstop.
    res.once("finish", release);
    res.once("close", () => {
      if (!res.locals.concurrencyWorkStarted) {
        release();
      } else if (!released) {
        setTimeout(release, CONCURRENCY_SLOT_BACKSTOP_MS).unref();
      }
    });
    res.locals.releaseConcurrencySlot = release;
    next();
  };
}

function holdSlotUntilSettled(handler) {
  return async (req, res, next) => {
    res.locals.concurrencyWorkStarted = true;
    try {
      return await handler(req, res, next);
    } finally {
      res.locals.releaseConcurrencySlot?.();
    }
  };
}


function loadSettingsOverrides() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    console.warn(`Ignoring invalid settings overrides: ${err.message}`);
    return {};
  }
}

function loadMuseumSafeBlocklist() {
  try {
    return fs.readFileSync(MUSEUM_SAFE_BLOCKLIST_URL, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith("#"));
  } catch (err) {
    console.warn(`Museum-safe blocklist unavailable: ${err.message}`);
    return [];
  }
}

function writeSettingsOverrides(overrides) {
  // SETTINGS_FILE_PATH may point outside the checkout, so the directory may not
  // exist yet.
  fs.mkdirSync(path.dirname(resolveFilePath(SETTINGS_FILE_PATH)), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE_PATH, `${JSON.stringify(overrides, null, 2)}\n`);
}

function getSettingSource(key) {
  if (Object.prototype.hasOwnProperty.call(settingsOverrides, key)) {
    return "override";
  }
  if (process.env[key] !== undefined && process.env[key] !== "") {
    return "env";
  }
  if (key === "FAL_KEY" && process.env.FAL_KEY) {
    return "env";
  }
  return "default";
}

function getRawSetting(key) {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(settingsOverrides, key)) {
    return settingsOverrides[key];
  }
  if (process.env[key] !== undefined && process.env[key] !== "") {
    return process.env[key];
  }
  return definition.defaultValue;
}

function getStringSetting(key) {
  return String(getRawSetting(key) ?? "").trim();
}

function getIntegerSetting(key) {
  const definition = SETTING_DEFINITIONS[key];
  return clampNumber(getRawSetting(key), definition.min ?? 0, definition.max ?? Number.MAX_SAFE_INTEGER, definition.defaultValue);
}

function getNumberSetting(key) {
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(getRawSetting(key));
  if (!Number.isFinite(parsed)) {
    return definition.defaultValue;
  }
  return Math.min(definition.max ?? Number.MAX_VALUE, Math.max(definition.min ?? 0, parsed));
}

function getOptionalIntegerSetting(key) {
  const value = getRawSetting(key);
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(definition.max ?? Number.MAX_SAFE_INTEGER, Math.max(definition.min ?? 1, Math.floor(parsed)));
}

function getOptionalNumberSetting(key) {
  const value = getRawSetting(key);
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(definition.max ?? Number.MAX_VALUE, Math.max(definition.min ?? 0, parsed));
}

function getBooleanSetting(key) {
  return parseBoolean(getRawSetting(key), SETTING_DEFINITIONS[key]?.defaultValue || false);
}

function isMuseumSafeEnabled() {
  return getBooleanSetting("GENAI_MUSEUM_SAFE");
}

function isMuseumSafeTextBlocked(text) {
  if (!isMuseumSafeEnabled()) {
    return false;
  }
  const normalized = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return museumSafeBlockedTerms.some((term) => normalized.includes(` ${term.replace(/[^a-z0-9]+/g, " ")} `));
}

function withMuseumSafeNegativePrompt(negativePrompt) {
  if (!isMuseumSafeEnabled()) {
    return negativePrompt;
  }
  const safetyNegative = "nsfw, nudity, gore, graphic violence, explicit sexual content";
  return [negativePrompt, safetyNegative].filter(Boolean).join(", ");
}

function getGenAiApiKey() {
  return getStringSetting("GENAI_API_KEY");
}

function getFalApiKey() {
  return getStringSetting("GENAI_API_KEY") || getStringSetting("FAL_KEY");
}

function getFalTextModel() {
  return getStringSetting("GENAI_FAL_TEXT_MODEL");
}

function getFalImageModel() {
  return getStringSetting("GENAI_FAL_IMAGE_MODEL");
}

function getFalModelCapabilities() {
  const textModel = getFalTextModel();
  const imageModel = getFalImageModel();
  const hasKleinText = textModel === FAL_FLUX_2_KLEIN_4B_TEXT_MODEL;
  const hasKleinEdit = imageModel === FAL_FLUX_2_KLEIN_4B_EDIT_MODEL;
  if (hasKleinText !== hasKleinEdit) {
    throw new ProviderConfigError(
      `FLUX.2 [klein] 4B requires paired Fal models: ${FAL_FLUX_2_KLEIN_4B_TEXT_MODEL} and ${FAL_FLUX_2_KLEIN_4B_EDIT_MODEL}`
    );
  }
  // varyStrengthControl: whether the vary endpoint takes a denoising-strength
  // dial. Klein edit's published schema has none (inputs: prompt, image_urls,
  // seed, num_inference_steps, image_size, num_images, sync_mode,
  // enable_safety_checker, output_format). It decides more than lineage metadata;
  // see composeVaryModifier.
  return hasKleinText
    ? { id: "flux2-klein-4b", textModel, imageModel, varyStrengthControl: false }
    : { id: "flux1-compatible", textModel, imageModel, varyStrengthControl: true };
}

function getGenAiTimeoutMs() {
  return getIntegerSetting("GENAI_TIMEOUT_MS");
}

function getGenAiImageRetentionDays() {
  return getIntegerSetting("GENAI_IMAGE_RETENTION_DAYS");
}

function getGenAiSaveImagesToDisk() {
  return getBooleanSetting("GENAI_SAVE_IMAGES_TO_DISK");
}

function getGenAiCleanupImages() {
  return getBooleanSetting("GENAI_CLEANUP_IMAGES");
}

function getGenAiResponseMaxBytes() {
  return parsePositiveInteger(process.env.GENAI_RESPONSE_MAX_BYTES, 50 * 1024 * 1024);
}

function isApiQueryLoggingEnabled() {
  return getBooleanSetting("LOG_API_QUERIES");
}

function getApiQueryLogFilePath() {
  if (API_QUERY_LOG_FILE instanceof URL) {
    return decodeURIComponent(API_QUERY_LOG_FILE.pathname);
  }
  return path.resolve(String(API_QUERY_LOG_FILE));
}

function logApiQuery(eventType, details = {}) {
  const liveSession = liveSessionContext.getStore();
  if (liveSession) {
    const line = describeEvent(eventType, details);
    if (line) {
      liveMonitor.addEvent(liveSession, line);
    }
  }
  if (!isApiQueryLoggingEnabled()) {
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    event: eventType,
    ...details
  };
  const line = JSON.stringify(entry);
  console.info(`[Surface Browser API query] ${line}`);

  const filePath = getApiQueryLogFilePath();
  fs.mkdir(path.dirname(filePath), { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      console.warn(`Could not prepare API query log directory: ${mkdirErr.message}`);
      return;
    }
    fs.appendFile(filePath, `${line}\n`, (writeErr) => {
      if (writeErr) {
        console.warn(`Could not write API query log: ${writeErr.message}`);
      }
    });
  });
}

function genAiQueryLogDetails({ provider = getGenAiProvider(), prompt = "", count = null, sourceRecord = null } = {}) {
  const steps = getOptionalIntegerSetting("GENAI_STEPS");
  const guidanceEmbed = provider === "drawthings" ? getOptionalNumberSetting("GENAI_DRAWTHINGS_GUIDANCE_EMBED") : null;
  return {
    provider,
    endpoint: provider === "fal"
      ? (sourceRecord ? getFalImageModel() : getFalTextModel())
      : safeResolvedGenAiEndpoint(provider),
    prompt,
    mode: sourceRecord ? "vary" : "generate",
    sourceId: sourceRecord?.id || null,
    count,
    width: sourceRecord?.width || getIntegerSetting("GENAI_WIDTH"),
    height: sourceRecord?.height || getIntegerSetting("GENAI_HEIGHT"),
    steps: steps ?? "default",
    guidanceEmbed: guidanceEmbed ?? "default"
  };
}

function safeResolvedGenAiEndpoint(provider) {
  try {
    return resolveGenAiEndpointValue(provider) || "";
  } catch {
    return "";
  }
}

// Count and bytes both bound the store; bytes is the one that protects memory.
// Pooled records count toward the first only.
function getGenAiImageCacheMax() {
  return parsePositiveInteger(process.env.GENAI_IMAGE_CACHE_MAX, 3000);
}

function getGenAiImageCacheMaxBytes() {
  return parsePositiveInteger(process.env.GENAI_IMAGE_CACHE_MAX_BYTES, 300 * 1024 * 1024);
}

function getGenAiImageCacheTtlMs() {
  return parsePositiveInteger(process.env.GENAI_IMAGE_CACHE_TTL_MS, 30 * 60_000);
}

function getGenAiResultCacheMax() {
  return parsePositiveInteger(process.env.GENAI_RESULT_CACHE_MAX, 50);
}

function getGenAiResultCacheTtlMs() {
  return parsePositiveInteger(process.env.GENAI_RESULT_CACHE_TTL_MS, getGenAiImageCacheTtlMs());
}

function getPublicSettings() {
  const publicSettings = {};
  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    const rawValue = getRawSetting(key);
    publicSettings[key] = {
      value: definition.type === "secret" ? maskSecret(rawValue) : coerceSettingValue(rawValue, definition),
      source: getSettingSource(key),
      secret: definition.type === "secret"
    };
  }
  return publicSettings;
}

function getSettingsMeta() {
  return {
    generatedImagesDir: getGeneratedImagesDirDisplayPath()
  };
}

function getGeneratedImagesDirDisplayPath() {
  if (GENERATED_IMAGES_DIR instanceof URL) {
    return decodeURIComponent(GENERATED_IMAGES_DIR.pathname);
  }
  return path.resolve(String(GENERATED_IMAGES_DIR));
}

function getScreenshotsDirPath() {
  if (SCREENSHOTS_DIR instanceof URL) {
    return decodeURIComponent(SCREENSHOTS_DIR.pathname);
  }
  return path.resolve(String(SCREENSHOTS_DIR));
}

// 404, not 403: same convention as the dev routes and /admin/pool, so a scanner
// does not learn that this host has a route that writes files.
function screenshotAuthGate(req, res, next) {
  if (!isScreenshotEnabled(req)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

function isScreenshotEnabled(req) {
  if (!parseBoolean(process.env.SCREENSHOT_ENABLED, true)) {
    return false;
  }
  // Same shape as canWriteSettings(): with a token configured, the correct token
  // or loopback authorises; loopback means someone with a shell on the host.
  if (SCREENSHOT_TOKEN && timingSafeEqualString(req.get("x-capture-token"), SCREENSHOT_TOKEN)) {
    return true;
  }
  return isLocalRequest(req);
}

// Constant-time compare. timingSafeEqual THROWS on unequal lengths, so the
// length guard has to come first; it leaks the token's length and nothing else.
function timingSafeEqualString(candidate, expected) {
  const a = Buffer.from(String(candidate ?? ""), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// express.raw accepts any content-type on purpose: the bytes are validated by
// their own signature (JPEG or PNG) in the route, so a declared type would be a
// second, weaker check. The wrapper exists because body-parser's 413 would
// otherwise reach Express's default HTML error page, and the client reads JSON.
const parseScreenshotBody = express.raw({ type: () => true, limit: SCREENSHOT_MAX_BYTES });

function readScreenshotBody(req, res, next) {
  parseScreenshotBody(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    const tooLarge = err.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? "Screenshot too large" : "Invalid screenshot body"
    });
  });
}

function formatStartupSettingsSummary() {
  const lines = [
    "Startup settings:",
    `- .env: ${hasDotEnvFile() ? "present" : "absent"} | ${formatSettingsLayerSummary(getEnvRawSetting)}`
  ];

  if (HIDE_SETTINGS) {
    lines.push("- Settings UI: hidden");
  } else {
    lines.push(`- Settings UI: visible | saved overrides: ${hasSettingsOverrides() ? "present" : "none"} | ${formatSettingsLayerSummary(getRawSetting)}`);
  }

  return lines.join("\n");
}

function hasDotEnvFile() {
  return fs.existsSync(new URL("../.env", import.meta.url)) || fs.existsSync(".env");
}

function hasSettingsOverrides() {
  return Object.keys(settingsOverrides).length > 0;
}

function getEnvRawSetting(key) {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) {
    return undefined;
  }
  if (process.env[key] !== undefined && process.env[key] !== "") {
    return process.env[key];
  }
  return definition.defaultValue;
}

function formatSettingsLayerSummary(readRawSetting) {
  const imageProvider = getLayerImageSearchProvider(readRawSetting);
  const genAiProvider = getLayerGenAiProvider(readRawSetting);
  return [
    `image search: ${formatImageSearchSummary(readRawSetting, imageProvider)}`,
    `gen ai: ${formatGenAiSummary(readRawSetting, genAiProvider)}`,
    `config: ${formatGenAiConfigSummary(readRawSetting)}`
  ].join(" | ");
}

function formatImageSearchSummary(readRawSetting, provider) {
  if (provider === "custom") {
    return `custom endpoint=${formatOptionalValue(getLayerStringSetting(readRawSetting, "IMAGE_SEARCH_ENDPOINT"))}`;
  }
  if (provider === "serper") {
    return `serper key=${formatSetUnset(getLayerStringSetting(readRawSetting, "SERPER_API_KEY"))}`;
  }
  if (provider === "brave") {
    return `brave key=${formatSetUnset(getLayerStringSetting(readRawSetting, "BRAVE_SEARCH_API_KEY"))}`;
  }
  return "ddg";
}

function formatGenAiSummary(readRawSetting, provider) {
  if (provider === "disabled") {
    return "disabled";
  }

  const enabled = isLayerGenAiEnabled(readRawSetting, provider) ? "enabled" : "configured but unavailable";
  if (provider === "fal") {
    return `fal ${enabled} key=${formatSetUnset(getLayerFalApiKey(readRawSetting))} base=${formatOptionalValue(getLayerStringSetting(readRawSetting, "GENAI_FAL_BASE_URL"))}`;
  }

  const endpoint = resolveLayerGenAiEndpoint(readRawSetting, provider);
  return `${provider} ${enabled} endpoint=${formatOptionalValue(endpoint)}`;
}

function formatGenAiConfigSummary(readRawSetting) {
  const steps = getLayerOptionalIntegerSetting(readRawSetting, "GENAI_STEPS");
  const cfgScale = getLayerOptionalNumberSetting(readRawSetting, "GENAI_CFG_SCALE");
  const guidanceEmbed = getLayerOptionalNumberSetting(readRawSetting, "GENAI_DRAWTHINGS_GUIDANCE_EMBED");
  const strengthMin = getLayerNumberSetting(readRawSetting, "GENAI_VARIATION_STRENGTH_MIN");
  const strengthMax = getLayerNumberSetting(readRawSetting, "GENAI_VARIATION_STRENGTH_MAX");
  return [
    `count=${getLayerIntegerSetting(readRawSetting, "GENAI_COUNT")}`,
    `size=${getLayerIntegerSetting(readRawSetting, "GENAI_WIDTH")}x${getLayerIntegerSetting(readRawSetting, "GENAI_HEIGHT")}`,
    `steps=${steps ?? "default"}`,
    `cfg=${cfgScale ?? "default"}`,
    `drawThingsGuidanceEmbed=${guidanceEmbed ?? "default"}`,
    `timeout=${getLayerIntegerSetting(readRawSetting, "GENAI_TIMEOUT_MS")}ms`,
    `savedImages=${formatSavedImagesSummary(readRawSetting)}`,
    `museumSafe=${getLayerBooleanSetting(readRawSetting, "GENAI_MUSEUM_SAFE")}`,
    `variation=${Math.min(strengthMin, strengthMax)}-${Math.max(strengthMin, strengthMax)}`,
    `varySeed=${getLayerStringSetting(readRawSetting, "GENAI_VARY_SEED_MODE") || "fresh"}`,
    `varyModifier=${normalizeGenAiVaryModifierMode(getLayerStringSetting(readRawSetting, "GENAI_VARY_MODIFIER_MODE")) || "per-image"}`,
    `varyModifierStyle=${normalizeGenAiVaryModifierStyle(getLayerStringSetting(readRawSetting, "GENAI_VARY_MODIFIER_STYLE")) || "replace"}`,
    `varyModifierPayload=${normalizeGenAiVaryModifierPayload(getLayerStringSetting(readRawSetting, "GENAI_VARY_MODIFIER_PAYLOAD")) || "text"}`,
    `falVaryMaxSource=${FAL_VARY_MAX_SOURCE_BYTES}B`
  ].join(", ");
}

function getLayerImageSearchProvider(readRawSetting) {
  const configuredProvider = normalizeImageSearchProvider(getLayerStringSetting(readRawSetting, "IMAGE_SEARCH_PROVIDER"));
  if (configuredProvider) {
    return configuredProvider;
  }
  if (getLayerStringSetting(readRawSetting, "IMAGE_SEARCH_ENDPOINT")) {
    return "custom";
  }
  if (getLayerStringSetting(readRawSetting, "SERPER_API_KEY")) {
    return "serper";
  }
  if (getLayerStringSetting(readRawSetting, "BRAVE_SEARCH_API_KEY")) {
    return "brave";
  }
  return "ddg";
}

function getLayerGenAiProvider(readRawSetting) {
  const configuredProvider = normalizeGenAiProvider(getLayerStringSetting(readRawSetting, "GENAI_PROVIDER"));
  if (configuredProvider) {
    return configuredProvider;
  }
  if (getLayerStringSetting(readRawSetting, "GENAI_ENDPOINT")) {
    return "custom";
  }
  return "disabled";
}

function isLayerGenAiEnabled(readRawSetting, provider) {
  return Boolean(
    resolveLayerGenAiEndpoint(readRawSetting, provider)
    || (provider === "fal" && getLayerFalApiKey(readRawSetting))
  );
}

function resolveLayerGenAiEndpoint(readRawSetting, provider) {
  return getLayerProviderEndpoint(readRawSetting, provider)
    || getLayerStringSetting(readRawSetting, "GENAI_ENDPOINT")
    || DEFAULT_GENAI_ENDPOINTS[provider]
    || "";
}

function getLayerFalApiKey(readRawSetting) {
  return getLayerStringSetting(readRawSetting, "GENAI_API_KEY") || getLayerStringSetting(readRawSetting, "FAL_KEY");
}

function getLayerStringSetting(readRawSetting, key) {
  return String(readRawSetting(key) ?? "").trim();
}

function getLayerIntegerSetting(readRawSetting, key) {
  const definition = SETTING_DEFINITIONS[key];
  return clampNumber(readRawSetting(key), definition.min ?? 0, definition.max ?? Number.MAX_SAFE_INTEGER, definition.defaultValue);
}

function getLayerNumberSetting(readRawSetting, key) {
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(readRawSetting(key));
  if (!Number.isFinite(parsed)) {
    return definition.defaultValue;
  }
  return Math.min(definition.max ?? Number.MAX_VALUE, Math.max(definition.min ?? 0, parsed));
}

function getLayerOptionalIntegerSetting(readRawSetting, key) {
  const value = readRawSetting(key);
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(definition.max ?? Number.MAX_SAFE_INTEGER, Math.max(definition.min ?? 1, Math.floor(parsed)));
}

function getLayerOptionalNumberSetting(readRawSetting, key) {
  const value = readRawSetting(key);
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(definition.max ?? Number.MAX_VALUE, Math.max(definition.min ?? 0, parsed));
}

function getLayerBooleanSetting(readRawSetting, key) {
  return parseBoolean(readRawSetting(key), SETTING_DEFINITIONS[key]?.defaultValue || false);
}

function formatSetUnset(value) {
  return value ? "set" : "unset";
}

function formatOptionalValue(value) {
  return value || "unset";
}

function formatSavedImagesSummary(readRawSetting) {
  if (!getLayerBooleanSetting(readRawSetting, "GENAI_SAVE_IMAGES_TO_DISK")) {
    return "off";
  }
  if (!getLayerBooleanSetting(readRawSetting, "GENAI_CLEANUP_IMAGES")) {
    return "on, cleanup=off";
  }
  const days = getLayerIntegerSetting(readRawSetting, "GENAI_IMAGE_RETENTION_DAYS");
  return `on, cleanup=${days <= 0 ? "after-session" : `${days}d`}`;
}

function maskSecret(value) {
  const str = String(value || "");
  if (!str) {
    return "";
  }
  if (str.length <= 8) {
    return "****";
  }
  return `${str.slice(0, 3)}...${str.slice(-4)}`;
}

function validateSettingsUpdate(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    throw new Error("Settings payload must be an object");
  }
  const next = { ...settingsOverrides };
  for (const [key, value] of Object.entries(rawSettings)) {
    const definition = SETTING_DEFINITIONS[key];
    if (!definition) {
      throw new Error(`Unknown setting: ${key}`);
    }
    if (value === null || value === undefined || value === "") {
      delete next[key];
      continue;
    }
    next[key] = coerceSettingValue(value, definition);
  }
  if (
    Object.prototype.hasOwnProperty.call(rawSettings, "GENAI_PROVIDER")
    && !Object.prototype.hasOwnProperty.call(rawSettings, "GENAI_ENDPOINT")
  ) {
    const provider = normalizeGenAiProvider(String(rawSettings.GENAI_PROVIDER || ""));
    if (provider && DEFAULT_GENAI_ENDPOINTS[provider]) {
      delete next.GENAI_ENDPOINT;
    }
  }
  return next;
}

function coerceSettingValue(value, definition) {
  if (definition.type === "boolean") {
    return parseBoolean(value, definition.defaultValue);
  }
  if (definition.type === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error("Expected an integer setting value");
    }
    const next = Math.floor(parsed);
    if (next < definition.min || next > definition.max) {
      throw new Error(`Integer setting must be between ${definition.min} and ${definition.max}`);
    }
    return next;
  }
  if (definition.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < definition.min || parsed > definition.max) {
      throw new Error(`Number setting must be between ${definition.min} and ${definition.max}`);
    }
    return parsed;
  }
  if (definition.type === "optionalInteger") {
    return value === "" ? "" : getOptionalIntegerSettingFromValue(value, definition);
  }
  if (definition.type === "optionalNumber") {
    return value === "" ? "" : getOptionalNumberSettingFromValue(value, definition);
  }
  const str = String(value || "").trim();
  if (definition.type === "imageSearchProvider") {
    if (!str) {
      return "";
    }
    const normalized = normalizeImageSearchProvider(str);
    if (!normalized) {
      throw new Error("Unsupported image search provider");
    }
    return normalized;
  }
  if (definition.type === "genAiProvider") {
    if (!str) {
      return "";
    }
    const normalized = normalizeGenAiProvider(str);
    if (!normalized) {
      throw new Error("Unsupported GenAI provider");
    }
    return normalized;
  }
  if (definition.type === "genAiVarySeedMode") {
    const normalized = normalizeGenAiVarySeedMode(str);
    if (!normalized) {
      throw new Error("Unsupported GenAI vary seed mode");
    }
    return normalized;
  }
  if (definition.type === "genAiVaryModifierMode") {
    const normalized = normalizeGenAiVaryModifierMode(str);
    if (!normalized) {
      throw new Error("Unsupported GenAI vary modifier mode");
    }
    return normalized;
  }
  if (definition.type === "genAiVaryModifierStyle") {
    const normalized = normalizeGenAiVaryModifierStyle(str);
    if (!normalized) {
      throw new Error("Unsupported GenAI vary modifier style");
    }
    return normalized;
  }
  if (definition.type === "genAiVaryModifierPayload") {
    const normalized = normalizeGenAiVaryModifierPayload(str);
    if (!normalized) {
      throw new Error("Unsupported GenAI vary modifier payload");
    }
    return normalized;
  }
  if (definition.type === "wristPanelHand") {
    const normalized = normalizeWristPanelHand(str);
    if (!normalized) {
      throw new Error("Wrist panel hand must be left or right");
    }
    return normalized;
  }
  if (definition.type === "url" && str) {
    try {
      const parsed = new URL(str);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("URL must use http or https");
      }
    } catch {
      throw new Error("Expected a valid http(s) URL");
    }
  }
  return str;
}

function getOptionalIntegerSettingFromValue(value, definition) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Expected an optional integer setting value");
  }
  const next = Math.floor(parsed);
  if (next < definition.min || next > definition.max) {
    throw new Error(`Integer setting must be between ${definition.min} and ${definition.max}`);
  }
  return next;
}

function getOptionalNumberSettingFromValue(value, definition) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < definition.min || parsed > definition.max) {
    throw new Error(`Number setting must be between ${definition.min} and ${definition.max}`);
  }
  return parsed;
}

function canWriteSettings(req) {
  if (SETTINGS_TOKEN && timingSafeEqualString(req.get("x-settings-token"), SETTINGS_TOKEN)) {
    return true;
  }
  return isLocalRequest(req);
}

// req.ip, not req.socket.remoteAddress. With `trust proxy` off the two are the
// same; with it on, req.ip is the real client, so this is not an open door for
// every request a reverse proxy forwards.
function isLocalRequest(req) {
  if (!isLoopbackAddress(req.ip || req.socket?.remoteAddress)) {
    return false;
  }
  // The Vite dev proxy forwards every client from loopback and names the real
  // one here (vite.config.js). The header can only narrow trust, never grant it.
  const devClient = req.get("x-surface-dev-client");
  return devClient === undefined || isLoopbackAddress(devClient);
}

function isLoopbackAddress(value) {
  const address = String(value || "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

async function runSettingsTest(target, stage) {
  if (target === "genai") {
    return runGenAiSettingsTest(stage);
  }
  if (target === "imageSearch") {
    return runImageSearchSettingsTest(stage);
  }
  throw new Error("Unknown settings test target");
}

async function runGenAiSettingsTest(stage) {
  if (stage === "connect") {
    const provider = getGenAiProvider();
    if (provider === "drawthings" || provider === "a1111") {
      const response = await fetchWithTimeout(
        buildSdApiUrl(resolveGenAiEndpoint(provider), "options"),
        { headers: { "accept": "application/json" } },
        Math.min(getGenAiTimeoutMs(), 10_000),
        { applyHostAllowlist: false, allowPrivateAddress: true, allowNonStandardPort: true }
      );
      if (!response.ok) {
        throw new Error(`GenAI connect returned HTTP ${response.status}`);
      }
      return { target: "genai", stage, provider };
    }
    if (provider === "fal") {
      if (!getFalApiKey()) {
        throw new ProviderConfigError("GENAI_API_KEY or FAL_KEY is required for GENAI_PROVIDER=fal");
      }
      const capabilities = getFalModelCapabilities();
      return { target: "genai", stage, provider, model: capabilities.textModel, profile: capabilities.id };
    }
    if (provider === "custom" || provider === "relay") {
      if (!resolveGenAiEndpointValue(provider)) {
        throw new ProviderConfigError("GENAI_ENDPOINT is required for GenAI mode");
      }
      return { target: "genai", stage, provider };
    }
    throw new ProviderConfigError("GenAI provider is not configured");
  }
  if (stage === "generate") {
    const selected = await generateImages({
      prompt: "surface browser test image",
      negativePrompt: "",
      count: 1
    });
    return { target: "genai", stage, provider: selected.provider, item: selected.items[0] || null };
  }
  if (stage === "vary") {
    const generated = await generateImages({
      prompt: "surface browser test image",
      negativePrompt: "",
      count: 1
    });
    const sourceRecord = generated.items[0]?.genai?.id ? getStoredGenAiImage(generated.items[0].genai.id) : null;
    if (!sourceRecord) {
      throw new Error("Generated test image was not stored");
    }
    const varied = await generateImages({
      prompt: sourceRecord.genai.prompt,
      negativePrompt: "",
      count: 1,
      sourceRecord
    });
    return { target: "genai", stage, provider: varied.provider, item: varied.items[0] || null };
  }
  throw new Error("Unknown GenAI test stage");
}

async function runImageSearchSettingsTest(stage) {
  if (stage !== "connect" && stage !== "generate") {
    throw new Error("Unknown image search test stage");
  }
  const selected = await searchImages("surface browser test", 3);
  return {
    target: "imageSearch",
    stage,
    provider: selected.provider,
    items: selected.items
  };
}

function chooseResult(primary, fallback) {
  if (!primary && !fallback) {
    return null;
  }
  if (!fallback) {
    return primary;
  }
  if (!primary) {
    return fallback;
  }
  // More LINKED images wins, provided the render did not collapse the set
  // (a handful of linked images is not better than a full tunnel of them).
  const fallbackLinked = linkedItemCount(fallback);
  const primaryLinked = linkedItemCount(primary);
  if (fallbackLinked !== primaryLinked) {
    const enough = fallback.items.length >= Math.min(primary.items.length, DEFAULT_THRESHOLD);
    if (fallbackLinked > primaryLinked && enough) {
      return fallback;
    }
    if (primaryLinked > fallbackLinked) {
      return primary;
    }
  }
  return fallback.items.length >= primary.items.length ? fallback : primary;
}

function normalizeFallback(raw) {
  const value = String(raw || "auto").toLowerCase();
  if (value === "force" || value === "none") {
    return value;
  }
  return "auto";
}

function normalizeImageSearchProvider(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "duckduckgo") {
    return "ddg";
  }
  if (value === "ddg" || value === "serper" || value === "brave" || value === "custom") {
    return value;
  }
  return "";
}

function normalizeGenAiProvider(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "drawthings" || value === "a1111" || value === "fal" || value === "custom" || value === "relay") {
    return value;
  }
  return "";
}

function normalizeGenAiVarySeedMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "fresh" || value === "fixed") {
    return value;
  }
  return "";
}

// GenAI vary emoji-modifier config.
// mode:    off | batch (one emoji per vary request) | per-image (one branch each).
// style:   replace (default: the img2img prompt is the modifier payload alone;
//          the source image already carries the content, so the modifier is the
//          only conditioning and denoising strength controls the pull) | append
//          (modifier appended to the lineage prompt, capped).
// payload: text (default: a short adjective phrase mapped from the emoji) |
//          emoji (raw-character fallback for providers whose text encoders
//          understand emoji strongly).
const VARY_MODIFIER_STACK_CAP = 2;

// Built-in emoji->phrase defaults for payload=text. Overridable per emoji via
// `emoji:phrase` tokens in GENAI_VARY_MODIFIERS; an override phrase is one
// whitespace-free token (e.g. `🧊:frozen`), which is why multi-word/comma
// phrases ship as these defaults. Emoji need no separator; see
// server/vary-modifiers.js.
const VARY_MODIFIER_DEFAULT_PHRASES = {
  "🧊": "icy, frozen",
  "🌶️": "spicy, hot red",
  "🦄": "unicorn, fantastical",
  "🎆": "fireworks, sparkling explosive light",
  "🍦": "ice cream, sweet dessert",
  "🧀": "cheese, golden yellow",
  "🌹": "roses, red floral petals",
  "😎": "sunglasses, cool glossy reflections",
  "🪩": "mirror ball, disco reflections",
  "🦦": "otter, playful wet fur",
  "🦘": "kangaroo, Australian outback",
  "❄️": "snow, snowy white",
  "🌊": "water wave, ocean blue",
  "🌕": "full moon, moonlit night",
  "🌲": "evergreen tree, pine forest",
  "🍌": "banana, bright tropical yellow",
  "💡": "light bulb, glowing bright idea",
  "🕯️": "candle, warm candlelit flame",
  "🚿": "shower, falling water and steam",
  "🤗": "warm, joyful",
  "🤖": "robotic, mechanical"
};

function normalizeGenAiVaryModifierMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "off" || value === "batch" || value === "per-image") {
    return value;
  }
  return "";
}

function normalizeGenAiVaryModifierStyle(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "replace" || value === "append") {
    return value;
  }
  return "";
}

function normalizeGenAiVaryModifierPayload(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "emoji" || value === "text") {
    return value;
  }
  return "";
}

// VR wrist UI handedness. The client can override it per page load with
// `?wrist=left|right`; this is the persisted default.
function normalizeWristPanelHand(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "left" || value === "right") {
    return value;
  }
  return "";
}

function getWristPanelHand() {
  return normalizeWristPanelHand(getStringSetting("WRIST_PANEL_HAND")) || "left";
}

function getGenAiVaryModifierMode() {
  return normalizeGenAiVaryModifierMode(getStringSetting("GENAI_VARY_MODIFIER_MODE")) || "per-image";
}

function getGenAiVaryModifierStyle() {
  return normalizeGenAiVaryModifierStyle(getStringSetting("GENAI_VARY_MODIFIER_STYLE")) || "replace";
}

function getGenAiVaryModifierPayload() {
  return normalizeGenAiVaryModifierPayload(getStringSetting("GENAI_VARY_MODIFIER_PAYLOAD")) || "text";
}

// The emoji pick list from GENAI_VARY_MODIFIERS. Separators between emoji are
// optional — see splitVaryModifierEntries in server/vary-modifiers.js.
function getGenAiVaryModifierEmojis() {
  return splitVaryModifierEntries(getStringSetting("GENAI_VARY_MODIFIERS")).map((entry) => entry.emoji);
}

// emoji→phrase map for payload=text: built-in defaults overlaid with any
// `emoji:phrase` overrides parsed from GENAI_VARY_MODIFIERS.
function getGenAiVaryModifierPhraseMap() {
  const map = { ...VARY_MODIFIER_DEFAULT_PHRASES };
  for (const { emoji, phrase } of splitVaryModifierEntries(getStringSetting("GENAI_VARY_MODIFIERS"))) {
    if (phrase) {
      map[emoji] = phrase;
    }
  }
  return map;
}

// The text phrase for an emoji, falling back to the raw emoji when unmapped so
// payload=text never silently drops a modifier.
function getVaryModifierPhrase(emoji) {
  const map = getGenAiVaryModifierPhraseMap();
  return map[emoji] || emoji;
}

// Deterministic-when-seeded emoji pick. `salt` disambiguates per-image picks so
// two variations in one batch can differ while still replaying from the seed.
function pickVaryModifierEmoji(emojis, seed, salt = 0) {
  if (!emojis.length) {
    return null;
  }
  let index;
  if (Number.isFinite(seed)) {
    // Mix seed + salt into a stable non-negative index (avoids adjacent seeds
    // marching predictably through the list for per-image picks).
    const mixed = Math.abs(Math.imul((seed | 0) + salt * 0x9e3779b1, 0x85ebca6b)) >>> 0;
    index = mixed % emojis.length;
  } else {
    index = Math.floor(Math.random() * emojis.length);
  }
  return emojis[index] || null;
}

function pickVaryModifierEmojiFromSequence(emojis, seed, salt = 0) {
  if (!emojis.length) {
    return null;
  }
  const round = Math.floor(Math.max(0, Number(salt) || 0) / emojis.length);
  const index = Math.max(0, Number(salt) || 0) % emojis.length;
  const shuffled = shuffledVaryModifierEmojis(emojis, seed, round);
  return shuffled[index] || null;
}

function shuffledVaryModifierEmojis(emojis, seed, round = 0) {
  const withKeys = emojis.map((emoji, index) => ({
    emoji,
    key: varyModifierShuffleKey(seed, round, emoji, index)
  }));
  withKeys.sort((a, b) => a.key.localeCompare(b.key));
  return withKeys.map((entry) => entry.emoji);
}

function varyModifierShuffleKey(seed, round, emoji, index) {
  const stableSeed = Number.isFinite(seed) ? String(seed) : String(randomInt(0, 2 ** 32));
  return createHash("sha256")
    .update(`${stableSeed}:${round}:${index}:${emoji}`)
    .digest("hex");
}

// Inherited modifier emojis from the vary source's lineage (for vary-of-vary
// compounding). Reads the source record's own modifier plus its ancestors',
// closest-first, deduped.
function collectInheritedModifierEmojis(sourceRecord) {
  const emojis = [];
  const seen = new Set();
  let current = sourceRecord;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const emoji = current.genai?.modifier?.emoji;
    if (emoji && !emojis.includes(emoji)) {
      emojis.push(emoji);
    }
    const parentId = current.genai?.parentId;
    current = parentId ? getStoredGenAiImage(parentId) : null;
  }
  return emojis;
}

// Render one emoji's payload for the sent prompt: the raw emoji, or its mapped
// text phrase when payload=text.
function renderVaryModifierPayload(emoji, payload) {
  return payload === "text" ? getVaryModifierPhrase(emoji) : emoji;
}

function buildVaryModifierStack(sourceRecord, chosen) {
  const inherited = collectInheritedModifierEmojis(sourceRecord);
  const orderedEmoji = [...inherited].reverse().filter((emoji) => emoji !== chosen);
  return [...orderedEmoji, chosen].slice(-VARY_MODIFIER_STACK_CAP);
}

// Compose the modifier for one variation. Returns:
//   prompt   - the string actually sent to the provider for this variation.
//   modifier - the lineage field for this item: { emoji, phrase, sentPrompt }
//              (phrase null unless payload=text), or null when nothing applied.
// Style semantics:
//   replace (default) - the sent prompt is the modifier payload alone (the source
//     image already carries the content; denoising strength controls how far the
//     modifier pulls). No lineage prompt, no compounding.
//   append - modifier appended to the lineage prompt, compounding across
//     vary-of-vary, capped at VARY_MODIFIER_STACK_CAP.
// `style` overrides the configured setting for one provider request. Replace is
// only coherent where the request also carries a denoising-strength dial, which
// is what keeps the source in the frame. An edit endpoint without one (Fal Klein;
// see getFalModelCapabilities) would receive a bare emoji and replace the picture
// with the emoji's subject, so those callers pass append, which anchors the edit
// to the lineage prompt.
function composeVaryModifier({ basePrompt, sourceRecord, seed = null, salt = 0, style: styleOverride = null }) {
  const mode = getGenAiVaryModifierMode();
  if (!sourceRecord || mode === "off") {
    return { prompt: basePrompt, modifier: null };
  }
  const emojis = getGenAiVaryModifierEmojis();
  // batch: one emoji for the whole request (salt fixed). per-image: salt is the
  // variation's global index into a seeded shuffled subset of the configured palette.
  const effectiveSalt = mode === "per-image" ? salt : 0;
  const chosen = mode === "per-image"
    ? pickVaryModifierEmojiFromSequence(emojis, seed, effectiveSalt)
    : pickVaryModifierEmoji(emojis, seed, effectiveSalt);
  if (!chosen) {
    return { prompt: basePrompt, modifier: null };
  }
  const style = styleOverride || getGenAiVaryModifierStyle();
  const payload = getGenAiVaryModifierPayload();
  const phrase = payload === "text" ? getVaryModifierPhrase(chosen) : null;

  if (style === "replace") {
    // The sent prompt is the modifier payload alone: no lineage, no compounding.
    const sentPrompt = renderVaryModifierPayload(chosen, payload);
    return { prompt: sentPrompt, modifier: { emoji: chosen, phrase, sentPrompt, stack: buildVaryModifierStack(sourceRecord, chosen) } };
  }

  // append (legacy): compound onto the clean lineage prompt, capped.
  const inherited = collectInheritedModifierEmojis(sourceRecord);
  // genai.prompt holds the base lineage prompt without the modifier suffix, but
  // older records may carry one: strip any trailing inherited-emoji suffix before
  // re-composing.
  const cleanBase = stripModifierSuffix(basePrompt, inherited);
  // `inherited` is closest-first (newest ancestor first); reverse to oldest→newest
  // so the newest modifier applies last (rightmost) and slice(-cap) keeps the
  // most-recent modifiers when the vary-of-vary stack would exceed the cap.
  const stack = buildVaryModifierStack(sourceRecord, chosen);
  const suffix = stack.map((emoji) => renderVaryModifierPayload(emoji, payload)).join(payload === "text" ? ", " : " ");
  const sentPrompt = cleanBase ? `${cleanBase}, ${suffix}` : suffix;
  return { prompt: sentPrompt, modifier: { emoji: chosen, phrase, sentPrompt, stack } };
}

// Remove a trailing ", <emoji …>" segment previously appended by an earlier
// vary, given the inherited emoji. Only strips when the tail is composed solely
// of inherited modifier emoji (and whitespace) so a legitimately emoji-ending
// user prompt is left alone.
function stripModifierSuffix(prompt, inheritedEmojis) {
  const text = String(prompt || "");
  if (!inheritedEmojis.length) {
    return text;
  }
  const lastComma = text.lastIndexOf(",");
  if (lastComma === -1) {
    return text;
  }
  const tail = text.slice(lastComma + 1).trim();
  if (!tail) {
    return text;
  }
  const tailTokens = tail.split(/\s+/).filter(Boolean);
  if (tailTokens.length && tailTokens.every((token) => inheritedEmojis.includes(token))) {
    return text.slice(0, lastComma).trimEnd();
  }
  return text;
}

function getImageSearchProvider() {
  const configuredProvider = normalizeImageSearchProvider(getStringSetting("IMAGE_SEARCH_PROVIDER"));
  if (configuredProvider) {
    return configuredProvider;
  }
  if (getStringSetting("IMAGE_SEARCH_ENDPOINT")) {
    return "custom";
  }
  if (getStringSetting("SERPER_API_KEY")) {
    return "serper";
  }
  if (getStringSetting("BRAVE_SEARCH_API_KEY")) {
    return "brave";
  }
  return "ddg";
}

function getGenAiProvider() {
  const configuredProvider = normalizeGenAiProvider(getStringSetting("GENAI_PROVIDER"));
  if (configuredProvider) {
    return configuredProvider;
  }
  if (getStringSetting("GENAI_ENDPOINT")) {
    return "custom";
  }
  return "disabled";
}

function getGenAiVarySeedMode() {
  return normalizeGenAiVarySeedMode(getStringSetting("GENAI_VARY_SEED_MODE")) || "fresh";
}

function isGenAiEnabled() {
  const provider = getGenAiProvider();
  return Boolean(
    resolveGenAiEndpointValue(provider)
    || (provider === "fal" && getFalApiKey())
  );
}

function normalizeSearchQuery(raw, maxChars = SEARCH_QUERY_MAX_CHARS) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxChars);
}

// GenAI prompts get their own (larger) ceiling: a search query is a handful of
// words, a prompt legitimately is not. Truncation, never a 400.
function normalizeGenAiPrompt(raw) {
  return normalizeSearchQuery(raw, GENAI_PROMPT_MAX_CHARS);
}

function clampNumber(raw, min, max, defaultValue) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function normalizeAndAssertTargetUrl(rawValue, label) {
  const normalized = normalizeUrl(rawValue);
  if (!normalized) {
    throw new RequestPolicyError(`Missing or invalid ${label}`);
  }
  await assertTargetUrlAllowed(normalized);
  return normalized;
}

function normalizeUrl(rawValue) {
  if (!rawValue) {
    return null;
  }
  let str = String(rawValue).trim();
  if (!str) {
    return null;
  }
  if (!/^https?:\/\//i.test(str)) {
    str = `https://${str}`;
  }
  try {
    const parsed = new URL(str);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function assertTargetUrlAllowed(
  urlValue,
  {
    applyHostAllowlist = true,
    allowPrivateAddress = false,
    allowNonStandardPort = false
  } = {}
) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new RequestPolicyError("Invalid target URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RequestPolicyError("Target URL must use http or https");
  }

  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (!allowNonStandardPort && port !== "80" && port !== "443") {
    throw new RequestPolicyError("Target URL port must be 80 or 443");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new RequestPolicyError("Target URL hostname is required");
  }

  if (applyHostAllowlist && ALLOWED_TARGET_HOSTS.size > 0 && !ALLOWED_TARGET_HOSTS.has(hostname)) {
    throw new RequestPolicyError(`Target host is not allowed: ${hostname}`);
  }

  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion) {
    if (!allowPrivateAddress && isBlockedIpAddress(hostname)) {
      throw new RequestPolicyError(`Target host resolves to a blocked address: ${hostname}`);
    }
    // No DNS involved for an IP literal, so nothing to pin — the connection
    // can only ever go to the address already checked above.
    return { url: parsed.toString(), addresses: [{ address: hostname, family: literalIpVersion }] };
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new RequestPolicyError(`Target hostname could not be resolved: ${hostname}`);
  }

  if (!records.length) {
    throw new RequestPolicyError(`Target hostname did not resolve: ${hostname}`);
  }

  for (const record of records) {
    if (!allowPrivateAddress && isBlockedIpAddress(record.address)) {
      throw new RequestPolicyError(`Target host resolves to a blocked address: ${record.address}`);
    }
  }

  // Every address this hostname resolved to was checked above. Hand all of them
  // back (not just the first) so the pinned dispatcher in fetchWithTimeout() can
  // still fail over between them without dialing an address the loop did not see.
  return { url: parsed.toString(), addresses: records };
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function browserUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
}

// fetch() resolves DNS itself when it connects, a separate lookup from the one
// assertTargetUrlAllowed() validated. An attacker-controlled hostname could
// answer differently between the two (DNS rebinding): public during the check,
// then 127.0.0.1 or a cloud metadata address when fetch() dials. Pinning the
// validated address(es) into a per-call dispatcher means the socket can only go
// somewhere the guard looked at.
function createPinnedDispatcher(addresses) {
  return new UndiciAgent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, addresses.map((record) => ({ address: record.address, family: record.family })));
      }
    }
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, policyOptions = {}) {
  // One deadline across every redirect hop; a fresh timer per hop would let a
  // chain of slow redirects hold a concurrency slot for MAX_REDIRECTS x timeoutMs.
  const deadline = Date.now() + timeoutMs;
  let { url: nextUrl, addresses } = await assertTargetUrlAllowed(url, policyOptions);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Request timed out");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let response;
    try {
      response = await fetch(nextUrl, {
        ...options,
        signal: controller.signal,
        redirect: "manual",
        dispatcher: createPinnedDispatcher(addresses)
      });
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }

    if (!isRedirectStatus(response.status)) {
      // Deliberately not cleared here: the caller reads the body (see
      // readResponseBuffer) after this returns, and the same timer must still abort a
      // body trickled past timeoutMs, not just a slow connect/headers wait. Firing
      // after the body is read is a harmless no-op.
      return response;
    }

    clearTimeout(timeout);
    if (redirects >= MAX_REDIRECTS) {
      throw new RequestPolicyError("Too many redirects");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new RequestPolicyError("Redirect response is missing a Location header");
    }

    await response.body?.cancel?.();
    const previousUrl = nextUrl;
    ({ url: nextUrl, addresses } = await assertTargetUrlAllowed(new URL(location, nextUrl).toString(), policyOptions));
    options = redirectedRequestOptions(options, response.status, previousUrl, nextUrl);
  }

  throw new RequestPolicyError("Too many redirects");
}

// What the fetch spec does on a followed redirect: 303 (and 301/302 after a
// POST) becomes a bodiless GET, and credentials do not cross to another origin.
function redirectedRequestOptions(options, status, fromUrl, toUrl) {
  const method = String(options.method || "GET").toUpperCase();
  const toGet = (status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST");
  const crossOrigin = new URL(fromUrl).origin !== new URL(toUrl).origin;
  if (!toGet && !crossOrigin) {
    return options;
  }
  const drop = new Set([
    ...(toGet ? ["content-type", "content-length", "content-encoding", "content-language", "content-location"] : []),
    ...(crossOrigin ? ["authorization", "cookie", "proxy-authorization"] : [])
  ]);
  const headers = {};
  for (const [name, value] of new Headers(options.headers || {}).entries()) {
    if (!drop.has(name)) {
      headers[name] = value;
    }
  }
  return toGet ? { ...options, method: "GET", body: undefined, headers } : { ...options, headers };
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

async function readResponseBuffer(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestPolicyError(`Response body exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.byteLength > maxBytes) {
      throw new RequestPolicyError(`Response body exceeds ${maxBytes} bytes`);
    }
    return fallback;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new RequestPolicyError(`Response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, received);
}

async function readJsonResponse(response, label, maxBytes = Math.min(MAX_RESPONSE_BYTES, 2 * 1024 * 1024)) {
  if (!response.ok) {
    const detail = await readErrorResponseDetail(response);
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  // A 2xx means the provider accepted the request; for a paid provider it may
  // already have billed us whether or not the body reads. See providerBillingContext.
  const billing = providerBillingContext.getStore();
  if (billing) {
    billing.billed = true;
  }

  const text = (await readResponseBuffer(response, maxBytes)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON content`);
  }
}

async function readErrorResponseDetail(response) {
  try {
    const text = (await readResponseBuffer(response, Math.min(MAX_RESPONSE_BYTES, 4096))).toString("utf8").trim();
    if (!text) {
      return "";
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.detail === "string") {
        return parsed.detail;
      }
      if (Array.isArray(parsed.detail)) {
        return parsed.detail
          .map((item) => item?.msg || item?.message || JSON.stringify(item))
          .filter(Boolean)
          .join("; ");
      }
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
    } catch {
      // Fall through to plain text.
    }
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

// The per-client key for spend accounting is req.ip, not the x-genai-client-id
// header used for job ownership, which the client chooses and could rotate per
// request. req.ip honours `trust proxy`. spendClientKey() folds IPv6 to its /64;
// see spend-guard.js.
function getSpendClientKey(req) {
  return spendClientKey(req.ip || req.socket?.remoteAddress || "");
}

function buildImageSearchResponse(query, selected, limit) {
  return {
    sourceUrl: `image-search:${query}`,
    title: `Image search: ${query}`,
    items: selected.items.slice(0, limit),
    meta: {
      method: `image_search_${selected.provider}`,
      warnings: selected.warnings
    }
  };
}

function buildSearchCacheKey(provider, query, limit) {
  return `${provider} ${query.toLowerCase()} ${limit}`;
}

function getCachedSearchResult(key) {
  if (!SEARCH_CACHE_MAX) {
    return null;
  }
  const entry = searchResultCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    searchResultCache.delete(key);
    return null;
  }
  // Re-insert so the Map's insertion order is LRU order, then hand back a
  // detached copy — the route slices and the caller must never mutate the entry.
  searchResultCache.delete(key);
  searchResultCache.set(key, entry);
  return cloneSearchSelection(entry.selected);
}

function storeSearchResult(key, selected) {
  if (!SEARCH_CACHE_MAX || !SEARCH_CACHE_TTL_MS || !selected?.items?.length) {
    return;
  }
  searchResultCache.set(key, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    selected: cloneSearchSelection(selected)
  });
  while (searchResultCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchResultCache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    searchResultCache.delete(oldest);
  }
}

function cloneSearchSelection(selected) {
  return {
    provider: selected.provider,
    warnings: [...(selected.warnings || [])],
    items: selected.items.map((item) => ({ ...item }))
  };
}

async function searchImages(query, limit) {
  const provider = getImageSearchProvider();
  if (provider === "custom") {
    return {
      provider,
      warnings: [],
      items: await searchImagesViaCustomEndpoint(query, limit)
    };
  }
  if (provider === "serper") {
    return {
      provider,
      warnings: [],
      items: await searchImagesViaSerper(query, limit)
    };
  }
  if (provider === "brave") {
    return {
      provider,
      warnings: [],
      items: await searchImagesViaBrave(query, limit)
    };
  }

  return {
    provider: "ddg",
    warnings: ["DuckDuckGo image search is an unofficial no-key fallback and may break if the page shape changes."],
    items: await searchImagesViaDuckDuckGo(query, limit)
  };
}

async function searchImagesViaCustomEndpoint(query, limit) {
  if (!getStringSetting("IMAGE_SEARCH_ENDPOINT")) {
    throw new ProviderConfigError("IMAGE_SEARCH_ENDPOINT is required for IMAGE_SEARCH_PROVIDER=custom");
  }
  const endpoint = new URL(getStringSetting("IMAGE_SEARCH_ENDPOINT"));
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("limit", String(limit));
  if (isMuseumSafeEnabled()) {
    endpoint.searchParams.set("safe", "1");
  }
  const response = await fetchWithTimeout(
    endpoint.toString(),
    {
      headers: {
        "user-agent": browserUserAgent(),
        "accept": "application/json"
      }
    },
    REQUEST_TIMEOUT_MS,
    {
      applyHostAllowlist: false,
      allowPrivateAddress: true,
      allowNonStandardPort: true
    }
  );
  const payload = await readJsonResponse(response, "Custom image search endpoint");
  return normalizeImageSearchPayload(payload, limit);
}

// --- the curated pool ------------------------------------------------------
//
// A batch is mostly images drawn from the pre-baked pack plus one or two
// guaranteed-new ones, interleaved and indistinguishable in the response. A
// slot's key must be built from the same values the provider would have been
// sent for that slot.

function logGenAiPoolStartup() {
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

function planGenAiPoolBatch({ prompt, negativePrompt, count, sourceRecord, batchSeed }) {
  const growRound = grownGenAiPool.active
    ? poolGrowthRound({ prompt, negativePrompt, sourceRecord, bookmarkPrompts: GENAI_BOOKMARK_PROMPTS })
    : 0;
  if (!genAiPool.active && !growRound) {
    return null;
  }
  const pool = genAiPool;
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

  // While every generator slot is busy, a fresh image costs this visitor a
  // 20-40 s wait in the queue, so the pool covers every slot it can.
  const plan = planPoolDraw({
    poolSize: reusable,
    count,
    newCount: isGenAiQueueFull() ? 0 : Math.min(count, randomGenAiPoolFreshQuota())
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
    drawFor
  };
}

// Every record drawn from one member file shares one Buffer and one WebP, so a
// pooled sphere costs the image store nothing however many visitors are shown
// it. Bounded by bytes: a grown pool has no fixed size.
const poolMemberBytes = new Map();
let poolMemberBytesTotal = 0;
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

  for (const entry of genAiPool.entries?.values() || []) {
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
      dir: genAiPool.dir,
      active: Boolean(genAiPool.active),
      error: genAiPool.error || "",
      missingFiles: genAiPool.missingFiles || 0,
      keyCount: genAiPool.entries?.size || 0,
      totalMembers,
      grownMembers,
      memberCount: genAiPool.memberCount || 0,
      suppressedCount: genAiPool.suppressedCount || 0
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
function genAiPoolLogDetails(poolBatch) {
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
function growGenAiPool(slot, items) {
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
    if (genAiPool.byId?.has(address) || poolMemberCount(genAiPool, slot.key) >= GENAI_POOL_GROW_MAX_PER_KEY) {
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
    genAiPool = rebuildGenAiPool();
    logApiQuery("pool.grown", { key: slot.key, id: address, round: slot.grow, depth: poolMemberCount(genAiPool, slot.key) });
  }
}

// A pooled image enters the same store as a generated one and is served by the
// same /api/genai/image/:id route, so the client needs no change and cannot
// tell them apart. That matters beyond tidiness: chording a pooled image varies
// from ITS bytes, whose content address is the sourceKey its own baked
// variations were keyed on.
function storePooledGenAiItem(slot, { prompt, sourceRecord }) {
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
function completeGenAiBatchFromPool({ poolBatch, fromIndex, delivered, prompt, sourceRecord }) {
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

async function generateImages({ prompt, negativePrompt, count, sourceRecord = null, seed = null }) {
  const provider = getGenAiProvider();
  if (provider === "disabled") {
    throw new ProviderConfigError("GENAI_ENDPOINT is not configured");
  }
  const effectiveNegativePrompt = withMuseumSafeNegativePrompt(negativePrompt);
  let selected;

  if (provider === "drawthings" || provider === "a1111") {
    selected = {
      provider,
      warnings: [],
      items: sourceRecord ? await varyImagesViaSdApi({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count,
        sourceRecord,
        seed,
        modifierSeed: seed,
        modifierIndexBase: 0
      }) : await generateImagesViaSdApi({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count,
        seed
      })
    };
  } else if (provider === "fal") {
    selected = {
      provider,
      warnings: [],
      items: sourceRecord ? await varyImagesViaFal({
        prompt,
        count,
        sourceRecord,
        seed,
        modifierSeed: seed,
        modifierIndexBase: 0
      }) : await generateImagesViaFal({
        prompt,
        count,
        seed
      })
    };
  } else if (provider === "custom" || provider === "relay") {
    selected = {
      provider,
      warnings: [],
      items: await generateImagesViaCustomEndpoint({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count,
        sourceRecord,
        seed
      })
    };
  } else {
    throw new ProviderConfigError(`Unsupported GENAI_PROVIDER: ${provider}`);
  }

  return sourceRecord
    ? { ...selected, items: [...buildGenAiLineageItems(sourceRecord), ...selected.items] }
    : selected;
}

// `count` is the BATCH size, always, even when the pool covers most of it:
// `poolSlots[index] === null` is the only thing that decides whether slot index
// is generated. The loop index therefore still drives the modifier salt and the
// strength ramp, which is what keeps a generated image aligned with the pool key
// its slot was drawn against.
async function generateImagesProgressive({
  prompt,
  negativePrompt,
  count,
  sourceRecord = null,
  seed = null,
  shouldCancel = null,
  onItems = null,
  batchSeed = null,
  poolSlots = null
}) {
  const provider = getGenAiProvider();
  if (provider === "disabled") {
    throw new ProviderConfigError("GENAI_ENDPOINT is not configured");
  }

  const effectiveNegativePrompt = withMuseumSafeNegativePrompt(negativePrompt);
  const selected = {
    provider,
    warnings: [],
    items: [
      ...(sourceRecord ? buildGenAiLineageItems(sourceRecord) : []),
      ...(poolSlots || []).filter((slot) => slot.preDelivered).map((slot) => slot.preDelivered)
    ]
  };
  // The pool planner had to choose each slot's modifier before this ran, so it
  // hands the seed it used back in rather than letting a second one be minted.
  const baseSeed = batchSeed ?? seed ?? createGenAiSeed();
  const strengths = sourceRecord ? getVariationStrengthRamp(count) : [];

  for (let index = 0; index < count; index += 1) {
    if (typeof shouldCancel === "function" && shouldCancel()) {
      throw new GenAiAbortError("GenAI job cancelled");
    }
    if (poolSlots?.[index]?.preDelivered) {
      onItems?.([], index);
      continue;
    }
    let nextItems;
    const nextSeed = sourceRecord && getGenAiVarySeedMode() === "fixed"
      ? baseSeed
      : baseSeed + index;
    const pooledSlot = poolSlots?.[index]?.pooled ? poolSlots[index] : null;
    if (pooledSlot) {
      nextItems = [storePooledGenAiItem(pooledSlot, { prompt, sourceRecord })];
    } else if (provider === "drawthings" || provider === "a1111") {
      nextItems = sourceRecord
        ? await varyImagesViaSdApi({
          provider,
          prompt,
          negativePrompt: effectiveNegativePrompt,
          count: 1,
          sourceRecord,
          seed: nextSeed,
          strengths: [strengths[index]],
          modifierSeed: baseSeed,
          modifierIndexBase: index
        })
        : await generateImagesViaSdApi({
          provider,
          prompt,
          negativePrompt: effectiveNegativePrompt,
          count: 1,
          seed: nextSeed
        });
    } else if (provider === "fal") {
      nextItems = sourceRecord
        ? await varyImagesViaFal({
          prompt,
          count: 1,
          sourceRecord,
          seed: nextSeed,
          strengths: [strengths[index]],
          modifierSeed: baseSeed,
          modifierIndexBase: index
        })
        : await generateImagesViaFal({
          prompt,
          count: 1,
          seed: nextSeed
        });
    } else if (provider === "custom" || provider === "relay") {
      nextItems = await generateImagesViaCustomEndpoint({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count: 1,
        sourceRecord,
        seed: nextSeed
      });
    } else {
      throw new ProviderConfigError(`Unsupported GENAI_PROVIDER: ${provider}`);
    }
    if (!pooledSlot && poolSlots?.[index]?.grow) {
      growGenAiPool(poolSlots[index], nextItems);
    }

    selected.items.push(...nextItems);
    if (typeof onItems === "function") {
      onItems(nextItems, index);
    }
  }

  return selected;
}

async function generateImagesViaSdApi({ provider, prompt, negativePrompt, count, seed = null }) {
  if (count > 1) {
    const baseSeed = seed ?? createGenAiSeed();
    const items = [];
    for (let index = 0; index < count; index += 1) {
      const generated = await generateImagesViaSdApi({
        provider,
        prompt,
        negativePrompt,
        count: 1,
        seed: baseSeed + index
      });
      items.push(...generated);
    }
    return items.slice(0, count);
  }

  const endpoint = resolveGenAiEndpoint(provider);
  const requestSeed = seed ?? createGenAiSeed();
  const body = {
    prompt,
    negative_prompt: negativePrompt,
    width: getIntegerSetting("GENAI_WIDTH"),
    height: getIntegerSetting("GENAI_HEIGHT"),
    batch_size: count,
    seed: requestSeed
  };
  if (getOptionalIntegerSetting("GENAI_STEPS") !== null) {
    body.steps = getOptionalIntegerSetting("GENAI_STEPS");
  }
  if (getOptionalNumberSetting("GENAI_CFG_SCALE") !== null) {
    body.cfg_scale = getOptionalNumberSetting("GENAI_CFG_SCALE");
  }
  addDrawThingsGuidanceEmbed(provider, body);

  const response = await fetchWithTimeout(
    buildSdApiUrl(endpoint, "txt2img"),
    {
      method: "POST",
      headers: genAiJsonHeaders(),
      body: JSON.stringify(body)
    },
    getIntegerSetting("GENAI_TIMEOUT_MS"),
    {
      applyHostAllowlist: false,
      allowPrivateAddress: true,
      allowNonStandardPort: true
    }
  );
  const payload = await readJsonResponse(response, `${getGenAiProviderLabel(provider)} txt2img`, getGenAiResponseMaxBytes());
  const info = parseSdApiInfo(payload.info);
  return normalizeGenAiPayload(payload.images || payload, {
    limit: count,
    provider,
    prompt,
    seeds: getSdApiSeeds(info, requestSeed, count),
    width: getIntegerSetting("GENAI_WIDTH"),
    height: getIntegerSetting("GENAI_HEIGHT"),
    parentId: null,
    strength: null
  });
}

async function varyImagesViaSdApi({ provider, prompt, negativePrompt, count, sourceRecord, seed = null, strengths = null, modifierSeed = null, modifierIndexBase = 0 }) {
  const endpoint = resolveGenAiEndpoint(provider);
  const strengthRamp = Array.isArray(strengths) ? strengths : getVariationStrengthRamp(count);
  const items = [];
  const baseSeed = seed ?? createGenAiSeed();
  const fixedSeed = getGenAiVarySeedMode() === "fixed";
  // Keep the batch modifier stable even when the request carries no seed: fall
  // back to this call's baseSeed so all variations pick the same emoji.
  const effectiveModifierSeed = modifierSeed ?? baseSeed;
  const width = sourceRecord.width || getIntegerSetting("GENAI_WIDTH");
  const height = sourceRecord.height || getIntegerSetting("GENAI_HEIGHT");

  for (const strength of strengthRamp) {
    const requestSeed = fixedSeed ? baseSeed : baseSeed + items.length;
    const { prompt: effectivePrompt, modifier } = composeVaryModifier({
      basePrompt: prompt,
      sourceRecord,
      seed: effectiveModifierSeed,
      salt: modifierIndexBase + items.length
    });
    const body = {
      prompt: effectivePrompt,
      negative_prompt: negativePrompt,
      width,
      height,
      batch_size: 1,
      seed: requestSeed,
      init_images: [sourceRecord.buffer.toString("base64")],
      denoising_strength: strength
    };
    if (getOptionalIntegerSetting("GENAI_STEPS") !== null) {
      body.steps = getOptionalIntegerSetting("GENAI_STEPS");
    }
    if (getOptionalNumberSetting("GENAI_CFG_SCALE") !== null) {
      body.cfg_scale = getOptionalNumberSetting("GENAI_CFG_SCALE");
    }
    addDrawThingsGuidanceEmbed(provider, body);

    const response = await fetchWithTimeout(
      buildSdApiUrl(endpoint, "img2img"),
      {
        method: "POST",
        headers: genAiJsonHeaders(),
        body: JSON.stringify(body)
      },
      getIntegerSetting("GENAI_TIMEOUT_MS"),
      {
        applyHostAllowlist: false,
        allowPrivateAddress: true,
        allowNonStandardPort: true
      }
    );
    const payload = await readJsonResponse(response, `${getGenAiProviderLabel(provider)} img2img`, getGenAiResponseMaxBytes());
    const info = parseSdApiInfo(payload.info);
    const normalized = await normalizeGenAiPayload(payload.images || payload, {
      limit: 1,
      provider,
      // Store the base lineage prompt (not the modifier-composed sent prompt):
      // genai.prompt is re-fired via txt2img if the cached image expires, and a
      // stored prompt of just "🧊" would regenerate nonsense. The actually-sent
      // string is recorded in modifier.sentPrompt.
      prompt,
      seeds: getSdApiSeeds(info, requestSeed, 1),
      width,
      height,
      parentId: sourceRecord.id,
      strength,
      modifier
    });
    items.push(...normalized);
  }

  return items.slice(0, count);
}

async function generateImagesViaFal({ prompt, count, seed = null }) {
  if (!getFalApiKey()) {
    throw new ProviderConfigError("GENAI_API_KEY or FAL_KEY is required for GENAI_PROVIDER=fal");
  }

  const capabilities = getFalModelCapabilities();
  // No source here, so the configured box IS the requested shape; it is still
  // raised to Fal's minimum, preserving that shape (a square box stays square).
  const imageSize = resolveFalRequestImageSize(null, null);
  const input = {
    prompt,
    image_size: imageSize,
    num_images: count,
    output_format: "png"
  };
  if (seed !== null) {
    input.seed = seed;
  }
  addFalOptionalInputs(input, capabilities, "text");

  const payload = await callFalModel(capabilities.textModel, input, "fal txt2img");
  return normalizeGenAiPayload(payload.images || payload, {
    limit: count,
    provider: "fal",
    prompt: payload.prompt || prompt,
    seeds: normalizeFalSeeds(payload.seed, count),
    // fal's per-image safety verdict. A flagged image is shown but never pooled.
    providerFlags: payload.has_nsfw_concepts,
    // Fallback only: storeGenAiImageSource measures the returned bytes.
    width: imageSize.width,
    height: imageSize.height,
    parentId: null,
    strength: null
  });
}

async function varyImagesViaFal({ prompt, count, sourceRecord, seed = null, strengths = null, modifierSeed = null, modifierIndexBase = 0 }) {
  if (!getFalApiKey()) {
    throw new ProviderConfigError("GENAI_API_KEY or FAL_KEY is required for GENAI_PROVIDER=fal");
  }

  const sourceBytes = sourceRecord.buffer?.byteLength ?? 0;
  if (sourceBytes > FAL_VARY_MAX_SOURCE_BYTES) {
    throw new GenAiSourceTooLargeError(
      `source image too large for hosted vary (${sourceBytes} bytes > ${FAL_VARY_MAX_SOURCE_BYTES} byte cap)`
    );
  }

  const capabilities = getFalModelCapabilities();
  const isKlein = capabilities.id === "flux2-klein-4b";
  const strengthRamp = Array.isArray(strengths) ? strengths : getVariationStrengthRamp(count);
  const variationCount = isKlein ? count : strengthRamp.length;
  const items = [];
  // Same source for every variation in this call, so resolve the edit size and
  // the (possibly rescaled) source bytes once. Klein-only: see
  // resolveFalKleinEditImageSize for why an explicit image_size is sent at all.
  const kleinEditImageSize = isKlein ? resolveFalKleinEditImageSize(sourceRecord) : null;
  const editSource = kleinEditImageSize
    ? await raiseFalEditSourceToRequestSize(sourceRecord, kleinEditImageSize)
    : sourceRecord;
  const editSourceBytes = editSource.buffer.byteLength;
  if (editSourceBytes > FAL_VARY_MAX_SOURCE_BYTES) {
    throw new GenAiSourceTooLargeError(
      `source image too large for hosted vary (${editSourceBytes} bytes > ${FAL_VARY_MAX_SOURCE_BYTES} byte cap)`
    );
  }
  const sourceDataUrl = `data:${editSource.contentType};base64,${editSource.buffer.toString("base64")}`;
  // Fallback dimensions only — storeGenAiImageSource measures what comes back.
  // The requested edit size beats the source's when they differ (they do
  // whenever the hosted floor raised the request).
  const width = kleinEditImageSize?.width || sourceRecord.width || getIntegerSetting("GENAI_WIDTH");
  const height = kleinEditImageSize?.height || sourceRecord.height || getIntegerSetting("GENAI_HEIGHT");
  const baseSeed = seed ?? createGenAiSeed();
  const fixedSeed = getGenAiVarySeedMode() === "fixed";
  // Keep the batch modifier stable even when the request carries no seed: fall
  // back to this call's baseSeed so all variations pick the same emoji.
  const effectiveModifierSeed = modifierSeed ?? baseSeed;

  for (let index = 0; index < variationCount; index += 1) {
    // Klein edit does not expose FLUX.1's denoising-strength control. Keep the
    // existing seed/modifier variation path, but store null rather than invent
    // a false close→divergent ordering in lineage metadata.
    const strength = isKlein ? null : strengthRamp[index];
    const { prompt: effectivePrompt, modifier } = composeVaryModifier({
      basePrompt: prompt,
      sourceRecord,
      seed: effectiveModifierSeed,
      salt: modifierIndexBase + items.length,
      // No strength dial on this endpoint, so the emoji cannot be the whole
      // prompt — it would have nothing holding it to the source.
      style: capabilities.varyStrengthControl ? null : "append"
    });
    const input = isKlein
      ? {
        prompt: effectivePrompt,
        image_urls: [sourceDataUrl],
        image_size: kleinEditImageSize,
        num_images: 1,
        output_format: "png"
      }
      // FLUX.1 dev image-to-image derives output size from the input image; adding
      // image_size here is untested against its schema and risks a 422.
      : {
        prompt: effectivePrompt,
        image_url: sourceDataUrl,
        strength,
        num_images: 1,
        output_format: "png"
      };
    input.seed = fixedSeed ? baseSeed : baseSeed + items.length;
    addFalOptionalInputs(input, capabilities, "image");

    const payload = await callFalModel(capabilities.imageModel, input, "fal img2img");
    const normalized = await normalizeGenAiPayload(payload.images || payload, {
      limit: 1,
      provider: "fal",
      // Store the base lineage prompt (not the modifier-composed sent prompt, and
      // not the provider's echoed prompt which is the sent one): genai.prompt is
      // re-fired via txt2img on cache expiry. The sent string is in
      // modifier.sentPrompt.
      prompt,
      seeds: normalizeFalSeeds(payload.seed, 1),
      providerFlags: payload.has_nsfw_concepts,
      width,
      height,
      parentId: sourceRecord.id,
      strength,
      modifier
    });
    items.push(...normalized);
  }

  return items.slice(0, count);
}

async function callFalModel(model, input, label) {
  const response = await fetchWithTimeout(
    buildFalModelUrl(model),
    {
      method: "POST",
      headers: {
        "authorization": `Key ${getFalApiKey()}`,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify(input)
    },
    getIntegerSetting("GENAI_TIMEOUT_MS"),
    {
      applyHostAllowlist: false,
      allowPrivateAddress: true,
      allowNonStandardPort: true
    }
  );
  return readJsonResponse(response, label, getGenAiResponseMaxBytes());
}

function buildFalModelUrl(model) {
  const base = getStringSetting("GENAI_FAL_BASE_URL").replace(/\/+$/, "");
  return `${base}/${model.replace(/^\/+/, "")}`;
}

function addFalOptionalInputs(input, capabilities, mode) {
  if (capabilities.id === "flux2-klein-4b") {
    // Fal Klein is a distilled four-step model. Its documented schema has no
    // guidance_scale field, and omitting steps deliberately selects its model
    // default rather than leaking the shared Draw Things/FLUX.1 setting.
    if (getBooleanSetting("GENAI_MUSEUM_SAFE")) {
      input.enable_safety_checker = true;
    }
    return;
  }
  const configuredSteps = getOptionalIntegerSetting("GENAI_STEPS");
  if (configuredSteps !== null) {
    // FLUX.1 dev img2img rejects fewer than 10 steps. Local Draw Things can
    // use much lower values, so preserve the shared setting but make this one
    // hosted request provider-safe rather than returning a 422.
    const minSteps = mode === "image" && capabilities.imageModel === FAL_FLUX_DEV_IMAGE_TO_IMAGE_MODEL
      ? FAL_FLUX_DEV_IMAGE_TO_IMAGE_MIN_STEPS
      : 1;
    input.num_inference_steps = Math.max(configuredSteps, minSteps);
  }
  if (getOptionalNumberSetting("GENAI_CFG_SCALE") !== null) {
    input.guidance_scale = getOptionalNumberSetting("GENAI_CFG_SCALE");
  }
  if (getBooleanSetting("GENAI_MUSEUM_SAFE")) {
    input.enable_safety_checker = true;
  }
}

function normalizeFalSeeds(seed, count) {
  if (Array.isArray(seed)) {
    return seed;
  }
  if (seed === undefined || seed === null) {
    return [];
  }
  return Array.from({ length: count }, (_, index) => Number(seed) + index);
}

// Fal Klein edit does not derive output size from the input image as its docs
// implied: a 320x256 source came back 1120x896 (~1 MP at the source's aspect
// ratio), so Klein normalizes to its own ~1 MP budget. An explicit image_size is
// therefore sent on every Klein edit request instead of trusting that inference.
//
// A generated source that matches the box comes back unchanged; an imported
// arbitrary-aspect web/search source is fitted inside the box instead of being
// squashed. The fitting policy lives in server/images.js, shared with the import
// resize.
//
// Measure the source buffer's actual pixel dimensions rather than trusting
// stored metadata: sourceRecord.width/height is inherited from its parent at
// store time and may not reflect what a provider returned for that buffer.
// detectRasterImage reads the real header; fall back to the stored metadata,
// then to null ("no usable dimensions" for resolveFalRequestImageSize).
function resolveFalKleinEditImageSize(sourceRecord) {
  const measured = measureRasterImageSize(sourceRecord?.buffer);
  const sourceWidth = measured?.width || Number(sourceRecord?.width) || null;
  const sourceHeight = measured?.height || Number(sourceRecord?.height) || null;
  return resolveFalRequestImageSize(sourceWidth, sourceHeight);
}

// The one size policy for every hosted Fal request: the source's aspect fitted
// inside the configured box, raised to Fal's per-endpoint minimum when the box
// sits under it, 64-aligned throughout. With no measurable source (text2img,
// or an unreadable header) the box itself supplies the shape so its aspect
// survives the raise.
function resolveFalRequestImageSize(sourceWidth, sourceHeight) {
  const boxWidth = getIntegerSetting("GENAI_WIDTH");
  const boxHeight = getIntegerSetting("GENAI_HEIGHT");
  return fitImageSizeToBox(sourceWidth || boxWidth, sourceHeight || boxHeight, boxWidth, boxHeight, {
    minWidth: FAL_MIN_IMAGE_WIDTH,
    minHeight: FAL_MIN_IMAGE_HEIGHT,
    maxPixels: GENAI_MAX_REQUEST_PIXELS
  });
}

// Fal's `image_too_small` 422 is documented against "the provided image
// dimensions", and on an edit endpoint that is the inlined source as much as the
// requested image_size, so satisfy both. Only upward: a source already at or
// above the request size is sent untouched, so a Fal-generated source never pays
// for a decode. The rescale is per-request and in memory; the stored record keeps
// its own pixel size because it is shared with the local Draw Things path, which
// answers 422 when an init image disagrees with the declared width/height.
async function raiseFalEditSourceToRequestSize(sourceRecord, requestSize) {
  const measured = measureRasterImageSize(sourceRecord?.buffer);
  const sourceWidth = measured?.width || Number(sourceRecord?.width) || 0;
  const sourceHeight = measured?.height || Number(sourceRecord?.height) || 0;
  if (!sourceWidth || !sourceHeight) {
    // Unreadable header: sharp would fail on it too. Send it as stored and let
    // the provider be the one to reject it.
    return sourceRecord;
  }
  if (sourceWidth >= requestSize.width && sourceHeight >= requestSize.height) {
    return sourceRecord;
  }
  try {
    return await resizeRasterImageToSize(sourceRecord.buffer, requestSize);
  } catch (err) {
    throw new RequestPolicyError(err.message);
  }
}

function measureRasterImageSize(buffer) {
  try {
    const detected = detectRasterImage(buffer);
    return detected ? { width: detected.width, height: detected.height } : null;
  } catch {
    // Malformed or pathological header: treat as unmeasurable.
    return null;
  }
}

async function generateImagesViaCustomEndpoint({ provider, prompt, negativePrompt, count, sourceRecord = null, seed = null }) {
  const endpoint = resolveGenAiEndpointValue(provider);
  if (!endpoint) {
    throw new ProviderConfigError("GENAI_ENDPOINT is required for GenAI mode");
  }

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: genAiJsonHeaders(),
      body: JSON.stringify({
        prompt,
        negativePrompt,
        count,
        seed,
        source: sourceRecord ? { id: sourceRecord.id } : undefined
      })
    },
    REQUEST_TIMEOUT_MS,
    {
      applyHostAllowlist: false,
      allowPrivateAddress: true,
      allowNonStandardPort: true
    }
  );
  const payload = await readJsonResponse(response, "GenAI endpoint", getGenAiResponseMaxBytes());
  return normalizeGenAiPayload(payload, {
    limit: count,
    provider,
    prompt,
    seeds: [],
    width: null,
    height: null,
    parentId: sourceRecord?.id || null,
    strength: null
  });
}

function resolveGenAiEndpoint(provider) {
  const endpoint = resolveGenAiEndpointValue(provider);
  if (endpoint) {
    return endpoint;
  }
  throw new ProviderConfigError(`GENAI_ENDPOINT is required for GENAI_PROVIDER=${provider}`);
}

function resolveGenAiEndpointValue(provider) {
  return getProviderEndpoint(provider)
    || getLegacyGenAiEndpoint(provider)
    || DEFAULT_GENAI_ENDPOINTS[provider]
    || "";
}

function getLegacyGenAiEndpoint(provider) {
  const endpoint = getStringSetting("GENAI_ENDPOINT");
  if (!endpoint) {
    return "";
  }
  // Back-compat for old env-only setups: GENAI_PROVIDER=a1111 + GENAI_ENDPOINT=...
  // should keep working. But once the settings UI saves a provider, that provider
  // choice should not inherit an unrelated legacy endpoint from .env or an older
  // settings file.
  if (DEFAULT_GENAI_ENDPOINTS[provider] && getSettingSource("GENAI_PROVIDER") === "override") {
    return "";
  }
  return endpoint;
}

function getProviderEndpoint(provider) {
  const key = getProviderEndpointSettingKey(provider);
  return key ? getStringSetting(key) : "";
}

function getLayerProviderEndpoint(readRawSetting, provider) {
  const key = getProviderEndpointSettingKey(provider);
  return key ? getLayerStringSetting(readRawSetting, key) : "";
}

function getProviderEndpointSettingKey(provider) {
  if (provider === "drawthings") {
    return "GENAI_DRAWTHINGS_ENDPOINT";
  }
  if (provider === "a1111") {
    return "GENAI_A1111_ENDPOINT";
  }
  if (provider === "custom" || provider === "relay") {
    return "GENAI_CUSTOM_ENDPOINT";
  }
  return "";
}

function buildSdApiUrl(endpoint, route) {
  const parsed = new URL(endpoint);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/sdapi/v1/${route}`)) {
    return parsed.toString();
  }
  if (path.endsWith("/sdapi/v1")) {
    parsed.pathname = `${path}/${route}`;
  } else {
    parsed.pathname = `${path}/sdapi/v1/${route}`;
  }
  return parsed.toString();
}

function genAiJsonHeaders() {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json"
  };
  if (getGenAiApiKey()) {
    headers.authorization = `Bearer ${getGenAiApiKey()}`;
  }
  return headers;
}

function parseSdApiInfo(rawInfo) {
  if (!rawInfo) {
    return {};
  }
  if (typeof rawInfo === "object") {
    return rawInfo;
  }
  try {
    return JSON.parse(String(rawInfo));
  } catch {
    return {};
  }
}

function normalizeGenAiSource(rawSource) {
  if (!rawSource || typeof rawSource !== "object") {
    return null;
  }
  const id = firstString(rawSource.id);
  return id ? { id } : null;
}

function getGenAiProviderLabel(provider) {
  return provider === "drawthings" ? "Draw Things" : "A1111";
}

function createGenAiSeed() {
  return randomInt(0, 2 ** 32);
}

function getSdApiSeeds(info, requestSeed, count) {
  if (Array.isArray(info.all_seeds) && info.all_seeds.length > 0) {
    return info.all_seeds;
  }
  if (info.seed !== undefined && info.seed !== null) {
    return Array.from({ length: count }, (_, index) => Number(info.seed) + index);
  }
  return Array.from({ length: count }, (_, index) => requestSeed + index);
}

function addDrawThingsGuidanceEmbed(provider, body) {
  if (provider !== "drawthings") {
    return;
  }
  const guidanceEmbed = getOptionalNumberSetting("GENAI_DRAWTHINGS_GUIDANCE_EMBED");
  if (guidanceEmbed !== null) {
    body.guidance_embed = guidanceEmbed;
  }
}

function getVariationStrengthRamp(count) {
  const min = Math.min(getNumberSetting("GENAI_VARIATION_STRENGTH_MIN"), getNumberSetting("GENAI_VARIATION_STRENGTH_MAX"));
  const max = Math.max(getNumberSetting("GENAI_VARIATION_STRENGTH_MIN"), getNumberSetting("GENAI_VARIATION_STRENGTH_MAX"));
  if (count <= 1) {
    return [roundStrength(min)];
  }
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    return roundStrength(min + ((max - min) * t));
  });
}

function roundStrength(value) {
  return Math.round(value * 1000) / 1000;
}

async function searchImagesViaSerper(query, limit) {
  if (!getStringSetting("SERPER_API_KEY")) {
    throw new ProviderConfigError("SERPER_API_KEY is required for IMAGE_SEARCH_PROVIDER=serper");
  }
  const response = await fetchWithTimeout(
    "https://google.serper.dev/images",
    {
      method: "POST",
      headers: {
        "X-API-KEY": getStringSetting("SERPER_API_KEY"),
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({
        q: query,
        num: limit,
        ...(isMuseumSafeEnabled() ? { safe: "active" } : {})
      })
    },
    REQUEST_TIMEOUT_MS,
    { applyHostAllowlist: false }
  );
  const payload = await readJsonResponse(response, "Serper image search");
  return normalizeImageSearchPayload(payload.images || payload.results || payload, limit);
}

async function searchImagesViaBrave(query, limit) {
  if (!getStringSetting("BRAVE_SEARCH_API_KEY")) {
    throw new ProviderConfigError("BRAVE_SEARCH_API_KEY is required for IMAGE_SEARCH_PROVIDER=brave");
  }
  const endpoint = new URL("https://api.search.brave.com/res/v1/images/search");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", String(limit));
  endpoint.searchParams.set("safesearch", "strict");
  const response = await fetchWithTimeout(
    endpoint.toString(),
    {
      headers: {
        "X-Subscription-Token": getStringSetting("BRAVE_SEARCH_API_KEY"),
        "accept": "application/json"
      }
    },
    REQUEST_TIMEOUT_MS,
    { applyHostAllowlist: false }
  );
  const payload = await readJsonResponse(response, "Brave image search");
  return normalizeImageSearchPayload(payload.results || payload.images || payload, limit);
}

async function searchImagesViaDuckDuckGo(query, limit) {
  const searchUrl = new URL("https://duckduckgo.com/");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("iax", "images");
  searchUrl.searchParams.set("ia", "images");
  if (isMuseumSafeEnabled()) {
    searchUrl.searchParams.set("kp", "1");
  }

  const searchResponse = await fetchWithTimeout(
    searchUrl.toString(),
    {
      headers: {
        "user-agent": browserUserAgent(),
        "accept": "text/html,application/xhtml+xml"
      }
    },
    REQUEST_TIMEOUT_MS,
    { applyHostAllowlist: false }
  );
  if (!searchResponse.ok) {
    throw new Error(`DuckDuckGo token request returned HTTP ${searchResponse.status}`);
  }
  const html = (await readResponseBuffer(searchResponse, Math.min(MAX_RESPONSE_BYTES, 2 * 1024 * 1024))).toString("utf8");
  const vqd = extractDuckDuckGoVqd(html);
  if (!vqd) {
    throw new Error("DuckDuckGo image token was not found");
  }

  const imageUrl = new URL("https://duckduckgo.com/i.js");
  imageUrl.searchParams.set("l", "us-en");
  imageUrl.searchParams.set("o", "json");
  imageUrl.searchParams.set("q", query);
  imageUrl.searchParams.set("vqd", vqd);
  imageUrl.searchParams.set("f", ",,,");
  if (isMuseumSafeEnabled()) {
    imageUrl.searchParams.set("p", "1");
  }

  const imageResponse = await fetchWithTimeout(
    imageUrl.toString(),
    {
      headers: {
        "user-agent": browserUserAgent(),
        "accept": "application/json",
        "referer": searchUrl.toString()
      }
    },
    REQUEST_TIMEOUT_MS,
    { applyHostAllowlist: false }
  );
  const payload = await readJsonResponse(imageResponse, "DuckDuckGo image search");
  return normalizeImageSearchPayload(payload.results || payload, limit);
}

function extractDuckDuckGoVqd(html) {
  const patterns = [
    /vqd=['"]([^'"]+)['"]/i,
    /vqd=([^&"']+)/i,
    /"vqd"\s*:\s*"([^"]+)"/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function normalizeImageSearchPayload(payload, limit) {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.items || payload?.images || payload?.results || [];
  const items = [];
  const seenImages = new Map();

  for (const candidate of candidates) {
    if (items.length >= limit) {
      break;
    }
    const item = normalizeImageSearchItem(candidate);
    if (!item || !isAllowedImageUrl(item.imageUrl)) {
      continue;
    }
    if (item.linkUrl && !isAllowedLink(item.linkUrl)) {
      item.linkUrl = null;
    }
    if (isDuplicateImageReference(item.imageUrl, item.linkUrl, seenImages)) {
      continue;
    }
    if (!passesDimensionHeuristic(item.imageUrl, item.linkUrl, item.width, item.height)) {
      continue;
    }
    items.push(item);
  }

  return items;
}

function normalizeImageSearchItem(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const properties = candidate.properties && typeof candidate.properties === "object"
    ? candidate.properties
    : {};
  const thumbnail = candidate.thumbnail && typeof candidate.thumbnail === "object"
    ? candidate.thumbnail
    : {};

  const imageUrl = firstString(
    candidate.imageUrl,
    candidate.image,
    properties.url,
    thumbnail.src,
    thumbnail.url,
    candidate.thumbnailUrl,
    candidate.thumbnail
  );
  const linkUrl = firstString(
    candidate.link,
    candidate.linkUrl,
    candidate.url,
    candidate.source,
    candidate.sourceUrl,
    candidate.hostPageUrl,
    properties.source
  );

  if (!imageUrl) {
    return null;
  }

  return {
    imageUrl,
    linkUrl: linkUrl && linkUrl !== imageUrl ? linkUrl : null,
    width: parseDimension(firstString(candidate.imageWidth, candidate.width, properties.width)),
    height: parseDimension(firstString(candidate.imageHeight, candidate.height, properties.height))
  };
}

async function normalizeGenAiPayload(payload, context) {
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
function describeImportedWebImage(imageUrl, pageUrl) {
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

function storeImportedGenAiImage({ source, prompt, width, height, origin }) {
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

function storeGenAiImageSource({ source, context }) {
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
  const genai = {
    id,
    prompt: context.prompt,
    seed: context.seed,
    strength: context.strength,
    parentId: context.parentId
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
      now
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

function saveGeneratedImageFile({ id, source, prompt, now }) {
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
    return fileName;
  } catch (err) {
    console.warn(`Could not save generated image ${id}: ${err.message}`);
    return null;
  }
}

function pruneGeneratedImageFiles(now = Date.now(), { includeSession = false } = {}) {
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

function generatedImageFilePath(fileName) {
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

function getStoredGenAiImage(id) {
  pruneGenAiImageStore();
  const record = genAiImageStore.get(id);
  if (!record) {
    return null;
  }
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

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    const str = String(value).trim();
    if (str) {
      return str;
    }
  }
  return null;
}

async function extractViaHtmlFetch(sourceUrl, limit) {
  const response = await fetchWithTimeout(sourceUrl, {
    headers: {
      "user-agent": browserUserAgent(),
      "accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const html = (await readResponseBuffer(response)).toString("utf8");
  const parsed = parseHtmlForImages(html, sourceUrl, limit);
  return {
    title: parsed.title,
    items: parsed.items,
    method: "html_fetch"
  };
}

function parseHtmlForImages(html, sourceUrl, limit) {
  const $ = loadHtml(html);
  const title = $("title").first().text().trim() || sourceUrl;
  const items = [];
  const seenImages = new Map();

  $("img").each((_, img) => {
    if (items.length >= limit * 3) {
      return false;
    }

    const srcCandidate = pickImageSource($, img);
    if (!srcCandidate) {
      return;
    }

    const imageUrl = resolveUrl(srcCandidate, sourceUrl);
    if (!imageUrl || !isAllowedImageUrl(imageUrl)) {
      return;
    }

    const linkHref = $(img).closest("a").attr("href");
    const resolvedLink = linkHref
      ? resolveUrl(linkHref, sourceUrl)
      : cardLinkFor($, img, sourceUrl);
    const linkUrl = resolvedLink && isAllowedLink(resolvedLink) ? resolvedLink : null;
    const width = parseDimension($(img).attr("width"));
    const height = parseDimension($(img).attr("height"));

    if (isDuplicateImageReference(imageUrl, linkUrl, seenImages)) {
      return;
    }

    if (!passesDimensionHeuristic(imageUrl, linkUrl, width, height)) {
      return;
    }

    const anchor = $(img).closest("a");
    items.push({
      imageUrl,
      linkUrl,
      width,
      height,
      alt: imageLabel($(img).attr("alt") || anchor.attr("title") || anchor.attr("aria-label"))
    });
  });

  return { title, items: items.slice(0, limit) };
}

// The card link: many sites put the image beside the story link and stretch
// that link over the whole card with CSS, so the image has no <a> ancestor even
// though clicking it follows the story. Walk up a few levels to the nearest
// container holding exactly one distinct link and use it; a container with
// several different links is a list of stories, not a card, so the walk stops
// there. Mirrored in extractViaPlaywright().
const CARD_LINK_MAX_DEPTH = 4;
// What a render may hand back per string. Longer URLs are dropped, not cut: a
// cut URL would fetch something else.
const RENDER_MAX_URL_CHARS = 4096;
const RENDER_MAX_TEXT_CHARS = 1000;

// A page's alt text is its author's to make huge; this is a caption.
function imageLabel(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function cardLinkFor($, img, sourceUrl) {
  let el = $(img).parent();
  for (let depth = 0; depth < CARD_LINK_MAX_DEPTH && el.length; depth += 1) {
    const links = new Set();
    el.find("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (href && !href.startsWith("#")) {
        const resolved = resolveUrl(href, sourceUrl);
        if (resolved) {
          links.add(resolved);
        }
      }
    });
    if (links.size === 1) {
      return links.values().next().value;
    }
    if (links.size > 1) {
      return null;
    }
    el = el.parent();
  }
  return null;
}

function pickImageSource($, img) {
  const src = $(img).attr("src");
  if (src) {
    return src.trim();
  }
  const dataSrc = $(img).attr("data-src");
  if (dataSrc) {
    return dataSrc.trim();
  }
  const srcSet = $(img).attr("srcset");
  if (!srcSet) {
    return null;
  }
  const first = srcSet.split(",")[0]?.trim();
  if (!first) {
    return null;
  }
  return first.split(" ")[0]?.trim() || null;
}

function parseDimension(value) {
  if (!value) {
    return null;
  }
  const parsed = Number(String(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed);
}

function resolveUrl(candidate, baseUrl) {
  if (!candidate) {
    return null;
  }
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function isAllowedImageUrl(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const ext = fileExtension(parsed.pathname);
    if (ext && EXCLUDED_CONTENT_EXTENSIONS.has(ext)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isAllowedLink(linkUrl) {
  try {
    const parsed = new URL(linkUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const ext = fileExtension(parsed.pathname);
    return !(ext && EXCLUDED_CONTENT_EXTENSIONS.has(ext));
  } catch {
    return false;
  }
}

function fileExtension(pathname) {
  const idx = pathname.lastIndexOf(".");
  if (idx < 0) {
    return null;
  }
  return pathname.slice(idx).toLowerCase();
}

function passesDimensionHeuristic(imageUrl, linkUrl, width, height) {
  const linked = Boolean(linkUrl) && linkUrl !== imageUrl;
  if (isLikelyFaviconUrl(imageUrl)) {
    return false;
  }
  if (width === null || height === null) {
    // An unlinked SVG with no size is almost always a CSS-sized library icon. A
    // linked one may be navigation; the proxy refuses it if its own size is
    // icon-small (SVG_MIN_EDGE_PX in images.js).
    return linked || !isSvgUrl(imageUrl);
  }
  const minDim = linked ? 24 : 128;
  return width > minDim && height > minDim;
}

function isSvgUrl(imageUrl) {
  try {
    return /\.svgz?$/i.test(new URL(imageUrl).pathname) || /^data:image\/svg/i.test(imageUrl);
  } catch {
    return false;
  }
}

function isLikelyFaviconUrl(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    return /(^|\/)favicon(?:[-_.][^/]*)?\.(?:ico|png|gif|jpe?g|webp)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

// As the Java original: an image repeated under different links (a nav icon,
// a "more" arrow) is kept for its first MAX_LINKS_PER_IMAGE links only.
const MAX_LINKS_PER_IMAGE = 2;

function isDuplicateImageReference(imageUrl, linkUrl, seenImages) {
  const linked = Boolean(linkUrl) && linkUrl !== imageUrl;
  let seen = seenImages.get(imageUrl);
  if (!seen) {
    seen = { unlinked: false, links: new Set() };
    seenImages.set(imageUrl, seen);
  }
  if (!linked) {
    if (seen.unlinked) {
      return true;
    }
    seen.unlinked = true;
    return false;
  }
  if (seen.links.has(linkUrl) || seen.links.size >= MAX_LINKS_PER_IMAGE) {
    return true;
  }
  seen.links.add(linkUrl);
  return false;
}

const PLAYWRIGHT_SCROLL_STEPS = 4;
const PLAYWRIGHT_SCROLL_WAIT_MS = 400;
const PLAYWRIGHT_SETTLE_MS = 3000;
// Covers context creation, navigation, scrolling and collection together.
const PLAYWRIGHT_RENDER_DEADLINE_MS = 25000;
const PLAYWRIGHT_IDLE_CLOSE_MS = 60000;
// Each sub-request is buffered in Node (up to MAX_RESPONSE_BYTES) before it is
// fulfilled, and a page can fire hundreds at once.
const PLAYWRIGHT_UPSTREAM_CONCURRENCY = 6;

function isPlaywrightEnabled() {
  return process.env.PLAYWRIGHT_ENABLED !== "0";
}

const sharedChromium = createSharedBrowser({
  idleMs: PLAYWRIGHT_IDLE_CLOSE_MS,
  launch: async () => {
    let playwright;
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error("playwright package is not installed");
    }
    return playwright.chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  }
});

// Chromium's network, served from Node: fetchWithTimeout validates and pins
// every redirect hop, and the HTML fetch's timeout and size caps apply.
async function fetchForRender(url, { method, headers, body }) {
  const response = await fetchWithTimeout(url, { method, headers, body }, REQUEST_TIMEOUT_MS);
  const buffer = await readResponseBuffer(response, MAX_RESPONSE_BYTES);
  return { url: response.url || url, status: response.status, headers: response.headers, body: buffer };
}

async function extractViaPlaywright(sourceUrl, limit) {
  if (!isPlaywrightEnabled()) {
    throw new Error("PLAYWRIGHT_ENABLED=0");
  }

  const browser = await sharedChromium.acquire();
  let context = null;
  try {
    return await withRenderDeadline(
      (deadline) => renderWithContext(deadline),
      PLAYWRIGHT_RENDER_DEADLINE_MS,
      () => context?.close()
    );
  } finally {
    await context?.close().catch(() => {});
    sharedChromium.release();
  }

  async function renderWithContext(deadline) {
    const created = await browser.newContext({
      ...CONTEXT_LOCKDOWN_OPTIONS,
      userAgent: browserUserAgent()
    });
    if (deadline.expired) {
      await created.close().catch(() => {});
      throw new Error("Render timed out");
    }
    context = created;
    const routing = await routeContextThroughNode(context, {
      fetchUpstream: fetchForRender,
      maxInFlight: PLAYWRIGHT_UPSTREAM_CONCURRENCY
    });
    const page = await context.newPage();

    // Node already followed any redirect chain; a second goto() puts the page
    // on the final URL and is answered from the kept response.
    let target = sourceUrl;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      routing.expectGoto();
      let gotoError = null;
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS });
      } catch (err) {
        gotoError = err;
      }
      if (routing.navigationError instanceof RequestPolicyError) {
        throw routing.navigationError;
      }
      if (routing.redirectTo && attempt === 0) {
        target = routing.redirectTo;
        continue;
      }
      if (gotoError) {
        // Node's error ("Request timed out") says more than ERR_BLOCKED_BY_CLIENT.
        throw routing.navigationError || gotoError;
      }
      break;
    }
    // Scroll a few screens and back: lazy loaders only fill in images that have
    // come near the viewport.
    for (let i = 0; i < PLAYWRIGHT_SCROLL_STEPS; i += 1) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(PLAYWRIGHT_SCROLL_WAIT_MS);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    // Collect only once the lazy images have loaded: an unloaded image has no natural
    // size and fails the size filter, which made the count vary with network timing.
    await page.waitForLoadState("networkidle", { timeout: PLAYWRIGHT_SETTLE_MS }).catch(() => {});

    const { title, items } = await page.evaluate(({ cap, maxDepth, maxLinksPerImage, maxUrl, maxText }) => {
      // Every string goes through the init script's clip (playwright-render.js),
      // and `out` grows by index, not push: the page may have patched both.
      const clip = window.__sbClip;
      if (typeof clip !== "function") {
        return { title: "", items: [] };
      }
      const url = (value) => (clip(value, maxUrl + 1).length > maxUrl ? "" : clip(value, maxUrl));
      // cardLinkFor(), in the page.
      const cardLink = (img) => {
        let el = img.parentElement;
        for (let depth = 0; depth < maxDepth && el; depth += 1) {
          const links = new Set();
          for (const a of el.querySelectorAll("a[href]")) {
            if (!clip(a.getAttribute("href"), 1).startsWith("#")) {
              links.add(url(a.href));
            }
          }
          if (links.size === 1) {
            return [...links][0];
          }
          if (links.size > 1) {
            return null;
          }
          el = el.parentElement;
        }
        return null;
      };
      const out = [];
      const seen = new Set();
      const linkCounts = new Map();
      for (const img of document.querySelectorAll("img")) {
        if (out.length >= cap * 3) {
          break;
        }

        const imageUrl = url(img.currentSrc) || url(img.src) || url(img.getAttribute("src")) || url(img.getAttribute("data-src"));
        if (!imageUrl) {
          continue;
        }

        const anchor = img.closest("a");
        const linkUrl = url(anchor?.href) || url(cardLink(img));
        // Unary + rather than Number(), which the page can replace.
        const width = +(img.naturalWidth || img.getAttribute("width")) || null;
        const height = +(img.naturalHeight || img.getAttribute("height")) || null;
        const linked = Boolean(linkUrl) && linkUrl !== imageUrl;
        const key = linked ? `${imageUrl}::${linkUrl}` : imageUrl;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (linked) {
          const links = (linkCounts.get(imageUrl) || 0) + 1;
          if (links > maxLinksPerImage) {
            continue;
          }
          linkCounts.set(imageUrl, links);
        }

        const alt = clip(img.getAttribute("alt"), maxText) || clip(anchor?.getAttribute("title"), maxText)
          || clip(anchor?.getAttribute("aria-label"), maxText);
        out[out.length] = { imageUrl, linkUrl: linkUrl || null, width, height, alt };
      }
      return {
        title: clip(document.title, maxText) || url(document.location.href),
        items: out
      };
    }, {
      cap: limit,
      maxDepth: CARD_LINK_MAX_DEPTH,
      maxLinksPerImage: MAX_LINKS_PER_IMAGE,
      maxUrl: RENDER_MAX_URL_CHARS,
      maxText: RENDER_MAX_TEXT_CHARS
    });

    const sanitized = items
      .filter((item) => isAllowedImageUrl(item.imageUrl))
      .filter((item) => !item.linkUrl || isAllowedLink(item.linkUrl))
      .filter((item) => passesDimensionHeuristic(item.imageUrl, item.linkUrl, item.width, item.height))
      .slice(0, limit)
      .map((item) => ({ ...item, alt: imageLabel(item.alt) }));

    return {
      title: title || sourceUrl,
      items: sanitized,
      method: "playwright_fallback"
    };
  }
}
