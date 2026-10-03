/**
 * Pure export/import envelope.
 */
import { CURRENT_SCHEMA_VERSION, EXPORT_FORMAT_VERSION, LIMITS, MODULE_ID } from "../constants.js";
import { migrateClock } from "./migration-service.js";
import { validateClock } from "./validation-service.js";

export function exportEnvelope(clocks, { moduleVersion = "0.0.0", state = null, now = new Date().toISOString(), includeLog = true } = {}) {
  return {
    module: MODULE_ID,
    moduleVersion,
    format: EXPORT_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: now,
    state: state ? { lastProcessedMoment: state.lastProcessedMoment ?? null, lastProcessedWorldTime: state.lastProcessedWorldTime ?? null } : null,
    clocks: (clocks ?? []).map(c => includeLog ? c : { ...c, log: [] })
  };
}

/**
 * Parse an import payload (string or object).
 * options: { regenerateIds, existingClocks, idGen, calendar }
 * Returns { ok, clocks, errors: [{code, data}], skipped: [{ index, errors }] , state }
 */
export function parseImport(payload, { regenerateIds = true, existingClocks = [], idGen, calendar = null } = {}) {
  const errors = [];
  let data = payload;
  if (typeof payload === "string") {
    try { data = JSON.parse(payload); }
    catch (e) { return { ok: false, clocks: [], errors: [{ code: "importJson", data: { message: e.message } }], skipped: [], state: null }; }
  }
  if (!data || typeof data !== "object") return { ok: false, clocks: [], errors: [{ code: "importShape" }], skipped: [], state: null };

  // Accept a bare array of clocks as well as the envelope.
  let list;
  if (Array.isArray(data)) list = data;
  else {
    if (data.module && data.module !== MODULE_ID) errors.push({ code: "importModule", data: { module: data.module } });
    if (Number.isFinite(data.format) && data.format > EXPORT_FORMAT_VERSION) {
      return { ok: false, clocks: [], errors: [{ code: "importNewer", data: { format: data.format, supported: EXPORT_FORMAT_VERSION } }], skipped: [], state: null };
    }
    if (Number.isFinite(data.schemaVersion) && data.schemaVersion > CURRENT_SCHEMA_VERSION) {
      return { ok: false, clocks: [], errors: [{ code: "importNewerSchema", data: { schemaVersion: data.schemaVersion, supported: CURRENT_SCHEMA_VERSION } }], skipped: [], state: null };
    }
    list = Array.isArray(data.clocks) ? data.clocks : null;
  }
  if (!list) return { ok: false, clocks: [], errors: [...errors, { code: "importNoClocks" }], skipped: [], state: null };

  const existingIds = new Set(existingClocks.map(c => c.id));
  const clocks = [];
  const skipped = [];
  const idMap = new Map();
  const opts = idGen ? { idGen } : {};

  // First pass: migrate + assign ids.
  const staged = list.map((raw, index) => {
    const { clock } = migrateClock(raw, opts);
    const oldId = clock.id;
    if (regenerateIds || existingIds.has(clock.id)) {
      clock.id = opts.idGen ? opts.idGen() : clock.id + "-" + Math.random().toString(36).slice(2, 8);
    }
    idMap.set(oldId, clock.id);
    return { index, clock };
  });
  // Second pass: remap linked triggers inside the imported set.
  for (const { clock } of staged) {
    for (const t of clock.triggers) {
      if (t.type === "linked" && idMap.has(t.clockId)) t.clockId = idMap.get(t.clockId);
    }
  }
  const all = [...existingClocks, ...staged.map(s => s.clock)];
  for (const { index, clock } of staged) {
    const v = validateClock(clock, { allClocks: all, calendar });
    if (!v.valid) { skipped.push({ index, name: clock.name, errors: v.errors }); continue; }
    clocks.push(clock);
  }
  if (existingClocks.length + clocks.length > LIMITS.CLOCKS_MAX) {
    return { ok: false, clocks: [], errors: [...errors, { code: "importTooMany", data: { max: LIMITS.CLOCKS_MAX } }], skipped, state: null };
  }
  const state = !Array.isArray(data) && data.state && typeof data.state === "object" ? data.state : null;
  return { ok: true, clocks, errors, skipped, state };
}
