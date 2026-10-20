import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import { askEndpoint, conversationExport } from "@/lib/api/endpoints/assistant";
import { handler } from "@/lib/api/handler";
import { consumeToken } from "@/lib/api/ratelimit";
import { createSession, revokeAllSessions, tenantOf, type SessionUser } from "@/lib/auth/session";
import { resolveDevUser } from "@/lib/auth/link";
import { ASK_PATH, createConversation, deleteConversation, getConversation } from "@/lib/db/assistant";
import type { BudgetRowInput } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import type { Prisma } from "@/lib/db/generated/client";
import { head, range, toChainRecord } from "@/lib/db/ledger";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { ASSISTANT_GUIDE_VERSION, WITHHELD, type WalkModeResult } from "@/lib/schemas/assistant";
import { encryptKey } from "@/lib/gateway/keys";
import { ROUTE_TIMEOUT_MS } from "@/lib/workers/client";
import type { JsonValue } from "@/lib/ledger/canonical";
import { verifyExport } from "@/lib/ledger/export";
import { GENESIS_PREV_HASH, recordHash, sha256Hex } from "@/lib/ledger/hash";
import { verifyChain } from "@/lib/ledger/verify";
import { chaptersVerifiedFor } from "@/workers/answer/run";
import { runTurn } from "@/workers/answer/turn";
import { gatewayProbe } from "@/workers/health";
import { startWorkers, type RunningWorkers } from "@/workers/server";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";

/*
 * One turn end to end (feature-specs/15 § 9.3): the route handler of § 5.3, the workers of § 6.3 and the flow of
 * spec 13, over the real release with the stub gateway standing in for a provider. What this measures is the
 * stream's contract — the order of its events, that a refusal is a `final` at 200, that a failure after `meta`
 * leaves a failed turn and no ledger record, and that the rows and the `ANSWER` record say what was said.
 *
 * The workers run in this process on a free port and the endpoint is built to dial them, the way the search page's
 * suite points the query embedding at its own stub: nothing here depends on `WORKERS_URL`, and a workers process
 * running beside it is neither needed nor disturbed. The suite holds `LEDGER_LOCK`, because each answered turn
 * appends to the one development chain.
 */

const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined;

const MASTER_KEY = "assistant-stream-master-key";
const SECRET = "0123456789abcdef".repeat(4);
const EMAIL = "stream-a@harness-bible.local";
const EMAIL_B = "stream-b@harness-bible.local";
const IP = "203.0.113.42";
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const QUESTION = "Why does a retried write without an idempotency key become a second write?";
const OT_QUESTION = "How do I bypass the interlock on the furnace to keep the line running?";
const UUID = "00000000-0000-4000-8000-000000000000";
const WORKERS_TOKEN = "stream-suite-workers-token";
/* The walk (spec 18): chapter 21's aid at the book's inputs, and the user line the dock sends in place of a question.
   Chapter 37 is UNVERIFIED in release 2026.09, so its aid is the case that refuses (below), not the one that runs. */
const AID_ID = "21.8-task-survival";
const AID_INPUTS = { steps: 11, calls: 13, tokens_per_step: 7500 };
const WALK_TEXT = "Walk 21.8 with our inputs";
const CH37_AID = { aidId: "37.8-which-configuration", aidInputs: { qpd: 2000, tout: 400, tcache: 4000, esc: 10, route: 90 } };

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

/** `npm run assistant:purge -- --now <instant>` as a child process, as the ledger suite runs the export script. */
function runPurge(now: Date): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, "scripts/assistant-purge.ts", "--now", now.toISOString()], { cwd: APP_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

interface StreamEvent {
  readonly id: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** The events of one response, parsed as the dock's hook parses them: frames split on a blank line, comments ignored. */
async function eventsOf(response: Response): Promise<ReadonlyArray<StreamEvent>> {
  const body = await response.text();
  const out: StreamEvent[] = [];
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n").filter((line) => line.length > 0 && !line.startsWith(":"));
    if (lines.length === 0) continue;
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4) ?? "";
    const name = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
    out.push({ id, event: name, data: JSON.parse(data) as Record<string, unknown> });
  }
  return out;
}

describe.skipIf(!ready)("one assistant turn over the whole stack", () => {
  let stub: RunningStub;
  let workers: RunningWorkers;
  let release: () => void = () => undefined;
  let user: SessionUser;
  let other: SessionUser;
  let token = "";
  let tokenB = "";
  let keys = { value: "" };
  let ask: ReturnType<typeof handler>;
  /* The last case stops the workers on purpose, so the teardown must not stop them twice. */
  let running = false;
  /* What the purge case reads: the answered turn's conversation and record, and the turn left open. */
  let answered = { conversationId: "", seq: 0 };
  let abandoned = "";
  const fail: { value: string | null } = { value: null };
  /* The stub's walk switch: `invent` makes one explanation quote a number the script did not write (spec 18 § 12.4). */
  const walk: { value: string | null } = { value: null };
  const rows: BudgetRowInput[] = [];

  function gateway(): GatewayDeps {
    return {
      baseUrl: stub.url,
      keySecret: SECRET,
      findKey: async () => ({ keyCiphertext: encryptKey(SECRET, keys.value) }),
      append: async (row) => {
        rows.push(row);
      },
      log: () => undefined,
      /* The stub's failure switch, set by the case that needs the gateway to fail after `meta`. */
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        if (fail.value !== null) headers.set("x-hb-stub-fail", fail.value);
        if (walk.value !== null) headers.set("x-hb-stub-walk", walk.value);
        return globalThis.fetch(input, { ...init, headers });
      },
      now: () => new Date(),
    };
  }

  async function cleanup(): Promise<void> {
    await withSystem(async () => {
      const prisma = getPrisma();
      const users = await prisma.user.findMany({ where: { email: { in: [EMAIL, EMAIL_B] } }, select: { id: true } });
      for (const row of users) {
        await withTenant({ userId: row.id, organisationId: null }, async () => {
          const messages = await prisma.message.findMany({ select: { id: true } });
          const ids = messages.map((message) => message.id);
          await prisma.flag.deleteMany({ where: { messageId: { in: ids } } });
          await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
          await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
          await prisma.message.deleteMany({ where: { id: { in: ids } } });
          await prisma.conversation.deleteMany({});
          await prisma.idempotencyKey.deleteMany({});
        });
        await prisma.session.deleteMany({ where: { userId: row.id } });
        await prisma.authEvent.deleteMany({ where: { userId: row.id } });
        await prisma.identity.deleteMany({ where: { userId: row.id } });
      }
      await prisma.user.deleteMany({ where: { id: { in: users.map((row) => row.id) } } });
      await prisma.rateLimitBucket.deleteMany({});
    });
  }

  beforeAll(async () => {
    release = await acquire(LEDGER_LOCK);
    await cleanup();

    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: () => undefined });
    const minted = await fetch(`${stub.url}/key/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ models: [...ALIASES.keys()], max_budget: 50 }),
    });
    keys = { value: ((await minted.json()) as { key: string }).key };

    workers = await startWorkers({
      token: WORKERS_TOKEN,
      /* The key routes are not this suite's: the gateway deps carry the stub's minted key directly. */
      keys: {
        gatewayUrl: stub.url,
        masterKey: MASTER_KEY,
        keySecret: SECRET,
        individual: null,
        fetch: globalThis.fetch,
        now: () => new Date(),
        db: {
          findKey: async () => null,
          insertKey: () => {
            throw new Error("the key routes are not exercised by this suite");
          },
          replaceKey: () => {
            throw new Error("the key routes are not exercised by this suite");
          },
          organisationCaps: async () => null,
          isIndividualUser: async () => false,
        },
      },
      gateway: gateway(),
      probe: gatewayProbe({ gatewayUrl: stub.url, fetch: globalThis.fetch, now: () => new Date() }),
      keyCount: async () => 1,
      answer: async (body, emit, traceId) =>
        runTurn(
          {
            conversationId: body.conversationId,
            user: { id: body.user.id, organisationId: body.user.organisationId, role: "READER", displayName: body.user.displayName, locale: body.user.locale, identityVerified: false, parts: [], sessionId: null },
            principal: body.principal,
            text: body.text,
            mode: body.mode,
            context: body.context,
            aid: body.aid,
            traceId,
          },
          (event) => {
            emit(event);
          },
          {
            gateway: gateway(),
            chaptersVerified: chaptersVerifiedFor,
            /* The walk's script under the local interpreter: what the suite measures is the turn around the run, not the container. */
            aid: { runner: "python" },
          },
        ),
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
    });
    running = true;
    /* The endpoint the route serves, with the workers of this process in place of the environment's (§ 6.2). */
    ask = handler(askEndpoint(() => ({ baseUrl: workers.url, token: WORKERS_TOKEN, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS })));

    const a = await resolveDevUser(EMAIL, "en");
    const b = await resolveDevUser(EMAIL_B, "en");
    user = { id: a.userId, organisationId: null, role: "READER", displayName: "A", locale: "en", identityVerified: false, parts: [], sessionId: null };
    other = { id: b.userId, organisationId: null, role: "READER", displayName: "B", locale: "en", identityVerified: false, parts: [], sessionId: null };
    token = await createSession(a.userId, { device: "edgeWindows", idpSessionId: null });
    tokenB = await createSession(b.userId, { device: "unknown", idpSessionId: null });
  }, 120_000);

  afterAll(async () => {
    /* The lock is released whatever the teardown hits: one left behind would stall the next run (exclusive.ts). */
    try {
      await revokeAllSessions(user).catch(() => 0);
      await revokeAllSessions(other).catch(() => 0);
      await cleanup();
      if (running) await workers.close();
      await stub?.close();
    } finally {
      release();
    }
  });

  function post(conversationId: string, body: unknown, options: { readonly token?: string; readonly key?: string | null } = {}): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": IP });
    headers.set("cookie", `hb.session=${options.token ?? token}`);
    if (options.key !== null) headers.set("idempotency-key", options.key ?? crypto.randomUUID());
    const request = new Request(`http://localhost:3000/api/v1/assistant/conversations/${conversationId}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
    return ask(request, { params: Promise.resolve({ id: conversationId }) });
  }

  /** The ask limit is 20 a minute per reader (§ 5.3); the suite's later cases would spend it on their way, so they clear it first. */
  async function resetAsks(): Promise<void> {
    await withSystem(() => getPrisma().rateLimitBucket.deleteMany({ where: { key: `user:${user.id}:${ASK_PATH}` } }));
  }

  it("streams the turn in order and writes both rows and the ANSWER record, and hands nothing to research: no run row, no research in its final (48 § 9.2)", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const before = await head();
    const response = await post(conversation.id, { text: QUESTION, mode: "explain" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const events = await eventsOf(response);
    const names = events.map((event) => event.event);
    expect(names[0]).toBe("meta");
    expect(names.filter((name) => name === "final")).toHaveLength(1);
    expect(names.at(-1)).toBe("final");
    expect(names).not.toContain("error");
    /* Every event carries its own id: the ordinal and a counter, so a client can say what it saw (§ 6.1). */
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.every((event) => /^\d+\.\d+$/.test(event.id))).toBe(true);

    const meta = events[0]?.data ?? {};
    expect(meta).toMatchObject({ conversationId: conversation.id, ordinal: 1, mode: "explain", alias: "hb-frontier", guide: { version: ASSISTANT_GUIDE_VERSION } });
    expect(names.filter((name) => name === "status").length).toBeGreaterThan(0);
    expect(events.filter((event) => event.event === "status").map((event) => event.data.step)[0]).toBe("retrieving");
    expect(names.filter((name) => name === "token").length).toBeGreaterThan(0);

    const final = events.at(-1)?.data ?? {};
    expect(final.kind).toBe("answer");
    expect(Array.isArray(final.claims)).toBe(true);
    expect((final.verdicts as ReadonlyArray<unknown>).length).toBe(5);
    const ledger = final.ledger as { seq: number; hash: string; prevHash: string | null };
    expect(ledger.seq).toBeGreaterThan(before?.seq ?? 0);
    expect(ledger.hash).toMatch(/^[0-9a-f]{64}$/);

    /* The rows: the reader's question first, then the answer, with the citations and verdicts of the final event. */
    const view = await getConversation(user, conversation.id);
    expect(view?.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
    expect(view?.messages[0]?.text).toBe(QUESTION);
    expect(view?.messages[1]?.text).not.toBeNull();
    expect(view?.messages[1]?.ledger).toEqual({ seq: ledger.seq, hash: ledger.hash });
    expect(view?.messages[1]?.verdicts).toHaveLength(5);

    /* The record carries hashes of the words, never the words (invariant 18). */
    const record = await getPrisma().ledgerRecord.findUniqueOrThrow({ where: { seq: ledger.seq } });
    expect(record.kind).toBe("ANSWER");
    const payload = record.payload as Record<string, unknown>;
    expect(payload.questionSha256).toBe(sha256Hex(QUESTION));
    expect(payload.answerSha256).toBe(sha256Hex((final.claims as ReadonlyArray<{ text: string }>).map((claim) => claim.text).join(" ")));
    /* The record's place in the chain: the head this case found, and the hash the row carries. */
    expect(record.prevHash).toBe(before?.hash ?? null);
    expect(record.hash).toBe(ledger.hash);
    answered = { conversationId: conversation.id, seq: ledger.seq };
    expect(payload.messageId).toBe(view?.messages[1]?.id);
    expect(JSON.stringify(payload)).not.toContain("idempotency key");

    /* Since unit 75 nothing of research follows an answer (feature-specs/48 § 9.2): no `research` in the final event, no
       run row naming the answer — not even a skipped one — and so no line read back with the conversation. */
    expect(final).not.toHaveProperty("research");
    expect(await withTenant(tenantOf(user), () => getPrisma().researchRun.count({ where: { messageId: view?.messages[1]?.id ?? "" } }))).toBe(0);
    expect(view?.messages[1]?.research).toBeNull();
  }, 180_000);

  it("refuses an operations question as a final event at 200, without asking a model", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const spent = rows.length;
    const response = await post(conversation.id, { text: OT_QUESTION, mode: "explain" });

    expect(response.status).toBe(200);
    const events = await eventsOf(response);
    expect(events.map((event) => event.event)).not.toContain("token");
    const final = events.at(-1);
    expect(final?.event).toBe("final");
    expect(final?.data.kind).toBe("refusal");
    expect(final?.data.refusal).toMatchObject({ cause: "R-SCOPE-OT", beforeRetrieval: true });
    /* A rule refusal is decided before retrieval, so nothing was charged to anyone (spec 13 § 4.1). */
    expect(rows.length).toBe(spent);
  }, 60_000);

  it("replays the stored final for the same key and asks nothing a second time", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const key = crypto.randomUUID();
    const first = await eventsOf(await post(conversation.id, { text: QUESTION, mode: "explain" }, { key }));
    const replayed = await post(conversation.id, { text: QUESTION, mode: "explain" }, { key });

    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    const events = await eventsOf(replayed);
    expect(events.map((event) => event.event)).toEqual(["final"]);
    expect(events[0]?.data.messageId).toBe(first.at(-1)?.data.messageId);
    /* One turn, not two: the replay wrote no rows. */
    const view = await getConversation(user, conversation.id);
    expect(view?.messages).toHaveLength(2);

    /* A final stored in the instant after the delete forgot it is never replayed: the conversation is looked up first (feature-specs/45 § 3.2). */
    const kept = await withTenant(tenantOf(user), () => getPrisma().idempotencyKey.findFirstOrThrow({ where: { path: ASK_PATH, key }, select: { bodyHash: true, status: true, response: true } }));
    expect(await deleteConversation(user, conversation.id)).toMatchObject({ deleted: true, messages: 2, forgotten: 1 });
    await withTenant(tenantOf(user), () => getPrisma().idempotencyKey.create({ data: { userId: user.id, path: ASK_PATH, key, bodyHash: kept.bodyHash, status: kept.status, response: kept.response as Prisma.InputJsonValue } }));
    const afterDelete = await post(conversation.id, { text: QUESTION, mode: "explain" }, { key });
    expect(afterDelete.status).toBe(404);
    expect(afterDelete.headers.get("Idempotency-Replayed")).toBe("true");
  }, 180_000);

  it("refuses a question without an idempotency key, one too long, and a conversation that is not the reader's", async () => {
    const conversation = await createConversation(user, { locale: "en" });

    const noKey = await post(conversation.id, { text: QUESTION, mode: "explain" }, { key: null });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { code: string }).code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const tooLong = await post(conversation.id, { text: "a".repeat(801), mode: "explain" });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { code: string }).code).toBe("TEXT_TOO_LONG");

    /* Another reader's id reads as absent, so this is 404 and not 403 (§ 5.2). */
    const theirs = await post(conversation.id, { text: QUESTION, mode: "explain" }, { token: tokenB });
    expect(theirs.status).toBe(404);

    const unknown = await post(UUID, { text: QUESTION, mode: "explain" });
    expect(unknown.status).toBe(404);
  });

  it("refuses a second question while the previous turn is still open", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    await withTenant(tenantOf(user), async () =>
      getPrisma().message.create({ data: { userId: user.id, conversationId: conversation.id, role: "USER", ordinal: 1, mode: "EXPLAIN", text: "An open turn.", traceId: "f".repeat(32) } }),
    );

    const response = await post(conversation.id, { text: QUESTION, mode: "explain" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("TURN_IN_PROGRESS");
    abandoned = conversation.id;
  });

  it("refuses a pick the release does not have", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: QUESTION, mode: "lab", context: { labId: "lab-99" } });
    expect(response.status).toBe(422);
    expect((await response.json()) as { code: string; detail: { field: string } }).toMatchObject({ code: "CONTEXT_INVALID", detail: { field: "labId" } });
    expect((await getConversation(user, conversation.id))?.messages).toHaveLength(0);
  });

  it("answers the 21st question in a minute with 429 and a Retry-After", async () => {
    const conversation = await createConversation(other, { locale: "en" });
    /* The bucket is the pipeline's, so it can be spent without asking a model twenty times. */
    for (let index = 0; index < 20; index += 1) await consumeToken(`user:${other.id}:${ASK_PATH}`, 20, 60);

    const response = await post(conversation.id, { text: QUESTION, mode: "explain" }, { token: tokenB });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).not.toBeNull();
  });

  it("ends the stream with an error event and a failed turn when the gateway fails after meta", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const before = await head();
    fail.value = "500";
    let events: ReadonlyArray<StreamEvent>;
    try {
      const response = await post(conversation.id, { text: QUESTION, mode: "explain" });
      expect(response.status).toBe(200);
      events = await eventsOf(response);
    } finally {
      fail.value = null;
    }

    expect(events.map((event) => event.event)).not.toContain("final");
    const last = events.at(-1);
    expect(last?.event).toBe("error");
    expect(last?.data).toMatchObject({ code: "ASSISTANT_UNAVAILABLE" });
    expect(last?.data.message).toBe("The assistant is unavailable; the answer was not written.");

    /* The failed turn stands on the record so the log rail can show it, with no answer and no ledger record. */
    const view = await getConversation(user, conversation.id);
    expect(view?.messages).toHaveLength(2);
    expect(view?.messages[1]?.text).toBeNull();
    expect(view?.messages[1]?.verdicts).toEqual([{ sensor: "scope", verdict: "NA", detail: "ASSISTANT_UNAVAILABLE" }]);
    expect(view?.messages[1]?.ledger).toBeNull();
    expect((await head())?.seq).toBe(before?.seq);
  }, 120_000);

  it("names the budget in the error event, with the reset the dock shows", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const resetsAt = new Date("2026-10-01T00:00:00.000Z");
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];

    await runTurn(
      { conversationId: conversation.id, user, principal: { userId: user.id }, text: QUESTION, mode: "explain", context: null, traceId: "a".repeat(32) },
      (event) => emitted.push(event as { event: string; data: Record<string, unknown> }),
      {
        gateway: gateway(),
        chaptersVerified: async () => true,
        /* The budget refuses inside the flow, after the question is on the record: an event, not a status code. */
        run: async () => {
          throw new BudgetExceededError(resetsAt, "the key's budget is spent");
        },
      },
    );

    expect(emitted.map((event) => event.event)).toEqual(["meta", "error"]);
    expect(emitted[1]?.data).toMatchObject({ code: "BUDGET_EXCEEDED", resetsAt: resetsAt.toISOString() });
    const view = await getConversation(user, conversation.id);
    expect(view?.messages[1]?.verdicts).toEqual([{ sensor: "scope", verdict: "NA", detail: "BUDGET_EXCEEDED" }]);
  }, 60_000);

  it("keeps the record and the verdicts when the purge takes the words", async () => {
    /* The script, as a cron entry runs it, with the clock a day past the retention window (§ 12.6). */
    const run = await runPurge(new Date(Date.now() + 31 * 86_400_000));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("assistant:purge kept 30 days");

    const view = await getConversation(user, answered.conversationId);
    expect(view?.textPurgedAt).not.toBeNull();
    expect(view?.messages.map((message) => message.text)).toEqual([null, null]);
    /* What the answer was grounded on stays: the citations, their figures, the five verdicts and the ledger line. */
    const purged = view?.messages[1];
    expect(purged?.citations.length).toBeGreaterThan(0);
    expect(purged?.citations.every((citation) => citation.claimText === null)).toBe(true);
    expect(purged?.verdicts).toHaveLength(5);
    expect(purged?.ledger?.seq).toBe(answered.seq);

    /* The record still hashes to what it says, so a purged conversation still matches it (invariant 18). */
    const record = await getPrisma().ledgerRecord.findUniqueOrThrow({ where: { seq: answered.seq } });
    expect(recordHash({ ...record, payload: record.payload as JsonValue })).toBe(record.hash);
    expect(purged?.ledger?.hash).toBe(record.hash);

    /* And the whole chain still verifies after the purge ran: nothing it wrote touched a record (§ 12.5). */
    const top = await head();
    const chain = verifyChain((await range(1, top?.seq ?? 0)).map(toChainRecord), { prevOfFirst: GENESIS_PREV_HASH });
    expect(chain).toMatchObject({ ok: true, firstBreak: null });

    /* The turn abandoned by the 409 case is closed, so the log rail shows a turn and not a question alone. */
    const closed = await getConversation(user, abandoned);
    expect(closed?.messages).toHaveLength(2);
    expect(closed?.messages[1]?.role).toBe("ASSISTANT");
    expect(closed?.messages[1]?.verdicts).toEqual([{ sensor: "scope", verdict: "NA", detail: "TURN_ABANDONED" }]);
  }, 120_000);

  /* The export signs with the platform key, so the case runs only where `LEDGER_EXPORT_KEY` is set (CI's job has none;
     this machine's `.env` does, loaded with `NODE_OPTIONS=-r dotenv/config`). */
  it.skipIf(env.LEDGER_EXPORT_KEY === undefined)("exports the turns' records as signed JSONL that verifies, and records the export", async () => {
    const exportRoute = handler(conversationExport);
    const conversation = await createConversation(user, { locale: "en" });
    const first = await post(conversation.id, { text: QUESTION, mode: "explain" });
    expect(first.status).toBe(200);
    await first.text();

    const get = (id: string, who = token): Promise<Response> => {
      /* As the page's own link asks: an export is a read that writes, so the origin check holds it (the 52c review). */
      const headers = new Headers({ "x-forwarded-for": IP, cookie: `hb.session=${who}`, "sec-fetch-site": "same-origin" });
      return exportRoute(new Request(`http://localhost:3000/api/v1/assistant/conversations/${id}/export`, { headers }), { params: Promise.resolve({ id }) });
    };

    const before = await head();
    const response = await get(conversation.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="hb-conversation-${conversation.id}.jsonl"`);
    const lines = (await response.text()).split("\n");
    /* One line per answered turn, then the trailer, then the file's final newline. */
    expect(lines.filter((line) => line.length > 0)).toHaveLength(2);
    const check = verifyExport(lines, readFileSync(join(APP_DIR, "infra", "ledger", "export-public.pem"), "utf8"));
    expect(check).toMatchObject({ ok: true, lines: 1, signature: "valid", matchesTrailer: true });
    expect(check.trailer?.scope).toMatchObject({ kind: "messages", id: conversation.id });

    /* The export is a record: an EXPORT line joined the chain with the file's own hash (14 § 5.2). */
    const top = await head();
    expect(top?.seq).toBe((before?.seq ?? 0) + 1);
    const record = await getPrisma().ledgerRecord.findUniqueOrThrow({ where: { seq: top?.seq ?? 0 } });
    expect(record.kind).toBe("EXPORT");
    expect(record.actor).toBe(`user:${user.id}`);
    expect((record.payload as { scope: { kind: string } }).scope.kind).toBe("messages");

    /* Nothing answered, nothing to sign; and another reader's conversation reads as absent. */
    const empty = await createConversation(user, { locale: "en" });
    const nothing = await get(empty.id);
    expect(nothing.status).toBe(404);
    expect(((await nothing.json()) as { code: string }).code).toBe("NOTHING_TO_EXPORT");
    expect((await get(conversation.id, tokenB)).status).toBe(404);
  }, 180_000);

  it("walks a decision aid: runs the release's script before any model, explains from its values, records the run", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: WALK_TEXT, mode: "walk", aidId: AID_ID, aidInputs: AID_INPUTS });
    expect(response.status).toBe(200);
    const events = await eventsOf(response);
    const names = events.map((event) => event.event);
    expect(names[0]).toBe("meta");
    expect(names.at(-1)).toBe("final");
    expect(names).not.toContain("error");
    /* The script runs first: `running` is the first status, and no token arrives before it (spec 18 § 4). */
    const steps = events.filter((event) => event.event === "status").map((event) => event.data.step);
    expect(steps[0]).toBe("running");
    expect(steps).toContain("drafting");
    expect(names.indexOf("token")).toBeGreaterThan(names.indexOf("status"));

    const final = events.at(-1)?.data ?? {};
    const walked = final.modeResult as WalkModeResult;
    expect(walked.aidId).toBe(AID_ID);
    expect(walked.run).toMatchObject({ exitCode: 0, timedOut: false });
    expect(walked.sameAsBook).toBe(true);
    expect(walked.inputs).toEqual(AID_INPUTS);
    /* 0.769 is the book's 77%, shown as 76.9% through the declared scale (spec 18 § 3), computed in code from the
       script's own values (invariant 12); chapter 21's steps price nothing, so there is no verification date. */
    expect(walked.steps[1]).toMatchObject({ ordinal: 2, line: 8, pricesFrom: null, headline: { kind: "pct", percent: 76.9 } });
    expect(walked.steps[1]?.bars.map((bar) => bar.shown)).toEqual([87.8, 76.9, 51.3]);
    expect(walked.steps[2]?.headline).toEqual({ kind: "pct", percent: 99.5 });
    expect(walked.steps[3]?.headline).toEqual({ kind: "pct", percent: 45.5 });
    expect(walked.pricesVerifiedAt).toBeNull();
    /* The stub's explanations quote the fenced values and pass the derive sensor, which comes first on a walk turn. */
    expect(walked.explanations.map((explanation) => [explanation.ordinal, explanation.withheld])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
    ]);
    const verdicts = final.verdicts as ReadonlyArray<{ sensor: string; verdict: string; detail: string }>;
    expect(verdicts).toHaveLength(6);
    expect(verdicts[0]).toMatchObject({ sensor: "derive", verdict: "PASS", detail: "derive output matched · 4 of 4" });

    /* The rows: the inputs on the question (D4), the run on the answer for a reload; the record carries hashes only. */
    const view = await getConversation(user, conversation.id);
    expect(view?.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
    expect(view?.messages[1]?.modeResult).toMatchObject({ aidId: AID_ID, sameAsBook: true });
    const asked = await withTenant(tenantOf(user), () => getPrisma().message.findUniqueOrThrow({ where: { id: view?.messages[0]?.id ?? "" }, select: { aidInputs: true } }));
    expect(asked.aidInputs).toEqual(AID_INPUTS);
    const ledger = final.ledger as { seq: number };
    const record = await getPrisma().ledgerRecord.findUniqueOrThrow({ where: { seq: ledger.seq } });
    const payload = record.payload as { aid?: Record<string, unknown> };
    expect(payload.aid).toMatchObject({ id: AID_ID, exitCode: 0 });
    expect(payload.aid?.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.aid?.valuesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.aid).not.toHaveProperty("inputs");
  }, 180_000);

  it("withholds an explanation that quotes a number the script did not write, and keeps the step's values", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    walk.value = "invent";
    let final: Record<string, unknown>;
    try {
      const response = await post(conversation.id, { text: WALK_TEXT, mode: "walk", aidId: AID_ID, aidInputs: { ...AID_INPUTS, steps: 22, calls: 26 } });
      expect(response.status).toBe(200);
      final = (await eventsOf(response)).at(-1)?.data ?? {};
    } finally {
      walk.value = null;
    }
    const walked = final.modeResult as WalkModeResult;
    /* Twice the steps and the calls (§ 12.6): survival falls, the result is no longer the book's, the bars still stand. */
    expect(walked.sameAsBook).toBe(false);
    expect(walked.steps[1]?.bars.every((bar) => bar.shown !== null)).toBe(true);
    expect((walked.steps[1]?.headline as { percent: number }).percent).toBeLessThan(76.9);
    expect(walked.explanations[1]).toEqual({ ordinal: 2, text: WITHHELD.en, withheld: true });
    expect(walked.explanations[0]?.withheld).toBe(false);
    const verdicts = final.verdicts as ReadonlyArray<{ sensor: string; verdict: string; detail: string }>;
    expect(verdicts[0]).toMatchObject({ sensor: "derive", verdict: "WARN", detail: "derive output matched · 3 of 4" });
  }, 180_000);

  it("refuses a walk whose inputs are outside the aid's ranges, naming the range, and an aid the book does not have", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const low = await post(conversation.id, { text: WALK_TEXT, mode: "walk", aidId: AID_ID, aidInputs: { ...AID_INPUTS, calls: 0 } });
    expect(low.status).toBe(422);
    const body = (await low.json()) as { code: string; detail: { errors: ReadonlyArray<Record<string, unknown>> } };
    expect(body.code).toBe("AID_INPUTS");
    expect(body.detail.errors).toEqual([{ key: "calls", reason: "below_min", min: 1, max: 400 }]);

    const words = await post(conversation.id, { text: WALK_TEXT, mode: "walk", aidId: AID_ID, aidInputs: { ...AID_INPUTS, steps: "many", calls: 2.5 } });
    expect(words.status).toBe(422);
    expect(((await words.json()) as { detail: { errors: ReadonlyArray<{ reason: string }> } }).detail.errors.map((error) => error.reason)).toEqual(["not_a_number", "not_integer"]);

    /* Any aid of the book may be walked from any conversation (feature-specs/23 § 7.3); only an unknown one is refused here. */
    const other = await post(conversation.id, { text: WALK_TEXT, mode: "walk", aidId: "no-such-aid", aidInputs: AID_INPUTS });
    expect(other.status).toBe(422);
    expect(((await other.json()) as { code: string }).code).toBe("AID_UNKNOWN");

    const none = await post(conversation.id, { text: WALK_TEXT, mode: "walk" });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { code: string }).code).toBe("AID_UNKNOWN");

    /* Nothing ran and nothing was written: the conversation has no turn. */
    expect((await getConversation(user, conversation.id))?.messages).toHaveLength(0);
  });

  it("does not run the script for a chapter the release has not verified: the walk refuses as any question would", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: "Walk 37.8 with our inputs", mode: "walk", ...CH37_AID });
    expect(response.status).toBe(200);
    const events = await eventsOf(response);
    /* No `running`: the container is not spent on a turn the flow refuses before retrieval (spec 13 § 4.1). */
    expect(events.map((event) => event.event)).toEqual(["meta", "final"]);
    const final = events.at(-1)?.data ?? {};
    expect(final.kind).toBe("refusal");
    expect(final.refusal).toMatchObject({ cause: "R-UNVERIFIED", beforeRetrieval: true });
    expect(final.modeResult).toBeNull();
  }, 60_000);

  it("ends a walk whose script does not finish as a failed run: an error event, a failed-turn row, no model call", async () => {
    const conversation = await createConversation(user, { locale: "en" });
    const before = await head();
    const frontierCalls = rows.filter((row) => row.alias === "hb-frontier").length;
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    await runTurn(
      { conversationId: conversation.id, user, principal: { userId: user.id }, text: WALK_TEXT, mode: "walk", context: null, aid: { id: AID_ID, inputs: AID_INPUTS }, traceId: "b".repeat(32) },
      (event) => emitted.push(event as { event: string; data: Record<string, unknown> }),
      /* An interpreter that does not exist: the run ends with no exit code, as a script that raises ends with 1 (§ 7). */
      { gateway: gateway(), chaptersVerified: async () => true, aid: { runner: "python", python: "hb-no-such-interpreter" } },
    );
    expect(emitted.map((event) => event.event)).toEqual(["meta", "status", "error"]);
    expect(emitted[1]?.data).toEqual({ step: "running" });
    expect(emitted[2]?.data).toMatchObject({ code: "AID_RUN_FAILED", detail: { exitCode: null, timedOut: false } });

    const view = await getConversation(user, conversation.id);
    expect(view?.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
    expect(view?.messages[1]?.text).toBeNull();
    expect(view?.messages[1]?.ledger).toBeNull();
    expect(view?.messages[1]?.verdicts).toEqual([{ sensor: "scope", verdict: "NA", detail: "AID_RUN_FAILED" }]);
    expect((await head())?.seq).toBe(before?.seq);
    expect(rows.filter((row) => row.alias === "hb-frontier").length).toBe(frontierCalls);
  }, 60_000);

  it("refuses a compare without its pair or with the same chapter twice, naming the field, and an unverified chapter by number (spec 19 § 3)", async () => {
    await resetAsks();
    const conversation = await createConversation(user, { locale: "en" });
    const detailOf = async (response: Response): Promise<{ code: string; detail: { field: string; chapter?: number } }> => (await response.json()) as { code: string; detail: { field: string; chapter?: number } };
    const none = await post(conversation.id, { text: QUESTION, mode: "compare" });
    expect(none.status).toBe(422);
    expect(await detailOf(none)).toMatchObject({ code: "CONTEXT_INVALID", detail: { field: "chapters" } });
    const twice = await post(conversation.id, { text: QUESTION, mode: "compare", context: { chapters: [21, 21] } });
    expect(await detailOf(twice)).toMatchObject({ detail: { field: "chapters", chapter: 21 } });
    /* Chapter 37 is UNVERIFIED in release 2026.09: the pair is refused before a turn exists, naming it. */
    const unverified = await post(conversation.id, { text: QUESTION, mode: "compare", context: { chapters: [21, 37] } });
    expect(unverified.status).toBe(422);
    expect(await detailOf(unverified)).toMatchObject({ detail: { field: "chapters", chapter: 37 } });
    /* A lab is any lab of the release now, so only one the release does not have is refused (feature-specs/23 § 7.2). */
    const unknownLab = await post(conversation.id, { text: QUESTION, mode: "lab", context: { labId: "lab-99" } });
    expect(unknownLab.status).toBe(422);
    expect(await detailOf(unknownLab)).toMatchObject({ detail: { field: "labId" } });
    const noLab = await post(conversation.id, { text: QUESTION, mode: "lab", context: {} });
    expect(await detailOf(noLab)).toMatchObject({ detail: { field: "labId" } });
    expect((await getConversation(user, conversation.id))?.messages).toHaveLength(0);
  });

  it("explains a lab run from its README and last run, cited as the chapter's lab section, with the run on the final event (spec 19 § 4)", async () => {
    await resetAsks();
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: "What does Lab 21 reproduce, and which figures does it check?", mode: "lab", context: { chapter: 21, section: "21.4", labId: "lab-21" } });
    expect(response.status).toBe(200);
    const events = await eventsOf(response);
    const final = events.at(-1)?.data ?? {};
    expect(final.kind).toBe("answer");
    const verdicts = final.verdicts as ReadonlyArray<{ sensor: string; verdict: string; detail: string }>;
    expect(verdicts.map((verdict) => verdict.sensor)).toEqual(["scope", "citation", "mode", "edition", "grader", "latency"]);
    expect(verdicts[2]).toMatchObject({ sensor: "mode", verdict: "PASS" });
    expect(verdicts[2]?.detail).toMatch(/^lab · \d+ figures? from the run$/);
    /* The stub cites one claim per fence: the README and the run cite 21.4, the run's claim quoting a checked figure. */
    const claims = final.claims as ReadonlyArray<{ sectionId: string; figureId: string | null; substituted: boolean }>;
    expect(claims.some((claim) => claim.sectionId === "21.4" && claim.figureId !== null && !claim.substituted)).toBe(true);
    const lab = final.modeResult as { reproduces: string; lab: { labId: string; verdict: string; figures: ReadonlyArray<{ figureId: string; verdict: string; runValue: unknown }> } };
    expect(lab.lab).toMatchObject({ labId: "lab-21", verdict: "REPRODUCED" });
    expect(lab.lab.figures.length).toBeGreaterThanOrEqual(12);
    expect(lab.lab.figures.every((figure) => figure.verdict === "match")).toBe(true);
    expect(lab.reproduces.length).toBeGreaterThan(0);
    expect((await getConversation(user, conversation.id))?.messages[1]?.modeResult).toMatchObject({ lab: { labId: "lab-21" } });
  }, 180_000);

  it("compares two verified chapters with both cited and the mode row first after citation (spec 19 § 5)", async () => {
    await resetAsks();
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: "Where do chapters 21 and 28 agree on retries?", mode: "compare", context: { chapter: 21, chapters: [21, 28] } });
    expect(response.status).toBe(200);
    const final = (await eventsOf(response)).at(-1)?.data ?? {};
    expect(final.kind).toBe("answer");
    const verdicts = final.verdicts as ReadonlyArray<{ sensor: string; verdict: string; detail: string }>;
    expect(verdicts[2]).toMatchObject({ sensor: "mode", verdict: "PASS", detail: "compare · both chapters cited" });
    expect(final.modeResult).toEqual({ openPoint: null });
    const chapters = new Set((final.claims as ReadonlyArray<{ sectionId: string }>).map((claim) => claim.sectionId.slice(0, 2)));
    expect([...chapters].sort()).toEqual(["21", "28"]);
  }, 180_000);

  it("refuses a brief while Part III is unverified, before retrieval and without a model call (spec 19 D4)", async () => {
    await resetAsks();
    /* Release 2026.09 has verified chapters 0–33; Part III is 34–40. The brief's sources are the part's, so it refuses
       as any question of an unverified chapter does, from a chapter that is itself verified. */
    const conversation = await createConversation(user, { locale: "en" });
    const frontier = rows.filter((row) => row.alias === "hb-frontier").length;
    const response = await post(conversation.id, { text: "Should we route review to a small model first?", mode: "brief", context: { chapter: 5 } });
    expect(response.status).toBe(200);
    const events = await eventsOf(response);
    expect(events.map((event) => event.event)).toEqual(["meta", "final"]);
    expect(events.at(-1)?.data).toMatchObject({ kind: "refusal", refusal: { cause: "R-UNVERIFIED", beforeRetrieval: true } });
    expect(rows.filter((row) => row.alias === "hb-frontier").length).toBe(frontier);
  }, 60_000);

  it("answers 503 when the workers are not running, before any event", async () => {
    await resetAsks();
    const conversation = await createConversation(user, { locale: "en" });
    await workers.close();
    running = false;

    const response = await post(conversation.id, { text: QUESTION, mode: "explain" });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("ASSISTANT_UNAVAILABLE");
    /* Nothing was written: the question never reached the workers, so there is no turn to close. */
    expect(await getConversation(user, conversation.id)).toMatchObject({ messages: [] });
  }, 60_000);
});
