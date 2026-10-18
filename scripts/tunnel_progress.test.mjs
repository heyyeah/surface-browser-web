import test from "node:test";
import assert from "node:assert/strict";
import {
  completedTunnelPanelCount,
  tunnelProgressText,
  shortSourceLabel,
  genAiProgressText,
  resetGenAiRequestLabels,
  tunnelErrorText
} from "../src/tunnel-progress.js";

test("tunnel progress is cumulative and never falls with the live panel count", () => {
  assert.equal(completedTunnelPanelCount(8, 15), 8);
  // The eight attached panels can subsequently be culled behind the camera;
  // their cumulative load progress must remain eight, not fall to a live count.
  assert.equal(completedTunnelPanelCount(8, 15), 8);
  assert.equal(completedTunnelPanelCount(20, 15), 15);
});

test("tunnel progress formats web and image-search loads from the cumulative count", () => {
  const domainFromUrl = (query) => query === "https://boxc.net/bfood/browserfood_numbers.html" ? "boxc.net" : "";
  assert.equal(
    tunnelProgressText({
      mode: "url",
      query: "https://boxc.net/bfood/browserfood_numbers.html",
      totalCount: 15,
      spawnedCount: 8,
      domainFromUrl
    }),
    "Loading boxc.net... 8/15 images"
  );
  assert.equal(
    tunnelProgressText({
      mode: "image_search",
      query: "numbers",
      totalCount: 15,
      spawnedCount: 15,
      domainFromUrl
    }),
    "Searching... 15/15"
  );
});

// An img2img run started from a selected image must name its origin, and show
// the batch total from the count SETTING rather than counting up from an unknown
// total (label and total are both known when the trigger fires, before any job
// exists).
test("GenAI variation progress names the source origin and uses the settings total", () => {
  assert.equal(
    genAiProgressText({ variationLabel: "boxc.net/…/24hrCoverage", received: 2, expected: 5 }),
    "Variations on boxc.net/…/24hrCoverage · 2/5"
  );
  // The acknowledgement frame, before any image has arrived.
  assert.equal(
    genAiProgressText({ variationLabel: "boxc.net/…/24hrCoverage", received: 0, expected: 5 }),
    "Variations on boxc.net/…/24hrCoverage · 0/5"
  );
  assert.equal(
    genAiProgressText({ variationLabel: "boxc.net/…/24hrCoverage", received: 0, expected: 0 }),
    "Variations on boxc.net/…/24hrCoverage"
  );
});

test("plain text-to-image GenAI wording is unchanged", () => {
  assert.equal(genAiProgressText({ variationLabel: "", received: 2, expected: 5 }), "Generating 2 of 5...");
  assert.equal(genAiProgressText({ received: 0, expected: 0 }), "Generating...");
});

test("short source labels stay inside the VR footer budget", () => {
  assert.equal(
    shortSourceLabel("https://www.boxc.net/bfood/24hrCoverage.html"),
    "boxc.net/…/24hrCoverage"
  );
  // Single-segment paths elide nothing, so they must not claim to.
  assert.equal(shortSourceLabel("https://example.test/page"), "example.test/page");
  assert.equal(shortSourceLabel("https://example.test/"), "example.test");
  assert.equal(shortSourceLabel("not a url"), "");
  const long = shortSourceLabel(
    "https://example.test/a/b/an-extremely-long-final-path-segment-that-cannot-possibly-fit",
    40
  );
  assert.ok(long.length <= 40, `expected <= 40 chars, got ${long.length}: "${long}"`);
  assert.ok(long.startsWith("example.test/…/"), `lost the host: "${long}"`);
});

// A failed/empty GenAI job must not leave the tunnel (and VR footer) reading
// "Generating N of M..." forever, or silently blank. api.js routes the provider
// error through this formatter for the status footer (state.genAiJobError,
// statusFooterText in ui.js). The full error is logged server-side, so this only
// needs to stay short and legible.
test("tunnel error text prefixes and fits within the footer budget", () => {
  assert.equal(
    tunnelErrorText("Draw Things img2img returned HTTP 422", 96),
    "GenAI failed: Draw Things img2img returned HTTP 422"
  );
  assert.equal(tunnelErrorText(""), "", "no error, no footer text");
  assert.equal(tunnelErrorText(null), "");
});

test("tunnel error text truncates long provider errors instead of overflowing the footer", () => {
  const longError = "Draw Things img2img returned HTTP 422: init_images height doesn't match 268 from the parameter 346";
  const text = tunnelErrorText(longError, 48);
  assert.ok(text.length <= 48, `expected <= 48 chars, got ${text.length}: "${text}"`);
  assert.ok(text.startsWith("GenAI failed: "), "must keep the prefix rather than truncating it away");
  assert.ok(text.endsWith("..."), "must mark the text as truncated");
});

// --- a new request never wears the previous one's name -----------------------
//
// Three state fields can put a previous request's identity on the footer. A
// refusal that resolves after a new prompt has started must not land on the new
// request's progress line.

test("beginning a request clears every field that can name the previous one", () => {
  const state = {
    // What a refused variations run leaves behind.
    genAiLaunch: { status: "failed", label: "example-nsfw.test/…/gallery" },
    genAiVariationLabel: "example-nsfw.test/…/gallery",
    genAiJobError: "Blocked: example-nsfw.test/…/gallery",
    // Untouched: this is a label reset, not a progress reset.
    genAiBatchExpected: 5,
    currentQuery: "otters"
  };
  resetGenAiRequestLabels(state);
  assert.equal(state.genAiLaunch, null, "the img2img launch is the footer's FIRST branch");
  assert.equal(state.genAiVariationLabel, "");
  assert.equal(state.genAiJobError, null);
  assert.equal(state.genAiBatchExpected, 5);
  assert.equal(state.currentQuery, "otters");
});

test("with the labels cleared the footer can only describe the NEW request", () => {
  const state = {
    genAiLaunch: { status: "failed", label: "example-nsfw.test/…/gallery" },
    genAiVariationLabel: "example-nsfw.test/…/gallery",
    genAiJobError: "Blocked: example-nsfw.test/…/gallery"
  };
  resetGenAiRequestLabels(state);
  const footer = genAiProgressText({
    variationLabel: state.genAiVariationLabel,
    received: 0,
    expected: 5
  });
  assert.equal(footer, "Generating 0 of 5...");
  assert.ok(!footer.includes("nsfw"), "the previous input is gone, not merely reordered");
});

test("the reset tolerates a missing state object rather than throwing", () => {
  assert.equal(resetGenAiRequestLabels(null), null);
});

// Source-level because neither call site can be exercised offline (one needs a
// live request, the other a 25 s XR round trip); same approach as
// wrist_poke.test.mjs uses for activateTarget().

async function readSrc(name) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, "..", "src", name), "utf8");
}

test("every new load request goes through the one label reset", async () => {
  const api = await readSrc("api.js");
  const fn = api.slice(api.indexOf("function beginLoadRequest("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(/resetGenAiRequestLabels\(state\)/.test(body));
  assert.ok(
    !/state\.genAiJobError = null/.test(body),
    "one list, in tunnel-progress.js — not a second copy that can drift"
  );
});

test("a superseded image import stays silent instead of overwriting the footer", async () => {
  const sphere = await readSrc("sphere.js");
  const fn = sphere.slice(sphere.indexOf("async function importSelectedSphereImageForGenAi"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  const guards = body.match(/state\.genAiLaunch !== launch/g) || [];
  assert.equal(
    guards.length,
    2,
    "BOTH exits check it: the failure path is the one that used to write regardless"
  );
  const failure = body.slice(body.indexOf("} catch"));
  assert.ok(
    failure.indexOf("state.genAiLaunch !== launch") < failure.indexOf("state.genAiJobError = message"),
    "the supersession check has to come BEFORE the write it is guarding"
  );
});

// The VR menu's status line: "Loading: x" in the tunnel, "Browsing: x" in the
// sphere, "Error loading: x" after a failure, and nothing at all before anything
// has been asked for.
test("menu status names the load and nothing else", async () => {
  const { menuStatusText } = await import("../src/tunnel-progress.js");
  const url = { mode: "url", query: "https://www.example.com/a/b", failed: false };
  assert.equal(menuStatusText({ appState: "tunnel", menuLoad: null }), "");
  assert.equal(menuStatusText({ appState: "tunnel", menuLoad: url }), "Loading: example.com");
  assert.equal(menuStatusText({ appState: "inside_sphere", menuLoad: url }), "Browsing: example.com");
  assert.equal(
    menuStatusText({ appState: "inside_sphere", menuLoad: url, requestInFlight: true }),
    "Loading: example.com",
    "a new load started from the sphere is loading, not browsing"
  );
  assert.equal(
    menuStatusText({ appState: "inside_sphere", menuLoad: { ...url, failed: true } }),
    "Error loading: example.com"
  );
  assert.equal(
    menuStatusText({ appState: "tunnel", menuLoad: { mode: "image_search", query: "red  kites" } }),
    "Loading: red kites"
  );
  const prompt = { mode: "genai", query: "a very long prompt ".repeat(8) };
  assert.ok(menuStatusText({ appState: "tunnel", menuLoad: prompt }).length <= 56);
  assert.equal(
    menuStatusText({ appState: "tunnel", menuLoad: url, voiceText: "Listening… speak now" }),
    "Listening… speak now",
    "the mic's own feedback wins while it is active"
  );
});

test("provider plumbing is stripped from what the visitor reads", async () => {
  const { tunnelErrorText, withoutProviderPrefix, pendingLoadText } = await import("../src/tunnel-progress.js");
  assert.equal(
    tunnelErrorText("fal txt2img returned HTTP 422: The content could not be processed"),
    "GenAI failed: The content could not be processed"
  );
  assert.equal(
    withoutProviderPrefix("Error: fal txt2img returned HTTP 422: nope; keeping current scene"),
    "nope; keeping current scene"
  );
  assert.equal(
    tunnelErrorText("GenAI failed: fal txt2img returned HTTP 422: The content could not be processed"),
    "GenAI failed: The content could not be processed",
    "the server's own message, as the client actually receives it"
  );
  assert.equal(tunnelErrorText("GenAI failed: budget spent"), "GenAI failed: budget spent");
  assert.equal(tunnelErrorText("No usable images returned"), "GenAI failed: No usable images returned");
  assert.equal(pendingLoadText({ mode: "url", query: "https://www.theverge.com/x" }), "Loading theverge.com...");
  assert.equal(pendingLoadText({ mode: "image_search", query: "kites" }), "Searching kites...");
});

test("a followed image's title rides along with the domain, truncated", async () => {
  const { pendingLoadText, tunnelProgressText } = await import("../src/tunnel-progress.js");
  assert.equal(
    pendingLoadText({ mode: "url", query: "https://www.theverge.com/x", label: "  Kites over\n Bondi " }),
    "Loading theverge.com: Kites over Bondi..."
  );
  assert.equal(pendingLoadText({ mode: "image_search", query: "kites", label: "ignored" }), "Searching kites...");
  const text = tunnelProgressText({
    mode: "url",
    query: "https://a.example/p",
    totalCount: 10,
    spawnedCount: 0,
    domainFromUrl: () => "a.example",
    label: "x".repeat(80)
  });
  assert.match(text, /^Loading a\.example: x{39}…\.\.\. \d+\/10 images$/);
});
