import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSchemaVersion, migrateClock, migrateClocks, migrateState } from "../scripts/services/migration-service.js";
import { CURRENT_SCHEMA_VERSION } from "../scripts/constants.js";

test("schema 0 prototypes migrate to 1", () => {
  const raw = { id: "old1", title: "Old clock", max: 6, value: 2, private: true, type: "threat", history: [{ delta: 1, filled: 1 }] };
  const r = migrateClock(raw);
  assert.equal(r.migrated, true);
  assert.equal(r.from, 0);
  assert.equal(r.clock.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(r.clock.name, "Old clock");
  assert.equal(r.clock.segments, 6);
  assert.equal(r.clock.filled, 2);
  assert.equal(r.clock.visibility, "gm-only");
  assert.equal(r.clock.kind, "threat");
  assert.equal(r.clock.log.length, 1);
});

test("current schema passes through unchanged", () => {
  const r = migrateClock({ schemaVersion: 1, id: "a", kind: "progress", name: "n", segments: 4, filled: 1 });
  assert.equal(r.migrated, false);
  assert.equal(r.clock.filled, 1);
});

test("newer schema is kept but flagged", () => {
  const r = migrateClock({ schemaVersion: 99, id: "a", kind: "progress", name: "n", segments: 4 });
  assert.equal(r.newer, true);
  assert.equal(r.clock.name, "n");
});

test("migrateClocks reports whether anything changed", () => {
  const r = migrateClocks([{ schemaVersion: 1, kind: "progress", name: "a" }, { max: 4, value: 1 }]);
  assert.equal(r.migrated, true);
  assert.equal(r.clocks.length, 2);
  assert.equal(migrateClocks(null).clocks.length, 0);
  assert.equal(detectSchemaVersion("junk"), 0);
});

test("migrateState keeps processed moments", () => {
  const r = migrateState({ lastProcessedMoment: { year: 1, month: 1, day: 1 }, lastProcessedWorldTime: 42 });
  assert.equal(r.migrated, true);
  assert.deepEqual(r.state.lastProcessedMoment, { year: 1, month: 1, day: 1 });
  assert.equal(r.state.lastProcessedWorldTime, 42);
  assert.equal(migrateState(null).state.lastProcessedMoment, null);
});
