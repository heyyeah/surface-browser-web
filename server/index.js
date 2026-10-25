import "dotenv/config";
import express from "express";
import cors from "cors";
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setupStt, isSttEnabled } from "./stt.js";
import { recommendedStepsSummary } from "./model-profiles.js";
import {
  detectRasterImage,
  looksLikeSvg,
  rasterizeSvg,
  downscaleProxiedImage,
  PROXY_IMAGE_MAX_EDGE_PX,
  RASTER_MIN_EDGE_PX
} from "./images.js";
import { createImageDiskCache } from "./image-cache.js";
import { createGenAiPromptCache } from "./genai-prompt-cache.js";
import { createLiveMonitor, deviceFromUserAgent, parseReferrer, parseSessionId } from "./live-monitor.js";
import { Reader as MmdbReader } from "mmdb-lib";
import { createInFlightRequests } from "./in-flight.js";
import { createSpendGuard, createKillSwitch, spendClientKey } from "./spend-guard.js";
import { hasNavigableUrlShape } from "../shared/url-shape.js";
import {
  clampNumber,
  parseBoolean,
  parseCorsAllowedOrigins,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseTrustProxy,
  resolveFilePath
} from "./env.js";
import { ProviderConfigError, sendPolicyError } from "./errors.js";
import {
  ALLOWED_TARGET_HOSTS,
  browserUserAgent,
  fetchWithTimeout,
  normalizeAndAssertTargetUrl,
  normalizeUrl,
  readResponseBuffer
} from "./net-policy.js";
import {
  appendXrDiagLine,
  getApiQueryLogFilePath,
  getXrDiagLogFilePath,
  initQueryLog,
  logApiQuery
} from "./query-log.js";
import {
  HIDE_SETTINGS,
  SETTINGS_FILE_PATH,
  getBooleanSetting,
  getGenAiProvider,
  getGenAiSaveImagesToDisk,
  getIntegerSetting,
  getPublicSettings,
  getWristPanelHand,
  initSettings,
  isGenAiEnabled,
  replaceSettingsOverrides,
  validateSettingsUpdate
} from "./settings.js";
import { extractCacheKey, handleExtract, isPlaywrightEnabled, readCachedExtract } from "./extract.js";
import { handleImageSearch, initSearch, searchResultCache } from "./search.js";
import {
  genAiImageStore,
  genAiImageStoreBytes,
  generatedImageFilePath,
  getGenAiImageCacheMaxBytes,
  getGeneratedImagesDirDisplayPath,
  handleGenAiImage,
  handleGenAiSourceImport,
  listSavedGenAiImages,
  pruneGeneratedImageFiles
} from "./genai-store.js";
import { getGenAiVaryModifierPhraseMap } from "./genai-vary.js";
import { formatStartupSettingsSummary, runSettingsTest } from "./settings-test.js";
import {
  GENAI_POOL_DIR,
  GENAI_POOL_GROW_DAILY_CAP,
  GENAI_POOL_GROW_DIR,
  POOL_GROW_SPEND_KEY,
  handlePoolImage,
  handlePoolMembers,
  handlePoolReviewPage,
  handlePoolSuppress,
  initGenAiPoolRuntime,
  logGenAiPoolStartup,
  poolMemberBytesTotal
} from "./genai-pool-runtime.js";
import {
  genAiProgressJobs,
  genAiResultCache,
  handleCancelGenAiJob,
  handleGenAi,
  handleGenAiJob,
  initGenAiJobs,
  isGenAiQueueFull
} from "./genai-jobs.js";

const PORT = Number(process.env.PORT || 8788);
// Loopback by default: the Vite proxy and an adb-reversed headset arrive there,
// and anyone else on the network would otherwise spend the provider keys.
// BIND_HOST=0.0.0.0 opts in to direct LAN access. Behind a reverse proxy keep it
// loopback: a reachable port lets anyone forge X-Forwarded-For, which defeats
// TRUST_PROXY, every per-IP limit and the localhost check.
const BIND_HOST = (process.env.BIND_HOST || "").trim() || "127.0.0.1";
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
// /admin/live. Per-day counts persist here; visitors are memory only.
// QUERY_LOG_DAYS keeps each page, search and prompt for /admin/queries; the
// privacy text promises at most 7.
const liveMonitor = createLiveMonitor({
  statsPath: resolveFilePath(process.env.LIVE_STATS_PATH || new URL("./live-stats.json", import.meta.url)),
  queryLogPath: resolveFilePath(process.env.QUERY_LOG_PATH || new URL("./queries.jsonl", import.meta.url)),
  queryLogDays: Math.min(7, parseNonNegativeInteger(process.env.QUERY_LOG_DAYS, 3))
});
const liveSessionContext = new AsyncLocalStorage();
// An mmdb country database (DB-IP "IP to Country Lite", CC BY 4.0). Unset or
// unreadable = no countries. The address is looked up and dropped, never kept.
const geoIpReader = loadGeoIpReader(process.env.GEOIP_COUNTRY_DB);
// Part of the cache key, so changing the cap cannot serve images sized for the
// old one. The host allowlist is in it too: a hit skips the policy check, so
// tightening the list must not leave earlier images reachable.
const PROXY_IMAGE_CACHE_VARIANT = `edge${PROXY_IMAGE_MAX_EDGE_PX}|${[...ALLOWED_TARGET_HOSTS].sort().join(",")}`;
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
// The body limit allows 1 MB; a real diag event is well under 2 KB.
const XR_DIAG_MAX_LINE_CHARS = parsePositiveInteger(process.env.XR_DIAG_MAX_LINE_CHARS, 8192);
// Daily spend caps. All default to 0 = unlimited, which leaves the guard inert:
// no counting, no state file, no spend log. See server/spend-guard.js for why
// the unit counted is images/queries, not requests.
const SPEND_STATE_PATH = process.env.SPEND_STATE_PATH || new URL("./spend-state.json", import.meta.url);
const KILL_SWITCH_PATH = process.env.KILL_SWITCH_PATH || new URL("./KILL_SWITCH", import.meta.url);
const KILL_SWITCH_CACHE_MS = parseNonNegativeInteger(process.env.KILL_SWITCH_CACHE_MS, 5_000);
// Unset = no static serving, the dev shape (Vite serves the client and proxies
// /api here). Set it to a built dist/ and this process serves the whole app on
// its own.
const SERVE_STATIC_DIR = process.env.SERVE_STATIC_DIR ? path.resolve(process.env.SERVE_STATIC_DIR) : "";
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
const SETTINGS_TOKEN = process.env.SETTINGS_TOKEN || "";
initSettings();
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
  ipv6PrefixFactor: parseNonNegativeInteger(process.env.SPEND_IPV6_48_FACTOR, 4),
  onWarn: (message) => console.warn(message)
});
const killSwitch = createKillSwitch({
  filePath: resolveFilePath(KILL_SWITCH_PATH),
  cacheMs: KILL_SWITCH_CACHE_MS
});
const GENAI_BOOKMARK_PROMPTS = initGenAiPoolRuntime({ isGenAiQueueFull, genAiResultCache });
initQueryLog({ liveMonitor, liveSessionContext, bookmarkPrompts: GENAI_BOOKMARK_PROMPTS });
initSearch({ killSwitch, spendGuard, getSpendClientKey });
initGenAiJobs({ killSwitch, spendGuard, getSpendClientKey, genAiPromptCache });

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
app.use("/api", loopbackBrowserGuard);
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
    replaceSettingsOverrides(nextOverrides);
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
    if (Math.max(detected.width, detected.height) < RASTER_MIN_EDGE_PX) {
      logApiQuery("proxyImage.refused", { url: imageUrl, upstreamType: detected.contentType, bytes: buffer.length, error: "too small" });
      res.status(415).json({ error: "Image too small" });
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

app.get("/api/genai/image/:id", handleGenAiImage);

app.get("/api/genai/job/:id", handleGenAiJob);

app.delete("/api/genai/job/:id", handleCancelGenAiJob);

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
// Grown members (GENAI_POOL_GROW_DIR) are listed beside baked ones; any round
// past 1 can have been triggered by a visitor, hence the review.
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

// The images the piece made, with their prompts, from the saved copies
// (GENAI_SAVE_IMAGES_TO_DISK). Pooled draws are not saved, so they are absent;
// bookmark lineages are on /admin/pool.
app.get("/admin/generated", localOnlyGate, (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.type("html").send(fs.readFileSync(new URL("./generated-review.html", import.meta.url), "utf8"));
});

app.get("/admin/generated.json", localOnlyGate, (req, res) => {
  const hours = clampNumber(req.query.hours, 1, 24 * 30, 24);
  res.setHeader("cache-control", "no-store");
  res.json({ saving: getGenAiSaveImagesToDisk(), hours, items: listSavedGenAiImages(Date.now() - hours * 3600 * 1000) });
});

app.get("/admin/generated/image/:name", localOnlyGate, (req, res) => {
  const name = String(req.params.name || "");
  // Only names the listing hands out: no separators, no dot-dot.
  if (!/^[\w.-]+\.(png|jpg|webp|gif)$/.test(name) || name.includes("..")) {
    res.status(404).end();
    return;
  }
  const filePath = generatedImageFilePath(name);
  if (!fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.setHeader("cache-control", "private, max-age=3600");
  res.sendFile(filePath instanceof URL ? decodeURIComponent(filePath.pathname) : filePath);
});

// Where admin rows link to: the public site on the box, the Vite dev server here.
const ADMIN_APP_ORIGIN = (process.env.PUBLIC_APP_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");

app.get("/admin/queries", localOnlyGate, (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.type("html").send(fs.readFileSync(new URL("./queries-review.html", import.meta.url), "utf8"));
});

app.get("/admin/queries.json", localOnlyGate, (req, res) => {
  const hours = clampNumber(req.query.hours, 1, 24 * 7, 24);
  res.setHeader("cache-control", "no-store");
  res.json({
    days: liveMonitor.queryLogDays,
    hours,
    appOrigin: ADMIN_APP_ORIGIN,
    items: liveMonitor.queries(Date.now() - hours * 3600 * 1000)
  });
});

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
    geoIp: Boolean(geoIpReader),
    appOrigin: ADMIN_APP_ORIGIN,
    quota: quotaSnapshot()
  });
});

// Who is at their daily cap. The pool-grow bucket is a key like any client's,
// with its own limit.
function quotaSnapshot() {
  if (!spendGuard.active) {
    return null;
  }
  const spend = spendGuard.snapshot();
  const scope = (name) => ({
    used: spend[name].total,
    limit: spend.limits[name].global,
    perClient: spend.limits[name].ip,
    clients: spendGuard.clients(name).slice(0, 50).map(({ key, used }) => ({
      key,
      used,
      limit: name === "genai" && key === POOL_GROW_SPEND_KEY ? GENAI_POOL_GROW_DAILY_CAP : spend.limits[name].ip,
      country: key === POOL_GROW_SPEND_KEY ? "" : lookupCountry(key.replace(/\/64$/, ""))
    }))
  });
  return { day: spend.day, genai: scope("genai"), search: scope("search") };
}

// Under /api so loopbackBrowserGuard turns away a foreign page posting here
// while the admin tunnel is open.
app.post("/api/admin/quota/reset", localOnlyGate, (req, res) => {
  const scope = String(req.body?.scope || "");
  if (!["genai", "search"].includes(scope)) {
    res.status(400).json({ error: "scope must be genai or search" });
    return;
  }
  const result = spendGuard.reset(scope, String(req.body?.key || ""));
  if (!result.ok) {
    res.status(409).json({ error: "Spend guard is off on this server" });
    return;
  }
  logApiQuery("admin.quota_reset", { scope, client: req.body?.key ? "one" : "all", freed: result.freed });
  res.json({ ok: true, freed: result.freed, quota: quotaSnapshot() });
});

app.get("/admin/pool", poolReviewGate, handlePoolReviewPage);

app.get("/api/pool/members", poolReviewGate, handlePoolMembers);

app.get("/api/pool/image/:id", poolReviewGate, handlePoolImage);

app.post("/api/pool/suppress", poolReviewGate, handlePoolSuppress);

app.get("/api/extract", holdSlotUntilSettled(handleExtract));

app.get("/api/search/images", handleImageSearch);

app.post("/api/genai/source/import", holdSlotUntilSettled(handleGenAiSourceImport));

app.post("/api/genai", handleGenAi);

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

app.listen(PORT, BIND_HOST, () => {
  ensureStateDirectories();
  pruneGeneratedImageFiles(Date.now(), { includeSession: true });
  console.log(`Surface Browser MVP API listening on http://${BIND_HOST}:${PORT}`);
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

// The header is sent only for a listed origin, or with CORS_ALLOWED_ORIGINS
// unset for a loopback one (any port: the Vite dev server, a second local app).
// Others get no CORS header and the browser refuses the response, and a JSON
// request from them fails its preflight. Same-origin and non-browser callers
// send no Origin and are unaffected.
function buildCorsOptions() {
  return {
    origin(origin, callback) {
      callback(null, !origin || isAllowedOrigin(origin));
    }
  };
}

function isAllowedOrigin(origin) {
  if (CORS_ALLOWED_ORIGINS.size > 0) {
    return CORS_ALLOWED_ORIGINS.has(String(origin).replace(/\/+$/, "").toLowerCase());
  }
  return isLoopbackOrigin(origin);
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(String(origin));
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function hostFromHeader(host) {
  const value = String(host || "");
  return value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.replace(/:\d*$/, "");
}

function isLoopbackHostname(hostname) {
  const name = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

// A browser on this machine can reach a loopback port on behalf of any page it
// has open. CORS hides responses but not the request: a simple GET or text/plain
// POST still runs (spending provider keys, or using the loopback authority of
// isLocalRequest), and a DNS-rebound page is same-origin to us. So a request
// arriving over loopback must name a loopback Host, and must not come from a
// foreign page. Requests a reverse proxy forwards carry the visitor's address
// (TRUST_PROXY) and are not judged here.
function loopbackBrowserGuard(req, res, next) {
  if (!isLoopbackAddress(req.ip || req.socket?.remoteAddress)) {
    next();
    return;
  }
  // The raw Host header: req.hostname honours X-Forwarded-Host under trust
  // proxy, and a rebound page is same-origin, so it may set that header.
  if (!isLoopbackHostname(hostFromHeader(req.get("host")))) {
    res.status(403).json({ error: "Forbidden: loopback requests must use a localhost Host (behind a proxy, set TRUST_PROXY)" });
    return;
  }
  const origin = req.get("origin");
  // No Origin (a no-cors GET such as <img>): Sec-Fetch-Site still names a
  // foreign page. Same-site covers localhost:5173 -> localhost:8788.
  const foreign = origin === undefined
    ? req.get("sec-fetch-site") === "cross-site"
    : !isLoopbackOrigin(origin) && !isAllowedOrigin(origin);
  if (foreign) {
    res.status(403).json({ error: "Forbidden: cross-site request" });
    return;
  }
  next();
}

// spend.log lives next to query.log by default.
function resolveSpendLogPath() {
  if (process.env.SPEND_LOG_FILE) {
    return path.resolve(process.env.SPEND_LOG_FILE);
  }
  return path.join(path.dirname(getApiQueryLogFilePath()), "spend.log");
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
    device: deviceFromUserAgent(req.get("user-agent")),
    referrer: parseReferrer(req.get("x-referrer"))
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

function getSettingsMeta() {
  return {
    generatedImagesDir: getGeneratedImagesDirDisplayPath(),
    recommendedSteps: recommendedStepsSummary(),
    emojiTexts: getGenAiVaryModifierPhraseMap()
  };
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

// The per-client key for spend accounting is req.ip, not the x-genai-client-id
// header used for job ownership, which the client chooses and could rotate per
// request. req.ip honours `trust proxy`. spendClientKey() folds IPv6 to its /64;
// see spend-guard.js.
function getSpendClientKey(req) {
  return spendClientKey(req.ip || req.socket?.remoteAddress || "");
}
