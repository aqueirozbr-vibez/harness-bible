import { randomUUID } from "node:crypto";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendUserMessage, createConversation } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { Prisma } from "@/lib/db/generated/client";
import { currentRelease } from "@/lib/db/shared";
import { withTenant } from "@/lib/db/tenant";
import { questionSha256Of } from "@/lib/research/question";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import type { FindingOutcome, ResearchRefusal, ResearchSkip, ResearchState } from "@/lib/schemas/research";
import type { ReaderFinding, ReadPage, Report, ResearchFound, ResearchStep } from "@/lib/schemas/researcher";
import { researchRunWorkflowId } from "@/lib/schemas/workflows";

/*
 * The Research page's states as rows (feature-specs/48 § 11.3, § 18, § 26; unit 72), shared by the research seed
 * (`npm run research:seed`, for the demo reader and the truncation suite) and the page's browser suite (for its own
 * account): six researches written as their runs would have left them, and an Assistant answer to seed from. No model
 * is asked and no workflow is started. Since unit 73 a run carries the workflow id its start would have given it
 * (`research:<runId>`), as the statistics count only runs with a workflow (§ 11.6): every run but the one a rule refused
 * at its start, which never had one. So the seed's runs of the last 24 hours count toward the day's thirty (A8) as
 * real ones would — nine of them, the two that spent nothing (`SKIPPED · BUDGET`, `SKIPPED · UNAVAILABLE`) left out —
 * and a run again replaces them; the budget's reset the start reads (§ 5.2 check 6) is the newest run's, the one under
 * way, which met no cap; none is swept (§ 17.2), since each belongs to a research; and no workflow of that id runs, so a
 * start in a research whose run is under way ends that run `FAILED · ABANDONED`, as it did with no id. No `BudgetLedger`
 * row is written, since the rows are never deleted again: every run's cost reads `—`. The seeded research's report
 * carries a flag (`wrong_citation`), so the page shows a flagged report and the statistics count one.
 *
 * - **done**: a research and its follow-up, each with its steps, its report citing its own pages `[1]` to `[3]`, the
 *   pages it read, two findings that passed the checks (a claim and a figure's value) and one the checks rejected,
 *   which the page never shows; the follow-up's one finding a duplicate. Two runs, so two page lists numbered from 1.
 * - **under way**: a run reading the web, its steps so far, started now. It reads `stale` 90 minutes later (§ 6).
 * - **refused**: the plant-equipment rule, the scope with its two pointers, and the planner's `R-PERSONAL`.
 * - **stopped**: the cap at the planner, the cap during the read, a reader that failed, the engine unavailable, and a
 *   run under way two hours ago that nothing moves (stale).
 * - **purged**: a run 31 days old whose words were removed, its findings' outcomes kept.
 * - **seeded**: a research from the seed answer, one run done with no finding.
 *
 * The seed answer's conversation also holds, after the answer, a question the Assistant refused (since unit 75): the
 * answer offers `Start a research` and the refusal none (feature-specs/48 § 9.1), and neither has a research line, as
 * no turn has been handed to research since then (§ 9.2). Its id is the report's `seedConversation`.
 *
 * Run again for the same asker, it replaces what it wrote before (found by its trace id).
 */

/** The seed's trace: what finds its rows again. */
export const PAGE_TRACE = "5eed0072".repeat(4);
/** The Assistant answer the page is seeded from (`?from=`), known by its question. */
const SEED_QUESTION = "How long should a server keep an idempotency key?";
/** The question after it, which the Assistant refused: a refusal offers no research (48 § 9.1). */
const REFUSED_QUESTION = "Which pizza place in Lisbon keeps its dough the longest?";

export interface ResearchPageSeed {
  readonly done: string;
  readonly underWay: string;
  readonly refused: string;
  readonly stopped: string;
  readonly purged: string;
  readonly seeded: string;
  /** The Assistant answer a research can be seeded from: `/research?from=<id>`. */
  readonly seedAnswer: string;
  /** Its Assistant conversation, the answer and a refusal after it (`/assistant?ask=<id>`; unit 75). */
  readonly seedConversation: string;
}

const DAY_MS = 86_400_000;
const S213 = parseSectionId("21.3");
const S214 = parseSectionId("21.4");

const PAGES: ReadonlyArray<ReadPage> = [
  { url: "https://docs.stripe.com/api/idempotent_requests", title: "Idempotent requests", opened: true, search: 1 },
  { url: "https://developer.paypal.com/reference/guidelines/idempotency/", title: "Idempotency guidelines for retried payment requests and their keys", opened: true, search: 1 },
  { url: "https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods", title: null, opened: false, search: 2 },
  { url: "https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/", title: "The Idempotency-Key HTTP Header Field", opened: true, search: 2 },
];

const FOLLOW_UP_PAGES: ReadonlyArray<ReadPage> = [
  { url: "https://cloud.google.com/apis/design/design_patterns#request_duplication", title: "Request duplication", opened: true, search: 1 },
  { url: "https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/", title: "Making retries safe with idempotent APIs", opened: true, search: 1 },
  { url: "https://learn.microsoft.com/azure/architecture/patterns/retry", title: "Retry pattern", opened: false, search: 1 },
];

function stepsOf(at: Date, sections: ReadonlyArray<string>, searches: ReadonlyArray<{ readonly query: string; readonly results: number | null; readonly pages: ReadonlyArray<ReadPage | { readonly url: string; readonly pending: true }> }>, tail: ReadonlyArray<"CHECKING" | "WRITING">): ResearchStep[] {
  const steps: ResearchStep[] = [];
  const stamp = (): string => new Date(at.getTime() + steps.length * 1_500).toISOString();
  steps.push({ seq: steps.length, at: stamp(), kind: "PLANNING" });
  steps.push({ seq: steps.length, at: stamp(), kind: "SECTIONS", sections: sections.map((id) => parseSectionId(id)) });
  for (const search of searches) {
    steps.push({ seq: steps.length, at: stamp(), kind: "SEARCH", query: search.query, results: search.results });
    for (const page of search.pages) {
      steps.push("pending" in page ? { seq: steps.length, at: stamp(), kind: "PAGE", url: page.url, title: null, opened: null } : { seq: steps.length, at: stamp(), kind: "PAGE", url: page.url, title: page.title, opened: page.opened });
    }
  }
  for (const kind of tail) steps.push({ seq: steps.length, at: stamp(), kind });
  return steps;
}

const CLAIM: ReaderFinding = {
  anchor: { kind: "SECTION", id: "21.3" },
  changeKind: "ADD_CLAIM",
  proposal: { kind: "ADD_CLAIM", text: "Payment providers keep an idempotency key for at least 24 hours; a retry after the window is processed as a new request.", placeAfter: "end", fastMoving: true },
  sources: [{ url: PAGES[0]?.url ?? "" }, { url: PAGES[1]?.url ?? "" }],
  note: "Both providers document a 24-hour floor for keys; the book's section gives no window at all.",
};

const VALUE: ReaderFinding = {
  anchor: { kind: "FIGURE", id: "F-21-16" },
  changeKind: "SET_VALUE",
  proposal: { kind: "SET_VALUE", after: "8000", unit: "tokens" },
  sources: [{ url: PAGES[3]?.url ?? "" }],
  note: "The draft standard's example sizes the stored response at this figure.",
};

const REJECTED: ReaderFinding = {
  anchor: { kind: "SECTION", id: "21.4" },
  changeKind: "ADD_CLAIM",
  proposal: { kind: "ADD_CLAIM", text: "A page the read never opened says something else.", placeAfter: "end", fastMoving: false },
  sources: [{ url: "https://example.org/never-opened" }],
  note: "A source the read did not see: the checks refuse it, and the page never shows it.",
};

const REPORT: Report = {
  paragraphs: [
    { text: "Stripe keeps an idempotency key for 24 hours after the first request; a write retried after that is processed as a new one [1]. The section gives no window for how long a key is kept.", sections: [S213], pages: [1] },
    { text: "PayPal documents the same floor for its payment requests [2], and the draft HTTP standard leaves the window to the server while naming 24 hours as common [4].", sections: [], pages: [2, 4] },
    { text: "None of the pages read changes the figures of the next section.", sections: [S214], pages: [] },
  ],
  dropped: {},
};

const FOLLOW_UP_REPORT: Report = {
  paragraphs: [
    { text: "The follow-up pages agree that a retry must reuse the same key [1], and none names a default longer than a day [2].", sections: [S213], pages: [1, 2] },
    { text: "One retry guide could not be opened, so it says nothing here [3].", sections: [], pages: [3] },
  ],
  dropped: {},
};

interface RunRow {
  readonly ordinal: number;
  readonly question: string;
  readonly state: ResearchState;
  readonly createdAt: Date;
  readonly skip?: ResearchSkip;
  readonly failure?: string;
  readonly refusal?: ResearchRefusal;
  readonly sections?: ReadonlyArray<string>;
  readonly targets?: ReadonlyArray<string>;
  readonly steps?: ReadonlyArray<ResearchStep>;
  readonly found?: ResearchFound;
  readonly report?: Report;
  readonly searches?: number;
  readonly pageReads?: number;
  readonly budgetResetsAt?: Date;
  readonly planned?: boolean;
  readonly purgedAt?: Date;
  readonly findings?: ReadonlyArray<{ readonly ordinal: number; readonly outcome: FindingOutcome; readonly suggestionId?: string }>;
  /** Refused by a rule at its start, so no workflow was ever started for it (§ 5.2). */
  readonly ruleRefused?: boolean;
  /** The person's label on the run's report or refusal (§ 11.7). */
  readonly flag?: string;
}

const ENDED: ReadonlySet<ResearchState> = new Set(["DONE", "SKIPPED", "FAILED", "REFUSED"]);

async function research(asker: SessionUser, releaseId: string, input: { readonly seedMessageId?: string; readonly runs: ReadonlyArray<RunRow>; readonly purgedAt?: Date }): Promise<string> {
  return withTenant(tenantOf(asker), async () => {
    const prisma = getPrisma();
    const first = input.runs[0]?.createdAt ?? new Date();
    const last = input.runs.at(-1)?.createdAt ?? first;
    const conversation = await prisma.researchConversation.create({ data: { userId: asker.id, organisationId: asker.organisationId, locale: "EN", seedMessageId: input.seedMessageId ?? null, createdAt: first, lastRunAt: last, textPurgedAt: input.purgedAt ?? null }, select: { id: true } });
    for (const run of input.runs) {
      const purged = run.purgedAt !== undefined;
      const id = randomUUID();
      const created = await prisma.researchRun.create({
        data: {
          id,
          userId: asker.id,
          organisationId: asker.organisationId,
          releaseId,
          locale: "EN",
          state: run.state,
          skip: run.skip ?? null,
          failure: run.failure ?? null,
          gap: false,
          sectionAnchors: [...(run.sections ?? run.targets ?? [])],
          targetAnchors: [...(run.targets ?? [])],
          questionSha256: questionSha256Of(run.question),
          briefSha256: run.planned === true ? questionSha256Of(`brief of ${run.question}`) : null,
          searches: run.searches ?? 0,
          pageReads: run.pageReads ?? 0,
          traceId: PAGE_TRACE,
          workflowId: run.ruleRefused === true ? null : researchRunWorkflowId(id),
          conversationId: conversation.id,
          ordinal: run.ordinal,
          question: purged ? null : run.question,
          steps: purged || run.steps === undefined ? Prisma.DbNull : (run.steps as unknown as Prisma.InputJsonValue),
          found: purged || run.found === undefined ? Prisma.DbNull : (run.found as unknown as Prisma.InputJsonValue),
          report: purged || run.report === undefined ? Prisma.DbNull : (run.report as unknown as Prisma.InputJsonValue),
          refusal: run.refusal ?? null,
          budgetResetsAt: run.budgetResetsAt ?? null,
          createdAt: run.createdAt,
          finishedAt: ENDED.has(run.state) ? new Date(run.createdAt.getTime() + 134_000) : null,
          textPurgedAt: run.purgedAt ?? null,
          flagReason: run.flag ?? null,
          flaggedAt: run.flag === undefined ? null : new Date(run.createdAt.getTime() + 300_000),
        },
        select: { id: true },
      });
      for (const finding of run.findings ?? []) {
        await prisma.researchFinding.create({ data: { runId: created.id, userId: asker.id, ordinal: finding.ordinal, outcome: finding.outcome, invalidReason: finding.outcome === "INVALID" ? "SOURCE_NOT_SEEN" : null, suggestionId: finding.suggestionId ?? null } });
      }
    }
    return conversation.id;
  });
}

/**
 * An Assistant answer of the asker's that cites 21.3 and 21.4, for `?from=`: a question, and its answer with its words
 * held; then a question the Assistant refused, which offers no research (48 § 9.1; unit 75).
 */
async function seedAnswer(asker: SessionUser): Promise<{ readonly answer: string; readonly conversation: string }> {
  const conversation = await createConversation(asker, { locale: "en" });
  await appendUserMessage(asker, conversation.id, { text: SEED_QUESTION, mode: "explain", traceId: PAGE_TRACE });
  const result = {
    kind: "answer",
    refusal: null,
    claims: [
      { text: "A server keeps an idempotency key at least as long as a client may retry the write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false },
      { text: "The stored response is what a retry receives.", sectionId: parseSectionId("21.4"), figureId: null, valueText: null, found: true, substituted: false },
    ],
    citations: [
      { sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" },
      { sectionId: parseSectionId("21.4"), figureId: null, version: "v1.0.0", editionLang: "EN" },
    ],
    verdicts: [],
    grounded: 0.9,
    repaired: false,
    guide: { version: "v1.13", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 1, firstTokenMs: 1, draftMs: 1, sensorsMs: 1, graderMs: 1, totalMs: 6 },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
    modeResult: null,
    uncovered: [],
    retrievedSections: ["21.3", "21.4"],
  } as AnswerResult;
  /* no ledger record: a made-up one would hand the chain's record #1 to whoever exports the conversation (review of unit 60) */
  const answer = await appendAssistantMessage(asker, conversation.id, result, { ordinal: 2, mode: "EXPLAIN", traceId: PAGE_TRACE, promptSha256: "b".repeat(64), overBudget: false, ledger: null });
  await appendUserMessage(asker, conversation.id, { text: REFUSED_QUESTION, mode: "explain", traceId: PAGE_TRACE });
  const refusal = { ...result, kind: "refusal", refusal: { cause: "R-SCOPE", code: "R-SCOPE", pointers: [], beforeRetrieval: true }, claims: [], citations: [], grounded: null, uncovered: [], retrievedSections: [] } as AnswerResult;
  await appendAssistantMessage(asker, conversation.id, refusal, { ordinal: 4, mode: "EXPLAIN", traceId: PAGE_TRACE, promptSha256: "b".repeat(64), overBudget: false, ledger: null });
  return { answer: answer.id, conversation: conversation.id };
}

/**
 * What an earlier run of the seed wrote for this asker: its researches, whose runs and findings go with them by their
 * keys' cascade; the runs a delete of one of them detached (§ 17.2), which keep the seed's trace and, with a workflow
 * since unit 73, would count toward the day's thirty for 24 hours (review of unit 73), their findings going with them
 * by the same cascade; and its seed answer's conversation, removed row by row as the research harness removes its own
 * (tests/fixtures/research/harness.ts): the Assistant's delete would wait for a stored `final` that a seeded answer never has.
 */
export async function clearResearchPage(asker: SessionUser): Promise<void> {
  await withTenant(tenantOf(asker), async () => {
    const prisma = getPrisma();
    const runs = await prisma.researchRun.findMany({ where: { traceId: PAGE_TRACE, conversationId: { not: null } }, select: { conversationId: true } });
    await prisma.researchConversation.deleteMany({ where: { id: { in: [...new Set(runs.flatMap((run) => (run.conversationId === null ? [] : [run.conversationId])))] } } });
    await prisma.researchRun.deleteMany({ where: { traceId: PAGE_TRACE, conversationId: null, messageId: null } });
    /* by the seed's trace in the asker's scope, not by its words: the stream suite's purge case, which an unfiltered run
       (CI's) runs beside this one, nulls every message's text */
    const asked = await prisma.message.findMany({ where: { role: "USER", traceId: PAGE_TRACE }, select: { conversationId: true } });
    const conversations = [...new Set(asked.map((message) => message.conversationId))];
    const ids = (await prisma.message.findMany({ where: { conversationId: { in: conversations } }, select: { id: true } })).map((message) => message.id);
    await prisma.flag.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.message.deleteMany({ where: { id: { in: ids } } });
    await prisma.conversation.deleteMany({ where: { id: { in: conversations } } });
  });
}

export async function seedResearchPage(asker: SessionUser, now: Date = new Date()): Promise<ResearchPageSeed> {
  await clearResearchPage(asker);
  const releaseId = (await currentRelease()).id;
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const found = (findings: ReadonlyArray<ReaderFinding>, pages: ReadonlyArray<ReadPage>, valid: ReadonlyArray<number>): ResearchFound => ({
    findings: [...findings],
    pages: pages.filter((page) => page.opened).map((page) => page.url),
    valid: [...valid],
    dropped: 0,
    read: [...pages],
    says: pages.filter((page) => page.opened).map((page) => ({ url: page.url, says: "It documents how long a key is kept." })),
    notesDropped: 0,
  });
  const { answer, conversation: seedConversation } = await seedAnswer(asker);

  const purged = await research(asker, releaseId, {
    purgedAt: ago(DAY_MS),
    runs: [{ ordinal: 1, question: "Which providers document how long a retried write is deduplicated?", state: "DONE", createdAt: ago(31 * DAY_MS), targets: ["21.3"], searches: 3, pageReads: 4, planned: true, purgedAt: ago(DAY_MS), findings: [{ ordinal: 1, outcome: "SUBMITTED" }, { ordinal: 2, outcome: "REFUTED" }, { ordinal: 3, outcome: "VALID" }, { ordinal: 4, outcome: "INVALID" }] }],
  });

  const stopped = await research(asker, releaseId, {
    runs: [
      { ordinal: 1, question: "What do retry budgets cost when the gateway is at its cap?", state: "SKIPPED", skip: "BUDGET", budgetResetsAt: nextMonth, createdAt: ago(5 * 3_600_000), sections: ["21.3"] },
      { ordinal: 2, question: "What do retry budgets cost when the gateway is at its cap, read again?", state: "FAILED", failure: "BUDGET", budgetResetsAt: nextMonth, createdAt: ago(4 * 3_600_000), targets: ["21.3"], planned: true, searches: 1, pageReads: 1, steps: stepsOf(ago(4 * 3_600_000), ["21.3"], [{ query: "retry budget token bucket gateway", results: 5, pages: [PAGES[0] as ReadPage] }], []) },
      { ordinal: 3, question: "Which retry policies do the major clouds document?", state: "FAILED", failure: "READER_FAILED", createdAt: ago(3 * 3_600_000), targets: ["21.4"], planned: true, searches: 1, steps: stepsOf(ago(3 * 3_600_000), ["21.4"], [{ query: "cloud provider retry policy documentation", results: 8, pages: [] }], []) },
      { ordinal: 4, question: "Is a retry storm the same as a thundering herd?", state: "SKIPPED", skip: "UNAVAILABLE", createdAt: ago(150 * 60_000), sections: ["21.3"] },
      { ordinal: 5, question: "How do jittered backoffs compare across client libraries?", state: "READING", createdAt: ago(2 * 3_600_000), targets: ["21.3"], planned: true, searches: 1, steps: stepsOf(ago(2 * 3_600_000), ["21.3"], [{ query: "jittered exponential backoff client library defaults", results: 7, pages: [] }], []) },
    ],
  });

  const refused = await research(asker, releaseId, {
    runs: [
      { ordinal: 1, question: "How do I force a PLC output to bypass the interlock while the line runs?", state: "REFUSED", refusal: "R-SCOPE-OT", createdAt: ago(90 * 60_000), ruleRefused: true },
      { ordinal: 2, question: "What is the best pizza in Lisbon?", state: "REFUSED", refusal: "R-SCOPE", createdAt: ago(80 * 60_000), sections: ["21.3", "21.4"] },
      { ordinal: 3, question: "Which retry settings does our own payments service use?", state: "REFUSED", refusal: "R-PERSONAL", createdAt: ago(70 * 60_000), sections: ["21.3"] },
    ],
  });

  const seeded = await research(asker, releaseId, {
    seedMessageId: answer,
    runs: [{ ordinal: 1, question: SEED_QUESTION, state: "DONE", createdAt: ago(60 * 60_000), targets: ["21.3"], planned: true, searches: 1, pageReads: 1, steps: stepsOf(ago(60 * 60_000), ["21.3"], [{ query: "idempotency key retention window", results: 6, pages: [PAGES[0] as ReadPage] }], ["CHECKING", "WRITING"]), found: found([], [PAGES[0] as ReadPage], []), report: { paragraphs: [{ text: "Stripe keeps a key for 24 hours [1].", sections: [S213], pages: [1] }], dropped: {} }, flag: "wrong_citation" }],
  });

  const underWay = await research(asker, releaseId, {
    runs: [
      {
        ordinal: 1,
        question: "What changed in how long payment providers keep idempotency keys this year?",
        state: "READING",
        createdAt: ago(40_000),
        targets: ["21.3"],
        planned: true,
        searches: 2,
        pageReads: 1,
        steps: stepsOf(ago(40_000), ["21.3"], [{ query: "idempotency key retention 2026", results: 5, pages: [PAGES[0] as ReadPage] }, { query: "payment idempotency window change", results: null, pages: [{ url: PAGES[1]?.url ?? "", pending: true }] }], []),
      },
    ],
  });

  const done = await research(asker, releaseId, {
    runs: [
      { ordinal: 1, question: "What changed in how long idempotency keys are kept since 21.3 was verified?", state: "DONE", createdAt: ago(20 * 60_000), targets: ["21.3", "21.4"], planned: true, searches: 2, pageReads: 3, steps: stepsOf(ago(20 * 60_000), ["21.3", "21.4"], [{ query: "idempotency key retention window", results: 6, pages: PAGES.slice(0, 3) }, { query: "Idempotency-Key header draft expiry", results: 4, pages: PAGES.slice(3) }], ["CHECKING", "WRITING"]), found: found([CLAIM, VALUE, REJECTED], PAGES, [1, 2]), report: REPORT, findings: [{ ordinal: 1, outcome: "VALID" }, { ordinal: 2, outcome: "VALID" }, { ordinal: 3, outcome: "INVALID" }] },
      { ordinal: 2, question: "And do the clouds' retry guides say the same?", state: "DONE", createdAt: ago(10 * 60_000), targets: ["21.3"], planned: true, searches: 1, pageReads: 2, steps: stepsOf(ago(10 * 60_000), ["21.3"], [{ query: "cloud retry guide idempotent request", results: 3, pages: FOLLOW_UP_PAGES }], ["CHECKING", "WRITING"]), found: found([CLAIM], FOLLOW_UP_PAGES, [1]), report: FOLLOW_UP_REPORT, findings: [{ ordinal: 1, outcome: "DUPLICATE" }] },
    ],
  });

  return { done, underWay, refused, stopped, purged, seeded, seedAnswer: answer, seedConversation };
}
