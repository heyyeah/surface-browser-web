// Canvas QWERTY keyboard for the in-VR panel: fallback text entry when no voice
// path exists. Owns layout and drawing only; vrpanel.js supplies the context,
// region, text and hover index, and applies the returned action objects.

import { t } from "./i18n.js";

// Layout tunables (canvas pixels / CSS color strings)

const KB_KEY_GAP = 12;
const KB_ROW_GAP = 12;
const KB_KEY_RADIUS = 10;
// Height reserved above the key rows for the composed-text field.
const KB_INPUT_H = 78;
const KB_INPUT_GAP = 18;
const KB_INPUT_RADIUS = 12;
const KB_CAPTION_H = 30;

const KB_COLOR_KEY = "#1b2740";
const KB_COLOR_KEY_HOVER = "#2a4270";
const KB_COLOR_KEY_BORDER = "#33456a";
const KB_COLOR_KEY_TEXT = "#e6eeff";
const KB_COLOR_ACTION = "#243657";
const KB_COLOR_ACTION_HOVER = "#325082";
const KB_COLOR_DONE = "#1f4d34";
const KB_COLOR_DONE_HOVER = "#2c7a51";
const KB_COLOR_CANCEL = "#4d2330";
const KB_COLOR_CANCEL_HOVER = "#7a3546";
const KB_COLOR_INPUT_BG = "#0b1220";
const KB_COLOR_INPUT_BORDER = "#33456a";
const KB_COLOR_INPUT_TEXT = "#dbe6ff";
const KB_COLOR_INPUT_PLACEHOLDER = "#546079";
const KB_COLOR_CAPTION = "#8ea1c2";
const KB_COLOR_CARET = "#53a9ff";

// Key rows. Each entry is either a single-character label or a special key with
// an explicit weight (how many key-widths it spans). Special actions carry an
// `action` object mirroring the panel's hit-rect action shape.
const KB_ROWS = Object.freeze([
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "-"],
  ["z", "x", "c", "v", "b", "n", "m", ".", "/",
    { label: "⌫", action: { type: "kbBackspace" }, weight: 1 }]
]);

// The bottom row. Speak is here, not on the menu toolbar, and only where a
// voice path exists; without it the space bar takes its width.
function bottomRow(voice, recording) {
  return [
    { label: t("vr.kb.close"), action: { type: "kbCancel" }, weight: 2 },
    ...(voice ? [{ label: t(recording ? "vr.kb.stop" : "vr.kb.speak"), action: { type: "voice" }, weight: 2 }] : []),
    { label: t("vr.kb.space"), action: { type: "kbKey", char: " " }, weight: voice ? 4 : 6 },
    { label: t("vr.kb.done"), action: { type: "kbDone" }, weight: 2 }
  ];
}

// Number of key-slots per row used to size a single key width (the widest row).
const KB_SLOTS_PER_ROW = 10;

// Drawing

function drawRoundedRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draw the keyboard into `region` = { x, y, w, h } on the given ctx. `text` is
// the composed string, `hoverIndex` is the global panel hover index and
// `baseRectIndex` is the panel's hitRects.length at call time (so hover math
// lines up with the panel's shared hit-rect list). Returns an array of
// { x, y, w, h, action } rects for the caller to append to its hit-rects.
function drawKeyboard(ctx, region, { text = "", hoverIndex = -1, baseRectIndex = 0, voice = false, recording = false } = {}) {
  const rects = [];
  const rows = [...KB_ROWS, bottomRow(voice, recording)];

  // Caption.
  ctx.fillStyle = KB_COLOR_CAPTION;
  ctx.font = "600 22px 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(t("vr.kb.title"), region.x + 4, region.y);

  // Composed-text field.
  const inputY = region.y + KB_CAPTION_H;
  ctx.fillStyle = KB_COLOR_INPUT_BG;
  drawRoundedRect(ctx, region.x, inputY, region.w, KB_INPUT_H, KB_INPUT_RADIUS);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = KB_COLOR_INPUT_BORDER;
  ctx.stroke();
  ctx.textBaseline = "middle";
  ctx.font = "500 34px 'Segoe UI', sans-serif";
  const inputMidY = inputY + KB_INPUT_H / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(region.x + 18, inputY, region.w - 36, KB_INPUT_H);
  ctx.clip();
  if (text) {
    ctx.fillStyle = KB_COLOR_INPUT_TEXT;
    const shown = `${text}`;
    ctx.fillText(shown, region.x + 20, inputMidY);
    // Caret after the text.
    const caretX = region.x + 20 + ctx.measureText(shown).width + 4;
    ctx.fillStyle = KB_COLOR_CARET;
    ctx.fillRect(caretX, inputMidY - 20, 3, 40);
  } else {
    ctx.fillStyle = KB_COLOR_INPUT_PLACEHOLDER;
    ctx.fillText(t("vr.kb.placeholder"), region.x + 20, inputMidY);
  }
  ctx.restore();

  // Key rows fill the remaining region below the input field.
  const rowsTop = inputY + KB_INPUT_H + KB_INPUT_GAP;
  const rowsH = region.y + region.h - rowsTop;
  const rowCount = rows.length;
  const keyH = (rowsH - KB_ROW_GAP * (rowCount - 1)) / rowCount;
  const unitW = (region.w - KB_KEY_GAP * (KB_SLOTS_PER_ROW - 1)) / KB_SLOTS_PER_ROW;

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const y = rowsTop + r * (keyH + KB_ROW_GAP);
    // Row width, centered in the region; wide keys span their inner gaps, so the sum
    // must use the same per-key width the loop below draws.
    const totalW = row.reduce((sum, key) => sum + keyWidth(key, unitW), 0)
      + KB_KEY_GAP * (row.length - 1);
    let x = region.x + (region.w - totalW) / 2;

    for (let c = 0; c < row.length; c += 1) {
      const key = row[c];
      const w = keyWidth(key, unitW);
      const label = keyLabel(key);
      const action = keyAction(key);
      const rectIndex = baseRectIndex + rects.length;
      const hovered = hoverIndex === rectIndex;

      let fill = KB_COLOR_KEY;
      if (action?.type === "kbDone") {
        fill = hovered ? KB_COLOR_DONE_HOVER : KB_COLOR_DONE;
      } else if (action?.type === "kbCancel") {
        fill = hovered ? KB_COLOR_CANCEL_HOVER : KB_COLOR_CANCEL;
      } else if (action?.type === "kbBackspace" || action?.type === "voice" || action?.char === " ") {
        fill = hovered ? KB_COLOR_ACTION_HOVER : KB_COLOR_ACTION;
      } else {
        fill = hovered ? KB_COLOR_KEY_HOVER : KB_COLOR_KEY;
      }

      ctx.fillStyle = fill;
      drawRoundedRect(ctx, x, y, w, keyH, KB_KEY_RADIUS);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = KB_COLOR_KEY_BORDER;
      ctx.stroke();

      ctx.fillStyle = KB_COLOR_KEY_TEXT;
      ctx.font = label.length > 1 ? "700 26px 'Segoe UI', sans-serif" : "600 32px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + w / 2, y + keyH / 2);

      rects.push({ x, y, w, h: keyH, action });
      x += w + KB_KEY_GAP;
    }
  }

  ctx.textAlign = "left";
  return rects;
}

function keyWeight(key) {
  if (typeof key === "string") {
    return 1;
  }
  return key.weight || 1;
}

function keyWidth(key, unitW) {
  const weight = keyWeight(key);
  return weight * unitW + KB_KEY_GAP * (weight - 1);
}

function keyLabel(key) {
  return typeof key === "string" ? key : key.label;
}

function keyAction(key) {
  if (typeof key === "string") {
    return { type: "kbKey", char: key };
  }
  return key.action;
}

// Apply a keyboard action to a text buffer, returning the next text. Callers
// handle kbDone/kbCancel themselves (they route/close); this only mutates text
// for kbKey and kbBackspace.
function applyKeyAction(text, action) {
  if (!action) {
    return text;
  }
  if (action.type === "kbKey") {
    return `${text}${action.char}`;
  }
  if (action.type === "kbBackspace") {
    return text.slice(0, -1);
  }
  return text;
}

export { drawKeyboard, applyKeyAction };
