import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMinutes, formatRemaining, isRunning, normalizeBreak, remainingMs } from "../scripts/services/break-timer-service.js";

test("break length is whole minutes between 1 and 60", () => {
  assert.equal(clampMinutes(30), 30);
  assert.equal(clampMinutes("45"), 45);
  assert.equal(clampMinutes(0), 1);
  assert.equal(clampMinutes(-5), 1);
  assert.equal(clampMinutes(61), 60);
  assert.equal(clampMinutes(500), 60);
  assert.equal(clampMinutes(12.4), 12);
  assert.equal(clampMinutes(""), null);
  assert.equal(clampMinutes("lunch"), null);
  assert.equal(clampMinutes(null), null);
});

test("a stored break is normalised and an empty setting means no break", () => {
  assert.deepEqual(normalizeBreak({}), { minutes: 30, endsAt: null, startedBy: null });
  assert.deepEqual(normalizeBreak(undefined), { minutes: 30, endsAt: null, startedBy: null });
  assert.deepEqual(normalizeBreak({ minutes: 90, endsAt: "x", startedBy: 7 }), { minutes: 60, endsAt: null, startedBy: null });
  assert.deepEqual(normalizeBreak({ minutes: 15, endsAt: 1000, startedBy: "gm" }), { minutes: 15, endsAt: 1000, startedBy: "gm" });
});

test("remaining time follows the wall clock and stops at zero", () => {
  const timer = { minutes: 10, endsAt: 600000 };
  assert.equal(remainingMs(timer, 0), 600000);
  assert.equal(remainingMs(timer, 599000), 1000);
  assert.equal(remainingMs(timer, 600000), 0);
  assert.equal(remainingMs(timer, 900000), 0);
  assert.equal(remainingMs({ minutes: 10, endsAt: null }, 0), 0);
  assert.equal(isRunning(timer, 1), true);
  assert.equal(isRunning(timer, 600000), false);
});

test("the countdown reads mm:ss, rounded up to the next second", () => {
  assert.equal(formatRemaining(3600000), "60:00");
  assert.equal(formatRemaining(599001), "10:00");
  assert.equal(formatRemaining(599000), "09:59");
  assert.equal(formatRemaining(1), "00:01");
  assert.equal(formatRemaining(0), "00:00");
  assert.equal(formatRemaining(-50), "00:00");
});
