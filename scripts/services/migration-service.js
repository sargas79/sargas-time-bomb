/**
 * Pure schema migrations. Schema 0 is "anything stored before the schemaVersion
 * field existed" (early prototypes used `max`/`value`/`private`).
 */
import { CURRENT_SCHEMA_VERSION, VISIBILITY } from "../constants.js";
import { normalizeClock } from "./clock-service.js";

export function detectSchemaVersion(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const v = Number(raw.schemaVersion);
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

const CLOCK_STEPS = {
  // 0 -> 1
  0(raw) {
    const out = { ...raw };
    if (out.segments === undefined && out.max !== undefined) out.segments = out.max;
    if (out.filled === undefined && out.value !== undefined) out.filled = out.value;
    if (out.visibility === undefined) {
      if (out.private === true || out.hidden === true) out.visibility = VISIBILITY.GM_ONLY;
      else if (out.private === false || out.hidden === false || out.visible === true) out.visibility = VISIBILITY.PLAYERS;
    }
    if (out.type && !out.kind) out.kind = out.type;
    if (Array.isArray(out.history) && !out.log) out.log = out.history;
    if (typeof out.title === "string" && !out.name) out.name = out.title;
    delete out.max; delete out.value; delete out.private; delete out.hidden; delete out.visible;
    delete out.type; delete out.history; delete out.title;
    out.schemaVersion = 1;
    return out;
  }
};

/**
 * Migrate a single raw clock to the current schema and normalise it.
 * Returns { clock, migrated: boolean, from: number }.
 */
export function migrateClock(raw, options = {}) {
  let from = detectSchemaVersion(raw);
  let working = raw && typeof raw === "object" ? { ...raw } : {};
  let v = from;
  if (v > CURRENT_SCHEMA_VERSION) {
    // Newer than we know: keep the data, normalise defensively, flag it.
    return { clock: normalizeClock(working, options), migrated: false, from, newer: true };
  }
  while (v < CURRENT_SCHEMA_VERSION) {
    const step = CLOCK_STEPS[v];
    if (!step) break;
    working = step(working);
    v += 1;
  }
  working.schemaVersion = CURRENT_SCHEMA_VERSION;
  return { clock: normalizeClock(working, options), migrated: from !== CURRENT_SCHEMA_VERSION, from, newer: false };
}

export function migrateClocks(rawList, options = {}) {
  const list = Array.isArray(rawList) ? rawList : [];
  let migrated = false;
  let newer = 0; // clocks saved by a newer schema than this version knows
  const clocks = [];
  for (const raw of list) {
    const r = migrateClock(raw, options);
    if (r.migrated) migrated = true;
    if (r.newer) newer++;
    clocks.push(r.clock);
  }
  return { clocks, migrated, newer };
}

export function defaultState() {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, lastProcessedMoment: null, lastProcessedWorldTime: null, lastRewindNoticeAt: null };
}

export function migrateState(raw) {
  const s = raw && typeof raw === "object" ? { ...raw } : {};
  const from = detectSchemaVersion(s);
  const out = defaultState();
  if (s.lastProcessedMoment && typeof s.lastProcessedMoment === "object") out.lastProcessedMoment = s.lastProcessedMoment;
  if (Number.isFinite(s.lastProcessedWorldTime)) out.lastProcessedWorldTime = s.lastProcessedWorldTime;
  if (s.lastRewindNoticeAt) out.lastRewindNoticeAt = s.lastRewindNoticeAt;
  return { state: out, migrated: from !== CURRENT_SCHEMA_VERSION };
}
