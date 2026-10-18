// Unit tests for server/in-flight.js, on a real Express app: the routes that use
// it (/api/proxy/image, /api/extract, /api/search/images) refuse loopback
// upstreams, so their wiring cannot be driven end to end from a test.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createInFlightRequests } from "../server/in-flight.js";

// The shape the server uses: follow ahead of the (here absent) slot pool, lead
// just before the work. The work is slow and counted.
async function withApp({ work }, fn) {
  const inFlight = createInFlightRequests();
  const app = express();
  let runs = 0;
  app.get("/thing", async (req, res, next) => {
    if (!await inFlight.follow(req.query.key, res)) {
      next();
    }
  });
  app.get("/thing", async (req, res) => {
    inFlight.lead(req.query.key, res);
    runs += 1;
    await work(req, res);
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, runs: () => runs });
  } finally {
    server.close();
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("simultaneous identical requests do the work once and all get its reply", async () => {
  await withApp({
    work: async (_req, res) => {
      await delay(150);
      res.setHeader("cache-control", "public, max-age=86400");
      res.type("image/png").send(Buffer.from("png bytes"));
    }
  }, async ({ base, runs }) => {
    const replies = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/thing?key=a`)));
    assert.equal(runs(), 1);
    for (const reply of replies) {
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get("content-type"), "image/png");
      assert.equal(reply.headers.get("cache-control"), "public, max-age=86400");
      assert.equal(Buffer.from(await reply.arrayBuffer()).toString(), "png bytes");
    }
  });
});

test("different keys never share, and a finished request is not replayed later", async () => {
  await withApp({
    work: async (req, res) => {
      await delay(50);
      res.json({ key: req.query.key });
    }
  }, async ({ base, runs }) => {
    const [a, b] = await Promise.all([fetch(`${base}/thing?key=a`), fetch(`${base}/thing?key=b`)]);
    assert.deepEqual([await a.json(), await b.json()], [{ key: "a" }, { key: "b" }]);
    await fetch(`${base}/thing?key=a`);
    assert.equal(runs(), 3);
  });
});

test("an error reply is shared too, with its status", async () => {
  await withApp({
    work: async (_req, res) => {
      await delay(100);
      res.status(502).json({ error: "upstream" });
    }
  }, async ({ base, runs }) => {
    const replies = await Promise.all([fetch(`${base}/thing?key=x`), fetch(`${base}/thing?key=x`)]);
    assert.equal(runs(), 1);
    assert.deepEqual(replies.map((reply) => reply.status), [502, 502]);
  });
});

test("if the leader disconnects without a reply, a follower runs the work itself", async () => {
  await withApp({
    work: async (req, res) => {
      if (req.query.drop === "1") {
        await delay(100);
        res.socket.destroy();
        return;
      }
      res.json({ ok: true });
    }
  }, async ({ base, runs }) => {
    const leader = fetch(`${base}/thing?key=k&drop=1`).catch(() => null);
    await delay(20);
    // Same key (the server's keys ignore unrelated query parameters).
    const follower = await fetch(`${base}/thing?key=k`);
    await leader;
    assert.equal(follower.status, 200);
    assert.deepEqual(await follower.json(), { ok: true });
    assert.equal(runs(), 2);
  });
});
