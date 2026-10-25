// Parsing for the GENAI_VARY_MODIFIERS emoji set. Split out of server/index.js
// so it is unit-testable offline.

// One emoji is often several code points (ZWJ sequence, skin-tone modifier,
// regional-indicator pair, base plus U+FE0F), so the set is split on grapheme
// clusters; code-point splitting would shatter them. Array.from is the degraded
// fallback that at least keeps astral characters whole.
const graphemeSegmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter("en", { granularity: "grapheme" })
  : null;

function splitGraphemes(value) {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

// Keeps emoji, drops separators. Regional_Indicator covers flags, whose halves
// are not Extended_Pictographic on their own.
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

// Parse the setting into ordered { emoji, phrase } entries.
//
// Whitespace between emoji is optional ("🧊🌶️🦄" reads as three modifiers);
// anything else between them (spaces, commas, punctuation) is ignored.
//
// `emoji:phrase` binds a payload=text phrase to that emoji. The phrase is one
// token (no whitespace); multi-word defaults live in the built-in map. A phrase
// written against a run of emoji applies to each of them.
//
// Duplicates are preserved: repeating an emoji is the setting's only weighting.
export function splitVaryModifierEntries(raw) {
  const entries = [];
  for (const token of String(raw || "").split(/\s+/)) {
    if (!token) {
      continue;
    }
    const colon = token.indexOf(":");
    const emojiPart = colon === -1 ? token : token.slice(0, colon);
    const phrase = colon === -1 ? null : (token.slice(colon + 1).trim() || null);
    for (const grapheme of splitGraphemes(emojiPart)) {
      if (!EMOJI_GRAPHEME.test(grapheme)) {
        continue;
      }
      entries.push({ emoji: grapheme, phrase });
    }
  }
  return entries;
}

// GENAI_VARY_MODIFIER_TEXTS: one "emoji text" pair per line (or ";"), e.g.
// "🦦 otter, playful wet fur". A ":" or "=" after the emoji is tolerated; a line
// with no text is skipped, so that emoji keeps its built-in text or goes bare.
export function parseVaryModifierTexts(raw) {
  const texts = {};
  for (const line of String(raw || "").split(/[\n;]/)) {
    const match = /^\s*(\S+?)\s*[:=]?\s+(.*\S)\s*$/u.exec(line) || /^\s*(\S+?)[:=](.*\S)\s*$/u.exec(line);
    if (!match) {
      continue;
    }
    const [emoji] = splitVaryModifierEntries(match[1]).map((entry) => entry.emoji);
    if (emoji) {
      texts[emoji] = match[2];
    }
  }
  return texts;
}
