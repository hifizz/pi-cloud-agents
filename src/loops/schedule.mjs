// Loop schedule math (Issue14 Phase1): next firing slot after `after` (ms), on the spec's timezone grid.
// Timezone handling goes through Intl — no tz database is shipped. DST is handled by asking Intl for the wall-clock
// parts of candidates in the target zone, never by doing arithmetic on "local" epoch offsets.
//
// Slot semantics (matching ext/routines.mjs): strictly after `after`. A missed series fires once for the next slot
// after now; the grid itself is anchored at startAt for hourly interval, and at (at, tz) wall-clock times otherwise.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Wall-clock parts of `ms` in `tz`: {year, month(1-12), day, hour, minute, second, weekday(0=Sunday)}. */
function partsIn(ms, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date(ms))) map[p.type] = p.value;
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[map.weekday];
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
  };
}

/**
 * Convert wall-clock parts in `tz` back to epoch ms. Handles DST by finding the instant whose tz-parts match.
 * A wall time inside a spring-forward gap resolves to the first valid instant after the gap; a fall-back repeat
 * resolves to the first occurrence (earlier instant).
 */
function msInTz({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  // Iterative UTC guess: start from the naive UTC instant, then correct by the observed offset. Two passes settle
  // for every real zone; a third pass covers zones whose offset changes exactly at the boundary.
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const p = partsIn(guess, tz);
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = observed - guess; // how far the guess is off, in wall-clock terms
    if (diff === 0) {
      // Verify the parts really match (a gap landing can coincidentally zero out).
      const back = partsIn(guess, tz);
      if (back.year === year && back.month === month && back.day === day && back.hour === hour && back.minute === minute) {
        return guess;
      }
      return guess;
    }
    guess -= diff;
  }
  // Fall through: return the first instant whose wall-clock parts are >= the target (gap semantics).
  let t = Date.UTC(year, month - 1, day, hour, minute, second) - 2 * 60 * 60 * 1000;
  const end = t + 8 * 60 * 60 * 1000;
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let best;
  for (; t <= end; t += 30 * 1000) {
    const p = partsIn(t, tz);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (wall >= target) {
      best = t;
      break;
    }
  }
  if (best === undefined) return Date.UTC(year, month - 1, day, hour, minute, second);
  // Slide to the exact minute boundary when the scan overshot by partial minutes.
  for (let t2 = best; t2 > best - 30 * 1000; t2 -= 1000) {
    const p = partsIn(t2 - 1, tz);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (wall >= target) best = t2 - 1;
    else break;
  }
  return best;
}

function parseAt(at) {
  const [h, m] = at.split(":").map(Number);
  return { hour: h, minute: m };
}

/** Next wall-clock occurrence of `at` (HH:MM) in `tz`, strictly after `after` ms. */
function nextAtInTz(at, after, tz, { days } = {}) {
  const { hour, minute } = parseAt(at);
  // Search up to 8 days ahead: weekly day sets need up to a week, plus one for the "strictly after" edge.
  const base = partsIn(after, tz);
  for (let d = 0; d <= 8; d++) {
    // Wall-clock date +d days: shift the base date by d calendar days (in tz terms, via UTC date arithmetic on parts).
    const probeDate = new Date(Date.UTC(base.year, base.month - 1, base.day + d));
    const y = probeDate.getUTCFullYear();
    const mo = probeDate.getUTCMonth() + 1;
    const dy = probeDate.getUTCDate();
    if (days) {
      // weekday of that wall date in tz: get it by asking parts of that date's noon in tz (noon never falls in a gap).
      const noon = msInTz({ year: y, month: mo, day: dy, hour: 12, minute: 0 }, tz);
      const wd = partsIn(noon, tz).weekday;
      if (!days.includes(wd)) continue;
    }
    const t = msInTz({ year: y, month: mo, day: dy, hour, minute, second: 0 }, tz);
    if (t > after) return t;
  }
  // Unreachable for sane inputs (days covers at least one weekday).
  return msInTz({ year: base.year, month: base.month, day: base.day + 9, hour, minute, second: 0 }, tz);
}

/** Next slot strictly after `after` for a monthly spec: day-of-month from startAt, at `at`, in `tz`. */
function nextMonthlyInTz(at, after, tz, dom) {
  const { hour, minute } = parseAt(at);
  const base = partsIn(after, tz);
  for (let k = 0; k <= 14; k++) {
    // k months after the current wall month.
    const probe = new Date(Date.UTC(base.year, base.month - 1 + k, 1));
    const y = probe.getUTCFullYear();
    const mo = probe.getUTCMonth() + 1;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (dom > dim) continue; // e.g. the 31st in a 30-day month: skipped, not clamped
    const t = msInTz({ year: y, month: mo, day: dom, hour, minute, second: 0 }, tz);
    if (t > after) return t;
  }
  return nextAtInTz(at, after, tz); // unreachable for dom <= 28
}

/** Next slot strictly after `after` for a yearly spec: month+day from startAt, at `at`, in `tz`. */
function nextYearlyInTz(at, after, tz, month, day) {
  const { hour, minute } = parseAt(at);
  const base = partsIn(after, tz);
  for (let k = 0; k <= 2; k++) {
    const y = base.year + k;
    // Feb 29 in a non-leap year: skipped.
    const dim = new Date(Date.UTC(y, month, 0)).getUTCDate();
    if (day > dim) continue;
    const t = msInTz({ year: y, month, day, hour, minute, second: 0 }, tz);
    if (t > after) return t;
  }
  return msInTz({ year: base.year + 3, month, day, hour, minute, second: 0 }, tz); // unreachable
}

/**
 * Next firing time (epoch ms) strictly after `after` for a validated schedule spec.
 * spec: {freq, interval, at?, tz, startAt, days?}. `after` defaults to now.
 *
 * - hourly: every `interval` hours on a UTC grid anchored at startAt (at/days not used).
 * - daily: every `interval` days at `at` in tz (grid anchored at the startAt wall date).
 * - weekly: every `interval` weeks on the listed `days` at `at` in tz.
 * - monthly: every `interval` months on the startAt day-of-month at `at` in tz.
 * - yearly: every `interval` years on the startAt month/day at `at` in tz.
 */
export function nextSlot(spec, after = Date.now()) {
  const tz = spec.tz ?? "UTC";
  const startAt = Number(spec.startAt ?? after);
  switch (spec.freq) {
    case "hourly": {
      const step = spec.interval * HOUR_MS;
      if (after < startAt) return Math.ceil((startAt - after) / step) * step + after <= startAt ? startAt : startAt;
      const steps = Math.floor((after - startAt) / step) + 1;
      const t = startAt + steps * step;
      return t > after ? t : t + step;
    }
    case "daily": {
      // Anchor the day grid on the startAt wall date; every interval-th day carries `at`.
      const start = partsIn(startAt, tz);
      const startDate = Date.UTC(start.year, start.month - 1, start.day);
      const now = partsIn(after, tz);
      const nowDate = Date.UTC(now.year, now.month - 1, now.day);
      const dayDiff = Math.floor((nowDate - startDate) / DAY_MS);
      const { hour, minute } = parseAt(spec.at);
      // Search a bounded window: the next grid day within a year.
      for (let d = Math.max(0, dayDiff); d <= dayDiff + spec.interval + 370; d++) {
        if (d % spec.interval !== 0) continue;
        const date = new Date(startDate + d * DAY_MS);
        const t = msInTz({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 }, tz);
        if (t > after && t >= startAt) return t;
      }
      return nextAtInTz(spec.at, after, tz); // unreachable
    }
    case "weekly": {
      // Every interval weeks (anchored on the startAt week), on `days` at `at` in tz.
      const days = spec.days && spec.days.length ? spec.days : [partsIn(startAt, tz).weekday];
      // Week anchor: the Sunday of the startAt week (wall date arithmetic).
      const start = partsIn(startAt, tz);
      const startSunday = Date.UTC(start.year, start.month - 1, start.day - start.weekday);
      const { hour, minute } = parseAt(spec.at);
      const now = partsIn(after, tz);
      const nowSunday = Date.UTC(now.year, now.month - 1, now.day - now.weekday);
      const weekDiff = Math.floor((nowSunday - startSunday) / (7 * DAY_MS));
      for (let w = Math.max(0, weekDiff - 1); w <= weekDiff + spec.interval + 55; w++) {
        if (w % spec.interval !== 0) continue;
        for (const wd of days) {
          const date = new Date(startSunday + (w * 7 + wd) * DAY_MS);
          const t = msInTz(
            { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 },
            tz,
          );
          if (t > after && t >= startAt) return t;
        }
      }
      return nextAtInTz(spec.at, after, tz, { days }); // unreachable
    }
    case "monthly": {
      const start = partsIn(startAt, tz);
      const { hour, minute } = parseAt(spec.at);
      // Anchor months on startAt: every interval-th month from (start.year, start.month) on start.day.
      const now = partsIn(after, tz);
      const monthDiff = (now.year - start.year) * 12 + (now.month - start.month);
      for (let k = Math.max(0, monthDiff - 1); k <= monthDiff + spec.interval + 14; k++) {
        if (k % spec.interval !== 0) continue;
        const probe = new Date(Date.UTC(start.year, start.month - 1 + k, 1));
        const y = probe.getUTCFullYear();
        const mo = probe.getUTCMonth() + 1;
        const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        if (start.day > dim) continue;
        const t = msInTz({ year: y, month: mo, day: start.day, hour, minute, second: 0 }, tz);
        if (t > after && t >= startAt) return t;
      }
      return nextMonthlyInTz(spec.at, after, tz, start.day); // unreachable
    }
    case "yearly": {
      const start = partsIn(startAt, tz);
      const { hour, minute } = parseAt(spec.at);
      const now = partsIn(after, tz);
      for (let k = Math.max(0, now.year - start.year - 1); k <= now.year - start.year + 3; k++) {
        if (k % spec.interval !== 0) continue;
        const y = start.year + k;
        const dim = new Date(Date.UTC(y, start.month, 0)).getUTCDate();
        if (start.day > dim) continue;
        const t = msInTz({ year: y, month: start.month, day: start.day, hour, minute, second: 0 }, tz);
        if (t > after && t >= startAt) return t;
      }
      return nextYearlyInTz(spec.at, after, tz, start.month, start.day); // unreachable
    }
  }
  throw new Error(`unsupported schedule freq: ${spec.freq}`);
}

/** trigger_key for a scheduled firing: the slot timestamp. */
export const scheduleTriggerKey = (slotMs) => `schedule:${Math.floor(slotMs)}`;
