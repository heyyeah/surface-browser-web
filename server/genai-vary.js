import { createHash, randomInt } from "node:crypto";
import { parseVaryModifierTexts, splitVaryModifierEntries } from "../shared/vary-modifiers.js";
import { getStoredGenAiImage } from "./genai-store.js";
import {
  getGenAiVaryModifierMode,
  getGenAiVaryModifierPayload,
  getGenAiVaryModifierStyle,
  getIntegerSetting,
  getStringSetting
} from "./settings.js";

// GenAI vary emoji-modifier config.
// mode:    off | batch (one emoji per vary request) | per-image (one branch each).
// style:   replace (default: the img2img prompt is the modifier payload alone;
//          the source image already carries the content, so the modifier is the
//          only conditioning and denoising strength controls the pull) | append
//          (the newest GENAI_VARY_PROMPT_EMOJI modifiers appended to the
//          lineage prompt).
// payload: text (default: a short adjective phrase mapped from the emoji) |
//          emoji (raw-character fallback for providers whose text encoders
//          understand emoji strongly).
// The stack is the lineage's emoji, oldest first, for display and pool keys;
// past the cap the oldest drops off. Only the newest few are sent: the source
// image already carries the earlier ones.
export const VARY_MODIFIER_STACK_CAP = 6;

// Built-in emoji->phrase defaults for payload=text. Overridable per emoji via
// `emoji:phrase` tokens in GENAI_VARY_MODIFIERS; an override phrase is one
// whitespace-free token (e.g. `🧊:frozen`), which is why multi-word/comma
// phrases ship as these defaults. Emoji need no separator; see
// shared/vary-modifiers.js.
const VARY_MODIFIER_DEFAULT_PHRASES = {
  "🧊": "icy, frozen",
  "🌶️": "spicy, hot red",
  "🦄": "unicorn, fantastical",
  "🎆": "fireworks, sparkling explosive light",
  "🍦": "ice cream, sweet dessert",
  "🧀": "cheese, golden yellow",
  "🌹": "roses, red floral petals",
  "😎": "sunglasses, cool glossy reflections",
  "🪩": "mirror ball, disco reflections",
  "🦦": "otter, playful wet fur",
  "🦘": "kangaroo, Australian outback",
  "❄️": "snow, snowy white",
  "🌊": "water wave, ocean blue",
  "🌕": "full moon, moonlit night",
  "🌲": "evergreen tree, pine forest",
  "🍌": "banana, bright tropical yellow",
  "💡": "light bulb, glowing bright idea",
  "🕯️": "candle, warm candlelit flame",
  "🚿": "shower, falling water and steam",
  "🤗": "warm, joyful",
  "🤖": "robotic, mechanical",
  "🥛": "glass of milk, milky",
  "💦": "splashing droplets, sweaty and steamy",
  "😈": "grinning devil, mischievous and naughty",
  "🚀": "rocket launch, to the moon",
  "❤️": "red heart, love",
  "🎧": "headphones, music",
  "🥰": "smitten, surrounded by little hearts",
  "🍆": "aubergine, eggplant, cheeky innuendo",
  "📹": "video, movie, film, filming",
  "☀️": "blazing sunshine, summer holiday",
  "😉": "wink, flirtatious, in on the joke",
  "🐷": "pig, piggy",
  "🫶": "heart hands, caring, solidarity",
  "🤩": "star-struck, dazzled by fame"
};

// The emoji pick list from GENAI_VARY_MODIFIERS. Separators between emoji are
// optional — see splitVaryModifierEntries in shared/vary-modifiers.js.
function getGenAiVaryModifierEmojis() {
  return splitVaryModifierEntries(getStringSetting("GENAI_VARY_MODIFIERS")).map((entry) => entry.emoji);
}

// emoji→phrase map for payload=text: built-in defaults overlaid with any
// `emoji:phrase` overrides parsed from GENAI_VARY_MODIFIERS.
export function getGenAiVaryModifierPhraseMap() {
  const map = { ...VARY_MODIFIER_DEFAULT_PHRASES };
  for (const { emoji, phrase } of splitVaryModifierEntries(getStringSetting("GENAI_VARY_MODIFIERS"))) {
    if (phrase) {
      map[emoji] = phrase;
    }
  }
  return { ...map, ...parseVaryModifierTexts(getStringSetting("GENAI_VARY_MODIFIER_TEXTS")) };
}

// The text phrase for an emoji, falling back to the raw emoji when unmapped so
// payload=text never silently drops a modifier.
function getVaryModifierPhrase(emoji) {
  const map = getGenAiVaryModifierPhraseMap();
  return map[emoji] || emoji;
}

// Deterministic-when-seeded emoji pick. `salt` disambiguates per-image picks so
// two variations in one batch can differ while still replaying from the seed.
function pickVaryModifierEmoji(emojis, seed, salt = 0) {
  if (!emojis.length) {
    return null;
  }
  let index;
  if (Number.isFinite(seed)) {
    // Mix seed + salt into a stable non-negative index (avoids adjacent seeds
    // marching predictably through the list for per-image picks).
    const mixed = Math.abs(Math.imul((seed | 0) + salt * 0x9e3779b1, 0x85ebca6b)) >>> 0;
    index = mixed % emojis.length;
  } else {
    index = Math.floor(Math.random() * emojis.length);
  }
  return emojis[index] || null;
}

function pickVaryModifierEmojiFromSequence(emojis, seed, salt = 0) {
  if (!emojis.length) {
    return null;
  }
  const round = Math.floor(Math.max(0, Number(salt) || 0) / emojis.length);
  const index = Math.max(0, Number(salt) || 0) % emojis.length;
  const shuffled = shuffledVaryModifierEmojis(emojis, seed, round);
  return shuffled[index] || null;
}

function shuffledVaryModifierEmojis(emojis, seed, round = 0) {
  const withKeys = emojis.map((emoji, index) => ({
    emoji,
    key: varyModifierShuffleKey(seed, round, emoji, index)
  }));
  withKeys.sort((a, b) => a.key.localeCompare(b.key));
  return withKeys.map((entry) => entry.emoji);
}

function varyModifierShuffleKey(seed, round, emoji, index) {
  const stableSeed = Number.isFinite(seed) ? String(seed) : String(randomInt(0, 2 ** 32));
  return createHash("sha256")
    .update(`${stableSeed}:${round}:${index}:${emoji}`)
    .digest("hex");
}

// Inherited modifier emojis from the vary source's lineage (for vary-of-vary
// compounding). Reads the source record's own modifier plus its ancestors',
// closest-first, deduped.
function collectInheritedModifierEmojis(sourceRecord) {
  const emojis = [];
  const seen = new Set();
  let current = sourceRecord;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const emoji = current.genai?.modifier?.emoji;
    if (emoji && !emojis.includes(emoji)) {
      emojis.push(emoji);
    }
    const parentId = current.genai?.parentId;
    current = parentId ? getStoredGenAiImage(parentId) : null;
  }
  return emojis;
}

// Render one emoji's payload for the sent prompt: the raw emoji, or its mapped
// text phrase when payload=text.
function renderVaryModifierPayload(emoji, payload) {
  return payload === "text" ? getVaryModifierPhrase(emoji) : emoji;
}

function buildVaryModifierStack(sourceRecord, chosen) {
  // The source's own stack survives its ancestors leaving the image store; the
  // walk is for records made before stacks were stored.
  const stored = sourceRecord?.genai?.modifier?.stack;
  const ordered = Array.isArray(stored) ? stored : [...collectInheritedModifierEmojis(sourceRecord)].reverse();
  return [...ordered.filter((emoji) => emoji !== chosen), chosen].slice(-VARY_MODIFIER_STACK_CAP);
}

// Compose the modifier for one variation. Returns:
//   prompt   - the string actually sent to the provider for this variation.
//   modifier - the lineage field for this item: { emoji, phrase, sentPrompt }
//              (phrase null unless payload=text), or null when nothing applied.
// Style semantics:
//   replace (default) - the sent prompt is the modifier payload alone (the source
//     image already carries the content; denoising strength controls how far the
//     modifier pulls). No lineage prompt, no compounding.
//   append - the newest GENAI_VARY_PROMPT_EMOJI modifiers appended to the
//     lineage prompt; earlier ones are in the source image, not the text.
//   auto - replace for a local edit model (model-profiles.js); any other local
//     model gets the lineage prompt plus every stack emoji (`appendCount`), since
//     it redraws rather than edits the source.
// `style` overrides the configured setting for one provider request. Replace is
// only coherent where the request also carries a denoising-strength dial, which
// is what keeps the source in the frame. An edit endpoint without one (Fal Klein;
// see getFalModelCapabilities) would receive a bare emoji and replace the picture
// with the emoji's subject, so those callers pass append, which anchors the edit
// to the lineage prompt.
export function composeVaryModifier({ basePrompt, sourceRecord, seed = null, salt = 0, style: styleOverride = null, appendCount = null }) {
  const mode = getGenAiVaryModifierMode();
  if (!sourceRecord || mode === "off") {
    return { prompt: basePrompt, modifier: null };
  }
  // An emoji already in the chain only reorders it: a repaint model gets the
  // same words and redraws the source. The whole set again once it is used up.
  const stored = sourceRecord.genai?.modifier?.stack;
  const inChain = new Set(Array.isArray(stored) ? stored : collectInheritedModifierEmojis(sourceRecord));
  const palette = getGenAiVaryModifierEmojis();
  const fresh = palette.filter((emoji) => !inChain.has(emoji));
  const emojis = fresh.length ? fresh : palette;
  // batch: one emoji for the whole request (salt fixed). per-image: salt is the
  // variation's global index into a seeded shuffled subset of the configured palette.
  const effectiveSalt = mode === "per-image" ? salt : 0;
  const chosen = mode === "per-image"
    ? pickVaryModifierEmojiFromSequence(emojis, seed, effectiveSalt)
    : pickVaryModifierEmoji(emojis, seed, effectiveSalt);
  if (!chosen) {
    return { prompt: basePrompt, modifier: null };
  }
  // auto with no model to judge by: append, which keeps the subject either way.
  const configured = getGenAiVaryModifierStyle();
  const style = styleOverride || (configured === "auto" ? "append" : configured);
  const payload = getGenAiVaryModifierPayload();
  const phrase = payload === "text" ? getVaryModifierPhrase(chosen) : null;

  if (style === "replace") {
    // The sent prompt is the modifier payload alone: no lineage, no compounding.
    const sentPrompt = renderVaryModifierPayload(chosen, payload);
    return { prompt: sentPrompt, modifier: { emoji: chosen, phrase, sentPrompt, stack: buildVaryModifierStack(sourceRecord, chosen) } };
  }

  // append (legacy): compound onto the clean lineage prompt, capped.
  const inherited = collectInheritedModifierEmojis(sourceRecord);
  // genai.prompt holds the base lineage prompt without the modifier suffix, but
  // older records may carry one: strip any trailing inherited-emoji suffix before
  // re-composing.
  const cleanBase = stripModifierSuffix(basePrompt, inherited);
  const stack = buildVaryModifierStack(sourceRecord, chosen);
  const suffix = stack
    .slice(-(appendCount || getIntegerSetting("GENAI_VARY_PROMPT_EMOJI")))
    .map((emoji) => renderVaryModifierPayload(emoji, payload))
    .join(payload === "text" ? ", " : " ");
  const sentPrompt = cleanBase ? `${cleanBase}, ${suffix}` : suffix;
  return { prompt: sentPrompt, modifier: { emoji: chosen, phrase, sentPrompt, stack } };
}

// Remove a trailing ", <emoji …>" segment previously appended by an earlier
// vary, given the inherited emoji. Only strips when the tail is composed solely
// of inherited modifier emoji (and whitespace) so a legitimately emoji-ending
// user prompt is left alone.
function stripModifierSuffix(prompt, inheritedEmojis) {
  const text = String(prompt || "");
  if (!inheritedEmojis.length) {
    return text;
  }
  const lastComma = text.lastIndexOf(",");
  if (lastComma === -1) {
    return text;
  }
  const tail = text.slice(lastComma + 1).trim();
  if (!tail) {
    return text;
  }
  const tailTokens = tail.split(/\s+/).filter(Boolean);
  if (tailTokens.length && tailTokens.every((token) => inheritedEmojis.includes(token))) {
    return text.slice(0, lastComma).trimEnd();
  }
  return text;
}
