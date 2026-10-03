/**
 * Small helpers that smooth over Foundry API differences. Every Foundry global
 * is read inside a function so this file can be imported by node tests.
 */
import { I18N_PREFIX, MODULE_ID, SETTINGS } from "./constants.js";

/** Localise `STB.<key>` with optional format data. Falls back to the key. */
export function t(key, data) {
  const full = key.startsWith(`${I18N_PREFIX}.`) ? key : `${I18N_PREFIX}.${key}`;
  const i18n = globalThis.game?.i18n;
  if (!i18n) return full;
  if (typeof i18n.has === "function" && !i18n.has(full)) return full;
  return data ? i18n.format(full, data) : i18n.localize(full);
}

export function hasI18n(key) {
  const full = key.startsWith(`${I18N_PREFIX}.`) ? key : `${I18N_PREFIX}.${key}`;
  return !!globalThis.game?.i18n?.has?.(full);
}

function debugEnabled() {
  try { return !!globalThis.game?.settings?.get(MODULE_ID, SETTINGS.debugLogging); }
  catch { return false; }
}

export function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

export function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

export function error(...args) {
  console.error(`${MODULE_ID} |`, ...args);
}

export function debug(...args) {
  if (debugEnabled()) console.debug(`${MODULE_ID} |`, ...args);
}

/** Escape a string for safe insertion into HTML. */
export function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template that escapes interpolations unless wrapped by `raw()`. */
export function html(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      out += v && v.__raw ? v.value : escapeHTML(v);
    }
  });
  return out;
}

export function raw(value) {
  return { __raw: true, value: String(value ?? "") };
}

/**
 * Sanitise untrusted HTML. Uses Foundry's enricher cleaning when available;
 * otherwise strips script-like content.
 */
export function sanitizeHTML(dirty) {
  const str = String(dirty ?? "");
  if (!str) return "";
  if (typeof globalThis.DOMParser === "function") {
    try {
      const doc = new DOMParser().parseFromString(`<body>${str}</body>`, "text/html");
      const banned = ["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button"];
      for (const tag of banned) for (const el of [...doc.querySelectorAll(tag)]) el.remove();
      for (const el of doc.body.querySelectorAll("*")) {
        for (const attr of [...el.attributes]) {
          const n = attr.name.toLowerCase();
          const v = attr.value.trim().toLowerCase();
          if (n.startsWith("on") || ((n === "href" || n === "src" || n === "xlink:href") && v.startsWith("javascript:"))) el.removeAttribute(attr.name);
        }
      }
      return doc.body.innerHTML;
    } catch {
      /* fall through */
    }
  }
  return str.replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/** Enrich sanitised HTML with Foundry's TextEditor when present. */
export async function enrich(content) {
  const clean = sanitizeHTML(content);
  const TE = globalThis.foundry?.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  if (!TE?.enrichHTML) return clean;
  try { return await TE.enrichHTML(clean, { async: true, secrets: !!globalThis.game?.user?.isGM }); }
  catch { return clean; }
}

export function renderTemplate(path, data) {
  const fn = globalThis.foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  if (!fn) return Promise.resolve("");
  return fn(path, data);
}

export function loadTemplates(paths) {
  const fn = globalThis.foundry?.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  if (!fn) return Promise.resolve([]);
  return fn(paths);
}

export function randomID(length = 16) {
  const fn = globalThis.foundry?.utils?.randomID;
  if (fn) return fn(length);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function getSetting(key) {
  return globalThis.game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return globalThis.game.settings.set(MODULE_ID, key, value);
}

export function getFormDataExtended() {
  return globalThis.foundry?.applications?.ux?.FormDataExtended ?? globalThis.FormDataExtended;
}

export function getDialogV2() {
  return globalThis.foundry?.applications?.api?.DialogV2;
}

export function notify(kind, message, options = {}) {
  const ui = globalThis.ui;
  if (!ui?.notifications) { (kind === "error" ? console.error : console.log)(`${MODULE_ID} | ${message}`); return; }
  const fn = ui.notifications[kind] ?? ui.notifications.info;
  fn.call(ui.notifications, message, options);
}

/** Re-render every open application that belongs to this module. */
export function rerenderModuleApps() {
  const instances = globalThis.foundry?.applications?.instances;
  if (instances) {
    for (const app of instances.values()) {
      if (app?.options?.classes?.includes("stb")) {
        try { app.render({ force: false }); } catch { /* ignore */ }
      }
    }
  }
  const legacy = globalThis.ui?.windows;
  if (legacy) {
    for (const app of Object.values(legacy)) {
      if (app?.options?.classes?.includes("stb")) {
        try { app.render(false); } catch { /* ignore */ }
      }
    }
  }
}

export function moduleVersion() {
  return globalThis.game?.modules?.get(MODULE_ID)?.version ?? "0.0.0";
}

export function isGM() {
  return !!globalThis.game?.user?.isGM;
}

export function currentUserId() {
  return globalThis.game?.user?.id ?? null;
}
