// Contract tests for the GenAI vary emoji modifiers. Default style is REPLACE:
// in img2img the source image carries the content, so the sent prompt is the
// modifier payload ALONE — no lineage prompt, no compounding. `append` remains
// as a config fallback. Payload defaults to `text` (mapped phrase); `emoji` is
// an explicit raw-token fallback. Uses the mock sdapi provider, which records
// each img2img request body, so we can assert both the sent prompt reaching the
// provider and the `modifier` field landing in each variation's lineage block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, startMockSdapi } from "./contract_helpers.mjs";

async function withA1111(extraEnv, fn, mockEnv = {}) {
  const mock = await startMockSdapi(mockEnv);
  const server = await startServer({
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base,
    ...extraEnv
  });
  try {
    await fn({ server, mock });
  } finally {
    await server.stop();
    await mock.stop();
  }
}

async function generateSource(server, prompt) {
  const gen = await fetch(`${server.base}/api/genai`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, count: 1 })
  });
  assert.equal(gen.status, 200);
  const genJson = await gen.json();
  return genJson.items[0].genai.id;
}

async function img2imgPrompts(mock) {
  const log = await (await fetch(`${mock.base}/requests`)).json();
  return log.requests
    .filter((r) => r.path === "/sdapi/v1/img2img")
    .map((r) => r.body.prompt);
}

// New variations from this request are the items whose parent is the request's
// source id. (The response also echoes the full lineage — earlier vary steps
// carry a strength too, so filtering on strength alone would catch ancestors.)
function newVariations(json, sourceId) {
  return json.items.filter((it) => it.genai?.parentId === sourceId);
}

async function pollGenAiJob(server, jobId) {
  let payload = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const poll = await fetch(`${server.base}/api/genai/job/${jobId}`);
    assert.equal(poll.status, 200);
    payload = await poll.json();
    assert.notEqual(payload.status, "failed", payload.error || "job failed");
    if (payload.status === "complete") {
      return payload;
    }
  }
  assert.fail(`GenAI job ${jobId} did not complete`);
}

test("replace + payload=emoji: sent prompt is the emoji alone; genai.prompt keeps base; sentPrompt recorded", async () => {
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIER_PAYLOAD: "emoji", GENAI_VARY_MODIFIERS: "🌶️" }, async ({ server, mock }) => {
    const parent = await generateSource(server, "a portrait of a person");
    await fetch(`${mock.base}/__reset`, { method: "POST" });

    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 3, seed: 42 })
    });
    assert.equal(vary.status, 200);
    const json = await vary.json();

    // Provider saw the emoji ALONE as the img2img prompt (no lineage prompt).
    const prompts = await img2imgPrompts(mock);
    assert.equal(prompts.length, 3);
    for (const p of prompts) {
      assert.equal(p, "🌶️", "replace: sent prompt is the modifier payload only");
    }

    // Every variation lineage item carries the additive modifier field, with the
    // base lineage prompt preserved in genai.prompt (for cache-expiry re-fire).
    const variations = newVariations(json, parent);
    assert.equal(variations.length, 3);
    for (const it of variations) {
      assert.deepEqual(it.genai.modifier, { emoji: "🌶️", phrase: null, sentPrompt: "🌶️", stack: ["🌶️"] });
      assert.equal(it.genai.prompt, "a portrait of a person", "genai.prompt keeps the base lineage prompt");
    }
  });
});

test("replace + payload=text: sent prompt is the mapped phrase alone; modifier.phrase set", async () => {
  await withA1111(
    { GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIER_PAYLOAD: "text", GENAI_VARY_MODIFIERS: "🧊" },
    async ({ server, mock }) => {
      const parent = await generateSource(server, "a busy market street");
      await fetch(`${mock.base}/__reset`, { method: "POST" });

      const vary = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: parent }, count: 2, seed: 5 })
      });
      assert.equal(vary.status, 200);
      const json = await vary.json();

      const prompts = await img2imgPrompts(mock);
      for (const p of prompts) {
        assert.equal(p, "icy, frozen", "replace+text: sent prompt is the mapped phrase alone");
      }
      for (const it of newVariations(json, parent)) {
        assert.deepEqual(it.genai.modifier, { emoji: "🧊", phrase: "icy, frozen", sentPrompt: "icy, frozen", stack: ["🧊"] });
        assert.equal(it.genai.prompt, "a busy market street", "genai.prompt keeps base even in text mode");
      }
    }
  );
});

test("replace + payload=text: emoji:phrase override in GENAI_VARY_MODIFIERS", async () => {
  await withA1111(
    { GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIER_PAYLOAD: "text", GENAI_VARY_MODIFIERS: "🧊:glacial" },
    async ({ server, mock }) => {
      const parent = await generateSource(server, "a lighthouse");
      await fetch(`${mock.base}/__reset`, { method: "POST" });

      const vary = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: parent }, count: 1, seed: 5 })
      });
      assert.equal(vary.status, 200);
      const prompts = await img2imgPrompts(mock);
      assert.equal(prompts[0], "glacial", "override phrase used for payload=text");
      const it = newVariations(await vary.json(), parent)[0];
      assert.equal(it.genai.modifier.emoji, "🧊", "override token still feeds the emoji picker");
      assert.equal(it.genai.modifier.phrase, "glacial");
    }
  );
});

test("replace + payload=text: expanded palette emoji map to useful phrases", async () => {
  await withA1111(
    { GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIER_PAYLOAD: "text", GENAI_VARY_MODIFIERS: "🪩" },
    async ({ server, mock }) => {
      const parent = await generateSource(server, "a quiet gallery");
      await fetch(`${mock.base}/__reset`, { method: "POST" });

      const vary = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: parent }, count: 1, seed: 9 })
      });
      assert.equal(vary.status, 200);
      const json = await vary.json();

      const [prompt] = await img2imgPrompts(mock);
      assert.equal(prompt, "mirror ball, disco reflections");
      const [variation] = newVariations(json, parent);
      assert.deepEqual(variation.genai.modifier, {
        emoji: "🪩",
        phrase: "mirror ball, disco reflections",
        sentPrompt: "mirror ball, disco reflections",
        stack: ["🪩"]
      });
    }
  );
});

test("replace vary-of-vary: no compounding — sent prompt is the freshly picked modifier only", async () => {
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIER_PAYLOAD: "emoji", GENAI_VARY_MODIFIERS: "🌶️" }, async ({ server, mock }) => {
    const parent = await generateSource(server, "a portrait");
    const vary1 = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 1, seed: 3 })
    });
    assert.equal(vary1.status, 200);
    const v1 = newVariations(await vary1.json(), parent)[0];
    assert.equal(v1.genai.modifier.sentPrompt, "🌶️");
    const child = v1.genai.id;

    // Vary the child with a different single-emoji set. Replace = only the new
    // pick is sent; the inherited 🌶️ does NOT compound.
    await fetch(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { GENAI_VARY_MODIFIERS: "🧊" } })
    });
    await fetch(`${mock.base}/__reset`, { method: "POST" });

    const vary2 = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: child }, count: 1, seed: 4 })
    });
    assert.equal(vary2.status, 200);
    const v2 = newVariations(await vary2.json(), child)[0];
    assert.deepEqual(v2.genai.modifier, { emoji: "🧊", phrase: null, sentPrompt: "🧊", stack: ["🌶️", "🧊"] });
    const prompt = (await img2imgPrompts(mock))[0];
    assert.equal(prompt, "🧊", "replace: no compounding across vary-of-vary");
  });
});

test("append (legacy fallback): emoji appended to the lineage prompt; genai.prompt keeps base", async () => {
  await withA1111(
    { GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIER_STYLE: "append", GENAI_VARY_MODIFIER_PAYLOAD: "emoji", GENAI_VARY_MODIFIERS: "🌶️" },
    async ({ server, mock }) => {
      const parent = await generateSource(server, "a portrait of a person");
      await fetch(`${mock.base}/__reset`, { method: "POST" });

      const vary = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: parent }, count: 3, seed: 42 })
      });
      assert.equal(vary.status, 200);
      const json = await vary.json();

      const prompts = await img2imgPrompts(mock);
      assert.equal(prompts.length, 3);
      for (const p of prompts) {
        assert.equal(p, "a portrait of a person, 🌶️", "append: emoji appended to lineage prompt");
      }
      for (const it of newVariations(json, parent)) {
        assert.deepEqual(it.genai.modifier, {
          emoji: "🌶️",
          phrase: null,
          sentPrompt: "a portrait of a person, 🌶️",
          stack: ["🌶️"]
        });
        assert.equal(it.genai.prompt, "a portrait of a person", "genai.prompt keeps base in append too");
      }
    }
  );
});

test("append + payload=text: phrase appended, comma-separated", async () => {
  await withA1111(
    {
      GENAI_VARY_MODIFIER_MODE: "batch",
      GENAI_VARY_MODIFIER_STYLE: "append",
      GENAI_VARY_MODIFIER_PAYLOAD: "text",
      GENAI_VARY_MODIFIERS: "🤖"
    },
    async ({ server, mock }) => {
      const parent = await generateSource(server, "a quiet forest");
      await fetch(`${mock.base}/__reset`, { method: "POST" });

      const vary = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: parent }, count: 1, seed: 1 })
      });
      assert.equal(vary.status, 200);
      const p = (await img2imgPrompts(mock))[0];
      assert.equal(p, "a quiet forest, robotic, mechanical", "append+text: phrase appended");
    }
  );
});

test("append vary-of-vary: modifiers compound in the prompt, capped at 2", async () => {
  await withA1111(
    { GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIER_STYLE: "append", GENAI_VARY_MODIFIER_PAYLOAD: "emoji", GENAI_VARY_MODIFIERS: "🌶️" },
    async ({ server, mock }) => {
      // First vary: base + 🌶️.
      const parent = await generateSource(server, "a portrait");
      const vary1 = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: parent }, count: 1, seed: 3 })
      });
      assert.equal(vary1.status, 200);
      const v1 = newVariations(await vary1.json(), parent)[0];
      assert.equal(v1.genai.modifier.emoji, "🌶️");
      const child = v1.genai.id;

      // Second vary from that child, now with a different single-emoji set.
      await fetch(`${server.base}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { GENAI_VARY_MODIFIERS: "🧊" } })
      });
      await fetch(`${mock.base}/__reset`, { method: "POST" });

      const vary2 = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: child }, count: 1, seed: 4 })
      });
      assert.equal(vary2.status, 200);
      const v2 = newVariations(await vary2.json(), child)[0];
      assert.equal(v2.genai.modifier.emoji, "🧊", "child stores its own new pick");

      const prompt = (await img2imgPrompts(mock))[0];
      assert.equal(prompt, "a portrait, 🌶️ 🧊", "compounded prompt, newest last, cap 2");

      // Third vary: a third distinct emoji must not push the stack past 2.
      await fetch(`${server.base}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { GENAI_VARY_MODIFIERS: "🦄" } })
      });
      await fetch(`${mock.base}/__reset`, { method: "POST" });

      const vary3 = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: v2.genai.id }, count: 1, seed: 5 })
      });
      assert.equal(vary3.status, 200);
      newVariations(await vary3.json(), v2.genai.id);
      const prompt3 = (await img2imgPrompts(mock))[0];
      const emojiCount = [...prompt3].filter((ch) => /\p{Extended_Pictographic}/u.test(ch)).length;
      assert.ok(emojiCount <= 2, `stack capped at 2 emoji (prompt was "${prompt3}")`);
      assert.equal(prompt3, "a portrait, 🧊 🦄", "oldest 🌶️ dropped, newest 🦄 last");
    }
  );
});

test("vary mode=batch: one emoji chosen per batch, identical across variations", async () => {
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIERS: "🧊 🌶️ 🦄 🎆 🍦" }, async ({ server }) => {
    const parent = await generateSource(server, "a busy market street");
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 5, seed: 7 })
    });
    assert.equal(vary.status, 200);
    const variations = newVariations(await vary.json(), parent);
    assert.equal(variations.length, 5);
    const emojis = new Set(variations.map((it) => it.genai.modifier?.emoji));
    assert.equal(emojis.size, 1, "batch mode picks exactly one emoji for the whole batch");
    assert.ok(["🧊", "🌶️", "🦄", "🎆", "🍦"].includes([...emojis][0]), "picked from the configured set");
  });
});

test("vary mode=off: no modifier sent, no modifier field, base prompt untouched", async () => {
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "off", GENAI_VARY_MODIFIERS: "🌶️" }, async ({ server, mock }) => {
    const parent = await generateSource(server, "a quiet forest");
    await fetch(`${mock.base}/__reset`, { method: "POST" });

    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 3, seed: 1 })
    });
    assert.equal(vary.status, 200);
    const json = await vary.json();

    const prompts = await img2imgPrompts(mock);
    for (const p of prompts) {
      assert.equal(p, "a quiet forest", "off: base lineage prompt sent unchanged");
    }
    for (const it of newVariations(json, parent)) {
      assert.equal(it.genai.modifier, undefined, "no modifier field when off");
    }
  });
});

test("generate (txt2img): never carries a modifier even when batch mode is on", async () => {
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIERS: "🌶️" }, async ({ server }) => {
    const gen = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a glowing tunnel", count: 3 })
    });
    assert.equal(gen.status, 200);
    const json = await gen.json();
    assert.equal(json.items.length, 3);
    for (const it of json.items) {
      assert.equal(it.genai.prompt, "a glowing tunnel", "generate prompt untouched");
      assert.equal(it.genai.modifier, undefined, "generate items carry no modifier");
    }
  });
});

test("vary mode=per-image: samples a shuffled subset of text emoji branches", async () => {
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "per-image", GENAI_VARY_MODIFIER_PAYLOAD: "text", GENAI_VARY_MODIFIERS: "🧊 🌶️ 🦄 🎆 🍦" }, async ({ server }) => {
    const parent = await generateSource(server, "a portrait of a person");
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 7, seed: 12345 })
    });
    assert.equal(vary.status, 200);
    const variations = newVariations(await vary.json(), parent);
    assert.equal(variations.length, 7);
    for (const it of variations) {
      assert.ok(it.genai.modifier?.emoji, "each variation has a modifier emoji");
      assert.ok(it.genai.modifier.phrase, "payload text: phrase recorded");
      assert.equal(it.genai.modifier.sentPrompt, it.genai.modifier.phrase, "replace+text: sent prompt is the phrase");
      assert.ok(["🧊", "🌶️", "🦄", "🎆", "🍦"].includes(it.genai.modifier.emoji));
    }
    const firstCycle = variations.slice(0, 5).map((it) => it.genai.modifier.emoji);
    assert.equal(new Set(firstCycle).size, 5, "first five variations cover the five configured emoji");
    assert.ok(
      ["🧊", "🌶️", "🦄", "🎆", "🍦"].includes(variations[5].genai.modifier.emoji),
      "after the first shuffled subset, additional children start another seeded palette pass"
    );
  });
});

test("vary mode=per-image: large palettes pick a subset across the whole list", async () => {
  const palette = "🧊 🌶️ 🦄 🎆 🍦 🧀 🌹 😎 🪩 🦦 🦘 ❄️ 🌊 🌕 🌲 🍌 💡 🕯️ 🚿";
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "per-image", GENAI_VARY_MODIFIER_PAYLOAD: "text", GENAI_VARY_MODIFIERS: palette }, async ({ server }) => {
    const parent = await generateSource(server, "a gallery installation");
    const vary = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 5, seed: 12345 })
    });
    assert.equal(vary.status, 200);
    const variations = newVariations(await vary.json(), parent);
    const emojis = variations.map((it) => it.genai.modifier.emoji);
    assert.deepEqual(emojis, ["🍦", "🕯️", "🦘", "🌕", "🍌"], "seeded subset samples across the expanded palette");
    assert.equal(new Set(emojis).size, 5, "one distinct emoji branch per child");
  });
});

test("vary mode=per-image async: second sphere gets five distinct emoji branches", async () => {
  const palette = "🧊 🌶️ 🦄 🎆 🍦 🧀 🌹 😎 🪩 🦦 🦘 ❄️ 🌊 🌕 🌲 🍌 💡 🕯️ 🚿";
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "per-image", GENAI_VARY_MODIFIER_PAYLOAD: "text", GENAI_VARY_MODIFIERS: palette }, async ({ server }) => {
    const parent = await generateSource(server, "a luminous garden");
    const start = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: parent }, count: 5, seed: 12345, async: true })
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    const payload = await pollGenAiJob(server, started.jobId);

    const variations = newVariations(payload, parent);
    assert.equal(variations.length, 5);
    const emojis = variations.map((it) => it.genai.modifier.emoji);
    assert.deepEqual(emojis, ["🍦", "🕯️", "🦘", "🌕", "🍌"], "async progressive vary samples five distinct emoji branches");
    assert.equal(new Set(emojis).size, 5);
  });
});

test("vary mode=batch: seeded pick is deterministic across replay", async () => {
  await withA1111({ GENAI_VARY_MODIFIER_MODE: "batch", GENAI_VARY_MODIFIERS: "🧊 🌶️ 🦄 🎆 🍦" }, async ({ server }) => {
    const parent = await generateSource(server, "a lighthouse");
    async function pick() {
      const vary = await fetch(`${server.base}/api/genai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { id: parent }, count: 3, seed: 9999 })
      });
      assert.equal(vary.status, 200);
      return newVariations(await vary.json(), parent)[0].genai.modifier.emoji;
    }
    assert.equal(await pick(), await pick(), "same seed → same emoji");
  });
});
