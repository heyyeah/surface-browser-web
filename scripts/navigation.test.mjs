import test from "node:test";
import assert from "node:assert/strict";
import { genAiAddressText, resolveBackTarget, sameDestination } from "../src/navigation.js";

const Z = { mode: "url", query: "https://example.com" };
const A = { mode: "genai", query: "boxccd still 03 from boxc.net", source: { id: "a" } };
const B = { mode: "genai", query: "boxccd still 03 from boxc.net", source: { id: "b", stack: ["🌹"] } };

test("Back with nothing pending pops the history", () => {
  assert.deepEqual(resolveBackTarget({ history: [Z], current: A, pending: null }), { entry: Z, pop: true });
});

test("Back while a new destination loads returns to the page being left", () => {
  // B has no images yet, so A was never pushed: popping would skip it.
  assert.deepEqual(resolveBackTarget({ history: [Z], current: A, pending: B }), { entry: A, pop: false });
});

test("a variation of the same prompt is a new destination", () => {
  assert.equal(sameDestination(A, B), false, "same prompt, different source image");
});

test("Back during a reload of the current page pops as usual", () => {
  const reload = { mode: A.mode, query: A.query, source: { id: "a" } };
  assert.deepEqual(resolveBackTarget({ history: [Z], current: A, pending: reload }), { entry: Z, pop: true });
});

test("Back with no current page and nothing behind has nowhere to go", () => {
  assert.deepEqual(resolveBackTarget({ history: [], current: null, pending: B }), { entry: null, pop: true });
});

test("an image import with no prompt yet is pending too", () => {
  const launch = { mode: "genai", query: null };
  assert.deepEqual(resolveBackTarget({ history: [], current: Z, pending: launch }), { entry: Z, pop: false });
});

test("the address bar adds the varied image's emoji chain to the prompt", () => {
  assert.equal(genAiAddressText("otters", []), "otters");
  assert.equal(genAiAddressText("otters", undefined), "otters");
  assert.equal(genAiAddressText("otters", ["🌹"]), "otters 🌹");
  assert.equal(genAiAddressText("otters", ["🌹", "🐙"]), "otters 🌹🐙");
});
