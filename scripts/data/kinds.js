/**
 * Per-kind defaults and presets. Pure data; no Foundry globals.
 * A kind only changes defaults and presentation. Every clock shares one schema.
 */
import { VISIBILITY } from "../constants.js";

export const KIND_DEFAULTS = Object.freeze({
  progress: {
    icon: "fa-solid fa-clock",
    color: "#3d6b8f",
    segments: 6,
    segmentPresets: [4, 6, 8, 12],
    direction: "fill",
    onComplete: "stop",
    visibility: VISIBILITY.GM_ONLY,
    thresholds: [],
    triggers: []
  },
  countdown: {
    icon: "fa-solid fa-hourglass-half",
    color: "#8f3d2e",
    segments: 6,
    segmentPresets: [4, 6, 8, 12],
    direction: "drain",
    onComplete: "stop",
    visibility: VISIBILITY.GM_ONLY,
    thresholds: [],
    triggers: []
  },
  threat: {
    icon: "fa-solid fa-skull",
    color: "#6b2e8f",
    segments: 8,
    segmentPresets: [6, 8, 12],
    direction: "fill",
    onComplete: "stop",
    visibility: VISIBILITY.GM_ONLY,
    thresholds: [
      { at: 2, label: "Rumours", note: "" },
      { at: 4, label: "Signs", note: "" },
      { at: 6, label: "Confrontation", note: "" },
      { at: 8, label: "Catastrophe", note: "" }
    ],
    triggers: []
  },
  faction: {
    icon: "fa-solid fa-flag",
    color: "#8f6b2e",
    segments: 8,
    segmentPresets: [4, 6, 8, 12],
    direction: "fill",
    onComplete: "stop",
    visibility: VISIBILITY.GM_ONLY,
    thresholds: [],
    triggers: []
  },
  corruption: {
    icon: "fa-solid fa-biohazard",
    color: "#2e8f5a",
    segments: 6,
    segmentPresets: [4, 6, 8, 10],
    direction: "fill",
    onComplete: "stayFull",
    visibility: VISIBILITY.ACTOR_OWNERS,
    thresholds: [],
    triggers: []
  },
  alarm: {
    icon: "fa-solid fa-bell",
    color: "#b3892a",
    segments: 0,
    segmentPresets: [0],
    direction: "fill",
    onComplete: "stop",
    visibility: VISIBILITY.GM_ONLY,
    thresholds: [],
    triggers: []
  },
  project: {
    icon: "fa-solid fa-hammer",
    color: "#4f7a2e",
    segments: 8,
    segmentPresets: [4, 6, 8, 12, 16],
    direction: "fill",
    onComplete: "stop",
    visibility: VISIBILITY.PLAYERS,
    thresholds: [],
    triggers: [{ type: "rest", advance: 1, kinds: [] }]
  },
  weather: {
    icon: "fa-solid fa-cloud-sun-rain",
    color: "#2e7a8f",
    segments: 6,
    segmentPresets: [4, 6, 8],
    direction: "fill",
    onComplete: "repeat",
    visibility: VISIBILITY.PLAYERS,
    segmentLabels: ["Clear", "Overcast", "Rain", "Storm", "Clearing", "Clear"],
    thresholds: [],
    triggers: [{ type: "time", advance: 1, every: { hours: 6 } }]
  }
});

export function kindDefaults(kind) {
  return KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.progress;
}

/** Deep-ish copy so callers cannot mutate the frozen presets. */
export function kindPreset(kind) {
  const d = kindDefaults(kind);
  return {
    icon: d.icon,
    color: d.color,
    segments: d.segments,
    direction: d.direction,
    onComplete: d.onComplete,
    visibility: d.visibility,
    segmentLabels: Array.isArray(d.segmentLabels) ? [...d.segmentLabels] : [],
    thresholds: d.thresholds.map(t => ({ ...t })),
    triggers: d.triggers.map(t => ({ ...t, every: t.every ? { ...t.every } : undefined, kinds: t.kinds ? [...t.kinds] : undefined }))
  };
}
