// The app's one procedural icon set. Canvas 2D only: no images, no fetch, no
// asset tree. One meaning, one drawing: a surface that needs an icon takes it
// from here or adds it here.
//
// Each drawer takes the icon cell's CENTRE and a size in PIXELS, and draws in the
// current strokeStyle/fillStyle. Pure apart from the canvas context it is handed,
// so a caller can rasterise at any density.

function strokeRoundedRectPath(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRoundedRect(ctx, x, y, w, h, radius) {
  strokeRoundedRectPath(ctx, x, y, w, h, radius);
}


// Image search: a magnifier. Circle plus a handle out of the lower right.
function drawMagnifierIcon(ctx, cx, cy, size) {
  const r = size * 0.28;
  const lensX = cx - (size * 0.06);
  const lensY = cy - (size * 0.06);
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(lensX, lensY, r, 0, Math.PI * 2);
  ctx.stroke();
  const start = Math.PI / 4;
  ctx.beginPath();
  ctx.moveTo(lensX + (Math.cos(start) * r), lensY + (Math.sin(start) * r));
  ctx.lineTo(cx + (size * 0.34), cy + (size * 0.34));
  ctx.stroke();
}

// GenAI: the four-point "sparkle" that has become the generative-AI convention,
// with a small companion spark so it reads as more than a plus sign.
function drawSparkIcon(ctx, cx, cy, size) {
  const spark = (x, y, r) => {
    const waist = r * 0.28;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + waist, y - waist, x + r, y);
    ctx.quadraticCurveTo(x + waist, y + waist, x, y + r);
    ctx.quadraticCurveTo(x - waist, y + waist, x - r, y);
    ctx.quadraticCurveTo(x - waist, y - waist, x, y - r);
    ctx.closePath();
    ctx.fill();
  };
  spark(cx - (size * 0.06), cy + (size * 0.04), size * 0.34);
  spark(cx + (size * 0.26), cy - (size * 0.26), size * 0.15);
}

// Help: the question mark, drawn as a glyph; a hand-built path would only be a worse "?".
function drawQuestionIcon(ctx, cx, cy, size) {
  ctx.save();
  ctx.font = `700 ${Math.round(size * 0.95)}px 'Segoe UI', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", cx, cy + (size * 0.02));
  ctx.restore();
}

// Capture: a camera. Body, the viewfinder hump on its top-left shoulder, and a
// lens. Deliberately only three strokes at three scales: the plainest silhouette
// that still reads as a camera rather than a rectangle at icons-only size.
function drawCameraIcon(ctx, cx, cy, size) {
  const bodyW = size * 0.88;
  const bodyH = size * 0.60;
  const left = cx - (bodyW / 2);
  // Nudged down so the hump above it keeps the whole glyph optically centred.
  const top = cy - (bodyH / 2) + (size * 0.07);
  ctx.lineWidth = size * 0.09;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Viewfinder hump: a trapezoid on the body's top edge, left of centre, open at
  // the bottom so it merges into the body outline.
  const humpCx = cx - (size * 0.20);
  const humpTopW = size * 0.22;
  const humpBaseW = size * 0.34;
  const humpH = size * 0.13;
  ctx.beginPath();
  ctx.moveTo(humpCx - (humpBaseW / 2), top);
  ctx.lineTo(humpCx - (humpTopW / 2), top - humpH);
  ctx.lineTo(humpCx + (humpTopW / 2), top - humpH);
  ctx.lineTo(humpCx + (humpBaseW / 2), top);
  ctx.stroke();

  strokeRoundedRectPath(ctx, left, top, bodyW, bodyH, size * 0.11);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, top + (bodyH / 2), size * 0.165, 0, Math.PI * 2);
  ctx.stroke();
}

// Exit VR: a doorway open on the right, with an arrow leaving through it.
function drawExitIcon(ctx, cx, cy, size) {
  const doorW = size * 0.36;
  const doorH = size * 0.72;
  const left = cx - (size * 0.42);
  const top = cy - (doorH / 2);
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(left + doorW, top);
  ctx.lineTo(left, top);
  ctx.lineTo(left, top + doorH);
  ctx.lineTo(left + doorW, top + doorH);
  ctx.stroke();
  const tip = cx + (size * 0.42);
  ctx.beginPath();
  ctx.moveTo(cx - (size * 0.1), cy);
  ctx.lineTo(tip, cy);
  ctx.moveTo(tip - (size * 0.18), cy - (size * 0.18));
  ctx.lineTo(tip, cy);
  ctx.lineTo(tip - (size * 0.18), cy + (size * 0.18));
  ctx.stroke();
}

// Menu: the hamburger. The panel it opens is more than a keyboard (bookmarks,
// modes, toolbar), and a keyboard at this size is a grid of indistinct squares.
function drawMenuIcon(ctx, cx, cy, size) {
  const w = size * 0.74;
  const gap = size * 0.24;
  ctx.lineWidth = size * 0.12;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const dy of [-gap, 0, gap]) {
    ctx.moveTo(cx - (w / 2), cy + dy);
    ctx.lineTo(cx + (w / 2), cy + dy);
  }
  ctx.stroke();
}

// Select: a reticle. Selection is a gaze target that the trigger commits, so the
// picture is crosshairs on a ring, matching the sphere's own selection marker.
function drawSelectIcon(ctx, cx, cy, size) {
  const r = size * 0.30;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const inner = r * 1.25;
  const outer = r * 1.9;
  ctx.beginPath();
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    ctx.moveTo(cx + (dx * inner), cy + (dy * inner));
    ctx.lineTo(cx + (dx * outer), cy + (dy * outer));
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.09, 0, Math.PI * 2);
  ctx.fill();
}


// Pause / resume the sphere's rotation: the transport pause, the only mark in the
// set that says "motion".
function drawPauseIcon(ctx, cx, cy, size) {
  const barW = size * 0.17;
  const barH = size * 0.64;
  const gap = size * 0.14;
  // Round-capped strokes rather than filled rects: at small sizes the caps keep
  // the two bars from reading as one grey smear.
  ctx.lineWidth = barW;
  ctx.lineCap = "round";
  for (const sign of [-1, 1]) {
    const x = cx + (sign * ((gap / 2) + (barW / 2)));
    ctx.beginPath();
    ctx.moveTo(x, cy - (barH / 2) + (barW / 2));
    ctx.lineTo(x, cy + (barH / 2) - (barW / 2));
    ctx.stroke();
  }
}



// Web: a globe (not a chain link, which says "URL"). Meridian, equator and a
// second meridian foreshortened to an ellipse: the fewest strokes that cannot be
// mistaken for a plain circle.
function drawGlobeIcon(ctx, cx, cy, size) {
  const r = size * 0.38;
  ctx.lineWidth = size * 0.09;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.44, r, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.stroke();
}




// Passthrough: a headset seen head-on with a DOTTED outline. A solid goggle is a
// headset, a dashed one is a headset you can see THROUGH, so the dashes are few
// and long to survive the small size.
function drawPassthroughIcon(ctx, cx, cy, size) {
  const w = size * 0.92;
  const h = size * 0.54;
  ctx.save();
  ctx.lineJoin = "round";

  // The goggles, SOLID so the silhouette lands first. The bottom-centre notch is
  // what separates goggles from a pill.
  ctx.lineWidth = size * 0.085;
  ctx.lineCap = "round";
  const x = cx - (w / 2);
  const y = cy - (h / 2);
  const r = h * 0.46;
  const notch = size * 0.1;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.lineTo(cx + notch, y + h);
  ctx.quadraticCurveTo(cx, y + h - notch, cx - notch, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.stroke();

  // The dotted line around it. Few and long, because fine dashes disappear at
  // small sizes. An ellipse rather than a second goggle shape, which reads as a
  // thick smudge.
  ctx.lineWidth = size * 0.06;
  ctx.lineCap = "butt";
  ctx.setLineDash([size * 0.15, size * 0.11]);
  ctx.beginPath();
  ctx.ellipse(cx, cy, w * 0.66, h * 0.98, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Directional glyphs for analogue inputs. An axis is not a button and must never
// be drawn as one.

function drawAxisArrows(ctx, cx, cy, size, directions) {
  const arm = size * 0.52;
  const head = size * 0.2;
  ctx.lineWidth = size * 0.11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [dx, dy] of directions) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (dx * arm), cy + (dy * arm));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + (dx * arm), cy + (dy * arm));
    ctx.lineTo(cx + (dx * arm) - (dx * head) + (dy * head), cy + (dy * arm) - (dy * head) - (dx * head));
    ctx.lineTo(cx + (dx * arm) - (dx * head) - (dy * head), cy + (dy * arm) - (dy * head) + (dx * head));
    ctx.closePath();
    ctx.fill();
  }
}

// Info: a circled lower-case i, drawn rather than typed so it does not depend
// on the font having the ⓘ glyph.
function drawInfoIcon(ctx, cx, cy, size) {
  const r = size * 0.40;
  ctx.lineWidth = size * 0.08;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy - (r * 0.48), size * 0.055, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - (r * 0.12));
  ctx.lineTo(cx, cy + (r * 0.55));
  ctx.stroke();
}

function drawUpDownIcon(ctx, cx, cy, size) {
  drawAxisArrows(ctx, cx, cy, size, [[0, -1], [0, 1]]);
}

function drawFourWayIcon(ctx, cx, cy, size) {
  drawAxisArrows(ctx, cx, cy, size, [[0, -1], [0, 1], [-1, 0], [1, 0]]);
}



const ICON_DRAWERS = Object.freeze({
  globe: drawGlobeIcon,
  magnifier: drawMagnifierIcon,
  spark: drawSparkIcon,
  question: drawQuestionIcon,
  camera: drawCameraIcon,
  exit: drawExitIcon,
  menu: drawMenuIcon,
  select: drawSelectIcon,
  pause: drawPauseIcon,
  passthrough: drawPassthroughIcon,
  info: drawInfoIcon,
  "up-down": drawUpDownIcon,
  "four-way": drawFourWayIcon
});

// What each icon is for, and which surface shows it. Every drawer must have an
// entry here (a test enforces it); scripts/icon_sheet.mjs prints it under each icon.
const ICON_MEANINGS = Object.freeze({
  globe: "Web mode · wrist menu row",
  magnifier: "Image search mode · wrist menu row",
  spark: "GenAI mode · wrist menu row, and the left-grip chord",
  question: "Help · wrist row, and A / X",
  camera: "Capture · wrist row, and X with a token",
  exit: "Exit VR · wrist row, and B held",
  menu: "Menu panel · Y",
  select: "Select · either trigger",
  pause: "Pause / resume rotation · right grip",
  passthrough: "Toggle passthrough · world menu toolbar",
  info: "Show / hide the status footer · world menu toolbar",
  "up-down": "Thumbstick, one axis · speed or zoom",
  "four-way": "Thumbstick, both axes · turn the sphere"
});

function iconMeaning(name) {
  return ICON_MEANINGS[name] || "";
}


// How wide each icon actually DRAWS, as a half-width in units of the `size`
// argument. Measured by rendering at 400 px and alpha-scanning. Centring every
// icon at a constant gap from its label spaces them unevenly ("?" occupies 0.235,
// the camera 0.485), so callers align the icon's EDGE, not its centre.
// Re-measure when an icon's drawing changes.
const ICON_HALF_WIDTH = Object.freeze({
  globe: 0.425,
  magnifier: 0.390,
  spark: 0.407,
  question: 0.235,
  camera: 0.485,
  exit: 0.470,
  menu: 0.430,
  select: 0.620,
  pause: 0.240,
  passthrough: 0.637,
  info: 0.440,
  "up-down": 0.200,
  "four-way": 0.575
});

function iconHalfWidth(name) {
  return ICON_HALF_WIDTH[name] ?? 0.5;
}

function drawIcon(ctx, name, cx, cy, size, color) {
  const drawer = ICON_DRAWERS[name];
  if (!drawer) {
    return false;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  drawer(ctx, cx, cy, size);
  ctx.restore();
  return true;
}

function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICON_DRAWERS, name);
}

export {
  drawIcon,
  hasIcon,
  iconHalfWidth,
  ICON_HALF_WIDTH,
  iconMeaning,
  ICON_MEANINGS,
  drawRoundedRect,
  strokeRoundedRectPath,
  ICON_DRAWERS
};
