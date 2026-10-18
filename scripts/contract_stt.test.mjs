// Contract tests for POST /api/stt via the mock STT provider.
//
// Covers the relay contract server/stt.js implements:
//   - explicitly disabled provider → 501, health stt.enabled=false
//   - builtin provider (the default) accepts WAV PCM and returns {text}
//   - whisper provider → multipart file relayed to /inference → {text},
//     health stt.enabled=true, audio body actually forwarded
//   - custom provider → raw audio body relayed → {text}
//   - wrong content-type → 415
//   - museum-safe on + blocked transcript → 400 neutral message
//
// The mock returns a fixed transcript (MOCK_STT_TEXT), so museum-safe blocking
// is exercised by making that transcript a blocklist term.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, startMockStt } from "./contract_helpers.mjs";

// A minimal, valid-enough audio blob. server/stt.js gates on the request
// Content-Type, not on decoding the bytes, so any non-empty buffer works.
const AUDIO = Buffer.from("fake-opus-audio-bytes-for-contract-test");
const WAV_AUDIO = makeWavPcm16([0, 0.15, -0.15, 0.05, -0.05, 0, 0, 0]);

async function post(base, { contentType = "audio/webm", body = AUDIO } = {}) {
  return fetch(`${base}/api/stt`, {
    method: "POST",
    headers: { "content-type": contentType },
    body
  });
}

test("/api/stt disabled: 501 and health reports stt.enabled=false", async () => {
  const server = await startServer({ STT_PROVIDER: "disabled", STT_ENDPOINT: "" });
  try {
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.stt.enabled, false, "health flags STT disabled");

    const res = await post(server.base);
    assert.equal(res.status, 501, "disabled STT returns 501");
    const json = await res.json();
    assert.match(json.error, /not configured/i);
  } finally {
    await server.stop();
  }
});

test("/api/stt builtin default: accepts WAV PCM and returns {text}", async () => {
  const server = await startServer({
    STT_BUILTIN_TEST_TRANSCRIPT: "hello quest"
  });
  try {
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.stt.enabled, true, "built-in STT is enabled by default when dependency is installed");

    const res = await post(server.base, { contentType: "audio/wav", body: WAV_AUDIO });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.text, "hello quest");

    const webm = await post(server.base);
    assert.equal(webm.status, 415, "built-in STT requires WAV PCM");
  } finally {
    await server.stop();
  }
});

test("/api/stt whisper: relays multipart file to /inference and returns {text}", async () => {
  const mock = await startMockStt({ MOCK_STT_TEXT: "example dot com" });
  const server = await startServer({
    STT_PROVIDER: "whisper",
    STT_ENDPOINT: mock.base
  });
  try {
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.stt.enabled, true, "health flags STT enabled");

    const res = await post(server.base);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.text, "example dot com", "transcript relayed back");

    // Confirm the audio actually reached the provider as a multipart file part.
    const last = (await (await fetch(`${mock.base}/last`)).json()).last;
    assert.ok(last, "provider received a request");
    assert.equal(last.path, "/inference", "posted to whisper /inference path");
    assert.ok(last.sawFilePart, "multipart file part forwarded");
    assert.ok(last.byteLength > AUDIO.length, "multipart wrapper adds bytes around audio");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("/api/stt custom: relays raw audio body and returns {text}", async () => {
  const mock = await startMockStt({ MOCK_STT_TEXT: "raw body transcript" });
  const server = await startServer({
    STT_PROVIDER: "custom",
    STT_ENDPOINT: `${mock.base}/`
  });
  try {
    const res = await post(server.base);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, "raw body transcript");

    const last = (await (await fetch(`${mock.base}/last`)).json()).last;
    assert.equal(last.path, "/", "custom posts to endpoint root");
    assert.equal(last.byteLength, AUDIO.length, "raw audio forwarded unwrapped");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("/api/stt rejects a non-audio content type with 415", async () => {
  const mock = await startMockStt();
  const server = await startServer({ STT_PROVIDER: "whisper", STT_ENDPOINT: mock.base });
  try {
    // Use text/plain (not application/json) so the global express.json parser
    // ignores it and the request reaches the STT handler's content-type gate.
    const res = await post(server.base, { contentType: "text/plain" });
    assert.equal(res.status, 415);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("/api/stt museum-safe: a blocked transcript yields a neutral 400", async () => {
  // The mock will "transcribe" to a blocklist term; the gate must reject it
  // without echoing the term back.
  const mock = await startMockStt({ MOCK_STT_TEXT: "nsfw" });
  const server = await startServer({
    STT_PROVIDER: "whisper",
    STT_ENDPOINT: mock.base,
    GENAI_MUSEUM_SAFE: "1"
  });
  try {
    const res = await post(server.base);
    assert.equal(res.status, 400, "blocked transcript rejected");
    const json = await res.json();
    assert.match(json.error, /museum-safe/i, "neutral museum-safe message");
    assert.doesNotMatch(json.error, /nsfw/i, "does not echo the blocked term");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

function makeWavPcm16(samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), 44 + (i * 2));
  }
  return buffer;
}

test("/api/stt honours the kill switch, like GenAI and search", async () => {
  // Paid transcription used to keep running with the emergency stop engaged.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-kill-"));
  const killPath = path.join(dir, "KILL_SWITCH");
  const mock = await startMockStt({ MOCK_STT_TEXT: "should not be reached" });
  const server = await startServer({
    STT_PROVIDER: "custom",
    STT_ENDPOINT: `${mock.base}/`,
    KILL_SWITCH_PATH: killPath,
    KILL_SWITCH_CACHE_MS: "50"
  });
  try {
    assert.equal((await post(server.base)).status, 200, "transcribes while the switch is off");
    fs.writeFileSync(killPath, "");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const stopped = await post(server.base);
    assert.equal(stopped.status, 503);
    assert.deepEqual(await stopped.json(), { error: "disabled" });
  } finally {
    await server.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
