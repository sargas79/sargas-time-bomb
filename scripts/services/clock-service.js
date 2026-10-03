/**
 * Pure clock arithmetic: normalisation, ticks, drains, thresholds, completion,
 * repeat and the audit log. No Foundry globals.
 */
import {
  CURRENT_SCHEMA_VERSION, DIRECTIONS, KINDS, LIMITS, LOG_MAX, ON_COMPLETE, VISIBILITIES, VISIBILITY
} from "../constants.js";
import { kindPreset } from "../data/kinds.js";

let idCounter = 0;
/** Fallback id generator used outside Foundry (tests). */
export function fallbackId(length = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  idCounter += 1;
  return out;
}

function clampInt(value, min, max, fallback = min) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanString(value, max, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

export function isMoment(m) {
  return !!m && typeof m === "object"
    && Number.isFinite(m.year) && Number.isFinite(m.month) && Number.isFinite(m.day);
}

export function normalizeMoment(m) {
  if (!isMoment(m)) return null;
  return {
    year: Math.trunc(m.year),
    month: Math.trunc(m.month),
    day: Math.trunc(m.day),
    hour: Number.isFinite(m.hour) ? Math.trunc(m.hour) : 0,
    minute: Number.isFinite(m.minute) ? Math.trunc(m.minute) : 0
  };
}

export function normalizeThreshold(raw, segments) {
  if (!raw || typeof raw !== "object") return null;
  const at = Number.parseInt(raw.at, 10);
  if (!Number.isFinite(at) || at < 0 || at > segments) return null;
  return {
    at,
    label: cleanString(raw.label, LIMITS.LABEL_MAX),
    note: cleanString(raw.note, LIMITS.DESCRIPTION_MAX),
    effectUuid: typeof raw.effectUuid === "string" && raw.effectUuid ? raw.effectUuid.slice(0, 200) : null
  };
}

export function normalizeTrigger(raw, idGen = fallbackId) {
  if (!raw || typeof raw !== "object") return null;
  const type = typeof raw.type === "string" ? raw.type : "scene";
  let advance = raw.advance;
  if (advance === "complete" || advance === "reset") { /* keep keyword */ }
  else advance = clampInt(advance, -LIMITS.ADVANCE_MAX, LIMITS.ADVANCE_MAX, 1);
  const t = { id: typeof raw.id === "string" && raw.id ? raw.id : idGen(), type, advance };
  switch (type) {
    case "scene":
      t.scenes = Array.isArray(raw.scenes) ? raw.scenes.filter(s => typeof s === "string") : [];
      break;
    case "rest":
      break;
    case "time": {
      const every = raw.every && typeof raw.every === "object" ? raw.every : { days: 1 };
      t.every = {};
      for (const unit of ["hours", "days", "weeks"]) {
        if (every[unit] !== undefined && every[unit] !== null && every[unit] !== "") {
          const n = clampInt(every[unit], 0, 100000, 0);
          if (n > 0) t.every[unit] = n;
        }
      }
      if (!Object.keys(t.every).length) t.every = { days: 1 };
      t.once = raw.once === true;
      break;
    }
    case "date":
      t.at = normalizeMoment(raw.at);
      t.repeatEvery = raw.repeatEvery && typeof raw.repeatEvery === "object" && Object.keys(raw.repeatEvery).length
        ? Object.fromEntries(Object.entries(raw.repeatEvery).filter(([k, v]) => ["hours", "days", "weeks"].includes(k) && clampInt(v, 0, 100000, 0) > 0).map(([k, v]) => [k, clampInt(v, 0, 100000, 0)]))
        : null;
      if (t.repeatEvery && !Object.keys(t.repeatEvery).length) t.repeatEvery = null;
      if (t.advance === 1 && raw.advance === undefined) t.advance = "complete";
      break;
    case "hook":
      t.hook = cleanString(raw.hook, 120, "");
      t.filter = typeof raw.filter === "string" ? raw.filter : null;
      break;
    case "linked":
      t.clockId = typeof raw.clockId === "string" ? raw.clockId : "";
      t.when = raw.when === "threshold" ? "threshold" : "completed";
      t.at = raw.when === "threshold" && raw.at !== null && raw.at !== undefined && raw.at !== "" && Number.isFinite(Number(raw.at)) ? Number(raw.at) : null;
      break;
    default:
      break;
  }
  return t;
}

export function normalizeLogEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    at: typeof raw.at === "string" ? raw.at : new Date(0).toISOString(),
    campaignMoment: normalizeMoment(raw.campaignMoment),
    worldTime: Number.isFinite(raw.worldTime) ? raw.worldTime : null,
    userId: typeof raw.userId === "string" ? raw.userId : null,
    source: typeof raw.source === "string" ? raw.source : "manual",
    delta: Number.isFinite(raw.delta) ? raw.delta : 0,
    filled: Number.isFinite(raw.filled) ? raw.filled : 0,
    note: typeof raw.note === "string" ? raw.note : ""
  };
}

/**
 * Normalise arbitrary input into a complete clock record. Unknown fields are
 * dropped, out-of-range numbers clamped, and kind defaults applied for missing
 * values.
 */
export function normalizeClock(raw = {}, { idGen = fallbackId } = {}) {
  const kind = KINDS.includes(raw.kind) ? raw.kind : "progress";
  const preset = kindPreset(kind);
  const segments = kind === "alarm" ? 1 : clampInt(raw.segments, LIMITS.SEGMENTS_MIN, LIMITS.SEGMENTS_MAX, preset.segments);
  const direction = DIRECTIONS.includes(raw.direction) ? raw.direction : preset.direction;
  const onComplete = ON_COMPLETE.includes(raw.onComplete) ? raw.onComplete : preset.onComplete;
  let visibility = VISIBILITIES.includes(raw.visibility) ? raw.visibility : preset.visibility;
  const actorUuid = typeof raw.actorUuid === "string" && raw.actorUuid ? raw.actorUuid : null;
  if (visibility === VISIBILITY.ACTOR_OWNERS && !actorUuid) visibility = VISIBILITY.GM_ONLY;

  const defaultFilled = direction === "drain" ? segments : 0;
  let filled = clampInt(raw.filled, 0, segments, defaultFilled);
  // D10: a repeating clock never rests at its complete value; it wraps to the start.
  if (onComplete === "repeat" && filled === (direction === "drain" ? 0 : segments)) filled = defaultFilled;

  const thresholds = (Array.isArray(raw.thresholds) ? raw.thresholds : preset.thresholds)
    .map(t => normalizeThreshold(t, segments))
    .filter(Boolean)
    .filter(t => t.at <= segments)
    .filter((t, i, arr) => arr.findIndex(o => o.at === t.at) === i)
    .sort((a, b) => a.at - b.at)
    .slice(0, LIMITS.THRESHOLDS_MAX);

  const triggers = (Array.isArray(raw.triggers) ? raw.triggers : preset.triggers)
    .map(t => normalizeTrigger(t, idGen))
    .filter(Boolean)
    .slice(0, LIMITS.TRIGGERS_MAX);

  const triggerState = {};
  const rawState = raw.triggerState && typeof raw.triggerState === "object" ? raw.triggerState : {};
  for (const t of triggers) {
    const s = rawState[t.id] ?? {};
    triggerState[t.id] = {
      carrySeconds: Number.isFinite(s.carrySeconds) ? Math.max(0, s.carrySeconds) : 0,
      lastFiredAt: s.lastFiredAt ?? null,
      fired: s.fired === true
    };
  }

  // Either empty, or exactly one label per segment.
  const segmentLabelsRaw = Array.isArray(raw.segmentLabels) ? raw.segmentLabels : preset.segmentLabels;
  let segmentLabels = segmentLabelsRaw.slice(0, segments).map(l => cleanString(l, LIMITS.LABEL_MAX));
  if (segmentLabels.some(l => l !== "")) while (segmentLabels.length < segments) segmentLabels.push("");
  else segmentLabels = [];

  const log = (Array.isArray(raw.log) ? raw.log : []).map(normalizeLogEntry).filter(Boolean).slice(0, LOG_MAX);

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : idGen(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    kind,
    name: cleanString(raw.name, LIMITS.NAME_MAX, "") || defaultName(kind),
    description: cleanString(raw.description, LIMITS.DESCRIPTION_MAX),
    color: typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color.toLowerCase() : preset.color,
    icon: cleanString(raw.icon, 80) || preset.icon,
    group: cleanString(raw.group, LIMITS.GROUP_MAX),
    sortOrder: Number.isFinite(raw.sortOrder) ? raw.sortOrder : 0,
    segments,
    filled,
    direction,
    segmentLabels,
    thresholds,
    onComplete,
    completedAt: raw.completedAt ?? null,
    dismissed: raw.dismissed === true,
    visibility,
    actorUuid,
    ownerUserId: typeof raw.ownerUserId === "string" && raw.ownerUserId ? raw.ownerUserId : null,
    triggers,
    triggerState,
    log,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}

export function defaultName(kind) {
  const names = {
    progress: "New clock", countdown: "New countdown", threat: "New threat",
    faction: "New faction clock", corruption: "Corruption", alarm: "New alarm",
    project: "New project", weather: "Weather front"
  };
  return names[kind] ?? "New clock";
}

/** Create a new clock from partial data, applying kind presets. */
export function createClock(data = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const kind = KINDS.includes(data.kind) ? data.kind : "progress";
  const preset = kindPreset(kind);
  const merged = { ...preset, ...data, kind };
  if (data.segments === undefined && data.thresholds === undefined) merged.thresholds = preset.thresholds;
  const clock = normalizeClock(merged, options);
  clock.createdAt = now;
  clock.updatedAt = now;
  return clock;
}

/** Start value for the direction. */
export function startValue(clock) {
  return clock.direction === "drain" ? clock.segments : 0;
}

/** End (complete) value for the direction. */
export function completeValue(clock) {
  return clock.direction === "drain" ? 0 : clock.segments;
}

/** How many progress units remain until completion (or until the next cycle for repeating clocks). */
export function remaining(clock) {
  return clock.direction === "drain" ? clock.filled : clock.segments - clock.filled;
}

/** Progress made so far in direction-agnostic units. */
export function progress(clock) {
  return clock.direction === "drain" ? clock.segments - clock.filled : clock.filled;
}

/** A repeating clock is never "complete": it wraps in the same write (D10). */
export function isComplete(clock) {
  if (clock.onComplete === "repeat") return false;
  return clock.filled === completeValue(clock);
}

/** Current state label: segmentLabels[progress], clamped to the last label when a non-repeating clock is full. */
export function currentLabel(clock) {
  if (!clock.segmentLabels?.length) return null;
  const n = clock.segmentLabels.length;
  let idx = progress(clock);
  if (idx >= n) idx = n - 1;
  if (idx < 0) idx = 0;
  return clock.segmentLabels[idx] ?? null;
}

/** Label of the state a repeating or filling clock reaches on its next tick, or null. */
export function nextLabel(clock) {
  if (!clock.segmentLabels?.length) return null;
  const n = clock.segmentLabels.length;
  let idx = progress(clock) + 1;
  if (idx >= n) {
    if (clock.onComplete !== "repeat") return null;
    idx = idx % n;
  }
  return clock.segmentLabels[idx] ?? null;
}

/** Most recent audit entry, or null. */
export function lastChange(clock) {
  return clock.log?.[0] ?? null;
}

/** Highest threshold reached so far, or null. */
export function reachedThreshold(clock) {
  let hit = null;
  for (const t of clock.thresholds) {
    const reached = clock.direction === "drain" ? clock.filled <= t.at : clock.filled >= t.at;
    if (reached) hit = t;
  }
  return hit;
}

function thresholdsCrossed(clock, prev, next) {
  const reached = [];
  const cleared = [];
  for (const t of clock.thresholds) {
    if (clock.direction === "drain") {
      if (prev > t.at && next <= t.at) reached.push(t);
      else if (prev <= t.at && next > t.at) cleared.push(t);
    } else {
      if (prev < t.at && next >= t.at) reached.push(t);
      else if (prev >= t.at && next < t.at) cleared.push(t);
    }
  }
  return { reached, cleared };
}

function makeLogEntry(clock, delta, context) {
  return {
    at: context.now ?? new Date().toISOString(),
    campaignMoment: normalizeMoment(context.moment),
    worldTime: Number.isFinite(context.worldTime) ? context.worldTime : null,
    userId: context.userId ?? null,
    source: context.source ?? "manual",
    delta,
    filled: clock.filled,
    note: context.note ?? ""
  };
}

export function appendLog(clock, entry) {
  clock.log = [entry, ...(clock.log ?? [])].slice(0, LOG_MAX);
  return clock;
}

/**
 * Apply a progress delta. Positive delta moves toward completion regardless of
 * direction; negative moves away. Returns the new clock and the events it
 * produced. Never mutates the input.
 *
 * context: { source, userId, moment, worldTime, now, note }
 */
export function applyDelta(input, delta, context = {}) {
  const clock = structuredClone(input);
  const events = [];
  const d = Math.trunc(Number(delta) || 0);
  if (d === 0) return { clock, events, changed: false };

  const wasComplete = isComplete(clock);
  if (wasComplete && d > 0 && (clock.onComplete === "stop" || clock.onComplete === "stayFull")) {
    return { clock, events, changed: false };
  }

  const sign = clock.direction === "drain" ? -1 : 1;
  const prevFilled = clock.filled;
  const prevLabel = currentLabel(clock);
  let target = prevFilled + sign * d;
  let completions = 0;

  if (clock.onComplete === "repeat" && d > 0) {
    // Wrap around, counting completions.
    let prog = progress(clock) + d;
    completions = Math.floor(prog / clock.segments);
    prog = prog % clock.segments;
    target = clock.direction === "drain" ? clock.segments - prog : prog;
  } else {
    target = Math.min(clock.segments, Math.max(0, target));
  }

  if (target === prevFilled && completions === 0) return { clock, events, changed: false };

  const crossed = thresholdsCrossed(clock, prevFilled, target);
  clock.filled = target;

  appendLog(clock, makeLogEntry(clock, d, context));
  events.push({ type: "advanced", delta: d, filled: clock.filled, previousFilled: prevFilled });

  for (const t of crossed.reached) events.push({ type: "thresholdReached", threshold: t });
  for (const t of crossed.cleared) events.push({ type: "thresholdCleared", threshold: t });

  const nowComplete = isComplete(clock);
  if (clock.onComplete === "repeat") {
    for (let i = 0; i < completions; i++) events.push({ type: "completed", repeat: true });
    if (completions > 0) { clock.completedAt = context.moment ?? context.now ?? new Date().toISOString(); clock.dismissed = false; }
  } else if (nowComplete && !wasComplete) {
    clock.completedAt = context.moment ?? context.now ?? new Date().toISOString();
    clock.dismissed = false;
    events.push({ type: "completed" });
    if (clock.onComplete === "reset") {
      clock.filled = startValue(clock);
      events.push({ type: "reset", automatic: true });
    }
  } else if (!nowComplete && wasComplete) {
    clock.completedAt = null;
  }

  const newLabel = currentLabel(clock);
  if (clock.segmentLabels?.length && newLabel !== prevLabel) {
    events.push({ type: "weatherChanged", previousLabel: prevLabel, label: newLabel });
  }

  touch(clock, context);
  return { clock, events, changed: true };
}

function touch(clock, context) {
  clock.updatedAt = context.now ?? new Date().toISOString();
}

/** Set filled to an exact value. */
export function setFilled(input, value, context = {}) {
  const clock = structuredClone(input);
  const target = Math.min(clock.segments, Math.max(0, Math.trunc(Number(value) || 0)));
  const prog = clock.direction === "drain" ? clock.segments - target : target;
  let delta = prog - progress(clock);
  if (clock.onComplete === "repeat" && delta < 0) delta += clock.segments; // move forward around the dial
  if (delta === 0) return { clock, events: [], changed: false };
  if (isComplete(clock) && delta > 0) return { clock, events: [], changed: false };
  return applyDelta(clock, delta, { ...context, source: context.source ?? "manual" });
}

/** Reset to the start value and clear completion. */
export function resetClock(input, context = {}) {
  const clock = structuredClone(input);
  const prevFilled = clock.filled;
  const prevLabel = currentLabel(clock);
  clock.filled = startValue(clock);
  clock.completedAt = null;
  clock.dismissed = false;
  for (const id of Object.keys(clock.triggerState ?? {})) {
    clock.triggerState[id] = { ...clock.triggerState[id], fired: false };
  }
  appendLog(clock, makeLogEntry(clock, -(prevFilled - clock.filled) * (clock.direction === "drain" ? -1 : 1), { ...context, note: context.note ?? "reset" }));
  const events = [{ type: "reset" }];
  const newLabel = currentLabel(clock);
  if (clock.segmentLabels?.length && newLabel !== prevLabel) {
    events.push({ type: "weatherChanged", previousLabel: prevLabel, label: newLabel });
  }
  touch(clock, context);
  return { clock, events, changed: true };
}

/** Complete immediately (fill or drain to the end). */
export function completeClock(input, context = {}) {
  if (isComplete(input)) return { clock: structuredClone(input), events: [], changed: false };
  // For a repeating clock this completes the current cycle and wraps (D10).
  return applyDelta(input, remaining(input), context);
}

/** Append a note to the audit log without moving the clock. */
export function annotateClock(input, note, context = {}) {
  const clock = structuredClone(input);
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) return { clock, events: [], changed: false };
  appendLog(clock, makeLogEntry(clock, 0, { ...context, note: text }));
  touch(clock, context);
  return { clock, events: [{ type: "annotated", note: text }], changed: true };
}

export function dismissClock(input, context = {}) {
  const clock = structuredClone(input);
  clock.dismissed = true;
  touch(clock, context);
  return { clock, events: [], changed: true };
}

/** Change kind, applying only presentation defaults that the user has not customised. */
export function changeKind(input, kind) {
  const clock = structuredClone(input);
  const oldPreset = kindPreset(clock.kind);
  const newPreset = kindPreset(kind);
  clock.kind = kind;
  if (clock.icon === oldPreset.icon) clock.icon = newPreset.icon;
  if (clock.color === oldPreset.color) clock.color = newPreset.color;
  if (clock.onComplete === oldPreset.onComplete) clock.onComplete = newPreset.onComplete;
  if (clock.direction === oldPreset.direction) clock.direction = newPreset.direction;
  if (kind === "alarm") { clock.segments = 1; clock.filled = 0; clock.thresholds = []; clock.segmentLabels = []; }
  else if (input.kind === "alarm") { clock.segments = newPreset.segments; clock.filled = startValue(clock); }
  if (kind === "weather" && !clock.segmentLabels.length) clock.segmentLabels = newPreset.segmentLabels.slice(0, clock.segments);
  if (kind === "threat" && !clock.thresholds.length) clock.thresholds = newPreset.thresholds.filter(t => t.at <= clock.segments);
  return normalizeClock(clock);
}

/** Sort comparator for the board. */
export function compareClocks(a, b) {
  return (a.group || "").localeCompare(b.group || "")
    || (a.sortOrder - b.sortOrder)
    || a.name.localeCompare(b.name);
}
