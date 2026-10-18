// Unit tests for the /api/genai/source/import image pipeline (server/images.js).
//
// These run in-process rather than against the live server on purpose: the
// import endpoint's SSRF guard rejects every loopback fixture host by design
// (same reasoning as the header note in contract_extract.test.mjs), so the
// happy path is not reachable over HTTP from a contract test. The header
// readers, the fitting policy and the resize are locked here instead.
//
// Fixtures are baked with sharp so the JPEG/GIF/EXIF cases use real encoder
// output, not hand-rolled headers that could encode the same mistake as the parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  detectRasterImage,
  fitImageSizeToBox,
  inspectImportedRasterImage,
  normalizeImportedRasterImage,
  planImageSizeFit
} from "../server/images.js";

// A landscape JPEG whose stored size differs from its transposed reading.
const SOURCE_WIDTH = 346;
const SOURCE_HEIGHT = 268;
// A small local box (GENAI_WIDTH x GENAI_HEIGHT).
const BOX = { boxWidth: 320, boxHeight: 256 };

function solidImage(width, height, channels = 3) {
  return sharp({
    create: { width, height, channels, background: { r: 40, g: 130, b: 210 } }
  });
}

function noiseBuffer(width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  let x = 0x9e3779b9;
  for (let i = 0; i < rgb.length; i += 1) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    rgb[i] = x & 0xff;
  }
  return rgb;
}

test("JPEG dimensions are read height-first, not transposed", async () => {
  const jpeg = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT).jpeg().toBuffer();
  const detected = detectRasterImage(jpeg);
  assert.equal(detected.contentType, "image/jpeg");
  // The SOF payload is [precision][height][width]; reading it width-first would
  // report 268x346 and a provider would answer "HTTP 422: init_images height
  // doesn't match 268 from the parameter 346".
  assert.equal(detected.width, SOURCE_WIDTH);
  assert.equal(detected.height, SOURCE_HEIGHT);
});

test("progressive JPEG dimensions are read height-first too", async () => {
  const jpeg = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT).jpeg({ progressive: true }).toBuffer();
  assert.deepEqual(detectRasterImage(jpeg), {
    contentType: "image/jpeg",
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT
  });
});

test("PNG, WebP and GIF headers report width before height", async () => {
  const png = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT).png().toBuffer();
  assert.deepEqual(detectRasterImage(png), {
    contentType: "image/png",
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT
  });

  const webpLossy = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT).webp().toBuffer();
  assert.deepEqual(detectRasterImage(webpLossy), {
    contentType: "image/webp",
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT
  });

  const webpLossless = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT).webp({ lossless: true }).toBuffer();
  assert.deepEqual(detectRasterImage(webpLossless), {
    contentType: "image/webp",
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT
  });

  const gif = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT).gif().toBuffer();
  assert.deepEqual(detectRasterImage(gif), {
    contentType: "image/gif",
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT
  });
});

test("import accepts GIF and rejects non-raster payloads with a clear message", async () => {
  const gif = await solidImage(200, 100).gif().toBuffer();
  assert.equal(inspectImportedRasterImage(gif, "image/gif").contentType, "image/gif");

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>');
  assert.throws(
    () => inspectImportedRasterImage(svg, "image/svg+xml"),
    /must be a PNG, JPEG, GIF, or WebP image/
  );

  const jpeg = await solidImage(200, 100).jpeg().toBuffer();
  assert.equal(inspectImportedRasterImage(jpeg, "image/jpg").contentType, "image/jpeg", "image/jpg alias accepted");
  assert.throws(
    () => inspectImportedRasterImage(jpeg, "image/png"),
    /content type does not match/
  );
});

test("fitImageSizeToBox fits the source aspect inside the box and never upscales", () => {
  // 346x268 in a 320x256 box: scale 320/346 -> 320x247.9, nearest 64 -> 320x256.
  assert.deepEqual(fitImageSizeToBox(SOURCE_WIDTH, SOURCE_HEIGHT, 320, 256), { width: 320, height: 256 });
  // The transposed reading would land somewhere else entirely — orientation has
  // to survive all the way into the size we ask a provider for.
  assert.deepEqual(fitImageSizeToBox(SOURCE_HEIGHT, SOURCE_WIDTH, 320, 256), { width: 192, height: 256 });
  // Smaller than the box: fitted to the step floor, never blown up.
  const small = fitImageSizeToBox(64, 48, 320, 256);
  assert.deepEqual(small, { width: 64, height: 64 });
});

// Providers reject sizes that are multiples of 16 but not 64 (e.g. 320x240).
// Nothing this function returns may be off-step, whatever the source or box.
test("fitImageSizeToBox only ever returns 64-aligned dimensions", () => {
  const boxes = [[320, 256], [512, 512], [256, 256], [640, 384]];
  const sources = [[346, 268], [268, 346], [3000, 2000], [1, 4000], [4000, 1], [0, 0]];
  for (const [boxWidth, boxHeight] of boxes) {
    for (const [sourceWidth, sourceHeight] of sources) {
      const fitted = fitImageSizeToBox(sourceWidth, sourceHeight, boxWidth, boxHeight);
      assert.equal(fitted.width % 64, 0, `width ${fitted.width} off-step for ${sourceWidth}x${sourceHeight} in ${boxWidth}x${boxHeight}`);
      assert.equal(fitted.height % 64, 0, `height ${fitted.height} off-step for ${sourceWidth}x${sourceHeight} in ${boxWidth}x${boxHeight}`);
      assert.ok(fitted.width <= boxWidth && fitted.height <= boxHeight, "never exceeds the configured box");
    }
  }
});

// The hosted-provider floor (Fal answers 422 image_too_small below its
// per-endpoint minimum). It overrides the box, which is a deliberately small
// local size, and must not break either invariant above.
test("fitImageSizeToBox raises a below-minimum result without distorting or breaking the step", () => {
  const min = { minWidth: 640, minHeight: 512 };
  // The box, exactly 2x under the floor.
  assert.deepEqual(fitImageSizeToBox(320, 256, 320, 256, min), { width: 640, height: 512 });
  // Already legal: unchanged, so a hosted source does not grow on every vary.
  assert.deepEqual(fitImageSizeToBox(640, 512, 320, 256, min), { width: 640, height: 512 });
  // A square box is scaled up as a square, not reshaped to the floor's aspect.
  assert.deepEqual(fitImageSizeToBox(512, 512, 512, 512, min), { width: 640, height: 640 });
  // Above the floor already: the box still wins.
  assert.deepEqual(fitImageSizeToBox(1024, 768, 768, 768, min), { width: 768, height: 576 });

  const boxes = [[320, 256], [512, 512], [64, 64], [1024, 768]];
  const sources = [[346, 268], [268, 346], [3000, 2000], [1, 4000], [4000, 1], [0, 0]];
  for (const [boxWidth, boxHeight] of boxes) {
    for (const [sourceWidth, sourceHeight] of sources) {
      const fitted = fitImageSizeToBox(sourceWidth, sourceHeight, boxWidth, boxHeight, min);
      const label = `${sourceWidth}x${sourceHeight} in ${boxWidth}x${boxHeight}`;
      assert.equal(fitted.width % 64, 0, `width ${fitted.width} off-step for ${label}`);
      assert.equal(fitted.height % 64, 0, `height ${fitted.height} off-step for ${label}`);
      assert.ok(fitted.width >= 640 && fitted.height >= 512, `below the floor for ${label}`);
      if (sourceWidth > 0 && sourceHeight > 0) {
        const sourceAspect = sourceWidth / sourceHeight;
        const fittedAspect = fitted.width / fitted.height;
        // Extreme aspects cannot survive a 64 grid at these sizes; the guard is
        // that the shape is preserved to within one step on the smaller axis.
        const tolerance = 64 / Math.min(fitted.width, fitted.height);
        assert.ok(
          Math.abs(fittedAspect - sourceAspect) <= sourceAspect * tolerance,
          `aspect ${fittedAspect} strays from ${sourceAspect} for ${label}`
        );
      }
    }
  }
});

// The area ceiling. Fal bills per megapixel and the floor is per axis, so a
// portrait source raised until both axes clear 640x512 costs 2.25x a 640x512
// request. These lock the band the ceiling leaves.
const FAL_POLICY = { minWidth: 640, minHeight: 512, maxPixels: 768 * 768 };

test("the area ceiling leaves ordinary aspects alone and clamps only the extremes", () => {
  // 16:9 and 3:4 already sit under 589824 once raised — untouched.
  assert.deepEqual(fitImageSizeToBox(1920, 1080, 640, 512, FAL_POLICY), { width: 896, height: 512 });
  assert.deepEqual(fitImageSizeToBox(768, 1024, 640, 512, FAL_POLICY), { width: 640, height: 832 });
  // 9:16 and 1:2 would raise to 640x1152 (737280 px, 2.25x the 640x512
  // baseline). Both clamp to the tallest legal shape instead.
  assert.deepEqual(fitImageSizeToBox(1080, 1920, 640, 512, FAL_POLICY), { width: 640, height: 896 });
  assert.deepEqual(fitImageSizeToBox(640, 1280, 640, 512, FAL_POLICY), { width: 640, height: 896 });
  // And the same on the wide side: 21:9 clamps to the widest legal shape.
  assert.deepEqual(fitImageSizeToBox(2560, 1080, 640, 512, FAL_POLICY), { width: 1152, height: 512 });
});

test("the ceiling caps a box larger than itself, in the branch the floor never reaches", () => {
  // The clamp must also apply when a floor did not RAISE the request: a large
  // configured box would otherwise sail past it. At GENAI_WIDTH/HEIGHT 1152 a 9:16
  // source fits to 640x1152, both axes clear the floor, and it is 0.70 MP against a
  // 0.5625 MP ceiling. A box is therefore not a free price dial;
  // GENAI_MAX_REQUEST_PIXELS has to move with it.
  assert.deepEqual(fitImageSizeToBox(2000, 2000, 1152, 1152, FAL_POLICY), { width: 768, height: 768 });
  assert.deepEqual(fitImageSizeToBox(1920, 1080, 1152, 1152, FAL_POLICY), { width: 1024, height: 576 });
  assert.deepEqual(fitImageSizeToBox(1600, 1200, 960, 768, FAL_POLICY), { width: 896, height: 640 });
  // Shrinking 640x1152 along its aspect reaches 576x1024, which is under the
  // 640 floor — so the floor wins and the ASPECT is clamped instead, exactly as
  // it is for a raise.
  assert.deepEqual(fitImageSizeToBox(1080, 1920, 1152, 1152, FAL_POLICY), { width: 640, height: 896 });
  // And with no measurable source at all, the box itself is capped.
  assert.deepEqual(fitImageSizeToBox(0, 0, 1152, 1152, FAL_POLICY), { width: 768, height: 768 });
});

test("the ceiling never breaks the floor, the step, or its own budget", () => {
  const sources = [[346, 268], [268, 346], [1080, 1920], [1920, 1080], [1, 4000], [4000, 1], [640, 512], [512, 512], [0, 0]];
  for (const [boxWidth, boxHeight] of [[320, 256], [640, 512], [512, 512], [960, 768], [1152, 1152]]) {
    for (const [sourceWidth, sourceHeight] of sources) {
      const fitted = fitImageSizeToBox(sourceWidth, sourceHeight, boxWidth, boxHeight, FAL_POLICY);
      const label = `${sourceWidth}x${sourceHeight} in ${boxWidth}x${boxHeight}`;
      assert.equal(fitted.width % 64, 0, `width ${fitted.width} off-step for ${label}`);
      assert.equal(fitted.height % 64, 0, `height ${fitted.height} off-step for ${label}`);
      // The floor is not negotiable: an undersized request is refused outright.
      assert.ok(fitted.width >= 640 && fitted.height >= 512, `below the floor for ${label}`);
      assert.ok(fitted.width * fitted.height <= FAL_POLICY.maxPixels, `over the ceiling for ${label}`);
    }
  }
});

test("a ceiling under the floor's own area cannot win", () => {
  // 640x512 is already 327680 px. Asked for less, the floor still holds —
  // a request the provider would refuse is worse than an expensive one.
  const fitted = fitImageSizeToBox(1080, 1920, 640, 512, { minWidth: 640, minHeight: 512, maxPixels: 100_000 });
  assert.ok(fitted.width >= 640 && fitted.height >= 512);
});

test("the ceiling is inert without a floor, so Draw Things keeps its small box", () => {
  // A local provider has no floor, so nothing is ever raised and the ceiling
  // has nothing to constrain. A 320x256 box must survive the option.
  const box = { boxWidth: 320, boxHeight: 256 };
  for (const [sourceWidth, sourceHeight] of [[346, 268], [1080, 1920], [3000, 2000]]) {
    assert.deepEqual(
      fitImageSizeToBox(sourceWidth, sourceHeight, box.boxWidth, box.boxHeight, { maxPixels: 768 * 768 }),
      fitImageSizeToBox(sourceWidth, sourceHeight, box.boxWidth, box.boxHeight)
    );
  }
});

test("aspectClamped reports only the clamp, not ordinary snap rounding", () => {
  assert.equal(planImageSizeFit(1920, 1080, 640, 512, FAL_POLICY).aspectClamped, false);
  assert.equal(planImageSizeFit(346, 268, 320, 256).aspectClamped, false, "snap rounding is not a clamp");
  assert.equal(planImageSizeFit(1080, 1920, 640, 512, FAL_POLICY).aspectClamped, true);
});

test("a clamped import is centre-cropped, not squashed", async () => {
  // A 9:16 phone screenshot clamps 0.5625 to 0.714 — a 22% horizontal squash if
  // it were filled, which is visible. `cover` throws away the top and bottom
  // instead. Red band on top, green below: filling would drag the red band into
  // the output's first rows, cropping cannot.
  const raw = Buffer.alloc(1080 * 1920 * 3);
  for (let y = 0; y < 1920; y += 1) {
    for (let x = 0; x < 1080; x += 1) {
      const i = ((y * 1080) + x) * 3;
      if (y < 200) { raw[i] = 220; } else { raw[i + 1] = 220; }
    }
  }
  const png = await sharp(raw, { raw: { width: 1080, height: 1920, channels: 3 } }).png().toBuffer();
  const inspected = inspectImportedRasterImage(png, "image/png");
  const normalized = await normalizeImportedRasterImage(png, inspected, {
    boxWidth: 640, boxHeight: 512, ...FAL_POLICY
  });

  assert.deepEqual({ width: normalized.width, height: normalized.height }, { width: 640, height: 896 });
  const pixels = await sharp(normalized.buffer).raw().toBuffer();
  const topPixel = ((2 * 640) + 320) * 3;
  assert.ok(pixels[topPixel + 1] > pixels[topPixel], "the red band survived, so the resize stretched instead of cropping");
});

test("import resizes a JPEG into the box, transcodes to PNG, and reports the real pixels", async () => {
  const jpeg = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT).jpeg().toBuffer();
  const inspected = inspectImportedRasterImage(jpeg, "image/jpeg");
  const normalized = await normalizeImportedRasterImage(jpeg, inspected, BOX);

  assert.equal(normalized.contentType, "image/png");
  assert.deepEqual(
    { width: normalized.width, height: normalized.height },
    fitImageSizeToBox(SOURCE_WIDTH, SOURCE_HEIGHT, BOX.boxWidth, BOX.boxHeight)
  );
  // The provider-422 invariant: the stored dimensions ARE the buffer's.
  assert.deepEqual(detectRasterImage(normalized.buffer), {
    contentType: "image/png",
    width: normalized.width,
    height: normalized.height
  });
});

test("import decodes a GIF to PNG instead of rejecting it", async () => {
  // A GIF source must pass the format gate, or the client shows nothing at all.
  const gif = await solidImage(500, 500).gif().toBuffer();
  const inspected = inspectImportedRasterImage(gif, "image/gif");
  const normalized = await normalizeImportedRasterImage(gif, inspected, BOX);

  assert.equal(normalized.contentType, "image/png");
  assert.deepEqual({ width: normalized.width, height: normalized.height }, { width: 256, height: 256 });
  assert.deepEqual(detectRasterImage(normalized.buffer), {
    contentType: "image/png",
    width: 256,
    height: 256
  });
});

test("an oversized photo is resized on import, not refused", async () => {
  // Incompressible pixels so the encoded source really is large: 2000x1500 RGB
  // noise is ~9 MB, past the 4 MB fal vary cap. It must come back small enough to
  // inline as a base64 data URL.
  const huge = await sharp(noiseBuffer(2000, 1500), { raw: { width: 2000, height: 1500, channels: 3 } })
    .png()
    .toBuffer();
  assert.ok(huge.byteLength > 4 * 1024 * 1024, `fixture should exceed the old caps (got ${huge.byteLength})`);

  const inspected = inspectImportedRasterImage(huge, "image/png");
  const normalized = await normalizeImportedRasterImage(huge, inspected, BOX);

  assert.deepEqual({ width: normalized.width, height: normalized.height }, { width: 320, height: 256 });
  assert.ok(
    normalized.buffer.byteLength < 4 * 1024 * 1024,
    `resized source must clear FAL_VARY_MAX_SOURCE_BYTES (got ${normalized.buffer.byteLength})`
  );
});

test("import applies EXIF orientation before fitting", async () => {
  // Orientation 6 means the stored 346x268 raster displays as 268x346. Fitting
  // the stored (landscape) size would hand the provider a rotated, wrongly
  // shaped image.
  const rotated = await solidImage(SOURCE_WIDTH, SOURCE_HEIGHT)
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const inspected = inspectImportedRasterImage(rotated, "image/jpeg");
  const normalized = await normalizeImportedRasterImage(rotated, inspected, BOX);

  assert.deepEqual(
    { width: normalized.width, height: normalized.height },
    fitImageSizeToBox(SOURCE_HEIGHT, SOURCE_WIDTH, BOX.boxWidth, BOX.boxHeight)
  );
  assert.ok(normalized.height > normalized.width, "portrait source stays portrait");
});
