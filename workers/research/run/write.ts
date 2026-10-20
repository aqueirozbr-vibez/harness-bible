import { ApplicationFailure } from "@temporalio/activity";

import { readEarlierRuns, readResearchFound, readResearchSections, readRunQuestion, writeRunReport, type ConversationRunRow, type ResearchSection } from "@/lib/db/research";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { loadGuidePart, type Guide } from "@/lib/guides/load";
import { figureText, rowText, sectionText } from "@/lib/improve/anchorText";
import { changeOf } from "@/lib/improve/outcomeView";
import { sectionOfAnchor } from "@/lib/research/validate";
import { ReaderFindingSchema, type ReaderFinding, type ResearchFound } from "@/lib/schemas/researcher";
import type { Rubric } from "@/lib/schemas/rubric";
import { checkReport } from "@/lib/sensors/report";
import { defaultWriterDeps, pagesForWriter, reportReferencesOf, write, type WriteInput, type WriterDeps, type WriterFinding, type WriterInput, type Written } from "@/workers/agents/researcher/v2/writer";
import { currentRubric } from "@/workers/research/plan";

import { principalOfRun, RESEARCHER_V2_GUIDE_VERSION } from "./plan";

/*
 * The write of a person's run (feature-specs/48 § 5.6, § 5.7; unit 70b), the activity's own code: the question, the
 * findings that passed the checks with their change's before and after, the pages whose note passed under their numbers
 * in the run's page list, and for a follow-up the earlier runs' questions and reports, read inside the asker's
 * context; the writer called once with the writer part of the guide's version 2, holding no tool; its paragraphs held to
 * the report sensor; the report stored. The writer never reads the brief, who asked, or a page's address or title.
 *
 * What comes back is one of three: the report, with how many paragraphs the sensor kept and dropped; the key's rate
 * limit, a 429 that never reached the provider and so is not the writer's one attempt, which the workflow waits out
 * once (§ 5.6); or the person's cap, with its reset (`FAILED · BUDGET`). Every failure is an `ApplicationFailure` with a
 * code and no text: `WRITER_FAILED` for the agent's one failure and for a report the sensor left empty, `TEXT_PURGED`
 * where the question or what the reader found is gone, or went while the writer ran.
 *
 * `signal` is the activity's cancellation (48 § 5.1; review of unit 70): the writer's one request is not streamed and
 * runs to its end, at most the row's five minutes, but once the signal has fired its report is not stored, since the
 * workflow has already concluded the run with its record. The step fails `CANCELLED` instead, which nobody awaits.
 */

export type WriteRunStep = { readonly written: "report"; readonly findings: number; readonly paragraphs: number; readonly dropped: number } | { readonly written: "rate_limit" } | { readonly written: "budget"; readonly resetsAt: Date };

export interface WriteRunDeps {
  readonly guide: () => Guide;
  readonly rubric: () => Promise<Pick<Rubric, "chips"> | null>;
  readonly readQuestion: typeof readRunQuestion;
  readonly readFound: typeof readResearchFound;
  readonly readEarlier: typeof readEarlierRuns;
  readonly readSections: (releaseId: string, anchors: ReadonlyArray<string>) => Promise<ReadonlyArray<ResearchSection>>;
  readonly write: (input: WriteInput, deps: WriterDeps) => Promise<Written>;
  readonly writer: WriterDeps;
  readonly writeReport: typeof writeRunReport;
  readonly log: (line: string) => void;
}

export function defaultWriteRunDeps(): WriteRunDeps {
  return {
    guide: () => loadGuidePart("researcher", RESEARCHER_V2_GUIDE_VERSION, "writer"),
    rubric: currentRubric,
    readQuestion: readRunQuestion,
    readFound: readResearchFound,
    readEarlier: readEarlierRuns,
    readSections: readResearchSections,
    write,
    writer: defaultWriterDeps(),
    writeReport: writeRunReport,
    log: (line) => console.info(line),
  };
}

function fail(type: string, message: string): never {
  throw ApplicationFailure.create({ type, message, nonRetryable: true });
}

/** What the anchor says now, from the sections the reader was given: a section's source text, a figure's label and value, a row's claim and citation (lib/improve/anchorText.ts). */
function currentTextOf(finding: ReaderFinding, section: ResearchSection): string {
  if (finding.anchor.kind === "FIGURE") {
    const figure = section.figures.find((candidate) => candidate.id === finding.anchor.id);
    return figure === undefined ? "" : figureText(figure);
  }
  if (finding.anchor.kind === "SOURCE_ROW") {
    const row = section.rows.find((candidate) => candidate.id === finding.anchor.id);
    return row === undefined ? "" : rowText(row);
  }
  return sectionText({ markdownEn: section.text });
}

/** The findings that passed the checks as the writer reads them (48 § 5.6 slot 6): the reader's ordinals `found.valid` names, each with its section and its change as `changeOf` computes it. */
export function writerFindingsOf(found: Pick<ResearchFound, "findings" | "valid">, sections: ReadonlyArray<ResearchSection>): ReadonlyArray<WriterFinding> {
  return (found.valid ?? []).flatMap((ordinal) => {
    const parsed = ReaderFindingSchema.safeParse(found.findings[ordinal - 1]);
    if (!parsed.success) return [];
    const section = sectionOfAnchor(parsed.data.anchor, sections);
    if (section === null) return [];
    const change = changeOf({ anchor: { currentText: currentTextOf(parsed.data, section) }, proposal: parsed.data.proposal });
    return [{ section: section.id, anchor: parsed.data.anchor, changeKind: parsed.data.changeKind, before: change.before, after: change.after, note: parsed.data.note }];
  });
}

export async function writeRunStep(run: ConversationRunRow, deps: WriteRunDeps = defaultWriteRunDeps(), signal?: AbortSignal): Promise<WriteRunStep> {
  const question = await deps.readQuestion(run);
  if (question === null) fail("TEXT_PURGED", `research run ${run.id}: the question is gone`);
  const found = await deps.readFound(run);
  if (found === null) fail("TEXT_PURGED", `research run ${run.id}: what the reader found is gone`);
  const [earlier, sections, rubric] = await Promise.all([deps.readEarlier(run), deps.readSections(run.releaseId, run.targetAnchors), deps.rubric()]);
  const prompt: WriterInput = {
    guide: deps.guide(),
    rubric,
    language: run.locale,
    question,
    /* slot 4: the earlier questions and their reports, the last six of them the assembler keeps; a purged one is left out */
    earlier: earlier.flatMap((before) => (before.question === null ? [] : [{ question: before.question, report: before.report?.paragraphs.map((paragraph) => paragraph.text) ?? [] }])),
    sections,
    findings: writerFindingsOf(found, sections),
    pages: pagesForWriter(found.read ?? [], found.says ?? []),
  };

  let written: Written;
  try {
    written = await deps.write({ prompt, call: { principal: principalOfRun(run), traceId: run.traceId, ref: run.id } }, deps.writer);
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) {
      deps.log(`research ${run.id}: the writer met the person's cap; the run ends with what it has, resets ${error.resetsAt.toISOString()} (trace ${run.traceId})`);
      return { written: "budget", resetsAt: error.resetsAt };
    }
    if (error instanceof GatewayUnavailableError && error.cause === "rate_limit") {
      deps.log(`research ${run.id}: the gateway refused the writer at the key's rate; the provider never saw it (trace ${run.traceId})`);
      return { written: "rate_limit" };
    }
    throw error;
  }
  if (!written.ok) {
    deps.log(`research ${run.id}: the writer failed — ${written.failure} (trace ${run.traceId})`);
    fail("WRITER_FAILED", written.failure);
  }
  const verdict = checkReport({ paragraphs: written.output.paragraphs, ...reportReferencesOf(prompt) });
  const dropped = Object.values(verdict.ok ? verdict.report.dropped : verdict.dropped).reduce((sum, count) => sum + count, 0);
  if (!verdict.ok) {
    deps.log(`research ${run.id}: the report sensor dropped every paragraph (${Object.entries(verdict.dropped).map(([rule, count]) => `${rule} ${String(count)}`).join(", ")}; trace ${run.traceId})`);
    fail("WRITER_FAILED", `the report sensor dropped all ${String(dropped)} paragraphs (feature-specs/48 § 5.7)`);
  }
  /* the run cancelled while the writer ran: the workflow ended it, with its record, so the report goes onto no row */
  if (signal?.aborted === true) fail("CANCELLED", `research run ${run.id}: cancelled while the writer ran; the report is not stored`);
  const stored = await deps.writeReport(run, verdict.report);
  if (!stored.written) fail("TEXT_PURGED", `research run ${run.id}: its text was purged while the writer ran`);
  deps.log(`research ${run.id}: the report kept ${String(verdict.report.paragraphs.length)} paragraph${verdict.report.paragraphs.length === 1 ? "" : "s"}, ${String(dropped)} dropped (trace ${run.traceId})`);
  return { written: "report", findings: prompt.findings.length, paragraphs: verdict.report.paragraphs.length, dropped };
}
