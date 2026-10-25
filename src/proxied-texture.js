// Texture loading for images that come through /api/proxy/image.
//
// A 503 from the proxy is this server's own busy guard: it refused before
// contacting the image's site, so retrying adds no load there. Any other failure
// is final — a broken image is not fetched from its site again.

import { textureLoader } from "./scene.js";

const BUSY_RETRY_DELAYS_MS = [400, 1000, 2200, 4500];
const RETRY_JITTER = 0.25;
// Stay at the server's per-client in-flight cap (4) so bursts queue here
// instead of drawing 503s.
const MAX_CONCURRENT_FETCHES = 4;

// The scene's copy of each image by URL, so Download still has it after the
// server has dropped a generated one. Weak: the panel's texture owns it.
const LOADED_IMAGES_MAX = 500;
const loadedImages = new Map();

function rememberImage(url, texture) {
  if (!texture?.image) {
    return;
  }
  loadedImages.delete(url);
  loadedImages.set(url, new WeakRef(texture.image));
  if (loadedImages.size > LOADED_IMAGES_MAX) {
    loadedImages.delete(loadedImages.keys().next().value);
  }
}

function loadedImageCopy(url) {
  return loadedImages.get(url)?.deref() || null;
}

let activeFetches = 0;
const fetchQueue = [];

function acquireSlot() {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => fetchQueue.push(resolve));
}

function releaseSlot() {
  const next = fetchQueue.shift();
  if (next) {
    next(); // the slot passes straight to the next waiter
  } else {
    activeFetches -= 1;
  }
}

function retryDelay(attempt) {
  const base = BUSY_RETRY_DELAYS_MS[attempt];
  return base * (1 + (Math.random() * 2 - 1) * RETRY_JITTER);
}

// Resolves to a Blob, or null for a 503 the caller should retry. The slot is
// released before the caller's retry timer starts.
async function fetchBlobLimited(url, attempt) {
  await acquireSlot();
  try {
    const response = await fetch(url);
    if (response.status === 503 && attempt < BUSY_RETRY_DELAYS_MS.length) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.blob();
  } finally {
    releaseSlot();
  }
}

function loadProxiedTexture(url, onLoad, onError) {
  if (!url.startsWith("/api/proxy/image")) {
    textureLoader.load(url, (texture) => {
      rememberImage(url, texture);
      onLoad(texture);
    }, undefined, onError);
    return;
  }
  const tryFetch = (attempt) => {
    fetchBlobLimited(url, attempt)
      .then((blob) => {
        if (!blob) {
          setTimeout(() => tryFetch(attempt + 1), retryDelay(attempt));
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        textureLoader.load(
          objectUrl,
          (texture) => {
            URL.revokeObjectURL(objectUrl);
            rememberImage(url, texture);
            onLoad(texture);
          },
          undefined,
          (err) => {
            URL.revokeObjectURL(objectUrl);
            onError(err);
          }
        );
      })
      .catch(onError);
  };
  tryFetch(0);
}

export { loadProxiedTexture, loadedImageCopy };
