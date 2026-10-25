import { load as loadHtml } from "cheerio";
import { PLACEHOLDER_IMAGE_NAME, TINY_DECLARED_EDGE_PX, declaredImageEdge, isPlaceholderImageUrl, isStandInImageSource } from "./image-url-filters.js";
import { hasNavigableUrlShape } from "../shared/url-shape.js";
import { clampNumber, parseNonNegativeInteger, parsePositiveInteger } from "./env.js";
import { RequestPolicyError, sendPolicyError } from "./errors.js";
import {
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  browserUserAgent,
  fetchWithTimeout,
  normalizeAndAssertTargetUrl,
  readResponseBuffer
} from "./net-policy.js";
import { logApiQuery } from "./query-log.js";
import { DEFAULT_LIMIT } from "./settings.js";
import {
  CHROMIUM_LAUNCH_OPTIONS,
  CONTEXT_LOCKDOWN_OPTIONS,
  createSharedBrowser,
  routeContextThroughNode,
  withRenderDeadline
} from "./playwright-render.js";

const DEFAULT_THRESHOLD = 5;

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

const EXCLUDED_CONTENT_EXTENSIONS = new Set([
  ".asf", ".avi", ".flv", ".m4v", ".mkv", ".mov", ".mp4", ".mpg", ".mpeg", ".swf", ".webm", ".wmv",
  ".atom", ".feed", ".rss", ".xml",
  ".csv", ".doc", ".docx", ".epub", ".odt", ".pdf", ".ppt", ".pptx", ".rtf", ".txt", ".xls", ".xlsx",
  ".7z", ".gz", ".rar", ".tar", ".zip",
  ".css", ".js", ".json", ".sql", ".yaml", ".yml",
  ".dll", ".exe", ".ico", ".iso", ".msi"
]);

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

export function extractCacheKey(sourceUrl, query) {
  const fallbackMode = normalizeFallback(query.fallback);
  if (!sourceUrl || EXTRACT_CACHE_TTL_MS <= 0 || fallbackMode === "force") {
    return null;
  }
  const limit = clampNumber(query.limit, 1, DEFAULT_LIMIT, DEFAULT_LIMIT);
  const threshold = clampNumber(query.threshold, 1, 30, DEFAULT_THRESHOLD);
  return `${sourceUrl}|${limit}|${threshold}|${fallbackMode}`;
}

export function readCachedExtract(key) {
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

export async function handleExtract(req, res) {
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

// Lazy-loading pages put a stand-in (a grey PNG, a 1px GIF, a data: URI) in
// `src` and the real image in data-src or srcset, so a stand-in loses to them.
function pickImageSource($, img) {
  const srcSet = $(img).attr("srcset");
  const candidates = [$(img).attr("src"), $(img).attr("data-src"), srcSet?.split(",")[0]?.trim().split(" ")[0]]
    .map((value) => value?.trim())
    .filter(Boolean);
  return candidates.find((value) => !isStandInImageSource(value)) || candidates[0] || null;
}

export function parseDimension(value) {
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

export function isAllowedImageUrl(imageUrl) {
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

export function isAllowedLink(linkUrl) {
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

export function passesDimensionHeuristic(imageUrl, linkUrl, width, height) {
  const linked = Boolean(linkUrl) && linkUrl !== imageUrl;
  if (isLikelyFaviconUrl(imageUrl) || isPlaceholderImageUrl(imageUrl)) {
    return false;
  }
  const declared = declaredImageEdge(imageUrl);
  if (declared !== null && declared <= TINY_DECLARED_EDGE_PX) {
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

export function isDuplicateImageReference(imageUrl, linkUrl, seenImages) {
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

export function isPlaywrightEnabled() {
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

    const { title, items } = await page.evaluate(({ cap, maxDepth, maxLinksPerImage, maxUrl, maxText, standInSource }) => {
      // Every string goes through the init script's clip (playwright-render.js),
      // and `out` grows by index, not push: the page may have patched both.
      const clip = window.__sbClip;
      if (typeof clip !== "function") {
        return { title: "", items: [] };
      }
      // A page could patch RegExp; the worst it gets is its own stand-in chosen,
      // which passesDimensionHeuristic() then drops.
      const standIn = new RegExp(standInSource, "i");
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

        // As pickImageSource(): a lazy page's stand-in loses to the real image.
        const sources = [img.currentSrc, img.src, img.getAttribute("src"), img.getAttribute("data-src")].map(url).filter(Boolean);
        const imageUrl = sources.find((value) => !standIn.test(value.split(/[?#]/)[0].split("/").pop())) || sources[0];
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
      maxText: RENDER_MAX_TEXT_CHARS,
      standInSource: PLACEHOLDER_IMAGE_NAME.source
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
