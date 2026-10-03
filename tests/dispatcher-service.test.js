import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { MODULE_ID, HOOKS } from "../scripts/constants.js";
import { createClock } from "../scripts/services/clock-service.js";

const stubOpts = { users: [{ id: "gmB", isGM: true, active: true }, { id: "gmA", isGM: true, active: true }, { id: "p1", isGM: false, active: true }], currentUserId: "gmA" };

async function load() {
  // Dynamic import after the stub is installed; modules only touch globals at call time anyway.
  const store = await import("../scripts/services/store-service.js");
  const dispatcher = await import("../scripts/services/dispatcher-service.js");
  const chat = await import("../scripts/services/chat-service.js");
  return { store, dispatcher, chat };
}

test("primary GM election picks the lowest id among active GMs", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { dispatcher } = await load();
    assert.equal(dispatcher.primaryGMId(), "gmA");
    assert.equal(dispatcher.isPrimaryGM(), true);
    stub.setUser("gmB");
    assert.equal(dispatcher.isPrimaryGM(), false);
    stub.setActive("gmA", false);
    assert.equal(dispatcher.primaryGMId(), "gmB");
    assert.equal(dispatcher.isPrimaryGM(), true);
    stub.setUser("p1");
    assert.equal(dispatcher.isPrimaryGM(), false);
  } finally { stub.uninstall(); }
});

test("non-primary GM ignores trigger events; local events still run", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store, dispatcher } = await load();
    const clock = createClock({ kind: "project", name: "Dig", visibility: "players", segments: 4 });
    await store.writeBatch({ upsert: [clock] });
    stub.setUser("gmB");
    const ignored = await dispatcher.dispatch({ type: "rest", actors: [] });
    assert.equal(ignored, null);
    assert.equal(store.getClock(clock.id).filled, 0);
    const ran = await dispatcher.dispatch({ type: "rest", actors: [] }, { local: true });
    assert.equal(ran.changed.length, 1);
    assert.equal(store.getClock(clock.id).filled, 1);
  } finally { stub.uninstall(); }
});

test("one evaluation writes each store once and includes the processed moment", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store, dispatcher } = await load();
    await store.ensurePrivateEntry();
    const pub1 = createClock({ kind: "progress", name: "A", visibility: "players", segments: 8, triggers: [{ type: "time", advance: 1, every: { hours: 8 } }] });
    const pub2 = createClock({ kind: "progress", name: "B", visibility: "players", segments: 8, triggers: [{ type: "time", advance: 1, every: { days: 1 } }] });
    const priv = createClock({ kind: "threat", name: "C", visibility: "gm-only", segments: 8, triggers: [{ type: "time", advance: 1, every: { hours: 8 } }] });
    await store.writeBatch({ upsert: [pub1, pub2, priv] });
    stub.settingWrites.length = 0;
    const entry = store.getPrivateEntry();
    entry.updates.length = 0;

    const to = { year: 1, month: 1, day: 2, hour: 0, minute: 0 };
    const res = await dispatcher.runBatch({
      events: [{ type: "time", seconds: 86400, from: { year: 1, month: 1, day: 1, hour: 0, minute: 0 }, to, calendar: { monthLengths: [30], monthBase: 1 } }],
      context: { source: "time", moment: to, state: { lastProcessedMoment: to } }
    });
    assert.equal(res.changed.length, 3);
    const clockWrites = stub.settingWrites.filter(w => w.key === `${MODULE_ID}.clocks`);
    const stateWrites = stub.settingWrites.filter(w => w.key === `${MODULE_ID}.state`);
    assert.equal(clockWrites.length, 1, "public store written once");
    assert.equal(entry.updates.length, 1, "private entry written once");
    assert.equal(stateWrites.length, 1, "state written once");
    assert.deepEqual(stateWrites[0].value.lastProcessedMoment, to);
    assert.equal(store.getClock(pub1.id).filled, 3);
    assert.equal(store.getClock(pub2.id).filled, 1);
    assert.equal(store.getClock(priv.id).filled, 3);
    // Threat thresholds 2 crossed -> hook emitted.
    assert.ok(stub.hooks.calls.some(c => c.name === HOOKS.thresholdReached));
    assert.ok(stub.hooks.calls.some(c => c.name === HOOKS.clockAdvanced));
  } finally { stub.uninstall(); }
});

test("linked chains propagate within one batch and stop at depth 5", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store, dispatcher } = await load();
    const chain = [];
    for (let i = 0; i < 7; i++) {
      chain.push(createClock({
        id: `c${i}`, kind: "progress", name: `c${i}`, visibility: "players", segments: 1,
        triggers: i ? [{ type: "linked", advance: "complete", clockId: `c${i - 1}`, when: "completed" }] : [{ type: "rest", advance: "complete" }]
      }));
    }
    await store.writeBatch({ upsert: chain });
    stub.settingWrites.length = 0;
    await dispatcher.dispatch({ type: "rest", actors: [] });
    const completed = chain.map(c => store.getClock(c.id).filled === 1);
    assert.deepEqual(completed, [true, true, true, true, true, true, false]);
    assert.equal(stub.settingWrites.filter(w => w.key === `${MODULE_ID}.clocks`).length, 1);
  } finally { stub.uninstall(); }
});

test("concurrent batches serialise: two quick +1 clicks are both applied", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store, dispatcher } = await load();
    const clock = createClock({ kind: "progress", name: "Race", visibility: "players", segments: 8 });
    await store.writeBatch({ upsert: [clock] });
    await Promise.all([dispatcher.manual(clock.id, "delta", 1), dispatcher.manual(clock.id, "delta", 1)]);
    assert.equal(store.getClock(clock.id).filled, 2);
  } finally { stub.uninstall(); }
});

test("a matched trigger that moves nothing and changes no bookkeeping is not written", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store, dispatcher } = await load();
    const full = createClock({ kind: "progress", name: "Full", visibility: "players", segments: 2, filled: 2, triggers: [{ id: "h", type: "hook", advance: 1, hook: "pauseGame" }] });
    await store.writeBatch({ upsert: [full] });
    stub.settingWrites.length = 0;
    const r = await dispatcher.dispatch({ type: "hook", hook: "pauseGame" });
    assert.equal(r.changed.length, 0);
    assert.equal(stub.settingWrites.filter(w => w.key === `${MODULE_ID}.clocks`).length, 0, "no write, so no self-feeding loop");
  } finally { stub.uninstall(); }
});

test("rival faction clocks: completion resets the rival", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store, dispatcher } = await load();
    const a = createClock({ id: "crows", kind: "faction", name: "Crows", visibility: "players", segments: 2 });
    const b = createClock({ id: "lamps", kind: "faction", name: "Lampblacks", visibility: "players", segments: 4, filled: 3, triggers: [{ type: "linked", advance: "reset", clockId: "crows", when: "completed" }] });
    await store.writeBatch({ upsert: [a, b] });
    await dispatcher.manual("crows", "delta", 2);
    assert.equal(store.getClock("crows").filled, 2);
    assert.equal(store.getClock("lamps").filled, 0);
  } finally { stub.uninstall(); }
});

test("reveal moves a clock between stores in one operation; players never receive gm-only data", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store, dispatcher } = await load();
    await store.ensurePrivateEntry();
    const clock = createClock({ kind: "progress", name: "Secret", visibility: "gm-only", segments: 4 });
    await store.writeBatch({ upsert: [clock] });
    assert.equal(stub.settings.get(`${MODULE_ID}.clocks`).length, 0);
    stub.setUser("p1");
    assert.equal(store.getAllClocks().length, 0, "player reads nothing");
    stub.setUser("gmA");
    await dispatcher.saveClock({ ...clock, visibility: "players" });
    assert.equal(stub.settings.get(`${MODULE_ID}.clocks`).length, 1);
    assert.equal(store.getPrivateEntry().getFlag(MODULE_ID, "clocks").length, 0);
    stub.setUser("p1");
    assert.equal(store.getAllClocks().length, 1);
  } finally { stub.uninstall(); }
});

test("actor-bound clocks live in the GM entry and reach owners through a read-only mirror", async () => {
  const stub = installFoundryStub({ users: [{ id: "gmA", isGM: true, active: true }, { id: "p1", isGM: false, active: true }, { id: "p2", isGM: false, active: true }], currentUserId: "gmA" });
  try {
    const { store } = await load();
    const { canView } = await import("../scripts/services/permission-service.js");
    // p1 owns Vex; p2 can only observe Vex.
    const actor = stub.addActor({ name: "Vex", ownership: { p1: 3, p2: 2 } });
    const clock = createClock({ kind: "corruption", name: "Corruption", visibility: "actor-owners", actorUuid: actor.uuid, segments: 6 });
    await store.writeBatch({ upsert: [clock] });

    // Authoritative record lives in the GM-only entry; the actor carries no flags.
    const priv = store.getPrivateEntry().getFlag(MODULE_ID, "clocks");
    assert.equal(priv.length, 1);
    assert.equal(priv[0].visibility, "actor-owners");
    assert.equal(actor.getFlag(MODULE_ID, "clocks"), undefined);

    // One mirror per actor, observable only by the owner.
    const mirrors = stub.journal.contents.filter(e => e.getFlag(MODULE_ID, "mirrorFor"));
    assert.equal(mirrors.length, 1);
    const mirror = mirrors[0];
    assert.equal(mirror.name, "Adventure Clocks: Vex");
    assert.equal(mirror.ownership.default, 0);
    assert.equal(mirror.ownership.p1, 2, "owner observes the mirror");
    assert.equal(mirror.ownership.p2, undefined, "a mere observer of the actor gets nothing");
    assert.equal(mirror.getFlag(MODULE_ID, "clocks")[0].id, clock.id);

    stub.setUser("p1");
    assert.equal(store.getAllClocks().length, 1, "owner reads the mirror");
    assert.equal(canView(store.getClock(clock.id)), true);
    stub.setUser("p2");
    // In Foundry the mirror would not even be sent to p2; the stub returns it, so check the permission test.
    assert.equal(canView(clock), false);

    // Ownership change rebuilds the mirror; deletion of the clock removes it.
    stub.setUser("gmA");
    actor.ownership = { default: 0, p2: 3 };
    await store.syncMirrors();
    assert.equal(mirror.ownership.p1, 0);
    assert.equal(mirror.ownership.p2, 2);
    await store.writeBatch({ remove: [clock.id] });
    assert.equal(stub.journal.contents.filter(e => e.getFlag(MODULE_ID, "mirrorFor")).length, 0);
  } finally { stub.uninstall(); }
});

test("corruption clocks refuse party, loot, vehicle and hazard actors", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store } = await load();
    for (const type of ["party", "loot", "vehicle", "hazard"]) assert.equal(store.isBindableActor(stub.addActor({ type })), false, type);
    for (const type of ["character", "npc", "familiar"]) assert.equal(store.isBindableActor(stub.addActor({ type })), true, type);
  } finally { stub.uninstall(); }
});

test("a PF2e party rest is debounced into one rest event", async () => {
  const stub = installFoundryStub({ ...stubOpts });
  try {
    const { startRestService, stopRestService } = await import("../scripts/services/rest-service.js");
    const rests = [];
    startRestService(payload => rests.push(payload));
    const a = stub.addActor({ name: "A" }), b = stub.addActor({ name: "B" });
    stub.hooks.callAll("pf2e.restForTheNight", a);
    stub.hooks.callAll("pf2e.restForTheNight", b);
    stub.hooks.callAll("pf2e.restForTheNight", "not an actor");
    await new Promise(r => setTimeout(r, 30));
    assert.equal(rests.length, 1);
    assert.deepEqual(rests[0].actors.sort(), [a.uuid, b.uuid].sort());
    stopRestService();
  } finally { stub.uninstall(); }
});

test("private entry ownership is repaired", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { store } = await load();
    const entry = await store.ensurePrivateEntry();
    assert.equal(entry.ownership.default, 0);
    entry.ownership = { default: 2, p1: 3, gmA: 3 };
    await store.repairOwnership(entry);
    assert.equal(entry.ownership.default, 0);
    assert.equal(entry.ownership.p1, 0);
    assert.equal(entry.ownership.gmA, 3);
  } finally { stub.uninstall(); }
});

test("chat cards respect the visibility mode and whisper GM-only clocks", async () => {
  const stub = installFoundryStub(stubOpts);
  try {
    const { chat, dispatcher, store } = await load();
    dispatcher.configure({ postCards: chat.postCards, timeInfo: () => ({ moment: null, worldTime: 0, calendar: null }) });
    const pub = createClock({ kind: "progress", name: "P", visibility: "players", segments: 4 });
    const priv = createClock({ kind: "progress", name: "S", visibility: "gm-only", segments: 4 });
    await store.writeBatch({ upsert: [pub, priv] });
    await dispatcher.manual(pub.id, "delta", 1);
    await dispatcher.manual(priv.id, "delta", 1);
    assert.equal(stub.chat.length, 2);
    assert.equal(stub.chat[0].whisper, undefined);
    assert.deepEqual(stub.chat[1].whisper.sort(), ["gmA", "gmB"]);
    dispatcher.configure({ postCards: null });
  } finally { stub.uninstall(); }
});
