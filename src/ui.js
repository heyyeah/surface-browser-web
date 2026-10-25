// UI helpers: status label, VR button state, focus, XR session control,
// resize, and the perf HUD.

import * as THREE from "three";
import { DEBUG_UI, DEV_TOOLS_ENABLED, XR_DIAG_ENABLED, XR_HAND_TRACKING_ENABLED, XR_LAYERS_ENABLED, PASSTHROUGH_ENABLED } from "./config.js";
import {
  statusLabel,
  statusFooter,
  exitVrBtn,
  backBtn,
  urlInput,
  canvas,
  perfLabel,
  stateLabel,
  devOnlyElements,
  resultsPanel,
  resultsShell,
  resultsToggle,
  resultsCount,
  touchChordRing,
  touchChordRingArc
} from "./dom.js";
import { canGoBack, goBack } from "./api.js";
import { AppState } from "./constants.js";
import { renderer, camera, scene, spherePanels } from "./scene.js";
import { passthroughSessionSupported } from "./passthrough.js";
import { state } from "./state.js";
import {
  tunnelProgressText,
  genAiProgressText,
  tunnelErrorText,
  trimForFooter,
  pendingLoadText,
  withoutProviderPrefix
} from "./tunnel-progress.js";
import { setXrSessionAttempt, logXrEvent } from "./xr-diag.js";
import { registerCaptureHideables } from "./capture-hide.js";
import { t } from "./i18n.js";

const FOOTER_DISTANCE = 2.4;
const FOOTER_HEIGHT_OFFSET = -0.92;
// Clearance between the bottom of a panel and the top of the footer when both
// are up. Device knob: raise if they touch, lower if the footer drops out of view.
const FOOTER_PANEL_CLEARANCE_M = 0.06;
const FOOTER_WIDTH_M = 1.75;
// Three readable URL lines, rather than one line spilling out of the panel.
const FOOTER_HEIGHT_M = 0.33;
const FOOTER_CANVAS_WIDTH = 1024;
const FOOTER_CANVAS_HEIGHT = 192;
const FOOTER_FOLLOW_LERP = 0.12;
const FOOTER_MAX_TEXT = 96;
// Warnings and errors are whole sentences (the daily-limit one runs to ~210
// characters in French) and both footers wrap: CSS on the flat one, three lines
// on the VR canvas, which adds its own ellipsis past that.
const FOOTER_NOTICE_MAX_TEXT = 240;
const FOOTER_TEXT_MAX_LINES = 3;

let statusFooterEnabled = true;
// The flat-mode list of extracted image/link URLs under the canvas. Useful while
// developing, noise when presenting, so it is server-gated. Flat mode only.
let imageListEnabled = true;
let statusFooterCanvas = null;
let statusFooterCtx = null;
let statusFooterTexture = null;
let statusFooterMesh = null;
let lastFooterText = "";

// DEV-only transient note on the status footer. The footer text is otherwise
// composed from state every frame, so a one-shot diagnostic needs a short-lived
// override that decays on its own. It is read ahead of the statusFooterEnabled
// gate on purpose: it is an input readout for tuning on device, where the footer
// may be switched off. Dead in the public build (DEBUG_UI === DEV_TOOLS_ENABLED).
const DEV_FOOTER_NOTE_MS = 1400;
let devFooterNote = "";
let devFooterNoteUntilMs = 0;

function setDevFooterNote(text) {
  if (!DEBUG_UI) {
    return;
  }
  devFooterNote = String(text || "");
  devFooterNoteUntilMs = performance.now() + DEV_FOOTER_NOTE_MS;
}

// The two-finger confirm ring. It makes the GenAI chord discoverable and
// cancellable, and is the only feedback that distinguishes "about to spend" from
// "nothing happening". Driven from the pure touch decision, so it has no timing
// of its own and draws whatever progress it is handed.
//
// TOUCH_CHORD_RING_CIRCUMFERENCE is 2 * PI * 18, matching the r=18 circle in
// index.html and the stroke-dasharray in styles.css.
const TOUCH_CHORD_RING_CIRCUMFERENCE = 2 * Math.PI * 18;
let touchChordRingVisible = false;

function updateTouchChordRing({ active = false, progress = 0, x = 0, y = 0 } = {}) {
  if (!touchChordRing) {
    return;
  }
  if (!active) {
    if (touchChordRingVisible) {
      touchChordRingVisible = false;
      touchChordRing.hidden = true;
    }
    return;
  }
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  touchChordRing.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  if (touchChordRingArc) {
    touchChordRingArc.style.strokeDashoffset =
      String(TOUCH_CHORD_RING_CIRCUMFERENCE * (1 - clamped));
  }
  if (!touchChordRingVisible) {
    touchChordRingVisible = true;
    touchChordRing.hidden = false;
  }
}

// A failed load must say so wherever the visitor is. The footer only surfaces
// in-progress statuses inside the sphere, so an outcome that leaves the scene
// unchanged would have nowhere to appear; warnings and errors get a few seconds
// of their own.
const FOOTER_NOTICE_MS = 6000;
let footerNotice = "";
let footerNoticeUntilMs = 0;
let footerNoticeIsError = false;

function setStatus(message, stateName = false, { noticeMs = FOOTER_NOTICE_MS } = {}) {
  statusLabel.textContent = message;
  statusLabel.classList.toggle("ok", stateName === true || stateName === "ok");
  statusLabel.classList.toggle("warning", stateName === "warning");
  statusLabel.classList.toggle("error", stateName === "error");
  if (stateName === "warning" || stateName === "error") {
    footerNotice = withoutProviderPrefix(message);
    footerNoticeUntilMs = performance.now() + noticeMs;
    footerNoticeIsError = stateName === "error";
  } else {
    footerNotice = "";
    footerNoticeUntilMs = 0;
    footerNoticeIsError = false;
  }
}

function setAddressFeedback(stateName = null) {
  urlInput.classList.toggle("load-error", stateName === "error");
  urlInput.classList.toggle("load-muted", stateName === "muted");
}

function configureDebugUi() {
  document.documentElement.dataset.dev = DEV_TOOLS_ENABLED ? "1" : "0";
  document.documentElement.dataset.debug = DEBUG_UI ? "1" : "0";
  for (const element of devOnlyElements) {
    element.hidden = !DEBUG_UI;
  }
}

function isStatusFooterEnabled() {
  return statusFooterEnabled;
}

function isImageListEnabled() {
  return imageListEnabled;
}

// The image-URL strip has two independent switches and they compose in one
// direction only:
//   imageListEnabled - the server capability. Off means the whole strip is gone
//                      and its DOM emptied.
//   resultsCollapsed - the reader's choice. It only hides the list; the header
//                      strip stays as the way back.
// Server-off wins. A strip the reader collapsed and the server then re-enables
// comes back collapsed, but no reader choice can un-hide a server-off strip.
const RESULTS_COLLAPSED_KEY = "surfaceBrowser.resultsCollapsed";
// Collapsed by default everywhere: the strip is a working list, not part of the
// work. A stored choice always beats this default. There is one default (no
// per-viewport one), so no matchMedia listener re-applies it on rotation.
let resultsCollapsed = true;

function readStoredResultsCollapsed() {
  try {
    const raw = window.localStorage?.getItem(RESULTS_COLLAPSED_KEY);
    if (raw === "1") {
      return true;
    }
    if (raw === "0") {
      return false;
    }
  } catch {
    // A private window throws on READ as well as write, so both are wrapped.
  }
  return null;
}

function writeStoredResultsCollapsed(collapsed) {
  try {
    window.localStorage?.setItem(RESULTS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}

function applyResultsVisibility() {
  if (resultsShell) {
    resultsShell.hidden = !imageListEnabled;
    resultsShell.classList.toggle("is-collapsed", resultsCollapsed);
  }
  if (resultsPanel) {
    resultsPanel.hidden = !imageListEnabled || resultsCollapsed;
  }
  if (resultsToggle) {
    resultsToggle.setAttribute("aria-expanded", resultsCollapsed ? "false" : "true");
  }
}

function updateResultsCount() {
  if (!resultsCount || !resultsPanel) {
    return;
  }
  let rows = 0;
  for (const child of resultsPanel.children) {
    if (child.querySelector?.("a[href]")) {
      rows += 1;
    }
  }
  resultsCount.textContent = rows > 0 ? String(rows) : "";
}

function setResultsCollapsed(collapsed, { persist = true } = {}) {
  resultsCollapsed = Boolean(collapsed);
  if (persist) {
    writeStoredResultsCollapsed(resultsCollapsed);
  }
  applyResultsVisibility();
}

function isResultsCollapsed() {
  return resultsCollapsed;
}

function setupResultsDisclosure() {
  const stored = readStoredResultsCollapsed();
  resultsCollapsed = stored === null ? true : stored;
  applyResultsVisibility();
  updateResultsCount();

  resultsToggle?.addEventListener("click", (event) => {
    // The window-level click handler in main.js closes the shortcuts menu; the
    // disclosure should not keep it open, but the click must not reach the canvas.
    event.stopPropagation();
    setResultsCollapsed(!resultsCollapsed);
  });

  // renderResults() in api.js rebuilds #results wholesale on every load, so there
  // is no event to hang the count off; watch the list itself.
  if (resultsPanel && typeof MutationObserver === "function") {
    new MutationObserver(updateResultsCount).observe(resultsPanel, { childList: true });
  }
}

// Marks the list row of the image selected in the sphere. Called every frame;
// a rebuilt list (new rows, no class) is detected by the row no longer carrying it.
let selectedResultRow = null;

function syncSelectedResultRow() {
  if (!resultsPanel || resultsPanel.hidden) {
    return;
  }
  const panel = state.appState === AppState.INSIDE_SPHERE ? spherePanels[state.sphereSelectedIndex] : null;
  const index = panel ? panel.itemIndex : -1;
  const row = index >= 0 ? resultsPanel.querySelector(`.result-row[data-item-index="${index}"]`) : null;
  if (row === selectedResultRow && (!row || row.classList.contains("is-selected"))) {
    return;
  }
  selectedResultRow?.classList.remove("is-selected");
  selectedResultRow = row;
  if (row) {
    row.classList.add("is-selected");
    // Scroll the list only: scrollIntoView would also move the page.
    const top = row.offsetTop - resultsPanel.offsetTop;
    if (top < resultsPanel.scrollTop || top + row.offsetHeight > resultsPanel.scrollTop + resultsPanel.clientHeight) {
      resultsPanel.scrollTop = top - (resultsPanel.clientHeight - row.offsetHeight) / 2;
    }
  }
}

// Hides the panel outright as well as gating its contents, so turning it off
// reclaims the space under the canvas rather than leaving an empty strip.
function setImageListEnabled(enabled) {
  imageListEnabled = Boolean(enabled);
  if (resultsPanel && !imageListEnabled) {
    resultsPanel.textContent = "";
  }
  applyResultsVisibility();
  updateResultsCount();
}

setupResultsDisclosure();

// The toolbar back button. Back is not a touch gesture, and the toolbar is the
// only flat control for it. It calls the same goBack() the VR left stick press
// calls.
//
// The import is static despite api.js importing this module back. The cycle is
// safe: both sides export hoisted function declarations and neither calls across
// the cycle during module evaluation.
let lastBackEnabled = null;

function syncBackButton() {
  if (!backBtn) {
    return;
  }
  // Not gated on cycleRequestInFlight: Back works mid-load, and gating would
  // make the button flicker through every load.
  const enabled = canGoBack();
  if (enabled === lastBackEnabled) {
    return;
  }
  lastBackEnabled = enabled;
  backBtn.disabled = !enabled;
}

backBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (backBtn.disabled) {
    return;
  }
  void goBack();
});

function setStatusFooterEnabled(enabled, { persist = false } = {}) {
  statusFooterEnabled = Boolean(enabled);
  if (!statusFooterEnabled) {
    setFooterText("");
  }
  if (persist) {
    void fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { SHOW_STATUS_FOOTER: statusFooterEnabled } })
    }).catch(() => {});
  }
}

// The run-your-own address in the daily-limit messages (api.js apiError) is a
// link on the flat footer. The VR footer is a canvas and stays plain text.
function setFlatFooterContent(element, text) {
  const address = `${window.location.host}/git`;
  const at = text.indexOf(address);
  if (at < 0) {
    element.textContent = text;
    return;
  }
  const link = document.createElement("a");
  link.href = `${window.location.origin}/git`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = address;
  // One span: as direct flex children the text and link would sit side by side.
  const line = document.createElement("span");
  line.append(text.slice(0, at), link, text.slice(at + address.length));
  element.replaceChildren(line);
}

function setFooterText(text) {
  const nextText = String(text || "").trim();
  if (nextText === lastFooterText) {
    return;
  }
  lastFooterText = nextText;
  if (statusFooter) {
    setFlatFooterContent(statusFooter, nextText);
    statusFooter.hidden = !nextText || renderer.xr.isPresenting;
  }
  if (statusFooterTexture) {
    drawVrStatusFooter(nextText);
  }
  if (statusFooterMesh) {
    statusFooterMesh.visible = Boolean(nextText) && renderer.xr.isPresenting;
  }
}

// The followed image's title or alt text, only while its own page is the load.
function followedLabelFor(query) {
  return state.followedLabel && state.followedLabel.query === query ? state.followedLabel.text : "";
}

// In-progress statuses are the only ones the footer echoes. Matched on the stem
// of each translated message ("Searching images" from "Searching images..."),
// since the label holds whatever language setStatus() was given.
const PROGRESS_STATUS_KEYS = [
  "status.extracting", "status.searching", "status.generating",
  "status.reloading", "status.regenerating"
];
function isProgressStatus(text) {
  const lower = String(text).toLowerCase();
  return PROGRESS_STATUS_KEYS.some((key) => lower.startsWith(t(key).replace(/\.+$/, "").toLowerCase()));
}

function statusFooterText() {
  if (DEBUG_UI && devFooterNote) {
    if (performance.now() < devFooterNoteUntilMs) {
      return devFooterNote;
    }
    devFooterNote = "";
  }
  if (!statusFooterEnabled) {
    // Switching the footer off hides progress, not failures: a load that failed
    // still says so.
    return footerErrorText();
  }
  if (footerNotice) {
    if (performance.now() < footerNoticeUntilMs) {
      return trimForFooter(footerNotice, FOOTER_NOTICE_MAX_TEXT);
    }
    footerNotice = "";
  }
  // The img2img launch starts the sphere exit on the trigger, ahead of the source
  // import, so both the acknowledgement and a failed import must be readable
  // during EXITING_SPHERE too; otherwise the only feedback in VR is motion.
  if (state.genAiLaunch) {
    if (state.genAiJobError) {
      return genAiErrorFooterText();
    }
    return genAiProgressText({
      variationLabel: state.genAiLaunch.label,
      received: 0,
      expected: state.genAiBatchExpected
    });
  }
  if (state.appState === AppState.INSIDE_SPHERE) {
    // Identity content in the sphere renders as a per-image caption below the aimed
    // panel (drawSphereCaption in sphere.js). The strip only surfaces transient
    // loading status here, else stays out of the way.
    const currentStatus = String(statusLabel?.textContent || "").trim();
    if (isProgressStatus(currentStatus)) {
      return currentStatus;
    }
    return "";
  }
  if (state.appState !== AppState.TUNNEL) {
    return "";
  }
  // A failed/empty GenAI batch sets genAiJobError and forces genAiBatchComplete
  // back to true (api.js), so this takes priority over the "Generating..." branch
  // below and persists, instead of a stuck readout or (when currentLoadMode had not
  // flipped to "genai") a footer that goes blank once cycleRequestInFlight clears.
  // It is the only way a headset user finds out the job failed.
  if (state.genAiJobError) {
    return genAiErrorFooterText();
  }
  // A new request names itself straight away; the tunnel's items are still the
  // previous page's until its payload lands.
  const pending = state.menuLoad;
  if (state.cycleRequestInFlight && pending && pending.mode !== "genai" && pending.query !== state.currentQuery) {
    return pendingLoadText({ ...pending, label: followedLabelFor(pending.query) }, FOOTER_MAX_TEXT);
  }
  if ((pending?.mode ?? state.currentLoadMode) === "genai" && !state.genAiBatchComplete) {
    return genAiProgressText({
      variationLabel: state.genAiVariationLabel,
      received: state.genAiBatchReceived,
      expected: state.genAiBatchExpected
    });
  }
  if (!state.cycleRequestInFlight && state.extractedItems.length === 0) {
    return "";
  }
  if (state.extractedItems.length > 0 && state.appState === AppState.TUNNEL) {
    const page = state.pageTitle?.query === state.currentQuery ? state.pageTitle : null;
    return tunnelProgressText({
      mode: state.currentLoadMode,
      query: page?.sourceUrl || state.currentQuery,
      totalCount: state.extractedItems.length,
      spawnedCount: state.tunnelSpawnedPanelCount,
      domainFromUrl,
      label: page?.text || followedLabelFor(state.currentQuery)
    });
  }
  const currentStatus = String(statusLabel?.textContent || "").trim();
  if (!currentStatus || currentStatus === "Idle") {
    return "";
  }
  if (isProgressStatus(currentStatus)) {
    return currentStatus;
  }
  return "";
}

// Mode-dependent identity line for a single sphere image. Pure: takes the item,
// its panel and the active load mode so the footer and the per-image caption in
// sphere.js share one source of truth.
function genAiErrorFooterText() {
  if (state.genAiJobErrorIsBudget) {
    return trimForFooter(state.genAiJobError, FOOTER_NOTICE_MAX_TEXT);
  }
  return tunnelErrorText(state.genAiJobError, FOOTER_MAX_TEXT);
}

function footerErrorText() {
  if (footerNotice && footerNoticeIsError && performance.now() < footerNoticeUntilMs) {
    return trimForFooter(footerNotice, FOOTER_NOTICE_MAX_TEXT);
  }
  if (state.genAiJobError && (state.genAiLaunch || state.appState === AppState.TUNNEL)) {
    return genAiErrorFooterText();
  }
  return "";
}

function sphereIdentityForItem(item, panel, loadMode = state.currentLoadMode, max = FOOTER_MAX_TEXT) {
  if (!item) {
    return "";
  }
  if (loadMode === "genai") {
    const prompt = item.genai?.prompt || panel?.navigationQuery || state.currentQuery || t("footer.generatedImage");
    const modifierStack = Array.isArray(item.genai?.modifier?.stack)
      ? item.genai.modifier.stack.filter(Boolean)
      : (item.genai?.modifier?.emoji ? [item.genai.modifier.emoji] : []);
    if (modifierStack.length > 0) {
      const emojiText = modifierStack.join(" ");
      // Keep the lineage prompt short enough that the modifier emoji stays legible on
      // the narrow in-sphere caption plane.
      const promptMax = Math.max(8, Math.min(18, max - emojiText.length - 3));
      return compactText(`${compactText(prompt, promptMax)} · ${emojiText}`, max);
    }
    return compactText(prompt, max);
  }
  if (loadMode === "image_search") {
    const domain = domainFromUrl(item.linkUrl || item.imageUrl);
    const title = compactText(item.title || item.alt || "", Math.min(42, max));
    return title ? `${domain || t("footer.image").toLowerCase()} - ${title}` : (domain || t("footer.imageResult"));
  }
  return compactText(
    item.alt || item.title || filenameFromUrl(item.imageUrl) || domainFromUrl(item.imageUrl) || t("footer.image"),
    max
  );
}

function sphereIdentityText() {
  const panel = spherePanels[state.sphereSelectedIndex];
  const item = panel ? state.extractedItems[panel.itemIndex] : null;
  return sphereIdentityForItem(item, panel);
}

function compactText(text, max = FOOTER_MAX_TEXT) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function domainFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function filenameFromUrl(value) {
  try {
    const parsed = new URL(value);
    const segment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    return segment.replace(/\.(jpe?g|png|gif|webp|avif|svg)$/i, "") || "";
  } catch {
    return "";
  }
}

// anchorVrStatusFooter() scratch — see the note in that function.
const _footerCamPos = new THREE.Vector3();
const _footerCamDir = new THREE.Vector3();
const _footerTarget = new THREE.Vector3();
const _footerLookTarget = new THREE.Vector3();

function ensureVrStatusFooter() {
  if (statusFooterMesh) {
    return;
  }
  statusFooterCanvas = document.createElement("canvas");
  statusFooterCanvas.width = FOOTER_CANVAS_WIDTH;
  statusFooterCanvas.height = FOOTER_CANVAS_HEIGHT;
  statusFooterCtx = statusFooterCanvas.getContext("2d");
  statusFooterTexture = new THREE.CanvasTexture(statusFooterCanvas);
  statusFooterTexture.colorSpace = THREE.SRGBColorSpace;
  // Flat head-on UI quad; see the note in vrpanel.js createPanelSurface().
  // 1024 px over 1.75 m = 585 texels/m, read at FOOTER_DISTANCE = 2.4 m (~590
  // screen px/m), so a mip chain could never be sampled. minFilter must move with
  // generateMipmaps or the quad renders black.
  statusFooterTexture.generateMipmaps = false;
  statusFooterTexture.minFilter = THREE.LinearFilter;
  statusFooterTexture.magFilter = THREE.LinearFilter;
  const geometry = new THREE.PlaneGeometry(FOOTER_WIDTH_M, FOOTER_HEIGHT_M);
  const material = new THREE.MeshBasicMaterial({
    map: statusFooterTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  statusFooterMesh = new THREE.Mesh(geometry, material);
  statusFooterMesh.renderOrder = 10003;
  statusFooterMesh.visible = false;
  scene.add(statusFooterMesh);
  drawVrStatusFooter(lastFooterText);
}

function drawVrStatusFooter(text) {
  if (!statusFooterCtx) {
    return;
  }
  const ctx = statusFooterCtx;
  ctx.clearRect(0, 0, FOOTER_CANVAS_WIDTH, FOOTER_CANVAS_HEIGHT);
  if (!text) {
    statusFooterTexture.needsUpdate = true;
    return;
  }
  ctx.fillStyle = "rgba(7, 12, 20, 0.82)";
  roundRect(ctx, 6, 8, FOOTER_CANVAS_WIDTH - 12, FOOTER_CANVAS_HEIGHT - 16, 18);
  ctx.fill();
  ctx.strokeStyle = "rgba(83, 169, 255, 0.42)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#dbe6ff";
  ctx.font = "600 27px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = 38;
  // Do not pre-truncate here: the footer itself owns the three-line budget, so
  // a long unbroken URL can fill those lines before the final ellipsis.
  const lines = wrapVrFooterText(ctx, text, FOOTER_CANVAS_WIDTH - 56, FOOTER_TEXT_MAX_LINES);
  const firstBaseline = (FOOTER_CANVAS_HEIGHT / 2) - ((lines.length - 1) * lineHeight / 2) + 2;
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(lines[index], FOOTER_CANVAS_WIDTH / 2, firstBaseline + index * lineHeight);
  }
  statusFooterTexture.needsUpdate = true;
}

// Wraps at spaces, and hard-wraps only a word too long for a line (URLs often
// are), so every glyph stays inside the footer's rounded box. The last
// permitted line gains an ellipsis as soon as any content remains.
function wrapVrFooterText(ctx, text, maxWidth, maxLines) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) {
    return [];
  }
  const lines = [""];
  for (const glyph of Array.from(value)) {
    const lineIndex = lines.length - 1;
    const candidate = `${lines[lineIndex]}${glyph}`;
    if (ctx.measureText(candidate).width <= maxWidth || !lines[lineIndex]) {
      lines[lineIndex] = candidate;
      continue;
    }
    if (lines.length === maxLines) {
      lines[lineIndex] = ellipsizeVrFooterLine(ctx, lines[lineIndex], maxWidth);
      return lines;
    }
    // Carry the unfinished word down, unless it is the whole line.
    const space = glyph === " " ? -1 : lines[lineIndex].lastIndexOf(" ");
    if (space > 0) {
      const carried = lines[lineIndex].slice(space + 1);
      lines[lineIndex] = lines[lineIndex].slice(0, space);
      lines.push(`${carried}${glyph}`);
    } else {
      lines.push(glyph === " " ? "" : glyph);
    }
  }
  return lines;
}

function ellipsizeVrFooterLine(ctx, text, maxWidth) {
  let line = String(text || "").trim();
  const ellipsis = "…";
  while (line && ctx.measureText(`${line}${ellipsis}`).width > maxWidth) {
    line = line.slice(0, -1).trimEnd();
  }
  return `${line}${ellipsis}`;
}

function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function updateStatusFooter() {
  // Piggy-backed here because nothing publishes a "history changed" event and this
  // is the one per-frame UI hook this module owns. Two reads and a comparison; the
  // DOM is only touched when the answer moves.
  syncBackButton();
  const text = statusFooterText();
  if (renderer.xr.isPresenting && text) {
    ensureVrStatusFooter();
    anchorVrStatusFooter();
  }
  setFooterText(text);
  if (statusFooter) {
    statusFooter.hidden = !text || renderer.xr.isPresenting;
  }
  if (statusFooterMesh) {
    statusFooterMesh.visible = Boolean(text) && renderer.xr.isPresenting;
  }
}

function anchorVrStatusFooter() {
  if (!statusFooterMesh) {
    return;
  }
  const activeCamera = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : camera;
  // Module scratch, not fresh Vector3s per frame. Nothing escapes: the mesh's
  // position and lookAt both copy from these.
  const camPos = _footerCamPos;
  const camDir = _footerCamDir;
  activeCamera.getWorldPosition(camPos);
  activeCamera.getWorldDirection(camDir);
  camDir.y = 0;
  if (camDir.lengthSq() < 1e-6) {
    camDir.set(0, 0, -1);
  }
  camDir.normalize();
  const targetPosition = _footerTarget.copy(camPos).addScaledVector(camDir, FOOTER_DISTANCE);
  // Below the panel when there is one. The footer and the panels are both anchored
  // at 2.4 m, so a fixed height put the footer across the menu's bottom edge. It
  // steps down only while a panel is up, and lerps there.
  const panelBottom = state.vrPanelBottomOffset ?? null;
  targetPosition.y = camPos.y + (panelBottom === null
    ? FOOTER_HEIGHT_OFFSET
    : Math.min(FOOTER_HEIGHT_OFFSET, panelBottom - FOOTER_PANEL_CLEARANCE_M - (FOOTER_HEIGHT_M / 2)));
  if (!statusFooterMesh.visible && lastFooterText) {
    statusFooterMesh.position.copy(targetPosition);
  } else {
    statusFooterMesh.position.lerp(targetPosition, FOOTER_FOLLOW_LERP);
  }
  const lookTarget = _footerLookTarget.copy(targetPosition).sub(camDir);
  lookTarget.y = targetPosition.y;
  statusFooterMesh.lookAt(lookTarget);
}

// The "VR unavailable" answer is a modal rather than a disabled button plus a
// paragraph in the help panel (where a refused visitor will not look). The
// button stays clickable and answers the question directly. The help panel keeps
// the VR shortcut rows unconditionally; they are reference material.
let vrUnavailable = false;
let vrUnavailableOverlay = null;
let vrUnavailableReturnFocus = null;

function updateVrButtonLabel() {
  if (!exitVrBtn) {
    return;
  }
  if (renderer.xr.isPresenting) {
    exitVrBtn.textContent = t("vr.exit");
    return;
  }
  // Guards against the label being reset to "Enter VR" by the boot call and by the
  // sessionend listener in main.js, both of which run without knowing this.
  //
  // The label is "VR", not "VR Unavailable": the refused state would spend the
  // widest label in the toolbar on what you cannot do, while the button should
  // still advertise that VR exists. It stays clickable and the modal says why.
  exitVrBtn.textContent = vrUnavailable ? t("vr.short") : t("vr.enter");
  exitVrBtn.title = vrUnavailable ? t("vr.unavailable.title") : t("vr.enter");
}

// The help panel must rebuild when this answer arrives, because it is async
// (isSessionSupported returns a promise) and the panel is built at boot. A
// callback rather than an event: there is exactly one listener.
let vrAvailabilityListener = null;

function onVrAvailabilityChange(listener) {
  vrAvailabilityListener = typeof listener === "function" ? listener : null;
}

function setVrUnavailable(unavailable) {
  const next = Boolean(unavailable);
  const changed = next !== vrUnavailable;
  vrUnavailable = next;
  if (changed && vrAvailabilityListener) {
    try {
      vrAvailabilityListener(vrUnavailable);
    } catch {
      // A listener that throws must not take the VR button's label with it.
    }
  }
  if (!exitVrBtn) {
    return;
  }
  // Never disabled: a disabled control cannot explain itself, and main.js's
  // sessionstart handler sets `.disabled = false` unconditionally anyway.
  exitVrBtn.disabled = false;
  updateVrButtonLabel();
}

function isVrUnavailable() {
  return vrUnavailable;
}

function closeVrUnavailableDialog() {
  if (!vrUnavailableOverlay) {
    return;
  }
  window.removeEventListener("keydown", handleVrUnavailableKeydown, true);
  vrUnavailableOverlay.remove();
  vrUnavailableOverlay = null;
  const returnTo = vrUnavailableReturnFocus;
  vrUnavailableReturnFocus = null;
  if (returnTo?.isConnected) {
    try {
      returnTo.focus();
    } catch {
      // A control that went away while the dialog was open.
    }
  }
}

function handleVrUnavailableKeydown(event) {
  if (event.key !== "Escape" || !vrUnavailableOverlay) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closeVrUnavailableDialog();
}

// Reuses the settings overlay's visual language. Nothing outside the overlay is
// made inert and no scroll lock is taken, so a JS error elsewhere cannot leave
// the page trapped behind it.
function openVrUnavailableDialog() {
  if (vrUnavailableOverlay) {
    return;
  }
  vrUnavailableReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  const overlay = document.createElement("div");
  overlay.className = "settings-overlay vr-unavailable-overlay";
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeVrUnavailableDialog();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "settings-dialog vr-unavailable-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "vr-unavailable-title");
  overlay.appendChild(dialog);

  const header = document.createElement("div");
  header.className = "settings-header";
  dialog.appendChild(header);

  const heading = document.createElement("h2");
  heading.id = "vr-unavailable-title";
  heading.textContent = t("vr.about.heading");
  header.appendChild(heading);

  const body = document.createElement("div");
  body.className = "vr-unavailable-body";
  dialog.appendChild(body);

  // The artwork's own voice: Tim's wording, translated in i18n.js.
  const first = document.createElement("p");
  first.textContent = t("vr.about.body");
  body.appendChild(first);

  const footer = document.createElement("div");
  footer.className = "settings-footer";
  dialog.appendChild(footer);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "secondary";
  closeBtn.textContent = t("vr.about.close");
  closeBtn.addEventListener("click", closeVrUnavailableDialog);
  footer.appendChild(closeBtn);

  document.body.appendChild(overlay);
  vrUnavailableOverlay = overlay;
  window.addEventListener("keydown", handleVrUnavailableKeydown, true);
  try {
    closeBtn.focus();
  } catch {
    // Focus is a courtesy here, not a requirement.
  }
}

async function updateVrButtonAvailability() {
  if (!exitVrBtn) {
    return;
  }
  if (!navigator.xr) {
    setVrUnavailable(true);
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported("immersive-vr");
    setVrUnavailable(!supported);
  } catch {
    setVrUnavailable(true);
  }
}

function focusUrlInput() {
  urlInput.focus();
  urlInput.select();
}

function focusSceneCanvas() {
  canvas.focus({ preventScroll: true });
}

async function exitVrSession() {
  const session = renderer.xr.getSession();
  if (!session) {
    return;
  }
  try {
    await session.end();
  } catch (err) {
    setStatus(t("status.xrExitFailed", { message: err instanceof Error ? err.message : String(err) }));
  }
}

async function enterVrSession() {
  // The unavailable answer is given here rather than by intercepting the button's
  // click: main.js owns that listener, and racing it from a capture handler would
  // be an ordering dependency. Both refusal paths already go through this function.
  if (!navigator.xr) {
    setStatus(t("status.webxrUnavailable"));
    setVrUnavailable(true);
    openVrUnavailableDialog();
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported("immersive-vr");
    if (!supported) {
      setStatus(t("status.vrUnsupported"));
      setVrUnavailable(true);
      openVrUnavailableDialog();
      return;
    }
    setVrUnavailable(false);
    renderer.xr.setReferenceSpaceType("local-floor");
    // Quest hands arrive without joints when `hand-tracking` is merely optional: the
    // session is granted without it and both hands appear as the non-articulated
    // `meta-fixed-hand` profile with `inputSource.hand` empty. Requesting it as
    // required yields articulated hands. A required feature the device cannot supply
    // rejects the whole session, so a controller-only headset needs the fallbacks.
    //
    // Attempt order: (1) hand-tracking required with layers; (2) drops `layers`, in
    // case requesting it blocks hand-tracking; (3) the original request, so a
    // headset supporting none of it still gets in. `sessionAttempt` is logged with
    // the granted features to show which combination the runtime accepts.
    // `?hands=0` keeps only the last shape and strips hand-tracking from its
    // optional list too, since a runtime granting an optional feature would hand
    // back the hands we are trying to do without.
    const layers = XR_LAYERS_ENABLED ? ["layers"] : [];
    const attempts = XR_HAND_TRACKING_ENABLED
      ? [
        { requiredFeatures: ["local-floor", "hand-tracking"], optionalFeatures: [...layers] },
        { requiredFeatures: ["local-floor", "hand-tracking"], optionalFeatures: [] },
        { requiredFeatures: ["local-floor"], optionalFeatures: ["hand-tracking", ...layers] }
      ]
      : [{ requiredFeatures: ["local-floor"], optionalFeatures: [...layers] }];
    // AR first, VR as the fallback. A passthrough toggle cannot exist inside an
    // immersive-vr session (the blend mode is fixed at creation), so the only way to
    // offer one is to enter as AR and cover the room with our own backdrop
    // (passthrough.js). A runtime that refuses AR falls through to the VR request.
    const modes = (PASSTHROUGH_ENABLED && await passthroughSessionSupported())
      ? ["immersive-ar", "immersive-vr"]
      : ["immersive-vr"];
    let session = null;
    let sessionAttempt = 0;
    const requests = [];
    for (const mode of modes) {
      for (const features of attempts) {
        requests.push({ mode, features });
      }
    }
    for (let index = 0; index < requests.length; index += 1) {
      const { mode, features } = requests[index];
      try {
        session = await navigator.xr.requestSession(mode, features);
        sessionAttempt = index + 1;
        break;
      } catch (attemptErr) {
        // The rejection message is the only place the runtime explains why a feature was
        // refused ("Unrecognized feature", a permission denial, an unsupported
        // combination); do not swallow it.
        logXrEvent({
          event: "sessionrequest.rejected",
          attempt: index + 1,
          mode: requests[index].mode,
          requested: requests[index].features,
          errorName: attemptErr instanceof Error ? attemptErr.name : "unknown",
          errorMessage: attemptErr instanceof Error ? attemptErr.message : String(attemptErr)
        });
        if (index === requests.length - 1) {
          throw attemptErr;
        }
      }
    }
    setXrSessionAttempt(sessionAttempt);
    await renderer.xr.setSession(session);
    // Which optional features the runtime actually granted. Requesting
    // `hand-tracking` does not mean it was granted; when it is missing the hands
    // still arrive as input sources with a gamepad but no `XRHand` joints, so hand
    // models, the wrist launcher and the two-hand gesture go dead while raw buttons
    // fall through to the controller map (a thumb swipe reads as B / exit-VR).
    // Surfaced in the status line (diagnostics builds / ?log=1 only) so that
    // failure is easy to diagnose without replacing the visitor's status.
    const granted = Array.isArray(session.enabledFeatures)
      ? session.enabledFeatures.join(", ")
      : "unreported";
    if (XR_DIAG_ENABLED) {
      setStatus(`XR features: ${granted}`);
    }
  } catch (err) {
    setStatus(t("status.xrEnterFailed", { message: err instanceof Error ? err.message : String(err) }));
  }
}

function resize() {
  // The XR session owns the size and the eye projections; three refuses
  // setSize here and warns every frame.
  if (renderer.xr.isPresenting) {
    return;
  }
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function updatePerfLabel() {
  if (!DEBUG_UI) {
    return;
  }
  state.frameCounter += 1;
  const now = performance.now();
  const elapsed = now - state.fpsAccumulatorStart;
  if (elapsed < 500) {
    return;
  }
  const fps = (state.frameCounter * 1000) / elapsed;
  stateLabel.textContent = `State: ${state.appState} | ring ${state.currentRingFloat.toFixed(1)} -> ${state.targetSphereRing.toFixed(1)}`;
  perfLabel.textContent = `${fps.toFixed(1)} fps | ${renderer.info.render.calls} calls | ${renderer.info.render.triangles} tris`;
  state.frameCounter = 0;
  state.fpsAccumulatorStart = now;
}

// Screen capture: the in-world status footer is UI and leaves the frame with the
// rest of it. It matters most to hide, since the capture path writes "Saving
// screenshot..." through setStatus() on its way in.
function statusFooterCaptureHideables() {
  return [statusFooterMesh];
}

registerCaptureHideables(statusFooterCaptureHideables);

export {
  setStatus,
  setAddressFeedback,
  updateTouchChordRing,
  configureDebugUi,
  updateVrButtonLabel,
  updateVrButtonAvailability,
  isVrUnavailable,
  onVrAvailabilityChange,
  openVrUnavailableDialog,
  closeVrUnavailableDialog,
  focusUrlInput,
  focusSceneCanvas,
  exitVrSession,
  enterVrSession,
  resize,
  updatePerfLabel,
  updateStatusFooter,
  setDevFooterNote,
  setStatusFooterEnabled,
  isStatusFooterEnabled,
  setImageListEnabled,
  isImageListEnabled,
  syncSelectedResultRow,
  setResultsCollapsed,
  isResultsCollapsed,
  sphereIdentityForItem
};
