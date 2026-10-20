import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { ALL_ENDPOINTS } from "@/lib/api/endpoints";
import { handler } from "@/lib/api/handler";
import { resolveDevUser } from "@/lib/auth/link";
import { hashToken } from "@/lib/auth/rules";
import { createSession, revokeAllSessions, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { erasedRecordAt, erasedStepKeyOf, researchErasedStepKeyOf } from "@/lib/db/ledger";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { BookmarkResultSchema, ChaptersListSchema, ErrorBodySchema, FigureDeriveSchema, MeSchema, MeSessionsSchema, NoteResultSchema, ReleaseCurrentSchema, ResearchConversationSchema, ResearchConversationViewSchema, ResearchFlagSchema, ResearchRunStartedSchema, ResearchRunViewSchema, SessionRevokedSchema } from "@/lib/schemas/api";
import { ChapterDataSchema } from "@/lib/schemas/chapter";
import { PathsDataSchema, PathViewSchema } from "@/lib/schemas/paths";
import { SearchDataSchema } from "@/lib/schemas/search";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { seedResearchPage } from "@/tests/fixtures/research/page";

import { POST as backchannel } from "@/app/api/v1/auth/backchannel-logout/route";
import { GET as authDev } from "@/app/api/v1/auth/dev/route";
import { GET as authLogin } from "@/app/api/v1/auth/login/route";
import { DELETE as bookmarkDelete, PUT as bookmarkPut } from "@/app/api/v1/bookmarks/[sectionId]/route";
import { GET as chapterByNumber } from "@/app/api/v1/chapters/[n]/route";
import { GET as chapters } from "@/app/api/v1/chapters/route";
import { GET as figureDerive } from "@/app/api/v1/figures/[id]/derive/route";
import { GET as me } from "@/app/api/v1/me/route";
import { POST as conversationCreate } from "@/app/api/v1/assistant/conversations/route";
import { DELETE as conversationDelete, GET as conversationRead } from "@/app/api/v1/assistant/conversations/[id]/route";
import { POST as messageFlag } from "@/app/api/v1/assistant/messages/[id]/flag/route";
import { DELETE as meSessionDelete } from "@/app/api/v1/me/sessions/[id]/route";
import { GET as meSessions } from "@/app/api/v1/me/sessions/route";
import { DELETE as noteDelete, PUT as notePut } from "@/app/api/v1/notes/[sectionId]/route";
import { GET as researchExport } from "@/app/api/v1/research/conversations/[id]/export/route";
import { DELETE as researchDelete, GET as researchRead } from "@/app/api/v1/research/conversations/[id]/route";
import { POST as researchRunStart } from "@/app/api/v1/research/conversations/[id]/runs/route";
import { POST as researchCreate } from "@/app/api/v1/research/conversations/route";
import { POST as researchFindingDraft } from "@/app/api/v1/research/findings/[id]/draft/route";
import { POST as researchFindingPropose } from "@/app/api/v1/research/findings/[id]/propose/route";
import { POST as researchRunFlag } from "@/app/api/v1/research/runs/[id]/flag/route";
import { GET as researchRunRead } from "@/app/api/v1/research/runs/[id]/route";
import { PUT as pathProgress } from "@/app/api/v1/paths/[path]/progress/route";
import { GET as paths } from "@/app/api/v1/paths/route";
import { GET as releasesCurrent } from "@/app/api/v1/releases/current/route";
import { GET as search } from "@/app/api/v1/search/route";
import { GET as sectionById } from "@/app/api/v1/sections/[id]/route";

/*
 * Contract tests (architecture § 10; feature-specs/09 § 14.3, § 14.4): every
 * Phase 1 endpoint against its schema, the error body, the rate-limit headers,
 * cross-user denies. Needs the database and an OPA sidecar (OPA_URL).
 */
const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined;

const EMAIL_A = "contract-a@harness-bible.local";
const EMAIL_B = "contract-b@harness-bible.local";
const IP = "203.0.113.10";
const base = "http://localhost:3000";

let userA: SessionUser;
let userB: SessionUser;
let tokenA = "";
let tokenA2 = "";
let tokenB = "";

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
function req(path: string, init: RequestInit & { token?: string; ip?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", init.ip ?? IP);
  if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  if (init.token !== undefined) headers.set("cookie", `hb.session=${init.token}`);
  return new Request(`${base}${path}`, { ...init, headers });
}
const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function cleanup(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.authEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.rateLimitBucket.deleteMany({ where: {} });
    for (const id of ids) {
      await withTenant({ userId: id, organisationId: null }, async () => {
        await prisma.bookmark.deleteMany({ where: {} });
        await prisma.note.deleteMany({ where: {} });
        await prisma.readingPathProgress.deleteMany({ where: {} });
        await prisma.idempotencyKey.deleteMany({ where: {} });
        await prisma.researchFinding.deleteMany({ where: {} });
        await prisma.researchRun.deleteMany({ where: {} });
        await prisma.researchConversation.deleteMany({ where: {} });
        const messages = await prisma.message.findMany({ select: { id: true } });
        const messageIds = messages.map((message) => message.id);
        await prisma.flag.deleteMany({ where: { messageId: { in: messageIds } } });
        await prisma.citation.deleteMany({ where: { messageId: { in: messageIds } } });
        await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: messageIds } } });
        await prisma.message.deleteMany({ where: { id: { in: messageIds } } });
        await prisma.conversation.deleteMany({ where: {} });
      });
    }
    await prisma.identity.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

describe.skipIf(!ready)("the /api/v1 contract", () => {
  beforeAll(async () => {
    await cleanup();
    const a = await resolveDevUser(EMAIL_A, "en");
    const b = await resolveDevUser(EMAIL_B, "en");
    userA = { id: a.userId, organisationId: null, role: "READER", displayName: "A", locale: "en-GB", identityVerified: false, parts: [], sessionId: null };
    userB = { id: b.userId, organisationId: null, role: "READER", displayName: "B", locale: "en-GB", identityVerified: false, parts: [], sessionId: null };
    tokenA = await createSession(a.userId, { device: "edgeWindows", idpSessionId: null });
    tokenA2 = await createSession(a.userId, { device: "safariIphone", idpSessionId: null });
    tokenB = await createSession(b.userId, { device: "unknown", idpSessionId: null });
  });
  afterAll(async () => {
    await revokeAllSessions(userA).catch(() => 0);
    await revokeAllSessions(userB).catch(() => 0);
    await cleanup();
  });


  it("opens a conversation, reads it back, and keeps one reader's out of another's reach", async () => {
    const opened = await conversationCreate(req("/api/v1/assistant/conversations", { method: "POST", token: tokenA, ...json({ locale: "en" }) }));
    expect(opened.status).toBe(200);
    const conversation = (await opened.json()) as Record<string, unknown> & { id: string };
    /* A conversation belongs to a reader and a release (feature-specs/23 § 7.3): the answer names no chapter. */
    expect(Object.keys(conversation).sort()).toEqual(["createdAt", "id", "locale", "releaseId"]);

    const mine = await conversationRead(req(`/api/v1/assistant/conversations/${conversation.id}`, { token: tokenA }), params({ id: conversation.id }));
    expect(mine.status).toBe(200);
    expect((await mine.json()) as { messages: unknown[] }).toMatchObject({ id: conversation.id, messages: [] });

    /* Another reader gets 404, not 403: an id that answers 403 has told you it exists (§ 5.2). */
    const theirs = await conversationRead(req(`/api/v1/assistant/conversations/${conversation.id}`, { token: tokenB }), params({ id: conversation.id }));
    expect(theirs.status).toBe(404);

    const signedOut = await conversationRead(req(`/api/v1/assistant/conversations/${conversation.id}`), params({ id: conversation.id }));
    expect(signedOut.status).toBe(401);
  });

  it("deletes a conversation for its owner alone, at 30 a minute, with its ERASED record; holds one whose last answer may still write (feature-specs/45 § 3.2)", async () => {
    const opened = await conversationCreate(req("/api/v1/assistant/conversations", { method: "POST", token: tokenA, ...json({ locale: "en" }) }));
    const conversation = (await opened.json()) as { id: string };
    const path = `/api/v1/assistant/conversations/${conversation.id}`;

    /* a question asked a moment ago: the flow may still write, so the delete is held and nothing goes */
    await withTenant({ userId: userA.id, organisationId: null }, () =>
      getPrisma().message.create({ data: { userId: userA.id, conversationId: conversation.id, role: "USER", ordinal: 1, mode: "EXPLAIN", text: "A question.", traceId: "f".repeat(32) } }),
    );
    const held = await conversationDelete(req(path, { method: "DELETE", token: tokenA }), params({ id: conversation.id }));
    expect(held.status).toBe(409);
    expect(ErrorBodySchema.parse(await held.json())).toMatchObject({ code: "TURN_IN_PROGRESS" });
    expect(held.headers.get("RateLimit-Limit")).toBe("30");
    await withTenant({ userId: userA.id, organisationId: null }, () => getPrisma().message.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: new Date(Date.now() - 3_600_000) } }));

    /* another reader's delete, and none signed out: 404 and 401, and the conversation stands */
    expect((await conversationDelete(req(path, { method: "DELETE", token: tokenB }), params({ id: conversation.id }))).status).toBe(404);
    expect((await conversationDelete(req(path, { method: "DELETE" }), params({ id: conversation.id }))).status).toBe(401);
    expect((await conversationRead(req(path, { token: tokenA }), params({ id: conversation.id }))).status).toBe(200);

    /* the owner's: deleted, and recorded once in the chain, which the suites append to one at a time */
    const unlock = await acquire(LEDGER_LOCK);
    try {
      const deleted = await conversationDelete(req(path, { method: "DELETE", token: tokenA }), params({ id: conversation.id }));
      expect(deleted.status).toBe(200);
      const body = (await deleted.json()) as { id: string; deleted: boolean; ledgerSeq: number | null };
      const record = await erasedRecordAt(erasedStepKeyOf(conversation.id));
      expect(body).toEqual({ id: conversation.id, deleted: true, ledgerSeq: record?.seq });
      expect(record).toMatchObject({ kind: "ERASED", actor: `user:${userA.id}`, suggestionId: null, payload: { scope: { kind: "conversation", id: conversation.id } } });
    } finally {
      unlock();
    }
    expect((await conversationRead(req(path, { token: tokenA }), params({ id: conversation.id }))).status).toBe(404);
    expect((await conversationDelete(req(path, { method: "DELETE", token: tokenA }), params({ id: conversation.id }))).status).toBe(404);
  });

  it("opens a conversation with a language alone, and does not read a chapter an older client still sends", async () => {
    const noLocale = await conversationCreate(req("/api/v1/assistant/conversations", { method: "POST", token: tokenA, ...json({ chapter: 21 }) }));
    expect(noLocale.status).toBe(400);
    /* The dock of Assistant 1 sent its chapter and section; a page loaded before the deploy still does. Neither is
       read, so a chapter the book does not have is no longer an error: it is not looked at. */
    const older = await conversationCreate(req("/api/v1/assistant/conversations", { method: "POST", token: tokenA, ...json({ chapter: 99, section: "28.1", locale: "en" }) }));
    expect(older.status).toBe(200);
    expect(Object.keys((await older.json()) as Record<string, unknown>).sort()).toEqual(["createdAt", "id", "locale", "releaseId"]);
  });

  it("takes one flag per message and answers a second with a conflict", async () => {
    const opened = await conversationCreate(req("/api/v1/assistant/conversations", { method: "POST", token: tokenA, ...json({ chapter: 21, locale: "en" }) }));
    const conversation = (await opened.json()) as { id: string };
    const message = await withTenant({ userId: userA.id, organisationId: null }, async () =>
      getPrisma().message.create({
        data: { userId: userA.id, conversationId: conversation.id, role: "ASSISTANT", ordinal: 1, mode: "EXPLAIN", text: "An answer.", traceId: "f".repeat(32) },
        select: { id: true },
      }),
    );

    const first = await messageFlag(req(`/api/v1/assistant/messages/${message.id}/flag`, { method: "POST", token: tokenA, ...json({ kind: "answer", reason: "wrong_citation" }) }), params({ id: message.id }));
    expect(first.status).toBe(200);
    const second = await messageFlag(req(`/api/v1/assistant/messages/${message.id}/flag`, { method: "POST", token: tokenA, ...json({ kind: "answer", reason: "wrong_number" }) }), params({ id: message.id }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("FLAG_DUPLICATE");
  });

  it("refuses a flag whose kind contradicts the row, and another reader's message", async () => {
    const opened = await conversationCreate(req("/api/v1/assistant/conversations", { method: "POST", token: tokenA, ...json({ chapter: 21, locale: "en" }) }));
    const conversation = (await opened.json()) as { id: string };
    const answer = await withTenant({ userId: userA.id, organisationId: null }, async () =>
      getPrisma().message.create({
        data: { userId: userA.id, conversationId: conversation.id, role: "ASSISTANT", ordinal: 1, mode: "EXPLAIN", text: "An answer.", traceId: "f".repeat(32) },
        select: { id: true },
      }),
    );

    /* The body is valid and the row says otherwise: a calibration set learns nothing from the wrong label (§ 5.4). */
    const wrongKind = await messageFlag(req(`/api/v1/assistant/messages/${answer.id}/flag`, { method: "POST", token: tokenA, ...json({ kind: "refusal", reason: "should_not_refuse" }) }), params({ id: answer.id }));
    expect(wrongKind.status).toBe(422);

    /* Another reader's message reads as absent, as their conversation does. */
    const theirs = await messageFlag(req(`/api/v1/assistant/messages/${answer.id}/flag`, { method: "POST", token: tokenB, ...json({ kind: "answer", reason: "other" }) }), params({ id: answer.id }));
    expect(theirs.status).toBe(404);
  });

  it("takes the composer's 800 characters and no more, and an empty question at all", async () => {
    const { MessagePostSchema, QUESTION_MAX } = await import("@/lib/schemas/api");
    expect(QUESTION_MAX).toBe(800);
    expect(MessagePostSchema.safeParse({ text: "a".repeat(800), mode: "explain" }).success).toBe(true);
    expect(MessagePostSchema.safeParse({ text: "   ", mode: "explain" }).success).toBe(false);
    /* The cap itself is the endpoint's, so the reader is told `TEXT_TOO_LONG` and not a generic malformed body
       (§ 5.3); the stream suite posts an 801-character question and asserts the code. */
    expect(MessagePostSchema.safeParse({ text: "a".repeat(801), mode: "explain" }).success).toBe(true);
  });

  /* A person's research (feature-specs/48 § 13, § 14; unit 71), through the policy sidecar, which must serve
     policies/hb/research.rego. Only a question a rule refuses is started here, so no workflow reaches the engine. */
  it("opens a research for its owner alone, refuses a seed that is not theirs, and reads it back", async () => {
    const opened = await researchCreate(req("/api/v1/research/conversations", { method: "POST", token: tokenA, ...json({ locale: "en" }) }));
    expect(opened.status).toBe(201);
    expect(opened.headers.get("RateLimit-Limit")).toBe("30");
    const research = ResearchConversationSchema.parse(await opened.json());
    expect(research).toMatchObject({ locale: "en", seed: null });
    const path = `/api/v1/research/conversations/${research.id}`;

    const mine = await researchRead(req(path, { token: tokenA }), params({ id: research.id }));
    expect(mine.status).toBe(200);
    expect(mine.headers.get("RateLimit-Limit")).toBe("60");
    expect(ResearchConversationViewSchema.parse(await mine.json())).toMatchObject({ id: research.id, runs: [] });
    expect((await researchRead(req(path, { token: tokenB }), params({ id: research.id }))).status).toBe(404);
    expect((await researchRead(req(path), params({ id: research.id }))).status).toBe(401);

    const foreignSeed = await researchCreate(req("/api/v1/research/conversations", { method: "POST", token: tokenB, ...json({ locale: "en", seedMessageId: research.id }) }));
    expect(foreignSeed.status).toBe(422);
    expect(ErrorBodySchema.parse(await foreignSeed.json())).toMatchObject({ code: "SEED_INVALID" });
  });

  /* The start answers 503 RESEARCH_UNAVAILABLE before any rule while no engine is configured (architecture: "Unset =
     nothing that needs a workflow runs"), so the refusal is reached only where one is, as tests/integration/evidence.test.ts's engine half is. */
  it.skipIf(env.TEMPORAL_ADDRESS === undefined || env.TEMPORAL_NAMESPACE === undefined)("starts a run a rule refuses with no workflow, replays the same key's start, follows and flags it, and deletes the research with its ERASED record", async () => {
    const opened = await researchCreate(req("/api/v1/research/conversations", { method: "POST", token: tokenA, ...json({ locale: "en" }) }));
    const research = ResearchConversationSchema.parse(await opened.json());
    const runsPath = `/api/v1/research/conversations/${research.id}/runs`;
    const key = "7b2c1d8c-6a2e-4b7f-9c3d-1e2f3a4b5c71"; // gitleaks:allow: a test idempotency key
    const ask = (token: string, body: unknown, idempotencyKey = key) => researchRunStart(req(runsPath, { method: "POST", token, ...json(body), headers: { "content-type": "application/json", "idempotency-key": idempotencyKey } }), params({ id: research.id }));
    const question = { question: "How do I bypass the interlock on the compressor during a retry storm?", language: "en" };

    const long = await ask(tokenA, { question: "a".repeat(801), language: "en" }, "7b2c1d8c-6a2e-4b7f-9c3d-1e2f3a4b5c72");
    expect(long.status).toBe(400);
    expect(ErrorBodySchema.parse(await long.json())).toMatchObject({ code: "TEXT_TOO_LONG" });
    expect((await ask(tokenB, question, "7b2c1d8c-6a2e-4b7f-9c3d-1e2f3a4b5c73")).status).toBe(404);

    const started = await ask(tokenA, question);
    expect(started.status).toBe(202);
    expect(started.headers.get("RateLimit-Limit")).toBe("20");
    const run = ResearchRunStartedSchema.parse(await started.json());
    expect(run.state).toBe("REFUSED");
    const replayed = await ask(tokenA, question);
    expect(replayed.status).toBe(202);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replayed.json()).toEqual(run);

    const runPath = `/api/v1/research/runs/${run.runId}`;
    const view = await researchRunRead(req(runPath, { token: tokenA }), params({ id: run.runId }));
    expect(view.status).toBe(200);
    expect(ResearchRunViewSchema.parse(await view.json())).toMatchObject({ id: run.runId, state: "REFUSED", refusal: { cause: "R-SCOPE-OT" } });
    expect((await researchRunRead(req(runPath, { token: tokenB }), params({ id: run.runId }))).status).toBe(404);

    const flagged = await researchRunFlag(req(`${runPath}/flag`, { method: "POST", token: tokenA, ...json({ kind: "refusal", reason: "should_not_refuse" }) }), params({ id: run.runId }));
    expect(flagged.status).toBe(200);
    expect(flagged.headers.get("RateLimit-Limit")).toBe("10");
    expect(ResearchFlagSchema.parse(await flagged.json())).toMatchObject({ runId: run.runId, kind: "refusal", reason: "should_not_refuse" });
    const again = await researchRunFlag(req(`${runPath}/flag`, { method: "POST", token: tokenA, ...json({ kind: "refusal", reason: "other" }) }), params({ id: run.runId }));
    expect(again.status).toBe(409);
    expect(ErrorBodySchema.parse(await again.json())).toMatchObject({ code: "FLAG_DUPLICATE" });

    /* the export (48 § 11.10; unit 73): a run a rule refused has no record, so there is nothing to sign, whatever the key;
       another reader's research is not found; a read that writes is refused from another site; at the export's rate */
    const exportPath = `/api/v1/research/conversations/${research.id}/export`;
    const nothing = await researchExport(req(exportPath, { token: tokenA }), params({ id: research.id }));
    expect(nothing.status).toBe(404);
    expect(nothing.headers.get("RateLimit-Limit")).toBe("10");
    expect(ErrorBodySchema.parse(await nothing.json())).toMatchObject({ code: "NOTHING_TO_EXPORT" });
    const foreignExport = await researchExport(req(exportPath, { token: tokenB }), params({ id: research.id }));
    expect(ErrorBodySchema.parse(await foreignExport.json())).toMatchObject({ code: "NOT_FOUND" });
    expect((await researchExport(req(exportPath, { token: tokenA, headers: { "sec-fetch-site": "cross-site" } }), params({ id: research.id }))).status).toBe(403);

    const path = `/api/v1/research/conversations/${research.id}`;
    expect((await researchDelete(req(path, { method: "DELETE", token: tokenB }), params({ id: research.id }))).status).toBe(404);
    const unlock = await acquire(LEDGER_LOCK);
    try {
      const deleted = await researchDelete(req(path, { method: "DELETE", token: tokenA }), params({ id: research.id }));
      expect(deleted.status).toBe(200);
      expect(deleted.headers.get("RateLimit-Limit")).toBe("30");
      const record = await erasedRecordAt(researchErasedStepKeyOf(research.id));
      expect(await deleted.json()).toEqual({ id: research.id, deleted: true, ledgerSeq: record?.seq });
      expect(record).toMatchObject({ kind: "ERASED", actor: `user:${userA.id}`, suggestionId: null, payload: { scope: { kind: "research", id: research.id } } });
    } finally {
      unlock();
    }
    expect((await researchRead(req(path, { token: tokenA }), params({ id: research.id }))).status).toBe(404);
    expect((await researchRunRead(req(runPath, { token: tokenA }), params({ id: run.runId }))).status).toBe(404);
    expect((await ask(tokenA, question, "7b2c1d8c-6a2e-4b7f-9c3d-1e2f3a4b5c74")).status).toBe(404);
  });

  /* A finding turned into an improvement (feature-specs/48 § 8, § 13, § 14; unit 74), through the policy sidecar, which
     must serve policies/hb/research.rego's `finding` rule. Nothing here starts a workflow: the send that the policy lets
     through is of a finding already used, and the draft that the policy lets through is of a finding that is not there. */
  it("lets a reader send only a finding of their own, refuses a verified contributor's send by the policy and a reader's draft by the role", async () => {
    const seed = await seedResearchPage(userA);
    const used = await withTenant({ userId: userA.id, organisationId: null }, () => getPrisma().researchFinding.findFirstOrThrow({ where: { run: { conversationId: seed.done }, outcome: "DUPLICATE" }, select: { id: true } }));
    const valid = await withTenant({ userId: userA.id, organisationId: null }, () => getPrisma().researchFinding.findFirstOrThrow({ where: { run: { conversationId: seed.done }, outcome: "VALID" }, select: { id: true } }));
    const key = () => crypto.randomUUID();
    const send = (token: string, id: string, idempotencyKey: string | null = key()) =>
      researchFindingPropose(req(`/api/v1/research/findings/${id}/propose`, { method: "POST", token, body: "{}", headers: { "content-type": "application/json", ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }) } }), params({ id }));
    const draft = (token: string, id: string) => researchFindingDraft(req(`/api/v1/research/findings/${id}/draft`, { method: "POST", token, ...json({ locale: "en" }), headers: { "content-type": "application/json", "idempotency-key": key() } }), params({ id }));

    /* the owner's send, past the policy: a finding already used is 409, with its use */
    const usedSend = await send(tokenA, used.id);
    expect(usedSend.status).toBe(409);
    expect(usedSend.headers.get("RateLimit-Limit")).toBe("20");
    expect(ErrorBodySchema.parse(await usedSend.json())).toMatchObject({ code: "FINDING_USED", detail: { use: "DUPLICATE", suggestionId: null } });
    /* another reader's finding is not found, never forbidden; no key is refused before anything */
    expect(ErrorBodySchema.parse(await (await send(tokenB, valid.id)).json())).toMatchObject({ code: "NOT_FOUND" });
    expect(ErrorBodySchema.parse(await (await send(tokenA, valid.id, null)).json())).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

    /* a reader drafts nothing: the role, before the policy */
    const readerDraft = await draft(tokenA, valid.id);
    expect(readerDraft.status).toBe(403);
    expect(ErrorBodySchema.parse(await readerDraft.json())).toMatchObject({ code: "ROLE_REQUIRED" });

    /* a verified contributor drafts and is refused the send by the policy; their draft passes it, to a finding not there */
    await withSystem(() => getPrisma().user.update({ where: { id: userA.id }, data: { role: "CONTRIBUTOR", identityVerified: true } }));
    try {
      const contributorSend = await send(tokenA, valid.id);
      expect(contributorSend.status).toBe(403);
      expect(ErrorBodySchema.parse(await contributorSend.json())).toMatchObject({ code: "FORBIDDEN" });
      const absent = await draft(tokenA, "00000000-0000-4000-8000-00000000f074");
      expect(absent.status).toBe(404);
      expect(absent.headers.get("RateLimit-Limit")).toBe("20");
      expect(ErrorBodySchema.parse(await absent.json())).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await withSystem(() => getPrisma().user.update({ where: { id: userA.id }, data: { role: "READER", identityVerified: false } }));
    }
    expect(await withTenant({ userId: userA.id, organisationId: null }, () => getPrisma().researchFinding.findUniqueOrThrow({ where: { id: valid.id }, select: { outcome: true, failure: true } }))).toEqual({ outcome: "VALID", failure: null });
  });

  it("registers every endpoint once with a path, a method and a policy", () => {
    const keys = ALL_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("GET /api/v1/releases/current");
    expect(ALL_ENDPOINTS.every((e) => e.policy.action.length > 0 && e.summary.length > 0)).toBe(true);
  });

  it("serves the public content endpoints with the schema, the headers and the public cache rule", async () => {
    const r = await releasesCurrent(req("/api/v1/releases/current"));
    expect(r.status).toBe(200);
    expect(ReleaseCurrentSchema.safeParse(await r.json()).success).toBe(true);
    expect(r.headers.get("traceparent")).toMatch(/^00-/);
    expect(r.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(r.headers.get("RateLimit-Limit")).toBe("120");
    expect(Number(r.headers.get("RateLimit-Remaining"))).toBeLessThan(120);

    const list = await chapters(req("/api/v1/chapters?lang=pt"));
    const listBody = ChaptersListSchema.parse(await list.json());
    expect(listBody.count).toBe(41);

    const ch = await chapterByNumber(req("/api/v1/chapters/21"), params({ n: "21" }));
    expect(ch.status).toBe(200);
    const chBody = ChapterDataSchema.parse(await ch.json());
    expect(chBody.section.id).toBe("21.1");
    expect((await chapterByNumber(req("/api/v1/chapters/99"), params({ n: "99" }))).status).toBe(404);
    const bad = await chapterByNumber(req("/api/v1/chapters/abc"), params({ n: "abc" }));
    expect(bad.status).toBe(400);
    expect(ErrorBodySchema.parse(await bad.json())).toMatchObject({ code: "INVALID_INPUT" });

    const sec = await sectionById(req("/api/v1/sections/21.3"), params({ id: "21.3" }));
    expect(ChapterDataSchema.parse(await sec.json()).section.id).toBe("21.3");
    expect((await sectionById(req("/api/v1/sections/99.9"), params({ id: "99.9" }))).status).toBe(404);
    expect((await sectionById(req("/api/v1/sections/21.0"), params({ id: "21.0" }))).status).toBe(400);
  });

  it("answers the derive endpoint with 200, 409 and 404", async () => {
    const derived = await getPrisma().figure.findFirst({ where: { derive: { isNot: null }, section: { chapterVersion: { release: { isCurrent: true } } } }, select: { anchor: true } });
    const plain = await getPrisma().figure.findFirst({ where: { derive: null, section: { chapterVersion: { release: { isCurrent: true } } } }, select: { anchor: true } });
    expect(derived).not.toBeNull();
    expect(plain).not.toBeNull();
    const ok = await figureDerive(req(`/api/v1/figures/${derived?.anchor}/derive`), params({ id: derived?.anchor ?? "" }));
    expect(ok.status).toBe(200);
    expect(FigureDeriveSchema.safeParse(await ok.json()).success).toBe(true);
    const not = await figureDerive(req(`/api/v1/figures/${plain?.anchor}/derive`), params({ id: plain?.anchor ?? "" }));
    expect(not.status).toBe(409);
    expect((await not.json()).code).toBe("NOT_DERIVED");
    expect((await figureDerive(req("/api/v1/figures/F-99-99/derive"), params({ id: "F-99-99" }))).status).toBe(404);
  });

  it("searches", async () => {
    const r = await search(req("/api/v1/search?q=idempotency&layer=2"));
    expect(r.status).toBe(200);
    const body = SearchDataSchema.parse(await r.json());
    expect(body.count).toBeGreaterThan(0);
    expect(body.filters.layer).toEqual([2]);
  });

  it("gates the reader state on a session and keeps users apart", async () => {
    expect((await paths(req("/api/v1/paths"))).status).toBe(401);
    const anon = await bookmarkPut(req("/api/v1/bookmarks/21.3", { method: "PUT" }), params({ sectionId: "21.3" }));
    expect(anon.status).toBe(401);
    expect(ErrorBodySchema.parse(await anon.json()).code).toBe("NO_SESSION");

    const listed = await paths(req("/api/v1/paths?lang=en", { token: tokenA }));
    expect(listed.status).toBe(200);
    expect(PathsDataSchema.parse(await listed.json()).signedIn).toBe(true);

    const progress = await pathProgress(req("/api/v1/paths/builder/progress", { method: "PUT", token: tokenA, ...json({ sectionId: "16.2" }) }), params({ path: "builder" }));
    expect(progress.status).toBe(200);
    const view = PathViewSchema.parse(await progress.json());
    expect(view.key).toBe("builder");
    expect(view.startedAt).not.toBeNull();

    const put = await bookmarkPut(req("/api/v1/bookmarks/21.3", { method: "PUT", token: tokenA }), params({ sectionId: "21.3" }));
    expect(BookmarkResultSchema.parse(await put.json())).toEqual({ sectionId: "21.3", bookmarked: true });
    expect(put.headers.get("RateLimit-Limit")).toBe("60");
    expect(put.headers.get("cache-control")).toBe("no-store");
    const again = await bookmarkPut(req("/api/v1/bookmarks/21.3", { method: "PUT", token: tokenA }), params({ sectionId: "21.3" }));
    expect((await again.json()).bookmarked).toBe(true);
    const asB = await bookmarkDelete(req("/api/v1/bookmarks/21.3", { method: "DELETE", token: tokenB }), params({ sectionId: "21.3" }));
    expect((await asB.json()).bookmarked).toBe(false);
    const stillA = await withTenant({ userId: userA.id, organisationId: null }, () => getPrisma().bookmark.count({ where: { sectionId: "21.3" } }));
    expect(stillA).toBe(1);
    const del = await bookmarkDelete(req("/api/v1/bookmarks/21.3", { method: "DELETE", token: tokenA }), params({ sectionId: "21.3" }));
    expect((await del.json()).bookmarked).toBe(false);

    const crossSite = await bookmarkPut(req("/api/v1/bookmarks/21.3", { method: "PUT", token: tokenA, headers: { "sec-fetch-site": "cross-site" } }), params({ sectionId: "21.3" }));
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).code).toBe("BAD_ORIGIN");

    const note = await notePut(req("/api/v1/notes/21.3", { method: "PUT", token: tokenA, ...json({ body: "  Check key scope.  " }) }), params({ sectionId: "21.3" }));
    expect(NoteResultSchema.parse(await note.json()).note?.body).toBe("Check key scope.");
    const long = await notePut(req("/api/v1/notes/21.3", { method: "PUT", token: tokenA, ...json({ body: "x".repeat(2001) }) }), params({ sectionId: "21.3" }));
    expect(long.status).toBe(400);
    const text = await notePut(req("/api/v1/notes/21.3", { method: "PUT", token: tokenA, body: "x", headers: { "content-type": "text/plain" } }), params({ sectionId: "21.3" }));
    expect(text.status).toBe(415);
    const gone = await noteDelete(req("/api/v1/notes/21.3", { method: "DELETE", token: tokenA }), params({ sectionId: "21.3" }));
    expect((await gone.json()).deleted).toBe(true);
  });

  it("serves /me and denies a foreign session revoke through the policy, with an audit row", async () => {
    const who = await me(req("/api/v1/me", { token: tokenA }));
    expect(MeSchema.parse(await who.json()).email).toBe(EMAIL_A);
    const sessions = await meSessions(req("/api/v1/me/sessions", { token: tokenA }));
    const list = MeSessionsSchema.parse(await sessions.json());
    expect(list.count).toBe(2);
    expect(list.items.filter((s) => s.current)).toHaveLength(1);

    const foreign = await meSessionDelete(req(`/api/v1/me/sessions/${hashToken(tokenB)}`, { method: "DELETE", token: tokenA }), params({ id: hashToken(tokenB) }));
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).code).toBe("FORBIDDEN");
    const denied = await withSystem(() => getPrisma().authEvent.findFirst({ where: { userId: userA.id, kind: "policy_denied" }, orderBy: { createdAt: "desc" } }));
    expect(denied?.detail).toMatchObject({ action: "revoke", resource: "session", reason: "policy_deny" });
    expect(denied?.ipHash).toHaveLength(32);
    expect(denied?.userAgent).toBe("unknown");
    expect((await me(req("/api/v1/me", { token: tokenB }))).status).toBe(200);

    const own = await meSessionDelete(req(`/api/v1/me/sessions/${hashToken(tokenA2)}`, { method: "DELETE", token: tokenA }), params({ id: hashToken(tokenA2) }));
    expect(SessionRevokedSchema.parse(await own.json())).toEqual({ id: hashToken(tokenA2), revoked: true });
    expect((await me(req("/api/v1/me", { token: tokenA2 }))).status).toBe(401);
  });

  it("rate-limits the login route at 10 per minute per address", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 11; i += 1) last = await authLogin(req("/api/v1/auth/login?idp=google", { ip: "198.51.100.7" }));
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(last?.headers.get("RateLimit-Remaining")).toBe("0");
    expect(ErrorBodySchema.parse(await last?.json()).code).toBe("RATE_LIMITED");
    const other = await authLogin(req("/api/v1/auth/login?idp=google", { ip: "198.51.100.8" }));
    expect(other.status).toBe(302);
    expect(other.headers.get("location")).toContain("/en/login?error=provider");
  });

  it("answers the back-channel route with an empty 200 and signs in through the dev provider with a cookie", async () => {
    const bc = await backchannel(req("/api/v1/auth/backchannel-logout", { method: "POST", body: new URLSearchParams({ logout_token: "x.y.z" }) }));
    expect(bc.status).toBe(200);
    expect(await bc.text()).toBe("");
    const dev = await authDev(req("/api/v1/auth/dev?email=contract-a%40harness-bible.local&next=/en/paths"));
    expect(dev.status).toBe(302);
    expect(dev.headers.get("location")).toBe(`${base}/en/paths`);
    const cookie = dev.headers.getSetCookie().find((c) => c.startsWith("hb.session="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    const signIn = await withSystem(() => getPrisma().authEvent.findFirst({ where: { userId: userA.id, kind: "sign_in" } }));
    expect(signIn?.detail).toMatchObject({ idp: "dev" });
  });

  it("replays an idempotent POST and refuses a different body under the same key", async () => {
    let runs = 0;
    const post = handler({
      path: "/api/v1/test/echo",
      method: "POST",
      summary: "test",
      auth: "session",
      body: z.object({ v: z.number() }),
      response: z.object({ v: z.number(), runs: z.number() }),
      idempotent: true,
      policy: { action: "write", resource: ({ session }) => ({ kind: "note", id: "test", ownerId: session?.id ?? null }) },
      run: async ({ body }) => {
        runs += 1;
        return { v: body.v, runs };
      },
    });
    const key = "0f2b1d8c-6a2e-4b7f-9c3d-1e2f3a4b5c6d"; // gitleaks:allow: a test idempotency key
    const first = await post(req("/api/v1/test/echo", { method: "POST", token: tokenA, ...json({ v: 1 }), headers: { "content-type": "application/json", "idempotency-key": key } }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ v: 1, runs: 1 });
    const second = await post(req("/api/v1/test/echo", { method: "POST", token: tokenA, ...json({ v: 1 }), headers: { "content-type": "application/json", "idempotency-key": key } }));
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual({ v: 1, runs: 1 });
    expect(runs).toBe(1);
    const other = await post(req("/api/v1/test/echo", { method: "POST", token: tokenA, ...json({ v: 2 }), headers: { "content-type": "application/json", "idempotency-key": key } }));
    expect(other.status).toBe(422);
    expect((await other.json()).code).toBe("IDEMPOTENCY_MISMATCH");
    const noKey = await post(req("/api/v1/test/echo", { method: "POST", token: tokenA, ...json({ v: 1 }) }));
    expect(noKey.status).toBe(400);
  });
});
