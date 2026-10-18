// A deliberately small URL-shape gate shared by the omnibar and /api/extract.
// It is not URL validation (the server still normalizes, resolves DNS and
// applies SSRF policy); it only distinguishes a likely web address from a
// filename or free-form token before coercing it to https://….

const FILE_LIKE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "heic", "bmp", "tif", "tiff",
  "mp3", "wav", "m4a", "ogg", "flac", "mp4", "mov", "mkv", "webm", "avi",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "epub",
  "zip", "gz", "rar", "7z", "tar", "dmg", "iso", "exe", "msi"
]);

export function hasNavigableUrlShape(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  // A path is an intentional URL-like shape even when the host is terse, e.g.
  // example.com/a/x.html. It remains subject to normal server validation.
  if (value.includes("/")) {
    return true;
  }
  const hostname = value.split(/[?#]/, 1)[0].toLowerCase();
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length < 2) {
    return false;
  }
  const finalLabel = labels[labels.length - 1];
  if (FILE_LIKE_EXTENSIONS.has(finalLabel)) {
    return false;
  }
  // A conventional two-or-more-character final label is enough to classify
  // example.com and similar bare hosts as URL-shaped without maintaining a
  // brittle global TLD list.
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(finalLabel)
    && finalLabel.length >= 2;
}

// "file" or "address": which of the two refusals applies. The client picks its
// own translated wording from this; urlShapeMessage() is the English text.
export function urlShapeReason(value) {
  const token = String(value || "").trim();
  return /^[^/]+\.[a-z0-9]{2,8}$/i.test(token) ? "file" : "address";
}

export function urlShapeMessage(value) {
  if (urlShapeReason(value) === "file") {
    return "That looks like a file name, not a web address";
  }
  return "Enter a web address such as example.com or https://example.com";
}
