/**
 * Chat cards for clock changes.
 */
import { MODULE_ID, SETTINGS, VISIBILITY } from "../constants.js";
import { enrich, getSetting, renderTemplate, t, warn } from "../compat.js";
import { currentLabel, isComplete, reachedThreshold, remaining } from "./clock-service.js";
import { recipientsFor } from "./permission-service.js";
import { renderPie } from "../ui/pie.js";
import { formatMoment } from "./time-source-service.js";

export const CARD_TEMPLATE = `modules/${MODULE_ID}/templates/chat/clock-card.hbs`;

function mode() {
  try { return getSetting(SETTINGS.chatCards) ?? "visible-only"; } catch { return "visible-only"; }
}

export function sourceLabel(source) {
  const key = `Source.${source}`;
  return t(key);
}

/** Describe a list of events for one clock as localised lines. */
export function describeEvents(clock, events) {
  const lines = [];
  for (const ev of events) {
    switch (ev.type) {
      case "advanced":
        if (clock.kind === "alarm") lines.push(t(ev.delta > 0 ? "Card.alarmFired" : "Card.alarmArmed"));
        else lines.push(t(ev.delta > 0 ? "Card.advanced" : "Card.retreated", { delta: Math.abs(ev.delta), filled: ev.filled, segments: clock.segments }));
        break;
      case "thresholdReached":
        lines.push(t("Card.thresholdReached", { label: ev.threshold.label || t("Card.unnamedThreshold"), at: ev.threshold.at }));
        break;
      case "thresholdCleared": lines.push(t("Card.thresholdCleared", { label: ev.threshold.label || t("Card.unnamedThreshold"), at: ev.threshold.at })); break;
      case "completed": lines.push(t(ev.repeat ? "Card.completedRepeat" : "Card.completed")); break;
      case "reset": lines.push(t(ev.automatic ? "Card.resetAuto" : "Card.reset")); break;
      case "weatherChanged": lines.push(t("Card.weatherChanged", { from: ev.previousLabel ?? "—", to: ev.label ?? "—" })); break;
      case "annotated": lines.push(t("Card.annotated", { note: ev.note })); break;
      default: break;
    }
  }
  return lines;
}

/**
 * Post one card per changed clock.
 * groups: [{ clock, events, source }], ctx: { moment, userId }
 */
export async function postCards(groups, ctx = {}) {
  const m = mode();
  if (m === "off") return;
  const ChatMessage = globalThis.ChatMessage ?? globalThis.foundry?.documents?.ChatMessage;
  if (!ChatMessage?.create) return;
  const allowed = groups.filter(g => g.events.length && !(m === "visible-only" && g.clock.visibility === VISIBILITY.GM_ONLY));
  if (!allowed.length) return;
  if (ctx.source === "catchup" && allowed.length > 1) return postSummary(allowed, ctx, ChatMessage);
  for (const { clock, events, source } of allowed) {
    const whisper = recipientsFor(clock);
    const reached = events.filter(e => e.type === "thresholdReached").map(e => e.threshold);
    const effects = [];
    for (const th of reached) {
      if (th.effectUuid) effects.push({ label: th.label, link: await enrich(`@UUID[${th.effectUuid}]`), note: th.note });
      else if (th.note) effects.push({ label: th.label, link: null, note: th.note });
    }
    const data = {
      clock,
      pie: renderPie(clock, { size: 72 }),
      name: clock.name,
      kindLabel: t(`Kind.${clock.kind}`),
      lines: describeEvents(clock, events),
      source: sourceLabel(source),
      moment: ctx.moment ? formatMoment(ctx.moment) : null,
      complete: isComplete(clock),
      remaining: remaining(clock),
      stateLabel: currentLabel(clock),
      threshold: reachedThreshold(clock),
      effects,
      isGMOnly: clock.visibility === VISIBILITY.GM_ONLY
    };
    let content;
    try { content = await renderTemplate(CARD_TEMPLATE, data); }
    catch (e) { warn("card template failed", e); content = `<div class="stb stb-card"><strong>${clock.name}</strong><br>${data.lines.join("<br>")}</div>`; }
    const msg = {
      content,
      speaker: { alias: t("Card.speaker") },
      flags: { [MODULE_ID]: { clockId: clock.id, source } }
    };
    if (whisper) msg.whisper = whisper;
    try { await ChatMessage.create(msg); }
    catch (e) { warn("chat card failed", e); }
  }
}

/** Summary cards for a catch-up: one public card, one GM whisper for GM-only clocks. */
async function postSummary(groups, ctx, ChatMessage) {
  const gmIds = (globalThis.game?.users?.contents ?? []).filter(u => u.isGM).map(u => u.id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
  const render = list => {
    const items = list.map(({ clock, events }) => `<li><strong>${esc(clock.name)}</strong> — ${describeEvents(clock, events).map(esc).join("; ")}</li>`);
    return `<div class="stb stb-chat-card stb-chat-card--summary"><div class="stb-chat-card__body">
      <header><i class="fa-solid fa-forward"></i> <strong>${esc(t("Card.catchupTitle"))}</strong></header>
      <ul class="stb-chat-card__lines">${items.join("")}</ul>
      ${ctx.moment ? `<footer><span><i class="fa-regular fa-calendar"></i> ${esc(formatMoment(ctx.moment))}</span></footer>` : ""}
    </div></div>`;
  };
  const batches = [
    { list: groups.filter(g => g.clock.visibility !== VISIBILITY.GM_ONLY), whisper: null },
    { list: groups.filter(g => g.clock.visibility === VISIBILITY.GM_ONLY), whisper: gmIds }
  ];
  for (const { list, whisper } of batches) {
    if (!list.length) continue;
    const msg = { content: render(list), speaker: { alias: t("Card.speaker") }, flags: { [MODULE_ID]: { summary: true, source: "catchup" } } };
    if (whisper) msg.whisper = whisper;
    try { await ChatMessage.create(msg); }
    catch (e) { warn("summary card failed", e); }
  }
}
