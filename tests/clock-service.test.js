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

test("alarm has one segment and actor-owners needs an actor", () => {
  const a = normalizeClock({ kind: "alarm", segments: 12 });
  assert.equal(a.segments, 1);
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
  assert.equal(w.segmentLabels.length, w.segments, "exactly one label per segment");
  assert.equal(currentLabel(w), "Clear");
  let r = applyDelta(w, 1, ctx);
  assert.equal(currentLabel(r.clock), "Breezy");
  const ev = r.events.find(e => e.type === "weatherChanged");
  assert.deepEqual([ev.previousLabel, ev.label], ["Clear", "Breezy"]);
  r = applyDelta(r.clock, 4, ctx);
  assert.equal(currentLabel(r.clock), "Clearing");
  r = applyDelta(r.clock, 1, ctx); // after Clearing the next tick completes a cycle and wraps to Clear
  assert.equal(r.clock.filled, 0);
  assert.equal(currentLabel(r.clock), "Clear");
  assert.ok(r.events.some(e => e.type === "completed" && e.repeat));
});

test("repeating clocks never store a full state, in both directions (D10)", () => {
  const fill = normalizeClock({ kind: "progress", segments: 4, onComplete: "repeat", filled: 4 });
  assert.equal(fill.filled, 0, "normalisation wraps a stored full state");
  assert.equal(isComplete(fill), false);
  let r = applyDelta(fill, 4, ctx);
  assert.equal(r.clock.filled, 0);
  assert.equal(r.events.filter(e => e.type === "completed").length, 1);
  r = completeClock(fill, ctx);
  assert.equal(r.clock.filled, 0, "complete wraps instead of resting at full");
  r = setFilled(fill, 4, ctx);
  assert.equal(r.clock.filled, 0, "set to full wraps too");

  const drain = normalizeClock({ kind: "countdown", segments: 4, onComplete: "repeat", filled: 0 });
  assert.equal(drain.filled, 4, "drain repeat never rests at empty");
  r = applyDelta(drain, 4, ctx);
  assert.equal(r.clock.filled, 4);
  assert.equal(r.events.filter(e => e.type === "completed").length, 1);
  r = applyDelta(drain, 5, ctx);
  assert.equal(r.clock.filled, 3);
});

test("alarm is not complete until its first fire; repeat re-arms by wrapping", () => {
  const a = createClock({ kind: "alarm" });
  assert.equal(a.segments, 1);
  assert.equal(isComplete(a), false);
  const r = applyDelta(a, 1, { ...ctx, moment: { year: 1, month: 1, day: 1, hour: 0, minute: 0 } });
  assert.equal(r.clock.filled, 1);
  assert.ok(isComplete(r.clock));
  assert.ok(r.events.some(e => e.type === "completed"));
  assert.equal(applyDelta(r.clock, 1, ctx).changed, false, "a fired alarm stays fired");
  const back = applyDelta(r.clock, -1, ctx);
  assert.equal(isComplete(back.clock), false);
  const recurring = normalizeClock({ kind: "alarm", onComplete: "repeat" });
  const fired = applyDelta(recurring, 1, ctx);
  assert.equal(fired.clock.filled, 0, "recurring alarm wraps back to empty");
  assert.ok(fired.events.some(e => e.type === "completed"));
});

test("thresholds may carry an effect link that is never applied", () => {
  const c = normalizeClock({ kind: "corruption", segments: 6, actorUuid: "Actor.a", thresholds: [{ at: 3, label: "Drained", effectUuid: "Compendium.pf2e.conditionitems.Item.abc" }, { at: 6, label: "x", effectUuid: 42 }] });
  assert.equal(c.thresholds[0].effectUuid, "Compendium.pf2e.conditionitems.Item.abc");
  assert.equal(c.thresholds[1].effectUuid, null);
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
  assert.equal(a.segments, 1);
  assert.equal(changeKind(a, "progress").segments, 6);
  const custom = changeKind({ ...c, icon: "fa-solid fa-cat" }, "weather");
  assert.equal(custom.icon, "fa-solid fa-cat");
  assert.equal(custom.segmentLabels.length, 6);
});
