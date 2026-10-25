// Contract tests for the public-deployment hardening.
//
// Every knob under test defaults to the pre-hardening behaviour, so each case
// comes in a pair: the dev default and the hardened setting.
//
// The load-bearing one is TRUST_PROXY. isLocalRequest() is the authorisation
// check for PUT /api/settings and /api/screenshot, and behind a reverse proxy
// every request arrives from 127.0.0.1 — so the check is only meaningful if
// req.ip is the forwarded client. These tests assert both halves: an
// X-Forwarded-For header must be ignored with TRUST_PROXY off (otherwise
// anyone could forge a LOCAL address) and honoured with it on.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Agent as UndiciAgent } from "undici";
import { fileURLToPath } from "node:url";
import { startServer, startMockSdapi, startImageSearchMock, findFreePort } from "./contract_helpers.mjs";
import { encodePng } from "./png.mjs";
import { isBlockedIpAddress } from "../server/ip-blocklist.js";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Blank the hardening vars by default so a developer's server/.env cannot leak
// into a test (dotenv skips keys already present in the environment).
const CLEAN = {
  SERVE_STATIC_DIR: "",
  BIND_HOST: "",
  TRUST_PROXY: "",
  CORS_ALLOWED_ORIGINS: "",
  XR_DIAG_ENABLED: "",
  XR_DIAG_MAX_BYTES: "",
  XR_DIAG_LOG_FILE: "",
  SEARCH_QUERY_MAX_CHARS: "",
  GENAI_PROMPT_MAX_CHARS: ""
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-hardening-"));
}

async function putSettings(server, headers = {}) {
  return fetch(`${server.base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ settings: { SHOW_STATUS_FOOTER: true } })
  });
}

test("TRUST_PROXY unset: X-Forwarded-For cannot change who counts as local", async () => {
  const server = await startServer({ ...CLEAN });
  try {
    // The socket really is loopback, so settings stay writable no matter what
    // the client claims in a header. This is the dev default, unchanged.
    const forged = await putSettings(server, { "x-forwarded-for": "203.0.113.9" });
    assert.equal(forged.status, 200, "no proxy trust -> the header is ignored");
  } finally {
    await server.stop();
  }
});

test("TRUST_PROXY=1: a forwarded client is remote, so settings are read-only", async () => {
  const server = await startServer({ ...CLEAN, TRUST_PROXY: "1" });
  try {
    const forwarded = await putSettings(server, { "x-forwarded-for": "203.0.113.9" });
    assert.equal(forwarded.status, 403, "forwarded remote client cannot write settings");
    const json = await forwarded.json();
    assert.match(json.error, /read-only/i);

    // No X-Forwarded-For: req.ip falls back to the loopback socket, so a real
    // local operator (curl on the host) still passes.
    const direct = await putSettings(server);
    assert.equal(direct.status, 200, "direct loopback request is still local");
  } finally {
    await server.stop();
  }
});

test("TRUST_PROXY=1 + SETTINGS_TOKEN: the token still overrides the remote check", async () => {
  const server = await startServer({ ...CLEAN, TRUST_PROXY: "1", SETTINGS_TOKEN: "s3cret" });
  try {
    const withToken = await putSettings(server, {
      "x-forwarded-for": "203.0.113.9",
      "x-settings-token": "s3cret"
    });
    assert.equal(withToken.status, 200, "SETTINGS_TOKEN semantics survive verbatim");

    const wrongToken = await putSettings(server, {
      "x-forwarded-for": "203.0.113.9",
      "x-settings-token": "nope"
    });
    assert.equal(wrongToken.status, 403);
  } finally {
    await server.stop();
  }
});

test("x-surface-dev-client: a LAN client the Vite dev proxy forwards is not local", async () => {
  // Vite connects from loopback for everyone and names the real client in this
  // header (vite.config.js), so it must narrow trust and can never widen it.
  const server = await startServer({ ...CLEAN });
  try {
    assert.equal((await putSettings(server, { "x-surface-dev-client": "192.168.1.20" })).status, 403);
    assert.equal((await putSettings(server, { "x-surface-dev-client": "::ffff:127.0.0.1" })).status, 200, "the developer's own browser through Vite");
    assert.equal((await putSettings(server, {})).status, 200, "a direct loopback request is unchanged");
  } finally {
    await server.stop();
  }

  const proxied = await startServer({ ...CLEAN, TRUST_PROXY: "1" });
  try {
    const status = (await putSettings(proxied, { "x-forwarded-for": "203.0.113.9", "x-surface-dev-client": "127.0.0.1" })).status;
    assert.equal(status, 403, "a remote client cannot claim loopback with the header");
  } finally {
    await proxied.stop();
  }
});

test("malformed JSON gets a JSON 400, not Express's stack-trace page", async () => {
  const server = await startServer({ ...CLEAN });
  try {
    const res = await fetch(`${server.base}/api/genai`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.deepEqual(JSON.parse(body), { error: "Bad request" });
    assert.doesNotMatch(body, /node_modules|SyntaxError/);
  } finally {
    await server.stop();
  }
});

// Raw http so the Host header can be set (fetch treats it as forbidden).
function rawGet(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("CORS_ALLOWED_ORIGINS unset: only loopback origins are reflected (dev default)", async () => {
  const server = await startServer({ ...CLEAN });
  try {
    const local = await fetch(`${server.base}/api/health`, { headers: { origin: "http://localhost:5173" } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const foreign = await fetch(`${server.base}/api/health`, { headers: { origin: "https://evil.test" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.stop();
  }
});

test("BIND_HOST unset: the API is not reachable from the network", async (t) => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!lan) {
    t.skip("no LAN address");
    return;
  }
  const server = await startServer({ ...CLEAN });
  try {
    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
    const remote = await fetch(`http://${lan}:${server.port}/api/health`).catch((err) => err);
    assert.ok(!(remote instanceof Response), `reachable on ${lan}`);
  } finally {
    await server.stop();
  }
});

test("loopback guard: a foreign page cannot use the local API through the developer's browser", async () => {
  const server = await startServer({ ...CLEAN });
  try {
    // A simple request needs no preflight, so CORS alone would let it run.
    const foreignOrigin = await fetch(`${server.base}/api/settings`, {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "text/plain" },
      body: "{}"
    });
    assert.equal(foreignOrigin.status, 403);

    // <img src> from a foreign page: no Origin, but Sec-Fetch-Site says so.
    const imgTag = await fetch(`${server.base}/api/health`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(imgTag.status, 403);
    const sameSite = await fetch(`${server.base}/api/health`, { headers: { "sec-fetch-site": "same-site" } });
    assert.equal(sameSite.status, 200);

    // DNS rebinding: same-origin to the page, so only the Host gives it away.
    const rebound = await rawGet(server.port, "/api/health", { host: "evil.test:8788" });
    assert.equal(rebound.status, 403);
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`, `[::1]:${server.port}`]) {
      assert.equal((await rawGet(server.port, "/api/health", { host })).status, 200, host);
    }
  } finally {
    await server.stop();
  }
});

test("loopback guard: proxied visitors are not judged by Host, the tunnelled operator still is", async () => {
  const server = await startServer({ ...CLEAN, TRUST_PROXY: "1", CORS_ALLOWED_ORIGINS: "https://vr.example.org" });
  try {
    const visitor = await rawGet(server.port, "/api/health", {
      host: "vr.example.org",
      "x-forwarded-for": "203.0.113.9",
      origin: "https://vr.example.org"
    });
    assert.equal(visitor.status, 200);
    // An SSH tunnel arrives from loopback without X-Forwarded-For: the
    // operator's localhost page passes, a rebound one does not.
    const operator = await rawGet(server.port, "/api/health", {
      host: "localhost:9999",
      origin: "http://localhost:9999"
    });
    assert.equal(operator.status, 200);
    const rebound = await rawGet(server.port, "/api/health", {
      host: "evil.test:9999",
      "x-forwarded-host": "localhost"
    });
    assert.equal(rebound.status, 403);
  } finally {
    await server.stop();
  }
});

test("CORS_ALLOWED_ORIGINS set: only listed origins get the header", async () => {
  const server = await startServer({
    ...CLEAN,
    CORS_ALLOWED_ORIGINS: "https://vr.example.org, https://alt.example.org"
  });
  try {
    const allowed = await fetch(`${server.base}/api/health`, {
      headers: { origin: "https://vr.example.org" }
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://vr.example.org");

    const second = await fetch(`${server.base}/api/health`, {
      headers: { origin: "https://alt.example.org" }
    });
    assert.equal(second.headers.get("access-control-allow-origin"), "https://alt.example.org");

    const blocked = await fetch(`${server.base}/api/health`, {
      headers: { origin: "https://evil.test" }
    });
    // Over loopback a foreign origin is refused outright (the loopback guard);
    // a proxied visitor would get the answer without the header.
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);

    // Same-origin / non-browser callers send no Origin and must be unaffected.
    const noOrigin = await fetch(`${server.base}/api/health`);
    assert.equal(noOrigin.status, 200);
  } finally {
    await server.stop();
  }
});

test("/api/debug/xr: enabled by default, 404 when XR_DIAG_ENABLED=0", async () => {
  const dir = tempDir();
  const logFile = path.join(dir, "xr-diag.log");
  const server = await startServer({ ...CLEAN, XR_DIAG_LOG_FILE: logFile });
  try {
    const res = await fetch(`${server.base}/api/debug/xr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "test" })
    });
    assert.equal(res.status, 204);
  } finally {
    await server.stop();
  }

  const off = await startServer({ ...CLEAN, XR_DIAG_ENABLED: "0", XR_DIAG_LOG_FILE: logFile });
  try {
    const res = await fetch(`${off.base}/api/debug/xr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "test" })
    });
    assert.equal(res.status, 404);
  } finally {
    await off.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/debug/xr: the log rotates once at XR_DIAG_MAX_BYTES", async () => {
  const dir = tempDir();
  const logFile = path.join(dir, "xr-diag.log");
  const server = await startServer({
    ...CLEAN,
    XR_DIAG_LOG_FILE: logFile,
    XR_DIAG_MAX_BYTES: "200"
  });
  try {
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${server.base}/api/debug/xr`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "rotate", index: i, pad: "x".repeat(60) })
      });
      assert.equal(res.status, 204);
    }
    // Appends are async; give the last write a moment to land.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !fs.existsSync(`${logFile}.1`)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(`${logFile}.1`), "rotated generation exists");
    // Rotation is a rename, so there is a window between it and the next append
    // where the live log does not exist at all — and if the write that tripped
    // the rotation was the last one, it never comes back. An absent live log IS
    // "restarted small". Appends are still landing, so the file can also vanish
    // between an existence check and a stat: stat once and treat ENOENT as 0.
    let liveSize = 0;
    try {
      liveSize = fs.statSync(logFile).size;
    } catch (err) {
      assert.equal(err.code, "ENOENT");
    }
    assert.ok(liveSize <= 400, "live log restarted small");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("search queries truncate at SEARCH_QUERY_MAX_CHARS (default 200)", async () => {
  const mock = await startImageSearchMock();
  const server = await startServer({
    ...CLEAN,
    IMAGE_SEARCH_PROVIDER: "custom",
    IMAGE_SEARCH_ENDPOINT: mock.endpoint
  });
  try {
    const long = "o".repeat(500);
    const res = await fetch(`${server.base}/api/search/images?q=${long}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.sourceUrl, `image-search:${"o".repeat(200)}`);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("search queries honour an explicit SEARCH_QUERY_MAX_CHARS", async () => {
  const mock = await startImageSearchMock();
  const server = await startServer({
    ...CLEAN,
    SEARCH_QUERY_MAX_CHARS: "12",
    IMAGE_SEARCH_PROVIDER: "custom",
    IMAGE_SEARCH_ENDPOINT: mock.endpoint
  });
  try {
    const res = await fetch(`${server.base}/api/search/images?q=${"o".repeat(40)}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.sourceUrl, `image-search:${"o".repeat(12)}`);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("GenAI prompts truncate at GENAI_PROMPT_MAX_CHARS, not the search limit", async () => {
  const mock = await startMockSdapi();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base
  });
  try {
    const prompt = "p".repeat(1400);
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, count: 1 })
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.sourceUrl, `genai:${"p".repeat(1000)}`, "clipped at 1000, not 200");
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("SERVE_STATIC_DIR unset: no static serving, unknown paths still 404", async () => {
  const server = await startServer({ ...CLEAN });
  try {
    const res = await fetch(`${server.base}/`);
    assert.equal(res.status, 404, "dev shape: Vite serves the client, not this process");
  } finally {
    await server.stop();
  }
});

test("SERVE_STATIC_DIR: assets are immutable, index.html is not, /api/ is untouched", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>surface</title>");
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "export const ok = 1;\n");
  const server = await startServer({ ...CLEAN, SERVE_STATIC_DIR: dir });
  try {
    const root = await fetch(`${server.base}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<title>surface<\/title>/);
    assert.match(root.headers.get("cache-control") || "", /no-cache/);

    const asset = await fetch(`${server.base}/assets/index-abc123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") || "", /max-age=31536000/);

    // SPA fallback: a client route with no file behind it gets index.html.
    const deep = await fetch(`${server.base}/some/client/route`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /<title>surface<\/title>/);
    assert.match(deep.headers.get("cache-control") || "", /no-cache/);

    // The API must never be answered with the HTML shell.
    const missingApi = await fetch(`${server.base}/api/does-not-exist`);
    assert.equal(missingApi.status, 404);
    assert.doesNotMatch(await missingApi.text(), /<title>surface<\/title>/);

    // A real API route still works with static serving mounted.
    const health = await fetch(`${server.base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state paths outside the checkout are created on demand", async () => {
  const dir = tempDir();
  // None of these directories exist yet — the server has to make them.
  const stateRoot = path.join(dir, "var", "lib", "surface-browser");
  const logRoot = path.join(dir, "var", "log", "surface-browser");
  const server = await startServer({
    ...CLEAN,
    SETTINGS_FILE_PATH: path.join(stateRoot, "settings.local.json"),
    SPEND_STATE_PATH: path.join(stateRoot, "spend-state.json"),
    LOG_API_QUERIES_FILE: path.join(logRoot, "query.log"),
    XR_DIAG_LOG_FILE: path.join(logRoot, "xr-diag.log"),
    GENAI_IMAGE_DIR_PATH: path.join(stateRoot, "generated-images")
  });
  try {
    assert.ok(fs.existsSync(stateRoot), "state directory created at boot");
    assert.ok(fs.existsSync(logRoot), "log directory created at boot");

    // A settings write into the fresh directory must not ENOENT.
    const put = await putSettings(server);
    assert.equal(put.status, 200);
    assert.ok(fs.existsSync(path.join(stateRoot, "settings.local.json")));
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GenAI prompts honour an explicit GENAI_PROMPT_MAX_CHARS", async () => {
  const mock = await startMockSdapi();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROMPT_MAX_CHARS: "20",
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: mock.base
  });
  try {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p".repeat(90), count: 1 })
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.sourceUrl, `genai:${"p".repeat(20)}`);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

// DNS rebinding: the SSRF guard (assertTargetUrlAllowed) resolves a hostname
// once to validate it, but Node's fetch() then does its OWN, separate DNS
// resolution when it actually connects — an attacker-controlled hostname can
// answer differently between the two. fetchWithTimeout() closes that gap by
// pinning the already-validated address(es) into a per-call undici dispatcher
// (createPinnedDispatcher). These tests prove that mechanism is honoured on
// the real fetch()/undici code path server/index.js uses, not merely assumed
// from documentation.

test("DNS pinning mechanism: fetch() only reaches an address the dispatcher's lookup names", async () => {
  const upstream = http.createServer((_req, res) => res.end("pinned"));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  // A hostname reserved by RFC 2606 to never resolve — the ONLY way a fetch to
  // it can succeed is via a dispatcher that skips real DNS entirely, which is
  // exactly what createPinnedDispatcher does with the guard's own answer.
  const unresolvableUrl = `http://ssrf-pin-mechanism-test.invalid:${port}/`;
  try {
    // Negative control: without a pinned dispatcher, real DNS genuinely has
    // nothing to answer with. This proves the success below isn't
    // coincidental (e.g. some resolver treating .invalid as resolvable).
    // fetch() wraps the real getaddrinfo failure in a generic "fetch failed"
    // TypeError, so the DNS error code lives on err.cause, not err.message.
    let unpinnedErr = null;
    try {
      await fetch(unresolvableUrl);
    } catch (err) {
      unpinnedErr = err;
    }
    assert.ok(unpinnedErr, "a .invalid hostname must not resolve without pinning");
    assert.match(
      String(unpinnedErr.cause?.code || unpinnedErr.cause?.message || unpinnedErr.message),
      /ENOTFOUND|EAI_AGAIN/
    );

    // Same construction as createPinnedDispatcher() in server/net-policy.js: a
    // custom connect.lookup handing back the already-validated address,
    // ignoring whatever hostname undici asks about.
    const dispatcher = new UndiciAgent({
      connect: {
        lookup: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }])
      }
    });
    const res = await fetch(unresolvableUrl, { dispatcher });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "pinned", "the pinned dispatcher, not real DNS, decided where fetch() connected");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("genai (a1111) via a hostname target: the DNS-lookup branch resolves, validates and pins successfully", async () => {
  // Every other contract test points GENAI_ENDPOINT at a bare 127.0.0.1 IP
  // literal, which never exercises assertTargetUrlAllowed's dns.lookup()
  // branch (an IP literal skips it) or the address list that branch hands to
  // the pinned dispatcher. "localhost" does — a real, if trivial, hostname
  // resolution the guard must validate and then pin into the actual fetch().
  const mock = await startMockSdapi();
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: `http://localhost:${mock.port}`
  });
  try {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "pinned hostname", count: 1 })
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.items.length, 1);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test("genai (a1111) redirect: the guard re-validates AND re-pins the redirect target, not just the original host", async () => {
  // hop1 only ever redirects; if generation succeeds, the response can only
  // have come from hop2 — proof that fetchWithTimeout's redirect loop built a
  // FRESH pinned dispatcher for the new hop rather than reusing hop1's.
  const hop2 = await startMockSdapi();
  const hop1Port = await findFreePort();
  // 307 keeps the POST; a 302 would turn it into a GET, as fetch does.
  const hop1 = http.createServer((req, res) => {
    res.writeHead(307, { location: `${hop2.base}${req.url}` });
    res.end();
  });
  await new Promise((resolve) => hop1.listen(hop1Port, "127.0.0.1", resolve));
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: `http://127.0.0.1:${hop1Port}`
  });
  try {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "redirected", count: 1 })
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.items.length, 1);
  } finally {
    await server.stop();
    await hop2.stop();
    await new Promise((resolve) => hop1.close(resolve));
  }
});

test("DNS rebinding: a target that answers differently at validation time vs connect time still lands on the validated address", async () => {
  // The two tests above prove the pin round-trips for a legitimate target;
  // this one reproduces the actual attack. dns_rebind_test_preload.mjs
  // (loaded into the server child via NODE_OPTIONS=--import) makes ONE
  // hostname answer SAFE_ADDRESS to node:dns/promises.lookup() — what
  // assertTargetUrlAllowed() calls to validate — and ATTACKER_ADDRESS to the
  // callback-style node:dns.lookup() that Node's default net/undici
  // connector falls back to at actual connect time whenever nothing pins the
  // address first. A vulnerable fetchWithTimeout() would validate SAFE, then
  // let fetch() dial ATTACKER; the fix pins SAFE into the connection itself,
  // so ATTACKER is never even asked for.
  const TEST_HOST = "rebind-test.invalid";
  const SAFE_ADDRESS = "127.0.0.1";
  const ATTACKER_ADDRESS = "::1";
  const port = await findFreePort();

  let attackerHits = 0;
  const attackerServer = http.createServer((_req, res) => {
    attackerHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ images: [], info: "{}" }));
  });
  let safeHits = 0;
  const safeServer = http.createServer((_req, res) => {
    safeHits += 1;
    const png = encodePng(4, 4, Buffer.alloc(4 * 4 * 3, 200));
    const body = JSON.stringify({
      images: [png.toString("base64")],
      parameters: { seed: 1 },
      info: JSON.stringify({ seed: 1, all_seeds: [1] })
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((resolve) => attackerServer.listen(port, ATTACKER_ADDRESS, resolve));
  await new Promise((resolve) => safeServer.listen(port, SAFE_ADDRESS, resolve));

  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: `http://${TEST_HOST}:${port}`,
    NODE_OPTIONS: `--import=${path.join(SCRIPTS_DIR, "dns_rebind_test_preload.mjs")}`,
    DNS_REBIND_TEST_HOST: TEST_HOST,
    DNS_REBIND_SAFE_ADDRESS: SAFE_ADDRESS,
    DNS_REBIND_ATTACKER_ADDRESS: ATTACKER_ADDRESS
  });
  try {
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "rebind probe", count: 1 })
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(safeHits, 1, "the pinned connection must land on the address the guard validated");
    assert.equal(attackerHits, 0, "the rebound (connect-time-only) address must never be dialed");
  } finally {
    await server.stop();
    await new Promise((resolve) => attackerServer.close(resolve));
    await new Promise((resolve) => safeServer.close(resolve));
  }
});

test("IP blocklist: IPv6 forms that embed or tunnel to IPv4 follow the IPv4 verdict", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:a9fe:a9fe",
    // NAT64 well-known prefix with a private IPv4, and local-use NAT64.
    "64:ff9b::7f00:1", "64:ff9b::169.254.169.254", "64:ff9b:1::8.8.8.8", "64:ff9b:1:abcd::1",
    // 6to4 wrapping a private IPv4 (groups 1-2).
    "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:0a00:0001::",
    // Teredo, documentation, IPv4-translated.
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1",
    "::ffff:0:127.0.0.1", "::ffff:0:a9fe:a9fe",
    "[::1]", "not-an-ip"
  ];
  const allowed = [
    "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8",
    "2002:0808:0808::1", "::ffff:0:8.8.8.8", "2001:4860:4860::8888"
  ];
  for (const address of blocked) {
    assert.equal(isBlockedIpAddress(address), true, `${address} must be blocked`);
  }
  for (const address of allowed) {
    assert.equal(isBlockedIpAddress(address), false, `${address} must be allowed`);
  }
});

// Resource exhaustion on a small host with no queue in front of the scraping
// paths.

test("fetchWithTimeout: a deadline covers the BODY read, not just headers — a stalled body is aborted, not hung forever", async () => {
  // Sends headers immediately (so fetch()'s own await resolves fast) then
  // never writes another byte and never ends the response — a slow/stuck
  // upstream withholding the rest of the body. The timer must outlive the
  // headers, or the body read that follows (readResponseBuffer, called via
  // readJsonResponse here) has NO deadline and hangs while the connection stays open.
  const port = await findFreePort();
  const stallingServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    // Never res.end(): the connection is held open with the body incomplete.
  });
  await new Promise((resolve) => stallingServer.listen(port, "127.0.0.1", resolve));
  const server = await startServer({
    ...CLEAN,
    GENAI_PROVIDER: "a1111",
    GENAI_ENDPOINT: `http://127.0.0.1:${port}`,
    // Small on purpose so the test is fast; this is the SAME budget
    // fetchWithTimeout uses for both the header wait and the
    // body read.
    GENAI_TIMEOUT_MS: "500"
  });
  try {
    const startedAt = Date.now();
    const res = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "stalled body", count: 1 })
    });
    const elapsedMs = Date.now() - startedAt;
    // Generous ceiling: the deadline is 500ms, so anything well under the
    // node:test per-test timeout proves the body read was actually bounded
    // rather than hanging until the connection or the test runner gave up.
    assert.ok(elapsedMs < 5_000, `request should abort near the 500ms body deadline, took ${elapsedMs}ms`);
    assert.ok(res.status >= 500, `a stalled body must surface as a failure, got ${res.status}`);
  } finally {
    await server.stop();
    await new Promise((resolve) => stallingServer.close(resolve));
  }
});

test("SCRAPE_CONCURRENCY_MAX: requests over the ceiling get a prompt 503, not an unbounded queue", async () => {
  // None of /api/extract, /api/proxy/image or the GenAI source import can
  // reach a loopback mock server (no allowPrivateAddress hatch on any of
  // them — see the top-of-file note in contract_extract.test.mjs), so there
  // is no way to hold one of these requests open against a real upstream.
  // slow_dns_test_preload.mjs makes hostname resolution itself take
  // SLOW_DNS_DELAY_MS for one fixed hostname instead — the request is held
  // open inside the SSRF guard (assertTargetUrlAllowed), which is enough to
  // observe the concurrency ceiling deterministically regardless of what the
  // request ultimately resolves to.
  const TEST_HOST = "slow-scrape-test.invalid";
  const server = await startServer({
    ...CLEAN,
    SCRAPE_CONCURRENCY_MAX: "2",
    NODE_OPTIONS: `--import=${path.join(SCRIPTS_DIR, "slow_dns_test_preload.mjs")}`,
    SLOW_DNS_TEST_HOST: TEST_HOST,
    SLOW_DNS_DELAY_MS: "400"
  });
  try {
    // Three different pages: identical ones would share one in-flight request.
    const url = (page) => `${server.base}/api/extract?url=${encodeURIComponent(`http://${TEST_HOST}/${page}`)}`;
    const first = fetch(url(1));
    const second = fetch(url(2));
    // Give both requests time to be received and pass the (synchronous)
    // concurrency guard before firing the third — the SSRF guard's delayed
    // DNS lookup is what holds them open past this point.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const thirdStartedAt = Date.now();
    const third = await fetch(url(3));
    const thirdElapsedMs = Date.now() - thirdStartedAt;
    assert.equal(third.status, 503, "a third concurrent request must be refused, not queued");
    assert.ok(thirdElapsedMs < 300, `the 503 should be immediate, not wait behind the slow requests (took ${thirdElapsedMs}ms)`);

    // Images have their own pool: a full page-load pool must not refuse them.
    const image = await fetch(`${server.base}/api/proxy/image?url=${encodeURIComponent(`http://${TEST_HOST}/a.png`)}`);
    assert.notEqual(image.status, 503, "the image proxy is not starved by page loads");

    const [firstRes, secondRes] = await Promise.all([first, second]);
    assert.equal(firstRes.status, 400, "the held request eventually fails its (unresolvable) target, not hangs");
    assert.equal(secondRes.status, 400);

    // The ceiling must have released both slots: a fresh request now succeeds
    // (i.e. gets past the guard, then fails the SAME way, immediately —
    // proving it was not still refused as over the ceiling).
    const afterStartedAt = Date.now();
    const after = await fetch(url(4));
    const afterElapsedMs = Date.now() - afterStartedAt;
    assert.equal(after.status, 400);
    assert.ok(afterElapsedMs > 300, "a released slot re-enters the slow DNS wait rather than being served from some leftover state");
  } finally {
    await server.stop();
  }
});

test("SCRAPE_CONCURRENCY_MAX: a client that disconnects keeps its slot until its work ends", async () => {
  // Releasing on disconnect let a client that kept hanging up stack detached
  // fetches and decodes past the ceiling.
  const TEST_HOST = "slow-scrape-test.invalid";
  const server = await startServer({
    ...CLEAN,
    SCRAPE_CONCURRENCY_MAX: "1",
    NODE_OPTIONS: `--import=${path.join(SCRIPTS_DIR, "slow_dns_test_preload.mjs")}`,
    SLOW_DNS_TEST_HOST: TEST_HOST,
    SLOW_DNS_DELAY_MS: "600"
  });
  try {
    const url = (page) => `${server.base}/api/extract?url=${encodeURIComponent(`http://${TEST_HOST}/${page}`)}`;
    const abort = new AbortController();
    const abandoned = fetch(url(1), { signal: abort.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    abort.abort();
    await abandoned;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const whileWorking = await fetch(url(2));
    assert.equal(whileWorking.status, 503, "the abandoned request's lookup is still running, so its slot is still held");

    await new Promise((resolve) => setTimeout(resolve, 700));
    const afterWork = await fetch(url(3));
    assert.equal(afterWork.status, 400, "once the abandoned work ends, the slot is free again");
  } finally {
    await server.stop();
  }
});

test("RATE_LIMIT_MAX_TRACKED_IPS: the bucket map is bounded — the oldest tracked IP is forgotten, not kept forever", async () => {
  // TRUST_PROXY=1 makes req.ip follow X-Forwarded-For, so each fake client
  // below is a genuinely distinct rate-limit bucket key. A long window
  // (60s) rules out "it passed because the window rolled over" as an
  // alternative explanation for anything below.
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    RATE_LIMIT_REQUESTS_PER_WINDOW: "1",
    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_MAX_TRACKED_IPS: "3"
  });
  const target = `${server.base}/api/extract?url=${encodeURIComponent("http://127.0.0.1/")}`;
  const asClient = (ip) => fetch(target, { headers: { "x-forwarded-for": ip } });
  try {
    // A's one-per-window allowance: first request runs (400, blocked target,
    // but the limiter let it through), second is rate limited.
    assert.equal((await asClient("10.0.0.1")).status, 400, "A's first request runs");
    assert.equal((await asClient("10.0.0.1")).status, 429, "A's second request is rate limited");

    // B and C fill the map to its cap of 3 (A, B, C).
    assert.equal((await asClient("10.0.0.2")).status, 400, "B's first request runs");
    assert.equal((await asClient("10.0.0.3")).status, 400, "C's first request runs");

    // D is a 4th distinct key arriving at a full map: the oldest entry (A,
    // the first one ever inserted) must be evicted to make room, leaving
    // {B, C, D}.
    assert.equal((await asClient("10.0.0.4")).status, 400, "D's first request runs, evicting A");

    // A is asked again, still well inside its original 60s window. An
    // unbounded map would remember A used its allowance and 429 this. A
    // bounded one forgot A entirely when it was evicted, so this is
    // indistinguishable from A's very first request: it runs.
    assert.equal((await asClient("10.0.0.1")).status, 400, "A was evicted, so this looks like a fresh client");
  } finally {
    await server.stop();
  }
});

test("the GenAI job poll is not rate-limited against the expensive budget", async () => {
  // The limiter is mounted on the "/api/genai" PREFIX, so it also sees
  // /api/genai/job/:id, which the client polls every 500 ms for the 20-60 s a
  // hosted batch takes. At 20/minute that would be the whole budget in ten
  // seconds, so polling must use a separate read tier.
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    RATE_LIMIT_REQUESTS_PER_WINDOW: "2",
    RATE_LIMIT_READ_REQUESTS_PER_WINDOW: "50",
    RATE_LIMIT_WINDOW_MS: "60000"
  });
  const ip = { "x-forwarded-for": "10.9.9.9" };
  try {
    // Twenty polls — ten times the expensive budget. A 404 means the limiter
    // let it reach the route (there is no such job); a 429 means it did not.
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${server.base}/api/genai/job/nope-${i}`, { headers: ip });
      assert.notEqual(res.status, 429, `poll ${i + 1} must not be rate limited`);
    }
    // ...and the expensive budget is UNTOUCHED by all that polling, because the
    // two tiers use separate buckets.
    const first = await fetch(
      `${server.base}/api/extract?url=${encodeURIComponent("http://127.0.0.1/")}`, { headers: ip }
    );
    assert.equal(first.status, 400, "the expensive allowance was not spent by the polls");
  } finally {
    await server.stop();
  }
});

test("the expensive routes still hit their own limit", async () => {
  // The other half: the read tier must not disarm the limiter.
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    RATE_LIMIT_REQUESTS_PER_WINDOW: "1",
    RATE_LIMIT_READ_REQUESTS_PER_WINDOW: "500",
    RATE_LIMIT_WINDOW_MS: "60000"
  });
  const ip = { "x-forwarded-for": "10.9.9.8" };
  const extract = () => fetch(
    `${server.base}/api/extract?url=${encodeURIComponent("http://127.0.0.1/")}`, { headers: ip }
  );
  try {
    assert.equal((await extract()).status, 400, "first request runs");
    assert.equal((await extract()).status, 429, "second is rate limited");
    // POST /api/genai is expensive too — it must share the expensive bucket,
    // NOT the read one, even though its path starts with the same prefix.
    const post = await fetch(`${server.base}/api/genai`, {
      method: "POST",
      headers: { ...ip, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" })
    });
    assert.equal(post.status, 429, "POST /api/genai is an expensive route");
  } finally {
    await server.stop();
  }
});

test("the rate limit counts an IPv6 /64 as one client, like the spend caps", async () => {
  // One tenant holds a whole /64; per-address keys would let it rotate past the limit.
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    RATE_LIMIT_REQUESTS_PER_WINDOW: "1",
    RATE_LIMIT_WINDOW_MS: "60000"
  });
  const asClient = (ip) => fetch(`${server.base}/api/extract?url=${encodeURIComponent("http://127.0.0.1/")}`, {
    headers: { "x-forwarded-for": ip }
  });
  try {
    assert.equal((await asClient("2001:db8:1:2::1")).status, 400, "first request runs");
    assert.equal((await asClient("2001:db8:1:2::ffff")).status, 429, "another address in the same /64 shares the bucket");
    assert.equal((await asClient("2001:db8:1:3::1")).status, 400, "the next /64 is another client");
  } finally {
    await server.stop();
  }
});

test("/api/debug/xr: lines are capped and the route is rate-limited", async () => {
  const dir = tempDir();
  const logFile = path.join(dir, "xr-diag.log");
  const server = await startServer({
    ...CLEAN,
    TRUST_PROXY: "1",
    XR_DIAG_LOG_FILE: logFile,
    RATE_LIMIT_REQUESTS_PER_WINDOW: "1",
    RATE_LIMIT_READ_REQUESTS_PER_WINDOW: "2",
    RATE_LIMIT_WINDOW_MS: "60000"
  });
  const post = (body) => fetch(`${server.base}/api/debug/xr`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.7" },
    body: JSON.stringify(body)
  });
  try {
    assert.equal((await post({ event: "big", text: "x".repeat(200_000) })).status, 204);
    assert.equal((await post({ event: "small" })).status, 204);
    assert.equal((await post({ event: "flood" })).status, 429);
    // Appends land after the 204; wait for the second.
    const readLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n") : []);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && readLines().length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lines = readLines();
    assert.equal(lines.length, 2);
    assert.ok(lines[0].length <= 8192, `line is ${lines[0].length} chars`);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/health names the commit only to local callers", async () => {
  // In public it would show which published fixes are not deployed yet.
  const server = await startServer({ ...CLEAN, TRUST_PROXY: "1" });
  try {
    const remote = await (await fetch(`${server.base}/api/health`, { headers: { "x-forwarded-for": "203.0.113.9" } })).json();
    assert.equal(remote.ok, true);
    assert.equal(remote.build, undefined);
    const local = await (await fetch(`${server.base}/api/health`)).json();
    assert.ok(local.build, "a local caller still sees the build");
  } finally {
    await server.stop();
  }
});
