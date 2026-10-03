// Rebuilds data.json from the latest released manifest of every repo listed
// in catalog.config.json. Run with: node scripts/update-catalog.mjs
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(path.join(root, "catalog.config.json"), "utf8"));

async function fetchEntry(kind, entry) {
  const repoUrl = `https://github.com/${config.owner}/${entry.repo}`;
  const manifest = `${repoUrl}/releases/latest/download/${entry.manifestFile}`;
  let data = {};
  try {
    const res = await fetch(manifest, { redirect: "follow" });
    if (res.ok) data = await res.json();
    else console.warn(`[${entry.repo}] ${res.status} fetching latest manifest`);
  } catch (err) {
    console.warn(`[${entry.repo}] ${err.message}`);
  }
  return {
    kind,
    id: data.id ?? entry.repo,
    name: data.title ?? entry.repo,
    repo: repoUrl,
    manifest,
    version: data.version ?? null,
    summary: entry.summary ?? firstSentence(data.description),
    compatibility: data.compatibility ?? null,
  };
}

function firstSentence(text) {
  if (!text) return "";
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return match ? match[1] : text.trim();
}

const systems = await Promise.all(config.systems.map((e) => fetchEntry("system", e)));
const modules = await Promise.all(config.modules.map((e) => fetchEntry("module", e)));

const out = { generatedAt: new Date().toISOString(), owner: config.owner, systems, modules };
await writeFile(path.join(root, "data.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote data.json: ${systems.length} systems, ${modules.length} modules`);
