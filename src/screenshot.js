// Screen capture.
//
// An admin capability, not a visitor feature: it writes a JPEG on the server,
// which gates it on SCREENSHOT_TOKEN. On hands it is the wrist panel's Capture
// row; on controllers it is left Y, available only when a capture token is
// configured (`?cap=`, config.js).
//
// The capture is an offscreen re-render, not a framebuffer grab: xr is switched
// off and the scene is drawn once more into a WebGLRenderTarget from the app
// camera. three's WebXRManager.updateCamera() writes the headset pose onto that
// camera every XR frame, so the render still sits at the eyes. Being a fresh
// pass over the same scene graph, hands and UI can be excluded (capture-hide.js).
import * as THREE from "three";
import { camera, renderer, scene } from "./scene.js";
import { collectCaptureHideables, hideForCapture } from "./capture-hide.js";
import { CAPTURE_TOKEN, CAPTURE_KEEP_UI } from "./config.js";
import { setStatus } from "./ui.js";
import { t } from "./i18n.js";

const SCREENSHOT_MAX_EDGE = 1920;

// The JPEG is encoded here and the binary goes on the wire: a headset eye
// buffer is ~18 MB of RGBA (~24 MB as base64), far over the server's JSON limit.
// canvas.toBlob encodes on a worker thread. JPEG rather than PNG: the frame is
// opaque, so there is no alpha to lose and the file is much smaller.
function encodeCaptureJpeg(pixels, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("No 2D context for the capture"));
  }
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding failed"))),
      "image/jpeg",
      0.92
    );
  });
}

async function saveScreenshot() {
  const sourceWidth = renderer.domElement.width || renderer.domElement.clientWidth || 1024;
  const sourceHeight = renderer.domElement.height || renderer.domElement.clientHeight || 768;
  const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.floor(sourceWidth * scale));
  const height = Math.max(1, Math.floor(sourceHeight * scale));
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace
  });
  const pixels = new Uint8Array(width * height * 4);
  // The flip stays: readRenderTargetPixels returns bottom-up rows and ImageData is
  // top-down. A row-wise set() is one pass; flipping via a second canvas costs a
  // full-size surface and a GPU round-trip.
  const flipped = new Uint8ClampedArray(pixels.length);
  const previousTarget = renderer.getRenderTarget();
  const previousXrEnabled = renderer.xr.enabled;
  // Assigned inside the try so a throw while hiding (which restores itself) still
  // reaches the finally below with a harmless no-op.
  let restoreVisibility = () => {};

  try {
    // The footer is hidden too, since saveScreenshotWithStatus() has just written
    // "Saving screenshot..." into it.
    //
    // `?capui=1` skips the whole list (config.js) so the UI stays in the capture;
    // the restore below stays a no-op.
    if (!CAPTURE_KEEP_UI) {
      restoreVisibility = hideForCapture(collectCaptureHideables());
    }
    renderer.xr.enabled = false;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
      const sourceOffset = (height - 1 - y) * rowBytes;
      const targetOffset = y * rowBytes;
      flipped.set(pixels.subarray(sourceOffset, sourceOffset + rowBytes), targetOffset);
    }
  } finally {
    // Not optional, and first: if the render threw, the user must not be left in a
    // headset with invisible hands and no UI.
    restoreVisibility();
    renderer.setRenderTarget(previousTarget);
    renderer.xr.enabled = previousXrEnabled;
    target.dispose();
  }

  const blob = await encodeCaptureJpeg(flipped, width, height);

  // The token rides in a header, never a query param: URLs end up in logs, history
  // and Referer, and this one authorises a write.
  const headers = { "content-type": "image/jpeg" };
  if (CAPTURE_TOKEN) {
    headers["x-capture-token"] = CAPTURE_TOKEN;
  }
  const response = await fetch("/api/screenshot", { method: "POST", headers, body: blob });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The route answers 404 rather than 403 when it refuses; say so instead of
    // showing a bare "not found".
    if (response.status === 404) {
      throw new Error("Screenshot saving is not available on this server");
    }
    throw new Error(payload.error || `Screenshot failed (HTTP ${response.status})`);
  }
  // Says which kind it was, so a UI capture is not mistaken for a failed hide.
  const path = payload.path || payload.filename;
  setStatus(t(CAPTURE_KEEP_UI ? "status.savedScreenshotUi" : "status.savedScreenshot", { path }), true);
  return payload;
}

async function saveScreenshotWithStatus() {
  try {
    setStatus(t("status.savingScreenshot"));
    return await saveScreenshot();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
    return null;
  }
}

export { saveScreenshot, saveScreenshotWithStatus };
