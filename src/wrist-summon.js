// Summon state machine for the wrist-anchored UI. Pure and dependency-free (no
// three, no DOM) so it is unit-testable offline; the pose math needs a live XR
// session, this part does not.
//
// The rule is two tiers off ONE measurement, the angle between head-forward and
// the head->hand direction:
//   Tier 1 (inView, ~50 deg): the hand is roughly in front of the user. The panel
//     appears, icons only. There is no palm term: an in-view hand shows its panel
//     whichever way the wrist is rolled. (A palm-facing factor was trivially true
//     with the jointless grip fallback and began to bite once real joints
//     arrived, so panels were rarely there.)
//   Tier 2 (focused, ~15 deg): the user is looking AT that wrist. The panel
//     expands in place to icon + text.
//
// Both tiers run the same sustain/hysteresis machine below (one instance each):
// showing requires the factor held for a short while, hiding waits out a longer
// window so one frame of tracking noise, or a glance grazing a cone edge, cannot
// strobe the panel. Losing the hand entirely hides immediately: nothing is left to
// anchor to.

// `null` rather than 0 for the timestamps: performance.now() legitimately returns
// 0 on the first frame, so a falsy check would restart the timer.
function createWristSummonState() {
  return { visible: false, satisfiedSinceMs: null, lostSinceMs: null };
}

// Returns the NEXT state; never mutates `prev`. Generic in `conditionMet` so ONE
// machine serves both tiers: the panel's copy is fed the wide in-view cone, a
// second copy the narrow focus cone.
//   tracked      the panel hand reported a usable wrist pose this frame
//   conditionMet this tier's factor holds now
//   showDelayMs  sustain time before an unseen panel appears
//   hideDelayMs  hysteresis before a visible panel goes away
function updateWristSummonState(prev, {
  tracked,
  conditionMet,
  nowMs,
  showDelayMs,
  hideDelayMs
}) {
  if (!tracked) {
    return createWristSummonState();
  }

  if (conditionMet) {
    const satisfiedSinceMs = prev.satisfiedSinceMs === null ? nowMs : prev.satisfiedSinceMs;
    return {
      visible: prev.visible || (nowMs - satisfiedSinceMs) >= showDelayMs,
      satisfiedSinceMs,
      lostSinceMs: null
    };
  }

  const lostSinceMs = prev.lostSinceMs === null ? nowMs : prev.lostSinceMs;
  return {
    visible: prev.visible && (nowMs - lostSinceMs) < hideDelayMs,
    satisfiedSinceMs: null,
    lostSinceMs
  };
}

// Tier resolution lives here, pure, rather than inline in wristui.js's render
// path, so the rule can be tested without a headset.

// True when a direction sits inside a cone of `maxAngleDeg` about the reference
// direction, given the COSINE of the angle (a dot product of unit vectors, which
// the caller already has). Comparing cosines keeps acos() out of the frame loop.
function withinCone(cosAngle, maxAngleDeg) {
  return cosAngle >= Math.cos((maxAngleDeg * Math.PI) / 180);
}

// Cosine of the angle between `forward` and the direction from `origin` to
// `target`. NaN when the points coincide or `forward` is degenerate; callers treat
// that as "no answer" and withinCone() refuses a NaN, the safe direction for a test
// that grants something.
//
// Plain {x, y, z} rather than Vector3 so the geometry can be checked with a
// calculator; THREE.Vector3 satisfies the shape.
//
// The focus cone is aimed at the PANEL, not the wrist joint: the panel hangs
// several centimetres off the wrist (see WRIST_SUMMON_FOCUS_MAX_ANGLE_DEG in
// wristui.js).
function gazeCosTo(origin, target, forward) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const lenSq = (dx * dx) + (dy * dy) + (dz * dz);
  const fwdSq = (forward.x * forward.x) + (forward.y * forward.y) + (forward.z * forward.z);
  if (lenSq < 1e-12 || fwdSq < 1e-12) {
    return NaN;
  }
  return ((dx * forward.x) + (dy * forward.y) + (dz * forward.z)) / Math.sqrt(lenSq * fwdSq);
}

// resolveWristSummonTier() runs per panel per frame (two panels, 72 Hz); these two
// slots cache the cosines of the two constant angles.
//
// Keyed on the degree VALUE, not the angles object's identity, so a caller that
// mutates its object in place, or a test passing a fresh literal, still gets the
// right answer. The comparison is the same `>=` on the same double Math.cos
// produces, so "exactly on the edge counts as inside" is unchanged.
let _viewConeDeg = NaN;
let _viewConeCos = -1;
let _focusConeDeg = NaN;
let _focusConeCos = -1;

// The two tiers, from the single measurement they share: `gazeCos` is
// dot(headForward, normalize(hand - head)). There is no palm term and nowhere to
// put one: an in-view hand shows its panel however the wrist is rolled.
//
// `focused` is computed independently of `inView`, but with
// focusMaxAngleDeg <= viewMaxAngleDeg the narrow cone is a subset of the wide one,
// so focused implies inView. The test asserts that; the code does not clamp.
//
// `focusGazeCos` defaults to `gazeCos`, but the tiers ask about different objects.
// Tier 1 asks whether the HAND is in front of the user; tier 2 whether the user is
// READING the panel, which is not at the wrist. Pass the panel-centre cosine for
// tier 2 (arithmetic beside the angle in wristui.js).
function resolveWristSummonTier(gazeCos, { viewMaxAngleDeg, focusMaxAngleDeg }, focusGazeCos = gazeCos) {
  if (viewMaxAngleDeg !== _viewConeDeg) {
    _viewConeDeg = viewMaxAngleDeg;
    _viewConeCos = Math.cos((viewMaxAngleDeg * Math.PI) / 180);
  }
  if (focusMaxAngleDeg !== _focusConeDeg) {
    _focusConeDeg = focusMaxAngleDeg;
    _focusConeCos = Math.cos((focusMaxAngleDeg * Math.PI) / 180);
  }
  return {
    inView: gazeCos >= _viewConeCos,
    focused: focusGazeCos >= _focusConeCos
  };
}

export {
  createWristSummonState,
  updateWristSummonState,
  withinCone,
  gazeCosTo,
  resolveWristSummonTier
};
