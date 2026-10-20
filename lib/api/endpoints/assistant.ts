import { createHash } from "node:crypto";
import { Writable } from "node:stream";

import { checkInputs } from "@/lib/aids/apply";
import { findAid } from "@/lib/aids/index";
import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import { SSE_HEADERS, sseFromLines, sseOfStoredFinal } from "@/lib/api/sse";
import type { SessionUser } from "@/lib/auth/session";
import { ASK_PATH, contextProblem, createConversation, deleteConversation, getConversation, openTurn, recordFlag } from "@/lib/db/assistant";
import { erasedRecordAt, erasedStepKeyOf } from "@/lib/db/ledger";
import { readResearchView } from "@/lib/db/research";
import { currentRelease } from "@/lib/db/shared";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { append } from "@/lib/ledger/append";
import { exportJsonl, exportKeyFromPem } from "@/lib/ledger/export";
import { ownResource } from "@/lib/policy/input";
import {
  ConversationCreateSchema,
  ConversationDeletedSchema,
  ConversationParamsSchema,
  ConversationSchema,
  ConversationViewSchema,
  FlagPostSchema,
  FlagSchema,
  MessageParamsSchema,
  MessagePostSchema,
  NoBodySchema,
  QUESTION_MAX,
  SSE_EVENTS,
  SseFinalSchema,
  ResearchViewSchema,
} from "@/lib/schemas/api";
import { defaultWorkersDeps, workersStream, WorkersRefusedError, WorkersUnavailableError, type WorkersClientDeps } from "@/lib/workers/client";

/*
 * The assistant's JSON endpoints (feature-specs/15 § 5.1, § 5.2, § 5.4). The stream of § 5.3 is a route of its
 * own, because an SSE body is not a schema the pipeline can validate.
 *
 * Ownership is a policy fact *and* a tenant filter, and the two answer differently on purpose: the policy denies
 * an action on a resource the caller does not own, and the guard makes another reader's row invisible, so a
 * foreign id is a 404 rather than a 403. An id that answers 403 tells you it exists.
 */

/* The four rates a person's research takes too (feature-specs/48 § 13): reads, opening one, flagging, and asking. */
export const READ_RATE = { key: "user", limit: 60, windowS: 60 } as const;
export const CREATE_RATE = { key: "user", limit: 30, windowS: 60 } as const;
export const FLAG_RATE = { key: "user", limit: 10, windowS: 60 } as const;
/* 10 a minute per reader (feature-specs/17 D5): a download, policed like the rest. A suggestion's record export takes the same (35 § 5). */
export const EXPORT_RATE = { key: "user", limit: 10, windowS: 60 } as const;
/* 20 a minute per reader, the budget-gated rate of architecture § 3.4: one turn is several model calls. */
export const ASK_RATE = { key: "user", limit: 20, windowS: 60 } as const;

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use the assistant");
  return session;
}

export const conversationCreate: Spec<undefined, undefined, typeof ConversationCreateSchema, typeof ConversationSchema> = {
  path: "/api/v1/assistant/conversations",
  method: "POST",
  summary: "Open a conversation about the book",
  auth: "session",
  body: ConversationCreateSchema,
  response: ConversationSchema,
  rateLimit: CREATE_RATE,
  policy: { action: "create", resource: ({ session }) => ownResource("conversation", null, requireUser(session)) },
  run: async ({ session, body }) => {
    const row = await createConversation(requireUser(session), { locale: body.locale });
    return { ...row, createdAt: row.createdAt.toISOString() };
  },
};

export const conversationRead: Spec<typeof ConversationParamsSchema, undefined, undefined, typeof ConversationViewSchema> = {
  path: "/api/v1/assistant/conversations/{id}",
  method: "GET",
  summary: "One conversation with its turns",
  auth: "session",
  params: ConversationParamsSchema,
  response: ConversationViewSchema,
  rateLimit: READ_RATE,
  policy: { action: "read", resource: ({ session, params }) => ownResource("conversation", params.id, requireUser(session)) },
  run: async ({ session, params }) => {
    const view = await getConversation(requireUser(session), params.id);
    /* Another reader's id reads as absent, so this is the same answer for "never existed" and "not yours". */
    if (view === null) throw new ApiError("NOT_FOUND", "no such conversation");
    return {
      ...view,
      createdAt: view.createdAt.toISOString(),
      textPurgedAt: view.textPurgedAt === null ? null : view.textPurgedAt.toISOString(),
      messages: view.messages.map((message) => ({
        ...message,
        citations: [...message.citations],
        verdicts: [...message.verdicts],
        createdAt: message.createdAt.toISOString(),
      })),
    };
  },
};

/**
 * The research run that followed an answer (feature-specs/43 § 4.3; unit 60a): the line under the answer asks this
 * every 5 s while the run is not over, and stops at an end. The message's owner, by the policy's `read` on it; the
 * reader's own rows and the platform's marks, inside their context; a message with no run — a question, a refusal, a
 * turn from before research — is not found, and so is another reader's.
 */
export const messageResearch: Spec<typeof MessageParamsSchema, undefined, undefined, typeof ResearchViewSchema> = {
  path: "/api/v1/assistant/messages/{id}/research",
  method: "GET",
  summary: "The research run that followed an answer, as the line under it reads it",
  auth: "session",
  params: MessageParamsSchema,
  response: ResearchViewSchema,
  rateLimit: READ_RATE,
  policy: { action: "read", resource: ({ session, params }) => ownResource("message", params.id, requireUser(session)) },
  run: async ({ session, params }) => {
    const view = await readResearchView(requireUser(session), params.id);
    if (view === null) throw new ApiError("NOT_FOUND", "no research for this message");
    return view;
  },
};

export const messageFlag: Spec<typeof MessageParamsSchema, undefined, typeof FlagPostSchema, typeof FlagSchema> = {
  path: "/api/v1/assistant/messages/{id}/flag",
  method: "POST",
  summary: "Flag an answer or a refusal for the grader's calibration set",
  auth: "session",
  params: MessageParamsSchema,
  body: FlagPostSchema,
  response: FlagSchema,
  rateLimit: FLAG_RATE,
  policy: { action: "write", resource: ({ session, params }) => ownResource("message", params.id, requireUser(session)) },
  run: async ({ session, params, body }) => {
    const user = requireUser(session);
    try {
      const flag = await recordFlag(user, params.id, body.kind === "answer" ? "ANSWER" : "REFUSAL", body.reason);
      return { id: flag.id, messageId: params.id, kind: body.kind.toUpperCase(), reason: body.reason, createdAt: new Date().toISOString() };
    } catch (error: unknown) {
      /* One flag per reader per message: a second is a conflict, because a flag is a label and not a vote. */
      if (error instanceof AppError && error.code === "FLAG_DUPLICATE") throw new ApiError("FLAG_DUPLICATE", error.message);
      /* A label that contradicts the row is unprocessable rather than malformed: the body is valid, the row says
         otherwise, and a calibration set learns nothing from a flag that names the wrong kind (§ 5.4). */
      if (error instanceof AppError && error.code === "FLAG_KIND_MISMATCH") throw new ApiError("UNPROCESSABLE", error.message);
      if (error instanceof AppError && error.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", error.message);
      throw error;
    }
  },
};

/**
 * Ask in a conversation (§ 5.3): the one endpoint of the API whose body is a stream. Everything that can be
 * decided without the workers is decided first — the conversation is the caller's, its release is still current,
 * the previous turn is closed, the context is in the release — because once the stream is open a refusal can only
 * be an event, and an event carries no status code.
 *
 * The web tier writes nothing to the five tables (D4): it validates, forwards, and translates the workers' lines.
 * The workers' address is a parameter so a test can run them on a free port, as `lib/db/search.ts` does for the
 * query embedding; the route serves `messagePost`, which reads the environment.
 */
export function askEndpoint(workers: () => WorkersClientDeps = defaultWorkersDeps): Spec<typeof ConversationParamsSchema, undefined, typeof MessagePostSchema, typeof SseFinalSchema> {
  return {
    path: ASK_PATH,
    method: "POST",
    summary: "Ask a question in a conversation and stream the answer",
    auth: "session",
    params: ConversationParamsSchema,
    body: MessagePostSchema,
    /* The `final` event's data, and the events themselves for the document: this answers no JSON body (§ 7). */
    response: SseFinalSchema,
    events: SSE_EVENTS,
    rateLimit: ASK_RATE,
    idempotent: "endpoint",
    policy: { action: "ask", resource: ({ session, params }) => ownResource("conversation", params.id, requireUser(session)) },
    run: async ({ session, params, body, traceId, locale, idempotency }) => {
      const user = requireUser(session);

      /* The conversation first, then any replay: a final stored as its conversation was deleted is answered 404, never replayed (feature-specs/45 § 3.2). */
      const conversation = await getConversation(user, params.id);
      if (conversation === null) throw new ApiError("NOT_FOUND", "no such conversation");

      /* A replay of the same key answers the stored `final` alone: no model is asked the same question twice (D1). */
      const stored = idempotency?.replay ?? null;
      if (stored !== null) return new Response(sseOfStoredFinal(stored.body, ordinalOf(stored.body)), { status: 200, headers: { ...SSE_HEADERS } });

      if (body.text.length > QUESTION_MAX) throw new ApiError("TEXT_TOO_LONG", `a question is at most ${String(QUESTION_MAX)} characters`);

      /* A conversation pinned to a superseded release is read-only: its answers cite versions the reader can still
         open, and a new question would mix two editions of the book in one thread (§ 5.3). */
      const release = await currentRelease();
      if (release === null || release.id !== conversation.releaseId) throw new ApiError("RELEASE_CHANGED", "this conversation is pinned to an earlier release; open a new one");

      if ((await openTurn(user, params.id)) !== null) throw new ApiError("TURN_IN_PROGRESS", "the previous turn is still running");

      /* What each mode works on is picked for the turn (feature-specs/23 § 7.3): compare needs its pair, lab its lab,
         walk its aid. The conversation has no chapter to supply one, and explain and brief take none. */
      const context = body.context ?? null;
      if (body.mode === "compare" && context?.chapters === undefined) throw new ApiError("CONTEXT_INVALID", "compare needs the two chapters being compared", { field: "chapters" });
      if (body.mode === "lab" && context?.labId === undefined) throw new ApiError("CONTEXT_INVALID", "lab mode needs a lab", { field: "labId" });
      const problem = await contextProblem(conversation.releaseId, context);
      if (problem !== null) throw new ApiError("CONTEXT_INVALID", problem.message, { field: problem.field, ...(problem.chapter === undefined ? {} : { chapter: problem.chapter }) });

      /* walk mode (feature-specs/18 § 6): any aid the release has, and every input must sit in its declared range.
         The field errors carry the range, so the form can say `between 100 and 100,000` beside the input rather
         than a sentence about the request. Nothing runs and nothing is written until both hold. The workers read
         the aid's chapter and section from the aid itself; a chapter that has not been verified refuses there. */
      let aid: { readonly id: string; readonly inputs: Readonly<Record<string, number>> } | null = null;
      if (body.mode === "walk") {
        const found = body.aidId === undefined ? null : findAid(body.aidId);
        if (found === null) throw new ApiError("AID_UNKNOWN", "walk mode needs one of the book's decision aids as aidId");
        const checked = checkInputs(found, body.aidInputs ?? {});
        if (checked.errors.length > 0) throw new ApiError("AID_INPUTS", "an input is outside the aid's ranges", { errors: checked.errors });
        aid = { id: found.id, inputs: checked.values };
      }

      /* Whose budget the turn spends: the reader's organisation, or the reader on an individual account (spec 11
         § 3.4). A signed-in reader always has one, which is why the assistant needs a session. */
      const principal = user.organisationId === null ? { userId: user.id } : { organisationId: user.organisationId };

      let lines: ReadableStream<Uint8Array>;
      try {
        lines = await workersStream(
          "/answer",
          {
            conversationId: params.id,
            user: { id: user.id, organisationId: user.organisationId, role: user.role, displayName: user.displayName, locale: user.locale },
            principal,
            text: body.text,
            mode: body.mode,
            context,
            aid,
          },
          { traceId },
          workers(),
        );
      } catch (error: unknown) {
        /* Nothing has been written to the reader yet, so these two are still status codes rather than events. */
        if (error instanceof WorkersRefusedError && error.code === "GATEWAY_BUDGET") throw new ApiError("BUDGET_EXCEEDED", error.message);
        if (error instanceof WorkersUnavailableError) throw new ApiError("ASSISTANT_UNAVAILABLE", "the assistant is unavailable");
        throw error;
      }

      /* The turn's outcome is stored from the stream: a replay of the key answers this same event (§ 5.3, D1). */
      const stream = sseFromLines(lines, { locale, traceId, onFinal: async (data) => idempotency?.complete(200, data) });
      return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
    },
  };
}

/** What the conversation's delete asks of the door and the ledger: the endpoint's seams, for its tests. */
export interface ConversationDeleteDeps {
  readonly remove: typeof deleteConversation;
  /** The `ERASED` record already appended under the step key, if one was. */
  readonly recorded: (stepKey: string) => Promise<{ readonly seq: number } | null>;
  readonly append: (input: Parameters<typeof append>[0]) => Promise<{ readonly seq: number }>;
  readonly now: () => Date;
}

const DELETE_DEPS: ConversationDeleteDeps = { remove: deleteConversation, recorded: erasedRecordAt, append, now: () => new Date() };

/**
 * A reader deletes a conversation (feature-specs/45 § 3.2, D1; unit 62h): the door deletes its rows in one transaction
 * (§ 3.3), then the endpoint appends the `ERASED` record, after the commit, so the ledger never claims a deletion that
 * did not happen (§ 3.7). The record is looked for by its step key first, so one deletion is one record. An append
 * that fails leaves the deletion standing without it: `ledgerSeq` null, and the line names the trace. No body and no
 * Idempotency-Key: a second delete is the first's 404. Another reader's id reads as absent, so it is 404 too; a turn
 * that may still write is 409 `TURN_IN_PROGRESS` (§ 3.4). 30 a minute, as creating one (D7).
 */
export function conversationDeleteEndpoint(deps: ConversationDeleteDeps = DELETE_DEPS): Spec<typeof ConversationParamsSchema, undefined, undefined, typeof ConversationDeletedSchema> {
  return {
    path: "/api/v1/assistant/conversations/{id}",
    method: "DELETE",
    summary: "Delete a conversation of one's own, its rows with it; the audit chain keeps its records and records the deletion",
    auth: "session",
    params: ConversationParamsSchema,
    response: ConversationDeletedSchema,
    /* its own bucket: the path's read takes READ_RATE, and one bucket for both would clamp each to the other's rate (review of unit 62) */
    rateLimit: { ...CREATE_RATE, bucket: "DELETE /api/v1/assistant/conversations/{id}" },
    policy: { action: "delete", resource: ({ session, params }) => ownResource("conversation", params.id, requireUser(session)) },
    run: async ({ session, params, traceId }) => {
      const user = requireUser(session);
      const done = await deps.remove(user, params.id, deps.now());
      if (!done.deleted) {
        if (done.reason === "TURN_IN_PROGRESS") throw new ApiError("TURN_IN_PROGRESS", "the last answer is still being saved; delete it in a moment");
        throw new ApiError("NOT_FOUND", "no such conversation");
      }
      const stepKey = erasedStepKeyOf(params.id);
      let ledgerSeq: number | null = null;
      try {
        const found = await deps.recorded(stepKey);
        ledgerSeq = (found ?? (await deps.append({ kind: "ERASED", actor: `user:${user.id}`, suggestionId: null, chapterVersionId: null, payload: { stepKey, scope: { kind: "conversation", id: params.id } } }))).seq;
      } catch (error: unknown) {
        /* the deletion stands without its record: a second delete is a 404 and cannot write it (45 § 3.7, § 9) */
        console.error("conversation deleted: its ERASED record was not appended", traceId, params.id, error instanceof Error ? error.message : String(error));
      }
      return { id: params.id, deleted: true as const, ledgerSeq };
    },
  };
}

/** The endpoint as the route serves it. */
export const conversationDelete = conversationDeleteEndpoint();

/** The ordinal of a stored `final`, for the replay's event id; 0 when an older row has none. */
function ordinalOf(stored: unknown): number {
  const ordinal = typeof stored === "object" && stored !== null ? (stored as { ordinal?: unknown }).ordinal : undefined;
  return typeof ordinal === "number" ? ordinal : 0;
}

/** The endpoint as the route serves it: the workers at the address the environment names (feature-specs/11 § 8). */
export const messagePost = askEndpoint();

/**
 * The conversation's records, signed (feature-specs/17 § 6; 14 § 5.2). The reader gets exactly what the ledger
 * holds for their turns — hashes, citations, verdicts, timings — never the text, which is theirs already on screen.
 * The export itself is a record: an `EXPORT` line with the file's own hash joins the chain, so the file can be matched
 * to the moment it was written. A conversation whose every turn failed has nothing to sign and says so.
 */
export const conversationExport: Spec<typeof ConversationParamsSchema, undefined, undefined, typeof NoBodySchema> = {
  path: "/api/v1/assistant/conversations/{id}/export",
  method: "GET",
  summary: "Download a conversation's ledger records as signed JSONL",
  auth: "session",
  params: ConversationParamsSchema,
  response: NoBodySchema,
  rateLimit: EXPORT_RATE,
  writes: true,
  policy: { action: "read", resource: ({ session, params }) => ownResource("conversation", params.id, requireUser(session)) },
  run: async ({ session, params, traceId }) => {
    const user = requireUser(session);
    const view = await getConversation(user, params.id);
    if (view === null) throw new ApiError("NOT_FOUND", "no such conversation");
    const seqs = view.messages.flatMap((message) => (message.role === "ASSISTANT" && message.ledger !== null ? [message.ledger.seq] : []));
    if (seqs.length === 0) throw new ApiError("NOTHING_TO_EXPORT", "this conversation has no ledger record to export (feature-specs/17 § 6)");

    /* No key, no export: a deployment without the platform export key cannot sign, and an unsigned file would be a
       file that looks like a record (14 § 7). Its message names the variable for the operator; the reader sees INTERNAL. */
    let key: ReturnType<typeof exportKeyFromPem>;
    try {
      key = exportKeyFromPem(env.LEDGER_EXPORT_KEY);
    } catch (error: unknown) {
      console.error("export refused", traceId, error instanceof Error ? error.message : String(error));
      throw new ApiError("INTERNAL", "the export key is not available");
    }

    const chunks: Buffer[] = [];
    const sink = new Writable({
      highWaterMark: 1 << 20,
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });
    const trailer = await exportJsonl({ kind: "messages", id: params.id, seqs }, sink, { key, now: () => new Date() });
    const file = Buffer.concat(chunks);

    await append({
      kind: "EXPORT",
      actor: `user:${user.id}`,
      suggestionId: null,
      chapterVersionId: null,
      payload: { scope: trailer.scope, fromSeq: trailer.fromSeq, toSeq: trailer.toSeq, records: trailer.records, headHash: trailer.headHash, fileSha256: createHash("sha256").update(file).digest("hex") },
    });

    return new Response(file, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="hb-conversation-${params.id}.jsonl"`,
        "cache-control": "private, no-store",
      },
    });
  },
};
