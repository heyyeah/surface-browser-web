// Frontend build-time flags.

export const DEV_TOOLS_ENABLED = Boolean(__SURFACE_BROWSER_DEV__);

export const DEBUG_UI = DEV_TOOLS_ENABLED;

// `?mic=0` skips the microphone permission prewarm for this page load.
// Automated browsers block getUserMedia and surface a warning; the prewarm is
// only a latency optimisation for the first mic press.
export const MIC_PREWARM_ENABLED = (() => {
  try {
    return new URLSearchParams(window.location.search).get("mic") !== "0";
  } catch {
    return true;
  }
})();

// `?wrist=left|right` forces which hand carries the wrist UI for this page load,
// overriding the server setting (WRIST_PANEL_HAND). Returns null when absent or
// malformed, in which case the server value wins.
export const WRIST_PANEL_HAND_OVERRIDE = (() => {
  try {
    const raw = new URLSearchParams(window.location.search).get("wrist");
    const value = String(raw || "").trim().toLowerCase();
    return value === "left" || value === "right" ? value : null;
  } catch {
    return null;
  }
})();

// The wrist launcher is production: with hands it is the only route to the menu.
// `?wristui=0` silences it for a session.
export const WRIST_LAUNCHER_ENABLED = (() => {
  try {
    return new URLSearchParams(window.location.search).get("wristui") !== "0";
  } catch {
    return true;
  }
})();

// `?w=1` (or `?wristui=force`) keeps the launcher up whenever the panel hand is
// tracked, bypassing the two-factor summon pose, for debugging the poke targets.
// It still needs a tracked hand to anchor to. DEV builds only.
export const WRIST_LAUNCHER_FORCE_SUMMON = (() => {
  if (!DEV_TOOLS_ENABLED) {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("w") === "1" || params.get("wristui") === "force";
  } catch {
    return false;
  }
})();

// `?wristlabels=1` pins the wrist panels' text labels on, instead of following
// tier 2 of the summon rule (icons while the hand is in view; icon + text once
// the user looks at that wrist). The freeze still pins the tier mid-poke, and
// the panel only grows away from its icon column rather than moving it.
export const WRIST_LABELS_PINNED = (() => {
  try {
    return new URLSearchParams(window.location.search).get("wristlabels") === "1";
  } catch {
    return false;
  }
})();

// `?hands=0` asks for a session without hand tracking, to test a hand-capable
// headset as a controller-only visitor. It drops the feature from the request
// rather than ignoring hands afterwards, so the runtime reports no
// `hand-tracking`, as on a headset with the setting off.
export const XR_HAND_TRACKING_ENABLED = (() => {
  try {
    return new URLSearchParams(window.location.search).get("hands") !== "0";
  } catch {
    return true;
  }
})();

// `?layers=0` is a device diagnostic: it renders XR through the plain
// XRWebGLLayer framebuffer instead of an XRProjectionLayer. Dropping "layers"
// from the session request is not enough, since three picks the projection-layer
// path whenever XRWebGLBinding exists, read once when the renderer is built. So
// the global is hidden here, before scene.js builds it.
export const XR_LAYERS_ENABLED = (() => {
  try {
    if (new URLSearchParams(window.location.search).get("layers") !== "0") {
      return true;
    }
    window.XRWebGLBinding = undefined;
    return false;
  } catch {
    return true;
  }
})();

// `?wall=basic` is a device diagnostic: the tunnel wall is the app's only lit
// material, and this draws it unlit instead (see buildTunnelMaterial).
export const TUNNEL_WALL_UNLIT = (() => {
  try {
    return new URLSearchParams(window.location.search).get("wall") === "basic";
  } catch {
    return false;
  }
})();

// `?clip=always` is a device diagnostic for the Pico right eye, which recovers
// once the portal clip plane switches on: it keeps a clip plane on the wall from
// the first frame, placed so it clips nothing (see setTunnelClipPlane).
export const TUNNEL_CLIP_ALWAYS = (() => {
  try {
    return new URLSearchParams(window.location.search).get("clip") === "always";
  } catch {
    return false;
  }
})();

// `?wall=opaque` is a Pico right-eye diagnostic: the wall is ~1.1M triangles,
// transparent and double-sided, which three draws as two passes per eye. This
// draws it opaque, in one pass.
export const TUNNEL_WALL_OPAQUE = (() => {
  try {
    return new URLSearchParams(window.location.search).get("wall") === "opaque";
  } catch {
    return false;
  }
})();

// `?rings=300` is the other half of that diagnostic: a short, coarse wall
// (also 64 segments), small enough for 16-bit indices.
export const TUNNEL_RINGS_OVERRIDE = (() => {
  try {
    const rings = Number(new URLSearchParams(window.location.search).get("rings"));
    return Number.isFinite(rings) && rings > 0 ? rings : 0;
  } catch {
    return 0;
  }
})();

// `?log=1` streams XR input diagnostics to the API server, which prints them in
// the `npm run dev:api` terminal and appends them to `server/xr-diag.log`. On by
// default in DEV builds; the flag enables it in any build.
export const XR_DIAG_ENABLED = (() => {
  try {
    if (new URLSearchParams(window.location.search).get("log") === "1") {
      return true;
    }
  } catch {
    // fall through to the build flag
  }
  return DEV_TOOLS_ENABLED;
})();

// `?cap=<token>` authorises screen capture against the server's SCREENSHOT_TOKEN.
// The token is kept in localStorage and stripped from the URL so it does not sit
// in history or ride along as a Referer; later requests carry it as a header,
// never a query param. `?cap=` (empty) forgets it. Absent and unstored, the
// capture control does not exist.
const CAPTURE_TOKEN_STORAGE_KEY = "surfaceBrowser.captureToken";

export const CAPTURE_TOKEN = (() => {
  // null = the parameter was absent, "" = it was present and empty.
  let fromUrl = null;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("cap")) {
      fromUrl = String(params.get("cap") || "").trim();
      params.delete("cap");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
      );
    }
  } catch {
    // No URL, or no history API. Fall through to whatever was stored.
  }
  // Storage throws in some privacy modes, so a stored token is a convenience, not
  // a requirement; the one from the URL still wins.
  try {
    if (fromUrl) {
      window.localStorage.setItem(CAPTURE_TOKEN_STORAGE_KEY, fromUrl);
    } else if (fromUrl === "") {
      window.localStorage.removeItem(CAPTURE_TOKEN_STORAGE_KEY);
    } else {
      return String(window.localStorage.getItem(CAPTURE_TOKEN_STORAGE_KEY) || "");
    }
  } catch {
    // fall through
  }
  return fromUrl || "";
})();

// Whether to offer a capture control at all. Gated on the token so a visitor's
// menu is unchanged and nobody is shown a button they could not use.
export const CAPTURE_CONTROL_ENABLED = Boolean(CAPTURE_TOKEN);

// `?capui=1` keeps the UI in the capture, for one page load. The default strips
// hands, controllers, wrist panels, world/help panels, ray visuals and the
// footer; this is for photographing a UI problem.
//
// Not `?cap=`: that is the capture token, and a value there would be stored as
// one. Not persisted, and needs no gate of its own since capture is token-gated.
export const CAPTURE_KEEP_UI = (() => {
  try {
    return new URLSearchParams(window.location.search).get("capui") === "1";
  } catch {
    return false;
  }
})();

// `?passthrough=0` forces the opaque session. By default the session is AR but
// passthrough itself starts off (state.passthroughOn), so nothing shows the room
// until the goggles cell is pressed.
export const PASSTHROUGH_ENABLED = (() => {
  try {
    return new URLSearchParams(window.location.search).get("passthrough") !== "0";
  } catch {
    return true;
  }
})();

// `?drag=vel` puts the sphere's pinch-drag back on the velocity model for one
// page load. The default is the grab model: hand displacement names an angle,
// not a speed, so a held displacement holds the sphere still. One branch, in
// applyHandRotateDrag() (src/input.js).
export const HAND_DRAG_VELOCITY_MODEL = (() => {
  try {
    return new URLSearchParams(window.location.search).get("drag") === "vel";
  } catch {
    return false;
  }
})();
