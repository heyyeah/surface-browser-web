// Contract tests for POST /api/screenshot.
//
// Saving a capture is an ADMIN capability — it writes a file on the server's
// disk — so almost everything here is about who gets to do it, not about the
// image. Three properties are load-bearing:
//
//   * SCREENSHOT_TOKEN unset keeps the local-only rule, so a dev
//     laptop is unaffected and no deploy opens the path by omission.
//   * A refusal is 404, not 403, matching the dev routes and /admin/pool: a
//     scanner must not learn that a write path exists here.
//   * An UNAUTHORISED request is refused BEFORE its body is read. The route
//     accepts multiple megabytes; if the gate ran after the body parser, any
//     stranger could make this process buffer them.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { startServer } from "./contract_helpers.mjs";
import { encodePng } from "./png.mjs";

// Explicit, so a developer's server/.env cannot decide the outcome (dotenv
// skips keys already present, and "" is treated as unset by the server).
const CLEAN = {
  SCREENSHOT_ENABLED: "",
  SCREENSHOT_TOKEN: "",
  SCREENSHOT_MAX_BYTES: "",
  TRUST_PROXY: "",
  LOG_API_QUERIES: ""
};

function shotDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-shots-"));
}

// Incompressible pixels on purpose: a flat PNG deflates to a few hundred bytes,
// which is useless for exercising a size limit.
function noisyPng(width, height) {
  return encodePng(width, height, randomBytes(width * height * 3));
}

function jpeg(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 130, b: 210 } } })
    .jpeg()
    .toBuffer();
}

async function postPng(server, png, headers = {}) {
  return fetch(`${server.base}/api/screenshot`, {
    method: "POST",
    headers: { "content-type": "image/png", ...headers },
    body: png
  });
}

async function postImage(server, body, contentType, headers = {}) {
  return fetch(`${server.base}/api/screenshot`, {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body
  });
}

function savedFiles(dir, extension = "png") {
  return fs.readdirSync(dir).filter((name) => name.endsWith(`.${extension}`));
}

// --- the local-only default -------------------------------------------------

test("no token: a loopback capture is saved, exactly as before", async () => {
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_DIR_PATH: dir });
  try {
    const res = await postPng(server, noisyPng(16, 12));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.width, 16);
    assert.equal(body.height, 12);
    assert.equal(savedFiles(dir).length, 1, "the PNG reached disk");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no token: a forwarded remote client is refused with 404, not 403", async () => {
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, TRUST_PROXY: "1", SCREENSHOT_DIR_PATH: dir });
  try {
    const res = await postPng(server, noisyPng(8, 8), { "x-forwarded-for": "203.0.113.9" });
    assert.equal(res.status, 404, "the route must not advertise itself");
    assert.equal(savedFiles(dir).length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SCREENSHOT_ENABLED=0 refuses even the right token", async () => {
  const dir = shotDir();
  const server = await startServer({
    ...CLEAN,
    SCREENSHOT_ENABLED: "0",
    SCREENSHOT_TOKEN: "cap-token",
    SCREENSHOT_DIR_PATH: dir
  });
  try {
    const res = await postPng(server, noisyPng(8, 8), { "x-capture-token": "cap-token" });
    assert.equal(res.status, 404);
    assert.equal(savedFiles(dir).length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the token --------------------------------------------------------------

test("SCREENSHOT_TOKEN: missing, wrong and right", async () => {
  const dir = shotDir();
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    SCREENSHOT_TOKEN: "cap-token",
    SCREENSHOT_DIR_PATH: dir
  });
  const remote = { "x-forwarded-for": "203.0.113.9" };
  try {
    const missing = await postPng(server, noisyPng(8, 8), remote);
    assert.equal(missing.status, 404);

    const wrong = await postPng(server, noisyPng(8, 8), { ...remote, "x-capture-token": "nope" });
    assert.equal(wrong.status, 404);

    // Same length as the real one, so this is the case the constant-time
    // compare actually runs to completion on.
    const sameLength = await postPng(server, noisyPng(8, 8), { ...remote, "x-capture-token": "cap-tokeN" });
    assert.equal(sameLength.status, 404);

    assert.equal(savedFiles(dir).length, 0, "nothing was written by a refused request");

    const right = await postPng(server, noisyPng(8, 8), { ...remote, "x-capture-token": "cap-token" });
    assert.equal(right.status, 200, "the token authorises from anywhere");
    assert.equal(savedFiles(dir).length, 1);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with a token configured, loopback alone is still a key", async () => {
  // Matches canWriteSettings(): loopback is someone with a shell on the host,
  // which the token exists to restrict strangers from, not that person.
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_TOKEN: "cap-token", SCREENSHOT_DIR_PATH: dir });
  try {
    const res = await postPng(server, noisyPng(8, 8));
    assert.equal(res.status, 200, "loopback authorises even without the token");
    assert.equal(savedFiles(dir).length, 1);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with a token configured, a genuinely remote forwarded address is still refused", async () => {
  // The loopback fallback must not widen who counts as remote: a real client
  // IP behind TRUST_PROXY still needs the token.
  const dir = shotDir();
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    SCREENSHOT_TOKEN: "cap-token",
    SCREENSHOT_DIR_PATH: dir
  });
  try {
    const res = await postPng(server, noisyPng(8, 8), { "x-forwarded-for": "203.0.113.9" });
    assert.equal(res.status, 404);
    assert.equal(savedFiles(dir).length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the token never reaches the query log", async () => {
  const dir = shotDir();
  const server = await startServer({
    ...CLEAN,
    LOG_API_QUERIES: "1",
    SCREENSHOT_TOKEN: "cap-token-in-a-log-would-be-a-bug",
    SCREENSHOT_DIR_PATH: dir
  });
  try {
    await postPng(server, noisyPng(8, 8), { "x-capture-token": "cap-token-in-a-log-would-be-a-bug" });
    await postPng(server, noisyPng(8, 8), { "x-capture-token": "wrong-but-still-a-secret" });
    const log = fs.existsSync(server.queryLogPath) ? fs.readFileSync(server.queryLogPath, "utf8") : "";
    assert.ok(!log.includes("cap-token-in-a-log-would-be-a-bug"), "query.log leaked the token");
    assert.ok(!log.includes("wrong-but-still-a-secret"), "query.log leaked an attempted token");
    const console_ = `${server.stdout()}${server.stderr()}`;
    assert.ok(!console_.includes("cap-token-in-a-log-would-be-a-bug"), "the console leaked the token");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the gate runs ahead of the body parser ---------------------------------

test("an unauthorised request is refused without its body being read", async () => {
  // Middleware order matters. This announces 20 MB in Content-Length
  // and then sends NOTHING. If the gate sat behind express.raw() the server
  // would sit waiting for those bytes and this would time out; because it sits
  // in front, the 404 comes back off the headers alone.
  const dir = shotDir();
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    SCREENSHOT_TOKEN: "cap-token",
    SCREENSHOT_DIR_PATH: dir
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: server.port,
        path: "/api/screenshot",
        method: "POST",
        headers: {
          "content-type": "image/png",
          "content-length": String(20 * 1024 * 1024),
          "x-forwarded-for": "203.0.113.9"
        }
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error("no response before the body was sent — the gate is behind the parser"));
      }, 5000);
      req.on("response", (res) => {
        clearTimeout(timer);
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // Headers on the wire, body never. (Node otherwise holds the header back
      // until the first write, and the server would see nothing at all.)
      req.flushHeaders();
    });
    assert.equal(status, 404);
    assert.equal(savedFiles(dir).length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- what the bytes have to be ----------------------------------------------

test("the bytes must really be a JPEG or PNG, whatever the content-type claims", async () => {
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_DIR_PATH: dir });
  try {
    const text = await postPng(server, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    assert.equal(text.status, 400);
    assert.match((await text.json()).error, /JPEG or PNG/i);

    // A real image, just not an accepted one: the check is the signature, not
    // "is this decodable".
    const gif = Buffer.alloc(13);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(16, 6);
    gif.writeUInt16LE(12, 8);
    assert.equal((await postPng(server, gif)).status, 400);

    // A PNG signature with a truncated header is not a PNG either.
    const stub = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    assert.equal((await postPng(server, stub)).status, 400);

    assert.equal((await postPng(server, Buffer.alloc(0))).status, 400);

    assert.equal(savedFiles(dir).length, 0, "nothing that failed validation was written");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a JPEG header with nothing after it is rejected", async () => {
  // SOI followed by bytes that never resolve to a marker: inspectJpegDimensions
  // runs off the end of the buffer without ever finding a SOF, same as a
  // genuinely truncated capture.
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_DIR_PATH: dir });
  try {
    const stub = Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const res = await postImage(server, stub, "image/jpeg");
    assert.equal(res.status, 400);
    assert.equal(savedFiles(dir, "jpg").length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a JPEG capture is saved, with dimensions read from its own header", async () => {
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_DIR_PATH: dir });
  try {
    const body = await jpeg(32, 24);
    const res = await postImage(server, body, "image/jpeg");
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.width, 32);
    assert.equal(payload.height, 24);
    assert.match(payload.filename, /\.jpg$/, "saved with the extension the bytes actually are");
    assert.equal(savedFiles(dir, "jpg").length, 1);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a PNG capture is still saved, with a .png extension", async () => {
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_DIR_PATH: dir });
  try {
    const res = await postPng(server, noisyPng(16, 12));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.match(payload.filename, /\.png$/);
    assert.equal(savedFiles(dir, "png").length, 1);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an oversized canvas is refused on the PNG's own IHDR", async () => {
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_DIR_PATH: dir });
  try {
    // 5000px wide, one row tall: a handful of KB on the wire that claims a
    // canvas past the 4096 clamp.
    const res = await postPng(server, noisyPng(5000, 1));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /dimensions/i);
    assert.equal(savedFiles(dir).length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an oversized canvas is refused on the JPEG's own SOF", async () => {
  const dir = shotDir();
  const server = await startServer({ ...CLEAN, SCREENSHOT_DIR_PATH: dir });
  try {
    const body = await jpeg(4200, 10);
    const res = await postImage(server, body, "image/jpeg");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /dimensions/i);
    assert.equal(savedFiles(dir, "jpg").length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SCREENSHOT_MAX_BYTES caps the upload with a JSON 413", async () => {
  const dir = shotDir();
  const server = await startServer({
    ...CLEAN,
    SCREENSHOT_MAX_BYTES: "4096",
    SCREENSHOT_DIR_PATH: dir
  });
  try {
    const small = await postPng(server, noisyPng(16, 16));
    assert.equal(small.status, 200, "a capture under the cap still lands");

    const big = noisyPng(128, 128);
    assert.ok(big.length > 4096, `test image is not over the cap (${big.length} bytes)`);
    const res = await postPng(server, big);
    assert.equal(res.status, 413);
    // body-parser's own error would otherwise arrive as Express's HTML page.
    assert.match((await res.json()).error, /too large/i);
    assert.equal(savedFiles(dir).length, 1, "only the small one was written");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
