import path from "node:path";

export function parseNonNegativeInteger(raw, defaultValue) {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

export function parsePositiveInteger(raw, defaultValue) {
  const parsed = parseNonNegativeInteger(raw, defaultValue);
  return parsed > 0 ? parsed : defaultValue;
}

export function parseOptionalPositiveInteger(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

export function parseOptionalPositiveNumber(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function parseBoolean(raw, defaultValue = false) {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// TRUST_PROXY accepts what express's "trust proxy" accepts: a hop count ("1"
// behind one reverse proxy), a boolean word, or a proxy-addr spec such as
// "loopback" or a comma-separated subnet list. Unset/empty is 0 = trust nothing.
export function parseTrustProxy(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return 0;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") {
    return true;
  }
  if (lower === "false" || lower === "no" || lower === "off") {
    return 0;
  }
  return value;
}

export function parseCorsAllowedOrigins(raw) {
  if (!raw) {
    return new Set();
  }
  return new Set(
    String(raw)
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean)
  );
}

export function parseAllowedTargetHosts(raw) {
  if (!raw) {
    return new Set();
  }
  return new Set(
    String(raw)
      .split(",")
      .map((host) => normalizeHostname(host.trim()))
      .filter(Boolean)
  );
}

export function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function clampNumber(raw, min, max, defaultValue) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// Every configurable path may be a file: URL (the in-checkout default) or an
// operator-supplied string pointing anywhere, so a deploy that replaces the
// checkout does not wipe state.
export function resolveFilePath(value) {
  if (value instanceof URL) {
    return decodeURIComponent(value.pathname);
  }
  return path.resolve(String(value));
}

export function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    const str = String(value).trim();
    if (str) {
      return str;
    }
  }
  return null;
}
