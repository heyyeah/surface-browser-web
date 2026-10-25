// GENAI_VARY_MODIFIERS parsing. The set is hand-edited in the settings dialog,
// so it has to survive however a human types it — with spaces, without, or with
// commas — and must never shatter a multi-code-point emoji.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVaryModifierTexts, splitVaryModifierEntries } from "../shared/vary-modifiers.js";

const emojisOf = (raw) => splitVaryModifierEntries(raw).map((entry) => entry.emoji);

test("splits a space-separated set (the shipped default shape)", () => {
  assert.deepEqual(emojisOf("🧊 🌶️ 🦄"), ["🧊", "🌶️", "🦄"]);
});

test("splits a run written with no separators at all", () => {
  // Emoji appended without spaces would otherwise read as a single token that
  // matches nothing.
  assert.deepEqual(emojisOf("🧊🌶️🦄"), ["🧊", "🌶️", "🦄"]);
});

test("ignores whatever separators a human leaves between emoji", () => {
  assert.deepEqual(emojisOf("🧊,🌶️ , 🦄\n🎆\t🍦"), ["🧊", "🌶️", "🦄", "🎆", "🍦"]);
  assert.deepEqual(emojisOf("  "), []);
  assert.deepEqual(emojisOf(""), []);
  assert.deepEqual(emojisOf(null), []);
});

test("keeps multi-code-point emoji whole", () => {
  // Each of these would be shredded by a code-point split: ZWJ sequence,
  // skin-tone modifier, regional-indicator flag, U+FE0F variation selector,
  // and a keycap sequence.
  assert.deepEqual(emojisOf("👨‍👩‍👧"), ["👨‍👩‍👧"]);
  assert.deepEqual(emojisOf("👍🏽"), ["👍🏽"]);
  assert.deepEqual(emojisOf("🇦🇺"), ["🇦🇺"]);
  assert.deepEqual(emojisOf("❄️"), ["❄️"]);
  assert.deepEqual(emojisOf("👨‍👩‍👧👍🏽🇦🇺"), ["👨‍👩‍👧", "👍🏽", "🇦🇺"]);
});

test("the full shipped default set parses to one entry per emoji", () => {
  const shipped = "🧊 🌶️ 🦄 🎆 🍦 🧀 🌹 😎 🪩 🦦 🦘 ❄️ 🌊 🌕 🌲 🍌 💡 🕯️ 🚿";
  const parsed = emojisOf(shipped);
  assert.equal(parsed.length, 19);
  assert.deepEqual(parsed, shipped.split(" "));
  // ...and the same set pasted without its spaces yields exactly the same list.
  assert.deepEqual(emojisOf(shipped.replaceAll(" ", "")), parsed);
});

test("emoji:phrase overrides still bind, spaced or not", () => {
  assert.deepEqual(splitVaryModifierEntries("🧊:glacial"), [{ emoji: "🧊", phrase: "glacial" }]);
  assert.deepEqual(
    splitVaryModifierEntries("🧊:glacial 🌶️"),
    [{ emoji: "🧊", phrase: "glacial" }, { emoji: "🌶️", phrase: null }]
  );
});

test("a phrase written against a run of emoji applies to each of them", () => {
  // Otherwise "🧊❄️:frozen" would key a phrase to a two-emoji string that the
  // picker can never produce, and the override would be silently dead.
  assert.deepEqual(
    splitVaryModifierEntries("🧊❄️:frozen"),
    [{ emoji: "🧊", phrase: "frozen" }, { emoji: "❄️", phrase: "frozen" }]
  );
});

test("non-emoji tokens are dropped rather than becoming pick entries", () => {
  assert.deepEqual(emojisOf("🧊 not-an-emoji 🌶️"), ["🧊", "🌶️"]);
  assert.deepEqual(emojisOf("- , ;"), []);
});

test("duplicates are preserved (repetition is the set's only weighting)", () => {
  assert.deepEqual(emojisOf("🧊🧊🌶️"), ["🧊", "🧊", "🌶️"]);
});

test("emoji texts: one per line or ';', separators tolerated, blank text skipped", () => {
  assert.deepEqual(
    parseVaryModifierTexts("🦦 otter, wet fur\n🌶️: hot, spicy;🥛\n🦄=unicorn\n\nno emoji here"),
    { "🦦": "otter, wet fur", "🌶️": "hot, spicy", "🦄": "unicorn" }
  );
});
