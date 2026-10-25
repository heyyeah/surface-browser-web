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

// `start: true` puts a bookmark in the rotation for its category's tile on the
// start screen. Only sites that won't mind the traffic: no news sites.
// `title` replaces the hostname on cards and in menus.
const DEFAULT_BOOKMARKS = Object.freeze([
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.boxc.net/browserfood.html", title: "Browser Food", start: true },
  { kind: BookmarkKind.WEB_PAGE, value: "https://publicdomainreview.org/collections/images/", title: "The Public Domain Review", start: true },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.europeana.eu/en/galleries", title: "Europeana galleries", start: true },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.rijksmuseum.nl/en/collection", title: "Rijksmuseum collection", start: true },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.bbc.com", title: "BBC", start: true },
  { kind: BookmarkKind.IMAGE_SEARCH, value: "browser art", start: true },
  { kind: BookmarkKind.IMAGE_SEARCH, value: "wild river", start: true },
  { kind: BookmarkKind.IMAGE_SEARCH, value: "ocean horizon", start: true },
  { kind: BookmarkKind.WEB_PAGE, value: "https://edition.cnn.com" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.theverge.com" },
  { kind: BookmarkKind.GENAI_PROMPT, value: "otters", start: true },
  { kind: BookmarkKind.GENAI_PROMPT, value: "IMG_0376.jpg", start: true },
  { kind: BookmarkKind.GENAI_PROMPT, value: "a liminal space of light and glass", start: true },
  { kind: BookmarkKind.GENAI_PROMPT, value: "sunday evening", start: true },
  { kind: BookmarkKind.GENAI_PROMPT, value: "giraffe in an overgrown brutalist ruin", start: true },
  { kind: BookmarkKind.WEB_PAGE, value: "https://commons.wikimedia.org/wiki/Commons:Picture_of_the_day", title: "Wikimedia Picture of the Day" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.nasa.gov/image-of-the-day/", title: "NASA Image of the Day" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://solarsystem.nasa.gov/solar-system/sun/overview/", title: "NASA Solar System Overview" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://artforum.com" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.theartnewspaper.com/keywords/digital-art" },
  { kind: BookmarkKind.WEB_PAGE, value: "https://www.monopol-magazin.de" }
]);

// One start tile per category, picked at random from its `start` bookmarks.
function pickStartBookmarks(bookmarks = DEFAULT_BOOKMARKS, random = Math.random) {
  return [BookmarkKind.WEB_PAGE, BookmarkKind.IMAGE_SEARCH, BookmarkKind.GENAI_PROMPT]
    .map((kind) => {
      const choices = bookmarks.filter((bookmark) => bookmark.kind === kind && bookmark.start);
      return choices.length ? choices[Math.floor(random() * choices.length)] : null;
    })
    .filter(Boolean);
}

function bookmarkTitle(bookmark) {
  if (bookmark.title || bookmark.kind !== BookmarkKind.WEB_PAGE) {
    return bookmark.title || bookmark.value;
  }
  try {
    return new URL(bookmark.value).hostname.replace(/^www\./, "");
  } catch {
    return bookmark.value;
  }
}

function genAiBookmarkPrompts(bookmarks = DEFAULT_BOOKMARKS) {
  return bookmarks
    .filter((bookmark) => bookmark.kind === BookmarkKind.GENAI_PROMPT)
    .map((bookmark) => bookmark.value);
}

export { BookmarkKind, DEFAULT_BOOKMARKS, bookmarkTitle, genAiBookmarkPrompts, pickStartBookmarks };
