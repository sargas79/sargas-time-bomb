/**
 * Human-readable descriptions of clocks and triggers for the board, editor
 * and cards. Localised through t(); Foundry globals only at call time.
 */
import { t } from "../compat.js";
import { currentLabel, isComplete, reachedThreshold, remaining } from "../services/clock-service.js";
import { describeSpan, elapsedSeconds, everyToSeconds, isValidMoment } from "../services/schedule-service.js";
import { formatMoment, timeInfo } from "../services/time-source-service.js";

export function everyText(every) {
  const parts = [];
  for (const unit of ["weeks", "days", "hours"]) {
    const n = Number(every?.[unit]) || 0;
    if (n > 0) parts.push(t(`Every.${unit}`, { n }));
  }
  return parts.join(" ") || t("Every.none");
}

export function advanceText(advance) {
  if (advance === "complete") return t("Advance.complete");
  if (advance === "reset") return t("Advance.reset");
  const n = Number(advance) || 0;
  return n >= 0 ? `+${n}` : `${n}`;
}

export function spanText(seconds, calendar) {
  const s = describeSpan(seconds, calendar);
  const parts = [];
  if (s.days) parts.push(t("Span.days", { n: s.days }));
  if (s.hours) parts.push(t("Span.hours", { n: s.hours }));
  if (!s.days && s.minutes) parts.push(t("Span.minutes", { n: s.minutes }));
  if (!parts.length) parts.push(t("Span.now"));
  return parts.join(" ");
}

export function relativeText(target, info = timeInfo()) {
  if (!info?.moment || !target) return "";
  const secs = elapsedSeconds(info.moment, target, info.calendar);
  if (secs === 0) return t("Relative.now");
  return secs > 0 ? t("Relative.in", { span: spanText(secs, info.calendar) }) : t("Relative.ago", { span: spanText(-secs, info.calendar) });
}

export function sceneName(id) {
  return globalThis.game?.scenes?.get(id)?.name ?? id;
}

export function clockName(id, clocks = []) {
  return clocks.find(c => c.id === id)?.name ?? t("Trigger.unknownClock");
}

/** One sentence per trigger. */
export function triggerText(trigger, { clocks = [], info = timeInfo() } = {}) {
  const adv = advanceText(trigger.advance);
  switch (trigger.type) {
    case "scene":
      return trigger.scenes?.length
        ? t("Trigger.sceneListed", { adv, scenes: trigger.scenes.map(sceneName).join(", ") })
        : t("Trigger.sceneAny", { adv });
    case "rest":
      return t(trigger.onAdventureDay ? "Trigger.restAdventureDay" : "Trigger.rest", { adv });
    case "time": {
      const base = t(trigger.once ? "Trigger.timeOnce" : "Trigger.timeEvery", { adv, every: everyText(trigger.every) });
      return info?.hasCalendar ? base : `${base} ${t("Trigger.worldTime")}`;
    }
    case "date": {
      if (!trigger.at) return t("Trigger.dateMissing");
      const when = info?.hasCalendar ? formatMoment(trigger.at) : formatMoment(trigger.at);
      const rel = relativeText(trigger.at, info);
      const invalid = info?.calendar && !isValidMoment(trigger.at, info.calendar);
      const base = trigger.repeatEvery
        ? t("Trigger.dateRepeat", { adv, when, rel, every: everyText(trigger.repeatEvery) })
        : t("Trigger.dateOnce", { adv, when, rel });
      return invalid ? `${base} ${t("Trigger.dateInvalid")}` : base;
    }
    case "hook":
      return t("Trigger.hook", { adv, hook: trigger.hook || "?" });
    case "linked":
      return trigger.when === "threshold"
        ? t("Trigger.linkedThreshold", { adv, name: clockName(trigger.clockId, clocks), at: trigger.at ?? t("Trigger.anyThreshold") })
        : t("Trigger.linkedCompleted", { adv, name: clockName(trigger.clockId, clocks) });
    default:
      return t("Trigger.unknown");
  }
}

/** Short "next expected" sentence for the board card. */
export function nextText(clock, { clocks = [], info = timeInfo() } = {}) {
  if (isComplete(clock) && clock.onComplete !== "repeat") return "";
  if (!clock.triggers?.length) return t("Next.manual");
  if (info?.sourceId === "off" && clock.triggers.some(tr => tr.type === "time" || tr.type === "date") && !clock.triggers.some(tr => tr.type !== "time" && tr.type !== "date")) {
    return t("Next.paused");
  }
  const date = clock.triggers.find(tr => tr.type === "date" && tr.at);
  if (date && info?.moment) {
    const rel = relativeText(date.at, info);
    return t("Next.due", { when: formatMoment(date.at), rel });
  }
  if (date && !info?.hasCalendar) return t("Next.dateNoCalendar");
  const first = clock.triggers[0];
  return triggerText(first, { clocks, info });
}

/** Headline state for a card. */
export function stateText(clock) {
  const label = currentLabel(clock);
  if (label) return label;
  if (clock.kind === "alarm") {
    if (isComplete(clock)) return t("State.alarmFired");
    return t("State.alarmArmed");
  }
  if (isComplete(clock)) return t(clock.onComplete === "stayFull" ? "State.full" : "State.complete");
  const th = reachedThreshold(clock);
  if (th?.label) return th.label;
  if (clock.kind === "project") {
    const restTrigger = clock.triggers?.find(tr => tr.type === "rest");
    const n = remaining(clock);
    if (restTrigger) {
      const per = Number(restTrigger.advance) > 0 ? Number(restTrigger.advance) : 1;
      return t("State.restsRemaining", { n: Math.ceil(n / per) });
    }
    const timeTrigger = clock.triggers?.find(tr => tr.type === "time" && tr.every && !tr.once && Number.isInteger(tr.advance) && tr.advance > 0);
    if (timeTrigger) {
      const per = timeTrigger.advance;
      const periods = Math.ceil(n / per);
      const days = Number(timeTrigger.every.days) || 0;
      if (days && !timeTrigger.every.hours && !timeTrigger.every.weeks) return t("State.daysRemaining", { n: periods * days });
      return t("State.periodsRemaining", { n: periods, every: everyText(timeTrigger.every) });
    }
    return t("State.remaining", { n });
  }
  if (clock.kind === "countdown") return t("State.remaining", { n: remaining(clock) });
  return t("State.progress", { filled: clock.filled, segments: clock.segments });
}

export function visibilityText(clock) {
  return t(`Visibility.${clock.visibility}`);
}

export function everySeconds(every, calendar) {
  return everyToSeconds(every, calendar);
}
