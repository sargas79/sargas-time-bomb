/**
 * Storage: player-visible clocks in a world setting, GM-only clocks as flags on
 * a journal entry nobody owns, actor-bound clocks as flags on the actor.
 * All writes are serialised through one WriteQueue. Foundry globals are only
 * touched inside functions.
 */
import { FLAG_CLOCKS, FOLDER_NAME, MODULE_ID, PRIVATE_ENTRY_NAME, SETTINGS, VISIBILITY } from "../constants.js";
import { debug, getSetting, setSetting, warn } from "../compat.js";
import { compareClocks } from "./clock-service.js";
import { defaultState, migrateClocks, migrateState } from "./migration-service.js";
import { WriteQueue } from "./write-queue.js";

export const writeQueue = new WriteQueue();

function game() { return globalThis.game; }

/* ------------------------------------------------------------------ */
/*  Reading                                                            */
/* ------------------------------------------------------------------ */

export function getPrivateEntry() {
  const id = getSetting(SETTINGS.privateEntryId);
  if (!id) return null;
  return game().journal?.get(id) ?? null;
}

export function readPublicClocks() {
  const raw = getSetting(SETTINGS.clocks);
  return migrateClocks(raw).clocks.map(c => ({ ...c, visibility: VISIBILITY.PLAYERS }));
}

export function readPrivateClocks() {
  if (!game().user?.isGM) return [];
  const entry = getPrivateEntry();
  if (!entry) return [];
  const raw = entry.getFlag(MODULE_ID, FLAG_CLOCKS) ?? [];
  return migrateClocks(raw).clocks.map(c => ({ ...c, visibility: VISIBILITY.GM_ONLY }));
}

export function resolveActor(uuid) {
  if (!uuid) return null;
  try {
    const doc = globalThis.fromUuidSync?.(uuid);
    if (!doc) return null;
    if (doc.documentName === "Actor") return doc;
    if (doc.documentName === "Token") return doc.actor ?? null;
    return doc.actor ?? null;
  } catch {
    return null;
  }
}

function actorUuids() {
  const set = new Set(getSetting(SETTINGS.actorIndex) ?? []);
  // Self-heal: any world actor carrying our flag is included even if the index lost it.
  for (const a of game().actors?.contents ?? []) {
    if (a.getFlag(MODULE_ID, FLAG_CLOCKS)?.length) set.add(a.uuid);
  }
  return [...set];
}

export function readActorClocks() {
  const out = [];
  for (const uuid of actorUuids()) {
    const actor = resolveActor(uuid);
    if (!actor) continue;
    const raw = actor.getFlag(MODULE_ID, FLAG_CLOCKS) ?? [];
    for (const c of migrateClocks(raw).clocks) {
      out.push({ ...c, visibility: VISIBILITY.ACTOR_OWNERS, actorUuid: c.actorUuid || uuid });
    }
  }
  return out;
}

/** Every clock this client can read, sorted for the board. */
export function getAllClocks() {
  const all = [...readPublicClocks(), ...readPrivateClocks(), ...readActorClocks()];
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; }).sort(compareClocks);
}

export function getClock(id) {
  return getAllClocks().find(c => c.id === id) ?? null;
}

export function getState() {
  return migrateState(getSetting(SETTINGS.state)).state;
}

/* ------------------------------------------------------------------ */
/*  Writing                                                            */
/* ------------------------------------------------------------------ */

function storeKeyFor(clock) {
  if (clock.visibility === VISIBILITY.PLAYERS) return "public";
  if (clock.visibility === VISIBILITY.ACTOR_OWNERS) return `actor:${clock.actorUuid}`;
  return "private";
}

function stripForStorage(clock) {
  // Visibility is implied by the store, but keeping it makes exports simpler.
  return clock;
}

/**
 * Apply a batch of changes in one serialised write per affected store.
 * changes: { upsert: [clock], remove: [id], state: partial }
 */
export function writeBatch(changes) {
  return writeQueue.enqueue(() => performWrite(changes));
}

async function performWrite({ upsert = [], remove = [], state = null } = {}) {
  if (!game().user?.isGM) throw new Error(`${MODULE_ID}: only a GM may write clocks`);
  const current = getAllClocks();
  const currentKey = new Map(current.map(c => [c.id, storeKeyFor(c)]));

  // Work out the final content of every touched store.
  const stores = new Map(); // key -> { list: clock[], dirty }
  const ensure = key => {
    if (!stores.has(key)) {
      let list;
      if (key === "public") list = readPublicClocks();
      else if (key === "private") list = readPrivateClocks();
      else list = readActorClocks().filter(c => `actor:${c.actorUuid}` === key);
      stores.set(key, { list: [...list], dirty: false });
    }
    return stores.get(key);
  };

  for (const id of remove) {
    const key = currentKey.get(id);
    if (!key) continue;
    const s = ensure(key);
    s.list = s.list.filter(c => c.id !== id);
    s.dirty = true;
  }
  for (const clock of upsert) {
    const newKey = storeKeyFor(clock);
    const oldKey = currentKey.get(clock.id);
    if (oldKey && oldKey !== newKey) {
      const s = ensure(oldKey);
      s.list = s.list.filter(c => c.id !== clock.id);
      s.dirty = true;
    }
    const s = ensure(newKey);
    const idx = s.list.findIndex(c => c.id === clock.id);
    if (idx >= 0) s.list[idx] = stripForStorage(clock); else s.list.push(stripForStorage(clock));
    s.dirty = true;
  }

  const results = [];
  for (const [key, s] of stores) {
    if (!s.dirty) continue;
    if (key === "public") {
      results.push(await setSetting(SETTINGS.clocks, s.list));
    } else if (key === "private") {
      const entry = await ensurePrivateEntry();
      if (!entry) { warn("No private journal entry available; GM-only clocks were not saved."); continue; }
      results.push(await entry.update({ [`flags.${MODULE_ID}.${FLAG_CLOCKS}`]: s.list }));
    } else {
      const uuid = key.slice("actor:".length);
      const actor = resolveActor(uuid);
      if (!actor) { warn(`Actor ${uuid} not found; its clocks were not saved.`); continue; }
      results.push(await actor.update({ [`flags.${MODULE_ID}.${FLAG_CLOCKS}`]: s.list }));
      await updateActorIndex(uuid, s.list.length > 0);
    }
  }
  if (state) {
    const merged = { ...getState(), ...state };
    results.push(await setSetting(SETTINGS.state, merged));
  }
  debug("write", { upsert: upsert.map(c => c.id), remove, stores: [...stores.keys()], state });
  return results;
}

async function updateActorIndex(uuid, present) {
  const index = new Set(getSetting(SETTINGS.actorIndex) ?? []);
  const had = index.has(uuid);
  if (present) index.add(uuid); else index.delete(uuid);
  if (had !== present) await setSetting(SETTINGS.actorIndex, [...index]);
}

export function saveState(partial) {
  return writeQueue.enqueue(async () => {
    const merged = { ...getState(), ...partial };
    return setSetting(SETTINGS.state, merged);
  });
}

/* ------------------------------------------------------------------ */
/*  Private entry management                                           */
/* ------------------------------------------------------------------ */

function ownershipLevels() {
  return globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS ?? { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
}

async function ensureFolder() {
  const g = game();
  let folder = null;
  const id = getSetting(SETTINGS.folderId);
  if (id) folder = g.folders?.get(id) ?? null;
  if (!folder) folder = g.folders?.find(f => f.type === "JournalEntry" && f.name === FOLDER_NAME && f.getFlag?.(MODULE_ID, "managed")) ?? null;
  if (!folder) {
    const Folder = globalThis.Folder ?? globalThis.foundry?.documents?.Folder;
    if (!Folder?.create) return null;
    folder = await Folder.create({ name: FOLDER_NAME, type: "JournalEntry", flags: { [MODULE_ID]: { managed: true } } });
  }
  if (folder && folder.id !== id) await setSetting(SETTINGS.folderId, folder.id);
  return folder;
}

/** Find or create the GM-only journal entry; repair its ownership. GM only. */
export async function ensurePrivateEntry() {
  const g = game();
  if (!g.user?.isGM) return null;
  let entry = getPrivateEntry();
  if (!entry) entry = g.journal?.find(e => e.name === PRIVATE_ENTRY_NAME && e.getFlag(MODULE_ID, "managed")) ?? null;
  if (!entry) {
    const JournalEntry = globalThis.JournalEntry ?? globalThis.foundry?.documents?.JournalEntry;
    if (!JournalEntry?.create) return null;
    const folder = await ensureFolder();
    entry = await JournalEntry.create({
      name: PRIVATE_ENTRY_NAME,
      folder: folder?.id ?? null,
      ownership: { default: ownershipLevels().NONE },
      flags: { [MODULE_ID]: { managed: true, [FLAG_CLOCKS]: [] } }
    });
  }
  if (!entry) return null;
  if (entry.id !== getSetting(SETTINGS.privateEntryId)) await setSetting(SETTINGS.privateEntryId, entry.id);
  await repairOwnership(entry);
  return entry;
}

export async function repairOwnership(entry) {
  const NONE = ownershipLevels().NONE;
  const ownership = entry.ownership ?? {};
  const fixes = {};
  if (ownership.default !== NONE) fixes.default = NONE;
  for (const [userId, level] of Object.entries(ownership)) {
    if (userId === "default") continue;
    const user = game().users?.get(userId);
    if (user && !user.isGM && level > NONE) fixes[userId] = NONE;
  }
  if (Object.keys(fixes).length) {
    warn("Repairing ownership of the GM-only clock entry.");
    await entry.update({ ownership: { ...ownership, ...fixes } });
  }
}

/* ------------------------------------------------------------------ */
/*  Startup migration                                                  */
/* ------------------------------------------------------------------ */

/** Migrate stored data in place if older schema versions are found. GM only. */
export async function migrateStoredData() {
  if (!game().user?.isGM) return false;
  let changed = false;
  const pub = migrateClocks(getSetting(SETTINGS.clocks));
  if (pub.migrated) { await setSetting(SETTINGS.clocks, pub.clocks); changed = true; }
  const entry = getPrivateEntry();
  if (entry) {
    const priv = migrateClocks(entry.getFlag(MODULE_ID, FLAG_CLOCKS) ?? []);
    if (priv.migrated) { await entry.update({ [`flags.${MODULE_ID}.${FLAG_CLOCKS}`]: priv.clocks }); changed = true; }
  }
  const st = migrateState(getSetting(SETTINGS.state));
  if (st.migrated) { await setSetting(SETTINGS.state, st.state); changed = true; }
  return changed;
}

export { defaultState };
