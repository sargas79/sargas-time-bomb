#!/usr/bin/env node
/**
 * Reconcile CHANGELOG.md with the release version and print the release notes.
 *  - If an "## [Unreleased]" section exists, it is renamed to the version and dated.
 *  - If the version section already exists, it is used as is.
 *  - A fresh "## [Unreleased]" header is inserted at the top.
 * The updated changelog is written back (the release workflow zips it).
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) { console.error("usage: release-changelog.mjs <version>"); process.exit(1); }
const date = new Date().toISOString().slice(0, 10);
const path = "CHANGELOG.md";
let text = readFileSync(path, "utf8");

const versionHeader = `## [${version}]`;
if (!text.includes(versionHeader)) {
  if (text.includes("## [Unreleased]")) {
    text = text.replace("## [Unreleased]", `${versionHeader} - ${date}`);
  } else {
    const idx = text.indexOf("\n## ");
    const insert = `\n${versionHeader} - ${date}\n\n- Release ${version}.\n`;
    text = idx >= 0 ? text.slice(0, idx) + insert + text.slice(idx) : text + insert;
  }
}
if (!text.includes("## [Unreleased]")) {
  text = text.replace(versionHeader, `## [Unreleased]\n\n${versionHeader}`);
}
writeFileSync(path, text);

// Extract the section for release notes.
const start = text.indexOf(versionHeader);
const rest = text.slice(start);
const next = rest.indexOf("\n## ", 1);
const section = (next >= 0 ? rest.slice(0, next) : rest).trim();
process.stdout.write(section.split("\n").slice(1).join("\n").trim() + "\n");
