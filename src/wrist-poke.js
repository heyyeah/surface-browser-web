// Poke selection for the wrist panels. Pure and dependency-free (no three, no
// DOM) so the parts a device pass cannot prove by hand are testable offline: which
// button a fingertip is nearest, and that one push fires exactly once.
//
// Frames: buttons are laid out the way UI normally is (origin at the panel's
// top-left, y DOWN, metres) but hit-tested in the quad's local frame (origin at
// the quad CENTRE, +x right, +y UP, +z out of the face), which is where a
// fingertip lands after Object3D.worldToLocal(). `layoutRectToLocalRect()` is the
// single place the two conventions meet.
//
// Depth: every target is scored by
//     approach = hypot(lateral, max(depth, 0))
// where `lateral` is the in-plane distance to the rect (zero anywhere over its
// face) and `depth` is the signed distance out of the face. Clamping negative
// depth to zero is load-bearing: a fingertip that has punched THROUGH the panel
// keeps scoring ~0 against that button, so it stays latched instead of reading as
// "retreated" out the back and firing a second time on the way home.

function clamp(value, min, max) {
  return value < min ? min : (value > max ? max : value);
}

// Layout rect { x, y, w, h } (top-left origin, y down) -> local rect (centre
// origin, y up). Sizes are unchanged; only the corner moves.
function layoutRectToLocalRect(rect, { widthM, heightM }) {
  return {
    x: rect.x - (widthM / 2),
    y: (heightM / 2) - (rect.y + rect.h),
    w: rect.w,
    h: rect.h
  };
}

// Nearest target to a fingertip already expressed in the quad's local frame.
// Returns { index: -1, approachM: Infinity } when there is nothing to hit.
function nearestPokeTarget(point, rects) {
  let index = -1;
  let approachM = Infinity;
  const depth = Math.max(point.z, 0);
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    const dx = point.x - clamp(point.x, rect.x, rect.x + rect.w);
    const dy = point.y - clamp(point.y, rect.y, rect.y + rect.h);
    const approach = Math.sqrt((dx * dx) + (dy * dy) + (depth * depth));
    if (approach < approachM) {
      approachM = approach;
      index = i;
    }
  }
  return { index, approachM };
}

// `pressed` starts true for a launcher that has just appeared: whatever the finger
// is doing at that instant must not count as a press, and the retreat rule below
// is the "let go first" the situation calls for.
function createWristPokeState(pressed = false) {
  return { pressed: Boolean(pressed), hoverIndex: -1, activatedIndex: -1 };
}

// Returns the NEXT state; never mutates `prev`. `activatedIndex` is an EDGE: it
// names a target on the single frame the poke lands and is -1 on every other.
//   tracked         — the free hand reported a usable fingertip this frame
//   index/approachM — nearestPokeTarget() for that fingertip
//   hoverRadiusM    — proximity highlight distance (no activation)
//   activateRadiusM — contact distance; crossing it inward fires once
//   releaseRadiusM  — retreat distance that re-arms (> activateRadiusM)
function updateWristPokeState(prev, {
  tracked,
  index,
  approachM,
  hoverRadiusM,
  activateRadiusM,
  releaseRadiusM
}) {
  if (!tracked || index < 0) {
    // No fingertip this frame: nothing hovers and nothing fires, but the press latch
    // is KEPT. Hand tracking drops frames constantly, and a blip must not re-arm a
    // finger that never retreated.
    return { pressed: prev.pressed, hoverIndex: -1, activatedIndex: -1 };
  }

  let pressed = prev.pressed;
  if (pressed && approachM > releaseRadiusM) {
    pressed = false;
  }

  let activatedIndex = -1;
  if (!pressed && approachM <= activateRadiusM) {
    pressed = true;
    activatedIndex = index;
  }

  return {
    pressed,
    hoverIndex: approachM <= hoverRadiusM ? index : -1,
    activatedIndex
  };
}

// What a poke on a launcher SECTION means, now that the launcher can be summoned
// over an already-open world panel. Pure and separate because it decides whether
// the world panel is re-anchored; a wrong answer makes the panel jump in front of
// the user on every poke.
//   mainPanelOpen  the world panel is open and showing its MAIN content (not the
//                  help view, not the idle start panel)
//   sectionActive  the panel is currently ON this section's mode, i.e. the row the
//                  panel draws the close glyph on
// Returns "promote" (nothing open, or help/idle is up: open the main panel on this
// mode), "switch" (the panel is open on a DIFFERENT mode: change it in place, no
// re-anchor) or "close" (this row's own mode is showing: hide it).
//
// Close-on-repoke must stay: the active row draws a close glyph, and a glyph that
// does not close is a lie. Both halves key off the same pair of facts (panel open
// AND showing this mode) that wristui.js's `open` draw treatment uses, so the
// glyph and the behaviour cannot disagree. "Unselect" needs no app-state change:
// with the panel hidden, mainPanelOpen is false and no row draws the glyph.
function resolveSectionPoke({ mainPanelOpen, sectionActive }) {
  if (!mainPanelOpen) {
    return "promote";
  }
  return sectionActive ? "close" : "switch";
}

// The ORDER lives here, not in wristui.js, because the row index IS the poke
// target index and three things key off it: the draw loop, the outcome resolver
// below, and the exit hold's `holdIndex`. wristui.js owns how each row LOOKS but
// derives its table from this list so the two cannot disagree.
//
// Capture is on this panel (not Settings) because screen capture can only be
// performed in VR and otherwise had no hands path.
const WRIST_SYSTEM_ROW_IDS = Object.freeze(["help", "capture", "exit"]);
// Exit VR is the ONLY hold-to-activate row in the hand UI. Capture is a single
// poke with no countdown (the hands and UI are hidden from the render instead; see
// capture-hide.js).
const WRIST_SYSTEM_HOLD_ROW_ID = "exit";

// The one place a poked row is turned into a NAMED OUTCOME. Every branch of
// wristui.js's activateTarget() reads from this, and so does the `outcome` field
// of the `wristpoke` diagnostic, so a device log cannot describe a decision the
// code did not make.
//
// The do-nothing outcomes are named rather than collapsed because on device they
// are different bugs: "no-item" is a row index with no row behind it, "disabled" is
// the GenAI server gate, "hold-row" is Exit VR correctly refusing a single poke,
// and "unhandled" is a row added to the table above without a branch here.
function resolveWristPokeOutcome(item, { role, mainPanelOpen, helpOpen } = {}) {
  if (!item) {
    return "no-item";
  }
  if (!item.enabled) {
    return "disabled";
  }
  if (item.hold) {
    return "hold-row";
  }
  if (role === "content") {
    // `item.active` is vrpanel's own "this is the active mode" flag, carried
    // through launcherSections() — the same one the ✕ is drawn from.
    return resolveSectionPoke({ mainPanelOpen, sectionActive: Boolean(item.active) });
  }
  if (item.id === "help") {
    // The help row is a toggle: a row that draws a close glyph when help is open
    // (wristui.js reads the same `helpOpen`) and then ignores the poke is worse than
    // either rule. Symmetric with the content rows (resolveSectionPoke -> "close").
    return helpOpen ? "help-close" : "help";
  }
  if (item.id === "capture") {
    return item.id;
  }
  return "unhandled";
}

// Which hand wears the CONTENT panel (see resolveWristPanelRole() below). Pure and
// here rather than in wristui.js because input.js also resolves the pinch that
// drives Select from it. wristui.js re-exports these; nothing else should reach
// for them directly.
const WRIST_PANEL_HANDS = ["left", "right"];
const DEFAULT_WRIST_PANEL_HAND = "left";

// Returns "left"/"right" for anything recognisable, else null; the null lets
// setWristPanelHand() fall through override -> server value -> default.
function normalizeWristPanelHand(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return WRIST_PANEL_HANDS.includes(candidate) ? candidate : null;
}

function resolveWristPanelHand(value) {
  return normalizeWristPanelHand(value) || DEFAULT_WRIST_PANEL_HAND;
}

// The hand OPPOSITE the content panel: it pokes that panel, and its pinch is the
// one that selects. Anything unrecognisable resolves through the default. The name
// is historical (both hands wear a panel and both poke the other one), but it
// still names the same hand and input.js resolves Select from it.
function resolveFreeHand(value) {
  return resolveWristPanelHand(value) === "left" ? "right" : "left";
}

// With BOTH wrists occupied, `wristPanelHand` is a MIRROR flag: which wrist
// carries the CONTENT panel (Web / Image / GenAI). The other wrist carries the
// SYSTEM panel (Help / Capture / Exit VR). The default, "left", puts content left
// and system right; flipping the setting mirrors the pair.
function resolveWristPanelRole(handedness, wristPanelHandValue) {
  return handedness === resolveWristPanelHand(wristPanelHandValue) ? "content" : "system";
}

// A controller ray may select a wrist panel only while that panel is SUMMONED, and
// only from the OTHER arm. Both halves are load-bearing and fail invisibly: a
// hidden quad left in the cast would absorb picks meant for the world panel or the
// sphere, and a panel reachable from its own arm would let the aiming hand eat its
// own view. The second half is also the poke rule ("you poke with the other
// hand"), so both input routes agree about whose panel is whose.
//
// Do not relax it for rays: the panel is rigid to the controller, so aiming that
// controller at it moves the target with the aim (an unstable self-latch, only
// reachable by pointing back at your own face). The other arm is the only stable
// way in.
function isWristRaySelectable({ visible, handedness } = {}, rayHandedness) {
  return Boolean(visible) && handedness !== rayHandedness;
}

// Hold-to-activate for Exit VR. A poke is a single contact edge, the wrong shape
// for "Exit VR": a stray fingertip must not end the session. This reproduces the
// controller contract (hold right B for XR_EXIT_HOLD_SECONDS behind a progress
// ring, input.js) with a fingertip, and gives hand-tracking users an in-app exit.
//
// A separate machine from updateWristPokeState(): that latch fires on the way IN
// and then stops caring, while a hold keeps watching one contact for over a second
// and abandons it the moment it breaks.
function createWristHoldState() {
  return { elapsedS: 0, fired: false, holding: false, progress: 0 };
}

// Returns the NEXT state; never mutates `prev`. `fired` latches true on the frame
// the hold completes and stays true until the finger leaves, so a caller reads a
// rising edge by comparing with the previous frame's `fired`.
//   tracked        a fingertip was reported this frame
//   index          nearestPokeTarget()'s target, or -1
//   approachM      its approach distance
//   holdIndex      the hold-to-activate target (-1 = none on screen)
//   contactRadiusM inside this, the timer runs (the radius a poke fires at)
//   releaseRadiusM outside this, the hold is abandoned and the timer resets. The
//                  band between the radii neither advances nor resets: a fingertip
//                  held against a target at 30 Hz jitters by millimetres, and
//                  resetting on every wobble would make the hold impossible.
//   dtS            frame delta, seconds
//   holdSeconds    total hold required
function updateWristHoldState(prev, {
  tracked,
  index,
  approachM,
  holdIndex,
  contactRadiusM,
  releaseRadiusM,
  dtS,
  holdSeconds
}) {
  if (holdIndex < 0) {
    return createWristHoldState();
  }
  if (!tracked) {
    // Same dropout rule as the poke latch: a tracking blip is not a withdrawal. Freeze
    // rather than reset, but do not advance either, or a hand that vanished mid-hold
    // would end the session by itself.
    return { ...prev, holding: false };
  }
  if (index !== holdIndex || approachM > releaseRadiusM) {
    return createWristHoldState();
  }
  if (approachM > contactRadiusM) {
    return { ...prev, holding: false };
  }

  const elapsedS = prev.fired ? prev.elapsedS : prev.elapsedS + Math.max(dtS, 0);
  const progress = holdSeconds > 0 ? Math.min(1, elapsedS / holdSeconds) : 1;
  return {
    elapsedS,
    fired: prev.fired || progress >= 1,
    holding: true,
    progress
  };
}

// A hold that was started and then abandoned before completing: the cue to tell
// the user "that one needs a hold".
function wristHoldAborted(prev, next) {
  return prev.elapsedS > 0 && !prev.fired && next.elapsedS === 0;
}

// Freeze-on-approach: while a finger travels toward a target the target must stop
// moving, or it chases the finger. So the panel's pose is pinned, the label tier
// is pinned with it (resolveWristLabelMode below), the summon machine is told the
// panel is still tracked (poking your own wrist is the most self-occluding pose
// hand tracking has), and input.js swallows the sphere-select meanwhile.
//
// The freeze must also end when it is no longer ABOUT anything, not only when the
// poking finger retreats. Otherwise: pin the panel with a poke, lower or turn away
// the WEARING arm, leave the poking hand where it was, and the panel hovers at a
// stale world pose, kept alive by its own freeze (`tracked: panel.approachFrozen`).
// Releases, ordered "is this freeze still about anything?" before "has the finger
// left?":
//   anchor-drift  the wearing hand is posed and the pose its panel WOULD have now
//                 is further than `maxAnchorDriftM` from the frozen quad.
//   hand-lost     the wearing hand has been untracked longer than the
//                 self-occlusion grace. Short dropouts still hold.
//   watchdog      a backstop; no legitimate approach lasts this long.
// A release for any of those sets `rearmRequired`: the finger must leave the
// release radius before another freeze can latch, so a persisting condition cannot
// re-freeze on the next frame.
//
// Occlusion: the panel is frozen at a pose the wearing hand has since moved IN
// FRONT OF, so the user sees the back of their own hand. The wrist is still within
// the anchor budget, the hand is tracked, and the finger is inside the release
// radius, so none of the above fire.
//
// The test is a cylinder around the head->quad ray. The hand occludes the panel
// when it is (a) NEARER the head than the quad by more than `minDepthM`, along
// that ray, and (b) within `maxRadiusM` of it laterally. Both terms are needed:
// the hand is always within a few centimetres of its own panel, so proximity alone
// would fire constantly.
//
// Plain {x, y, z}.
//   head  the viewer's eye position
//   hand  the WEARING hand's wrist (the rendered model is centred on the hand, so
//         `maxRadiusM` is sized for a hand, not a joint)
//   quad  the frozen panel's centre
function isOwnerOccludingPanel(head, hand, quad, { minDepthM, maxRadiusM }) {
  const rx = quad.x - head.x;
  const ry = quad.y - head.y;
  const rz = quad.z - head.z;
  const rLenSq = (rx * rx) + (ry * ry) + (rz * rz);
  if (!(rLenSq > 1e-8)) {
    return false;
  }
  const hx = hand.x - head.x;
  const hy = hand.y - head.y;
  const hz = hand.z - head.z;
  // Where the hand projects onto the head->quad ray, as a fraction of the way there.
  // Behind the head (< 0) or past the panel (>= 1) is not in front of it.
  const t = ((hx * rx) + (hy * ry) + (hz * rz)) / rLenSq;
  if (t <= 0) {
    return false;
  }
  const rLen = Math.sqrt(rLenSq);
  if ((1 - t) * rLen < minDepthM) {
    return false;
  }
  // Perpendicular distance from the hand to that ray.
  const px = hx - (t * rx);
  const py = hy - (t * ry);
  const pz = hz - (t * rz);
  return Math.sqrt((px * px) + (py * py) + (pz * pz)) <= maxRadiusM;
}

function createWristFreezeState() {
  return { frozen: false, sinceMs: null, rearmRequired: false, reason: null };
}

// Returns the NEXT state; never mutates `prev`. `reason` is an EDGE, naming the
// release on the single frame it happens (null otherwise), so the caller can log
// it.
//   panelVisible    the panel was on screen last frame (a never-placed quad at the
//                   origin must never freeze)
//   quadPlaced      its quad exists and has been anchored at least once
//   pokerTracked    the OTHER hand reported a usable fingertip this frame
//   approachM       fingertip -> frozen quad position
//   ownerPosed      the wearing hand has a usable wrist pose this frame
//   ownerDriftM     where the panel would sit now -> the frozen quad (ignored
//                   unless ownerPosed)
//   ownerLostMs     how long the wearing hand has been untracked (0 if tracked)
//   heldMs          nowMs, against `prev.sinceMs`, for the watchdog
//   ownerOccluding  isOwnerOccludingPanel(): the wearing hand is between the head
//                   and the frozen quad
//   pokeCommitted   the poking fingertip has arrived (inside the hover band, or
//                   the press latch is down, or a hold is running)
//
// Unlike the other releases, the occlusion release is GATED by `pokeCommitted`.
// Those describe an abandoned panel; this one can be true while an ordinary poke
// is a centimetre from landing (a hand rolling slightly can get in front of its
// own panel without stranding it). Moving the target in that last centimetre is
// the failure freeze-on-approach exists to prevent, so the release fires only
// while the finger is still on approach; once in the hover band the occlusion is
// tolerated.
function updateWristFreezeState(prev, {
  panelVisible,
  quadPlaced,
  pokerTracked,
  approachM,
  enterRadiusM,
  releaseRadiusM,
  ownerPosed,
  ownerDriftM,
  maxAnchorDriftM,
  ownerLostMs,
  ownerLostGraceMs,
  nowMs,
  maxHoldMs,
  ownerOccluding = false,
  pokeCommitted = false
}) {
  if (!panelVisible || !quadPlaced || !pokerTracked) {
    // No panel or no finger: nothing to pin and nothing latched. The re-arm goes too.
    return createWristFreezeState();
  }

  if (prev.frozen) {
    let reason = null;
    if (ownerPosed && ownerDriftM > maxAnchorDriftM) {
      reason = "anchor-drift";
    } else if (!ownerPosed && ownerLostMs > ownerLostGraceMs) {
      reason = "hand-lost";
    } else if (ownerPosed && ownerOccluding && !pokeCommitted) {
      reason = "occluded";
    } else if (maxHoldMs > 0 && prev.sinceMs !== null && (nowMs - prev.sinceMs) >= maxHoldMs) {
      reason = "watchdog";
    } else if (approachM > releaseRadiusM) {
      reason = "retreat";
    }
    if (!reason) {
      return { frozen: true, sinceMs: prev.sinceMs, rearmRequired: false, reason: null };
    }
    return {
      frozen: false,
      sinceMs: null,
      rearmRequired: reason !== "retreat",
      reason
    };
  }

  if (prev.rearmRequired) {
    return {
      frozen: false,
      sinceMs: null,
      rearmRequired: approachM <= releaseRadiusM,
      reason: null
    };
  }

  if (approachM <= enterRadiusM) {
    return { frozen: true, sinceMs: nowMs, rearmRequired: false, reason: null };
  }
  return { frozen: false, sinceMs: null, rearmRequired: false, reason: null };
}

// Label mode: tier 2 of the summon rule. Minimal near the wrist whenever the hand
// is in view, expanding on gaze. Gaze is self-triggered and happens before a
// reach, unlike a trigger on the other hand arriving, which is exactly when a
// finger starts travelling toward a target and would grow targets mid-reach.
//
// `gazeFocused` is the narrow-cone tier from wrist-summon.js, already run through
// the sustain/hysteresis machine, so it cannot strobe. `frozen` is
// freeze-on-approach and governs the label tier as well as the pose: once an
// approach is underway the mode is pinned, so a panel never collapses from labels
// to icons under a mid-poke finger (looking down at your own finger breaks the
// gaze cone). `pinned` is `?wristlabels=1`, an A/B flag.
// `worldMenuGaze`: the world panel is open AND the user's gaze is on it, measured
// in wristui.js with the same withinCone() the summon tiers use, so there is one
// notion of "looking at".
//
// Precedence, decided here:
//   1. pinned        labels, always: an A/B that quietly stops holding is not one.
//                    (A frozen panel under the pin has `prev === "labels"` anyway,
//                    but pinned-first is right even on the first frame.)
//   2. frozen        the tier stays what it was. The collapse MUST lose to this, or
//                    opening the world menu would shrink a row out from under a
//                    finger already travelling toward it.
//   3. worldMenuGaze reading the world menu: get out of the way.
//   4. gazeFocused   the ordinary tier-2 rule.
const WRIST_LABEL_MODES = ["icons", "labels"];

function resolveWristLabelMode(prev, { pinned, gazeFocused, frozen, worldMenuGaze = false }) {
  if (pinned) {
    return "labels";
  }
  if (frozen) {
    return WRIST_LABEL_MODES.includes(prev) ? prev : "icons";
  }
  if (worldMenuGaze) {
    return "icons";
  }
  return gazeFocused ? "labels" : "icons";
}

export {
  layoutRectToLocalRect,
  nearestPokeTarget,
  createWristPokeState,
  updateWristPokeState,
  resolveSectionPoke,
  resolveWristPokeOutcome,
  isWristRaySelectable,
  WRIST_SYSTEM_ROW_IDS,
  WRIST_SYSTEM_HOLD_ROW_ID,
  createWristHoldState,
  updateWristHoldState,
  wristHoldAborted,
  createWristFreezeState,
  updateWristFreezeState,
  isOwnerOccludingPanel,
  resolveWristLabelMode,
  resolveWristPanelRole,
  WRIST_LABEL_MODES,
  WRIST_PANEL_HANDS,
  DEFAULT_WRIST_PANEL_HAND,
  normalizeWristPanelHand,
  resolveWristPanelHand,
  resolveFreeHand
};
