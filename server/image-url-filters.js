// What an image URL gives away before it is fetched: a lazy-loading stand-in,
// or a size too small to show. Used by both extraction paths in index.js.

export const PLACEHOLDER_IMAGE_NAME = /(^|[-_.])(placeholder|spacer|blank|transparent|loading)([-_.]([\dx]+|image|img))?\.(png|gif|jpe?g|webp|svg)$/i;

export function isPlaceholderImageUrl(imageUrl) {
  try {
    return PLACEHOLDER_IMAGE_NAME.test(new URL(imageUrl).pathname.split("/").pop());
  } catch {
    return false;
  }
}

export function isStandInImageSource(value) {
  return /^data:/i.test(value) || PLACEHOLDER_IMAGE_NAME.test(value.split(/[?#]/)[0].split("/").pop());
}

// The size an image URL asks its server for: ?w=/&h= query parameters, or a
// IIIF size segment (/full/40,22/0/default.jpg). Blur-up pages pair each image
// with a ~40px copy that the tunnel would stretch into a smear.
export const TINY_DECLARED_EDGE_PX = 64;
const IIIF_SIZE_PATH = /\/(?:full|square|pct:[\d.,]+|[\d.]+,[\d.]+,[\d.]+,[\d.]+)\/\^?!?(\d*),(\d*)\/!?[\d.]+\/\w+\.\w+$/i;

export function declaredImageEdge(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const iiif = IIIF_SIZE_PATH.exec(decodeURIComponent(parsed.pathname));
    const values = iiif
      ? [iiif[1], iiif[2]]
      : ["w", "width", "h", "height"].map((key) => parsed.searchParams.get(key));
    const sizes = values.map((value) => (/^\d+$/.test(value || "") ? Number(value) : 0)).filter((value) => value > 0);
    return sizes.length ? Math.max(...sizes) : null;
  } catch {
    return null;
  }
}
