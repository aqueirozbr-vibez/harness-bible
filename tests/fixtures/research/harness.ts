import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { Client } from "@temporalio/client";

import { FIXTURE_PAGES } from "@/infra/gateway/stub/research";
import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendUserMessage } from "@/lib/db/assistant";
import { appendBudgetRow, type BudgetRowInput } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { createResearchRun, readFindings } from "@/lib/db/research";
import { withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import type { ResearchSkip, ResearchState } from "@/lib/schemas/research";
import { researchWorkflowId, SUGGESTION_WAITS_QUERY, SuggestionWaitsSchema, suggestionWorkflowId } from "@/lib/schemas/workflows";
import { defaultEvidenceDeps, evidenceActivities } from "@/workers/activities/evidence";
import { defaultMergeDeps, mergeActivities } from "@/workers/activities/merge";
import { defaultResearchDeps, researchActivities } from "@/workers/activities/research";
import { defaultResearchRunDeps, researchRunActivities as personRunActivities, type ResearchRunActivityDeps } from "@/workers/activities/researchRun";
import { defaultSuggestionDeps, suggestionActivities } from "@/workers/activities/suggestion";
import { adjudicate } from "@/workers/agents/adjudicator/adjudicate";
import { gradeEvidence } from "@/workers/agents/grader/evidence";
import type { FetchOutcome } from "@/workers/fetch/fetch";
import { defaultPlanStepDeps, planStep } from "@/workers/research/plan";
import { defaultReadStepDeps, readStep } from "@/workers/research/read";
import { defaultRecordStepDeps, recordResearch } from "@/workers/research/record";
import { defaultPlanRunDeps, planRunStep, retrieveSections } from "@/workers/research/run/plan";
import { defaultReadRunDeps, readRunStep } from "@/workers/research/run/read";
import { read as readOnce } from "@/workers/agents/researcher/v2/reader";
import { defaultWriteRunDeps, writeRunStep } from "@/workers/research/run/write";

/*
 * A research run on the stub (feature-specs/41 § 11; 42 § 10; 43 § 13.11), shared by the end-to-end suite
 * (tests/integration/research-run.test.ts), the research seed (scripts/research-seed.ts) and, since unit 75, the road
 * of research on request (tests/research/road.test.ts), whose sent finding's suggestion these vet: the stub gateway in
 * this process with a key minted at it, the research activities and the suggestion's, the grader's and the merge's on that
 * stub, a fetcher that serves the stub's fixture pages as the product's own fetcher would open them, a turn handed over
 * in a conversation, and the suggestions a run made settled before the worker stops. No model is asked: every call is
 * the stub's, and its rows are kept here, not in the budget ledger. The run's own records are the ledger's, as every
 * record is.
 */

/** The research principal the runs are paid by (40 § 7.1): an organisation of the stub's, never charged anywhere. */
export const RESEARCH_PRINCIPAL_DOUBLE = { organisationId: "00000000-0000-4000-8000-0000000d00aa" } as const;

export interface ResearchStub {
  readonly url: string;
  /** The rows the gateway's client would append to the budget ledger, kept here instead. */
  readonly rows: BudgetRowInput[];
  /** Each request's model and body, in order. */
  readonly bodies: Array<{ readonly model: string; readonly body: string }>;
  /** What the stub said of each request. */
  readonly log: string[];
  readonly gateway: (headers: Record<string, string>) => GatewayDeps;
  readonly close: () => Promise<void>;
}

/** The stub on a port of its own, its aliases the gateway's, and a key minted at it with a budget no run reaches. */
export async function startResearchStub(): Promise<ResearchStub> {
  const masterKey = randomBytes(24).toString("hex");
  const keySecret = randomBytes(32).toString("hex");
  const log: string[] = [];
  const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
  const stub: RunningStub = await startStub({ masterKey, aliases, port: 0, log: (line) => log.push(line) });
  const minted = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 1_000 }) });
  const key = ((await minted.json()) as { key: string }).key;
  const rows: BudgetRowInput[] = [];
  const bodies: Array<{ readonly model: string; readonly body: string }> = [];
  const gateway = (headers: Record<string, string>): GatewayDeps => ({
    baseUrl: stub.url,
    keySecret,
    findKey: async () => ({ keyCiphertext: encryptKey(keySecret, key) }),
    append: async (row) => {
      rows.push(row);
    },
    log: () => undefined,
    fetch: async (input, init) => {
      const merged = new Headers(init?.headers);
      for (const [name, value] of Object.entries(headers)) merged.set(name, value);
      if (typeof init?.body === "string") bodies.push({ model: (JSON.parse(init.body) as { model: string }).model, body: init.body });
      return globalThis.fetch(input, { ...init, headers: merged });
    },
    now: () => new Date(),
  });
  return { url: stub.url, rows, bodies, log, gateway, close: () => stub.close() };
}

/** The stub's fixture pages as the product's own fetcher would open them (42 § 4.2): those pages, and nothing else. */
export async function fixtureFetch(url: string): Promise<FetchOutcome> {
  const fetchedAt = new Date();
  const page = Object.values(FIXTURE_PAGES).find((candidate) => candidate.url === url);
  if (page === undefined) return { outcome: "unreachable", fetchStatus: "unreachable:404", cause: "404", at: url, url, redirects: 0, fetchedAt };
  const body = Buffer.from(`<html><head><title>${page.title}</title></head><body><p>${page.text}</p></body></html>`, "utf8");
  return { outcome: "opened", fetchStatus: "opened:200", url, finalUrl: url, redirects: 0, contentType: "text/html", charset: "utf-8", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), body, document: { kind: "html", title: page.title, text: page.text, publishedOn: "2026-09-01", canonicalUrl: null }, fetchedAt };
}

/**
 * The real activities of a run and of the suggestions it makes, their model calls on the stub — the research ones with
 * the case's headers, the grader's at the case's tier (`B:direct:none`, a tier with its relevance and stake, is the
 * accept line's 85) — their records on the database, paid by the research principal double.
 */
export function researchRunActivities(stub: ResearchStub, headers: Record<string, string>, grade = "B:direct:none") {
  const principal = () => RESEARCH_PRINCIPAL_DOUBLE;
  const suggestion = suggestionActivities({ ...defaultSuggestionDeps(), researchPrincipal: principal, adjudicate: (input) => adjudicate(input, { gateway: stub.gateway({}) }) });
  const evidence = evidenceActivities({
    ...defaultEvidenceDeps(),
    researchPrincipal: principal,
    fetch: fixtureFetch,
    openDoi: () => Promise.reject(new Error("no finding cites a DOI")),
    grade: (input) => gradeEvidence(input, { gateway: stub.gateway({ "x-hb-stub-grade": grade }), now: () => new Date() }),
  });
  const merge = mergeActivities({ ...defaultMergeDeps(), repo: () => Promise.reject(new Error("no research run here writes the book's repository")) });
  const research = researchActivities({
    ...defaultResearchDeps(),
    plan: (run) => planStep(run, { ...defaultPlanStepDeps(), principal, rubric: async () => null, planner: { gateway: stub.gateway(headers) }, log: () => undefined }),
    read: (run) => readStep(run, { ...defaultReadStepDeps(), principal, rubric: async () => null, reader: { gateway: stub.gateway(headers) }, log: () => undefined }),
    record: (run, end) =>
      recordResearch(run, end, {
        ...defaultRecordStepDeps(),
        principal,
        calls: async (_principal, runId) => stub.rows.filter((row) => row.kind === "RESEARCH" && row.ref === runId).map((row) => ({ alias: row.alias, modelId: row.modelId, outcome: row.outcome, inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens })),
        log: () => undefined,
      }),
  });
  return { ...suggestion, ...evidence, ...merge, ...research };
}

/**
 * A person's run's activities on the stub (feature-specs/48 § 5; unit 70b), shared by the end-to-end suite of research
 * on request (tests/integration/research-on-demand.test.ts) and its road (tests/research/road.test.ts): the planner,
 * retrieval's two calls, the reader and the writer on the stub with the case's headers, each call's row kept in the
 * stub's list and appended to the budget
 * ledger as the gateway's client appends it — under the person's own principal, where the run's record reads them
 * (48 § 15) — and the rubric none, so a figure's tier reads as the guide's own letter. No research principal is given:
 * a person's run never asks for one. `over` replaces any of the activities' own dependencies; `onReaderAnswered` is
 * told when the reader's turn came back, so a case can tell the steps written while it streamed from those after.
 */
export function researchRunOnStub(stub: ResearchStub, headers: Record<string, string>, options: { readonly over?: Partial<ResearchRunActivityDeps>; readonly onReaderAnswered?: () => void } = {}) {
  const gateway: GatewayDeps = {
    ...stub.gateway(headers),
    append: async (row) => {
      stub.rows.push(row);
      await appendBudgetRow(row);
    },
  };
  return personRunActivities({
    ...defaultResearchRunDeps(),
    plan: (run) => planRunStep(run, { ...defaultPlanRunDeps(), rubric: async () => null, retrieve: retrieveSections(gateway), planner: { gateway }, log: () => undefined }),
    read: (run, steps, signal) =>
      readRunStep(
        run,
        steps,
        {
          ...defaultReadRunDeps(),
          rubric: async () => null,
          reader: { gateway },
          read: async (input, deps) => {
            const answer = await readOnce(input, deps);
            options.onReaderAnswered?.();
            return answer;
          },
          log: () => undefined,
        },
        signal,
      ),
    write: (run, signal) => writeRunStep(run, { ...defaultWriteRunDeps(), rubric: async () => null, writer: { gateway }, log: () => undefined }, signal),
    log: () => undefined,
    ...options.over,
  });
}

export interface HandedOver {
  readonly runId: string;
  readonly messageId: string;
}

/**
 * A turn answered in a conversation and handed over (40 § 4): the question, the answer citing the section, what it left
 * uncovered, and the run's row in the state asked — QUEUED for a run to start, any other for a line to show.
 */
export async function handOverTurn(
  asker: SessionUser,
  conversationId: string,
  turn: { readonly question: string; readonly cited: string; readonly releaseId: string; readonly ordinal: number; readonly traceId: string; readonly state?: ResearchState; readonly skip?: ResearchSkip | null; readonly failure?: string | null },
): Promise<HandedOver> {
  await appendUserMessage(asker, conversationId, { text: turn.question, mode: "explain", traceId: turn.traceId });
  const section = parseSectionId(turn.cited);
  const result = {
    kind: "answer",
    refusal: null,
    claims: [{ text: "A retried write without a key is a second write.", sectionId: section, figureId: null, valueText: null, found: true, substituted: false }],
    citations: [{ sectionId: section, figureId: null, version: "v1.0.0", editionLang: "EN" }],
    verdicts: [],
    grounded: 0.9,
    repaired: false,
    guide: { version: "v1.13", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 1, firstTokenMs: 1, draftMs: 1, sensorsMs: 1, graderMs: 1, totalMs: 6 },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
    modeResult: null,
    uncovered: [{ sectionId: turn.cited, text: "Idempotency keys are also what makes a retried refund safe." }],
    retrievedSections: [turn.cited],
  } as AnswerResult;
  /* no ledger record: a made-up one would hand the chain's record #1 to whoever exports the conversation (review of unit 60) */
  const answer = await appendAssistantMessage(asker, conversationId, result, { ordinal: turn.ordinal, mode: "EXPLAIN", traceId: turn.traceId, promptSha256: "b".repeat(64), overBudget: false, ledger: null });
  const state = turn.state ?? "QUEUED";
  const skipped = state === "SKIPPED";
  const run = await createResearchRun(asker, { messageId: answer.id, releaseId: turn.releaseId, locale: "EN", gap: true, sectionAnchors: [turn.cited], questionSha256: createHash("sha256").update(turn.question).digest("hex"), traceId: turn.traceId, state: skipped ? "SKIPPED" : "QUEUED", skip: skipped ? (turn.skip ?? "UNAVAILABLE") : null, workflowId: skipped ? null : researchWorkflowId(answer.id) }, new Date());
  /* a line's state other than a run's start, written as the run would have left it */
  if (!skipped && state !== "QUEUED") await withTenant(tenantOf(asker), () => getPrisma().researchRun.update({ where: { id: run.id }, data: { state, failure: turn.failure ?? null, ...(state === "DONE" || state === "FAILED" ? { finishedAt: new Date() } : {}) } }));
  return { runId: run.id, messageId: answer.id };
}

/**
 * The suggestions a run submitted, each parked where its decision left it or ended, before the worker stops: the run
 * reads a suggestion's place the moment its row says so, while the suggestion's own workflow may still have a task to
 * take. One parked in the queue is ended here, as no curator decides it on this engine.
 */
export async function settleSuggestions(client: Client, asker: Pick<SessionUser, "id">, runId: string): Promise<void> {
  for (const finding of await readFindings({ id: runId, userId: asker.id })) {
    if (finding.suggestionId === null) continue;
    const handle = client.workflow.getHandle(suggestionWorkflowId(finding.suggestionId));
    for (let tries = 0; tries < 300; tries += 1) {
      if ((await handle.describe()).status.name !== "RUNNING") break;
      const waits = SuggestionWaitsSchema.parse(await handle.query(SUGGESTION_WAITS_QUERY));
      if (waits !== null) {
        await handle.terminate("the run's harness has what it needs");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** The asker's conversations whose first question is this one, asked under the seed's trace: a seed's own, found again to be replaced — never a conversation the reader began with the same words (review of unit 60). */
export async function conversationsAsking(asker: SessionUser, question: string, traceId: string): Promise<ReadonlyArray<string>> {
  const firsts = await withTenant(tenantOf(asker), () => getPrisma().message.findMany({ where: { role: "USER", ordinal: 1, text: question, traceId }, select: { conversationId: true } }));
  return [...new Set(firsts.map((message) => message.conversationId))];
}

/**
 * The researcher's suggestions an asker's findings made, gone with their rows and stored evidence — moved back to draft
 * so that they can go, a move nothing of the product makes, the Improve harness's own way — and the asker's research
 * rows, messages and conversations: all of them, or those of the conversations named. A `DUPLICATE` finding names a
 * suggestion someone else's run or person made, which is never this asker's to remove. Their ledger records stay.
 * Given a trace, only the suggestions of runs under it go: a real question asked in a seeded conversation keeps its own.
 */
export async function clearResearchOf(asker: SessionUser, conversationIds: ReadonlyArray<string> | null = null, traceId: string | null = null): Promise<void> {
  const inConversations = { ...(conversationIds === null ? {} : { message: { conversationId: { in: [...conversationIds] } } }), ...(traceId === null ? {} : { traceId }) };
  /* everything of the asker's: a finding kept when its detached run was swept included, which has no run to filter by (45 § 3.5) */
  const everything = conversationIds === null && traceId === null;
  const made = await withTenant(tenantOf(asker), () => getPrisma().researchFinding.findMany({ where: { suggestionId: { not: null }, outcome: { in: ["SUBMITTED", "PROPOSED", "REFUTED"] }, ...(everything ? {} : { run: inConversations }) }, select: { suggestionId: true } }));
  const suggestionIds = made.flatMap((finding) => (finding.suggestionId === null ? [] : [finding.suggestionId]));
  if (suggestionIds.length > 0) {
    /* an endorsement's row goes with its suggestion, by its key */
    const prisma = getPrisma();
    await prisma.evidenceItem.deleteMany({ where: { suggestionId: { in: suggestionIds } } });
    await prisma.criterionVerdict.deleteMany({ where: { suggestionId: { in: suggestionIds } } });
    await prisma.adjudication.deleteMany({ where: { suggestionId: { in: suggestionIds } } });
    await prisma.suggestionSensorVerdict.deleteMany({ where: { suggestionId: { in: suggestionIds } } });
    await prisma.anchor.deleteMany({ where: { suggestionId: { in: suggestionIds } } });
    await prisma.suggestion.updateMany({ where: { id: { in: suggestionIds }, origin: "RESEARCHER" }, data: { state: "DRAFT", submittedAt: null, workflowId: null } });
    await prisma.suggestion.deleteMany({ where: { id: { in: suggestionIds }, origin: "RESEARCHER", state: "DRAFT" } });
    for (const id of suggestionIds) await rm(join(env.OBJECT_STORE_DIR, "evidence", id), { recursive: true, force: true });
  }
  await withTenant(tenantOf(asker), async () => {
    const prisma = getPrisma();
    const conversations = conversationIds === null ? {} : { id: { in: [...conversationIds] } };
    const messages = await prisma.message.findMany({ where: conversationIds === null ? {} : { conversationId: { in: [...conversationIds] } }, select: { id: true } });
    const ids = messages.map((message) => message.id);
    await prisma.researchFinding.deleteMany({ where: { run: { messageId: { in: ids } } } });
    await prisma.researchRun.deleteMany({ where: { messageId: { in: ids } } });
    if (conversationIds === null) {
      /* the asker's runs a conversation's delete detached, and the findings the sweep kept (45 § 3.5) */
      await prisma.researchFinding.deleteMany({ where: { OR: [{ runId: null }, { run: { messageId: null } }] } });
      await prisma.researchRun.deleteMany({ where: { messageId: null } });
    }
    /* a flag's key to its message is RESTRICT, as a citation's and a verdict's are */
    await prisma.flag.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.message.deleteMany({ where: { id: { in: ids } } });
    await prisma.conversation.deleteMany({ where: conversations });
  });
}
