/**
 * SVG pie rendering shared by the board, the editor preview and chat cards.
 * Pure string building; no Foundry globals.
 */
import { escapeHTML } from "../compat.js";
import { currentLabel, isComplete } from "../services/clock-service.js";

function polar(cx, cy, r, angle) {
  const a = (angle - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function wedge(cx, cy, r, start, end) {
  const s = polar(cx, cy, r, end);
  const e = polar(cx, cy, r, start);
  const large = end - start <= 180 ? 0 : 1;
  return `M ${cx} ${cy} L ${s.x.toFixed(3)} ${s.y.toFixed(3)} A ${r} ${r} 0 ${large} 0 ${e.x.toFixed(3)} ${e.y.toFixed(3)} Z`;
}

/**
 * Render a clock as an inline SVG string.
 * options: { size = 64, showLabel = false }
 */
export function renderPie(clock, { size = 64, title = null } = {}) {
  const color = /^#[0-9a-f]{6}$/i.test(clock.color ?? "") ? clock.color : "#3d6b8f";
  const n = Math.max(0, clock.segments | 0);
  const label = escapeHTML(title ?? clock.name ?? "");
  const complete = isComplete(clock);
  const cx = 50, cy = 50, r = 46;
  const parts = [];
  parts.push(`<svg class="stb-pie${complete ? " stb-pie--complete" : ""}" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${label}" data-segments="${n}" data-filled="${clock.filled | 0}">`);
  parts.push(`<title>${label}</title>`);
  if (clock.kind === "alarm") {
    // Alarm: a badge rather than a pie. Lit when the single segment is filled.
    const fired = clock.filled >= 1;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" class="stb-pie__ring${fired ? " is-filled" : ""}" fill="${fired ? color : "none"}" stroke="${color}" stroke-width="6" opacity="${fired ? 1 : 0.6}"/>`);
    parts.push(`<path d="M50 24 a14 14 0 0 1 14 14 v12 l6 8 h-40 l6 -8 v-12 a14 14 0 0 1 14 -14 z M44 62 a6 6 0 0 0 12 0 z" fill="${fired ? "#fff" : color}" opacity="${fired ? 1 : 0.5}"/>`);
  } else if (n === 1) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" class="stb-pie__segment${clock.filled >= 1 ? " is-filled" : ""}" fill="${clock.filled >= 1 ? color : "transparent"}" stroke="currentColor" stroke-width="1.5"/>`);
  } else {
    const step = 360 / n;
    for (let i = 0; i < n; i++) {
      const filled = clock.direction === "drain" ? i < clock.filled : i < clock.filled;
      const threshold = (clock.thresholds ?? []).find(t => t.at === i + 1);
      parts.push(`<path d="${wedge(cx, cy, r, i * step, (i + 1) * step)}" class="stb-pie__segment${filled ? " is-filled" : ""}${threshold ? " has-threshold" : ""}" fill="${filled ? color : "transparent"}" stroke="currentColor" stroke-width="1.5"${threshold ? ` data-threshold="${escapeHTML(threshold.label)}"` : ""}/>`);
    }
    for (const t of clock.thresholds ?? []) {
      if (t.at <= 0 || t.at > n) continue;
      const p = polar(cx, cy, r + 1, t.at * step);
      const q = polar(cx, cy, r - 10, t.at * step);
      parts.push(`<line x1="${p.x.toFixed(2)}" y1="${p.y.toFixed(2)}" x2="${q.x.toFixed(2)}" y2="${q.y.toFixed(2)}" class="stb-pie__threshold" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`);
    }
  }
  const stateLabel = currentLabel(clock);
  if (stateLabel && size >= 48) {
    // Longer labels fit at a smaller size; anything longer still is cut with an ellipsis (the <title> carries the full text).
    const max = size >= 88 ? 10 : 8;
    const text = stateLabel.length > max ? `${stateLabel.slice(0, max - 1)}…` : stateLabel;
    const fontSize = text.length > 8 ? 9 : 11;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="22" class="stb-pie__hub" fill="var(--stb-pie-hub, rgba(0,0,0,.55))"/>`);
    parts.push(`<text x="${cx}" y="${cy}" class="stb-pie__text" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}">${escapeHTML(text)}</text>`);
  } else if (n > 1 && size >= 48) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="18" class="stb-pie__hub" fill="var(--stb-pie-hub, rgba(0,0,0,.55))"/>`);
    parts.push(`<text x="${cx}" y="${cy}" class="stb-pie__text" text-anchor="middle" dominant-baseline="central" font-size="16">${clock.filled | 0}/${n}</text>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
