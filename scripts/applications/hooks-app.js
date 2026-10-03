/**
 * GM panel listing every Foundry hook currently used by a `hook` trigger, so
 * free-text hooks can be audited and removed.
 */
import { APP_IDS, CURATED_HOOKS, MODULE_ID } from "../constants.js";
import { isGM, notify, rerenderModuleApps, t } from "../compat.js";
import * as dispatcher from "../services/dispatcher-service.js";
import * as store from "../services/store-service.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HooksApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_IDS.hooks,
    classes: ["stb", "stb-hooks"],
    window: { title: "STB.Hooks.title", icon: "fa-solid fa-plug", resizable: true },
    position: { width: 520, height: "auto" },
    actions: { removeHook: HooksApp.#onRemove }
  };

  static PARTS = {
    list: { template: `modules/${MODULE_ID}/templates/hooks.hbs` }
  };

  async _prepareContext() {
    const clocks = store.getAllClocks();
    const byHook = new Map();
    for (const c of clocks) {
      for (const tr of c.triggers ?? []) {
        if (tr.type !== "hook" || !tr.hook) continue;
        if (!byHook.has(tr.hook)) byHook.set(tr.hook, []);
        byHook.get(tr.hook).push({ id: c.id, name: c.name });
      }
    }
    const hooks = [...byHook.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hook, used]) => ({
      hook,
      curated: CURATED_HOOKS.some(h => h.hook === hook),
      clocks: used
    }));
    return { hooks, isGM: isGM(), empty: !hooks.length };
  }

  static async #onRemove(event, target) {
    const hook = target.dataset.hook;
    if (!hook || !isGM()) return;
    const clocks = store.getAllClocks();
    const changed = [];
    for (const c of clocks) {
      const before = c.triggers.length;
      const triggers = c.triggers.filter(tr => !(tr.type === "hook" && tr.hook === hook));
      if (triggers.length !== before) changed.push({ ...c, triggers });
    }
    if (changed.length) await store.writeBatch({ upsert: changed });
    try { await globalThis.game.modules.get(MODULE_ID)?.api?.syncHookListeners?.(); } catch { /* ignore */ }
    notify("info", t("Hooks.removed", { hook, n: changed.length }));
    rerenderModuleApps();
    this.render();
  }
}

export { dispatcher as _dispatcher };
