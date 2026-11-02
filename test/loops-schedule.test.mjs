// Loop schedule math tests (Issue14 Phase1): nextSlot correctness across freqs, intervals, day sets,
// timezone handling and DST boundaries (America/New_York, Asia/Singapore). Pure functions, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSlot, scheduleTriggerKey } from "../src/loops/schedule.mjs";

const UTC = "UTC";
const NY = "America/New_York";
const SG = "Asia/Singapore";
const ms = (iso) => Date.parse(iso);

/** wall-clock parts in tz (test helper, independent of impl's internal partsIn). */
function parts(msv, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  const m = {};
  for (const p of fmt.formatToParts(new Date(msv))) m[p.type] = p.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[m.weekday];
  return { y: +m.year, mo: +m.month, d: +m.day, h: +m.hour, mi: +m.minute, wd };
}

test("hourly interval=2: UTC grid anchored at startAt", () => {
  const spec = { kind: "schedule", freq: "hourly", interval: 2, tz: UTC, startAt: ms("2026-10-31T00:00:00Z") };
  assert.equal(nextSlot(spec, ms("2026-10-31T00:30:00Z")), ms("2026-10-31T02:00:00Z"));
  assert.equal(nextSlot(spec, ms("2026-10-31T02:00:00Z")), ms("2026-10-31T04:00:00Z"), "strictly after");
  assert.equal(nextSlot(spec, ms("2026-10-31T05:59:00Z")), ms("2026-10-31T06:00:00Z"));
  // before startAt: first firing is startAt itself
  assert.equal(nextSlot(spec, ms("2026-10-30T20:00:00Z")), ms("2026-10-31T00:00:00Z"));
});

test("daily at 09:00 Asia/Singapore (no DST)", () => {
  const spec = { kind: "schedule", freq: "daily", interval: 1, at: "09:00", tz: SG, startAt: ms("2026-10-30T01:00:00Z") };
  const t = nextSlot(spec, ms("2026-10-31T02:00:00Z")); // 10:00 SG on Oct 31
  const p = parts(t, SG);
  assert.deepEqual([p.h, p.mi], [9, 0]);
  assert.equal(p.d, 1, "next daily slot is Nov 1 09:00 SG");
  // same wall clock every day: consecutive slots are 24h apart in SG (no DST)
  const t2 = nextSlot(spec, t);
  assert.equal(t2 - t, 24 * 3600 * 1000);
});

test("weekly multi-day at 18:30 UTC", () => {
  // startAt on a Wednesday; days Mon+Wed+Fri
  const spec = { kind: "schedule", freq: "weekly", interval: 1, at: "18:30", tz: UTC, startAt: ms("2026-10-28T18:30:00Z"), days: [1, 3, 5] };
  const t = nextSlot(spec, ms("2026-10-28T18:30:00Z")); // the startAt instant itself
  const p = parts(t, UTC);
  assert.equal(p.wd, 5, "next is Friday (same wall time already passed)");
  assert.deepEqual([p.h, p.mi], [18, 30]);
  const t2 = nextSlot(spec, t);
  assert.equal(parts(t2, UTC).wd, 1, "then Monday");
});

test("monthly on the 31st: months without a 31st are skipped, not clamped", () => {
  const spec = { kind: "schedule", freq: "monthly", interval: 1, at: "09:00", tz: UTC, startAt: ms("2026-01-31T09:00:00Z") };
  const t = nextSlot(spec, ms("2026-02-01T00:00:00Z"));
  const p = parts(t, UTC);
  assert.deepEqual([p.mo, p.d, p.h, p.mi], [3, 31, 9, 0], "Feb has no 31st; next is Mar 31");
});

test("yearly Feb 29: non-leap years skipped", () => {
  const spec = { kind: "schedule", freq: "yearly", interval: 1, at: "09:00", tz: UTC, startAt: ms("2024-02-29T09:00:00Z") };
  const t = nextSlot(spec, ms("2025-01-01T00:00:00Z"));
  const p = parts(t, UTC);
  assert.deepEqual([p.y, p.mo, p.d], [2028, 2, 29]);
});

test("DST spring-forward America/New_York: 09:00 local lands correctly across the gap", () => {
  // 2026-03-08 is the US spring-forward (EST->EDT). A daily 09:00 must stay 09:00 local, which shifts the UTC instant by 1h.
  const spec = { kind: "schedule", freq: "daily", interval: 1, at: "09:00", tz: NY, startAt: ms("2026-03-06T14:00:00Z") };
  const d7 = nextSlot(spec, ms("2026-03-07T00:00:00Z")); // -> Mar 7 09:00 EST = 14:00Z
  const d8 = nextSlot(spec, d7); // -> Mar 8 09:00 EDT = 13:00Z
  const d9 = nextSlot(spec, d8); // -> Mar 9 09:00 EDT = 13:00Z
  assert.deepEqual([parts(d7, NY).d, parts(d7, NY).h], [7, 9]);
  assert.deepEqual([parts(d8, NY).d, parts(d8, NY).h], [8, 9]);
  assert.deepEqual([parts(d9, NY).d, parts(d9, NY).h], [9, 9]);
  // Mar7->Mar8 is 23h (spring forward removes an hour); Mar8->Mar9 is a normal 24h.
  assert.equal(d8 - d7, 23 * 3600 * 1000, "DST gap compresses the interval");
  assert.equal(d9 - d8, 24 * 3600 * 1000);
});

test("DST fall-back America/New_York: 09:00 local stays 09:00 (25h apart)", () => {
  // 2026-11-01 is the US fall-back day. Oct 31 09:00 EDT = 13:00Z; Nov 1 09:00 EST = 14:00Z.
  const spec = { kind: "schedule", freq: "daily", interval: 1, at: "09:00", tz: NY, startAt: ms("2026-10-30T13:00:00Z") };
  const d31 = nextSlot(spec, ms("2026-10-31T00:00:00Z")); // Oct 31 09:00 EDT = 13:00Z
  const d1 = nextSlot(spec, d31); // Nov 1 09:00 EST = 14:00Z
  const d2 = nextSlot(spec, d1); // Nov 2 09:00 EST = 14:00Z
  assert.deepEqual([parts(d31, NY).d, parts(d31, NY).h], [31, 9]);
  assert.deepEqual([parts(d1, NY).d, parts(d1, NY).h], [1, 9]);
  assert.deepEqual([parts(d2, NY).d, parts(d2, NY).h], [2, 9]);
  assert.equal(d1 - d31, 25 * 3600 * 1000, "fall-back day is 25 hours");
  assert.equal(d2 - d1, 24 * 3600 * 1000);
});

test("missed slots fire once (no burst): late wake computes the next grid slot strictly after now", () => {
  const spec = { kind: "schedule", freq: "hourly", interval: 1, tz: UTC, startAt: ms("2026-10-31T00:00:00Z") };
  // "now" is 5 slots overdue — the next slot is the immediate next grid point, not a replay of all missed ones
  assert.equal(nextSlot(spec, ms("2026-10-31T05:30:00Z")), ms("2026-10-31T06:00:00Z"));
});

test("interval > 1 for daily/weekly/monthly", () => {
  const daily = { kind: "schedule", freq: "daily", interval: 3, at: "08:00", tz: UTC, startAt: ms("2026-10-01T08:00:00Z") };
  const t = nextSlot(daily, ms("2026-10-01T09:00:00Z"));
  assert.equal(parts(t, UTC).d, 4, "every 3rd day from Oct 1");
  const weekly = { kind: "schedule", freq: "weekly", interval: 2, at: "08:00", tz: UTC, startAt: ms("2026-10-05T08:00:00Z"), days: [1] };
  const w = nextSlot(weekly, ms("2026-10-05T09:00:00Z"));
  assert.equal(parts(w, UTC).d, 19, "every 2nd Monday");
  const monthly = { kind: "schedule", freq: "monthly", interval: 2, at: "08:00", tz: UTC, startAt: ms("2026-01-15T08:00:00Z") };
  const m = nextSlot(monthly, ms("2026-02-01T00:00:00Z"));
  assert.deepEqual([parts(m, UTC).mo, parts(m, UTC).d], [3, 15], "every 2nd month on the 15th");
});

test("scheduleTriggerKey: schedule:<slotTs>", () => {
  assert.equal(scheduleTriggerKey(1730000000000), "schedule:1730000000000");
  assert.equal(scheduleTriggerKey(1730000000123.9), "schedule:1730000000123");
});
