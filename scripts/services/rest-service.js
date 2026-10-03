/**
 * Rest detection for PF2e: `pf2e.restForTheNight`, which the system calls once
 * per actor after Rest for the Night completes, plus the module's own
 * "Declare rest" path. Per-actor hooks are debounced into one rest.
 */
import { HOOKS, PF2E_HOOKS, SETTINGS, SYSTEM_ID } from "../constants.js";
import { debug, getSetting, warn } from "../compat.js";

let registered = [];
let pending = null;
let timer = null;
let onRest = null;
let warnedShape = false;

function debounceMs() {
  let s = 5;
  try { s = Number(getSetting(SETTINGS.restDebounceSeconds)); } catch { /* not ready */ }
  if (!Number.isFinite(s) || s < 0) s = 5;
  return s * 1000;
}

/** Fold a per-actor rest signal into the pending batch. */
function collect(actor, source) {
  if (!pending) pending = { actors: new Set(), sources: new Set() };
  if (actor?.uuid) pending.actors.add(actor.uuid);
  pending.sources.add(source);
  clearTimeout(timer);
  timer = setTimeout(flush, debounceMs());
}

function flush() {
  if (!pending) return;
  const payload = { actors: [...pending.actors], source: [...pending.sources].join("+") };
  pending = null;
  timer = null;
  debug("rest", payload);
  globalThis.Hooks.callAll(HOOKS.rest, payload);
}

function on(name, fn) {
  const id = globalThis.Hooks.on(name, fn);
  registered.push([name, id]);
}

/** Verify the hook payload is an Actor before trusting it. Logs once and skips otherwise. */
function verifyActor(x, hookName) {
  const ok = !!x && typeof x === "object" && x.documentName === "Actor" && typeof x.uuid === "string";
  if (!ok && !warnedShape) {
    warnedShape = true;
    warn(`Hook ${hookName} delivered an unexpected payload (${typeof x}); rest signals from it are ignored. Use "Declare rest" instead.`);
  }
  return ok;
}

export function isPF2e() {
  return globalThis.game?.system?.id === SYSTEM_ID;
}

/**
 * Start listening. `handler({ actors, source })` is called once per debounced
 * rest, on every client; the dispatcher decides who executes.
 */
export function startRestService(handler) {
  stopRestService();
  onRest = handler;

  // Our own hook is the single funnel.
  on(HOOKS.rest, payload => { try { onRest?.(payload); } catch (e) { warn("rest handler failed", e); } });

  if (!isPF2e()) {
    warn(`System is not ${SYSTEM_ID}; only "Declare rest" is available for rest triggers.`);
    return;
  }
  on(PF2E_HOOKS.restForTheNight, (...args) => {
    const actor = args[0];
    if (!verifyActor(actor, PF2E_HOOKS.restForTheNight)) return;
    collect(actor, PF2E_HOOKS.restForTheNight);
  });
}

export function stopRestService() {
  for (const [name, id] of registered) globalThis.Hooks.off(name, id);
  registered = [];
  clearTimeout(timer);
  timer = null;
  pending = null;
}

/** The GM's explicit rest declaration. Bypasses the debounce. */
export function declareRest({ actors = [] } = {}) {
  const uuids = (Array.isArray(actors) ? actors : [actors]).map(a => (typeof a === "string" ? a : a?.uuid)).filter(Boolean);
  const payload = { actors: uuids, source: "declared", declaredBy: globalThis.game?.user?.id ?? null };
  globalThis.Hooks.callAll(HOOKS.rest, payload);
  return payload;
}
