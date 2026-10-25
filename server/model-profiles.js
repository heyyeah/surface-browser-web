// What the app knows about a local (Draw Things / a1111) model from its file
// name: recommended steps, and whether it edits from an instruction.

// Shown in the settings panel as written; add a model here, not in the UI.
export const RECOMMENDED_STEPS = Object.freeze([
  { name: "FLUX.2 Klein", match: /flux[._ -]?2.*klein/i, steps: 4 },
  { name: "Moss", match: /moss/i, steps: 30 }
]);

// Edit models take "make it icy" against the source image; the rest repaint it
// at a denoising strength and need the subject in the prompt to keep it.
const EDIT_MODEL = /kontext|klein|qwen[._ -]?image[._ -]?edit|[._ -]edit([._ -]|$)/i;

export function recommendedSteps(model) {
  return RECOMMENDED_STEPS.find((entry) => entry.match.test(String(model || "")))?.steps ?? null;
}

export function isEditModel(model) {
  return EDIT_MODEL.test(String(model || ""));
}

export function recommendedStepsSummary() {
  return RECOMMENDED_STEPS.map((entry) => `${entry.name}: ${entry.steps}`).join(", ");
}
