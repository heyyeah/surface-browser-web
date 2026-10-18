// One SVG render per process, for rasterizeSvg (images.js), which kills this
// process at the deadline: librsvg cannot be interrupted mid-tile.
import { ImageFormatError, renderSanitizedSvg } from "./images.js";

process.once("message", async ({ svg, maxEdgePx }) => {
  try {
    const png = await renderSanitizedSvg(Buffer.from(svg), maxEdgePx);
    process.send({ png });
  } catch (err) {
    process.send({ formatError: err instanceof ImageFormatError, message: err?.message || String(err) });
  }
});
