// Unit tests for the grown pool store (server/genai-pool-grow.js) and its union
// with a baked pack (mergePools). The end-to-end half is
// contract_genai_pool_grow.test.mjs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { genAiBookmarkPrompts } from "../src/bookmark-presets.js";
import { addGrownMember, bookmarkPromptSet, loadGrowStore, poolGrowthRound } from "../server/genai-pool-grow.js";
import { applyPoolSuppression, mergePools } from "../server/genai-pool-pack.js";

const bookmarkPrompts = bookmarkPromptSet(genAiBookmarkPrompts());
const dirs = [];
after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-grow-unit-"));
  dirs.push(dir);
  return dir;
}

function address(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

const generated = (overrides = {}) => ({ origin: null, genai: { prompt: "otters", parentId: null }, ...overrides });

test("round 1 is a bookmark prompt, normalized the way the pool key normalizes it", () => {
  assert.equal(poolGrowthRound({ prompt: "otters", bookmarkPrompts }), 1);
  assert.equal(poolGrowthRound({ prompt: "  OTTERS ", bookmarkPrompts }), 1);
  assert.equal(poolGrowthRound({ prompt: "a  liminal space of light and GLASS", bookmarkPrompts }), 1);
  assert.equal(poolGrowthRound({ prompt: "otters on a tram", bookmarkPrompts }), 0, "a typed prompt");
  assert.equal(poolGrowthRound({ prompt: "otters", negativePrompt: "blurry", bookmarkPrompts }), 0, "a negative prompt");
});

test("round 2 is a round-1 source of the same bookmark, fresh or drawn; nothing else", () => {
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: generated(), bookmarkPrompts }), 2);
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: generated({ origin: "pool" }), bookmarkPrompts }), 2);
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: generated({ origin: "url" }), bookmarkPrompts }), 0, "a site image");
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: generated({ origin: "image_search" }), bookmarkPrompts }), 0, "a search image");
  assert.equal(
    poolGrowthRound({ prompt: "otters", sourceRecord: generated({ genai: { prompt: "otters", parentId: "abc" } }), bookmarkPrompts }),
    0,
    "a variation with no stored round"
  );
  assert.equal(
    poolGrowthRound({ prompt: "otters", sourceRecord: generated({ genai: { prompt: "sunday", parentId: null } }), bookmarkPrompts }),
    0,
    "a request prompt that is not the source's lineage prompt"
  );
});

test("later rounds follow the source's stored round, up to maxRound", () => {
  const ofRound = (round) => generated({ genai: { prompt: "otters", parentId: "abc", round } });
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: ofRound(2), bookmarkPrompts }), 0, "default maxRound is 2");
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: ofRound(2), bookmarkPrompts, maxRound: 4 }), 3);
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: ofRound(3), bookmarkPrompts, maxRound: 4 }), 4);
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: ofRound(4), bookmarkPrompts, maxRound: 4 }), 0, "round 5");
  assert.equal(poolGrowthRound({ prompt: "otters", sourceRecord: ofRound(0), bookmarkPrompts, maxRound: 4 }), 0, "an imported lineage");
});

test("a missing store is empty and writable; a kept member reloads under its key", () => {
  const dir = tempDir();
  const store = loadGrowStore(dir);
  assert.equal(store.active, true);
  assert.equal(store.memberCount, 0);

  const buffer = Buffer.from("not really a png");
  const sha256 = address(buffer);
  const { store: next, error } = addGrownMember(store, {
    key: "k1",
    entry: { kind: "base", model: "m", prompt: "otters", emoji: null, sourceKey: "", width: 640, height: 512, steps: 0, strength: null },
    member: { sha256, seed: 7, bakedAt: "2026-09-13T10:00:00.000Z" },
    buffer,
    contentType: "image/png"
  });
  assert.equal(error, undefined);
  assert.equal(next.memberCount, 1);
  assert.equal(next.entries.get("k1").members[0].store, "grown");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["images", "manifest.json"], "no temp file left behind");

  const reloaded = loadGrowStore(dir);
  assert.equal(reloaded.memberCount, 1);
  assert.equal(reloaded.byId.get(sha256).key, "k1");
  assert.deepEqual(fs.readFileSync(reloaded.byId.get(sha256).path), buffer);
});

test("a corrupt store is refused, and refuses writes", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "manifest.json"), "{ \"version\": 2, \"keys\": {");
  const store = loadGrowStore(dir);
  assert.equal(store.active, false);
  assert.match(store.error, /manifest\.json/);
  const result = addGrownMember(store, { key: "k", entry: {}, member: { sha256: "x" }, buffer: Buffer.from("x"), contentType: "image/png" });
  assert.ok(result.error);
  assert.equal(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"), "{ \"version\": 2, \"keys\": {");
});

test("a union draws from both stores, and bytes in both count once, as baked", () => {
  const member = (id, store) => ({ id, key: "k", store });
  const baked = {
    active: true,
    dir: "/pack",
    entries: new Map([["k", { key: "k", members: [member("a", "baked"), member("b", "baked")] }]]),
    byId: new Map([["a", member("a", "baked")], ["b", member("b", "baked")]])
  };
  const grown = {
    active: true,
    entries: new Map([
      ["k", { key: "k", members: [member("b", "grown"), member("c", "grown")] }],
      ["k2", { key: "k2", members: [member("d", "grown")] }]
    ]),
    byId: new Map()
  };
  const merged = applyPoolSuppression(mergePools(baked, grown), new Set(["c"]));
  assert.deepEqual(merged.entries.get("k").members.map((m) => `${m.id}:${m.store}`), ["a:baked", "b:baked", "c:grown"]);
  assert.equal(merged.keys.get("k").length, 2, "a tombstone applies to a grown member");
  assert.equal(merged.keys.get("k2").length, 1);
  assert.equal(merged.dir, "/pack");
  assert.equal(mergePools(baked, { active: false }), baked, "no grown store is the pack unchanged");
});
