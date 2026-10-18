// Controller button decisions for the sphere: select and the GenAI chord.
// Pure and dependency-free (no three, no DOM, no `state`) so the combinations are
// unit-testable offline; applyXrControllerInput (src/input.js) reads the live
// controllers and calls the actions this returns.
//
// The chord is a modifier: left grip held, then right trigger. It cannot be
// confused with a select and needs no timer, because the modifier is either
// already down or it is not. The left grip does nothing else, so one button never
// means two things. Capture lives on the system wrist panel.

function createXrButtonState() {
  return { chordLatch: false };
}

// `selectEdge` is passed in rather than derived here: input.js owns the select
// latch because the thumb microgestures force it to swallow a select, and two
// modules latching the same button would be two answers to one question.
function resolveXrButtonActions(prev, {
  leftGripPressed = false,
  selectEdge = false,
  rightTriggerPressed = false,
  genAiAvailable = true
} = {}) {
  const state = { ...(prev || createXrButtonState()) };

  // THE CHORD. Left grip is a modifier, so it is read as a level, not an edge:
  // the order that matters is grip-then-trigger, and holding the grip through
  // several triggers must not fire several batches — hence the latch, cleared
  // only when the trigger goes back up.
  const chordArmed = leftGripPressed && rightTriggerPressed && genAiAvailable;
  const fireChord = chordArmed && !state.chordLatch;
  state.chordLatch = chordArmed;

  // SELECT. Any trigger edge that is not the chord. No delay: the modifier is
  // observable in the same frame, so there is nothing to wait and see about.
  // Suppressed by an ARMED chord, not by the button combination: with no relay
  // configured the chord cannot arm, and a visitor who happens to be holding
  // the grip must still get the ordinary action rather than nothing at all.
  const fireSelect = selectEdge && !fireChord && !chordArmed;

  return { state, decision: { fireChord, fireSelect } };
}

export { createXrButtonState, resolveXrButtonActions };
