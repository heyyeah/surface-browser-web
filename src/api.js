// API extraction and flat-mode result rendering.

import { state } from "./state.js";
import { DEBUG_UI } from "./config.js";
import { AppState, GENAI_MIN_TUNNEL_DISPLAY_MS } from "./constants.js";
import { urlInput, fallbackInput, extractLabel, resultsPanel, historyLabel } from "./dom.js";
import { runGenAiJob } from "./genai-client.js";
import { SESSION_HEADERS, SESSION_ID } from "./session-id.js";
import { appendImagePanels, setImagePanels } from "./tunnel.js";
import { loadedImageCopy } from "./proxied-texture.js";
import { prepareForTunnelRun } from "./transitions.js";
import { setAddressFeedback, setStatus, isImageListEnabled } from "./ui.js";
import { genAiBatchCount } from "./settings.js";
import { resetGenAiRequestLabels } from "./tunnel-progress.js";
import { genAiAddressText, resolveBackTarget } from "./navigation.js";
import { hasNavigableUrlShape, urlShapeReason } from "../shared/url-shape.js";
import { t } from "./i18n.js";

const GENAI_CLIENT_ID = SESSION_ID;
const activeLoadRequest = {
  generation: 0,
  controller: null,
  genAiJobId: null,
  // What the request is for, so Back can tell a new destination from a reload.
  // Null for a load Back itself started.
  target: null
};

function renderResults(items, method, warnings = []) {
  resultsPanel.textContent = "";

  // Gated off: don't build the rows at all rather than hiding them with CSS; the
  // panel lists every extracted source URL, which a public build should keep out
  // of the DOM.
  if (!isImageListEnabled()) {
    return;
  }

  if (DEBUG_UI) {
    const methodDiv = document.createElement("div");
    methodDiv.textContent = `Method: ${method}. Images: ${items.length}`;
    resultsPanel.appendChild(methodDiv);

    for (const warning of warnings) {
      const warningDiv = document.createElement("div");
      warningDiv.textContent = `Warning: ${warning}`;
      resultsPanel.appendChild(warningDiv);
    }
  }

  const shown = items.slice(0, 15);
  for (const [index, item] of shown.entries()) {
    const row = document.createElement("div");
    row.appendChild(describeItemNode(item, index, shown.length));
    // A generated image has no source page to travel to, and its own URL is already
    // the row's label, so there is nothing useful on the right.
    if (item.linkUrl && !item.genai) {
      row.appendChild(document.createTextNode(" -> "));
      row.appendChild(linkOrText(item.linkUrl, item.linkUrl));
    }
    row.className = "result-row";
    row.dataset.itemIndex = String(index);
    row.appendChild(resultActions(item, index));
    resultsPanel.appendChild(row);
  }
}

// Select does what selecting the image in the sphere does (follow its link, or
// vary a generated image), from wherever the viewer is.
function itemNavigationRequest(item) {
  if (item.navigationMode && item.navigationQuery) {
    return { mode: item.navigationMode, query: item.navigationQuery, source: item.navigationSource || null };
  }
  return item.linkUrl ? { mode: "url", query: item.linkUrl, source: null } : null;
}

function resultActions(item, index) {
  const actions = document.createElement("span");
  actions.className = "result-actions";
  const request = itemNavigationRequest(item);
  if (request) {
    const select = document.createElement("button");
    select.type = "button";
    select.textContent = t("results.select");
    select.addEventListener("click", () => {
      urlInput.value = request.mode === "genai" ? genAiAddressText(request.query, request.source?.stack) : request.query;
      setAddressFeedback(null);
      void loadRequestByMode(request);
    });
    actions.appendChild(select);
  }
  const wrap = document.createDocumentFragment();
  wrap.appendChild(actions);
  if (state.imageDownloadsEnabled) {
    const download = document.createElement("button");
    download.type = "button";
    download.className = "result-download";
    download.textContent = t("results.download");
    download.addEventListener("click", () => void downloadItemImage(item, index));
    wrap.appendChild(download);
  }
  return wrap;
}

// Through our own origin: a cross-origin <a download> is ignored and just opens
// the image. Web images come via the proxy, so at most PROXY_IMAGE_MAX_EDGE_PX.
// A blob, not a link, so no generated-image URL is handed out
// (GENAI_IMAGE_LIST_LINKS).
async function downloadItemImage(item, index) {
  const src = isOwnApiUrl(item.imageUrl)
    ? item.imageUrl
    : `/api/proxy/image?url=${encodeURIComponent(item.imageUrl)}`;
  try {
    const blob = await fetchImageBlob(src);
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${downloadBaseName(item, index)}.${blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 10_000);
  } catch (err) {
    setStatus(t("status.downloadFailed", { message: err.message }), "error");
  }
}

// Falls back to the copy the scene drew, as PNG: a generated image leaves the
// server's memory 30 minutes after its last use but stays on screen.
async function fetchImageBlob(src) {
  let failure;
  try {
    const response = await fetch(src, { headers: SESSION_HEADERS });
    if (response.ok) {
      return await response.blob();
    }
    failure = new Error(`HTTP ${response.status}`);
  } catch (err) {
    failure = err;
  }
  const image = loadedImageCopy(src);
  if (!image) {
    throw failure;
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    throw failure;
  }
  return blob;
}

function downloadBaseName(item, index) {
  const slug = (text) => String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (item.genai) {
    return `${slug(item.genai.prompt) || "generated"}-${index + 1}`;
  }
  try {
    return slug(new URL(item.imageUrl).pathname.split("/").pop().replace(/\.\w+$/, "")) || "image";
  } catch {
    return "image";
  }
}

// A generated image is described by how it was made, not where it lives. Its URL
// is `/api/genai/image/<random id>`, meaningless to read and shareable as a link
// to one specific image; the prompt, batch position and emoji are what matter.
// An extracted web image keeps its URL, which is public at its own origin.
// Same-origin API URLs only. Relative `/api/...` is what the server returns for
// generated images; the absolute form is checked too so a fully-qualified URL
// onto our own origin cannot slip past.
function isOwnApiUrl(url) {
  const value = String(url || "");
  if (value.startsWith("/api/")) {
    return true;
  }
  try {
    const parsed = new URL(value, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/");
  } catch {
    // Unparseable is not ours to serve, so it is not ours to gate.
    return false;
  }
}

// The emoji chain that made a generated image, oldest first.
function genAiItemStack(item) {
  return item.genai?.modifier?.stack?.length
    ? item.genai.modifier.stack
    : [item.genai?.modifier?.emoji].filter(Boolean);
}

function describeItemNode(item, index, total) {
  if (!item.genai) {
    return linkOrText(item.imageUrl, item.imageUrl, fileNameRange(item.imageUrl));
  }
  const prompt = item.genai.prompt || "generated";
  const from = state.genAiLineageOrdinal ? ` #${state.genAiLineageOrdinal}` : "";
  // Once there are emoji they identify an image, so the batch position is dropped
  // (`otters #3 🌹`, not `otters #3 (2/5) 🌹`). The stack is the accumulated chain
  // (buildVaryModifierStack on the server collects the lineage oldest-first), so a
  // third round shows the whole path.
  const stack = genAiItemStack(item);
  if (stack.length) {
    const label = `${prompt}${from} ${stack.join("")}`;
    return linkOrText(item.imageUrl, label, [0, label.length]);
  }
  // No emoji: a plain prompt batch, where position is all that tells images apart.
  const label = `${prompt}${from} (${index + 1}/${total})`;
  return linkOrText(item.imageUrl, label, [0, label.length]);
}

// The file name in an image URL: after the last "/" of the path, before any query.
// It is what turns white on the row of the image selected in the sphere.
function fileNameRange(url) {
  const end = url.search(/[?#]/) >= 0 ? url.search(/[?#]/) : url.length;
  const start = url.lastIndexOf("/", end - 1) + 1;
  return start > 0 && start < end && !url.slice(0, start).endsWith("//") ? [start, end] : null;
}

// GENAI_IMAGE_LIST_LINKS off makes a row inert text rather than hiding it, so
// nobody can hand out a URL that resolves to one specific generated image.
// Hiding the list entirely is the separate SHOW_IMAGE_LIST switch.
//
// It gates only our own API. An extracted web image and its source page are
// absolute URLs at someone else's origin: already public, not ours to serve. The
// /api/proxy/image rewrite happens at texture-load time (tunnel.js, sphere.js)
// and never reaches this list.
//
// The test is broader than the name: anything same-origin under /api/ is gated,
// so a future item type returning one of our URLs is covered automatically.
function linkOrText(href, label, nameRange = null) {
  if (isOwnApiUrl(href) && !state.imageListLinksEnabled) {
    const span = document.createElement("span");
    setLabel(span, label, nameRange);
    return span;
  }
  const anchor = document.createElement("a");
  anchor.href = href;
  setLabel(anchor, label, nameRange);
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  return anchor;
}

function setLabel(element, label, nameRange) {
  if (!nameRange) {
    element.textContent = label;
    return;
  }
  const [start, end] = nameRange;
  const name = document.createElement("span");
  name.className = "result-name";
  name.textContent = label.slice(start, end);
  element.append(label.slice(0, start), name, label.slice(end));
}

function requestIdentity(entry) {
  if (!entry) {
    return "";
  }
  return [
    entry.mode,
    entry.query,
    entry.source?.id || "",
    entry.cacheKey || ""
  ].join("\u0000");
}

function historyEntriesMatch(left, right) {
  return requestIdentity(left) === requestIdentity(right);
}

function isAbortError(err) {
  return err?.name === "AbortError";
}

function cancelActiveLoadRequest() {
  if (activeLoadRequest.controller) {
    activeLoadRequest.controller.abort();
  }
  if (activeLoadRequest.genAiJobId) {
    void fetch(`/api/genai/job/${encodeURIComponent(activeLoadRequest.genAiJobId)}`, {
      method: "DELETE"
    }).catch(() => {});
  }
  activeLoadRequest.controller = null;
  activeLoadRequest.genAiJobId = null;
}

function beginLoadRequest(mode, query, { source = null, recordHistory = true } = {}) {
  cancelActiveLoadRequest();
  // A load Back started is not a new destination: a second Back while it runs
  // must go further back, not return to the page it is leaving.
  activeLoadRequest.target = recordHistory ? { mode, query, source } : null;
  state.menuLoad = { mode, query, failed: false };
  activeLoadRequest.generation += 1;
  activeLoadRequest.controller = new AbortController();
  activeLoadRequest.genAiJobId = null;
  state.cycleRequestInFlight = true;
  // Progress is per request, not per live tunnel panel; this also covers cycle
  // reloads, whose tunnel scene is prepared before this fetch.
  state.tunnelSpawnedPanelCount = 0;
  // A stale error or label from a previous GenAI job must not bleed into this
  // request's footer. They are re-set below if this one fails too, and
  // loadGenAiPrompt re-sets the variation label from the one carried through the
  // sphere-exit handoff (read by restartCycleFromCurrentQuery before the reset).
  //
  // All the label fields are cleared together from one list in tunnel-progress.js.
  // `genAiLaunch` is the footer's first branch and names the img2img source; a
  // request that did not reset the tunnel would otherwise leave the previous input
  // describing this one.
  resetGenAiRequestLabels(state);
  return {
    generation: activeLoadRequest.generation,
    signal: activeLoadRequest.controller.signal
  };
}

function isCurrentLoadRequest(generation) {
  return activeLoadRequest.generation === generation && !activeLoadRequest.controller?.signal.aborted;
}

function markLoadFailed() {
  if (state.menuLoad) {
    state.menuLoad.failed = true;
  }
}

function finishLoadRequest(generation) {
  if (activeLoadRequest.generation !== generation) {
    return;
  }
  activeLoadRequest.controller = null;
  activeLoadRequest.genAiJobId = null;
  state.cycleRequestInFlight = false;
}

function setActiveGenAiJob(generation, jobId) {
  if (activeLoadRequest.generation === generation) {
    activeLoadRequest.genAiJobId = jobId || null;
  }
}

function sessionHistoryLabel(entry) {
  if (entry.mode === "image_search") {
    return `search:${entry.query}`;
  }
  if (entry.mode === "genai") {
    return `genai:${entry.query}`;
  }
  return entry.query;
}

function updateSessionHistoryPanel() {
  if (!historyLabel) {
    return;
  }
  const recent = state.sessionVisitLog.slice(-4).map(sessionHistoryLabel);
  historyLabel.textContent = recent.length ? `Visited: ${recent.join(" | ")}` : "";
}

function logVisitedRequest(mode, query) {
  const entry = {
    mode,
    query,
    at: new Date().toISOString()
  };
  state.sessionVisitLog.push(entry);
  if (state.sessionVisitLog.length > 80) {
    state.sessionVisitLog.splice(0, state.sessionVisitLog.length - 80);
  }
  console.info(`[Surface Browser] visited ${sessionHistoryLabel(entry)}`);
  updateSessionHistoryPanel();
}

// `stack` is client-only (the address bar's emoji); the server keeps only `id`.
function historySource(source) {
  if (!source?.id) {
    return null;
  }
  return source.stack?.length ? { id: source.id, stack: source.stack } : { id: source.id };
}

function rememberSuccessfulLoad(mode, query, recordHistory, metadata = {}) {
  const nextRequest = { mode, query, ...metadata };
  const previous = state.lastSuccessfulRequest;
  if (
    recordHistory
    && previous
    && !historyEntriesMatch(previous, nextRequest)
    && !historyEntriesMatch(state.navigationHistory[state.navigationHistory.length - 1], previous)
  ) {
    state.navigationHistory.push(previous);
  }

  state.currentLoadMode = mode;
  state.currentQuery = query;
  state.lastSuccessfulQuery = query;
  state.lastSuccessfulRequest = nextRequest;
  logVisitedRequest(mode, query);
}

function applyImagePayload({
  payload,
  mode,
  resolvedQuery,
  source = null,
  resetTunnel,
  recordHistory,
  requestGeneration = null,
  emptyStatusKey = "status.noImagesOnPage"
}) {
  if (requestGeneration !== null && !isCurrentLoadRequest(requestGeneration)) {
    return false;
  }

  const nextItems = normalizeClientItemsForMode(payload.items, mode, resolvedQuery);
  const linkedCount = nextItems.filter((item) => item.linkUrl).length;
  const navigableCount = nextItems.filter((item) => item.linkUrl || item.navigationMode).length;
  renderResults(nextItems, payload.meta?.method || mode, payload.meta?.warnings || []);
  extractLabel.textContent = `Source: ${payload.sourceUrl || resolvedQuery}`;

  if (nextItems.length === 0) {
    if (mode === "genai") {
      // Covers the synchronous GenAI fallback (no jobId; the server already resolved):
      // loadGenAiPrompt set genAiBatchComplete=false before the fetch and nothing else
      // would flip it back for this zero-item outcome.
      state.genAiBatchComplete = true;
      state.genAiJobError = t("status.noUsableImages");
      state.genAiJobErrorIsBudget = false;
    }
    markLoadFailed();
    setAddressFeedback("muted");
    setStatus(t(emptyStatusKey), "warning");
    return false;
  }

  if (resetTunnel) {
    prepareForTunnelRun();
  }

  // The server falls back to the URL when a page has no title; that is not one.
  // sourceUrl is the address the server resolved: a typed "example.org" has no
  // scheme, so the footer cannot read a domain out of the query itself.
  const pageTitle = mode === "url" ? String(payload.title || "").trim() : "";
  state.pageTitle = mode === "url"
    ? {
      query: resolvedQuery,
      sourceUrl: String(payload.sourceUrl || ""),
      text: /^https?:\/\//i.test(pageTitle) ? "" : pageTitle
    }
    : null;

  rememberSuccessfulLoad(
    mode,
    resolvedQuery,
    recordHistory,
    mode === "genai"
      ? {
        source: historySource(source),
        cacheKey: payload.meta?.genaiCacheKey || null
      }
      : {}
  );
  // Web / image-search transitions have no minimum-display floor. GenAI async
  // handoff is gated by job completeness; the sync fallback is already complete.
  if (mode !== "genai") {
    state.minTunnelDisplayUntilMs = 0;
    state.genAiBatchReceived = 0;
    state.genAiBatchExpected = 0;
    state.genAiBatchComplete = true;
  } else {
    state.genAiBatchReceived = nextItems.length;
    state.genAiBatchExpected = nextItems.length;
    state.genAiBatchComplete = true;
  }
  state.extractedItems = nextItems;
  setImagePanels(state.extractedItems);
  if (navigableCount === 0) {
    setAddressFeedback("muted");
    setStatus(t("status.loadedNoLinks", { count: state.extractedItems.length }), "warning");
  } else if (mode === "genai" && linkedCount === 0) {
    setAddressFeedback(null);
    setStatus(t("status.loadedGenerated", { count: state.extractedItems.length }), true);
  } else {
    setAddressFeedback(null);
    setStatus(t("status.loadedCandidates", { count: state.extractedItems.length }), true);
  }
  return true;
}

// The server refuses metered work with a bare `{ error: "budget", scope }`
// (spendGuard.reserve). `ip` (one visitor's daily share) and `daily` (the whole
// deployment's) need different sentences; any other scope is corrupt-state,
// failing closed for the day. Each points at running your own copy, the only
// way past the cap.
const BUDGET_STATUS_KEYS = { ip: "status.budget.ip", daily: "status.budget.daily" };
const BUDGET_NOTICE_MS = 20000;
const EXTRACT_BUSY_RETRY_MS = 1500;

function apiError(payload, fallback) {
  if (payload?.error !== "budget") {
    return new Error(payload?.error || fallback);
  }
  const key = BUDGET_STATUS_KEYS[payload.scope] || "status.budget.unavailable";
  const err = new Error(t(key, { repo: `${window.location.host}/git` }));
  err.budget = true;
  return err;
}

// Budget messages skip the "Error: …; keeping current scene" wrapper and stay
// up longer in the VR footer: they are the visitor's only explanation.
function reportLoadError(err) {
  const message = err instanceof Error ? err.message : String(err);
  setAddressFeedback("error");
  markLoadFailed();
  if (err?.budget) {
    setStatus(message, "error", { noticeMs: BUDGET_NOTICE_MS });
  } else {
    setStatus(t("status.error", { message }), "error");
  }
  return message;
}

function normalizeClientItemsForMode(items, mode, resolvedQuery) {
  const nextItems = Array.isArray(items) ? items.slice() : [];
  if (mode !== "genai") {
    return nextItems;
  }
  return nextItems.map((item, index) => ({
    ...item,
    navigationMode: "genai",
    navigationQuery: resolvedQuery,
    // `#3` answers "which of the prompt's variations did this branch come from", so
    // it is only meaningful when the parent batch was a plain prompt run, where
    // position is the only thing telling images apart. Once emoji are involved the
    // emoji identify the image, so an emoji item hands down the ordinal it already
    // carries.
    //
    // Three states: absent means "not from this list at all" (the AI chord on a
    // website image starts a fresh lineage) and must clear the ordinal rather than
    // inherit a stale one.
    //
    // Rides the existing source plumbing (item -> panel -> navigation request ->
    // loadGenAiPrompt). The server's normalizeGenAiSource() whitelists `id`, so the
    // extra keys are dropped on arrival.
    navigationSource: item.genai?.id
      ? {
        id: item.genai.id,
        ...(item.genai.modifier?.emoji
          ? { inheritOrdinal: true }
          : { ordinal: index + 1 }),
        ...(genAiItemStack(item).length ? { stack: genAiItemStack(item) } : {})
      }
      : null
  }));
}

async function loadApiCapabilities() {
  const response = await fetch("/api/health", { headers: SESSION_HEADERS });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "API health check failed");
  }
  return payload;
}

function applyGenAiProgressPayload({
  payload,
  resolvedQuery,
  source,
  recordHistory,
  lastItemCount,
  remembered,
  requestGeneration
}) {
  if (!isCurrentLoadRequest(requestGeneration)) {
    return { done: true, ok: false, lastItemCount, remembered };
  }

  if (payload.status === "failed" || payload.ok === false) {
    throw apiError(payload, "GenAI job failed");
  }

  const nextItems = normalizeClientItemsForMode(payload.items, "genai", resolvedQuery);
  const received = Number.isFinite(Number(payload.received)) ? Number(payload.received) : nextItems.length;
  const expected = Number.isFinite(Number(payload.expected)) ? Number(payload.expected) : Number(payload.count || nextItems.length);
  const done = payload.done === true || payload.meta?.complete === true || payload.status === "complete";
  state.genAiBatchReceived = received;
  state.genAiBatchExpected = expected;
  state.genAiBatchComplete = done && (expected <= 0 || received >= expected);

  renderResults(nextItems, payload.meta?.method || "genai", payload.meta?.warnings || []);
  extractLabel.textContent = `Source: ${payload.sourceUrl || resolvedQuery}`;

  // Progressive results only ever belong to the tunnel. If the scene has already
  // left it, a late poll result must not mutate state.extractedItems or append
  // panels, which would stack the straggler onto the formed sphere. The batch
  // completeness gate makes this window unreachable in practice; this is the
  // backstop.
  const inTunnel = state.appState === AppState.TUNNEL;
  if (inTunnel && nextItems.length > lastItemCount) {
    const newItems = nextItems.slice(lastItemCount);
    state.extractedItems = nextItems;
    appendImagePanels(newItems);
  }

  if (payload.status === "complete") {
    if (nextItems.length === 0) {
      // A "complete" job with zero items never satisfies the `received >= expected`
      // check above, so genAiBatchComplete would stay false and strand the footer on
      // a phantom "Generating..." readout.
      state.genAiBatchComplete = true;
      state.genAiJobError = t("status.noUsableImages");
      state.genAiJobErrorIsBudget = false;
      markLoadFailed();
      setAddressFeedback("muted");
      setStatus(t("status.noGeneratedKeeping"), "warning");
      return { done: true, ok: false, lastItemCount: nextItems.length, remembered };
    }
    if (!remembered) {
      rememberSuccessfulLoad("genai", resolvedQuery, recordHistory, {
        source: historySource(source),
        cacheKey: payload.meta?.genaiCacheKey || null
      });
      remembered = true;
    }
    if (!state.genAiBatchComplete) {
      setStatus(t("status.generatingProgress", { progress: `${received}/${expected || "?"}` }));
      return { done: false, ok: false, lastItemCount: nextItems.length, remembered };
    }
    setAddressFeedback(null);
    setStatus(t("status.loadedGenerated", { count: nextItems.length }), true);
    return { done: true, ok: true, lastItemCount: nextItems.length, remembered };
  }

  const targetCount = Number(payload.count || 0);
  const progressText = targetCount > 0
    ? `${nextItems.length}/${targetCount}`
    : String(nextItems.length);
  setStatus(t("status.generatingProgress", { progress: progressText }));
  return { done: false, ok: false, lastItemCount: nextItems.length, remembered };
}

async function loadAndExtractUrl({
  query = null,
  resetTunnel = true,
  cycleReload = false,
  recordHistory = true
} = {}) {
  const resolvedQuery = (query ?? urlInput.value ?? "").trim();
  if (!resolvedQuery) {
    setAddressFeedback("muted");
    setStatus(t("status.enterUrl"), "warning");
    return false;
  }
  if (!hasNavigableUrlShape(resolvedQuery)) {
    setAddressFeedback("muted");
    setStatus(t(`status.urlShape.${urlShapeReason(resolvedQuery)}`), "warning");
    return false;
  }

  if (urlInput.value !== resolvedQuery) {
    urlInput.value = resolvedQuery;
  }

  const request = beginLoadRequest("url", resolvedQuery, { recordHistory });
  setAddressFeedback(null);
  setStatus(t(cycleReload ? "status.reloading" : "status.extracting"));
  extractLabel.textContent = "";

  try {
    const fallbackMode = fallbackInput.checked ? "auto" : "none";
    const extractUrl = `/api/extract?url=${encodeURIComponent(resolvedQuery)}&limit=15&fallback=${fallbackMode}&threshold=5`;
    let response = await fetch(extractUrl, { signal: request.signal, headers: SESSION_HEADERS });
    // 503 is the server's own page-load slots, full for a second or so.
    if (response.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, EXTRACT_BUSY_RETRY_MS * (0.75 + Math.random() * 0.5)));
      if (!isCurrentLoadRequest(request.generation)) {
        return false;
      }
      response = await fetch(extractUrl, { signal: request.signal, headers: SESSION_HEADERS });
    }
    const payload = await response.json();
    if (!isCurrentLoadRequest(request.generation)) {
      return false;
    }
    if (!response.ok) {
      throw new Error(payload.error || "Extraction failed");
    }

    return applyImagePayload({
      payload,
      mode: "url",
      resolvedQuery,
      resetTunnel,
      recordHistory,
      requestGeneration: request.generation
    });
  } catch (err) {
    if (isAbortError(err) || !isCurrentLoadRequest(request.generation)) {
      return false;
    }
    reportLoadError(err);
    return false;
  } finally {
    finishLoadRequest(request.generation);
  }
}

async function loadGenAiPrompt({
  query = null,
  source = null,
  cacheKey = null,
  seed = null,
  // Client-only short origin label for an img2img run started from a selected image
  // (see sphere.js). Never sent to the server.
  variationLabel = "",
  resetTunnel = true,
  cycleReload = false,
  recordHistory = true
} = {}) {
  const resolvedQuery = (query ?? urlInput.value ?? "").trim();
  if (!resolvedQuery) {
    setAddressFeedback("muted");
    setStatus(t("status.enterPrompt"), "warning");
    return false;
  }

  // Set before the request. A fresh prompt, or a chord on a website image, is a
  // new lineage and must not inherit the last branch's "#3"; an emoji variation
  // keeps it.
  if (source?.ordinal) {
    state.genAiLineageOrdinal = source.ordinal;
  } else if (!source?.inheritOrdinal) {
    state.genAiLineageOrdinal = null;
  }

  const addressText = genAiAddressText(resolvedQuery, source?.stack);
  if (urlInput.value !== addressText) {
    urlInput.value = addressText;
  }

  const request = beginLoadRequest("genai", resolvedQuery, { source, recordHistory });
  setAddressFeedback(null);
  setStatus(t(cycleReload ? "status.regenerating" : "status.generating"));
  extractLabel.textContent = "";
  if (resetTunnel) {
    prepareForTunnelRun();
  }
  state.genAiVariationLabel = variationLabel;
  state.genAiBatchReceived = 0;
  // Seeded from the batch-count setting so the footer shows a real total from the
  // first frame; the first job poll replaces it with the server's expected count.
  // Correctness comes from genAiBatchComplete, false here regardless.
  state.genAiBatchExpected = genAiBatchCount();
  state.genAiBatchComplete = false;
  // Optional theatrical floor. Default is 0; correctness comes from the
  // received/expected/done progress gate.
  state.minTunnelDisplayUntilMs = GENAI_MIN_TUNNEL_DISPLAY_MS > 0
    ? performance.now() + GENAI_MIN_TUNNEL_DISPLAY_MS
    : 0;

  try {
    const response = await fetch("/api/genai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-genai-client-id": GENAI_CLIENT_ID,
        ...SESSION_HEADERS
      },
      signal: request.signal,
      body: JSON.stringify({
        prompt: resolvedQuery,
        source,
        cacheKey,
        async: true,
        // The server owns count/settings; no client-side batching.
        seed
      })
    });
    const payload = await response.json();
    if (!isCurrentLoadRequest(request.generation)) {
      return false;
    }
    if (!response.ok) {
      throw apiError(payload, "GenAI failed");
    }

    if (payload.jobId) {
      let lastItemCount = 0;
      let remembered = false;
      // Must be `return await`, not bare `return`: loadGenAiPrompt's finally runs
      // finishLoadRequest, which clears state.cycleRequestInFlight. A bare
      // `return runGenAiJob(...)` would run the finally at the job's first poll await,
      // flipping it false while the batch is still generating and breaking the "batch
      // complete before tunnel->sphere transition" gate.
      return await runGenAiJob({
        initialPayload: payload,
        signal: request.signal,
        generation: request.generation,
        isCurrentGeneration: isCurrentLoadRequest,
        onActiveJob: setActiveGenAiJob,
        onProgress: (nextPayload) => {
          const progress = applyGenAiProgressPayload({
            payload: nextPayload,
            resolvedQuery,
            source,
            recordHistory,
            lastItemCount,
            remembered,
            requestGeneration: request.generation
          });
          lastItemCount = progress.lastItemCount;
          remembered = progress.remembered;
          return progress;
        }
      });
    }

    return applyImagePayload({
      payload,
      mode: "genai",
      resolvedQuery,
      source,
      resetTunnel: false,
      recordHistory,
      requestGeneration: request.generation,
      emptyStatusKey: "status.noGeneratedKeeping"
    });
  } catch (err) {
    if (isAbortError(err) || !isCurrentLoadRequest(request.generation)) {
      return false;
    }
    // Covers every non-superseded way a GenAI job can end without a usable batch: an
    // explicit `failed` poll status (applyGenAiProgressPayload throws), a network
    // error mid-poll, or any other rejection. Otherwise genAiBatchComplete stays
    // false and the footer shows a stale "Generating N of M". Force it true so the
    // batch reads as finished, and surface the error.
    state.genAiBatchComplete = true;
    state.genAiJobError = reportLoadError(err);
    state.genAiJobErrorIsBudget = Boolean(err?.budget);
    return false;
  } finally {
    finishLoadRequest(request.generation);
  }
}

async function loadImageSearch({
  query = null,
  resetTunnel = true,
  recordHistory = true
} = {}) {
  const resolvedQuery = (query ?? urlInput.value ?? "").trim();
  if (!resolvedQuery) {
    setAddressFeedback("muted");
    setStatus(t("status.enterSearch"), "warning");
    return false;
  }

  if (urlInput.value !== resolvedQuery) {
    urlInput.value = resolvedQuery;
  }

  const request = beginLoadRequest("image_search", resolvedQuery, { recordHistory });
  setAddressFeedback(null);
  setStatus(t("status.searching"));
  extractLabel.textContent = "";

  try {
    const response = await fetch(`/api/search/images?q=${encodeURIComponent(resolvedQuery)}&limit=15`, {
      signal: request.signal,
      headers: SESSION_HEADERS
    });
    const payload = await response.json();
    if (!isCurrentLoadRequest(request.generation)) {
      return false;
    }
    if (!response.ok) {
      throw apiError(payload, "Image search failed");
    }

    return applyImagePayload({
      payload,
      mode: "image_search",
      resolvedQuery,
      resetTunnel,
      recordHistory,
      requestGeneration: request.generation,
      emptyStatusKey: "status.noSearchResults"
    });
  } catch (err) {
    if (isAbortError(err) || !isCurrentLoadRequest(request.generation)) {
      return false;
    }
    reportLoadError(err);
    return false;
  } finally {
    finishLoadRequest(request.generation);
  }
}

async function loadRequestByMode({
  mode,
  query,
  source = null,
  cacheKey = null,
  variationLabel = "",
  resetTunnel = true,
  cycleReload = false,
  recordHistory = true
}) {
  if (mode === "image_search") {
    return loadImageSearch({
      query,
      resetTunnel,
      recordHistory
    });
  }
  if (mode === "genai") {
    return loadGenAiPrompt({
      query,
      source,
      cacheKey,
      variationLabel,
      resetTunnel,
      cycleReload,
      recordHistory
    });
  }
  return loadAndExtractUrl({
    query,
    resetTunnel,
    cycleReload,
    recordHistory
  });
}

// The destination the viewer is heading to but has not reached: a request still
// running, an image import, or a sphere exit toward a link.
function pendingDestination() {
  if (state.cycleRequestInFlight) {
    return activeLoadRequest.target;
  }
  if (state.genAiLaunch) {
    return { mode: "genai", query: null };
  }
  if (state.pendingExitQuery) {
    return {
      mode: state.pendingExitMode || state.currentLoadMode,
      query: state.pendingExitQuery,
      source: state.pendingExitSource
    };
  }
  return null;
}

function backTarget() {
  return resolveBackTarget({
    history: state.navigationHistory,
    current: state.lastSuccessfulRequest,
    pending: pendingDestination()
  });
}

function canGoBack() {
  return Boolean(backTarget().entry);
}

// Back works mid-load too: starting the previous request cancels the running
// one (beginLoadRequest), including its GenAI job on the server.
async function goBack() {
  const { entry: previous, pop } = backTarget();
  if (pop) {
    state.navigationHistory.pop();
  }
  if (!previous) {
    setStatus(t("status.noHistory"));
    return false;
  }

  state.pendingExitQuery = null;
  state.pendingExitMode = null;
  state.pendingExitSource = null;
  if (previous.mode === "image_search") {
    return loadImageSearch({
      query: previous.query,
      recordHistory: false
    });
  }
  if (previous.mode === "genai") {
    return loadGenAiPrompt({
      query: previous.query,
      source: previous.source || null,
      cacheKey: previous.cacheKey || null,
      recordHistory: false
    });
  }

  return loadAndExtractUrl({
    query: previous.query,
    recordHistory: false
  });
}

export {
  canGoBack,
  renderResults,
  loadApiCapabilities,
  loadAndExtractUrl,
  loadImageSearch,
  loadGenAiPrompt,
  loadRequestByMode,
  goBack
};
