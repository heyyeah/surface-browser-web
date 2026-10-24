// Daily spend caps for the paid surfaces (fal images, Serper queries).
//
// The queue in index.js paces GenAI but is not a cap, and one request may ask for
// up to 15 images; a per-request rate limiter would count calls while the cost
// lives in `count`. So this counts the cost unit (images, queries), globally and
// per client, against a UTC-daily budget.
//
// Dependency-free (node builtins only) and injectable (clock, paths, caps), so
// it is testable without HTTP.
//
// Inert by default: every cap defaults to 0 = unlimited, and with no cap set the
// guard does not count or write a state file or spend log. `enabled: true`
// counts without capping.
//
// Reserve, then release: callers reserve the requested amount before calling the
// provider, so a `count: 15` request cannot slip past, and release whatever the
// provider never delivered. Release is partial-aware: an async job that produced
// 3 of 4 images before failing releases 1, not 4, otherwise late cancellation
// would be a free-images bug.
//
// Persistence: writes are atomic (temp file + fsync + rename) with one retained
// `.prev` generation. A missing primary is a first run and starts clean; a
// primary that is present but unreadable falls back to `.prev`, and if that is
// also unusable the guard fails closed for the rest of the UTC day (every
// reservation refused) rather than open at zero. The day still rolls over at
// UTC midnight.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const SCOPES = Object.freeze(["genai", "search"]);

export function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Expand any IPv6 spelling to exactly 8 minimal hextets. The caller must have
// validated with net.isIPv6 first — this trusts the shape.
function ipv6Hextets(address) {
  let text = address;
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two hextets, not one group.
  const lastColon = text.lastIndexOf(":");
  if (text.indexOf(".", lastColon) >= 0) {
    const quad = text.slice(lastColon + 1).split(".").map(Number);
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length > 1
      ? [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
      : left;
  return groups.length === 8 ? groups.map((h) => parseInt(h, 16).toString(16)) : null;
}

// The bucket a spend reservation is charged to.
//
// IPv6 must collapse to the /64: a residential tenant holds a whole /64 and
// could mint a fresh bucket per request, defeating the per-client cap. IPv4 keys
// are the address as given; widening would bucket unrelated visitors behind one
// carrier NAT together.
export function spendClientKey(address) {
  const raw = String(address ?? "").trim();
  // A zone id (fe80::1%eth0) is a local interface name, never part of identity.
  const bare = raw.split("%")[0];
  if (net.isIPv4(bare)) {
    return bare;
  }
  if (net.isIPv6(bare)) {
    const hextets = ipv6Hextets(bare);
    if (!hextets) {
      return "unknown";
    }
    // IPv4-mapped (::ffff:a.b.c.d) is an IPv4 client on a v6 socket. Its /64 is
    // all-zero, so truncating would herd every such client into one bucket.
    if (hextets[5] === "ffff" && hextets.slice(0, 5).every((h) => h === "0")) {
      const hi = parseInt(hextets[6], 16);
      const lo = parseInt(hextets[7], 16);
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
    return `${hextets.slice(0, 4).join(":")}::/64`;
  }
  // Unparseable or missing: share one bucket rather than give each unknown its
  // own, which would be a free bucket for anything that makes req.ip unreadable.
  return "unknown";
}

// The /48 an IPv6 /64 key belongs to, or "" for IPv4 and "unknown". One site or
// cloud tenant commonly holds a /48, i.e. 65536 /64 buckets.
function ipv6PrefixKey(key) {
  const match = /^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):[0-9a-f]+::\/64$/.exec(key);
  return match ? `${match[1]}::/48` : "";
}

export function createSpendGuard({
  caps = {},
  statePath = null,
  spendLogPath = null,
  usdPerImage = 0.0165,
  usdPerQuery = 0.001,
  persistDelayMs = 2000,
  // The per-IP Map grows with distinct clients over a day; cap it so a rotating-IP
  // flood cannot leak memory. Past the cap, newcomers are charged to the global
  // counter only, which still bounds the money.
  ipTrackingMax = 10_000,
  // Each IPv6 /48 may spend this many per-IP caps a day across all its /64s.
  // Without it, ~38 /64s from one /48 drain the whole GenAI day. 0 = off.
  ipv6PrefixFactor = 4,
  now = () => Date.now(),
  enabled = null,
  onWarn = () => {}
} = {}) {
  const limits = {
    genai: {
      global: normalizeCap(caps.genaiDaily),
      ip: normalizeCap(caps.genaiDailyPerIp)
    },
    search: {
      global: normalizeCap(caps.searchDaily),
      ip: normalizeCap(caps.searchDailyPerIp)
    }
  };
  const prefixFactor = Math.max(0, Math.floor(Number(ipv6PrefixFactor) || 0));
  const anyCap = SCOPES.some((scope) => limits[scope].global > 0 || limits[scope].ip > 0);
  const active = enabled === null ? anyCap : Boolean(enabled);

  let state = emptyState(utcDayKey(now()));
  let persistTimer = null;
  let dirty = false;

  if (active && statePath) {
    const loaded = readState(statePath, onWarn);
    if (loaded.ok) {
      if (loaded.state) {
        state = loaded.state;
      }
      // else: no primary file, a legitimate first run; keep the clean default.
    } else {
      // Primary and .prev are both unreadable. Starting at zero would fail open and
      // hand back up to a day of spend per crash-corrupt cycle, so fail closed:
      // refuse every reservation today and roll over at the next UTC midnight.
      onWarn(
        `Spend state at ${statePath} and its .prev generation are both unusable. ` +
        "Failing CLOSED for the rest of today: every genai/search reservation " +
        "will be refused until UTC midnight. To reset deliberately, stop the " +
        `server and delete ${statePath} (and ${statePath}.prev).`
      );
      state = exhaustedState(utcDayKey(now()));
    }
  }

  function ensureDay() {
    const day = utcDayKey(now());
    if (day === state.day) {
      return;
    }
    // The day changed under a running process: bank the old day's line, then
    // start clean. This is the only place a rollover summary is written.
    appendSummaryLine(state);
    state = emptyState(day);
    dirty = true;
    persistNow();
  }

  function bucketFor(scope) {
    if (!state.scopes[scope]) {
      state.scopes[scope] = { total: 0, ips: new Map(), prefixes: new Map() };
    }
    return state.scopes[scope];
  }

  function reserve(scope, { key = "", amount = 1 } = {}) {
    const units = Math.max(0, Math.floor(Number(amount) || 0));
    if (!active || units === 0 || !SCOPES.includes(scope)) {
      return { ok: true, scope, amount: 0, key: "", day: "" };
    }
    ensureDay();
    if (state.corrupt) {
      // Fail-closed day (see readState): refuse rather than trust unrecovered counters.
      return { ok: false, reason: "corrupt-state", scope, amount: 0, key: "", day: state.day };
    }
    const bucket = bucketFor(scope);
    const limit = limits[scope];

    if (limit.global > 0 && bucket.total + units > limit.global) {
      return { ok: false, reason: "daily", scope, amount: 0, key: "", day: state.day };
    }

    const ipKey = String(key || "").trim();
    const tracked = Boolean(ipKey) && (bucket.ips.has(ipKey) || bucket.ips.size < ipTrackingMax);
    if (limit.ip > 0 && tracked) {
      const used = bucket.ips.get(ipKey) || 0;
      if (used + units > limit.ip) {
        return { ok: false, reason: "ip", scope, amount: 0, key: ipKey, day: state.day };
      }
    }
    const prefixLimit = limit.ip * prefixFactor;
    const prefixCandidate = prefixLimit > 0 ? ipv6PrefixKey(ipKey) : "";
    const prefixKey = prefixCandidate && (bucket.prefixes.has(prefixCandidate) || bucket.prefixes.size < ipTrackingMax)
      ? prefixCandidate
      : "";
    if (prefixKey && (bucket.prefixes.get(prefixKey) || 0) + units > prefixLimit) {
      // Same scope as the per-IP refusal: to the visitor it is their network's limit.
      return { ok: false, reason: "ip", scope, amount: 0, key: ipKey, day: state.day };
    }

    bucket.total += units;
    if (tracked) {
      bucket.ips.set(ipKey, (bucket.ips.get(ipKey) || 0) + units);
    }
    if (prefixKey) {
      bucket.prefixes.set(prefixKey, (bucket.prefixes.get(prefixKey) || 0) + units);
    }
    dirty = true;
    schedulePersist();
    // The day is part of the receipt: a reservation taken at 23:59 must not be
    // refunded out of tomorrow's budget.
    return { ok: true, scope, amount: units, key: tracked ? ipKey : "", prefixKey, day: state.day };
  }

  // Give back what the provider never delivered. `amount` defaults to the whole
  // reservation; pass a smaller number to keep the delivered part charged.
  function release(reservation, amount = null) {
    if (!active || !reservation || reservation.ok !== true || !reservation.amount) {
      return;
    }
    const units = amount === null
      ? reservation.amount
      : Math.max(0, Math.min(reservation.amount, Math.floor(Number(amount) || 0)));
    if (units === 0) {
      return;
    }
    // Rolled over while in flight. Yesterday's counter is already banked; refunding
    // into today would hand back budget never spent today. The dropped refund is
    // bounded by the requests in flight across midnight.
    if (reservation.day && reservation.day !== state.day) {
      return;
    }
    const bucket = bucketFor(reservation.scope);
    bucket.total = Math.max(0, bucket.total - units);
    for (const [map, key] of [[bucket.ips, reservation.key], [bucket.prefixes, reservation.prefixKey]]) {
      if (key && map.has(key)) {
        const next = Math.max(0, (map.get(key) || 0) - units);
        if (next === 0) {
          map.delete(key);
        } else {
          map.set(key, next);
        }
      }
    }
    dirty = true;
    schedulePersist();
  }

  function snapshot() {
    return {
      active,
      day: state.day,
      limits: {
        genai: { ...limits.genai },
        search: { ...limits.search }
      },
      genai: {
        total: state.scopes.genai?.total || 0,
        clients: state.scopes.genai?.ips.size || 0
      },
      search: {
        total: state.scopes.search?.total || 0,
        clients: state.scopes.search?.ips.size || 0
      },
      estimatedUsd: estimateUsd(state)
    };
  }

  function estimateUsd(target) {
    const images = target.scopes.genai?.total || 0;
    const queries = target.scopes.search?.total || 0;
    return Math.round((images * usdPerImage + queries * usdPerQuery) * 10000) / 10000;
  }

  function summaryLine(target) {
    return JSON.stringify({
      date: target.day,
      genaiImages: target.scopes.genai?.total || 0,
      searchQueries: target.scopes.search?.total || 0,
      estimatedUsd: estimateUsd(target)
    });
  }

  function appendSummaryLine(target) {
    if (!active || !spendLogPath) {
      return;
    }
    const line = `${summaryLine(target)}\n`;
    try {
      fs.mkdirSync(path.dirname(spendLogPath), { recursive: true });
      fs.appendFileSync(spendLogPath, line);
    } catch (err) {
      onWarn(`Could not write spend log: ${err.message}`);
    }
  }

  function schedulePersist() {
    if (!active || !statePath || persistTimer) {
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, persistDelayMs);
    persistTimer.unref?.();
  }

  function persistNow() {
    if (!active || !statePath || !dirty) {
      return;
    }
    // Atomic write: temp file next to the target (same filesystem), fsync, then
    // rename() over it, so a crash leaves the old file or the new one, never a
    // truncated read. Before the rename the live primary is kept as a single
    // `.prev` generation (overwritten, not accumulated).
    const tmpPath = `${statePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const payload = `${JSON.stringify(serializeState(state), null, 2)}\n`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.copyFileSync(statePath, `${statePath}.prev`);
      } catch (err) {
        if (err.code !== "ENOENT") {
          onWarn(`Could not preserve previous spend state generation: ${err.message}`);
        }
      }
      fs.renameSync(tmpPath, statePath);
      dirty = false;
    } catch (err) {
      onWarn(`Could not write spend state: ${err.message}`);
    }
  }

  // Called on shutdown: bank the running day's line and persist the counters, so
  // a restart cannot refill the budget.
  function shutdown() {
    if (!active) {
      return;
    }
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    appendSummaryLine(state);
    dirty = true;
    persistNow();
  }

  return { active, reserve, release, snapshot, summaryLine: () => summaryLine(state), flush: persistNow, shutdown };
}

function normalizeCap(raw) {
  const value = Math.floor(Number(raw) || 0);
  return value > 0 ? value : 0;
}

function emptyState(day) {
  return {
    day,
    corrupt: false,
    scopes: {
      genai: { total: 0, ips: new Map(), prefixes: new Map() },
      search: { total: 0, ips: new Map(), prefixes: new Map() }
    }
  };
}

// A state that refuses every reservation for `day` without pretending the budget
// is unspent (contrast emptyState). Only reached when readState() cannot recover
// either generation.
function exhaustedState(day) {
  const state = emptyState(day);
  state.corrupt = true;
  return state;
}

function serializeState(state) {
  const scopes = {};
  for (const scope of SCOPES) {
    const bucket = state.scopes[scope] || { total: 0, ips: new Map(), prefixes: new Map() };
    scopes[scope] = {
      total: bucket.total,
      ips: Object.fromEntries(bucket.ips),
      prefixes: Object.fromEntries(bucket.prefixes || [])
    };
  }
  // `corrupt` round-trips deliberately: if this state is persisted (e.g. on
  // shutdown), a same-day restart must stay fail-closed.
  return { day: state.day, corrupt: Boolean(state.corrupt), scopes };
}

// A missing primary file is a first boot: `{ ok: true, state: null }`, no
// warning. A primary that exists but cannot be read or parsed falls back to the
// `.prev` generation (see persistNow); only when that is unusable too does this
// return `{ ok: false }`, telling the caller to fail closed for the day.
function readState(statePath, onWarn) {
  const primary = tryReadStateFile(statePath);
  if (primary.status === "missing") {
    return { ok: true, state: null };
  }
  if (primary.status === "ok") {
    return { ok: true, state: primary.state };
  }

  onWarn(`Ignoring invalid spend state at ${statePath} (${primary.reason}); trying the previous generation`);
  const prev = tryReadStateFile(`${statePath}.prev`);
  if (prev.status === "ok") {
    onWarn(`Recovered spend state from ${statePath}.prev`);
    return { ok: true, state: prev.state };
  }
  return { ok: false };
}

// Reads and validates one state file. Never throws; every failure comes back as
// a status string.
function tryReadStateFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return err.code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", reason: err.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.day !== "string") {
      throw new Error("unexpected shape");
    }
    const state = emptyState(parsed.day);
    state.corrupt = parsed.corrupt === true;
    for (const scope of SCOPES) {
      const bucket = parsed.scopes?.[scope];
      if (!bucket || typeof bucket !== "object") {
        continue;
      }
      state.scopes[scope].total = Math.max(0, Math.floor(Number(bucket.total) || 0));
      for (const field of ["ips", "prefixes"]) {
        for (const [key, value] of Object.entries(bucket[field] || {})) {
          const count = Math.max(0, Math.floor(Number(value) || 0));
          if (count > 0) {
            state.scopes[scope][field].set(key, count);
          }
        }
      }
    }
    return { status: "ok", state };
  } catch (err) {
    return { status: "invalid", reason: err.message };
  }
}

// Cheap presence check for the operator kill switch, cached so a hot path is
// not one stat() per request. `touch <path>` disables the paid endpoints within
// `cacheMs`; removing the file re-enables them. No restart either way.
export function createKillSwitch({ filePath = "", cacheMs = 5000, now = () => Date.now() } = {}) {
  let cachedAt = -Infinity;
  let cached = false;
  return {
    isEngaged() {
      if (!filePath) {
        return false;
      }
      const ts = now();
      if (ts - cachedAt < cacheMs) {
        return cached;
      }
      cachedAt = ts;
      cached = fs.existsSync(filePath);
      return cached;
    }
  };
}
