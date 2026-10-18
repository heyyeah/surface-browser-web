// Which binding sits on which physical button, for the 3D callouts. The rule, not
// the rendering: pure, dependency-free and unit-testable offline.
// controller-callouts.js turns the output into markers and labels on the real model.
//
// Component ids are WebXR input-profile ids, the keys of three's
// XRControllerModelFactory `motionController.components`; the renderer uses them
// to find the node for a marker. Changing one silently detaches a callout.
//
// The marks are a reading of the hardware and do not change when Help opens.
// Neither stick press is annotated: jump and history-back stay bound but are
// shortcuts that would clutter a quick-glance menu. The wrist menu's mode rows
// (web / image search / GenAI) are not here either; a controller has a Menu button.
//
// An entry that does nothing in the current app state carries `available: false`
// and is dropped (in the tunnel: both grips).

// Mirrors input.js's axes block: INSIDE_SPHERE is the sphere and every other state
// (both transitions included) falls through to the tunnel branch. Duplicated
// rather than imported to keep this file free of the constants/three import chain.
const APP_STATE_INSIDE_SPHERE = "inside_sphere";

const TIER_PRIMARY = "primary";

// Every mark is a meaning, not a button shape: names in the shared set
// (ui-icons.js), so the wrist panel draws the identical picture for the identical
// row. An axis is never drawn as a button; the directional glyphs are for axes.
const ICON_HELP = "question";
const ICON_CAPTURE = "camera";
const ICON_EXIT = "exit";
const ICON_MENU = "menu";
const ICON_SELECT = "select";
// A plain sparkle with NO hold ring: the chord is hold the left grip, then pull
// the right trigger, and the grip alone does nothing. A two-part icon is an
// illegible smear at mark size. The mark says what, the label says how
// (act.variationsChord).
const ICON_VARIATIONS = "spark";
const ICON_PAUSE = "pause";
const GLYPH_UP_DOWN = "up-down";
const GLYPH_FOUR_WAY = "four-way";

// The thumbstick carries two entries on one node (axes and press), so entries
// have their own `id` rather than being keyed by `component`. The renderer
// stacks the two.
const THUMBSTICK = "xr-standard-thumbstick";
const TRIGGER = "xr-standard-trigger";
const SQUEEZE = "xr-standard-squeeze";

// `hold` is a modifier, not an icon: the renderer draws a progress-track ring
// around the row's icon, so Exit VR reads as "hold this" and still as Exit.
// `lettered` marks a button with a moulded letter (A, B, X, Y); its mark is
// nudged in off the cap so the letter stays readable underneath.
function entry(id, component, tier, glyph, labelKey, available = true, hold = false, lettered = false) {
  return { id, component, tier, glyph, labelKey, available, hold, lettered };
}

// LEFT. The stick is up/down in both states: inside the sphere input.js reads only
// axis Y on this hand, so a four-way glyph would promise a movement that does nothing.
// Select acts in the sphere (the gaze-targeted image) and on any open panel, and
// does nothing in the tunnel with nothing open. It is the one availability that
// changes without the app state changing, so the redraw key carries it.
function selectAvailable(inSphere, panelOpen) {
  return inSphere || panelOpen;
}

function leftCallouts({ inSphere, captureEnabled, genaiEnabled, panelOpen }) {
  return [
    entry(
      "left-stick-axes", THUMBSTICK, TIER_PRIMARY, GLYPH_UP_DOWN,
      inSphere ? "callout.zoom" : "callout.speed"
    ),
    // X is the menu: the lower, more reachable button.
    entry("left-x", "x-button", TIER_PRIMARY, ICON_MENU, "callout.menu", true, false, true),
    // Y is Capture only where a capture token is configured; otherwise it is the
    // second Help button. The label has to follow the binding.
    entry(
      "left-y", "y-button", TIER_PRIMARY,
      captureEnabled ? ICON_CAPTURE : ICON_HELP,
      captureEnabled ? "callout.screenshot" : "callout.help",
      true, false, true
    ),
    entry(
      "left-trigger", TRIGGER, TIER_PRIMARY, ICON_SELECT,
      inSphere ? "callout.navigate" : "callout.select",
      selectAvailable(inSphere, panelOpen)
    ),
    // Held, then the trigger. Needs a relay configured and a sphere with a raster.
    entry(
      "left-grip", SQUEEZE, TIER_PRIMARY, ICON_VARIATIONS, "callout.variations",
      genaiEnabled && inSphere
    ),
  ];
}

// RIGHT. The only four-way on either controller, and only inside the sphere; in
// the tunnel this stick drives speed on axis Y like the left one.
function rightCallouts({ inSphere, panelOpen }) {
  return [
    entry(
      "right-stick-axes", THUMBSTICK, TIER_PRIMARY,
      inSphere ? GLYPH_FOUR_WAY : GLYPH_UP_DOWN,
      inSphere ? "callout.rotate" : "callout.speed"
    ),
    entry("right-a", "a-button", TIER_PRIMARY, ICON_HELP, "callout.help", true, false, true),
    entry("right-b", "b-button", TIER_PRIMARY, ICON_EXIT, "callout.exit", true, true, true),
    entry(
      "right-trigger", TRIGGER, TIER_PRIMARY, ICON_SELECT,
      inSphere ? "callout.navigate" : "callout.select",
      selectAvailable(inSphere, panelOpen)
    ),
    // Sphere-only, and a toggle rather than a navigation: the grip is the most
    // accidentally-pressed button on a Touch controller.
    entry(
      "right-grip", SQUEEZE, TIER_PRIMARY, ICON_PAUSE, "callout.pauseRotation",
      inSphere
    )
  ];
}

// The callouts for one controller: the marks that do something right now.
// Returns a fresh array every call; this runs on gaze/state changes, not per
// frame (controller-callouts.js rebuilds only when the key below changes).
function resolveControllerCallouts({
  handedness,
  appState,
  captureEnabled = false,
  genaiEnabled = false,
  panelOpen = false
} = {}) {
  if (handedness !== "left" && handedness !== "right") {
    return [];
  }
  const inSphere = appState === APP_STATE_INSIDE_SPHERE;
  const all = handedness === "left"
    ? leftCallouts({ inSphere, captureEnabled, genaiEnabled, panelOpen })
    : rightCallouts({ inSphere, panelOpen });
  return all.filter((item) => item.available);
}

// Cheap identity for "would resolveControllerCallouts() return something different".
// The renderer redraws its label canvases only when this changes.
function controllerCalloutKey({
  handedness,
  appState,
  captureEnabled = false,
  genaiEnabled = false,
  panelOpen = false
} = {}) {
  const inSphere = appState === APP_STATE_INSIDE_SPHERE ? "s" : "t";
  return `${handedness || "?"}|${inSphere}`
    + `|${captureEnabled ? "c" : "-"}|${genaiEnabled ? "g" : "-"}|${panelOpen ? "o" : "-"}`;
}

export {
  resolveControllerCallouts,
  controllerCalloutKey,
  TIER_PRIMARY,
  GLYPH_UP_DOWN,
  GLYPH_FOUR_WAY
};
