import "dotenv/config";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPrisma } from "@/lib/db/client";
import { currentRelease } from "@/lib/db/shared";
import { env } from "@/lib/env";
import { CURATED_EVIDENCE_DIR, SUGGESTIONS_DIR } from "@/lib/gate/suggestions";
import { generateCuratedSet, quotableSentences, CURATED_TOTAL } from "@/lib/golden/suggestions";
import { loadRubric } from "@/lib/rubrics/load";
import { currentRubricVersion } from "@/lib/db/improve";
import { CuratedItemSchema } from "@/lib/schemas/curated";

/*
 * npm run gate:suggestions — the curated set of suggestions for the Phase 4 gate (feature-specs/39 § 3), generated from
 * the current release's rows as the assistant's golden set is from its chapters: golden/suggestions-<release>.jsonl,
 * one item a line, and its evidence documents under golden/suggestions/evidence/. Deterministic for a release. A
 * curator labels the set by hand into golden/suggestions/labels/<release>.jsonl; `npm run gate:suggestions:run` runs it.
 */

async function main(): Promise<number> {
  if (env.DATABASE_URL === undefined) {
    console.error("gate:suggestions needs DATABASE_URL: the set is generated from the release's rows.");
    return 1;
  }
  const prisma = getPrisma();
  const release = await currentRelease();
  const inRelease = { chapterVersion: { releaseId: release.id } } as const;
  const rubricVersion = await currentRubricVersion();
  if (rubricVersion === null) {
    console.error("gate:suggestions: no rubric is in force (npm run rubric:publish).");
    return 1;
  }
  const { rubric } = loadRubric(rubricVersion.id);

  const sections = await prisma.section.findMany({ where: inRelease, select: { anchor: true, markdownEn: true, chapterVersion: { select: { chapterNumber: true } } }, orderBy: [{ chapterVersion: { chapterNumber: "asc" } }, { ordinal: "asc" }] });
  const figures = await prisma.figure.findMany({ where: { section: inRelease }, select: { anchor: true, label: true, valueText: true, unit: true, tier: true, scenarioParam: true, fastMoving: true, derive: { select: { labId: true } }, sourceRow: { select: { url: true } }, section: { select: { chapterVersion: { select: { chapterNumber: true } } } } }, orderBy: [{ section: { chapterVersion: { chapterNumber: "asc" } } }, { ordinal: "asc" }] });
  const rows = await prisma.sourceRow.findMany({ where: inRelease, select: { anchor: true, claim: true, citation: true, verifiedAt: true, fastMoving: true, chapterVersion: { select: { chapterNumber: true } } }, orderBy: [{ chapterVersion: { chapterNumber: "asc" } }, { ordinal: "asc" }] });

  /* a resolver is nobody's vendor: a source cited by DOI has no domain of its own here */
  const RESOLVERS = new Set(["doi.org", "dx.doi.org", "arxiv.org", "zenodo.org"]);
  const domainOf = (url: string | null): string | null => {
    if (url === null) return null;
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return RESOLVERS.has(host) ? null : host;
    } catch {
      return null;
    }
  };
  const today = new Date().toISOString().slice(0, 10);
  const generated = generateCuratedSet({
    release: release.id,
    today,
    rules: rubric,
    sections: sections.map((section) => ({ anchor: section.anchor, chapter: section.chapterVersion.chapterNumber, sentences: quotableSentences(section.markdownEn) })),
    figures: figures.map((figure) => ({ anchor: figure.anchor, chapter: figure.section.chapterVersion.chapterNumber, label: figure.label, valueText: figure.valueText, unit: figure.unit, derived: figure.derive !== null, scenarioParam: figure.scenarioParam, tier: figure.tier, vendorDomain: domainOf(figure.sourceRow?.url ?? null), fastMoving: figure.fastMoving })),
    rows: rows.map((row) => ({ anchor: row.anchor, chapter: row.chapterVersion.chapterNumber, claim: row.claim, citation: row.citation, verifiedOn: row.verifiedAt.toISOString().slice(0, 10), fastMoving: row.fastMoving })),
  });

  /* every line read back strictly, as the gate will read it */
  for (const item of generated.items) CuratedItemSchema.parse(item);
  rmSync(CURATED_EVIDENCE_DIR, { recursive: true, force: true });
  mkdirSync(CURATED_EVIDENCE_DIR, { recursive: true });
  const setPath = join(SUGGESTIONS_DIR, `suggestions-${release.id}.jsonl`);
  writeFileSync(setPath, `${generated.items.map((item) => JSON.stringify(item)).join("\n")}\n`);
  for (const document of generated.documents) writeFileSync(join(CURATED_EVIDENCE_DIR, document.file), document.text);
  const classes = new Map<string, number>();
  for (const item of generated.items) classes.set(item.changeClass, (classes.get(item.changeClass) ?? 0) + 1);
  console.log(`gate:suggestions · release ${release.id} · ${String(generated.items.length)} of ${String(CURATED_TOTAL)} items · ${String(generated.documents.length)} documents`);
  console.log(`  by class: ${[...classes.entries()].map(([name, count]) => `${name} ${String(count)}`).join(", ")}`);
  console.log(`  expected by rule: ${String(generated.items.filter((item) => item.expected.decision !== null).length)} · for the adjudicator or a curator: ${String(generated.items.filter((item) => item.expected.decision === null).length)}`);
  console.log(`  written: ${setPath} and ${CURATED_EVIDENCE_DIR}`);
  return generated.items.length === CURATED_TOTAL ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => (env.DATABASE_URL === undefined ? undefined : getPrisma().$disconnect()));
