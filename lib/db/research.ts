import { randomUUID } from "node:crypto";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma, type ExtendedClient } from "@/lib/db/client";
import { Prisma } from "@/lib/db/generated/client";
import type { Lang, SourceTier } from "@/lib/db/generated/enums";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { resolveAnchor } from "@/lib/db/anchors";
import { TEXT_RETENTION_DAYS } from "@/lib/db/assistant";
import { runCostOf } from "@/lib/db/budget";
import { callerOf, ownSuggestionStates, readProposalsForAsker, readSuggestion, suggestionVisibleTo, type ImproveClient, type ResearchCreated } from "@/lib/db/improve";
import { researchRecordsAt } from "@/lib/db/ledger";
import { sectionTitleOf } from "@/lib/db/marks";
import { proposalViewOf } from "@/lib/improve/proposalView";
import { stepKeyOf } from "@/lib/ledger/hash";
import { BUDGET_MARK, markOfQuestion, markOfSection, RESEARCH_RUNS_PER_DAY, RESEARCH_SENDS_PER_MONTH, ResearchRefusalSchema, sendsMonthOf, type FindingFailure, type FindingOutcome, type ResearchRefusal, type ResearchSkip, type ResearchState } from "@/lib/schemas/research";
import { ReaderFindingSchema, ReportSchema, ResearchFoundSchema, ResearchStepSchema, ResearchStepsSchema, type ReaderFinding, type Report, type ResearchFound, type ResearchStep } from "@/lib/schemas/researcher";
import { questionSha256Of } from "@/lib/research/question";
import { findingSourcesOf, sourcesNotAmong } from "@/lib/research/submission";
import { findingViewOf, refusalPointerIdsOf, runViewOf } from "@/lib/research/runView";
import { USED_OUTCOMES } from "@/lib/research/stats";
import { chaptersOfSections } from "@/lib/research/summary";
import { researchViewOf, type ResearchMarkRow, type RunForView } from "@/lib/research/view";
import { findingWorkflowId, researchRunWorkflowId } from "@/lib/schemas/workflows";
import type { ProposalView, ResearchFindingView, ResearchRunView, ResearchView } from "@/lib/schemas/api";

/*
 * The research rows (feature-specs/40 § 3; unit 57a): a run and what it found are the asker's own, read and written
 * inside the reader's tenant context as the assistant's rows are — the start endpoint inserts a person's run as them
 * (feature-specs/48 § 5.2), the workflows' activities write as the person whose run it is, by the run's own `userId`.
 * A legacy run of an answered turn was the turn's end's to insert until unit 75 (48 § 9.2); its rows are read as they
 * stand. The marks are the platform's, no user, no text. Nothing here hands a client the brief or the uncovered
 * sentences; what a page may say of a run is spec 43's view, and of a person's run spec 48's.
 */

export interface RunInput {
  readonly messageId: string;
  readonly releaseId: string;
  readonly locale: Lang;
  readonly gap: boolean;
  readonly sectionAnchors: ReadonlyArray<string>;
  readonly questionSha256: string;
  readonly traceId: string;
  /** `QUEUED` with its workflow's id, or `SKIPPED` with the reason (40 § 6.1 step 2). */
  readonly state: "QUEUED" | "SKIPPED";
  readonly skip: ResearchSkip | null;
  readonly workflowId: string | null;
}

/**
 * A legacy run's row, as the turn's end wrote it for the reader until unit 75 took the hand-over out of the turn
 * (feature-specs/48 § 9.2): the product writes none any more. The legacy rows that stand are read as they are (§ 4.3),
 * and the legacy run's suite and the research seed write theirs through it until unit 78 removes the legacy workflow.
 */
export function createResearchRun(user: SessionUser, input: RunInput, now: Date): Promise<{ readonly id: string }> {
  return withTenant({ userId: user.id, organisationId: null }, () =>
    getPrisma().researchRun.create({
      data: {
        messageId: input.messageId,
        userId: user.id,
        organisationId: user.organisationId,
        releaseId: input.releaseId,
        locale: input.locale,
        state: input.state,
        skip: input.skip,
        gap: input.gap,
        sectionAnchors: [...input.sectionAnchors],
        questionSha256: input.questionSha256,
        workflowId: input.workflowId,
        traceId: input.traceId,
        createdAt: now,
        finishedAt: input.state === "SKIPPED" ? now : null,
      },
      select: { id: true },
    }),
  );
}

/**
 * A person's run as the start inserts it (feature-specs/48 § 5.2): the question as the web tier redacted it; what the
 * seed answer gives a research's first run (§ 4.2's table: whether it replaced a claim, and the sections it cited, the
 * plan's to complete with retrieval's); and the cause a rule refused the question with at its start, or none.
 */
export interface ConversationRunInput {
  readonly conversationId: string;
  readonly releaseId: string;
  readonly locale: Lang;
  readonly question: string;
  readonly traceId: string;
  /**
   * The seed's facts, read for any start of a seeded research; null from scratch. The door gives them to the research's
   * seeded run alone (`isSeededRun`), which it decides under the research's lock (review of unit 71).
   */
  readonly seed: { readonly gap: boolean; readonly cited: ReadonlyArray<string> } | null;
  /** `REFUSED` with no workflow where a rule refused the question (§ 5.2): nothing spent, not counted; `QUEUED` otherwise. */
  readonly refusal: Extract<ResearchRefusal, "R-SCOPE-OT" | "R-UNVERIFIED"> | null;
}

export type ConversationRunCreated =
  | { readonly created: true; readonly id: string; readonly ordinal: number; readonly state: "QUEUED"; readonly workflowId: string }
  | { readonly created: true; readonly id: string; readonly ordinal: number; readonly state: "REFUSED"; readonly workflowId: null }
  | { readonly created: false; readonly reason: "NOT_FOUND" }
  | { readonly created: false; readonly reason: "IN_PROGRESS" }
  | { readonly created: false; readonly reason: "DAILY_LIMIT"; readonly resetsAt: Date };

/** The seed's sections a seeded run is inserted with, at most the run's ten (§ 5.3); its plan writes the whole set. */
const SEED_SECTIONS_MAX = 10;

/**
 * The seeded run of a research (feature-specs/48 § 4.2, § 5.3, § 16; review of unit 71): a run of a research seeded from
 * an Assistant answer no earlier run of which planned — had its brief stored, which `briefSha256` says and the purge
 * keeps. Ordinal 1 alone would not do: a first question refused by a rule at its start (`REFUSED · R-SCOPE-OT`,
 * `R-UNVERIFIED`), a start the engine refused (`SKIPPED · UNAVAILABLE`), a stale run the next start ended (`FAILED ·
 * ABANDONED`), and a planner that refused, failed or met the cap all leave no brief, and the question the person asks
 * next is still the one the seed is for. The insert gives the seeded run the seed's `gap` and cited sections
 * (`createConversationRun`), its planner reads the seed (`readRunSeed`), and its view says `seeded`; a run after one
 * that planned is a follow-up. `firstPlanned` is the ordinal of the research's first run with a brief, null where none
 * has one. Every earlier run has ended before a later one is inserted (check 3, read again under the research's lock),
 * and no brief is ever written onto an ended run (`writeResearchState`), so the answer for a run never changes.
 */
export function isSeededRun(seedMessageId: string | null, ordinal: number, firstPlanned: number | null): boolean {
  return seedMessageId !== null && (firstPlanned === null || ordinal <= firstPlanned);
}

/** The ordinal of a research's first run that planned (its brief stored), on the client the caller's context or transaction gives; null where none did. */
async function firstPlannedOrdinalIn(client: Pick<ExtendedClient, "researchRun">, conversationId: string): Promise<number | null> {
  const row = await client.researchRun.findFirst({ where: { conversationId, briefSha256: { not: null } }, orderBy: { ordinal: "asc" }, select: { ordinal: true } });
  return row?.ordinal ?? null;
}

/**
 * The door's insert of a person's run (feature-specs/48 § 5.2; review of unit 70; unit 71), one transaction inside the
 * asker's context: the research's row locked `FOR UPDATE` (lib/db/RAW_SQL.md), the lock its delete takes (§ 17.2), so a
 * start and a delete of the same research never interleave and a start that waited on a delete finds nothing; under it
 * the start's check 3 and check 7 read again — the research's newest run not under way, fewer than thirty counted runs
 * in 24 hours — since a start of the same research, or of another at the thirtieth, may have committed while the
 * endpoint read them; the next ordinal; the run inserted with its question, the question's hash
 * (lib/research/question.ts), the seed's facts where it is the research's seeded run (`isSeededRun`, read under the
 * same lock), and either `QUEUED` with its workflow's id, `research:<runId>`, or `REFUSED` with its cause, ended and
 * with no workflow; and the research's `lastRunAt` moved to now with its `textPurgedAt` cleared. The purge stamps a
 * research once every run of it is purged (§ 17.1), and a follow-up asked after that holds text again: a stamp left
 * standing would say otherwise.
 *
 * A `P2002` on `(conversationId, ordinal)`, which the lock leaves to a start that raced past it, is `IN_PROGRESS`: the
 * other start's run is the research's newest.
 */
export async function createConversationRun(user: SessionUser, input: ConversationRunInput, now: Date): Promise<ConversationRunCreated> {
  try {
    return await withTenant(tenantOf(user), () =>
      getPrisma().$transaction(async (tx): Promise<ConversationRunCreated> => {
        const locked = await tx.$queryRaw<Array<{ id: string; seedMessageId: string | null }>>`SELECT "id", "seedMessageId" FROM "ResearchConversation" WHERE "id" = ${input.conversationId} AND "userId" = ${user.id} FOR UPDATE`;
        const research = locked[0];
        if (research === undefined) return { created: false, reason: "NOT_FOUND" };
        const newest = await tx.researchRun.findFirst({ where: { conversationId: input.conversationId }, orderBy: { ordinal: "desc" }, select: { ordinal: true, state: true } });
        if (newest !== null && !ENDED_STATES.includes(newest.state)) return { created: false, reason: "IN_PROGRESS" };
        const resetsAt = await dailyLimitUntilIn(tx, user.id, now);
        if (resetsAt !== null) return { created: false, reason: "DAILY_LIMIT", resetsAt };
        const ordinal = (newest?.ordinal ?? 0) + 1;
        const seed = isSeededRun(research.seedMessageId, ordinal, await firstPlannedOrdinalIn(tx, input.conversationId)) ? input.seed : null;
        const id = randomUUID();
        const workflowId = input.refusal === null ? researchRunWorkflowId(id) : null;
        await tx.researchRun.create({
          data: {
            id,
            userId: user.id,
            organisationId: user.organisationId,
            conversationId: input.conversationId,
            ordinal,
            releaseId: input.releaseId,
            locale: input.locale,
            state: input.refusal === null ? "QUEUED" : "REFUSED",
            refusal: input.refusal,
            gap: seed?.gap ?? false,
            sectionAnchors: seed === null ? [] : seed.cited.slice(0, SEED_SECTIONS_MAX),
            question: input.question,
            questionSha256: questionSha256Of(input.question),
            workflowId,
            traceId: input.traceId,
            createdAt: now,
            finishedAt: input.refusal === null ? null : now,
          },
          select: { id: true },
        });
        await tx.researchConversation.updateMany({ where: { id: input.conversationId }, data: { lastRunAt: now, textPurgedAt: null } });
        return workflowId === null ? { created: true, id, ordinal, state: "REFUSED", workflowId } : { created: true, id, ordinal, state: "QUEUED", workflowId };
      }),
    );
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { created: false, reason: "IN_PROGRESS" };
    throw error;
  }
}

/**
 * How many runs the reader started in the last 24 hours (A13): every row that had a workflow, whatever the run ended as —
 * a run whose planner found nothing to research ends SKIPPED but made its paid call (review of units 57–58). A turn
 * skipped before any workflow has no `workflowId` and is not counted. Since unit 70 (feature-specs/48 § 2 A8, § 5.2,
 * § 7.2) neither is a run that spent nothing on a model: `SKIPPED · BUDGET`, the planner refused at the person's cap,
 * and `SKIPPED · UNAVAILABLE`, the engine refused the start or the gateway the planner before the provider saw it. A
 * run refused by rule at its start has no workflow and was never counted.
 */
export const UNCOUNTED_SKIPS: ReadonlyArray<ResearchSkip> = ["BUDGET", "UNAVAILABLE"];

/** The rows the day's count takes (A8): the reader's, with a workflow, started since `since`, and not a run that spent nothing. */
function countedRunsWhere(userId: string, since: Date): Prisma.ResearchRunWhereInput {
  return { userId, workflowId: { not: null }, createdAt: { gte: since }, OR: [{ state: { not: "SKIPPED" } }, { skip: { notIn: [...UNCOUNTED_SKIPS] } }] };
}

export function runsStartedSince(user: SessionUser, since: Date): Promise<number> {
  return withTenant({ userId: user.id, organisationId: null }, () => getPrisma().researchRun.count({ where: countedRunsWhere(user.id, since) }));
}

const DAY_MS = 86_400_000;

/** The instant the day's window has room again, read on a client the caller's context or transaction gives; null below the thirty. */
async function dailyLimitUntilIn(client: Pick<ExtendedClient, "researchRun">, userId: string, now: Date): Promise<Date | null> {
  /* the thirtieth newest counted run: while it is inside the window the thirty stand, and the window frees when it leaves */
  const thirtieth = await client.researchRun.findFirst({ where: countedRunsWhere(userId, new Date(now.getTime() - DAY_MS)), orderBy: { createdAt: "desc" }, skip: RESEARCH_RUNS_PER_DAY - 1, select: { createdAt: true } });
  return thirtieth === null ? null : new Date(thirtieth.createdAt.getTime() + DAY_MS);
}

/**
 * The start's check 7 (feature-specs/48 § 5.2, A8): null while the reader has started fewer than thirty counted runs
 * in the 24 hours before `now`; else the instant the oldest of the thirty leaves the window, which the 429 names.
 */
export function dailyLimitUntil(user: SessionUser, now: Date): Promise<Date | null> {
  return withTenant(tenantOf(user), () => dailyLimitUntilIn(getPrisma(), user.id, now));
}

/* ------------------------------------------------------------------ a person's research, as the API opens and starts it (feature-specs/48 § 5.2, § 13; unit 71) */

/** A research conversation's row, as its endpoints read it: the asker's own, no text. */
export interface ResearchConversationRow {
  readonly id: string;
  readonly locale: Lang;
  readonly seedMessageId: string | null;
  readonly createdAt: Date;
  readonly textPurgedAt: Date | null;
}

const CONVERSATION_ROW = { id: true, locale: true, seedMessageId: true, createdAt: true, textPurgedAt: true } as const;

/**
 * An Assistant answer as a research's seed (48 A6, § 4.2, § 13), read inside the asker's context, so another person's
 * reads as none: whether it is answered and its words are held — an `ASSISTANT` row with no refusal and its text — what a
 * new research may start from; whether it replaced a claim, the first run's `gap`; and the sections it cited, in its
 * citations' order. Null where the asker has no such answer.
 */
export interface SeedFacts {
  readonly answered: boolean;
  readonly gap: boolean;
  readonly cited: ReadonlyArray<string>;
}

export async function readSeedFacts(user: SessionUser, messageId: string): Promise<SeedFacts | null> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const answer = await prisma.message.findFirst({ where: { id: messageId, role: "ASSISTANT" }, select: { text: true, refusalCause: true, substituted: true } });
    if (answer === null) return null;
    const citations = await prisma.citation.findMany({ where: { messageId }, orderBy: { ordinal: "asc" }, select: { sectionId: true } });
    return { answered: answer.refusalCause === null && answer.text !== null, gap: answer.substituted > 0, cited: [...new Set(citations.map((citation) => citation.sectionId))] };
  });
}

/** A research opened (48 § 13): the asker's, under their organisation, with its language and the answer it was seeded from, which the caller has found theirs and answered. */
export function createResearchConversation(user: SessionUser, input: { readonly locale: Lang; readonly seedMessageId: string | null }, now: Date): Promise<ResearchConversationRow> {
  return withTenant(tenantOf(user), () =>
    getPrisma().researchConversation.create({ data: { userId: user.id, organisationId: user.organisationId, locale: input.locale, seedMessageId: input.seedMessageId, createdAt: now, lastRunAt: now }, select: CONVERSATION_ROW }),
  );
}

/** A research by id inside the asker's context; null where it is not theirs or is gone. */
export function readResearchConversation(user: SessionUser, id: string): Promise<ResearchConversationRow | null> {
  return withTenant(tenantOf(user), () => getPrisma().researchConversation.findUnique({ where: { id }, select: CONVERSATION_ROW }));
}

/* ------------------------------------------------------------------ the Research page's reads (feature-specs/48 § 11; unit 72) */

/** A research as the page's list shows it (48 § 11.4): no word of the person's, so it survives the purge. */
export interface ResearchConversationSummary {
  readonly id: string;
  /** The chapters of its runs' sections (the planners' targets), in order of first appearance. */
  readonly chapters: ReadonlyArray<number>;
  readonly lastRunAt: Date;
  readonly runs: number;
  /** Its findings that passed the checks (every outcome but `INVALID`), as a run's line counts them. */
  readonly findings: number;
  /** Of those, the ones drafted or sent to Improve, whatever became of them since. */
  readonly used: number;
  readonly seeded: boolean;
  readonly textPurged: boolean;
}

/**
 * The asker's researches, newest run first (48 § 11.4), inside their context: each labelled by its runs' sections and
 * counted — its runs, refused ones among them, its findings that passed the checks, and of those the ones drafted or
 * sent. Never a question or a report.
 */
export async function listResearchConversations(user: SessionUser, options: { readonly limit: number }): Promise<ReadonlyArray<ResearchConversationSummary>> {
  return withTenant(tenantOf(user), async () => {
    const rows = await getPrisma().researchConversation.findMany({
      orderBy: { lastRunAt: "desc" },
      take: options.limit,
      select: { id: true, lastRunAt: true, seedMessageId: true, textPurgedAt: true, runs: { orderBy: { ordinal: "asc" }, select: { targetAnchors: true, findings: { where: { outcome: { not: "INVALID" } }, select: { outcome: true } } } } },
    });
    return rows.map((row) => ({
      id: row.id,
      chapters: [...new Set(row.runs.flatMap((run) => run.targetAnchors.map((anchor) => Number(anchor.slice(0, 2)))).filter((chapter) => Number.isInteger(chapter)))],
      lastRunAt: row.lastRunAt,
      runs: row.runs.length,
      findings: row.runs.reduce((sum, run) => sum + run.findings.length, 0),
      used: row.runs.reduce((sum, run) => sum + run.findings.filter((finding) => USED_OUTCOMES.has(finding.outcome)).length, 0),
      seeded: row.seedMessageId !== null,
      textPurged: row.textPurgedAt !== null,
    }));
  });
}

/** How many researches the asker has, and when the oldest run whose words are held was started (48 § 11.6's `keptUntil`). */
export async function researchConversationCounts(user: SessionUser): Promise<{ readonly conversations: number; readonly oldestTextAt: Date | null }> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const conversations = await prisma.researchConversation.count();
    const oldest = await prisma.researchRun.findFirst({ where: { conversationId: { not: null }, textPurgedAt: null }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    return { conversations, oldestTextAt: oldest?.createdAt ?? null };
  });
}

/**
 * An Assistant answer as the Research page's seed card shows it (48 § 11.3, A6), inside the asker's context, so another
 * person's reads as none: the conversation it is in, when it was answered, the sections it cited in their order, and
 * the question it answered — the turn's `USER` row, which the composer is prefilled with — or null once its words are
 * gone. `answered` is `readSeedFacts`' own rule: an `ASSISTANT` row with no refusal whose text is held, what a new research
 * may start from. Null where the asker has no such message, or it was deleted.
 */
export interface SeedView {
  readonly conversationId: string;
  readonly answeredAt: Date;
  readonly cited: ReadonlyArray<string>;
  readonly answered: boolean;
  readonly question: string | null;
}

export async function readSeedView(user: SessionUser, messageId: string): Promise<SeedView | null> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const answer = await prisma.message.findFirst({ where: { id: messageId, role: "ASSISTANT" }, select: { conversationId: true, ordinal: true, createdAt: true, text: true, refusalCause: true } });
    if (answer === null) return null;
    const citations = await prisma.citation.findMany({ where: { messageId }, orderBy: { ordinal: "asc" }, select: { sectionId: true } });
    const asked = await prisma.message.findFirst({ where: { conversationId: answer.conversationId, role: "USER", ordinal: { lt: answer.ordinal } }, orderBy: { ordinal: "desc" }, select: { text: true } });
    return {
      conversationId: answer.conversationId,
      answeredAt: answer.createdAt,
      cited: [...new Set(citations.map((citation) => citation.sectionId))],
      answered: answer.refusalCause === null && answer.text !== null,
      question: asked?.text ?? null,
    };
  });
}

/** The research's newest run, as the start's check 3 reads it (48 § 5.2): only the newest can be under way. */
export interface NewestRun {
  readonly id: string;
  readonly userId: string;
  readonly state: ResearchState;
  readonly workflowId: string | null;
  /** The instant of the start that inserted it: a `QUEUED` row younger than a start's request may be one in flight. */
  readonly createdAt: Date;
}

export function newestConversationRun(user: SessionUser, conversationId: string): Promise<NewestRun | null> {
  return withTenant(tenantOf(user), () => getPrisma().researchRun.findFirst({ where: { conversationId }, orderBy: { ordinal: "desc" }, select: { id: true, userId: true, state: true, workflowId: true, createdAt: true } }));
}

/**
 * The start's check 3 ending a run nothing moves any more (48 § 5.2; review of unit 71): `FAILED · ABANDONED`, on the
 * condition that the row still holds the state the start read. A row that moved since — its workflow took it, its own
 * start took it back, another start ended it — is left as it stands, and the write says it changed nothing, which the
 * start answers 409. An ended state is never the condition: an ended run is not moved again.
 */
export async function abandonConversationRun(run: Pick<NewestRun, "id" | "userId" | "state">, now: Date): Promise<{ readonly written: boolean }> {
  if (ENDED_STATES.includes(run.state)) return { written: false };
  const result = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.updateMany({ where: { id: run.id, state: run.state }, data: { state: "FAILED", failure: "ABANDONED", finishedAt: now } }));
  return { written: result.count === 1 };
}

/**
 * The start's checks 4 and 5 (48 § 5.2), in one system read: whether a deletion request stands for the account (spec
 * 46 § 3.2: nothing new is started while it does), and the organisation's research switch (D2); an organisation of
 * none is on.
 */
export async function researchStartGates(user: SessionUser): Promise<{ readonly deletionRequested: boolean; readonly organisation: boolean }> {
  return withSystem(async () => {
    const row = await getPrisma().user.findUnique({ where: { id: user.id }, select: { deletionRequestedAt: true, organisation: { select: { researchEnabled: true } } } });
    return { deletionRequested: row !== null && row.deletionRequestedAt !== null, organisation: row?.organisation?.researchEnabled ?? true };
  });
}

/**
 * The start's check 6 (48 § 7.2): the gateway's reset the asker's latest research run met, remembered on its row — the
 * person's runs alone, which carry an ordinal (a detached one keeps it), since a legacy run of an answered turn was the
 * platform's to pay and never carries a reset (since unit 75 none is made); and of those the runs with a
 * workflow, since a run a rule refused at its start never reached the gateway and says nothing of the budget. The
 * endpoint answers 402 while it is ahead.
 */
export async function latestBudgetReset(user: SessionUser): Promise<Date | null> {
  const row = await withTenant(tenantOf(user), () => getPrisma().researchRun.findFirst({ where: { ordinal: { not: null }, workflowId: { not: null } }, orderBy: { createdAt: "desc" }, select: { budgetResetsAt: true } }));
  return row?.budgetResetsAt ?? null;
}

/*
 * The reader's own switch, `User.researchEnabled`, is read and written by nothing since unit 75 (feature-specs/48 § 4.3,
 * § 9.4): research starts only when a person presses Start, so there is nothing for it to switch off. The column is
 * dropped in a later release, once no code reads it (code-standards § Data). The organisation's switch stays (D2).
 */

/** An organisation's switch, set by the operator's command (40 D5), read by the start's check 5 (48 § 5.2, D2). */
export async function setOrganisationResearch(organisationId: string, on: boolean): Promise<{ readonly found: boolean }> {
  const updated = await getPrisma().organisation.updateMany({ where: { id: organisationId }, data: { researchEnabled: on } });
  return { found: updated.count === 1 };
}

/** The research organisation's name (40 § 7.1; 43 § 3.3): the platform's one principal for research, created by the operator's command with this name; found by `Organisation.researchPrincipal`, never by it (48 § 7.3). */
export const RESEARCH_ORGANISATION_NAME = "Research";

/**
 * The platform's research organisation (40 § 7.1, A14; 43 § 3.3): one row, no seats, no IDE minutes, the token cap that
 * is the month's research budget at the frontier input price (lib/gateway/prices.ts `tokensOfUsd`), which the gateway
 * key minted for it takes as its `max_budget`. Created once; a second call finds the first and creates nothing.
 *
 * It is found and marked by `Organisation.researchPrincipal` (48 § 7.3; review of unit 70), never by its name, which
 * any organisation could be given: the research views read the platform's payer from the same column. A partial unique
 * index keeps the principal to one, so a second command racing the first fails its insert and finds the first's row.
 */
export async function ensureResearchOrganisation(input: { readonly tokenCap: bigint; readonly tokensPerMinute: number }): Promise<{ readonly id: string; readonly created: boolean }> {
  const prisma = getPrisma();
  const principal = () => prisma.organisation.findFirst({ where: { researchPrincipal: true }, select: { id: true } });
  const found = await principal();
  if (found !== null) return { id: found.id, created: false };
  try {
    const row = await prisma.organisation.create({ data: { name: RESEARCH_ORGANISATION_NAME, seatLimit: 0, tokenCap: input.tokenCap, ideMinutesCap: 0, tokensPerMinute: input.tokensPerMinute, researchPrincipal: true }, select: { id: true } });
    return { id: row.id, created: true };
  } catch (error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    const raced = await principal();
    if (raced === null) throw error;
    return { id: raced.id, created: false };
  }
}

/* ------------------------------------------------------------------ the marks (40 § 3, § 7.2) */

/*
 * Since unit 75 no run sets a section's or a question's mark (feature-specs/48 § 4.3): the hand-over that wrote them, and
 * took them back, is gone with the eligibility that read them, and research on request is not deduplicated across people
 * (§ 5.1). The marks that stand still give a legacy line its days ("researched 12 days ago"), read with its run below.
 */

/** The budget mark (40 § 7.2): the legacy run met the platform's cap and waits for the reset, which its line names. */
export async function writeBudgetMark(at: Date, until: Date): Promise<void> {
  await getPrisma().researchMark.upsert({ where: { key: BUDGET_MARK }, create: { key: BUDGET_MARK, at, until }, update: { at, until } });
}

/* ------------------------------------------------------------------ the line under the answer (43 § 4.3) */

const RUN_FOR_VIEW = { messageId: true, state: true, skip: true, sectionAnchors: true, questionSha256: true, findings: { where: { outcome: "PROPOSED" as const, suggestionId: { not: null } }, orderBy: { ordinal: "asc" as const }, select: { suggestionId: true } } } as const;
type RunForViewRow = { readonly messageId: string | null; readonly state: ResearchState; readonly skip: ResearchSkip | null; readonly sectionAnchors: string[]; readonly questionSha256: string; readonly findings: ReadonlyArray<{ readonly suggestionId: string | null }> };

/** The marks every run of the list reads, in one query: the budget's, each question's, each cited section's. */
async function marksForRuns(runs: ReadonlyArray<Pick<RunForView, "sectionAnchors" | "questionSha256">>): Promise<ReadonlyArray<ResearchMarkRow>> {
  if (runs.length === 0) return [];
  const keys = new Set<string>([BUDGET_MARK]);
  for (const run of runs) {
    keys.add(markOfQuestion(run.questionSha256));
    for (const anchor of run.sectionAnchors) keys.add(markOfSection(anchor));
  }
  return getPrisma().researchMark.findMany({ where: { key: { in: [...keys] } }, select: { key: true, at: true, until: true } });
}

/** The ids of a run's proposals, in its findings' order. */
function proposalIdsOf(row: Pick<RunForViewRow, "findings">): ReadonlyArray<string> {
  return row.findings.flatMap((finding) => (finding.suggestionId === null ? [] : [finding.suggestionId]));
}

/**
 * The proposals as the asker is shown them (43 § 5.3; unit 60b): the suggestions their findings name, through the door's
 * read for the asker, each with its section's title in the suggestion's edition and the asker's own name on it, read
 * in their context. By id, in the proposals' own order, newest submitted first (45 § 3.6); one that is not a
 * researcher's is absent.
 */
async function proposalViewsOf(user: SessionUser, ids: ReadonlyArray<string>): Promise<ReadonlyMap<string, ProposalView>> {
  if (ids.length === 0) return new Map();
  const rows = [...(await readProposalsForAsker(callerOf(user), ids))].sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0) || b.id.localeCompare(a.id));
  const endorsements = await withTenant(tenantOf(user), () => getPrisma().proposalEndorsement.findMany({ where: { suggestionId: { in: [...ids] } }, select: { suggestionId: true, createdAt: true } }));
  const endorsedAt = new Map(endorsements.map((row) => [row.suggestionId, row.createdAt]));
  const views = new Map<string, ProposalView>();
  for (const row of rows) {
    const section = row.anchor?.sectionAnchor ?? null;
    const title = section === null ? null : await sectionTitleOf(section, row.locale === "PT" ? "pt" : "en");
    views.set(row.id, proposalViewOf({ row, title, endorsedAt: endorsedAt.get(row.id) ?? null }));
  }
  return views;
}

function viewOfRow(row: RunForViewRow, marks: ReadonlyArray<ResearchMarkRow>, proposals: ReadonlyMap<string, ProposalView>, now: Date): ResearchView {
  return researchViewOf(row, marks, proposalIdsOf(row).flatMap((id) => { const view = proposals.get(id); return view === undefined ? [] : [view]; }), now);
}

/**
 * Every proposal of the reader's, newest submitted first (43 § 6; unit 60c): the suggestions their `PROPOSED` findings
 * name, of any run — one whose conversation's text was purged, or whose conversation was deleted, included, since the
 * finding holds no text and outlives its run (40 § 8.3; 45 § 3.6) — as the panel shows them. Ordered by the proposal's
 * own time, since a finding the sweep kept has no run to order by. Nothing of the run or the question comes with them.
 */
export async function readProposalsOfAsker(user: SessionUser): Promise<ReadonlyArray<ProposalView>> {
  const findings = await withTenant(tenantOf(user), () => getPrisma().researchFinding.findMany({ where: { outcome: "PROPOSED", suggestionId: { not: null } }, select: { suggestionId: true } }));
  const ids = [...new Set(findings.flatMap((finding) => (finding.suggestionId === null ? [] : [finding.suggestionId])))];
  return [...(await proposalViewsOf(user, ids)).values()];
}

/** The research view of one message (43 § 4.3), inside the asker's context; null where the message has no run or is not theirs. */
export async function readResearchView(user: SessionUser, messageId: string, now: Date = new Date()): Promise<ResearchView | null> {
  const row = await withTenant(tenantOf(user), () => getPrisma().researchRun.findUnique({ where: { messageId }, select: RUN_FOR_VIEW }));
  if (row === null) return null;
  return viewOfRow(row, await marksForRuns([row]), await proposalViewsOf(user, proposalIdsOf(row)), now);
}

/**
 * The research views of a conversation's assistant messages, by message id (43 § 4.3), for the conversation's read:
 * the runs inside the asker's context, the marks in one query, a message without a run absent from the map.
 */
export async function readResearchViews(user: SessionUser, messageIds: ReadonlyArray<string>, now: Date = new Date()): Promise<ReadonlyMap<string, ResearchView>> {
  if (messageIds.length === 0) return new Map();
  const rows = await withTenant(tenantOf(user), () => getPrisma().researchRun.findMany({ where: { messageId: { in: [...messageIds] } }, select: RUN_FOR_VIEW }));
  const marks = await marksForRuns(rows);
  const proposals = await proposalViewsOf(user, rows.flatMap(proposalIdsOf));
  /* read by message, so every row has one */
  return new Map(rows.flatMap((row) => (row.messageId === null ? [] : [[row.messageId, viewOfRow(row, marks, proposals, now)] as const])));
}

/* ------------------------------------------------------------------ the asker's name on a proposal (42 § 6; unit 59d) */

/**
 * Whether a proposal came from one of this reader's runs: a finding of theirs names the suggestion and is `PROPOSED` —
 * the one direction that link is followed (40 § 3; 43 D7), and only for what the reader is shown: a finding still
 * deciding, or refuted, is no proposal of theirs (42 § 5; unit 59's review). The endpoint sets the policy's `ownerId` from it.
 */
export async function askerOfProposal(user: SessionUser, suggestionId: string): Promise<boolean> {
  return (await withTenant(tenantOf(user), () => getPrisma().researchFinding.count({ where: { suggestionId, outcome: "PROPOSED" } }))) > 0;
}

export interface EndorsementRow {
  readonly createdAt: Date;
}

/** The reader's own endorsement of a proposal, inside their context; null where they have put no name to it. */
export async function readEndorsement(user: SessionUser, suggestionId: string): Promise<EndorsementRow | null> {
  return withTenant(tenantOf(user), () => getPrisma().proposalEndorsement.findUnique({ where: { suggestionId }, select: { createdAt: true } }));
}

/**
 * The reader's name on a proposal, at most one a proposal (42 § 6): the row as it stands when one is there already, so
 * a second press is the first's; `written` false where the proposal carries another reader's name, which the policy
 * does not let happen and the key refuses all the same.
 */
export async function writeEndorsement(user: SessionUser, suggestionId: string, now: Date): Promise<{ readonly written: true; readonly createdAt: Date; readonly existed: boolean } | { readonly written: false }> {
  return withTenant(tenantOf(user), async () => {
    const standing = await getPrisma().proposalEndorsement.findUnique({ where: { suggestionId }, select: { createdAt: true } });
    if (standing !== null) return { written: true, createdAt: standing.createdAt, existed: true };
    try {
      const created = await getPrisma().proposalEndorsement.create({ data: { suggestionId, userId: user.id, createdAt: now }, select: { createdAt: true } });
      return { written: true, createdAt: created.createdAt, existed: false };
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      /* the reader's own second request made it a moment ago (a double press): answered as it stands; another reader's row stays out of sight here, and is refused */
      const made = await getPrisma().proposalEndorsement.findUnique({ where: { suggestionId }, select: { createdAt: true } });
      return made === null ? { written: false } : { written: true, createdAt: made.createdAt, existed: true };
    }
  });
}

/** The name taken back (42 D4): the row of that instant gone, and no other, so an undo takes back no row another request made; whether there was one. */
export async function removeEndorsement(user: SessionUser, suggestionId: string, createdAt: Date): Promise<boolean> {
  return (await withTenant(tenantOf(user), () => getPrisma().proposalEndorsement.deleteMany({ where: { suggestionId, createdAt } }))).count > 0;
}

/**
 * The reader's name on a proposal as the suggestion's workflow reads it before recording (42 § 6; unit 59's review):
 * inside their own context, by the id the signal names, as a curator's action is read again before its record.
 */
export async function endorsementOf(userId: string, suggestionId: string): Promise<EndorsementRow | null> {
  return withTenant({ userId, organisationId: null }, () => getPrisma().proposalEndorsement.findUnique({ where: { suggestionId }, select: { createdAt: true } }));
}

/* ------------------------------------------------------------------ the workflow's reads and writes */

export interface ResearchRunRow {
  readonly id: string;
  /** Null once the reader deleted the conversation while the run worked: detached, its text gone (45 § 3.5). */
  readonly messageId: string | null;
  readonly userId: string;
  readonly organisationId: string | null;
  readonly releaseId: string;
  readonly locale: Lang;
  readonly state: ResearchState;
  readonly skip: ResearchSkip | null;
  /** A code, never text (40 § 3). */
  readonly failure: string | null;
  readonly gap: boolean;
  readonly sectionAnchors: ReadonlyArray<string>;
  readonly questionSha256: string;
  readonly briefSha256: string | null;
  readonly searches: number;
  readonly pageReads: number;
  readonly workflowId: string | null;
  readonly traceId: string;
  readonly textPurgedAt: Date | null;
  /** When the turn handed it over: the run's line measures its whole time from here (feature-specs/44 § 4). */
  readonly createdAt: Date;
}

/** A run by id, for its workflow, inside the asker's own tenant context — the workflow is told whose run it is, by id, and reads nothing but that reader's. */
export async function readResearchRun(runId: string, userId: string): Promise<ResearchRunRow | null> {
  return withTenant({ userId, organisationId: null }, () => getPrisma().researchRun.findUnique({ where: { id: runId }, select: { id: true, messageId: true, userId: true, organisationId: true, releaseId: true, locale: true, state: true, skip: true, failure: true, gap: true, sectionAnchors: true, questionSha256: true, briefSha256: true, searches: true, pageReads: true, workflowId: true, traceId: true, textPurgedAt: true, createdAt: true } }));
}

/**
 * What the planner reads of the turn (40 § 6.2 step 1), inside the reader's own tenant context: the question, the
 * answer, the uncovered sentences. Null text where the purge took it; null, with no query, for a run detached from its
 * message, since a filter on a null id is not "no text" (45 § 3.5).
 */
export async function readResearchTurn(run: Pick<ResearchRunRow, "userId" | "messageId">): Promise<{ readonly question: string | null; readonly answer: string | null; readonly uncovered: ReadonlyArray<{ readonly sectionId: string | null; readonly text: string }>; readonly retrievedSections: ReadonlyArray<string> } | null> {
  const { messageId } = run;
  if (messageId === null) return null;
  return withTenant({ userId: run.userId, organisationId: null }, async () => {
    const prisma = getPrisma();
    const answer = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, ordinal: true, text: true, uncovered: true, retrievedSections: true } });
    if (answer === null) return null;
    const question = await prisma.message.findFirst({ where: { conversationId: answer.conversationId, role: "USER", ordinal: { lt: answer.ordinal } }, orderBy: { ordinal: "desc" }, select: { text: true } });
    const uncovered = Array.isArray(answer.uncovered) ? (answer.uncovered as Array<{ sectionId?: string | null; text?: string }>).flatMap((entry) => (typeof entry.text === "string" ? [{ sectionId: entry.sectionId ?? null, text: entry.text }] : [])) : [];
    return { question: question?.text ?? null, answer: answer.text, uncovered, retrievedSections: answer.retrievedSections };
  });
}

/** The answer's citations (41 § 5.1 slot 3), inside the asker's context: which section and figure each claim cited, with the claim's sentence where the purge has not taken it; none, with no query, for a run detached from its message (45 § 3.5). */
export async function readResearchCitations(run: Pick<ResearchRunRow, "userId" | "messageId">): Promise<ReadonlyArray<{ readonly sectionId: string; readonly figureId: string | null; readonly claimText: string | null }>> {
  const { messageId } = run;
  if (messageId === null) return [];
  return withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().citation.findMany({ where: { messageId }, orderBy: { ordinal: "asc" }, select: { sectionId: true, figureId: true, claimText: true } }));
}

/** The brief the planner wrote, inside the asker's context; null where there is none yet or the purge took it. */
export async function readResearchBrief(run: Pick<ResearchRunRow, "id" | "userId">): Promise<string | null> {
  const row = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.findUnique({ where: { id: run.id }, select: { brief: true } }));
  return row?.brief ?? null;
}

/** What the reader found (41 § 6.2, § 7), left on the run for the validation and the submission, inside the asker's context; never onto a run whose text was purged — the write says whether it took. The counts are `writeResearchCounts`'s, written first (45 § 3.5). */
export async function writeResearchFound(run: Pick<ResearchRunRow, "id" | "userId">, found: ResearchFound): Promise<{ readonly written: boolean }> {
  const result = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.updateMany({ where: { id: run.id, textPurgedAt: null }, data: { found: found as unknown as Prisma.InputJsonValue } }));
  return { written: result.count === 1 };
}

/** The run's findings as their rows stand (40 § 3), in order, inside the asker's context: what the RESEARCH record lists. */
export function readFindings(run: Pick<ResearchRunRow, "id" | "userId">): Promise<ReadonlyArray<{ readonly ordinal: number; readonly outcome: FindingOutcome; readonly invalidReason: string | null; readonly suggestionId: string | null }>> {
  return withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchFinding.findMany({ where: { runId: run.id }, orderBy: { ordinal: "asc" }, select: { ordinal: true, outcome: true, invalidReason: true, suggestionId: true } }));
}

/** What the reader found, read back inside the asker's context; null where there is nothing yet, the purge took it, or the column holds another shape. */
export async function readResearchFound(run: Pick<ResearchRunRow, "id" | "userId">): Promise<ResearchFound | null> {
  const row = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.findUnique({ where: { id: run.id }, select: { found: true } }));
  if (row === null || row.found === null) return null;
  const parsed = ResearchFoundSchema.safeParse(row.found);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ a person's run (feature-specs/48 § 5, § 6; unit 70a) */

/*
 * The door of a person's research run, for its workflow's activities (ResearchRunWorkflow; 48 § 5.1). Every read and
 * write is inside the asker's own tenant context, by the ids the workflow was given (invariant 35), and every write of
 * text — the question redacted again, the brief, what the reader found, the steps, the report — is guarded by
 * `"textPurgedAt" IS NULL`, as the brief always was: a run its conversation's delete detached (§ 17.2), or the purge
 * reached (§ 17.1), takes no text again, and the step that needed it ends the run `SKIPPED · TEXT_PURGED`.
 */

/** A run as its activities name it: its id and its asker's. */
export type RunRef = Pick<ResearchRunRow, "id" | "userId">;

/** A person's run as its workflow reads it: the legacy row's columns and the conversation's, no text. */
export interface ConversationRunRow {
  readonly id: string;
  readonly userId: string;
  readonly organisationId: string | null;
  /** Null once its conversation's delete detached it (48 § 17.2), or for a legacy run, which no activity here is given. */
  readonly conversationId: string | null;
  readonly ordinal: number | null;
  readonly releaseId: string;
  readonly locale: Lang;
  readonly state: ResearchState;
  readonly skip: ResearchSkip | null;
  readonly failure: string | null;
  readonly refusal: ResearchRefusal | null;
  /** The seed answer replaced a claim (48 § 4.2), as the start found it. */
  readonly gap: boolean;
  readonly sectionAnchors: ReadonlyArray<string>;
  readonly targetAnchors: ReadonlyArray<string>;
  readonly questionSha256: string;
  readonly briefSha256: string | null;
  readonly searches: number;
  readonly pageReads: number;
  readonly workflowId: string | null;
  readonly traceId: string;
  readonly textPurgedAt: Date | null;
  /** When the writer was first called: the run's `hb-frontier` ledger rows from here are the writer's (48 § 15). */
  readonly writingAt: Date | null;
  readonly budgetResetsAt: Date | null;
  readonly createdAt: Date;
}

const CONVERSATION_RUN = {
  id: true,
  userId: true,
  organisationId: true,
  conversationId: true,
  ordinal: true,
  releaseId: true,
  locale: true,
  state: true,
  skip: true,
  failure: true,
  refusal: true,
  gap: true,
  sectionAnchors: true,
  targetAnchors: true,
  questionSha256: true,
  briefSha256: true,
  searches: true,
  pageReads: true,
  workflowId: true,
  traceId: true,
  textPurgedAt: true,
  writingAt: true,
  budgetResetsAt: true,
  createdAt: true,
} as const;

/** A person's run by id, inside the asker's own tenant context; null where there is none of theirs. A cause the column holds that is not one of the enum's reads as none. */
export async function readConversationRun(runId: string, userId: string): Promise<ConversationRunRow | null> {
  const row = await withTenant({ userId, organisationId: null }, () => getPrisma().researchRun.findUnique({ where: { id: runId }, select: CONVERSATION_RUN }));
  if (row === null) return null;
  const refusal = ResearchRefusalSchema.safeParse(row.refusal);
  return { ...row, refusal: refusal.success ? refusal.data : null };
}

/** The question as stored, inside the asker's context; null once purged, or detached by a delete. */
export async function readRunQuestion(run: RunRef): Promise<string | null> {
  const row = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.findUnique({ where: { id: run.id }, select: { question: true } }));
  return row?.question ?? null;
}

/**
 * The question redacted again in the workers, with its hash, where the workers' secrets changed it (48 § 5.1, § 5.2):
 * the web tier's redaction does not know the gateway's master key, which only the workers hold. Never onto a run whose
 * text was purged; the write says whether it took.
 */
export async function writeRunQuestion(run: RunRef, question: string, questionSha256: string): Promise<{ readonly written: boolean }> {
  const result = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.updateMany({ where: { id: run.id, textPurgedAt: null }, data: { question, questionSha256 } }));
  return { written: result.count === 1 };
}

/** What a seeded run reads of the answer it began from (48 § 5.3): the answer's claims as its citations recorded them, its uncovered sentences, and the sections it cited, in its citations' order. */
export interface RunSeed {
  readonly claims: ReadonlyArray<{ readonly text: string | null; readonly sectionId: string; readonly figureId: string | null }>;
  readonly uncovered: ReadonlyArray<{ readonly sectionId: string | null; readonly text: string }>;
  readonly cited: ReadonlyArray<string>;
}

/**
 * The seed of a person's run (48 § 5.3, A6), read and never copied, inside the asker's context: null where the run is
 * not its research's seeded run (`isSeededRun`: a seeded research, and no earlier run of it planned); `gone` where the
 * seed answer is no longer the asker's (the Assistant's delete took it, 45 § 3.3), which ends the run `SKIPPED ·
 * TEXT_PURGED` (§ 18). A seed whose words the purge took is still read: its claims without their sentences, its
 * sections as they were.
 */
export async function readRunSeed(run: Pick<ConversationRunRow, "userId" | "conversationId" | "ordinal">): Promise<RunSeed | "gone" | null> {
  const { conversationId, ordinal } = run;
  if (conversationId === null || ordinal === null) return null;
  return withTenant({ userId: run.userId, organisationId: null }, async () => {
    const prisma = getPrisma();
    const conversation = await prisma.researchConversation.findUnique({ where: { id: conversationId }, select: { seedMessageId: true } });
    const seedMessageId = conversation?.seedMessageId ?? null;
    if (seedMessageId === null || !isSeededRun(seedMessageId, ordinal, await firstPlannedOrdinalIn(prisma, conversationId))) return null;
    const answer = await prisma.message.findFirst({ where: { id: seedMessageId, role: "ASSISTANT" }, select: { uncovered: true } });
    if (answer === null) return "gone";
    const citations = await prisma.citation.findMany({ where: { messageId: seedMessageId }, orderBy: { ordinal: "asc" }, select: { sectionId: true, figureId: true, claimText: true } });
    const uncovered = Array.isArray(answer.uncovered) ? (answer.uncovered as Array<{ sectionId?: string | null; text?: string }>).flatMap((entry) => (typeof entry.text === "string" ? [{ sectionId: entry.sectionId ?? null, text: entry.text }] : [])) : [];
    return { claims: citations.map((citation) => ({ text: citation.claimText, sectionId: citation.sectionId, figureId: citation.figureId })), uncovered, cited: [...new Set(citations.map((citation) => citation.sectionId))] };
  });
}

/** An earlier run of the conversation, as a follow-up's planner and writer read it (48 § 5.3 slot 5, § 5.6 slot 4): its words where the purge has not taken them, and its targets. */
export interface EarlierRun {
  readonly ordinal: number;
  readonly question: string | null;
  readonly brief: string | null;
  readonly report: Report | null;
  readonly targetAnchors: ReadonlyArray<string>;
}

/** The conversation's runs before this one, oldest first, inside the asker's context; none for a first run or a detached one. */
export async function readEarlierRuns(run: Pick<ConversationRunRow, "userId" | "conversationId" | "ordinal">): Promise<ReadonlyArray<EarlierRun>> {
  const { conversationId, ordinal } = run;
  if (conversationId === null || ordinal === null || ordinal <= 1) return [];
  const rows = await withTenant({ userId: run.userId, organisationId: null }, () =>
    getPrisma().researchRun.findMany({ where: { conversationId, ordinal: { lt: ordinal } }, orderBy: { ordinal: "asc" }, select: { ordinal: true, question: true, brief: true, report: true, targetAnchors: true } }),
  );
  return rows.map((row) => {
    const report = row.report === null ? null : ReportSchema.safeParse(row.report);
    return { ordinal: row.ordinal ?? 0, question: row.question, brief: row.brief, report: report?.success === true ? report.data : null, targetAnchors: row.targetAnchors };
  });
}

/** The report a run stored, read back inside the asker's context; null where there is none, the purge took it, or the column holds another shape. */
export async function readRunReport(run: RunRef): Promise<Report | null> {
  const row = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.findUnique({ where: { id: run.id }, select: { report: true } }));
  if (row === null || row.report === null) return null;
  const parsed = ReportSchema.safeParse(row.report);
  return parsed.success ? parsed.data : null;
}

/** The report the sensor passed (48 § 5.7), never onto a run whose text was purged; the write says whether it took. */
export async function writeRunReport(run: RunRef, report: Report): Promise<{ readonly written: boolean }> {
  const result = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.updateMany({ where: { id: run.id, textPurgedAt: null }, data: { report: report as unknown as Prisma.InputJsonValue } }));
  return { written: result.count === 1 };
}

/**
 * When the writer was first called (48 § 15): written once, before the call, so a second call after the rate limit's
 * wait (§ 5.6) keeps the first instant and its refused row counts as the writer's too. The run's `hb-frontier` ledger
 * rows from it are the writer's, those before it the reader's; both are stamped by this process's clock.
 */
export async function writeWritingAt(run: RunRef, at: Date): Promise<void> {
  await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.updateMany({ where: { id: run.id, writingAt: null }, data: { writingAt: at } }));
}

/** The gateway's reset where a call of the run met the person's cap (48 § 7.2): the start endpoint answers 402 while it is ahead. Not text, so written whatever the purge did. */
export async function writeBudgetResetsAt(run: RunRef, resetsAt: Date): Promise<void> {
  await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.updateMany({ where: { id: run.id }, data: { budgetResetsAt: resetsAt } }));
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A live step as it is appended (48 § 6): its `seq` is the place the statement gives it. */
export type NewResearchStep = DistributiveOmit<ResearchStep, "seq">;

/** What completes a step: a search's count of results; a page's address opened and its title, or `opened: false`. */
export type ResearchStepPatch = { readonly results: number } | { readonly url: string; readonly title: string | null; readonly opened: true } | { readonly opened: false };

/**
 * A live step appended to the run (48 § 6), in one statement — the client cannot say it, and a read-modify-write of the
 * array would lose a step to a race (lib/db/RAW_SQL.md). The step's `seq` is its place in the array, taken in the same
 * statement, so a step that failed to write leaves no gap a later completion could land in. `once` appends only where
 * the run has no step of that kind yet, so a retried activity writes its step once. Never onto a run whose text was
 * purged. The asker's id is a condition beside the tenant context: a raw statement passes no guard. Returns the step's
 * `seq`, or null where nothing was written.
 */
export async function appendRunStep(run: RunRef, step: NewResearchStep, options: { readonly once?: boolean } = {}): Promise<number | null> {
  /* the step is held to its schema before it is stored: an address or a query of another shape is a defect here, not a row */
  const body = ResearchStepSchema.parse({ ...step, seq: 0 });
  const { seq: _seq, ...fields } = body;
  void _seq;
  const json = JSON.stringify(fields);
  const once = options.once === true ? Prisma.sql`AND NOT (coalesce("steps", '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('kind', ${step.kind}::text)))` : Prisma.empty;
  const rows = await withTenant({ userId: run.userId, organisationId: null }, () =>
    getPrisma().$queryRaw<Array<{ seq: number }>>`
      UPDATE "ResearchRun"
      SET "steps" = coalesce("steps", '[]'::jsonb) || jsonb_build_array(${json}::jsonb || jsonb_build_object('seq', jsonb_array_length(coalesce("steps", '[]'::jsonb))))
      WHERE "id" = ${run.id} AND "userId" = ${run.userId} AND "textPurgedAt" IS NULL ${once}
      RETURNING jsonb_array_length("steps") - 1 AS seq`,
  );
  return rows[0]?.seq ?? null;
}

/**
 * A step completed in place (48 § 6): one `jsonb_set` on the step at its index, merged with what its result says, and
 * only where the step there is the one appended under that `seq`. Never onto a run whose text was purged; whether it
 * took. Raw, and registered, for the reasons the append is.
 */
export async function completeRunStep(run: RunRef, seq: number, patch: ResearchStepPatch): Promise<boolean> {
  const json = JSON.stringify("results" in patch ? { results: patch.results } : patch.opened ? { url: patch.url, title: patch.title, opened: true } : { opened: false });
  const count = await withTenant({ userId: run.userId, organisationId: null }, () =>
    getPrisma().$executeRaw`
      UPDATE "ResearchRun"
      SET "steps" = jsonb_set("steps", ARRAY[${String(seq)}::text], ("steps" -> ${seq}::int) || ${json}::jsonb, false)
      WHERE "id" = ${run.id} AND "userId" = ${run.userId} AND "textPurgedAt" IS NULL AND ("steps" -> ${seq}::int ->> 'seq') = ${String(seq)}`,
  );
  return count === 1;
}

/** The run's steps as stored, inside the asker's context; none where there are none yet, the purge took them, or the column holds another shape. */
export async function readRunSteps(run: RunRef): Promise<ReadonlyArray<ResearchStep>> {
  const row = await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.findUnique({ where: { id: run.id }, select: { steps: true } }));
  if (row === null || row.steps === null) return [];
  const parsed = ResearchStepsSchema.safeParse(row.steps);
  return parsed.success ? parsed.data : [];
}

/* ------------------------------------------------------------------ the book's side (41 § 5.1, § 6.1) */

export interface ResearchSectionFigure {
  readonly id: string;
  readonly label: string;
  readonly valueText: string;
  readonly unit: string | null;
  readonly tier: SourceTier;
  readonly fastMoving: boolean;
  /** The verification date of the row the figure cites; null for a figure with no row. */
  readonly verifiedOn: Date | null;
  readonly sourceRow: string | null;
}

export interface ResearchSourceRow {
  readonly id: string;
  readonly claim: string;
  readonly citation: string;
  readonly url: string | null;
  readonly tier: SourceTier;
  readonly verifiedOn: Date;
  readonly fastMoving: boolean;
}

/** A section as the researcher's two calls are shown it: the source edition's text, its figures with their tiers and dates, and the source rows those figures cite. */
export interface ResearchSection {
  readonly id: string;
  readonly chapter: number;
  readonly version: string;
  readonly title: string;
  readonly text: string;
  readonly verifiedOn: Date | null;
  readonly figures: ReadonlyArray<ResearchSectionFigure>;
  readonly rows: ReadonlyArray<ResearchSourceRow>;
}

/**
 * The sections an answer cited, at the run's pinned release (41 § 5.1 slot 2, § 6.1 slot 4), in the order asked;
 * an anchor the release does not have is left out. Content rows are the release's and nobody's, so this reads them
 * as the content loaders do, outside any tenant; the text is the source edition's (EN), as a proposal changes it.
 */
export async function readResearchSections(releaseId: string, anchors: ReadonlyArray<string>): Promise<ReadonlyArray<ResearchSection>> {
  if (anchors.length === 0) return [];
  const sections = await getPrisma().section.findMany({
    where: { anchor: { in: [...anchors] }, chapterVersion: { releaseId } },
    select: {
      anchor: true,
      titleEn: true,
      markdownEn: true,
      chapterVersion: { select: { chapterNumber: true, version: true, verifiedAt: true } },
      figures: { orderBy: { ordinal: "asc" }, select: { anchor: true, label: true, valueText: true, unit: true, tier: true, fastMoving: true, sourceRow: { select: { anchor: true, claim: true, citation: true, url: true, tier: true, verifiedAt: true, fastMoving: true } } } },
    },
  });
  const byAnchor = new Map(sections.map((section) => [section.anchor, section]));
  return anchors.flatMap((anchor) => {
    const section = byAnchor.get(anchor);
    if (section === undefined) return [];
    const rows = new Map<string, ResearchSourceRow>();
    for (const figure of section.figures) {
      const row = figure.sourceRow;
      if (row !== null && !rows.has(row.anchor)) rows.set(row.anchor, { id: row.anchor, claim: row.claim, citation: row.citation, url: row.url, tier: row.tier, verifiedOn: row.verifiedAt, fastMoving: row.fastMoving });
    }
    return [
      {
        id: section.anchor,
        chapter: section.chapterVersion.chapterNumber,
        version: section.chapterVersion.version,
        title: section.titleEn,
        text: section.markdownEn,
        verifiedOn: section.chapterVersion.verifiedAt,
        figures: section.figures.map((figure) => ({ id: figure.anchor, label: figure.label, valueText: figure.valueText, unit: figure.unit, tier: figure.tier, fastMoving: figure.fastMoving, verifiedOn: figure.sourceRow?.verifiedAt ?? null, sourceRow: figure.sourceRow?.anchor ?? null })),
        rows: [...rows.values()],
      },
    ];
  });
}

/**
 * The states a run ends in. `REFUSED` since unit 70 (feature-specs/48 § 5.2 check 3): a person's run refused by rule at
 * its start or by its planner is over, and a reader of this list that held it as running would keep the conversation's
 * composer busy for ever and the start endpoint answering 409.
 */
export const ENDED_STATES: ReadonlyArray<ResearchState> = ["DONE", "SKIPPED", "FAILED", "REFUSED"];

/**
 * The run's state as its workflow moves it, inside the asker's context; `finishedAt` on an end. A run that has ended —
 * by its workflow, or by the purge, which ends a waiting run SKIPPED · TEXT_PURGED (40 § 8.3) — is not moved again, and
 * text (the brief) is never written onto a run whose text was purged: the write says whether it took (review of units
 * 57–58), and the step that needed it to fails `TEXT_PURGED`.
 */
export interface ResearchStateExtra {
  readonly skip?: ResearchSkip | null;
  readonly failure?: string | null;
  readonly brief?: string | null;
  readonly briefSha256?: string | null;
  readonly searches?: number;
  readonly pageReads?: number;
  /** A person's run (feature-specs/48 § 5.3): the planner's refusal's cause, written with the `REFUSED` end. */
  readonly refusal?: ResearchRefusal | null;
  /** A person's run (48 § 5.3): the sections the planner was given and its targets, written with the brief. */
  readonly sectionAnchors?: ReadonlyArray<string>;
  readonly targetAnchors?: ReadonlyArray<string>;
}

export async function writeResearchState(run: Pick<ResearchRunRow, "id" | "userId">, state: ResearchState, extra: ResearchStateExtra = {}, now: Date = new Date()): Promise<{ readonly written: boolean }> {
  const ended = ENDED_STATES.includes(state);
  const writesText = typeof extra.brief === "string";
  const { sectionAnchors, targetAnchors, ...columns } = extra;
  const anchors = { ...(sectionAnchors === undefined ? {} : { sectionAnchors: [...sectionAnchors] }), ...(targetAnchors === undefined ? {} : { targetAnchors: [...targetAnchors] }) };
  const result = await withTenant({ userId: run.userId, organisationId: null }, () =>
    getPrisma().researchRun.updateMany({ where: { id: run.id, state: { notIn: [...ENDED_STATES] }, ...(writesText ? { textPurgedAt: null } : {}) }, data: { state, ...columns, ...anchors, ...(ended ? { finishedAt: now } : {}) } }),
  );
  return { written: result.count === 1 };
}

/** The run's counts of searches and page reads (40 § 3, 41 § 3), written whatever the reader's turn ended as, its text purged or its conversation deleted included, since the provider charged them. */
export async function writeResearchCounts(run: Pick<ResearchRunRow, "id" | "userId">, counts: { readonly searches: number; readonly pageReads: number }): Promise<void> {
  await withTenant({ userId: run.userId, organisationId: null }, () => getPrisma().researchRun.updateMany({ where: { id: run.id }, data: { searches: counts.searches, pageReads: counts.pageReads } }));
}

/** A finding of the run, in the asker's own rows (40 § 3). */
export async function writeFinding(run: Pick<ResearchRunRow, "id" | "userId">, finding: { readonly ordinal: number; readonly outcome: FindingOutcome; readonly invalidReason: string | null; readonly suggestionId: string | null }): Promise<void> {
  await withTenant({ userId: run.userId, organisationId: null }, () =>
    getPrisma().researchFinding.upsert({
      where: { runId_ordinal: { runId: run.id, ordinal: finding.ordinal } },
      create: { runId: run.id, userId: run.userId, ordinal: finding.ordinal, outcome: finding.outcome, invalidReason: finding.invalidReason, suggestionId: finding.suggestionId },
      update: { outcome: finding.outcome, invalidReason: finding.invalidReason, suggestionId: finding.suggestionId },
    }),
  );
}

/**
 * A valid finding's suggestion made and the finding's row naming it, in one transaction (42 § 4.1; unit 59's review):
 * the door's create through `make`, then the row in the asker's context — `SUBMITTED` with the new id, or `DUPLICATE`
 * with the one it doubles. A step that dies between the two leaves neither, and its retry reads what an earlier attempt
 * wrote rather than taking a suggestion of its own for a duplicate.
 */
export async function submitFinding(run: Pick<ResearchRunRow, "id" | "userId">, ordinal: number, make: (client: ImproveClient) => Promise<ResearchCreated>): Promise<ResearchCreated> {
  return withTenant({ userId: run.userId, organisationId: null }, () =>
    getPrisma().$transaction(async (tx) => {
      const created = await make(tx);
      const row = created.created ? { outcome: "SUBMITTED" as const, suggestionId: created.id } : { outcome: "DUPLICATE" as const, suggestionId: created.duplicateOf };
      await tx.researchFinding.upsert({
        where: { runId_ordinal: { runId: run.id, ordinal } },
        create: { runId: run.id, userId: run.userId, ordinal, outcome: row.outcome, invalidReason: null, suggestionId: row.suggestionId },
        update: { outcome: row.outcome, invalidReason: null, suggestionId: row.suggestionId },
      });
      return created;
    }),
  );
}

/* ------------------------------------------------------------------ a finding turned into an improvement (feature-specs/48 § 8; unit 74) */

/*
 * A finding that passed the checks is the asker's to use once (A12): drafted in Improve by a verified contributor, or
 * sent as a researcher's proposal by anyone else, never both and never twice. Its row is the asker's own, so every read
 * and write here is inside their tenant context — the endpoints' as the signed-in person, the send's workflow by the
 * ids it was given (invariant 35) — and another person's finding is absent: a 404, never a 403. The improvement rows are
 * reached through the door (lib/db/improve.ts) alone, in the asker's own transaction where a finding names what it made,
 * and the link runs one way, from the asker's finding to the suggestion (40 § 3).
 */

/** A finding as its workflow names it: its id and its asker's. */
export interface FindingRef {
  readonly findingId: string;
  readonly userId: string;
}

/** What the reader wrote of a finding, where it is still held: parsed; `purged` where its run's text is gone (a delete, the 30 days) or it has no run; `unparsed` across a schema change. */
export type FindingText = { readonly kind: "held"; readonly finding: ReaderFinding } | { readonly kind: "purged" } | { readonly kind: "unparsed" };

/** A finding as its endpoints and its send read it: its row, its run's language, and what the reader wrote of it. */
export interface FindingForUse {
  readonly id: string;
  readonly runId: string | null;
  readonly outcome: FindingOutcome;
  readonly suggestionId: string | null;
  /** A code an earlier send left (§ 8.4), never text. */
  readonly failure: string | null;
  /** The run's language, the edition its anchor was read in; null with no run. */
  readonly locale: Lang | null;
  readonly text: FindingText;
}

const FINDING_FOR_USE = { id: true, runId: true, ordinal: true, outcome: true, suggestionId: true, failure: true, run: { select: { locale: true, textPurgedAt: true, found: true, conversationId: true } } } as const;

type FindingForUseRow = Prisma.ResearchFindingGetPayload<{ select: typeof FINDING_FOR_USE }>;

/** The finding's text out of its run's `found`, by the reader's ordinal. */
function findingTextOf(row: FindingForUseRow): FindingText {
  const { run } = row;
  if (run === null || run.textPurgedAt !== null || run.found === null) return { kind: "purged" };
  const found = ResearchFoundSchema.safeParse(run.found);
  if (!found.success) return { kind: "unparsed" };
  const finding = ReaderFindingSchema.safeParse(found.data.findings[row.ordinal - 1] ?? null);
  return finding.success ? { kind: "held", finding: finding.data } : { kind: "unparsed" };
}

async function findingForUseIn(userId: string, findingId: string): Promise<FindingForUse | null> {
  const row = await withTenant({ userId, organisationId: null }, () => getPrisma().researchFinding.findUnique({ where: { id: findingId }, select: FINDING_FOR_USE }));
  if (row === null) return null;
  return { id: row.id, runId: row.runId, outcome: row.outcome, suggestionId: row.suggestionId, failure: row.failure, locale: row.run?.locale ?? null, text: findingTextOf(row) };
}

/** A finding of the caller's, for the draft's and the send's endpoints (48 § 8.2 step 3, § 8.3 step 2); null where it is another's or none. */
export function readFindingForUse(user: SessionUser, findingId: string): Promise<FindingForUse | null> {
  return findingForUseIn(user.id, findingId);
}

/** The same, for the send's workflow, by the ids it was given (48 § 8.4). */
export function readFindingToSend(ref: FindingRef): Promise<FindingForUse | null> {
  return findingForUseIn(ref.userId, ref.findingId);
}

/**
 * How many of the caller's findings became a suggestion in a calendar month in UTC (48 § 8.3 step 5, D5): the month's
 * row in `ResearchSendMonth`, none being none. The endpoint's fast check before a workflow starts; the send's
 * transaction takes its place atomically (`sendFindingTx`), which is what holds under a burst of presses. Never counted
 * from the findings, which the person's own deletes and the sweep remove (review of unit 74).
 */
export async function sendsInMonth(user: SessionUser, month: string): Promise<number> {
  const row = await withTenant(tenantOf(user), () => getPrisma().researchSendMonth.findFirst({ where: { month }, select: { count: true } }));
  return row?.count ?? 0;
}

/** A failure an earlier send left, cleared before a new start (48 § 8.3 step 6), and only while the finding is unused, so a new failure written after it is never erased. */
export async function clearFindingFailure(user: SessionUser, findingId: string): Promise<void> {
  await withTenant(tenantOf(user), () => getPrisma().researchFinding.updateMany({ where: { id: findingId, outcome: "VALID", failure: { not: null } }, data: { failure: null } }));
}

export type FindingClaimed = { readonly claimed: true; readonly suggestionId: string; readonly items: ReadonlyArray<string> } | { readonly claimed: false };

/**
 * A contributor's draft from their finding, in one transaction inside their context (48 § 8.2 step 7), as
 * `submitFinding` runs `createFromResearch`: the finding moved from `VALID` to `DRAFTED`, a conditional update, so two
 * presses cannot both pass — the second waits on the first's row and then finds it moved; the door's
 * `createDraftFromFinding` through `make`; the finding naming the draft. A finding no longer `VALID` makes nothing; the
 * endpoint reads it again and says what it is now in the view's words (`findingUseOf`; review of unit 74).
 */
export async function claimFindingForDraft(user: SessionUser, findingId: string, make: (client: ImproveClient) => Promise<{ readonly id: string; readonly items: ReadonlyArray<string> }>): Promise<FindingClaimed> {
  return withTenant(tenantOf(user), () =>
    getPrisma().$transaction(async (tx) => {
      const moved = await tx.researchFinding.updateMany({ where: { id: findingId, outcome: "VALID" }, data: { outcome: "DRAFTED", failure: null } });
      if (moved.count !== 1) return { claimed: false } as const;
      const created = await make(tx);
      await tx.researchFinding.update({ where: { id: findingId }, data: { suggestionId: created.id } });
      return { claimed: true, suggestionId: created.id, items: created.items } as const;
    }),
  );
}

/** What the edit page's `from your research` shows of a draft made from a finding (48 § 8.2). */
export interface DraftNote {
  /** The researcher's note, never the person's rationale. */
  readonly note: string;
  /** The run's language, which the note is written in. */
  readonly contentLang: "en" | "pt";
  /** Where the run is, for the link back to it. */
  readonly research: { readonly conversationId: string; readonly runId: string };
  /** The finding's `https` sources, each once. */
  readonly sources: ReadonlyArray<{ readonly url: string; readonly host: string }>;
  /** Those the draft's evidence does not hold, read again from its items. */
  readonly notAdded: ReadonlyArray<{ readonly url: string; readonly host: string }>;
}

/**
 * The caller's own `DRAFTED` finding that names the draft, inside their context — never through the improvement door,
 * which reaches no research run (rules § 5) — with the researcher's note, the language it is written in, where its run
 * is, and its sources, those the draft's evidence does not hold beside them: read each time from the draft's own items
 * (`sourcesNotAmong`), so a grading whose start failed and an item the contributor removed are listed alike, after a
 * reload too. Null where no finding of theirs names it, its run's text is gone, or the suggestion is no draft of theirs:
 * the instrument shows while the suggestion is a draft and the run's text lasts.
 */
export async function noteOfDraft(user: SessionUser, suggestionId: string): Promise<DraftNote | null> {
  const row = await withTenant(tenantOf(user), () => getPrisma().researchFinding.findFirst({ where: { suggestionId, outcome: "DRAFTED" }, select: FINDING_FOR_USE }));
  if (row === null || row.runId === null || row.run === null || row.run.conversationId === null) return null;
  const text = findingTextOf(row);
  if (text.kind !== "held") return null;
  const draft = await readSuggestion(callerOf(user), suggestionId);
  if (draft === null || draft.state !== "DRAFT" || draft.userId !== user.id) return null;
  const sources = findingSourcesOf(text.finding);
  return { note: text.finding.note, contentLang: row.run.locale === "PT" ? "pt" : "en", research: { conversationId: row.run.conversationId, runId: row.runId }, sources, notAdded: sourcesNotAmong(sources, draft.evidence) };
}

/**
 * Whether the person may be told the id of the suggestion their finding doubles (48 § 8.5): their own or merged, as the
 * door says (`suggestionVisibleTo`), or a researcher's proposal they are the asker of — their `PROPOSED` finding names
 * it (`askerOfProposal`). Anything else is not public, and the person reads `already proposed in Improve`.
 */
export async function duplicateVisibleTo(user: SessionUser, suggestionId: string): Promise<boolean> {
  return (await suggestionVisibleTo(callerOf(user), suggestionId)) || (await askerOfProposal(user, suggestionId));
}

/** Why a send made no suggestion, on the finding, which stays `VALID` (48 § 8.4): written only while it is unused. */
export async function writeFindingFailure(ref: FindingRef, failure: FindingFailure): Promise<void> {
  await withTenant({ userId: ref.userId, organisationId: null }, () => getPrisma().researchFinding.updateMany({ where: { id: ref.findingId, outcome: "VALID" }, data: { failure } }));
}

export type FindingSent = { readonly sent: "submitted"; readonly suggestionId: string } | { readonly sent: "duplicate"; readonly suggestionId: string } | { readonly sent: "moved" } | { readonly sent: "limited" };

/** Thrown inside the send's transaction when the month's thirty are taken, so that everything it made is rolled back. */
class SendsLimitReached extends Error {
  constructor() {
    super("the month's sends are taken");
    this.name = "SendsLimitReached";
  }
}

/**
 * A finding sent (48 § 8.4), one transaction inside the asker's context, as `submitFinding` is for a legacy run but keyed
 * by the finding's id: the finding moved from `VALID` to `SUBMITTED` with its `sentAt`, a conditional update; the door's
 * `createFromResearch` through `make`; a place taken in the month's thirty (D5); and the row naming the new suggestion —
 * or, where the same proposal is already made, `DUPLICATE` with the one it doubles and no `sentAt`, since it made nothing
 * (§ 4.2) and so takes no place. Nothing is claimed before: a step that dies between the two leaves neither. A finding
 * no longer `VALID` is `moved`, and the step reads it again.
 *
 * The place (review of unit 74) is taken in the person's row of `ResearchSendMonth` for the month `at` falls in, in UTC,
 * by one statement that inserts it at one or adds one only while it is under thirty and answers the count it wrote
 * (lib/db/RAW_SQL.md): the check and the increment are one, and a second send of the person's waits on the row's lock
 * until the first commits, then reads its count. No row answered means the thirty are taken: the transaction is rolled
 * back — the suggestion, its serial and the finding's move with it — and the send is `limited`; the step writes
 * `SENDS_LIMIT` on the finding, which stays `VALID`. So a burst of presses at twenty-nine makes exactly one more
 * suggestion, whatever the endpoint's earlier read said, and no delete of a finding gives a place back.
 */
export async function sendFindingTx(ref: FindingRef, at: Date, make: (client: ImproveClient) => Promise<ResearchCreated>): Promise<FindingSent> {
  const { month } = sendsMonthOf(at);
  return withTenant({ userId: ref.userId, organisationId: null }, async () => {
    try {
      return await getPrisma().$transaction(async (tx) => {
        const moved = await tx.researchFinding.updateMany({ where: { id: ref.findingId, outcome: "VALID" }, data: { outcome: "SUBMITTED", sentAt: at, failure: null } });
        if (moved.count !== 1) return { sent: "moved" } as const;
        const created = await make(tx);
        if (!created.created) {
          await tx.researchFinding.update({ where: { id: ref.findingId }, data: { outcome: "DUPLICATE", sentAt: null, suggestionId: created.duplicateOf } });
          return { sent: "duplicate", suggestionId: created.duplicateOf } as const;
        }
        const placed = await tx.$queryRaw<Array<{ count: number }>>`
          INSERT INTO "ResearchSendMonth" ("userId", "month", "count") VALUES (${ref.userId}, ${month}, 1)
          ON CONFLICT ("userId", "month") DO UPDATE SET "count" = "ResearchSendMonth"."count" + 1
          WHERE "ResearchSendMonth"."count" < ${RESEARCH_SENDS_PER_MONTH}
          RETURNING "count"
        `;
        if (placed.length === 0) throw new SendsLimitReached();
        await tx.researchFinding.update({ where: { id: ref.findingId }, data: { suggestionId: created.id } });
        return { sent: "submitted", suggestionId: created.id } as const;
      });
    } catch (error: unknown) {
      if (error instanceof SendsLimitReached) return { sent: "limited" } as const;
      throw error;
    }
  });
}

/**
 * A sent finding's outcome (48 § 8.4 step 3), written only while it is `SUBMITTED`: `PROPOSED` stays the asker's, under
 * Improve's proposals from their questions; a `REFUTED` one whose run a delete detached (`runId` null) is deleted in the
 * same step, since it is no proposal of the asker's to keep (spec 45 § 3.6 keeps the proposed ones). What happened.
 */
export async function writeFindingOutcome(ref: FindingRef, outcome: "PROPOSED" | "REFUTED"): Promise<"written" | "deleted" | "unchanged"> {
  return withTenant({ userId: ref.userId, organisationId: null }, async () => {
    const prisma = getPrisma();
    if (outcome === "REFUTED") {
      const gone = await prisma.researchFinding.deleteMany({ where: { id: ref.findingId, outcome: "SUBMITTED", runId: null } });
      if (gone.count === 1) return "deleted";
    }
    const written = await prisma.researchFinding.updateMany({ where: { id: ref.findingId, outcome: "SUBMITTED" }, data: { outcome } });
    return written.count === 1 ? "written" : "unchanged";
  });
}

/* ------------------------------------------------------------------ retention (40 § 8.3) */

/**
 * The nightly purge's half for research: the brief and the findings of every run of a message whose text goes, and the
 * message's uncovered sentences, emptied and stamped; a run still waiting when its text is purged ends SKIPPED ·
 * TEXT_PURGED. Hashes, counts, states and anchors stay.
 */
export async function purgeResearchText(messageIds: ReadonlyArray<string>, now: Date): Promise<{ readonly runs: number; readonly ended: number }> {
  if (messageIds.length === 0) return { runs: 0, ended: 0 };
  /* called inside the owner's tenant context by the purge, which walks reader by reader (lib/db/assistant.ts) */
  const prisma = getPrisma();
  await prisma.message.updateMany({ where: { id: { in: [...messageIds] } }, data: { uncovered: Prisma.DbNull } });
  const ended = await prisma.researchRun.updateMany({ where: { messageId: { in: [...messageIds] }, state: { in: ["QUEUED", "PLANNING", "READING", "VALIDATING", "SUBMITTING", "WAITING_BUDGET"] } }, data: { state: "SKIPPED", skip: "TEXT_PURGED", finishedAt: now } });
  const runs = await prisma.researchRun.updateMany({ where: { messageId: { in: [...messageIds] }, textPurgedAt: null }, data: { brief: null, found: Prisma.DbNull, textPurgedAt: now } });
  return { runs: runs.count, ended: ended.count };
}

/**
 * The nightly purge's half for a person's research (feature-specs/48 § 17.1; unit 70a), after `purgeAssistantText` and
 * with the same `reader` option: on each run of a research conversation whose own `createdAt` is older than the
 * Assistant's retention window (`TEXT_RETENTION_DAYS`, 30 days; A9), the question, the brief, what the reader found,
 * the steps and the report are emptied and the run stamped. A run's own age, not its conversation's: a follow-up asked yesterday in a research opened 31 days ago keeps
 * its text, its report and its unused findings. The states, the counts, the anchors, the hashes, the flag, the findings'
 * outcomes and the conversation's own row stay; the conversation is stamped once every run of it is purged, and a stamp
 * that no longer holds — a research with a run whose text is not purged — is cleared, as the start clears it when a
 * follow-up is asked (`createConversationRun`; review of unit 70). A run is never moved: nothing of a person's run
 * waits 30 days. The legacy runs' text is `purgeResearchText`'s, by message.
 *
 * Its owners come from a statement of its own (lib/db/RAW_SQL.md): the readers with a research run's text past the
 * window, or a research conversation past it not yet stamped. Every read and write after it runs inside that reader's
 * context.
 */
export async function purgeResearchRuns(options: { readonly now: Date; readonly retentionDays?: number; readonly reader?: string }): Promise<{ readonly readers: number; readonly runs: number; readonly conversations: number }> {
  const cutoff = new Date(options.now.getTime() - (options.retentionDays ?? TEXT_RETENTION_DAYS) * 86_400_000);
  const prisma = getPrisma();
  const owners = await prisma.$queryRaw<Array<{ userId: string }>>`
    SELECT DISTINCT "userId" FROM "ResearchRun" WHERE "conversationId" IS NOT NULL AND "textPurgedAt" IS NULL AND "createdAt" < ${cutoff}
    UNION
    SELECT DISTINCT "userId" FROM "ResearchConversation" WHERE "textPurgedAt" IS NULL AND "createdAt" < ${cutoff}
  `;
  const counts = { readers: 0, runs: 0, conversations: 0 };
  for (const owner of options.reader === undefined ? owners : owners.filter((candidate) => candidate.userId === options.reader)) {
    counts.readers += 1;
    await withTenant({ userId: owner.userId, organisationId: null }, async () => {
      const runs = await prisma.researchRun.updateMany({
        where: { conversationId: { not: null }, textPurgedAt: null, createdAt: { lt: cutoff } },
        data: { question: null, brief: null, found: Prisma.DbNull, steps: Prisma.DbNull, report: Prisma.DbNull, textPurgedAt: options.now },
      });
      /* a research with runs, none of whose text is left; one with no run at all held no text and is left as it is */
      const conversations = await prisma.researchConversation.updateMany({ where: { textPurgedAt: null, runs: { some: {}, none: { textPurgedAt: null } } }, data: { textPurgedAt: options.now } });
      /* a stamp gone stale: a run of it holds text again, a follow-up asked after the research was stamped */
      await prisma.researchConversation.updateMany({ where: { textPurgedAt: { not: null }, runs: { some: { textPurgedAt: null } } }, data: { textPurgedAt: null } });
      counts.runs += runs.count;
      counts.conversations += conversations.count;
    });
  }
  return counts;
}

/** How long a detached run's row is kept at least: the cap counts the runs started in the last 24 hours, and the row is that tally (feature-specs/45 D9). */
export const DETACHED_RUN_KEPT_MS = 86_400_000;

export interface SweepCounts {
  /** Readers with a detached run past the window, or a detached finding the sweep reads. */
  readonly readers: number;
  /** Detached runs deleted. */
  readonly deleted: number;
  /** Detached runs past the window kept, since their workflows still run. */
  readonly running: number;
  /** Proposals kept as the asker's, detached from the runs deleted. */
  readonly proposalsKept: number;
  /** Sent findings kept, detached or left detached, since their `finding:<id>` workflow still runs and may yet make them a proposal (48 § 17.2). */
  readonly findingsKept: number;
  /** Detached findings deleted that were no proposal of the asker's: refuted, duplicates, and sent ones whose workflow ended (48 § 17.2). */
  readonly findingsDeleted: number;
  /** False where the engine could not be reached: the step stopped there for the night, and its counts are what it did before. */
  readonly engineAnswered: boolean;
}

/** Detached findings that are no proposal of the asker's (48 § 17.2): taken by the sweep's second pass, a sent one only once its workflow ended. */
const UNOWED_OUTCOMES: ReadonlyArray<FindingOutcome> = ["REFUTED", "DUPLICATE", "SUBMITTED"];

/**
 * The nightly sweep of detached runs (feature-specs/45 § 3.5; unit 62f), after the purge. A run is detached when it
 * belongs neither to a message nor to a research conversation (feature-specs/48 § 17.2; unit 70a): a conversation's
 * delete took the one it belonged to. Read on `"messageId"` alone, as it was built, every person's run would match, and
 * the sweep would delete a person's live research once its workflow ended and 24 hours passed. A detached run is
 * deleted once both hold: it started more than 24 hours ago, so the cap's window no longer counts it (D9); and its
 * workflow does not run. That is asked of the engine through `running` and never read off the row, which can say a run
 * ended while its workflow still runs; `null` there means the engine could not be reached, and the step stops for the
 * night. A run with no workflow is not running.
 *
 * Before a run goes, its findings that may still be or become the asker's proposal are detached and kept: the
 * `PROPOSED` ones that name a suggestion (§ 3.6), and since unit 70 the `SUBMITTED` ones whose `finding:<id>` workflow
 * the engine says is running, which may wait up to 40 days for the outcome (48 § 8.4). Its other findings go with it by
 * the key's cascade. A second pass then ends what was kept: the detached findings that are no proposal of the asker's —
 * `REFUTED` and `DUPLICATE` ones, and `SUBMITTED` ones whose workflow no longer runs — are deleted, so a research the
 * person deleted keeps no link from them to a suggestion but a proposal's, which spec 45 keeps on purpose.
 *
 * Its readers come from a statement of its own (lib/db/RAW_SQL.md): the purge's names only readers who still have
 * messages or an unpurged conversation, and a reader who deleted their last conversation has neither. Every read and
 * write after it runs inside that reader's context. `reader` keeps it to one reader's rows, as the purge's option does.
 */
export async function sweepDetachedRuns(options: { readonly now: Date; readonly running: (workflowId: string) => Promise<boolean | null>; readonly reader?: string }): Promise<SweepCounts> {
  const cutoff = new Date(options.now.getTime() - DETACHED_RUN_KEPT_MS);
  const prisma = getPrisma();
  const owners = await prisma.$queryRaw<Array<{ userId: string }>>`
    SELECT DISTINCT "userId" FROM "ResearchRun" WHERE "messageId" IS NULL AND "conversationId" IS NULL AND "createdAt" < ${cutoff}
    UNION
    SELECT DISTINCT "userId" FROM "ResearchFinding" WHERE "runId" IS NULL AND "outcome"::text IN ('REFUTED', 'DUPLICATE', 'SUBMITTED')
  `;
  const counts = { readers: 0, deleted: 0, running: 0, proposalsKept: 0, findingsKept: 0, findingsDeleted: 0 };
  const stopped = (): SweepCounts => ({ ...counts, engineAnswered: false });
  for (const owner of options.reader === undefined ? owners : owners.filter((candidate) => candidate.userId === options.reader)) {
    counts.readers += 1;
    const tenant = { userId: owner.userId, organisationId: null };
    /* the findings this night detached and kept: the second pass does not ask about them again */
    const keptTonight = new Set<string>();
    const runs = await withTenant(tenant, () => prisma.researchRun.findMany({ where: { messageId: null, conversationId: null, createdAt: { lt: cutoff } }, orderBy: { createdAt: "asc" }, select: { id: true, workflowId: true } }));
    for (const run of runs) {
      const running = run.workflowId === null ? false : await options.running(run.workflowId);
      if (running === null) return stopped();
      if (running) {
        counts.running += 1;
        continue;
      }
      /* every sent finding asked about first, so an engine gone mid-way leaves the run and its findings as they were */
      const sent = await withTenant(tenant, () => prisma.researchFinding.findMany({ where: { runId: run.id, outcome: "SUBMITTED" }, select: { id: true } }));
      const stillSending: string[] = [];
      for (const finding of sent) {
        const sending = await options.running(findingWorkflowId(finding.id));
        if (sending === null) return stopped();
        if (sending) stillSending.push(finding.id);
      }
      await withTenant(tenant, async () => {
        const kept = await prisma.researchFinding.updateMany({ where: { runId: run.id, outcome: "PROPOSED", suggestionId: { not: null } }, data: { runId: null } });
        const waiting = await prisma.researchFinding.updateMany({ where: { runId: run.id, id: { in: stillSending }, outcome: "SUBMITTED" }, data: { runId: null } });
        const deleted = await prisma.researchRun.deleteMany({ where: { id: run.id, messageId: null, conversationId: null } });
        counts.proposalsKept += kept.count;
        counts.findingsKept += waiting.count;
        counts.deleted += deleted.count;
      });
      for (const id of stillSending) keptTonight.add(id);
    }
    /* the second pass: what was kept and is no proposal of the asker's */
    const detached = await withTenant(tenant, () => prisma.researchFinding.findMany({ where: { runId: null, outcome: { in: [...UNOWED_OUTCOMES] } }, orderBy: { ordinal: "asc" }, select: { id: true, outcome: true } }));
    for (const finding of detached) {
      if (keptTonight.has(finding.id)) continue;
      if (finding.outcome === "SUBMITTED") {
        const sending = await options.running(findingWorkflowId(finding.id));
        if (sending === null) return stopped();
        if (sending) {
          counts.findingsKept += 1;
          continue;
        }
      }
      const gone = await withTenant(tenant, () => prisma.researchFinding.deleteMany({ where: { id: finding.id, runId: null, outcome: finding.outcome } }));
      counts.findingsDeleted += gone.count;
    }
  }
  return { ...counts, engineAnswered: true };
}

/* ------------------------------------------------------------------ a person's research: its delete, its flag, its views (feature-specs/48 § 11.7, § 16, § 17.2; unit 71) */

export type ResearchConversationDeleted = { readonly deleted: true; readonly detached: number } | { readonly deleted: false };

/**
 * A person's delete of a research (feature-specs/48 § 17.2), one transaction inside their tenant context:
 *
 * 1. the research's row locked `FOR UPDATE`, raw since the client cannot (lib/db/RAW_SQL.md): the lock a start takes
 *    before it inserts (`createConversationRun`), and a run's insert checks its key with `FOR KEY SHARE`, so a start
 *    racing the delete waits, then finds no row and answers 404 (spec 45 § 3.3's reasoning);
 * 2. its runs with a workflow detached and without their text: no conversation, no question, brief, found, steps or
 *    report, no flag, `textPurgedAt` stamped where it is null; their state untouched. A run still under way ends
 *    `SKIPPED · TEXT_PURGED` at its next step, what it spent stays spent, and its row is the 24 hours' tally the cap
 *    counts (spec 45 D9) until the sweep takes it with what is no proposal of the asker's;
 * 3. its runs without a workflow, refused by a rule at their start, go with it by the key's cascade;
 * 4. the research itself.
 *
 * No stored response holds anything of it, since no research endpoint's answer holds text (§ 17.2), so nothing is
 * forgotten and nothing is settled first: there is no 409. The ledger keeps every record, and `BudgetLedger` its rows.
 * The `ERASED` record is the endpoint's, after this commits.
 */
export async function deleteResearchConversation(user: SessionUser, id: string, now: Date = new Date()): Promise<ResearchConversationDeleted> {
  return withTenant(tenantOf(user), () =>
    getPrisma().$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ResearchConversation" WHERE "id" = ${id} AND "userId" = ${user.id} FOR UPDATE`;
      if (locked.length === 0) return { deleted: false } as const;
      const working = { conversationId: id, workflowId: { not: null } };
      await tx.researchRun.updateMany({ where: { ...working, textPurgedAt: null }, data: { textPurgedAt: now } });
      const detached = await tx.researchRun.updateMany({ where: working, data: { conversationId: null, question: null, brief: null, found: Prisma.DbNull, steps: Prisma.DbNull, report: Prisma.DbNull, flagReason: null, flaggedAt: null } });
      await tx.researchConversation.deleteMany({ where: { id } });
      return { deleted: true, detached: detached.count } as const;
    }),
  );
}

/**
 * A research's `RESEARCH` records, by `seq` in chain order (feature-specs/48 § 11.10; unit 73): what its export signs,
 * and whether its page offers one. Each run of it with a workflow, by its record's step key — the key `recordPersonRun`
 * writes the record under, its workflow's id and the step `research:1` — read inside the asker's context, so another
 * person's research is null. A run a rule refused at its start has no workflow and no record, and so has a run that
 * spent nothing on a model (no planner answered it, § 30); a research of none of the others has none.
 */
export async function researchRecordSeqs(user: SessionUser, id: string): Promise<ReadonlyArray<number> | null> {
  const research = await readResearchConversation(user, id);
  if (research === null) return null;
  const runs = await withTenant(tenantOf(user), () => getPrisma().researchRun.findMany({ where: { conversationId: id, workflowId: { not: null } }, select: { workflowId: true } }));
  const stepKeys = runs.flatMap((run) => (run.workflowId === null ? [] : [stepKeyOf(run.workflowId, "research:1")]));
  return (await researchRecordsAt(stepKeys)).map((record) => record.seq);
}

/** The flag a run already carries, as its view reads it back (48 § 16, § 18): its kind by the run's refusal, and its reason, a code. */
export interface StoredFlag {
  readonly kind: "report" | "refusal";
  readonly reason: string | null;
}

export type ResearchFlagged =
  | { readonly flagged: true; readonly at: Date }
  | { readonly flagged: false; readonly reason: "NOT_FOUND" | "KIND_MISMATCH" }
  | { readonly flagged: false; readonly reason: "DUPLICATE"; readonly stored: StoredFlag };

const FLAG_ROW = { state: true, refusal: true, report: true, flagReason: true, flaggedAt: true } as const;

/**
 * A run's flag (feature-specs/48 § 11.7): the person's own label on its report or its refusal, on the run's own columns,
 * one a run. A run of a research of theirs, inside their context: another's, a legacy run or one detached by a delete
 * is absent. A flag already there is a duplicate, the first standing and read back (§ 18), whatever the run is now:
 * tested first, since the 30 days take a flagged run's report and keep its flag (§ 17.1), and a second press on it is
 * the same duplicate, not a contradiction (review of unit 71). Otherwise the kind must be the run's — a report on a run
 * that ended `DONE` with one, a refusal on a `REFUSED` run — since a label that contradicts the row says nothing true.
 * The write is conditional on no flag, so two at once leave one.
 */
export async function flagResearchRun(user: SessionUser, runId: string, kind: "report" | "refusal", reason: string, now: Date): Promise<ResearchFlagged> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const read = () => prisma.researchRun.findFirst({ where: { id: runId, conversationId: { not: null } }, select: FLAG_ROW });
    const duplicateOf = (row: { readonly refusal: string | null; readonly flagReason: string | null }): ResearchFlagged => ({ flagged: false, reason: "DUPLICATE", stored: { kind: row.refusal !== null ? "refusal" : "report", reason: row.flagReason } });
    const run = await read();
    if (run === null) return { flagged: false, reason: "NOT_FOUND" };
    if (run.flaggedAt !== null) return duplicateOf(run);
    const is = kind === "refusal" ? run.state === "REFUSED" && run.refusal !== null : run.state === "DONE" && run.report !== null;
    if (!is) return { flagged: false, reason: "KIND_MISMATCH" };
    const written = await prisma.researchRun.updateMany({ where: { id: runId, conversationId: { not: null }, flaggedAt: null }, data: { flagReason: reason, flaggedAt: now } });
    if (written.count === 1) return { flagged: true, at: now };
    /* a flag that landed between the read and the write, or a delete that took the run */
    const after = await read();
    return after === null ? { flagged: false, reason: "NOT_FOUND" } : duplicateOf(after);
  });
}

const RUN_FOR_PAGE = {
  id: true,
  userId: true,
  organisationId: true,
  conversationId: true,
  ordinal: true,
  locale: true,
  question: true,
  state: true,
  skip: true,
  failure: true,
  refusal: true,
  sectionAnchors: true,
  targetAnchors: true,
  budgetResetsAt: true,
  searches: true,
  pageReads: true,
  flagReason: true,
  flaggedAt: true,
  createdAt: true,
  finishedAt: true,
  textPurgedAt: true,
  steps: true,
  report: true,
  found: true,
} as const;

type RunForPage = Prisma.ResearchRunGetPayload<{ select: typeof RUN_FOR_PAGE }>;

const SHOWN_OUTCOMES = new Set<FindingOutcome>(["VALID", "DRAFTED", "SUBMITTED", "DUPLICATE", "PROPOSED", "REFUTED"]);

function shownFinding<T extends { readonly outcome: FindingOutcome }>(row: T): row is T & { readonly outcome: Exclude<FindingOutcome, "INVALID"> } {
  return SHOWN_OUTCOMES.has(row.outcome);
}

/** A column read back by its schema; null where it is empty or holds another shape. */
function parsedOr<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T | null {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The views of some runs of one research (feature-specs/48 § 16), inside the asker's context: each run's findings that
 * passed the checks, in the reader's order (an `INVALID` one is never read); what the reader wrote of each, where the
 * run's text is held, with its anchor resolved in the current release; the targets' and the pointers' titles in the
 * run's language; a proposed finding's panel through the door's read for the asker; the run's cost under the
 * principal it was charged to; and whether it is the research's seeded run (`isSeededRun`), from the research's seed and
 * the ordinal of its first run that planned. Since unit 74 what a used finding's suggestion lets the person see (§ 8.1,
 * § 8.5): a drafted finding's draft by the owner's own read (`ownSuggestionStates`), so its link opens the edit page
 * while it is a draft and none once it is deleted; and whether a duplicate's suggestion is theirs to be told
 * (`duplicateVisibleTo`). The view itself is `lib/research/runView.ts`'s.
 */
async function runViewsOf(user: SessionUser, rows: ReadonlyArray<RunForPage>, research: { readonly seedMessageId: string | null; readonly firstPlanned: number | null }, now: Date): Promise<ReadonlyArray<ResearchRunView>> {
  if (rows.length === 0) return [];
  const findingRows = await withTenant(tenantOf(user), () => getPrisma().researchFinding.findMany({ where: { runId: { in: rows.map((row) => row.id) } }, orderBy: { ordinal: "asc" }, select: { id: true, runId: true, ordinal: true, outcome: true, suggestionId: true, failure: true } }));
  const shown = findingRows.filter(shownFinding);
  const proposals = await proposalViewsOf(user, shown.flatMap((row) => (row.outcome === "PROPOSED" && row.suggestionId !== null ? [row.suggestionId] : [])));
  const drafts = await ownSuggestionStates(callerOf(user), shown.flatMap((row) => (row.outcome === "DRAFTED" && row.suggestionId !== null ? [row.suggestionId] : [])));
  const visible = new Set<string>();
  for (const row of shown) if (row.outcome === "DUPLICATE" && row.suggestionId !== null && (await duplicateVisibleTo(user, row.suggestionId))) visible.add(row.suggestionId);
  const views: ResearchRunView[] = [];
  for (const row of rows) {
    const { conversationId, ordinal } = row;
    /* read by conversation, so every row has one; a run with no ordinal is a legacy run's, which no research holds */
    if (conversationId === null || ordinal === null) continue;
    const lang = row.locale === "PT" ? "pt" : "en";
    const textPurged = row.textPurgedAt !== null;
    const found = parsedOr(ResearchFoundSchema, row.found);
    const refusal = parsedOr(ResearchRefusalSchema, row.refusal);
    const titled = async (ids: ReadonlyArray<string>) => Promise.all(ids.map(async (id) => ({ id, title: await sectionTitleOf(id, lang) })));
    const findings: ResearchFindingView[] = [];
    for (const finding of shown.filter((candidate) => candidate.runId === row.id)) {
      const written = textPurged || found === null ? null : parsedOr(ReaderFindingSchema, found.findings[finding.ordinal - 1] ?? null);
      const anchor = written === null ? null : await resolveAnchor(written.anchor.kind, written.anchor.id, lang);
      findings.push(
        findingViewOf(finding, findings.length + 1, textPurged, {
          finding: written,
          anchor,
          title: anchor === null ? null : await sectionTitleOf(anchor.sectionAnchor, lang),
          proposal: finding.suggestionId === null ? null : (proposals.get(finding.suggestionId) ?? null),
          use: { draftState: finding.suggestionId === null ? null : (drafts.get(finding.suggestionId) ?? null), duplicateVisible: finding.suggestionId !== null && visible.has(finding.suggestionId) },
        }),
      );
    }
    const pointers = refusal === null ? [] : (await titled(refusalPointerIdsOf(refusal, row.sectionAnchors))).flatMap((pointer) => (pointer.title === null ? [] : [{ sectionId: pointer.id, title: pointer.title }]));
    const principal = row.organisationId === null ? { userId: row.userId } : { organisationId: row.organisationId };
    views.push(
      runViewOf(
        { ...row, conversationId, ordinal, refusal },
        {
          seeded: isSeededRun(research.seedMessageId, ordinal, research.firstPlanned),
          steps: parsedOr(ResearchStepsSchema, row.steps) ?? [],
          report: parsedOr(ReportSchema, row.report),
          found,
          sections: await titled(row.targetAnchors),
          pointers,
          findings,
          costUsd: await runCostOf(principal, row.id),
        },
        now,
      ),
    );
  }
  return views;
}

/** A run of a research of the asker's, as the run endpoint answers it (48 § 16); null where it is not theirs, is a legacy run, or was detached by a delete. */
export async function readResearchRunView(user: SessionUser, runId: string, now: Date = new Date()): Promise<ResearchRunView | null> {
  const row = await withTenant(tenantOf(user), () => getPrisma().researchRun.findFirst({ where: { id: runId, conversationId: { not: null } }, select: { ...RUN_FOR_PAGE, conversation: { select: { seedMessageId: true } } } }));
  if (row === null || row.conversationId === null) return null;
  const { conversation, ...run } = row;
  const { conversationId } = row;
  /* the research's first run that planned, which says whether this one is its seeded run */
  const firstPlanned = await withTenant(tenantOf(user), () => firstPlannedOrdinalIn(getPrisma(), conversationId));
  return (await runViewsOf(user, [run], { seedMessageId: conversation?.seedMessageId ?? null, firstPlanned }, now))[0] ?? null;
}

/** A research of the asker's with its runs' views, oldest first (48 § 13); null where it is not theirs or is gone. */
export async function readResearchConversationView(user: SessionUser, id: string, now: Date = new Date()): Promise<{ readonly conversation: ResearchConversationRow; readonly runs: ReadonlyArray<ResearchRunView> } | null> {
  const conversation = await readResearchConversation(user, id);
  if (conversation === null) return null;
  const rows = await withTenant(tenantOf(user), () => getPrisma().researchRun.findMany({ where: { conversationId: id }, orderBy: { ordinal: "asc" }, select: RUN_FOR_PAGE }));
  const firstPlanned = await withTenant(tenantOf(user), () => firstPlannedOrdinalIn(getPrisma(), id));
  return { conversation, runs: await runViewsOf(user, rows, { seedMessageId: conversation.seedMessageId, firstPlanned }, now) };
}

/* ------------------------------------------------------------------ the Improve landing page's `From a research` (feature-specs/48 § 10.2; unit 76) */

/** A finding of the person's not yet turned into an improvement, as the Improve landing page lists it (48 § 10.2). */
export interface UnusedFinding {
  /** Its research, labelled by its runs' sections' chapters as the Research page's list labels it (§ 11.4). */
  readonly research: { readonly id: string; readonly chapters: ReadonlyArray<number> };
  /** The run it came from — its row links to it, a send's follow reads it — and when it was started. */
  readonly run: { readonly id: string; readonly createdAt: Date };
  /** The run's language: the anchor's section title is that edition's. */
  readonly contentLang: "en" | "pt";
  /**
   * The finding as its run's view gives it (§ 16), for its button by role (`FindingAction`), less the reader's words: its
   * note, its change and its sources are null here, since the row shows none of them and a client island's props reach
   * the page whole. The Research page's run shows them.
   */
  readonly finding: ResearchFindingView;
}

/**
 * How many unused findings the Improve landing page lists (48 § 10.2; review of unit 76): the newest runs' first. The
 * rest are still offered under their runs on the Research page, and come into this list as newer ones are used or the
 * 30 days take the newer runs' words.
 */
export const UNUSED_FINDINGS_MAX = 50;

/**
 * The person's findings not yet turned into an improvement (48 § 10.2, story 4), inside their context: every `VALID`
 * finding of a research of theirs whose run's text is held — one an earlier send left a code on included, which its line
 * says (§ 8.1) — newest run first and in the reader's order within a run, the first `UNUSED_FINDINGS_MAX`. Each is the
 * run's view of it (`findingViewOf`): numbered among its run's findings that passed the checks, its anchor resolved in
 * the current release with its section's title in the run's language, nothing used about it; its note, change and sources
 * left out (`UnusedFinding.finding`). A finding drafted or sent, or whose words the 30 days or a delete took, is none of
 * them; nor is a legacy run's, which no research holds. Never a question, a report or a brief.
 */
export async function unusedFindingsOf(user: SessionUser): Promise<ReadonlyArray<UnusedFinding>> {
  const rows = await withTenant(tenantOf(user), () =>
    getPrisma().researchFinding.findMany({
      where: { outcome: "VALID", run: { conversationId: { not: null }, textPurgedAt: null } },
      /* the run's id between two runs started in the same instant, so that the cut falls in one place */
      orderBy: [{ run: { createdAt: "desc" } }, { runId: "asc" }, { ordinal: "asc" }],
      take: UNUSED_FINDINGS_MAX,
      select: {
        id: true,
        ordinal: true,
        suggestionId: true,
        failure: true,
        run: {
          select: {
            id: true,
            createdAt: true,
            locale: true,
            found: true,
            conversationId: true,
            findings: { where: { outcome: { not: "INVALID" } }, select: { ordinal: true } },
            conversation: { select: { runs: { orderBy: { ordinal: "asc" }, select: { targetAnchors: true } } } },
          },
        },
      },
    }),
  );
  /* a run's words parsed once and its research's chapters counted once, however many of its findings are listed */
  const ofRun = new Map<string, { readonly found: ResearchFound | null; readonly chapters: ReadonlyArray<number> }>();
  const listed = rows.flatMap((row) => {
    const { run } = row;
    if (run === null || run.conversationId === null || run.conversation === null) return [];
    const known = ofRun.get(run.id) ?? { found: parsedOr(ResearchFoundSchema, run.found), chapters: chaptersOfSections(run.conversation.runs.flatMap((other) => other.targetAnchors)) };
    ofRun.set(run.id, known);
    const written = known.found === null ? null : parsedOr(ReaderFindingSchema, known.found.findings[row.ordinal - 1] ?? null);
    /* its number in its run's view: among the findings that passed the checks, in the reader's order (§ 16) */
    const n = run.findings.filter((other) => other.ordinal <= row.ordinal).length;
    return [{ row, run, conversationId: run.conversationId, chapters: known.chapters, written, n }];
  });
  /* the anchors resolved together, each with its section's title in its run's language */
  return Promise.all(
    listed.map(async ({ row, run, conversationId, chapters, written, n }): Promise<UnusedFinding> => {
      const lang = run.locale === "PT" ? "pt" : "en";
      const anchor = written === null ? null : await resolveAnchor(written.anchor.kind, written.anchor.id, lang);
      const view = findingViewOf({ id: row.id, outcome: "VALID", suggestionId: row.suggestionId, failure: row.failure }, Math.max(1, n), false, {
        finding: written,
        anchor,
        title: anchor === null ? null : await sectionTitleOf(anchor.sectionAnchor, lang),
        proposal: null,
        use: { draftState: null, duplicateVisible: false },
      });
      return {
        research: { id: conversationId, chapters },
        run: { id: run.id, createdAt: run.createdAt },
        contentLang: lang,
        finding: { ...view, change: null, sources: null, note: null },
      };
    }),
  );
}
