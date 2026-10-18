// XR input diagnostics for device debugging.
//
// The headset console is not practically readable, so this posts what the XR
// runtime actually hands the app to `POST /api/debug/xr`, which prints it in the
// dev server terminal and appends it to `server/xr-diag.log`.
//
// It looks for whether hand input sources arrive with their `XRHand` joints
// (`hasHand` / `jointCount`) or as bare gamepads. Without joints, hand models, the
// wrist launcher and the two-hand gesture go dead while raw buttons fall through
// to the controller map (a thumb swipe reading as B/exit-VR).
//
// Gated behind XR_DIAG_ENABLED (`?log=1`, or any DEV build) and best-effort: a
// failed post is swallowed, never surfaced to the user.

import { TUNNEL_CLIP_ALWAYS, TUNNEL_RINGS_OVERRIDE, TUNNEL_WALL_OPAQUE, TUNNEL_WALL_UNLIT, XR_DIAG_ENABLED, XR_LAYERS_ENABLED } from "./config.js";
import { renderer } from "./scene.js";
import { state } from "./state.js";

// Posts are emitted on change, not on a timer: a microgesture press lasts one or
// two frames at 30 Hz hand tracking, so a sampled snapshot would miss it. The
// cheap per-frame signature below makes that affordable.
let lastSignature = "";
let started = false;
// Which entry in enterVrSession()'s attempt list produced this session. Zero means
// the app's own cascade did not create it: the session came from three's hidden
// VRButton (Quest Browser's own VR affordance, or a URL opened directly into VR),
// which requests a different feature set and never gets `hand-tracking`.
// `sessionSource` names the path.
let sessionAttempt = 0;
let sessionSource = "system";

function setXrSessionAttempt(attempt) {
  sessionAttempt = Number(attempt) || 0;
  sessionSource = sessionAttempt > 0 ? "app" : "system";
}

// One-off structured events (a rejected session request, say) outside the
// per-frame input signature. Same best-effort posting as everything else here.
function logXrEvent(payload) {
  if (!XR_DIAG_ENABLED) {
    return;
  }
  post(payload);
}

function post(payload) {
  try {
    void fetch("/api/debug/xr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  } catch {
    // Diagnostics must never break the session they are diagnosing.
  }
}

function pressedIndices(buttons) {
  const pressed = [];
  for (let index = 0; index < buttons.length; index += 1) {
    if (buttons[index]?.pressed) {
      pressed.push(index);
    }
  }
  return pressed;
}

// Cheap enough to run every frame — no JSON, no allocation beyond one string.
function sourceSignature(source) {
  const buttons = source.gamepad?.buttons || [];
  return `${source.handedness}:${source.hand ? "H" : "-"}:${buttons.length}:${pressedIndices(buttons).join(",")}`;
}

function describeSource(source, frame, referenceSpace) {
  const buttons = source.gamepad?.buttons || [];
  const hand = source.hand || null;
  let jointCount = 0;
  let wristPose = false;
  if (hand) {
    jointCount = typeof hand.size === "number" ? hand.size : 0;
    try {
      const wrist = typeof hand.get === "function" ? hand.get("wrist") : null;
      if (wrist && frame && referenceSpace && typeof frame.getJointPose === "function") {
        wristPose = Boolean(frame.getJointPose(wrist, referenceSpace));
      }
    } catch {
      wristPose = false;
    }
  }
  return {
    handedness: source.handedness,
    targetRayMode: source.targetRayMode,
    hasHand: Boolean(hand),
    jointCount,
    wristPose,
    profiles: Array.from(source.profiles || []),
    buttonCount: buttons.length,
    pressed: pressedIndices(buttons)
  };
}

// Forwards console errors, since three reports a failed shader or model load only
// there. Capped so a per-frame error cannot flood the log.
const CONSOLE_FORWARD_LIMIT = 40;
let consoleForwarded = 0;

function forwardConsole(level, args) {
  if (consoleForwarded >= CONSOLE_FORWARD_LIMIT) {
    return;
  }
  consoleForwarded += 1;
  const message = args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(" ")
    .slice(0, 2000);
  post({ event: "console", level, message });
}

function startConsoleForwarding() {
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      forwardConsole(level, args);
    };
  }
  window.addEventListener("error", (event) => {
    forwardConsole("uncaught", [event.message, `${event.filename}:${event.lineno}`]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    forwardConsole("rejection", [event.reason]);
  });
}

function glRendererName() {
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch {
    return "unreported";
  }
}

function startXrDiagnostics() {
  if (!XR_DIAG_ENABLED || started) {
    return;
  }
  started = true;
  startConsoleForwarding();

  renderer.xr.addEventListener("sessionstart", () => {
    lastSignature = "";
    const session = renderer.xr.getSession();
    post({
      event: "sessionstart",
      sessionAttempt,
      sessionSource,
      userAgent: navigator.userAgent,
      gl: glRendererName(),
      layers: XR_LAYERS_ENABLED,
      wallUnlit: TUNNEL_WALL_UNLIT,
      clipAlways: TUNNEL_CLIP_ALWAYS,
      wallOpaque: TUNNEL_WALL_OPAQUE,
      rings: TUNNEL_RINGS_OVERRIDE,
      // The headline field: `hand-tracking` missing here means the runtime refused it
      // and no client code will produce joints.
      enabledFeatures: Array.isArray(session?.enabledFeatures)
        ? Array.from(session.enabledFeatures)
        : "unreported",
      wristPanelHand: state.wristPanelHand
    });
  });

  renderer.xr.addEventListener("sessionend", () => {
    lastSignature = "";
    post({ event: "sessionend" });
  });
}

// Frame pacing, summarised every 2 s: the Pico right-eye wall fault looks tied
// to how heavy frames are, and this lines that up with when the wall appears.
const FRAME_REPORT_MS = 2000;
let frameWindow = null;

function sampleFrameTiming(session) {
  const now = performance.now();
  if (!frameWindow || frameWindow.session !== session) {
    frameWindow = { session, start: now, last: now, count: 0, maxMs: 0, slow: 0 };
    return;
  }
  const deltaMs = now - frameWindow.last;
  frameWindow.last = now;
  frameWindow.count += 1;
  frameWindow.maxMs = Math.max(frameWindow.maxMs, deltaMs);
  if (deltaMs > 1000 / 60) {
    frameWindow.slow += 1;
  }
  if (now - frameWindow.start < FRAME_REPORT_MS) {
    return;
  }
  post({
    event: "frames",
    fps: Math.round((frameWindow.count * 1000) / (now - frameWindow.start)),
    maxMs: Math.round(frameWindow.maxMs),
    // Frames slower than 60 Hz, whatever the display rate.
    slow: frameWindow.slow,
    targetFps: session.frameRate ?? null,
    appState: state.appState,
    panels: state.tunnelSpawnedPanelCount
  });
  frameWindow = { session, start: now, last: now, count: 0, maxMs: 0, slow: 0 };
}

function updateXrDiagnostics() {
  if (!XR_DIAG_ENABLED || !renderer.xr.isPresenting) {
    return;
  }
  const session = renderer.xr.getSession();
  if (!session) {
    return;
  }
  sampleFrameTiming(session);
  const sources = Array.from(session.inputSources || []);
  let signature = `${sources.length}`;
  for (const source of sources) {
    signature += `|${sourceSignature(source)}`;
  }
  if (signature === lastSignature) {
    return;
  }
  lastSignature = signature;

  const frame = renderer.xr.getFrame();
  const referenceSpace = renderer.xr.getReferenceSpace();
  post({
    event: "sources",
    sourceCount: sources.length,
    sources: sources.map((source) => describeSource(source, frame, referenceSpace))
  });
}

export { startXrDiagnostics, updateXrDiagnostics, setXrSessionAttempt, logXrEvent };
