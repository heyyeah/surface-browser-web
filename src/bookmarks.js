// Built-in bookmark presets for the browser/VR MVP.

import { loadAndExtractUrl, loadGenAiPrompt, loadImageSearch } from "./api.js";
import { bookmarksBtn, bookmarksMenu, urlInput } from "./dom.js";
import { setAddressFeedback, focusSceneCanvas } from "./ui.js";
import { BookmarkKind, DEFAULT_BOOKMARKS, bookmarkTitle, pickStartBookmarks } from "../shared/bookmark-presets.js";
import { t } from "./i18n.js";

let genAiBookmarksEnabled = false;
// Picked once per page load, and shared, so the flat start screen and the VR
// panel show the same three.
let startBookmarks = null;

function startFavoriteBookmarks() {
  startBookmarks ??= pickStartBookmarks();
  return startBookmarks;
}

function bookmarkModeLabel(kind) {
  if (kind === BookmarkKind.IMAGE_SEARCH) {
    return t("vr.chip.search");
  }
  if (kind === BookmarkKind.GENAI_PROMPT) {
    return t("vr.mode.genai");
  }
  return t("vr.mode.web");
}

function setBookmarksMenuOpen(open) {
  if (!bookmarksBtn || !bookmarksMenu) {
    return;
  }
  bookmarksMenu.hidden = !open;
  bookmarksBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleBookmarksMenu() {
  setBookmarksMenuOpen(Boolean(bookmarksMenu?.hidden));
}

async function activateBookmark(bookmark) {
  setBookmarksMenuOpen(false);
  urlInput.value = bookmark.value;
  setAddressFeedback(null);
  window.dispatchEvent(new CustomEvent("surface-browser:bookmark-activated", {
    detail: { kind: bookmark.kind }
  }));

  if (bookmark.kind === BookmarkKind.IMAGE_SEARCH) {
    await loadImageSearch({ query: bookmark.value });
    focusSceneCanvas();
    return;
  }

  if (bookmark.kind === BookmarkKind.GENAI_PROMPT) {
    await loadGenAiPrompt({ query: bookmark.value });
    focusSceneCanvas();
    return;
  }

  await loadAndExtractUrl({ query: bookmark.value });
  focusSceneCanvas();
}

function renderBookmarksMenu(bookmarks = DEFAULT_BOOKMARKS) {
  if (!bookmarksMenu) {
    return;
  }
  bookmarksMenu.textContent = "";
  for (const bookmark of bookmarks) {
    if (bookmark.kind === BookmarkKind.GENAI_PROMPT && !genAiBookmarksEnabled) {
      continue;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "bookmark-menu-item";
    item.role = "menuitem";
    item.ariaLabel = `${bookmarkModeLabel(bookmark.kind)} ${bookmark.value}`;
    item.title = bookmark.value;

    const mode = document.createElement("span");
    mode.className = `bookmark-mode bookmark-mode-${bookmark.kind}`;
    mode.textContent = bookmarkModeLabel(bookmark.kind);
    item.appendChild(mode);

    const title = document.createElement("span");
    title.className = "bookmark-title";
    title.textContent = bookmarkTitle(bookmark);
    item.appendChild(title);

    item.addEventListener("click", () => {
      void activateBookmark(bookmark);
    });
    bookmarksMenu.appendChild(item);
  }
}

function setGenAiBookmarksEnabled(enabled) {
  genAiBookmarksEnabled = Boolean(enabled);
  renderBookmarksMenu();
}

function isGenAiBookmarksEnabled() {
  return genAiBookmarksEnabled;
}

function setupBookmarks() {
  if (!bookmarksBtn || !bookmarksMenu) {
    return;
  }

  renderBookmarksMenu();
  bookmarksBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleBookmarksMenu();
  });

  bookmarksMenu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  window.addEventListener("click", () => {
    setBookmarksMenuOpen(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !bookmarksMenu.hidden) {
      setBookmarksMenuOpen(false);
      bookmarksBtn.focus();
    }
  });
}

export {
  BookmarkKind,
  DEFAULT_BOOKMARKS,
  activateBookmark,
  bookmarkModeLabel,
  bookmarkTitle,
  isGenAiBookmarksEnabled,
  setBookmarksMenuOpen,
  setGenAiBookmarksEnabled,
  setupBookmarks,
  startFavoriteBookmarks
};
