/**
 * Rest detection: known system hooks, chat-message based detection where the
 * system only fires hooks on the acting client, and the module's own
 * "Declare rest" path. Per-actor hooks are debounced into one rest.
 */
import { HOOKS, MODULE_ID, SETTINGS } from "../constants.js";
import { debug, getSetting, warn } from "../compat.js";

let registered = [];
let pending = null;
let timer = null;
let onRest = null;

function debounceMs() {
  let s = 5;
  try { s = Number(getSetting(SETTINGS.restDebounceSeconds)); } catch { /* not ready */ }
  if (!Number.isFinite(s) || s < 0) s = 5;
  return s * 1000;
}

/** Fold a per-actor rest signal into the pending batch. */
function collect(kind, actor, source) {
  if (!pending) pending = { kinds: new Set(), actors: new Set(), sources: new Set() };
  if (kind) pending.kinds.add(kind);
  if (actor?.uuid) pending.actors.add(actor.uuid);
  pending.sources.add(source);
  clearTimeout(timer);
  timer = setTimeout(flush, debounceMs());
}

function flush() {
  if (!pending) return;
  const kind = pending.kinds.has("long") ? "long" : (pending.kinds.values().next().value ?? "long");
  const payload = { kind, actors: [...pending.actors], source: [...pending.sources].join("+") };
  pending = null;
  timer = null;
  debug("rest", payload);
  globalThis.Hooks.callAll(HOOKS.rest, payload);
}

function on(name, fn) {
  const id = globalThis.Hooks.on(name, fn);
  registered.push([name, id]);
}

function expectActor(x, hookName) {
  if (x && typeof x === "object" && (x.documentName === "Actor" || typeof x.uuid === "string")) return true;
  warn(`Hook ${hookName} delivered an unexpected payload; ignoring this rest signal.`);
  return false;
}

/**
 * Start listening. `handler({ kind, actors, source })` is called once per
 * debounced rest, on every client (the dispatcher decides who executes).
 */
export function startRestService(handler) {
  stopRestService();
  onRest = handler;
  const systemId = globalThis.game?.system?.id;

  // Our own hook is the single funnel.
  on(HOOKS.rest, payload => { try { onRest?.(payload); } catch (e) { warn("rest handler failed", e); } });

  if (systemId === "pf2e") {
    on("pf2e.restForTheNight", (...args) => {
      const actors = args.flat().filter(a => a && typeof a === "object" && a.documentName === "Actor");
      if (!actors.length && args.length) { expectActor(args[0], "pf2e.restForTheNight"); }
      if (actors.length) for (const a of actors) collect("long", a, "pf2e.restForTheNight");
      else collect("long", null, "pf2e.restForTheNight");
    });
  }
  if (systemId === "dnd5e") {
    on("dnd5e.restCompleted", (actor, result) => {
      if (!expectActor(actor, "dnd5e.restCompleted")) return;
      const kind = result?.longRest === true || result?.type === "long" ? "long" : "short";
      collect(kind, actor, "dnd5e.restCompleted");
    });
    on("dnd5e.longRest", (actor) => { if (expectActor(actor, "dnd5e.longRest")) collect("long", actor, "dnd5e.longRest"); });
    on("dnd5e.shortRest", (actor) => { if (expectActor(actor, "dnd5e.shortRest")) collect("short", actor, "dnd5e.shortRest"); });
  }

  // Chat-message detection: system rest hooks only fire on the resting client,
  // so this is the signal the primary GM actually receives for player rests.
  on("createChatMessage", (message) => {
    const rest = message?.flags?.dnd5e?.rest ?? message?.flags?.pf2e?.rest ?? null;
    if (!rest || message?.flags?.[MODULE_ID]) return;
    const type = typeof rest === "string" ? rest : rest.type;
    const kind = type === "long" || type === "longRest" ? "long" : "short";
    collect(kind, message.speaker?.actor ? { uuid: `Actor.${message.speaker.actor}` } : null, "chat");
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
export function declareRest({ kind = "long", actors = [] } = {}) {
  const payload = { kind, actors, source: "declared", declaredBy: globalThis.game?.user?.id ?? null };
  globalThis.Hooks.callAll(HOOKS.rest, payload);
  return payload;
}
