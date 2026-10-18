// First-run onboarding inside the sphere.
//
// A visitor in a sphere of images has no hint that it can be turned, thrown,
// zoomed or entered. Rules:
//   * Show the overlay once the visitor has been in a sphere a while without
//     interacting; never again once they have interacted. Merely having seen it
//     does not count, since it has not yet done its job.
//   * Input before it appears means it never appears. Input while it is up
//     leaves a short grace period to finish the line.
//   * Only interaction ends it (no timed hide), so while it is up the caller
//     must also hold the sphere dwell (`decision.holdDwell`).
//   * It never blocks: the caller renders it with pointer-events: none.
//
// Pure. No DOM, no clock, no storage — the caller owns all three.

export const ONBOARDING_DELAY_SECONDS = 4.5;
// Once they start steering the overlay finishes its line, then drops to the last
// row alone on the way out.
export const ONBOARDING_GRACE_SECONDS = 4;
export const ONBOARDING_TAIL_SECONDS = 2.5;

export function createOnboardingState() {
  return { shownForThisSphere: false, hidden: false, interactedAt: null, phase: "hidden" };
}

// `hasInteractedEver` is the persisted flag (storage can fail in a private
// window); `interactedNow` is this frame's live input, so a first interaction
// removes the overlay on that frame, not on the next load.
export function stepOnboarding(prev, {
  inSphere = false,
  elapsedSeconds = 0,
  hasInteractedEver = false,
  interactedNow = false,
  delaySeconds = ONBOARDING_DELAY_SECONDS,
  graceSeconds = ONBOARDING_GRACE_SECONDS,
  tailSeconds = ONBOARDING_TAIL_SECONDS
} = {}) {
  const state = { ...(prev || createOnboardingState()) };

  // Leaving the sphere resets everything; the next sphere is a fresh chance.
  if (!inSphere) {
    return { state: createOnboardingState(), decision: idle(state) };
  }
  if (!state.shownForThisSphere && (hasInteractedEver || interactedNow)) {
    // Interaction before the overlay: nothing to teach, so nothing appears.
    return {
      state: { ...state, hidden: true },
      decision: { visible: false, justShown: false, justHidden: false, holdDwell: false }
    };
  }
  // Interaction while it is up starts the grace countdown instead.
  if (interactedNow && state.interactedAt === null && Number.isFinite(Number(elapsedSeconds))) {
    state.interactedAt = Number(elapsedSeconds);
  }

  const phase = phaseNow(state, {
    elapsedSeconds, delaySeconds, graceSeconds, tailSeconds
  });
  const shouldShow = phase !== "hidden";
  const justShown = shouldShow && !state.shownForThisSphere;
  const justHidden = !shouldShow && state.shownForThisSphere && !state.hidden;
  return {
    state: {
      shownForThisSphere: state.shownForThisSphere || shouldShow,
      hidden: state.hidden || justHidden,
      interactedAt: state.interactedAt,
      phase
    },
    decision: {
      visible: shouldShow,
      phase,
      justShown,
      justHidden,
      // The tail counts: the exit still takes several seconds, and a dwell firing
      // under it would strand the panel mid-exit. This does not rely on the
      // interaction having already zeroed the caller's dwell clock.
      holdDwell: shouldShow,
      // The caller re-renders on a phase change; it does not track one itself.
      phaseChanged: shouldShow && phase !== state.phase
    }
  };
}

// "full" = the four rows plus the pointer to Help; "tail" = that pointer alone.
function phaseNow(state, {
  elapsedSeconds, delaySeconds, graceSeconds, tailSeconds
}) {
  if (state.hidden) {
    return "hidden";
  }
  const elapsed = Number(elapsedSeconds);
  const delay = Number(delaySeconds);
  if (!Number.isFinite(elapsed) || !Number.isFinite(delay)) {
    return "hidden";
  }
  if (elapsed < delay) {
    return "hidden";
  }
  // Nothing but interaction ends it, so with interactedAt null it stays.
  if (state.interactedAt === null) {
    return "full";
  }
  const fullUntil = state.interactedAt + positive(graceSeconds);
  const tailUntil = fullUntil + positive(tailSeconds);
  if (elapsed < fullUntil) {
    return "full";
  }
  return elapsed < tailUntil ? "tail" : "hidden";
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(n, 0) : 0;
}

function idle(previous) {
  return {
    visible: false,
    justShown: false,
    justHidden: Boolean(previous.shownForThisSphere && !previous.hidden),
    holdDwell: false
  };
}

// The shortest set that lets someone use the sphere, in the order needed: move
// it, keep it moving, change the view, go somewhere. Returned as i18n keys so
// the caller translates. Each list names only what the device can do (no pinch
// on a desktop, no Shift on a phone).
export function onboardingRowKeys(touchOnly) {
  return touchOnly
    ? [
      ["key.drag", "act.turn"],
      ["key.dragRelease", "act.throw"],
      ["key.pinch", "act.zoom"],
      ["key.tap", "act.travel"]
    ]
    : [
      ["key.arrows", "act.turn"],
      ["key.shiftArrows", "act.zoom"],
      ["key.clickDrag", "act.turn"],
      ["key.clickEnter", "act.travelSelected"]
    ];
}
