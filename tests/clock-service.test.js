import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDelta, changeKind, completeClock, createClock, currentLabel, isComplete, normalizeClock,
  reachedThreshold, remaining, resetClock, setFilled
} from "../scripts/services/clock-service.js";
import { LIMITS } from "../scripts/constants.js";

const ctx = { now: "2026-01-01T00:00:00.000Z", userId: "u1", source: "manual" };

test("createClock applies kind presets", () => {
  const c = createClock({ kind: "threat", name: "Doom" }, { now: ctx.now });
  assert.equal(c.segments, 8);
  assert.equal(c.thresholds.length, 4);
  assert.equal(c.visibility, "gm-only");
  assert.equal(c.schemaVersion, 1);
  assert.ok(c.id);
  const w = createClock({ kind: "weather" });
  assert.equal(w.segmentLabels.length, 6);
  assert.equal(w.triggers[0].type, "time");
  assert.deepEqual(w.triggers[0].every, { hours: 6 });
});

test("normalizeClock clamps and repairs malformed input", () => {
  const c = normalizeClock({ kind: "bogus", segments: 999, filled: -4, direction: "sideways", name: "x".repeat(500), thresholds: [{ at: 99 }, { at: 2 }, { at: 2 }, "junk"], triggers: [{ type: "time", every: { days: "abc" } }] });
  assert.equal(c.kind, "progress");
  assert.equal(c.segments, LIMITS.SEGMENTS_MAX);
  assert.equal(c.filled, 0);
  assert.equal(c.direction, "fill");
  assert.equal(c.name.length, LIMITS.NAME_MAX);
  assert.deepEqual(c.thresholds.map(t => t.at), [2]);
  assert.deepEqual(c.triggers[0].every, { days: 1 });
  assert.ok(c.triggerState[c.triggers[0].id]);
});

test("alarm defaults to zero segments and actor-owners needs an actor", () => {
  const a = normalizeClock({ kind: "alarm" });
  assert.equal(a.segments, 0);
  const c = normalizeClock({ kind: "corruption", visibility: "actor-owners" });
  assert.equal(c.visibility, "gm-only");
  const c2 = normalizeClock({ kind: "corruption", visibility: "actor-owners", actorUuid: "Actor.abc" });
  assert.equal(c2.visibility, "actor-owners");
});

test("fill clock ticks, stops when full, and logs", () => {
  let c = createClock({ kind: "progress", segments: 4 });
  let r = applyDelta(c, 1, ctx);
  assert.equal(r.clock.filled, 1);
  assert.equal(r.events[0].type, "advanced");
  assert.equal(r.clock.log.length, 1);
  assert.equal(r.clock.log[0].delta, 1);
  r = applyDelta(r.clock, 10, ctx);
  assert.equal(r.clock.filled, 4);
  assert.ok(isComplete(r.clock));
  assert.ok(r.events.some(e => e.type === "completed"));
  assert.ok(r.clock.completedAt);
  const again = applyDelta(r.clock, 1, ctx);
  assert.equal(again.changed, false);
  const back = applyDelta(r.clock, -1, ctx);
  assert.equal(back.clock.filled, 3);
  assert.equal(back.clock.completedAt, null);
});

test("drain clock drains toward zero", () => {
  const c = createClock({ kind: "countdown", segments: 6 });
  assert.equal(c.filled, 6);
  assert.equal(remaining(c), 6);
  const r = applyDelta(c, 2, ctx);
  assert.equal(r.clock.filled, 4);
  assert.equal(remaining(r.clock), 4);
  const done = applyDelta(r.clock, 4, ctx);
  assert.ok(isComplete(done.clock));
});

test("thresholds are reached and cleared in both directions, including jumps", () => {
  const c = createClock({ kind: "threat", segments: 8 });
  const r = applyDelta(c, 5, ctx);
  const reached = r.events.filter(e => e.type === "thresholdReached").map(e => e.threshold.at);
  assert.deepEqual(reached, [2, 4]);
  assert.equal(reachedThreshold(r.clock).at, 4);
  const back = applyDelta(r.clock, -2, ctx);
  const cleared = back.events.filter(e => e.type === "thresholdCleared").map(e => e.threshold.at);
  assert.deepEqual(cleared, [4]);
  // drain thresholds
  const d = normalizeClock({ kind: "countdown", segments: 6, thresholds: [{ at: 3, label: "half" }] });
  const dr = applyDelta(d, 3, ctx);
  assert.equal(dr.events.filter(e => e.type === "thresholdReached").length, 1);
});

test("onComplete reset returns to start; repeat wraps and counts completions", () => {
  const reset = normalizeClock({ kind: "progress", segments: 4, onComplete: "reset" });
  const r = applyDelta(reset, 4, ctx);
  assert.ok(r.events.some(e => e.type === "completed"));
  assert.equal(r.clock.filled, 0);
  assert.ok(r.events.some(e => e.type === "reset"));

  const rep = normalizeClock({ kind: "progress", segments: 4, onComplete: "repeat", filled: 3 });
  const rr = applyDelta(rep, 6, ctx); // 3 + 6 = 9 -> 2 completions, lands on 1
  assert.equal(rr.clock.filled, 1);
  assert.equal(rr.events.filter(e => e.type === "completed").length, 2);
});

test("stayFull behaves like stop", () => {
  const c = normalizeClock({ kind: "corruption", segments: 6, actorUuid: "Actor.a" });
  const r = applyDelta(c, 6, ctx);
  assert.ok(isComplete(r.clock));
  assert.equal(applyDelta(r.clock, 1, ctx).changed, false);
});

test("weather front cycles through labels and emits weatherChanged", () => {
  const w = createClock({ kind: "weather" });
  assert.equal(currentLabel(w), "Clear");
  let r = applyDelta(w, 1, ctx);
  assert.equal(currentLabel(r.clock), "Overcast");
  const ev = r.events.find(e => e.type === "weatherChanged");
  assert.deepEqual([ev.previousLabel, ev.label], ["Clear", "Overcast"]);
  r = applyDelta(r.clock, 5, ctx); // wraps back to index 0
  assert.equal(r.clock.filled, 0);
  assert.equal(currentLabel(r.clock), "Clear");
});

test("alarm completes on any positive delta and re-arms on negative", () => {
  const a = createClock({ kind: "alarm" });
  assert.equal(isComplete(a), false);
  const r = applyDelta(a, 1, { ...ctx, moment: { year: 1, month: 1, day: 1, hour: 0, minute: 0 } });
  assert.ok(isComplete(r.clock));
  assert.ok(r.events.some(e => e.type === "completed"));
  const back = applyDelta(r.clock, -1, ctx);
  assert.equal(isComplete(back.clock), false);
});

test("setFilled, resetClock, completeClock", () => {
  const c = createClock({ kind: "progress", segments: 8 });
  const s = setFilled(c, 5, ctx);
  assert.equal(s.clock.filled, 5);
  const s2 = setFilled(s.clock, 2, ctx);
  assert.equal(s2.clock.filled, 2);
  const done = completeClock(s2.clock, ctx);
  assert.ok(isComplete(done.clock));
  const res = resetClock(done.clock, ctx);
  assert.equal(res.clock.filled, 0);
  assert.equal(res.clock.completedAt, null);
  assert.equal(res.events[0].type, "reset");
  const rep = normalizeClock({ kind: "weather", onComplete: "repeat", segments: 6 });
  const full = completeClock(rep, ctx);
  assert.equal(full.clock.onComplete, "repeat");
  assert.equal(full.clock.filled, 6);
});

test("log is capped at LOG_MAX newest first", () => {
  let c = normalizeClock({ kind: "progress", segments: 48, onComplete: "repeat" });
  for (let i = 0; i < 60; i++) c = applyDelta(c, 1, { ...ctx, now: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` }).clock;
  assert.equal(c.log.length, LIMITS.LOG_MAX);
  assert.equal(c.log[0].at, "2026-01-01T00:00:59.000Z");
});

test("changeKind swaps presets only where untouched", () => {
  const c = createClock({ kind: "progress", segments: 6 });
  const t = changeKind(c, "threat");
  assert.equal(t.kind, "threat");
  assert.equal(t.icon, "fa-solid fa-skull");
  assert.ok(t.thresholds.every(th => th.at <= 6));
  const a = changeKind(c, "alarm");
  assert.equal(a.segments, 0);
  const custom = changeKind({ ...c, icon: "fa-solid fa-cat" }, "weather");
  assert.equal(custom.icon, "fa-solid fa-cat");
  assert.equal(custom.segmentLabels.length, 6);
});
