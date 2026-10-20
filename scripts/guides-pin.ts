import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GUIDES_DIR, joinPrefix, readManifest, type Agent } from "@/lib/guides/load";
import { sha256 } from "@/pipeline/renderHash";

/*
 * npm run guides:pin -- assistant v1.9 — recomputes a guide's prefix hash, and
 * the hash of each named part, into its manifest. Run it once when a new guide
 * version is created; an existing version is never re-pinned (the loader's
 * check is the point).
 */

const [agent, version] = process.argv.slice(2) as [Agent | undefined, string | undefined];
if (agent === undefined || version === undefined) {
  console.error("usage: npm run guides:pin -- <assistant|grader|adjudicator> <version>");
  process.exit(1);
}
const manifest = readManifest(agent, version);
const prefixOf = (files: ReadonlyArray<string>): string => joinPrefix(files.map((f) => readFileSync(join(GUIDES_DIR, agent, version, f), "utf8")));
const prefix = prefixOf(manifest.files);
const hash = sha256(prefix);
const parts =
  manifest.parts === undefined
    ? undefined
    : Object.fromEntries(Object.entries(manifest.parts).map(([name, part]) => [name, { files: part.files, sha256: sha256(prefixOf(part.files)) }]));
writeFileSync(join(GUIDES_DIR, agent, version, "manifest.json"), `${JSON.stringify({ ...manifest, sha256: hash, ...(parts === undefined ? {} : { parts }) }, null, 2)}\n`);
console.log(`${agent}/${version}: ${manifest.files.join(" + ")} → sha256 ${hash} (${prefix.length} chars)`);
for (const [name, part] of Object.entries(parts ?? {})) console.log(`${agent}/${version}/${name}: ${part.files.join(" + ")} → sha256 ${part.sha256}`);
