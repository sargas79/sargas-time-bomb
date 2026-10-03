/**
 * Wiring: sidebar button, document hooks that re-render, scene tracking,
 * lazily registered `hook` trigger listeners, and ownership repair.
 */
import { CURATED_HOOKS, MODULE_ID, SETTINGS, TTA_ID } from "./constants.js";
import { debug, getSetting, isGM, rerenderModuleApps, setSetting, t } from "./compat.js";
import * as dispatcher from "./services/dispatcher-service.js";
import * as store from "./services/store-service.js";
import { BoardApp } from "./applications/board-app.js";

let lastActiveSceneId = null;
let lastViewedSceneId = null;
const hookListeners = new Map(); // hook name -> hook id

/* ------------------------------------------------------------------ */
/*  Sidebar button                                                     */
/* ------------------------------------------------------------------ */

function shouldShowButton() {
  if (isGM()) return true;
  try { return !!getSetting(SETTINGS.showBoardToPlayers); } catch { return false; }
}

function insertButton(root) {
  if (!root || !shouldShowButton()) return;
  if (root.querySelector(".stb-sidebar-button")) return;
  const header = root.querySelector(".header-actions.action-buttons")
    ?? root.querySelector(".header-actions")
    ?? root.querySelector(".action-buttons")
    ?? root.querySelector(".directory-header");
  if (!header) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stb-sidebar-button";
  button.innerHTML = `<i class="fa-solid fa-clock"></i> ${t("Board.button")}`;
  button.addEventListener("click", ev => { ev.preventDefault(); BoardApp.open(); });
  // Place next to Through the Ages' Calendar button when present.
  const tta = header.querySelector(`.${TTA_ID}-button, .tta-sidebar-button, [data-action='tta-calendar']`);
  if (tta?.nextSibling) header.insertBefore(button, tta.nextSibling);
  else header.appendChild(button);
}

export function registerSidebarButton() {
  Hooks.on("renderJournalDirectory", (app, html) => {
    const el = html instanceof HTMLElement ? html : html?.[0];
    insertButton(el);
  });
}

export function refreshSidebarButton() {
  const el = document.querySelector("#journal") ?? document.querySelector("section.journal-sidebar");
  if (!el) return;
  el.querySelector(".stb-sidebar-button")?.remove();
  insertButton(el);
}

/* ------------------------------------------------------------------ */
/*  Re-render on data changes                                          */
/* ------------------------------------------------------------------ */

export function registerDocumentHooks() {
  Hooks.on("updateSetting", setting => {
    if (!setting?.key?.startsWith(`${MODULE_ID}.`)) return;
    rerenderModuleApps();
    if (isGM()) queueSyncHooks();
  });
  Hooks.on("updateJournalEntry", (entry, changes) => {
    if (entry.id !== getSetting(SETTINGS.privateEntryId)) return;
    rerenderModuleApps();
    if (isGM()) queueSyncHooks();
    if (changes.ownership && dispatcher.isPrimaryGM()) store.repairOwnership(entry);
  });
  Hooks.on("deleteJournalEntry", entry => {
    if (entry.id !== getSetting(SETTINGS.privateEntryId)) return;
    if (dispatcher.isPrimaryGM()) {
      setSetting(SETTINGS.privateEntryId, "").then(() => store.ensurePrivateEntry());
    }
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.getProperty(changes, `flags.${MODULE_ID}`) !== undefined || foundry.utils.hasProperty(changes, `flags.-=${MODULE_ID}`)) rerenderModuleApps();
  });
  Hooks.on("updateToken", (token, changes) => {
    if (foundry.utils.hasProperty(changes, `delta.flags.${MODULE_ID}`) || foundry.utils.hasProperty(changes, `actorData.flags.${MODULE_ID}`)) rerenderModuleApps();
  });
  Hooks.on("deleteActor", actor => {
    if (!dispatcher.isPrimaryGM()) return;
    const index = getSetting(SETTINGS.actorIndex) ?? [];
    if (index.includes(actor.uuid)) setSetting(SETTINGS.actorIndex, index.filter(u => u !== actor.uuid));
  });
  Hooks.on("userConnected", () => rerenderModuleApps());
}

/* ------------------------------------------------------------------ */
/*  Scene triggers                                                     */
/* ------------------------------------------------------------------ */

export function registerSceneHooks() {
  lastActiveSceneId = game.scenes?.active?.id ?? null;
  lastViewedSceneId = canvas?.scene?.id ?? null;
  Hooks.on("updateScene", (scene, changes) => {
    if (changes.active !== true) return;
    const previous = lastActiveSceneId;
    lastActiveSceneId = scene.id;
    if (mode() !== "activate") return;
    if (previous === scene.id) return;
    dispatcher.dispatch({ type: "scene", sceneId: scene.id, previousSceneId: previous });
  });
  Hooks.on("canvasReady", cv => {
    const id = cv?.scene?.id ?? canvas?.scene?.id ?? null;
    const previous = lastViewedSceneId;
    lastViewedSceneId = id;
    if (mode() !== "view" || !id || previous === id) return;
    dispatcher.dispatch({ type: "scene", sceneId: id, previousSceneId: previous });
  });
}

function mode() {
  try { return getSetting(SETTINGS.sceneTriggerMode) ?? "activate"; } catch { return "activate"; }
}

/* ------------------------------------------------------------------ */
/*  `hook` triggers: lazily registered listeners                       */
/* ------------------------------------------------------------------ */

let syncTimer = null;
function queueSyncHooks() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncHookListeners(), 100);
}

function onHookEvent(name, args) {
  if (!dispatcher.isPrimaryGM()) return;
  let isRoll;
  if (name === "createChatMessage") {
    const message = args[0];
    if (message?.flags?.[MODULE_ID]) return; // never react to our own cards
    isRoll = message?.isRoll ?? (Array.isArray(message?.rolls) && message.rolls.length > 0);
  }
  dispatcher.dispatch({ type: "hook", hook: name, isRoll, args: [] });
}

/** Make sure a listener exists for every hook named by a `hook` trigger. */
export async function syncHookListeners() {
  if (!isGM()) return;
  const names = new Set();
  for (const c of store.getAllClocks()) {
    for (const tr of c.triggers ?? []) if (tr.type === "hook" && tr.hook) names.add(tr.hook);
  }
  for (const name of names) {
    if (hookListeners.has(name)) continue;
    const id = Hooks.on(name, (...args) => onHookEvent(name, args));
    hookListeners.set(name, id);
    debug("listening to hook", name);
  }
  for (const [name, id] of [...hookListeners]) {
    if (names.has(name)) continue;
    Hooks.off(name, id);
    hookListeners.delete(name);
    debug("stopped listening to hook", name);
  }
  const list = [...names].sort();
  const stored = getSetting(SETTINGS.registeredHooks) ?? [];
  if (dispatcher.isPrimaryGM() && JSON.stringify(list) !== JSON.stringify(stored)) {
    try { await setSetting(SETTINGS.registeredHooks, list); } catch { /* ignore */ }
  }
}

export function curatedHookNames() {
  return CURATED_HOOKS.map(h => h.hook);
}
