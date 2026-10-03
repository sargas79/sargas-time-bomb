/**
 * Break timer banner: a small countdown pinned to the top of the screen on
 * every client while a break runs, whether or not the board is open. Each
 * client counts down locally against the shared deadline.
 */
import { BREAK_MINUTES_MAX, BREAK_MINUTES_MIN } from "../constants.js";
import { getDialogV2, isGM, notify, t, warn } from "../compat.js";
import { cancelBreak, clampMinutes, formatRemaining, getBreak, realNow, remainingMs, startBreak } from "../services/break-timer-service.js";

const TICK_MS = 500;
const END_SOUND = "sounds/notify.wav";

let banner = null;
let ticker = null;
let armedFor = null; // deadline this client is counting down to

function ensureBanner() {
  if (banner?.isConnected) return banner;
  banner = document.createElement("div");
  banner.className = "stb stb-break";
  banner.setAttribute("role", "timer");
  const label = document.createElement("span");
  label.className = "stb-break__label";
  label.innerHTML = `<i class="fa-solid fa-mug-hot"></i> ${t("Break.label")}`;
  const time = document.createElement("span");
  time.className = "stb-break__time";
  banner.append(label, time);
  if (isGM()) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "stb-break__cancel";
    cancel.title = t("Break.cancel");
    cancel.setAttribute("aria-label", t("Break.cancel"));
    cancel.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
    cancel.addEventListener("click", () => cancelBreak().catch(e => warn("break cancel failed", e)));
    banner.append(cancel);
  }
  document.body.append(banner);
  return banner;
}

function stop() {
  clearInterval(ticker);
  ticker = null;
  armedFor = null;
  banner?.remove();
  banner = null;
}

function finish() {
  stop();
  notify("info", t("Break.over"), { permanent: true });
  try {
    const helper = globalThis.foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
    helper?.play?.({ src: END_SOUND, volume: 0.8, autoplay: true, loop: false }, false);
  } catch { /* the notification is enough */ }
}

function tick() {
  const timer = getBreak();
  if (timer.endsAt !== armedFor) { refreshBreakTimer(); return; }
  const left = remainingMs(timer, realNow());
  if (left <= 0) { finish(); return; }
  ensureBanner().querySelector(".stb-break__time").textContent = formatRemaining(left);
}

/**
 * Bring the banner in line with the stored break. Called at ready and whenever
 * the setting changes. A break that ended while this client was away stays silent.
 */
export function refreshBreakTimer() {
  const timer = getBreak();
  if (remainingMs(timer, realNow()) <= 0) { stop(); return; }
  armedFor = timer.endsAt;
  if (!ticker) ticker = setInterval(tick, TICK_MS);
  tick();
}

/** GM dialog: pick a length in minutes and start the break. */
export async function promptBreak() {
  if (!isGM()) return null;
  const Dialog = getDialogV2();
  if (!Dialog) return null;
  const current = getBreak();
  const running = remainingMs(current, realNow()) > 0;
  const value = await Dialog.prompt({
    window: { title: t("Break.title") },
    content: `<div class="stb form-group"><label>${t("Break.minutesLabel", { min: BREAK_MINUTES_MIN, max: BREAK_MINUTES_MAX })}</label><input type="number" name="minutes" min="${BREAK_MINUTES_MIN}" max="${BREAK_MINUTES_MAX}" step="1" value="${current.minutes}" autofocus></div>
      <p class="stb hint">${t(running ? "Break.hintRunning" : "Break.hint")}</p>`,
    ok: { label: t("Break.start"), callback: (ev, button) => button.form.elements.minutes.value },
    rejectClose: false,
    modal: true
  });
  if (value === null || value === undefined) return null;
  const minutes = clampMinutes(value);
  if (minutes === null) { notify("warn", t("Break.invalid", { min: BREAK_MINUTES_MIN, max: BREAK_MINUTES_MAX })); return null; }
  const timer = await startBreak(minutes);
  notify("info", t("Break.started", { n: minutes }));
  return timer;
}
