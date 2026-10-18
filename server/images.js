// Raster image inspection and import normalization.
//
// Split out of server/index.js so it can be unit tested directly: the
// /api/genai/source/import happy path is unreachable from a contract test because
// its SSRF guard rejects every loopback fixture host by design.
//
// Everything here throws ImageFormatError; server/index.js re-throws those as
// RequestPolicyError so they keep answering 400 with the same message.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export class ImageFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImageFormatError";
  }
}

// Bound decode work independently of the download cap: a small file can still
// declare an enormous canvas. Matches the header-level guard below.
const MAX_IMPORT_PIXELS = 64_000_000;

let sharpModulePromise = null;

// Lazy, like the playwright fallback in index.js: sharp is a declared dependency
// but a native one, so a load failure should surface as a clear message on the
// one route that needs it rather than stopping the server from booting.
function loadSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = import("sharp")
      .then((module) => module.default)
      .catch((err) => {
        sharpModulePromise = null;
        throw new ImageFormatError(`Image resizing is unavailable on this server (${err.message})`);
      });
  }
  return sharpModulePromise;
}

// Sniff the real pixel format from the file header. Never trust the declared
// content type: this gate is also what keeps SVG (and anything else with a
// remote-reference/XXE surface) away from the decoders below; SVG goes only
// through rasterizeSvg.
export function detectRasterImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
      return null;
    }
    // IHDR is width-then-height.
    return validatedRasterDimensions("image/png", buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return inspectJpegDimensions(buffer);
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return inspectWebpDimensions(buffer);
  }
  if (buffer.toString("ascii", 0, 3) === "GIF" && /^8[79]a$/.test(buffer.toString("ascii", 3, 6))) {
    // Logical screen descriptor, little-endian width then height. This is the
    // canvas size the decoder composes frames onto, which is what we resize.
    return validatedRasterDimensions("image/gif", buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }
  return null;
}

function inspectJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > buffer.length) {
      return null;
    }
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length) {
      return null;
    }
    // All JPEG SOF markers carry the frame size here, and unlike PNG's IHDR it is
    // height first: [length:2][precision:1][height:2][width:2]. Keep the two reads
    // named so the order cannot silently flip.
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (size < 8) {
        return null;
      }
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return validatedRasterDimensions("image/jpeg", width, height);
    }
    offset += size;
  }
  return null;
}

function inspectWebpDimensions(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) {
      return null;
    }
    if (chunkType === "VP8X" && chunkSize >= 10) {
      return validatedRasterDimensions("image/webp", buffer.readUIntLE(dataOffset + 4, 3) + 1, buffer.readUIntLE(dataOffset + 7, 3) + 1);
    }
    if (chunkType === "VP8L" && chunkSize >= 5 && buffer[dataOffset] === 0x2f) {
      const bits = buffer.readUInt32LE(dataOffset + 1);
      return validatedRasterDimensions("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunkType === "VP8 " && chunkSize >= 10 && buffer[dataOffset + 3] === 0x9d && buffer[dataOffset + 4] === 0x01 && buffer[dataOffset + 5] === 0x2a) {
      return validatedRasterDimensions("image/webp", buffer.readUInt16LE(dataOffset + 6) & 0x3fff, buffer.readUInt16LE(dataOffset + 8) & 0x3fff);
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return null;
}

function validatedRasterDimensions(contentType, width, height) {
  // Guard decode memory downstream. Oversized files are downscaled on import, but
  // an absurd canvas is refused.
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > MAX_IMPORT_PIXELS) {
    throw new ImageFormatError("Selected image dimensions are not supported");
  }
  return { contentType, width, height };
}

// GIF is accepted as an INPUT format only: its first frame is decoded and
// transcoded to PNG by normalizeImportedRasterImage, so providers that only
// take PNG/JPEG/WebP never see one.
export function inspectImportedRasterImage(buffer, declaredContentType) {
  const detected = detectRasterImage(buffer);
  if (!detected) {
    throw new ImageFormatError("Selected file must be a PNG, JPEG, GIF, or WebP image");
  }
  const declared = String(declaredContentType || "").split(";", 1)[0].trim().toLowerCase();
  const normalizedDeclared = declared === "image/jpg" ? "image/jpeg" : declared;
  if (normalizedDeclared && normalizedDeclared !== "application/octet-stream" && normalizedDeclared !== detected.contentType) {
    throw new ImageFormatError("Selected image content type does not match its file data");
  }
  return detected;
}

// ---------------------------------------------------------------------------
// Texture proxy downscale
// ---------------------------------------------------------------------------
//
// The client hands /api/proxy/image URLs to THREE.TextureLoader (`new Image()`),
// so decode, GPU upload and mip generation all land synchronously on the first
// frame the material renders. A 3000x2000 JPEG is ~24 MB of RGBA plus ~8 MB of
// mips in one frame, which stutters the tunnel. Capping the long edge at 1024 px
// bounds that regardless of what a search result hands us.
//
// Design rules, in priority order:
//   1. A broken image is worse than a large one. Anything this cannot handle
//      (unreadable header, SVG, a sharp failure, a missing native binding) is
//      passed through untouched. It never fails the request.
//   2. Downscale only, never upscale. Thumbnails already under the cap never
//      reach the decoder.
//   3. Aspect ratio is preserved exactly (`fit: "inside"`), because sphere.js
//      lays its panels out from texture.image.naturalWidth/naturalHeight.
//   4. Format is preserved, so alpha survives. GIF is the exception: it
//      transcodes to PNG, keeping alpha and dropping the animation a WebGL
//      texture could not show anyway.
//   5. `.rotate()` bakes EXIF orientation into the pixels. Re-encoding drops
//      EXIF, so without it a rotated phone photo would render sideways.
export const PROXY_IMAGE_MAX_EDGE_PX = 1024;

// Sniffed content type -> the sharp encoder that preserves it. GIF maps to PNG
// (rule 4). Anything absent from this table is passed through.
const PROXY_IMAGE_ENCODERS = {
  "image/jpeg": (pipeline) => pipeline.jpeg({ quality: 86, mozjpeg: false }),
  "image/png": (pipeline) => pipeline.png({ compressionLevel: 6, palette: false }),
  "image/webp": (pipeline) => pipeline.webp({ quality: 86 }),
  "image/gif": (pipeline) => pipeline.png({ compressionLevel: 6, palette: false })
};

const PROXY_IMAGE_OUTPUT_TYPES = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/png"
};

// Decide, from the header alone, whether this buffer needs the decoder at all.
// Exported separately from the resize so the pass-through rules are testable
// without sharp.
export function planProxyImageDownscale(buffer, maxEdgePx = PROXY_IMAGE_MAX_EDGE_PX) {
  let detected = null;
  try {
    // Throws on an absurd declared canvas and returns null on SVG or anything
    // unrecognised. Both mean "pass through": this route is a texture proxy, not an
    // importer, and refuses nothing the verbatim path served.
    detected = detectRasterImage(buffer);
  } catch {
    return { resize: false, reason: "unsupported-dimensions" };
  }
  if (!detected) {
    return { resize: false, reason: "unrecognized-format" };
  }
  if (!PROXY_IMAGE_ENCODERS[detected.contentType]) {
    return { resize: false, reason: "no-encoder", detected };
  }
  // Header dimensions are pre-EXIF; a rotated JPEG swaps them, but max() is
  // orientation-invariant, so the "already small enough" test holds either way.
  if (Math.max(detected.width, detected.height) <= maxEdgePx) {
    return { resize: false, reason: "within-cap", detected };
  }
  return { resize: true, reason: "oversize", detected };
}

// Downscale a proxied texture so its long edge is at most `maxEdgePx`. Always
// resolves: on any failure it returns the input buffer and content type
// unchanged (rule 1). `resized` says which happened.
export async function downscaleProxiedImage(buffer, contentType, maxEdgePx = PROXY_IMAGE_MAX_EDGE_PX) {
  const plan = planProxyImageDownscale(buffer, maxEdgePx);
  if (!plan.resize) {
    return { buffer, contentType, resized: false, reason: plan.reason };
  }
  try {
    const sharp = await loadSharp();
    const output = await PROXY_IMAGE_ENCODERS[plan.detected.contentType](
      sharp(buffer, { limitInputPixels: MAX_IMPORT_PIXELS, failOn: "error", animated: false })
        // rotate() before resize() so `inside` measures the post-EXIF shape.
        .rotate()
        .resize({
          width: maxEdgePx,
          height: maxEdgePx,
          fit: "inside",
          withoutEnlargement: true
        })
    ).toBuffer();
    return {
      buffer: output,
      contentType: PROXY_IMAGE_OUTPUT_TYPES[plan.detected.contentType],
      resized: true,
      reason: "resized"
    };
  } catch (err) {
    // Rule 1: a sharp that cannot load or decode this file must not turn a working
    // image into a 502.
    return { buffer, contentType, resized: false, reason: `failed:${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// SVG rasterising
// ---------------------------------------------------------------------------
//
// SVG is never served as SVG: on our origin it could run script. It is drawn
// to a PNG here and only the PNG leaves the server. librsvg (inside sharp) then
// reads attacker-controlled input, so before it does: a size cap, no DOCTYPE or
// entities (expansion bombs), no script or foreignObject, and every href and
// url() that points outside the document removed. sharp is given a buffer, not
// a path, so librsvg has no base location to load relative files from either.
const SVG_MAX_BYTES = 1_000_000;
const SVG_RENDER_TIMEOUT_S = 5;
// Includes the child's start-up (node + sharp, ~0.2 s).
const SVG_RENDER_KILL_MS = (SVG_RENDER_TIMEOUT_S + 1) * 1000;
const SVG_RENDER_WORKER = fileURLToPath(new URL("./svg-render-worker.js", import.meta.url));
// librsvg draws at 72 dpi = one SVG unit per pixel; this caps the scale-up of a
// tiny declared size.
const SVG_MAX_DENSITY = 72 * 16;
// Icon libraries draw at 16-24 units; a page's real SVG artwork is larger.
export const SVG_MIN_EDGE_PX = 32;

export function looksLikeSvg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return false;
  }
  const head = buffer.toString("utf8", 0, Math.min(buffer.length, 4096)).replace(/^\uFEFF/, "");
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>\s*)?<svg[\s>]/i.test(head);
}

export function sanitizeSvg(text) {
  if (/<!(doctype|entity)/i.test(text)) {
    throw new ImageFormatError("SVG with a DOCTYPE is not supported");
  }
  return text
    .replace(/<script[\s\S]*?<\/script\s*>|<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>|<foreignObject[^>]*\/>/gi, "")
    .replace(/\s(xlink:)?href\s*=\s*("[^"#][^"]*"|'[^'#][^']*'|[^\s"'#>][^\s>]*)/gi, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, "none");
}

// Resolves a PNG whose long edge is maxEdgePx (up or down), or throws
// ImageFormatError.
//
// The render runs in a child process that is killed at the deadline. sharp's own
// timeout is only checked between tiles, and a few KB of <use>d filters made one
// tile take 30 s while holding a libuv thread the whole server shares.
export async function rasterizeSvg(buffer, maxEdgePx = PROXY_IMAGE_MAX_EDGE_PX) {
  if (buffer.length > SVG_MAX_BYTES) {
    throw new ImageFormatError("SVG is too large");
  }
  const clean = Buffer.from(sanitizeSvg(buffer.toString("utf8")));
  return new Promise((resolve, reject) => {
    const child = fork(SVG_RENDER_WORKER, [], { serialization: "advanced", execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let done = false;
    const finish = (err, png) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (err) {
        reject(err);
      } else {
        resolve(png);
      }
    };
    const timer = setTimeout(() => finish(new ImageFormatError("SVG took too long to draw")), SVG_RENDER_KILL_MS);
    child.once("message", (reply) => {
      if (reply?.png) {
        finish(null, Buffer.from(reply.png));
      } else {
        finish(new ImageFormatError(reply?.formatError ? reply.message : `SVG could not be drawn (${reply?.message})`));
      }
    });
    child.once("error", (err) => finish(new ImageFormatError(`SVG could not be drawn (${err.message})`)));
    child.once("exit", () => finish(new ImageFormatError("SVG could not be drawn")));
    child.send({ svg: clean, maxEdgePx });
  });
}

// The in-process render, for server/svg-render-worker.js only.
export async function renderSanitizedSvg(clean, maxEdgePx) {
  const sharp = await loadSharp();
  const options = { limitInputPixels: MAX_IMPORT_PIXELS, failOn: "error" };
  try {
    const meta = await sharp(clean, options).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    if (!longEdge) {
      throw new ImageFormatError("SVG has no size");
    }
    if (longEdge < SVG_MIN_EDGE_PX) {
      throw new ImageFormatError("SVG is icon-sized");
    }
    const density = Math.min(SVG_MAX_DENSITY, Math.max(1, (72 * maxEdgePx) / longEdge));
    return await sharp(clean, { ...options, density })
      .resize({ width: maxEdgePx, height: maxEdgePx, fit: "inside" })
      .png({ compressionLevel: 6 })
      .timeout({ seconds: SVG_RENDER_TIMEOUT_S })
      .toBuffer();
  } catch (err) {
    if (err instanceof ImageFormatError) {
      throw err;
    }
    throw new ImageFormatError(`SVG could not be drawn (${err.message})`);
  }
}

// A smaller copy for the wire. Resolves null when sharp cannot produce one or
// the result is no smaller, so the caller serves the original.
export async function encodeWebpForDelivery(buffer, quality) {
  try {
    const sharp = await loadSharp();
    const output = await sharp(buffer, { limitInputPixels: MAX_IMPORT_PIXELS, failOn: "error", animated: false })
      .webp({ quality })
      .toBuffer();
    return output.length < buffer.length ? output : null;
  } catch {
    return null;
  }
}

// 64, not 8 or 16: a latent-diffusion UNet downsamples by 8 and again through
// its own stages, so 64 is the granularity every SD-family pipeline agrees on,
// and a native implementation may not validate it (Draw Things crashes on
// non-64 sizes instead of returning an error).
const DIMENSION_STEP = 64;

function snapDimensionDownToMultiple(value, step) {
  const snapped = Math.floor(value / step) * step;
  return snapped >= step ? snapped : step;
}

// Snap to the nearest multiple, then clamp into the box. Rounding down on both
// axes independently distorts the aspect ratio: a 320x256 source fitted into a
// 256x256 box lands on 256x204.8, which floors to 256x192 (1.33 vs 1.25), where
// nearest gives 256x208 (1.23). Rounding up cannot breach the box because the
// clamp's ceiling is itself a floored multiple of `step`.
function snapDimensionToNearestMultiple(value, step, maxValue) {
  const snapped = Math.round(value / step) * step;
  return Math.min(Math.max(snapped, step), maxValue);
}

function snapDimensionUpToMultiple(value, step) {
  const snapped = Math.ceil(value / step) * step;
  return snapped >= step ? snapped : step;
}

// Fit a source's aspect ratio inside the configured GENAI_WIDTH x GENAI_HEIGHT
// box, never upscaling past it, snapped to a multiple of DIMENSION_STEP. One
// policy, two users: the explicit image_size sent with every Fal Klein edit
// request, and the pixel size an imported web/search image is resized to, so
// measuring a stored imported buffer later reproduces the same numbers.
//
// `minWidth`/`minHeight` add a per-provider floor the box cannot go under (Fal
// rejects an undersized request with 422 `image_too_small`; local Draw Things
// has no floor). The floor wins over the box: the SOURCE aspect is scaled up to
// the smallest legal size. The raw source shape is used rather than the
// snap-rounded box result, which would compound the aspect error.
//
// `maxPixels` is an area ceiling, because the floor is per-axis while fal bills
// per megapixel: raising a 1:2 portrait until both axes clear 640x512 lands on
// 640x1152, 2.25x the baseline's area and price.
//
// The floor is never traded for the ceiling (an undersized request is refused
// outright); the ceiling constrains the aspect the raise may reach. The legal
// band at the default 589824 (=768x768) against a 640x512 floor:
//   widest   1152x512  (2.25)   1152 = the largest step-aligned width at h=512
//   tallest   640x896  (0.714)   896 = the largest step-aligned height at w=640
// so 16:9 (-> 896x512) and 3:4 (-> 640x832) pass through untouched, while 9:16
// and 1:2 are both clamped to 640x896.
//
// The ceiling is a hard cap on both branches: with a 1152x1152 box a 9:16 source
// fits to 640x1152, which clears both floors and never reaches the clamp, yet
// exceeds the ceiling. A box larger than the ceiling is therefore capped back
// down; raise GENAI_MAX_REQUEST_PIXELS together with GENAI_WIDTH/GENAI_HEIGHT.
//
// `aspectClamped` says whether that clamp bit: sending a clamped image_size is
// fine, but resizing the stored source into a clamped shape must crop, not
// stretch.
export function planImageSizeFit(sourceWidth, sourceHeight, boxWidth, boxHeight, options = {}) {
  const step = options.step || DIMENSION_STEP;
  // A floor must itself be step-aligned or it can never be met exactly; round an
  // env override up.
  const minWidth = options.minWidth > 0 ? snapDimensionUpToMultiple(options.minWidth, step) : 0;
  const minHeight = options.minHeight > 0 ? snapDimensionUpToMultiple(options.minHeight, step) : 0;
  const safeBoxWidth = Math.max(snapDimensionDownToMultiple(boxWidth, step), minWidth);
  const safeBoxHeight = Math.max(snapDimensionDownToMultiple(boxHeight, step), minHeight);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    // No usable source dimensions: use the configured box (raised to the floor,
    // capped by the ceiling).
    const capped = shrinkToPixelBudget({ width: safeBoxWidth, height: safeBoxHeight }, options.maxPixels, step);
    return {
      width: Math.max(capped.width, minWidth),
      height: Math.max(capped.height, minHeight),
      aspectClamped: false
    };
  }
  const scale = Math.min(safeBoxWidth / sourceWidth, safeBoxHeight / sourceHeight, 1);
  const fitted = {
    width: snapDimensionToNearestMultiple(sourceWidth * scale, step, safeBoxWidth),
    height: snapDimensionToNearestMultiple(sourceHeight * scale, step, safeBoxHeight)
  };
  if (fitted.width >= minWidth && fitted.height >= minHeight) {
    const capped = shrinkToPixelBudget(fitted, options.maxPixels, step);
    // Under a floor after the shrink: fall through to the raise below, which meets
    // the ceiling by clamping the aspect.
    if (capped.width >= minWidth && capped.height >= minHeight) {
      return { ...capped, aspectClamped: false };
    }
  }
  // Smallest uniform upscale that clears both floors, of the source aspect held
  // inside the ceiling's band. Scaling the aspect rather than the source's pixel
  // dimensions is the same arithmetic when nothing is clamped, and the only way
  // to express the clamp without a fake source size.
  const aspect = sourceWidth / sourceHeight;
  const legalAspect = clampAspectToPixelBudget(aspect, minWidth, minHeight, options.maxPixels, step);
  const upscale = Math.max(minWidth / legalAspect, minHeight);
  return {
    width: Math.max(snapDimensionToNearestMultiple(legalAspect * upscale, step, Number.MAX_SAFE_INTEGER), minWidth),
    height: Math.max(snapDimensionToNearestMultiple(upscale, step, Number.MAX_SAFE_INTEGER), minHeight),
    aspectClamped: legalAspect !== aspect
  };
}

// Scale a shape down along its own aspect until its area fits the budget.
// Nearest-snapping can round the area back over, so the result is re-snapped
// downward when it does.
function shrinkToPixelBudget(size, maxPixels, step) {
  if (!(maxPixels > 0) || size.width * size.height <= maxPixels) {
    return size;
  }
  const scale = Math.sqrt(maxPixels / (size.width * size.height));
  const nearest = {
    width: snapDimensionToNearestMultiple(size.width * scale, step, size.width),
    height: snapDimensionToNearestMultiple(size.height * scale, step, size.height)
  };
  if (nearest.width * nearest.height <= maxPixels) {
    return nearest;
  }
  return {
    width: Math.max(snapDimensionDownToMultiple(size.width * scale, step), step),
    height: Math.max(snapDimensionDownToMultiple(size.height * scale, step), step)
  };
}

// The widest and tallest step-aligned shapes that satisfy both floors without
// breaching the area ceiling. If the ceiling is smaller than the floor's own
// area, the floor wins.
function clampAspectToPixelBudget(aspect, minWidth, minHeight, maxPixels, step) {
  if (!(maxPixels > 0) || !(minWidth > 0) || !(minHeight > 0)) {
    return aspect;
  }
  const widest = snapDimensionDownToMultiple(maxPixels / minHeight, step);
  const tallest = snapDimensionDownToMultiple(maxPixels / minWidth, step);
  if (widest < minWidth || tallest < minHeight) {
    return aspect;
  }
  return Math.min(Math.max(aspect, minWidth / tallest), widest / minHeight);
}

// The {width, height} half of planImageSizeFit. Separate because this object is
// sent verbatim as fal's `image_size`, so it must not carry unknown fields.
export function fitImageSizeToBox(sourceWidth, sourceHeight, boxWidth, boxHeight, options = {}) {
  const { width, height } = planImageSizeFit(sourceWidth, sourceHeight, boxWidth, boxHeight, options);
  return { width, height };
}

// Downscale an imported web/search image into the configured box and transcode
// it to PNG. Done at import because:
//   - web photos are far bigger than any request budget (Fal inlines the source
//     as a base64 data URL, Draw Things takes base64 init_images);
//   - Draw Things returns HTTP 422 unless the init image's pixel size agrees
//     with the request's width/height, so stored dimensions must be the
//     buffer's real ones;
//   - one stored format (PNG) keeps GIF and EXIF-rotated JPEG out of providers.
// The target is planImageSizeFit, and the resize is normally a straight fill to
// it: the dimension snap shifts the aspect by a few percent, and matching the
// size asked of the model beats a differently-shaped image. The area ceiling's
// aspect clamp is a fifth or more, which squashes visibly, so `fit: "cover"`
// applies there only.
//
// No floor is passed, deliberately: the stored pixel size is what the local Draw
// Things path declares beside its init_images, and importing at fal's floor
// would move the local box up to 640x512. The hosted path rescales in memory per
// request (raiseFalEditSourceToRequestSize). The ceiling is passed so the one
// policy stays one policy if a floor is added.
//
// Output is flattened to opaque 8-bit RGB: an init image with an alpha channel
// is something a native pipeline may not expect. White matches the page
// background most sources were composited against.
export async function normalizeImportedRasterImage(buffer, inspected, { boxWidth, boxHeight, minWidth = 0, minHeight = 0, maxPixels = 0 }) {
  const sharp = await loadSharp();
  const pipeline = sharp(buffer, { limitInputPixels: MAX_IMPORT_PIXELS, failOn: "error", animated: false });
  let sourceWidth = inspected?.width || 0;
  let sourceHeight = inspected?.height || 0;
  try {
    // autoOrient reports the dimensions after the EXIF rotation .rotate() applies,
    // so a portrait phone photo is not fitted using its landscape stored size.
    const metadata = await pipeline.metadata();
    sourceWidth = metadata.autoOrient?.width || metadata.width || sourceWidth;
    sourceHeight = metadata.autoOrient?.height || metadata.height || sourceHeight;
  } catch {
    // Unreadable metadata: the resize below will fail with a clearer message.
  }
  const target = planImageSizeFit(sourceWidth, sourceHeight, boxWidth, boxHeight, { minWidth, minHeight, maxPixels });
  let output;
  try {
    output = await pipeline
      .rotate()
      .resize({
        width: target.width,
        height: target.height,
        fit: target.aspectClamped ? "cover" : "fill",
        position: "centre"
      })
      .flatten({ background: "#ffffff" })
      .toColorspace("srgb")
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
  } catch (err) {
    throw new ImageFormatError(`Selected image could not be decoded (${err.message})`);
  }
  return { buffer: output, contentType: "image/png", width: target.width, height: target.height };
}

// Rescale an already-owned store buffer to an exact pixel size, in memory, for
// one provider request. For providers that refuse an undersized input image
// (Fal's 422 `image_too_small`) while the stored bytes must stay as they are:
// the store is shared with Draw Things, which refuses an init image whose pixel
// size disagrees with the declared width/height. `fit: "fill"` as in the import
// resize: the target is step-aligned and may differ from the source aspect by a
// few percent.
export async function resizeRasterImageToSize(buffer, { width, height }) {
  const sharp = await loadSharp();
  try {
    const output = await sharp(buffer, { limitInputPixels: MAX_IMPORT_PIXELS, failOn: "error", animated: false })
      .resize({ width, height, fit: "fill" })
      .flatten({ background: "#ffffff" })
      .toColorspace("srgb")
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
    return { buffer: output, contentType: "image/png", width, height };
  } catch (err) {
    throw new ImageFormatError(`Source image could not be resized (${err.message})`);
  }
}
