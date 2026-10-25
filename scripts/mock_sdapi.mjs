// Mock image-generation provider for the GenAI bake-off harness.
//
// It speaks TWO dialects from one process:
//
//   1. The `custom` relay contract that server/index.js implements
//      (POST <endpoint> {prompt, negativePrompt, count} -> {items:[...]}),
//      via GENAI_PROVIDER=custom + GENAI_ENDPOINT pointing here.
//
//   2. The AUTOMATIC1111 / Draw Things `sdapi` dialect
//      (POST /sdapi/v1/txt2img and /sdapi/v1/img2img -> {images:[b64...]}),
//      for GENAI_PROVIDER=a1111.
//
// Every image is a deterministic solid-colour PNG with the seed/strength baked
// in as text, so contact sheets are visually distinguishable and repeat runs
// are byte-stable. Zero real models, zero heavy dependencies.

import http from "node:http";
import { encodePng, makeLabeledImage } from "./png.mjs";

const PORT = Number(process.env.MOCK_SDAPI_PORT || 7999);
// Per-request artificial latency applied to EVERY generation response
// (custom `/generate`, sdapi txt2img/img2img). `MOCK_SDAPI_DELAY_MS` is the
// general knob (used to simulate real per-image generation pacing so the
// progressive-fill / tunnel→sphere handoff can be exercised headlessly);
// `MOCK_SDAPI_RESPONSE_DELAY_MS` is the older sdapi-only name, kept for
// backward compatibility. The larger of the two applies. Both default to 0,
// so existing callers that set neither are unaffected.
const RESPONSE_DELAY_MS = Math.max(
  0,
  Number(process.env.MOCK_SDAPI_DELAY_MS || 0),
  Number(process.env.MOCK_SDAPI_RESPONSE_DELAY_MS || 0)
);

// Deterministic 32-bit hash so a given (prompt, seed) always maps to the same
// hue — makes txt2img output stable and vary output visibly related but shifted.
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function bakeImage({ prompt, seed, width, height, strength }) {
  const hue = hash32(`${prompt}#${seed}`) % 360;
  // For vary calls, strength nudges lightness so the ramp reads visually.
  const lightness = strength == null ? 0.5 : 0.35 + 0.4 * strength;
  const rgb = makeLabeledImage(width, height, hslToRgb(hue, 0.6, lightness), [
    strength == null ? "GEN" : "VARY",
    `SEED:${seed}`,
    strength == null ? "" : `STR:${strength.toFixed(2)}`
  ]);
  return encodePng(width, height, rgb).toString("base64");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function delayResponse() {
  if (!RESPONSE_DELAY_MS) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
}

// Optional in-memory request log (opt-in, backward compatible). Contract tests
// enable it to assert what the server actually forwarded to the provider — e.g.
// that the museum-safe negative prompt reached the sdapi call. It is a bounded
// ring buffer so a long-lived mock never grows unbounded. Existing callers that
// never touch /requests or /__reset are unaffected.
const REQUEST_LOG_MAX = 200;
const requestLog = [];
function recordRequest(pathname, body) {
  requestLog.push({ path: pathname, body, at: Date.now() });
  if (requestLog.length > REQUEST_LOG_MAX) {
    requestLog.shift();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Cheap liveness ping (the harness waits on the API's /api/health, not this).
  if (req.method === "GET" && url.pathname === "/ping") {
    sendJson(res, 200, { ok: true, mock: "sdapi" });
    return;
  }

  // The app's current options; only the model name is read.
  if (req.method === "GET" && url.pathname === "/sdapi/v1/options") {
    sendJson(res, 200, { model: process.env.MOCK_SDAPI_MODEL || "mock_model.ckpt", steps: 20 });
    return;
  }

  // Inspect what the server forwarded (contract tests only).
  if (req.method === "GET" && url.pathname === "/requests") {
    sendJson(res, 200, { requests: requestLog });
    return;
  }

  // Clear the request log between assertions.
  if (req.method === "POST" && url.pathname === "/__reset") {
    requestLog.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  // --- Dialect 1: the `custom` relay contract -----------------------------
  // server/index.js posts {prompt, negativePrompt, count}. No `source` field is
  // forwarded by the custom adapter, so this path cannot do img2img variations
  // — the harness detects the absence of lineage ids and records that.
  if (url.pathname === "/" || url.pathname === "/generate") {
    await delayResponse();
    const prompt = String(body.prompt || "");
    const count = clampCount(body.count, 7);
    const width = Number(body.width) || 512;
    const height = Number(body.height) || 512;
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const seed = (hash32(`${prompt}/${i}`) % 100000) + 1;
      items.push({
        imageUrl: `data:image/png;base64,${bakeImage({ prompt, seed, width, height, strength: null })}`,
        width,
        height
      });
    }
    sendJson(res, 200, { items });
    return;
  }

  // --- Dialect 2: sdapi (a1111) -------------------------------------------
  if (url.pathname === "/sdapi/v1/txt2img") {
    recordRequest(url.pathname, body);
    await delayResponse();
    const prompt = String(body.prompt || "");
    const count = clampCount(body.batch_size ?? body.n_iter, 1);
    const width = Number(body.width) || 512;
    const height = Number(body.height) || 512;
    const baseSeed = Number.isFinite(Number(body.seed)) && Number(body.seed) >= 0 ? Number(body.seed) : hash32(prompt) % 100000;
    const images = [];
    for (let i = 0; i < count; i += 1) {
      images.push(bakeImage({ prompt, seed: baseSeed + i, width, height, strength: null }));
    }
    // Real A1111 reports every batch seed via info.all_seeds (info is a JSON *string*).
    const allSeeds = images.map((_, i) => baseSeed + i);
    sendJson(res, 200, {
      images,
      parameters: { seed: baseSeed },
      info: JSON.stringify({ seed: baseSeed, all_seeds: allSeeds })
    });
    return;
  }

  if (url.pathname === "/sdapi/v1/img2img") {
    recordRequest(url.pathname, body);
    await delayResponse();
    const prompt = String(body.prompt || "");
    const count = clampCount(body.batch_size ?? body.n_iter, 1);
    const width = Number(body.width) || 512;
    const height = Number(body.height) || 512;
    const strength = Number.isFinite(Number(body.denoising_strength)) ? Number(body.denoising_strength) : 0.5;
    // seed:-1 means "random per call" on real A1111; stay deterministic for tests
    // but vary by strength so a vary ramp gets distinct seeds like a real provider.
    const baseSeed = Number.isFinite(Number(body.seed)) && Number(body.seed) >= 0
      ? Number(body.seed)
      : hash32(`${prompt}:vary:${strength}`) % 100000;
    const images = [];
    for (let i = 0; i < count; i += 1) {
      images.push(bakeImage({ prompt, seed: baseSeed + i, width, height, strength }));
    }
    const allSeeds = images.map((_, i) => baseSeed + i);
    sendJson(res, 200, {
      images,
      parameters: { seed: baseSeed, denoising_strength: strength },
      info: JSON.stringify({ seed: baseSeed, all_seeds: allSeeds })
    });
    return;
  }

  sendJson(res, 404, { error: `unknown path ${url.pathname}` });
});

function clampCount(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(15, Math.max(1, Math.floor(n)));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock sdapi provider listening on http://127.0.0.1:${PORT}`);
});
