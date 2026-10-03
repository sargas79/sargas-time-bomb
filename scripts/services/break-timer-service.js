/**
 * Break timer: one real-world countdown (a lunch break, a pause) the GM starts
 * for the whole table. It is a wall-clock deadline in a world setting, so it
 * survives reloads and never touches campaign time or the clocks. Foundry
 * globals are only touched inside functions.
 */
import { BREAK_MINUTES_DEFAULT, BREAK_MINUTES_MAX, BREAK_MINUTES_MIN, MODULE_ID, SETTINGS } from "../constants.js";
import { getSetting, isGM, setSetting } from "../compat.js";

/** Whole minutes within the allowed range, or null when the input is not a number. */
export function clampMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(BREAK_MINUTES_MAX, Math.max(BREAK_MINUTES_MIN, n));
}

/** Stored shape: `{ minutes, endsAt, startedBy }`; `endsAt` is null when no break is set. */
export function normalizeBreak(raw) {
  const endsAt = Number(raw?.endsAt);
  return {
    minutes: clampMinutes(raw?.minutes) ?? BREAK_MINUTES_DEFAULT,
    endsAt: Number.isFinite(endsAt) && endsAt > 0 ? endsAt : null,
    startedBy: typeof raw?.startedBy === "string" ? raw.startedBy : null
  };
}

export function remainingMs(timer, now) {
  if (!timer?.endsAt) return 0;
  return Math.max(0, timer.endsAt - now);
}

export function isRunning(timer, now) {
  return remainingMs(timer, now) > 0;
}

/** `mm:ss`, rounded up so the display reaches 00:00 exactly when the break ends. */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = n => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Real-world now in ms. Server-synced when Foundry offers it, so clients with skewed clocks agree. */
export function realNow() {
  const server = globalThis.game?.time?.serverTime;
  return Number.isFinite(server) ? server : Date.now();
}

export function getBreak() {
  let raw = null;
  try { raw = getSetting(SETTINGS.breakTimer); } catch { /* not registered yet */ }
  return normalizeBreak(raw);
}

function requireGM() {
  if (!isGM()) throw new Error(`${MODULE_ID}: only a GM can set the break timer`);
}

/** Start (or restart) the break. Any GM may; the deadline is shared through the setting. */
export async function startBreak(minutes) {
  requireGM();
  const m = clampMinutes(minutes);
  if (m === null) throw new Error(`${MODULE_ID}: break length must be a number of minutes`);
  const timer = { minutes: m, endsAt: realNow() + m * 60000, startedBy: globalThis.game?.user?.id ?? null };
  await setSetting(SETTINGS.breakTimer, timer);
  return timer;
}

/** Stop the break early. The last length is kept as the next default. */
export async function cancelBreak() {
  requireGM();
  const timer = { minutes: getBreak().minutes, endsAt: null, startedBy: null };
  await setSetting(SETTINGS.breakTimer, timer);
  return timer;
}
