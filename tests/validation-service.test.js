import { test } from "node:test";
import assert from "node:assert/strict";
import { validateClock, validateTrigger } from "../scripts/services/validation-service.js";
import { createClock, normalizeClock } from "../scripts/services/clock-service.js";
import { LIMITS } from "../scripts/constants.js";

const codes = r => r.errors.map(e => e.code);

test("a fresh clock validates", () => {
  const c = createClock({ kind: "progress", name: "ok" });
  assert.deepEqual(validateClock(c), { valid: true, errors: [] });
});

test("bounds are enforced", () => {
  const c = { ...createClock({ kind: "progress" }), segments: 99, filled: 100, name: "" };
  const r = validateClock(c);
  assert.ok(codes(r).includes("segmentsRange"));
  assert.ok(codes(r).includes("filledRange"));
  assert.ok(codes(r).includes("nameRequired"));
  const zero = { ...createClock({ kind: "progress", name: "z" }), segments: 0, filled: 0 };
  assert.ok(codes(validateClock(zero)).includes("segmentsRange"));
  const alarm = createClock({ kind: "alarm", name: "a" });
  assert.ok(validateClock(alarm).valid);
  assert.ok(codes(validateClock({ ...alarm, segments: 2 })).includes("alarmSegments"));
  const rep = { ...createClock({ kind: "progress", name: "r", segments: 4, onComplete: "repeat" }), filled: 4 };
  assert.ok(codes(validateClock(rep)).includes("repeatAtFull"));
  const labels = { ...createClock({ kind: "weather", name: "w" }), segmentLabels: ["a", "b"] };
  assert.ok(codes(validateClock(labels)).includes("segmentLabelsCount"));
  const effect = { ...createClock({ kind: "progress", name: "e", segments: 4 }), thresholds: [{ at: 2, label: "", note: "", effectUuid: "bad uuid!" }] };
  assert.ok(codes(validateClock(effect)).includes("thresholdEffect"));
});

test("threshold order, duplicates and range", () => {
  const c = { ...createClock({ kind: "progress", segments: 6, name: "t" }), thresholds: [{ at: 4, label: "" , note: ""}, { at: 2, label: "", note: "" }, { at: 2, label: "", note: "" }, { at: 9, label: "", note: "" }] };
  const r = validateClock(c);
  assert.ok(codes(r).includes("thresholdOrder"));
  assert.ok(codes(r).includes("thresholdDuplicate"));
  assert.ok(codes(r).includes("thresholdRange"));
  const many = { ...c, thresholds: Array.from({ length: 13 }, (_, i) => ({ at: i, label: "", note: "" })) };
  assert.ok(codes(validateClock({ ...many, segments: 48 })).includes("thresholdsMax"));
});

test("trigger shapes", () => {
  assert.deepEqual(validateTrigger({ type: "rest", advance: 1 }, 0), []);
  assert.ok(validateTrigger({ type: "time", advance: 1, every: {} }, 0).some(e => e.code === "triggerEvery"));
  assert.ok(validateTrigger({ type: "date", advance: "complete" }, 0).some(e => e.code === "triggerDateMissing"));
  assert.ok(validateTrigger({ type: "date", advance: "complete", at: { year: 1, month: 13, day: 1 } }, 0, { calendar: { monthLengths: [30, 30] } }).some(e => e.code === "triggerDateInvalid"));
  assert.ok(validateTrigger({ type: "hook", advance: 1, hook: "bad hook()" }, 0).some(e => e.code === "triggerHook"));
  assert.ok(validateTrigger({ type: "hook", advance: 1, hook: "sargas-time-bomb.clockAdvanced" }, 0).some(e => e.code === "triggerHookSelf"));
  assert.ok(validateTrigger({ type: "rest", advance: 0 }, 0).some(e => e.code === "triggerAdvance"));
  assert.ok(validateTrigger({ type: "rest", advance: 1000 }, 0).some(e => e.code === "triggerAdvance"));
  assert.ok(validateTrigger({ type: "nope", advance: 1 }, 0).some(e => e.code === "triggerType"));
  const c = normalizeClock({ kind: "progress", name: "x", triggers: Array.from({ length: 9 }, () => ({ type: "rest" })) });
  assert.equal(c.triggers.length, LIMITS.TRIGGERS_MAX);
});

test("linked triggers: missing target, self link, cycle, depth", () => {
  const a = normalizeClock({ id: "a", kind: "progress", name: "a", triggers: [{ id: "l", type: "linked", advance: 1, clockId: "zzz", when: "completed" }] });
  assert.ok(codes(validateClock(a, { allClocks: [a] })).includes("linkedMissing"));
  const self = normalizeClock({ id: "s", kind: "progress", name: "s", triggers: [{ id: "l", type: "linked", advance: 1, clockId: "s", when: "completed" }] });
  assert.ok(codes(validateClock(self, { allClocks: [self] })).includes("linkedSelf"));
  const x = normalizeClock({ id: "x", kind: "progress", name: "x", triggers: [{ id: "l", type: "linked", advance: 1, clockId: "y", when: "completed" }] });
  const y = normalizeClock({ id: "y", kind: "progress", name: "y", triggers: [{ id: "l", type: "linked", advance: 1, clockId: "x", when: "completed" }] });
  assert.ok(codes(validateClock(y, { allClocks: [x, y] })).includes("linkedCycle"));
  const chain = [];
  for (let i = 0; i < 7; i++) chain.push(normalizeClock({ id: `c${i}`, kind: "progress", name: `c${i}`, triggers: i ? [{ id: "l", type: "linked", advance: 1, clockId: `c${i - 1}`, when: "completed" }] : [] }));
  assert.ok(codes(validateClock(chain[6], { allClocks: chain })).includes("linkedDepth"));
});

test("clock count limit applies to new clocks", () => {
  const all = Array.from({ length: LIMITS.CLOCKS_MAX }, (_, i) => createClock({ kind: "progress", name: `c${i}` }));
  const c = createClock({ kind: "progress", name: "new" });
  assert.ok(codes(validateClock(c, { allClocks: all, isNew: true })).includes("clocksMax"));
  assert.ok(validateClock(c, { allClocks: all, isNew: false }).valid);
});
