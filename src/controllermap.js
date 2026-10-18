// Controller map diagram for the flat-mode Help menu: an inline SVG of the two
// Quest Touch controllers with numbered markers, plus a two-column HTML legend.
// Long labels live in the legend, not in SVG text, so nothing clips at narrow widths.
//
// Line art: Meta Quest Touch Plus developer art pack (Meta's first-party controller
// art, provided for depicting the controllers in apps), converted to SVG and reduced
// to outline strokes; recolored via the .cm-art class. Path coordinates are baked into
// display space; markers sit at the real button positions read from the art.
import { CAPTURE_CONTROL_ENABLED } from "./config.js";
import { t } from "./i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Combined outline path (both controllers) in art-space units. A single <path>
// with all subpaths — they share one stroke, so no per-shape overhead.
const ART_PATH =
  "M222,257 C267,274 320,276 390,228 C430,200 456,163 476,127 " +
  "M340,285 C356,304 317,308 294,314 C277,319 244,321 242,348 C240,373 257,378 257,378 " +
  "M395,237 C385,257 374,271 362,277 C339,287 300,297 234,307 C198,313 205,355 222,367 " +
  "C240,379 269,382 302,377 C335,371 335,352 335,352 C335,352 339,315 342,299 C343,298 343,296 343,295 " +
  "M269,60 C240,80 211,107 187,141 L184,146 C184,146 167,173 158,207 C123,335 0,536 130,593 " +
  "C209,627 255,547 287,471 C309,418 323,369 323,369 " +
  "M358,279 C363,277 437,259 447,255 C451,254 456,252 459,249 C462,246 464,241 467,235 " +
  "C472,219 499,138 500,131 C504,108 504,81 503,76 C502,65 501,29 471,15 C443,0 375,4 306,39 " +
  "M501,129 C501,129 510,194 510,201 C509,211 500,216 469,228 " +
  "M321,66 C328,64 334,65 336,68 C340,74 330,87 315,96 C300,105 285,108 281,102 C279,99 281,93 286,88 " +
  "M322,66 C325,72 320,81 310,87 C300,93 290,93 286,88 " +
  "M324,46 C329,55 322,71 306,81 C290,90 273,90 267,81 C261,71 269,55 284,46 C300,36 318,36 324,46 Z " +
  "M312,42 C315,48 308,58 296,65 C285,73 272,74 269,69 C266,63 272,53 284,46 C296,38 309,37 312,42 Z " +
  "M768,66 C760,64 754,65 752,68 C749,74 758,87 773,96 C788,105 804,108 807,102 C809,99 807,93 802,88 " +
  "M767,66 C763,72 769,81 778,87 C788,93 799,93 802,88 " +
  "M765,46 C759,55 767,71 782,81 C798,90 816,90 822,81 C827,71 820,55 804,46 C788,36 771,36 765,46 Z " +
  "M776,42 C773,48 780,58 792,65 C804,73 816,74 819,69 C823,63 816,53 804,46 C792,38 780,37 776,42 Z " +
  "M493,35 C496,41 505,92 478,143 C449,198 395,237 395,237 C395,237 356,270 295,276 C234,282 192,255 192,255 " +
  "C192,255 142,228 175,162 " +
  "M95,568 C95,568 72,543 87,469 C100,405 173,237 173,237 " +
  "M866,257 C822,274 769,276 699,228 C658,200 633,163 612,127 " +
  "M748,285 C733,304 771,308 794,314 C812,319 844,321 846,348 C848,373 831,378 831,378 " +
  "M694,237 C703,257 714,271 727,277 C750,287 788,297 855,307 C890,313 884,355 866,367 " +
  "C849,379 820,382 787,377 C753,371 753,352 753,352 C753,352 749,315 746,299 C746,298 745,296 745,295 " +
  "M819,60 C848,80 877,107 902,141 L905,146 C905,146 921,173 931,207 C966,335 1088,536 958,593 " +
  "C880,627 833,547 802,471 C779,418 765,369 765,369 " +
  "M731,279 C725,277 652,259 642,255 C637,254 633,252 629,249 C627,246 624,241 622,235 " +
  "C617,219 589,138 588,131 C584,108 584,81 585,76 C586,65 587,29 618,15 C646,0 713,4 783,39 " +
  "M587,129 C587,129 578,194 579,201 C579,211 588,216 620,228 " +
  "M595,35 C593,41 583,92 610,143 C640,198 693,237 693,237 C693,237 733,270 793,276 C854,282 897,255 897,255 " +
  "C897,255 947,228 913,162 " +
  "M993,568 C993,568 1017,543 1002,469 C989,405 915,237 915,237";

// Art-space viewBox: outline bbox is x[0..1088] y[0..627]; extra headroom on
// top (negative y) for the LEFT / RIGHT headers.
const VIEWBOX = "0 -95 1088 722";

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

// Numbered marker dot at an art-space point.
function marker(container, x, y, n) {
  container.appendChild(el("circle", { cx: x, cy: y, r: 24, class: "cm-marker" }));
  container.appendChild(
    el("text", { x, y: y + 9, "text-anchor": "middle", class: "cm-marker-num" }, String(n))
  );
}

// Marker positions in ART SPACE, read from the official art's real buttons.
// Order matches the legend: 1 X/A, 2 Y/B, 3 Stick, 4 Trigger, 5 Grip. Trigger
// before Grip is also top-to-bottom on the art, so the leader lines never cross.
const LEFT_MARKERS = [
  [278, 144], // 1 X   (lower-mid face button)
  [359, 106], // 2 Y   (upper-right face button)
  [299, 68],  // 3 Stick (thumbstick cap)
  [371, 211], // 4 Trigger (front, under the ring)
  [271, 341]  // 5 Grip (inner-side grip bump)
];
const RIGHT_MARKERS = [
  [810, 144], // 1 A
  [730, 106], // 2 B
  [791, 68],  // 3 Stick
  [718, 211], // 4 Trigger
  [818, 341]  // 5 Grip
];

// One wording for the desktop legend and the in-headset diagram. The right
// stick press (jump to sphere) is left out on purpose, like on the callouts.
function leftLegend(captureEnabled) {
  return [
    ["X", t("act.menuPanel")],
    ["Y", captureEnabled ? t("callout.screenshot") : t("act.helpPanel")],
    [t("vr.map.stick"), t("vr.map.stickLeft")],
    [t("vrhelp.trigger"), t("vr.map.trigger")],
    [t("vr.map.grip"), t("vr.map.gripLeft")]
  ];
}
function rightLegend() {
  return [
    ["A", t("act.helpPanel")],
    ["B", t("vrhelp.holdExitVr")],
    [t("vr.map.stick"), t("vr.map.stickRight")],
    [t("vrhelp.trigger"), t("vr.map.trigger")],
    [t("vr.map.grip"), t("vr.map.gripRight")]
  ];
}

function calloutLabels(side, captureEnabled) {
  const legend = side === "left" ? leftLegend(captureEnabled) : rightLegend();
  return legend.map(([key, text]) => `${key} · ${text}`);
}

// Canvas counterpart for the in-world Help panel. Same outline and marker
// coordinates as createControllerMap() below, but with direct callouts instead of
// a numbered legend, which is hard to cross-reference at a distance.
export function drawControllerMapCanvas(ctx, {
  x, y, width, height, side = "both", captureEnabled = CAPTURE_CONTROL_ENABLED
}) {
  if (side === "left" || side === "right") {
    drawSingleControllerCanvas(ctx, { x, y, width, height, side, captureEnabled });
    return;
  }
  const artHeight = Math.max(120, Math.min(height, width * (722 / 1088)));
  const scale = Math.min(width / 1088, artHeight / 722);
  const artWidth = 1088 * scale;
  const artX = x + ((width - artWidth) / 2);
  // VIEWBOX starts at y=-95, so shift the art-space origin down by 95 units.
  const artY = y + ((height - (722 * scale)) / 2) + (95 * scale);

  ctx.save();
  ctx.translate(artX, artY);
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#8ea1c2";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D(ART_PATH));

  ctx.fillStyle = "#8ea1c2";
  ctx.font = "600 42px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(t("vr.map.left"), 279, -45);
  ctx.fillText(t("vr.map.right"), 809, -45);
  ctx.restore();

  const labelWidth = Math.max(120, (width - artWidth) / 2 - 12);
  drawCanvasControllerCallouts(ctx, {
    x, y, width, height, artX, artY, scale,
    markers: LEFT_MARKERS,
    labels: calloutLabels("left", captureEnabled),
    labelWidth,
    align: "left"
  });
  drawCanvasControllerCallouts(ctx, {
    x, y, width, height, artX, artY, scale,
    markers: RIGHT_MARKERS,
    labels: calloutLabels("right", captureEnabled),
    labelWidth,
    align: "right"
  });
}

function drawSingleControllerCanvas(ctx, { x, y, width, height, side, captureEnabled = false }) {
  const minX = side === "left" ? 0 : 578;
  const maxX = side === "left" ? 510 : 1088;
  const headerX = side === "left" ? 279 : 809;
  const markers = side === "left" ? LEFT_MARKERS : RIGHT_MARKERS;
  const labels = calloutLabels(side, captureEnabled);
  const labelColumnWidth = Math.min(330, width * 0.36);
  const gap = 22;
  const artWidth = maxX - minX;
  const artHeight = Math.max(120, Math.min(height, width * (722 / artWidth)));
  const scale = Math.min((width - labelColumnWidth - gap) / artWidth, artHeight / 722);
  const scaledArtWidth = artWidth * scale;
  const artX = side === "left"
    ? x + labelColumnWidth + gap
    : x + width - labelColumnWidth - gap - scaledArtWidth;
  const artY = y + ((height - (722 * scale)) / 2) + (95 * scale);

  ctx.save();
  ctx.beginPath();
  ctx.rect(artX, y, scaledArtWidth, height);
  ctx.clip();
  ctx.translate(artX - minX * scale, artY);
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#8ea1c2";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D(ART_PATH));
  ctx.fillStyle = "#8ea1c2";
  ctx.font = "600 42px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(t(side === "left" ? "vr.map.left" : "vr.map.right"), headerX, -45);
  ctx.restore();

  drawCanvasControllerCallouts(ctx, {
    x,
    y,
    width,
    height,
    artX,
    artY,
    scale,
    markerOriginX: minX,
    markers,
    labels,
    labelWidth: labelColumnWidth,
    align: side === "left" ? "left" : "right"
  });
}

// Greedy word wrap to `maxWidth` at the current font.
function wrapLabel(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

function drawCanvasControllerCallouts(ctx, {
  x,
  y,
  width,
  height,
  artX,
  artY,
  scale,
  markerOriginX = 0,
  markers,
  labels,
  labelWidth,
  align
}) {
  const labelX = align === "left" ? x + 4 : x + width - 4;
  const top = y + 28;
  const bottom = y + height - 24;
  const rowGap = (bottom - top) / (labels.length - 1);
  const lineHeight = 19;

  ctx.save();
  ctx.font = "600 16px 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  for (let i = 0; i < labels.length; i += 1) {
    const [markerX, markerY] = markers[i];
    const pointX = artX + (markerX - markerOriginX) * scale;
    const pointY = artY + markerY * scale;
    const labelY = top + i * rowGap;
    const lines = wrapLabel(ctx, labels[i], labelWidth);
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const lineEndX = align === "left"
      ? labelX + textWidth + 8
      : labelX - textWidth - 8;

    ctx.strokeStyle = "#53a9ff99";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pointX, pointY);
    ctx.lineTo(lineEndX, labelY);
    ctx.stroke();

    ctx.fillStyle = "#53a9ff";
    ctx.beginPath();
    ctx.arc(pointX, pointY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#dbe6ff";
    // Centred on the leader line's end.
    const firstY = labelY - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, n) => ctx.fillText(line, labelX, firstY + n * lineHeight));
  }
  ctx.restore();
}

function legendColumn(title, items) {
  const col = document.createElement("div");
  col.className = "cm-legend-col";
  const head = document.createElement("div");
  head.className = "cm-legend-head";
  head.textContent = title;
  col.appendChild(head);
  items.forEach(([key, label], i) => {
    const row = document.createElement("div");
    row.className = "cm-legend-row";
    const num = document.createElement("span");
    num.className = "cm-legend-num";
    num.textContent = String(i + 1);
    row.appendChild(num);
    const keySpan = document.createElement("span");
    keySpan.className = "cm-legend-key";
    keySpan.textContent = key;
    row.appendChild(keySpan);
    const labelSpan = document.createElement("span");
    labelSpan.className = "cm-legend-label";
    labelSpan.textContent = label;
    row.appendChild(labelSpan);
    col.appendChild(row);
  });
  return col;
}

/**
 * Build the controller-map diagram element: the official Quest Touch Plus line
 * art with numbered markers on the real buttons, plus a two-column HTML legend.
 * @returns {HTMLDivElement}
 */
export function createControllerMap() {
  const wrap = document.createElement("div");
  wrap.className = "controller-map";

  const svg = el("svg", {
    viewBox: VIEWBOX,
    class: "controller-map-svg",
    role: "img",
    "aria-label": t("vr.map.aria")
  });

  // Controller line art (both controllers), recolored via the .cm-art class.
  svg.appendChild(el("path", { d: ART_PATH, class: "cm-art" }));

  // LEFT / RIGHT headers, centered over each controller (art-space x).
  svg.appendChild(el("text", { x: 279, y: -45, "text-anchor": "middle", class: "cm-head" }, t("vr.map.left")));
  svg.appendChild(el("text", { x: 809, y: -45, "text-anchor": "middle", class: "cm-head" }, t("vr.map.right")));

  LEFT_MARKERS.forEach(([x, y], i) => marker(svg, x, y, i + 1));
  RIGHT_MARKERS.forEach(([x, y], i) => marker(svg, x, y, i + 1));

  wrap.appendChild(svg);

  const legend = document.createElement("div");
  legend.className = "cm-legend";
  legend.appendChild(legendColumn(t("vr.help.switch.leftController"), leftLegend(CAPTURE_CONTROL_ENABLED)));
  legend.appendChild(legendColumn(t("vr.help.switch.rightController"), rightLegend()));
  wrap.appendChild(legend);

  return wrap;
}
