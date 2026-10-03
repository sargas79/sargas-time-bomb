import { test } from "node:test";
import assert from "node:assert/strict";
import { exportEnvelope, parseImport } from "../scripts/services/portability-service.js";
import { createClock } from "../scripts/services/clock-service.js";
import { EXPORT_FORMAT_VERSION, MODULE_ID } from "../scripts/constants.js";

test("export envelope carries module, format and clocks", () => {
  const clocks = [createClock({ kind: "progress", name: "a" })];
  const env = exportEnvelope(clocks, { moduleVersion: "1.0.0", now: "2026-01-01T00:00:00.000Z", state: { lastProcessedMoment: null } });
  assert.equal(env.module, MODULE_ID);
  assert.equal(env.format, EXPORT_FORMAT_VERSION);
  assert.equal(env.clocks.length, 1);
  assert.equal(env.exportedAt, "2026-01-01T00:00:00.000Z");
  const noLog = exportEnvelope(clocks, { includeLog: false });
  assert.deepEqual(noLog.clocks[0].log, []);
});

test("import round-trips and regenerates ids, remapping linked triggers", () => {
  const a = createClock({ kind: "progress", name: "a", id: "a" });
  const b = createClock({ kind: "progress", name: "b", id: "b", triggers: [{ id: "l", type: "linked", advance: 1, clockId: "a", when: "completed" }] });
  const env = exportEnvelope([a, b]);
  let n = 0;
  const r = parseImport(JSON.stringify(env), { idGen: () => `new${n++}` });
  assert.equal(r.ok, true);
  assert.equal(r.clocks.length, 2);
  assert.notEqual(r.clocks[0].id, "a");
  assert.equal(r.clocks[1].triggers[0].clockId, r.clocks[0].id);
});

test("import refuses newer formats and bad json", () => {
  assert.equal(parseImport("{not json").ok, false);
  const newer = parseImport({ module: MODULE_ID, format: EXPORT_FORMAT_VERSION + 1, clocks: [] });
  assert.equal(newer.ok, false);
  assert.equal(newer.errors[0].code, "importNewer");
  assert.equal(parseImport({ module: MODULE_ID, format: 1 }).errors.at(-1).code, "importNoClocks");
  assert.equal(parseImport(42).ok, false);
});

test("import skips invalid clocks and keeps the rest; accepts a bare array", () => {
  const r = parseImport([{ kind: "progress", name: "fine", segments: 4 }, { kind: "progress", name: "broken", segments: 4, triggers: [{ type: "linked", advance: 1, clockId: "missing", when: "completed" }] }]);
  assert.equal(r.ok, true);
  assert.equal(r.clocks.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].index, 1);
});

test("import keeps existing ids unique", () => {
  const existing = [createClock({ kind: "progress", name: "x", id: "dup" })];
  const r = parseImport([{ id: "dup", kind: "progress", name: "y" }], { regenerateIds: false, existingClocks: existing });
  assert.equal(r.ok, true);
  assert.notEqual(r.clocks[0].id, "dup");
});
