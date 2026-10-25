// Settings cog overlay: a flat DOM panel (not in-canvas) that reads the
// effective server config from GET /api/settings, writes overrides via
// PUT /api/settings, and drives the three-stage GenAI test plus the
// image-search test via POST /api/settings/test.
//
// Contract (server/index.js is the source of truth):
//   GET  /api/settings          -> { ok, settings: { KEY: { value, source, secret } } }
//   PUT  /api/settings          -> body { settings: { KEY: value } }, optional
//                                  header x-settings-token; 403 read-only, 400 invalid
//   POST /api/settings/test     -> body { target, stage }; returns
//                                  { ok, latencyMs, provider, [model], [item], [items] }
//   When HIDE_SETTINGS=1 every /api/settings route 404s: no cog button at all.

import { settingsBtn } from "./dom.js";
import { parseVaryModifierTexts, splitVaryModifierEntries } from "../shared/vary-modifiers.js";
import { GENAI_DEFAULT_ENDPOINTS, GENAI_PROVIDER_ENDPOINT_KEYS, GENAI_PROVIDERS } from "../shared/genai-provider-table.js";

const SETTINGS_TOKEN_HEADER = "x-settings-token";
const IMAGE_SEARCH_PROVIDERS = [
  { value: "ddg", label: "Default (DuckDuckGo, no key)" },
  { value: "serper", label: "Serper" },
  { value: "brave", label: "Brave" },
  { value: "custom", label: "Custom endpoint" }
];
const GENAI_VARY_SEED_MODES = [
  { value: "fresh", label: "Fresh seed per variation" },
  { value: "fixed", label: "Fixed seed across ramp" }
];
const GENAI_VARY_MODIFIER_MODES = [
  { value: "off", label: "Off" },
  { value: "batch", label: "One emoji per batch" },
  { value: "per-image", label: "One emoji per image" }
];
const GENAI_VARY_MODIFIER_STYLES = [
  { value: "replace", label: "Replace prompt" },
  { value: "auto", label: "Auto: replace for edit models, else append" },
  { value: "append", label: "Append to prompt" }
];
const GENAI_VARY_MODIFIER_PAYLOADS = [
  { value: "text", label: "Text phrase" },
  { value: "emoji", label: "Raw emoji" }
];
const GENAI_TIP = "Easiest local: install Draw Things (free, Mac App Store), download a model "
  + "(FLUX.1 schnell is the current recommendation), enable Settings -> API Server, and pick "
  + "\"Draw Things\" here. Self-hosted server: run AUTOMATIC1111 / SD.Next / Forge on your box "
  + "or cloud GPU and pick \"A1111 server\" with its URL. Hosted API: create a fal.ai key and "
  + "pick \"Hosted (fal.ai)\" - fastest setup, pay per image. Anything else: \"Custom endpoint\".";

// The tunnel footer's batch size before the server has answered.
const DEFAULT_GENAI_COUNT = 5;

// Field descriptors keyed by the server setting name. `control` picks the input
// widget; secrets show a masked placeholder that must never be round-tripped
// back on save.
const FIELDS = {
  // Image search
  IMAGE_SEARCH_PROVIDER: { control: "select", options: IMAGE_SEARCH_PROVIDERS },
  IMAGE_SEARCH_ENDPOINT: { control: "text", placeholder: "http://127.0.0.1:9000/search/images" },
  SERPER_API_KEY: { control: "secret" },
  BRAVE_SEARCH_API_KEY: { control: "secret" },
  // GenAI core
  GENAI_PROVIDER: { control: "select", options: GENAI_PROVIDERS },
  GENAI_ENDPOINT: { control: "text", placeholder: "http://127.0.0.1:7860" },
  GENAI_DRAWTHINGS_ENDPOINT: { control: "text" },
  GENAI_A1111_ENDPOINT: { control: "text" },
  GENAI_CUSTOM_ENDPOINT: { control: "text" },
  GENAI_API_KEY: { control: "secret" },
  FAL_KEY: { control: "secret" },
  GENAI_FAL_TEXT_MODEL: { control: "text" },
  GENAI_FAL_IMAGE_MODEL: { control: "text" },
  GENAI_COUNT: { control: "number", min: 1, max: 15, step: 1 },
  GENAI_WIDTH: { control: "number", min: 64, max: 2048, step: 64 },
  GENAI_HEIGHT: { control: "number", min: 64, max: 2048, step: 64 },
  GENAI_TIMEOUT_MS: { control: "number", min: 1000, max: 600000, step: 1000 },
  GENAI_SAVE_IMAGES_TO_DISK: { control: "checkbox" },
  GENAI_CLEANUP_IMAGES: { control: "checkbox" },
  GENAI_IMAGE_RETENTION_DAYS: { control: "number", min: 0, max: 3650, step: 1 },
  GENAI_MUSEUM_SAFE: { control: "checkbox" },
  GENAI_STEPS: { control: "number", min: 1, max: 150, step: 1, optional: true },
  GENAI_STEPS_RECOMMENDED: { control: "checkbox" },
  GENAI_CFG_SCALE: { control: "number", min: 0.1, max: 30, step: 0.1, optional: true },
  GENAI_DRAWTHINGS_GUIDANCE_EMBED: { control: "number", min: 0.1, max: 30, step: 0.1, optional: true },
  GENAI_VARIATION_STRENGTH_MIN: { control: "number", min: 0, max: 1, step: 0.05 },
  GENAI_VARIATION_STRENGTH_MAX: { control: "number", min: 0, max: 1, step: 0.05 },
  GENAI_VARY_SEED_MODE: { control: "select", options: GENAI_VARY_SEED_MODES },
  GENAI_VARY_MODIFIERS: { control: "text" },
  GENAI_VARY_MODIFIER_TEXTS: { control: "textarea" },
  GENAI_VARY_MODIFIER_MODE: { control: "select", options: GENAI_VARY_MODIFIER_MODES },
  GENAI_VARY_MODIFIER_STYLE: { control: "select", options: GENAI_VARY_MODIFIER_STYLES },
  GENAI_VARY_MODIFIER_PAYLOAD: { control: "select", options: GENAI_VARY_MODIFIER_PAYLOADS },
  SHOW_STATUS_FOOTER: { control: "checkbox" },
  SHOW_IMAGE_LIST: { control: "checkbox" },
  LOG_API_QUERIES: { control: "checkbox" }
};

let overlayEl = null;
let dialogEl = null;
let inputs = null;
let serverSettings = null;
let settingsMeta = null;
let adminToken = "";
let adminTokenField = null;
let lastFocusedEl = null;
let onSavedCallback = null;
let genAiEndpointDrafts = {};
let genAiEndpointDirtyProviders = new Set();

function makeEl(tag, className, attrs = {}) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") {
      el.textContent = value;
    } else if (value !== null && value !== undefined) {
      el.setAttribute(key, value);
    }
  }
  return el;
}

// Tags only what is worth noticing: a value pinned by the server environment,
// or a saved one that differs from what it would otherwise be. A saved copy of
// the default and an untouched default get none.
function sourceTag(entry, descriptor) {
  if (entry.source === "env") {
    return makeEl("span", "settings-source-tag source-env", { text: "env-pinned", title: "Set via server environment" });
  }
  if (entry.source === "override" && differsFromFallback(entry, descriptor)) {
    return makeEl("span", "settings-source-tag source-override", { text: "saved", title: "Saved runtime override" });
  }
  return null;
}

function differsFromFallback(entry, descriptor) {
  if (entry.secret || entry.fallback === undefined) {
    return true;
  }
  return entryComparableValue(entry, descriptor) !== entryComparableValue({ value: entry.fallback }, descriptor);
}

// Puts the field back to what it would be without the override; saving then
// stores that.
function resetButton(input, descriptor, entry) {
  const button = makeEl("button", "settings-reset-btn", { type: "button", text: "\u21ba", title: "Reset to default", "aria-label": "Reset to default" });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (descriptor.control === "checkbox") {
      input.checked = Boolean(entry.fallback);
    } else {
      input.value = entry.fallback === null || entry.fallback === undefined ? "" : String(entry.fallback);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    button.hidden = true;
  });
  return button;
}

function settingEntry(key) {
  return serverSettings?.[key] || { value: "", source: "default", secret: false };
}

// Unloaded, nothing is: blank fields saved back would clear every override.
function settingSupported(key) {
  return Boolean(serverSettings) && Object.prototype.hasOwnProperty.call(serverSettings, key);
}

function genAiEndpointKeyForProvider(provider) {
  return GENAI_PROVIDER_ENDPOINT_KEYS[provider] || "";
}

function fallbackGenAiEndpointForProvider(provider) {
  return GENAI_DEFAULT_ENDPOINTS[provider] || "";
}

function endpointEntryForProvider(provider) {
  const key = genAiEndpointKeyForProvider(provider);
  const providerEntry = key ? settingEntry(key) : null;
  const legacyEntry = settingEntry("GENAI_ENDPOINT");
  const savedProviderEntry = settingEntry("GENAI_PROVIDER");
  const providerHasDefault = Boolean(fallbackGenAiEndpointForProvider(provider));
  const legacyMatchesSavedProvider = String(savedProviderEntry.value || "") === provider
    && savedProviderEntry.source !== "override";
  if (providerEntry?.value) {
    return { ...providerEntry, key };
  }
  if (legacyEntry.value && (!providerHasDefault || legacyMatchesSavedProvider)) {
    return { ...legacyEntry, key: "GENAI_ENDPOINT" };
  }
  return {
    value: fallbackGenAiEndpointForProvider(provider),
    source: "default",
    secret: false,
    key
  };
}

function storeCurrentGenAiEndpointDraft(provider = inputs?.GENAI_PROVIDER?.input?.value) {
  if (!inputs?.GENAI_ENDPOINT?.input) {
    return;
  }
  if (!genAiEndpointKeyForProvider(provider)) {
    return;
  }
  genAiEndpointDrafts[provider] = inputs.GENAI_ENDPOINT.input.value.trim();
}

function fieldValue(input, descriptor) {
  if (descriptor.control === "checkbox") {
    return input.checked;
  }
  return input.value.trim();
}

function entryComparableValue(entry, descriptor) {
  if (descriptor.control === "checkbox") {
    return Boolean(entry.value);
  }
  if (entry.secret && entry.value) {
    return "";
  }
  return entry.value === "" || entry.value === null || entry.value === undefined ? "" : String(entry.value);
}

function updateSourceTagForDirtyState(input, descriptor, entry, tag) {
  if (!tag || entry.source !== "override") {
    return;
  }
  const savedValue = entryComparableValue(entry, descriptor);
  const refresh = () => {
    tag.hidden = fieldValue(input, descriptor) !== savedValue;
  };
  input.addEventListener("input", refresh);
  input.addEventListener("change", refresh);
  refresh();
}

function buildField(key, labelText, hint) {
  const descriptor = FIELDS[key];
  const entry = settingEntry(key);
  const field = makeEl("div", "settings-field");
  const fieldId = `settings-${key.toLowerCase()}`;

  if (descriptor.control === "checkbox") {
    const wrap = makeEl("label", "settings-checkbox");
    const input = makeEl("input", null, { type: "checkbox", id: fieldId });
    input.checked = Boolean(entry.value);
    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(labelText));
    const tag = sourceTag(entry, descriptor);
    if (tag) {
      wrap.appendChild(tag);
      if (entry.source === "override") {
        wrap.appendChild(resetButton(input, descriptor, entry));
      }
    }
    field.appendChild(wrap);
    if (hint) {
      field.appendChild(makeEl("div", "settings-hint", { text: hint }));
    }
    updateSourceTagForDirtyState(input, descriptor, entry, tag);
    inputs[key] = { input, descriptor };
    return field;
  }

  const label = makeEl("label", null, { for: fieldId, text: labelText });
  const tag = sourceTag(entry, descriptor);
  if (tag) {
    label.appendChild(tag);
  }
  field.appendChild(label);

  let input;
  if (descriptor.control === "select") {
    input = makeEl("select", null, { id: fieldId });
    for (const option of descriptor.options) {
      const opt = makeEl("option", null, { value: option.value, text: option.label });
      if (String(entry.value ?? "") === option.value) {
        opt.selected = true;
      }
      input.appendChild(opt);
    }
  } else if (descriptor.control === "secret") {
    input = makeEl("input", null, {
      type: "password",
      id: fieldId,
      autocomplete: "off",
      // The masked value is shown as a placeholder so the real (masked) string is
      // never a form value that could be saved back verbatim.
      placeholder: entry.value ? `${entry.value} (leave blank to keep)` : "not set"
    });
  } else if (descriptor.control === "number") {
    input = makeEl("input", null, {
      type: "number",
      id: fieldId,
      min: descriptor.min,
      max: descriptor.max,
      step: descriptor.step
    });
    input.value = entry.value === "" || entry.value === null || entry.value === undefined ? "" : String(entry.value);
  } else {
    input = makeEl("input", null, {
      type: "text",
      id: fieldId,
      spellcheck: "false",
      placeholder: descriptor.placeholder || ""
    });
    input.value = entry.value ?? "";
  }
  field.appendChild(input);
  if (tag && entry.source === "override" && !entry.secret) {
    label.appendChild(resetButton(input, descriptor, entry));
  }
  if (hint) {
    field.appendChild(makeEl("div", "settings-hint", { text: hint }));
  }
  updateSourceTagForDirtyState(input, descriptor, entry, tag);
  inputs[key] = { input, descriptor };
  return field;
}

function buildGenAiEndpointField(labelText) {
  const descriptor = FIELDS.GENAI_ENDPOINT;
  const field = makeEl("div", "settings-field");
  const fieldId = "settings-genai-endpoint";
  const label = makeEl("label", null, { for: fieldId, text: labelText });
  let tag = null;
  field.appendChild(label);

  const input = makeEl("input", null, {
    type: "text",
    id: fieldId,
    spellcheck: "false",
    placeholder: descriptor.placeholder || ""
  });
  field.appendChild(input);

  let activeProvider = "";
  let activeComparableValue = "";
  let activeSource = "default";

  const setTag = (entry) => {
    if (tag) {
      tag.remove();
    }
    tag = sourceTag(entry, descriptor);
    if (tag) {
      label.appendChild(tag);
    }
  };

  const refreshDirtyTag = () => {
    if (!tag) {
      return;
    }
    tag.hidden = activeSource === "override" && input.value.trim() !== activeComparableValue;
  };

  const showProviderEndpoint = (provider) => {
    activeProvider = provider;
    const entry = endpointEntryForProvider(provider);
    const value = Object.prototype.hasOwnProperty.call(genAiEndpointDrafts, provider)
      ? genAiEndpointDrafts[provider]
      : String(entry.value || "");
    activeComparableValue = String(entry.value || "");
    activeSource = entry.source;
    input.value = value;
    input.placeholder = fallbackGenAiEndpointForProvider(provider) || descriptor.placeholder || "";
    setTag(entry);
    refreshDirtyTag();
  };

  input.addEventListener("input", () => {
    if (genAiEndpointKeyForProvider(activeProvider)) {
      genAiEndpointDrafts[activeProvider] = input.value.trim();
      genAiEndpointDirtyProviders.add(activeProvider);
    }
    refreshDirtyTag();
  });
  input.addEventListener("change", () => {
    if (genAiEndpointKeyForProvider(activeProvider)) {
      genAiEndpointDrafts[activeProvider] = input.value.trim();
      genAiEndpointDirtyProviders.add(activeProvider);
    }
    refreshDirtyTag();
  });

  inputs.GENAI_ENDPOINT = { input, descriptor, showProviderEndpoint };
  return field;
}

function makeThumb(imageUrl) {
  const img = makeEl("img", null, { alt: "test image", loading: "lazy" });
  img.src = imageUrl;
  return img;
}

// Only send values the user actually changed, and never echo secrets: a blank
// secret field means "keep current"; a non-empty select/number/text is sent so
// the server can re-derive source flags. Sending the whole set is safe because
// the server treats "" as "clear override".
function collectUpdates() {
  const updates = {};
  storeCurrentGenAiEndpointDraft();
  for (const [key, { input, descriptor }] of Object.entries(inputs)) {
    if (!settingSupported(key)) {
      continue;
    }
    if (key === "GENAI_ENDPOINT") {
      continue;
    }
    if (descriptor.control === "checkbox") {
      updates[key] = input.checked;
      continue;
    }
    // Unedited, it is only the current texts written out: saving would freeze
    // them over later built-in changes.
    if (descriptor.control === "textarea") {
      if (input.dataset.edited) {
        updates[key] = input.value.trim();
      }
      continue;
    }
    const raw = input.value.trim();
    if (descriptor.control === "secret") {
      // Blank secret = keep whatever the server already has (masked); do not send.
      if (raw) {
        updates[key] = raw;
      }
      continue;
    }
    updates[key] = raw;
  }
  for (const provider of genAiEndpointDirtyProviders) {
    const key = genAiEndpointKeyForProvider(provider);
    if (key && settingSupported(key)) {
      updates[key] = genAiEndpointDrafts[provider] || "";
    }
  }
  return updates;
}

async function fetchSettings() {
  const response = await fetch("/api/settings");
  if (response.status === 404) {
    // HIDE_SETTINGS=1: endpoints are gone, hide the cog entirely.
    return { hidden: true };
  }
  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.settings) {
    return { hidden: false, settings: payload.settings, meta: payload.meta || null };
  }
  throw new Error(payload.error || `HTTP ${response.status}`);
}

function requestHeaders(extra = {}) {
  const headers = { "content-type": "application/json", ...extra };
  if (adminToken) {
    headers[SETTINGS_TOKEN_HEADER] = adminToken;
  }
  return headers;
}

async function saveSettings() {
  const footerStatus = dialogEl.querySelector(".settings-status");
  setStatusText(footerStatus, "Saving...", null);
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({ settings: collectUpdates() })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      revealAdminToken();
      setStatusText(footerStatus, payload.error || "Settings are read-only; enter an admin token.", "error");
      return;
    }
    if (!response.ok) {
      setStatusText(footerStatus, payload.error || `Save failed (HTTP ${response.status})`, "error");
      return;
    }
    serverSettings = payload.settings || serverSettings;
    settingsMeta = payload.meta || settingsMeta;
    setStatusText(footerStatus, "Saved.", "ok");
    // Re-render so masks/source tags reflect the persisted state, and refresh
    // capabilities so the GenAI button's enabled/disabled state updates live.
    rerenderBody();
    if (typeof onSavedCallback === "function") {
      await onSavedCallback();
    }
  } catch (err) {
    setStatusText(footerStatus, err instanceof Error ? err.message : String(err), "error");
  }
}

function setStatusText(el, text, tone) {
  if (!el) {
    return;
  }
  el.textContent = text;
  el.classList.toggle("ok", tone === "ok");
  el.classList.toggle("error", tone === "error");
}

async function runTest(target, stage, button, statusEl, thumbsEl) {
  const buttons = button.parentElement.querySelectorAll(".settings-test-btn");
  button.classList.add("stage-running");
  setStatusText(statusEl, `Testing ${stage}...`, null);
  try {
    // Persist current form values first so the server tests what the user typed.
    await fetch("/api/settings", {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({ settings: collectUpdates() })
    }).then(async (r) => {
      if (r.status === 401 || r.status === 403) {
        revealAdminToken();
        throw new Error("Settings are read-only; enter an admin token to test.");
      }
      if (!r.ok) {
        const p = await r.json().catch(() => ({}));
        throw new Error(p.error || `Could not apply settings (HTTP ${r.status})`);
      }
      const p = await r.json().catch(() => ({}));
      serverSettings = p.settings || serverSettings;
      settingsMeta = p.meta || settingsMeta;
    });

    const response = await fetch("/api/settings/test", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ target, stage })
    });
    const payload = await response.json().catch(() => ({}));
    button.classList.remove("stage-running");
    if (!response.ok || payload.ok === false) {
      button.classList.remove("stage-ok");
      button.classList.add("stage-error");
      setStatusText(statusEl, payload.error || `Test failed (HTTP ${response.status})`, "error");
      return;
    }
    button.classList.remove("stage-error");
    button.classList.add("stage-ok");
    const parts = [];
    if (payload.provider) {
      parts.push(payload.provider);
    }
    if (payload.model) {
      parts.push(payload.model);
    }
    if (Number.isFinite(payload.latencyMs)) {
      parts.push(`${payload.latencyMs} ms`);
    }
    setStatusText(statusEl, `OK${parts.length ? ` - ${parts.join(" / ")}` : ""}`, "ok");

    if (thumbsEl) {
      thumbsEl.textContent = "";
      const thumbItems = payload.item ? [payload.item] : Array.isArray(payload.items) ? payload.items : [];
      for (const item of thumbItems) {
        if (item?.imageUrl) {
          thumbsEl.appendChild(makeThumb(item.imageUrl));
        }
      }
    }
  } catch (err) {
    button.classList.remove("stage-running", "stage-ok");
    button.classList.add("stage-error");
    setStatusText(statusEl, err instanceof Error ? err.message : String(err), "error");
  } finally {
    buttons.forEach((b) => b.classList.remove("stage-running"));
  }
}

function buildTestRow(target, stages, thumbsEl) {
  const row = makeEl("div", "settings-test-row");
  const status = makeEl("div", "settings-test-status");
  for (const stage of stages) {
    const button = makeEl("button", "settings-test-btn secondary", { type: "button", text: stage.label });
    button.addEventListener("click", () => {
      void runTest(target, stage.stage, button, status, stage.showThumbs ? thumbsEl : null);
    });
    row.appendChild(button);
  }
  return { row, status };
}

function generatedImagesPathText() {
  return settingsMeta?.generatedImagesDir || "generated-images/";
}

function savedImagesInfoText() {
  const saveInput = inputs?.GENAI_SAVE_IMAGES_TO_DISK?.input;
  const path = generatedImagesPathText();
  return saveInput?.checked
    ? `Saving generated images to ${path}. This keeps the GenAI sequence available as files; switch it off for ephemeral sessions.`
    : `Save to disk is off. Switch it on to write generated images to ${path} and preserve the sequence as files.`;
}

function showGenAiDimensionNotice() {
  const status = dialogEl?.querySelector(".settings-status");
  setStatusText(
    status,
    "Image dimensions apply to the next new GenAI prompt; variations keep the selected image size.",
    "ok"
  );
}

function buildSavedImagesControls() {
  const saveRow = makeEl("div", "settings-field-row");
  saveRow.appendChild(buildField(
    "GENAI_SAVE_IMAGES_TO_DISK",
    "Save generated images to disk",
    "On by default so the GenAI sequence can survive as files."
  ));
  const infoBtn = makeEl("button", "settings-info-btn", {
    type: "button",
    "aria-label": "Saved image folder",
    text: "i"
  });
  saveRow.appendChild(infoBtn);
  const savedTip = makeEl("div", "settings-tip", { hidden: "" });
  infoBtn.addEventListener("click", () => {
    savedTip.textContent = savedImagesInfoText();
    savedTip.hidden = !savedTip.hidden;
  });

  const cleanupRow = makeEl("div", "settings-field-row");
  cleanupRow.appendChild(buildField("GENAI_CLEANUP_IMAGES", "Clean up saved images"));
  cleanupRow.appendChild(buildField(
    "GENAI_IMAGE_RETENTION_DAYS",
    "Cleanup days",
    "0 cleans files from previous sessions on the next API start; 1+ keeps files for that many days."
  ));

  const cleanupInput = inputs.GENAI_CLEANUP_IMAGES?.input;
  const daysInput = inputs.GENAI_IMAGE_RETENTION_DAYS?.input;
  const refreshCleanupState = () => {
    if (daysInput) {
      daysInput.disabled = cleanupInput && !cleanupInput.checked;
    }
  };
  cleanupInput?.addEventListener("change", refreshCleanupState);
  refreshCleanupState();

  const fragment = document.createDocumentFragment();
  fragment.appendChild(saveRow);
  fragment.appendChild(savedTip);
  fragment.appendChild(cleanupRow);
  return fragment;
}

// What each emoji is sent as (payload=text), one "emoji text" line each,
// prefilled from the set. An emoji with no text goes to the provider bare, so a
// set edit that adds one says so and opens the fold.
function buildEmojiTextsControls(setInput) {
  const key = "GENAI_VARY_MODIFIER_TEXTS";
  const entry = settingEntry(key);
  const wrap = makeEl("div", "settings-field");
  const warning = makeEl("div", "settings-hint settings-warning");
  const fold = makeEl("details", "settings-advanced");
  const summary = makeEl("summary", null, { text: "Emoji texts" });
  const tag = entry.source === "env" || entry.value ? sourceTag(entry, FIELDS[key]) : null;
  if (tag) {
    summary.appendChild(tag);
  }
  const textarea = makeEl("textarea", "settings-textarea", { id: "settings-genai_vary_modifier_texts", rows: "8", spellcheck: "false" });
  textarea.disabled = entry.source === "env";
  fold.append(
    summary,
    makeEl("div", "settings-hint", { text: "One emoji per line, then the words sent for it, e.g. \"🦦 otter, playful wet fur\"." }),
    textarea
  );
  wrap.append(warning, fold);

  const setEmojis = () => [...new Set(splitVaryModifierEntries(setInput.value).map((item) => item.emoji))];
  const listed = () => new Set(textarea.value.split("\n").map((line) => splitVaryModifierEntries(line.trim().split(/\s/)[0])[0]?.emoji).filter(Boolean));
  const known = settingsMeta?.emojiTexts || {};
  const savedExtra = Object.entries(parseVaryModifierTexts(entry.value)).filter(([emoji]) => !setEmojis().includes(emoji));
  textarea.value = [
    ...setEmojis().map((emoji) => `${emoji} ${known[emoji] || ""}`.trimEnd()),
    ...savedExtra.map(([emoji, text]) => `${emoji} ${text}`)
  ].join("\n");

  // New set emoji get a line; that is not an edit.
  const syncFromSet = (openIfMissing) => {
    const present = listed();
    const added = setEmojis().filter((emoji) => !present.has(emoji));
    if (added.length && !textarea.disabled) {
      textarea.value = `${textarea.value.trimEnd()}\n${added.join("\n")}`.replace(/^\n/, "");
    }
    const texts = parseVaryModifierTexts(textarea.value);
    const missing = setEmojis().filter((emoji) => !texts[emoji]);
    warning.textContent = missing.length
      ? `No text for ${missing.join(" ")}: sent as the bare emoji. Add words under Emoji texts.`
      : "";
    warning.hidden = !missing.length;
    if (openIfMissing && missing.length) {
      fold.open = true;
    }
  };
  setInput.addEventListener("change", () => syncFromSet(true));
  textarea.addEventListener("input", () => {
    textarea.dataset.edited = "1";
    syncFromSet(false);
  });
  syncFromSet(false);
  inputs[key] = { input: textarea, descriptor: FIELDS[key] };
  return wrap;
}

function buildGenAiSection() {
  const section = makeEl("section", "settings-section");
  const heading = makeEl("h3", null, { text: "GenAI" });
  const infoBtn = makeEl("button", "settings-info-btn", { type: "button", "aria-label": "GenAI setup tips", text: "i" });
  heading.appendChild(infoBtn);
  section.appendChild(heading);

  const tip = makeEl("div", "settings-tip", { text: GENAI_TIP, hidden: "" });
  infoBtn.addEventListener("click", () => {
    tip.hidden = !tip.hidden;
  });
  section.appendChild(tip);

  section.appendChild(buildField("GENAI_PROVIDER", "Provider"));
  // Everything else waits until a provider is picked.
  const details = makeEl("div", "settings-subsection");
  section.appendChild(details);
  const endpointField = buildGenAiEndpointField("Endpoint");
  details.appendChild(endpointField);
  const apiKeyField = buildField(
    "GENAI_API_KEY",
    "Provider API key",
    "For hosted providers (fal.ai) or auth-protected remote servers. Leave empty for local Draw Things."
  );
  details.appendChild(apiKeyField);

  const falModels = makeEl("div", "settings-field-row is-aligned");
  falModels.appendChild(buildField("GENAI_FAL_TEXT_MODEL", "fal text model"));
  falModels.appendChild(buildField("GENAI_FAL_IMAGE_MODEL", "fal image model"));
  details.appendChild(falModels);

  const dims = makeEl("div", "settings-field-row is-aligned");
  dims.appendChild(buildField("GENAI_COUNT", "Image count"));
  dims.appendChild(buildField("GENAI_WIDTH", "Width"));
  dims.appendChild(buildField("GENAI_HEIGHT", "Height"));
  details.appendChild(dims);
  inputs.GENAI_WIDTH.input.addEventListener("change", showGenAiDimensionNotice);
  inputs.GENAI_HEIGHT.input.addEventListener("change", showGenAiDimensionNotice);

  if (
    settingSupported("GENAI_SAVE_IMAGES_TO_DISK")
    && settingSupported("GENAI_CLEANUP_IMAGES")
    && settingSupported("GENAI_IMAGE_RETENTION_DAYS")
  ) {
    details.appendChild(buildSavedImagesControls());
  }
  details.appendChild(buildField("GENAI_VARY_MODIFIERS", "Emoji set"));
  if (settingSupported("GENAI_VARY_MODIFIER_TEXTS")) {
    details.appendChild(buildEmojiTextsControls(inputs.GENAI_VARY_MODIFIERS.input));
  }
  details.appendChild(buildField("GENAI_MUSEUM_SAFE", "Museum-safe mode (strict filtering)"));

  // Tuning most setups never touch, folded away.
  const fold = makeEl("details", "settings-advanced");
  fold.appendChild(makeEl("summary", null, { text: "Advanced" }));
  const foldBody = makeEl("div", "settings-subsection");
  fold.appendChild(foldBody);
  details.appendChild(fold);

  const advanced = makeEl("div", "settings-field-row is-aligned");
  advanced.appendChild(buildField("GENAI_STEPS", "Steps", "Leave blank to let the app decide steps"));
  advanced.appendChild(buildField("GENAI_CFG_SCALE", "CFG scale", "Blank: the app decides"));
  const guidanceField = buildField("GENAI_DRAWTHINGS_GUIDANCE_EMBED", "Guidance embed", "FLUX guidance, Draw Things only");
  advanced.appendChild(guidanceField);
  advanced.appendChild(buildField("GENAI_TIMEOUT_MS", "Timeout (ms)"));
  foldBody.appendChild(advanced);
  if (settingSupported("GENAI_STEPS_RECOMMENDED")) {
    foldBody.appendChild(buildField(
      "GENAI_STEPS_RECOMMENDED",
      "Override for known recommended models",
      settingsMeta?.recommendedSteps || ""
    ));
  }

  const strengths = makeEl("div", "settings-field-row is-aligned");
  strengths.appendChild(buildField("GENAI_VARIATION_STRENGTH_MIN", "Variation strength min"));
  strengths.appendChild(buildField("GENAI_VARIATION_STRENGTH_MAX", "Variation strength max"));
  strengths.appendChild(buildField("GENAI_VARY_SEED_MODE", "Variation seed mode"));
  foldBody.appendChild(strengths);

  const modifiers = makeEl("div", "settings-field-row is-aligned");
  modifiers.appendChild(buildField("GENAI_VARY_MODIFIER_MODE", "Emoji mode"));
  modifiers.appendChild(buildField("GENAI_VARY_MODIFIER_STYLE", "Emoji prompt style"));
  modifiers.appendChild(buildField("GENAI_VARY_MODIFIER_PAYLOAD", "Emoji payload"));
  foldBody.appendChild(modifiers);

  const thumbs = makeEl("div", "settings-thumbs");
  const { row, status } = buildTestRow("genai", [
    { stage: "connect", label: "Connect" },
    { stage: "generate", label: "Generate", showThumbs: true },
    { stage: "vary", label: "Vary", showThumbs: true }
  ], thumbs);
  const testHint = makeEl("div", "settings-hint");
  testHint.append(makeEl("strong", null, { text: "Test" }), " the provider end to end: reachability, one generated image, then a variation of it.");
  details.appendChild(testHint);
  details.appendChild(row);
  details.appendChild(status);
  details.appendChild(thumbs);

  // Provider-conditional visibility: fal hides the endpoint (needs key + model
  // only); non-fal hides the fal model fields; and switching provider pre-fills a
  // sensible default endpoint when the field is empty.
  const providerSelect = inputs.GENAI_PROVIDER.input;
  let previousProvider = providerSelect.value;
  const applyProviderVisibility = () => {
    const provider = providerSelect.value;
    const endpointInput = inputs.GENAI_ENDPOINT.input;
    details.hidden = provider === "";
    endpointField.hidden = provider === "fal";
    falModels.hidden = provider !== "fal";
    guidanceField.hidden = provider !== "drawthings";
    inputs.GENAI_ENDPOINT.showProviderEndpoint(provider);
    endpointInput.disabled = provider === "fal" || provider === "";
  };
  providerSelect.addEventListener("change", () => {
    if (providerSelect.value !== previousProvider) {
      storeCurrentGenAiEndpointDraft(previousProvider);
      previousProvider = providerSelect.value;
    }
    applyProviderVisibility();
  });
  applyProviderVisibility();

  return section;
}

function buildImageSearchSection() {
  const section = makeEl("section", "settings-section");
  section.appendChild(makeEl("h3", null, { text: "Image search" }));
  section.appendChild(makeEl("div", "settings-hint", {
    text: "Unset defaults to DuckDuckGo (no key). Museum-safe mode forces strict-safe flags when enabled."
  }));

  section.appendChild(buildField("IMAGE_SEARCH_PROVIDER", "Provider"));
  const endpointField = buildField("IMAGE_SEARCH_ENDPOINT", "Custom endpoint");
  section.appendChild(endpointField);
  const serperField = buildField("SERPER_API_KEY", "Serper API key");
  section.appendChild(serperField);
  const braveField = buildField("BRAVE_SEARCH_API_KEY", "Brave API key");
  section.appendChild(braveField);

  const thumbs = makeEl("div", "settings-thumbs");
  const { row, status } = buildTestRow("imageSearch", [
    { stage: "connect", label: "Test search", showThumbs: true }
  ], thumbs);
  section.appendChild(row);
  section.appendChild(status);
  section.appendChild(thumbs);

  const providerSelect = inputs.IMAGE_SEARCH_PROVIDER.input;
  const applyProviderVisibility = () => {
    const provider = providerSelect.value;
    endpointField.hidden = provider !== "custom";
    serperField.hidden = provider !== "serper";
    braveField.hidden = provider !== "brave";
  };
  providerSelect.addEventListener("change", applyProviderVisibility);
  applyProviderVisibility();

  return section;
}

function buildDiagnosticsSection() {
  const section = makeEl("details", "settings-section settings-advanced");
  section.appendChild(makeEl("summary", null, { text: "Diagnostics" }));
  section.appendChild(buildField(
    "LOG_API_QUERIES",
    "Log API queries",
    "Writes URL/search/GenAI request records to the API console and server/query.log."
  ));
  return section;
}

function buildInterfaceSection() {
  const section = makeEl("section", "settings-section");
  section.appendChild(makeEl("h3", null, { text: "Interface" }));
  section.appendChild(buildField(
    "SHOW_STATUS_FOOTER",
    "Show status footer",
    "Shows public loading progress and the selected sphere image identity in flat and VR modes."
  ));
  section.appendChild(buildField(
    "SHOW_IMAGE_LIST",
    "Show image list (flat mode)",
    "Lists every extracted image URL and its link under the canvas on desktop. Turn off for a clean view when presenting or exhibiting; it has no effect in VR."
  ));
  return section;
}

function buildAdminTokenField() {
  const wrap = makeEl("div", "settings-field settings-admin-token");
  wrap.hidden = true;
  const label = makeEl("label", null, {
    for: "settings-admin-token",
    text: "Admin token (required to write settings on this deployment)"
  });
  wrap.appendChild(label);
  const input = makeEl("input", null, { type: "password", id: "settings-admin-token", autocomplete: "off" });
  input.value = adminToken;
  input.addEventListener("input", () => {
    adminToken = input.value.trim();
  });
  wrap.appendChild(input);
  adminTokenField = wrap;
  return wrap;
}

function revealAdminToken() {
  if (adminTokenField) {
    adminTokenField.hidden = false;
    adminTokenField.querySelector("input")?.focus();
  }
}

function buildBody() {
  inputs = {};
  genAiEndpointDrafts = {};
  genAiEndpointDirtyProviders = new Set();
  const body = makeEl("div", "settings-body");
  body.appendChild(buildInterfaceSection());
  body.appendChild(buildImageSearchSection());
  body.appendChild(buildGenAiSection());
  body.appendChild(buildDiagnosticsSection());
  body.appendChild(buildAdminTokenField());
  return body;
}

function rerenderBody() {
  const oldBody = dialogEl.querySelector(".settings-body");
  const newBody = buildBody();
  oldBody.replaceWith(newBody);
}

function buildDialog() {
  overlayEl = makeEl("div", "settings-overlay", { role: "presentation" });
  dialogEl = makeEl("div", "settings-dialog", { role: "dialog", "aria-modal": "true", "aria-label": "Settings" });

  const header = makeEl("div", "settings-header");
  header.appendChild(makeEl("h2", null, { text: "Settings" }));
  const closeBtn = makeEl("button", "settings-close secondary", { type: "button", "aria-label": "Close settings", text: "✕" });
  closeBtn.addEventListener("click", closeSettings);
  header.appendChild(closeBtn);
  dialogEl.appendChild(header);

  dialogEl.appendChild(buildBody());

  const footer = makeEl("div", "settings-footer");
  footer.appendChild(makeEl("div", "settings-status"));
  const cancelBtn = makeEl("button", "secondary", { type: "button", text: "Close" });
  cancelBtn.addEventListener("click", closeSettings);
  const saveBtn = makeEl("button", null, { type: "button", text: "Save" });
  saveBtn.addEventListener("click", () => void saveSettings());
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  dialogEl.appendChild(footer);

  overlayEl.appendChild(dialogEl);

  // Click on the backdrop (outside the dialog) closes; Escape closes; keep
  // scene keys from firing while the overlay is open by stopping propagation
  // to window-level handlers.
  overlayEl.addEventListener("mousedown", (event) => {
    if (event.target === overlayEl) {
      closeSettings();
    }
  });
  dialogEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
      return;
    }
    event.stopPropagation();
  });
}

async function openSettings() {
  lastFocusedEl = document.activeElement;
  let loadError = null;
  try {
    const result = await fetchSettings();
    if (result.hidden) {
      // Should not happen (button hidden), but guard defensively.
      settingsBtn.hidden = true;
      return;
    }
    serverSettings = result.settings;
    settingsMeta = result.meta || null;
  } catch (err) {
    loadError = err;
  }

  if (!overlayEl) {
    buildDialog();
  } else {
    rerenderBody();
  }
  document.body.appendChild(overlayEl);
  // Last good settings stay on screen; with none, the panel is empty but says why.
  if (loadError) {
    setStatusText(dialogEl.querySelector(".settings-status"), `Could not load the server's settings: ${loadError.message}`, "error");
  }
  const firstControl = dialogEl.querySelector("select, input, button");
  firstControl?.focus();
}

function closeSettings() {
  if (overlayEl?.parentElement) {
    overlayEl.remove();
  }
  if (lastFocusedEl && typeof lastFocusedEl.focus === "function") {
    lastFocusedEl.focus();
  } else {
    settingsBtn.focus();
  }
}

function isSettingsOpen() {
  return Boolean(overlayEl?.parentElement);
}

// The effective server settings are already cached from boot (setupSettings), so
// the GenAI batch size is known before any job exists. The tunnel footer needs
// it that early to read "1/5" instead of "1/?" on the first frame. Falls back to
// the built-in default when the panel is hidden (HIDE_SETTINGS=1) or the probe
// failed; the server still owns the real count.
function genAiBatchCount() {
  const raw = Number(serverSettings?.GENAI_COUNT?.value);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_GENAI_COUNT;
}

// Probe /api/settings once: if HIDE_SETTINGS removed the endpoints (404) the cog
// stays hidden; otherwise reveal it and wire the click handler. onSaved refreshes
// client capabilities so the GenAI button flips enabled/disabled live.
async function setupSettings({ onSaved, enabled = true } = {}) {
  if (!settingsBtn) {
    return;
  }
  onSavedCallback = onSaved || null;
  if (!enabled) {
    // The server said HIDE_SETTINGS: no probe, no cog.
    settingsBtn.hidden = true;
    return;
  }
  try {
    const result = await fetchSettings();
    if (result.hidden) {
      // HIDE_SETTINGS=1: no cog at all.
      settingsBtn.hidden = true;
      return;
    }
    serverSettings = result.settings;
    settingsMeta = result.meta || null;
    settingsBtn.hidden = false;
  } catch {
    // If the settings probe fails for a transient reason, still show the cog so
    // the user can retry; opening will re-fetch.
    settingsBtn.hidden = false;
  }
  settingsBtn.addEventListener("click", () => {
    if (isSettingsOpen()) {
      closeSettings();
    } else {
      void openSettings();
    }
  });
}

export { setupSettings, openSettings, isSettingsOpen, genAiBatchCount };
