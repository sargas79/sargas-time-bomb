import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { MODULE_ID } from "../scripts/constants.js";
import { createClock } from "../scripts/services/clock-service.js";
import { PROPOSAL_OPS, approveProposal, buildProposal, createLocalRelay, getProposals, handleProposal, validateProposal } from "../scripts/services/proposal-service.js";
import * as store from "../scripts/services/store-service.js";
import * as dispatcher from "../scripts/services/dispatcher-service.js";

const player = { id: "p1", name: "Pat", isGM: false };
const gm = { id: "gm1", name: "GM", isGM: true };

test("validateProposal: project +1 by its owner only", () => {
  const owned = createClock({ kind: "project", name: "Dig", ownerUserId: "p1" });
  assert.equal(validateProposal(owned, player, PROPOSAL_OPS.ADVANCE, { delta: 1 }).ok, true);
  assert.equal(validateProposal(owned, player, PROPOSAL_OPS.ADVANCE, { delta: -1 }).ok, true);
  assert.equal(validateProposal(owned, player, PROPOSAL_OPS.ADVANCE, { delta: 2 }).code, "delta");
  assert.equal(validateProposal(owned, { id: "p2" }, PROPOSAL_OPS.ADVANCE, { delta: 1 }).code, "notOwner");
  assert.equal(validateProposal(owned, gm, PROPOSAL_OPS.ADVANCE, { delta: 1 }).code, "gmProposes");
  const progress = createClock({ kind: "progress", name: "x", ownerUserId: "p1" });
  assert.equal(validateProposal(progress, player, PROPOSAL_OPS.ADVANCE, { delta: 1 }).code, "notProject");
  assert.equal(validateProposal(null, player, PROPOSAL_OPS.ADVANCE, { delta: 1 }).code, "noClock");
  assert.equal(validateProposal(owned, player, "hack", {}).code, "operation");
});

test("validateProposal: corruption notes need an owned, actor-bound clock and text within bounds", () => {
  const c = createClock({ kind: "corruption", name: "C", actorUuid: "Actor.a", visibility: "actor-owners" });
  assert.equal(validateProposal(c, player, PROPOSAL_OPS.NOTE, { text: "A whisper" }, { actorOwner: true }).ok, true);
  assert.equal(validateProposal(c, player, PROPOSAL_OPS.NOTE, { text: "A whisper" }, { actorOwner: false }).code, "notActorOwner");
  assert.equal(validateProposal(c, player, PROPOSAL_OPS.NOTE, { text: "   " }, { actorOwner: true }).code, "emptyNote");
  assert.equal(validateProposal(c, player, PROPOSAL_OPS.NOTE, { text: "x".repeat(501) }, { actorOwner: true }).code, "noteLength");
  const unbound = createClock({ kind: "corruption", name: "C" });
  assert.equal(validateProposal(unbound, player, PROPOSAL_OPS.NOTE, { text: "hi" }, { actorOwner: true }).code, "notActorBound");
});

test("buildProposal records who, what and when", () => {
  const clock = createClock({ kind: "project", name: "Dig", ownerUserId: "p1", id: "dig" });
  const p = buildProposal({ id: "x", clock, user: player, operation: PROPOSAL_OPS.ADVANCE, payload: { delta: 1 }, now: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(p, { id: "x", clockId: "dig", clockName: "Dig", userId: "p1", userName: "Pat", operation: PROPOSAL_OPS.ADVANCE, at: "2026-01-01T00:00:00.000Z", delta: 1 });
  const n = buildProposal({ id: "y", clock, user: player, operation: PROPOSAL_OPS.NOTE, payload: { text: "  note  " } });
  assert.equal(n.text, "note");
});

/** Users with flag writes and an updateUser hook, the surface the local relay touches. */
function relayWorld(stub, acting) {
  const users = new Map();
  for (const u of stub.game.users.contents) {
    const doc = { ...u, flags: {}, getFlag(scope, key) { return this.flags[scope]?.[key]; } };
    doc.update = async function (changes, byUserId = this.id) {
      const touched = {};
      for (const [path, value] of Object.entries(changes)) {
        const parts = path.split(".");
        let cursor = this.flags; const leaf = parts.pop();
        for (const part of parts.slice(1)) { cursor[part] ??= {}; cursor = cursor[part]; }
        if (leaf.startsWith("-=")) delete cursor[leaf.slice(2)]; else cursor[leaf] = value;
        touched[parts[1]] = true;
      }
      stub.hooks.callAll("updateUser", this, { flags: Object.fromEntries(Object.keys(touched).map(k => [k, {}])) }, {}, byUserId);
      return this;
    };
    users.set(u.id, doc);
  }
  stub.game.users = { contents: [...users.values()], get: id => users.get(id), filter: fn => [...users.values()].filter(fn), some: fn => [...users.values()].some(fn) };
  stub.game.user = users.get(acting);
  return { users, actAs: id => { stub.game.user = users.get(id); } };
}

test("local relay: a request on the player's own document reaches the primary GM's handler and is answered", async () => {
  const stub = installFoundryStub({ users: [{ id: "gm1", isGM: true, active: true }, { id: "p1", isGM: false, active: true }], currentUserId: "p1" });
  try {
    const world = relayWorld(stub, "p1");
    const seen = [];
    const relay = createLocalRelay({ moduleId: MODULE_ID, requestTimeoutMs: 500, isPrimary: () => stub.game.user?.isGM === true });
    relay.registerHandler("probe", async (payload, user) => { seen.push({ user: user.id, payload }); return payload.n * 2; });
    relay.registerRelay();
    // The player writes; this process also plays the GM, so flip identity before the hook executes.
    const pending = (async () => {
      const p = relay.request("probe", { n: 21 });
      return p;
    })();
    await new Promise(r => setTimeout(r, 0));
    // Execution happens inside the hook fired by the player's own write, which ran as the player
    // (isPrimary false). Re-fire as the GM to execute, then let the response reach the player.
    world.actAs("gm1");
    const p1 = world.users.get("p1");
    await p1.update({ [`flags.${MODULE_ID}.touch`]: 1 }, "p1");
    world.actAs("p1");
    await p1.update({ [`flags.${MODULE_ID}.touch`]: 2 }, "p1");
    assert.equal(await pending, 42);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].user, "p1");
    assert.equal(p1.getFlag(MODULE_ID, "requests") && Object.keys(p1.getFlag(MODULE_ID, "requests")).length, 0);
  } finally { stub.uninstall(); }
});

test("local relay: identity comes from the document, never from who planted the request", async () => {
  const stub = installFoundryStub({ users: [{ id: "gm1", isGM: true, active: true }, { id: "p1", isGM: false, active: true }, { id: "p2", isGM: false, active: true }], currentUserId: "gm1" });
  try {
    const world = relayWorld(stub, "gm1");
    const seen = [];
    const relay = createLocalRelay({ moduleId: MODULE_ID, isPrimary: () => true });
    relay.registerHandler("probe", async (payload, user) => { seen.push(user.id); return true; });
    relay.registerRelay();
    const p1 = world.users.get("p1");
    // Only a GM could do this in Foundry; a player cannot write another user's document at all.
    await p1.update({ [`flags.${MODULE_ID}.requests.r1`]: { operation: "probe", payload: {} } }, "p2");
    assert.equal(seen.length, 0, "a write by someone else is not p1 asking");
    // When p1 next writes, whatever sits on p1's document runs with p1's permissions, never p2's.
    await p1.update({ [`flags.${MODULE_ID}.requests.r2`]: { operation: "probe", payload: {} } }, "p1");
    assert.deepEqual(seen, ["p1", "p1"]);
    assert.ok(!seen.includes("p2"));
  } finally { stub.uninstall(); }
});

test("proposals: full records stay on the GM entry, players see only pending state; approval applies and clears", async () => {
  const stub = installFoundryStub({ users: [{ id: "gm1", isGM: true, active: true }, { id: "p1", isGM: false, active: true }], currentUserId: "gm1" });
  try {
    stub.settings.set(`${MODULE_ID}.allowProposals`, true);
    stub.settings.set(`${MODULE_ID}.proposals`, []);
    await store.ensurePrivateEntry();
    const clock = createClock({ kind: "project", name: "Dig", visibility: "players", segments: 4, ownerUserId: "p1" });
    await store.writeBatch({ upsert: [clock] });
    const pat = { id: "p1", name: "Pat", isGM: false, active: true };

    const { id } = await handleProposal(PROPOSAL_OPS.ADVANCE, { clockId: clock.id, delta: 1 }, pat);
    assert.equal(getProposals().length, 1);
    assert.equal(getProposals()[0].userName, "Pat");
    const shared = stub.settings.get(`${MODULE_ID}.proposals`);
    assert.deepEqual(Object.keys(shared[0]).sort(), ["at", "clockId", "id", "operation", "userId"], "no names or text in the world setting");
    await assert.rejects(handleProposal(PROPOSAL_OPS.ADVANCE, { clockId: clock.id, delta: 1 }, pat), /duplicate/);

    await approveProposal(id, { dispatcher });
    assert.equal(store.getClock(clock.id).filled, 1);
    assert.equal(store.getClock(clock.id).log[0].userId, "p1", "the proposer is on the log entry");
    assert.equal(store.getClock(clock.id).log[0].source, "proposal");
    assert.equal(getProposals().length, 0);
    assert.ok(stub.chat.some(m => Array.isArray(m.whisper) && m.whisper.includes("p1")), "the player was told");
  } finally { stub.uninstall(); }
});
