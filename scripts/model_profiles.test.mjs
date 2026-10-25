// Model-name rules for local providers: recommended steps and edit models.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isEditModel, recommendedSteps, recommendedStepsSummary } from "../server/model-profiles.js";

test("recommended steps come from the model file name", () => {
  assert.equal(recommendedSteps("flux_2_klein_4b_q8p.ckpt"), 4);
  assert.equal(recommendedSteps("moss_image_sft_q8p.ckpt"), 30);
  assert.equal(recommendedSteps("sd_xl_base_1.0.safetensors"), null);
  assert.equal(recommendedSteps(""), null);
  assert.equal(recommendedStepsSummary(), "FLUX.2 Klein: 4, Moss: 30");
});

test("edit models are told apart from repaint-at-strength ones", () => {
  for (const model of ["flux_1_kontext_dev_q8p.ckpt", "flux_2_klein_4b_q8p.ckpt", "qwen_image_edit_2509_q8p.ckpt"]) {
    assert.equal(isEditModel(model), true, model);
  }
  for (const model of ["moss_image_sft_q8p.ckpt", "krea_2_turbo_q8p.ckpt", "credit_model.ckpt", ""]) {
    assert.equal(isEditModel(model), false, model);
  }
});
