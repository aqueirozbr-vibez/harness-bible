import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import { askEndpoint } from "@/lib/api/endpoints/assistant";
import { handler } from "@/lib/api/handler";
import { parseTraceparent } from "@/lib/api/trace";
import { resolveDevUser } from "@/lib/auth/link";
import { createSession, revokeAllSessions, type SessionUser } from "@/lib/auth/session";
import { createConversation, getConversation } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { range } from "@/lib/db/ledger";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";
import { logGatewaySpan } from "@/lib/gateway/span";
import { editionMismatchShare } from "@/lib/metrics/assistant";
import { sha256Hex } from "@/lib/ledger/hash";
import { flushTelemetry, startTelemetry, stopTelemetry } from "@/lib/telemetry/tracer";
import { ROUTE_TIMEOUT_MS } from "@/lib/workers/client";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { startOtlpReceiver, type OtlpReceiver, type ReceivedSpan } from "@/tests/fixtures/otlp";
import { chaptersVerifiedFor } from "@/workers/answer/run";
import { runTurn } from "@/workers/answer/turn";
import { gatewayProbe } from "@/workers/health";
import { startWorkers, type RunningWorkers } from "@/workers/server";

/*
 * One turn's spans over the whole stack (feature-specs/21 § 13.4): the route handler, the workers and the flow, with
 * the stub gateway for a provider and a stand-in collector listening. The loggers are the product's own — nothing
 * here passes a double for `logSpan` or `logGatewaySpan` — so what arrives is what a deployment would export.
 *
 * Both tiers run in this process, so they share one tracer and one service name; what a deployment splits in two is
 * the parent link the web tier's `traceparent` carries, and that link is asserted.
 */

const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined;

const MASTER_KEY = "telemetry-suite-master-key";
const SECRET = "89abcdef01234567".repeat(4);
const WORKERS_TOKEN = "telemetry-suite-workers-token";
const EMAIL = "telemetry-a@harness-bible.local";
const IP = "203.0.113.77";
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const QUESTION = "Why does a retried write without an idempotency key become a second write?";
const AID_ID = "21.8-task-survival";
const AID_INPUTS = { steps: 11, calls: 13, tokens_per_step: 7500 };

interface Final {
  readonly messageId: string;
  readonly kind: string;
  readonly claims: ReadonlyArray<{ readonly text: string }>;
  readonly ledger: { readonly seq: number };
}

/** The data of one named event of a stream, already read as text. */
function eventOf<T>(body: string, name: string): T {
  const frame = body.split("\n\n").find((candidate) => candidate.includes(`event: ${name}`)) ?? "";
  const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
  return JSON.parse(data) as T;
}

/** The `final` event of a response's stream. */
async function finalOf(response: Response): Promise<Final> {
  return eventOf<Final>(await response.text(), "final");
}

describe.skipIf(!ready)("one turn's spans over the whole stack", () => {
  let stub: RunningStub;
  let workers: RunningWorkers;
  let receiver: OtlpReceiver;
  let release: () => void = () => undefined;
  let user: SessionUser;
  let token = "";
  let key = "";
  let ask: ReturnType<typeof handler>;
  /* What was sent to the gateway, call by call: the test of what a model and the embedder were shown. */
  const sent: Array<{ readonly url: string; readonly body: string }> = [];

  function gateway(): GatewayDeps {
    return {
      baseUrl: stub.url,
      keySecret: SECRET,
      findKey: async () => ({ keyCiphertext: encryptKey(SECRET, key) }),
      /* The budget rows are the gateway suite's subject; the model call's line and span are this one's. */
      append: async () => undefined,
      log: logGatewaySpan,
      fetch: async (input, init) => {
        sent.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, body: typeof init?.body === "string" ? init.body : "" });
        return globalThis.fetch(input, init);
      },
      now: () => new Date(),
    };
  }

  async function cleanup(): Promise<void> {
    await withSystem(async () => {
      const prisma = getPrisma();
      const rows = await prisma.user.findMany({ where: { email: EMAIL }, select: { id: true } });
      for (const row of rows) {
        await withTenant({ userId: row.id, organisationId: null }, async () => {
          const ids = (await prisma.message.findMany({ select: { id: true } })).map((message) => message.id);
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
        await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: `user:${row.id}:` } } });
      }
      await prisma.user.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    });
  }

  beforeAll(async () => {
    release = await acquire(LEDGER_LOCK);
    await cleanup();
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    receiver = await startOtlpReceiver();
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: () => undefined });
    const minted = await fetch(`${stub.url}/key/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ models: [...ALIASES.keys()], max_budget: 50 }),
    });
    key = ((await minted.json()) as { key: string }).key;

    const refused = (): never => {
      throw new Error("the key routes are not exercised by this suite");
    };
    workers = await startWorkers({
      token: WORKERS_TOKEN,
      keys: {
        gatewayUrl: stub.url,
        masterKey: MASTER_KEY,
        keySecret: SECRET,
        individual: null,
        fetch: globalThis.fetch,
        now: () => new Date(),
        db: { findKey: async () => null, insertKey: refused, replaceKey: refused, organisationCaps: async () => null, isIndividualUser: async () => false },
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
          { gateway: gateway(), chaptersVerified: chaptersVerifiedFor, aid: { runner: "python" } },
        ),
      host: "127.0.0.1",
      port: 0,
    });
    ask = handler(askEndpoint(() => ({ baseUrl: workers.url, token: WORKERS_TOKEN, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS })));

    const resolved = await resolveDevUser(EMAIL, "en");
    user = { id: resolved.userId, organisationId: null, role: "READER", displayName: "T", locale: "en", identityVerified: false, parts: [], sessionId: null };
    token = await createSession(resolved.userId, { device: "unknown", idpSessionId: null });
  }, 120_000);

  afterAll(async () => {
    try {
      await stopTelemetry();
      await revokeAllSessions(user).catch(() => 0);
      await cleanup();
      await workers?.close();
      await stub?.close();
      await receiver?.close();
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  function post(conversationId: string, body: unknown): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": IP, cookie: `hb.session=${token}`, "idempotency-key": crypto.randomUUID() });
    const request = new Request(`http://localhost:3000/api/v1/assistant/conversations/${conversationId}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
    return ask(request, { params: Promise.resolve({ id: conversationId }) });
  }

  const of = (spans: ReadonlyArray<ReceivedSpan>, name: string) => spans.filter((span) => span.name === name);

  it("exports the request, the retrieval, the model calls and the answer as one trace, the workers under the web tier", async () => {
    expect(await startTelemetry("hb-web", receiver.url)).toBe(true);
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: QUESTION, mode: "explain" });
    expect(response.status).toBe(200);
    const final = await finalOf(response);
    expect(final.kind).toBe("answer");
    await flushTelemetry();

    const traceId = parseTraceparent(response.headers.get("traceparent"))?.traceId ?? "";
    const spans = receiver.spans().filter((span) => span.traceId === traceId);
    /* Everything this turn exported is in the response's own trace: nothing went out under another id. */
    expect(spans.length).toBe(receiver.spans().length);

    const web = of(spans, "http.request").find((span) => String(span.attributes["url.path"]).endsWith("/messages"));
    const worker = of(spans, "http.request").find((span) => span.attributes["url.path"] === "/answer");
    expect(web).toMatchObject({ parentSpanId: "", attributes: { "http.request.method": "POST", "http.response.status_code": 200, "hb.subject": user.id, "hb.policy": "allow" } });
    expect(web?.spanId).toBe(parseTraceparent(response.headers.get("traceparent"))?.parentId);
    expect(worker).toMatchObject({ parentSpanId: web?.spanId, attributes: { "http.response.status_code": 200 } });

    /* The turn itself: one retrieval with its two retrieval calls, the classifier and the draft, the grader, one answer. */
    expect(of(spans, "assistant.retrieve")).toHaveLength(1);
    expect(of(spans, "gen_ai.embeddings")).toHaveLength(1);
    expect(of(spans, "gen_ai.rerank")).toHaveLength(1);
    const chats = of(spans, "gen_ai.chat");
    expect(chats.filter((span) => span.attributes["hb.purpose"] === "assistant").length).toBeGreaterThanOrEqual(2);
    expect(chats.filter((span) => span.attributes["hb.purpose"] === "grading")).toHaveLength(1);
    expect(chats.every((span) => span.attributes["hb.principal"] === `user:${user.id}` && typeof span.attributes["hb.prompt.sha256"] === "string" && span.attributes["hb.outcome"] === "ok")).toBe(true);
    expect(chats.some((span) => span.attributes["hb.alias"] === "hb-frontier" && typeof span.attributes["hb.guide.version"] === "string" && typeof span.attributes["hb.first_token_ms"] === "number")).toBe(true);
    expect(of(spans, "assistant.retrieve")[0]?.attributes).toMatchObject({ "hb.mode": "explain", "hb.vector_ready": expect.any(Boolean) as boolean, "hb.candidates": expect.any(Number) as number });

    const answer = of(spans, "assistant.answer");
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({ status: { code: 0 }, attributes: { "hb.message_id": final.messageId, "hb.mode": "explain", "hb.outcome": "answer", "hb.edition.locale": "en", "hb.edition.cited": "EN", "hb.edition.mismatch": false, "hb.secret.redacted": 0 } });
    expect(answer[0]?.attributes["hb.citations.total"]).toBeGreaterThan(0);
    expect(answer[0]?.attributes["hb.citations.resolved"]).toBe(answer[0]?.attributes["hb.citations.total"]);
    for (const span of spans.filter((candidate) => candidate.name !== "http.request")) expect(span.parentSpanId).toBe(worker?.spanId);

    /* No words and no secrets, in any attribute of any span (§ 5.1): the question, what was answered, who asked, the keys. */
    const strings = spans.flatMap((span) => [span.status.message, ...Object.values(span.attributes).filter((value): value is string => typeof value === "string")]);
    for (const value of strings) {
      expect(value).not.toContain(QUESTION);
      for (const claim of final.claims) expect(value).not.toContain(claim.text);
      for (const secret of [EMAIL, key, WORKERS_TOKEN, token, MASTER_KEY, SECRET]) expect(value).not.toContain(secret);
      expect(value).not.toMatch(/@|\s/);
    }
  }, 120_000);

  it("exports the aid's run for a walk, between the request and the answer", async () => {
    const before = receiver.spans().length;
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: "Walk 21.8 with our inputs", mode: "walk", aidId: AID_ID, aidInputs: AID_INPUTS });
    expect(response.status).toBe(200);
    const final = await finalOf(response);
    await flushTelemetry();

    const spans = receiver.spans().slice(before);
    const worker = of(spans, "http.request").find((span) => span.attributes["url.path"] === "/answer");
    expect(of(spans, "aid.run")).toHaveLength(1);
    expect(of(spans, "aid.run")[0]).toMatchObject({ parentSpanId: worker?.spanId, status: { code: 0 }, attributes: { "hb.aid.id": AID_ID, "hb.aid.runner": "python", "hb.aid.exit_code": 0, "hb.aid.timed_out": false } });
    expect(of(spans, "assistant.answer")[0]?.attributes).toMatchObject({ "hb.message_id": final.messageId, "hb.mode": "walk", "hb.outcome": "answer" });
    /* The reader's inputs are numbers the script ran with; they are in the ledger as a hash and in no span. */
    expect(spans.some((span) => Object.keys(span.attributes).some((name) => name.includes("input") && !name.startsWith("gen_ai.usage.")))).toBe(false);
  }, 120_000);

  it("writes the same lines and exports nothing once the tracer is stopped", async () => {
    await stopTelemetry();
    const requests = receiver.requests();
    vi.mocked(console.info).mockClear();
    const conversation = await createConversation(user, { locale: "en" });
    const final = await finalOf(await post(conversation.id, { text: QUESTION, mode: "explain" }));
    await flushTelemetry();

    expect(receiver.requests()).toBe(requests);
    const kinds = vi.mocked(console.info).mock.calls.flatMap((call) => {
      try {
        return [(JSON.parse(String(call[0])) as { kind?: string; messageId?: string }) ?? {}];
      } catch {
        return [];
      }
    });
    /* The policy decision is a line of its own and stays one: it goes to the log store, not to a trace (architecture section 7). */
    expect(new Set(kinds.map((line) => line.kind))).toEqual(new Set(["policy", "span", "retrieve", "model_call", "answer"]));
    expect(kinds.find((line) => line.kind === "answer")?.messageId).toBe(final.messageId);
  }, 120_000);

  it("removes a secret pasted into a question before it is stored, shown to a model or searched by, and counts it", async () => {
    expect(await startTelemetry("hb-web", receiver.url)).toBe(true);
    const before = receiver.spans().length;
    sent.length = 0;
    /* Assembled here: no file of the repository holds a string shaped like a key. */
    const pasted = ["sk", "ant", `api03-${"Hn5".repeat(30)}`].join("-");
    const stored = `Our key is [redacted:anthropic-key]. ${QUESTION}`;
    const conversation = await createConversation(user, { locale: "en" });
    const response = await post(conversation.id, { text: `Our key is ${pasted}. ${QUESTION}`, mode: "explain" });
    expect(response.status).toBe(200);
    const body = await response.text();
    const final = eventOf<Final>(body, "final");
    expect(final.kind).toBe("answer");
    await flushTelemetry();

    /* The reader's own turn: `meta` carries the question as it was stored, and the stream never carries the key. */
    expect(eventOf<{ question?: string }>(body, "meta").question).toBe(stored);
    expect(body).not.toContain(pasted);

    /* The row, and the record's hash of it: 30 days of retention hold the mark, not the key. */
    const view = await getConversation(user, conversation.id);
    expect(view?.messages[0]?.text).toBe(stored);
    const record = (await range(final.ledger.seq, final.ledger.seq))[0];
    expect((record?.payload as { questionSha256?: string } | undefined)?.questionSha256).toBe(sha256Hex(stored));

    /* What left for the gateway: no call carried the key; the model's calls carried the mark; the embedder was given
       the rest of the question, without the mark's three words. */
    expect(sent.length).toBeGreaterThanOrEqual(4);
    for (const call of sent) expect(call.body).not.toContain(pasted);
    const chats = sent.filter((call) => call.url.endsWith("/v1/messages"));
    expect(chats.length).toBeGreaterThanOrEqual(2);
    expect(chats.some((call) => call.body.includes("[redacted:anthropic-key]"))).toBe(true);
    const embeddings = sent.filter((call) => call.url.includes("/embeddings"));
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]?.body).not.toContain("redacted");
    expect(embeddings[0]?.body).toContain("idempotency key");

    /* The span counts it and holds no part of it; nothing tripped the guard, because nothing leaked. */
    const spans = receiver.spans().slice(before);
    expect(of(spans, "assistant.answer")[0]?.attributes).toMatchObject({ "hb.message_id": final.messageId, "hb.secret.redacted": 1 });
    expect(JSON.stringify(spans)).not.toContain(pasted.slice(7, 27));
    expect(spans.some((span) => span.attributes["hb.secret.detected"] === true)).toBe(false);
  }, 120_000);

  it("records the edition gap: a Portuguese reader's answer cites the English edition, on the rows, the span and the series", async () => {
    expect(await startTelemetry("hb-web", receiver.url)).toBe(true);
    const before = receiver.spans().length;
    const from = new Date();
    const conversation = await createConversation(user, { locale: "pt" });
    const response = await post(conversation.id, { text: QUESTION, mode: "explain" });
    expect(response.status).toBe(200);
    const final = await finalOf(response);
    expect(final.kind).toBe("answer");
    await flushTelemetry();

    /* The two facts the gap is made of are on the rows: the conversation's language and the edition the answer cited. */
    const view = await getConversation(user, conversation.id);
    expect(view?.locale).toBe("pt");
    expect(view?.messages[1]?.citesEdition).toBe("EN");

    /* The span says it outright. */
    expect(of(receiver.spans().slice(before), "assistant.answer")[0]?.attributes).toMatchObject({
      "hb.message_id": final.messageId,
      "hb.edition.locale": "pt",
      "hb.edition.cited": "EN",
      "hb.edition.mismatch": true,
    });

    /* And the series derives it from those rows, per language: over this case's own minute, one Portuguese answer, all of it the gap. */
    const series = await editionMismatchShare({ from, to: new Date(Date.now() + 1000) });
    expect(series.points.filter((point) => point.key === "pt")).toEqual([expect.objectContaining({ n: 1, d: 1, value: 1 })]);
    expect(series.points.filter((point) => point.key === "en")).toEqual([]);
  }, 120_000);
});
