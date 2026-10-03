/**
 * Public API: game.modules.get("sargas-time-bomb").api
 */
import { MODULE_ID, VISIBILITY } from "./constants.js";
import { isGM, moduleVersion, notify, randomID, rerenderModuleApps, t } from "./compat.js";
import { createClock as buildClock, normalizeClock } from "./services/clock-service.js";
import * as dispatcher from "./services/dispatcher-service.js";
import { exportEnvelope, parseImport } from "./services/portability-service.js";
import { canView } from "./services/permission-service.js";
import { declareRest } from "./services/rest-service.js";
import { momentToSeconds } from "./services/schedule-service.js";
import * as store from "./services/store-service.js";
import { formatMoment, timeInfo } from "./services/time-source-service.js";
import { describeTrigger } from "./services/trigger-service.js";
import { validateClock } from "./services/validation-service.js";
import { nextText, triggerText } from "./ui/describe.js";
import { BoardApp } from "./applications/board-app.js";
import * as breakTimer from "./services/break-timer-service.js";
import { ClockEditorApp } from "./applications/clock-editor-app.js";
import { syncHookListeners } from "./hooks.js";

function requireGM() {
  if (!isGM()) throw new Error(`${MODULE_ID}: this operation requires a GM`);
}

function requireClock(id) {
  const clock = store.getClock(id);
  if (!clock) throw new Error(`${MODULE_ID}: no clock with id ${id}`);
  return clock;
}

async function persist(clock, { isNew }) {
  const info = timeInfo();
  const boundActor = clock.actorUuid ? store.resolveActor(clock.actorUuid) : null;
  const actorType = boundActor ? boundActor.type : undefined;
  const result = validateClock(clock, { allClocks: store.getAllClocks(), calendar: info.calendar, isNew, actorType });
  if (!result.valid) {
    const err = new Error(`${MODULE_ID}: invalid clock: ${result.errors.map(e => e.code).join(", ")}`);
    err.errors = result.errors;
    throw err;
  }
  await dispatcher.saveClock(clock);
  await syncHookListeners();
  rerenderModuleApps();
  return clock;
}

export function buildAPI(timeHandlers = {}) {
  return {
    MODULE_ID,
    get version() { return moduleVersion(); },

    openBoard() { return BoardApp.open(); },
    openEditor(id) {
      const clock = id ? requireClock(id) : null;
      return new ClockEditorApp(clock ? { clock } : {}).render({ force: true });
    },

    getClocks({ visible = true } = {}) {
      const all = store.getAllClocks();
      return visible ? all.filter(c => canView(c)) : all;
    },
    getClock(id) {
      const clock = store.getClock(id);
      return clock && canView(clock) ? clock : null;
    },

    async createClock(data = {}) {
      requireGM();
      const clock = buildClock(data, { idGen: () => randomID() });
      return persist(clock, { isNew: true });
    },
    async updateClock(id, changes = {}) {
      requireGM();
      const current = requireClock(id);
      const merged = normalizeClock({ ...current, ...changes, id: current.id }, { idGen: () => randomID() });
      merged.createdAt = current.createdAt;
      merged.updatedAt = new Date().toISOString();
      return persist(merged, { isNew: false });
    },
    async deleteClock(id) {
      requireGM();
      requireClock(id);
      await dispatcher.deleteClock(id);
      await syncHookListeners();
      rerenderModuleApps();
      return true;
    },

    async advanceClock(id, delta = 1, { source = "manual", note } = {}) {
      requireGM(); requireClock(id);
      return dispatcher.manual(id, "delta", delta, { source, note });
    },
    async setClock(id, filled, { source = "manual" } = {}) {
      requireGM(); requireClock(id);
      return dispatcher.manual(id, "set", filled, { source });
    },
    async resetClock(id, { source = "manual" } = {}) {
      requireGM(); requireClock(id);
      return dispatcher.manual(id, "reset", undefined, { source });
    },
    async completeClock(id, { source = "manual" } = {}) {
      requireGM(); requireClock(id);
      return dispatcher.manual(id, "complete", undefined, { source });
    },
    async dismissClock(id) {
      requireGM(); requireClock(id);
      return dispatcher.manual(id, "dismiss");
    },
    async revealClock(id) {
      requireGM();
      const clock = requireClock(id);
      return persist({ ...clock, visibility: VISIBILITY.PLAYERS }, { isNew: false });
    },
    async hideClock(id) {
      requireGM();
      const clock = requireClock(id);
      return persist({ ...clock, visibility: VISIBILITY.GM_ONLY }, { isNew: false });
    },

    declareRest({ actors = [] } = {}) {
      requireGM();
      return declareRest({ actors });
    },
    syncMirrors() { requireGM(); return store.syncMirrors(); },
    isBindableActor: store.isBindableActor,

    /** Re-evaluate elapsed time now (catch-up) on this client if it is the primary GM. */
    async evaluateNow() {
      requireGM();
      if (!dispatcher.isPrimaryGM()) {
        notify("warn", t("Notify.notPrimary"));
        return { changed: [], emitted: [] };
      }
      return (await timeHandlers.evaluateNow?.()) ?? { changed: [], emitted: [] };
    },

    exportClocks({ includeLog = true } = {}) {
      const clocks = isGM() ? store.getAllClocks() : store.getAllClocks().filter(c => canView(c));
      return exportEnvelope(clocks, { moduleVersion: moduleVersion(), state: store.getState(), includeLog });
    },
    async importClocks(json, { regenerateIds = true } = {}) {
      requireGM();
      const existing = store.getAllClocks();
      const result = parseImport(json, { regenerateIds, existingClocks: existing, idGen: () => randomID(), calendar: timeInfo().calendar });
      if (!result.ok) return result;
      if (result.clocks.length) await store.writeBatch({ upsert: result.clocks });
      await syncHookListeners();
      rerenderModuleApps();
      return result;
    },

    /** Real-world break countdown shown to everyone; minutes are clamped to 1-60. */
    startBreak(minutes) { return breakTimer.startBreak(minutes); },
    cancelBreak() { return breakTimer.cancelBreak(); },
    getBreak() {
      const timer = breakTimer.getBreak();
      return { ...timer, remainingMs: breakTimer.remainingMs(timer, breakTimer.realNow()) };
    },

    syncHookListeners,
    isPrimaryGM: () => dispatcher.isPrimaryGM(),

    utils: {
      nextTrigger(clock) { return nextText(clock, { clocks: store.getAllClocks() }); },
      describeTrigger(trigger) { return triggerText(trigger, { clocks: store.getAllClocks() }); },
      describeTriggerKey: describeTrigger,
      momentToSeconds(moment, calendar = timeInfo().calendar) { return momentToSeconds(moment, calendar); },
      formatMoment,
      timeInfo
    },
    applications: { BoardApp, ClockEditorApp }
  };
}
