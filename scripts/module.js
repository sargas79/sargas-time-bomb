/**
 * Sargas Time Bomb — Adventure Clock System. Lifecycle entry point.
 */
import { HOOKS, MODULE_ID, SETTINGS, TTA_ID } from "./constants.js";
import { debug, getSetting, isGM, loadTemplates, log, notify, rerenderModuleApps, t, warn } from "./compat.js";
import { registerSettings } from "./settings.js";
import { buildAPI } from "./api.js";
import * as dispatcher from "./services/dispatcher-service.js";
import * as store from "./services/store-service.js";
import { elapsedSeconds, isValidMoment } from "./services/schedule-service.js";
import { postCards } from "./services/chat-service.js";
import { relayRest, startRestRelayListener, startRestService } from "./services/rest-service.js";
import { formatMoment, startTimeSource, timeInfo } from "./services/time-source-service.js";
import { renderPie } from "./ui/pie.js";
import { BoardMenu } from "./applications/board-app.js";
import { HooksApp } from "./applications/hooks-app.js";
import { registerDocumentHooks, registerSceneHooks, registerSidebarButton, refreshSidebarButton, syncHookListeners } from "./hooks.js";
import { startProposalService } from "./services/proposal-service.js";

const TEMPLATES = [
  "board", "clock-editor", "clock-editor-footer", "hooks",
  "partials/clock-card", "partials/clock-pie", "partials/threshold-list", "partials/trigger-list",
  "chat/clock-card"
].map(n => `modules/${MODULE_ID}/templates/${n}.hbs`);

function momentKey(m) {
  return m ? `${m.year}-${m.month}-${m.day}-${m.hour}-${m.minute}` : "";
}

/* ------------------------------------------------------------------ */
/*  Time handling                                                      */
/* ------------------------------------------------------------------ */

/**
 * Called by the active time source on every client; only the primary GM acts.
 * Elapsed time is measured from the stored "last processed" marker, never from
 * the previous hook payload, so bursts and missed events cannot lose time.
 */
/**
 * Runs inside the write queue: the "last processed" marker is read and the
 * elapsed span computed only once every earlier batch has written, so a burst
 * of time changes cannot measure twice from the same marker.
 */
function onTimeChange(change, options = {}) {
  if (!dispatcher.isPrimaryGM()) return Promise.resolve(null);
  return store.writeQueue.enqueue(() => onTimeChangeNow(change, options));
}

async function onTimeChangeNow({ moment, worldTime, source, reconfigured = false, reason = null, adventureDayOnly = false }, { catchUp = false } = {}) {
  if (!dispatcher.isPrimaryGM()) return null;
  if (source === "off") return null; // time triggers disabled by setting
  const info = timeInfo();
  if (info.sourceId === "off") return null;

  // The reason for an already-processed move arrived late: count the rest only.
  if (adventureDayOnly) {
    return dispatcher.runBatchUnqueued({ events: [{ type: "rest", actors: [], source: "adventureDay" }], context: { moment, worldTime, source: "rest" } });
  }
  const state = store.getState();
  const stamp = { lastProcessedMoment: moment ?? state.lastProcessedMoment ?? null, lastProcessedWorldTime: worldTime ?? state.lastProcessedWorldTime ?? null };

  if (source === TTA_ID) {
    if (!moment) return null;
    const from = state.lastProcessedMoment;
    if (!from) { await store.saveStateUnqueued(stamp); return null; }
    // One arithmetic for both ends (TTA's own when it exposes it) so a mixed sum cannot fake a rewind.
    const span = info.elapsedBetween(from, moment);
    const seconds = Number.isFinite(span) ? span : elapsedSeconds(from, moment, info.calendar);
    if (reconfigured) rerenderModuleApps();
    if (seconds === 0) return null;
    if (seconds < 0) {
      const key = momentKey(moment);
      if (state.lastRewindNoticeAt !== key) {
        notify("warn", t("Notify.rewind", { from: formatMoment(from), to: formatMoment(moment) }));
        stamp.lastRewindNoticeAt = key;
      }
      await store.saveStateUnqueued(stamp);
      rerenderModuleApps();
      return null;
    }
    const events = [{ type: "time", seconds, from, to: moment, calendar: info.calendar, source: catchUp ? "catchup" : "time" }];
    // TTA's "next adventure day" is the party waking up; rest triggers that opt in count it.
    if (reason === "nextAdventureDay") events.push({ type: "rest", actors: [], source: "adventureDay" });
    return dispatcher.runBatchUnqueued({
      events,
      context: { moment, worldTime, source: catchUp ? "catchup" : "time", state: stamp, calendar: info.calendar }
    });
  }

  // World time.
  if (!Number.isFinite(worldTime)) return null;
  const from = state.lastProcessedWorldTime;
  if (!Number.isFinite(from)) { await store.saveStateUnqueued(stamp); return null; }
  const seconds = worldTime - from;
  if (seconds === 0) return null;
  if (seconds < 0) {
    const key = `wt:${worldTime}`;
    if (state.lastRewindNoticeAt !== key) {
      notify("warn", t("Notify.rewindWorldTime"));
      stamp.lastRewindNoticeAt = key;
    }
    await store.saveStateUnqueued(stamp);
    return null;
  }
  return dispatcher.runBatchUnqueued({
    events: [{ type: "time", seconds, from: null, to: null, calendar: null, source: catchUp ? "catchup" : "time" }],
    context: { worldTime, source: catchUp ? "catchup" : "time", state: stamp }
  });
}

/**
 * After a structural calendar change, name the clocks whose stored deadlines no
 * longer exist. Runs on the GM client that saw the change (calendarConfigured
 * fires only there), whether or not it is the primary.
 */
function reportInvalidDeadlines(info) {
  if (!isGM() || !info.calendar) return;
  const bad = store.getAllClocks().filter(c => c.triggers?.some(tr => tr.type === "date" && tr.at && !isValidMoment(tr.at, info.calendar)));
  if (!bad.length) return;
  notify("warn", t("Notify.deadlinesInvalid", { n: bad.length, names: bad.map(c => c.name).join(", ") }), { permanent: true });
}

async function evaluateNow() {
  const info = timeInfo();
  return onTimeChange({ moment: info.moment, worldTime: info.worldTime, source: info.sourceId }, { catchUp: true });
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  log("init");
  registerSettings({
    BoardMenu,
    HooksMenu: HooksApp,
    onTimeSourceChange: () => startTimeSource(),
    onDisplayChange: () => refreshSidebarButton()
  });

  Handlebars.registerHelper("stbPie", (clock, options) => new Handlebars.SafeString(renderPie(clock, { size: options?.hash?.size ?? 64 })));
  Handlebars.registerHelper("stbEq", (a, b) => a === b);
  Handlebars.registerHelper("stbT", (key, options) => t(key, options?.hash));
  Handlebars.registerHelper("stbRange", (n) => Array.from({ length: Math.max(0, Number(n) || 0) }, (_, i) => i));

  loadTemplates(TEMPLATES).catch(e => warn("template preload failed", e));

  const mod = game.modules.get(MODULE_ID);
  mod.api = buildAPI({ evaluateNow });

  dispatcher.configure({ postCards, timeInfo });
  registerSidebarButton();
});

Hooks.once("setup", () => {
  registerDocumentHooks();
});

Hooks.once("ready", async () => {
  if (isGM()) {
    try {
      await store.ensurePrivateEntry();
      await store.migrateStoredData();
    } catch (e) { warn("startup maintenance failed", e); }
  }

  registerSceneHooks();
  startRestService(payload => {
    // Declared rests run on the declaring GM's client. PF2e rests fire only on
    // the resting client: the primary GM processes them directly, every other
    // client relays them through its User flag.
    if (payload.source === "declared") {
      dispatcher.dispatch({ type: "rest", actors: payload.actors }, { local: payload.declaredBy === game.user.id });
      return;
    }
    if (dispatcher.isPrimaryGM()) dispatcher.dispatch({ type: "rest", actors: payload.actors });
    else relayRest(payload);
  });
  startRestRelayListener(payload => {
    if (!dispatcher.isPrimaryGM()) return;
    dispatcher.dispatch({ type: "rest", actors: payload.actors });
  });
  startTimeSource(change => {
    if (change.reconfigured && change.structureChanged) {
      try { reportInvalidDeadlines(timeInfo()); } catch (e) { warn("deadline revalidation failed", e); }
    }
    return onTimeChange(change);
  });
  try { startProposalService({ isPrimary: () => dispatcher.isPrimaryGM() }); }
  catch (e) { warn("proposal relay failed to start", e); }

  if (isGM()) {
    await syncHookListeners();
    if (dispatcher.isPrimaryGM()) {
      try { await store.syncMirrors(); } catch (e) { warn("mirror sync failed", e); }
    }
    let catchUp = true;
    try { catchUp = !!getSetting(SETTINGS.catchUpOnConnect); } catch { /* ignore */ }
    if (catchUp && dispatcher.isPrimaryGM()) {
      try {
        const info = timeInfo();
        await onTimeChange({ moment: info.moment, worldTime: info.worldTime, source: info.sourceId }, { catchUp: true });
      } catch (e) { warn("catch-up failed", e); }
    }
  }

  refreshSidebarButton();
  debug("ready", { primary: dispatcher.isPrimaryGM(), timeSource: timeInfo().sourceId });
  Hooks.callAll(HOOKS.ready, game.modules.get(MODULE_ID).api);
  log(`ready (time source: ${timeInfo().sourceId})`);
});

// Re-elect when GMs come and go; the new primary may need to catch up.
Hooks.on("userConnected", async (user, connected) => {
  if (!user.isGM || !isGM()) return;
  debug("GM connection changed", user.name, connected, "primary:", dispatcher.isPrimaryGM());
  if (!connected && dispatcher.isPrimaryGM()) {
    try { await evaluateNow(); } catch (e) { warn("re-election catch-up failed", e); }
  }
});
