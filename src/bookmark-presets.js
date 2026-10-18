// Built-in bookmark presets, as data only.
//
// NO DOM IMPORTS. The server imports this to recognise GenAI bookmark prompts
// for auto-pooling, and the baker imports it to pick what to bake; both run in
// plain Node. bookmarks.js (the menu) imports it too, so there is one list.

const BookmarkKind = Object.freeze({
  WEB_PAGE: 0,
  IMAGE_SEARCH: 1,
  GENAI_PROMPT: 2
});

const DEFAULT_BOOKMARKS = Object.freeze([
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.boxc.net/browserfood.html" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.bbc.com" },
  { kind: BookmarkKind.IMAGE_SEARCH, value: "browser art" },
  { kind: BookmarkKind.IMAGE_SEARCH, value: "wild river" },
  { kind: BookmarkKind.IMAGE_SEARCH, value: "ocean horizon" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://edition.cnn.com" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.theverge.com" },
  { kind: BookmarkKind.GENAI_PROMPT, value: "otters" },
  { kind: BookmarkKind.GENAI_PROMPT, value: "IMG_0376.jpg" },
  { kind: BookmarkKind.GENAI_PROMPT, value: "a liminal space of light and glass" },
  { kind: BookmarkKind.GENAI_PROMPT, value: "sunday" },
  { kind: BookmarkKind.GENAI_PROMPT, value: "giraffe in an overgrown brutalist ruin" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.theartnewspaper.com/keywords/digital-art" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.monopol-magazin.de" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://solarsystem.nasa.gov/solar-system/sun/overview/" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://artforum.com" }
]);

function genAiBookmarkPrompts(bookmarks = DEFAULT_BOOKMARKS) {
  return bookmarks
    .filter((bookmark) => bookmark.kind === BookmarkKind.GENAI_PROMPT)
    .map((bookmark) => bookmark.value);
}

export { BookmarkKind, DEFAULT_BOOKMARKS, genAiBookmarkPrompts };
