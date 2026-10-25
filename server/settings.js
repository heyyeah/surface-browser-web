import fs from "node:fs";
import path from "node:path";
import { clampNumber, parseBoolean, resolveFilePath } from "./env.js";
import { ProviderConfigError } from "./errors.js";
import { GENAI_DEFAULT_ENDPOINTS, GENAI_PROVIDER_ENDPOINT_KEYS, GENAI_PROVIDERS } from "../shared/genai-provider-table.js";

export const DEFAULT_LIMIT = 15;
export const SETTINGS_FILE_PATH = process.env.SETTINGS_FILE_PATH || new URL("./settings.local.json", import.meta.url);
const MUSEUM_SAFE_BLOCKLIST_URL = new URL("./museum-safe-blocklist.txt", import.meta.url);
export const HIDE_SETTINGS = parseBoolean(process.env.HIDE_SETTINGS, false);

// Unset until initSettings(), which index.js calls at the point in boot where it
// used to load them.
let settingsOverrides;
let museumSafeBlockedTerms;

export function initSettings() {
  settingsOverrides = loadSettingsOverrides();
  museumSafeBlockedTerms = loadMuseumSafeBlocklist();
}

// PUT /api/settings: adopt a validated override set and persist it.
export function replaceSettingsOverrides(nextOverrides) {
  settingsOverrides = nextOverrides;
  writeSettingsOverrides(settingsOverrides);
}

export const SETTING_DEFINITIONS = Object.freeze({
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
  GENAI_STEPS_RECOMMENDED: { defaultValue: false, type: "boolean" },
  GENAI_CFG_SCALE: { defaultValue: "", type: "optionalNumber", min: 0.1, max: 30 },
  GENAI_DRAWTHINGS_GUIDANCE_EMBED: { defaultValue: 5, type: "optionalNumber", min: 0.1, max: 30 },
  GENAI_VARIATION_STRENGTH_MIN: { defaultValue: 0.95, type: "number", min: 0, max: 1 },
  GENAI_VARIATION_STRENGTH_MAX: { defaultValue: 1, type: "number", min: 0, max: 1 },
  GENAI_VARY_SEED_MODE: { defaultValue: "fresh", type: "genAiVarySeedMode" },
  GENAI_VARY_MODIFIERS: { defaultValue: "🧊 🌶️ 🦄 🎆 🍦 🧀 🌹 😎 🪩 🦦 🦘 ❄️ 🌊 🌕 🌲 🍌 💡 🕯️ 🚿", type: "string" },
  GENAI_VARY_MODIFIER_MODE: { defaultValue: "per-image", type: "genAiVaryModifierMode" },
  GENAI_VARY_MODIFIER_STYLE: { defaultValue: "replace", type: "genAiVaryModifierStyle" },
  GENAI_VARY_MODIFIER_PAYLOAD: { defaultValue: "text", type: "genAiVaryModifierPayload" },
  // Emoji texts over the built-in ones: "🦦 otter, wet fur" per line (or ";").
  GENAI_VARY_MODIFIER_TEXTS: { defaultValue: "", type: "string" },
  // Append style (fal Klein): how many of the newest stack emoji go in the sent prompt.
  GENAI_VARY_PROMPT_EMOJI: { defaultValue: 2, type: "integer", min: 1, max: 6 },
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

export function loadSettingsOverrides() {
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

export function loadMuseumSafeBlocklist() {
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

export function writeSettingsOverrides(overrides) {
  // SETTINGS_FILE_PATH may point outside the checkout, so the directory may not
  // exist yet.
  fs.mkdirSync(path.dirname(resolveFilePath(SETTINGS_FILE_PATH)), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE_PATH, `${JSON.stringify(overrides, null, 2)}\n`);
}

export function getSettingSource(key) {
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

export function getRawSetting(key) {
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

export function getStringSetting(key) {
  return String(getRawSetting(key) ?? "").trim();
}

export function getIntegerSetting(key) {
  const definition = SETTING_DEFINITIONS[key];
  return clampNumber(getRawSetting(key), definition.min ?? 0, definition.max ?? Number.MAX_SAFE_INTEGER, definition.defaultValue);
}

export function getNumberSetting(key) {
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(getRawSetting(key));
  if (!Number.isFinite(parsed)) {
    return definition.defaultValue;
  }
  return Math.min(definition.max ?? Number.MAX_VALUE, Math.max(definition.min ?? 0, parsed));
}

export function getOptionalIntegerSetting(key) {
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

export function getOptionalNumberSetting(key) {
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

export function getBooleanSetting(key) {
  return parseBoolean(getRawSetting(key), SETTING_DEFINITIONS[key]?.defaultValue || false);
}

export function isMuseumSafeEnabled() {
  return getBooleanSetting("GENAI_MUSEUM_SAFE");
}

export function isMuseumSafeTextBlocked(text) {
  if (!isMuseumSafeEnabled()) {
    return false;
  }
  const normalized = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return museumSafeBlockedTerms.some((term) => normalized.includes(` ${term.replace(/[^a-z0-9]+/g, " ")} `));
}

export function withMuseumSafeNegativePrompt(negativePrompt) {
  if (!isMuseumSafeEnabled()) {
    return negativePrompt;
  }
  const safetyNegative = "nsfw, nudity, gore, graphic violence, explicit sexual content";
  return [negativePrompt, safetyNegative].filter(Boolean).join(", ");
}

export function getGenAiApiKey() {
  return getStringSetting("GENAI_API_KEY");
}

export function getFalApiKey() {
  return getStringSetting("GENAI_API_KEY") || getStringSetting("FAL_KEY");
}

export function getFalTextModel() {
  return getStringSetting("GENAI_FAL_TEXT_MODEL");
}

export function getFalImageModel() {
  return getStringSetting("GENAI_FAL_IMAGE_MODEL");
}

export function getGenAiTimeoutMs() {
  return getIntegerSetting("GENAI_TIMEOUT_MS");
}

export function getGenAiImageRetentionDays() {
  return getIntegerSetting("GENAI_IMAGE_RETENTION_DAYS");
}

export function getGenAiSaveImagesToDisk() {
  return getBooleanSetting("GENAI_SAVE_IMAGES_TO_DISK");
}

export function getGenAiCleanupImages() {
  return getBooleanSetting("GENAI_CLEANUP_IMAGES");
}

export function isApiQueryLoggingEnabled() {
  return getBooleanSetting("LOG_API_QUERIES");
}

export function safeResolvedGenAiEndpoint(provider) {
  try {
    return resolveGenAiEndpointValue(provider) || "";
  } catch {
    return "";
  }
}

export function getPublicSettings() {
  const publicSettings = {};
  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    const rawValue = getRawSetting(key);
    publicSettings[key] = {
      value: definition.type === "secret" ? maskSecret(rawValue) : coerceSettingValue(rawValue, definition),
      source: getSettingSource(key),
      secret: definition.type === "secret",
      // What it would be without the saved override, so the panel can tell a
      // real change from a saved copy of the default.
      fallback: definition.type === "secret" ? null : coerceSettingValue(
        process.env[key] !== undefined && process.env[key] !== "" ? process.env[key] : definition.defaultValue,
        definition
      )
    };
  }
  return publicSettings;
}

export function hasSettingsOverrides() {
  return Object.keys(settingsOverrides).length > 0;
}

export function getEnvRawSetting(key) {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) {
    return undefined;
  }
  if (process.env[key] !== undefined && process.env[key] !== "") {
    return process.env[key];
  }
  return definition.defaultValue;
}

export function getLayerImageSearchProvider(readRawSetting) {
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

export function getLayerGenAiProvider(readRawSetting) {
  const configuredProvider = normalizeGenAiProvider(getLayerStringSetting(readRawSetting, "GENAI_PROVIDER"));
  if (configuredProvider) {
    return configuredProvider;
  }
  if (getLayerStringSetting(readRawSetting, "GENAI_ENDPOINT")) {
    return "custom";
  }
  return "disabled";
}

export function isLayerGenAiEnabled(readRawSetting, provider) {
  return Boolean(
    resolveLayerGenAiEndpoint(readRawSetting, provider)
    || (provider === "fal" && getLayerFalApiKey(readRawSetting))
  );
}

export function resolveLayerGenAiEndpoint(readRawSetting, provider) {
  return getLayerProviderEndpoint(readRawSetting, provider)
    || getLayerStringSetting(readRawSetting, "GENAI_ENDPOINT")
    || GENAI_DEFAULT_ENDPOINTS[provider]
    || "";
}

export function getLayerFalApiKey(readRawSetting) {
  return getLayerStringSetting(readRawSetting, "GENAI_API_KEY") || getLayerStringSetting(readRawSetting, "FAL_KEY");
}

export function getLayerStringSetting(readRawSetting, key) {
  return String(readRawSetting(key) ?? "").trim();
}

export function getLayerIntegerSetting(readRawSetting, key) {
  const definition = SETTING_DEFINITIONS[key];
  return clampNumber(readRawSetting(key), definition.min ?? 0, definition.max ?? Number.MAX_SAFE_INTEGER, definition.defaultValue);
}

export function getLayerNumberSetting(readRawSetting, key) {
  const definition = SETTING_DEFINITIONS[key];
  const parsed = Number(readRawSetting(key));
  if (!Number.isFinite(parsed)) {
    return definition.defaultValue;
  }
  return Math.min(definition.max ?? Number.MAX_VALUE, Math.max(definition.min ?? 0, parsed));
}

export function getLayerOptionalIntegerSetting(readRawSetting, key) {
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

export function getLayerOptionalNumberSetting(readRawSetting, key) {
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

export function getLayerBooleanSetting(readRawSetting, key) {
  return parseBoolean(readRawSetting(key), SETTING_DEFINITIONS[key]?.defaultValue || false);
}

export function maskSecret(value) {
  const str = String(value || "");
  if (!str) {
    return "";
  }
  if (str.length <= 8) {
    return "****";
  }
  return `${str.slice(0, 3)}...${str.slice(-4)}`;
}

export function validateSettingsUpdate(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    throw new Error("Settings payload must be an object");
  }
  const next = { ...settingsOverrides };
  for (const [key, value] of Object.entries(rawSettings)) {
    const definition = SETTING_DEFINITIONS[key];
    if (!definition) {
      throw new Error(`Unknown setting: ${key}`);
    }
    // A blank optional number is a value, "send none", not a reset: otherwise a
    // cleared Steps field falls back to its default of 8.
    if (value === "" && definition.type.startsWith("optional")) {
      next[key] = "";
      continue;
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
    if (provider && GENAI_DEFAULT_ENDPOINTS[provider]) {
      delete next.GENAI_ENDPOINT;
    }
  }
  return next;
}

export function coerceSettingValue(value, definition) {
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

export function getOptionalIntegerSettingFromValue(value, definition) {
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

export function getOptionalNumberSettingFromValue(value, definition) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < definition.min || parsed > definition.max) {
    throw new Error(`Number setting must be between ${definition.min} and ${definition.max}`);
  }
  return parsed;
}

export function normalizeImageSearchProvider(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "duckduckgo") {
    return "ddg";
  }
  if (value === "ddg" || value === "serper" || value === "brave" || value === "custom") {
    return value;
  }
  return "";
}

export function normalizeGenAiProvider(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "relay" || (value && GENAI_PROVIDERS.some((provider) => provider.value === value))) {
    return value;
  }
  return "";
}

export function normalizeGenAiVarySeedMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "fresh" || value === "fixed") {
    return value;
  }
  return "";
}

export function normalizeGenAiVaryModifierMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "off" || value === "batch" || value === "per-image") {
    return value;
  }
  return "";
}

export function normalizeGenAiVaryModifierStyle(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "replace" || value === "append" || value === "auto") {
    return value;
  }
  return "";
}

export function normalizeGenAiVaryModifierPayload(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "emoji" || value === "text") {
    return value;
  }
  return "";
}

// VR wrist UI handedness. The client can override it per page load with
// `?wrist=left|right`; this is the persisted default.
export function normalizeWristPanelHand(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "left" || value === "right") {
    return value;
  }
  return "";
}

export function getWristPanelHand() {
  return normalizeWristPanelHand(getStringSetting("WRIST_PANEL_HAND")) || "left";
}

export function getGenAiVaryModifierMode() {
  return normalizeGenAiVaryModifierMode(getStringSetting("GENAI_VARY_MODIFIER_MODE")) || "per-image";
}

export function getGenAiVaryModifierStyle() {
  return normalizeGenAiVaryModifierStyle(getStringSetting("GENAI_VARY_MODIFIER_STYLE")) || "replace";
}

export function getGenAiVaryModifierPayload() {
  return normalizeGenAiVaryModifierPayload(getStringSetting("GENAI_VARY_MODIFIER_PAYLOAD")) || "text";
}

export function getImageSearchProvider() {
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

export function getGenAiProvider() {
  const configuredProvider = normalizeGenAiProvider(getStringSetting("GENAI_PROVIDER"));
  if (configuredProvider) {
    return configuredProvider;
  }
  if (getStringSetting("GENAI_ENDPOINT")) {
    return "custom";
  }
  return "disabled";
}

export function getGenAiVarySeedMode() {
  return normalizeGenAiVarySeedMode(getStringSetting("GENAI_VARY_SEED_MODE")) || "fresh";
}

export function isGenAiEnabled() {
  const provider = getGenAiProvider();
  return Boolean(
    resolveGenAiEndpointValue(provider)
    || (provider === "fal" && getFalApiKey())
  );
}

export function resolveGenAiEndpoint(provider) {
  const endpoint = resolveGenAiEndpointValue(provider);
  if (endpoint) {
    return endpoint;
  }
  throw new ProviderConfigError(`GENAI_ENDPOINT is required for GENAI_PROVIDER=${provider}`);
}

export function resolveGenAiEndpointValue(provider) {
  return getProviderEndpoint(provider)
    || getLegacyGenAiEndpoint(provider)
    || GENAI_DEFAULT_ENDPOINTS[provider]
    || "";
}

export function getLegacyGenAiEndpoint(provider) {
  const endpoint = getStringSetting("GENAI_ENDPOINT");
  if (!endpoint) {
    return "";
  }
  // Back-compat for old env-only setups: GENAI_PROVIDER=a1111 + GENAI_ENDPOINT=...
  // should keep working. But once the settings UI saves a provider, that provider
  // choice should not inherit an unrelated legacy endpoint from .env or an older
  // settings file.
  if (GENAI_DEFAULT_ENDPOINTS[provider] && getSettingSource("GENAI_PROVIDER") === "override") {
    return "";
  }
  return endpoint;
}

export function getProviderEndpoint(provider) {
  const key = getProviderEndpointSettingKey(provider);
  return key ? getStringSetting(key) : "";
}

export function getLayerProviderEndpoint(readRawSetting, provider) {
  const key = getProviderEndpointSettingKey(provider);
  return key ? getLayerStringSetting(readRawSetting, key) : "";
}

export function getProviderEndpointSettingKey(provider) {
  if (provider === "relay") {
    return GENAI_PROVIDER_ENDPOINT_KEYS.custom;
  }
  return Object.hasOwn(GENAI_PROVIDER_ENDPOINT_KEYS, provider) ? GENAI_PROVIDER_ENDPOINT_KEYS[provider] : "";
}
