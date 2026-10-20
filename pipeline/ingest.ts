import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getPrisma } from "@/lib/db/client";
import { env } from "@/lib/env";

import { attachMermaid, buildChapter, loadBook, type BuiltChapter } from "./build";
import { ParseError } from "./parse/chapterFile";
import { createMermaidRenderer, type MermaidRenderer } from "./parse/mermaid";
import { firstHeading, plainProse, renderProse } from "./parse/markdown";
import { renderHash, treeHash } from "./renderHash";
import { formatReport, type IngestReport } from "./report";

/*
 * npm run ingest -- [--book ../bible] [--release 2026.09] [--only 21,28,37] [--dry-run]
 *                   [--expect-hash <sha256>] [--skip-invalid] [--no-mermaid]
 *                   [--git-sha <commit>] [--report-dir <folder>]
 * One transaction; inserts a new release or aborts (feature-specs/04 § 6.7).
 * Requires PIPELINE=1 in the environment (the npm script sets it).
 * A merge (feature-specs/37 § 5; unit 54c) runs it on a tag of the book's repository: `--git-sha` is the tagged
 * commit, which is then the release's `gitSha` (37 § 3), and `--expect-hash` the render hash its check computed.
 */

interface Args {
  readonly book: string;
  readonly release: string;
  readonly only: ReadonlySet<number> | null;
  readonly dryRun: boolean;
  readonly expectHash: string | null;
  readonly skipInvalid: boolean;
  readonly mermaid: boolean;
  /** The tagged commit a merge ingests (37 § 3), or null for the folder's own tree hash. */
  readonly gitSha: string | null;
  readonly reportDir: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const only = get("--only");
  return {
    book: resolve(get("--book") ?? env.BOOK_DIR),
    release: get("--release") ?? env.RELEASE_ID,
    only: only === null ? null : new Set(only.split(",").map((s) => Number(s.trim()))),
    dryRun: argv.includes("--dry-run"),
    expectHash: get("--expect-hash") ?? env.RENDER_HASH_EXPECTED ?? null,
    skipInvalid: argv.includes("--skip-invalid"),
    mermaid: !argv.includes("--no-mermaid"),
    gitSha: get("--git-sha"),
    reportDir: get("--report-dir") ?? join("pipeline", "reports"),
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  if (!args.dryRun && env.PIPELINE !== "1") {
    console.error("ingest: PIPELINE=1 is required to write content rows (architecture § 11.3).");
    return 1;
  }
  const prisma = args.dryRun ? null : getPrisma();

  const book = loadBook(args.book);
  if (!book.chapterMap) console.log("ingest: book/CHAPTER-MAP.md is absent; each chapter carries what its frontmatter says.");
  if (args.gitSha !== null && !/^[0-9a-f]{40}$/.test(args.gitSha)) {
    console.error(`ingest: --git-sha takes a commit id, not ${args.gitSha}.`);
    return 1;
  }
  const gitSha = args.gitSha ?? treeHash(book.allFiles);

  /* previous versions, for the mechanical bump (D4), and the release they were read from, which the publish must find still current */
  const previous = new Map<number, { version: string; title: string; layerTitles: string[]; subHeadings: string[]; contentHash: string }>();
  let versionedAgainst: string | null = null;
  if (prisma !== null) {
    const current = await prisma.release.findFirst({ where: { isCurrent: true }, include: { chapters: { include: { editions: { where: { lang: "EN" } }, sections: { orderBy: { ordinal: "asc" }, select: { titleEn: true, markdownEn: true } } } } } });
    versionedAgainst = current?.id ?? null;
    for (const cv of current?.chapters ?? []) {
      previous.set(cv.chapterNumber, {
        version: cv.version,
        title: cv.editions[0]?.title ?? "",
        layerTitles: cv.sections.map((s) => s.titleEn),
        subHeadings: cv.sections.flatMap((s) => [...s.markdownEn.matchAll(/^###\s+(.+?)\s*$/gm)].map((m) => m[1])),
        contentHash: cv.contentHash,
      });
    }
  }

  const skipped: Array<{ chapter: number; reason: string }> = [];
  let built: BuiltChapter[] = [];
  for (const file of book.chapters) {
    const n = Number(/^ch(\d{2})/.exec(file.fileName)?.[1] ?? "-1");
    if (args.only !== null && !args.only.has(n)) continue;
    try {
      built.push(buildChapter(file, book, { locale: "en", previous }));
    } catch (error) {
      if (error instanceof ParseError && args.skipInvalid) {
        skipped.push({ chapter: n, reason: error.message });
        continue;
      }
      throw error;
    }
  }

  let renderer: MermaidRenderer | null = null;
  if (args.mermaid) {
    try {
      renderer = await createMermaidRenderer();
    } catch (error) {
      console.error(`ingest: mermaid renderer unavailable (${(error as Error).message}); figures will carry a placeholder.`);
    }
  }
  try {
    const attached: BuiltChapter[] = [];
    for (const chapter of built) {
      try {
        attached.push(...(await attachMermaid([chapter], renderer)));
      } catch (error) {
        if (error instanceof ParseError && args.skipInvalid) {
          skipped.push({ chapter: chapter.number, reason: error.message });
          continue;
        }
        throw error;
      }
    }
    built = attached;
  } finally {
    await renderer?.close();
  }

  const hash = renderHash(built.map((c) => ({ number: c.number, hash: c.contentHash })), args.release);
  const hashMatches = args.expectHash === null ? null : args.expectHash === hash;

  const report: IngestReport = {
    release: args.release,
    gitSha,
    renderHash: hash,
    expectedHash: args.expectHash,
    hashMatches,
    dryRun: args.dryRun,
    skipped,
    chapters: built.map((c) => c.report),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
  mkdirSync(args.reportDir, { recursive: true });
  writeFileSync(join(args.reportDir, `${args.release}${args.dryRun ? ".dry-run" : ""}.json`), JSON.stringify(report, null, 2));
  console.log(formatReport(report));

  if (hashMatches === false) {
    console.error(`ingest: render hash ${hash} differs from expected ${args.expectHash}; nothing written.`);
    return 2;
  }
  if (prisma === null) return 0;

  const existing = await prisma.release.findUnique({ where: { gitSha } });
  if (existing !== null) {
    if (existing.renderHash === hash) {
      console.log(`ingest: no-op — release ${existing.id} already holds gitSha ${gitSha} with the same render hash.`);
      return 0;
    }
    console.error(`ingest: gitSha ${gitSha} is already ingested as release ${existing.id} with render hash ${existing.renderHash}; the pipeline changed. Use a new release id.`);
    return 3;
  }
  const sameId = await prisma.release.findUnique({ where: { id: args.release } });
  if (sameId !== null) {
    console.error(`ingest: release ${args.release} already exists (gitSha ${sameId.gitSha}); content rows are immutable per release. Use a new release id.`);
    return 3;
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.release.create({ data: { id: args.release, gitSha, renderHash: hash, isCurrent: false, publishedAt: new Date() } });
      for (const c of built) {
        await tx.chapter.upsert({ where: { number: c.number }, create: { number: c.number, part: c.part, slug: c.slug, carries: c.carries }, update: {} });
        const cv = await tx.chapterVersion.create({
          data: {
            chapterNumber: c.number,
            releaseId: args.release,
            version: c.version,
            sourceLang: "EN",
            verifyStatus: c.verifyStatus,
            redteamStatus: c.redteamStatus,
            redteamOpen: c.redteamOpen,
            verifiedAt: c.verifiedAt,
            contentHash: c.contentHash,
            words: c.words,
            derivedLinked: c.derivedLinked,
            derivedTotal: c.derivedTotal,
            citedTotal: c.citedTotal,
            citedFastMoving: c.citedFastMoving,
          },
        });
        await tx.edition.create({ data: { chapterVersionId: cv.id, lang: "EN", status: "PARITY", title: c.title, standfirst: c.standfirst } });
        await tx.edition.create({ data: { chapterVersionId: cv.id, lang: "PT", status: "PENDING", title: c.title, standfirst: c.standfirst } });

        const rows = await tx.sourceRow.createManyAndReturn({
          data: c.sourceRows.map((r) => ({ anchor: `${pad(c.number)}.9 r${r.ordinal}`, chapterVersionId: cv.id, ordinal: r.ordinal, claim: r.claim, citation: r.citation, url: r.url, doi: r.doi, tier: r.tier, verifiedAt: r.verifiedAt, fastMoving: r.fastMoving })),
          select: { id: true, anchor: true, fastMoving: true },
        });
        const rowByAnchor = new Map(rows.map((r) => [r.anchor, r]));

        for (const s of c.sections) {
          const section = await tx.section.create({
            data: { anchor: s.id, chapterVersionId: cv.id, layer: s.layer, ordinal: s.ordinal, titleEn: s.titleEn, markdownEn: s.markdownEn, htmlEn: s.htmlEn, words: s.words, textEn: s.textEn, codeBlocks: s.codeBlocks as unknown as object[] },
            select: { id: true },
          });
          if (s.figures.length > 0) {
            const figures = await tx.figure.createManyAndReturn({
              data: s.figures.map((f) => {
                const row = f.sourceRowId === null ? undefined : rowByAnchor.get(f.sourceRowId);
                return { anchor: f.id, sectionId: section.id, ordinal: f.ordinal, label: f.label, valueText: f.valueText, value: f.value, unit: f.unit, tier: f.tier, fastMoving: row?.fastMoving ?? false, scenarioParam: f.scenarioParam, sourceRowId: row?.id ?? null };
              }),
              select: { id: true, anchor: true },
            });
            const figureByAnchor = new Map(figures.map((f) => [f.anchor, f.id]));
            const links = s.figures.filter((f) => f.derive !== null);
            if (links.length > 0) {
              await tx.deriveLink.createMany({ data: links.map((f) => ({ figureId: figureByAnchor.get(f.id)!, labId: f.derive!.labId, filePath: f.derive!.filePath, line: f.derive!.line, key: f.derive!.key, expression: f.derive!.expression })) });
            }
          }
          if (s.xrefs.length > 0) {
            await tx.crossReference.createMany({ data: s.xrefs.map((x) => ({ chapterVersionId: cv.id, fromSectionId: section.id, targetKind: x.targetKind, targetId: x.targetId })) });
          }
        }

        if (c.lab !== null) {
          const readmeHtml = renderProse(c.lab.readmeMarkdown.replace(/```[\s\S]*?```/g, ""));
          const prevLab = await tx.lab.findFirst({ where: { chapterVersion: { chapterNumber: c.number, release: { isCurrent: true } } }, select: { ciVerdict: true, ciDivergedSince: true, ciCheckedAt: true } });
          const divergedSince = c.lab.ciVerdict === "REPRODUCED" || c.lab.ciVerdict === null ? null : (prevLab?.ciDivergedSince ?? c.lab.ciCheckedAt);
          await tx.lab.create({
            data: {
              anchor: c.lab.id,
              chapterVersionId: cv.id,
              folder: c.lab.folder,
              readme: readmeHtml,
              title: firstHeading(c.lab.readmeMarkdown),
              textEn: plainProse(c.lab.readmeMarkdown),
              expectedRuntimeS: c.lab.expectedRuntimeS,
              declaresModelCalls: c.lab.declaresModelCalls,
              egressExtra: [],
              ciVerdict: c.lab.ciVerdict,
              ciCheckedAt: c.lab.ciCheckedAt,
              ciDivergedSince: divergedSince,
              derived: c.lab.derived as object,
              files: { create: c.lab.files.map((f) => ({ path: f.path, sha256: f.sha256, content: f.content })) },
            },
          });
        }
      }
      /* The release the versions were read against is the one made not current: another publish landed meanwhile, and this one would publish over it with versions of the wrong release (unit 54's review). */
      const retired = await tx.release.updateMany({ where: versionedAgainst === null ? { isCurrent: true } : { id: versionedAgainst, isCurrent: true }, data: { isCurrent: false } });
      if (versionedAgainst !== null && retired.count !== 1) throw new IngestConflict(`release ${versionedAgainst}, which the versions were read against, is not current any more: another release was published meanwhile`);
      await tx.release.update({ where: { id: args.release }, data: { isCurrent: true } });
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
  console.log(`ingest: release ${args.release} is current · ${built.length} chapters · renderHash ${hash}`);
  return 0;
}

/** Another release was published while this one was built: the conflict exit (3), as a release id or a gitSha already taken is. */
class IngestConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestConflict";
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = error instanceof IngestConflict ? 3 : 1;
  })
  .finally(() => (env.DATABASE_URL === undefined ? undefined : getPrisma().$disconnect()));
