/**
 * Who may see or edit which clocks. Foundry globals only at call time.
 */
import { VISIBILITY } from "../constants.js";

export function canEdit(user = globalThis.game?.user) {
  return !!user?.isGM;
}

function resolveActor(uuid) {
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

export function actorForClock(clock) {
  return resolveActor(clock?.actorUuid);
}

export function canView(clock, user = globalThis.game?.user) {
  if (!clock) return false;
  if (user?.isGM) return true;
  switch (clock.visibility) {
    case VISIBILITY.PLAYERS: return true;
    case VISIBILITY.ACTOR_OWNERS: {
      const actor = resolveActor(clock.actorUuid);
      if (!actor) return false;
      const level = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      try { return actor.testUserPermission(user, level); }
      catch { return false; }
    }
    default: return false;
  }
}

export function visibleClocks(clocks, user = globalThis.game?.user) {
  return clocks.filter(c => canView(c, user));
}

/** Users who should receive a whisper about this clock. */
export function recipientsFor(clock) {
  const users = globalThis.game?.users?.contents ?? [];
  if (clock.visibility === VISIBILITY.PLAYERS) return null; // public
  return users.filter(u => canView(clock, u)).map(u => u.id);
}
