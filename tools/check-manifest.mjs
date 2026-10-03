#!/usr/bin/env node
/**
 * Sanity checks run in CI and before release:
 *  - module.json is valid and has the fields Foundry needs
 *  - every file the manifest references exists
 *  - lang/en.json is valid JSON
 *  - every literal `STB.…` / t("…") key used in scripts and templates exists in en.json
 *  - pure services import no Foundry globals at module evaluation time
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const note = (msg) => problems.push(msg);

/* ---------- manifest ---------- */
let manifest;
try { manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8")); }
catch (e) { console.error(`module.json is not valid JSON: ${e.message}`); process.exit(1); }

for (const field of ["id", "title", "description", "version", "compatibility", "esmodules", "styles", "languages", "manifest", "download"]) {
  if (manifest[field] === undefined) note(`module.json: missing "${field}"`);
}
if (manifest.id !== "sargas-time-bomb") note(`module.json: id must be "sargas-time-bomb" (is "${manifest.id}")`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) note(`module.json: version "${manifest.version}" is not semver`);
if (!manifest.compatibility?.minimum || !manifest.compatibility?.verified) note("module.json: compatibility.minimum and .verified are required");
if (manifest.socket) note("module.json: socket must stay false (D5: no module socket in 1.0)");
if (!manifest.relationships?.systems?.some(s => s.id === "pf2e")) note("module.json: relationships.systems must declare pf2e (D3)");

const referenced = [
  ...(manifest.esmodules ?? []),
  ...(manifest.styles ?? []),
  ...(manifest.languages ?? []).map(l => l.path),
  manifest.readme, manifest.license
].filter(Boolean);
for (const f of referenced) if (!existsSync(join(root, f))) note(`module.json references missing file: ${f}`);

/* ---------- language ---------- */
let lang;
try { lang = JSON.parse(readFileSync(join(root, "lang/en.json"), "utf8")); }
catch (e) { console.error(`lang/en.json is not valid JSON: ${e.message}`); process.exit(1); }

const flat = new Set();
(function walk(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") walk(v, key); else flat.add(key);
  }
})(lang, "");

/* ---------- key usage ---------- */
function files(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some(e => name.endsWith(e))) out.push(p);
  }
  return out;
}
const sources = [...files(join(root, "scripts"), [".js"]), ...files(join(root, "templates"), [".hbs"])];
const used = new Map();
const add = (key, file) => { if (!used.has(key)) used.set(key, new Set()); used.get(key).add(relative(root, file)); };
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/["'`](STB\.[A-Za-z0-9_.-]+)["'`]/g)) if (!m[1].includes("$")) add(m[1], file);
  for (const m of text.matchAll(/\bt\(\s*["'`]([A-Za-z][A-Za-z0-9_.-]+)["'`]/g)) if (!m[1].includes("$")) add(`STB.${m[1]}`, file);
  for (const m of text.matchAll(/stbT\s+'([A-Za-z0-9_.-]+)'/g)) add(`STB.${m[1]}`, file);
}
for (const [key, where] of used) {
  if (!flat.has(key)) note(`missing i18n key ${key} (used in ${[...where].join(", ")})`);
}

/* ---------- pure modules must import without Foundry ---------- */
const pure = [
  "scripts/constants.js", "scripts/data/kinds.js", "scripts/compat.js",
  "scripts/services/clock-service.js", "scripts/services/trigger-service.js", "scripts/services/schedule-service.js",
  "scripts/services/validation-service.js", "scripts/services/migration-service.js", "scripts/services/portability-service.js",
  "scripts/services/write-queue.js", "scripts/services/permission-service.js", "scripts/services/store-service.js",
  "scripts/services/dispatcher-service.js", "scripts/services/time-source-service.js", "scripts/services/rest-service.js",
  "scripts/services/chat-service.js", "scripts/ui/pie.js", "scripts/ui/describe.js"
];
for (const p of pure) {
  try { await import(pathToFileURL(join(root, p)).href); }
  catch (e) { note(`${p} cannot be imported without Foundry: ${e.message}`); }
}

/* ---------- templates referenced by scripts ---------- */
for (const file of files(join(root, "scripts"), [".js"])) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/templates\/([A-Za-z0-9_./-]+\.hbs)/g)) {
    if (!existsSync(join(root, "templates", m[1]))) note(`${relative(root, file)} references missing template ${m[1]}`);
  }
}
for (const file of files(join(root, "templates"), [".hbs"])) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\{\{>\s*"modules\/sargas-time-bomb\/templates\/([^"]+)"/g)) {
    if (!existsSync(join(root, "templates", m[1]))) note(`${relative(root, file)} references missing partial ${m[1]}`);
  }
}

if (problems.length) {
  console.error(`check-manifest: ${problems.length} problem(s)`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`check-manifest: ok (${used.size} i18n keys verified, ${pure.length} modules import cleanly)`);
