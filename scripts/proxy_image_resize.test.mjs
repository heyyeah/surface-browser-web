// Unit tests for the /api/proxy/image downscale (server/images.js).
//
// Capping the long edge at 1024 px bounds the decoded texture size; the byte cap
// says nothing about pixels, and the texture decode/upload lands in one frame.
//
// In-process because the route's SSRF guard rejects every loopback fixture host,
// so the happy path is not reachable over HTTP. Fixtures are baked with real
// sharp output rather than hand-rolled headers.
//
// The contract, in priority order:
//   1. It NEVER throws and never turns a working image into an error. A broken
//      image is worse than a large one.
//   2. Downscale only, never upscale.
//   3. Aspect ratio is preserved (sphere.js lays panels out from
//      texture.image.naturalWidth/naturalHeight).
//   4. Format, and therefore alpha, is preserved. GIF is the one transcode.
//   5. EXIF orientation is baked in, because re-encoding drops the tag.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import sharp from "sharp";
import {
  detectRasterImage,
  downscaleProxiedImage,
  looksLikeSvg,
  planProxyImageDownscale,
  PROXY_IMAGE_MAX_EDGE_PX,
  rasterizeSvg,
  sanitizeSvg
} from "../server/images.js";

const CAP = PROXY_IMAGE_MAX_EDGE_PX;

function solid(width, height, channels = 3) {
  return sharp({
    create: {
      width,
      height,
      channels,
      background: channels === 4
        ? { r: 40, g: 130, b: 210, alpha: 0.5 }
        : { r: 40, g: 130, b: 210 }
    }
  });
}

test("the cap is 1024 px", () => {
  assert.equal(PROXY_IMAGE_MAX_EDGE_PX, 1024);
});

// --- rule 2: downscale only -------------------------------------------------

test("an image already inside the cap is passed through byte-for-byte", async () => {
  const png = await solid(800, 600).png().toBuffer();
  const result = await downscaleProxiedImage(png, "image/png");
  assert.equal(result.resized, false);
  assert.equal(result.reason, "within-cap");
  assert.equal(result.contentType, "image/png");
  // Identity, not a re-encode: an image under the cap must never pay for a
  // decode, and must never be re-compressed.
  assert.ok(result.buffer === png);
});

test("an image exactly at the cap is left alone", async () => {
  const png = await solid(CAP, 400).png().toBuffer();
  const result = await downscaleProxiedImage(png, "image/png");
  assert.equal(result.resized, false, "1024 is within the cap, not over it");
  assert.ok(result.buffer === png);
});

test("one pixel over the cap does resize", async () => {
  const png = await solid(CAP + 1, 400).png().toBuffer();
  const result = await downscaleProxiedImage(png, "image/png");
  assert.equal(result.resized, true);
  assert.equal(detectRasterImage(result.buffer).width, CAP);
});

test("a tiny image is never upscaled", async () => {
  const png = await solid(64, 48).png().toBuffer();
  const result = await downscaleProxiedImage(png, "image/png");
  assert.equal(result.resized, false);
  assert.deepEqual(detectRasterImage(result.buffer), {
    contentType: "image/png",
    width: 64,
    height: 48
  });
});

// --- rule 3: aspect ratio ---------------------------------------------------

test("a landscape source is capped on its width and keeps its aspect", async () => {
  const jpeg = await solid(3000, 2000).jpeg().toBuffer();
  const result = await downscaleProxiedImage(jpeg, "image/jpeg");
  assert.equal(result.resized, true);
  const out = detectRasterImage(result.buffer);
  assert.equal(out.width, CAP);
  // 3000x2000 is 3:2; 1024 * 2/3 = 682.67 -> 683.
  assert.equal(out.height, 683);
  assert.ok(Math.abs((out.width / out.height) - (3000 / 2000)) < 0.01);
});

test("a portrait source is capped on its HEIGHT, not its width", async () => {
  const jpeg = await solid(2000, 3000).jpeg().toBuffer();
  const out = detectRasterImage((await downscaleProxiedImage(jpeg, "image/jpeg")).buffer);
  assert.equal(out.height, CAP, "the cap is on the LONG edge");
  assert.equal(out.width, 683);
});

test("an extreme panorama still caps its long edge", async () => {
  const jpeg = await solid(4000, 200).jpeg().toBuffer();
  const out = detectRasterImage((await downscaleProxiedImage(jpeg, "image/jpeg")).buffer);
  assert.equal(out.width, CAP);
  assert.equal(out.height, 51);
});

// --- rule 4: format and alpha ----------------------------------------------

test("a transparent PNG stays a PNG and keeps its alpha channel", async () => {
  // The visible regression this guards: flattening onto white (which the GenAI
  // import path deliberately DOES do) would put a white box behind every
  // transparent logo in the tunnel.
  const png = await solid(2000, 2000, 4).png().toBuffer();
  const result = await downscaleProxiedImage(png, "image/png");
  assert.equal(result.resized, true);
  assert.equal(result.contentType, "image/png");
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.hasAlpha, true);
});

test("a JPEG stays a JPEG and a WebP stays a WebP", async () => {
  const jpeg = await downscaleProxiedImage(await solid(1600, 1200).jpeg().toBuffer(), "image/jpeg");
  assert.equal(jpeg.contentType, "image/jpeg");
  assert.equal(detectRasterImage(jpeg.buffer).contentType, "image/jpeg");

  const webp = await downscaleProxiedImage(await solid(1600, 1200).webp().toBuffer(), "image/webp");
  assert.equal(webp.contentType, "image/webp");
  assert.equal((await sharp(webp.buffer).metadata()).format, "webp");
});

test("an oversized GIF transcodes to PNG and reports the new content type", async () => {
  // GIF is the one format that changes: a WebGL texture samples a single frame
  // anyway, and PNG keeps the alpha that JPEG would lose.
  const gif = await solid(2000, 1500).gif().toBuffer();
  const result = await downscaleProxiedImage(gif, "image/gif");
  assert.equal(result.resized, true);
  assert.equal(result.contentType, "image/png");
  assert.equal(detectRasterImage(result.buffer).contentType, "image/png");
  assert.equal(detectRasterImage(result.buffer).width, CAP);
});

// --- rule 5: EXIF -----------------------------------------------------------

test("an EXIF-rotated JPEG is measured and emitted in its DISPLAY orientation", async () => {
  // Orientation 6 = rotate 90 CW on display. Stored 3000x2000 (landscape),
  // displayed 2000x3000 (portrait). Re-encoding drops the EXIF tag, so without
  // .rotate() the proxy would hand the browser a sideways image.
  const jpeg = await solid(3000, 2000).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await downscaleProxiedImage(jpeg, "image/jpeg");
  assert.equal(result.resized, true);
  const out = detectRasterImage(result.buffer);
  assert.equal(out.height, CAP, "the displayed long edge is the height");
  assert.equal(out.width, 683);
});

// --- rule 1: never break a request -----------------------------------------

test("an SVG reaches this function unchanged — the ROUTE is what refuses it", async () => {
  // downscaleProxiedImage passes SVG through because its contract is "never turn a
  // working image into an error" (rule 1). The route never calls it for SVG: it
  // draws SVG to a PNG with rasterizeSvg, because serving image/svg+xml from our
  // own origin is script execution. See the tests below and at the foot of this file.
  //
  // detectRasterImage refuses SVG on purpose (XXE / remote-reference surface); the
  // downscaler must still pass it through untouched.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"><rect width="4000" height="4000"/></svg>'
  );
  const result = await downscaleProxiedImage(svg, "image/svg+xml");
  assert.equal(result.resized, false);
  assert.equal(result.reason, "unrecognized-format");
  assert.equal(result.contentType, "image/svg+xml");
  assert.ok(result.buffer === svg);
});

// --- SVG: drawn to PNG, never served as SVG ----------------------------------

const NUMBER_SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#6A2C70"/><text x="160" y="176" font-size="140" fill="#FFFFFF">1</text></svg>';

test("SVG is recognised with or without a prolog, and nothing else is", async () => {
  assert.equal(looksLikeSvg(Buffer.from(NUMBER_SVG)), true);
  assert.equal(looksLikeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), true);
  assert.equal(looksLikeSvg(Buffer.from("\uFEFF<!-- c --><svg>")), true);
  assert.equal(looksLikeSvg(Buffer.from("<html><svg></svg></html>")), false);
  assert.equal(looksLikeSvg(await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer()), false);
});

test("an SVG becomes a PNG at the texture cap, keeping its aspect", async () => {
  const png = await rasterizeSvg(Buffer.from(NUMBER_SVG));
  assert.deepEqual(detectRasterImage(png), { contentType: "image/png", width: CAP, height: 768 });
  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [0x6a, 0x2c, 0x70], "the shapes are actually drawn");
});

test("sanitising removes script, foreignObject and every outside reference, and keeps local ones", () => {
  const out = sanitizeSvg('<svg><script>alert(1)</script><foreignObject><iframe src="x"/></foreignObject>'
    + '<image xlink:href="http://169.254.169.254/a.png"/><image href=\'file:///etc/passwd\'/>'
    + '<use href="#a"/><style>@import "http://x/a.css"; rect { fill: url(http://x/p.svg#g) } circle { fill: url(#g) }</style></svg>');
  assert.doesNotMatch(out, /script|foreignObject|169\.254|passwd|http:/i);
  assert.match(out, /href="#a"/);
  assert.match(out, /url\(#g\)/);
});

test("an icon-sized SVG is refused; the page's own artwork is not", async () => {
  const icon = (w, h, extra = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${extra} width="${w}" height="${h}"><rect width="${w}" height="${h}"/></svg>`);
  await assert.rejects(rasterizeSvg(icon(24, 24)), /icon-sized/);
  await assert.rejects(rasterizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>')), /icon-sized/);
  assert.ok(detectRasterImage(await rasterizeSvg(icon(64, 48))));
});

test("a DOCTYPE, entities or an oversized SVG are refused", async () => {
  await assert.rejects(rasterizeSvg(Buffer.from('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>')), /DOCTYPE/);
  await assert.rejects(rasterizeSvg(Buffer.from(`<svg>${" ".repeat(1_000_001)}</svg>`)), /too large/);
});

test("a small SVG that would render for half a minute is stopped at the deadline", async () => {
  // sharp's timeout is only checked between tiles; this one tile ran ~30 s
  // in-process before the render moved to a child that is killed.
  const uses = '<use href="#r"/>'.repeat(128);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feTurbulence baseFrequency="0.05" numOctaves="10"/><feGaussianBlur stdDeviation="40"/></filter><rect id="r" width="1024" height="1024" filter="url(#f)"/></defs>${uses}</svg>`;
  const startedAt = Date.now();
  await assert.rejects(rasterizeSvg(Buffer.from(svg), 1024), /too long/);
  assert.ok(Date.now() - startedAt < 9_000, `took ${Date.now() - startedAt} ms`);
});

test("garbage, truncated and empty bodies are passed through, not thrown on", async () => {
  for (const body of [
    Buffer.alloc(0),
    Buffer.from("not an image at all"),
    (await solid(2000, 2000).png().toBuffer()).subarray(0, 40)
  ]) {
    const result = await downscaleProxiedImage(body, "application/octet-stream");
    assert.equal(result.resized, false);
    assert.ok(result.buffer === body);
  }
});

test("a header declaring an absurd canvas is passed through rather than refused", async () => {
  // detectRasterImage THROWS (not returns null) above 16384 px or 64 MP. The
  // importer wants that refusal; the proxy does not — it just declines to
  // resize. Hand-built IHDR: 40000 x 40000.
  const png = await solid(16, 16).png().toBuffer();
  const forged = Buffer.from(png);
  forged.writeUInt32BE(40_000, 16);
  forged.writeUInt32BE(40_000, 20);
  const plan = planProxyImageDownscale(forged);
  assert.equal(plan.resize, false);
  assert.equal(plan.reason, "unsupported-dimensions");
  const result = await downscaleProxiedImage(forged, "image/png");
  assert.equal(result.resized, false);
  assert.ok(result.buffer === forged);
});

test("a corrupt body that only the DECODER can reject still passes through", async () => {
  // Valid PNG header claiming 2000x2000 (so the plan says resize) with the
  // pixel data shredded, so sharp throws. Rule 1 says serve it anyway.
  const png = await solid(2000, 2000).png().toBuffer();
  const corrupt = Buffer.from(png);
  corrupt.fill(0x00, 200, corrupt.length - 12);
  assert.equal(planProxyImageDownscale(corrupt).resize, true, "the header still looks resizable");
  const result = await downscaleProxiedImage(corrupt, "image/png");
  assert.equal(result.resized, false);
  assert.match(result.reason, /^failed:/);
  assert.ok(result.buffer === corrupt, "the original bytes are what gets served");
});

// --- the plan, on its own ---------------------------------------------------

test("planProxyImageDownscale names every branch it can take", async () => {
  const small = await solid(100, 100).png().toBuffer();
  const big = await solid(2000, 100).png().toBuffer();
  assert.equal(planProxyImageDownscale(small).reason, "within-cap");
  assert.equal(planProxyImageDownscale(big).reason, "oversize");
  assert.equal(planProxyImageDownscale(Buffer.from("nope")).reason, "unrecognized-format");
});

test("the cap is a parameter, so a caller can tighten it without a code change", async () => {
  const png = await solid(900, 600).png().toBuffer();
  assert.equal(planProxyImageDownscale(png, 1024).resize, false);
  assert.equal(planProxyImageDownscale(png, 512).resize, true);
  const result = await downscaleProxiedImage(png, "image/png", 512);
  assert.equal(detectRasterImage(result.buffer).width, 512);
});


// The gate lives in server/index.js and a contract test cannot reach the happy
// path over HTTP (see top of file), so it is asserted against the source.

const routeSource = (() => {
  const file = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const start = file.indexOf('app.get("/api/proxy/image"');
  return file.slice(start, file.indexOf("app.get(\"/api/genai/image", start));
})();

test("the proxy route refuses anything that is not a sniffed raster", () => {
  assert.match(routeSource, /detectRasterImage\(buffer\)/,
    "the route must sniff the bytes itself");
  assert.match(routeSource, /if \(!detected\)/);
  assert.match(routeSource, /status\(415\)/,
    "an unrecognised format must be refused, not forwarded");
});

test("the content type comes from the SNIFF, never from upstream", () => {
  // The whole vulnerability in one line: forwarding the upstream content-type
  // let a remote host choose what our origin claimed to be serving.
  assert.match(routeSource, /downscaleProxiedImage\(buffer, detected\.contentType/);
  assert.doesNotMatch(routeSource, /upstream\.headers\.get\("content-type"\)\s*\|\|\s*"application\/octet-stream"/,
    "the upstream content-type must not become the response content-type");
});

test("the proxy route serves an SVG only as the PNG drawn from it", () => {
  assert.match(routeSource, /if \(looksLikeSvg\(buffer\)\) \{[\s\S]*?rasterizeSvg\(buffer[\s\S]*?sendProxiedImage\(res, png, "image\/png"\)/);
});

test("proxied bytes carry a CSP that can load and run nothing", () => {
  assert.match(routeSource, /content-security-policy["']\s*,\s*["']default-src 'none'; sandbox/);
});
