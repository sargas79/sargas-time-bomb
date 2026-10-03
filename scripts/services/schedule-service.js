/**
 * Pure campaign-moment arithmetic. A calendar is
 * { monthLengths: number[], monthNames?: string[]|null, monthBase: 0|1, dayBase: 1,
 *   hoursPerDay, minutesPerHour, secondsPerMinute }.
 * Moments are { year, month, day, hour, minute } in the calendar's own bases.
 */
import { DEFAULT_CALENDAR, SECONDS } from "../constants.js";
import { isMoment, normalizeMoment } from "./clock-service.js";

export function normalizeCalendar(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  let monthLengths = Array.isArray(c.monthLengths) ? c.monthLengths.map(n => Math.max(1, Math.trunc(Number(n) || 1))) : null;
  if (!monthLengths?.length) monthLengths = [...DEFAULT_CALENDAR.monthLengths];
  const monthNames = Array.isArray(c.monthNames) && c.monthNames.length === monthLengths.length ? [...c.monthNames] : null;
  return {
    monthLengths,
    monthNames,
    monthBase: c.monthBase === 0 ? 0 : 1,
    dayBase: c.dayBase === 0 ? 0 : 1,
    hoursPerDay: positive(c.hoursPerDay, DEFAULT_CALENDAR.hoursPerDay),
    minutesPerHour: positive(c.minutesPerHour, DEFAULT_CALENDAR.minutesPerHour),
    secondsPerMinute: positive(c.secondsPerMinute, DEFAULT_CALENDAR.secondsPerMinute)
  };
}

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function daysPerYear(calendar) {
  return calendar.monthLengths.reduce((a, b) => a + b, 0);
}

export function secondsPerDay(calendar) {
  return calendar.hoursPerDay * calendar.minutesPerHour * calendar.secondsPerMinute;
}

export function secondsPerHour(calendar) {
  return calendar.minutesPerHour * calendar.secondsPerMinute;
}

/** Absolute day number (day 0 = first day of year 0). */
export function toAbsoluteDay(moment, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  const m = normalizeMoment(moment);
  if (!m) return NaN;
  const monthIndex = m.month - cal.monthBase;
  let days = m.year * daysPerYear(cal);
  const months = cal.monthLengths.length;
  // Tolerate out-of-range months by rolling years.
  const yearShift = Math.floor(monthIndex / months);
  const mi = ((monthIndex % months) + months) % months;
  days += yearShift * daysPerYear(cal);
  for (let i = 0; i < mi; i++) days += cal.monthLengths[i];
  days += m.day - cal.dayBase;
  return days;
}

export function fromAbsoluteDay(day, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  const dpy = daysPerYear(cal);
  let year = Math.floor(day / dpy);
  let rem = day - year * dpy;
  let monthIndex = 0;
  while (monthIndex < cal.monthLengths.length - 1 && rem >= cal.monthLengths[monthIndex]) {
    rem -= cal.monthLengths[monthIndex];
    monthIndex += 1;
  }
  return { year, month: monthIndex + cal.monthBase, day: rem + cal.dayBase, hour: 0, minute: 0 };
}

export function momentToSeconds(moment, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  const m = normalizeMoment(moment);
  if (!m) return NaN;
  return toAbsoluteDay(m, cal) * secondsPerDay(cal)
    + m.hour * secondsPerHour(cal)
    + m.minute * cal.secondsPerMinute;
}

export function secondsToMoment(seconds, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  const spd = secondsPerDay(cal);
  const day = Math.floor(seconds / spd);
  let rem = seconds - day * spd;
  const m = fromAbsoluteDay(day, cal);
  m.hour = Math.floor(rem / secondsPerHour(cal));
  rem -= m.hour * secondsPerHour(cal);
  m.minute = Math.floor(rem / cal.secondsPerMinute);
  return m;
}

export function addSeconds(moment, seconds, calendar) {
  return secondsToMoment(momentToSeconds(moment, calendar) + seconds, calendar);
}

export function addDays(moment, days, calendar) {
  return addSeconds(moment, days * secondsPerDay(normalizeCalendar(calendar)), calendar);
}

export function compareMoments(a, b, calendar) {
  const sa = momentToSeconds(a, calendar);
  const sb = momentToSeconds(b, calendar);
  if (Number.isNaN(sa) || Number.isNaN(sb)) return NaN;
  return Math.sign(sa - sb);
}

export function elapsedSeconds(from, to, calendar) {
  if (!isMoment(from) || !isMoment(to)) return 0;
  return momentToSeconds(to, calendar) - momentToSeconds(from, calendar);
}

/** Convert an `every` object { hours, days, weeks } to seconds. */
export function everyToSeconds(every, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  if (!every || typeof every !== "object") return 0;
  const h = Number(every.hours) || 0;
  const d = Number(every.days) || 0;
  const w = Number(every.weeks) || 0;
  return h * secondsPerHour(cal) + d * secondsPerDay(cal) + w * 7 * secondsPerDay(cal);
}

/**
 * Bucket elapsed seconds into whole periods, carrying the remainder forward.
 * Negative elapsed time never produces ticks and never reduces the carry below 0.
 */
export function bucketElapsed(carrySeconds, elapsed, periodSeconds) {
  const carry = Math.max(0, Number(carrySeconds) || 0);
  if (!(periodSeconds > 0)) return { ticks: 0, carry };
  const e = Number(elapsed) || 0;
  if (e <= 0) return { ticks: 0, carry };
  const total = carry + e;
  const ticks = Math.floor(total / periodSeconds);
  return { ticks, carry: total - ticks * periodSeconds };
}

/** Is the moment a valid date in this calendar? */
export function isValidMoment(moment, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  const m = normalizeMoment(moment);
  if (!m) return false;
  const mi = m.month - cal.monthBase;
  if (mi < 0 || mi >= cal.monthLengths.length) return false;
  const di = m.day - cal.dayBase;
  if (di < 0 || di >= cal.monthLengths[mi]) return false;
  if (m.hour < 0 || m.hour >= cal.hoursPerDay) return false;
  if (m.minute < 0 || m.minute >= cal.minutesPerHour) return false;
  return true;
}

/** Fallback formatter when no time source supplies one. */
export function formatMoment(moment, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  const m = normalizeMoment(moment);
  if (!m) return "";
  const mi = m.month - cal.monthBase;
  const monthName = cal.monthNames?.[mi] ?? String(m.month);
  const hh = String(m.hour).padStart(2, "0");
  const mm = String(m.minute).padStart(2, "0");
  return `${m.day} ${monthName} ${m.year}, ${hh}:${mm}`;
}

/** Break a span of seconds into { weeks, days, hours, minutes, negative }. */
export function describeSpan(seconds, rawCalendar) {
  const cal = normalizeCalendar(rawCalendar);
  const negative = seconds < 0;
  let s = Math.abs(Math.trunc(seconds));
  const spd = secondsPerDay(cal);
  const sph = secondsPerHour(cal);
  const days = Math.floor(s / spd); s -= days * spd;
  const hours = Math.floor(s / sph); s -= hours * sph;
  const minutes = Math.floor(s / cal.secondsPerMinute);
  return { negative, days, hours, minutes, totalSeconds: seconds };
}

/**
 * Given a repeating date trigger that fired at `at`, return the next `at`
 * strictly after `now`.
 */
export function nextOccurrence(at, repeatEvery, now, calendar) {
  const period = everyToSeconds(repeatEvery, calendar);
  if (!(period > 0)) return null;
  const nowS = momentToSeconds(now, calendar);
  let atS = momentToSeconds(at, calendar);
  if (Number.isNaN(nowS) || Number.isNaN(atS)) return null;
  if (atS > nowS) return normalizeMoment(at);
  const steps = Math.floor((nowS - atS) / period) + 1;
  atS += steps * period;
  return secondsToMoment(atS, calendar);
}

/** Convenience: build a moment from the common TTA shape { date: {year,month,day}, time: {hour,minute} }. */
export function momentFromDateTime(date, time) {
  if (!date || typeof date !== "object") return null;
  return normalizeMoment({
    year: date.year, month: date.month, day: date.day,
    hour: time?.hour ?? time?.hours ?? 0,
    minute: time?.minute ?? time?.minutes ?? 0
  });
}

export const UNIT_SECONDS = SECONDS;
