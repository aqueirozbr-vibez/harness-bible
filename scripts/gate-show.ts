import "dotenv/config";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { tenantOf } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { newestRun, readRunFile, REPORTS_DIR } from "@/lib/gate/goldenRun";
import { LABELS_DIR, labelsFileName, readLabels } from "@/lib/gate/labels";
import { LABELS_MIN } from "@/lib/gate/phase2";
import { criteriaOf, progressText, showText, type ShownAnswer, type ShownSection } from "@/lib/gate/show";
import { loadGuidePart } from "@/lib/guides/load";
import { GoldenItemSchema } from "@/lib/schemas/golden";
import { LABELLERS, type Label } from "@/lib/schemas/labels";

/*
 * npm run gate:show (feature-specs/22 § 5, D3): the reading aid of the person who labels answers for κ.
 *
 *   npm run gate:show                      where the labelling stands, and which answers are next
 *   npm run gate:show -- G-0042            one answer: the question, the answer, what it cites as the book prints it,
 *                                          the grader's four criteria, and the label line to complete
 *   … --run <file>                         a run file by name; without it the newest real run, or the stub's when
 *                                          no real run exists
 *   … --as curator                         who the label line names (andre when not said)
 *
 * It reads; it writes nothing. The label is a line the labeller adds to golden/assistant/labels/<release>.jsonl.
 * The grader's score and verdicts are in the rows this command reads and are never printed (lib/gate/show.ts).
 */

function stop(message: string): never {
  console.error(`${message}\nusage: npm run gate:show [-- <G-0000>] [--run <file>] [--as ${LABELLERS.join("|")}]`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: { run: { type: "string" }, as: { type: "string", default: "andre" } }, allowPositionals: true, strict: true });
  const labeller = LABELLERS.find((name) => name === values.as);
  if (labeller === undefined) stop(`--as takes ${LABELLERS.join(" or ")}, not ${values.as}`);
  if (positionals.length > 1) stop("one answer at a time");
  const id = positionals[0] ?? null;
  if (id !== null && !/^G-\d{4}$/.test(id)) stop(`${id} is not a golden id (G-0042)`);

  const prisma = getPrisma();
  const release = await prisma.release.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (release === null) throw new Error("no current release: run `npm run ingest`");

  if (values.run !== undefined && !existsSync(join(REPORTS_DIR, values.run))) stop(`${values.run} is not a file of pipeline/reports/: --run takes a run file's name`);
  const run = values.run === undefined ? (newestRun(REPORTS_DIR, release.id, "real") ?? newestRun(REPORTS_DIR, release.id, "stub")) : readRunFile(REPORTS_DIR, values.run);
  if (run === null) stop(`no run of ${release.id} in pipeline/reports/: npm run gate:golden -- --stub (or --real) writes one`);
  const labels = readLabels(LABELS_DIR, release.id);
  const labelsFile = `golden/assistant/labels/${labelsFileName(release.id)}`;

  if (id === null) {
    console.log(progressText(run, labels, LABELS_MIN, labelsFile));
    return;
  }

  const item = readFileSync(join(process.cwd(), "golden", "assistant", `${release.id}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)))
    .find((candidate) => candidate.id === id);
  if (item === undefined) stop(`${id} is not in golden/assistant/${release.id}.jsonl`);
  const record = run.items.find((candidate) => candidate.id === id);
  if (record === undefined) stop(`${id} is not in ${run.file}${run.partial ? " (a partial run)" : ""}`);

  /* The rows are the run's account's, and are read as that account: the tenant guard hides them from anyone else. */
  const messageId = record.messageId;
  const owner = await withSystem(() => prisma.user.findUnique({ where: { id: run.header.userId }, select: { id: true, organisationId: true } }));
  const row =
    owner === null || messageId === null
      ? null
      : await withTenant(tenantOf({ id: owner.id, organisationId: owner.organisationId, role: "READER", displayName: "Gate", locale: item.language, identityVerified: false, parts: [], sessionId: null }), () =>
          prisma.message.findFirst({
            where: { id: messageId },
            select: {
              conversationId: true,
              text: true,
              guideVersion: true,
              substituted: true,
              citations: { orderBy: { ordinal: "asc" }, select: { ordinal: true, sectionId: true, figureId: true, version: true, editionLang: true, claimText: true } },
            },
          }),
        );
  const answer: ShownAnswer | null = row;

  const cited = [...new Set((answer?.citations ?? []).map((citation) => citation.sectionId))];
  const figures = (answer?.citations ?? []).flatMap((citation) => (citation.figureId === null ? [] : [citation.figureId]));
  const rows = await prisma.section.findMany({
    where: { anchor: { in: cited }, chapterVersion: { releaseId: release.id } },
    select: { anchor: true, titleEn: true, titlePt: true, figures: { where: { anchor: { in: figures } }, select: { anchor: true, label: true, valueText: true } } },
  });
  const sections: ReadonlyArray<ShownSection> = rows.map((section) => ({
    sectionId: section.anchor,
    title: item.language === "pt" ? (section.titlePt ?? section.titleEn) : section.titleEn,
    figures: section.figures.map((figure) => ({ figureId: figure.anchor, label: figure.label, valueText: figure.valueText })),
  }));

  let criteria: { readonly text: string; readonly file: string } | null = null;
  if (answer !== null && answer.guideVersion !== null) {
    try {
      const text = criteriaOf(loadGuidePart("assistant", answer.guideVersion, "grader").prefix);
      criteria = text === null ? null : { text, file: `guides/assistant/${answer.guideVersion}/grader.md` };
    } catch {
      criteria = null;
    }
  }

  const labelled: Label | null = labels.find((label) => label.messageId === record.messageId) ?? null;
  console.log(
    showText({
      item,
      record,
      run,
      answer,
      sections,
      criteria,
      labelsFile,
      labeller,
      labelled,
      pageUrl: answer === null ? null : `${env.APP_URL}/${item.language}/assistant/${answer.conversationId}`,
      now: new Date(),
    }),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
