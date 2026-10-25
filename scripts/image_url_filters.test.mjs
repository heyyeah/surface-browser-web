// The URL-only image filters: lazy-load stand-ins and blur-up previews.

import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredImageEdge, isPlaceholderImageUrl, isStandInImageSource } from "../server/image-url-filters.js";

test("placeholder files are recognised by name, ordinary names are not", () => {
  for (const url of [
    "https://static.files.bbci.co.uk/web/1/grey-placeholder.png",
    "https://example.com/img/spacer.gif",
    "https://example.com/transparent_1x1.gif"
  ]) {
    assert.equal(isPlaceholderImageUrl(url), true, url);
  }
  for (const url of ["https://example.com/blanket.jpg", "https://example.com/loading-cat.png", "https://example.com/myplaceholder.png"]) {
    assert.equal(isPlaceholderImageUrl(url), false, url);
  }
  assert.equal(isStandInImageSource("data:image/gif;base64,R0lGOD"), true);
  assert.equal(isStandInImageSource("/assets/placeholder.png?v=2"), true);
});

test("the declared size is read from ?w=/&h= and from a IIIF size segment", () => {
  assert.equal(declaredImageEdge("https://www.rijksmuseum.nl/api/headless/assets/x?w=40&h=22&format=webp"), 40);
  assert.equal(declaredImageEdge("https://iiif.micr.io/hZepb/98,868.3,5737,3155.3/40,22/0/default.webp"), 40);
  assert.equal(declaredImageEdge("https://iiif.micr.io/ecqwF/full/%5E40,22/0/default.webp"), 40);
  assert.equal(declaredImageEdge("https://iiif.micr.io/QkOGy/39,43,4541,5040/%5E40,/0/default.webp"), 40);
  assert.equal(declaredImageEdge("https://iiif.micr.io/hZepb/98,294.6,5737,4302.7/1440,1080/0/default.webp"), 1440);
  assert.equal(declaredImageEdge("https://iiif.example.org/id/full/max/0/default.jpg"), null);
  assert.equal(declaredImageEdge("https://example.com/photo.jpg"), null);
});
