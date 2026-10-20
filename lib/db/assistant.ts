import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma, type ExtendedClient } from "@/lib/db/client";
import { purgeResearchText, readResearchViews } from "@/lib/db/research";
import { Prisma } from "@/lib/db/generated/client";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { purgedModeResult } from "@/lib/assistant/purge";
import { AppError, isForeignKeyViolation } from "@/lib/errors";
import type { ResearchView } from "@/lib/schemas/api";
import type { AnswerResult, Mode } from "@/lib/schemas/assistant";
import { ANSWER_DEADLINE_MS } from "@/lib/workers/client";

/*
 * The assistant's rows: creates, reads and the purge (feature-specs/15 § 4). Every query runs inside the session's
 * tenant context and none of them names the user in a `where`: the guard injects it, so one reader's conversations
 * are invisible to another by construction. A foreign id therefore reads as absent, and the endpoint answers 404
 * rather than 403, so an id is not an oracle for what exists.
 *
 * The workers own a turn's rows (§ 6.3, D4): the web tier validates and forwards, and `appendAssistantMessage` is
 * called from there with the flow's result. Nothing in this file calls a model or knows what one is.
 */

const MODES: Readonly<Record<Mode, "EXPLAIN" | "COMPARE" | "WALK" | "LAB" | "BRIEF">> = {
  explain: "EXPLAIN",
  compare: "COMPARE",
  walk: "WALK",
  lab: "LAB",
  brief: "BRIEF",
};

export interface ConversationRow {
  readonly id: string;
  readonly releaseId: string;
  readonly locale: string;
  readonly createdAt: Date;
}

/**
 * Create a conversation in the current release. Since Assistant 2.0 (feature-specs/23 § 7.2) it belongs to a reader
 * and a release and to nothing else: it has no chapter, no section and no stored label. What a question is about is
 * read from the question, and the list labels a conversation by the chapters its answers cite (`citedChapters`).
 */
export async function createConversation(user: SessionUser, input: { readonly locale: "en" | "pt" }): Promise<ConversationRow> {
  const release = await currentRelease();
  if (release === null) throw new AppError("RELEASE_MISSING", "no current release");

  return withTenant(tenantOf(user), async () => {
    const row = await getPrisma().conversation.create({
      data: { userId: user.id, releaseId: release.id, locale: input.locale },
      select: { id: true, releaseId: true, locale: true, createdAt: true },
    });
    return row;
  });
}

/**
 * The derive lines of cited figures (feature-specs/23 § 7.3): a claim that quotes a derived figure shows its `ƒ L45`
 * mark, and since a conversation may cite any chapter the line travels with the citation instead of with the page
 * the reader has open. Content is not a tenant's, so this reads outside the guard.
 */
export async function deriveLinesOf(releaseId: string, figureIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, number>> {
  const wanted = [...new Set(figureIds)];
  if (wanted.length === 0) return new Map();
  const rows = await withSystem(async () =>
    getPrisma().figure.findMany({
      where: { anchor: { in: wanted }, derive: { isNot: null }, section: { chapterVersion: { releaseId } } },
      select: { anchor: true, derive: { select: { line: true } } },
    }),
  );
  return new Map(rows.flatMap((row) => (row.derive === null ? [] : [[row.anchor, row.derive.line] as const])));
}

export interface MessageView {
  readonly id: string;
  readonly role: "USER" | "ASSISTANT";
  readonly ordinal: number;
  readonly mode: string;
  readonly text: string | null;
  readonly refusal: { readonly cause: string; readonly beforeRetrieval: boolean } | null;
  readonly citations: ReadonlyArray<{ readonly ordinal: number; readonly sectionId: string; readonly figureId: string | null; readonly version: string; readonly editionLang: string; readonly claimText: string | null; readonly deriveLine: number | null }>;
  readonly verdicts: ReadonlyArray<{ readonly sensor: string; readonly verdict: string; readonly detail: string }>;
  readonly grounded: number | null;
  readonly repaired: boolean;
  readonly substituted: number;
  readonly citesEdition: string | null;
  readonly firstTokenMs: number | null;
  readonly totalMs: number | null;
  readonly ledger: { readonly seq: number; readonly hash: string } | null;
  readonly flag: { readonly kind: string; readonly reason: string } | null;
  readonly traceId: string;
  /** A walk turn's run and values (`WalkModeResultSchema`); null on other turns. */
  readonly modeResult: unknown;
  /** The research run that followed an answer (feature-specs/43 § 4.3), whole; null on a question, a refusal or a turn from before research. */
  readonly research: ResearchView | null;
  readonly createdAt: Date;
}

export interface ConversationView extends ConversationRow {
  readonly textPurgedAt: Date | null;
  readonly messages: ReadonlyArray<MessageView>;
}

/** One conversation with its turns in order. `null` for an id that is not the reader's: the guard hides it. */
export async function getConversation(user: SessionUser, id: string): Promise<ConversationView | null> {
  const found = await withTenant(tenantOf(user), async () => {
    const row = await getPrisma().conversation.findFirst({
      where: { id },
      select: {
        id: true, releaseId: true, locale: true, createdAt: true, textPurgedAt: true,
        messages: {
          orderBy: { ordinal: "asc" },
          select: {
            id: true, role: true, ordinal: true, mode: true, text: true, refusalCause: true, refusalBeforeRetrieval: true,
            grounded: true, repaired: true, substituted: true, citesEdition: true, firstTokenMs: true, totalMs: true,
            ledgerSeq: true, ledgerHash: true, traceId: true, modeResult: true, createdAt: true,
            citations: { orderBy: { ordinal: "asc" }, select: { ordinal: true, sectionId: true, figureId: true, version: true, editionLang: true, claimText: true } },
            verdicts: { select: { sensor: true, verdict: true, detail: true } },
            flags: { select: { kind: true, reason: true } },
          },
        },
      },
    });
    if (row === null) return null;

    /* the research run that followed each answer (43 § 4.3), read with the conversation so a reload shows the line */
    const research = await readResearchViews(user, row.messages.flatMap((message) => (message.role === "ASSISTANT" && message.refusalCause === null ? [message.id] : [])));
    return {
      ...row,
      messages: row.messages.map((message) => ({
        id: message.id,
        role: message.role,
        ordinal: message.ordinal,
        mode: message.mode,
        text: message.text,
        refusal: message.refusalCause === null ? null : { cause: message.refusalCause, beforeRetrieval: message.refusalBeforeRetrieval ?? false },
        research: research.get(message.id) ?? null,
        citations: message.citations,
        verdicts: message.verdicts,
        grounded: message.grounded === null ? null : Number(message.grounded),
        repaired: message.repaired,
        substituted: message.substituted,
        citesEdition: message.citesEdition,
        firstTokenMs: message.firstTokenMs,
        totalMs: message.totalMs,
        ledger: message.ledgerSeq === null || message.ledgerHash === null ? null : { seq: message.ledgerSeq, hash: message.ledgerHash },
        flag: message.flags[0] ?? null,
        traceId: message.traceId,
        modeResult: message.modeResult ?? null,
        createdAt: message.createdAt,
      })),
    };
  });
  if (found === null) return null;

  const lines = await deriveLinesOf(found.releaseId, found.messages.flatMap((message) => message.citations.flatMap((citation) => (citation.figureId === null ? [] : [citation.figureId]))));
  return {
    ...found,
    messages: found.messages.map((message) => ({
      ...message,
      citations: message.citations.map((citation) => ({ ...citation, deriveLine: citation.figureId === null ? null : (lines.get(citation.figureId) ?? null) })),
    })),
  };
}

export interface ConversationSummary {
  readonly id: string;
  /**
   * The distinct chapters the conversation's answers cite, in order of first citation: its label (feature-specs/23
   * § 7.2, D8). It is never the reader's text, it survives the 30-day purge because citations do, and it is short by
   * construction, which the no-truncation rule needs.
   */
  readonly citedChapters: ReadonlyArray<number>;
  readonly lastMessageAt: Date;
  readonly turns: number;
  readonly passCount: number;
  readonly refusedCount: number;
  readonly textPurged: boolean;
}

/** The log rail's "earlier conversations": the screen's `6 turns · 6 pass` line, newest first (§ 4). */
export async function listConversations(user: SessionUser, options: { readonly limit?: number } = {}): Promise<ReadonlyArray<ConversationSummary>> {
  return withTenant(tenantOf(user), async () => {
    const rows = await getPrisma().conversation.findMany({
      orderBy: { lastMessageAt: "desc" },
      take: options.limit ?? 5,
      select: {
        id: true, lastMessageAt: true, textPurgedAt: true,
        messages: {
          where: { role: "ASSISTANT" },
          orderBy: { ordinal: "asc" },
          select: { refusalCause: true, verdicts: { select: { verdict: true } }, citations: { orderBy: { ordinal: "asc" }, select: { sectionId: true } } },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      citedChapters: [...new Set(row.messages.flatMap((message) => message.citations.map((citation) => Number(citation.sectionId.slice(0, 2)))).filter((chapter) => Number.isInteger(chapter)))],
      lastMessageAt: row.lastMessageAt,
      turns: row.messages.length,
      /* "pass" is every sensor PASS or NA: an NA is a sensor that had nothing to check, not a failure. */
      passCount: row.messages.filter((message) => message.refusalCause === null && message.verdicts.every((verdict) => verdict.verdict === "PASS" || verdict.verdict === "NA")).length,
      refusedCount: row.messages.filter((message) => message.refusalCause !== null).length,
      textPurged: row.textPurgedAt !== null,
    }));
  });
}

/**
 * The reader's turn, written before the flow runs so a crash leaves the question on the record (§ 6.3). A question
 * racing the conversation's delete waits on its lock and fails on the key: `NOT_FOUND`, as the conversation's read
 * answers once it is gone, never a 500 (feature-specs/45 § 3.3).
 */
export async function appendUserMessage(
  user: SessionUser,
  conversationId: string,
  input: { readonly text: string; readonly mode: Mode; readonly traceId: string; readonly aidInputs?: Readonly<Record<string, number>> | null },
): Promise<{ readonly id: string; readonly ordinal: number }> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const last = await prisma.message.findFirst({ where: { conversationId }, orderBy: { ordinal: "desc" }, select: { ordinal: true } });
    const ordinal = (last?.ordinal ?? 0) + 1;
    const row = await prisma.message
      .create({
        data: { userId: user.id, conversationId, role: "USER", ordinal, mode: MODES[input.mode], text: input.text, traceId: input.traceId, aidInputs: input.aidInputs ?? undefined },
        select: { id: true, ordinal: true },
      })
      .catch((error: unknown) => {
        if (isForeignKeyViolation(error)) throw new AppError("NOT_FOUND", "no such conversation");
        throw error;
      });
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
    return row;
  });
}

/** The assistant's turn, from the flow's result: the claims, the citations, the verdicts and the ledger line. */
export async function appendAssistantMessage(
  user: SessionUser,
  conversationId: string,
  result: AnswerResult,
  extra: {
    readonly ordinal: number;
    readonly mode: "EXPLAIN" | "COMPARE" | "WALK" | "LAB" | "BRIEF";
    readonly traceId: string;
    readonly promptSha256: string | null;
    readonly overBudget: boolean;
    readonly ledger: { readonly seq: number; readonly hash: string } | null;
    /** A walk turn's run and values, for the reload (feature-specs/18 D4); null on other turns. */
    readonly modeResult?: unknown;
  },
): Promise<{ readonly id: string }> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const substituted = result.claims.filter((claim) => claim.substituted).length;
    const message = await prisma.message.create({
      data: {
        userId: user.id,
        conversationId,
        role: "ASSISTANT",
        ordinal: extra.ordinal,
        mode: extra.mode,
        /* The claims as the reader will read them, joined: the substituted sentences included, because that is
           what was shown and the record is of what was shown. */
        text: result.claims.map((claim) => claim.text).join(" "),
        refusalCause: result.refusal?.cause ?? null,
        refusalBeforeRetrieval: result.refusal?.beforeRetrieval ?? null,
        guideVersion: result.guide.version,
        guideSha256: result.guide.sha256,
        modelId: result.modelId,
        promptSha256: extra.promptSha256,
        grounded: result.grounded,
        repaired: result.repaired,
        substituted,
        citesEdition: result.citations[0]?.editionLang ?? null,
        firstTokenMs: result.timings.firstTokenMs,
        totalMs: result.timings.totalMs,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        /* what the turn hands over to research (feature-specs/40 § 4): never read back to a client, purged with the text */
        uncovered: result.uncovered === undefined || result.uncovered.length === 0 ? undefined : [...result.uncovered],
        retrievedSections: result.retrievedSections === undefined ? [] : [...result.retrievedSections],
        overBudget: extra.overBudget,
        traceId: extra.traceId,
        ledgerSeq: extra.ledger?.seq ?? null,
        ledgerHash: extra.ledger?.hash ?? null,
        modeResult: extra.modeResult === undefined || extra.modeResult === null ? undefined : (extra.modeResult as Prisma.InputJsonValue),
        citations: {
          create: result.citations.map((citation, index) => ({
            userId: user.id,
            ordinal: index + 1,
            sectionId: citation.sectionId,
            figureId: citation.figureId,
            version: citation.version,
            editionLang: citation.editionLang,
            claimText: result.claims.find((claim) => claim.sectionId === citation.sectionId && !claim.substituted)?.text ?? null,
          })),
        },
        verdicts: {
          create: result.verdicts.map((verdict) => ({ userId: user.id, sensor: verdict.sensor, verdict: verdict.verdict, detail: verdict.detail, data: verdict.data })),
        },
      },
      select: { id: true },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
    return message;
  });
}

/** One flag per reader per message: a second is a 409, because a flag is a label and not a vote (§ 5.4). */
export async function recordFlag(user: SessionUser, messageId: string, kind: "ANSWER" | "REFUSAL", reason: string): Promise<{ readonly id: string }> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const message = await prisma.message.findFirst({ where: { id: messageId }, select: { refusalCause: true } });
    /* Not the reader's message, or none: absent, so the endpoint answers 404 rather than telling them it exists. */
    if (message === null) throw new AppError("NOT_FOUND", "no such message");
    /* A flag is a labelled sample for the grader's calibration set (spec 17), so a label that contradicts the row
       would teach it the opposite of what happened: `refusal` on an answer, or `answer` on a refusal, is refused. */
    const isRefusal = message.refusalCause !== null;
    if (isRefusal !== (kind === "REFUSAL")) {
      throw new AppError("FLAG_KIND_MISMATCH", `this message is ${isRefusal ? "a refusal" : "an answer"}; flag it as one (feature-specs/15 § 5.4)`);
    }
    const existing = await prisma.flag.findFirst({ where: { messageId }, select: { id: true } });
    if (existing !== null) throw new AppError("FLAG_DUPLICATE", "this message is already flagged (feature-specs/15 § 5.4)");
    return prisma.flag.create({ data: { userId: user.id, messageId, kind, reason }, select: { id: true } }).catch((error: unknown) => {
      /* its message deleted with the conversation as the flag was written (45 § 3.3; review of unit 62): absent, as before it */
      if (isForeignKeyViolation(error)) throw new AppError("NOT_FOUND", "no such message");
      throw error;
    });
  });
}

/** What the account page's retention line says, and what spec 21's series counts (§ 4). */
export async function conversationStats(user: SessionUser): Promise<{ readonly conversations: number; readonly oldestTextAt: Date | null }> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const conversations = await prisma.conversation.count();
    const oldest = await prisma.message.findFirst({ where: { text: { not: null } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    return { conversations, oldestTextAt: oldest?.createdAt ?? null };
  });
}

/**
 * Whether the conversation's last turn is still open: a `USER` row with no `ASSISTANT` row after it (§ 6.3). A
 * second question while one stands is 409 `TURN_IN_PROGRESS`, and a turn abandoned by a crash is closed by the
 * purge script as a failed turn. `null` for a conversation that is not the reader's: the guard hides it.
 */
export async function openTurn(user: SessionUser, conversationId: string): Promise<{ readonly ordinal: number } | null> {
  return withTenant(tenantOf(user), async () => {
    const last = await getPrisma().message.findFirst({ where: { conversationId }, orderBy: { ordinal: "desc" }, select: { role: true, ordinal: true } });
    return last === null || last.role !== "USER" ? null : { ordinal: last.ordinal };
  });
}

/**
 * A turn that failed after the question was recorded (§ 6.3 step 4): no text, no citations and no ledger record,
 * because nothing was answered. The one `NA` verdict carries the error's code, so the log rail shows the turn
 * rather than a question with silence after it.
 */
export async function appendFailedTurn(
  user: SessionUser,
  conversationId: string,
  extra: FailedTurn,
): Promise<{ readonly id: string }> {
  return withTenant(tenantOf(user), async () => writeFailedTurn(user.id, conversationId, extra));
}

export interface FailedTurn {
  readonly ordinal: number;
  readonly mode: "EXPLAIN" | "COMPARE" | "WALK" | "LAB" | "BRIEF";
  readonly traceId: string;
  readonly code: string;
  /** What the verdict row keeps beside the code: a failed aid run's exit code and duration (feature-specs/18 § 7). */
  readonly data?: Readonly<Record<string, number | string | boolean>>;
}

/**
 * The row itself, inside a tenant context the caller already opened: the turn's own, or the purge's (§ 8). Its insert
 * fails on the key where the conversation was deleted (45 § 3.3): the turn's tail logs that, and the purge skips it.
 */
async function writeFailedTurn(userId: string, conversationId: string, extra: FailedTurn): Promise<{ readonly id: string }> {
  const prisma = getPrisma();
  const message = await prisma.message.create({
    data: {
      userId,
      conversationId,
      role: "ASSISTANT",
      ordinal: extra.ordinal,
      mode: extra.mode,
      text: null,
      refusalCause: null,
      traceId: extra.traceId,
      verdicts: { create: [{ userId, sensor: "scope", verdict: "NA", detail: extra.code, data: extra.data ?? {} }] },
    },
    select: { id: true },
  });
  await prisma.conversation.updateMany({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  return message;
}

/**
 * An abandoned turn closed by the purge as a failed turn (§ 8), inside the reader's context the purge opened; false
 * where the conversation was deleted under the purge, which skips it rather than stopping the night's run for every
 * reader after this one (feature-specs/45 § 3.3).
 */
export async function closeAbandonedTurn(userId: string, question: { readonly conversationId: string; readonly ordinal: number; readonly mode: FailedTurn["mode"]; readonly traceId: string }): Promise<boolean> {
  try {
    await writeFailedTurn(userId, question.conversationId, { ordinal: question.ordinal + 1, mode: question.mode, traceId: question.traceId, code: "TURN_ABANDONED" });
    return true;
  } catch (error: unknown) {
    if (isForeignKeyViolation(error)) return false;
    throw error;
  }
}

/** What a turn's mode picked (feature-specs/23 § 7.3): the pair of a compare, the lab of a lab turn. A walk's aid travels beside it. */
export interface TurnContext {
  readonly chapters?: readonly [number, number];
  readonly labId?: string;
}

/** What a 422 `CONTEXT_INVALID` names: the field at fault and, for a chapter, which one (feature-specs/19 § 3). */
export interface ContextProblem {
  readonly message: string;
  readonly field: "chapters" | "labId";
  readonly chapter?: number;
}

/**
 * What is wrong with a turn's context, or `null` when nothing is (§ 5.3, 422 `CONTEXT_INVALID`). Every part is
 * checked against the conversation's own release, so a question can never be asked of a page the reader cannot
 * open; compare mode's two chapters must also be distinct and verified, because comparing an unverified chapter
 * would present a claim the pipeline has not checked, and a lab must be the context chapter's own (feature-specs/19
 * § 3).
 */
export async function contextProblem(releaseId: string, context: TurnContext | null): Promise<ContextProblem | null> {
  if (context === null) return null;
  const prisma = getPrisma();

  if (context.chapters !== undefined) {
    const [first, second] = context.chapters;
    if (first === second) return { message: "compare needs two different chapters", field: "chapters", chapter: first };
    const verified = await prisma.chapterVersion.findMany({ where: { releaseId, chapterNumber: { in: [first, second] }, verifyStatus: "PASSED" }, select: { chapterNumber: true } });
    const passed = new Set(verified.map((row) => row.chapterNumber));
    const failing = [first, second].find((chapter) => !passed.has(chapter));
    if (failing !== undefined) return { message: `chapter ${String(failing)} is not verified in release ${releaseId}`, field: "chapters", chapter: failing };
  }

  if (context.labId !== undefined) {
    const lab = await prisma.lab.findFirst({ where: { anchor: context.labId, chapterVersion: { releaseId } }, select: { id: true } });
    /* Any lab of the release: since Assistant 2.0 there is no context chapter for it to be "the chapter's own" lab of. */
    if (lab === null) return { message: `lab ${context.labId} is not in release ${releaseId}`, field: "labId" };
  }

  return null;
}

/**
 * The `ANSWER` record's line on the row it proves (§ 6.3 step 3). It is a second write and not a column of the
 * first, because the record names the message: the row has to exist before the record can be appended, and the
 * record's seq and hash have to exist before the row can carry them.
 */
export async function attachLedger(user: SessionUser, messageId: string, line: { readonly seq: number; readonly hash: string }): Promise<void> {
  await withTenant(tenantOf(user), async () => {
    await getPrisma().message.update({ where: { id: messageId }, data: { ledgerSeq: line.seq, ledgerHash: line.hash } });
  });
}

/** The reader's words are kept for 30 days (architecture § 4.5; feature-specs/15 § 8), never their citations or verdicts. */
export const TEXT_RETENTION_DAYS = 30;

export interface PurgeCounts {
  /** Readers whose rows the run touched. */
  readonly readers: number;
  /** Messages whose `text` the run nulled. */
  readonly messages: number;
  /** Citations whose `claimText` the run nulled. */
  readonly citations: number;
  /** Stored mode results whose sentences the run cleared: a walk's explanations, a lab's lines, a compare's open point, a brief's decision. */
  readonly modeResults: number;
  /** Research runs whose brief went with their message's text, and whose uncovered sentences went (feature-specs/40 § 8.3). */
  readonly researchRuns: number;
  /** Conversations whose last remaining text went, so `textPurgedAt` is now set. */
  readonly conversations: number;
  /** Turns abandoned by a crash, closed as failed turns. */
  readonly closed: number;
}

/**
 * The nightly purge (§ 8). Three things happen and nothing else: a message older than the retention window loses
 * its text, its citations lose their quoted claim and its stored mode result loses the model's sentences (the
 * script's numbers and the run's table stay: `lib/assistant/purge.ts`), a conversation with no text left is marked purged, and a turn
 * abandoned by a crash — a `USER` row still alone after the flow's longest possible run — is closed as a failed
 * turn so the log rail shows a turn rather than a question with silence after it.
 *
 * What stays: citations, verdicts, flags, timings, hashes and every ledger record. The record proves what was
 * answered by its hashes, so it still matches a conversation whose words are gone (invariant 18), and this run
 * appends no record of its own. A conversation its reader deletes loses those rows too, at once and not here
 * (`deleteConversation`, feature-specs/45 § 3); a row deleted between this run's read and its write is skipped.
 *
 * Every write runs inside the reader's own tenant context, so the guard scopes it exactly as a request would: the
 * one cross-reader statement is the raw `SELECT` that names which readers have anything to purge, because a
 * maintenance job has no session and the guard admits no model but the auth four without one.
 *
 * `reader` keeps the run to one reader's rows. The nightly job never sets it. The Phase 2 gate does
 * (feature-specs/22 § 3, P2.6b): it moves the clock 31 days ahead to watch the purge take a turn's words, and a
 * clock moved ahead must not take anyone else's words early.
 */
export async function purgeAssistantText(options: { readonly now: Date; readonly abandonedAfterMs: number; readonly retentionDays?: number; readonly reader?: string }): Promise<PurgeCounts> {
  const cutoff = new Date(options.now.getTime() - (options.retentionDays ?? TEXT_RETENTION_DAYS) * 86_400_000);
  const abandonedBefore = new Date(options.now.getTime() - options.abandonedAfterMs);
  const prisma = getPrisma();

  const owners = await prisma.$queryRaw<Array<{ userId: string }>>`
    SELECT DISTINCT "userId" FROM "Message"
    WHERE ("text" IS NOT NULL AND "createdAt" < ${cutoff}) OR ("role" = 'USER' AND "createdAt" < ${abandonedBefore})
    UNION
    SELECT DISTINCT "userId" FROM "Conversation" WHERE "textPurgedAt" IS NULL
  `;

  const counts = { readers: 0, messages: 0, citations: 0, modeResults: 0, researchRuns: 0, conversations: 0, closed: 0 };
  for (const owner of options.reader === undefined ? owners : owners.filter((candidate) => candidate.userId === options.reader)) {
    counts.readers += 1;
    await withTenant({ userId: owner.userId, organisationId: null }, async () => {
      /* The claim text goes with the message that made it: a citation quoting words nobody may read any more
         would keep the reader's question alive in another column. */
      const citations = await prisma.citation.updateMany({ where: { claimText: { not: null }, message: { createdAt: { lt: cutoff } } }, data: { claimText: null } });
      /* the messages whose text goes are known first: research's brief and the uncovered sentences go with it (feature-specs/40 § 8.3) */
      const going = await prisma.message.findMany({ where: { text: { not: null }, createdAt: { lt: cutoff } }, select: { id: true } });
      const messages = await prisma.message.updateMany({ where: { text: { not: null }, createdAt: { lt: cutoff } }, data: { text: null } });
      counts.citations += citations.count;
      counts.messages += messages.count;
      const research = await purgeResearchText(going.map((row) => row.id), options.now);
      counts.researchRuns += research.runs;

      /* The modes that store a result on the row (specs 18 D4, 19 § 6): what the model wrote in it goes with the text. */
      const shaped = await prisma.message.findMany({
        where: { role: "ASSISTANT", createdAt: { lt: cutoff }, mode: { in: ["WALK", "LAB", "COMPARE", "BRIEF"] } },
        select: { id: true, mode: true, modeResult: true },
      });
      for (const row of shaped) {
        if (row.modeResult === null) continue;
        const cleared = purgedModeResult(row.mode, row.modeResult);
        /* Identity, not a comparison of serialisations: the column comes back with its keys reordered (lib/assistant/purge.ts). */
        if (cleared === row.modeResult) continue;
        /* by `updateMany`: a message whose conversation was deleted since it was read is gone, and skipped (45 § 3.3) */
        const written = await prisma.message.updateMany({ where: { id: row.id }, data: { modeResult: cleared as Prisma.InputJsonValue } });
        counts.modeResults += written.count;
      }

      /* A conversation is purged when it had text and has none left; one with no messages at all is not purged,
         it is empty, and the account page's line would be wrong to call it otherwise. */
      const purged = await prisma.conversation.updateMany({
        where: { textPurgedAt: null, messages: { some: {}, none: { text: { not: null } } } },
        data: { textPurgedAt: options.now },
      });
      counts.conversations += purged.count;

      /* An abandoned turn: the last row of the conversation is the question, and the flow cannot still be running
         because its longest possible run has passed (§ 6.3, D5). */
      const open = await prisma.message.findMany({
        where: { role: "USER", createdAt: { lt: abandonedBefore } },
        orderBy: { ordinal: "asc" },
        select: { conversationId: true, ordinal: true, mode: true, traceId: true },
      });
      for (const question of open) {
        const after = await prisma.message.count({ where: { conversationId: question.conversationId, ordinal: { gt: question.ordinal } } });
        if (after > 0) continue;
        if (await closeAbandonedTurn(owner.userId, question)) counts.closed += 1;
      }
    });
  }
  return counts;
}

/* ------------------------------------------------------------------ deleting a conversation (feature-specs/45 § 3) */

/** The ask endpoint's path template, under which the pipeline keeps each turn's stored `final` for 24 hours (45 § 3.3, § 3.4). */
export const ASK_PATH = "/api/v1/assistant/conversations/{id}/messages";

/** What a conversation's delete did (45 § 3.3): its rows gone, with how many messages, research runs detached and stored finals forgotten; or why not. */
export type ConversationDeleted =
  | { readonly deleted: true; readonly messages: number; readonly detached: number; readonly forgotten: number }
  | { readonly deleted: false; readonly reason: "NOT_FOUND" | "TURN_IN_PROGRESS" };

/**
 * Whether the conversation's turns have settled (45 § 3.4): nothing of any can still be written. A reader may ask again
 * as soon as an answer's row exists, before its final is stored, so every row younger than the answer's deadline is
 * read, not only the last (review of unit 62). Not while the last row is a question younger than the deadline, nor
 * while any answer or refusal younger than it has no stored `final` — the stored final is a turn's last write, after
 * its record, its line and the research hand-over. A failed turn is settled at once, its error event its last act; an
 * abandoned question, and an answer whose stream was never finished, once the deadline is past.
 */
async function settled(tx: Pick<ExtendedClient, "message" | "idempotencyKey">, conversationId: string, now: Date): Promise<boolean> {
  const young = await tx.message.findMany({ where: { conversationId, createdAt: { gt: new Date(now.getTime() - ANSWER_DEADLINE_MS) } }, orderBy: { ordinal: "desc" }, select: { id: true, role: true, guideVersion: true } });
  /* ordinals and times rise together: where any row is young, the first is the last row */
  if (young[0]?.role === "USER") return false;
  const answered = young.flatMap((row) => (row.role === "ASSISTANT" && row.guideVersion !== null ? [row.id] : []));
  if (answered.length === 0) return true;
  const stored = await tx.idempotencyKey.findMany({ where: { path: ASK_PATH, OR: answered.map((messageId) => ({ response: { path: ["messageId"], equals: messageId } })) }, select: { response: true } });
  const finals = new Set(stored.map((row) => (typeof row.response === "object" && row.response !== null && !Array.isArray(row.response) ? row.response.messageId : undefined)));
  return answered.every((messageId) => finals.has(messageId));
}

/**
 * The reader's delete of a conversation (45 § 3.3, D1), in one transaction inside their tenant context:
 *
 * 1. the conversation's row locked `FOR UPDATE`, raw since the client cannot (lib/db/RAW_SQL.md): the lock a message's
 *    insert must wait on, its key's check taking `FOR KEY SHARE`, so every writer of the conversation's rows waits, and
 *    fails on the missing row once this commits rather than landing between these statements;
 * 2. the settle rule, read under the lock; then its messages locked `FOR UPDATE` as they are read, since a flag's key
 *    check waits on its message, not on the conversation (review of unit 62);
 * 3. its research: a run with a workflow loses its text and is detached from its message, its state untouched, and its
 *    row is the 24 hours' tally the cap counts (D9); a run with none goes with its message by the key's cascade;
 * 4. the stored finals of its turns forgotten: the reader's keys on the ask path whose `final` names one of its messages;
 * 5. its rows, children first since their keys are `RESTRICT`: flags, citations, verdicts, messages, the conversation.
 *
 * The ledger keeps every record, and `BudgetLedger` its rows. The `ERASED` record is the endpoint's, after this commits.
 */
export async function deleteConversation(user: SessionUser, id: string, now: Date = new Date()): Promise<ConversationDeleted> {
  return withTenant(tenantOf(user), () =>
    getPrisma().$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Conversation" WHERE "id" = ${id} AND "userId" = ${user.id} FOR UPDATE`;
      if (locked.length === 0) return { deleted: false, reason: "NOT_FOUND" } as const;
      if (!(await settled(tx, id, now))) return { deleted: false, reason: "TURN_IN_PROGRESS" } as const;

      const messageIds = (await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Message" WHERE "conversationId" = ${id} AND "userId" = ${user.id} FOR UPDATE`).map((message) => message.id);
      const working = (await tx.researchRun.findMany({ where: { messageId: { in: messageIds }, workflowId: { not: null } }, select: { id: true } })).map((run) => run.id);
      await tx.researchRun.updateMany({ where: { id: { in: working }, textPurgedAt: null }, data: { textPurgedAt: now } });
      const detached = await tx.researchRun.updateMany({ where: { id: { in: working } }, data: { brief: null, found: Prisma.DbNull, messageId: null } });

      const forgotten = messageIds.length === 0 ? { count: 0 } : await tx.idempotencyKey.deleteMany({ where: { path: ASK_PATH, OR: messageIds.map((messageId) => ({ response: { path: ["messageId"], equals: messageId } })) } });

      await tx.flag.deleteMany({ where: { messageId: { in: messageIds } } });
      await tx.citation.deleteMany({ where: { messageId: { in: messageIds } } });
      await tx.sensorVerdict.deleteMany({ where: { messageId: { in: messageIds } } });
      await tx.message.deleteMany({ where: { conversationId: id } });
      await tx.conversation.deleteMany({ where: { id } });
      return { deleted: true, messages: messageIds.length, detached: detached.count, forgotten: forgotten.count } as const;
    }),
  );
}
