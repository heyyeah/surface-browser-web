import dns from "node:dns/promises";
import net from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { Agent as UndiciAgent } from "undici";
import { normalizeHostname, parseAllowedTargetHosts, parseNonNegativeInteger } from "./env.js";
import { RequestPolicyError } from "./errors.js";
import { isBlockedIpAddress } from "./ip-blocklist.js";

export const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
export const MAX_RESPONSE_BYTES = parseNonNegativeInteger(process.env.MAX_RESPONSE_BYTES, 10 * 1024 * 1024);
const MAX_REDIRECTS = parseNonNegativeInteger(process.env.MAX_REDIRECTS, 5);
export const ALLOWED_TARGET_HOSTS = parseAllowedTargetHosts(process.env.ALLOWED_TARGET_HOSTS);

// A paid provider (fal, Serper) can bill us the moment it answers with a usable
// response, before our own code has done anything with it, and reading the body
// or decoding can still fail afterward. readJsonResponse() flips `billed` the
// instant it sees response.ok so a route's catch block knows a release would
// refund something already paid for. AsyncLocalStorage (not a plain variable)
// because requests run concurrently; AsyncResource.bind is used at the genai
// queue boundary because a queued job's fetch happens later, off a different
// job's continuation, which would lose this context.
export const providerBillingContext = new AsyncLocalStorage();

export async function normalizeAndAssertTargetUrl(rawValue, label) {
  const normalized = normalizeUrl(rawValue);
  if (!normalized) {
    throw new RequestPolicyError(`Missing or invalid ${label}`);
  }
  await assertTargetUrlAllowed(normalized);
  return normalized;
}

export function normalizeUrl(rawValue) {
  if (!rawValue) {
    return null;
  }
  let str = String(rawValue).trim();
  if (!str) {
    return null;
  }
  if (!/^https?:\/\//i.test(str)) {
    str = `https://${str}`;
  }
  try {
    const parsed = new URL(str);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function assertTargetUrlAllowed(
  urlValue,
  {
    applyHostAllowlist = true,
    allowPrivateAddress = false,
    allowNonStandardPort = false
  } = {}
) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new RequestPolicyError("Invalid target URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RequestPolicyError("Target URL must use http or https");
  }

  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (!allowNonStandardPort && port !== "80" && port !== "443") {
    throw new RequestPolicyError("Target URL port must be 80 or 443");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new RequestPolicyError("Target URL hostname is required");
  }

  if (applyHostAllowlist && ALLOWED_TARGET_HOSTS.size > 0 && !ALLOWED_TARGET_HOSTS.has(hostname)) {
    throw new RequestPolicyError(`Target host is not allowed: ${hostname}`);
  }

  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion) {
    if (!allowPrivateAddress && isBlockedIpAddress(hostname)) {
      throw new RequestPolicyError(`Target host resolves to a blocked address: ${hostname}`);
    }
    // No DNS involved for an IP literal, so nothing to pin — the connection
    // can only ever go to the address already checked above.
    return { url: parsed.toString(), addresses: [{ address: hostname, family: literalIpVersion }] };
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new RequestPolicyError(`Target hostname could not be resolved: ${hostname}`);
  }

  if (!records.length) {
    throw new RequestPolicyError(`Target hostname did not resolve: ${hostname}`);
  }

  for (const record of records) {
    if (!allowPrivateAddress && isBlockedIpAddress(record.address)) {
      throw new RequestPolicyError(`Target host resolves to a blocked address: ${record.address}`);
    }
  }

  // Every address this hostname resolved to was checked above. Hand all of them
  // back (not just the first) so the pinned dispatcher in fetchWithTimeout() can
  // still fail over between them without dialing an address the loop did not see.
  return { url: parsed.toString(), addresses: records };
}

export function browserUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
}

// fetch() resolves DNS itself when it connects, a separate lookup from the one
// assertTargetUrlAllowed() validated. An attacker-controlled hostname could
// answer differently between the two (DNS rebinding): public during the check,
// then 127.0.0.1 or a cloud metadata address when fetch() dials. Pinning the
// validated address(es) into a per-call dispatcher means the socket can only go
// somewhere the guard looked at.
export function createPinnedDispatcher(addresses) {
  return new UndiciAgent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, addresses.map((record) => ({ address: record.address, family: record.family })));
      }
    }
  });
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, policyOptions = {}) {
  // One deadline across every redirect hop; a fresh timer per hop would let a
  // chain of slow redirects hold a concurrency slot for MAX_REDIRECTS x timeoutMs.
  const deadline = Date.now() + timeoutMs;
  let { url: nextUrl, addresses } = await assertTargetUrlAllowed(url, policyOptions);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Request timed out");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let response;
    try {
      response = await fetch(nextUrl, {
        ...options,
        signal: controller.signal,
        redirect: "manual",
        dispatcher: createPinnedDispatcher(addresses)
      });
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }

    if (!isRedirectStatus(response.status)) {
      // Deliberately not cleared here: the caller reads the body (see
      // readResponseBuffer) after this returns, and the same timer must still abort a
      // body trickled past timeoutMs, not just a slow connect/headers wait. Firing
      // after the body is read is a harmless no-op.
      return response;
    }

    clearTimeout(timeout);
    if (redirects >= MAX_REDIRECTS) {
      throw new RequestPolicyError("Too many redirects");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new RequestPolicyError("Redirect response is missing a Location header");
    }

    await response.body?.cancel?.();
    const previousUrl = nextUrl;
    ({ url: nextUrl, addresses } = await assertTargetUrlAllowed(new URL(location, nextUrl).toString(), policyOptions));
    options = redirectedRequestOptions(options, response.status, previousUrl, nextUrl);
  }

  throw new RequestPolicyError("Too many redirects");
}

// What the fetch spec does on a followed redirect: 303 (and 301/302 after a
// POST) becomes a bodiless GET, and credentials do not cross to another origin.
export function redirectedRequestOptions(options, status, fromUrl, toUrl) {
  const method = String(options.method || "GET").toUpperCase();
  const toGet = (status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST");
  const crossOrigin = new URL(fromUrl).origin !== new URL(toUrl).origin;
  if (!toGet && !crossOrigin) {
    return options;
  }
  const drop = new Set([
    ...(toGet ? ["content-type", "content-length", "content-encoding", "content-language", "content-location"] : []),
    ...(crossOrigin ? ["authorization", "cookie", "proxy-authorization"] : [])
  ]);
  const headers = {};
  for (const [name, value] of new Headers(options.headers || {}).entries()) {
    if (!drop.has(name)) {
      headers[name] = value;
    }
  }
  return toGet ? { ...options, method: "GET", body: undefined, headers } : { ...options, headers };
}

export function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

export async function readResponseBuffer(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestPolicyError(`Response body exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.byteLength > maxBytes) {
      throw new RequestPolicyError(`Response body exceeds ${maxBytes} bytes`);
    }
    return fallback;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new RequestPolicyError(`Response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, received);
}

export async function readJsonResponse(response, label, maxBytes = Math.min(MAX_RESPONSE_BYTES, 2 * 1024 * 1024)) {
  if (!response.ok) {
    const detail = await readErrorResponseDetail(response);
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  // A 2xx means the provider accepted the request; for a paid provider it may
  // already have billed us whether or not the body reads. See providerBillingContext.
  const billing = providerBillingContext.getStore();
  if (billing) {
    billing.billed = true;
  }

  const text = (await readResponseBuffer(response, maxBytes)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON content`);
  }
}

export async function readErrorResponseDetail(response) {
  try {
    const text = (await readResponseBuffer(response, Math.min(MAX_RESPONSE_BYTES, 4096))).toString("utf8").trim();
    if (!text) {
      return "";
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.detail === "string") {
        return parsed.detail;
      }
      if (Array.isArray(parsed.detail)) {
        return parsed.detail
          .map((item) => item?.msg || item?.message || JSON.stringify(item))
          .filter(Boolean)
          .join("; ");
      }
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
    } catch {
      // Fall through to plain text.
    }
    return text.slice(0, 500);
  } catch {
    return "";
  }
}
