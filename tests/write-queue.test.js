import { test } from "node:test";
import assert from "node:assert/strict";
import { WriteQueue } from "../scripts/services/write-queue.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("writes run one at a time in FIFO order", async () => {
  const q = new WriteQueue();
  const order = [];
  let inFlight = 0, maxInFlight = 0;
  const job = (name, ms) => q.enqueue(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(ms);
    order.push(name);
    inFlight--;
    return name;
  });
  const results = await Promise.all([job("a", 20), job("b", 5), job("c", 1)]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.equal(maxInFlight, 1);
  assert.equal(q.pending, 0);
});

test("a rejected job does not break the chain", async () => {
  const q = new WriteQueue();
  await assert.rejects(q.enqueue(async () => { throw new Error("boom"); }));
  const v = await q.enqueue(async () => 42);
  assert.equal(v, 42);
  await q.drain();
});
