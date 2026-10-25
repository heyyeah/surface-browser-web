// What /admin/live shows: who is using the piece right now, what each visitor
// asked for, and daily counts.
//
// A visitor is the random id the client makes per page load (x-session-id), so
// a reload is a new visitor. No address is kept: the caller passes a country
// code, and sessions live only in memory, gone SESSION_FORGET_MS after their
// last request. The per-day counts on disk hold numbers, country codes, device
// kinds and referring sites. With a query log path set, each visitor event
// (page, search, prompt) is also kept for `queryLogDays`, with the visitor's
// country and device but no address.

import fs from "node:fs";
import path from "node:path";

const SESSION_ACTIVE_MS = 5 * 60 * 1000;
const SESSION_FORGET_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_EVENTS_PER_SESSION = 60;
const SESSION_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_TEXT = 300;
const MAX_REFERRER = 100;
const QUERY_LOG_PRUNE_MS = 60 * 60 * 1000;
// New visitors one address may start per hour. Ids are the client's to invent,
// so without this one script could inflate the counts and push real visitors
// out of MAX_SESSIONS. A venue sharing one IP may need it raised.
const NEW_SESSIONS_PER_CLIENT_PER_HOUR = 30;

export const COUNTER_NAMES = Object.freeze([
  "visits",
  "pages",
  "searches",
  "aiRequests",
  "aiImagesMade",
  "aiImagesShown",
  "imagesShown",
  "imageCacheHits"
]);

export function parseSessionId(raw) {
  const value = String(raw || "");
  return SESSION_ID.test(value) ? value : "";
}

// Coarse on purpose: enough to tell a headset from a laptop.
export function deviceFromUserAgent(userAgent) {
  const ua = String(userAgent || "");
  if (/OculusBrowser|Quest/i.test(ua)) {
    return /Quest 3S/i.test(ua) ? "Quest 3S" : /Quest 3/i.test(ua) ? "Quest 3" : /Quest 2/i.test(ua) ? "Quest 2" : /Quest Pro/i.test(ua) ? "Quest Pro" : "Quest";
  }
  if (/Pico/i.test(ua)) {
    return "Pico";
  }
  if (/VisionOS|Apple Vision/i.test(ua)) {
    return "Vision Pro";
  }
  if (/iPad|Tablet/i.test(ua)) {
    return "tablet";
  }
  if (/Mobi|iPhone|Android/i.test(ua)) {
    return "phone";
  }
  return "desktop";
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyDay() {
  return { ...Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0])), countries: {}, devices: {}, referrers: {} };
}

// The client sends document.referrer's host, and only when it is another site.
export function parseReferrer(raw) {
  const host = String(raw || "").trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9.-]{1,100}$/.test(host) && host.includes(".") ? host.slice(0, MAX_REFERRER) : "";
}

export function createLiveMonitor({
  statsPath = "",
  queryLogPath = "",
  queryLogDays = 0,
  now = Date.now,
  onWarn = console.warn,
  newSessionsPerClientPerHour = NEW_SESSIONS_PER_CLIENT_PER_HOUR
} = {}) {
  const sessions = new Map();
  const newSessionsByClient = new Map();
  const days = loadDays();
  let persistTimer = null;

  function loadDays() {
    if (!statsPath) {
      return {};
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(statsPath, "utf8"));
      return parsed?.days && typeof parsed.days === "object" ? parsed.days : {};
    } catch (err) {
      if (err.code !== "ENOENT") {
        // Not overwritten until the next count, so a bad file can be inspected.
        onWarn(`Live stats ${statsPath} unreadable, starting from zero: ${err.message}`);
      }
      return {};
    }
  }

  function today() {
    const key = utcDay(now());
    days[key] ??= emptyDay();
    return days[key];
  }

  function schedulePersist() {
    if (!statsPath || persistTimer) {
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flush();
    }, 10_000);
    persistTimer.unref?.();
  }

  function flush() {
    if (!statsPath) {
      return;
    }
    const tmp = `${statsPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(statsPath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, days })}\n`);
      fs.renameSync(tmp, statsPath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      onWarn(`Could not write live stats: ${err.message}`);
    }
  }

  function count(name, amount = 1) {
    today()[name] += amount;
    schedulePersist();
  }

  // The spend guard owns today's paid-image count. Its state only rolls over to
  // a new day on the next reservation, so a quiet morning still reports
  // yesterday's total: anything not stamped with today counts as zero.
  function syncPaidImages({ day, total }) {
    setToday("aiImagesMade", day === utcDay(now()) ? total : 0);
  }

  // Overwrites rather than adds.
  function setToday(name, value) {
    const day = today();
    if (day[name] !== value) {
      day[name] = value;
      schedulePersist();
    }
  }

  // Days saved before devices were counted have no `devices` map.
  function tally(day, table, key, amount = 1) {
    day[table] ??= {};
    day[table][key] = (day[table][key] || 0) + amount;
  }

  function forgetIdle() {
    const cutoff = now() - SESSION_FORGET_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
      }
    }
    while (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  }

  function allowNewSession(client) {
    const hour = Math.floor(now() / 3_600_000);
    const entry = newSessionsByClient.get(client);
    if (!entry || entry.hour !== hour) {
      if (newSessionsByClient.size > 10_000) {
        newSessionsByClient.clear();
      }
      newSessionsByClient.set(client, { hour, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= newSessionsPerClientPerHour;
  }

  // Called once per API request that carries a session id. `describeNew` runs
  // only for a visitor not seen before, so the country lookup is once each.
  // Returns the session, or null when it is not being tracked.
  function touch(id, describeNew = () => ({}), client = "") {
    if (!id) {
      return null;
    }
    let session = sessions.get(id);
    if (!session) {
      if (!allowNewSession(client)) {
        return null;
      }
      const { country = "", device = "", referrer = "" } = describeNew();
      session = { id, firstSeen: now(), lastSeen: now(), country, device, referrer, requests: 0, events: [] };
      count("visits");
      const day = today();
      tally(day, "countries", country || "??");
      tally(day, "devices", device || "unknown");
      tally(day, "referrers", referrer || "direct");
    } else {
      sessions.delete(id);
    }
    session.lastSeen = now();
    session.requests += 1;
    sessions.set(id, session);
    forgetIdle();
    return session;
  }

  function addEvent(id, event) {
    const session = id ? sessions.get(id) : null;
    if (!session) {
      return;
    }
    const text = String(event.text ?? "");
    const entry = { at: now(), ...event, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text };
    session.events.push(entry);
    if (session.events.length > MAX_EVENTS_PER_SESSION) {
      session.events.shift();
    }
    logQuery({ ...entry, visitor: session.id.slice(0, 6), country: session.country, device: session.device, referrer: session.referrer });
  }

  let lastPrune = 0;
  function logQuery(entry) {
    if (!queryLogPath || !(queryLogDays > 0)) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(queryLogPath), { recursive: true });
      fs.appendFileSync(queryLogPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      onWarn(`Could not write query log: ${err.message}`);
    }
    if (now() - lastPrune > QUERY_LOG_PRUNE_MS) {
      pruneQueries();
    }
  }

  function readQueries() {
    try {
      return fs.readFileSync(queryLogPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  // Rewrites the file without entries past the retention, at most hourly.
  function pruneQueries() {
    lastPrune = now();
    const cutoff = now() - queryLogDays * 86_400_000;
    const all = readQueries();
    const kept = all.filter((entry) => entry.at >= cutoff);
    if (kept.length === all.length) {
      return;
    }
    const tmp = `${queryLogPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      fs.renameSync(tmp, queryLogPath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      onWarn(`Could not prune query log: ${err.message}`);
    }
  }

  // Newest first.
  function queries(sinceMs, limit = 2000) {
    if (!queryLogPath || !(queryLogDays > 0)) {
      return null;
    }
    return readQueries().filter((entry) => entry.at >= sinceMs).reverse().slice(0, limit);
  }

  function totals() {
    const sum = emptyDay();
    for (const day of Object.values(days)) {
      for (const name of COUNTER_NAMES) {
        sum[name] += Number(day[name]) || 0;
      }
      for (const table of ["countries", "devices", "referrers"]) {
        for (const [key, visits] of Object.entries(day[table] || {})) {
          tally(sum, table, key, visits);
        }
      }
    }
    return sum;
  }

  function snapshot() {
    forgetIdle();
    const at = now();
    const list = [...sessions.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((session) => ({
        ...session,
        active: at - session.lastSeen < SESSION_ACTIVE_MS,
        events: [...session.events].reverse()
      }));
    return {
      now: at,
      day: utcDay(at),
      activeCount: list.filter((session) => session.active).length,
      sessions: list,
      today: today(),
      total: totals(),
      firstDay: Object.keys(days).sort()[0] || utcDay(at)
    };
  }

  return { touch, addEvent, count, setToday, syncPaidImages, snapshot, flush, queries, queryLogDays };
}

// Turns a query-log event into one line of a visitor's trail, or null for the
// events that would only be noise there.
export function describeEvent(type, details = {}) {
  switch (type) {
    case "extract.complete":
      return { kind: "page", text: details.url, note: `${details.items} images` };
    case "extract.cached":
      return { kind: "page", text: details.url, note: `${details.items} images, cached` };
    case "extract.failed":
    case "extract.blocked":
      return { kind: "page", text: details.url, note: type === "extract.blocked" ? "blocked by site" : "failed", failed: true };
    case "imageSearch.complete":
      return { kind: "search", text: details.query, note: `${details.items} images` };
    case "imageSearch.cached":
      return { kind: "search", text: details.query, note: `${details.items} images, cached` };
    case "imageSearch.failed":
    case "imageSearch.budget":
      return { kind: "search", text: details.query, note: type === "imageSearch.budget" ? "over budget" : "failed", failed: true };
    case "genai.accepted":
    case "genai.complete":
    case "genai.cached":
    case "genai.pooled":
      if (type === "genai.complete" && details.async) {
        // The async route already showed this request when it was accepted.
        return null;
      }
      return {
        kind: details.mode === "vary" ? "vary" : "ai",
        text: details.prompt,
        note: type === "genai.cached" ? "cached" : type === "genai.pooled" ? "from pool" : "",
        ...(details.bookmark ? { bookmark: true } : {})
      };
    case "genai.failed":
    case "genai.budget":
      return { kind: details.mode === "vary" ? "vary" : "ai", text: details.prompt, note: type === "genai.budget" ? "over budget" : "failed", failed: true };
    default:
      return null;
  }
}
