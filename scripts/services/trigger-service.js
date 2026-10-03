/**
 * Pure trigger evaluation: given one clock and one event, how many progress
 * units move, and what per-trigger bookkeeping changes.
 *
 * Events:
 *   { type: "scene",  sceneId, previousSceneId }
 *   { type: "rest",   kind: "short"|"long"|string }
 *   { type: "time",   seconds, from: moment|null, to: moment|null, calendar }
 *   { type: "hook",   hook, args }
 *   { type: "linked", clockId, when: "completed"|"threshold", at }
 *
 * Result: { delta, complete, reset, matched: [triggerId], triggerState, triggerUpdates }
 */
import { LIMITS } from "../constants.js";
import { addSeconds, bucketElapsed, compareMoments, everyToSeconds } from "./schedule-service.js";

function emptyResult(clock) {
  return {
    delta: 0,
    complete: false,
    reset: false,
    matched: [],
    triggerState: structuredClone(clock.triggerState ?? {}),
    triggerUpdates: {}
  };
}

function applyAdvance(result, trigger, multiplier = 1) {
  if (trigger.advance === "complete") result.complete = true;
  else if (trigger.advance === "reset") result.reset = true;
  else result.delta += (Number(trigger.advance) || 0) * multiplier;
}

export function matchesScene(trigger, event) {
  if (!event.sceneId) return false;
  if (event.previousSceneId && event.previousSceneId === event.sceneId) return false;
  if (trigger.scenes?.length && !trigger.scenes.includes(event.sceneId)) return false;
  return true;
}

export function matchesRest(trigger, event) {
  return trigger.type === "rest" && event.type === "rest";
}

export function matchesHook(trigger, event) {
  if (!trigger.hook || trigger.hook !== event.hook) return false;
  if (trigger.filter === "roll" && event.isRoll === false) return false;
  return true;
}

export function matchesLinked(trigger, event) {
  if (!trigger.clockId || trigger.clockId !== event.clockId) return false;
  if (trigger.when !== event.when) return false;
  if (trigger.when === "threshold" && trigger.at !== null && trigger.at !== undefined && Number(trigger.at) !== Number(event.at)) return false;
  return true;
}

/**
 * Evaluate one clock against one event.
 */
export function evaluate(clock, event) {
  const result = emptyResult(clock);
  if (!clock || !event || !Array.isArray(clock.triggers)) return result;

  for (const trigger of clock.triggers) {
    if (trigger.type !== event.type && !(event.type === "time" && trigger.type === "date")) continue;
    const state = result.triggerState[trigger.id] ?? { carrySeconds: 0, lastFiredAt: null, fired: false };
    result.triggerState[trigger.id] = state;

    switch (trigger.type) {
      case "scene":
        if (matchesScene(trigger, event)) { applyAdvance(result, trigger); result.matched.push(trigger.id); }
        break;
      case "rest":
        if (matchesRest(trigger, event)) { applyAdvance(result, trigger); result.matched.push(trigger.id); }
        break;
      case "hook":
        if (matchesHook(trigger, event)) { applyAdvance(result, trigger); result.matched.push(trigger.id); }
        break;
      case "linked":
        if (matchesLinked(trigger, event)) { applyAdvance(result, trigger); result.matched.push(trigger.id); }
        break;
      case "time": {
        if (event.type !== "time") break;
        if (trigger.once && state.fired) break;
        const period = everyToSeconds(trigger.every, event.calendar);
        const { ticks, carry } = bucketElapsed(state.carrySeconds, event.seconds, period);
        state.carrySeconds = carry;
        if (ticks > 0) {
          const n = trigger.once ? 1 : ticks;
          applyAdvance(result, trigger, n);
          state.fired = true;
          state.lastFiredAt = event.to ?? null;
          if (trigger.once) state.carrySeconds = 0;
          result.matched.push(trigger.id);
        }
        break;
      }
      case "date": {
        if (event.type !== "time" || !event.to || !trigger.at) break;
        if (state.fired && !trigger.repeatEvery) break;
        const cmp = compareMoments(event.to, trigger.at, event.calendar);
        if (Number.isNaN(cmp) || cmp < 0) break;
        if (!trigger.repeatEvery) {
          applyAdvance(result, trigger);
          state.fired = true;
          state.lastFiredAt = event.to;
          result.matched.push(trigger.id);
          break;
        }
        // Repeating: the due occurrence fires, plus every further occurrence
        // that fell inside (from, to], so a long step cannot skip periods.
        const period = everyToSeconds(trigger.repeatEvery, event.calendar);
        if (!(period > 0)) break;
        let at = trigger.at;
        let count = 0;
        let guard = 0;
        while (guard++ < 10000 && compareMoments(event.to, at, event.calendar) >= 0) {
          const afterFrom = !event.from || compareMoments(at, event.from, event.calendar) > 0;
          if (count === 0 || afterFrom) count++;
          at = addSeconds(at, period, event.calendar);
        }
        if (count > 0) {
          applyAdvance(result, trigger, count);
          state.fired = false;
          state.lastFiredAt = event.to;
          result.matched.push(trigger.id);
          result.triggerUpdates[trigger.id] = { at };
        }
        break;
      }
      default:
        break;
    }
  }
  return result;
}

/** Apply triggerUpdates (new `at` for repeating dates) to a clock copy. */
export function applyTriggerUpdates(clock, updates) {
  if (!updates || !Object.keys(updates).length) return clock;
  const copy = structuredClone(clock);
  copy.triggers = copy.triggers.map(t => updates[t.id] ? { ...t, ...updates[t.id] } : t);
  return copy;
}

/**
 * Detect cycles and over-deep chains among linked triggers, looking both
 * upstream (clocks this one listens to) and downstream (clocks listening to it).
 * Depth is counted in hops. Returns { ok, depth, cycle, path }.
 */
export function checkLinkChain(clockId, allClocks, maxDepth = LIMITS.LINK_DEPTH_MAX) {
  const byId = new Map(allClocks.map(c => [c.id, c]));
  if (!byId.has(clockId)) return { ok: true, cycle: false, depth: 0, path: [] };

  const walk = (id, path, next) => {
    if (path.includes(id)) return { cycle: true, depth: path.length, path: [...path, id] };
    let best = { cycle: false, depth: path.length, path: [...path, id] };
    for (const nid of next(id)) {
      const r = walk(nid, [...path, id], next);
      if (r.cycle) return r;
      if (r.depth > best.depth) best = r;
    }
    return best;
  };
  const upstream = id => (byId.get(id)?.triggers ?? []).filter(t => t.type === "linked" && t.clockId).map(t => t.clockId);
  const downstream = id => allClocks.filter(c => c.triggers?.some(t => t.type === "linked" && t.clockId === id)).map(c => c.id);

  const up = walk(clockId, [], upstream);
  if (up.cycle) return { ok: false, cycle: true, depth: up.depth, path: up.path };
  const down = walk(clockId, [], downstream);
  if (down.cycle) return { ok: false, cycle: true, depth: down.depth, path: down.path };
  const depth = up.depth + down.depth;
  return { ok: depth <= maxDepth, cycle: false, depth, path: [...up.path.slice(1).reverse(), ...down.path] };
}

/** Human description key + data for a trigger (localised by the caller). */
export function describeTrigger(trigger) {
  switch (trigger?.type) {
    case "scene": return { key: trigger.scenes?.length ? "sceneListed" : "sceneAny", data: { count: trigger.scenes?.length ?? 0, advance: trigger.advance } };
    case "rest": return { key: "rest", data: { advance: trigger.advance } };
    case "time": {
      const parts = [];
      for (const [unit, n] of Object.entries(trigger.every ?? {})) parts.push({ unit, n });
      return { key: trigger.once ? "timeOnce" : "timeEvery", data: { every: parts, advance: trigger.advance } };
    }
    case "date": return { key: trigger.repeatEvery ? "dateRepeat" : "dateOnce", data: { at: trigger.at, repeatEvery: trigger.repeatEvery, advance: trigger.advance } };
    case "hook": return { key: "hook", data: { hook: trigger.hook, advance: trigger.advance } };
    case "linked": return { key: trigger.when === "threshold" ? "linkedThreshold" : "linkedCompleted", data: { clockId: trigger.clockId, at: trigger.at, advance: trigger.advance } };
    default: return { key: "unknown", data: {} };
  }
}
