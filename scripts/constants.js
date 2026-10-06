/**
 * Module-wide constants. This file must not touch Foundry globals at import
 * time so that `node --test` can import it without a runtime.
 */

export const MODULE_ID = "sargas-time-bomb";
export const MODULE_TITLE = "Sargas Time Bomb";
export const I18N_PREFIX = "STB";
export const CSS_SCOPE = "stb";

export const TTA_ID = "through-the-ages";
export const TTA_SETTING_KEY = `${TTA_ID}.calendarData`;
export const TTA_HOOKS = Object.freeze({
  timeChanged: `${TTA_ID}.timeChanged`,
  dateChanged: `${TTA_ID}.dateChanged`,
  calendarConfigured: `${TTA_ID}.calendarConfigured`
});

export const CURRENT_SCHEMA_VERSION = 1;
export const EXPORT_FORMAT_VERSION = 1;

/** Bounds enforced by validation-service. */
export const LIMITS = Object.freeze({
  SEGMENTS_MIN: 1,
  SEGMENTS_MAX: 48,
  THRESHOLDS_MAX: 12,
  TRIGGERS_MAX: 8,
  NAME_MAX: 120,
  DESCRIPTION_MAX: 20000,
  GROUP_MAX: 80,
  LABEL_MAX: 80,
  CLOCKS_MAX: 500,
  LOG_MAX: 50,
  LINK_DEPTH_MAX: 5,
  ADVANCE_MAX: 48,
  REST_DEBOUNCE_MAX: 120
});

/** Break timer length in real-world minutes. */
export const BREAK_MINUTES_MIN = 1;
export const BREAK_MINUTES_MAX = 60;
export const BREAK_MINUTES_DEFAULT = 30;

export const LOG_MAX = LIMITS.LOG_MAX;

export const KINDS = Object.freeze([
  "progress",
  "countdown",
  "threat",
  "faction",
  "corruption",
  "alarm",
  "project",
  "weather"
]);

export const DIRECTIONS = Object.freeze(["fill", "drain"]);

export const ON_COMPLETE = Object.freeze(["stop", "reset", "repeat", "stayFull"]);

export const VISIBILITY = Object.freeze({
  GM_ONLY: "gm-only",
  PLAYERS: "players",
  ACTOR_OWNERS: "actor-owners"
});
export const VISIBILITIES = Object.freeze(Object.values(VISIBILITY));

export const TRIGGER_TYPES = Object.freeze([
  "scene",
  "rest",
  "time",
  "date",
  "hook",
  "linked"
]);

/** Values accepted for `trigger.advance` besides integers. */
export const ADVANCE_KEYWORDS = Object.freeze(["complete", "reset"]);

export const EVERY_UNITS = Object.freeze(["hours", "days", "weeks"]);

export const LINK_WHEN = Object.freeze(["completed", "threshold"]);

/** Every `source` a log entry or chat card may carry; `STB.Source.<source>` must exist for each. */
export const SOURCES = Object.freeze([
  "manual",
  "scene",
  "rest",
  "time",
  "date",
  "hook",
  "linked",
  "import",
  "catchup",
  "declared",
  "api",
  "proposal",
  "adventureDay"
]);

/** Curated Foundry hooks that may be used by a `hook` trigger. */
export const CURATED_HOOKS = Object.freeze([
  { key: "combatRound", hook: "combatRound" },
  { key: "combatStart", hook: "combatStart" },
  { key: "deleteCombat", hook: "deleteCombat" },
  { key: "pf2eStartTurn", hook: "pf2e.startTurn" },
  { key: "pf2eEndTurn", hook: "pf2e.endTurn" },
  { key: "createChatMessage", hook: "createChatMessage", filter: "roll" },
  { key: "pauseGame", hook: "pauseGame" }
]);

/**
 * Hooks a `hook` trigger may never name: this module's own writes emit them, so
 * a trigger on one would feed itself (clock write -> hook -> tick -> write...).
 */
export const DENIED_TRIGGER_HOOKS = Object.freeze([
  "createSetting", "updateSetting", "preUpdateSetting", "preCreateSetting",
  "createJournalEntry", "updateJournalEntry", "deleteJournalEntry", "preUpdateJournalEntry", "preCreateJournalEntry", "preDeleteJournalEntry",
  "updateUser", "preUpdateUser",
  // Chat render hooks fire on every re-render of every message, including this module's cards.
  "preCreateChatMessage", "renderChatMessage", "renderChatMessageHTML"
]);

/** PF2e hooks this module relies on. Names are verified at runtime against the installed system. */
export const PF2E_HOOKS = Object.freeze({
  restForTheNight: "pf2e.restForTheNight",
  startTurn: "pf2e.startTurn",
  endTurn: "pf2e.endTurn"
});

export const SYSTEM_ID = "pf2e";

/** Actor types a corruption clock may be bound to. Party, loot, vehicle and hazard are refused. */
export const BINDABLE_ACTOR_TYPES = Object.freeze(["character", "npc", "familiar"]);

/** Hooks this module emits. */
export const HOOKS = Object.freeze({
  clockAdvanced: `${MODULE_ID}.clockAdvanced`,
  thresholdReached: `${MODULE_ID}.thresholdReached`,
  clockCompleted: `${MODULE_ID}.clockCompleted`,
  weatherChanged: `${MODULE_ID}.weatherChanged`,
  rest: `${MODULE_ID}.rest`,
  ready: `${MODULE_ID}.ready`
});

/** Setting keys (registered under MODULE_ID). */
export const SETTINGS = Object.freeze({
  clocks: "clocks",
  state: "state",
  privateEntryId: "privateEntryId",
  folderId: "folderId",
  registeredHooks: "registeredHooks",
  timeSource: "timeSource",
  restDebounceSeconds: "restDebounceSeconds",
  catchUpOnConnect: "catchUpOnConnect",
  chatCards: "chatCards",
  showBoardToPlayers: "showBoardToPlayers",
  sceneTriggerMode: "sceneTriggerMode",
  playerBoardDensity: "playerBoardDensity",
  collapsedGroups: "collapsedGroups",
  proposals: "proposals",
  allowProposals: "allowProposals",
  breakTimer: "breakTimer",
  debugLogging: "debugLogging",
  boardMenu: "boardMenu",
  hooksMenu: "hooksMenu"
});

export const TIME_SOURCES = Object.freeze(["auto", "through-the-ages", "world-time", "off"]);
export const CHAT_CARD_MODES = Object.freeze(["off", "visible-only", "all"]);
export const SCENE_TRIGGER_MODES = Object.freeze(["activate", "view"]);
export const DENSITIES = Object.freeze(["compact", "comfortable"]);

export const PRIVATE_ENTRY_NAME = "Adventure Clocks (GM only)";
export const MIRROR_ENTRY_PREFIX = "Adventure Clocks: ";
export const FOLDER_NAME = "Adventure Clocks";

export const FLAG_CLOCKS = "clocks";
export const FLAG_PROPOSALS = "proposals";
export const FLAG_MIRROR_FOR = "mirrorFor";

export const APP_IDS = Object.freeze({
  board: "stb-board",
  editor: "stb-clock-editor",
  hooks: "stb-hooks"
});

/** Default calendar used when no time source supplies one. */
export const DEFAULT_CALENDAR = Object.freeze({
  monthLengths: Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]),
  monthNames: null,
  monthBase: 1,
  dayBase: 1,
  hoursPerDay: 24,
  minutesPerHour: 60,
  secondsPerMinute: 60
});

export const SECONDS = Object.freeze({
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800
});
