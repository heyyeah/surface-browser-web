// Pure navigation helpers (no DOM, no state import), tested in
// scripts/navigation.test.mjs.

function sameDestination(left, right) {
  return Boolean(left && right)
    && left.mode === right.mode
    && left.query === right.query
    && (left.source?.id || "") === (right.source?.id || "");
}

// Where Back goes. A destination still on its way (a request with no images
// yet, an image import, a sphere exit toward a link) is not on the history
// stack: the page being left is only pushed once the new one has images. So
// popping then would skip the page the viewer is leaving; Back abandons the
// pending one and returns there instead. A pending reload of the current page
// (a tunnel cycle) is not a new destination, so Back pops as usual.
function resolveBackTarget({ history, current, pending }) {
  if (pending && current && !sameDestination(pending, current)) {
    return { entry: current, pop: false };
  }
  return { entry: history.length ? history[history.length - 1] : null, pop: true };
}

// The address bar for a GenAI run: the prompt, then the emoji chain of the image
// it varies, so each round reads differently and going Back visibly changes it.
// Display only; the request and its history entry keep the bare prompt.
function genAiAddressText(prompt, stack) {
  const emoji = Array.isArray(stack) ? stack.filter(Boolean).join("") : "";
  return emoji ? `${prompt} ${emoji}` : prompt;
}

export { sameDestination, resolveBackTarget, genAiAddressText };
