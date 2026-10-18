// Mock fal.run provider for the GenAI contract tests.
//
// server/index.js's fal adapter posts to `${GENAI_FAL_BASE_URL}/${model}` and
// reads back `{ images: [{ url }], seed }` (see callFalModel /
// generateImagesViaFal / varyImagesViaFal). This mock speaks exactly that
// dialect from one process, routing by pathname:
//
//   POST /<text model>  -> txt2img: returns N solid-colour PNGs as data: URLs.
//   POST /<image model> -> img2img: returns 1 PNG per call (vary strength ramp).
//
// The txt2img image size is controllable via MOCK_FAL_TXT_PAYLOAD_BYTES so a
// test can force the stored source record over the server's
// FAL_VARY_MAX_SOURCE_BYTES cap and assert the 413-style rejection happens
// BEFORE any img2img call. Every request is logged so tests can assert what the
// server forwarded (and, crucially, what it did NOT).

import http from "node:http";
import { encodePng } from "./png.mjs";

const PORT = Number(process.env.MOCK_FAL_PORT || 7998);
// Approximate raw (pre-PNG) pixel budget for the txt2img output. Bigger =>
// larger stored source buffer. Default is small; the oversized-source test
// overrides it to blow past the server's 4 MB vary cap.
const TXT_PAYLOAD_BYTES = Math.max(0, Number(process.env.MOCK_FAL_TXT_PAYLOAD_BYTES || 0));
// Provider outage after N successful generation calls (-1 = never fail). The
// pool's fallback path is only observable against a provider that stops
// answering part-way through a batch.
const FAIL_AFTER = Number(process.env.MOCK_FAL_FAIL_AFTER ?? -1);
// Report every image as flagged by fal's safety checker (has_nsfw_concepts).
const NSFW = process.env.MOCK_FAL_NSFW === "1";
// Per-call latency, so a job can be held in the server's queue.
const DELAY_MS = Math.max(0, Number(process.env.MOCK_FAL_DELAY_MS || 0));
let servedCalls = 0;

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Build a solid-colour PNG. When targetBytes is set, choose a square dimension
// whose raw RGBA byte count is at least targetBytes so the encoded PNG (plus
// base64 inflation) comfortably clears the cap. Solid colour compresses well,
// so we oversize generously via the raw-pixel budget.
//
// When targetBytes is unset and a `size` ({width, height}) is given, bake at
// exactly that size instead of the tiny default tile. This lets contract
// tests fabricate sources with real, non-square pixel dimensions (e.g. to
// exercise the Klein edit image_size fit-not-stretch path in
// varyImagesViaFal/resolveFalKleinEditImageSize) without depending on the
// real Fal API or the SSRF-guarded /api/genai/source/import network fetch.
function bakePng({ prompt, seed, targetBytes, size = null }) {
  if (targetBytes > 0) {
    // Size a square so the ENCODED PNG file (what the server stores as the
    // source buffer) is at least targetBytes. PNG deflates, so solid/gradient
    // pixels would collapse far below the cap; fill with high-entropy
    // (deterministic xorshift) bytes deflate cannot compress. raw RGB bytes =
    // side*side*3 ~= encoded size for incompressible data.
    const side = Math.max(8, Math.ceil(Math.sqrt(targetBytes / 3)));
    const n = side * side * 3;
    const rgb = Buffer.alloc(n);
    let x = (0x9e3779b9 ^ side ^ hash32(`${prompt}#${seed}`)) >>> 0;
    for (let i = 0; i < n; i += 1) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      rgb[i] = x & 0xff;
    }
    return encodePng(side, side, rgb);
  }

  const width = Number.isFinite(size?.width) && size.width > 0 ? Math.round(size.width) : 8;
  const height = Number.isFinite(size?.height) && size.height > 0 ? Math.round(size.height) : 8;
  const rgb = Buffer.alloc(width * height * 3);
  // All 24 bits of the hash, one per channel. A single `% 256` hue would give
  // only 256 distinct images, and two of the pool's baked members colliding
  // makes "which key did these bytes come from" ambiguous for a test.
  const hash = hash32(`${prompt}#${seed}`);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 3;
    rgb[o] = (hash + i) & 0xff;
    rgb[o + 1] = ((hash >>> 8) + (i >> 1)) & 0xff;
    rgb[o + 2] = ((hash >>> 16) + (i >> 2)) & 0xff;
  }
  return encodePng(width, height, rgb);
}

function pngDataUrl(png) {
  return `data:image/png;base64,${png.toString("base64")}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // Generous ceiling; the server should never post more than a few MB here.
      if (size > 64 * 1024 * 1024) {
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

const REQUEST_LOG_MAX = 200;
const requestLog = [];
function recordRequest(pathname, body) {
  // Do not retain the (potentially huge) inlined source image in the log.
  const redacted = { ...body };
  if (typeof redacted.image_url === "string") {
    redacted.image_url = `data-url(${redacted.image_url.length} chars)`;
  }
  if (Array.isArray(redacted.image_urls)) {
    redacted.image_urls = redacted.image_urls.map((value) => (
      typeof value === "string" ? `data-url(${value.length} chars)` : value
    ));
  }
  requestLog.push({ path: pathname, body: redacted, at: Date.now() });
  if (requestLog.length > REQUEST_LOG_MAX) {
    requestLog.shift();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/ping") {
    sendJson(res, 200, { ok: true, mock: "fal" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/requests") {
    sendJson(res, 200, { requests: requestLog });
    return;
  }
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

  recordRequest(url.pathname, body);

  if (FAIL_AFTER >= 0 && servedCalls >= FAIL_AFTER) {
    sendJson(res, 503, { error: "mock fal outage" });
    return;
  }
  servedCalls += 1;
  if (DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  const isImg2Img = typeof body.image_url === "string" || Array.isArray(body.image_urls);
  const prompt = String(body.prompt || "");
  const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : hash32(prompt) % 100000;

  if (isImg2Img) {
    // Single-image vary call. Honour a requested image_size (Klein edit path) so
    // contract tests can build a real source image at a known size and assert the
    // next level's fit-not-stretch behaviour.
    const png = bakePng({ prompt, seed, targetBytes: 0, size: body.image_size });
    sendJson(res, 200, { images: [{ url: pngDataUrl(png) }], seed, has_nsfw_concepts: [NSFW] });
    return;
  }

  // txt2img: honour num_images; size controlled by TXT_PAYLOAD_BYTES, or by a
  // requested image_size when TXT_PAYLOAD_BYTES is unset (the default).
  const count = Math.min(15, Math.max(1, Math.floor(Number(body.num_images) || 1)));
  const images = [];
  for (let i = 0; i < count; i += 1) {
    const png = bakePng({ prompt, seed: seed + i, targetBytes: TXT_PAYLOAD_BYTES, size: body.image_size });
    images.push({ url: pngDataUrl(png) });
  }
  sendJson(res, 200, { images, seed, has_nsfw_concepts: images.map(() => NSFW) });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock fal provider listening on http://127.0.0.1:${PORT}`);
});
