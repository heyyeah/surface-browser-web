// Pure tests for server/spend-guard.js — no HTTP, injected clock and paths.
//
// The behaviours that matter to the budget: caps of 0 are inert, the counted
// unit is images/queries (not requests), per-IP and global caps are separate
// refusals, a reservation can be handed back in part, the day rolls at UTC
// midnight, and a restart does not refill the budget.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSpendGuard, createKillSwitch, spendClientKey, utcDayKey } from "../server/spend-guard.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-spend-"));
}

function fixedClock(startMs) {
  let ms = startMs;
  return {
    now: () => ms,
    advance(delta) {
      ms += delta;
    },
    set(value) {
      ms = value;
    }
  };
}

const DAY_START = Date.parse("2026-08-28T10:00:00.000Z");

test("caps of 0 leave the guard inert: no counting, no state file", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  try {
    const guard = createSpendGuard({ caps: {}, statePath });
    assert.equal(guard.active, false);
    for (let i = 0; i < 50; i += 1) {
      assert.equal(guard.reserve("genai", { key: "1.2.3.4", amount: 15 }).ok, true);
    }
    guard.shutdown();
    assert.equal(fs.existsSync(statePath), false, "inert guard writes nothing");
    assert.equal(guard.snapshot().genai.total, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the global cap counts images, not requests", () => {
  const guard = createSpendGuard({ caps: { genaiDaily: 10 } });
  // One request asking for 15 cannot slip past a cap of 10.
  const refused = guard.reserve("genai", { key: "a", amount: 15 });
  assert.deepEqual(
    { ok: refused.ok, reason: refused.reason, scope: refused.scope, amount: refused.amount, key: refused.key },
    { ok: false, reason: "daily", scope: "genai", amount: 0, key: "" }
  );
  assert.equal(guard.reserve("genai", { key: "a", amount: 6 }).ok, true);
  assert.equal(guard.reserve("genai", { key: "b", amount: 4 }).ok, true);
  assert.equal(guard.snapshot().genai.total, 10);
  // Exactly at the cap, the next unit from anyone is refused.
  assert.equal(guard.reserve("genai", { key: "c", amount: 1 }).reason, "daily");
});

test("per-IP and global caps refuse with different scopes", () => {
  const guard = createSpendGuard({ caps: { genaiDaily: 100, genaiDailyPerIp: 4 } });
  assert.equal(guard.reserve("genai", { key: "1.1.1.1", amount: 4 }).ok, true);
  const refused = guard.reserve("genai", { key: "1.1.1.1", amount: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "ip", "one greedy client is capped before the day is");
  // A different client is unaffected.
  assert.equal(guard.reserve("genai", { key: "2.2.2.2", amount: 4 }).ok, true);
  assert.equal(guard.snapshot().genai.total, 8);
});

test("scopes are independent budgets", () => {
  const guard = createSpendGuard({ caps: { genaiDaily: 1, searchDaily: 3 } });
  assert.equal(guard.reserve("genai", { key: "a", amount: 1 }).ok, true);
  assert.equal(guard.reserve("genai", { key: "a", amount: 1 }).ok, false);
  assert.equal(guard.reserve("search", { key: "a", amount: 1 }).ok, true);
  assert.equal(guard.reserve("search", { key: "a", amount: 1 }).ok, true);
  assert.equal(guard.snapshot().search.total, 2);
});

test("release hands back the whole reservation or only the undelivered part", () => {
  const guard = createSpendGuard({ caps: { genaiDaily: 10, genaiDailyPerIp: 10 } });
  const failed = guard.reserve("genai", { key: "1.1.1.1", amount: 4 });
  guard.release(failed);
  assert.equal(guard.snapshot().genai.total, 0, "a provider failure costs nothing");

  const partial = guard.reserve("genai", { key: "1.1.1.1", amount: 4 });
  guard.release(partial, 1); // delivered 3 of 4
  assert.equal(guard.snapshot().genai.total, 3, "delivered images stay charged");

  // Over-releasing cannot mint credit.
  const another = guard.reserve("genai", { key: "1.1.1.1", amount: 2 });
  guard.release(another, 99);
  assert.equal(guard.snapshot().genai.total, 3);
  // And a refused reservation is not releasable.
  guard.release({ ok: false, scope: "genai", amount: 4, key: "1.1.1.1" });
  assert.equal(guard.snapshot().genai.total, 3);
});

test("counters reset at UTC midnight and bank a spend line for the closed day", () => {
  const dir = tempDir();
  const spendLogPath = path.join(dir, "spend.log");
  const clock = fixedClock(DAY_START);
  try {
    const guard = createSpendGuard({
      caps: { genaiDaily: 100, searchDaily: 100 },
      spendLogPath,
      usdPerImage: 0.01,
      usdPerQuery: 0.001,
      now: clock.now
    });
    guard.reserve("genai", { key: "a", amount: 5 });
    guard.reserve("search", { key: "a", amount: 2 });
    assert.equal(guard.snapshot().day, "2026-08-28");

    clock.set(Date.parse("2026-08-29T00:00:01.000Z"));
    assert.equal(guard.reserve("genai", { key: "a", amount: 1 }).ok, true);
    const snapshot = guard.snapshot();
    assert.equal(snapshot.day, "2026-08-29");
    assert.equal(snapshot.genai.total, 1, "yesterday's images do not count against today");
    assert.equal(snapshot.search.total, 0);

    const lines = fs.readFileSync(spendLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      date: "2026-08-28",
      genaiImages: 5,
      searchQueries: 2,
      estimatedUsd: 0.052
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state survives a restart, so a restart does not refill the budget", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  const spendLogPath = path.join(dir, "spend.log");
  const clock = fixedClock(DAY_START);
  try {
    const first = createSpendGuard({
      caps: { genaiDaily: 6, genaiDailyPerIp: 6 },
      statePath,
      spendLogPath,
      now: clock.now
    });
    assert.equal(first.reserve("genai", { key: "1.1.1.1", amount: 5 }).ok, true);
    first.shutdown();
    assert.ok(fs.existsSync(statePath));

    const second = createSpendGuard({
      caps: { genaiDaily: 6, genaiDailyPerIp: 6 },
      statePath,
      spendLogPath,
      now: clock.now
    });
    assert.equal(second.snapshot().genai.total, 5, "counters reloaded");
    assert.equal(second.reserve("genai", { key: "1.1.1.1", amount: 2 }).ok, false, "global cap remembered");
    const perIp = second.reserve("genai", { key: "1.1.1.1", amount: 1 });
    assert.equal(perIp.ok, true);
    assert.equal(second.reserve("genai", { key: "1.1.1.1", amount: 1 }).reason, "daily");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt state file with no .prev fails CLOSED, not open at zero", () => {
  // A corrupt primary with nothing to recover from must refuse the day: ignoring
  // it and restarting at zero would fail open and hand back a full day of spend.
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  fs.writeFileSync(statePath, "{ not json");
  const warnings = [];
  try {
    const guard = createSpendGuard({
      caps: { genaiDaily: 3 },
      statePath,
      onWarn: (message) => warnings.push(message)
    });
    assert.equal(guard.snapshot().genai.total, 0, "no spend is fabricated either");
    const reservation = guard.reserve("genai", { key: "a", amount: 1 });
    assert.deepEqual(
      { ok: reservation.ok, reason: reservation.reason },
      { ok: false, reason: "corrupt-state" },
      "every reservation is refused, not just ones that would exceed the cap"
    );
    assert.ok(warnings.some((message) => /fail(ing)? closed/i.test(message)), "the operator is told loudly");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt primary recovers from the .prev generation instead of failing closed", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  const prevPath = `${statePath}.prev`;
  fs.writeFileSync(statePath, "{ not json");
  fs.writeFileSync(prevPath, JSON.stringify({
    day: "2026-08-28",
    scopes: { genai: { total: 4, ips: { "1.1.1.1": 4 } }, search: { total: 0, ips: {} } }
  }));
  const warnings = [];
  try {
    const guard = createSpendGuard({
      caps: { genaiDaily: 6 },
      statePath,
      now: () => DAY_START, // same UTC day as the recovered file, so the
      // first reserve() below does not itself roll the day over
      onWarn: (message) => warnings.push(message)
    });
    assert.equal(guard.snapshot().day, "2026-08-28");
    assert.equal(guard.snapshot().genai.total, 4, "counters recovered from .prev, not reset to zero");
    // The recovered budget is real, not exhausted: only 2 of the 6-image cap
    // remain, and a 3rd is refused.
    assert.equal(guard.reserve("genai", { key: "1.1.1.1", amount: 2 }).ok, true);
    assert.equal(guard.reserve("genai", { key: "1.1.1.1", amount: 1 }).reason, "daily");
    assert.ok(warnings.some((message) => /recovered/i.test(message)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted state survives being read back after an atomic write (temp file cleaned up)", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  try {
    const guard = createSpendGuard({
      caps: { genaiDaily: 10 },
      statePath,
      persistDelayMs: 0
    });
    guard.reserve("genai", { key: "a", amount: 3 });
    guard.flush();
    assert.ok(fs.existsSync(statePath));
    assert.equal(fs.existsSync(`${statePath}.tmp`), false, "the temp file is renamed away, not left behind");
    const onDisk = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(onDisk.scopes.genai.total, 3);
    assert.equal(onDisk.corrupt, false);

    // A second write proves the previous GOOD primary becomes .prev, not a
    // growing history of generations.
    guard.reserve("genai", { key: "a", amount: 2 });
    guard.flush();
    const prev = JSON.parse(fs.readFileSync(`${statePath}.prev`, "utf8"));
    assert.equal(prev.scopes.genai.total, 3, "the .prev generation is the state from just before this write");
    const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(current.scopes.genai.total, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fail-closed day still rolls over normally at the next UTC midnight", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  fs.writeFileSync(statePath, "{ not json");
  const clock = fixedClock(DAY_START);
  try {
    const guard = createSpendGuard({
      caps: { genaiDaily: 10 },
      statePath,
      now: clock.now,
      persistDelayMs: 0
    });
    assert.equal(guard.reserve("genai", { key: "a", amount: 1 }).reason, "corrupt-state");

    // Midnight passes: the next reservation must roll the day over and stop
    // being fail-closed — a corrupt file must cost one day, not the service.
    clock.set(Date.parse("2026-08-29T00:00:01.000Z"));
    const afterRollover = guard.reserve("genai", { key: "a", amount: 1 });
    assert.equal(afterRollover.ok, true, "no longer fail-closed once the day changes");
    assert.equal(guard.snapshot().day, "2026-08-29");

    guard.flush();
    const onDisk = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(onDisk.corrupt, false, "the corrupt marker does not survive the rollover");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fail-closed day persisted on shutdown stays fail-closed across a same-day restart", () => {
  // Distinguishes a deliberate reset (delete the file) from an accidental one
  // (a plain process restart must NOT clear a fail-closed day).
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  fs.writeFileSync(statePath, "{ not json");
  const clock = fixedClock(DAY_START);
  try {
    const first = createSpendGuard({ caps: { genaiDaily: 10 }, statePath, now: clock.now });
    assert.equal(first.reserve("genai", { key: "a", amount: 1 }).reason, "corrupt-state");
    first.shutdown();

    const second = createSpendGuard({ caps: { genaiDaily: 10 }, statePath, now: clock.now });
    assert.equal(
      second.reserve("genai", { key: "a", amount: 1 }).reason,
      "corrupt-state",
      "a restart on the same day is not a way to clear a fail-closed day"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("per-IP tracking stops growing past ipTrackingMax; the global cap still holds", () => {
  const guard = createSpendGuard({
    caps: { genaiDaily: 100, genaiDailyPerIp: 1 },
    ipTrackingMax: 2
  });
  assert.equal(guard.reserve("genai", { key: "a", amount: 1 }).ok, true);
  assert.equal(guard.reserve("genai", { key: "b", amount: 1 }).ok, true);
  assert.equal(guard.reserve("genai", { key: "a", amount: 1 }).reason, "ip", "known client still capped");
  // A third distinct client is not tracked individually any more, so the per-IP
  // cap cannot apply to it — but every unit still lands on the global counter.
  assert.equal(guard.reserve("genai", { key: "c", amount: 1 }).ok, true);
  assert.equal(guard.reserve("genai", { key: "c", amount: 1 }).ok, true);
  assert.equal(guard.snapshot().genai.total, 4);
  assert.equal(guard.snapshot().genai.clients, 2);
});

test("kill switch: file presence flips the answer, cached for cacheMs", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "KILL_SWITCH");
  const clock = fixedClock(DAY_START);
  try {
    const kill = createKillSwitch({ filePath, cacheMs: 5000, now: clock.now });
    assert.equal(kill.isEngaged(), false);

    fs.writeFileSync(filePath, "");
    assert.equal(kill.isEngaged(), false, "still cached");
    clock.advance(5001);
    assert.equal(kill.isEngaged(), true, "engaged without a restart");

    fs.rmSync(filePath);
    clock.advance(5001);
    assert.equal(kill.isEngaged(), false, "disengaged without a restart");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kill switch with no path configured is always off", () => {
  assert.equal(createKillSwitch({ filePath: "" }).isEngaged(), false);
});

test("utcDayKey is a UTC calendar day", () => {
  assert.equal(utcDayKey(Date.parse("2026-08-28T23:59:59.999Z")), "2026-08-28");
  assert.equal(utcDayKey(Date.parse("2026-08-29T00:00:00.000Z")), "2026-08-29");
});

test("a release cannot refund across a UTC day rollover", () => {
  // A request reserved at 23:59 whose provider call fails at 00:01 must not
  // subtract from the new day's counter. The reservation carries the day it was
  // taken on, so the refund is dropped.
  let clock = Date.UTC(2026, 7, 29, 23, 59, 0);
  const guard = createSpendGuard({
    caps: { genaiDaily: 100, genaiDailyPerIp: 40 },
    now: () => clock
  });

  const reservation = guard.reserve("genai", { key: "1.2.3.4", amount: 15 });
  assert.equal(reservation.ok, true);
  assert.equal(reservation.day, "2026-08-29");
  assert.equal(guard.snapshot().genai.total, 15);

  // Midnight passes, and a fresh reservation rolls the day over.
  clock = Date.UTC(2026, 7, 30, 0, 1, 0);
  assert.equal(guard.reserve("genai", { key: "5.6.7.8", amount: 1 }).ok, true);
  assert.equal(guard.snapshot().day, "2026-08-30");
  assert.equal(guard.snapshot().genai.total, 1);

  // Yesterday's failure refunds nothing into today.
  guard.release(reservation);
  assert.equal(guard.snapshot().genai.total, 1, "refund must not credit the new day");

  // A same-day release still works normally.
  const sameDay = guard.reserve("genai", { key: "5.6.7.8", amount: 4 });
  assert.equal(guard.snapshot().genai.total, 5);
  guard.release(sameDay);
  assert.equal(guard.snapshot().genai.total, 1);
});

// --- spendClientKey ---------------------------------------------------------
// The per-client cap is only as good as its bucket: a v6 tenant owns a whole
// /64, so keying on the full address hands them a fresh bucket per request.

test("IPv4 keys pass through unchanged", () => {
  assert.equal(spendClientKey("1.2.3.4"), "1.2.3.4");
  assert.equal(spendClientKey("203.0.113.9"), "203.0.113.9");
});

test("IPv4-mapped addresses key as the IPv4 address, not an all-zero /64", () => {
  assert.equal(spendClientKey("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(spendClientKey("::ffff:203.0.113.9"), "203.0.113.9");
  // The hex spelling of the same address must not collapse with every other
  // mapped client into one shared bucket.
  assert.equal(spendClientKey("::ffff:cb00:7109"), "203.0.113.9");
  assert.notEqual(spendClientKey("::ffff:1.2.3.4"), spendClientKey("::ffff:5.6.7.8"));
});

test("IPv6 keys collapse to the /64 regardless of spelling", () => {
  const expected = "2001:db8:1:2::/64";
  assert.equal(spendClientKey("2001:db8:1:2:3:4:5:6"), expected);
  assert.equal(spendClientKey("2001:0db8:0001:0002:0000:0000:0000:0001"), expected);
  assert.equal(spendClientKey("2001:db8:1:2::1"), expected);
  assert.equal(spendClientKey("2001:DB8:1:2::beef"), expected);
});

test("a whole /64 is one bucket, and a different /64 is a different one", () => {
  const guard = createSpendGuard({ caps: { genaiDaily: 1000, genaiDailyPerIp: 4 } });
  // Rotating the host part inside one /64 must not mint a new bucket.
  assert.equal(guard.reserve("genai", { key: spendClientKey("2001:db8:a:b::1"), amount: 3 }).ok, true);
  const refused = guard.reserve("genai", { key: spendClientKey("2001:db8:a:b::dead:beef"), amount: 3 });
  assert.equal(refused.ok, false, "same /64 must share the per-client cap");
  assert.equal(refused.reason, "ip");
  // A neighbouring /64 is a different tenant and keeps its own budget.
  assert.equal(guard.reserve("genai", { key: spendClientKey("2001:db8:a:c::1"), amount: 3 }).ok, true);
});

test("zone ids, loopback and garbage do not throw", () => {
  assert.equal(spendClientKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(spendClientKey("fe80::abcd%12"), "fe80:0:0:0::/64");
  assert.equal(spendClientKey("::1"), "0:0:0:0::/64");
  assert.equal(spendClientKey("::"), "0:0:0:0::/64");
});

test("unparseable clients share one bucket rather than each getting a free one", () => {
  // The abuse-safe side of the trade-off: an attacker who can make req.ip
  // unreadable must not get a fresh cap per request.
  for (const bad of ["", null, undefined, "not-an-ip", "999.1.1.1", "2001:db8:::1", {}]) {
    assert.equal(spendClientKey(bad), "unknown");
  }
});

test("one IPv6 /48 cannot drain the day by rotating /64s", () => {
  const guard = createSpendGuard({ caps: { genaiDaily: 1000, genaiDailyPerIp: 4 }, ipv6PrefixFactor: 2 });
  assert.equal(guard.reserve("genai", { key: spendClientKey("2001:db8:a:1::1"), amount: 4 }).ok, true);
  assert.equal(guard.reserve("genai", { key: spendClientKey("2001:db8:a:2::1"), amount: 4 }).ok, true);
  const refused = guard.reserve("genai", { key: spendClientKey("2001:db8:a:3::1"), amount: 1 });
  assert.equal(refused.ok, false, "a fresh /64 in a spent /48 is refused");
  assert.equal(refused.reason, "ip");
  assert.equal(guard.reserve("genai", { key: spendClientKey("2001:db8:b:1::1"), amount: 4 }).ok, true, "another /48 is unaffected");
  assert.equal(guard.reserve("genai", { key: "198.51.100.7", amount: 4 }).ok, true, "IPv4 has no prefix bucket");
});

test("a release refunds the /48 as well, and factor 0 turns the /48 limit off", () => {
  const guard = createSpendGuard({ caps: { genaiDaily: 1000, genaiDailyPerIp: 4 }, ipv6PrefixFactor: 1 });
  const first = guard.reserve("genai", { key: spendClientKey("2001:db8:a:1::1"), amount: 4 });
  assert.equal(guard.reserve("genai", { key: spendClientKey("2001:db8:a:2::1"), amount: 1 }).ok, false);
  guard.release(first, 3);
  assert.equal(guard.reserve("genai", { key: spendClientKey("2001:db8:a:2::1"), amount: 3 }).ok, true);

  const off = createSpendGuard({ caps: { genaiDaily: 1000, genaiDailyPerIp: 4 }, ipv6PrefixFactor: 0 });
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(off.reserve("genai", { key: spendClientKey(`2001:db8:a:${i}::1`), amount: 4 }).ok, true);
  }
});

test("/48 counters survive a restart", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "spend-state.json");
  const clock = fixedClock(DAY_START);
  const options = { caps: { genaiDaily: 1000, genaiDailyPerIp: 4 }, ipv6PrefixFactor: 1, statePath, now: clock.now };
  try {
    const first = createSpendGuard(options);
    assert.equal(first.reserve("genai", { key: spendClientKey("2001:db8:a:1::1"), amount: 4 }).ok, true);
    first.shutdown();
    const second = createSpendGuard(options);
    assert.equal(second.reserve("genai", { key: spendClientKey("2001:db8:a:2::1"), amount: 1 }).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
