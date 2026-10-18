// Mock speech-to-text provider for the contract tests. TEST-ONLY.
//
// Speaks the two local-runner dialects server/stt.js relays to:
//   1. whisper.cpp / mlx-whisper: POST /inference (multipart file) -> {text}
//   2. custom: POST / (raw audio body) -> {text}
//
// It does no real transcription — it returns a fixed transcript (overridable via
// MOCK_STT_TEXT) so a test can assert the relay wired the request through and
// returned {text}. It records the last request so a test can confirm the audio
// body actually arrived. Zero heavy dependencies.

import http from "node:http";

const PORT = Number(process.env.MOCK_STT_PORT || 7998);
const TRANSCRIPT = process.env.MOCK_STT_TEXT || "hello world";

let lastRequest = null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/ping") {
    sendJson(res, 200, { ok: true, mock: "stt" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/last") {
    sendJson(res, 200, { last: lastRequest });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: "body error" });
    return;
  }

  lastRequest = {
    path: url.pathname,
    contentType: req.headers["content-type"] || "",
    byteLength: body.length,
    // For multipart, note whether the file part header made it through.
    sawFilePart: body.toString("latin1").includes('name="file"'),
    at: Date.now()
  };

  // whisper.cpp /inference (multipart) and custom / (raw) both just return text.
  sendJson(res, 200, { text: TRANSCRIPT });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock stt provider listening on http://127.0.0.1:${PORT}`);
});
