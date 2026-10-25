import { randomInt } from "node:crypto";
import { isEditModel, recommendedSteps } from "./model-profiles.js";
import { fitImageSizeToBox, resizeRasterImageToSize } from "./images.js";
import { parseNonNegativeInteger, parsePositiveInteger } from "./env.js";
import { GenAiSourceTooLargeError, ProviderConfigError, RequestPolicyError } from "./errors.js";
import { REQUEST_TIMEOUT_MS, fetchWithTimeout, readJsonResponse } from "./net-policy.js";
import {
  getBooleanSetting,
  getFalApiKey,
  getFalImageModel,
  getFalTextModel,
  getGenAiApiKey,
  getGenAiVaryModifierStyle,
  getGenAiVarySeedMode,
  getIntegerSetting,
  getNumberSetting,
  getOptionalIntegerSetting,
  getOptionalNumberSetting,
  getStringSetting,
  resolveGenAiEndpoint,
  resolveGenAiEndpointValue
} from "./settings.js";
import { GENAI_MAX_REQUEST_PIXELS, getGenAiResponseMaxBytes, measureRasterImageSize, normalizeGenAiPayload } from "./genai-store.js";
import { VARY_MODIFIER_STACK_CAP, composeVaryModifier } from "./genai-vary.js";

// The fal img2img adapter inlines the whole source image as a base64 data URL in
// the request body (no upload API), so a larger source is rejected rather than
// ballooning the request. Pre-encoding bytes; base64 inflates ~4/3. Imported
// sources are downscaled into the GENAI_WIDTH x GENAI_HEIGHT box before storing,
// so this only fires for a provider-generated source.
export const FAL_VARY_MAX_SOURCE_BYTES = parseNonNegativeInteger(process.env.FAL_VARY_MAX_SOURCE_BYTES, 4 * 1024 * 1024);

const FAL_FLUX_DEV_IMAGE_TO_IMAGE_MODEL = "fal-ai/flux/dev/image-to-image";
const FAL_FLUX_DEV_IMAGE_TO_IMAGE_MIN_STEPS = 10;
export const FAL_FLUX_2_KLEIN_4B_TEXT_MODEL = "fal-ai/flux-2/klein/4b";
const FAL_FLUX_2_KLEIN_4B_EDIT_MODEL = "fal-ai/flux-2/klein/4b/edit";
// Hosted Fal refuses an undersized image with HTTP 422 `image_too_small`, whose
// context carries per-endpoint `min_width`/`min_height`. The model schemas
// publish no numeric bound, so these defaults (640x512 for the Klein pair) were
// observed from a live call; override if another Fal model reports different
// values. Hosted-only: local Draw Things has no floor. fitImageSizeToBox rounds
// these up to its 64 alignment.
const FAL_MIN_IMAGE_WIDTH = parsePositiveInteger(process.env.FAL_MIN_IMAGE_WIDTH, 640);
const FAL_MIN_IMAGE_HEIGHT = parsePositiveInteger(process.env.FAL_MIN_IMAGE_HEIGHT, 512);

export function getFalModelCapabilities() {
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

export async function generateImagesViaSdApi({ provider, prompt, negativePrompt, count, seed = null }) {
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
  const steps = resolveSdApiSteps(await sdApiModelIfNeeded(provider));
  if (steps !== null) {
    body.steps = steps;
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

export async function varyImagesViaSdApi({ provider, prompt, negativePrompt, count, sourceRecord, seed = null, strengths = null, modifierSeed = null, modifierIndexBase = 0 }) {
  const endpoint = resolveGenAiEndpoint(provider);
  const strengthRamp = Array.isArray(strengths) ? strengths : getVariationStrengthRamp(count);
  const items = [];
  const baseSeed = seed ?? createGenAiSeed();
  const fixedSeed = getGenAiVarySeedMode() === "fixed";
  // Keep the batch modifier stable even when the request carries no seed: fall
  // back to this call's baseSeed so all variations pick the same emoji.
  const effectiveModifierSeed = modifierSeed ?? baseSeed;
  const model = await sdApiModelIfNeeded(provider);
  const steps = resolveSdApiSteps(model);
  const style = getGenAiVaryModifierStyle() === "auto" ? (isEditModel(model) ? "replace" : "append") : null;
  const width = sourceRecord.width || getIntegerSetting("GENAI_WIDTH");
  const height = sourceRecord.height || getIntegerSetting("GENAI_HEIGHT");

  for (const strength of strengthRamp) {
    const requestSeed = fixedSeed ? baseSeed : baseSeed + items.length;
    const { prompt: effectivePrompt, modifier } = composeVaryModifier({
      basePrompt: prompt,
      sourceRecord,
      seed: effectiveModifierSeed,
      salt: modifierIndexBase + items.length,
      style,
      appendCount: style === "append" ? VARY_MODIFIER_STACK_CAP : null
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
    if (steps !== null) {
      body.steps = steps;
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

export async function generateImagesViaFal({ prompt, count, seed = null }) {
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

export async function varyImagesViaFal({ prompt, count, sourceRecord, seed = null, strengths = null, modifierSeed = null, modifierIndexBase = 0 }) {
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
export function resolveFalKleinEditImageSize(sourceRecord) {
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
export function resolveFalRequestImageSize(sourceWidth, sourceHeight) {
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

export async function generateImagesViaCustomEndpoint({ provider, prompt, negativePrompt, count, sourceRecord = null, seed = null }) {
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

export function buildSdApiUrl(endpoint, route) {
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

function getGenAiProviderLabel(provider) {
  return provider === "drawthings" ? "Draw Things" : "A1111";
}

export function createGenAiSeed() {
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

// The loaded model's file name, from the app's own options. Cached briefly: it
// changes only when someone picks another model in Draw Things.
const SD_API_MODEL_CACHE_MS = 30_000;
let sdApiModelCache = { at: 0, key: "", model: "" };

async function getSdApiModelName(provider) {
  const endpoint = resolveGenAiEndpoint(provider);
  const key = `${provider} ${endpoint}`;
  if (sdApiModelCache.key === key && Date.now() - sdApiModelCache.at < SD_API_MODEL_CACHE_MS) {
    return sdApiModelCache.model;
  }
  let model = "";
  try {
    const response = await fetchWithTimeout(
      buildSdApiUrl(endpoint, "options"),
      { headers: { accept: "application/json" } },
      5_000,
      { applyHostAllowlist: false, allowPrivateAddress: true, allowNonStandardPort: true }
    );
    if (response.ok) {
      const options = await response.json();
      model = String(options?.model || options?.sd_model_checkpoint || "");
    }
  } catch {
    // Unknown model: configured steps, append style.
  }
  sdApiModelCache = { at: Date.now(), key, model };
  return model;
}

// Only asked when a setting depends on it, so the default path makes no extra call.
function sdApiModelIfNeeded(provider) {
  const needed = getBooleanSetting("GENAI_STEPS_RECOMMENDED") || getGenAiVaryModifierStyle() === "auto";
  return needed ? getSdApiModelName(provider) : Promise.resolve("");
}

// Blank GENAI_STEPS sends none, so the app uses its own. GENAI_STEPS_RECOMMENDED
// overrides both for a model in model-profiles.js.
function resolveSdApiSteps(model) {
  const recommended = getBooleanSetting("GENAI_STEPS_RECOMMENDED") ? recommendedSteps(model) : null;
  return recommended ?? getOptionalIntegerSetting("GENAI_STEPS");
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

export function getVariationStrengthRamp(count) {
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
