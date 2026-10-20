import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getPrisma } from "@/lib/db/client";
import { generateGoldenSet, type GoldenSource } from "@/lib/golden/assistant";

/*
 * npm run golden:assistant — writes golden/assistant/<release>.jsonl from the
 * current release's rows (lib/golden/assistant.ts). Deterministic; commit the
 * file. Curators relabel by editing lines; regenerate only for a new release.
 */

async function main(): Promise<void> {
  const prisma = getPrisma();
  const release = await prisma.release.findFirst({ where: { isCurrent: true } });
  if (release === null) throw new Error("no current release; run `npm run ingest`");
  const inRelease = { chapterVersion: { releaseId: release.id } };
  const chapters = await prisma.chapterVersion.findMany({
    where: { releaseId: release.id },
    select: { chapterNumber: true, verifyStatus: true, chapter: { select: { part: true } }, editions: { where: { lang: "EN" }, select: { title: true } }, lab: { select: { anchor: true } }, xrefs: { where: { targetKind: "chapter" }, select: { targetId: true }, distinct: ["targetId"] } },
    orderBy: { chapterNumber: "asc" },
  });
  const figures = await prisma.figure.findMany({ where: { section: inRelease }, select: { anchor: true, label: true, valueText: true, tier: true, section: { select: { anchor: true, chapterVersion: { select: { chapterNumber: true } } } } }, orderBy: { anchor: "asc" } });
  const rows = await prisma.sourceRow.findMany({ where: inRelease, select: { anchor: true, claim: true, tier: true, chapterVersion: { select: { chapterNumber: true } } }, orderBy: { anchor: "asc" } });
  const source: GoldenSource = {
    release: release.id,
    chapters: chapters.map((c) => ({
      number: c.chapterNumber,
      title: c.editions[0]?.title ?? `Chapter ${c.chapterNumber}`,
      part: c.chapter.part,
      verified: c.verifyStatus === "PASSED",
      labId: c.lab?.anchor ?? null,
      refersTo: c.xrefs.map((x) => Number(x.targetId.replace(/^ch/, ""))).filter((n) => Number.isInteger(n)),
    })),
    figures: figures.map((f) => ({ id: f.anchor, sectionId: f.section.anchor, chapter: f.section.chapterVersion.chapterNumber, label: f.label, valueText: f.valueText, tier: f.tier })),
    sourceRows: rows.map((r) => ({ id: r.anchor, chapter: r.chapterVersion.chapterNumber, claim: r.claim, tier: r.tier })),
  };
  const items = generateGoldenSet(source);
  mkdirSync(join("golden", "assistant"), { recursive: true });
  const out = join("golden", "assistant", `${release.id}.jsonl`);
  writeFileSync(out, `${items.map((i) => JSON.stringify(i)).join("\n")}\n`, "utf8");
  const counts = items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
  console.log(`golden:assistant wrote ${items.length} questions to ${out}: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}; pt ${items.filter((i) => i.language === "pt").length}`);
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
