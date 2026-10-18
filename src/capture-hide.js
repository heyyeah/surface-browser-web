// Capture visibility: hide objects for a screenshot, restore afterwards.
//
// saveScreenshot() (screenshot.js) re-renders the same scene graph into an
// offscreen target with renderer.xr.enabled off, so anything can be excluded by
// flipping `visible` for the duration of that pass.
//
// This is a registry so screenshot.js need not import every UI module (that
// would be an import cycle: wristui.js imports screenshot.js).
//
// Pure: nothing here imports three or touches the DOM, so the save/restore
// contract, including the throwing case, is unit-testable offline.

// Each provider is a zero-arg function returning an iterable of scene objects
// (or nulls, for UI that has not been built yet in this session).
const captureHideableProviders = new Set();

// Called once at module scope by each UI module. Returns an unregister function
// so a test can register a provider without leaking it into the next test.
function registerCaptureHideables(provider) {
  if (typeof provider !== "function") {
    return () => {};
  }
  captureHideableProviders.add(provider);
  return () => {
    captureHideableProviders.delete(provider);
  };
}

// Flattens every provider's objects into one list, dropping nulls. A provider
// that throws is skipped so a failing provider cannot abort the capture.
function collectCaptureHideables() {
  const objects = [];
  for (const provider of captureHideableProviders) {
    let produced = null;
    try {
      produced = provider();
    } catch {
      produced = null;
    }
    if (!produced) {
      continue;
    }
    for (const object of produced) {
      if (object && typeof object === "object") {
        objects.push(object);
      }
    }
  }
  return objects;
}

// Hides everything given and returns the restore function. The caller must run
// it from a `finally`: a render that throws mid-capture must not leave the user
// without hands or menus.
//   1. If hiding throws part-way, what was already hidden is put back before the
//      error propagates.
//   2. The returned restore drains its record, so a second call is a no-op.
// Each object's previous value is restored, not `true`; most of these surfaces
// are normally hidden.
function hideForCapture(objects) {
  const saved = [];
  const restore = () => {
    while (saved.length) {
      const entry = saved.pop();
      entry.object.visible = entry.visible;
    }
  };
  try {
    for (const object of objects || []) {
      if (!object || typeof object !== "object") {
        continue;
      }
      saved.push({ object, visible: object.visible });
      object.visible = false;
    }
  } catch (err) {
    restore();
    throw err;
  }
  return restore;
}

export { registerCaptureHideables, collectCaptureHideables, hideForCapture };
