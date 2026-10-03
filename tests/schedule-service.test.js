import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, addSeconds, bucketElapsed, compareMoments, describeSpan, elapsedSeconds, everyToSeconds,
  formatMoment, fromAbsoluteDay, isValidMoment, momentToSeconds, nextOccurrence, normalizeCalendar,
  secondsToMoment, toAbsoluteDay
} from "../scripts/services/schedule-service.js";

// Uneven stub calendar in the style of TTA: 1-based months, 1-based days.
const CAL = { monthLengths: [30, 25, 31, 28, 33], monthNames: ["Ashfen", "Brume", "Cinder", "Dusk", "Ember"], monthBase: 1 };
const DAY = 86400;

test("normalizeCalendar fills defaults", () => {
  const c = normalizeCalendar({});
  assert.equal(c.monthLengths.length, 12);
  assert.equal(c.monthBase, 1);
  assert.equal(normalizeCalendar({ monthLengths: [10], monthBase: 0 }).monthBase, 0);
});

test("toAbsoluteDay / fromAbsoluteDay round-trip across uneven months", () => {
  const m = { year: 3, month: 3, day: 7, hour: 0, minute: 0 };
  const d = toAbsoluteDay(m, CAL);
  assert.equal(d, 3 * 147 + 30 + 25 + 6);
  assert.deepEqual(fromAbsoluteDay(d, CAL), m);
  // last day of year
  const last = { year: 0, month: 5, day: 33, hour: 0, minute: 0 };
  assert.deepEqual(fromAbsoluteDay(toAbsoluteDay(last, CAL), CAL), last);
  // zero-based months
  const cal0 = { ...CAL, monthBase: 0 };
  const m0 = { year: 1, month: 0, day: 1, hour: 0, minute: 0 };
  assert.deepEqual(fromAbsoluteDay(toAbsoluteDay(m0, cal0), cal0), m0);
});

test("momentToSeconds and secondsToMoment include hours and minutes", () => {
  const m = { year: 142, month: 1, day: 12, hour: 7, minute: 30 };
  const s = momentToSeconds(m, CAL);
  assert.equal(s, (142 * 147 + 11) * DAY + 7 * 3600 + 30 * 60);
  assert.deepEqual(secondsToMoment(s, CAL), m);
});

test("addSeconds crosses month and year boundaries", () => {
  const m = { year: 0, month: 1, day: 30, hour: 23, minute: 0 };
  assert.deepEqual(addSeconds(m, 3600, CAL), { year: 0, month: 2, day: 1, hour: 0, minute: 0 });
  const end = { year: 0, month: 5, day: 33, hour: 0, minute: 0 };
  assert.deepEqual(addDays(end, 1, CAL), { year: 1, month: 1, day: 1, hour: 0, minute: 0 });
});

test("compareMoments and elapsedSeconds", () => {
  const a = { year: 1, month: 1, day: 1, hour: 0, minute: 0 };
  const b = { year: 1, month: 1, day: 2, hour: 0, minute: 0 };
  assert.equal(compareMoments(a, b, CAL), -1);
  assert.equal(compareMoments(b, a, CAL), 1);
  assert.equal(compareMoments(a, a, CAL), 0);
  assert.equal(elapsedSeconds(a, b, CAL), DAY);
  assert.equal(elapsedSeconds(b, a, CAL), -DAY);
  assert.equal(elapsedSeconds(null, a, CAL), 0);
});

test("everyToSeconds", () => {
  assert.equal(everyToSeconds({ hours: 6 }, CAL), 6 * 3600);
  assert.equal(everyToSeconds({ days: 1 }, CAL), DAY);
  assert.equal(everyToSeconds({ weeks: 1, days: 1 }, CAL), 8 * DAY);
  assert.equal(everyToSeconds(null, CAL), 0);
});

test("bucketElapsed carries remainders so 3 x 8h = 1 day exactly", () => {
  let st = { ticks: 0, carry: 0 };
  let total = 0;
  for (let i = 0; i < 3; i++) {
    st = bucketElapsed(st.carry, 8 * 3600, DAY);
    total += st.ticks;
  }
  assert.equal(total, 1);
  assert.equal(st.carry, 0);
  // Daily clock gets exactly one tick from +1 day; 8h clock gets three.
  assert.equal(bucketElapsed(0, DAY, DAY).ticks, 1);
  assert.equal(bucketElapsed(0, DAY, 8 * 3600).ticks, 3);
  // Negative elapsed never ticks and never reduces the carry.
  assert.deepEqual(bucketElapsed(100, -5000, DAY), { ticks: 0, carry: 100 });
  assert.deepEqual(bucketElapsed(0, 10, 0), { ticks: 0, carry: 0 });
});

test("isValidMoment honours month lengths", () => {
  assert.ok(isValidMoment({ year: 1, month: 2, day: 25 }, CAL));
  assert.equal(isValidMoment({ year: 1, month: 2, day: 26 }, CAL), false);
  assert.equal(isValidMoment({ year: 1, month: 6, day: 1 }, CAL), false);
  assert.equal(isValidMoment({ year: 1, month: 1, day: 1, hour: 24 }, CAL), false);
});

test("formatMoment uses month names when available", () => {
  assert.equal(formatMoment({ year: 142, month: 1, day: 12, hour: 7, minute: 0 }, CAL), "12 Ashfen 142, 07:00");
  assert.equal(formatMoment({ year: 1, month: 2, day: 3 }, { monthLengths: [10, 10] }), "3 2 1, 00:00");
});

test("describeSpan", () => {
  const s = describeSpan(2 * DAY + 3 * 3600 + 15 * 60, CAL);
  assert.deepEqual([s.days, s.hours, s.minutes, s.negative], [2, 3, 15, false]);
  assert.equal(describeSpan(-60, CAL).negative, true);
});

test("nextOccurrence re-arms strictly after now", () => {
  const at = { year: 1, month: 1, day: 1, hour: 6, minute: 0 };
  const now = { year: 1, month: 1, day: 3, hour: 6, minute: 0 };
  assert.deepEqual(nextOccurrence(at, { days: 1 }, now, CAL), { year: 1, month: 1, day: 4, hour: 6, minute: 0 });
  const future = { year: 2, month: 1, day: 1, hour: 0, minute: 0 };
  assert.deepEqual(nextOccurrence(future, { days: 1 }, now, CAL), future);
  assert.equal(nextOccurrence(at, {}, now, CAL), null);
});
