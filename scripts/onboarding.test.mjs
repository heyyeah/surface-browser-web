// First-run sphere onboarding — the decision logic, on a fake clock.
//
// The rule under test is about INTERACTION, not about having seen the overlay:
// a visitor who watches it appear and still does nothing must get it again next
// sphere, because it has not yet done its job.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOnboardingState,
  stepOnboarding,
  onboardingRowKeys,
  ONBOARDING_DELAY_SECONDS,
  ONBOARDING_GRACE_SECONDS,
  ONBOARDING_TAIL_SECONDS
} from "../src/onboarding.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every doesNotMatch below is about the CODE, not comments: a comment that names
// the thing it warns against would otherwise match.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

// Walks a sphere visit, returning every decision. The step is half a second
// because the constants are not whole numbers (ONBOARDING_DELAY_SECONDS is 4.5,
// which a one-second walker cannot land on); every expectation below is written on
// this grid, so use STEP rather than 1 when naming the frame before a boundary.
// Halves are exact in binary — no epsilon needed.
const STEP = 0.5;

function visit({ seconds, hasInteractedEver = false, interactAt = null, leaveAt = null }) {
  let state = createOnboardingState();
  const decisions = [];
  for (let s = 0; s <= seconds; s += STEP) {
    const stepped = stepOnboarding(state, {
      inSphere: leaveAt === null || s < leaveAt,
      elapsedSeconds: s,
      hasInteractedEver,
      interactedNow: interactAt !== null && s === interactAt
    });
    state = stepped.state;
    decisions.push({ s, ...stepped.decision });
  }
  return { state, decisions, shownAt: decisions.filter((d) => d.justShown).map((d) => d.s) };
}

test("nothing appears before the delay", () => {
  const { decisions } = visit({ seconds: ONBOARDING_DELAY_SECONDS - 1 });
  assert.ok(decisions.every((d) => !d.visible), "the sphere is not a tutorial by default");
});

test("it appears once the visitor has sat still long enough", () => {
  const { decisions, shownAt } = visit({ seconds: ONBOARDING_DELAY_SECONDS + 1 });
  assert.deepEqual(shownAt, [ONBOARDING_DELAY_SECONDS], "shown exactly once, at the delay");
  assert.equal(decisions.at(-1).visible, true);
});

test("it does NOT go away on its own — it waits for the visitor", () => {
  // There is no timed hide: hiding after a span while the 20 s dwell carries the
  // reader out from underneath it would ask for a gesture and then leave without them.
  const { decisions } = visit({ seconds: 600 });
  assert.ok(decisions.filter((d) => d.s >= ONBOARDING_DELAY_SECONDS).every((d) => d.visible),
    "still up ten minutes later");
  assert.equal(decisions.at(-1).phase, "full", "and still the full four rows");
});

test("and it holds the dwell for as long as it is up", () => {
  // The other half of the same rule: a hidden overlay must never freeze the
  // sphere, and a visible one must always freeze it.
  const { decisions } = visit({ seconds: 600 });
  for (const d of decisions) {
    assert.equal(d.holdDwell, d.visible, `holdDwell disagreed with visible at ${d.s}s`);
  }
});

test("input BEFORE it appears means it never appears", () => {
  // That visitor has already found the sphere; there is nothing to teach.
  const { decisions } = visit({ seconds: 30, interactAt: 3 });
  assert.ok(decisions.every((d) => !d.visible));
});

test("input WHILE it is on screen leaves time to finish the line", () => {
  // Input does not dismiss the overlay (trying the arrow must not make it vanish
  // before the visitor finishes); it starts a short grace instead.
  const at = ONBOARDING_DELAY_SECONDS + 2;
  const { decisions } = visit({ seconds: 30, interactAt: at });
  assert.equal(decisions.find((d) => d.s === at).visible, true, "still readable while they steer");
  assert.equal(decisions.find((d) => d.s === at).justHidden, false);
  const full = decisions.filter((d) => d.phase === "full").at(-1).s;
  assert.equal(full, at + ONBOARDING_GRACE_SECONDS - STEP, "grace, then the tail");
  // Then the last line alone: everything else has been answered by the fact
  // that they are now steering, and Help is the only thing left to point at.
  const tail = decisions.filter((d) => d.phase === "tail");
  assert.ok(tail.length > 0, "a tail phase must follow the grace");
  assert.equal(tail.at(-1).s, at + ONBOARDING_GRACE_SECONDS + ONBOARDING_TAIL_SECONDS - STEP);
  // ...and then it is gone, which is the ONLY way it goes: a visitor who is
  // steering loses it, one who is not keeps it.
  assert.equal(decisions.at(-1).visible, false);
  assert.equal(decisions.at(-1).holdDwell, false, "and the sphere is free to move on");
});

test("the tail is the Help line alone, and only the caller knows that", () => {
  // The module reports a phase; the rows themselves are the caller's business.
  const at = ONBOARDING_DELAY_SECONDS + 1;
  const { decisions } = visit({ seconds: 30, interactAt: at });
  const changes = decisions.filter((d) => d.phaseChanged).map((d) => d.phase);
  assert.deepEqual(changes, ["full", "tail"], "one render per phase, no churn");
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function renderSphereOnboarding"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /phase === "tail" \? \[\] : onboardingRowKeys/);
});

test("the exit is the same length whenever they get round to it", () => {
  // There is no span left for a late interaction to be clipped against, so a
  // reader who takes two minutes gets the same grace and tail as one who takes
  // two seconds.
  const soon = visit({ seconds: 200, interactAt: ONBOARDING_DELAY_SECONDS + 1 });
  const late = visit({ seconds: 200, interactAt: 120 });
  const onScreen = (v) => {
    const shown = v.decisions.filter((d) => d.visible);
    return shown.at(-1).s - shown[0].s;
  };
  const tailFrames = (v) => v.decisions.filter((d) => d.phase === "tail").length;
  assert.equal(tailFrames(soon), tailFrames(late), "the same tail");
  assert.ok(onScreen(late) > onScreen(soon), "and the late reader simply had longer to read");
});

test("having interacted in an EARLIER sphere still suppresses it", () => {
  // The persisted flag arrives as hasInteractedEver on the very first frame,
  // which is the branch that must stay a suppression.
  const { decisions } = visit({ seconds: 30, hasInteractedEver: true });
  assert.ok(decisions.every((d) => !d.visible));
});

test("a visitor who has interacted before never sees it", () => {
  const { decisions } = visit({ seconds: 30, hasInteractedEver: true });
  assert.ok(decisions.every((d) => !d.visible));
});

test("THE RULE: watching it and still doing nothing earns it again next sphere", () => {
  // The flag is set by INTERACTION, never by having been shown. Marking it seen
  // would teach nobody and then silence itself.
  const first = visit({ seconds: 20 });
  assert.ok(first.shownAt.length === 1, "shown in the first sphere");
  // A second sphere, same visitor, still no interaction: fresh state, shown again.
  const second = visit({ seconds: 20, hasInteractedEver: false });
  assert.deepEqual(second.shownAt, [ONBOARDING_DELAY_SECONDS], "and again in the next");
});

test("leaving the sphere resets it, so the next sphere is a fresh chance", () => {
  const { state } = visit({ seconds: 12, leaveAt: 11 });
  assert.deepEqual(state, createOnboardingState());
});

test("it is not re-shown within one sphere once the exit has finished", () => {
  // Without the `hidden` latch the elapsed test would go false, then true again
  // on nothing, and the overlay would blink back after it had finished.
  const { decisions } = visit({ seconds: 40, interactAt: ONBOARDING_DELAY_SECONDS + 1 });
  assert.equal(decisions.filter((d) => d.justShown).length, 1);
  assert.ok(decisions.filter((d) => d.visible).at(-1).s < 40, "and it stays gone");
});

test("nonsense timing shows nothing rather than showing forever", () => {
  for (const bad of [undefined, null, NaN, "x", Infinity, -1]) {
    const { decision } = stepOnboarding(createOnboardingState(), {
      inSphere: true,
      elapsedSeconds: bad
    });
    assert.equal(decision.visible, false, `elapsed=${String(bad)}`);
    assert.equal(decision.holdDwell, false, "and a broken clock never freezes the sphere");
  }
});

// --- content ---------------------------------------------------------------

test("each device is offered only what it can actually do", () => {
  const touch = onboardingRowKeys(true).flat();
  const desktop = onboardingRowKeys(false).flat();
  assert.ok(touch.includes("key.pinch"));
  assert.ok(!desktop.includes("key.pinch"), "pinch does not work on desktop yet");
  assert.ok(desktop.includes("key.shiftArrows"));
  assert.ok(!touch.includes("key.shiftArrows"), "a phone has no Shift");
});

test("the rows teach the four things in the order they are needed", () => {
  for (const touchOnly of [true, false]) {
    const rows = onboardingRowKeys(touchOnly);
    assert.equal(rows.length, 4, "the shortest set that makes the sphere usable");
    // move it, keep it moving, change the view, go somewhere
    assert.equal(rows[0][1], "act.turn");
    assert.ok(rows.at(-1)[1].startsWith("act.travel"), "selecting is the payoff, so it is last");
  }
});

test("every key the overlay uses exists in the dictionary", () => {
  // The overlay holds no words; a typo here would render a raw key at a visitor.
  const i18n = read("src/i18n.js");
  for (const key of [...onboardingRowKeys(true).flat(), ...onboardingRowKeys(false).flat()]) {
    assert.ok(i18n.includes(`"${key}"`), `${key} is missing from src/i18n.js`);
  }
});

test("it is a readout, never a target", () => {
  // An overlay that ate the first drag would be teaching a gesture while
  // preventing it — the same rule the confirm ring follows.
  const css = read("src/styles.css");
  const block = css.slice(css.indexOf(".sphere-onboarding {"));
  assert.match(block.slice(0, block.indexOf("}")), /pointer-events: none/);
});

test("the panel gets the width it asks for, not half the viewport", () => {
  // Centring with left:50% + translateX(-50%) is a trap: the transform moves only
  // the painted result, the layout box has already shrink-to-fit into the space
  // between the 50% edge and the right edge, so on a 390px phone the panel is
  // 195px and every row breaks into a column of single words.
  const css = read("src/styles.css");
  const block = css.slice(css.indexOf(".sphere-onboarding {"));
  const rules = block.slice(0, block.indexOf("}"));
  const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /left:\s*50%/, "left:50% caps an auto-width absolute box at half its container");
  assert.match(rules, /margin-inline: auto/);
  assert.match(rules, /width: fit-content/);
});

// --- wiring ----------------------------------------------------------------

test("the interaction signal is real input, never the gaze selector", () => {
  // markSphereInteraction() fires whenever gaze selection CHANGES, and the
  // sphere drifts on its own — so using it here would mark an empty room as an
  // engaged visitor and the overlay would never appear for the people it exists
  // for. Both flags used instead are cleared at the top of every frame and set
  // only by real input paths.
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function stepSphereOnboarding"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /state\.sphereRotationInputActive \|\| state\.sphereInteractionHold/);
  // Strip comments before asserting the absence: the lines ABOVE explain why
  // markSphereInteraction is not used, and naming it there is the point.
  assert.doesNotMatch(stripComments(body), /markSphereInteraction/);
});

test("the flag persists INTERACTION, not having been shown", () => {
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function stepSphereOnboarding"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  // Written on interaction...
  assert.match(body, /if \(!onboardingForced && interactedNow && !sphereInteractedEver\)[\s\S]*?setItem\(SPHERE_INTERACTED_KEY/);
  // ...and never on justShown, which would silence it having taught nobody.
  const shownBranch = body.slice(body.indexOf("justShown"));
  assert.doesNotMatch(shownBranch, /setItem/);
});

test("an unreadable store errs toward showing the overlay", () => {
  // A private window throws on read. Showing it to someone who has seen it is a
  // far smaller failure than withholding it from someone who needs it.
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function readSphereInteracted"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /catch \{[\s\S]*return false;/);
});

test("?onboarding=1 FORCES it, rather than only clearing the flag", () => {
  // A reset alone cannot be told apart from a broken deploy: if nothing appears,
  // there is no way to know whether the flag was cleared or the overlay failed.
  // Forcing removes the ambiguity: under the switch, history is ignored, input
  // neither suppresses nor persists, and the delay is a second.
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function readOnboardingForce"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /get\("onboarding"\)/);
  assert.match(mainJs, /const onboardingForced = readOnboardingForce\(\);\s*if \(onboardingForced\) \{\s*forgetSphereInteracted\(\);/);
  const forget = mainJs.slice(mainJs.indexOf("function forgetSphereInteracted"));
  assert.match(forget.slice(0, forget.indexOf("\n}\n")), /removeItem\(SPHERE_INTERACTED_KEY\)/);

  const step = mainJs.slice(mainJs.indexOf("function stepSphereOnboarding"));
  const body = step.slice(0, step.indexOf("\nfunction "));
  assert.match(body, /hasInteractedEver: onboardingForced \? false : sphereInteractedEver/);
  assert.match(body, /delaySeconds: onboardingForced \? ONBOARDING_FORCE_DELAY_SECONDS : undefined/);
  // Interaction is NOT stubbed out under the switch: the grace and the tail are
  // most of what there is to look at, so forcing has to show them too.
  assert.match(body, /\n\s*interactedNow,\n/);
  // A forced run must not write the flag, or the test switch would silence the
  // real thing for that visitor.
  assert.match(body, /if \(!onboardingForced && interactedNow && !sphereInteractedEver\)/);
});

test("the overlay holds the sphere's dwell, through its own flag", () => {
  // THE TRAP: it cannot hold the dwell with state.sphereInteractionHold, which
  // is the flag stepSphereOnboarding() reads back as "the visitor is driving" —
  // the overlay would dismiss itself the frame it tried to hold anything.
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function stepSphereOnboarding"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /state\.sphereDwellHeldByOnboarding = Boolean\(stepped\.decision\.holdDwell\)/);
  const code = stripComments(body);
  assert.doesNotMatch(code, /state\.sphereInteractionHold\s*=/, "never written here, only read");

  // Set before updateStateMachine() reads it, so the hold lands on the frame
  // the overlay appears rather than the one after.
  assert.ok(mainJs.indexOf("stepSphereOnboarding(dt);") < mainJs.indexOf("updateStateMachine(dt);"));

  const transitions = read("src/transitions.js");
  assert.match(
    stripComments(transitions),
    /if \(!state\.sphereInteractionHold && !state\.sphereDwellHeldByOnboarding && !idle\.suspended\) \{\s*\n\s*state\.sphereDwellSeconds \+= dt;/,
    "the dwell clock consults the overlay's hold"
  );
});

test("it never appears — so never stalls the sphere — in VR or gallery mode", () => {
  // It is a DOM element and no dom-overlay feature is requested (ui.js), so in
  // an immersive session nobody can see it; gallery mode runs unattended by
  // design. In both, a hold that waits for an interaction that will never come
  // would stall the piece.
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function stepSphereOnboarding"));
  const body = stripComments(fn.slice(0, fn.indexOf("\nfunction ")));
  assert.match(body, /appState === AppState\.INSIDE_SPHERE\s*\n\s*&& !renderer\.xr\.isPresenting\s*\n\s*&& !state\.autoGalleryMode/);
  assert.doesNotMatch(read("src/ui.js"), /dom-overlay/, "if that ever changes, revisit the VR guard");
});

test("the elapsed clock resets when the sphere is left", () => {
  const mainJs = read("src/main.js");
  const fn = mainJs.slice(mainJs.indexOf("function stepSphereOnboarding"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /sphereVisibleSeconds = inSphere \? sphereVisibleSeconds \+ dt : 0/);
});
