// Pure tunnel loading-status helpers. Keep the displayed count independent of
// the live scene array: panels are intentionally culled behind the camera.

import { t } from "./i18n.js";

function completedTunnelPanelCount(spawnedCount, totalCount) {
  const total = Math.max(0, Number(totalCount) || 0);
  const spawned = Math.max(0, Number(spawnedCount) || 0);
  return Math.min(total, spawned);
}

// "domain: link text" when the load came from a followed image that had some.
function withFollowedLabel(domain, label, maxLen = 40) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text || text === domain) {
    return domain;
  }
  return `${domain}: ${text.length <= maxLen ? text : `${text.slice(0, maxLen - 1).trimEnd()}…`}`;
}

function tunnelProgressText({ mode, query, totalCount, spawnedCount, domainFromUrl, label = "" }) {
  const total = Math.max(0, Number(totalCount) || 0);
  if (total === 0) {
    return "";
  }
  const shown = completedTunnelPanelCount(spawnedCount, total);
  if (mode === "image_search") {
    return t("footer.searching", { shown, total });
  }
  const domain = withFollowedLabel(domainFromUrl(query) || t("footer.page"), label);
  return t("footer.loading", { domain, shown, total });
}

// Client-only origin label (host + leaf segment) for an image picked from a
// web or image-search sphere. The provider's source contract carries only an
// id, so this rides along with the sphere-exit handoff for the tunnel footer.
function shortSourceLabel(url, maxLen = 40) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return "";
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] || "";
  let leaf;
  try {
    leaf = decodeURIComponent(lastSegment);
  } catch {
    leaf = lastSegment;
  }
  leaf = leaf.replace(/\.(jpe?g|png|gif|webp|avif|svg|html?|php|aspx?)$/i, "").trim();
  if (!leaf) {
    return host.length <= maxLen ? host : `${host.slice(0, Math.max(1, maxLen - 1))}…`;
  }
  const separator = segments.length > 1 ? "/…/" : "/";
  const budget = maxLen - host.length - separator.length;
  if (budget < 4) {
    return host.length <= maxLen ? host : `${host.slice(0, Math.max(1, maxLen - 1))}…`;
  }
  const trimmedLeaf = leaf.length <= budget ? leaf : `${leaf.slice(0, budget - 1)}…`;
  return `${host}${separator}${trimmedLeaf}`;
}

// GenAI batch progress for the tunnel / VR footer. `expected` comes from the
// batch-count setting so the footer reads "0/5" before the first job poll.
function genAiProgressText({ variationLabel, received, expected }) {
  const done = Math.max(0, Number(received) || 0);
  const total = Math.max(0, Number(expected) || 0);
  const label = String(variationLabel || "").trim();
  if (label) {
    return total > 0
      ? t("footer.variationsCount", { label, done, total })
      : t("footer.variations", { label });
  }
  return total > 0 ? t("footer.generatingOf", { done, total }) : t("footer.generating");
}

// The footer must never describe the previous request. Three state fields can
// carry a previous request's identity and ui.js statusFooterText() reads all of
// them: `genAiLaunch` (checked first), `genAiVariationLabel` and `genAiJobError`.
// Clear them together from this one list, where a new request begins (api.js
// beginLoadRequest); clearing only some lets a late error overwrite new progress.
// Mutates the caller's state object and returns it.
function resetGenAiRequestLabels(target) {
  if (!target) {
    return target;
  }
  target.genAiJobError = null;
  target.genAiJobErrorIsBudget = false;
  target.genAiVariationLabel = "";
  target.genAiLaunch = null;
  return target;
}

// A GenAI job that ends without a usable batch surfaces here. The full provider
// error is logged server-side; this trims it to the reason for the narrow VR
// footer: "fal txt2img returned HTTP 422: <reason>" -> "<reason>".
function withoutProviderPrefix(message) {
  return String(message || "").replace(/^.*?\breturned HTTP \d{3}:\s*/i, "");
}

// What the footer says while a new request is in flight.
function pendingLoadText({ mode, query, label: followed = "" } = {}, maxLen = 96) {
  const label = menuLoadLabel({ mode, query });
  if (!label) {
    return "";
  }
  return trimForFooter(
    mode === "image_search"
      ? t("footer.pendingSearching", { label })
      : t("footer.pendingLoading", { label: withFollowedLabel(label, mode === "url" ? followed : "") }),
    maxLen
  );
}

function tunnelErrorText(error, maxLen = 96) {
  // The server's own message may already start with the (English) prefix.
  const reason = withoutProviderPrefix(error).replace(/^GenAI failed:\s*/i, "");
  const framingLength = t("footer.genAiFailed", { reason: "" }).length;
  const trimmed = trimForFooter(reason, maxLen - framingLength);
  return trimmed ? t("footer.genAiFailed", { reason: trimmed }) : "";
}

// The same trimming without the GenAI framing, for text that is not a provider
// failure (e.g. an idle-timeout warning on a plain web page).
function trimForFooter(message, maxLen = 96) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  const budget = Math.max(8, maxLen);
  return text.length <= budget
    ? text
    : `${text.slice(0, Math.max(0, budget - 3)).trim()}...`;
}

// The VR menu's single status line: what is loading, being browsed, or failed.
// Empty means no status bar. The tunnel is "Loading"; the sphere is "Browsing".
const MENU_STATUS_MAX = 56;

function menuLoadLabel({ mode, query } = {}) {
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (mode === "url") {
    try {
      return new URL(text).hostname.replace(/^www\./, "") || text;
    } catch {
      return text;
    }
  }
  return text;
}

function menuStatusText({ appState, menuLoad, requestInFlight = false, voiceText = "" } = {}) {
  if (voiceText) {
    return trimForFooter(voiceText, MENU_STATUS_MAX);
  }
  const label = menuLoad ? menuLoadLabel(menuLoad) : "";
  if (!label) {
    return "";
  }
  let key = "vr.status.loading";
  if (menuLoad.failed) {
    key = "vr.status.error";
  } else if (!requestInFlight && (appState === "inside_sphere" || appState === "transition_to_sphere")) {
    key = "vr.status.browsing";
  }
  return trimForFooter(t(key, { label }), MENU_STATUS_MAX);
}

export {
  menuStatusText,
  pendingLoadText,
  withoutProviderPrefix,
  completedTunnelPanelCount,
  tunnelProgressText,
  shortSourceLabel,
  genAiProgressText,
  resetGenAiRequestLabels,
  tunnelErrorText,
  trimForFooter
};
