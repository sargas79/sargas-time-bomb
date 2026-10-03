/**
 * Collects events, elects the executor (primary GM), runs the pure trigger
 * evaluation, applies results, and writes everything once.
 */
import { HOOKS, LIMITS, MODULE_ID } from "../constants.js";
import { currentUserId, debug, notify, t, warn } from "../compat.js";
import { applyDelta, completeClock, dismissClock, isComplete, resetClock, setFilled } from "./clock-service.js";
import { applyTriggerUpdates, evaluate } from "./trigger-service.js";
import * as store from "./store-service.js";

let chatHandler = null;
let timeInfoProvider = () => ({ moment: null, worldTime: null, calendar: null });

/** Allow module.js to plug in chat posting and the current-time provider. */
export function configure({ postCards, timeInfo } = {}) {
  if (postCards) chatHandler = postCards;
  if (timeInfo) timeInfoProvider = timeInfo;
}

export function activeGMIds() {
  const users = globalThis.game?.users?.contents ?? [];
  return users.filter(u => u.active && u.isGM).map(u => u.id).sort();
}

export function primaryGMId() {
  return activeGMIds()[0] ?? null;
}

export function isPrimaryGM() {
  const me = globalThis.game?.user;
  if (!me?.isGM) return false;
  return primaryGMId() === me.id;
}

function sameState(a, b) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/**
 * Run one batch. Returns { changed: clock[], emitted: [{clock, event, source}] }.
 * ops: [{ clockId, op: "delta"|"set"|"reset"|"complete"|"dismiss", value }]
 * events: trigger events (see trigger-service)
 * context: { source, userId, moment, worldTime, now, state }
 */
export async function runBatch({ ops = [], events = [], context = {} } = {}) {
  const info = timeInfoProvider() ?? {};
  const ctx = {
    now: context.now ?? new Date().toISOString(),
    userId: context.userId ?? currentUserId(),
    moment: context.moment ?? info.moment ?? null,
    worldTime: context.worldTime ?? info.worldTime ?? null,
    source: context.source ?? "manual"
  };
  const calendar = context.calendar ?? info.calendar ?? null;

  const byId = new Map(store.getAllClocks().map(c => [c.id, c]));
  const changed = new Map();
  const emitted = [];
  const pending = events.map(e => ({ event: { calendar, ...e }, depth: 0 }));

  const record = (id, res, source) => {
    if (!res.changed) return;
    byId.set(id, res.clock);
    changed.set(id, res.clock);
    for (const ev of res.events) {
      emitted.push({ clock: res.clock, event: ev, source });
      if (ev.type === "completed") pending.push({ event: { type: "linked", clockId: id, when: "completed", calendar }, depth: (res.depth ?? 0) + 1 });
      if (ev.type === "thresholdReached") pending.push({ event: { type: "linked", clockId: id, when: "threshold", at: ev.threshold.at, calendar }, depth: (res.depth ?? 0) + 1 });
    }
  };

  // Manual operations first.
  for (const op of ops) {
    const clock = byId.get(op.clockId);
    if (!clock) continue;
    const c = { ...ctx, source: op.source ?? ctx.source, note: op.note };
    let res;
    switch (op.op) {
      case "delta": res = applyDelta(clock, op.value, c); break;
      case "set": res = setFilled(clock, op.value, c); break;
      case "reset": res = resetClock(clock, c); break;
      case "complete": res = completeClock(clock, c); break;
      case "dismiss": res = dismissClock(clock, c); break;
      default: continue;
    }
    record(clock.id, res, c.source);
  }

  // Trigger events, including linked chains.
  let guard = 0;
  while (pending.length && guard++ < 10000) {
    const { event, depth } = pending.shift();
    if (event.type === "linked" && depth > LIMITS.LINK_DEPTH_MAX) { debug("linked chain depth exceeded", event); continue; }
    for (const clock of [...byId.values()]) {
      if (!clock.triggers?.length) continue;
      const r = evaluate(clock, event);
      const stateChanged = !sameState(clock.triggerState, r.triggerState);
      if (!r.matched.length && !stateChanged) continue;
      let working = { ...clock, triggerState: r.triggerState };
      working = applyTriggerUpdates(working, r.triggerUpdates);
      const c = { ...ctx, source: event.source ?? event.type, moment: event.to ?? ctx.moment };
      let res;
      if (r.reset) res = resetClock(working, c);
      else if (r.complete) res = completeClock(working, c);
      else if (r.delta !== 0) res = applyDelta(working, r.delta, c);
      else res = { clock: working, events: [], changed: true };
      // Bookkeeping-only changes still need saving (carry seconds, re-armed dates).
      if (!res.changed) res = { clock: working, events: [], changed: true };
      res.depth = depth;
      record(clock.id, res, c.source);
    }
  }

  if (changed.size || context.state) {
    await store.writeBatch({ upsert: [...changed.values()], state: context.state ?? null });
  }

  // Side effects after the write.
  for (const { clock, event, source } of emitted) emitHook(clock, event, source, ctx);
  if (chatHandler && emitted.length) {
    try { await chatHandler(groupEmitted(emitted), ctx); }
    catch (e) { warn("chat card failed", e); }
  }
  return { changed: [...changed.values()], emitted };
}

function groupEmitted(emitted) {
  const groups = new Map();
  for (const e of emitted) {
    if (!groups.has(e.clock.id)) groups.set(e.clock.id, { clock: e.clock, events: [], source: e.source });
    groups.get(e.clock.id).events.push(e.event);
  }
  return [...groups.values()];
}

function emitHook(clock, event, source, ctx) {
  const Hooks = globalThis.Hooks;
  if (!Hooks?.callAll) return;
  const moment = ctx.moment;
  switch (event.type) {
    case "advanced": Hooks.callAll(HOOKS.clockAdvanced, { clock, delta: event.delta, source, moment }); break;
    case "thresholdReached": Hooks.callAll(HOOKS.thresholdReached, { clock, threshold: event.threshold, moment }); break;
    case "completed": Hooks.callAll(HOOKS.clockCompleted, { clock, moment }); break;
    case "weatherChanged": Hooks.callAll(HOOKS.weatherChanged, { clock, previousLabel: event.previousLabel, label: event.label, moment }); break;
    default: break;
  }
}

/**
 * Dispatch a trigger event. Only the primary GM executes unless `local` is set
 * (manual ticks and declared rests run on the acting GM's client).
 */
export async function dispatch(event, { local = false, state = null, context = {} } = {}) {
  const me = globalThis.game?.user;
  if (!me?.isGM) return null;
  if (!local && !isPrimaryGM()) { debug("not primary GM; ignoring", event.type); return null; }
  debug("dispatch", event);
  return runBatch({ events: [event], context: { ...context, source: event.source ?? event.type, state } });
}

/** Manual operation from the board or API (any GM). */
export async function manual(clockId, op, value, { source = "manual", note } = {}) {
  if (!globalThis.game?.user?.isGM) { notify("warn", t("Notify.gmOnly")); return null; }
  return runBatch({ ops: [{ clockId, op, value, source, note }], context: { source } });
}

/** Save an edited/created clock (GM). Returns the stored clock. */
export async function saveClock(clock) {
  if (!globalThis.game?.user?.isGM) { notify("warn", t("Notify.gmOnly")); return null; }
  await store.writeBatch({ upsert: [clock] });
  return clock;
}

export async function deleteClock(id) {
  if (!globalThis.game?.user?.isGM) { notify("warn", t("Notify.gmOnly")); return false; }
  await store.writeBatch({ remove: [id] });
  return true;
}

export { isComplete };
export const MODULE = MODULE_ID;
