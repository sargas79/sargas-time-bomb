/**
 * Time source adapters: Through the Ages, or Foundry world time.
 * One interface:
 *   start(onChange)  onChange({ moment|null, worldTime|null, source })
 *   stop()
 *   currentMoment()  -> moment | null
 *   formatMoment(m)  -> string
 *   calendar()       -> calendar | null
 *   hasCalendar      -> boolean
 *   id               -> "through-the-ages" | "world-time" | "off"
 */
import { SETTINGS, TTA_HOOKS, TTA_ID, TTA_SETTING_KEY } from "../constants.js";
import { debug, getSetting, warn } from "../compat.js";
import { formatMoment as fallbackFormat, momentFromDateTime, momentToSeconds as localMomentToSeconds, normalizeCalendar } from "./schedule-service.js";
import { normalizeMoment } from "./clock-service.js";

function momentKey(m) {
  return m ? `${m.year}-${m.month}-${m.day}-${m.hour}-${m.minute}` : "";
}

/* ------------------------------------------------------------------ */

export class OffSource {
  id = "off";
  hasCalendar = false;
  start() {}
  stop() {}
  currentMoment() { return null; }
  formatMoment() { return ""; }
  calendar() { return null; }
  worldTime() { return null; }
  momentToSeconds(m) { return localMomentToSeconds(m, null); }
}

/* ------------------------------------------------------------------ */

export class WorldTimeSource {
  id = "world-time";
  hasCalendar = false;
  #hookId = null;
  #onChange = null;

  start(onChange) {
    this.#onChange = onChange;
    this.#hookId = globalThis.Hooks.on("updateWorldTime", (worldTime) => {
      this.#onChange?.({ moment: null, worldTime, source: this.id });
    });
  }

  stop() {
    if (this.#hookId !== null) globalThis.Hooks.off("updateWorldTime", this.#hookId);
    this.#hookId = null;
  }

  currentMoment() { return null; }
  worldTime() { return globalThis.game?.time?.worldTime ?? null; }
  formatMoment(m) { return fallbackFormat(m, null); }
  calendar() { return null; }
  momentToSeconds(m) { return localMomentToSeconds(m, null); }
}

/* ------------------------------------------------------------------ */

export class TTASource {
  id = TTA_ID;
  #hooks = [];
  #onChange = null;
  #lastKey = "";
  #calendarCache = null;
  #lastReason = null;

  static get module() { return globalThis.game?.modules?.get(TTA_ID) ?? null; }
  static get isActive() { return !!TTASource.module?.active; }
  static get api() { return TTASource.module?.api ?? null; }

  get hasCalendar() { return !!this.calendar(); }

  start(onChange) {
    this.#onChange = onChange;
    const H = globalThis.Hooks;
    this.#hooks.push(["updateSetting", H.on("updateSetting", (setting) => {
      if (setting?.key !== TTA_SETTING_KEY) return;
      this.#calendarCache = null;
      this.#report();
    })]);
    // Fast path on the client that moved time; deduplicated by moment.
    // TTA 2.2+ says why time moved; a "next adventure day" may count as a rest.
    this.#hooks.push([TTA_HOOKS.timeChanged, H.on(TTA_HOOKS.timeChanged, payload => this.#report({ reason: payload?.reason ?? null }))]);
    this.#hooks.push([TTA_HOOKS.dateChanged, H.on(TTA_HOOKS.dateChanged, () => this.#report())]);
    this.#hooks.push([TTA_HOOKS.calendarConfigured, H.on(TTA_HOOKS.calendarConfigured, payload => {
      this.#calendarCache = null;
      this.#report({ reconfigured: true, structureChanged: payload?.structureChanged !== false });
    })]);
  }

  stop() {
    for (const [name, id] of this.#hooks) globalThis.Hooks.off(name, id);
    this.#hooks = [];
  }

  #report(extra = {}) {
    const moment = this.currentMoment();
    const key = momentKey(moment);
    // The settings hook and the local timeChanged hook both describe one move;
    // the second report of the same moment only adds the reason if it has one.
    if (!extra.reconfigured && key && key === this.#lastKey && !extra.reason) return;
    if (key === this.#lastKey && extra.reason && this.#lastReason === extra.reason) return;
    this.#lastKey = key;
    this.#lastReason = extra.reason ?? null;
    this.#onChange?.({ moment, worldTime: globalThis.game?.time?.worldTime ?? null, source: this.id, ...extra });
  }

  /** Raw calendar object as TTA exposes it. */
  #rawCalendar() {
    const api = TTASource.api;
    try {
      if (typeof api?.getCalendar === "function") return api.getCalendar();
    } catch (e) { debug("TTA getCalendar failed", e); }
    try {
      const data = globalThis.game?.settings?.get(TTA_ID, "calendarData");
      return data?.calendar ?? data ?? null;
    } catch { return null; }
  }

  calendar() {
    if (this.#calendarCache) return this.#calendarCache;
    const raw = this.#rawCalendar();
    if (!raw) return null;
    const inner = raw.calendar && typeof raw.calendar === "object" ? raw.calendar : raw;
    let monthLengths = inner.monthLengths ?? raw.monthLengths ?? null;
    let monthNames = inner.monthNames ?? raw.monthNames ?? null;
    if (!Array.isArray(monthLengths) && Array.isArray(inner.months)) {
      monthLengths = inner.months.map(m => m.days ?? m.length ?? m.numberOfDays ?? 30);
      if (!monthNames) monthNames = inner.months.map(m => m.name ?? "");
    }
    if (!Array.isArray(monthLengths) || !monthLengths.length) return null;
    const cal = normalizeCalendar({
      monthLengths,
      monthNames,
      monthBase: 1, // TTA dates are 1-based (date-service.toAbsoluteDay)
      hoursPerDay: inner.hoursPerDay ?? raw.hoursPerDay,
      minutesPerHour: inner.minutesPerHour ?? raw.minutesPerHour,
      secondsPerMinute: inner.secondsPerMinute ?? raw.secondsPerMinute
    });
    this.#calendarCache = cal;
    return cal;
  }

  /**
   * Seconds for a moment, preferring TTA's own arithmetic (2.2+) so deadlines
   * and elapsed time agree exactly with the calendar; otherwise the local sum.
   */
  momentToSeconds(moment) {
    const m = normalizeMoment(moment);
    if (!m) return NaN;
    const api = TTASource.api;
    try {
      if (typeof api?.utils?.campaignSeconds === "function" && typeof api.getCalendar === "function") {
        return api.utils.campaignSeconds({ year: m.year, month: m.month, day: m.day }, { hour: m.hour, minute: m.minute }, api.getCalendar());
      }
    } catch (e) { debug("TTA campaignSeconds failed", e); }
    return localMomentToSeconds(m, this.calendar());
  }

  #rawDate() {
    const api = TTASource.api;
    try {
      if (typeof api?.getCurrentDate === "function") return api.getCurrentDate();
    } catch { /* ignore */ }
    try {
      const data = globalThis.game?.settings?.get(TTA_ID, "calendarData");
      return data?.calendar?.currentDate ?? data?.currentDate ?? null;
    } catch { return null; }
  }

  #rawTime() {
    const api = TTASource.api;
    try {
      if (typeof api?.getCurrentTime === "function") return api.getCurrentTime();
    } catch { /* ignore */ }
    try {
      const data = globalThis.game?.settings?.get(TTA_ID, "calendarData");
      return data?.calendar?.currentTime ?? data?.currentTime ?? null;
    } catch { return null; }
  }

  currentMoment() {
    const d = this.#rawDate();
    if (!d) return null;
    // Some shapes nest date and time together.
    const time = this.#rawTime() ?? { hour: d.hour, minute: d.minute };
    return momentFromDateTime(d, time);
  }

  worldTime() { return globalThis.game?.time?.worldTime ?? null; }

  formatMoment(moment) {
    const m = normalizeMoment(moment);
    if (!m) return "";
    const api = TTASource.api;
    try {
      if (typeof api?.formatDate === "function") {
        const date = api.formatDate({ year: m.year, month: m.month, day: m.day });
        let time = "";
        if (typeof api.formatTime === "function") time = api.formatTime({ hour: m.hour, minute: m.minute, hours: m.hour, minutes: m.minute });
        if (typeof date === "string" && date) return time ? `${date}, ${time}` : date;
      }
    } catch (e) { debug("TTA formatDate failed", e); }
    return fallbackFormat(m, this.calendar());
  }

  monthNames() {
    return this.calendar()?.monthNames ?? null;
  }
}

/* ------------------------------------------------------------------ */

let current = null;
let listener = null;

export function resolveSourceId() {
  let setting = "auto";
  try { setting = getSetting(SETTINGS.timeSource) ?? "auto"; } catch { /* settings not ready */ }
  if (setting === "off") return "off";
  if (setting === TTA_ID) return TTASource.isActive ? TTA_ID : "world-time";
  if (setting === "world-time") return "world-time";
  return TTASource.isActive ? TTA_ID : "world-time";
}

export function createSource(id) {
  if (id === TTA_ID) return new TTASource();
  if (id === "world-time") return new WorldTimeSource();
  return new OffSource();
}

/** Start (or restart) the configured time source. */
export function startTimeSource(onChange) {
  if (onChange) listener = onChange;
  stopTimeSource();
  const id = resolveSourceId();
  current = createSource(id);
  if (listener) current.start(listener);
  debug("time source", id);
  return current;
}

export function stopTimeSource() {
  if (current) current.stop();
  current = null;
}

export function getTimeSource() {
  return current ?? createSource(resolveSourceId());
}

/** Snapshot used by the dispatcher to stamp log entries and cards. */
export function timeInfo() {
  const src = getTimeSource();
  return {
    sourceId: src.id,
    moment: src.currentMoment(),
    worldTime: globalThis.game?.time?.worldTime ?? null,
    calendar: src.calendar?.() ?? null,
    hasCalendar: !!src.hasCalendar,
    momentToSeconds: m => src.momentToSeconds(m)
  };
}

export function formatMoment(m) {
  return getTimeSource().formatMoment(m);
}

export function ttaRecommended() {
  return !TTASource.isActive;
}

export { warn as _warn };
