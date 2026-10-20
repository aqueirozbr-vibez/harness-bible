import { createHash } from "node:crypto";
import { Writable } from "node:stream";

import { ASK_RATE, CREATE_RATE, EXPORT_RATE, FLAG_RATE, READ_RATE } from "@/lib/api/endpoints/assistant";
import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { chaptersPassed } from "@/lib/db/content";
import { erasedRecordAt, researchErasedStepKeyOf } from "@/lib/db/ledger";
import {
  abandonConversationRun,
  createConversationRun,
  createResearchConversation,
  dailyLimitUntil,
  deleteResearchConversation,
  ENDED_STATES,
  flagResearchRun,
  latestBudgetReset,
  newestConversationRun,
  readResearchConversation,
  readResearchConversationView,
  readResearchRunView,
  readSeedFacts,
  researchRecordSeqs,
  researchStartGates,
  writeResearchState,
  type ResearchConversationRow,
} from "@/lib/db/research";
import { currentRelease } from "@/lib/db/shared";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { append } from "@/lib/ledger/append";
import { exportJsonl, exportKeyFromPem } from "@/lib/ledger/export";
import { ownResource } from "@/lib/policy/input";
import {
  ConversationDeletedSchema,
  ConversationParamsSchema,
  NoBodySchema,
  QUESTION_MAX,
  ResearchConversationCreateSchema,
  ResearchConversationSchema,
  ResearchConversationViewSchema,
  ResearchFlagPostSchema,
  ResearchFlagSchema,
  ResearchRunPostSchema,
  ResearchRunStartedSchema,
  ResearchRunViewSchema,
  type ResearchConversation,
  type ResearchRunStarted,
} from "@/lib/schemas/api";
import type { ExportTrailer } from "@/lib/schemas/ledger";
import { RESEARCH_RUN_WORKFLOW } from "@/lib/schemas/workflows";
import { processSecrets } from "@/lib/security/processSecrets";
import { redactSecrets } from "@/lib/security/redact";
import { namedChaptersOf, referencesOf } from "@/lib/sensors/references";
import { otRule } from "@/lib/sensors/scope";
import { startWorkflow, workflowRunning, WorkflowsUnavailableError } from "@/lib/workflows/client";

/*
 * A person's research through the API (feature-specs/48 § 13; unit 71): open a research, from scratch or seeded from an
 * Assistant answer of theirs; read it with its runs' views; start a run in it; follow a run; flag one; delete the
 * research; and, since unit 73, export its records. The two findings' endpoints, since unit 74, are ./researchFindings.ts. Every endpoint is the one pipeline's —
 * session, origin, rate, policy, tenant — and the policy's kind `research` (policies/hb/research.rego) names the caller
 * its owner; the tenant filter makes another person's research absent, so its id is a 404, never a 403.
 *
 * The start decides what it can for free before anything is spent (§ 5.2), each a status code since nothing has
 * started, in this order: the question's length; the research the caller's; no run of it under way — where the newest
 * is, the engine is asked, and a run whose workflow no longer runs is ended `FAILED · ABANDONED` so the start goes on,
 * before any lock is held, unless it is a `QUEUED` row young enough to be another start still in flight
 * (`START_IN_FLIGHT_MS`), which is a 409 and left alone, and only on the condition that the row still holds the state
 * read, a write that changed nothing being a 409 too; no deletion request standing for the account; the organisation's
 * switch; no reset the caller's latest run met still ahead; fewer than thirty counted runs in 24 hours; the engine
 * configured. Then the question is redacted with the process's secret patterns, and the Assistant's two free rules
 * decide whether it is a run refused at no cost, with no workflow, or a run queued: one transaction under the
 * research's lock, which reads the newest run and the day's count again (`createConversationRun`). After the commit the
 * workflow is started on the person's principal (`ResearchRunWorkflow`, `research:<runId>`); a refused start takes the
 * row back to `SKIPPED · UNAVAILABLE`, uncounted, and answers 503.
 *
 * No answer of these writes holds text or an address, so a stored idempotent response holds none (§ 17.2): the start's
 * `{ runId, state }` is stored and replayed for 24 hours, after the research is looked up, so a research deleted since
 * answers 404 and never its stored start (the Assistant's ask's order, spec 45 § 3.2).
 */

/** What the research endpoints ask of the door, the engine, the ledger and the clock: their seams, for the tests. */
export interface ResearchEndpointDeps {
  readonly seed: typeof readSeedFacts;
  readonly open: typeof createResearchConversation;
  readonly conversation: typeof readResearchConversation;
  readonly conversationView: typeof readResearchConversationView;
  readonly runView: typeof readResearchRunView;
  readonly newestRun: typeof newestConversationRun;
  /** Whether a run's workflow still runs; `WorkflowsUnavailableError` where the engine cannot be asked. */
  readonly running: (workflowId: string) => Promise<boolean>;
  /** Check 3's end of a run nothing moves, on the condition that it holds the state read. */
  readonly abandon: typeof abandonConversationRun;
  /** The take-back of a run whose start the engine refused. */
  readonly writeState: typeof writeResearchState;
  readonly gates: typeof researchStartGates;
  readonly budgetReset: typeof latestBudgetReset;
  readonly dailyLimit: typeof dailyLimitUntil;
  /** The workflow engine's address and namespace are set (check 8). */
  readonly configured: () => boolean;
  /** The current release's id: a run reads the book at it. */
  readonly release: () => Promise<string>;
  readonly chaptersPassed: (releaseId: string, chapters: ReadonlyArray<number>) => Promise<boolean>;
  readonly secrets: () => ReadonlyArray<string>;
  readonly createRun: typeof createConversationRun;
  readonly start: (workflowId: string, input: { readonly runId: string; readonly userId: string }) => Promise<void>;
  readonly flag: typeof flagResearchRun;
  readonly remove: typeof deleteResearchConversation;
  /** The `ERASED` record already appended under the step key, if one was. */
  readonly recorded: (stepKey: string) => Promise<{ readonly seq: number } | null>;
  readonly append: (input: Parameters<typeof append>[0]) => Promise<{ readonly seq: number }>;
  /** A research's `RESEARCH` records by `seq`; null where it is not the caller's (48 § 11.10). */
  readonly records: typeof researchRecordSeqs;
  /** Those records as signed JSONL with the trailer, signed with the platform's export key (spec 14 § 7). */
  readonly exportFile: (researchId: string, seqs: ReadonlyArray<number>) => Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }>;
  readonly now: () => Date;
}

/** A research's records as the file the export answers: one canonical line a record and the signed trailer, in memory, since a research holds a few. */
async function exportFile(researchId: string, seqs: ReadonlyArray<number>): Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }> {
  const key = exportKeyFromPem(env.LEDGER_EXPORT_KEY);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 1 << 20,
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const trailer = await exportJsonl({ kind: "research", id: researchId, seqs }, sink, { key, now: () => new Date() });
  return { file: Buffer.concat(chunks), trailer };
}

/** The real door, engine, ledger and clock; a suite replaces what it doubles. */
export const defaultResearchEndpointDeps: ResearchEndpointDeps = {
  seed: readSeedFacts,
  open: createResearchConversation,
  conversation: readResearchConversation,
  conversationView: readResearchConversationView,
  runView: readResearchRunView,
  newestRun: newestConversationRun,
  running: (workflowId) => workflowRunning(RESEARCH_RUN_WORKFLOW, workflowId),
  abandon: abandonConversationRun,
  writeState: writeResearchState,
  gates: researchStartGates,
  budgetReset: latestBudgetReset,
  dailyLimit: dailyLimitUntil,
  configured: () => env.TEMPORAL_ADDRESS !== undefined && env.TEMPORAL_NAMESPACE !== undefined,
  release: async () => (await currentRelease()).id,
  chaptersPassed,
  secrets: processSecrets,
  createRun: createConversationRun,
  start: async (workflowId, input) => {
    await startWorkflow(RESEARCH_RUN_WORKFLOW, workflowId, input);
  },
  flag: flagResearchRun,
  remove: deleteResearchConversation,
  recorded: erasedRecordAt,
  append,
  records: researchRecordSeqs,
  exportFile,
  now: () => new Date(),
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to research");
  return session;
}

function conversationOf(row: ResearchConversationRow): ResearchConversation {
  return { id: row.id, locale: row.locale === "PT" ? "pt" : "en", seed: row.seedMessageId, createdAt: row.createdAt.toISOString() };
}

const unavailable = (): ApiError => new ApiError("RESEARCH_UNAVAILABLE", "research is not available here: the workflow engine is not running");
const inProgress = (): ApiError => new ApiError("RESEARCH_IN_PROGRESS", "a research is under way in this conversation; wait for it to end");

/**
 * How long a `QUEUED` run whose workflow the engine does not know is taken for a start still in flight (48 § 5.2 check
 * 3; review of unit 71). A start commits its row and then asks the engine to start the workflow, so a second start that
 * asks the engine in between finds none; ending that row would end a run whose start then answers 202, and whose
 * workflow would have run on it. A start's whole request — the engine asked at check 3 and at the start, each within
 * its five seconds (`WORKFLOWS_DEADLINE_MS`, lib/workflows/client.ts), and the reads between — ends well inside a
 * minute of the instant its row is stamped with, so a younger row is answered 409 and left alone. An older one was left
 * by a web tier that died between its commit and its start, and is ended.
 */
export const START_IN_FLIGHT_MS = 60_000;

/**
 * Which of the Assistant's two free rules refuses the question (48 § 5.2), in the order the section lists them: the
 * plant-equipment rule, then the unverified-chapter rule — a chapter the question names that has not passed
 * verification in the release, since the research reads verified chapters only, as the Assistant's retrieval does.
 * It is the reverse of `scopeRules`'s order, which asks the unverified chapter first: a question that is both is
 * `R-SCOPE-OT` here and `R-UNVERIFIED` in the Assistant (review of unit 71).
 */
async function refusalOf(deps: Pick<ResearchEndpointDeps, "chaptersPassed">, question: string, releaseId: string): Promise<"R-SCOPE-OT" | "R-UNVERIFIED" | null> {
  if (otRule(question).cause !== null) return "R-SCOPE-OT";
  if (!(await deps.chaptersPassed(releaseId, namedChaptersOf(referencesOf(question))))) return "R-UNVERIFIED";
  return null;
}

export function researchEndpoints(deps: ResearchEndpointDeps = defaultResearchEndpointDeps): {
  readonly researchConversationCreate: Spec<undefined, undefined, typeof ResearchConversationCreateSchema, typeof ResearchConversationSchema>;
  readonly researchConversationRead: Spec<typeof ConversationParamsSchema, undefined, undefined, typeof ResearchConversationViewSchema>;
  readonly researchConversationDelete: Spec<typeof ConversationParamsSchema, undefined, undefined, typeof ConversationDeletedSchema>;
  readonly researchRunStart: Spec<typeof ConversationParamsSchema, undefined, typeof ResearchRunPostSchema, typeof ResearchRunStartedSchema>;
  readonly researchRunRead: Spec<typeof ConversationParamsSchema, undefined, undefined, typeof ResearchRunViewSchema>;
  readonly researchRunFlag: Spec<typeof ConversationParamsSchema, undefined, typeof ResearchFlagPostSchema, typeof ResearchFlagSchema>;
  readonly researchConversationExport: Spec<typeof ConversationParamsSchema, undefined, undefined, typeof NoBodySchema>;
} {
  return {
    /**
     * A research opened (§ 13), 201: from scratch, or seeded from an Assistant answer of the caller's that answered and
     * still holds its words (A6). An answer that is another's, a refusal, gone or purged is `SEED_INVALID`, the same
     * for each, so another person's answer reads as invalid and never as existing. Nothing is spent: the seed is read,
     * not copied, when its first run plans.
     */
    researchConversationCreate: {
      path: "/api/v1/research/conversations",
      method: "POST",
      summary: "Open a research, from scratch or from an Assistant answer of one's own",
      auth: "session",
      body: ResearchConversationCreateSchema,
      response: ResearchConversationSchema,
      rateLimit: CREATE_RATE,
      policy: { action: "create", resource: ({ session }) => ownResource("research", null, requireUser(session)) },
      run: async ({ session, body }) => {
        const user = requireUser(session);
        const seedMessageId = body.seedMessageId ?? null;
        if (seedMessageId !== null && (await deps.seed(user, seedMessageId))?.answered !== true) {
          throw new ApiError("SEED_INVALID", "that answer cannot start a research: it is not an answer of yours that still holds its words", { field: "seedMessageId" });
        }
        const row = await deps.open(user, { locale: body.locale === "pt" ? "PT" : "EN", seedMessageId }, deps.now());
        return new Response(JSON.stringify(ResearchConversationSchema.parse(conversationOf(row))), { status: 201, headers: JSON_HEADERS });
      },
    },

    researchConversationRead: {
      path: "/api/v1/research/conversations/{id}",
      method: "GET",
      summary: "One research of one's own with its runs, each as the run's view",
      auth: "session",
      params: ConversationParamsSchema,
      response: ResearchConversationViewSchema,
      rateLimit: READ_RATE,
      policy: { action: "read", resource: ({ session, params }) => ownResource("research", params.id, requireUser(session)) },
      run: async ({ session, params }) => {
        const view = await deps.conversationView(requireUser(session), params.id, deps.now());
        if (view === null) throw new ApiError("NOT_FOUND", "no such research");
        return { ...conversationOf(view.conversation), textPurgedAt: view.conversation.textPurgedAt === null ? null : view.conversation.textPurgedAt.toISOString(), runs: [...view.runs] };
      },
    },

    /**
     * A person deletes a research (§ 17.2): the door detaches its runs with a workflow, without their text, and deletes
     * the rest in one transaction; then the endpoint appends the `ERASED` record, after the commit, so the ledger never
     * claims a deletion that did not happen, looked for by its step key first so one deletion is one record (spec 45
     * § 3.7). An append that fails leaves the deletion standing without it: `ledgerSeq` null, and the line names the
     * trace. A run under way does not hold it, since it is detached and stops at its next step: no 409. No body and
     * no Idempotency-Key: a second delete is the first's 404. 30 a minute, in a bucket of its own (spec 45 D7).
     */
    researchConversationDelete: {
      path: "/api/v1/research/conversations/{id}",
      method: "DELETE",
      summary: "Delete a research of one's own; a run under way stops at its next step; the audit chain keeps its records and records the deletion",
      auth: "session",
      params: ConversationParamsSchema,
      response: ConversationDeletedSchema,
      /* its own bucket: the path's read takes READ_RATE, and one bucket for both would clamp each to the other's rate (review of unit 62) */
      rateLimit: { ...CREATE_RATE, bucket: "DELETE /api/v1/research/conversations/{id}" },
      policy: { action: "delete", resource: ({ session, params }) => ownResource("research", params.id, requireUser(session)) },
      run: async ({ session, params, traceId }) => {
        const user = requireUser(session);
        const done = await deps.remove(user, params.id, deps.now());
        if (!done.deleted) throw new ApiError("NOT_FOUND", "no such research");
        const stepKey = researchErasedStepKeyOf(params.id);
        let ledgerSeq: number | null = null;
        try {
          const found = await deps.recorded(stepKey);
          ledgerSeq = (found ?? (await deps.append({ kind: "ERASED", actor: `user:${user.id}`, suggestionId: null, chapterVersionId: null, payload: { stepKey, scope: { kind: "research", id: params.id } } }))).seq;
        } catch (error: unknown) {
          /* the deletion stands without its record: a second delete is a 404 and cannot write it (45 § 3.7, § 9) */
          console.error("research deleted: its ERASED record was not appended", traceId, params.id, error instanceof Error ? error.message : String(error));
        }
        return { id: params.id, deleted: true as const, ledgerSeq };
      },
    },

    /** Start a run in a research (§ 5.2), 202: `QUEUED` with its workflow started, or `REFUSED` by a rule at no cost. */
    researchRunStart: {
      path: "/api/v1/research/conversations/{id}/runs",
      method: "POST",
      summary: "Start a research run with a question about the book; it plans, reads the web and writes a report on the person's own budget",
      auth: "session",
      params: ConversationParamsSchema,
      body: ResearchRunPostSchema,
      response: ResearchRunStartedSchema,
      /* 20 a minute, as the Assistant's ask: one run is several model calls (§ 13) */
      rateLimit: ASK_RATE,
      /* the stored first answer is replayed, after the research is looked up (spec 45 § 3.2's order) */
      idempotent: "endpoint",
      policy: { action: "ask", resource: ({ session, params }) => ownResource("research", params.id, requireUser(session)) },
      run: async ({ session, params, body, traceId, idempotency }) => {
        const user = requireUser(session);
        const now = deps.now();

        /* 1 the question's length: the composer's 800 characters */
        if (body.question.length > QUESTION_MAX) throw new ApiError("TEXT_TOO_LONG", `a question is at most ${String(QUESTION_MAX)} characters`);

        /* 2 the research is the caller's: another's reads as absent; then a replay of the same key answers its stored start */
        const conversation = await deps.conversation(user, params.id);
        if (conversation === null) throw new ApiError("NOT_FOUND", "no such research");
        const stored = idempotency?.replay ?? null;
        if (stored !== null) return new Response(JSON.stringify(stored.body), { status: stored.status, headers: JSON_HEADERS });

        /* 3 no run of it under way: the newest is the only one that can be, and the engine says whether it still runs — a
           workflow never started, terminated or closed at its 90 minutes leaves a row nothing moves, which is ended here */
        const newest = await deps.newestRun(user, params.id);
        if (newest !== null && !ENDED_STATES.includes(newest.state)) {
          let running: boolean;
          try {
            running = newest.workflowId !== null && (await deps.running(newest.workflowId));
          } catch (error: unknown) {
            if (error instanceof WorkflowsUnavailableError) throw unavailable();
            throw error;
          }
          if (running) throw inProgress();
          /* a QUEUED row this young may be another start's, committed, its engine call not yet arrived: left alone */
          if (newest.state === "QUEUED" && now.getTime() - newest.createdAt.getTime() < START_IN_FLIGHT_MS) throw inProgress();
          /* only as it was read: a row that moved since — its workflow took it, its start took it back, another start
             ended it — is not this start's to end; 409, and the next start reads it as it stands */
          const { written } = await deps.abandon(newest, now);
          if (!written) throw inProgress();
          console.warn("research run ended FAILED · ABANDONED: its workflow no longer runs", traceId, newest.id);
        }

        /* 4 and 5 the account's deletion request, the organisation's switch */
        const gates = await deps.gates(user);
        if (gates.deletionRequested) throw new ApiError("ACCOUNT_DELETION_REQUESTED", "this account is being deleted: nothing new can be started");
        if (!gates.organisation) throw new ApiError("RESEARCH_OFF_ORGANISATION", "research is off for your organisation");

        /* 6 the gateway's refusal remembered on the caller's latest run, while its reset is ahead (§ 7.2) */
        const reset = await deps.budgetReset(user);
        if (reset !== null && reset.getTime() > now.getTime()) throw new ApiError("BUDGET_EXCEEDED", "your model budget is spent until its reset", { resetsAt: reset.toISOString() });

        /* 7 thirty counted runs in 24 hours, with the instant the oldest leaves the window */
        const full = await deps.dailyLimit(user, now);
        if (full !== null) throw new ApiError("RESEARCH_DAILY_LIMIT", "30 researches were started in the last 24 hours", { resetsAt: full.toISOString() });

        /* 8 the engine configured */
        if (!deps.configured()) throw unavailable();

        /* the question redacted as the Assistant's turn redacts one, before it is stored or read (spec 21 § 6.2); the workers
           redact it again with their own secrets before any prompt (§ 5.1). Then the two free rules, on what is stored. */
        const question = redactSecrets(body.question, deps.secrets()).text;
        const releaseId = await deps.release();
        const refusal = await refusalOf(deps, question, releaseId);
        /* a seeded research's seed: whether the answer replaced a claim, the sections it cited (§ 4.2). Read for any start
           of it; the door gives it to the research's seeded run alone, which it decides under the lock (`isSeededRun`) */
        const seed = conversation.seedMessageId !== null ? await deps.seed(user, conversation.seedMessageId) : null;
        const created = await deps.createRun(user, { conversationId: params.id, releaseId, locale: body.language === "pt" ? "PT" : "EN", question, traceId, seed, refusal }, now);
        if (!created.created) {
          if (created.reason === "NOT_FOUND") throw new ApiError("NOT_FOUND", "no such research");
          if (created.reason === "IN_PROGRESS") throw inProgress();
          throw new ApiError("RESEARCH_DAILY_LIMIT", "30 researches were started in the last 24 hours", { resetsAt: created.resetsAt.toISOString() });
        }

        if (created.state === "QUEUED") {
          /* the engine after the commit; a start it refused takes the row back, uncounted, and says so (spec 41 § 13). No
             second start ends the row meanwhile: it is QUEUED and younger than START_IN_FLIGHT_MS (check 3). A request that
             outlived the minute is the one exception, and its workflow then finds the row ended and returns (§ 30) */
          try {
            await deps.start(created.workflowId, { runId: created.id, userId: user.id });
          } catch (error: unknown) {
            await deps.writeState({ id: created.id, userId: user.id }, "SKIPPED", { skip: "UNAVAILABLE" }, deps.now()).catch((undo: unknown) => {
              console.error("research start refused: its run could not be taken back", traceId, created.id, undo instanceof Error ? undo.message : String(undo));
            });
            if (error instanceof WorkflowsUnavailableError) throw unavailable();
            throw error;
          }
        }

        const answer: ResearchRunStarted = { runId: created.id, state: created.state };
        await idempotency?.complete(202, answer);
        return new Response(JSON.stringify(ResearchRunStartedSchema.parse(answer)), { status: 202, headers: JSON_HEADERS });
      },
    },

    /** A run of a research of one's own, as the page follows it every 2 s while it is under way (§ 6, § 16). */
    researchRunRead: {
      path: "/api/v1/research/runs/{id}",
      method: "GET",
      summary: "One research run of one's own: its line, its steps, its report, the pages it read and its findings",
      auth: "session",
      params: ConversationParamsSchema,
      response: ResearchRunViewSchema,
      rateLimit: READ_RATE,
      policy: { action: "read", resource: ({ session, params }) => ownResource("research", params.id, requireUser(session)) },
      run: async ({ session, params }) => {
        const view = await deps.runView(requireUser(session), params.id, deps.now());
        if (view === null) throw new ApiError("NOT_FOUND", "no such research run");
        return view;
      },
    },

    /**
     * A run's flag (§ 11.7): a label for the operator, one a run, no text. A second is 409 `FLAG_DUPLICATE`, the first
     * standing and read back in its `detail` (`{ kind, reason }`, both codes; § 18), whatever the run is now — a run the
     * 30 days took the report of keeps its flag (review of unit 71); a kind the run contradicts — a report on a run
     * with none, a refusal on a run that was not refused — is 422 `UNPROCESSABLE`.
     */
    researchRunFlag: {
      path: "/api/v1/research/runs/{id}/flag",
      method: "POST",
      summary: "Flag a research run's report or refusal with a coded reason, for the operator",
      auth: "session",
      params: ConversationParamsSchema,
      body: ResearchFlagPostSchema,
      response: ResearchFlagSchema,
      rateLimit: FLAG_RATE,
      policy: { action: "write", resource: ({ session, params }) => ownResource("research", params.id, requireUser(session)) },
      run: async ({ session, params, body }) => {
        const flagged = await deps.flag(requireUser(session), params.id, body.kind, body.reason, deps.now());
        if (!flagged.flagged) {
          if (flagged.reason === "NOT_FOUND") throw new ApiError("NOT_FOUND", "no such research run");
          if (flagged.reason === "DUPLICATE") throw new ApiError("FLAG_DUPLICATE", "this run is already flagged", { kind: flagged.stored.kind, reason: flagged.stored.reason });
          throw new ApiError("UNPROCESSABLE", body.kind === "report" ? "this run has no report to flag" : "this run was not refused");
        }
        return { runId: params.id, kind: body.kind, reason: body.reason, at: flagged.at.toISOString() };
      },
    },

    /**
     * A research's records, signed (§ 11.10; unit 73), as the Assistant's conversation export gives a conversation's
     * (spec 17 § 6): the `RESEARCH` records of its runs, each found by its step key, as JSONL with the signed trailer —
     * the records the ledger holds, hashes and counts, never the words, which are the person's on screen and which
     * `Copy report` carries. A research with none (its runs refused by a rule, or none answered by a planner) is 404
     * `NOTHING_TO_EXPORT`, as the catalogue answers the code for every export, said before the key is asked for, with or
     * without one. No key, no export: an unsigned file would look like a record (spec 14 § 7), so the person reads
     * `INTERNAL` and the log names the variable. The export is a record itself: an `EXPORT` by the person, scope
     * `{ kind: "research", id }`, with the file's own hash. A read that writes, so the pipeline holds it to the same
     * origin (`writes: true`), at the Assistant export's rate.
     */
    researchConversationExport: {
      path: "/api/v1/research/conversations/{id}/export",
      method: "GET",
      summary: "Download a research's ledger records as signed JSONL; the export is recorded",
      auth: "session",
      params: ConversationParamsSchema,
      response: NoBodySchema,
      rateLimit: EXPORT_RATE,
      writes: true,
      policy: { action: "export", resource: ({ session, params }) => ownResource("research", params.id, requireUser(session)) },
      run: async ({ session, params, traceId }) => {
        const user = requireUser(session);
        const seqs = await deps.records(user, params.id);
        if (seqs === null) throw new ApiError("NOT_FOUND", "no such research");
        if (seqs.length === 0) throw new ApiError("NOTHING_TO_EXPORT", "this research has no ledger record to export: none of its runs reached a model (feature-specs/48 § 11.10)");
        let exported: { readonly file: Buffer; readonly trailer: ExportTrailer };
        try {
          exported = await deps.exportFile(params.id, seqs);
        } catch (error: unknown) {
          if (error instanceof AppError && error.code === "LEDGER_EXPORT_EMPTY") throw new ApiError("NOTHING_TO_EXPORT", "this research has no ledger record to export");
          if (error instanceof AppError && (error.code === "LEDGER_KEY_MISSING" || error.code === "LEDGER_KEY_INVALID")) {
            console.error("export refused", traceId, error.message);
            throw new ApiError("INTERNAL", "the export key is not available");
          }
          throw error;
        }
        const { file, trailer } = exported;
        await deps.append({
          kind: "EXPORT",
          actor: `user:${user.id}`,
          suggestionId: null,
          chapterVersionId: null,
          payload: { scope: trailer.scope, fromSeq: trailer.fromSeq, toSeq: trailer.toSeq, records: trailer.records, headHash: trailer.headHash, fileSha256: createHash("sha256").update(file).digest("hex") },
        });
        return new Response(new Uint8Array(file), {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": `attachment; filename="hb-research-${params.id}.jsonl"`,
            "cache-control": "private, no-store",
          },
        });
      },
    },
  };
}

/** The endpoints as the routes serve them. */
export const { researchConversationCreate, researchConversationRead, researchConversationDelete, researchRunStart, researchRunRead, researchRunFlag, researchConversationExport } = researchEndpoints();
