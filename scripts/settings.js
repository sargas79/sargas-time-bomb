/**
 * Setting registration. Called from the init hook.
 */
import {
  CHAT_CARD_MODES, DENSITIES, MODULE_ID, SCENE_TRIGGER_MODES, SETTINGS, TIME_SOURCES, LIMITS
} from "./constants.js";
import { rerenderModuleApps, t } from "./compat.js";

function choices(prefix, values) {
  return Object.fromEntries(values.map(v => [v, `STB.Settings.${prefix}.${v}`]));
}

export function registerSettings({ BoardMenu, HooksMenu, onTimeSourceChange, onDisplayChange } = {}) {
  const S = globalThis.game.settings;

  // Hidden storage.
  S.register(MODULE_ID, SETTINGS.clocks, { scope: "world", config: false, type: Array, default: [] });
  S.register(MODULE_ID, SETTINGS.state, { scope: "world", config: false, type: Object, default: {} });
  S.register(MODULE_ID, SETTINGS.privateEntryId, { scope: "world", config: false, type: String, default: "" });
  S.register(MODULE_ID, SETTINGS.folderId, { scope: "world", config: false, type: String, default: "" });
  S.register(MODULE_ID, SETTINGS.registeredHooks, { scope: "world", config: false, type: Array, default: [] });
  S.register(MODULE_ID, SETTINGS.collapsedGroups, { scope: "client", config: false, type: Array, default: [] });

  // Menus.
  if (BoardMenu) {
    S.registerMenu(MODULE_ID, SETTINGS.boardMenu, {
      name: "STB.Settings.boardMenu.name",
      label: "STB.Settings.boardMenu.label",
      hint: "STB.Settings.boardMenu.hint",
      icon: "fa-solid fa-clock",
      type: BoardMenu,
      restricted: true
    });
  }
  if (HooksMenu) {
    S.registerMenu(MODULE_ID, SETTINGS.hooksMenu, {
      name: "STB.Settings.hooksMenu.name",
      label: "STB.Settings.hooksMenu.label",
      hint: "STB.Settings.hooksMenu.hint",
      icon: "fa-solid fa-plug",
      type: HooksMenu,
      restricted: true
    });
  }

  // Visible world settings.
  S.register(MODULE_ID, SETTINGS.timeSource, {
    name: "STB.Settings.timeSource.name", hint: "STB.Settings.timeSource.hint",
    scope: "world", config: true, type: String, default: "auto",
    choices: choices("timeSource", TIME_SOURCES),
    onChange: () => { onTimeSourceChange?.(); rerenderModuleApps(); }
  });
  S.register(MODULE_ID, SETTINGS.sceneTriggerMode, {
    name: "STB.Settings.sceneTriggerMode.name", hint: "STB.Settings.sceneTriggerMode.hint",
    scope: "world", config: true, type: String, default: "activate",
    choices: choices("sceneTriggerMode", SCENE_TRIGGER_MODES)
  });
  S.register(MODULE_ID, SETTINGS.restDebounceSeconds, {
    name: "STB.Settings.restDebounceSeconds.name", hint: "STB.Settings.restDebounceSeconds.hint",
    scope: "world", config: true, type: Number, default: 5,
    range: { min: 0, max: LIMITS.REST_DEBOUNCE_MAX, step: 1 }
  });
  S.register(MODULE_ID, SETTINGS.catchUpOnConnect, {
    name: "STB.Settings.catchUpOnConnect.name", hint: "STB.Settings.catchUpOnConnect.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  S.register(MODULE_ID, SETTINGS.chatCards, {
    name: "STB.Settings.chatCards.name", hint: "STB.Settings.chatCards.hint",
    scope: "world", config: true, type: String, default: "visible-only",
    choices: choices("chatCards", CHAT_CARD_MODES)
  });
  S.register(MODULE_ID, SETTINGS.showBoardToPlayers, {
    name: "STB.Settings.showBoardToPlayers.name", hint: "STB.Settings.showBoardToPlayers.hint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { onDisplayChange?.(); globalThis.ui?.journal?.render?.(); }
  });

  // Client settings.
  S.register(MODULE_ID, SETTINGS.playerBoardDensity, {
    name: "STB.Settings.playerBoardDensity.name", hint: "STB.Settings.playerBoardDensity.hint",
    scope: "client", config: true, type: String, default: "compact",
    choices: choices("playerBoardDensity", DENSITIES),
    onChange: () => rerenderModuleApps()
  });
  S.register(MODULE_ID, SETTINGS.debugLogging, {
    name: "STB.Settings.debugLogging.name", hint: "STB.Settings.debugLogging.hint",
    scope: "client", config: true, type: Boolean, default: false
  });
}

export function settingLabel(key) {
  return t(`Settings.${key}.name`);
}
