import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTriggerUpdates, checkLinkChain, describeTrigger, evaluate } from "../scripts/services/trigger-service.js";
import { normalizeClock } from "../scripts/services/clock-service.js";

const CAL = { monthLengths: [30, 30, 30], monthBase: 1 };
const DAY = 86400;
const mk = (triggers, extra = {}) => normalizeClock({ kind: "progress", segments: 8, triggers, ...extra });

test("scene trigger: any scene, listed scenes, same-scene re-activation ignored", () => {
  const c = mk([{ id: "t", type: "scene", advance: 2 }]);
  assert.equal(evaluate(c, { type: "scene", sceneId: "s1", previousSceneId: "s0" }).delta, 2);
  assert.equal(evaluate(c, { type: "scene", sceneId: "s1", previousSceneId: "s1" }).delta, 0);
  const listed = mk([{ id: "t", type: "scene", advance: 1, scenes: ["s9"] }]);
  assert.equal(evaluate(listed, { type: "scene", sceneId: "s1" }).delta, 0);
  assert.equal(evaluate(listed, { type: "scene", sceneId: "s9" }).delta, 1);
});

test("rest trigger and advance keywords", () => {
  const any = mk([{ id: "t", type: "rest", advance: 1 }]);
  assert.equal(evaluate(any, { type: "rest", actors: ["Actor.a", "Actor.b"] }).delta, 1, "a party rest is one rest");
  assert.equal(evaluate(any, { type: "scene", sceneId: "s" }).delta, 0);
  const comp = mk([{ id: "t", type: "rest", advance: "complete" }]);
  const r = evaluate(comp, { type: "rest", actors: [] });
  assert.equal(r.complete, true);
  assert.deepEqual(r.matched, ["t"]);
  const reset = mk([{ id: "t", type: "rest", advance: "reset" }]);
  assert.equal(evaluate(reset, { type: "rest" }).reset, true);
});

test("time trigger buckets elapsed seconds with carry across events", () => {
  let c = mk([{ id: "t", type: "time", advance: 1, every: { days: 1 } }]);
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const r = evaluate(c, { type: "time", seconds: 8 * 3600, calendar: CAL });
    total += r.delta;
    c = { ...c, triggerState: r.triggerState };
  }
  assert.equal(total, 1);
  assert.equal(c.triggerState.t.carrySeconds, 0);
  const eight = mk([{ id: "t", type: "time", advance: 1, every: { hours: 8 } }]);
  assert.equal(evaluate(eight, { type: "time", seconds: DAY, calendar: CAL }).delta, 3);
  // rewind never ticks
  assert.equal(evaluate(eight, { type: "time", seconds: -DAY, calendar: CAL }).delta, 0);
});

test("time trigger with once fires a single time", () => {
  let c = mk([{ id: "t", type: "time", advance: "complete", every: { hours: 1 }, once: true }]);
  let r = evaluate(c, { type: "time", seconds: 5 * 3600, calendar: CAL });
  assert.equal(r.complete, true);
  c = { ...c, triggerState: r.triggerState };
  r = evaluate(c, { type: "time", seconds: 5 * 3600, calendar: CAL });
  assert.equal(r.complete, false);
  assert.equal(r.delta, 0);
});

test("date trigger fires once when the moment is reached, then re-arms when repeating", () => {
  const at = { year: 1, month: 2, day: 1, hour: 7, minute: 0 };
  let c = mk([{ id: "d", type: "date", at }]);
  assert.equal(c.triggers[0].advance, "complete");
  let r = evaluate(c, { type: "time", seconds: DAY, to: { year: 1, month: 1, day: 30, hour: 0, minute: 0 }, calendar: CAL });
  assert.equal(r.complete, false);
  r = evaluate(c, { type: "time", seconds: DAY, to: { year: 1, month: 2, day: 1, hour: 7, minute: 0 }, calendar: CAL });
  assert.equal(r.complete, true);
  c = { ...c, triggerState: r.triggerState };
  r = evaluate(c, { type: "time", seconds: DAY, to: { year: 1, month: 2, day: 5, hour: 0, minute: 0 }, calendar: CAL });
  assert.equal(r.complete, false, "already fired");

  let rep = mk([{ id: "d", type: "date", advance: 1, at, repeatEvery: { days: 1 } }]);
  // Due on day 1; from day 2 08:00 to day 3 08:00 only day 3's occurrence is new -> 2 in total.
  r = evaluate(rep, { type: "time", seconds: DAY, from: { year: 1, month: 2, day: 2, hour: 8, minute: 0 }, to: { year: 1, month: 2, day: 3, hour: 8, minute: 0 }, calendar: CAL });
  assert.equal(r.delta, 2);
  assert.deepEqual(r.triggerUpdates.d.at, { year: 1, month: 2, day: 4, hour: 7, minute: 0 });
  rep = applyTriggerUpdates({ ...rep, triggerState: r.triggerState }, r.triggerUpdates);
  assert.deepEqual(rep.triggers[0].at, { year: 1, month: 2, day: 4, hour: 7, minute: 0 });
  r = evaluate(rep, { type: "time", seconds: 60, to: { year: 1, month: 2, day: 3, hour: 9, minute: 0 }, calendar: CAL });
  assert.equal(r.delta, 0);
  // no calendar moment -> date triggers are inert
  r = evaluate(rep, { type: "time", seconds: DAY, to: null, calendar: CAL });
  assert.equal(r.delta, 0);
});

test("hook trigger matches by name and roll filter", () => {
  const c = mk([{ id: "h", type: "hook", advance: 1, hook: "deleteCombat" }]);
  assert.equal(evaluate(c, { type: "hook", hook: "deleteCombat" }).delta, 1);
  assert.equal(evaluate(c, { type: "hook", hook: "combatRound" }).delta, 0);
  const roll = mk([{ id: "h", type: "hook", advance: 1, hook: "createChatMessage", filter: "roll" }]);
  assert.equal(evaluate(roll, { type: "hook", hook: "createChatMessage", isRoll: false }).delta, 0);
  assert.equal(evaluate(roll, { type: "hook", hook: "createChatMessage", isRoll: true }).delta, 1);
});

test("linked trigger matches target clock and when", () => {
  const c = mk([{ id: "l", type: "linked", advance: "reset", clockId: "rival", when: "completed" }]);
  assert.equal(evaluate(c, { type: "linked", clockId: "rival", when: "completed" }).reset, true);
  assert.equal(evaluate(c, { type: "linked", clockId: "other", when: "completed" }).reset, false);
  const th = mk([{ id: "l", type: "linked", advance: 1, clockId: "rival", when: "threshold", at: 4 }]);
  assert.equal(evaluate(th, { type: "linked", clockId: "rival", when: "threshold", at: 2 }).delta, 0);
  assert.equal(evaluate(th, { type: "linked", clockId: "rival", when: "threshold", at: 4 }).delta, 1);
});

test("linked trigger with any threshold matches every threshold", () => {
  const any = normalizeClock({ kind: "progress", segments: 8, triggers: [{ id: "l", type: "linked", advance: 1, clockId: "rival", when: "threshold", at: null }] });
  assert.equal(any.triggers[0].at, null);
  assert.equal(evaluate(any, { type: "linked", clockId: "rival", when: "threshold", at: 2 }).delta, 1);
  assert.equal(evaluate(any, { type: "linked", clockId: "rival", when: "threshold", at: 6 }).delta, 1);
});

test("repeating date trigger counts every occurrence inside a long step", () => {
  const at = { year: 1, month: 1, day: 2, hour: 7, minute: 0 };
  const rep = mk([{ id: "d", type: "date", advance: 1, at, repeatEvery: { days: 1 } }]);
  // From day 1 to day 5: due day 2, then days 3, 4, 5 -> 4 occurrences; re-armed at day 6.
  const r = evaluate(rep, { type: "time", seconds: 4 * DAY, from: { year: 1, month: 1, day: 1, hour: 7, minute: 0 }, to: { year: 1, month: 1, day: 5, hour: 7, minute: 0 }, calendar: CAL });
  assert.equal(r.delta, 4);
  assert.deepEqual(r.triggerUpdates.d.at, { year: 1, month: 1, day: 6, hour: 7, minute: 0 });
  // A long-overdue first occurrence fires once, not once per missed period before `from`.
  const stale = mk([{ id: "d", type: "date", advance: 1, at: { year: 1, month: 1, day: 1, hour: 0, minute: 0 }, repeatEvery: { hours: 1 } }]);
  const r2 = evaluate(stale, { type: "time", seconds: 3600, from: { year: 1, month: 1, day: 10, hour: 0, minute: 0 }, to: { year: 1, month: 1, day: 10, hour: 1, minute: 0 }, calendar: CAL });
  assert.equal(r2.delta, 2);
});

test("checkLinkChain detects cycles and depth", () => {
  const chain = [];
  for (let i = 0; i < 7; i++) chain.push(mk(i ? [{ id: "l", type: "linked", advance: 1, clockId: `c${i - 1}`, when: "completed" }] : [], { id: `c${i}` }));
  const r = checkLinkChain("c0", chain);
  assert.equal(r.ok, false);
  assert.equal(r.cycle, false);
  const okChain = chain.slice(0, 5);
  assert.equal(checkLinkChain("c0", okChain).ok, true);
  const a = mk([{ id: "l", type: "linked", advance: 1, clockId: "b", when: "completed" }], { id: "a" });
  const b = mk([{ id: "l", type: "linked", advance: 1, clockId: "a", when: "completed" }], { id: "b" });
  assert.equal(checkLinkChain("a", [a, b]).cycle, true);
  // A racing pair linked both ways with reset is not a cycle: resets do not propagate.
  const ra = mk([{ id: "l", type: "linked", advance: "reset", clockId: "rb", when: "completed" }], { id: "ra" });
  const rb = mk([{ id: "l", type: "linked", advance: "reset", clockId: "ra", when: "completed" }], { id: "rb" });
  assert.equal(checkLinkChain("ra", [ra, rb]).ok, true);
});

test("describeTrigger returns i18n keys", () => {
  assert.equal(describeTrigger({ type: "rest" }).key, "rest");
  assert.equal(describeTrigger({ type: "time", every: { hours: 6 } }).key, "timeEvery");
  assert.equal(describeTrigger({ type: "date", repeatEvery: { days: 1 } }).key, "dateRepeat");
  assert.equal(describeTrigger({}).key, "unknown");
});
