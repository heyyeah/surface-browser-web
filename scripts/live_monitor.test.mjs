// Unit tests for /admin/live's bookkeeping (server/live-monitor.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLiveMonitor,
  describeEvent,
  deviceFromUserAgent,
  parseReferrer,
  parseSessionId
} from "../server/live-monitor.js";

const MINUTE = 60 * 1000;
const NOON = Date.UTC(2026, 9, 3, 12);

function clocked(start = NOON) {
  const clock = { t: start };
  return { clock, now: () => clock.t };
}

test("a visitor is counted once, with the country and device from their first request", () => {
  const { now } = clocked();
  const monitor = createLiveMonitor({ now });
  let lookups = 0;
  const describe = () => {
    lookups += 1;
    return { country: "CH", device: "Quest 3" };
  };
  monitor.touch("visitor-1", describe);
  monitor.touch("visitor-1", describe);
  monitor.touch("", describe);
  const snap = monitor.snapshot();
  assert.equal(lookups, 1, "the country is looked up once per visitor");
  assert.equal(snap.today.visits, 1);
  assert.deepEqual(snap.today.countries, { CH: 1 });
  assert.deepEqual(snap.today.devices, { "Quest 3": 1 });
  assert.equal(snap.sessions[0].requests, 2);
  assert.equal(snap.sessions[0].device, "Quest 3");
});

test("events land on the visitor's trail, newest first", () => {
  const { clock, now } = clocked();
  const monitor = createLiveMonitor({ now });
  monitor.touch("v");
  monitor.addEvent("v", { kind: "page", text: "https://a.test/" });
  clock.t += 1000;
  monitor.addEvent("v", { kind: "ai", text: "otters" });
  monitor.addEvent("unknown", { kind: "ai", text: "ignored" });
  const [session] = monitor.snapshot().sessions;
  assert.deepEqual(session.events.map((event) => event.text), ["otters", "https://a.test/"]);
});

test("one address can start only so many visitors an hour", () => {
  const { clock, now } = clocked();
  const monitor = createLiveMonitor({ now, newSessionsPerClientPerHour: 2 });
  assert.ok(monitor.touch("v1-abcdef", undefined, "1.2.3.4"));
  assert.ok(monitor.touch("v2-abcdef", undefined, "1.2.3.4"));
  assert.equal(monitor.touch("v3-abcdef", undefined, "1.2.3.4"), null);
  assert.ok(monitor.touch("v1-abcdef", undefined, "1.2.3.4"), "a known visitor is never refused");
  assert.ok(monitor.touch("v4-abcdef", undefined, "5.6.7.8"));
  assert.equal(monitor.snapshot().today.visits, 3);
  clock.t += 60 * MINUTE;
  assert.ok(monitor.touch("v5-abcdef", undefined, "1.2.3.4"));
});

test("trail text is clipped, so long URLs cannot pad memory", () => {
  const { now } = clocked();
  const monitor = createLiveMonitor({ now });
  monitor.touch("v");
  monitor.addEvent("v", { kind: "page", text: `https://a.test/?q=${"x".repeat(20_000)}` });
  assert.ok(monitor.snapshot().sessions[0].events[0].text.length <= 301);
});

test("a visitor goes idle after 5 minutes and is forgotten after 30", () => {
  const { clock, now } = clocked();
  const monitor = createLiveMonitor({ now });
  monitor.touch("v");
  clock.t += 6 * MINUTE;
  assert.equal(monitor.snapshot().activeCount, 0);
  assert.equal(monitor.snapshot().sessions.length, 1);
  clock.t += 25 * MINUTE;
  assert.equal(monitor.snapshot().sessions.length, 0);
  assert.equal(monitor.snapshot().today.visits, 1, "forgetting a visitor does not uncount them");
});

test("counts are per UTC day and the total sums every day", () => {
  const { clock, now } = clocked(Date.UTC(2026, 9, 3, 23, 59));
  const monitor = createLiveMonitor({ now });
  monitor.count("pages", 3);
  monitor.setToday("aiImagesMade", 5);
  monitor.setToday("aiImagesMade", 7);
  clock.t += 2 * MINUTE;
  monitor.count("pages");
  const snap = monitor.snapshot();
  assert.equal(snap.day, "2026-10-04");
  assert.equal(snap.today.pages, 1);
  assert.equal(snap.total.pages, 4);
  assert.equal(snap.total.aiImagesMade, 7, "setToday overwrites rather than adds");
  assert.equal(snap.firstDay, "2026-10-03");
});

test("paid images come from the spend guard only when it is stamped with today", () => {
  // The snapshot is only trusted when stamped with today: a guard untouched for
  // days still reports its old total (39), which must not land on today.
  const { now } = clocked();
  const monitor = createLiveMonitor({ now });
  monitor.syncPaidImages({ day: "2026-09-26", total: 39 });
  assert.equal(monitor.snapshot().today.aiImagesMade, 0);
  monitor.syncPaidImages({ day: "2026-10-03", total: 4 });
  assert.equal(monitor.snapshot().today.aiImagesMade, 4);
});

test("counts survive a restart; visitors do not", () => {
  const statsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-live-")), "live-stats.json");
  const { now } = clocked();
  const first = createLiveMonitor({ statsPath, now });
  first.touch("v", () => ({ country: "DE", device: "Pico" }));
  first.count("searches", 2);
  first.flush();
  const saved = fs.readFileSync(statsPath, "utf8");
  assert.doesNotMatch(saved, /"v"/, "no visitor id on disk");

  const second = createLiveMonitor({ statsPath, now });
  const snap = second.snapshot();
  assert.equal(snap.today.searches, 2);
  assert.deepEqual(snap.today.countries, { DE: 1 });
  assert.deepEqual(snap.total.devices, { Pico: 1 });
  assert.equal(snap.sessions.length, 0);
});

test("days saved before devices were counted still load and count", () => {
  const statsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-live-")), "live-stats.json");
  const { now } = clocked();
  const day = new Date(now()).toISOString().slice(0, 10);
  fs.writeFileSync(statsPath, JSON.stringify({ version: 1, days: { [day]: { visits: 3, countries: { CH: 3 } } } }));
  const monitor = createLiveMonitor({ statsPath, now });
  monitor.touch("v", () => ({ country: "CH", device: "Quest 2" }));
  const snap = monitor.snapshot();
  assert.equal(snap.today.visits, 4);
  assert.deepEqual(snap.today.devices, { "Quest 2": 1 });
  assert.deepEqual(snap.total.devices, { "Quest 2": 1 });
});

test("an unreadable stats file starts from zero and is left for inspection", () => {
  const statsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-live-")), "live-stats.json");
  fs.writeFileSync(statsPath, "{ not json");
  const warnings = [];
  const monitor = createLiveMonitor({ statsPath, onWarn: (message) => warnings.push(message) });
  assert.equal(monitor.snapshot().total.pages, 0);
  assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(statsPath, "utf8"), "{ not json");
});

test("session ids: the client's UUID passes, anything odd is dropped", () => {
  assert.equal(parseSessionId("3f1c2a9e-1111-4a2b-9c3d-aaaaaaaaaaaa"), "3f1c2a9e-1111-4a2b-9c3d-aaaaaaaaaaaa");
  assert.equal(parseSessionId("genai_1791006527_abc123"), "genai_1791006527_abc123");
  for (const bad of ["", "abc", "<script>", "x".repeat(65), undefined]) {
    assert.equal(parseSessionId(bad), "");
  }
});

test("devices are coarse: headset, phone or desktop", () => {
  assert.equal(deviceFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/38.0"), "Quest 3");
  assert.equal(deviceFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; Quest 3S) OculusBrowser/38.0"), "Quest 3S");
  assert.equal(deviceFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; Quest Pro) OculusBrowser/38.0"), "Quest Pro");
  assert.equal(deviceFromUserAgent("Mozilla/5.0 (Linux; Android 10; Pico 4) PicoBrowser"), "Pico");
  assert.equal(deviceFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile"), "phone");
  assert.equal(deviceFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "desktop");
});

test("trail lines: pages, searches and prompts; async completions are not shown twice", () => {
  assert.deepEqual(describeEvent("extract.cached", { url: "https://a.test/", items: 9 }),
    { kind: "page", text: "https://a.test/", note: "9 images, cached" });
  assert.equal(describeEvent("imageSearch.complete", { query: "otters", items: 15 }).kind, "search");
  assert.equal(describeEvent("genai.accepted", { prompt: "otters", mode: "generate", async: true }).text, "otters");
  assert.equal(describeEvent("genai.complete", { prompt: "otters", async: true }), null);
  assert.equal(describeEvent("genai.pooled", { prompt: "otters", mode: "vary" }).kind, "vary");
  assert.equal(describeEvent("genai.failed", { prompt: "otters" }).failed, true);
  assert.equal(describeEvent("pool.grown", {}), null);
});

// --- wiring, asserted against the source

const serverSource = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

test("the admin page and its data are localhost-only", () => {
  assert.match(serverSource, /app\.get\("\/admin\/live", localOnlyGate,/);
  assert.match(serverSource, /app\.get\("\/admin\/live\.json", localOnlyGate,/);
  assert.match(serverSource, /function localOnlyGate\(req, res, next\) \{\s*if \(!isLocalRequest\(req\)\) \{\s*res\.status\(404\)/);
});

test("the monitor sees requests the rate limiter refuses", () => {
  const monitor = serverSource.indexOf('app.use("/api", liveMonitorMiddleware)');
  const limiter = serverSource.indexOf("rateLimitRequests);");
  assert.ok(monitor > 0 && monitor < limiter);
});

test("referrers are counted per visitor, host only", () => {
  const { now } = clocked();
  const monitor = createLiveMonitor({ now });
  monitor.touch("visitor-1", () => ({ referrer: parseReferrer("www.swurf.org") }));
  monitor.touch("visitor-2", () => ({ referrer: parseReferrer("") }));
  monitor.touch("visitor-3", () => ({ referrer: parseReferrer("<script>") }));
  assert.deepEqual(monitor.snapshot().today.referrers, { "swurf.org": 1, direct: 2 });
});

test("the query log keeps events for its retention and drops older ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-queries-"));
  try {
    const { clock, now } = clocked();
    const queryLogPath = path.join(dir, "queries.jsonl");
    const monitor = createLiveMonitor({ now, queryLogPath, queryLogDays: 3 });
    monitor.touch("visitor-1", () => ({ country: "DE", device: "phone", referrer: "swurf.org" }));
    monitor.addEvent("visitor-1", { kind: "ai", text: "otters", bookmark: true });
    clock.t += 4 * 24 * 60 * MINUTE;
    monitor.touch("visitor-1");
    monitor.addEvent("visitor-1", { kind: "page", text: "https://example.com/" });

    const items = monitor.queries(0);
    assert.equal(items.length, 1, "the 4-day-old prompt is pruned");
    assert.equal(items[0].text, "https://example.com/");
    assert.deepEqual([items[0].country, items[0].device, items[0].referrer, items[0].visitor], ["DE", "phone", "swurf.org", "visito"]);
    assert.equal(createLiveMonitor({ now }).queries(0), null, "off without a path");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
