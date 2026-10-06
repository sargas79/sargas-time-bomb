/**
 * Storage: player-visible clocks in a world setting; GM-only and actor-bound
 * clocks as flags on a journal entry nobody owns. Actor-bound clocks reach the
 * actor's owners through read-only mirror entries (one per actor) that only
 * those owners can observe. Mirrors are written only by the primary GM and are
 * never read back as truth. All writes are serialised through one WriteQueue.
 * Foundry globals are only touched inside functions.
 */
import { BINDABLE_ACTOR_TYPES, FLAG_CLOCKS, FLAG_MIRROR_FOR, FOLDER_NAME, MIRROR_ENTRY_PREFIX, MODULE_ID, PRIVATE_ENTRY_NAME, SETTINGS, VISIBILITY } from "../constants.js";
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
  return migrateClocks(raw).clocks.map(c => ({
    ...c,
    visibility: c.visibility === VISIBILITY.ACTOR_OWNERS && c.actorUuid ? VISIBILITY.ACTOR_OWNERS : VISIBILITY.GM_ONLY
  }));
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

/** Is this actor one a corruption clock may be bound to? */
export function isBindableActor(actor) {
  return !!actor && BINDABLE_ACTOR_TYPES.includes(actor.type);
}

/** Mirror entries this client can see (players: only those they observe). */
export function mirrorEntries() {
  return (game().journal?.contents ?? []).filter(e => !!e.getFlag(MODULE_ID, FLAG_MIRROR_FOR));
}

/**
 * Actor-bound clocks as a player sees them: from the read-only mirrors. GMs read
 * the authoritative record from the private entry instead (readPrivateClocks).
 */
export function readMirroredClocks() {
  if (game().user?.isGM) return [];
  const out = [];
  for (const entry of mirrorEntries()) {
    const uuid = entry.getFlag(MODULE_ID, FLAG_MIRROR_FOR);
    const raw = entry.getFlag(MODULE_ID, FLAG_CLOCKS) ?? [];
    for (const c of migrateClocks(raw).clocks) out.push({ ...c, visibility: VISIBILITY.ACTOR_OWNERS, actorUuid: c.actorUuid || uuid, readonly: true });
  }
  return out;
}

/** Every clock this client can read, sorted for the board. */
export function getAllClocks() {
  const all = [...readPublicClocks(), ...readPrivateClocks(), ...readMirroredClocks()];
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
  return clock.visibility === VISIBILITY.PLAYERS ? "public" : "private";
}

/**
 * Apply a batch of changes in one serialised write per affected store.
 * changes: { upsert: [clock], remove: [id], state: partial }
 */
export function writeBatch(changes) {
  return writeQueue.enqueue(() => performWrite(changes));
}

/** Same as writeBatch but for callers already running inside the queue. */
export function writeBatchUnqueued(changes) {
  return performWrite(changes);
}

async function performWrite({ upsert = [], remove = [], state = null } = {}) {
  if (!game().user?.isGM) throw new Error(`${MODULE_ID}: only a GM may write clocks`);
  const current = getAllClocks();
  const currentKey = new Map(current.map(c => [c.id, storeKeyFor(c)]));

  // Work out the final content of every touched store.
  const stores = new Map(); // key -> { list: clock[], dirty }
  const ensure = key => {
    if (!stores.has(key)) {
      const list = key === "public" ? readPublicClocks() : readPrivateClocks();
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
    if (idx >= 0) s.list[idx] = clock; else s.list.push(clock);
    s.dirty = true;
  }

  const results = [];
  let privateTouched = false;
  for (const [key, s] of stores) {
    if (!s.dirty) continue;
    if (key === "public") {
      results.push(await setSetting(SETTINGS.clocks, s.list));
    } else {
      const entry = await ensurePrivateEntry();
      if (!entry) { warn("No private journal entry available; GM-only clocks were not saved."); continue; }
      results.push(await entry.update({ [`flags.${MODULE_ID}.${FLAG_CLOCKS}`]: s.list }));
      privateTouched = true;
    }
  }
  // Owner mirrors follow the authoritative record. Other GM clients rebuild
  // them too when they see the private entry change (hooks.js), if primary.
  if (privateTouched && isPrimaryGMLocal()) await syncMirrorsNow();
  if (state) {
    const merged = { ...getState(), ...state };
    results.push(await setSetting(SETTINGS.state, merged));
  }
  debug("write", { upsert: upsert.map(c => c.id), remove, stores: [...stores.keys()], state });
  return results;
}

export function saveState(partial) {
  return writeQueue.enqueue(() => saveStateUnqueued(partial));
}

/** For callers already inside the write queue. */
export function saveStateUnqueued(partial) {
  const merged = { ...getState(), ...partial };
  return setSetting(SETTINGS.state, merged);
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
/*  Owner mirrors                                                      */
/* ------------------------------------------------------------------ */

function isPrimaryGMLocal() {
  const g = game();
  if (!g.user?.isGM) return false;
  const ids = (g.users?.contents ?? []).filter(u => u.active && u.isGM).map(u => u.id).sort();
  return ids[0] === g.user.id;
}

/** Ownership a mirror must carry: nobody by default, OBSERVER for each non-GM owner of the actor. */
export function mirrorOwnershipFor(actor) {
  const L = ownershipLevels();
  const ownership = { default: L.NONE };
  for (const user of game().users?.contents ?? []) {
    if (user.isGM) continue;
    let owns = false;
    try { owns = actor.testUserPermission(user, L.OWNER); } catch { owns = false; }
    if (owns) ownership[user.id] = L.OBSERVER;
  }
  return ownership;
}

function sameOwnership(a, b) {
  const ka = Object.keys(a ?? {}).filter(k => (a[k] ?? 0) !== 0).sort();
  const kb = Object.keys(b ?? {}).filter(k => (b[k] ?? 0) !== 0).sort();
  if (ka.length !== kb.length || (a?.default ?? 0) !== (b?.default ?? 0)) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Rebuild every owner mirror from the authoritative record. Serialised; GM only. */
export function syncMirrors() {
  return writeQueue.enqueue(() => syncMirrorsNow());
}

async function syncMirrorsNow() {
  const g = game();
  if (!g.user?.isGM) return false;
  const JournalEntry = globalThis.JournalEntry ?? globalThis.foundry?.documents?.JournalEntry;
  const byActor = new Map();
  for (const c of readPrivateClocks()) {
    if (c.visibility !== VISIBILITY.ACTOR_OWNERS || !c.actorUuid) continue;
    if (!byActor.has(c.actorUuid)) byActor.set(c.actorUuid, []);
    byActor.get(c.actorUuid).push(c);
  }
  const existing = new Map(mirrorEntries().map(e => [e.getFlag(MODULE_ID, FLAG_MIRROR_FOR), e]));
  let changed = false;

  for (const [uuid, clocks] of byActor) {
    const actor = resolveActor(uuid);
    const entry = existing.get(uuid);
    if (!actor) {
      if (entry) { await entry.delete(); changed = true; }
      continue;
    }
    const name = `${MIRROR_ENTRY_PREFIX}${actor.name}`;
    const ownership = mirrorOwnershipFor(actor);
    const payload = clocks.map(c => ({ ...c, log: [] }));
    if (!entry) {
      if (!JournalEntry?.create) continue;
      const folder = await ensureFolder();
      await JournalEntry.create({
        name, folder: folder?.id ?? null, ownership,
        flags: { [MODULE_ID]: { managed: true, [FLAG_MIRROR_FOR]: uuid, [FLAG_CLOCKS]: payload } }
      });
      changed = true;
      continue;
    }
    const update = {};
    if (entry.name !== name) update.name = name;
    if (!sameOwnership(entry.ownership, ownership)) {
      // Replace, not merge: stale per-user grants must go.
      update.ownership = { ...Object.fromEntries(Object.keys(entry.ownership ?? {}).filter(k => k !== "default").map(k => [k, ownershipLevels().NONE])), ...ownership };
    }
    if (JSON.stringify(entry.getFlag(MODULE_ID, FLAG_CLOCKS) ?? []) !== JSON.stringify(payload)) update[`flags.${MODULE_ID}.${FLAG_CLOCKS}`] = payload;
    if (Object.keys(update).length) { await entry.update(update); changed = true; }
  }
  // Mirrors whose actor has no clocks left.
  for (const [uuid, entry] of existing) {
    if (byActor.has(uuid)) continue;
    await entry.delete();
    changed = true;
  }
  if (changed) debug("mirrors synced", [...byActor.keys()]);
  return changed;
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
  // Records from a newer schema are kept as they are, but the next save would
  // write them back in this version's shape: say so once, on load.
  const newer = pub.newer + (entry ? migrateClocks(entry.getFlag(MODULE_ID, FLAG_CLOCKS) ?? []).newer : 0);
  if (newer > 0) {
    warn(`${newer} clock(s) were saved by a newer version of this module; editing them here will downgrade them.`);
    try { globalThis.ui?.notifications?.warn?.(globalThis.game?.i18n?.format?.("STB.Notify.newerSchema", { n: newer }) ?? `${newer} clock(s) come from a newer version`, { permanent: true }); } catch { /* notification is best effort */ }
  }
  return changed;
}

export { defaultState };
