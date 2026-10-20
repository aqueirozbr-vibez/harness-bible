import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { IdempotencyStart } from "@/lib/api/idempotency";
import type { SessionUser } from "@/lib/auth/session";
import { researchErasedStepKeyOf } from "@/lib/db/ledger";
import type { ConversationRunCreated, ConversationRunInput, NewestRun, ResearchConversationRow, SeedFacts } from "@/lib/db/research";
import { ErrorBodySchema, ResearchConversationSchema, ResearchRunStartedSchema, ResearchRunViewSchema, type ResearchRunView } from "@/lib/schemas/api";
import type { ResearchState } from "@/lib/schemas/research";
import { WORKFLOWS_DEADLINE_MS, WorkflowsUnavailableError } from "@/lib/workflows/client";

import { researchEndpoints, START_IN_FLIGHT_MS, type ResearchEndpointDeps } from "./research";

/*
 * A person's research through the pipeline, its door, the engine and the ledger doubled (feature-specs/48 § 5.2, § 13,
 * § 17.2; unit 71): each endpoint declared as § 13 says; the start's checks in § 5.2's order, each the status code it
 * names, and what each leaves behind — check 3 leaving alone a `QUEUED` row young enough to be another start in flight,
 * and ending a stale one only as it was read; the two free rules' refusals with no workflow; the engine's refusal
 * taken back; the stored start replayed after the research is looked up; the flag's three refusals, a duplicate's with
 * the flag that stands; and the delete with its one `ERASED` record. The same endpoints against the database are tests/integration/research-api.test.ts, and through the
 * policy tests/contract/api.test.ts.
 */

const READER: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "READER", displayName: "A reader", locale: "en", identityVerified: false, parts: [], sessionId: "s1" };
const RESEARCH = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const SEED = "44444444-4444-4444-8444-444444444444";
const KEY = "0f2b1d8c-6a2e-4b7f-9c3d-1e2f3a4b5c6d";
const NOW = new Date("2026-10-12T15:00:00.000Z");
const QUESTION = "What changed in idempotency key retention since the book was verified?";
/** Another run of the research, the newest, which check 3 reads. */
const OTHER_RUN = "55555555-5555-4555-8555-555555555555";
/** An instant past the minute a start in flight is given (`START_IN_FLIGHT_MS`). */
const STALE = new Date(NOW.getTime() - START_IN_FLIGHT_MS - 1_000);

const CONVERSATION: ResearchConversationRow = { id: RESEARCH, locale: "EN", seedMessageId: null, createdAt: new Date("2026-10-12T14:00:00.000Z"), textPurgedAt: null };

interface Fake {
  conversation: ResearchConversationRow | null;
  seed: SeedFacts | null;
  newest: NewestRun | null;
  running: boolean | "unreachable";
  gates: { deletionRequested: boolean; organisation: boolean };
  reset: Date | null;
  full: Date | null;
  configured: boolean;
  passed: boolean;
  created: ConversationRunCreated | null;
  startFails: Error | null;
  /** Whether check 3's conditional end finds the row as it was read. */
  abandons: boolean;
  flagged: Awaited<ReturnType<ResearchEndpointDeps["flag"]>>;
  removed: Awaited<ReturnType<ResearchEndpointDeps["remove"]>>;
  recorded: { readonly seq: number } | null;
  appendFails: boolean;
  /** The research's records by `seq`, null for none of the caller's; and what signing them does. */
  records: ReadonlyArray<number> | null;
  exportFails: Error | null;
  /* what the endpoints did */
  inputs: ConversationRunInput[];
  started: Array<{ workflowId: string; runId: string; userId: string }>;
  states: Array<{ id: string; state: ResearchState; extra: unknown }>;
  abandoned: Array<{ id: string; from: ResearchState }>;
  asked: string[];
  opened: unknown[];
  appended: unknown[];
  completed: Array<{ status: number; body: unknown }>;
  chapters: number[][];
}

let fake: Fake;

function reset(): Fake {
  return {
    conversation: CONVERSATION,
    seed: null,
    newest: null,
    running: false,
    gates: { deletionRequested: false, organisation: true },
    reset: null,
    full: null,
    configured: true,
    passed: true,
    created: null,
    startFails: null,
    abandons: true,
    flagged: { flagged: true, at: NOW },
    removed: { deleted: true, detached: 1 },
    recorded: null,
    appendFails: false,
    records: [12, 40],
    exportFails: null,
    inputs: [],
    started: [],
    states: [],
    abandoned: [],
    asked: [],
    opened: [],
    appended: [],
    completed: [],
    chapters: [],
  };
}

const VIEW = ResearchRunViewSchema.parse({
  id: RUN,
  conversationId: RESEARCH,
  ordinal: 1,
  question: QUESTION,
  language: "en",
  seeded: false,
  state: "QUEUED",
  line: { key: "queued", tone: "run" },
  stale: false,
  refusal: null,
  resetsAt: null,
  steps: [],
  sections: [],
  report: null,
  pages: [],
  findings: [],
  usage: { searches: 0, pagesOpened: 0, pagesSeen: null, costUsd: null },
  flag: null,
  createdAt: NOW.toISOString(),
  finishedAt: null,
  textPurged: false,
});

const deps: ResearchEndpointDeps = {
  seed: async () => fake.seed,
  open: async (_user, input, at) => {
    fake.opened.push(input);
    return { id: RESEARCH, locale: input.locale, seedMessageId: input.seedMessageId, createdAt: at, textPurgedAt: null };
  },
  conversation: async () => fake.conversation,
  conversationView: async () => (fake.conversation === null ? null : { conversation: fake.conversation, runs: [VIEW] as ReadonlyArray<ResearchRunView> }),
  runView: async (_user, id) => (id === RUN ? VIEW : null),
  newestRun: async () => fake.newest,
  running: async (workflowId) => {
    fake.asked.push(workflowId);
    if (fake.running === "unreachable") throw new WorkflowsUnavailableError("connection", "the workflow engine could not be reached");
    return fake.running;
  },
  abandon: async (run) => {
    fake.abandoned.push({ id: run.id, from: run.state });
    return { written: fake.abandons };
  },
  writeState: async (run, state, extra) => {
    fake.states.push({ id: run.id, state, extra });
    return { written: true };
  },
  gates: async () => fake.gates,
  budgetReset: async () => fake.reset,
  dailyLimit: async () => fake.full,
  configured: () => fake.configured,
  release: async () => "2026.09",
  chaptersPassed: async (_release, chapters) => {
    fake.chapters.push([...chapters]);
    return fake.passed;
  },
  secrets: () => [],
  createRun: async (_user, input) => {
    fake.inputs.push(input);
    if (fake.created !== null) return fake.created;
    return input.refusal === null ? { created: true, id: RUN, ordinal: 1, state: "QUEUED", workflowId: `research:${RUN}` } : { created: true, id: RUN, ordinal: 1, state: "REFUSED", workflowId: null };
  },
  start: async (workflowId, input) => {
    if (fake.startFails !== null) throw fake.startFails;
    fake.started.push({ workflowId, ...input });
  },
  flag: async () => fake.flagged,
  remove: async () => fake.removed,
  recorded: async () => fake.recorded,
  append: async (input) => {
    if (fake.appendFails) throw new Error("the chain's head did not answer");
    fake.appended.push(input);
    return { seq: 9001 };
  },
  records: async () => fake.records,
  exportFile: async (researchId, seqs) => {
    if (fake.exportFails !== null) throw fake.exportFails;
    return { file: Buffer.from(`{"seqs":${JSON.stringify(seqs)}}\n`), trailer: { headHash: "a".repeat(64), fromSeq: seqs[0] ?? 1, toSeq: seqs.at(-1) ?? 1, records: seqs.length, scope: { kind: "research", id: researchId, from: null, to: null }, exportedAt: NOW.toISOString(), signature: "b".repeat(128) } };
  },
  now: () => NOW,
};

const buckets: string[] = [];

function pipeline(session: SessionUser | null, idempotency: IdempotencyStart = { kind: "new" }): HandlerDeps {
  return {
    sessionFromRequest: async () => session,
    authorize: async () => ({ allow: true }),
    consume: async (key) => {
      buckets.push(key);
      return { allowed: true, limit: 20, remaining: 19, resetS: 60, retryAfterS: 0 };
    },
    idempotency: {
      begin: async () => idempotency,
      complete: async (_user, _path, _key, status, body) => {
        fake.completed.push({ status, body });
      },
      abandon: async () => undefined,
    },
    audit: async () => undefined,
    log: () => undefined,
  };
}

const endpoints = researchEndpoints(deps);
const BASE = "http://localhost:3000";
const headers = { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.71" };

function post(path: string, body: unknown, extra: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
}

const start = (body: unknown = { question: QUESTION, language: "en" }, idempotency?: IdempotencyStart) =>
  handler(endpoints.researchRunStart, pipeline(READER, idempotency))(post(`/api/v1/research/conversations/${RESEARCH}/runs`, body, { "idempotency-key": KEY }), { params: { id: RESEARCH } });

async function codeOf(response: Response): Promise<string> {
  return ErrorBodySchema.parse(await response.json()).code;
}

beforeEach(() => {
  fake = reset();
  buckets.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the research endpoints as § 13 declares them", () => {
  it("each with its path, method, rate and policy action; the start alone with an Idempotency-Key, stored by the endpoint", () => {
    const declared = Object.values(endpoints).map((spec) => ({ at: `${spec.method} ${spec.path}`, limit: spec.rateLimit?.limit, action: spec.policy.action, idempotent: spec.idempotent ?? false }));
    expect(declared).toEqual([
      { at: "POST /api/v1/research/conversations", limit: 30, action: "create", idempotent: false },
      { at: "GET /api/v1/research/conversations/{id}", limit: 60, action: "read", idempotent: false },
      { at: "DELETE /api/v1/research/conversations/{id}", limit: 30, action: "delete", idempotent: false },
      { at: "POST /api/v1/research/conversations/{id}/runs", limit: 20, action: "ask", idempotent: "endpoint" },
      { at: "GET /api/v1/research/runs/{id}", limit: 60, action: "read", idempotent: false },
      { at: "POST /api/v1/research/runs/{id}/flag", limit: 10, action: "write", idempotent: false },
      { at: "GET /api/v1/research/conversations/{id}/export", limit: 10, action: "export", idempotent: false },
    ]);
    /* a read that writes its own record: the pipeline holds it to the same origin (code-standards § API Routes) */
    expect(endpoints.researchConversationExport.writes).toBe(true);
    expect(endpoints.researchConversationDelete.rateLimit?.bucket).toBe("DELETE /api/v1/research/conversations/{id}");
  });

  it("names the caller the owner of the research, by construction", async () => {
    const resource = await endpoints.researchRunStart.policy.resource({ params: { id: RESEARCH }, query: undefined, body: { question: QUESTION, language: "en" }, session: READER });
    expect(resource).toEqual({ kind: "research", id: RESEARCH, ownerId: READER.id, organisationId: null });
  });
});

describe("POST /api/v1/research/conversations (§ 13)", () => {
  const open = (body: unknown) => handler(endpoints.researchConversationCreate, pipeline(READER))(post("/api/v1/research/conversations", body));

  it("opens a research from scratch, 201", async () => {
    const response = await open({ locale: "pt" });
    expect(response.status).toBe(201);
    expect(ResearchConversationSchema.parse(await response.json())).toEqual({ id: RESEARCH, locale: "pt", seed: null, createdAt: NOW.toISOString() });
    expect(fake.opened).toEqual([{ locale: "PT", seedMessageId: null }]);
  });

  it("opens one seeded from an answer of the caller's that answered and holds its words", async () => {
    fake.seed = { answered: true, gap: false, cited: ["21.3"] };
    const response = await open({ locale: "en", seedMessageId: SEED });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ seed: SEED });
  });

  it("refuses a seed that is no answer of the caller's, a refusal or a purged one alike: 422 SEED_INVALID, nothing opened", async () => {
    for (const seed of [null, { answered: false, gap: false, cited: [] }]) {
      fake.seed = seed;
      const response = await open({ locale: "en", seedMessageId: SEED });
      expect(response.status).toBe(422);
      expect(await codeOf(response)).toBe("SEED_INVALID");
    }
    expect(fake.opened).toEqual([]);
  });
});

describe("POST /api/v1/research/conversations/{id}/runs: the start's checks in § 5.2's order", () => {
  it("queues a run and starts its workflow after the commit: 202 { runId, state }, stored for a replay, no text in it", async () => {
    const response = await start();
    expect(response.status).toBe(202);
    const body = ResearchRunStartedSchema.parse(await response.json());
    expect(body).toEqual({ runId: RUN, state: "QUEUED" });
    expect(fake.started).toEqual([{ workflowId: `research:${RUN}`, runId: RUN, userId: READER.id }]);
    expect(fake.completed).toEqual([{ status: 202, body }]);
    expect(fake.inputs).toEqual([{ conversationId: RESEARCH, releaseId: "2026.09", locale: "EN", question: QUESTION, traceId: expect.stringMatching(/^[0-9a-f]{32}$/), seed: null, refusal: null }]);
  });

  it("1 refuses a question over 800 characters with 400 TEXT_TOO_LONG, before it looks for the research", async () => {
    fake.conversation = null;
    const response = await start({ question: "a".repeat(801), language: "en" });
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe("TEXT_TOO_LONG");
  });

  it("2 is 404 for a research that is not the caller's, and never replays a stored start for it", async () => {
    fake.conversation = null;
    const response = await start(undefined, { kind: "replay", status: 202, body: { runId: RUN, state: "QUEUED" } });
    expect(response.status).toBe(404);
    expect(fake.inputs).toEqual([]);
  });

  it("replays the stored first answer of the same key once the research is found, and starts nothing", async () => {
    const response = await start(undefined, { kind: "replay", status: 202, body: { runId: RUN, state: "REFUSED" } });
    expect(response.status).toBe(202);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual({ runId: RUN, state: "REFUSED" });
    expect(fake.inputs).toEqual([]);
    expect(fake.started).toEqual([]);
  });

  it("3 is 409 RESEARCH_IN_PROGRESS while the newest run is under way and its workflow runs", async () => {
    fake.newest = { id: RUN, userId: READER.id, state: "READING", workflowId: `research:${RUN}`, createdAt: STALE };
    fake.running = true;
    const response = await start();
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("RESEARCH_IN_PROGRESS");
    expect(fake.asked).toEqual([`research:${RUN}`]);
    expect(fake.abandoned).toEqual([]);
  });

  it("3 ends a run under way whose workflow no longer runs FAILED · ABANDONED, on the state it read, and the start goes on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const state of ["QUEUED", "PLANNING"] as const) {
      fake = reset();
      fake.newest = { id: OTHER_RUN, userId: READER.id, state, workflowId: `research:${OTHER_RUN}`, createdAt: STALE };
      const response = await start();
      expect(response.status).toBe(202);
      expect(fake.abandoned).toEqual([{ id: OTHER_RUN, from: state }]);
      expect(fake.started).toHaveLength(1);
    }
  });

  it("3 answers 409 for a QUEUED run younger than START_IN_FLIGHT_MS the engine does not know yet — another start in flight — and leaves it alone (review of unit 71)", async () => {
    /* longer than a start's request: the engine asked twice, each within its deadline, and the reads between */
    expect(START_IN_FLIGHT_MS).toBeGreaterThan(4 * WORKFLOWS_DEADLINE_MS);
    fake.newest = { id: OTHER_RUN, userId: READER.id, state: "QUEUED", workflowId: `research:${OTHER_RUN}`, createdAt: new Date(NOW.getTime() - START_IN_FLIGHT_MS + 1_000) };
    const response = await start();
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("RESEARCH_IN_PROGRESS");
    expect(fake.asked).toEqual([`research:${OTHER_RUN}`]);
    expect(fake.abandoned).toEqual([]);
    expect(fake.inputs).toEqual([]);
    /* a young row a workflow has moved is no start in flight: its workflow is gone, and it is ended */
    fake = reset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fake.newest = { id: OTHER_RUN, userId: READER.id, state: "PLANNING", workflowId: `research:${OTHER_RUN}`, createdAt: new Date(NOW.getTime() - 5_000) };
    expect((await start()).status).toBe(202);
    expect(fake.abandoned).toEqual([{ id: OTHER_RUN, from: "PLANNING" }]);
  });

  it("3 answers 409 where its conditional end changed nothing — the row moved since it was read — and goes no further (review of unit 71)", async () => {
    fake.newest = { id: OTHER_RUN, userId: READER.id, state: "QUEUED", workflowId: `research:${OTHER_RUN}`, createdAt: STALE };
    fake.abandons = false;
    const said = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await start();
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("RESEARCH_IN_PROGRESS");
    expect(fake.abandoned).toEqual([{ id: OTHER_RUN, from: "QUEUED" }]);
    expect(said).not.toHaveBeenCalled();
    expect(fake.inputs).toEqual([]);
    expect(fake.completed).toEqual([]);
  });

  it("3 is 503 RESEARCH_UNAVAILABLE where the engine cannot be asked, and ends nothing", async () => {
    fake.newest = { id: RUN, userId: READER.id, state: "PLANNING", workflowId: `research:${RUN}`, createdAt: STALE };
    fake.running = "unreachable";
    const response = await start();
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("RESEARCH_UNAVAILABLE");
    expect(fake.abandoned).toEqual([]);
  });

  it("does not ask the engine when the newest run has ended", async () => {
    fake.newest = { id: RUN, userId: READER.id, state: "REFUSED", workflowId: null, createdAt: NOW };
    expect((await start()).status).toBe(202);
    expect(fake.asked).toEqual([]);
  });

  it("4 is 403 ACCOUNT_DELETION_REQUESTED while a deletion request stands, 5 is 403 RESEARCH_OFF_ORGANISATION with the switch off", async () => {
    fake.gates = { deletionRequested: true, organisation: false };
    const deleting = await start();
    expect(deleting.status).toBe(403);
    expect(await codeOf(deleting)).toBe("ACCOUNT_DELETION_REQUESTED");
    fake.gates = { deletionRequested: false, organisation: false };
    const off = await start();
    expect(off.status).toBe(403);
    expect(await codeOf(off)).toBe("RESEARCH_OFF_ORGANISATION");
    expect(fake.inputs).toEqual([]);
  });

  it("6 is 402 BUDGET_EXCEEDED with the reset while the latest run's reset is ahead, and goes on once it passed", async () => {
    fake.reset = new Date("2026-11-01T00:00:00.000Z");
    fake.full = new Date("2026-10-13T09:00:00.000Z");
    const response = await start();
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "BUDGET_EXCEEDED", detail: { resetsAt: "2026-11-01T00:00:00.000Z" } });
    fake.reset = new Date("2026-10-01T00:00:00.000Z");
    fake.full = null;
    expect((await start()).status).toBe(202);
  });

  it("7 is 429 RESEARCH_DAILY_LIMIT with the instant the oldest of the thirty leaves the window", async () => {
    fake.full = new Date("2026-10-13T09:00:00.000Z");
    fake.configured = false;
    const response = await start();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RESEARCH_DAILY_LIMIT", detail: { resetsAt: "2026-10-13T09:00:00.000Z" } });
  });

  it("8 is 503 RESEARCH_UNAVAILABLE where no engine is configured, and writes nothing", async () => {
    fake.configured = false;
    const response = await start();
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("RESEARCH_UNAVAILABLE");
    expect(fake.inputs).toEqual([]);
  });

  it("writes a question the plant-equipment rule refuses as a REFUSED run with no workflow, and starts nothing (§ 5.2)", async () => {
    const response = await start({ question: "How do I bypass the interlock on the compressor?", language: "en" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: RUN, state: "REFUSED" });
    expect(fake.inputs[0]?.refusal).toBe("R-SCOPE-OT");
    expect(fake.started).toEqual([]);
    expect(fake.completed).toEqual([{ status: 202, body: { runId: RUN, state: "REFUSED" } }]);
  });

  it("writes a question that names an unverified chapter as REFUSED · R-UNVERIFIED, asking the release of the chapters it names", async () => {
    fake.passed = false;
    const response = await start({ question: "What does chapter 37 say about the harness cost?", language: "en" });
    expect(await response.json()).toEqual({ runId: RUN, state: "REFUSED" });
    expect(fake.inputs[0]?.refusal).toBe("R-UNVERIFIED");
    expect(fake.chapters).toEqual([[37]]);
    expect(fake.started).toEqual([]);
  });

  it("stores the question redacted with the process's secrets, and judges the redacted question", async () => {
    const leaky = researchEndpoints({ ...deps, secrets: () => ["s3cr3t-value-of-this-process"] });
    const response = await handler(leaky.researchRunStart, pipeline(READER))(post(`/api/v1/research/conversations/${RESEARCH}/runs`, { question: "Why would s3cr3t-value-of-this-process leak in a retry?", language: "pt" }, { "idempotency-key": KEY }), { params: { id: RESEARCH } });
    expect(response.status).toBe(202);
    expect(fake.inputs[0]).toMatchObject({ locale: "PT", question: "Why would [redacted:process-secret] leak in a retry?" });
  });

  it("hands the door a seeded research's seed for any start of it, the door deciding under its lock which run is the seeded one; none from scratch", async () => {
    fake.conversation = { ...CONVERSATION, seedMessageId: SEED };
    fake.seed = { answered: true, gap: true, cited: ["21.3", "21.4"] };
    expect((await start()).status).toBe(202);
    expect(fake.inputs[0]?.seed).toEqual({ answered: true, gap: true, cited: ["21.3", "21.4"] });
    /* a newest run that ended — refused by a rule, say — does not settle it here */
    fake.newest = { id: OTHER_RUN, userId: READER.id, state: "REFUSED", workflowId: null, createdAt: NOW };
    expect((await start()).status).toBe(202);
    expect(fake.inputs[1]?.seed).toEqual({ answered: true, gap: true, cited: ["21.3", "21.4"] });
    fake.conversation = CONVERSATION;
    expect((await start()).status).toBe(202);
    expect(fake.inputs[2]?.seed).toBeNull();
  });

  it("answers what the door finds under the research's lock: 409 for a run another start queued, 429 for the thirtieth, 404 for a research deleted meanwhile", async () => {
    fake.created = { created: false, reason: "IN_PROGRESS" };
    const racing = await start();
    expect(racing.status).toBe(409);
    expect(await codeOf(racing)).toBe("RESEARCH_IN_PROGRESS");
    fake.created = { created: false, reason: "DAILY_LIMIT", resetsAt: new Date("2026-10-13T09:00:00.000Z") };
    expect(await (await start()).json()).toMatchObject({ code: "RESEARCH_DAILY_LIMIT", detail: { resetsAt: "2026-10-13T09:00:00.000Z" } });
    fake.created = { created: false, reason: "NOT_FOUND" };
    expect((await start()).status).toBe(404);
    expect(fake.started).toEqual([]);
  });

  it("takes the row back to SKIPPED · UNAVAILABLE when the engine refuses the start, and answers 503 with nothing stored", async () => {
    fake.startFails = new WorkflowsUnavailableError("timeout", "the workflow engine did not answer in time");
    const response = await start();
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("RESEARCH_UNAVAILABLE");
    expect(fake.states).toEqual([{ id: RUN, state: "SKIPPED", extra: { skip: "UNAVAILABLE" } }]);
    expect(fake.completed).toEqual([]);
  });
});

describe("GET /api/v1/research/conversations/{id} and /research/runs/{id} (§ 13, § 16)", () => {
  const research = (id: string) => handler(endpoints.researchConversationRead, pipeline(READER))(new Request(`${BASE}/api/v1/research/conversations/${id}`, { headers }), { params: { id } });
  const run = (id: string) => handler(endpoints.researchRunRead, pipeline(READER))(new Request(`${BASE}/api/v1/research/runs/${id}`, { headers }), { params: { id } });

  it("reads a research with its runs' views, and a run's view; 404 for none of the caller's", async () => {
    const read = await research(RESEARCH);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ id: RESEARCH, locale: "en", seed: null, createdAt: CONVERSATION.createdAt.toISOString(), textPurgedAt: null, runs: [VIEW] });
    expect(await (await run(RUN)).json()).toEqual(VIEW);
    expect((await run(SEED)).status).toBe(404);
    fake.conversation = null;
    expect((await research(RESEARCH)).status).toBe(404);
  });
});

describe("POST /api/v1/research/runs/{id}/flag (§ 11.7)", () => {
  const flag = (body: unknown) => handler(endpoints.researchRunFlag, pipeline(READER))(post(`/api/v1/research/runs/${RUN}/flag`, body), { params: { id: RUN } });

  it("flags a report once, and answers the door's refusals: 404, 409 FLAG_DUPLICATE, 422 UNPROCESSABLE", async () => {
    const first = await flag({ kind: "report", reason: "wrong_citation" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ runId: RUN, kind: "report", reason: "wrong_citation", at: NOW.toISOString() });
    for (const [reason, status, code] of [["KIND_MISMATCH", 422, "UNPROCESSABLE"], ["NOT_FOUND", 404, "NOT_FOUND"]] as const) {
      fake.flagged = { flagged: false, reason };
      const response = await flag({ kind: "refusal", reason: "should_not_refuse" });
      expect(response.status).toBe(status);
      expect(await codeOf(response)).toBe(code);
    }
  });

  it("answers a second flag 409 FLAG_DUPLICATE with the flag that stands read back, its kind and reason (§ 18; review of unit 71)", async () => {
    fake.flagged = { flagged: false, reason: "DUPLICATE", stored: { kind: "report", reason: "wrong_citation" } };
    const response = await flag({ kind: "refusal", reason: "should_not_refuse" });
    expect(response.status).toBe(409);
    expect(ErrorBodySchema.parse(await response.json())).toMatchObject({ code: "FLAG_DUPLICATE", detail: { kind: "report", reason: "wrong_citation" } });
  });

  it("takes only the two kinds and the answers' reasons", async () => {
    expect((await flag({ kind: "answer", reason: "other" })).status).toBe(400);
    expect((await flag({ kind: "report", reason: "a sentence" })).status).toBe(400);
  });
});

describe("DELETE /api/v1/research/conversations/{id} (§ 17.2, § 15)", () => {
  const remove = () => handler(endpoints.researchConversationDelete, pipeline(READER))(new Request(`${BASE}/api/v1/research/conversations/${RESEARCH}`, { method: "DELETE", headers }), { params: { id: RESEARCH } });

  it("deletes through the door, then appends one ERASED record by the person about the research, from a bucket of its own", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: RESEARCH, deleted: true, ledgerSeq: 9001 });
    expect(fake.appended).toEqual([{ kind: "ERASED", actor: `user:${READER.id}`, suggestionId: null, chapterVersionId: null, payload: { stepKey: researchErasedStepKeyOf(RESEARCH), scope: { kind: "research", id: RESEARCH } } }]);
    expect(buckets).toEqual([`user:${READER.id}:DELETE /api/v1/research/conversations/{id}`]);
  });

  it("answers the record already under the step key, lets the deletion stand when the append fails, and is 404 for none", async () => {
    fake.recorded = { seq: 4242 };
    expect(await (await remove()).json()).toEqual({ id: RESEARCH, deleted: true, ledgerSeq: 4242 });
    fake.recorded = null;
    fake.appendFails = true;
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await (await remove()).json()).toEqual({ id: RESEARCH, deleted: true, ledgerSeq: null });
    expect(said).toHaveBeenCalledWith("research deleted: its ERASED record was not appended", expect.stringMatching(/^[0-9a-f]{32}$/), RESEARCH, "the chain's head did not answer");
    fake.removed = { deleted: false };
    expect((await remove()).status).toBe(404);
    expect(fake.appended).toEqual([]);
  });
});

describe("GET /api/v1/research/conversations/{id}/export (§ 11.10; unit 73)", () => {
  const exported = () => handler(endpoints.researchConversationExport, pipeline(READER))(new Request(`${BASE}/api/v1/research/conversations/${RESEARCH}/export`, { headers }), { params: { id: RESEARCH } });

  it("answers the research's records signed, as a download, and records the export by the person, scope research, with the file's hash", async () => {
    const response = await exported();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="hb-research-${RESEARCH}.jsonl"`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const file = Buffer.from(await response.arrayBuffer());
    expect(file.toString("utf8")).toBe('{"seqs":[12,40]}\n');
    const { createHash } = await import("node:crypto");
    expect(fake.appended).toEqual([
      { kind: "EXPORT", actor: `user:${READER.id}`, suggestionId: null, chapterVersionId: null, payload: { scope: { kind: "research", id: RESEARCH, from: null, to: null }, fromSeq: 12, toSeq: 40, records: 2, headHash: "a".repeat(64), fileSha256: createHash("sha256").update(file).digest("hex") } },
    ]);
  });

  it("is NOT_FOUND for a research not the caller's, and NOTHING_TO_EXPORT for one with no record — the catalogue's 404, as the Assistant's — signing nothing and recording nothing", async () => {
    fake.records = null;
    const foreign = await exported();
    expect(foreign.status).toBe(404);
    expect(await codeOf(foreign)).toBe("NOT_FOUND");
    fake.records = [];
    fake.exportFails = new Error("the key was asked for");
    const none = await exported();
    expect(none.status).toBe(404);
    expect(await codeOf(none)).toBe("NOTHING_TO_EXPORT");
    expect(fake.appended).toEqual([]);
  });

  it("refuses to sign without the platform's key: INTERNAL to the person, the variable named in the log, nothing recorded", async () => {
    const { AppError } = await import("@/lib/errors");
    fake.exportFails = new AppError("LEDGER_KEY_MISSING", "LEDGER_EXPORT_KEY is not set");
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await exported();
    expect(response.status).toBe(500);
    expect(await codeOf(response)).toBe("INTERNAL");
    expect(said).toHaveBeenCalledWith("export refused", expect.stringMatching(/^[0-9a-f]{32}$/), "LEDGER_EXPORT_KEY is not set");
    fake.exportFails = new AppError("LEDGER_EXPORT_EMPTY", "the scope matches no record");
    expect(await codeOf(await exported())).toBe("NOTHING_TO_EXPORT");
    expect(fake.appended).toEqual([]);
  });
});
