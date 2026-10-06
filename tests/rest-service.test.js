import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { ownedRestActors } from "../scripts/services/rest-service.js";

test("a relayed rest counts only bindable actors the relaying user owns", async () => {
  const stub = installFoundryStub({ users: [{ id: "gm1", isGM: true }, { id: "p1", isGM: false }, { id: "p2", isGM: false }], currentUserId: "gm1" });
  try {
    const store = await import("../scripts/services/store-service.js");
    const mine = stub.addActor({ id: "mine", ownership: { p1: 3 } });
    const theirs = stub.addActor({ id: "theirs", ownership: { p2: 3 } });
    const loot = stub.addActor({ id: "loot", ownership: { p1: 3 }, type: "loot" });
    const deps = { resolve: store.resolveActor, bindable: store.isBindableActor };
    const p1 = stub.game.users.get("p1");
    assert.deepEqual(ownedRestActors([mine.uuid, theirs.uuid, loot.uuid, "Actor.missing", 42], p1, deps), [mine.uuid]);
    assert.deepEqual(ownedRestActors([mine.uuid, mine.uuid], p1, deps), [mine.uuid], "duplicates collapse");
    assert.deepEqual(ownedRestActors([], p1, deps), [], "an empty relay moves nothing");
    assert.deepEqual(ownedRestActors([mine.uuid], null, deps), []);
    // A GM relaying from a non-primary client owns everything.
    assert.deepEqual(ownedRestActors([mine.uuid, theirs.uuid], stub.game.users.get("gm1"), deps), [mine.uuid, theirs.uuid]);
  } finally { stub.uninstall(); }
});
