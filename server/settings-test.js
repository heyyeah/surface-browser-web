// The settings page's provider tests and the startup settings summary. Kept out
// of settings.js so that module does not import the providers and job runner.
import fs from "node:fs";
import { ProviderConfigError } from "./errors.js";
import { isEditModel, recommendedSteps } from "./model-profiles.js";
import { fetchWithTimeout } from "./net-policy.js";
import {
  HIDE_SETTINGS,
  getEnvRawSetting,
  getFalApiKey,
  getGenAiProvider,
  getGenAiTimeoutMs,
  getLayerBooleanSetting,
  getLayerFalApiKey,
  getLayerGenAiProvider,
  getLayerImageSearchProvider,
  getLayerIntegerSetting,
  getLayerNumberSetting,
  getLayerOptionalIntegerSetting,
  getLayerOptionalNumberSetting,
  getLayerStringSetting,
  getRawSetting,
  hasSettingsOverrides,
  isLayerGenAiEnabled,
  normalizeGenAiVaryModifierMode,
  normalizeGenAiVaryModifierPayload,
  normalizeGenAiVaryModifierStyle,
  resolveGenAiEndpoint,
  resolveGenAiEndpointValue,
  resolveLayerGenAiEndpoint
} from "./settings.js";
import { searchImages } from "./search.js";
import { getStoredGenAiImage } from "./genai-store.js";
import { FAL_VARY_MAX_SOURCE_BYTES, buildSdApiUrl, getFalModelCapabilities } from "./genai-providers.js";
import { generateImages } from "./genai-jobs.js";

export function formatStartupSettingsSummary() {
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

export async function runSettingsTest(target, stage) {
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
      // Draw Things names the loaded file `model`, A1111 `sd_model_checkpoint`.
      const options = await response.json().catch(() => ({}));
      const model = String(options?.model || options?.sd_model_checkpoint || "");
      const steps = recommendedSteps(model);
      return {
        target: "genai",
        stage,
        provider,
        model: model ? `${model}${steps ? ` (recommended ${steps} steps)` : ""}${isEditModel(model) ? ", edit model" : ""}` : ""
      };
    }
    if (provider === "fal") {
      if (!getFalApiKey()) {
        throw new ProviderConfigError("GENAI_API_KEY or FAL_KEY is required for GENAI_PROVIDER=fal");
      }
      const capabilities = getFalModelCapabilities();
      return { target: "genai", stage, provider, model: `${capabilities.textModel}, ${capabilities.imageModel}`, profile: capabilities.id };
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
