/**
 * Player proposals (1.1): a player asks for a change the GM approves.
 *
 * Writes stay GM-executed. The request travels on the proposing user's own
 * User document, so "who is asking" is stamped by the server rather than
 * claimed in the payload. When Through the Ages is active its relay factory is
 * used; otherwise an equivalent local transport with the same contract runs.
 *
 * Pending proposals live in the world setting `proposals` (written by the
 * primary GM), so every client can show a card's pending state.
 */
import { FLAG_PROPOSALS, MODULE_ID, SETTINGS, TTA_ID, VISIBILITY } from "../constants.js";
import { debug, getSetting, notify, randomID, rerenderModuleApps, setSetting, t, warn } from "../compat.js";
import { canView } from "./permission-service.js";
import * as store from "./store-service.js";

export const PROPOSAL_OPS = Object.freeze({
  ADVANCE: "proposeAdvance",
  NOTE: "proposeNote"
});

export const PROPOSAL_LIMITS = Object.freeze({
  NOTE_MAX: 500,
  PENDING_PER_USER: 10,
  PENDING_MAX: 200
});

/* ------------------------------------------------------------------ */
/*  Pure validation                                                    */
/* ------------------------------------------------------------------ */

/**
 * May this user propose this operation on this clock?
 * Returns { ok, code } where code is an i18n key under STB.Proposal.Error.
 */
export function validateProposal(clock, user, operation, payload, { actorOwner = null } = {}) {
  if (!clock) return { ok: false, code: "noClock" };
  if (!user || user.isGM) return { ok: false, code: "gmProposes" };
  if (!payload || typeof payload !== "object") return { ok: false, code: "payload" };
  switch (operation) {
    case PROPOSAL_OPS.ADVANCE: {
      if (clock.kind !== "project") return { ok: false, code: "notProject" };
      if (clock.ownerUserId !== user.id) return { ok: false, code: "notOwner" };
      const delta = Number(payload.delta);
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1) return { ok: false, code: "delta" };
      return { ok: true };
    }
    case PROPOSAL_OPS.NOTE: {
      if (clock.kind !== "corruption") return { ok: false, code: "notCorruption" };
      if (clock.visibility !== VISIBILITY.ACTOR_OWNERS || !clock.actorUuid) return { ok: false, code: "notActorBound" };
      if (actorOwner !== true) return { ok: false, code: "notActorOwner" };
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return { ok: false, code: "emptyNote" };
      if (text.length > PROPOSAL_LIMITS.NOTE_MAX) return { ok: false, code: "noteLength" };
      return { ok: true };
    }
    default:
      return { ok: false, code: "operation" };
  }
}

/** Build the stored proposal record from a validated request. */
export function buildProposal({ id = randomID(), clock, user, operation, payload, now = new Date().toISOString() }) {
  const record = { id, clockId: clock.id, clockName: clock.name, userId: user.id, userName: user.name ?? user.id, operation, at: now };
  if (operation === PROPOSAL_OPS.ADVANCE) record.delta = Number(payload.delta);
  if (operation === PROPOSAL_OPS.NOTE) record.text = String(payload.text).trim().slice(0, PROPOSAL_LIMITS.NOTE_MAX);
  return record;
}

/* ------------------------------------------------------------------ */
/*  Storage                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pending proposals. The full records (note text, clock names) live on the
 * GM-only journal entry; the world setting carries only what a player's card
 * needs to show "pending": id, clock, user and operation. A player therefore
 * sees their own pending state without any other player's note text leaving
 * the GM's store.
 */
export function getProposals() {
  if (globalThis.game?.user?.isGM) {
    const entry = store.getPrivateEntry();
    const raw = entry?.getFlag(MODULE_ID, FLAG_PROPOSALS) ?? [];
    return Array.isArray(raw) ? raw.filter(p => p && typeof p === "object" && p.id) : [];
  }
  try { return (getSetting(SETTINGS.proposals) ?? []).filter(p => p && typeof p === "object" && p.id); }
  catch { return []; }
}

export function proposalsFor(clockId) {
  return getProposals().filter(p => p.clockId === clockId);
}

export function proposalsEnabled() {
  try { return !!getSetting(SETTINGS.allowProposals); } catch { return false; }
}

function publicView(p) {
  return { id: p.id, clockId: p.clockId, userId: p.userId, operation: p.operation, at: p.at };
}

/** Write the full list to the GM store and the stripped list to the world setting. Caller is inside the queue. */
async function persistProposals(list) {
  const entry = await store.ensurePrivateEntry();
  if (entry) await entry.update({ [`flags.${MODULE_ID}.${FLAG_PROPOSALS}`]: list });
  await setSetting(SETTINGS.proposals, list.map(publicView));
  return list;
}

/** Read-modify-write under the shared write queue so two requests cannot overwrite each other. */
function updateProposals(mutate) {
  return store.writeQueue.enqueue(async () => {
    const current = getProposals();
    const next = await mutate(current);
    if (next === null) return current;
    await persistProposals(next);
    return next;
  });
}

/* ------------------------------------------------------------------ */
/*  Transport                                                          */
/* ------------------------------------------------------------------ */

let relay = null;

/**
 * A minimal relay with Through the Ages' contract, used when TTA is absent.
 * Request on `flags.<module>.requests.<id>` of the requester's own user;
 * executed by the primary GM; response on `flags.<module>.responses.<id>`.
 */
export function createLocalRelay({ moduleId, requestTimeoutMs = 15000, isPrimary }) {
  const pending = new Map();
  const handlers = new Map();
  /** Ids this GM client already executed; bounded so a long session cannot grow it without limit. */
  const executed = new Set();
  const EXECUTED_MAX = 500;
  let registered = false;
  const reqPath = id => `flags.${moduleId}.requests.${id}`;
  const resPath = id => `flags.${moduleId}.responses.${id}`;
  const delReq = id => `flags.${moduleId}.requests.-=${id}`;
  const delRes = id => `flags.${moduleId}.responses.-=${id}`;
  const hasActiveGM = () => (globalThis.game?.users?.contents ?? globalThis.game?.users ?? []).some(u => u.isGM && u.active);

  async function request(operation, payload) {
    if (!hasActiveGM()) throw new Error(t("Proposal.Error.noGM"));
    const id = randomID();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); globalThis.game.user.update({ [delReq(id)]: null }).catch(() => {}); reject(new Error(t("Proposal.Error.timeout"))); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timeout });
    });
    try { await globalThis.game.user.update({ [reqPath(id)]: { operation, payload, requestedAt: Date.now() } }); }
    catch (e) { const r = pending.get(id); if (r) { clearTimeout(r.timeout); pending.delete(id); } warn("relay request refused", e); throw new Error(t("Proposal.Error.relayUnavailable")); }
    return promise;
  }

  async function handleRequests(user, byUserId) {
    if (!isPrimary()) return;
    if (byUserId !== user.id) return; // only the user's own writes count as that user asking
    const requests = user.getFlag(moduleId, "requests") ?? {};
    for (const [id, entry] of Object.entries(requests)) {
      if (!entry || typeof entry !== "object" || executed.has(id)) continue;
      executed.add(id);
      if (executed.size > EXECUTED_MAX) executed.delete(executed.values().next().value);
      const response = { ok: false };
      try {
        const handler = handlers.get(entry.operation);
        if (!handler) throw new Error(`Unsupported operation: ${entry.operation}`);
        response.result = await handler(entry.payload, user);
        response.ok = true;
      } catch (e) { response.error = e.message ?? String(e); }
      try { await user.update({ [resPath(id)]: response, [delReq(id)]: null }); }
      catch (e) { warn("could not return relay result", e); }
    }
  }

  function handleResponses(user) {
    if (user.id !== globalThis.game.user.id) return;
    const responses = user.getFlag(moduleId, "responses") ?? {};
    for (const [id, response] of Object.entries(responses)) {
      const record = pending.get(id);
      // A response to a request this client gave up on (timeout, reload) is still
      // ours to clear, or it would sit on the document forever.
      if (!record) { globalThis.game.user.update({ [delRes(id)]: null }).catch(() => {}); continue; }
      pending.delete(id);
      clearTimeout(record.timeout);
      globalThis.game.user.update({ [delRes(id)]: null }).catch(() => {});
      if (response?.ok) record.resolve(response.result); else record.reject(new Error(response?.error ?? t("Proposal.Error.failed")));
    }
  }

  async function clearStaleRelayFlags() {
    const user = globalThis.game.user;
    const stale = {};
    for (const id of Object.keys(user.getFlag(moduleId, "requests") ?? {})) stale[delReq(id)] = null;
    for (const id of Object.keys(user.getFlag(moduleId, "responses") ?? {})) stale[delRes(id)] = null;
    if (!Object.keys(stale).length) return 0;
    try { await user.update(stale); } catch (e) { debug("stale relay flags", e); }
    return Object.keys(stale).length;
  }

  function registerRelay() {
    if (registered) return;
    registered = true;
    globalThis.Hooks.on("updateUser", (user, changes, options, byUserId) => {
      if (!changes?.flags?.[moduleId]) return;
      handleRequests(user, byUserId);
      handleResponses(user);
    });
  }

  return { moduleId, request, registerHandler: (op, fn) => handlers.set(op, fn), registerRelay, clearStaleRelayFlags, hasActiveGM, isPrimaryGM: isPrimary };
}

function ttaRelayFactory() {
  const mod = globalThis.game?.modules?.get(TTA_ID);
  return mod?.active ? mod.api?.relay?.createRelay ?? null : null;
}

/** Create (once) the relay this module uses. */
export function getRelay({ isPrimary }) {
  if (relay) return relay;
  const factory = ttaRelayFactory();
  relay = factory ? factory({ moduleId: MODULE_ID }) : createLocalRelay({ moduleId: MODULE_ID, isPrimary });
  debug("proposal relay", factory ? "through-the-ages" : "local");
  return relay;
}

/* ------------------------------------------------------------------ */
/*  GM-side handlers                                                   */
/* ------------------------------------------------------------------ */

function actorOwnedBy(clock, user) {
  const actor = store.resolveActor(clock.actorUuid);
  if (!actor) return false;
  const level = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  try { return actor.testUserPermission(user, level); } catch { return false; }
}

/** Executed on the primary GM for a relayed request. Returns the stored proposal id. */
export async function handleProposal(operation, payload, user) {
  if (!proposalsEnabled()) throw new Error(t("Proposal.Error.disabled"));
  if (!user?.active) throw new Error(t("Proposal.Error.inactive"));
  const clock = store.getClock(payload?.clockId);
  const check = validateProposal(clock, user, operation, payload, { actorOwner: clock ? actorOwnedBy(clock, user) : null });
  if (!check.ok) throw new Error(t(`Proposal.Error.${check.code}`));
  if (!canView(clock, user)) throw new Error(t("Proposal.Error.notOwner"));
  const record = buildProposal({ clock, user, operation, payload });
  // Limits and duplicates are judged against the list as it is at write time.
  await updateProposals(existing => {
    if (existing.length >= PROPOSAL_LIMITS.PENDING_MAX) throw new Error(t("Proposal.Error.queueFull"));
    if (existing.filter(p => p.userId === user.id).length >= PROPOSAL_LIMITS.PENDING_PER_USER) throw new Error(t("Proposal.Error.tooMany"));
    if (operation === PROPOSAL_OPS.ADVANCE && existing.some(p => p.clockId === clock.id && p.userId === user.id && p.operation === operation)) {
      throw new Error(t("Proposal.Error.duplicate"));
    }
    return [...existing, record];
  });
  notify("info", t("Proposal.Notify.received", { user: record.userName, clock: clock.name }));
  rerenderModuleApps();
  return { id: record.id };
}

/** Approve: run the change with the proposer recorded, then drop the proposal. GM. */
export async function approveProposal(id, { dispatcher }) {
  const p = getProposals().find(x => x.id === id);
  if (!p) return null;
  const clock = store.getClock(p.clockId);
  let result = null;
  let outcome = { approved: false, reason: t("Proposal.Error.noClock") };
  if (clock) {
    const op = p.operation === PROPOSAL_OPS.ADVANCE
      ? { clockId: clock.id, op: "delta", value: p.delta, source: "proposal", note: t("Proposal.Log.approved", { user: p.userName }) }
      : { clockId: clock.id, op: "note", value: p.text, source: "proposal" };
    result = await dispatcher.runBatch({ ops: [op], context: { source: "proposal", userId: p.userId } });
    outcome = result?.changed?.length
      ? { approved: true }
      : { approved: false, reason: t("Proposal.Error.noChange") };
  }
  await removeProposal(id);
  whisper(p, outcome.approved, outcome.reason ?? "");
  rerenderModuleApps();
  return result;
}

/** Reject: drop the proposal and tell the proposer. GM. */
export async function rejectProposal(id, reason = "") {
  const p = getProposals().find(x => x.id === id);
  if (!p) return false;
  await removeProposal(id);
  whisper(p, false, reason);
  rerenderModuleApps();
  return true;
}

/** Drop one proposal, re-reading the list at write time so arrivals during an await survive. */
function removeProposal(id) {
  return updateProposals(current => (current.some(x => x.id === id) ? current.filter(x => x.id !== id) : null));
}

function whisper(p, approved, reason = "") {
  const ChatMessage = globalThis.ChatMessage ?? globalThis.foundry?.documents?.ChatMessage;
  if (!ChatMessage?.create) return;
  const what = p.operation === PROPOSAL_OPS.ADVANCE ? t("Proposal.describeAdvance", { delta: p.delta > 0 ? `+${p.delta}` : p.delta, clock: p.clockName }) : t("Proposal.describeNote", { clock: p.clockName });
  const content = `<div class="stb stb-chat-card"><div class="stb-chat-card__body"><strong>${approved ? t("Proposal.Notify.approvedTitle") : t("Proposal.Notify.rejectedTitle")}</strong><div>${what}</div>${reason ? `<div class="stb-chat-card__note">${reason}</div>` : ""}</div></div>`;
  ChatMessage.create({ content, whisper: [p.userId], speaker: { alias: t("Card.speaker") }, flags: { [MODULE_ID]: { proposal: p.id } } }).catch(e => warn("proposal whisper failed", e));
}

/* ------------------------------------------------------------------ */
/*  Player side                                                        */
/* ------------------------------------------------------------------ */

/** What the current player may propose on a clock, for the board. */
export function proposalOptions(clock, user = globalThis.game?.user) {
  if (!proposalsEnabled() || !user || user.isGM || !clock) return { advance: false, note: false };
  const advance = validateProposal(clock, user, PROPOSAL_OPS.ADVANCE, { delta: 1 }).ok;
  const note = validateProposal(clock, user, PROPOSAL_OPS.NOTE, { text: "x" }, { actorOwner: actorOwnedBy(clock, user) }).ok;
  return { advance, note };
}

export async function propose(operation, payload, { isPrimary }) {
  const r = getRelay({ isPrimary });
  try {
    const result = await r.request(operation, payload);
    notify("info", t("Proposal.Notify.sent"));
    return result;
  } catch (e) {
    notify("warn", e.message);
    return null;
  }
}

/** Wire the relay on every client; register handlers (they only run on the primary GM). */
export function startProposalService({ isPrimary }) {
  const r = getRelay({ isPrimary });
  r.registerHandler(PROPOSAL_OPS.ADVANCE, (payload, user) => handleProposal(PROPOSAL_OPS.ADVANCE, payload, user));
  r.registerHandler(PROPOSAL_OPS.NOTE, (payload, user) => handleProposal(PROPOSAL_OPS.NOTE, payload, user));
  r.registerRelay();
  r.clearStaleRelayFlags?.().catch?.(() => {});
  return r;
}
