import { test } from "node:test";
import assert from "node:assert/strict";
import { hasNavigableUrlShape } from "../shared/url-shape.js";

test("URL-shape gate accepts explicit URLs, hosts, and paths", () => {
  for (const value of ["https://example.com", "http://example.com/a", "example.com", "boxc.net/bfood/x.html"]) {
    assert.equal(hasNavigableUrlShape(value), true, value);
  }
});

test("URL-shape gate rejects bare file-like and free-form tokens", () => {
  for (const value of ["img_3456.jpg", "holiday.webp", "document.pdf", "just words", "giraffe"]) {
    assert.equal(hasNavigableUrlShape(value), false, value);
  }
});
