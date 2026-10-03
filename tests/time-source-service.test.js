import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundryStub } from "./helpers/foundry-stub.js";
import { TTA_ID, TTA_SETTING_KEY } from "../scripts/constants.js";
import { TTASource } from "../scripts/services/time-source-service.js";

const CAL = { monthLengths: Array(12).fill(30), monthNames: Array(12).fill("M"), monthsPerYear: 12, currentDate: { year: 1, month: 1, day: 1 }, currentTime: { hour: 0, minute: 0 } };

function withTTA(stub, { campaignSeconds = true } = {}) {
  const api = {
    getCalendar: () => CAL,
    getCurrentDate: () => CAL.currentDate,
    getCurrentTime: () => CAL.currentTime,
    formatDate: d => `${d.day}/${d.month}/${d.year}`,
    formatTime: t => `${t.hour}:${t.minute}`,
    utils: campaignSeconds ? { campaignSeconds: (d, t) => (((d.year - 1) * 360 + (d.month - 1) * 30 + (d.day - 1)) * 86400) + t.hour * 3600 + t.minute * 60 } : {}
  };
  stub.game.modules.set(TTA_ID, { id: TTA_ID, active: true, api });
  return api;
}

test("one move is reported once even though TTA fires updateSetting and timeChanged for it", () => {
  const stub = installFoundryStub();
  try {
    withTTA(stub);
    const src = new TTASource();
    const reports = [];
    src.start(r => reports.push(r));
    CAL.currentDate = { year: 1, month: 1, day: 2 };
    stub.hooks.callAll("updateSetting", { key: TTA_SETTING_KEY });
    stub.hooks.callAll(`${TTA_ID}.timeChanged`, { date: CAL.currentDate, time: CAL.currentTime, reason: "advance" });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].adventureDayOnly, undefined);
    assert.deepEqual(reports[0].moment, { year: 1, month: 1, day: 2, hour: 0, minute: 0 });
    src.stop();
  } finally { CAL.currentDate = { year: 1, month: 1, day: 1 }; stub.uninstall(); }
});

test("a late next-adventure-day reason becomes a rest-only notice, once", () => {
  const stub = installFoundryStub();
  try {
    withTTA(stub);
    const src = new TTASource();
    const reports = [];
    src.start(r => reports.push(r));
    CAL.currentDate = { year: 1, month: 1, day: 2 }; CAL.currentTime = { hour: 7, minute: 0 };
    stub.hooks.callAll("updateSetting", { key: TTA_SETTING_KEY });
    stub.hooks.callAll(`${TTA_ID}.timeChanged`, { date: CAL.currentDate, time: CAL.currentTime, reason: "nextAdventureDay" });
    stub.hooks.callAll(`${TTA_ID}.timeChanged`, { date: CAL.currentDate, time: CAL.currentTime, reason: "nextAdventureDay" });
    assert.equal(reports.length, 2);
    assert.equal(reports[0].adventureDayOnly, undefined, "the time step");
    assert.equal(reports[1].adventureDayOnly, true, "the rest, exactly once");
    src.stop();
  } finally { CAL.currentDate = { year: 1, month: 1, day: 1 }; CAL.currentTime = { hour: 0, minute: 0 }; stub.uninstall(); }
});

test("elapsedBetween uses TTA arithmetic for both ends, or the local sum for both", () => {
  const stub = installFoundryStub();
  try {
    const api = withTTA(stub);
    const src = new TTASource();
    const a = { year: 1, month: 1, day: 1, hour: 0, minute: 0 }, b = { year: 1, month: 2, day: 1, hour: 6, minute: 0 };
    assert.equal(src.elapsedBetween(a, b), 30 * 86400 + 6 * 3600);
    // TTA fails for one end: never mix, fall back to local for both.
    api.utils.campaignSeconds = d => { if (d.month === 2) throw new Error("boom"); return 0; };
    assert.equal(src.elapsedBetween(a, b), 30 * 86400 + 6 * 3600);
    delete api.utils.campaignSeconds;
    assert.equal(src.elapsedBetween(a, b), 30 * 86400 + 6 * 3600);
    assert.equal(src.calendar().monthBase, 1);
  } finally { stub.uninstall(); }
});
