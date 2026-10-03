/**
 * Minimal Foundry stub for node tests. Records setting writes, document
 * updates, hooks and notifications. Install with `installFoundryStub()` and
 * remove with the returned `uninstall()`.
 */
import { MODULE_ID } from "../../scripts/constants.js";

class HooksStub {
  #handlers = new Map();
  #next = 1;
  calls = [];
  on(name, fn) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, new Map());
    const id = this.#next++;
    this.#handlers.get(name).set(id, fn);
    return id;
  }
  once(name, fn) { return this.on(name, (...a) => { fn(...a); }); }
  off(name, id) { this.#handlers.get(name)?.delete(id); }
  callAll(name, ...args) {
    this.calls.push({ name, args });
    for (const fn of this.#handlers.get(name)?.values() ?? []) fn(...args);
    return true;
  }
  call(name, ...args) { return this.callAll(name, ...args); }
  listenerCount(name) { return this.#handlers.get(name)?.size ?? 0; }
}

class Document {
  constructor({ id, documentName, name = "", flags = {}, ownership = {}, uuid = null, isGM = false, type = null, folder = null }) {
    this.id = id; this.documentName = documentName; this.name = name; this.type = type; this.folder = folder;
    this.flags = structuredClone(flags); this.ownership = { default: 0, ...ownership };
    this.uuid = uuid ?? `${documentName}.${id}`;
    this.updates = [];
    this.isGM = isGM;
    this.img = "";
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async update(changes) {
    this.updates.push(structuredClone(changes));
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split(".");
      let obj = this;
      while (parts.length > 1) { const p = parts.shift(); obj[p] ??= {}; obj = obj[p]; }
      obj[parts[0]] = structuredClone(value);
    }
    return this;
  }
  get hasPlayerOwner() {
    return Object.entries(this.ownership).some(([k, v]) => k !== "default" && v >= 3);
  }
  async delete() {
    this.deleted = true;
    const coll = this.documentName === "JournalEntry" ? this._collection : null;
    coll?.delete(this.id);
    return this;
  }
  testUserPermission(user, level) {
    const lvl = typeof level === "string" ? ({ NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 })[level] : level;
    return user.isGM || (this.ownership[user.id] ?? this.ownership.default ?? 0) >= lvl;
  }
}

class Collection extends Map {
  get contents() { return [...this.values()]; }
  find(fn) { return this.contents.find(fn); }
  filter(fn) { return this.contents.filter(fn); }
}

export function installFoundryStub({ users = [{ id: "gm1", isGM: true, active: true }], currentUserId = "gm1", worldTime = 0, system = "pf2e" } = {}) {
  const prev = {};
  const keep = (k, v) => { prev[k] = globalThis[k]; globalThis[k] = v; };

  const settings = new Map();
  const settingWrites = [];
  const notifications = [];
  const hooks = new HooksStub();

  const userDocs = new Collection();
  for (const u of users) userDocs.set(u.id, { id: u.id, name: u.name ?? u.id, isGM: !!u.isGM, active: u.active !== false });

  const journal = new Collection();
  const folders = new Collection();
  const actors = new Collection();
  const scenes = new Collection();
  const chat = [];

  const settingsApi = {
    register(ns, key, data) { if (!settings.has(`${ns}.${key}`)) settings.set(`${ns}.${key}`, structuredClone(data.default)); },
    registerMenu() {},
    get(ns, key) { return structuredClone(settings.get(`${ns}.${key}`)); },
    async set(ns, key, value) {
      settings.set(`${ns}.${key}`, structuredClone(value));
      settingWrites.push({ key: `${ns}.${key}`, value: structuredClone(value) });
      hooks.callAll("updateSetting", { key: `${ns}.${key}`, value });
      return value;
    }
  };

  const game = {
    user: userDocs.get(currentUserId),
    users: userDocs,
    settings: settingsApi,
    journal, folders, actors, scenes,
    time: { worldTime },
    system: { id: system },
    modules: new Map([[MODULE_ID, { id: MODULE_ID, active: true, version: "0.0.0-test" }]]),
    i18n: {
      has: () => true,
      localize: k => k,
      format: (k, d) => `${k}${d ? " " + JSON.stringify(d) : ""}`
    }
  };

  let docCounter = 0;
  const nextId = () => `doc${++docCounter}`;

  keep("game", game);
  keep("Hooks", hooks);
  keep("ui", { notifications: { info: m => notifications.push(["info", m]), warn: m => notifications.push(["warn", m]), error: m => notifications.push(["error", m]) } });
  keep("CONST", { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } });
  keep("foundry", { utils: { randomID: (n = 16) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, "x") } });
  keep("fromUuidSync", uuid => {
    for (const c of [actors, journal]) for (const d of c.values()) if (d.uuid === uuid) return d;
    return null;
  });
  keep("JournalEntry", { async create(data) { const d = new Document({ id: nextId(), documentName: "JournalEntry", ...data }); d._collection = journal; journal.set(d.id, d); return d; } });
  keep("Folder", { async create(data) { const d = new Document({ id: nextId(), documentName: "Folder", ...data }); d.type = data.type; folders.set(d.id, d); return d; } });
  keep("ChatMessage", { async create(data) { chat.push(structuredClone(data)); return data; } });

  // Register the module's own hidden settings so the store can read them.
  for (const key of ["clocks", "registeredHooks"]) settingsApi.register(MODULE_ID, key, { default: [] });
  settingsApi.register(MODULE_ID, "state", { default: {} });
  for (const key of ["privateEntryId", "folderId"]) settingsApi.register(MODULE_ID, key, { default: "" });
  settingsApi.register(MODULE_ID, "timeSource", { default: "auto" });
  settingsApi.register(MODULE_ID, "chatCards", { default: "all" });
  settingsApi.register(MODULE_ID, "restDebounceSeconds", { default: 0 });
  settingsApi.register(MODULE_ID, "debugLogging", { default: false });

  const addActor = ({ id = nextId(), name = "Actor", ownership = {}, type = "character" } = {}) => {
    const a = new Document({ id, documentName: "Actor", name, ownership, type });
    actors.set(a.id, a);
    return a;
  };

  return {
    game, hooks, settings, settingWrites, notifications, chat, journal, actors, addActor,
    setUser(id) { game.user = userDocs.get(id); },
    setActive(id, active) { userDocs.get(id).active = active; },
    uninstall() { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } }
  };
}

export { Document as StubDocument };
