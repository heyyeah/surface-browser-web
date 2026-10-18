// Interface translation — the pure half, plus the wiring that cannot be seen
// from it. src/i18n.js is chrome only: bookmark labels, the emoji modifier map
// and the museum-safe blocklist stay English because they shape what gets
// GENERATED, and translating them would change the work.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  LANGUAGE_NAMES,
  resolveLanguage,
  normalizeLanguage,
  translate,
  allLanguageTables
} from "../src/i18n.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const html = read("index.html");
const mainJs = read("src/main.js");
const uiJs = read("src/ui.js");
const i18nJs = read("src/i18n.js");

// --- completeness ----------------------------------------------------------

test("EVERY language has every key — no visitor may reach a raw key", () => {
  // translate() falls back English-then-key. The key fallback exists so a
  // developer sees something rather than an exception; a visitor reaching
  // `help.tunnel.title` on screen would look broken, so the real guarantee is
  // this test rather than the fallback.
  const tables = allLanguageTables();
  const englishKeys = Object.keys(tables[DEFAULT_LANGUAGE]).sort();
  assert.ok(englishKeys.length > 40, "the English table should be the full set");
  for (const lang of SUPPORTED_LANGUAGES) {
    assert.deepEqual(Object.keys(tables[lang]).sort(), englishKeys,
      `${lang} must have exactly the English key set — no missing and no extra`);
  }
});

test("no translation is left as its English source", () => {
  // Catches a key pasted into fr/de and never translated. Deliberate exceptions
  // are listed: proper nouns, controller button letters and shared abbreviations
  // are the same word in all three.
  const SAME_ON_PURPOSE = new Set([
    "results.title",      // "Images" in English and French
    "start.aria",         // "Favorites"/"Favoris" differ; English vs French only
    "vr.short", "key.zoomIn", "key.zoomOut", "key.x", "key.ay",
    "key.thumbstick",     // "Joystick" in French
    "help.tunnel.title",  // "Tunnel" is the same word in all three
    // Callout tags are single words chosen to be short enough to read at a
    // glance on a controller; several are the same word in all three.
    "callout.menu",       // "Menu" everywhere
    "callout.zoom",       // "Zoom" everywhere
    "callout.screenshot", // "Screenshot" in German too
    "callout.pauseRotation", // "Pause rotation" in French too
    "vr.wrist.capture",   // "Capture" in French too, as the help rows call it
    "vr.about.heading",    // the work's name plus "in VR" reads the same in German
    // VR panel tabs and labels that are one word across languages (product or
    // control names, or shared loanwords).
    "vr.mode.web", "vr.mode.image", "vr.mode.genai", // "Image" in French
    "vr.tb.passthrough",  // Meta's own feature name in all three
    "vr.tb.status",       // "Status" in German
    "vr.map.stick",       // "Stick" in German
    "vrhelp.trigger",     // "Trigger" in German
    "vrhelp.pinch",       // "Pinch" in German (Meta's term)
    "footer.page", "footer.image" // "page" / "Image" in French
  ]);
  const tables = allLanguageTables();
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang === DEFAULT_LANGUAGE) continue;
    for (const [key, value] of Object.entries(tables[lang])) {
      if (SAME_ON_PURPOSE.has(key)) continue;
      assert.notEqual(value, tables[DEFAULT_LANGUAGE][key],
        `${lang}.${key} is still the English string`);
    }
  }
});

test("every language keeps the same {placeholders} as English", () => {
  // A dropped {icon} would draw a help row with no icon; a dropped {count}
  // would read as a status with no number.
  const tables = allLanguageTables();
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const [key, english] of Object.entries(tables[DEFAULT_LANGUAGE])) {
    for (const lang of SUPPORTED_LANGUAGES) {
      assert.equal(names(tables[lang][key]), names(english), `${lang}.${key} placeholders`);
    }
  }
});

test("translate() fills {placeholders} literally and leaves unknown ones", () => {
  assert.equal(translate("status.error", "en", { message: "$& boom" }), "Error: $& boom; keeping current scene");
  assert.ok(translate("vrhelp.passthroughControllers", "de").includes("{icon}"));
  assert.equal(translate("status.loadedGenerated", "fr", { count: 4 }), "4 images générées chargées");
});

test("every supported language has a name in its own language", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    assert.ok(LANGUAGE_NAMES[lang], `${lang} needs a display name`);
  }
  assert.equal(LANGUAGE_NAMES.de, "Deutsch", "not 'German' — the reader does not read English");
});

// --- resolution ------------------------------------------------------------

test("a region tag matches its base language", () => {
  // de-CH and de-AT are the realistic case for a European audience.
  for (const tag of ["de-CH", "de-AT", "de_DE", "DE"]) {
    assert.equal(resolveLanguage({ preferred: [tag] }), "de", tag);
  }
  assert.equal(resolveLanguage({ preferred: ["fr-CA"] }), "fr");
});

test("order of authority: ?lang beats stored beats browser", () => {
  // The URL wins so a link can be shared in a chosen language, and so a deployment
  // can pin one. The stored choice beats the browser because a visitor who picked
  // German meant it.
  assert.equal(resolveLanguage({ override: "fr", stored: "de", preferred: ["en"] }), "fr");
  assert.equal(resolveLanguage({ stored: "de", preferred: ["en"] }), "de");
  assert.equal(resolveLanguage({ preferred: ["en"] }), "en");
});

test("an unsupported or junk preference falls back to English, never throws", () => {
  for (const junk of [undefined, null, "", "ja", "klingon", "  ", 42, {}]) {
    assert.equal(resolveLanguage({ override: junk, preferred: [junk] }), DEFAULT_LANGUAGE,
      `override=${String(junk)}`);
  }
  assert.equal(resolveLanguage(), DEFAULT_LANGUAGE);
  assert.equal(resolveLanguage({ preferred: "not-an-array" }), DEFAULT_LANGUAGE);
});

test("an unsupported language walks the list rather than giving up at the first", () => {
  // navigator.languages on a European phone is routinely ["ja", "de-CH", "en"].
  assert.equal(resolveLanguage({ preferred: ["ja", "de-CH", "en"] }), "de");
});

test("translate falls back to English, then to the key", () => {
  assert.equal(translate("nav.bookmarks", "fr"), "Favoris");
  assert.equal(translate("nav.bookmarks", "ja"), "Bookmarks", "unknown language reads English");
  assert.equal(translate("no.such.key", "de"), "no.such.key");
});

test("normalizeLanguage rejects what it cannot serve", () => {
  assert.equal(normalizeLanguage("DE-at"), "de");
  assert.equal(normalizeLanguage("es"), "");
  assert.equal(normalizeLanguage(null), "");
});

// --- wiring ----------------------------------------------------------------

test("the markup is marked up, not hard-coded, for the public chrome", () => {
  // The dev-only toolbar rows are deliberately NOT translated: they are hidden
  // in a public build, so translating them would be work nobody reads.
  for (const key of ["omnibar.placeholder", "nav.bookmarks", "nav.help", "vr.enter", "results.title"]) {
    assert.ok(html.includes(key), `index.html should reference ${key}`);
  }
  assert.match(html, /data-i18n-attr="placeholder:omnibar\.placeholder"/);
});

test("language is resolved before anything with words in it renders", () => {
  // Later would show English for a frame and then swap.
  const initIndex = mainJs.indexOf("initLanguage()");
  const menuIndex = mainJs.indexOf("setupShortcutsMenu();");
  assert.ok(initIndex !== -1 && menuIndex !== -1);
  assert.ok(initIndex < menuIndex, "initLanguage() must run before the help panel is built");
});

test("the help panel and the VR button read t(), not literals", () => {
  const render = mainJs.slice(mainJs.indexOf("function renderShortcutsMenu"));
  const body = render.slice(0, render.indexOf("\nfunction "));
  assert.match(body, /addTitle\(t\("help\.tunnel\.title"\)\)/);
  assert.match(body, /addTitle\(t\("help\.sphere\.title"\)\)/);
  // The English sentences must be gone from the renderer: one source of truth.
  assert.doesNotMatch(body, /"In the tunnel"/);
  assert.doesNotMatch(body, /"Turn the sphere"/);
  assert.match(uiJs, /exitVrBtn\.textContent = vrUnavailable \? t\("vr\.short"\) : t\("vr\.enter"\)/);
});

test("the language picker has its own toolbar menu, and each option is in its own language", () => {
  const render = mainJs.slice(mainJs.indexOf("function renderLanguageMenu"));
  const body = render.slice(0, render.indexOf("\nfunction "));
  assert.match(body, /LANGUAGE_NAMES\[code\]/);
  // `lang` on the button so a screen reader switches voice for that one word.
  assert.match(body, /setAttribute\("lang", code\)/);
  assert.match(body, /setLanguage\(code\)/);
});

test("<html lang> follows the choice", () => {
  // The document lang is what a screen reader picks a voice from and what a browser
  // offers to translate against, so it must follow the chosen language.
  assert.match(i18nJs, /document\.documentElement\.lang = activeLanguage/);
});

test("every storage and locale read is wrapped", () => {
  // A private window throws on localStorage READ as well as write, and a missing
  // navigator.languages is real on old browsers. Neither may take the page down.
  for (const fn of ["readUrlLanguage", "readStoredLanguage", "readBrowserLanguages"]) {
    const slice = i18nJs.slice(i18nJs.indexOf(`function ${fn}`));
    assert.match(slice.slice(0, 400), /try \{[\s\S]*catch/, `${fn} must be wrapped`);
  }
});
