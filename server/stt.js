// Speech-to-text relay for in-VR text entry.
//
// Quest's browser lacks the Web Speech API but supports getUserMedia + Web Audio
// capture, so dictation goes through the server: an env-selected provider
// adapter, capability-flagged in /api/health (stt.enabled), rate-limited, and
// with the transcript passed through the GenAI prompt blocklist when museum-safe
// mode is on. Audio lives only in memory for the length of the request and is
// never written to disk.
//
// Self-contained (own timeout fetch, blocklist read, multipart builder) so
// mounting it in server/index.js is a single setup call.
//
// Public surface:
//   - setupStt(app, { rateLimitMiddleware }) → mounts POST /api/stt.
//   - isSttEnabled() → boolean, for the /api/health capability payload.

import express from "express";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Config (env only — STT is operator-configured, like the other relays)
// ---------------------------------------------------------------------------

// Cap the accepted audio blob. A few seconds of WAV PCM is still comfortably
// below 10 MB; the ceiling refuses runaway/abusive uploads outright.
const MAX_AUDIO_BYTES = parsePositiveInt(process.env.STT_MAX_AUDIO_BYTES, 10 * 1024 * 1024);
const STT_TIMEOUT_MS = parsePositiveInt(process.env.STT_TIMEOUT_MS, 30_000);
const ACCEPTED_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/wav", "audio/wave", "audio/x-wav"];
const WAV_AUDIO_TYPES = ["audio/wav", "audio/wave", "audio/x-wav"];
const BUILTIN_SAMPLE_RATE = 16_000;
const BUILTIN_MODEL = String(process.env.STT_BUILTIN_MODEL || "").trim();
const BUILTIN_MODEL_CANDIDATES = BUILTIN_MODEL
  ? [BUILTIN_MODEL]
  : ["Xenova/whisper-base", "Xenova/whisper-tiny.en"];
const BUILTIN_LOCAL_ONLY = parseBoolean(process.env.STT_BUILTIN_LOCAL_ONLY, false);
// whisper.cpp / mlx-whisper style local servers take a multipart file on this
// path; overridable in case a runner exposes a different route.
const WHISPER_TRANSCRIBE_PATH = process.env.STT_WHISPER_PATH || "/inference";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODEL = process.env.STT_OPENAI_MODEL || "whisper-1";

// Museum-safe blocklist: the same gate as GenAI. index.js does not export its
// checker, so this reads the same file.
const MUSEUM_SAFE_BLOCKLIST_URL = new URL("./museum-safe-blocklist.txt", import.meta.url);
const museumSafeBlockedTerms = loadMuseumSafeBlocklist();
let builtinTranscriberPromise = null;
let builtinDependencyAvailable = null;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

function getProvider() {
  const provider = String(process.env.STT_PROVIDER || "").trim().toLowerCase();
  return provider || "builtin";
}

function getEndpoint() {
  return String(process.env.STT_ENDPOINT || "").trim();
}

function getApiKey() {
  return String(process.env.STT_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

// STT is "enabled" when a provider is fully configured:
//   - builtin is the default and only needs @huggingface/transformers installed
//   - whisper/custom need STT_ENDPOINT
//   - openai needs an API key (STT_API_KEY or OPENAI_API_KEY)
// Anything else (no provider, missing endpoint/key) → disabled → 501.
function isSttEnabled() {
  const provider = getProvider();
  if (provider === "builtin") {
    return hasBuiltinDependency();
  }
  if (provider === "off" || provider === "none" || provider === "disabled") {
    return false;
  }
  if (provider === "whisper" || provider === "custom") {
    return Boolean(getEndpoint());
  }
  if (provider === "openai") {
    return Boolean(getApiKey());
  }
  return false;
}

function isMuseumSafeEnabled() {
  return parseBoolean(process.env.GENAI_MUSEUM_SAFE, false);
}

// Same normalization shape as index.js's museum-safe text gate: collapse to
// space-delimited alphanumerics and match whole conservative terms.
function isMuseumSafeTextBlocked(text) {
  if (!isMuseumSafeEnabled()) {
    return false;
  }
  const normalized = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return museumSafeBlockedTerms.some(
    (term) => normalized.includes(` ${term.replace(/[^a-z0-9]+/g, " ")} `)
  );
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

// Mount POST /api/stt. Rate limiting is applied by index.js's global limiter,
// which lists "/api/stt", so STT shares the per-IP buckets. An optional
// `rateLimitMiddleware` attaches a limiter here instead (self-contained mounting
// and tests); omit it when index.js covers the path, to avoid double counts.
function setupStt(app, { rateLimitMiddleware, killSwitch } = {}) {
  const raw = express.raw({
    type: ACCEPTED_AUDIO_TYPES,
    limit: MAX_AUDIO_BYTES
  });

  const handlers = [];
  if (typeof rateLimitMiddleware === "function") {
    handlers.push(rateLimitMiddleware);
  }
  // The operator's emergency stop covers paid transcription as it does GenAI and
  // search, and answers before the upload is read.
  handlers.push((req, res, next) => {
    if (killSwitch?.isEngaged()) {
      res.status(503).json({ error: "disabled" });
      return;
    }
    next();
  });
  // The STT slot (index.js) is held until transcription ends, not until the
  // client disconnects; see holdSlotUntilSettled there.
  handlers.push(raw, async (req, res) => {
    res.locals.concurrencyWorkStarted = true;
    try {
      await handleStt(req, res);
    } finally {
      res.locals.releaseConcurrencySlot?.();
    }
  });

  app.post("/api/stt", ...handlers);
}

async function handleStt(req, res) {
  const provider = getProvider();
  if (!isSttEnabled()) {
    res.status(501).json({ error: "Speech-to-text is not configured on this server" });
    return;
  }

  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!isAudioTypeAcceptedForProvider(contentType, provider)) {
    res.status(415).json({
      error: provider === "builtin"
        ? "Unsupported audio type (expected audio/wav PCM)"
        : "Unsupported audio type (expected audio/webm, audio/ogg, or audio/wav)"
    });
    return;
  }

  const audio = Buffer.isBuffer(req.body) ? req.body : null;
  if (!audio || audio.length === 0) {
    res.status(400).json({ error: "Empty audio body" });
    return;
  }

  let text;
  try {
    text = await transcribe(audio, contentType);
  } catch (err) {
    const status = err instanceof SttConfigError ? 501 : 502;
    res.status(status).json({ error: err.message });
    return;
  }

  const transcript = String(text || "").trim();

  // Museum-safe: gate the transcript exactly like a GenAI prompt. Neutral
  // message so the panel status line does not echo the blocked content.
  if (isMuseumSafeTextBlocked(transcript)) {
    res.status(400).json({ error: "This request is not available in museum-safe mode" });
    return;
  }

  res.json({ text: transcript });
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

async function transcribe(audio, contentType) {
  const provider = getProvider();
  if (provider === "builtin") {
    return transcribeBuiltin(audio, contentType);
  }
  if (provider === "whisper") {
    return transcribeWhisper(audio, contentType);
  }
  if (provider === "custom") {
    return transcribeCustom(audio, contentType);
  }
  if (provider === "openai") {
    return transcribeOpenai(audio, contentType);
  }
  throw new SttConfigError("Speech-to-text is not configured on this server");
}

async function transcribeBuiltin(audio, contentType) {
  if (!WAV_AUDIO_TYPES.includes(contentType)) {
    throw new Error("Built-in STT expects 16 kHz mono WAV PCM");
  }
  const samples = decodeWavPcm(audio);
  if (process.env.NODE_ENV === "test" && process.env.STT_BUILTIN_TEST_TRANSCRIPT) {
    return process.env.STT_BUILTIN_TEST_TRANSCRIPT;
  }
  const transcriber = await getBuiltinTranscriber();
  const payload = await transcriber(samples, {
    language: "english",
    task: "transcribe"
  });
  return extractText(payload);
}

async function getBuiltinTranscriber() {
  if (builtinTranscriberPromise) {
    return builtinTranscriberPromise;
  }
  builtinTranscriberPromise = loadBuiltinTranscriber();
  return builtinTranscriberPromise;
}

async function loadBuiltinTranscriber() {
  let transformers;
  try {
    transformers = await import("@huggingface/transformers");
  } catch {
    throw new SttConfigError("Built-in STT requires @huggingface/transformers");
  }
  const { pipeline, env } = transformers;
  if (env) {
    env.useFSCache = true;
    if (BUILTIN_LOCAL_ONLY) {
      env.allowRemoteModels = false;
    }
  }

  let lastErr = null;
  for (const model of BUILTIN_MODEL_CANDIDATES) {
    try {
      console.info(
        `[Surface Browser] Loading built-in STT model ${model}. `
        + `First use may download model files into the Hugging Face cache (~100 MB+).`
      );
      return await pipeline("automatic-speech-recognition", model, {
        dtype: "q8"
      });
    } catch (err) {
      lastErr = err;
      if (BUILTIN_MODEL) {
        break;
      }
      console.warn(`[Surface Browser] Built-in STT model ${model} failed; trying fallback.`);
    }
  }
  throw new Error(`Built-in STT model unavailable: ${lastErr?.message || lastErr}`);
}

// whisper.cpp / mlx-whisper HTTP servers accept a multipart file upload. We
// hand-roll the single multipart body we need rather than pulling in a
// form-data dependency.
async function transcribeWhisper(audio, contentType) {
  const endpoint = joinUrl(getEndpoint(), WHISPER_TRANSCRIBE_PATH);
  const { body, boundary } = buildMultipartFile("file", filenameFor(contentType), contentType, audio);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  const payload = await readJsonResponse(response, "Whisper STT endpoint");
  return extractText(payload);
}

// Custom endpoint: raw audio body in, {text} out.
async function transcribeCustom(audio, contentType) {
  const response = await fetchWithTimeout(getEndpoint(), {
    method: "POST",
    headers: { "content-type": contentType },
    body: audio
  });
  const payload = await readJsonResponse(response, "Custom STT endpoint");
  return extractText(payload);
}

// OpenAI audio transcriptions API (also multipart; requires model field + key).
async function transcribeOpenai(audio, contentType) {
  const key = getApiKey();
  if (!key) {
    throw new SttConfigError("OpenAI STT requires STT_API_KEY or OPENAI_API_KEY");
  }
  const { body, boundary } = buildMultipartForm([
    { name: "model", value: OPENAI_MODEL },
    { name: "file", filename: filenameFor(contentType), contentType, data: audio }
  ]);
  const response = await fetchWithTimeout(OPENAI_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    body
  });
  const payload = await readJsonResponse(response, "OpenAI STT");
  return extractText(payload);
}

// whisper.cpp, custom, and OpenAI all return { text: "..." }; some whisper
// builds nest it or return { transcription }. Accept the common shapes.
function extractText(payload) {
  if (Array.isArray(payload)) {
    return extractText(payload[0]);
  }
  if (payload && typeof payload.text === "string") {
    return payload.text;
  }
  if (payload && typeof payload.transcription === "string") {
    return payload.transcription;
  }
  throw new Error("STT provider returned no transcript");
}

// ---------------------------------------------------------------------------
// Multipart body builders (hand-rolled — no form-data dependency)
// ---------------------------------------------------------------------------

function buildMultipartFile(fieldName, filename, contentType, data) {
  return buildMultipartForm([{ name: fieldName, filename, contentType, data }]);
}

function buildMultipartForm(parts) {
  const boundary = `----surfaceStt${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      header += `; filename="${part.filename}"`;
    }
    header += "\r\n";
    if (part.contentType) {
      header += `Content-Type: ${part.contentType}\r\n`;
    }
    header += "\r\n";
    chunks.push(Buffer.from(header, "utf8"));
    if (part.data != null && Buffer.isBuffer(part.data)) {
      chunks.push(part.data);
    } else {
      chunks.push(Buffer.from(String(part.value ?? ""), "utf8"));
    }
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), boundary };
}

function filenameFor(contentType) {
  if (WAV_AUDIO_TYPES.includes(contentType)) {
    return "audio.wav";
  }
  return contentType === "audio/ogg" ? "audio.ogg" : "audio.webm";
}

// ---------------------------------------------------------------------------
// Helpers (self-contained: this module does not reach into index.js)
// ---------------------------------------------------------------------------

class SttConfigError extends Error {}

function hasBuiltinDependency() {
  if (builtinDependencyAvailable !== null) {
    return builtinDependencyAvailable;
  }
  try {
    require.resolve("@huggingface/transformers");
    builtinDependencyAvailable = true;
  } catch {
    builtinDependencyAvailable = false;
  }
  return builtinDependencyAvailable;
}

function isAudioTypeAcceptedForProvider(contentType, provider) {
  if (!ACCEPTED_AUDIO_TYPES.includes(contentType)) {
    return false;
  }
  if (provider === "builtin") {
    return WAV_AUDIO_TYPES.includes(contentType);
  }
  return true;
}

function decodeWavPcm(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Built-in STT expected a WAV file");
  }

  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (id === "data") {
      dataStart = chunkStart;
      dataLength = size;
      break;
    }
    offset = chunkStart + size + (size % 2);
  }

  if (!fmt || dataStart < 0) {
    throw new Error("Built-in STT expected WAV fmt and data chunks");
  }
  if (fmt.sampleRate !== BUILTIN_SAMPLE_RATE || fmt.channels !== 1) {
    throw new Error("Built-in STT expected 16 kHz mono WAV PCM");
  }

  const dataEnd = Math.min(buffer.length, dataStart + dataLength);
  if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
    const sampleCount = Math.floor((dataEnd - dataStart) / 2);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = Math.max(-1, Math.min(1, buffer.readInt16LE(dataStart + (i * 2)) / 32768));
    }
    return samples;
  }
  if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
    const sampleCount = Math.floor((dataEnd - dataStart) / 4);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = Math.max(-1, Math.min(1, buffer.readFloatLE(dataStart + (i * 4))));
    }
    return samples;
  }
  throw new Error("Built-in STT supports WAV PCM16 or float32 only");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`STT request timed out after ${STT_TIMEOUT_MS}ms`);
    }
    throw new Error(`STT request failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  if (!response.ok) {
    const detail = text ? `: ${text.slice(0, 300)}` : "";
    throw new Error(`${label} returned HTTP ${response.status}${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // whisper.cpp with response-format=text returns bare text; accept it.
    if (text.trim()) {
      return { text: text.trim() };
    }
    throw new Error(`${label} returned non-JSON content`);
  }
}

function joinUrl(base, pathPart) {
  if (!pathPart) {
    return base;
  }
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = pathPart.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

function loadMuseumSafeBlocklist() {
  try {
    return fs.readFileSync(MUSEUM_SAFE_BLOCKLIST_URL, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export { setupStt, isSttEnabled };
