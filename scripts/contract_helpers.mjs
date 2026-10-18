// Shared helpers for the contract tests.
//
// Each contract suite starts the REAL Express server (server/index.js) as a
// child process with a controlled env, waits for /api/health, and asserts
// against real HTTP. These helpers keep that lifecycle deterministic and make
// sure no stray child processes survive a suite (killed in after hooks, even
// on failure).

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MVP_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(MVP_ROOT, "server", "index.js");
export const MOCK_SDAPI_ENTRY = path.join(__dirname, "mock_sdapi.mjs");
export const MOCK_STT_ENTRY = path.join(__dirname, "mock_stt.mjs");
export const MOCK_FAL_ENTRY = path.join(__dirname, "mock_fal.mjs");
// A test that throws before its `finally` (a server that never came up, say)
// leaves its children running, and a running child keeps this file's process
// alive: `node --test` then waits on the file for good. Unreferenced children
// cannot hold it open, and whatever is left is killed on the way out.
const liveChildren = new Set();
process.on("exit", () => {
  for (const proc of liveChildren) {
    proc.kill("SIGKILL");
  }
});

function spawnTracked(...args) {
  const proc = spawn(...args);
  liveChildren.add(proc);
  proc.once("exit", () => liveChildren.delete(proc));
  proc.unref();
  proc.stdout?.unref?.();
  proc.stderr?.unref?.();
  return proc;
}

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function tcpUp(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}

export async function waitForTcp(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpUp(port)) return;
    await sleep(80);
  }
  throw new Error(`nothing listening on port ${port} within ${timeoutMs}ms`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Spawn the mock sdapi provider on a free port. Returns a handle with stop().
export async function startMockSdapi(extraEnv = {}) {
  const port = await findFreePort();
  const proc = spawnTracked(process.execPath, [MOCK_SDAPI_ENTRY], {
    env: { ...process.env, MOCK_SDAPI_PORT: String(port), ...extraEnv },
    stdio: "ignore"
  });
  await waitForTcp(port);
  return {
    proc,
    port,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await killProc(proc);
    }
  };
}

// Spawn the mock fal.run provider on a free port. Returns a handle with stop().
export async function startMockFal(extraEnv = {}) {
  const port = await findFreePort();
  const proc = spawnTracked(process.execPath, [MOCK_FAL_ENTRY], {
    env: { ...process.env, MOCK_FAL_PORT: String(port), ...extraEnv },
    stdio: "ignore"
  });
  await waitForTcp(port);
  return {
    proc,
    port,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await killProc(proc);
    }
  };
}

// Spawn the mock STT provider on a free port. Returns a handle with stop().
export async function startMockStt(extraEnv = {}) {
  const port = await findFreePort();
  const proc = spawnTracked(process.execPath, [MOCK_STT_ENTRY], {
    env: { ...process.env, MOCK_STT_PORT: String(port), ...extraEnv },
    stdio: "ignore"
  });
  await waitForTcp(port);
  return {
    proc,
    port,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await killProc(proc);
    }
  };
}

// Start the real Express API with a controlled env. The child gets ONLY the env
// we build here (not the developer's full shell env), so provider keys in a
// local .env / shell cannot leak into a test. dotenv still loads server/.env if
// present; every provider key is explicitly blanked below, and empty string is
// treated as "unset" by the server's getRawSetting, so .env values are beaten.
export async function startServer(env = {}) {
  // The port is free when findFreePort looks and can be taken before the child
  // binds it (another suite, a mock still shutting down). One retry on a fresh
  // port turns that race from a red run into nothing.
  try {
    return await startServerOnce(env);
  } catch {
    return startServerOnce(env);
  }
}

async function startServerOnce(env) {
  const port = await findFreePort();
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-settings-"));
  const settingsPath = path.join(settingsDir, "settings.local.json");
  const queryLogPath = path.join(settingsDir, "query.log");
  const ownsGeneratedImagesDir = !env.GENAI_IMAGE_DIR_PATH;
  const generatedImagesDir = env.GENAI_IMAGE_DIR_PATH || fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-generated-"));
  fs.writeFileSync(settingsPath, "{}\n");
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    IMAGE_SEARCH_PROVIDER: "",
    IMAGE_SEARCH_ENDPOINT: "",
    SERPER_API_KEY: "",
    BRAVE_SEARCH_API_KEY: "",
    GENAI_PROVIDER: "",
    GENAI_ENDPOINT: "",
    GENAI_DRAWTHINGS_ENDPOINT: "",
    GENAI_A1111_ENDPOINT: "",
    GENAI_CUSTOM_ENDPOINT: "",
    GENAI_API_KEY: "",
    FAL_KEY: "",
    GENAI_MUSEUM_SAFE: "",
    GENAI_SAVE_IMAGES_TO_DISK: "",
    GENAI_CLEANUP_IMAGES: "",
    GENAI_IMAGE_RETENTION_DAYS: "",
    STT_PROVIDER: "",
    STT_ENDPOINT: "",
    STT_API_KEY: "",
    OPENAI_API_KEY: "",
    STT_BUILTIN_MODEL: "",
    STT_BUILTIN_LOCAL_ONLY: "",
    STT_BUILTIN_TEST_TRANSCRIPT: "",
    ALLOWED_TARGET_HOSTS: "",
    RATE_LIMIT_REQUESTS_PER_WINDOW: "",
    HIDE_SETTINGS: "",
    SETTINGS_TOKEN: "",
    SETTINGS_FILE_PATH: settingsPath,
    LOG_API_QUERIES_FILE: queryLogPath,
    GENAI_IMAGE_DIR_PATH: generatedImagesDir,
    ...env,
    PORT: String(port)
  };

  const proc = spawnTracked(process.execPath, [SERVER_ENTRY], {
    cwd: MVP_ROOT,
    env: childEnv,
    // Both pipes are drained below. Startup diagnostics (the settings summary,
    // the pool's key/member counts, a refused pack) are only assertable if the
    // suite can read them back.
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderr = [];
  const stdout = [];
  proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  proc.stdout.on("data", (chunk) => stdout.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base, proc);
  } catch (err) {
    await killProc(proc);
    fs.rmSync(settingsDir, { recursive: true, force: true });
    if (ownsGeneratedImagesDir) {
      fs.rmSync(generatedImagesDir, { recursive: true, force: true });
    }
    throw new Error(`${err.message}\nserver stderr:\n${stderr.join("")}`);
  }

  return {
    proc,
    port,
    base,
    generatedImagesDir,
    queryLogPath,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    async stop() {
      await killProc(proc);
      fs.rmSync(settingsDir, { recursive: true, force: true });
      if (ownsGeneratedImagesDir) {
        fs.rmSync(generatedImagesDir, { recursive: true, force: true });
      }
    }
  };
}

async function waitForHealth(base, proc, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no attempt";
  while (Date.now() < deadline) {
    // Answered by somebody else's server on the same port is not ready.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      lastErr = `server exited (${proc.exitCode ?? proc.signalCode})`;
      break;
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        await res.json();
        return;
      }
      lastErr = `health returned ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(80);
  }
  throw new Error(`/api/health never became ready (${lastErr})`);
}

export function killProc(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), 2000);
    timer.unref?.();
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGKILL");
  });
}

// A tiny local JSON endpoint used as the `custom` image-search provider. This
// exercises the shared envelope + normalization without touching the
// SSRF-guarded /api/extract path.
export async function startImageSearchMock() {
  const port = await findFreePort();
  const http = await import("node:http");
  const server = http.default.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/search") {
      const payload = {
        items: [
          {
            imageUrl: "https://example.test/a.jpg",
            link: "https://example.test/a",
            width: 640,
            height: 480
          },
          {
            image: "https://example.test/b.png",
            source: "https://example.test/b",
            width: 800,
            height: 600
          }
        ]
      };
      const body = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    endpoint: `http://127.0.0.1:${port}/search`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
