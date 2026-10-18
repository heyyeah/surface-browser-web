// Tiny zero-dependency PNG encoder used by the bake-off mock provider.
//
// Produces a valid RGB PNG from a raw pixel buffer. This is deliberately
// minimal: it exists so the mock sdapi provider can bake deterministic,
// human-distinguishable images (solid colour + a little text) with zero
// external dependencies and no canvas. Node's built-in zlib supplies the
// DEFLATE compression the PNG spec requires.

import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32 (PNG uses the standard IEEE polynomial). Small table built once.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

/**
 * Encode a raw RGB pixel buffer (length = width*height*3, row-major) into a
 * PNG buffer.
 */
export function encodePng(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePng: expected ${width * height * 3} bytes, got ${rgb.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour RGB
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // Each scanline is prefixed by a filter-type byte (0 = none).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// A compact 5x7 bitmap font: enough glyphs to bake seed/strength captions
// into the mock images so a human eye can tell the variations apart. Each
// glyph is 7 rows of a 5-bit mask (MSB = leftmost pixel).
const FONT = {
  "0": [0x1e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x1e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x1e, 0x11, 0x01, 0x0e, 0x10, 0x10, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04]
};

/**
 * Draw a short ASCII string into an existing RGB buffer at (x, y), scaled up,
 * in the given [r,g,b] colour. Unknown characters render as blanks.
 */
export function drawText(rgb, width, height, text, x, y, scale, color) {
  const [r, g, b] = color;
  let cursorX = x;
  for (const rawChar of String(text).toUpperCase()) {
    const glyph = FONT[rawChar] || FONT[" "];
    for (let row = 0; row < 7; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col += 1) {
        if (!(bits & (1 << (4 - col)))) {
          continue;
        }
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const px = cursorX + col * scale + sx;
            const py = y + row * scale + sy;
            if (px < 0 || px >= width || py < 0 || py >= height) {
              continue;
            }
            const idx = (py * width + px) * 3;
            rgb[idx] = r;
            rgb[idx + 1] = g;
            rgb[idx + 2] = b;
          }
        }
      }
    }
    cursorX += 6 * scale; // 5px glyph + 1px gap
  }
}

/**
 * Build a solid-background RGB buffer with a couple of caption lines baked in.
 * Deterministic given the inputs — used by the mock provider so repeated runs
 * with the same seed produce byte-identical PNGs (exercises the harness cache
 * story and makes contact sheets readable).
 */
export function makeLabeledImage(width, height, bgColor, lines) {
  const rgb = Buffer.alloc(width * height * 3);
  const [br, bg, bb] = bgColor;
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = br;
    rgb[i * 3 + 1] = bg;
    rgb[i * 3 + 2] = bb;
  }
  // Pick a legible text colour (black or white) based on background luminance.
  const luminance = 0.299 * br + 0.587 * bg + 0.114 * bb;
  const textColor = luminance > 140 ? [20, 20, 20] : [245, 245, 245];
  const scale = Math.max(2, Math.floor(width / 90));
  let y = Math.floor(height * 0.12);
  for (const line of lines) {
    drawText(rgb, width, height, line, Math.floor(width * 0.08), y, scale, textColor);
    y += 10 * scale;
  }
  return rgb;
}
