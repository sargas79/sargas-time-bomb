/**
 * Pure validation: bounds, trigger shapes, threshold order, link chains.
 * Returns { valid, errors: [{ code, path, data }] }. Errors are keys for i18n.
 */
import {
  ADVANCE_KEYWORDS, DIRECTIONS, EVERY_UNITS, KINDS, LIMITS, LINK_WHEN, ON_COMPLETE, TRIGGER_TYPES, VISIBILITIES, VISIBILITY
} from "../constants.js";
import { isMoment } from "./clock-service.js";
import { isValidMoment } from "./schedule-service.js";
import { checkLinkChain } from "./trigger-service.js";
import { MODULE_ID } from "../constants.js";

function err(code, path, data = {}) {
  return { code, path, data };
}

export function validateTrigger(trigger, index, { calendar } = {}) {
  const errors = [];
  const p = `triggers.${index}`;
  if (!trigger || typeof trigger !== "object") return [err("triggerInvalid", p)];
  if (!TRIGGER_TYPES.includes(trigger.type)) errors.push(err("triggerType", `${p}.type`, { type: trigger.type }));
  const adv = trigger.advance;
  if (!(ADVANCE_KEYWORDS.includes(adv) || (Number.isInteger(adv) && Math.abs(adv) <= LIMITS.ADVANCE_MAX && adv !== 0))) {
    errors.push(err("triggerAdvance", `${p}.advance`, { max: LIMITS.ADVANCE_MAX }));
  }
  switch (trigger.type) {
    case "time": {
      const every = trigger.every ?? {};
      const keys = Object.keys(every).filter(k => EVERY_UNITS.includes(k) && Number(every[k]) > 0);
      if (!keys.length) errors.push(err("triggerEvery", `${p}.every`));
      break;
    }
    case "date":
      if (!isMoment(trigger.at)) errors.push(err("triggerDateMissing", `${p}.at`));
      else if (calendar && !isValidMoment(trigger.at, calendar)) errors.push(err("triggerDateInvalid", `${p}.at`));
      break;
    case "hook":
      if (!trigger.hook || typeof trigger.hook !== "string" || !/^[\w.:-]+$/.test(trigger.hook)) errors.push(err("triggerHook", `${p}.hook`));
      else if (trigger.hook.startsWith(`${MODULE_ID}.`)) errors.push(err("triggerHookSelf", `${p}.hook`));
      break;
    case "linked":
      if (!trigger.clockId) errors.push(err("triggerLinkedTarget", `${p}.clockId`));
      if (!LINK_WHEN.includes(trigger.when)) errors.push(err("triggerLinkedWhen", `${p}.when`));
      break;
    default:
      break;
  }
  return errors;
}

/**
 * Validate a normalised clock.
 * options: { allClocks: [], calendar, isNew }
 */
export function validateClock(clock, { allClocks = [], calendar = null, isNew = false } = {}) {
  const errors = [];
  if (!clock || typeof clock !== "object") return { valid: false, errors: [err("clockInvalid", "")] };

  if (!KINDS.includes(clock.kind)) errors.push(err("kind", "kind"));
  if (typeof clock.name !== "string" || !clock.name.trim()) errors.push(err("nameRequired", "name"));
  else if (clock.name.length > LIMITS.NAME_MAX) errors.push(err("nameLength", "name", { max: LIMITS.NAME_MAX }));
  if (typeof clock.description === "string" && clock.description.length > LIMITS.DESCRIPTION_MAX) {
    errors.push(err("descriptionLength", "description", { max: LIMITS.DESCRIPTION_MAX }));
  }

  if (!Number.isInteger(clock.segments) || clock.segments < LIMITS.SEGMENTS_MIN || clock.segments > LIMITS.SEGMENTS_MAX) {
    errors.push(err("segmentsRange", "segments", { min: LIMITS.SEGMENTS_MIN, max: LIMITS.SEGMENTS_MAX }));
  } else if (clock.kind === "alarm" && clock.segments !== 1) {
    errors.push(err("alarmSegments", "segments"));
  }
  if (clock.onComplete === "repeat" && Number.isInteger(clock.segments) && clock.filled === (clock.direction === "drain" ? 0 : clock.segments)) {
    errors.push(err("repeatAtFull", "filled"));
  }
  if (Array.isArray(clock.segmentLabels) && clock.segmentLabels.length && clock.segmentLabels.length !== clock.segments) {
    errors.push(err("segmentLabelsCount", "segmentLabels", { segments: clock.segments }));
  }
  if (!Number.isInteger(clock.filled) || clock.filled < 0 || clock.filled > clock.segments) errors.push(err("filledRange", "filled"));
  if (!DIRECTIONS.includes(clock.direction)) errors.push(err("direction", "direction"));
  if (!ON_COMPLETE.includes(clock.onComplete)) errors.push(err("onComplete", "onComplete"));
  if (!VISIBILITIES.includes(clock.visibility)) errors.push(err("visibility", "visibility"));
  if (clock.visibility === VISIBILITY.ACTOR_OWNERS && !clock.actorUuid) errors.push(err("actorRequired", "actorUuid"));

  const thresholds = Array.isArray(clock.thresholds) ? clock.thresholds : [];
  if (thresholds.length > LIMITS.THRESHOLDS_MAX) errors.push(err("thresholdsMax", "thresholds", { max: LIMITS.THRESHOLDS_MAX }));
  const seen = new Set();
  let last = -Infinity;
  thresholds.forEach((t, i) => {
    if (!Number.isInteger(t.at) || t.at < 0 || t.at > clock.segments) errors.push(err("thresholdRange", `thresholds.${i}.at`));
    if (seen.has(t.at)) errors.push(err("thresholdDuplicate", `thresholds.${i}.at`, { at: t.at }));
    seen.add(t.at);
    if (t.at < last) errors.push(err("thresholdOrder", `thresholds.${i}.at`));
    last = t.at;
    if (t.effectUuid !== null && t.effectUuid !== undefined && !(typeof t.effectUuid === "string" && /^[\w.-]+$/.test(t.effectUuid))) {
      errors.push(err("thresholdEffect", `thresholds.${i}.effectUuid`));
    }
  });

  const triggers = Array.isArray(clock.triggers) ? clock.triggers : [];
  if (triggers.length > LIMITS.TRIGGERS_MAX) errors.push(err("triggersMax", "triggers", { max: LIMITS.TRIGGERS_MAX }));
  triggers.forEach((t, i) => errors.push(...validateTrigger(t, i, { calendar })));

  // Linked chain depth and cycles, evaluated against the proposed clock set.
  if (triggers.some(t => t.type === "linked")) {
    const others = allClocks.filter(c => c.id !== clock.id);
    const set = [...others, clock];
    for (const t of triggers.filter(t => t.type === "linked")) {
      if (t.clockId === clock.id) errors.push(err("linkedSelf", "triggers"));
      else if (t.clockId && !set.some(c => c.id === t.clockId)) errors.push(err("linkedMissing", "triggers", { clockId: t.clockId }));
    }
    const chain = checkLinkChain(clock.id, set);
    if (chain.cycle) errors.push(err("linkedCycle", "triggers"));
    else if (!chain.ok) errors.push(err("linkedDepth", "triggers", { max: LIMITS.LINK_DEPTH_MAX }));
  }

  if (isNew && allClocks.length >= LIMITS.CLOCKS_MAX) errors.push(err("clocksMax", "", { max: LIMITS.CLOCKS_MAX }));

  return { valid: errors.length === 0, errors };
}
