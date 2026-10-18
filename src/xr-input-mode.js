// What the visitor is actually holding, for the help surfaces. No headset-model
// differentiation: only "is this a hand". Two facts from the live session decide:
// (a) whether `hand-tracking` was granted (session.enabledFeatures), and
// (b) what is live this frame (session.inputSources), the only thing that can say
// "controllers", since a controller is never announced by a feature.
//
// `known: false` is the honest answer outside a session (desktop menu, or before
// the first source arrives); callers then show everything, because a help surface
// that hides a binding it merely could not confirm is worse than one that lists a
// spare.
//
// Pure and dependency-free apart from the hand test it shares with the
// microgesture path, so it is unit-testable offline.

import { isHandLikeSource } from "./xr-microgestures.js";

const HAND_TRACKING_FEATURE = "hand-tracking";

function grantsHandTracking(enabledFeatures) {
  if (!enabledFeatures || typeof enabledFeatures[Symbol.iterator] !== "function") {
    return false;
  }
  for (const feature of enabledFeatures) {
    if (feature === HAND_TRACKING_FEATURE) {
      return true;
    }
  }
  return false;
}

// A source with a pose but no hand. `gripSpace` OR `targetRaySpace`: a runtime may
// report only one and either is enough to say a controller is here.
function isControllerSource(source) {
  return Boolean(source) && !isHandLikeSource(source)
    && Boolean(source.gripSpace || source.targetRaySpace);
}

// Returns { known, hands, controllers, handTrackingGranted, handsLive,
// controllersLive }. `hands` / `controllers` are what a help surface switches on;
// the rest say why.
function resolveXrInputAffordances({ enabledFeatures, inputSources } = {}) {
  const handTrackingGranted = grantsHandTracking(enabledFeatures);
  let handsLive = false;
  let controllersLive = false;
  for (const source of inputSources || []) {
    if (isHandLikeSource(source)) {
      handsLive = true;
    } else if (isControllerSource(source)) {
      controllersLive = true;
    }
  }
  if (!handsLive && !controllersLive) {
    // Nothing in the visitor's hands that we can see. A granted feature is not
    // evidence on its own — this is also every frame before the first source
    // connects — so say we do not know and let the caller list everything.
    return {
      known: false,
      hands: true,
      controllers: true,
      handTrackingGranted,
      handsLive,
      controllersLive
    };
  }
  return {
    known: true,
    // Live input wins over what the headset could do: hand tracking can be granted
    // while the visitor holds controllers, and the help should not show pinches then.
    // A granted feature still counts when nothing is live in the other hand, so
    // putting the controllers down brings the hand bindings back.
    hands: handsLive || (handTrackingGranted && !controllersLive),
    controllers: controllersLive,
    handTrackingGranted,
    handsLive,
    controllersLive
  };
}

export { resolveXrInputAffordances, isControllerSource, HAND_TRACKING_FEATURE };
