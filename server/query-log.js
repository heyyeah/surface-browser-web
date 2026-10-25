import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseNonNegativeInteger, resolveFilePath } from "./env.js";
import { normalizeText } from "./genai-pool.js";
import { describeEvent } from "./live-monitor.js";
import {
  getFalImageModel,
  getFalTextModel,
  getGenAiProvider,
  getIntegerSetting,
  getOptionalIntegerSetting,
  getOptionalNumberSetting,
  isApiQueryLoggingEnabled,
  safeResolvedGenAiEndpoint
} from "./settings.js";

const API_QUERY_LOG_FILE = process.env.LOG_API_QUERIES_FILE || new URL("./query.log", import.meta.url);
const XR_DIAG_LOG_FILE = process.env.XR_DIAG_LOG_FILE || new URL("./xr-diag.log", import.meta.url);
const XR_DIAG_MAX_BYTES = parseNonNegativeInteger(process.env.XR_DIAG_MAX_BYTES, 20 * 1024 * 1024);

// index.js state, handed over by initQueryLog() once it exists.
let liveMonitor;
let liveSessionContext;
let bookmarkPrompts;

export function initQueryLog(deps) {
  ({ liveMonitor, liveSessionContext, bookmarkPrompts } = deps);
}

export function getApiQueryLogFilePath() {
  if (API_QUERY_LOG_FILE instanceof URL) {
    return decodeURIComponent(API_QUERY_LOG_FILE.pathname);
  }
  return path.resolve(String(API_QUERY_LOG_FILE));
}

export function logApiQuery(eventType, details = {}) {
  const liveSession = liveSessionContext.getStore();
  if (liveSession) {
    const line = describeEvent(eventType, details);
    if (line) {
      liveMonitor.addEvent(liveSession, line);
    }
  }
  if (!isApiQueryLoggingEnabled()) {
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    event: eventType,
    ...details
  };
  const line = JSON.stringify(entry);
  console.info(`[Surface Browser API query] ${line}`);

  const filePath = getApiQueryLogFilePath();
  fs.mkdir(path.dirname(filePath), { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      console.warn(`Could not prepare API query log directory: ${mkdirErr.message}`);
      return;
    }
    fs.appendFile(filePath, `${line}\n`, (writeErr) => {
      if (writeErr) {
        console.warn(`Could not write API query log: ${writeErr.message}`);
      }
    });
  });
}

export function genAiQueryLogDetails({ provider = getGenAiProvider(), prompt = "", count = null, sourceRecord = null } = {}) {
  const steps = getOptionalIntegerSetting("GENAI_STEPS");
  const guidanceEmbed = provider === "drawthings" ? getOptionalNumberSetting("GENAI_DRAWTHINGS_GUIDANCE_EMBED") : null;
  return {
    provider,
    endpoint: provider === "fal"
      ? (sourceRecord ? getFalImageModel() : getFalTextModel())
      : safeResolvedGenAiEndpoint(provider),
    prompt,
    bookmark: bookmarkPrompts.has(normalizeText(sourceRecord?.genai?.prompt || prompt)),
    mode: sourceRecord ? "vary" : "generate",
    sourceId: sourceRecord?.id || null,
    count,
    width: sourceRecord?.width || getIntegerSetting("GENAI_WIDTH"),
    height: sourceRecord?.height || getIntegerSetting("GENAI_HEIGHT"),
    steps: steps ?? "default",
    guidanceEmbed: guidanceEmbed ?? "default"
  };
}

export function getXrDiagLogFilePath() {
  return resolveFilePath(XR_DIAG_LOG_FILE);
}

// Single-generation rotation: at the cap the current log becomes `<file>.1`
// (replacing any previous .1) and a fresh file starts. Bounded disk use with no
// logrotate dependency and no truncation mid-line.
//
// Serialised on one promise chain: each line waits for the previous line's whole
// stat/rotate/append. Otherwise concurrent requests each measure the file before
// anyone rotates, all decide there is room, and the log passes its cap. Appends
// are occasional diagnostics, so the ordering costs nothing.
let xrDiagWriteChain = Promise.resolve();

export function appendXrDiagLine(line) {
  const filePath = getXrDiagLogFilePath();
  xrDiagWriteChain = xrDiagWriteChain.then(async () => {
    try {
      if (XR_DIAG_MAX_BYTES) {
        let size = 0;
        try {
          ({ size } = await fsp.stat(filePath));
        } catch {
          size = 0; // No file yet: nothing to rotate.
        }
        if (size && size + Buffer.byteLength(line) > XR_DIAG_MAX_BYTES) {
          await fsp.rename(filePath, `${filePath}.1`);
        }
      }
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.appendFile(filePath, line);
    } catch (err) {
      // A diagnostic log must never take the request path down with it.
      console.warn(`Could not write XR diag log: ${err.message}`);
    }
  });
}
