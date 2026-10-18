// Direct-manipulation hand gestures. Pure and dependency-free (no three, no DOM,
// no `state`) so the whole decision tree is unit-testable offline;
// applyXrControllerInput (src/input.js) reads the live XR frame and carries the
// decisions out.
//
// The tree: five gestures, resolved by the ORDER the two pinches arrived in, not by
// a race between hold timers.
//
//   select hand pinches, other hand NOT pinching  -> Select, on the press edge
//   rotate hand pinch ALREADY held, select hand then pinches
//                                                -> GenAI variation (confirm hold)
//   rotate hand pinch alone                      -> sphere yaw + pitch drag
//   no pinch, both hands open, palms AWAY         -> stop signal: pause rotation
//   no pinch, both hands tracked                  -> distance gesture
//                 (TUNNEL -> tunnel speed, INSIDE_SPHERE -> sphere zoom)
//
// Ordering instead of a race: the mere presence of the other hand must not delay
// select, and a stray microgesture co-fire on the other hand must not kill it. The
// accepted risk is the mirror image: a stray SELECT-hand pinch during a deliberate
// rotate drag reads as the GenAI chord, which the confirm hold guards. A tie (both
// pinches counting on the same frame) deliberately does NOT arm the chord; it fires
// a select, the direction that bills nobody.
//
// Why GenAI holds to confirm: each fire costs real money (a four-image batch), so a
// chord that is actually the start of something else must not bill anyone. The hold
// is on the SELECT-hand pinch, the second half of the chord, and is short enough
// that a deliberate chord still reads as immediate.
//
// Why pinches are debounced and cancellable: on this runtime a thumb microgesture
// co-fires the pinch button (`pressed: [0,5]` for swipe-left, `[0,8]` for
// swipe-backward), so button 0 alone is noisy. A pinch must persist
// PINCH_DEBOUNCE_MS before it counts, and a microgesture edge during a contact
// CANCELS that contact for as long as it is held.
//
// Why the distance gesture ratchets: it writes its control from a baseline captured
// on the engaging frame, and if the only release were the hands returning to that
// separation, every stroke would undo itself and the reachable range would be one
// stroke wide. A second, EARLIER release, settle, fixes that: hold the hands still
// for DISTANCE_COMMIT_MS past the deadband and the gesture lets go where it is (the
// caller stops writing, so the control keeps the stroke's value and the next
// engagement baselines from there). Returning to the baseline separation still
// releases and unwinds: that is "cancel".
//
// Why the hands must settle before it can engage: a hand at the edge of the
// tracking volume reports garbage separations for a few frames before it is dropped
// and again on return, and a garbage separation is a 25% deviation.
// DISTANCE_TRACKING_SETTLE_MS requires both hands to have been continuously
// POSITIONED that long. Losing tracking freezes the gesture (the caller stops
// writing) rather than snapping.
//
// The distance gesture has no engage pinch, so it must tell "I am moving my hands"
// from "I am operating a control" from the distance signal alone, hence the
// relative-change hysteresis below.
//
// The stop signal must outrank the distance gesture: "both hands tracked, open, no
// pinch" is the distance gesture's engage condition, so only the palm direction
// separates them (palms turned AWAY from the face, the universal "stop" pose). It
// carries a stability window so hands merely passing through that orientation do
// not pause the sphere.
//
// The stop signal is a LATCH. The pose engages it and only these disengage it:
// both hands moving DOWN from where the pose engaged, losing both hands, leaving
// the sphere, or a throw (below). Rotating the wrists out of palms-away or
// pinching does not release it.
//   * The release test is RELATIVE: each hand's height is captured when the latch
//     engages and the release asks for a drop from that, so it survives sitting vs
//     standing, short vs long reach, and any floor offset the runtime reports.
//   * "Latched" and "posed" are different states. While latched but not posed the
//     user is moving normally again, so the distance gesture (which the pose
//     suppresses) is available; only the live POSE stands it down.
// The pause is only the auto-rotation's: sphereRotationPaused scales rotation
// acceleration down (sphereRotationAccelScale in input.js), so a manual pinch-drag
// still turns the sphere while latched.
//
// The hand drag is velocity-proportional and the thumbstick is not. A stick springs
// back to centre, so "deflection = acceleration" lets it hold a speed. A hand has no
// spring, so feeding its deflection in as acceleration runs away to the clamp
// however it is tuned. The honest mapping is "displacement = how fast to TURN": push
// and it turns, return to the anchor and it stops (stepHandDragSpeed() below).
//
// Dropouts and a variable frame rate. Hand presence on this runtime is chaotic even
// on a good run: absence gaps have a median of 200-500 ms and p10 of ~15 ms, and
// about 42% of both-hands-present runs are shorter than the distance gesture's own
// 250 ms settle gate. So a rule that resets on a single absent frame cannot be
// satisfied by this stream. Five rules follow.
//
// Rule 1, absence is not information. It is not a release. If `pinching` went false
// on a dropped frame it would re-enter every downstream state machine as a
// brand-new pinch (a blink of the right hand while the left pinch is held would arm
// the chord and bill a batch for a user who never pinched right). A hand that goes
// away carries its last verdict forward for HAND_DROPOUT_GRACE_MS. The same rule
// holds in updateWristPokeState() and updateMicrogestureLatch().
//
// Rule 2, the chord is ordered by TIMESTAMP, not by frame. "Rotate was true on the
// previous evaluation" conflates elapsed time, sample count and loop iteration,
// which agree only at a steady high frame rate (two pinches had to be >13.9 ms
// apart at 72 Hz but >50 ms at 20 Hz). It is
// `pinchStartMs[rotate] + CHORD_LEAD_MS <= pinchStartMs[select]`, on the RAW press
// timestamps (so the debounce cancels from both sides). A tie resolves to SELECT.
//
// Rule 3, one fire per physical chord. `chordSpent` is set the moment a chord arms
// and clears ONLY when the select hand is OBSERVED present with its button
// released. An absence never clears it, so no dropout can manufacture a second
// chord out of one physical one.
//
// Rule 4, a long frame is not a long hold. One 350 ms hitch would otherwise satisfy
// GENAI_CONFIRM_HOLD_MS, DISTANCE_COMMIT_MS and STOP_POSE_STABILITY_MS in a single
// sample. The tree keeps an internal gesture clock:
//   * every threshold is measured on it; it advances by at most MAX_GESTURE_STEP_MS
//     (50 ms, the 20 Hz floor renderFrame() clamps to) per frame. Every window
//     therefore has an implicit minimum sample count of
//     ceil(threshold / MAX_GESTURE_STEP_MS); minWindowSamples() states it and a test
//     asserts it for every threshold.
//   * a frame longer than FRAME_HITCH_RATIO x the recent median (floored at
//     FRAME_HITCH_FLOOR_MS) is a HITCH and advances the clock by nothing. Hitch
//     frames still enter the median history, so a sustained drop in frame rate is
//     adapted to within a few frames.
//   * PINCH_DEBOUNCE_MS also carries a frame count (PINCH_DEBOUNCE_MIN_SAMPLES):
//     the disturbance it outlasts is counted in frames, so at 20 Hz a bare 80 ms
//     would let a three-frame microgesture blip through.
//
// Rule 5, the settle gates tolerate a blink. `handsTrackedSinceMs`, the stop pose's
// stability window and the distance gesture's own state get the same grace as the
// latch release: a gap shorter than HAND_DROPOUT_GRACE_MS holds the clock rather
// than resetting it, and an engaged distance gesture FREEZES across the gap instead
// of having its baseline and rest tracking wiped.
//
// A pinch is a grab: hold the sphere still and it stops; throw it and it spins.
//   * The brake. An engaged drag inside the rotate deadzone produces zero
//     deflection, which stepHandDragSpeed() reads as "turn at zero rad/s", so manual
//     momentum decays, but the sphere's own auto-drift (SPHERE_BASE_ROTATION_SPEED,
//     sphere.js) would keep turning under a hand the user believes is holding it.
//     `rotate.braking`: an ENGAGED drag held inside the deadzone for
//     ROTATE_BRAKE_HOLD_MS pauses the drift through the stop signal's channel. The
//     manual speed decays through the existing smoother
//     (HAND_DRAG_SPEED_RESPONSE_PER_S) and the drift has no momentum, so no second
//     explicit decay is added.
//   * The throw. While paused, a gentle drag inspects the surface and KEEPS the
//     pause; a decisive flick hands rotation back. It is measured on VELOCITY, not
//     total displacement: a slow sweep across the sphere is exploration, a fast
//     6 cm flick is a throw. A throw always imparts rotational momentum in the drag
//     direction (rotate.throwSpin, fed into the same state.sphereYRotSpeed /
//     sphereXRotSpeed the drag writes) and releases the pause if one is latched.
//     It also sets the drift DIRECTION (state.sphereDriftDirection, sphere.js),
//     because SPHERE_BASE_ROTATION_SPEED drifts one fixed way and would otherwise
//     reassert itself opposite to the throw once the momentum decayed; an engaged
//     drag suppresses the drift outright (applyHandRotateDrag()).
//   * The axes are not ergonomically equal: lateral travel is a shoulder/elbow
//     sweep across the body, longer and less precise than the wrist-and-forearm
//     lift that drives pitch, so yaw has its own, more sensitive deadzone and
//     full-deflection travel.
//
// The distance gesture only hears horizontal, and only in view.
//   * `handDistanceM` is not the raw 3-D separation: input.js projects the
//     hand-to-hand vector onto the viewer's horizontal axis (camera-right, the axis
//     applyHandRotateDrag() measures sideways drag along), so lowering both hands
//     changes nothing. Done at the measurement so the pure tree keeps taking one
//     scalar.
//   * Leaving the viewport is not a dropout. A hand that is tracked and outside the
//     viewport was deliberately taken out of frame: the gesture lets go WHERE IT IS
//     (releaseReason "out-of-view"; the caller stops writing, so nothing snaps back)
//     and the settle gate restarts. An UNTRACKED hand still gets the grace.
//   * The viewport test projects each hand's world position through the ACTIVE
//     CAMERA to normalised device coordinates and requires it inside the frustum
//     with a margin. An angular cone around head-forward fails: hands at chest
//     height are already 40-60 deg below the view axis, and spreading them (the
//     gesture itself) pushes them further out, so the gesture disqualified itself.
//     withinCone() belongs to the wrist summon: "is that ONE hand in front of me"
//     and "are BOTH hands on screen" are different questions.
//   * The horizontal margin was widened repeatedly (hands spreading fast reached
//     |x| 1.03-1.41 NDC against a bound of 1.35) and the horizontal test was then
//     removed; only DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE / _BELOW remain.
//
// The motion gate. A position test cannot separate "down plus some horizontal"
// (lowering the arms swings the hands apart as they fall) from a spread. What
// separates them is the MODE of motion: split the hands' velocity along the
// separation axis into differential (opposite directions, the gesture) and common
// (the same direction together). Common lateral motion changes no separation, but
// common VERTICAL motion is invisible to horizontalSeparationM() (it projects onto
// camera-right), so it must be measured separately. DISTANCE_INTENT_* measures both
// rates and requires the motion to be dominantly separation, with a Schmitt band so
// an engaged stroke survives the vertical wobble of holding two arms out.
// updateDistanceIntent() is the machine. The viewport gate stays: hands taken out
// sideways or behind the head can have a perfectly differential profile.
//
// Intent-share lessons that shaped the thresholds:
//   * "not-intent" must not fire at the end of good strokes: the share collapses
//     because the numerator goes to zero when a stroke finishes, not because the arms
//     went down. "The hands stopped moving" is not "the user is lowering their
//     arms", so the release must require the PRESENCE of evidence, not the absence.
//     The share is an ENGAGE gate only (floor DISTANCE_INTENT_MIN_RATE_MPS), and a
//     held verdict expires back to neutral after DISTANCE_INTENT_STALE_MS so a stale
//     ALLOWED from a finished spread does not authorise the arm-drop that follows.
//   * distanceRefusalGate() and the `distance / refused` transition line log
//     refusals, with `restM` / `baselineM` / `travelRel` (the numbers the engage
//     test is made of); without them a gesture that never fires leaves no evidence.
//   * No baseline can settle during a continuous entering motion: promoting a rest
//     only after a candidate held within DISTANCE_STABILITY_REL for 100 ms means a
//     pair converging faster than ~0.24 m/s (at 0.4 m separation) never settles, and
//     bringing hands in from the sides is 0.5-1.0 m/s. A LEAKY EXTREMUM
//     (DISTANCE_EXTREMUM_LEAK_S) records a turning point the moment it happens and
//     forgets it slowly, so no stillness is needed and deliberateness is a speed
//     (0.125 m/s at 0.4 m) rather than a pause.
//   * A 6-slot, 100 ms, 600 ms ring of {separation, height} replaces the share-based
//     release. Net DISPLACEMENT over that window separates a spread from an
//     arm-drop about five times better than any rate (a drop moves the mean height
//     0.4-0.6 m; the incidental sag of a spread 0.05-0.10 m) and is phase-invariant
//     (at the start of a spread the horizontal leads and the vertical lags 125 ms).
//     From it: an engage-side pathRatio gate, the lowering veto (the only
//     intent-driven release, firing on the presence of evidence), a post-release
//     re-arm blackout, and a reversal guard for the swing that follows a zoom-out
//     stroke.
//
// The distance gesture only engages at eye level. Every gate above reads motion or
// the frame edge, and a hand swinging into view as the head turns has a perfectly
// good differential motion. A POSE gate: both hands raised to about eye level,
// level with each other, in front of the face (DISTANCE_POSE_*, distancePoseCheck()).
// It is a gate, not an engage pinch. All three tests are RELATIVE TO THE HEAD (as
// for the stop latch: seated vs standing, floor offset), and an engaged stroke is
// held to looser margins and released keeping its value ("pose"), like
// "out-of-view".

const APP_STATE_TUNNEL = "tunnel";
const APP_STATE_INSIDE_SPHERE = "inside_sphere";

// Tunables

// A pinch must survive this long before any gesture reads it as a pinch. Sized to
// outlast a microgesture's incidental button-0 blip (1-3 frames at the 30 Hz
// hand-tracking rate) without perceptible lag on a real pinch. It is also the whole
// of the select latency, since ordering (not a hold) keeps a forming chord from
// firing a select. If select feels twitchy, raise this.
const PINCH_DEBOUNCE_MS = 80;

// The frame count that goes with it. The disturbance PINCH_DEBOUNCE_MS outlasts is
// counted in FRAMES, so the millisecond figure alone stops meaning what it says when
// the rate moves: at 20 Hz, 80 ms is two samples and a three-frame blip clears it.
// Three samples is the floor; at 30 Hz and above the millisecond window binds.
const PINCH_DEBOUNCE_MIN_SAMPLES = 3;

// The select-hand pinch must be held this long, with the rotate-hand pinch already
// down, before the variation fires. It is a **money guard** (each fire bills a
// four-image batch): lower it deliberately, never remove it.
const GENAI_CONFIRM_HOLD_MS = 200;

// The money guard's own frame count, stated rather than inherited. The clamped
// gesture clock already guarantees ceil(200/50) = 4 samples, so this is belt and
// braces; if it is ever the binding constraint, the clock is wrong.
const GENAI_CONFIRM_MIN_SAMPLES = 3;

// Dropout / frame-rate robustness: see rules 1-5 in the header.

// How long a hand may be ABSENT before its silence is treated as information.
// Inside this window the previous verdict is carried forward unchanged: a blink is
// not a release, not a re-press, and not an untracked hand. Short enough that a
// hand genuinely put down releases within a beat. Raise it if gestures break up;
// lower it if a hand put down keeps its pinch alive too long.
const HAND_DROPOUT_GRACE_MS = 150;

// Release-edge debounce, ROTATE hand and DRAG only. PINCH_DEBOUNCE_MS is a
// RISING-edge debounce, and updatePinchState() wipes the contact the instant the
// button reads up, so one bad frame ends the drag AND costs another 80 ms before a
// new one counts. Each new contact is a `rotate.justEngaged`, i.e. a fresh anchor in
// input.js: the position map restarts mid-stroke and the sphere jumps back to where
// the hand is now (stutter). So while a drag is engaged and the hand is still
// tracked, a raw un-pinch does not end the contact for this long; if the pinch
// re-asserts inside the window the SAME grab continues with the same anchor, offset
// and applied angle, and no release handoff is produced. `pinching` itself is
// untouched, so `pinchCount`, the select level, the chord and the distance gesture
// see what they saw before.
//
// Cost: a GENUINE release is confirmed this much later, so the sphere holds its
// angle for ~100 ms before the throw's coast starts. The throw is unaffected: the
// velocity EMA is snapshotted at the FIRST raw un-pinch (the true let-go instant),
// because a hand decelerates as soon as it opens. Raw gaps seen are a single frame.
const ROTATE_RELEASE_DEBOUNCE_MS = 100;

// A tracking blink mid-flick. Holding the grab displacement frozen is right for a
// slow drag but a visible hitch for a FLICK. So an unpositioned frame inside the
// grace EXTRAPOLATES the grab displacement along the release-velocity EMA, decaying
// with this time constant. A long gap contributes at most v*tau (0.12 m at 1 m/s).
// The offset re-anchor absorbs the error: on re-acquisition `offset += raw - heldRaw`
// and the extrapolation advances heldRaw with the corrected displacement, so the
// applied angle stays continuous. A blink AT REST extrapolates by nothing (the EMA
// is zero).
//
// Only for a TRACKING gap. The release debounce above also produces unpositioned
// frames, and those must FREEZE: the hand is visible, it just is not pinching.
const GRAB_DROPOUT_EXTRAPOLATE_TAU_S = 0.12;

// How much EARLIER the rotate-hand pinch must have started than the select-hand
// pinch for the pair to read as the GenAI chord (rule 2); making it explicit keeps
// it the same gesture at any frame rate. Too low and a two-handed grab bills a
// batch; too high and a deliberate chord reads as a select and navigates the sphere.
// Expected range 60-100 ms.
const CHORD_LEAD_MS = 80;

// The largest step the internal gesture clock takes in one frame (rule 4). 50 ms is
// 20 Hz, the same floor renderFrame() clamps to with MAX_FRAME_DT_SECONDS = 1/20.
// Every threshold is measured on that clock, which makes "no window can be satisfied
// by one long frame" a property rather than a hope.
const MAX_GESTURE_STEP_MS = 50;

// A frame longer than FRAME_HITCH_RATIO x the recent median frame time is a HITCH
// and contributes nothing to any window. The floor stops ordinary jitter (and a
// clean 72 -> 30 Hz transition) from reading as one; it sits below PINCH_DEBOUNCE_MS
// so no real threshold can be reached inside a single non-hitch frame either.
const FRAME_HITCH_FLOOR_MS = 60;
const FRAME_HITCH_RATIO = 2;

// How many recent frame times the median is taken over. Short enough to follow a
// sustained rate change within a few frames (so a slow session is not permanently
// classified as one long hitch), long enough that a single stall cannot move it.
const FRAME_MEDIAN_SAMPLES = 12;

// Distance-gesture hysteresis, all RELATIVE to a settled rest separation so it
// works the same for a short reach and a long one.
//
// The engaged condition is "deviation from rest is LARGE", so a release bound above
// the enter bound would mean the gesture could never let go. It is a Schmitt band:
// release once the deviation falls back to 35% OF the enter threshold, i.e. the
// hands have returned close to where they started. That costs nothing, because the
// gesture writes its output from the baseline every frame: back at rest, the control
// is back at the value it engaged with.
const DISTANCE_ENGAGE_REL = 0.25;
const DISTANCE_RELEASE_REL = 0.35 * DISTANCE_ENGAGE_REL;

// How much a separation reading may wander and still count as the SAME reading, for
// the ratchet's "the hands have stopped here" detector. Not a baseline (see
// DISTANCE_EXTREMUM_LEAK_S); only the tolerance the commit's stillness clock is
// measured against.
const DISTANCE_STABILITY_REL = 0.06;

// The turning-point baseline. A rest promoted only after a candidate held still
// cannot settle while the hands are converging faster than ~0.24 m/s (at a 0.4 m
// separation), and bringing hands in from the sides is 0.5-1.0 m/s; with no rest
// there is nothing to deviate 25% from. So there is no stillness test in the
// baseline. Track a LEAKY EXTREMUM: the furthest apart and closest together the
// hands have recently been, each relaxing toward the present reading with this time
// constant:
//
//   sepMin <- min(s, sepMin + (s - sepMin)(1 - e^(-dt/tau)))
//   sepMax <- max(s, sepMax - (sepMax - s)(1 - e^(-dt/tau)))
//
// and measure the deviation from whichever the hands are moving AWAY from. Bringing
// the hands in and immediately spreading works: the minimum they reached IS the
// baseline.
//
// The leak stops a very slow drift accumulating into an engagement: the extremum
// chases the hands, so a spread only builds a gap of roughly (speed x tau). Setting
// the gap equal to the engage band gives the slowest spread that can engage:
//
//   v_min = DISTANCE_ENGAGE_REL * b / tau = 0.25 * 0.4 / 0.8 = 0.125 m/s
//
// so this is a DELIBERATENESS test expressed as a speed. Slow deliberate spreads are
// refused -> raise tau; the zoom creeps while you merely hold your hands out ->
// lower it.
const DISTANCE_EXTREMUM_LEAK_S = 0.8;

// The release bound has to hold this long before the gesture lets go, so passing
// back through rest mid-gesture does not drop it.
const DISTANCE_RELEASE_GRACE_MS = 150;

// How long the hands must have BOTH been positioned before an engagement is allowed
// at all: the "hands moving in and out of frame must not affect the zoom" guard. It
// is measured on tracking, not on the separation reading, because the bad frames
// are the ones where the separation looks fine and is not. Long enough to outlast
// the re-acquisition wobble, short enough that a deliberate gesture never waits for
// it. It need not contain a baseline settle (the leaky extremum needs none), and
// the view transition does not restart this clock.
const DISTANCE_TRACKING_SETTLE_MS = 150;

// How long the hands must hold still, past the deadband, for the gesture to COMMIT
// and let go where it is (see the ratchet note in the header). Long enough that a
// stroke which merely decelerates does not trip it: committing mid-stroke would
// stall the control until the hands had travelled another engage band.
const DISTANCE_COMMIT_MS = 320;

// Below this the separation reading is noise (hands overlapping, or a bad joint
// pose) and cannot be a meaningful baseline.
const DISTANCE_MIN_REST_M = 0.05;

// The path layer. Smoothed instantaneous rates cannot separate the PHASE of a
// motion from its MODE: at the start of a spread the horizontal rate leads and the
// vertical lags by ~125 ms, so a lowering that BEGINS with an outward swing scores
// well for its first ~150 ms, and a slow lowering falls under the min-rate floor and
// inherits whatever verdict came before it.
//
// A short ring of recent samples answers both, because net DISPLACEMENT over a
// window is phase-invariant and separates the two poses about five times better
// than any rate: an arm drop moves the mean hand height 0.4-0.6 m, the incidental
// sag of a spread 0.05-0.10 m.
//
//   netSeparationM = s(now) - s(oldest slot in the window)
//   netHeightM     = h(now) - h(oldest slot in the window)
//   pathRatio      = |netSeparationM| / (|netSeparationM| + |netHeightM|)
//
// The 600 ms window (6 slots of DISTANCE_TRACK_SLOT_MS) is sized against stroke
// durations (engage -> release median ~850 ms) and must stay LONGER than a stroke's
// acceleration phase, or it measures the phase again rather than the whole path.
const DISTANCE_TRACK_SLOT_MS = 100;
const DISTANCE_TRACK_SLOTS = 6;
const DISTANCE_TRACK_WINDOW_MS = DISTANCE_TRACK_SLOT_MS * DISTANCE_TRACK_SLOTS;

// The path's own dominance test, alongside (not instead of) the instantaneous
// share. Both must clear their bound to engage: the share says what the hands are
// doing now is a separation, the path says so is the whole of what they just did.
const DISTANCE_PATH_ENGAGE_RATIO = 0.6;

// The lowering veto, the ONLY intent-driven release. It fires on POSITIVE EVIDENCE:
// the mean hand height is 0.18 m lower than at the top of the window. That is a real
// arm movement (an arm drop is 0.4-0.6 m) and cannot be produced by a stroke merely
// stopping. An engaged stroke released this way KEEPS ITS VALUE, like "out-of-view".
const DISTANCE_LOWERING_DROP_M = 0.18;

// How the veto is lifted. The veto is a STATE, not a latch, and re-arms two ways:
//   * Not lowering any more: netHeightM >= -DISTANCE_LOWERING_STEADY_M (one-sided,
//     so a rise does not refuse) sustained for DISTANCE_REARM_STILL_MS, only long
//     enough to outlast noise on a hand that has stopped descending.
//   * Rising: netHeightM >= +DISTANCE_LOWERING_STEADY_M re-arms IMMEDIATELY.
//     Raising the hands is the unambiguous statement that they are done parking.
// A two-sided stillness latch fails because the natural motion lower -> raise ->
// spread has no still phase, so the gesture locks out for good (the hands coming
// back UP fail a |netHeightM| < band test on the wrong side).
//
// The worry that the swing at the bottom of an arm-drop re-arms the gesture just in
// time for the swing back up to engage it is covered by the guards built for it:
// DISTANCE_REARM_MS blacks out 400 ms after any release, the REVERSAL GUARD demands
// pathRatio 0.80 and 1.5x travel for 900 ms, and the lowering veto re-fires the
// moment the window shows another 0.18 m drop.
const DISTANCE_LOWERING_STEADY_M = 0.05;
const DISTANCE_REARM_STILL_MS = 150;

// After ANY release, no engage for this long. The stroke just finished is still
// decelerating and the hands are where it left them; without this the deadband is
// the only thing between one stroke and an accidental second.
const DISTANCE_REARM_MS = 400;

// The reversal guard. For this long after a release, an engage in the OPPOSITE
// direction to the stroke that just ended has to be more convincing: a pathRatio of
// 0.80 rather than 0.60, and 1.5x the engage travel. The outward swing of an
// arm-drop always follows an inward zoom-out stroke and looks exactly like a
// re-spread; a deliberate re-spread clears 0.80 easily (real spreads score
// 0.82-1.00 on the instantaneous share).
const DISTANCE_REVERSAL_GUARD_MS = 900;
const DISTANCE_PATH_REVERSE_RATIO = 0.8;
const DISTANCE_PATH_REVERSE_TRAVEL_SCALE = 1.5;

// The intent test. Position tests cannot separate a spread from "down plus some
// horizontal": dropping the arms increases horizontal separation too, so the
// discriminator is MOTION. Project each hand's velocity onto the frozen separation
// axis and split it into two modes:
//
//   DIFFERENTIAL  the hands moving in OPPOSITE directions along that axis. This is
//                 d(separation)/dt, and it is the gesture.
//   COMMON        the hands moving the SAME way together. Not the gesture.
//
// Common LATERAL motion changes no separation, so it cannot engage anything. But
// horizontalSeparationM() projects onto camera-right, which makes the measurement
// blind to common VERTICAL motion. Two arms dropping are almost pure common
// vertical, yet the shoulders swing them out (or in) as they fall, so the projection
// sees a healthy differential and writes a zoom. The vertical common mode must be
// measured explicitly.
//
// So compare |d(separation)/dt| against the hands' common vertical rate and require
// the motion to be DOMINANTLY separation. The ratio is a dimensionless share,
// scale-free like DISTANCE_ENGAGE_REL, so a slow careful spread and a fast one are
// judged identically.

// How fast the two rates are smoothed, as an exponential response (1/s). Hand
// tracking runs at 30 Hz and a per-frame velocity difference of two noisy joint
// positions is mostly noise; 8/s is a 125 ms time constant (~4 frames), short enough
// that the verdict tracks a stroke and long enough that one bad frame cannot flip it.
const DISTANCE_INTENT_SMOOTH_PER_S = 8;

// Below this combined rate (differential + common, m/s) the hands are not really
// moving and the frame is not evidence either way, so the previous verdict is HELD
// rather than recomputed from noise. It matters at the top of a stroke, where the
// hands stop and DISTANCE_COMMIT_MS is counting: the ratchet must commit without
// the intent test changing its mind about a finished stroke. It must sit above the
// residue of a stopping stroke (separation rates of -0.10..+0.07 m/s with common
// vertical of -0.05..-0.23 m/s are finished strokes, not arm-drops); at a combined
// 0.06-0.10 m/s the share is arithmetic on noise.
const DISTANCE_INTENT_MIN_RATE_MPS = 0.15;

// How long the hands may sit under that floor before the HELD verdict is forgotten
// and the neutral "allowed" default returns. Holding a stale refusal is safe;
// holding a stale PERMISSION is not: a spread that ended (verdict: allowed) followed
// by the arms coming down would inherit the permission the finished spread earned.
// 300 ms is roughly the pause between finishing a gesture and the next thing you do
// with your arms. The reset is to the NEUTRAL default, not a refusal: an unknown is
// not a refusal, the same rule the viewport gate follows for an unreadable
// projection.
const DISTANCE_INTENT_STALE_MS = 300;

// The Schmitt band on the dominance share |sep| / (|sep| + |common vertical|). 0.75
// to engage; 0.30 to stay engaged (the separation rate may fall to 0.43x the
// vertical rate before an engaged stroke is dropped by the verdict). The two poses
// that must land on opposite sides:
//
//   dropping both arms: ~0.6 m of fall in ~0.8 s (0.75 m/s common) while the
//     shoulders swing the hands ~0.25 m apart (0.31 m/s differential): share 0.29.
//     Refused.
//   a deliberate spread: 0.30 m in 0.6 s (0.50 m/s) with the incidental vertical
//     drift of holding arms up, ~0.1 m/s: share 0.83. Allowed.
//
// Strokes that engaged while the hands were still rising into the eye-level pose
// scored 0.55-0.74; clean spreads 0.84-0.99.
//
// Legitimate spreads are refused -> lower the engage ratio; arms dropped out of the
// scene still write a zoom -> raise it. The two must stay ordered (release < engage)
// or the band is not hysteresis.
//
// This is an ENGAGE gate only: a release authorised by a share dip fires at the END
// of good strokes, because "the hands stopped moving" is read as "the user is
// lowering their arms". The release requires positive evidence of lowering (the
// net-displacement test); the RELEASE_RATIO only survives as the lower half of the
// engage hysteresis: once the verdict is `allowed`, a fall below 0.30 revokes it.
const DISTANCE_INTENT_ENGAGE_RATIO = 0.75;
const DISTANCE_INTENT_RELEASE_RATIO = 0.3;

// Rotate drag: how far the pinching hand travels for zero and for full "stick"
// deflection. Small on purpose: this is a wrist/forearm movement, not a reach. These
// numbers describe the displacement worth zero and full rotation SPEED.
//
// Per axis, because the arm is not symmetric:
//   * PITCH is a lift. The forearm rotates about the elbow with the upper arm more
//     or less still; vertical travel is comfortable, controlled and high-resolution.
//   * YAW is a sweep ACROSS THE BODY. It recruits the shoulder, the hand crosses the
//     torso, and the same travel costs more effort and lands less precisely.
// Yaw therefore gets the shorter travel and the tighter deadzone.
//
// Both full-deflection travels are short because a modest drag is otherwise worth
// very little through the whole chain (deflection -> stepHandDragSpeed -> sphere.js's
// own 0.95-per-frame decay, which lands the drag at ~74% of target at 72 Hz): 4 cm
// sideways at the old 0.15 m travel was only 17 deg/s, 4 cm vertical 9 deg/s. The
// response is not laggy (smoother plus decay give a ~64 ms effective time constant);
// the speed a reachable drag names was small, so the knob is the MAPPING, not the
// response rate nor HAND_SPHERE_*_SPEED_MAX (what full deflection is worth, 2.2
// rad/s). ROTATE_RESPONSE_EXPONENT bends the curve so the useful middle of the
// stroke arrives sooner still. With both, 4 cm buys 37 deg/s sideways and 28 deg/s
// vertically, full speed arrives at 10 cm / 12 cm, and yaw stays the more sensitive
// axis.
//
// The DEADZONES are kept: they are the only dead travel left, but they are also what
// the BRAKE is measured against ("hold it still and it stops"), and hand tracking
// jitters a few millimetres. Tightening them would make the brake harder to hold.
const ROTATE_YAW_DEADZONE_M = 0.015;
// Used only by the legacy ?drag=vel model.
const ROTATE_YAW_FULL_DEFLECTION_M = 0.10;
const ROTATE_PITCH_DEADZONE_M = 0.02;
// Used only by the legacy ?drag=vel model.
const ROTATE_PITCH_FULL_DEFLECTION_M = 0.12;

// The shape of the deflection curve, as an exponent on the normalised travel (0 at
// the deadzone edge, 1 at full deflection). 1 is a straight line.
//
// Below 1 ON PURPOSE, the opposite of an RC "expo" curve. Expo buys fine control
// near centre by making small deflections weaker, and "weaker near centre" is the
// complaint here. What expo protects against, a twitch reading as a command, the
// deadzone already handles, so spending sensitivity on it twice would be paying
// twice.
//
// 0.75 is a mild bend: it lifts the middle of the stroke by about a fifth (0.5 ->
// 0.59) and leaves both ends pinned, so the deadzone edge is still zero and full
// travel still exactly 1.
//
// Feels twitchy just outside the deadzone -> raise toward 1 (0.85 first); still stiff
// mid-stroke -> lower it, but not under ~0.6 or the curve reads as an on/off switch
// a centimetre past the deadzone. Used only by the legacy ?drag=vel model.
const ROTATE_RESPONSE_EXPONENT = 0.75;

// A pinch is a GRAB: the brake and the throw

// How long an ENGAGED drag has to sit inside the per-axis deadzones before it counts
// as "I am holding this still" and pauses the auto-drift. Not zero on purpose: a drag
// that reverses direction passes through the deadzone on the way, and killing the
// drift every time somebody changed their mind would make the pause feel like a
// fault rather than a grip. A quarter of a second is about the shortest pause a hand
// can make deliberately and roughly three time constants of
// HAND_DRAG_SPEED_RESPONSE_PER_S, so by the time the drift stops the manual momentum
// has decayed to ~5% and the two halves of the brake land together.
//
// The knob most likely to feel wrong: a user who pinches and takes a beat before
// dragging runs into the same window, finding the sphere paused (and, via
// sphereRotationAccelScale(), their drag 45% calmer) unasked. Trigger-happy -> raise
// it; "grab and hold" needs a deliberate wait -> lower it.
const ROTATE_BRAKE_HOLD_MS = 250;

// The THROW. Hand speed, in metres per second, that separates exploring the surface
// from flinging it. Measured as a speed, not a distance, because the two disagree
// exactly where it matters: a slow sweep across the sphere is exploration however
// far it goes, and a fast 6 cm flick is a throw however short. Deliberate throws
// run 1.0-2.2 m/s and clear this comfortably. Still the top device knob if a throw
// fails to register.
const ROTATE_THROW_SPEED_MPS = 0.7;

// What a throw is WORTH. A throw always hands the sphere rotational momentum in the
// direction of the fling, whether or not anything was paused, written into the same
// state.sphereYRotSpeed / sphereXRotSpeed the drag steers, so there is one rotation
// path.
//
// The gain maps hand speed to sphere speed. A full-deflection DRAG is worth
// HAND_SPHERE_YAW_SPEED_MAX = 2.2 rad/s and measured throws run 1.0-2.2 m/s. At 1.5
// rad/s per m/s the slowest recognised throw (0.7 m/s) is worth ~1.05 rad/s, a
// typical 1.4 m/s throw ~2.1 rad/s (about a full-deflection drag), and anything
// harder saturates. Feels feeble -> raise the gain; the sphere spins away from a
// firm gesture -> lower it. Used only by the legacy ?drag=vel model.
const ROTATE_THROW_SPIN_GAIN_RAD_PER_MPS = 1.5;

// The ceiling on that, in rad/s. 3.0 is ~172 deg/s, just over two seconds for a full
// turn: fast enough to read as a fling, slow enough that images stay legible on the
// way past. Sits under HAND_DRAG_SPEED_CLAMP (and so under applySphereRotationDelta()'s
// own +/-4), which stays the hard envelope.
const ROTATE_THROW_SPIN_MAX_RAD_PER_S = 3.0;

// The Schmitt lower bound: after a throw fires, the hand has to come back below this
// before another can. Without it one long fast sweep is a stream of throws, and the
// same sweep may cross the pause boundary more than once.
const ROTATE_THROW_RELEASE_SPEED_MPS = 0.35;

// How long the speed has to hold up. Two samples minimum on the clamped clock
// (minWindowSamples(80) = 2), so one noisy tracking frame that teleports the hand
// cannot throw the sphere. At the engage speed this is ~5.6 cm of travel: a flick,
// not a twitch.
const ROTATE_THROW_HOLD_MS = 80;

// How far from the drag anchor the hand has to have got. A jitter burst while the
// hand sits at the anchor can read fast for two frames without going anywhere; a
// throw goes somewhere. Outside the deadzone and inside ROTATE_YAW_FULL_DEFLECTION_M,
// so a throw is still a movement the drag itself was mapping.
const ROTATE_THROW_MIN_TRAVEL_M = 0.05;

// The grab model. A velocity model (displacement names a SPEED) turns the sphere
// forever under a held hand, so there is no "move across one image and stop", and
// every stroke has to be paid back by dragging the other way. Displacement naming an
// ANGLE gives fine-grained exploration, strokes that add up, and a throw, and the
// sphere is where the hand put it when the pinch opens.
//
// The gains live in constants.js (HAND_SPHERE_YAW_RAD_PER_M), with the arc
// calibration. What lives here is the envelope and the handoff.

// ANTI-TELEPORT CLAMP, and the reason the direct angle write is safe. The grab
// premultiplies its delta straight onto sphereOrientation, bypassing
// applySphereRotationDelta()'s own +/-4 rad/s clamp, so this IS the envelope;
// without it one bad tracking frame could snap the sphere through half a turn.
//
// 12 rad/s is 3 m/s of hand at 4.0 rad/m: above the 1.0-2.2 m/s of a deliberate
// fling, so a real throw is never clipped, and well below the apparent speed of a
// joint that teleports. An excursion the clamp eats is DROPPED, not repaid later;
// repaying it would hand the sphere the motion the clamp exists to refuse.
//
// A bad tracking frame still snaps the sphere -> lower it; a hard fling feels
// clipped -> raise it.
const HAND_GRAB_MAX_RATE_RAD_PER_S = 12;

// THE CATCH. Grabbing a sphere that is already spinning steers the spin to zero
// through the same smoother the velocity model used (HAND_DRAG_SPEED_RESPONSE_PER_S,
// tau 83 ms, ~5% left after 250 ms) while the position map does the real work on
// top. Same direction: the residual carries on briefly and the drag adds to it.
// Opposite: the residual dies inside a quarter second while the position map already
// drives the other way. Perpendicular axis: damped identically and nothing writes it,
// so it halts. A hard kill would get the end states right and the transient wrong
// (stopping 3 rad/s in one frame is visually violent).
//
// Grabbing a fast sphere feels like it fights you -> raise; the stop feels abrupt ->
// lower toward 8. There is no separate constant: the catch IS stepHandDragSpeed()
// commanded to zero, so it is HAND_DRAG_SPEED_RESPONSE_PER_S by construction.

// THE RELEASE VELOCITY, as an EMA that survives both a blink and the release edge.
// It has to be its own accumulator rather than a reading taken on the release frame,
// because on that frame the drag is already over: `dragSpeedMps` is computed only
// while `dragging`, so a release-frame reading is always 0.
//
// tau ~90 ms: long enough to ride out one noisy frame and a 200 ms dropout 50 ms
// before the release, short enough that a hand which decelerated to a stop before
// opening the pinch hands over almost nothing. Flicks feel weaker than they were ->
// raise; a decelerating release still flings -> lower.
const ROTATE_RELEASE_VEL_SMOOTH_PER_S = 11;

// Below MIN a release imparts NOTHING: that is what makes fine placement possible
// and re-gripping (let go, move the hand back, pinch again) safe to repeat. The ramp
// to _RAMP_MPS avoids a cliff at the threshold, where a hair's difference in release
// speed would otherwise be a dead stop versus a full handoff. Placing an image still
// drifts away from under the hand -> raise MIN; deliberate flicks die -> lower it.
const ROTATE_RELEASE_MIN_MPS = 0.18;
const ROTATE_RELEASE_RAMP_MPS = 0.30;

// The ceiling on the handoff. Same number the throw uses, so a release and a
// recognised throw cannot disagree about how fast is too fast, and still under
// HAND_DRAG_SPEED_CLAMP (and so under applySphereRotationDelta()'s +/-4).
const ROTATE_RELEASE_MAX_RAD_PER_S = ROTATE_THROW_SPIN_MAX_RAD_PER_S;

// The coast. Under the grab model the throw is the ONLY source of spin, so the decay
// is the whole behaviour of a flick. A fixed per-frame decay (0.95) is a time
// constant of 0.21 s at 90 Hz: a 2 rad/s flick travels about 0.45 rad (less than a
// panel) and is gone inside half a second, and the sphere stops 25% sooner on a
// faster headset. So:
//   1. TIME-BASED: exp(-dt/tau) gives the same coast at 72 Hz and 90 Hz.
//   2. TWO time constants, chosen by the momentum's SOURCE (state.sphereCoastTauS,
//      written by whoever last wrote a speed). A spring-centred stick wants a short
//      coast (you steer with the stick itself and a long tail reads as lag); a
//      thrown globe wants a long one.
//
// Stick/keyboard/microgesture tau: 0.22 s is the equivalent of 0.95/frame at 90 Hz.
//
// Coast runs on too long, or the sphere will not stop -> lower the HAND one; flicks
// die before they have gone anywhere -> raise it.
const SPHERE_COAST_TAU_STICK_S = 0.22;
const SPHERE_COAST_TAU_HAND_THROW_S = 2.2;

// One frame of the coast. Frame-rate independent by construction: the same elapsed
// time removes the same fraction of the speed however it is sliced. A 2 rad/s throw
// at tau 2.2 s travels omega*tau = 4.4 rad before it is spent.
function stepCoastSpeed(speed, { dtS, tauS = SPHERE_COAST_TAU_STICK_S } = {}) {
  const current = Number.isFinite(speed) ? speed : 0;
  if (current === 0) {
    return 0;
  }
  if (!Number.isFinite(dtS) || dtS <= 0) {
    return current;
  }
  const tau = Number.isFinite(tauS) && tauS > 0 ? tauS : SPHERE_COAST_TAU_STICK_S;
  return current * Math.exp(-dtS / tau);
}

// The idle drift's re-entry. The manual momentum DECAYS and the drift constant does
// not, so however the drift is aimed it eventually dominates, arriving at full
// magnitude the instant the pinch opens on top of a sphere still moving fast (see
// driftDirectionAfterRotation()). So the drift gets a gain and two gates in front
// of it: THE DRIFT CAN NEVER BE LARGER THAN THE MOMENTUM IT IS REPLACING, and it
// never starts while that momentum is still the bigger term.
//
// How long after any release before the drift starts coming back at all. A placed
// image drifts out from under you too soon -> raise it.
const DRIFT_RESUME_DELAY_S = 1.2;

// How long it then takes to reach full strength. The drift visibly "switches on" ->
// raise it.
const DRIFT_RESUME_SECONDS = 1.5;

// One frame of the ramp. `manualSpeed` is the larger of the two manual rotation
// speeds and `driftSpeed` is SPHERE_BASE_ROTATION_SPEED; while the sphere is turning
// faster than the drift would, the drift contributes nothing, so "the drift countered
// my release" cannot be observed.
//
// A grab zeroes the gain instantly (no ramp down): a hand on the sphere is not a
// gradual statement.
function stepDriftResume(prevGain, {
  dtS,
  grabbed,
  paused,
  holdSeconds,
  manualSpeed,
  driftSpeed,
  resumeSeconds = DRIFT_RESUME_SECONDS
}) {
  if (grabbed || paused) {
    return 0;
  }
  if (Number.isFinite(holdSeconds) && holdSeconds > 0) {
    return 0;
  }
  const manual = Number.isFinite(manualSpeed) ? Math.abs(manualSpeed) : 0;
  const drift = Number.isFinite(driftSpeed) ? Math.abs(driftSpeed) : 0;
  if (manual > drift) {
    return 0;
  }
  const previous = Number.isFinite(prevGain) ? Math.max(0, Math.min(1, prevGain)) : 0;
  if (!Number.isFinite(dtS) || dtS <= 0) {
    return previous;
  }
  const seconds = Number.isFinite(resumeSeconds) && resumeSeconds > 0 ? resumeSeconds : 0;
  if (seconds === 0) {
    return 1;
  }
  return Math.min(1, previous + (dtS / seconds));
}

// Optional gate on the brake ("near the centre"). OFF: "near the centre" could mean
// the centre of view, of the sphere or the selected image, and a brake that silently
// refuses to arm reads as broken rather than gated. The mechanism is here, tested
// both ways.
const ROTATE_BRAKE_CENTER_GATE = false;

// The gate itself, as an NDC radius around view centre. 0.5 is half way to the frame
// edge on the tighter axis: squarely "I am holding the thing I am looking at" rather
// than "my hand happens to be on screen".
const ROTATE_BRAKE_CENTER_MAX_NDC_R = 0.5;

// The distance gesture's viewport gate

// How far OUTSIDE the frustum a tracked hand may sit and still count as in the
// viewport, in normalised device coordinates: the test is |ndc.y| <= 1 + margin on
// the vertical axis, where the caller has projected the hand's world position
// through the active camera (input.js). 0 is dead centre, 1 is the frame edge.
//
// NDC and not an angle: an angular cone is a circle around head-forward, and
// spreading the hands (the gesture itself) pushes them out of it, so it disengaged
// every attempt. NDC is the real frustum, and costs one project() per hand per
// frame.
//
// There is no horizontal test. NDC x explodes as a hand approaches the near plane,
// so it reads "far off screen" for a hand a foot in front of the chest; strokes were
// killed at x = 3.0-4.1 on ordinary 1.0-1.2 m spreads, and every widening of the
// bound was soon exceeded again. The gesture only ever TRAVELS along x, and
// the honest test for a hand taken out sideways in earnest is `ndc.behind` (going
// properly wide means going behind the shoulder). If a hand off to the side must be
// refused, the fix is a real angular test, not another NDC number.
//
// The vertical band is asymmetric because the bottom of the view is where you park
// your hands to reset them (lower the hands, move them in or out of frame for the
// next zoom direction), and a gesture that keeps reading them there makes a second
// stroke in the opposite direction hard.
//   Y ABOVE: 0.35. Nobody zooms with their hands over their head.
//   Y BELOW: 0.25, a bound of -1.25. It must not be snug: legitimate spreads were
//     killed at y = -1.15 and -1.16. The LOWERING VETO carries the "lower the hands
//     to reposition them" workflow, backed by DISTANCE_MIN_SEPARATION_M and the
//     reversal guard, and all three read MOVEMENT rather than static position. This
//     band is only a backstop against hands parked at lap height (y = -2.03 at 0.9 m
//     below eye level at 0.4 m out), which it still refuses with room to spare.
//
// Worked geometry for the vertical pose:
//   0.7 m spread, 0.45 m out, 0.40 m below eye level: ndc.y = -(0.40/0.45)/1.11 = -0.80
//   0.8 m spread, 0.40 m out, 0.45 m below eye level (the extreme): ndc.y = -1.01
//
// A legitimate spread disengages -> raise the axis the diagnostic's `handNdc` says it
// died on; hands out of frame still drive the zoom -> lower it.
const DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE = 0.35;
const DISTANCE_VIEW_NDC_MARGIN_Y_BELOW = 0.25;

// The hands have to be APART to be measuring a separation. One hand travelling to
// the OTHER WRIST to poke a panel brings the pair to 0.074-0.136 m, which to a
// gesture that only looks at the gap between the hands is a textbook converging
// (zoom-out) stroke.
//
// 0.18 m is wider than any wrist poke seen and narrower than any deliberate
// two-handed pose: hands that close are doing something to each other, not to the
// sphere. It blocks the ENGAGE only; the extremum keeps tracking underneath, so
// bringing the hands right in and then spreading is still one continuous gesture.
//
// Zoom-out strokes that end with the hands nearly touching stop committing -> lower
// it; wrist pokes still zoom -> raise it (and check the `wrist` gate below first,
// the more specific fix).
const DISTANCE_MIN_SEPARATION_M = 0.18;

// The eye-level pose gate. All heights are the hand anchor (the WRIST joint,
// input.js) relative to the head (camera = eye height), never world height. ENGAGE
// margins gate a new stroke; the looser RELEASE margins are what an engaged stroke
// must leave, so drifting a few cm mid-zoom never drops it. Hands looking around
// still zoom -> tighten the engage margins; a deliberate eye-level spread is refused
// -> loosen the one the `pose-*` refusal names (its measured values are on the diag
// line).
//
// Level: 12 cm is about a hand's length. Two hands raised "level by eye" land well
// inside it; one at the face and one at the chest (25-30 cm) do not.
const DISTANCE_POSE_LEVEL_M = 0.12;
const DISTANCE_POSE_LEVEL_RELEASE_M = 0.22;
// Eye band: eye-to-shoulder is ~0.20-0.25 m, so 0.30 below admits wrists in front of
// the face down to the top of the chest; forearms-level at the waist (~0.6 below) and
// hands hanging (~0.8 below) fail by a wide margin. 0.20 above is the brow.
const DISTANCE_POSE_EYE_BELOW_M = 0.30;
const DISTANCE_POSE_EYE_ABOVE_M = 0.20;
const DISTANCE_POSE_EYE_BELOW_RELEASE_M = 0.45;
const DISTANCE_POSE_EYE_ABOVE_RELEASE_M = 0.35;
// In front: metres along the head's HORIZONTAL forward, not an angle (an angle is the
// cone again and would refuse a 1.2 m tunnel spread, whose wrists still sit 0.3-0.45
// m out). 10 cm only refuses a hand beside or behind the head, where a hand at the
// edge of a head turned ~60 deg sits.
const DISTANCE_POSE_FORWARD_M = 0.10;
const DISTANCE_POSE_FORWARD_RELEASE_M = 0;
// A lost pose must persist this long before it releases an engaged stroke, so one
// garbage joint frame cannot end it. Same length as the rest release grace.
const DISTANCE_POSE_RELEASE_MS = 150;
// At most one `pose-*` refusal line per this interval: a marginal pose flickers
// across the bound with joint jitter, and each flicker is a gate transition.
const DISTANCE_POSE_DIAG_INTERVAL_MS = 1000;

// How quickly the rotation speed chases the displacement the hand is asking for, as an
// exponential response rate (1/s). A smoother, not a throttle: the speed converges on
// the target and can never exceed it, so holding a deflection never makes the sphere
// faster. ~12/s is an 83 ms time constant: fast enough that the sphere feels attached
// to the hand, slow enough that a single noisy tracking frame cannot snap the speed
// across the range.
const HAND_DRAG_SPEED_RESPONSE_PER_S = 12;

// Mirrors the +/-4 clamp inside applySphereRotationDelta() (src/sphere.js). Defensive
// only, but keeps this module's output inside the envelope every other rotation input
// lives in.
const HAND_DRAG_SPEED_CLAMP = 4;

// Palm-up refusal for the rotate drag: Meta reserves palm-up pinch for its system
// wrist menu and it can eject the WebXR session. cos(60 deg) = 0.5, so a palm normal
// within 60 deg of world-up refuses the drag.
const PALM_UP_MAX_COS = 0.5;

// Stop signal: how squarely both palms have to face away from the head, as the palm
// normal's dot product with the view direction. cos(53 deg) ~ 0.6: loose enough for a
// natural "stop" pose at chest height, tight enough that palms turned toward each
// other (the distance gesture's own pose) or toward the face (the wrist-panel summon
// pose) do not qualify.
const PALM_AWAY_MIN_COS = 0.6;

// How long that pose has to survive before it pauses anything. Hands pass through all
// sorts of orientations while the distance gesture is operated; this window stops one
// of them reading as a stop signal.
const STOP_POSE_STABILITY_MS = 250;

// How far BOTH hands have to fall below the height they were at when the latch engaged
// before it lets go (the test is relative; see the header). A quarter of a metre is
// well past the wobble of a held pose and well short of the ~0.5-0.7 m to drop the
// hands to the lap. Top device knob for this gesture: too easy to resume -> raise it;
// can't let go without flopping the arms down -> lower it.
const STOP_RELEASE_DROP_M = 0.25;

// Held for this long, so a dip on the way to somewhere else does not resume.
const STOP_RELEASE_STABILITY_MS = 150;

// The same test when one or both hands have stopped being tracked. Longer than the drop
// window because a blip is not a lowered hand, but it must exist: hands lowered out of
// the tracking volume look exactly like hands that vanished, and a latch with no exit
// would strand the pause.
const STOP_RELEASE_TRACKING_GRACE_MS = 400;

// Frame clock and graced windows (rules 4 and 5)

// The smallest number of frames a window of `thresholdMs` can possibly be satisfied in,
// given the clamp. Exported so the guarantee is stated in one place and asserted by a
// test rather than being an emergent property nobody re-derives when a threshold moves.
function minWindowSamples(thresholdMs) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return 1;
  }
  return Math.ceil(thresholdMs / MAX_GESTURE_STEP_MS);
}

function medianOf(values) {
  if (!values || values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function createFrameClock() {
  return { started: false, rawNowMs: 0, clockMs: 0, recentMs: [] };
}

// One frame of the internal gesture clock. Returns the clock value every threshold in
// this file is measured against, plus the raw frame time and whether this frame was a
// hitch.
//
// Two clamps (rule 4): an ordinary long frame advances the clock by at most
// MAX_GESTURE_STEP_MS, and a HITCH (a frame far out of line with the recent median)
// advances it by nothing, because a stall is the absence of evidence rather than a lot
// of it. Hitch frames still enter the median history: a session that settles at a low
// frame rate must stop being classified as one long hitch, or the clock would never
// advance again.
function stepFrameClock(prev, nowMs) {
  const state = prev || createFrameClock();
  if (!Number.isFinite(nowMs)) {
    return { state, clockMs: state.clockMs, dtMs: 0, medianDtMs: 0, hitch: false };
  }
  if (!state.started) {
    return {
      state: { started: true, rawNowMs: nowMs, clockMs: nowMs, recentMs: [] },
      clockMs: nowMs,
      dtMs: 0,
      medianDtMs: 0,
      hitch: false
    };
  }
  const dtMs = Math.max(0, nowMs - state.rawNowMs);
  const medianDtMs = medianOf(state.recentMs);
  const hitchLimitMs = Math.max(FRAME_HITCH_FLOOR_MS, FRAME_HITCH_RATIO * medianDtMs);
  const hitch = state.recentMs.length > 0 && dtMs > hitchLimitMs;
  const advanceMs = hitch ? 0 : Math.min(dtMs, MAX_GESTURE_STEP_MS);
  const clockMs = state.clockMs + advanceMs;
  const recentMs = state.recentMs.concat(dtMs).slice(-FRAME_MEDIAN_SAMPLES);
  return {
    state: { started: true, rawNowMs: nowMs, clockMs, recentMs },
    clockMs,
    dtMs,
    medianDtMs,
    hitch
  };
}

function createGracedWindow() {
  return { sinceMs: 0, gapSinceMs: 0 };
}

// A "how long has this been continuously true" clock that distinguishes FALSE from
// UNKNOWN (rule 5). False resets it. Unknown (the evidence went missing rather than
// went away) holds it for up to `graceMs`, then gives up. Never mutates `prev`.
function stepGracedWindow(prev, { now, active, unknown, graceMs = HAND_DROPOUT_GRACE_MS }) {
  const state = prev || createGracedWindow();
  if (active) {
    return { sinceMs: state.sinceMs || now, gapSinceMs: 0 };
  }
  if (unknown && state.sinceMs) {
    const gapSinceMs = state.gapSinceMs || now;
    if (now - gapSinceMs <= graceMs) {
      return { sinceMs: state.sinceMs, gapSinceMs };
    }
  }
  return createGracedWindow();
}

// Small pure helpers

// Relative deviation of `value` from `reference`. Infinity for a useless reference,
// which reads as "not near it" everywhere it is compared.
function relativeDeviation(value, reference) {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference <= 0) {
    return Infinity;
  }
  return Math.abs(value - reference) / reference;
}

// The HORIZONTAL hand separation: the magnitude of the hand-to-hand vector's component
// along the viewer's horizontal axis. Both arguments are anything with x/y/z (a
// THREE.Vector3 in the app, a plain object in tests), so that "moving down must not
// change the zoom" can be proved offline. input.js still owns reading the two anchors
// and the camera axis.
function horizontalSeparationM(separation, axis) {
  if (!separation || !axis) {
    return NaN;
  }
  const projected = (separation.x * axis.x) + (separation.y * axis.y) + (separation.z * axis.z);
  return Number.isFinite(projected) ? Math.abs(projected) : NaN;
}

// Is the palm turned toward world-up? `palmUpDot` is the palm normal's dot product with
// world up. Anything unreadable (null/NaN) counts as palm-up, so an unknown pose
// refuses the drag rather than gambling the session on it.
function isPalmFacingUp(palmUpDot, maxCos = PALM_UP_MAX_COS) {
  if (!Number.isFinite(palmUpDot)) {
    return true;
  }
  return palmUpDot >= maxCos;
}

// Is the palm turned away from the face? `palmForwardDot` is the palm normal's dot
// product with the head's view direction. Unreadable counts as NOT away, the opposite
// default to isPalmFacingUp() and for the same reason: there the safe answer was
// "refuse the drag", here it is "do not pause the sphere on a pose we could not see".
function isPalmFacingAway(palmForwardDot, minCos = PALM_AWAY_MIN_COS) {
  if (!Number.isFinite(palmForwardDot)) {
    return false;
  }
  return palmForwardDot >= minCos;
}

// Drag distance -> stick-like deflection in [-1, 1], with a deadzone. The two axes do
// not share their tunables (a lateral sweep across the body is longer and coarser than
// a vertical lift); the curve shape is identical, so this stays one function with the
// pair passed in rather than two near-copies that could drift apart. The curve is
// bent by ROTATE_RESPONSE_EXPONENT; both ends stay pinned (zero at the deadzone edge,
// exactly 1 at full deflection).
function rotateDeflection(
  displacementM,
  deadzoneM,
  fullDeflectionM,
  exponent = ROTATE_RESPONSE_EXPONENT
) {
  if (!Number.isFinite(displacementM)) {
    return 0;
  }
  const magnitude = Math.abs(displacementM);
  if (magnitude <= deadzoneM) {
    return 0;
  }
  const span = fullDeflectionM - deadzoneM;
  const scaled = span > 0 ? Math.min(1, (magnitude - deadzoneM) / span) : 1;
  const shaped = Number.isFinite(exponent) && exponent > 0 && exponent !== 1
    ? Math.pow(scaled, exponent)
    : scaled;
  return Math.sign(displacementM) * shaped;
}

// The two axes, named, so a caller cannot apply the pitch curve to a sideways drag.
function rotateYawDeflection(lateralM) {
  return rotateDeflection(lateralM, ROTATE_YAW_DEADZONE_M, ROTATE_YAW_FULL_DEFLECTION_M);
}

function rotatePitchDeflection(verticalM) {
  return rotateDeflection(verticalM, ROTATE_PITCH_DEADZONE_M, ROTATE_PITCH_FULL_DEFLECTION_M);
}

// The viewport test. `ndc` is one hand's world position projected through the ACTIVE
// camera into normalised device coordinates: `{ x, y, behind }`, where `behind` says
// the hand is on the wrong side of the near plane and x/y are meaningless.
//
// Three defaults, all the same rule as the dropout grace: an UNKNOWN is never read as
// a deliberate act.
//   * no reading at all (null/undefined) -> IN view. An untracked hand is for
//     HAND_DROPOUT_GRACE_MS to handle.
//   * an unreadable coordinate (NaN) -> IN view, same reason.
//   * `behind` -> OUT of view. That IS information: a hand behind the head is not
//     operating a control the user can see.
// The vertical band is asymmetric: `marginYBelow` lets a user park their hands out of
// the gesture and bring them back up for the next stroke.
function handWithinViewport(
  ndc,
  marginYAbove = DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE,
  marginYBelow = DISTANCE_VIEW_NDC_MARGIN_Y_BELOW
) {
  if (!ndc) {
    return true;
  }
  if (ndc.behind) {
    return false;
  }
  const { x, y } = ndc;
  // `x` is destructured and must be READABLE (an unreadable projection is an unknown),
  // but it is not BOUNDED; see the constants above for why the horizontal axis has no
  // test.
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return true;
  }
  const boundAbove = 1 + Math.max(0, Number.isFinite(marginYAbove) ? marginYAbove : 0);
  const boundBelow = 1 + Math.max(0, Number.isFinite(marginYBelow) ? marginYBelow : 0);
  return y >= 0 ? y <= boundAbove : y >= -boundBelow;
}

// The same reading against a RADIUS around view centre, for the brake's centre gate.
// Same three defaults as handWithinViewport(): no reading and an unreadable coordinate
// are both "unknown", which here means the gate PERMITS (an unknown must never silently
// disable a control), while `behind` refuses.
function handWithinNdcRadius(ndc, maxRadius = ROTATE_BRAKE_CENTER_MAX_NDC_R) {
  if (!ndc) {
    return true;
  }
  if (ndc.behind) {
    return false;
  }
  const { x, y } = ndc;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return true;
  }
  const limit = Math.max(0, Number.isFinite(maxRadius) ? maxRadius : 0);
  return Math.hypot(x, y) <= limit;
}

// One hand's verdict against the height the stop latch captured for it:
//   "lost"  no usable height this frame (untracked, or never captured)
//   "down"  dropped more than STOP_RELEASE_DROP_M below the captured height
//   "up"    still up there
// A hand with no captured anchor can never be "down" (nothing to measure against) but
// can be "lost", which keeps the latch escapable even if the anchor was never readable.
function stopHandExit(heightM, anchorY, dropM = STOP_RELEASE_DROP_M) {
  if (!Number.isFinite(heightM)) {
    return "lost";
  }
  if (!Number.isFinite(anchorY)) {
    return "up";
  }
  return heightM <= anchorY - dropM ? "down" : "up";
}

// One frame of the velocity-proportional rotate drag, per axis. `deflection` is the
// [-1, 1] displacement reading; `maxSpeed` is what full deflection is worth in rad/s;
// `scale` is the caller's zoom-based calming (sphereRotationAccelScale()). The returned
// speed CONVERGES on the target and never passes it, however long the deflection is
// held. Pure, so that property is provable offline.
function stepHandDragSpeed(currentSpeed, {
  deflection,
  maxSpeed,
  scale = 1,
  dt,
  responsePerS = HAND_DRAG_SPEED_RESPONSE_PER_S,
  maxAbsSpeed = HAND_DRAG_SPEED_CLAMP
}) {
  const current = Number.isFinite(currentSpeed) ? currentSpeed : 0;
  if (!Number.isFinite(deflection) || !Number.isFinite(maxSpeed) || !Number.isFinite(dt) || dt <= 0) {
    return current;
  }
  const scaled = Number.isFinite(scale) ? scale : 1;
  let target = deflection * maxSpeed * scaled;
  if (target > maxAbsSpeed) {
    target = maxAbsSpeed;
  } else if (target < -maxAbsSpeed) {
    target = -maxAbsSpeed;
  }
  // Exponential approach, frame-rate independent so a 30 Hz hand frame and a 72 Hz render
  // frame reach the same speed in the same wall-clock time.
  const alpha = 1 - Math.exp(-Math.max(0, responsePerS) * dt);
  const next = current + ((target - current) * alpha);
  // Snap the last sliver, so "hand back at the anchor" reaches zero instead of leaving a
  // permanent creep the brake would have to fight.
  return Math.abs(target - next) < 1e-4 ? target : next;
}

// The grab model's four pure steps

// The grab's own displacement bookkeeping, kept HERE rather than in input.js because
// dropouts are what the offline tests can reproduce. A hand WILL vanish mid-drag (gaps
// run a median of 200-500 ms). Under a position map a frozen displacement means the
// sphere HOLDS ITS ANGLE; the one hazard is the re-acquisition snap (a 207 ms gap at 1
// m/s is 0.2 m, i.e. 0.8 rad of sphere arriving in one frame).
//
// The offset closes it: on the first positioned frame after any unpositioned one,
// `offset += raw - heldRaw`, so the applied angle is CONTINUOUS across the gap and the
// hand keeps control from wherever it came back. Nothing is repaid; the sphere does not
// lurch to where the hand "should" have taken it.
function createGrabState() {
  return {
    // The re-anchor. Everything the hand did while untracked is absorbed here.
    offsetLateralM: 0,
    offsetVerticalM: 0,
    // The last RAW displacement seen on a positioned frame, which the next re-anchor is
    // measured against.
    rawLateralM: 0,
    rawVerticalM: 0,
    // The corrected displacement the angle target is made of.
    lateralM: 0,
    verticalM: 0,
    positioned: false,
    // How much angle has actually been handed to the sphere so far this contact, per axis.
    // The rate clamp is bookkept against THIS, not the target, so a clamped excursion is
    // dropped rather than queued.
    appliedYawRad: 0,
    appliedPitchRad: 0,
    // The release velocity EMA (see ROTATE_RELEASE_VEL_SMOOTH_PER_S). It lives on the
    // contact because it has to survive the release edge; by the frame the pinch opens
    // `dragging` is already false and there is nothing left to measure.
    velLateralMps: 0,
    velVerticalMps: 0,
    // The velocity the DROPOUT extrapolation is coasting on: seeded from the release EMA on
    // the frame the hand vanishes, decayed every unpositioned frame after. Zeroed when a
    // real reading comes back.
    holdVelLateralMps: 0,
    holdVelVerticalMps: 0
  };
}

// `extrapolate` distinguishes the two ways a frame can arrive unpositioned:
//   * a TRACKING gap (the hand blinked): coast the displacement along the
//     release-velocity EMA, decaying with GRAB_DROPOUT_EXTRAPOLATE_TAU_S. Freezing the
//     sphere mid-flick is a visible hitch.
//   * a PINCH gap (the release debounce is bridging a raw un-pinch): FREEZE. The hand
//     is visible and may be doing anything; inventing motion for it would be a guess.
// Both advance nothing when the estimate is zero, so a blink at rest produces no motion.
function stepGrabDisplacement(prev, {
  positioned,
  rawLateralM,
  rawVerticalM,
  extrapolate = false,
  dtS = 0,
  decayTauS = GRAB_DROPOUT_EXTRAPOLATE_TAU_S
}) {
  const state = prev || createGrabState();
  const live = Boolean(positioned)
    && Number.isFinite(rawLateralM)
    && Number.isFinite(rawVerticalM);
  if (!live) {
    // Seed on the FIRST unpositioned frame, carry the decayed estimate after.
    const holdLateral = state.positioned
      ? (Number.isFinite(state.velLateralMps) ? state.velLateralMps : 0)
      : (Number.isFinite(state.holdVelLateralMps) ? state.holdVelLateralMps : 0);
    const holdVertical = state.positioned
      ? (Number.isFinite(state.velVerticalMps) ? state.velVerticalMps : 0)
      : (Number.isFinite(state.holdVelVerticalMps) ? state.holdVelVerticalMps : 0);
    const dt = Number.isFinite(dtS) && dtS > 0 ? dtS : 0;
    const tau = Number.isFinite(decayTauS) && decayTauS > 0 ? decayTauS : 0;
    if (!extrapolate || dt === 0 || tau === 0) {
      // HOLD. Not zero: zero would mean "the hand came back to the anchor", a statement about
      // the hand, and a blink is not one.
      return {
        ...state,
        positioned: false,
        holdVelLateralMps: holdLateral,
        holdVelVerticalMps: holdVertical
      };
    }
    // Exact integral of v0*e^(-t/tau) over the step, so the coast is identical at 72 Hz and
    // 90 Hz and a long gap converges on v0*tau rather than running away.
    const decay = Math.exp(-dt / tau);
    const stepLateral = holdLateral * tau * (1 - decay);
    const stepVertical = holdVertical * tau * (1 - decay);
    return {
      ...state,
      positioned: false,
      // BOTH the raw reference and the corrected displacement advance. That keeps the
      // re-anchor honest: on re-acquisition `offset += raw - heldRaw` measures against where
      // the extrapolation got to, so the applied angle is continuous with no snap back.
      rawLateralM: state.rawLateralM + stepLateral,
      rawVerticalM: state.rawVerticalM + stepVertical,
      lateralM: state.lateralM + stepLateral,
      verticalM: state.verticalM + stepVertical,
      holdVelLateralMps: holdLateral * decay,
      holdVelVerticalMps: holdVertical * decay
    };
  }
  let offsetLateralM = state.offsetLateralM;
  let offsetVerticalM = state.offsetVerticalM;
  if (!state.positioned) {
    offsetLateralM += rawLateralM - state.rawLateralM;
    offsetVerticalM += rawVerticalM - state.rawVerticalM;
  }
  return {
    ...state,
    positioned: true,
    rawLateralM,
    rawVerticalM,
    offsetLateralM,
    offsetVerticalM,
    lateralM: rawLateralM - offsetLateralM,
    verticalM: rawVerticalM - offsetVerticalM,
    holdVelLateralMps: 0,
    holdVelVerticalMps: 0
  };
}

// Displacement -> ANGLE. Linear past the deadzone, with no full-deflection rescale and
// no response exponent: both shape a speed, and shaping a position map only makes the
// same stroke worth different amounts depending on where in the stroke it happens.
//
// `zoomGain` is handDragGainScale() in input.js, a separate, floored gain, NOT
// sphereRotationAccelScale(); reusing the velocity path's calming would be wrong here.
function grabAngleTarget(displacementM, deadzoneM, gainRadPerM, zoomGain = 1) {
  const displacement = Number.isFinite(displacementM) ? displacementM : 0;
  const deadzone = Number.isFinite(deadzoneM) ? Math.max(0, deadzoneM) : 0;
  const gain = Number.isFinite(gainRadPerM) ? gainRadPerM : 0;
  const scale = Number.isFinite(zoomGain) ? zoomGain : 1;
  const magnitude = Math.max(0, Math.abs(displacement) - deadzone);
  if (magnitude === 0) {
    return 0;
  }
  return Math.sign(displacement) * magnitude * gain * scale;
}

// One axis of the position channel: how much angle to hand the sphere THIS frame, given
// where the map wants to be and where it has got to.
//
// The clamp is HAND_GRAB_MAX_RATE_RAD_PER_S (load-bearing, see that constant).
// `appliedRad` advances by the CLAMPED delta, so the excursion the clamp refused is gone
// for good; carrying it forward would hand the sphere the teleport one frame later.
function stepGrabAngle(appliedRad, targetRad, {
  dtS,
  maxRatePerS = HAND_GRAB_MAX_RATE_RAD_PER_S
}) {
  const applied = Number.isFinite(appliedRad) ? appliedRad : 0;
  if (!Number.isFinite(targetRad) || !Number.isFinite(dtS) || dtS <= 0) {
    return { deltaRad: 0, appliedRad: applied };
  }
  const limit = Math.max(0, Number.isFinite(maxRatePerS) ? maxRatePerS : 0) * dtS;
  let delta = targetRad - applied;
  if (delta > limit) {
    delta = limit;
  } else if (delta < -limit) {
    delta = -limit;
  }
  return { deltaRad: delta, appliedRad: applied + delta };
}

// The release-velocity EMA, per axis. `sample` is null/NaN on a frame that carries no
// measurement (untracked hand, a hitch, the engaging frame); such a frame HOLDS the
// estimate rather than decaying it toward zero, so a blink 50 ms before the release
// does not eat the throw.
function stepReleaseVelocity(prevMps, {
  sampleMps,
  dtS,
  responsePerS = ROTATE_RELEASE_VEL_SMOOTH_PER_S
}) {
  const previous = Number.isFinite(prevMps) ? prevMps : 0;
  if (!Number.isFinite(sampleMps) || !Number.isFinite(dtS) || dtS <= 0) {
    return previous;
  }
  const rate = Math.max(0, Number.isFinite(responsePerS) ? responsePerS : 0);
  const alpha = 1 - Math.exp(-rate * dtS);
  return previous + ((sampleMps - previous) * alpha);
}

// THE HANDOFF, on the release edge. Two properties:
//   * VELOCITY CONTINUITY. The same gain G maps hand velocity to sphere rate as maps
//     hand displacement to sphere angle, so the sphere does not change speed when the
//     pinch opens; a flick reads as a flick, not a fling bolted onto a drag.
//   * ADDITIVITY. It ADDS to whatever the sphere is already carrying, so consecutive
//     flicks accumulate. A re-grip cannot fling by accident: a below-MIN release
//     imparts exactly nothing.
//
// `aim*` is what the idle drift should be pointed down: the handoff itself when there
// is one, otherwise the net direction the drag was going, so even a placement release
// leaves the drift agreeing with the hand.
function releaseHandoff({
  velLateralMps,
  velVerticalMps,
  netLateralM = 0,
  netVerticalM = 0,
  yawSpeedRadPerS = 0,
  pitchSpeedRadPerS = 0,
  yawGainRadPerM,
  pitchGainRadPerM,
  zoomGain = 1,
  minMps = ROTATE_RELEASE_MIN_MPS,
  rampMps = ROTATE_RELEASE_RAMP_MPS,
  maxRadPerS = ROTATE_RELEASE_MAX_RAD_PER_S
}) {
  const velL = Number.isFinite(velLateralMps) ? velLateralMps : 0;
  const velV = Number.isFinite(velVerticalMps) ? velVerticalMps : 0;
  const yawGain = Number.isFinite(yawGainRadPerM) ? yawGainRadPerM : 0;
  const pitchGain = Number.isFinite(pitchGainRadPerM) ? pitchGainRadPerM : 0;
  const scale = Number.isFinite(zoomGain) ? zoomGain : 1;
  const residualYaw = Number.isFinite(yawSpeedRadPerS) ? yawSpeedRadPerS : 0;
  const residualPitch = Number.isFinite(pitchSpeedRadPerS) ? pitchSpeedRadPerS : 0;
  const speedMps = Math.hypot(velL, velV);
  let gain;
  if (speedMps < minMps) {
    gain = 0;
  } else if (speedMps < rampMps && rampMps > minMps) {
    gain = (speedMps - minMps) / (rampMps - minMps);
  } else {
    gain = 1;
  }
  const limit = Math.max(0, maxRadPerS);
  const clampSpeed = (value) => (value > limit ? limit : (value < -limit ? -limit : value));
  // The signs are the drag's own: a hand moving RIGHT (positive lateral) drives NEGATIVE
  // yaw and a hand moving UP drives positive pitch, so the content moves with the hand.
  const yawRadPerS = clampSpeed(residualYaw + (gain * -yawGain * velL * scale));
  const pitchRadPerS = clampSpeed(residualPitch + (gain * pitchGain * velV * scale));
  const hasHandoff = yawRadPerS !== 0 || pitchRadPerS !== 0;
  return {
    yawRadPerS,
    pitchRadPerS,
    speedMps,
    gain,
    aimYawRadPerS: hasHandoff
      ? yawRadPerS
      : -yawGain * (Number.isFinite(netLateralM) ? netLateralM : 0) * scale,
    aimPitchRadPerS: hasHandoff
      ? pitchRadPerS
      : pitchGain * (Number.isFinite(netVerticalM) ? netVerticalM : 0) * scale
  };
}

// Which way the idle drift should point once a rotation input lets go. The sphere has
// two rotation channels: the manual speeds turn the whole content group rigidly through
// a quaternion, while the idle drift accumulates into irisXRot / irisYRot and turns each
// panel by its own multiplier. If a release does not aim the drift, a drift of FIXED
// sense resumes at full magnitude the instant the pinch opens, against the hand half the
// time; the manual speed decays (~0.27 s time constant) while the drift does not, so the
// constant term wins within about half a second and the sphere visibly turns back. So
// the release, not only the throw, aims the drift. The drift is ONE signed scalar applied
// to both irisXRot and irisYRot, so a single +/-1 cannot satisfy a diagonal release; it
// follows the axis the user was actually moving in.
//
// Returns +1 / -1 as a multiplier on the base drift speed, or 0 for "no opinion, leave
// the direction alone": a release with no rotation left in it (the brake, or a hand
// returned to its anchor) says nothing about which way to drift, and neither does an
// unreadable speed.
function driftDirectionAfterRotation(yawSpeed, pitchSpeed, baseDriftSpeed) {
  const yaw = Number.isFinite(yawSpeed) ? yawSpeed : 0;
  const pitch = Number.isFinite(pitchSpeed) ? pitchSpeed : 0;
  const base = Number.isFinite(baseDriftSpeed) ? baseDriftSpeed : 0;
  if (base === 0) {
    return 0;
  }
  const dominant = Math.abs(yaw) >= Math.abs(pitch) ? yaw : pitch;
  if (dominant === 0) {
    return 0;
  }
  return Math.sign(dominant) === Math.sign(base) ? 1 : -1;
}

// The layer differential. The sphere is twelve concentric shells and they must not turn
// as one, or one surface sits stuck behind another.
//
// `sphereOrientation` turns the whole content group RIGIDLY: every rotation writer
// (stick, keys, microgestures, desktop pointer, the grab's direct angle write, the
// momentum coast) ends up there, and a rigid turn can never unstack a panel hidden
// behind another. The only thing that moves panels RELATIVE to each other is
// `state.irisXRot` / `irisYRot`, which sphere.js's panel loop applies to panel `i`
// multiplied by `sphereLayerSpreadMultiplier(i)` below (1.05 innermost to 4.30
// outermost). So "the layers turn at different speeds" is "irisXRot / irisYRot are
// changing".
//
// The idle drift is the only unpaused writer of those two. A hand throw sets
// `sphereDriftHoldSeconds` and coasts with tau 2.2 s, and `stepDriftResume()` holds the
// gain at zero until the manual speed is under the drift's own 0.12 rad/s (about 6 s of
// a rigid, stacked sphere); a grab claims `sphereRotationInputActive` on every engaged
// frame, pinning the gain at zero for the whole drag. Re-opening the drift during a
// coast is not the fix: a drift running while the sphere carries momentum is the
// counter-rotation bug. The differential is driven from the manual rotation itself,
// as the original Java did: the original Java SphereProxy.java (line 170) rotates
// each sphere by `temprotX + m_spinOffsets[i] * xspeedStore`, a per-layer multiple of
// the CURRENT manual speed on top of the `xrot * spreadFactor` iris channel. Every
// radian the sphere turns, from any source, also spends SPHERE_MANUAL_LAYER_COUPLING of
// a radian into the iris channel in the direction of the turn, so layer `i` turns at
// `1 + coupling * multiplier(i)` times the group rate (1.08x innermost to 1.34x
// outermost). The layers can only lead the rotation, never oppose it.
const SPHERE_LAYER_SPREAD_BASE = 1.05;
const SPHERE_LAYER_SPREAD_STEP = 0.1;

// How much of each radian of manual rotation is spent on the layer spread. 0.08 makes a
// full turn of the sphere worth ~0.5 rad of iris, about what ~4 s of idle drift
// accumulates. Panels still hide behind each other on a long drag -> raise; the sphere
// reads as coming apart while you turn it -> lower.
const SPHERE_MANUAL_LAYER_COUPLING = 0.08;

// The per-panel multiplier on irisXRot / irisYRot. Two interleaved series (the `i % 2`
// parity doubles every second shell) so NEIGHBOURING layers are the ones furthest apart
// in rate; a monotone ramp would leave adjacent panels nearly locked, the "stuck behind
// another" failure. Pure, so the property can be tested without three.js.
function sphereLayerSpreadMultiplier(index) {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return ((i % 2) + 1) * (SPHERE_LAYER_SPREAD_BASE + (i * SPHERE_LAYER_SPREAD_STEP));
}

// The iris increment a frame's manual rotation earns. Per-axis and sign-preserving: a
// yaw drag spreads the layers about Y (the axis that brings a panel out from behind its
// neighbour horizontally) and a pitch drag about X. Not the drift's shape, which drives
// one signed scalar into both axes because the drift has no direction of its own.
function manualLayerDifferential(deltaPitchRad, deltaYawRad, coupling = SPHERE_MANUAL_LAYER_COUPLING) {
  const pitch = Number.isFinite(deltaPitchRad) ? deltaPitchRad : 0;
  const yaw = Number.isFinite(deltaYawRad) ? deltaYawRad : 0;
  const k = Number.isFinite(coupling) ? coupling : 0;
  return { irisXRad: pitch * k, irisYRad: yaw * k };
}

// One hand's NDC reading, rounded for the diagnostics line. `null` stays null, so "no
// projection" and "the projection was 0,0" cannot be confused.
function ndcForDiag(ndc) {
  if (!ndc) {
    return null;
  }
  const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  return ndc.behind
    ? { x: round2(ndc.x), y: round2(ndc.y), behind: true }
    : { x: round2(ndc.x), y: round2(ndc.y) };
}

// The deviation the engage test is looking at, rounded for the log: from the engaged
// stroke's baseline when one is running, otherwise from the turning point it would
// engage off. `null` when there is no reference yet (the "no-baseline" refusal), which
// must read differently from a travel of zero.
function distanceTravelRelForDiag(distanceM, reference) {
  const rel = relativeDeviation(distanceM, reference);
  return Number.isFinite(rel) ? Math.round(rel * 100) / 100 : null;
}

function otherHand(handedness) {
  return handedness === "left" ? "right" : "left";
}

// Per-hand pinch contact

// `idleObserved` / `observedStart` are the second half of the money guard (rule 3). The
// dropout grace covers gaps up to HAND_DROPOUT_GRACE_MS, but a hand can also be away
// long enough that the contact legitimately ends, come back with the button still down,
// and present a rising edge that never happened. A real press is one where we WATCHED
// the hand not pressing just before it: `idleObserved` records that, and
// `observedStart` carries it onto the contact. A contact reconstructed out of an
// absence has `observedStart: false` and can never arm the chord; it can still Select,
// the cheap reading.
function createPinchState() {
  return {
    pressed: false,
    sinceMs: 0,
    samples: 0,
    cancelled: false,
    idleObserved: false,
    observedStart: false
  };
}

// Next contact state; never mutates `prev`. `cancelled` is sticky for the whole contact:
// a microgesture edge disqualifies every frame until the button actually releases, which
// stops the tail of a swipe reading as a deliberate pinch.
//
// `samples` counts the frames on which the button was OBSERVED pressed (rule 4). It is
// not incremented on a frame the hand was absent for, because the caller does not step
// the contact then: a blink adds neither time nor evidence, it just holds. Only called
// for a hand that IS present this frame, which is what makes `idleObserved` mean what it
// says.
function updatePinchState(prev, { pressed, now, microgestureEdge }) {
  if (!pressed) {
    return { ...createPinchState(), idleObserved: true };
  }
  const continuing = Boolean(prev.pressed);
  return {
    pressed: true,
    sinceMs: continuing ? prev.sinceMs : now,
    samples: continuing ? (prev.samples || 0) + 1 : 1,
    cancelled: Boolean((continuing && prev.cancelled) || microgestureEdge),
    idleObserved: false,
    observedStart: continuing ? Boolean(prev.observedStart) : Boolean(prev.idleObserved)
  };
}

// How long this contact has counted as a pinch, or -1 when it does not count at all
// (released, cancelled by a microgesture, inside the debounce, or not yet seen on enough
// separate frames; see PINCH_DEBOUNCE_MIN_SAMPLES).
function pinchHeldMs(pinch, now, minSamples = PINCH_DEBOUNCE_MIN_SAMPLES) {
  if (!pinch.pressed || pinch.cancelled) {
    return -1;
  }
  if ((pinch.samples || 0) < minSamples) {
    return -1;
  }
  const held = now - pinch.sinceMs;
  return held >= PINCH_DEBOUNCE_MS ? held : -1;
}

// Distance gesture

// The path ring. Six slots, one every 100 ms, so the oldest usable sample is roughly
// 500-600 ms old whatever the frame rate. It carries the horizontal separation and the
// mean hand height and answers one question: where were the hands, as a body, half a
// second ago?
//
// A ring of SAMPLES and not another exponential filter: the thing measured is a
// displacement between two points in time, and an EMA of a displacement is a rate again,
// which could not tell an arm-drop from a finished stroke.
function createDistanceTrack() {
  return { slots: [] };
}

// One sample. `slots` is oldest-first; a new one is only appended once
// DISTANCE_TRACK_SLOT_MS has passed, and anything older than the window (or past
// DISTANCE_TRACK_SLOTS entries) falls off the front. Returns the next track plus the
// derived path, so callers never reach into `slots`.
//
// A tracking gap does NOT clear the ring. The displacement across a blink really
// happened, unlike a RATE, which would read a 200 ms gap as a teleport, so the samples
// either side are both true.
function stepDistanceTrack(prev, { nowMs, separationM, heightM }) {
  const usable = Number.isFinite(nowMs)
    && Number.isFinite(separationM)
    && Number.isFinite(heightM);
  if (!usable) {
    return {
      track: prev,
      netSeparationM: 0,
      netHeightM: 0,
      spanMs: 0,
      pathRatio: 0
    };
  }
  const prevSlots = prev.slots || [];
  const last = prevSlots.length ? prevSlots[prevSlots.length - 1] : null;
  let slots = prevSlots;
  if (!last || nowMs - last.ms >= DISTANCE_TRACK_SLOT_MS) {
    slots = [...prevSlots, { ms: nowMs, separationM, heightM }]
      .filter((slot) => nowMs - slot.ms <= DISTANCE_TRACK_WINDOW_MS);
    if (slots.length > DISTANCE_TRACK_SLOTS) {
      slots = slots.slice(slots.length - DISTANCE_TRACK_SLOTS);
    }
  }
  const oldest = slots[0];
  const netSeparationM = separationM - oldest.separationM;
  const netHeightM = heightM - oldest.heightM;
  const total = Math.abs(netSeparationM) + Math.abs(netHeightM);
  return {
    track: { slots },
    netSeparationM,
    netHeightM,
    spanMs: nowMs - oldest.ms,
    // No motion at all is NO EVIDENCE, hence 0 rather than 1. It cannot block a real
    // gesture (the slowest spread that can engage still moves 75 mm across this window) and
    // it keeps a perfectly still pair of hands from inheriting a path verdict they did not
    // earn.
    pathRatio: total > 0 ? Math.abs(netSeparationM) / total : 0
  };
}

// The intent test's state (a motion test, not a third position test).
//
// `allowed` starts TRUE, the same default the viewport gate uses for an unreadable
// projection: an unknown must not be a refusal. It only changes on a frame where the
// hands move fast enough to be evidence, so a gesture performed slowly enough to sit
// under the noise floor throughout is permitted rather than silently blocked.
function createDistanceIntentState() {
  return {
    lastMs: null,
    lastSeparationM: NaN,
    lastHeightM: NaN,
    separationRateMps: 0,
    commonVerticalRateMps: 0,
    ratio: 1,
    allowed: true,
    // When the combined rate first fell under DISTANCE_INTENT_MIN_RATE_MPS, or null while
    // the hands are moving fast enough to be evidence. The held verdict expires off this
    // (DISTANCE_INTENT_STALE_MS).
    quietSinceMs: null,

    // the path layer
    track: createDistanceTrack(),
    netSeparationM: 0,
    netHeightM: 0,
    spanMs: 0,
    pathRatio: 0,
    // Positive evidence that the arms are coming down, RIGHT NOW.
    lowering: false,
    // The state the veto sets. Disarmed while the window shows a drop; re-armed as soon as
    // it stops showing one (held DISTANCE_REARM_STILL_MS), or immediately if the hands are
    // RISING.
    armed: true,
    steadySinceMs: null,
    // Set by noteDistanceStrokeEnd() on any release: the post-stroke blackout and the
    // window in which a reversal has to work harder, plus the direction of the stroke a
    // reversal would be reversing.
    rearmUntilMs: 0,
    reversalGuardUntilMs: 0,
    lastStrokeDirection: 0
  };
}

// One release edge, folded back into the intent state by the caller. Separate from
// updateDistanceIntent() because a release is decided by updateDistanceGesture() and
// this is the only thing that flows the other way.
function noteDistanceStrokeEnd(prev, { nowMs, strokeDirection }) {
  return {
    ...prev,
    rearmUntilMs: nowMs + DISTANCE_REARM_MS,
    reversalGuardUntilMs: nowMs + DISTANCE_REVERSAL_GUARD_MS,
    lastStrokeDirection: Math.sign(strokeDirection) || prev.lastStrokeDirection
  };
}

// One frame of the intent test. Returns the NEXT state; never mutates `prev`.
//   nowMs        the clamped gesture clock, not performance.now()
//   readable     both hands gave a usable separation and height this frame
//   separationM  the same HORIZONTAL separation the gesture is driven from
//   meanHeightM  the mean of the two hand heights: the common vertical mode
//
// A frame that is not readable drops the SAMPLES (so the next rate is not computed
// across a tracking gap, which would read as a teleport) but KEEPS the verdict, the same
// split the dropout grace makes everywhere between "this stopped" and "we cannot see
// it". The PATH ring keeps its samples too, for the opposite reason: a displacement
// across a gap is real.
function updateDistanceIntent(prev, { nowMs, readable, separationM, meanHeightM }) {
  if (!readable || !Number.isFinite(separationM) || !Number.isFinite(meanHeightM)) {
    return {
      ...prev,
      lastMs: null,
      lastSeparationM: NaN,
      lastHeightM: NaN,
      separationRateMps: 0,
      commonVerticalRateMps: 0
    };
  }

  // The path first, because the lowering veto is a statement about where the hands have
  // BEEN and needs no per-frame rate.
  const path = stepDistanceTrack(prev.track, { nowMs, separationM, heightM: meanHeightM });
  const lowering = path.netHeightM <= -DISTANCE_LOWERING_DROP_M;
  let armed = prev.armed;
  let steadySinceMs = prev.steadySinceMs;
  if (lowering) {
    armed = false;
    steadySinceMs = null;
  } else if (path.netHeightM >= DISTANCE_LOWERING_STEADY_M) {
    // RISING RE-ARMS, IMMEDIATELY. A stillness-only re-arm has no rule for "move hands down,
    // move hands back up, zoom again" and locks the zoom (a 0.53 m spread refused because
    // netHeightM was +0.055).
    armed = true;
    steadySinceMs = null;
  } else if (!armed) {
    // Otherwise the veto lifts when the window stops showing a drop: a ONE-SIDED test, held
    // for DISTANCE_REARM_STILL_MS so a hand that has stopped descending is distinguishable
    // from noise mid-drop.
    if (path.netHeightM >= -DISTANCE_LOWERING_STEADY_M) {
      if (steadySinceMs === null) {
        steadySinceMs = nowMs;
      } else if (nowMs - steadySinceMs >= DISTANCE_REARM_STILL_MS) {
        armed = true;
        steadySinceMs = null;
      }
    } else {
      steadySinceMs = null;
    }
  }
  const pathNext = {
    track: path.track,
    netSeparationM: path.netSeparationM,
    netHeightM: path.netHeightM,
    spanMs: path.spanMs,
    pathRatio: path.pathRatio,
    lowering,
    armed,
    steadySinceMs
  };

  if (prev.lastMs === null || !Number.isFinite(prev.lastSeparationM) || !Number.isFinite(prev.lastHeightM)) {
    return {
      ...prev,
      ...pathNext,
      lastMs: nowMs,
      lastSeparationM: separationM,
      lastHeightM: meanHeightM
    };
  }
  const dtS = (nowMs - prev.lastMs) / 1000;
  if (!(dtS > 0)) {
    return { ...prev, ...pathNext };
  }

  const rawSeparationRate = (separationM - prev.lastSeparationM) / dtS;
  const rawCommonRate = (meanHeightM - prev.lastHeightM) / dtS;
  // Frame-rate independent exponential smoothing, the same shape stepHandDragSpeed() uses,
  // so the time constant means 125 ms at any rate.
  const alpha = 1 - Math.exp(-DISTANCE_INTENT_SMOOTH_PER_S * dtS);
  const separationRateMps = prev.separationRateMps
    + ((rawSeparationRate - prev.separationRateMps) * alpha);
  const commonVerticalRateMps = prev.commonVerticalRateMps
    + ((rawCommonRate - prev.commonVerticalRateMps) * alpha);

  const differential = Math.abs(separationRateMps);
  const common = Math.abs(commonVerticalRateMps);
  const motion = differential + common;
  let ratio = prev.ratio;
  let allowed = prev.allowed;
  let quietSinceMs = prev.quietSinceMs;
  if (motion >= DISTANCE_INTENT_MIN_RATE_MPS) {
    quietSinceMs = null;
    ratio = differential / motion;
    allowed = prev.allowed
      ? ratio >= DISTANCE_INTENT_RELEASE_RATIO
      : ratio >= DISTANCE_INTENT_ENGAGE_RATIO;
  } else {
    // Under the floor. HOLD the verdict, but not forever: a verdict earned by a stroke that
    // finished 300 ms ago is not evidence about what the arms do next, and the dangerous
    // direction is a stale ALLOWED authorising the arm-drop that follows a zoom. Expire back
    // to the neutral default.
    if (quietSinceMs === null) {
      quietSinceMs = nowMs;
    } else if (nowMs - quietSinceMs >= DISTANCE_INTENT_STALE_MS) {
      // Both fields go back to what a FRESH state carries, so a diag line after an expiry
      // reads as "no evidence" rather than a current measurement that happens to be 300 ms
      // old.
      allowed = true;
      ratio = 1;
    }
  }

  return {
    ...prev,
    ...pathNext,
    lastMs: nowMs,
    lastSeparationM: separationM,
    lastHeightM: meanHeightM,
    separationRateMps,
    commonVerticalRateMps,
    ratio,
    allowed,
    quietSinceMs
  };
}

function createDistanceState() {
  return {
    engaged: false,
    // The leaky extremum: the closest together and the furthest apart the hands have
    // recently been. The engage baseline is whichever of the two they are travelling AWAY
    // from. 0 means "no reading yet".
    sepMinM: 0,
    sepMaxM: 0,
    // The ratchet's stillness detector, and the ONLY stillness left in this gesture. It
    // decides when a finished stroke commits; it is not a baseline.
    stillM: 0,
    stillSinceMs: 0,
    baselineM: 0,
    releaseSinceMs: 0,
    // When an ENGAGED stroke first read outside the pose's release margins.
    poseLostSinceMs: 0,
    lastMs: 0
  };
}

// One frame of the leaky extremum. Both bounds chase the present reading with
// DISTANCE_EXTREMUM_LEAK_S, and each is clamped so it can never cross it: the minimum
// snaps instantly to a new low, the maximum to a new high. That asymmetry is the
// mechanism: a turning point is recorded the moment it happens and forgotten slowly.
function stepDistanceExtremum({ sepMinM, sepMaxM }, distanceM, dtS) {
  if (!(sepMinM > 0) || !(sepMaxM > 0)) {
    return { sepMinM: distanceM, sepMaxM: distanceM };
  }
  const k = dtS > 0 ? 1 - Math.exp(-dtS / DISTANCE_EXTREMUM_LEAK_S) : 0;
  return {
    sepMinM: Math.min(distanceM, sepMinM + ((distanceM - sepMinM) * k)),
    sepMaxM: Math.max(distanceM, sepMaxM - ((sepMaxM - distanceM) * k))
  };
}

// Which extremum the engage test measures from. `direction` is the sign of the
// windowed net separation: spreading measures from the minimum you came off, closing
// from the maximum.
//
// With no direction (only when the caller supplies no path, i.e. the pure unit tests),
// fall back to the extremum the hands are FURTHEST from. That reproduces the directed
// answer whenever there is one, so it is a fallback rather than a second rule; it must
// not be used on a real frame, where a stale far extremum in the wrong direction would
// engage a stroke backwards.
function distanceBaselineFor({ sepMinM, sepMaxM }, distanceM, direction) {
  if (!(sepMinM > 0) || !(sepMaxM > 0)) {
    return 0;
  }
  if (direction > 0) {
    return sepMinM;
  }
  if (direction < 0) {
    return sepMaxM;
  }
  return Math.abs(distanceM - sepMinM) >= Math.abs(distanceM - sepMaxM) ? sepMinM : sepMaxM;
}

// The path gate a caller with no path layer gets: everything open, no direction, no
// guard. Only the pure tests take this branch.
const DISTANCE_PATH_OPEN = {
  armed: true,
  lowering: false,
  ratio: 1,
  direction: 0,
  reverseGuarded: false,
  lastStrokeDirection: 0
};

// One frame of the distance gesture. Returns { state, active, justEngaged, deltaM,
// releaseReason }, never mutating `prev`. `deltaM` is signed metres of EFFECTIVE travel:
// the raw separation change with the engage deadband subtracted, so the control starts
// at exactly zero on the frame it engages instead of jumping by the whole 25% it took
// to get there. Positive = hands moving apart.
//
// `canEngage` is the tracking gate: false means "the hands have not been reliably
// tracked long enough to trust a new engagement". It only blocks the engage transition;
// a running gesture is never dropped by it, and the extremum keeps tracking underneath
// so there is already a turning point to deviate from when the gate opens.
//
// `path` is the path layer's verdict, and everything in it except `lowering` gates the
// ENGAGE transition only:
//   armed     false while the window still shows the arms coming down, true again
//             once it stops (held DISTANCE_REARM_STILL_MS) or at once if they are
//             rising; and false inside the post-release blackout
//   lowering  positive evidence the arms are coming down RIGHT NOW; this one also
//             releases a running stroke
//   ratio     |net separation| / (|net separation| + |net height|) over the 600 ms
//             window, against DISTANCE_PATH_ENGAGE_RATIO
//   direction / reverseGuarded / lastStrokeDirection   the reversal guard
// `direction` also chooses WHICH extremum the deviation is measured from.
//
// `releaseReason` names which exit fired on this frame:
//   "committed"   the hands settled past the deadband; the gesture lets go WHERE IT IS
//                 and the caller keeps the value (the ratchet).
//   "rest"        the hands came back to the baseline separation; the control is back
//                 where it engaged, i.e. the stroke was cancelled.
//   "out-of-view" a TRACKED hand left the viewport. Keeps the value like "committed":
//                 the caller stops writing, so the control freezes where the stroke
//                 left it. A hand taken out of frame and one that merely blinked must
//                 be read differently (see `hold`).
//   "lowering"    the mean hand height is DISTANCE_LOWERING_DROP_M lower than at the
//                 top of the path window. Keeps the value. The ONE intent-driven
//                 release, firing on the PRESENCE of evidence.
//   "pose"        an engaged stroke's hands left the eye-level pose's RELEASE margins
//                 for DISTANCE_POSE_RELEASE_MS. Keeps the value. `poseOk` is the
//                 caller's distancePoseCheck() verdict.
//
// `intent` is the verdict from updateDistanceIntent(). It gates the ENGAGE transition
// alongside `canEngage`, and nothing else: a release authorised by the share fires at
// the END of good strokes (the share collapses because the numerator goes to zero), so
// a release must come from positive evidence of lowering, never from the absence of
// evidence.
//
// `hold` is the dropout grace (rule 5): "we just cannot see the hands this frame". The
// state is returned UNCHANGED and the gesture reports inactive, so the caller freezes,
// but the baseline, rest tracker and engaged flag survive to be continued when the hand
// returns. Wiping on every gap would make the gesture spend its life restarting, since
// ~42% of both-hands-present runs are shorter than the settle gate.
function updateDistanceGesture(prev, {
  now,
  eligible,
  distanceM,
  canEngage = true,
  hold = false,
  inView = true,
  intent = true,
  path = DISTANCE_PATH_OPEN,
  poseOk = true
}) {
  // A release seeds the extremum from wherever the hands ended up, so the next stroke
  // measures from HERE and cannot bounce back in off a stale turning point. Same shape
  // for every exit that keeps its value.
  const seeded = () => ({
    ...createDistanceState(),
    sepMinM: distanceM,
    sepMaxM: distanceM,
    stillM: distanceM,
    stillSinceMs: now,
    lastMs: now
  });

  if (hold) {
    return {
      state: { ...prev },
      active: false,
      justEngaged: false,
      deltaM: 0,
      releaseReason: "",
      baselineCandidateM: distanceBaselineFor(prev, distanceM, path.direction),
      strokeDirection: 0
    };
  }
  if (!eligible || !Number.isFinite(distanceM) || distanceM < DISTANCE_MIN_REST_M) {
    return {
      state: createDistanceState(),
      active: false,
      justEngaged: false,
      deltaM: 0,
      releaseReason: "",
      baselineCandidateM: 0,
      strokeDirection: 0
    };
  }
  if (!inView) {
    // A TRACKED hand outside the viewport. Deliberate, not a dropout, so this is a clean
    // disengage rather than the `hold` freeze above: the caller stops writing, so the
    // control keeps what the stroke gave it (nothing snaps back to the baseline the way the
    // "rest" cancel unwinds), and the next engagement measures from where the hands are now.
    return {
      state: seeded(),
      active: false,
      justEngaged: false,
      deltaM: 0,
      releaseReason: prev.engaged ? "out-of-view" : "",
      baselineCandidateM: distanceM,
      strokeDirection: prev.engaged ? Math.sign(distanceM - prev.baselineM) : 0
    };
  }
  if (path.lowering && prev.engaged) {
    // The lowering veto: the only intent-driven release. It fires on positive evidence, the
    // hands being DISTANCE_LOWERING_DROP_M lower than at the top of the path window. Keeps
    // the value, like "out-of-view", because the user did not ask for the control to move
    // back; they stopped asking for anything.
    //
    // Only the ENGAGED case returns here. While nothing is running the veto works through
    // `path.armed` below, which blocks the engage transition without wiping anything;
    // otherwise the arms-down state would eat its own recovery.
    return {
      state: seeded(),
      active: false,
      justEngaged: false,
      deltaM: 0,
      releaseReason: "lowering",
      baselineCandidateM: distanceM,
      strokeDirection: Math.sign(distanceM - prev.baselineM)
    };
  }

  const dtS = prev.lastMs > 0 ? Math.max(0, now - prev.lastMs) / 1000 : 0;
  const next = { ...prev, ...stepDistanceExtremum(prev, distanceM, dtS), lastMs: now };

  // The ratchet's stillness detector. A reading that keeps landing within
  // DISTANCE_STABILITY_REL of itself survives; anything else restarts the clock. Not the
  // baseline (see DISTANCE_EXTREMUM_LEAK_S): its only job is to notice that a stroke has
  // stopped somewhere.
  if (
    next.stillM <= 0
    || relativeDeviation(distanceM, next.stillM) > DISTANCE_STABILITY_REL
  ) {
    next.stillM = distanceM;
    next.stillSinceMs = now;
  }

  // The eye-level pose, engaged side. The caller already applied the looser release
  // margins, so this only fires once the hands have really left the pose, and only after
  // DISTANCE_POSE_RELEASE_MS of it. Keeps the value.
  if (next.engaged) {
    next.poseLostSinceMs = poseOk ? 0 : (prev.poseLostSinceMs || now);
    if (!poseOk && now - next.poseLostSinceMs >= DISTANCE_POSE_RELEASE_MS) {
      return {
        state: seeded(),
        active: false,
        justEngaged: false,
        deltaM: 0,
        releaseReason: "pose",
        baselineCandidateM: distanceM,
        strokeDirection: Math.sign(distanceM - prev.baselineM)
      };
    }
  }

  const baselineCandidateM = distanceBaselineFor(next, distanceM, path.direction);

  let justEngaged = false;
  let releaseReason = "";
  let strokeDirection = 0;
  if (!next.engaged) {
    // THE REVERSAL GUARD. An engage in the opposite direction to the stroke that just ended
    // has to be more convincing, because the outward swing of an arm-drop always follows an
    // inward zoom-out stroke and looks exactly like a deliberate re-spread.
    const reversing = path.reverseGuarded
      && path.direction !== 0
      && path.lastStrokeDirection !== 0
      && Math.sign(path.direction) === -Math.sign(path.lastStrokeDirection);
    const requiredRatio = reversing ? DISTANCE_PATH_REVERSE_RATIO : DISTANCE_PATH_ENGAGE_RATIO;
    const requiredRel = reversing
      ? DISTANCE_ENGAGE_REL * DISTANCE_PATH_REVERSE_TRAVEL_SCALE
      : DISTANCE_ENGAGE_REL;
    if (
      canEngage
      && intent
      && path.armed
      && poseOk
      && path.ratio >= requiredRatio
      // The hands are too close together to be talking about the sphere. Engage only; the
      // extremum above kept tracking, so a stroke from hands nearly touching is available as
      // soon as they are far enough apart. See DISTANCE_MIN_SEPARATION_M.
      && distanceM >= DISTANCE_MIN_SEPARATION_M
      && baselineCandidateM > 0
      && relativeDeviation(distanceM, baselineCandidateM) >= requiredRel
    ) {
      next.engaged = true;
      next.baselineM = baselineCandidateM;
      next.releaseSinceMs = 0;
      justEngaged = true;
    }
  } else if (
    // THE RATCHET. The hands have held still long enough, and where they stopped is past
    // the deadband, i.e. the control had actually moved there. Let go HERE: the caller stops
    // writing, so the control keeps the stroke's value and the next engagement baselines from
    // there, which is how repeated strokes accumulate. Checked BEFORE the return-to-rest
    // branch because a settle inside the release bound is a cancel, not a commit; the
    // ordering keeps those apart.
    next.stillM > 0
    && now - next.stillSinceMs >= DISTANCE_COMMIT_MS
    && relativeDeviation(next.stillM, next.baselineM) > DISTANCE_ENGAGE_REL
  ) {
    strokeDirection = Math.sign(next.stillM - next.baselineM);
    releaseReason = "committed";
    return {
      state: seeded(),
      active: false,
      justEngaged: false,
      deltaM: 0,
      releaseReason,
      baselineCandidateM: distanceM,
      strokeDirection
    };
  } else if (relativeDeviation(distanceM, next.baselineM) <= DISTANCE_RELEASE_REL) {
    if (!next.releaseSinceMs) {
      next.releaseSinceMs = now;
    }
    if (now - next.releaseSinceMs >= DISTANCE_RELEASE_GRACE_MS) {
      // The control is back at the value it engaged with: this exit is the CANCEL, and the
      // only one that unwinds.
      releaseReason = "rest";
      return {
        state: seeded(),
        active: false,
        justEngaged: false,
        deltaM: 0,
        releaseReason,
        baselineCandidateM: distanceM,
        strokeDirection: 0
      };
    }
  } else {
    next.releaseSinceMs = 0;
  }

  if (!next.engaged) {
    return {
      state: next,
      active: false,
      justEngaged: false,
      deltaM: 0,
      releaseReason,
      baselineCandidateM,
      strokeDirection
    };
  }

  const raw = distanceM - next.baselineM;
  const deadbandM = DISTANCE_ENGAGE_REL * next.baselineM;
  const magnitude = Math.max(0, Math.abs(raw) - deadbandM);
  return {
    state: next,
    active: true,
    justEngaged,
    deltaM: Math.sign(raw) * magnitude,
    releaseReason,
    baselineCandidateM,
    strokeDirection: Math.sign(raw)
  };
}

// Anti-windup for a control the caller CLAMPS after this module has written it. The
// gesture writes `baseline + travel` every frame; when that lands past the end of the
// range, the clamp throws the excess away but the BASELINE still remembers it, so
// backing off does nothing until the hands have unwound the whole overshoot. On a range
// the gesture can overshoot by a factor of two in one stroke (the sphere zoom can), that
// reads as being stuck against the end.
//
// Given the value that actually survived the clamp, this returns the baseline that would
// have produced it, so the next millimetre of hand travel moves the control again.
// Returns `baseline` unchanged when nothing was clamped.
function reanchorBaselineAfterClamp(baseline, travel, appliedValue) {
  if (!Number.isFinite(baseline) || !Number.isFinite(travel) || !Number.isFinite(appliedValue)) {
    return baseline;
  }
  const wanted = baseline + travel;
  return Math.abs(appliedValue - wanted) < 1e-9 ? baseline : appliedValue - travel;
}

function metresForDiag(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function finiteVec3(v) {
  return Boolean(v) && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// The eye-level pose. `engaged` picks the looser release margins. Missing or non-finite
// head/hand vectors are UNREADABLE and pass: an unknown is not a refusal (same rule as
// the viewport gate), and input.js supplies all four whenever both hands are positioned.
// Looking straight up or down leaves no horizontal forward, so only the forward test is
// skipped then.
//
// `failed` is the first failing test in the order height, level, front.
function distancePoseCheck({
  leftHandPosition,
  rightHandPosition,
  headPosition,
  headForward,
  engaged = false
} = {}) {
  const none = {
    readable: false,
    ok: true,
    failed: "",
    heightDiffM: NaN,
    leftEyeOffsetM: NaN,
    rightEyeOffsetM: NaN,
    leftForwardM: NaN,
    rightForwardM: NaN
  };
  if (
    !finiteVec3(leftHandPosition)
    || !finiteVec3(rightHandPosition)
    || !finiteVec3(headPosition)
    || !finiteVec3(headForward)
  ) {
    return none;
  }
  const levelM = engaged ? DISTANCE_POSE_LEVEL_RELEASE_M : DISTANCE_POSE_LEVEL_M;
  const belowM = engaged ? DISTANCE_POSE_EYE_BELOW_RELEASE_M : DISTANCE_POSE_EYE_BELOW_M;
  const aboveM = engaged ? DISTANCE_POSE_EYE_ABOVE_RELEASE_M : DISTANCE_POSE_EYE_ABOVE_M;
  const forwardMinM = engaged ? DISTANCE_POSE_FORWARD_RELEASE_M : DISTANCE_POSE_FORWARD_M;

  const leftEyeOffsetM = leftHandPosition.y - headPosition.y;
  const rightEyeOffsetM = rightHandPosition.y - headPosition.y;
  const heightDiffM = Math.abs(leftHandPosition.y - rightHandPosition.y);

  let leftForwardM = NaN;
  let rightForwardM = NaN;
  const flatLen = Math.hypot(headForward.x, headForward.z);
  if (flatLen >= 0.1) {
    const fx = headForward.x / flatLen;
    const fz = headForward.z / flatLen;
    leftForwardM = ((leftHandPosition.x - headPosition.x) * fx) + ((leftHandPosition.z - headPosition.z) * fz);
    rightForwardM = ((rightHandPosition.x - headPosition.x) * fx) + ((rightHandPosition.z - headPosition.z) * fz);
  }

  const inBand = (offset) => offset >= -belowM && offset <= aboveM;
  let failed = "";
  if (!inBand(leftEyeOffsetM) || !inBand(rightEyeOffsetM)) {
    failed = "height";
  } else if (heightDiffM > levelM) {
    failed = "level";
  } else if (
    (Number.isFinite(leftForwardM) && leftForwardM < forwardMinM)
    || (Number.isFinite(rightForwardM) && rightForwardM < forwardMinM)
  ) {
    failed = "front";
  }
  return {
    readable: true,
    ok: failed === "",
    failed,
    heightDiffM,
    leftEyeOffsetM,
    rightEyeOffsetM,
    leftForwardM,
    rightForwardM
  };
}

// WHY THE GESTURE IS NOT ENGAGING, as one word. The `handgesture` diag logs a line on
// engage and on release, so without this a refused engage leaves no evidence and "the
// zoom just doesn't work" sessions produce nothing.
//
// Returns the FIRST binding gate in the order the gesture applies them, or "" when
// nothing is binding (engaged, or free to engage once the hands travel far enough). The
// caller emits one line per TRANSITION of this value, never one per frame.
//
//   ""            nothing refusing: engaged, or merely not there yet
//   "wrist"       a fingertip is on (or arriving at) a wrist panel: a poke, not a zoom,
//                 however the gap between the hands reads
//   "view"        a tracked hand is outside the viewport
//   "pose-height" / "pose-level" / "pose-front"
//                 the hands are not raised to eye level, level, in front
//   "settle"      DISTANCE_TRACKING_SETTLE_MS has not elapsed
//   "lowering"    the arms are coming down right now
//   "rearm"       disarmed: the post-release blackout, or the arms are down and have not
//                 been held at a steady height long enough
//   "intent"      the instantaneous share says this is not a separation
//   "path"        the 600 ms net displacement says this is not a separation
//   "near"        the hands are closer together than DISTANCE_MIN_SEPARATION_M
//   "no-baseline" nothing to deviate FROM: no separation reading yet
//
// `unobservable` covers the frames where a refusal would be meaningless: the gates
// outside this gesture are shut (a pinch, an open panel, the stop pose), or the hands
// are not being seen. Logging them would bury the real refusals.
function distanceRefusalGate({
  engaged,
  unobservable,
  wristNear,
  inView,
  poseFailed = "",
  settled,
  lowering,
  armed,
  intent,
  pathOk,
  nearHands,
  hasBaseline
}) {
  if (engaged) {
    return "";
  }
  // Named BEFORE `unobservable`, deliberately: the wrist gate shuts the same outer door
  // `launcherCapturing` does, and if it were folded into "nothing to see here" it would be
  // the one refusal that never appears in the log.
  if (wristNear) {
    return "wrist";
  }
  if (unobservable) {
    return "";
  }
  if (!inView) {
    return "view";
  }
  if (poseFailed) {
    return `pose-${poseFailed}`;
  }
  if (!settled) {
    return "settle";
  }
  if (lowering) {
    return "lowering";
  }
  if (armed === false) {
    return "rearm";
  }
  if (!intent) {
    return "intent";
  }
  if (pathOk === false) {
    return "path";
  }
  if (nearHands) {
    return "near";
  }
  if (!hasBaseline) {
    return "no-baseline";
  }
  return "";
}

// The tree

function createHandGestureState() {
  return {
    // The internal, clamped gesture clock (rule 4). Every *SinceMs below is a reading of
    // THIS, not of performance.now().
    frameClock: createFrameClock(),
    pinch: { left: createPinchState(), right: createPinchState() },
    // Last frame's DEBOUNCED pinch verdict per hand. Carried forward unchanged across a
    // short absence (rule 1), so a blink produces no edge at all.
    pinching: { left: false, right: false },
    // When each hand's source stopped being present, 0 while it is present. The dropout
    // grace is measured from here.
    handAbsentSinceMs: { left: 0, right: 0 },
    // Was the select level true last frame? Only used to log the decision edge.
    selectLevel: false,
    // Scoped to one select-hand contact: armed when that contact began CHORD_LEAD_MS after
    // the rotate hand's, resolved once it has fired or refused.
    chordArmed: false,
    chordSinceMs: 0,
    chordSamples: 0,
    chordResolved: false,
    // Rule 3, the real "once per chord" guard. Set when a chord arms, cleared ONLY by an
    // observed release of the select hand's button. An absence, of any length, never clears
    // it.
    chordSpent: false,
    rotateActive: false,
    // The release-edge debounce: when the rotate hand's raw pinch first read UP during an
    // engaged drag, and the release velocity as it stood at that instant. See
    // ROTATE_RELEASE_DEBOUNCE_MS.
    rotateReleasePendingSinceMs: 0,
    rotateReleaseVelCaptured: false,
    rotateReleaseVelLateralMps: 0,
    rotateReleaseVelVerticalMps: 0,
    // The grab: the position channel's displacement bookkeeping, applied-angle ledger and
    // release-velocity EMA, all scoped to one contact. See createGrabState().
    grab: createGrabState(),
    // The drag's own displacement history, kept so the tree can differentiate it on the
    // CLAMPED clock: a hitch delivers a displacement step with no time attached, and
    // dividing by that would manufacture a throw out of a stall.
    rotateSampleMs: 0,
    rotateLateralM: 0,
    rotateVerticalM: 0,
    rotateSpeedMps: 0,
    // The same velocity as a VECTOR: the throw needs a direction, not just a magnitude,
    // because it imparts spin.
    rotateVelLateralMps: 0,
    rotateVelVerticalMps: 0,
    // How long the engaged drag has sat inside the deadzone: the brake's hold.
    rotateBrake: createGracedWindow(),
    // Whether the brake's centre gate was satisfied WHERE THIS CONTACT STARTED. Latched on
    // justEngaged for the whole contact, so a hand that drifts off centre while holding
    // still does not lose the brake half way through.
    rotateBrakeGateOk: true,
    rotateBraking: false,
    // The throw's window: how long the hand has been moving fast enough, plus the Schmitt
    // latch that keeps one fling from firing as several.
    throwWindow: createGracedWindow(),
    throwSpent: false,
    // The stop pose's stability window, as a graced window (rule 5): hands that blink out of
    // the pose hold the clock rather than restarting it.
    stopPose: createGracedWindow(),
    stopActive: false,
    // `stopLatched` outlives the pose; the two anchors are the hand heights the pose engaged
    // at, and are the ONLY reference the release is measured against.
    stopLatched: false,
    stopRearmBlocked: false,
    stopAnchorLeftY: NaN,
    stopAnchorRightY: NaN,
    stopReleaseSinceMs: 0,
    stopWasPaused: false,
    // When both hands last STARTED being continuously positioned: the distance gesture's
    // engage gate. A graced window, because the stream drops both hands for a few
    // milliseconds constantly and a scalar reset to zero on every one of them.
    handsTracked: createGracedWindow(),
    distance: createDistanceState(),
    // The motion-intent test: is what the hands are doing dominantly a SEPARATION or
    // dominantly a common sweep? Kept beside the distance state because it has to keep
    // sampling across the frames the gesture itself is wiped on.
    distanceIntent: createDistanceIntentState(),
    // Which gate is currently keeping the distance gesture from engaging, or "" when none.
    // Diagnostics only: it lets the tree emit ONE line per TRANSITION into a refused state
    // instead of a line per frame. See distanceRefusalGate() and the `distance / refused`
    // event below.
    distanceRefusedGate: "",
    // Clock of the last `pose-*` refusal line (DISTANCE_POSE_DIAG_INTERVAL_MS).
    distancePoseLoggedMs: 0
  };
}

// Resolve one frame. Returns { state, select, rotate, stop, distance, genAi, reason },
// never mutating `prev`; the caller stores `state` and carries the rest out.
//
//   now                  performance.now(). Only consumed through stepFrameClock():
//                        every threshold in here is measured on the CLAMPED internal
//                        clock, so a hitch cannot buy a hold (rule 4).
//   appState             state.appState
//   panelOpen            isPanelVisible(): main, help or the idle start panel
//   launcherCapturing    isWristLauncherCapturingSelect(): a poke is in progress
//   wristPokeNear        isWristPokeNear() (wristui.js): a fingertip is in a visible
//                        wrist panel's poke band, or pressed on it. Suppresses the
//                        DISTANCE gesture only (the "wrist" refusal)
//   genAiPending         a variation batch is already launching / in flight
//   sphereRotationPaused state.sphereRotationPaused, so the stop signal can put it back
//                        the way it found it
//   selectHandedness     freeHand(): the hand NOT wearing the wrist launcher
//   left/rightPresent    a hand input source for that side this frame
//   left/rightPositioned a usable anchor position for that side this frame
//   left/rightPinch      raw pinch button state (noisy; debounced here)
//   left/rightMicrogestureEdge  a microgesture fired on that hand this frame
//   left/rightPalmForwardDot    palm normal . view direction, NaN when unreadable
//   left/rightHandHeightM  that hand anchor's world height, NaN when untracked; only
//                        the stop latch reads it, and only as a DELTA against the height
//                        it captured on engagement
//   handDistanceM        HORIZONTAL separation between the two hand anchors: the
//                        hand-to-hand vector projected onto camera-right (input.js),
//                        NOT the raw 3-D distance, so lowering both hands together
//                        changes nothing. Done at the measurement so this module still
//                        takes one scalar
//   left/rightHandNdc    that hand's world position projected through the ACTIVE CAMERA
//                        into normalised device coordinates, `{ x, y, behind }`
//                        (input.js), or null when there is no reading
//   left/rightHandPosition, headPosition, headForward
//                        `{ x, y, z }` in one frame (input.js: the wrist anchors, the
//                        camera position and view direction), null when unread. Only
//                        the eye-level pose gate reads them (distancePoseCheck())
//   rotatePalmUp         the rotate hand's palm is turned toward world-up
//   rotateLateralM       sideways drag of the rotate hand since the drag engaged
//   rotateVerticalM      vertical drag of the rotate hand since the drag engaged
//
// `select` is a LEVEL, not an edge: input.js owns xrSelectLatch and the panel-ray
// routing that reads it, so handing it a level keeps exactly one place that turns a held
// pinch into a single activation.
function resolveHandGestures(prev, {
  now,
  appState,
  panelOpen,
  launcherCapturing,
  // A fingertip is on, or arriving at, one of the wrist panels. Distinct from
  // `launcherCapturing`, the freeze LATCH, which is later and stickier: this is the
  // geometry, and the only thing that can tell a wrist poke from a zoom-out, because a
  // hand travelling to the other wrist IS two hands converging. Distance gesture only.
  wristPokeNear,
  genAiPending,
  sphereRotationPaused,
  selectHandedness,
  leftPresent,
  rightPresent,
  leftPositioned,
  rightPositioned,
  leftPinch,
  rightPinch,
  leftMicrogestureEdge,
  rightMicrogestureEdge,
  leftPalmForwardDot,
  rightPalmForwardDot,
  leftHandHeightM,
  rightHandHeightM,
  handDistanceM,
  leftHandNdc,
  rightHandNdc,
  leftHandPosition = null,
  rightHandPosition = null,
  headPosition = null,
  headForward = null,
  rotatePalmUp,
  // The ROTATE hand's own NDC, read even when the other hand is untracked (the distance
  // gesture's pair above needs both hands and this does not). Only the brake's centre gate
  // consumes it.
  rotateHandNdc,
  rotateLateralM,
  rotateVerticalM,
  // The grab model's extra inputs.
  //
  // The two position gains, in radians of sphere per metre of hand
  // (HAND_SPHERE_YAW_RAD_PER_M / _PITCH_RAD_PER_M, constants.js). Passed in rather than
  // imported because this module is dependency-free, as stepHandDragSpeed() takes
  // `maxSpeed`. They default to ZERO (no position channel at all), the safe direction to
  // fail in; input.js always supplies them.
  //
  // `rotateGainScale` is handDragGainScale() in input.js: the zoom-based gain on the
  // POSITION path, floored at POSITION_GAIN_ZOOM_MIN and deliberately not
  // sphereRotationAccelScale().
  //
  // The two sphere speeds are what the sphere is currently carrying. The release handoff
  // is ADDITIVE, so the tree has to say what the sphere ends up at, not merely what the
  // flick was worth, or "two consecutive flicks end faster than one" would not be provable
  // offline. Safe to read: resolveHandGestures() runs before applyHandRotateDrag(), and on
  // a release frame the drag returns early, so nothing has moved them since.
  rotateYawGainRadPerM = 0,
  rotatePitchGainRadPerM = 0,
  rotateGainScale = 1,
  sphereYawSpeedRadPerS = 0,
  spherePitchSpeedRadPerS = 0
}) {
  const selectHand = selectHandedness === "left" ? "left" : "right";
  const rotateHand = otherHand(selectHand);

  // The clamped gesture clock (rule 4). EVERY threshold below is measured on `clock`,
  // never on the raw `now`, so a stall cannot buy a hold and a variable frame rate cannot
  // change what a gesture means.
  const frame = stepFrameClock(prev.frameClock, now);
  const clock = frame.clockMs;
  // How much time the CLAMPED clock advanced this frame, in seconds. The grab's rate clamp
  // and its velocity EMA both integrate and must do so on the clock every other threshold
  // uses: a hitch advances it by nothing, so a stall hands the position map no travel
  // allowance rather than a frame's worth of teleport.
  const clockStepS = (prev.frameClock && prev.frameClock.started)
    ? Math.max(0, clock - prev.frameClock.clockMs) / 1000
    : 0;

  const present = { left: Boolean(leftPresent), right: Boolean(rightPresent) };
  const rawPinch = { left: Boolean(leftPinch), right: Boolean(rightPinch) };

  // Rule 1. A hand that is not present this frame said NOTHING this frame. For
  // HAND_DROPOUT_GRACE_MS its contact and verdict are frozen as they were; only past that
  // is silence read as "the hand is gone".
  const prevAbsentSince = prev.handAbsentSinceMs || { left: 0, right: 0 };
  const handAbsentSinceMs = {
    left: present.left ? 0 : (prevAbsentSince.left || clock),
    right: present.right ? 0 : (prevAbsentSince.right || clock)
  };
  const prevPinching = prev.pinching || { left: false, right: false };
  const graceHeld = {
    left: !present.left && clock - handAbsentSinceMs.left <= HAND_DROPOUT_GRACE_MS,
    right: !present.right && clock - handAbsentSinceMs.right <= HAND_DROPOUT_GRACE_MS
  };

  function stepHand(hand, pressed, microgestureEdge) {
    if (present[hand]) {
      return updatePinchState(prev.pinch[hand], { pressed, now: clock, microgestureEdge });
    }
    // Absent. Hold the contact untouched through the grace, then let it go.
    return graceHeld[hand] ? { ...prev.pinch[hand] } : createPinchState();
  }

  const pinch = {
    left: stepHand("left", rawPinch.left, leftMicrogestureEdge),
    right: stepHand("right", rawPinch.right, rightMicrogestureEdge)
  };

  const pinching = {
    left: present.left
      ? pinchHeldMs(pinch.left, clock) >= 0
      : (graceHeld.left ? Boolean(prevPinching.left) : false),
    right: present.right
      ? pinchHeldMs(pinch.right, clock) >= 0
      : (graceHeld.right ? Boolean(prevPinching.right) : false)
  };
  const pinchCount = (pinching.left ? 1 : 0) + (pinching.right ? 1 : 0);
  const wasPinching = prevPinching;

  // Rule 2's raw material: WHEN each counting pinch physically started. Taken from the
  // contact's own press timestamp rather than the frame the debounced verdict flipped on,
  // so the debounce cancels from both sides and the lead is the lead the user performed.
  const pinchStartMs = {
    left: pinching.left ? pinch.left.sinceMs : 0,
    right: pinching.right ? pinch.right.sinceMs : 0
  };

  const events = [];
  const next = { ...prev, frameClock: frame.state, pinch, pinching, handAbsentSinceMs };

  // A blink that would otherwise have read as a release, reported once per blink (never
  // per frame). Its absence from a device log says the dropout theory is not what happened.
  for (const hand of ["left", "right"]) {
    if (graceHeld[hand] && !prevAbsentSince[hand] && prevPinching[hand]) {
      events.push({
        decision: "presence",
        outcome: "grace-held",
        hand,
        reason: "absent-holding-pinch",
        note: `hands ${hand} dropout -> pinch held through grace`
      });
    }
    if (!present[hand] && !graceHeld[hand] && prevPinching[hand]) {
      events.push({
        decision: "presence",
        outcome: "grace-expired",
        hand,
        reason: "absent-too-long",
        note: `hands ${hand} dropout -> pinch released (grace expired)`
      });
    }
  }

  // Chord arming: the ordering rule, as a timestamp comparison (rules 2 and 3). The chord
  // is armed at the instant the SELECT hand's pinch starts counting, and only if the rotate
  // hand's pinch physically started at least CHORD_LEAD_MS earlier. A tie, or anything
  // closer than the lead, resolves to Select, the reading that bills nobody. Armed state is
  // sticky for the whole select-hand contact, which stops an asymmetric release (the rotate
  // pinch letting go a beat before the select pinch) from leaving a lingering single pinch
  // that commits a select.
  //
  // `chordSpent` is the once-per-chord guard, keyed off an OBSERVED button release rather
  // than `!pinching[selectHand]`: the latter is produced for free by a dropout, and a
  // dropout must never be able to re-arm a chord.
  const selectReleaseObserved = present[selectHand] && !rawPinch[selectHand];
  next.chordSpent = Boolean(prev.chordSpent) && !selectReleaseObserved;

  const chordLeadMs = pinchStartMs[rotateHand] > 0 && pinchStartMs[selectHand] > 0
    ? pinchStartMs[selectHand] - pinchStartMs[rotateHand]
    : NaN;

  if (!pinching[selectHand]) {
    next.chordArmed = false;
    next.chordSinceMs = 0;
    next.chordSamples = 0;
    next.chordResolved = false;
  } else if (!wasPinching[selectHand]) {
    const armed = !next.chordSpent
      // We must have WATCHED this select pinch arrive, not inferred it from a gap. This guards
      // absences longer than the dropout grace, which are the common case, not the exotic one.
      && Boolean(pinch[selectHand].observedStart)
      && pinching[rotateHand]
      && Number.isFinite(chordLeadMs)
      && pinchStartMs[rotateHand] + CHORD_LEAD_MS <= pinchStartMs[selectHand];
    next.chordArmed = armed;
    next.chordSinceMs = armed ? clock : 0;
    next.chordSamples = 0;
    next.chordResolved = false;
    if (armed) {
      // Spent from the moment it arms, not from the moment it fires: a refused chord must not
      // be retried by a blink either.
      next.chordSpent = true;
      events.push({
        decision: "chord",
        outcome: "armed",
        reason: "",
        leadMs: chordLeadMs,
        note: "hands chord -> armed"
      });
    }
  }

  // The chord: GenAI variation in the sphere, TUNNEL JUMP in the tunnel. The ordered chord
  // keeps one gesture with a second meaning chosen by app state; the pump maps the target
  // onto the two existing entry points.
  //
  // `chordTarget` is the decision, `genAi` stays as the boolean the pump reads for the
  // sphere case. Everything in front of it is shared: the CHORD_LEAD_MS ordering, the
  // confirm hold, the sample count, the chord-broken refusal, and `chordSpent`, which keeps
  // it once per chord in either state.
  //
  // A TRANSITION fires nothing. `appState` is neither named constant while the camera is
  // flying; arming there is harmless (it only suppresses a select that state would refuse
  // anyway) but firing must not be.
  let chordTarget = null;
  let genAi = false;
  let reason = "";
  if (next.chordArmed && !next.chordResolved) {
    // Hitch frames deliver no evidence, so they buy no confirm hold (rule 4).
    next.chordSamples = (next.chordSamples || 0) + (frame.hitch ? 0 : 1);
    if (!pinching[rotateHand]) {
      // The rotate half let go before the confirm hold completed. Refuse for the rest of this
      // contact rather than re-arming a timer that could fire with only one hand pinched: a
      // broken chord bills nobody.
      next.chordResolved = true;
      reason = "chord-broken";
    } else if (
      clock - next.chordSinceMs >= GENAI_CONFIRM_HOLD_MS
      && next.chordSamples >= GENAI_CONFIRM_MIN_SAMPLES
    ) {
      // Resolve exactly once per chord, fired or refused. A refusal that re-tested every frame
      // would spam the readout and could fire the instant a guard cleared mid-hold.
      next.chordResolved = true;
      if (launcherCapturing) {
        reason = "launcher-poke";
      } else if (panelOpen) {
        reason = "panel-open";
      } else if (appState === APP_STATE_INSIDE_SPHERE) {
        if (genAiPending) {
          // Mirrors the first guard inside activateSelectedSphereImageForGenAi(), which stays the
          // authority; the early copy lets the DEV readout say "genai-pending" instead of a bare
          // "fired".
          reason = "genai-pending";
        } else {
          chordTarget = "genai";
        }
      } else if (appState === APP_STATE_TUNNEL) {
        chordTarget = "tunnelJump";
      } else {
        reason = "wrong-state";
      }
    }
  }
  genAi = chordTarget === "genai";
  if (chordTarget) {
    events.push({
      decision: "chord",
      outcome: "fired",
      reason: "",
      target: chordTarget,
      leadMs: chordLeadMs,
      note: chordTarget === "genai"
        ? "hands chord -> genai variation"
        : "hands chord -> jump to sphere"
    });
  } else if (reason) {
    events.push({
      decision: "chord",
      outcome: "ignored",
      reason,
      leadMs: chordLeadMs,
      note: `hands chord -> ignored (${reason})`
    });
  }

  // Select: the select hand's pinch, alone, on the press edge. No hold and no presence
  // penalty. If the chord is armed this contact belongs to GenAI and never selects;
  // otherwise the pinch is a select the moment it clears the debounce. The launcher swallow
  // is the same window that swallows pinch-select elsewhere: a pinch made while reaching
  // for the wrist must not also navigate the sphere behind it.
  const select = pinching[selectHand] && !next.chordArmed && !launcherCapturing;
  next.selectLevel = select;
  if (select && !prev.selectLevel) {
    events.push({
      decision: "select",
      outcome: "fired",
      reason: "",
      leadMs: chordLeadMs,
      note: "hands select -> fired"
    });
  }

  // The rotate hand's pinch, alone: yaw + pitch drag. The release-edge debounce is resolved
  // before eligibility so the rest of the tree cannot tell a bridged frame from a pinching
  // one. `pinching` itself is NOT touched: pinchCount, the select level, the chord and the
  // distance gesture read what they always did. Only the rotate contact is held open.
  //
  // A hand that has gone ABSENT is not this rule's business: the dropout grace already
  // holds `pinching[rotateHand]` true through HAND_DROPOUT_GRACE_MS, and a second hold on
  // top would extend a drag past the point where the tree has decided the hand is gone.
  //
  // Once a contact is running it is already validated, so the RAW button is enough to keep
  // it alive. Re-paying PINCH_DEBOUNCE_MS (80 ms) inside a 100 ms bridge would barely fit;
  // the rising debounce owns only contacts that do not exist yet.
  const rotatePinchDown = Boolean(pinching[rotateHand])
    || (Boolean(prev.rotateActive) && Boolean(rawPinch[rotateHand]) && present[rotateHand]);
  let rotateReleasePendingSinceMs = prev.rotateReleasePendingSinceMs || 0;
  let rotateReleaseVelCaptured = Boolean(prev.rotateReleaseVelCaptured);
  let rotateReleaseVelLateralMps = prev.rotateReleaseVelLateralMps || 0;
  let rotateReleaseVelVerticalMps = prev.rotateReleaseVelVerticalMps || 0;
  let rotateReleaseBridged = false;
  if (!prev.rotateActive || rotatePinchDown || !present[rotateHand]) {
    rotateReleasePendingSinceMs = 0;
    rotateReleaseVelCaptured = false;
    rotateReleaseVelLateralMps = 0;
    rotateReleaseVelVerticalMps = 0;
  } else {
    if (!rotateReleasePendingSinceMs) {
      rotateReleasePendingSinceMs = clock;
      // THE LET-GO INSTANT. Snapshot the EMA now, because the hand starts decelerating the
      // moment it opens: reading it when the window expires would eat every flick.
      const grabAtRelease = prev.grab || createGrabState();
      rotateReleaseVelCaptured = true;
      rotateReleaseVelLateralMps = grabAtRelease.velLateralMps || 0;
      rotateReleaseVelVerticalMps = grabAtRelease.velVerticalMps || 0;
    }
    rotateReleaseBridged = clock - rotateReleasePendingSinceMs < ROTATE_RELEASE_DEBOUNCE_MS;
  }
  // The bridged frames carry the drag but not the pinch, which tells the grab to FREEZE
  // rather than follow a hand that is no longer holding anything.
  const rotatePinchEffective = rotatePinchDown || rotateReleaseBridged;
  const rotateOtherPinching = Boolean(pinching[selectHand]);
  const rotateEligible = rotatePinchEffective
    && !rotateOtherPinching
    && !launcherCapturing
    && !panelOpen
    && appState === APP_STATE_INSIDE_SPHERE
    && !rotatePalmUp;
  const dragging = rotateEligible && prev.rotateActive;
  const rotate = {
    active: rotateEligible,
    justEngaged: rotateEligible && !prev.rotateActive,
    // The falling edge, which the dwell reset reads: the clock must be zeroed on BOTH edges
    // of a drag, not merely held down in between.
    justReleased: Boolean(prev.rotateActive) && !rotateEligible,
    // Zero on the engaging frame: the caller anchors the drag origin then, so any offset
    // carried in from before is meaningless. Yaw and pitch use the same shape through
    // different distances (see rotateDeflection()).
    deflection: dragging ? rotateYawDeflection(rotateLateralM) : 0,
    // Vertical drag -> sphere pitch, the axis the right thumbstick's Y drives. Positive = the
    // hand moved UP.
    pitchDeflection: dragging ? rotatePitchDeflection(rotateVerticalM) : 0
  };
  next.rotateActive = rotate.active;
  // A contact that ends for any OTHER reason (the select hand pinched, the panel opened,
  // the palm turned over) closes the bridge with it: there is nothing left to re-assert
  // into.
  next.rotateReleasePendingSinceMs = rotate.active ? rotateReleasePendingSinceMs : 0;
  next.rotateReleaseVelCaptured = rotate.active ? rotateReleaseVelCaptured : false;
  next.rotateReleaseVelLateralMps = rotate.active ? rotateReleaseVelLateralMps : 0;
  next.rotateReleaseVelVerticalMps = rotate.active ? rotateReleaseVelVerticalMps : 0;
  if (rotate.justEngaged) {
    events.push({
      decision: "rotate",
      outcome: "engaged",
      reason: "",
      note: "hands pinch-drag -> sphere yaw/pitch engaged"
    });
  } else if (prev.rotateActive && !rotate.active) {
    events.push({
      decision: "rotate",
      outcome: "released",
      reason: "",
      note: "hands pinch-drag -> released"
    });
  }

  // A pinch is a grab: the brake and the throw. Both read the SAME displacement the drag
  // is already steered by, so there is no second measurement of the hand to keep in step.
  const dragLateralM = Number.isFinite(rotateLateralM) ? rotateLateralM : 0;
  const dragVerticalM = Number.isFinite(rotateVerticalM) ? rotateVerticalM : 0;
  const dragTravelM = Math.hypot(dragLateralM, dragVerticalM);

  // Hand speed, differentiated on the CLAMPED clock. A hitch advances the clock by
  // nothing, so `dtMs` is zero there and the previous reading is carried rather than a
  // displacement being divided by no time, which would manufacture an enormous "throw"
  // out of a stall (the class of bug rule 4 closes).
  //
  // Kept as a VECTOR: the throw needs the direction of the fling, not only how fast it
  // was, because it spins the sphere that way.
  let dragVelLateralMps = 0;
  let dragVelVerticalMps = 0;
  let dragSpeedMps = 0;
  if (dragging && prev.rotateSampleMs > 0) {
    const sampleDtMs = clock - prev.rotateSampleMs;
    if (sampleDtMs > 0) {
      const perSecond = 1000 / sampleDtMs;
      dragVelLateralMps = (dragLateralM - prev.rotateLateralM) * perSecond;
      dragVelVerticalMps = (dragVerticalM - prev.rotateVerticalM) * perSecond;
      dragSpeedMps = Math.hypot(dragVelLateralMps, dragVelVerticalMps);
    } else {
      // A hitch: no time passed on the clamped clock, so carry the last reading rather than
      // dividing a displacement by nothing.
      dragVelLateralMps = prev.rotateVelLateralMps || 0;
      dragVelVerticalMps = prev.rotateVelVerticalMps || 0;
      dragSpeedMps = prev.rotateSpeedMps || 0;
    }
  }
  next.rotateSampleMs = rotate.active ? clock : 0;
  next.rotateLateralM = rotate.active ? dragLateralM : 0;
  next.rotateVerticalM = rotate.active ? dragVerticalM : 0;
  next.rotateSpeedMps = dragSpeedMps;
  next.rotateVelLateralMps = rotate.active ? dragVelLateralMps : 0;
  next.rotateVelVerticalMps = rotate.active ? dragVelVerticalMps : 0;

  // THE BRAKE. An engaged drag parked inside the deadzone is a hand holding the sphere
  // still, and has to mean that: a zero rotation SPEED is not what the auto-drift is made
  // of. The graced window is rule 5: a blink mid-hold is not the user letting go. Each
  // axis is tested against ITS OWN deadzone, so "the drag is commanding zero speed" and
  // "the brake is allowed to arm" stay the same statement.
  const dragInsideDeadzone = dragging
    && Math.abs(dragLateralM) <= ROTATE_YAW_DEADZONE_M
    && Math.abs(dragVerticalM) <= ROTATE_PITCH_DEADZONE_M;
  next.rotateBrake = stepGracedWindow(prev.rotateBrake, {
    now: clock,
    active: dragInsideDeadzone,
    unknown: rotate.active && graceHeld[rotateHand]
  });
  // Optional centre gate. Evaluated ONCE, on the frame the contact engages, and latched
  // for its duration: the question is where the grab was made, not where the hand has
  // wandered to during the hold. With the gate off (the default) this is unconditionally
  // true.
  next.rotateBrakeGateOk = rotate.justEngaged
    ? (!ROTATE_BRAKE_CENTER_GATE || handWithinNdcRadius(rotateHandNdc))
    : (rotate.active ? Boolean(prev.rotateBrakeGateOk) : true);
  const braking = dragInsideDeadzone
    && next.rotateBrakeGateOk
    && Boolean(next.rotateBrake.sinceMs)
    && clock - next.rotateBrake.sinceMs >= ROTATE_BRAKE_HOLD_MS;
  next.rotateBraking = braking;

  // THE THROW. Fast, and actually somewhere: both, for long enough. `throwSpent` is the
  // Schmitt half: the hand has to drop back below the release speed before a second throw
  // can arm, so one fling is one throw.
  const throwFast = dragging
    && dragSpeedMps >= ROTATE_THROW_SPEED_MPS
    && dragTravelM >= ROTATE_THROW_MIN_TRAVEL_M;
  next.throwWindow = stepGracedWindow(prev.throwWindow, {
    now: clock,
    active: throwFast,
    unknown: rotate.active && graceHeld[rotateHand]
  });
  next.throwSpent = dragging
    && Boolean(prev.throwSpent)
    && dragSpeedMps > ROTATE_THROW_RELEASE_SPEED_MPS;
  const thrown = throwFast
    && !next.throwSpent
    && Boolean(next.throwWindow.sinceMs)
    && clock - next.throwWindow.sinceMs >= ROTATE_THROW_HOLD_MS;
  if (thrown) {
    next.throwSpent = true;
  }

  // What the throw is worth. A throw ALWAYS produces momentum, in the direction of the
  // fling, scaled by how hard it was and clamped; releasing a latched pause is one of its
  // effects, not the only one (a throw that only unlatched a pause is inert when rotation
  // is already running).
  //
  // The signs mirror applyHandRotateDrag() exactly, because this feeds the very same two
  // speeds: a drag to the RIGHT (positive lateral) drives NEGATIVE yaw, and a drag UPWARD
  // drives positive pitch. Taking that from the drag rather than re-deriving it keeps a
  // throw continuing the motion the hand was already making.
  let throwSpin = null;
  if (thrown) {
    const magnitude = Math.min(
      dragSpeedMps * ROTATE_THROW_SPIN_GAIN_RAD_PER_MPS,
      ROTATE_THROW_SPIN_MAX_RAD_PER_S
    );
    const dirLateral = dragSpeedMps > 0 ? dragVelLateralMps / dragSpeedMps : 0;
    const dirVertical = dragSpeedMps > 0 ? dragVelVerticalMps / dragSpeedMps : 0;
    throwSpin = {
      yawRadPerS: -dirLateral * magnitude,
      pitchRadPerS: dirVertical * magnitude,
      speedMps: dragSpeedMps
    };
  }

  // The grab: displacement -> ANGLE. The position channel is what the drag IS.
  // `rotate.deflection` above survives only for ?drag=vel; nothing here reads it.
  //
  // Ordered after the throw because both differentiate the same displacement, and the
  // grab wants the offset-corrected reading while the throw and the brake keep the raw one
  // they were tuned against.
  const rotatePositioned = rotateHand === "left"
    ? Boolean(leftPositioned)
    : Boolean(rightPositioned);
  const grabPrev = rotate.justEngaged ? createGrabState() : (prev.grab || createGrabState());
  let grab = rotate.active
    ? stepGrabDisplacement(grabPrev, {
      // The BRIDGE reads as unpositioned on purpose: the hand is visible but no longer holding
      // anything, so the map must stop following it. The offset re-anchor then absorbs
      // whatever it did while the pinch was up, which makes a re-assert continue the same
      // stroke instead of restarting it.
      positioned: rotatePositioned && rotatePinchDown,
      rawLateralM: dragLateralM,
      rawVerticalM: dragVerticalM,
      // Extrapolate a TRACKING gap, freeze a pinch gap. Same unpositioned branch, two
      // meanings; see stepGrabDisplacement().
      extrapolate: !rotatePositioned,
      dtS: clockStepS
    })
    : createGrabState();

  let grabDeltaYawRad = 0;
  let grabDeltaPitchRad = 0;
  if (dragging) {
    // Sign convention, identical to the velocity model's and the desktop pointer drag's: a
    // hand moving RIGHT turns the sphere so the content moves right (negative yaw about
    // world +Y), a hand moving UP moves the content up (positive pitch about world +X).
    const targetYawRad = -grabAngleTarget(
      grab.lateralM,
      ROTATE_YAW_DEADZONE_M,
      rotateYawGainRadPerM,
      rotateGainScale
    );
    const targetPitchRad = grabAngleTarget(
      grab.verticalM,
      ROTATE_PITCH_DEADZONE_M,
      rotatePitchGainRadPerM,
      rotateGainScale
    );
    const yawStep = stepGrabAngle(grab.appliedYawRad, targetYawRad, { dtS: clockStepS });
    const pitchStep = stepGrabAngle(grab.appliedPitchRad, targetPitchRad, { dtS: clockStepS });
    grabDeltaYawRad = yawStep.deltaRad;
    grabDeltaPitchRad = pitchStep.deltaRad;
    // THE RELEASE VELOCITY EMA. Fed from the CORRECTED displacement, and only on a frame
    // with two consecutive positioned readings to difference: the re-acquisition frame after
    // a dropout is exactly the frame whose raw delta is a teleport, and it must not reach
    // the throw.
    const sampleable = grab.positioned && grabPrev.positioned && clockStepS > 0;
    grab = {
      ...grab,
      appliedYawRad: yawStep.appliedRad,
      appliedPitchRad: pitchStep.appliedRad,
      velLateralMps: stepReleaseVelocity(grab.velLateralMps, {
        sampleMps: sampleable ? (grab.lateralM - grabPrev.lateralM) / clockStepS : NaN,
        dtS: clockStepS
      }),
      velVerticalMps: stepReleaseVelocity(grab.velVerticalMps, {
        sampleMps: sampleable ? (grab.verticalM - grabPrev.verticalM) / clockStepS : NaN,
        dtS: clockStepS
      })
    };
  }
  next.grab = grab;

  // THE HANDOFF, on the falling edge and nowhere else. `grabPrev` is the state the contact
  // ended with (`grab` has already been wiped because the drag is over): the release frame
  // has no live measurement of its own to read.
  let releaseSpin = null;
  if (rotate.justReleased) {
    releaseSpin = releaseHandoff({
      // THE VELOCITY AT THE TRUE LET-GO INSTANT, not when the release debounce gave up on it.
      // A hand decelerates as soon as it opens, so reading the EMA up to
      // ROTATE_RELEASE_DEBOUNCE_MS later would eat the flick the user performed.
      velLateralMps: rotateReleaseVelCaptured
        ? rotateReleaseVelLateralMps
        : grabPrev.velLateralMps,
      velVerticalMps: rotateReleaseVelCaptured
        ? rotateReleaseVelVerticalMps
        : grabPrev.velVerticalMps,
      netLateralM: grabPrev.lateralM,
      netVerticalM: grabPrev.verticalM,
      yawSpeedRadPerS: sphereYawSpeedRadPerS,
      pitchSpeedRadPerS: spherePitchSpeedRadPerS,
      yawGainRadPerM: rotateYawGainRadPerM,
      pitchGainRadPerM: rotatePitchGainRadPerM,
      zoomGain: Number.isFinite(rotateGainScale) ? rotateGainScale : 1
    });
  }

  // No pinch: the stop signal. Both hands up, open, palms turned away from the face =
  // pause the sphere. Resolved BEFORE the distance gesture and forces it to stand down,
  // because the two poses are otherwise identical (see the header). Sphere-only: pausing
  // rotation in the tunnel would pause something the viewer cannot see.
  //
  // Rule 5: the pose's stability window distinguishes "the user stopped holding it" (hard
  // reset) from "we could not read the hands this frame" (hold the clock through the
  // dropout grace); without that, 250 ms of continuous pose is close to unreachable on
  // the measured stream.
  const stopPoseGatesOpen = pinchCount === 0
    && !launcherCapturing
    && !panelOpen
    && appState === APP_STATE_INSIDE_SPHERE;
  const stopPoseReadable = Boolean(leftPositioned)
    && Boolean(rightPositioned)
    && Number.isFinite(leftPalmForwardDot)
    && Number.isFinite(rightPalmForwardDot);
  const stopPosePresent = stopPoseGatesOpen
    && stopPoseReadable
    && isPalmFacingAway(leftPalmForwardDot)
    && isPalmFacingAway(rightPalmForwardDot);

  next.stopPose = stepGracedWindow(prev.stopPose, {
    now: clock,
    active: stopPosePresent,
    unknown: stopPoseGatesOpen && !stopPoseReadable
  });
  const stopActive = Boolean(next.stopPose.sinceMs)
    && clock - next.stopPose.sinceMs >= STOP_POSE_STABILITY_MS;
  next.stopActive = stopActive;

  // The latch. `setPaused` is the value input.js should drive state.sphereRotationPaused
  // to, or null for "leave it alone".
  //
  // Losing the POSE does nothing: rotating the wrists out of palms-away, or pinching to
  // drag, must not resume. Exactly three things let go:
  //   1. both hands DOWN from where the pose engaged, held STOP_RELEASE_STABILITY_MS;
  //   2. both hands gone (or one gone and one down) for the longer tracking grace, the
  //      same motion seen from outside the tracking volume;
  //   3. leaving the sphere, where the pause means nothing anyway.
  // (1) and (2) restore the pause to whatever the pose found, so a stop signal held over
  // an already-paused sphere never secretly resumes it.
  next.stopLatched = Boolean(prev.stopLatched);
  next.stopAnchorLeftY = prev.stopAnchorLeftY;
  next.stopAnchorRightY = prev.stopAnchorRightY;
  next.stopReleaseSinceMs = prev.stopReleaseSinceMs;
  next.stopWasPaused = prev.stopWasPaused;
  // Set on release, cleared as soon as the pose is gone. Without it, lowering the hands
  // while KEEPING the palms out (the natural release motion) would resume and immediately
  // re-pause, because the pose is still held at the new height. The pose has to be let go
  // of before it can arm again. Graced along with the pose window: if it cleared on a mere
  // dropout, releasing the latch and then blinking would let the surviving pose window
  // re-latch immediately.
  next.stopRearmBlocked = Boolean(prev.stopRearmBlocked) && Boolean(next.stopPose.sinceMs);

  let setPaused = null;
  let stopJustEngaged = false;
  let stopJustReleased = false;
  let stopReleaseReason = "";

  // The ENGAGE transition additionally insists the pose be readable RIGHT NOW, even
  // though the stability window tolerates a gap: the anchors it captures are hand heights,
  // and latching on a frame with no hands in it would store two NaNs and leave the release
  // with nothing to measure against.
  if (stopActive && stopPosePresent && !prev.stopLatched && !next.stopRearmBlocked) {
    next.stopLatched = true;
    next.stopWasPaused = Boolean(sphereRotationPaused);
    // Captured ONCE, on the engaging frame. Not refreshed while the pose is re-held: the
    // release motion is "lower the hands from the stop position", and a user keeping their
    // palms out on the way down would otherwise drag the reference down with them and never
    // let go.
    next.stopAnchorLeftY = Number.isFinite(leftHandHeightM) ? leftHandHeightM : NaN;
    next.stopAnchorRightY = Number.isFinite(rightHandHeightM) ? rightHandHeightM : NaN;
    next.stopReleaseSinceMs = 0;
    stopJustEngaged = true;
    setPaused = true;
  } else if (prev.stopLatched) {
    if (thrown) {
      // The third exit: a throw. Not a contradiction of "a left pinch must not resume the
      // pause", which is about an INCIDENTAL pinch; a fling is not performed by accident.
      // Unlike the other two exits it does NOT restore `stopWasPaused`: a throw is an explicit
      // request for rotation, not a request to put the flag back the way the pose found it.
      next.stopLatched = false;
      next.stopAnchorLeftY = NaN;
      next.stopAnchorRightY = NaN;
      next.stopReleaseSinceMs = 0;
      stopJustReleased = true;
      next.stopRearmBlocked = true;
      stopReleaseReason = "thrown";
      setPaused = false;
    } else if (appState !== APP_STATE_INSIDE_SPHERE) {
      next.stopLatched = false;
      next.stopAnchorLeftY = NaN;
      next.stopAnchorRightY = NaN;
      next.stopReleaseSinceMs = 0;
      stopJustReleased = true;
      next.stopRearmBlocked = true;
      stopReleaseReason = "left-sphere";
      // No setPaused: vrPauseSphereRotation() refuses outside the sphere anyway, and the
      // sphere clears the flag itself on the way back in.
    } else {
      const leftExit = stopHandExit(
        leftPositioned ? leftHandHeightM : NaN,
        next.stopAnchorLeftY
      );
      const rightExit = stopHandExit(
        rightPositioned ? rightHandHeightM : NaN,
        next.stopAnchorRightY
      );
      const bothOut = leftExit !== "up" && rightExit !== "up";
      const anyLost = leftExit === "lost" || rightExit === "lost";
      const graceMs = anyLost ? STOP_RELEASE_TRACKING_GRACE_MS : STOP_RELEASE_STABILITY_MS;
      next.stopReleaseSinceMs = bothOut ? (prev.stopReleaseSinceMs || clock) : 0;
      if (bothOut && clock - next.stopReleaseSinceMs >= graceMs) {
        next.stopLatched = false;
        next.stopAnchorLeftY = NaN;
        next.stopAnchorRightY = NaN;
        next.stopReleaseSinceMs = 0;
        stopJustReleased = true;
        next.stopRearmBlocked = true;
        stopReleaseReason = anyLost ? "tracking-lost" : "hands-down";
        setPaused = Boolean(next.stopWasPaused);
      }
    }
  }

  // The grab writes the SAME pause channel the stop signal does: one pause in the app, one
  // field that names it (`stop.setPaused`), three writers. They cannot collide: the stop
  // pose requires pinchCount === 0 and both of these require a pinch, and the brake
  // requires the hand inside the deadzone while the throw requires it 5 cm outside it.
  let pauseSource = stopJustEngaged
    ? "stop-signal"
    : (stopJustReleased ? `stop-${stopReleaseReason}` : "");
  if (thrown) {
    // "Was anything paused?" Three ways: this throw released the stop latch a few lines
    // above, something was already paused when the frame started, or the brake paused it on
    // this very frame. This question does not decide WHETHER the throw does anything
    // (`rotate.throwSpin` is unconditional), only whether it additionally has a pause to
    // hand back.
    const releasedLatch = stopReleaseReason === "thrown";
    const wasPaused = releasedLatch || Boolean(sphereRotationPaused) || setPaused === true;
    if (wasPaused) {
      setPaused = false;
      pauseSource = "throw";
    }
    events.push({
      decision: "rotate",
      outcome: "thrown",
      // Which of the three it was, because tuning reads this: `stop-latch` and `was-paused`
      // also handed a pause back, `momentum` is a throw into already-running rotation and is
      // the common case.
      reason: releasedLatch ? "stop-latch" : (wasPaused ? "was-paused" : "momentum"),
      note: `hands throw -> spin ${throwSpin.yawRadPerS.toFixed(2)} rad/s${wasPaused ? " (resumed)" : ""}`
    });
  } else if (
    releaseSpin
    && releaseSpin.speedMps >= ROTATE_THROW_SPEED_MPS
    && setPaused === null
    && sphereRotationPaused
  ) {
    // A release hard enough to be a throw hands the pause back too. The latch-release effect
    // is only available mid-drag, where `thrown` fires; under the grab model the fling is
    // measured on the release edge, so the same "this was deliberate" test
    // (ROTATE_THROW_SPEED_MPS) has to be applied there, or a braked sphere could only be
    // restarted by flinging without letting go.
    setPaused = false;
    pauseSource = "release-throw";
    events.push({
      decision: "rotate",
      outcome: "release-throw",
      reason: "was-paused",
      note: `hands release -> spin ${releaseSpin.yawRadPerS.toFixed(2)} rad/s (resumed)`
    });
  } else if (braking && !prev.rotateBraking && setPaused === null) {
    setPaused = true;
    pauseSource = "brake";
    events.push({
      decision: "rotate",
      outcome: "braking",
      reason: "",
      note: "hands pinch-hold -> rotation braked"
    });
  }

  // No pinch: the distance gesture. One gesture, read through appState: TUNNEL means tunnel
  // speed, INSIDE_SPHERE means sphere zoom. They never coexist, so nothing to disambiguate.
  //
  // The stop pose suppresses it from the first frame of the pose when nothing is running
  // yet (no zoom blip while the stability window elapses), but only once the stop signal
  // is actually ACTIVE when a gesture is already engaged, so a single frame of palms-away
  // noise cannot drop a zoom mid-flight.
  //
  // Tracking settle gate: hands entering and leaving the tracking volume must not move the
  // zoom, and the frames either side of a dropout are where the separation reading lies. It
  // is measured on tracking itself rather than the separation, because a bad separation
  // looks perfectly plausible. Rule 5: ~42% of both-hands-present runs are SHORTER than
  // DISTANCE_TRACKING_SETTLE_MS, so a gate that zeroed on one unpositioned frame almost
  // never opened. It is a graced window; only an absence longer than
  // HAND_DROPOUT_GRACE_MS resets the clock.
  //
  // The viewport gate is the deliberate opposite of that grace, and the two must be kept
  // apart. A hand that is TRACKED and outside the frustum is a hand the user took out of
  // the frame: it disengages, and it is not "unknown". A hand that is not positioned says
  // nothing and keeps the grace, which is why the test is only consulted for a positioned
  // hand and why an unreadable projection counts as in view.
  //
  // Leaving the view does not RESET the settle clock. It disengages and blocks an engage
  // for as long as it lasts, but the clock is about how long tracking has been
  // trustworthy, and a hand moving across the frame edge says nothing about that; resetting
  // would make hands brought in from the sides pay a fresh settle after already being on
  // screen.
  const bothPositioned = Boolean(leftPositioned) && Boolean(rightPositioned);
  const leftOutOfView = Boolean(leftPositioned) && !handWithinViewport(leftHandNdc);
  const rightOutOfView = Boolean(rightPositioned) && !handWithinViewport(rightHandNdc);
  const handsInView = !leftOutOfView && !rightOutOfView;
  next.handsTracked = stepGracedWindow(prev.handsTracked, {
    now: clock,
    // TRACKING ONLY. Requiring `handsInView` here would restart the settle on every
    // out-of-view -> in-view transition, so hands brought in from the sides would pay
    // DISTANCE_TRACKING_SETTLE_MS after already being on screen. Being in view is still
    // required to engage (tested per frame through `inView` below) and leaving still
    // releases; it just does not reset a clock about TRACKING QUALITY.
    active: bothPositioned,
    unknown: !bothPositioned
  });
  const handsTrackingSettled = bothPositioned
    && Boolean(next.handsTracked.sinceMs)
    && clock - next.handsTracked.sinceMs >= DISTANCE_TRACKING_SETTLE_MS;

  const stopSuppressesDistance = stopActive
    || (stopPosePresent && !prev.distance.engaged);
  // Everything except the hands actually being readable this frame.
  const distanceGatesOpen = pinchCount === 0
    && !launcherCapturing
    // THE WRIST POKE IS NOT A ZOOM. One hand reaching for the other wrist converges the pair
    // to 0.074-0.136 m, a textbook zoom-out stroke to a gesture that only sees the gap.
    // `launcherCapturing` already shuts this door, but only once the panel's freeze has
    // LATCHED, by which time the approach has read as a stroke for a couple of hundred
    // milliseconds.
    && !wristPokeNear
    && !panelOpen
    && !stopSuppressesDistance
    && (appState === APP_STATE_TUNNEL || appState === APP_STATE_INSIDE_SPHERE);
  const distanceEligible = distanceGatesOpen && bothPositioned;
  // This is the dropout: the gates are open, the hands are merely missing, and they were
  // there a moment ago. Freeze rather than wipe.
  const distanceHold = distanceGatesOpen
    && !bothPositioned
    && Boolean(next.handsTracked.sinceMs);
  // THE INTENT TEST. Sampled from the same two numbers the rest of the gesture reads (the
  // horizontal separation and the two hand heights) and stepped on the CLAMPED clock, so a
  // hitch cannot manufacture a velocity. It runs whenever both hands are positioned,
  // including on frames the gesture itself is not eligible for: the verdict must already be
  // right on the frame a spread first crosses the deadband, not start converging then.
  const meanHandHeightM = (leftHandHeightM + rightHandHeightM) / 2;
  next.distanceIntent = updateDistanceIntent(prev.distanceIntent || createDistanceIntentState(), {
    nowMs: clock,
    readable: bothPositioned,
    separationM: handDistanceM,
    meanHeightM: meanHandHeightM
  });
  // THE PATH LAYER, read off the same state. `armed` folds the lowering latch together with
  // the post-release blackout, because to the engage test they are the same answer: not
  // right now.
  const pathArmed = next.distanceIntent.armed && clock >= next.distanceIntent.rearmUntilMs;
  const distancePath = {
    armed: pathArmed,
    lowering: next.distanceIntent.lowering,
    ratio: next.distanceIntent.pathRatio,
    direction: Math.sign(next.distanceIntent.netSeparationM),
    reverseGuarded: clock < next.distanceIntent.reversalGuardUntilMs,
    lastStrokeDirection: next.distanceIntent.lastStrokeDirection
  };
  // THE EYE-LEVEL POSE. Same gate in the tunnel and the sphere. Evaluated after the stop
  // signal and inside the eligibility it already decided, so which of the two wins is
  // unchanged. The engage-margin check also names the refusal, so a just-released stroke
  // logs against the engage bound.
  const poseInputs = {
    leftHandPosition: leftPositioned ? leftHandPosition : null,
    rightHandPosition: rightPositioned ? rightHandPosition : null,
    headPosition,
    headForward
  };
  const poseEngage = distancePoseCheck({ ...poseInputs, engaged: false });
  const pose = prev.distance.engaged
    ? distancePoseCheck({ ...poseInputs, engaged: true })
    : poseEngage;
  const distance = updateDistanceGesture(prev.distance, {
    now: clock,
    eligible: distanceEligible,
    distanceM: handDistanceM,
    canEngage: handsTrackingSettled,
    hold: distanceHold,
    inView: handsInView,
    intent: next.distanceIntent.allowed,
    path: distancePath,
    poseOk: pose.ok
  });
  next.distance = distance.state;
  if (prev.distance.engaged && !distance.state.engaged) {
    // The release edge is the one thing that flows back into the path state: it opens the
    // re-arm blackout and names the direction a reversal would be reversing. Folded in here,
    // after the gesture has decided, so the pure function stays a function of its inputs.
    next.distanceIntent = noteDistanceStrokeEnd(next.distanceIntent, {
      nowMs: clock,
      strokeDirection: distance.strokeDirection
    });
  }
  if (distance.justEngaged) {
    events.push({
      decision: "distance",
      outcome: "engaged",
      reason: "",
      target: appState === APP_STATE_INSIDE_SPHERE ? "sphereZoom" : "tunnelSpeed",
      note: `hands distance -> ${appState === APP_STATE_INSIDE_SPHERE ? "sphereZoom" : "tunnelSpeed"} engaged`
    });
  } else if (prev.distance.engaged && !distance.state.engaged) {
    // Read off the STATE, not off `active`: a held frame reports inactive while the gesture
    // is still engaged, and that must not log as a release.
    events.push({
      decision: "distance",
      outcome: "released",
      reason: distance.releaseReason,
      target: appState === APP_STATE_INSIDE_SPHERE ? "sphereZoom" : "tunnelSpeed",
      note: `hands distance -> released${distance.releaseReason ? ` (${distance.releaseReason})` : ""}`
    });
  }

  // WHY it is not engaging. One line per transition, so a hand held out of frame for a
  // minute is one line and not 3600 of them.
  next.distanceRefusedGate = distanceRefusalGate({
    engaged: distance.state.engaged,
    unobservable: !distanceGatesOpen || !bothPositioned || distanceHold,
    wristNear: Boolean(wristPokeNear),
    inView: handsInView,
    poseFailed: poseEngage.failed,
    settled: handsTrackingSettled,
    lowering: distancePath.lowering,
    armed: pathArmed,
    intent: next.distanceIntent.allowed,
    pathOk: distancePath.ratio >= DISTANCE_PATH_ENGAGE_RATIO,
    nearHands: Number.isFinite(handDistanceM) && handDistanceM < DISTANCE_MIN_SEPARATION_M,
    hasBaseline: distance.baselineCandidateM > 0
  });
  const poseRefusal = next.distanceRefusedGate.startsWith("pose-");
  next.distancePoseLoggedMs = prev.distancePoseLoggedMs || 0;
  const refusalLineDue = !poseRefusal
    || !next.distancePoseLoggedMs
    || clock - next.distancePoseLoggedMs >= DISTANCE_POSE_DIAG_INTERVAL_MS;
  if (
    next.distanceRefusedGate
    && next.distanceRefusedGate !== (prev.distanceRefusedGate || "")
    && refusalLineDue
  ) {
    if (poseRefusal) {
      next.distancePoseLoggedMs = clock;
    }
    events.push({
      decision: "distance",
      outcome: "refused",
      reason: next.distanceRefusedGate,
      target: appState === APP_STATE_INSIDE_SPHERE ? "sphereZoom" : "tunnelSpeed",
      note: `hands distance -> refused (${next.distanceRefusedGate})`
    });
  }

  if (stopJustEngaged) {
    events.push({
      decision: "stop",
      outcome: "engaged",
      reason: "",
      note: "hands stop signal -> rotation paused (latched)"
    });
  } else if (stopJustReleased) {
    events.push({
      decision: "stop",
      outcome: "released",
      reason: stopReleaseReason,
      note: `hands stop signal -> released (${stopReleaseReason})`
    });
  }

  // The grab's two verdicts ride on `rotate`, because they ARE the drag: same contact, same
  // displacement, same hand.
  rotate.braking = braking;
  rotate.thrown = thrown;
  rotate.speedMps = dragSpeedMps;
  rotate.travelM = dragTravelM;
  // Used only by the legacy ?drag=vel model. The momentum a throw imparts, in rad/s on the
  // two speeds the drag already steers (null on every frame that is not a throw). Under the
  // grab model the release handoff below subsumes it: the throw is continuous rather than an
  // event, and `thrown` survives only as the stop latch's third exit.
  rotate.throwSpin = throwSpin;
  // `grab` is the position channel's answer for THIS frame: two angle deltas, already
  // rate-clamped, to be premultiplied straight onto sphereOrientation. `releaseSpin` is the
  // falling edge's handoff: the two speeds the sphere should be left carrying, additive over
  // whatever it already had. Both null/zero on the frames they do not apply to.
  rotate.grab = {
    deltaYawRad: grabDeltaYawRad,
    deltaPitchRad: grabDeltaPitchRad,
    lateralM: grab.lateralM,
    verticalM: grab.verticalM,
    appliedYawRad: grab.appliedYawRad,
    appliedPitchRad: grab.appliedPitchRad,
    velLateralMps: grab.velLateralMps,
    velVerticalMps: grab.velVerticalMps
  };
  rotate.releaseSpin = releaseSpin;

  return {
    state: next,
    select,
    rotate,
    stop: {
      // `active` is the live POSE: it stands the distance gesture and the thumb microgestures
      // down, and goes false as soon as the palms turn. `latched` is the pause itself, which
      // outlives it.
      active: stopActive,
      latched: next.stopLatched,
      justEngaged: stopJustEngaged,
      justReleased: stopJustReleased,
      releaseReason: stopReleaseReason,
      // THE APP'S ONE PAUSE CHANNEL. Named `stop.setPaused` because it predates the brake and
      // the throw, but it carries all three writers, and `pauseSource` says which one wrote it.
      setPaused,
      pauseSource
    },
    distance: {
      active: distance.active,
      justEngaged: distance.justEngaged,
      deltaM: distance.deltaM,
      releaseReason: distance.releaseReason,
      target: appState === APP_STATE_INSIDE_SPHERE ? "sphereZoom" : "tunnelSpeed"
    },
    genAi,
    // The chord's decision, app-state-resolved: "genai" inside the sphere, "tunnelJump" in
    // the tunnel, null everywhere else (including every frame of a transition). `genAi` above
    // is the same decision for the sphere case, kept so the pump's existing branch does not
    // change shape.
    chord: { target: chordTarget },
    reason,
    pinchCount,
    // IS THE USER DOING SOMETHING? A phantom "select" part-way through a pinch-drag is not a
    // select (a rotate-hand pinch can never reach that branch) but the sphere dwell reaching
    // SPHERE_DWELL_SECONDS and auto-advancing to the linked image via the same
    // startSphereExit(). The dwell resets only when the drag produces a non-zero DEFLECTION,
    // so holding a pinch still, or drifting inside the deadzone, counted as idling.
    //
    // A hand that is pinching, dragging, spreading or holding the stop pose is by definition
    // not idle, so this is the single flag input.js resets the dwell from. Computed in the
    // pure tree so "engaged but not moving still counts" is provable offline.
    interacting: pinchCount > 0
      || rotate.active
      || distance.active
      || stopActive,
    // Decision edges, for the `handgesture` diagnostics event and the DEV footer. Never per
    // frame: this array is empty on most frames and carries a handful of entries on frames
    // where something changed. Built HERE, in the pass that makes the decisions, as
    // resolveWristPokeOutcome() is, so a log line cannot describe a decision the code did not
    // make. `note` is the human string the DEV footer shows; the structured fields travel to
    // the workstation.
    events,
    // What the decisions above were made from, attached once to every event by the caller:
    // the block that answers "why did it do that" without putting the headset back on.
    diag: {
      selectHand,
      rotateHand,
      present,
      pinching,
      rawPinch,
      graceHeld,
      pinchStartMs,
      chordLeadMs: Number.isFinite(chordLeadMs) ? Math.round(chordLeadMs) : null,
      chordArmed: next.chordArmed,
      chordSpent: next.chordSpent,
      // Did we watch the select pinch arrive, or reconstruct it from a gap? `false` next to a
      // select where GenAI was expected is the whole story.
      selectObservedStart: Boolean(pinch[selectHand].observedStart),
      bothPositioned,
      // The viewport gate. `handsInView: false` next to a distance gesture that would not engage
      // is the answer, and the NDC pair next to it says by how much, which is what a margin
      // tuning pass reads. Rounded so a log line stays legible.
      handsInView,
      handNdc: {
        left: ndcForDiag(leftHandNdc),
        right: ndcForDiag(rightHandNdc)
      },
      // THE INTENT TEST, logged rather than merely implemented. `intentRatio` next to a distance
      // gesture that would not engage says whether the motion or the threshold is the problem,
      // and the two rates say which mode dominated. A `reason:"intent"` REFUSAL with a ratio
      // near 0.6 means DISTANCE_INTENT_ENGAGE_RATIO is the knob; one at 0.1 means the gesture
      // really was an arm-drop.
      intentOk: next.distanceIntent.allowed,
      intentRatio: Math.round(next.distanceIntent.ratio * 100) / 100,
      sepRateMps: Math.round(next.distanceIntent.separationRateMps * 100) / 100,
      dropRateMps: Math.round(next.distanceIntent.commonVerticalRateMps * 100) / 100,
      // THE BASELINE. The engage test is |sep - rest| / rest >= DISTANCE_ENGAGE_REL, and logging
      // all three numbers distinguishes a session where nothing engaged from one where no
      // baseline ever existed. `restM` is the turning point the engage test would measure from
      // RIGHT NOW, `baselineM` is what an engaged stroke is measuring from (0 when nothing is
      // running) and `travelRel` is the deviation actually under test.
      restM: Math.round((distance.baselineCandidateM || 0) * 1000) / 1000,
      baselineM: Math.round((distance.state.baselineM || 0) * 1000) / 1000,
      // null, not Infinity, when there is no reference to measure against. JSON.stringify()
      // turns a non-finite number into `null` anyway, and saying so keeps `restM: 0,
      // travelRel: null` legible as "nothing to measure from" rather than a serialiser artefact.
      travelRel: distanceTravelRelForDiag(
        handDistanceM,
        distance.state.engaged ? distance.state.baselineM : distance.baselineCandidateM
      ),
      // THE PATH LAYER. `pathRatio` is the 600 ms net-displacement share and `netDropM` is the
      // number the lowering veto fires on, so a `reason:"lowering"` release can be checked
      // against DISTANCE_LOWERING_DROP_M. `armed` folds the lowering latch and the post-release
      // blackout together.
      pathRatio: Math.round(distancePath.ratio * 100) / 100,
      netSepM: Math.round(next.distanceIntent.netSeparationM * 1000) / 1000,
      netDropM: Math.round(next.distanceIntent.netHeightM * 1000) / 1000,
      armed: pathArmed,
      // Which gate is holding the gesture shut right now, "" for none. The `distance / refused`
      // event fires on each TRANSITION of this; the field is on every line so any other event can
      // be read in its context.
      refusedGate: next.distanceRefusedGate,
      // The eye-level pose's measurements: what a `pose-*` refusal or a `pose` release is checked
      // against DISTANCE_POSE_*.
      poseOk: pose.ok,
      poseFailed: pose.failed,
      poseHeightDiffM: metresForDiag(pose.heightDiffM),
      poseEyeOffsetM: {
        left: metresForDiag(pose.leftEyeOffsetM),
        right: metresForDiag(pose.rightEyeOffsetM)
      },
      poseForwardM: {
        left: metresForDiag(pose.leftForwardM),
        right: metresForDiag(pose.rightForwardM)
      },
      handsTrackedMs: next.handsTracked.sinceMs
        ? Math.round(clock - next.handsTracked.sinceMs)
        : 0,
      // The grab. `dragSpeedMps` against ROTATE_THROW_SPEED_MPS is what a throw tuning pass
      // reads; `braking` says whether a hold was recognised as one.
      dragSpeedMps: Math.round(dragSpeedMps * 100) / 100,
      dragTravelM: Math.round(dragTravelM * 1000) / 1000,
      // `grabYawRad`/`grabPitchRad` are the angles the position channel has actually handed the
      // sphere so far this contact; read them against 0.74 rad, one image of arc. `grabVelMps` is
      // the EMA the release handoff will be made of, on EVERY line because the release frame's
      // own `dragSpeedMps` is always 0.00: this is the only field that can say how fast a
      // release was.
      grabYawRad: Math.round(grab.appliedYawRad * 1000) / 1000,
      grabPitchRad: Math.round(grab.appliedPitchRad * 1000) / 1000,
      grabVelMps: Math.round(Math.hypot(grab.velLateralMps, grab.velVerticalMps) * 100) / 100,
      // `grabBridged` is true on a frame the release debounce is holding a drag open across a raw
      // un-pinch: a run of them next to no `rotate/engaged` line is the pinch flicker being
      // absorbed instead of restarting the position map. `grabCoasting` is true on a frame the
      // grab is extrapolating through a TRACKING gap. Both false is an ordinary dragging frame.
      grabBridged: Boolean(rotateReleaseBridged),
      grabCoasting: Boolean(rotate.active && !rotatePositioned && rotatePinchDown),
      releaseGain: releaseSpin ? Math.round(releaseSpin.gain * 100) / 100 : null,
      braking,
      pauseSource,
      appState,
      panelOpen: Boolean(panelOpen),
      launcherCapturing: Boolean(launcherCapturing),
      // The zoom suppression, on every line so a `refused reason:"wrist"` can be read against the
      // poke it belongs to.
      wristPokeNear: Boolean(wristPokeNear),
      genAiPending: Boolean(genAiPending),
      // Frame health. A decision that looks wrong next to a `hitch` or a 200 ms `dtMs` is a
      // frame-rate problem, not a gesture problem; this field separates the two.
      dtMs: Math.round(frame.dtMs),
      medianDtMs: Math.round(frame.medianDtMs),
      hitch: frame.hitch
    }
  };
}

export {
  APP_STATE_TUNNEL,
  APP_STATE_INSIDE_SPHERE,
  PINCH_DEBOUNCE_MS,
  PINCH_DEBOUNCE_MIN_SAMPLES,
  GENAI_CONFIRM_HOLD_MS,
  GENAI_CONFIRM_MIN_SAMPLES,
  HAND_DROPOUT_GRACE_MS,
  CHORD_LEAD_MS,
  MAX_GESTURE_STEP_MS,
  FRAME_HITCH_FLOOR_MS,
  FRAME_HITCH_RATIO,
  FRAME_MEDIAN_SAMPLES,
  DISTANCE_ENGAGE_REL,
  DISTANCE_RELEASE_REL,
  DISTANCE_STABILITY_REL,
  DISTANCE_EXTREMUM_LEAK_S,
  DISTANCE_RELEASE_GRACE_MS,
  DISTANCE_MIN_REST_M,
  DISTANCE_TRACKING_SETTLE_MS,
  DISTANCE_COMMIT_MS,
  DISTANCE_VIEW_NDC_MARGIN_Y_ABOVE,
  DISTANCE_VIEW_NDC_MARGIN_Y_BELOW,
  DISTANCE_MIN_SEPARATION_M,
  DISTANCE_POSE_LEVEL_M,
  DISTANCE_POSE_LEVEL_RELEASE_M,
  DISTANCE_POSE_EYE_BELOW_M,
  DISTANCE_POSE_EYE_ABOVE_M,
  DISTANCE_POSE_EYE_BELOW_RELEASE_M,
  DISTANCE_POSE_EYE_ABOVE_RELEASE_M,
  DISTANCE_POSE_FORWARD_M,
  DISTANCE_POSE_FORWARD_RELEASE_M,
  DISTANCE_POSE_RELEASE_MS,
  DISTANCE_POSE_DIAG_INTERVAL_MS,
  distancePoseCheck,
  DISTANCE_INTENT_SMOOTH_PER_S,
  DISTANCE_INTENT_MIN_RATE_MPS,
  DISTANCE_INTENT_STALE_MS,
  DISTANCE_INTENT_ENGAGE_RATIO,
  DISTANCE_INTENT_RELEASE_RATIO,
  DISTANCE_TRACK_SLOT_MS,
  DISTANCE_TRACK_SLOTS,
  DISTANCE_TRACK_WINDOW_MS,
  DISTANCE_PATH_ENGAGE_RATIO,
  DISTANCE_PATH_REVERSE_RATIO,
  DISTANCE_PATH_REVERSE_TRAVEL_SCALE,
  DISTANCE_LOWERING_DROP_M,
  DISTANCE_LOWERING_STEADY_M,
  DISTANCE_REARM_STILL_MS,
  DISTANCE_REARM_MS,
  DISTANCE_REVERSAL_GUARD_MS,
  ROTATE_YAW_DEADZONE_M,
  ROTATE_YAW_FULL_DEFLECTION_M,
  ROTATE_PITCH_DEADZONE_M,
  ROTATE_PITCH_FULL_DEFLECTION_M,
  ROTATE_RESPONSE_EXPONENT,
  ROTATE_BRAKE_HOLD_MS,
  ROTATE_THROW_SPEED_MPS,
  ROTATE_THROW_RELEASE_SPEED_MPS,
  ROTATE_THROW_HOLD_MS,
  ROTATE_THROW_MIN_TRAVEL_M,
  ROTATE_THROW_SPIN_GAIN_RAD_PER_MPS,
  ROTATE_THROW_SPIN_MAX_RAD_PER_S,
  HAND_GRAB_MAX_RATE_RAD_PER_S,
  ROTATE_RELEASE_VEL_SMOOTH_PER_S,
  ROTATE_RELEASE_MIN_MPS,
  ROTATE_RELEASE_RAMP_MPS,
  ROTATE_RELEASE_MAX_RAD_PER_S,
  ROTATE_RELEASE_DEBOUNCE_MS,
  GRAB_DROPOUT_EXTRAPOLATE_TAU_S,
  SPHERE_COAST_TAU_STICK_S,
  SPHERE_COAST_TAU_HAND_THROW_S,
  stepCoastSpeed,
  DRIFT_RESUME_DELAY_S,
  DRIFT_RESUME_SECONDS,
  ROTATE_BRAKE_CENTER_GATE,
  ROTATE_BRAKE_CENTER_MAX_NDC_R,
  PALM_UP_MAX_COS,
  PALM_AWAY_MIN_COS,
  STOP_POSE_STABILITY_MS,
  STOP_RELEASE_DROP_M,
  STOP_RELEASE_STABILITY_MS,
  STOP_RELEASE_TRACKING_GRACE_MS,
  HAND_DRAG_SPEED_RESPONSE_PER_S,
  HAND_DRAG_SPEED_CLAMP,
  minWindowSamples,
  medianOf,
  createFrameClock,
  stepFrameClock,
  createGracedWindow,
  stepGracedWindow,
  relativeDeviation,
  horizontalSeparationM,
  isPalmFacingUp,
  isPalmFacingAway,
  rotateDeflection,
  rotateYawDeflection,
  rotatePitchDeflection,
  handWithinViewport,
  handWithinNdcRadius,
  stepDriftResume,
  stopHandExit,
  stepHandDragSpeed,
  createGrabState,
  stepGrabDisplacement,
  grabAngleTarget,
  stepGrabAngle,
  stepReleaseVelocity,
  releaseHandoff,
  driftDirectionAfterRotation,
  SPHERE_MANUAL_LAYER_COUPLING,
  sphereLayerSpreadMultiplier,
  manualLayerDifferential,
  reanchorBaselineAfterClamp,
  createPinchState,
  updatePinchState,
  pinchHeldMs,
  createDistanceState,
  updateDistanceGesture,
  distanceRefusalGate,
  createDistanceIntentState,
  updateDistanceIntent,
  noteDistanceStrokeEnd,
  createDistanceTrack,
  stepDistanceTrack,
  stepDistanceExtremum,
  distanceBaselineFor,
  createHandGestureState,
  resolveHandGestures
};
