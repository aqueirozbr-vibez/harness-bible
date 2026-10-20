import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDevUser } from "@/lib/auth/link";
import type { SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { adjudicatorAgreement, closedResearchProposals, researcherEvidence, researcherSuggestionsForGate } from "@/lib/db/improve";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { formatGateReport } from "@/lib/gate/common";
import { REPORTS_DIR } from "@/lib/gate/goldenRun";
import { selectTests, type TestOutcome, type TestSelection, type Unmeasured } from "@/lib/gate/phase4";
import { budgetCriterion, checkCriterion, curatorFirstCriterion, evidenceCriterion, formatResearchExtras, researchMeasures, researchReport, suitesCriterion, turnsCriterion, type CuratorFirstFacts, type EvidenceFacts, type MeasureFacts, type ResearchBudgetFacts, type ResearchCheckFacts, type TurnsFacts } from "@/lib/gate/research";
import { runOpa, runVitest } from "@/lib/gate/run";
import { refutedLinesOf } from "@/lib/improve/researchLog";
import { researchMetrics } from "@/lib/metrics/research";
import { GoldenItemSchema } from "@/lib/schemas/golden";
import { evidenceSourceKey } from "@/lib/schemas/storage";
import { CuratorPayloadSchema, EndorsedPayloadSchema, MergedPayloadSchema, ResearchPayloadSchema } from "@/lib/schemas/ledger";
import { ROUTE_TIMEOUT_MS } from "@/lib/workers/client";
import { clearConversations, sessionOf } from "@/workers/gate/goldenDeps";
import { measureResearchTurns } from "@/workers/gate/researchTurns";
import { startStubStack } from "@/workers/gate/stubStack";

/*
 * npm run gate:research — the researcher's gate (feature-specs/44; unit 61b). Eleven criteria: most are the suites the
 * specs name, run here through vitest's JSON reporter on the stub gateway and the engine's test server, so the gate
 * makes no model call; R1 is also the gate's own turns through the workers over the stub (workers/gate/researchTurns.ts);
 * R5, R6 and R9 read the database and the ledger; R11 reads what `npm run research:check` wrote, and is blocked until
 * Andre has run it. § 3's measures are printed beneath and never move the exit. Writes
 * pipeline/reports/research-gate-<release>.json and exits 1 unless every criterion passes.
 *
 * It needs what the suites always need (context/code-standards.md: the database, the engine's address and namespace,
 * the store's directory and secret, the policy sidecar) and `opa` on the PATH or at OPA_BIN. The suites run without the
 * research principal in their environment: none of the gate's may start a run that this machine's workers, which read
 * the web on the real provider, would take.
 *
 * Since unit 75 (feature-specs/48 § 25) R1, R2, R3, R8 and R9 read as research on request has them: an answered turn
 * starts nothing; the thirty a day and the organisation's switch are the start endpoint's; the canary runs through the
 * planner, the reader and the writer; the road starts from an answer's `Start a research` (tests/research/); and a run
 * is the person's to pay, Improve's vetting of a sent finding the platform's. The legacy run's suites stay where a
 * criterion still holds of it (R3's legacy reader, R4, R5, R7, R10): its workflow stays registered until unit 78.
 */

const GATE_EMAIL = "research-gate@harness-bible.local";

/** The files the criteria name, run once; each criterion selects its tests by file and name. */
const SUITE_FILES = [
  "tests/research/road.test.ts",
  "tests/research-contract.test.ts",
  "tests/integration/research-on-demand.test.ts",
  "tests/integration/research-api.test.ts",
  "tests/integration/research-door.test.ts",
  "tests/integration/research-findings.test.ts",
  "tests/integration/research-rows.test.ts",
  "tests/integration/research-run.test.ts",
  "tests/workflows/research.test.ts",
  "tests/workflows/researchRun.test.ts",
  "workers/agents/researcher/reader.test.ts",
  "workers/agents/researcher/v2/canary.test.ts",
  "workers/agents/researcher/v2/reader.test.ts",
  "workers/agents/researcher/v2/writer.test.ts",
  "workers/research/submit.test.ts",
  "lib/research/validate.test.ts",
  "lib/improve/decision.test.ts",
  "lib/improve/researchLog.test.ts",
  "lib/improve/history.test.ts",
  "lib/api/endpoints/curation-decision.test.ts",
  "lib/gateway/client.test.ts",
  "tests/integration/merge.test.ts",
];

const sel = (outcomes: ReadonlyArray<TestOutcome>, label: string, file: string, name?: RegExp): TestSelection => ({ label, tests: selectTests(outcomes, file, name), expected: null });

/** R1: the gate's own turns, through the workers over the stub, on its own reader, everything of them cleared after. */
async function ownTurns(releaseId: string): Promise<TurnsFacts | Unmeasured> {
  const golden = readFileSync(join(process.cwd(), "golden", "assistant", `${releaseId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)));
  const verified = new Set((await getPrisma().chapterVersion.findMany({ where: { releaseId, verifyStatus: "PASSED" }, select: { chapterNumber: true } })).map((row) => row.chapterNumber));
  const account = await resolveDevUser(GATE_EMAIL, "en");
  const user: SessionUser = sessionOf(account.userId, account.organisationId);
  const stack = await startStubStack();
  try {
    await clearConversations(user);
    return await measureResearchTurns({
      golden,
      verified,
      user,
      workers: { baseUrl: stack.url, token: stack.token, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS },
      stack,
      log: (line) => console.log(`  ${line}`),
    });
  } finally {
    /* the gate's conversations */
    await clearConversations(user);
    await stack.close();
  }
}

/** R5: every evidence item of every researcher's suggestion, as the fetcher left it. */
async function evidenceFacts(): Promise<EvidenceFacts> {
  const items = await researcherEvidence();
  const settled = items.filter((item) => item.state !== "PENDING");
  const withText = settled.filter((item) => item.textKey !== null);
  return {
    suggestions: new Set(items.map((item) => item.suggestionId)).size,
    items: settled.length,
    pending: items.length - settled.length,
    opened: withText.length,
    withoutFetch: settled.filter((item) => item.fetchStatus === null).map((item) => item.id),
    textWithoutHash: settled.filter((item) => (item.textKey === null) !== (item.contentSha256 === null)).map((item) => item.id),
    textNotOpened: withText.filter((item) => !(item.fetchStatus ?? "").startsWith("opened:")).map((item) => item.id),
    missingText: withText.filter((item) => !existsSync(join(env.OBJECT_STORE_DIR, ...(item.textKey ?? "").split("/")))).map((item) => item.id),
    /* the source the fetcher received, read back and hashed as its row says (an upload's is under its own key, and is not a researcher's) */
    sourceMismatch: withText
      .filter((item) => (item.fetchStatus ?? "").startsWith("opened:"))
      .filter((item) => {
        const path = join(env.OBJECT_STORE_DIR, ...evidenceSourceKey(item.suggestionId, item.id).split("/"));
        return !existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") !== item.contentSha256;
      })
      .map((item) => item.id),
  };
}

/** R6: every `merged` record of a researcher's suggestion, and whether a curator's accept of it came first. */
async function curatorFirstFacts(): Promise<CuratorFirstFacts> {
  const records = await getPrisma().ledgerRecord.findMany({ where: { kind: { in: ["MERGED", "CURATOR"] }, suggestionId: { not: null } }, orderBy: { seq: "asc" }, select: { seq: true, kind: true, suggestionId: true, payload: true } });
  const merged = records.filter((record) => record.kind === "MERGED" && MergedPayloadSchema.safeParse(record.payload).data?.origin === "RESEARCHER");
  const withoutAccept = merged.filter((record) => !records.some((earlier) => earlier.seq < record.seq && earlier.suggestionId === record.suggestionId && earlier.kind === "CURATOR" && CuratorPayloadSchema.safeParse(earlier.payload).data?.action === "ACCEPT"));
  return { merged: merged.length, withoutAccept: withoutAccept.map((record) => record.suggestionId ?? "") };
}

/**
 * R9 (48 § 7, A3): each person's runs — a run of a research, which carries an ordinal — read in their own context, their
 * research calls on their own principal counted, and any call naming one of them on the platform's research principal
 * found; and that principal's months against its gateway budget. The principal is the organisation whose
 * `researchPrincipal` is true (48 § 7.3), as the views find it, never the workers' environment.
 */
async function budgetFacts(): Promise<ResearchBudgetFacts> {
  const prisma = getPrisma();
  const platform = await prisma.organisation.findFirst({ where: { researchPrincipal: true }, select: { id: true } });
  const people = await withSystem(() => prisma.user.findMany({ select: { id: true, organisationId: true } }));
  const personRunsOnPlatform: string[] = [];
  let personCalls = 0;
  for (const person of people) {
    const runs = (await withTenant({ userId: person.id, organisationId: person.organisationId }, () => prisma.researchRun.findMany({ where: { ordinal: { not: null } }, select: { id: true } }))).map((run) => run.id);
    if (runs.length === 0) continue;
    personCalls += await withTenant({ userId: person.id, organisationId: person.organisationId }, () => prisma.budgetLedger.count({ where: { kind: "RESEARCH", ref: { in: runs } } }));
    if (platform === null) continue;
    const onPlatform = await withTenant({ userId: null, organisationId: platform.id }, () => prisma.budgetLedger.findMany({ where: { ref: { in: runs } }, distinct: ["ref"], select: { ref: true } }));
    personRunsOnPlatform.push(...onPlatform.flatMap((row) => (row.ref === null ? [] : [row.ref])));
  }
  if (platform === null) return { principal: null, personRunsOnPlatform, personCalls, months: [] };
  const [months, key] = await withTenant({ userId: null, organisationId: platform.id }, () => Promise.all([prisma.budgetLedger.groupBy({ by: ["month"], _sum: { costUsd: true }, orderBy: { month: "asc" } }), prisma.gatewayKey.findFirst({ select: { maxBudgetUsd: true } })]));
  const capUsd = key === null ? null : Number(key.maxBudgetUsd);
  return { principal: `org:${platform.id}`, personRunsOnPlatform, personCalls, months: months.map((month) => ({ month: month.month, spentUsd: Number(month._sum.costUsd ?? 0), capUsd })) };
}

/** R11: the newest facts `npm run research:check` wrote, or none. */
function checkFacts(): { readonly file: string; readonly facts: ResearchCheckFacts } | null {
  if (!existsSync(REPORTS_DIR)) return null;
  const newest = readdirSync(REPORTS_DIR)
    .filter((name) => /^research-check-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .at(-1);
  return newest === undefined ? null : { file: `pipeline/reports/${newest}`, facts: JSON.parse(readFileSync(join(REPORTS_DIR, newest), "utf8")) as ResearchCheckFacts };
}

/** § 3: the measures, from the series, the improvement tables and the ledger, to date. */
async function measureFacts(now: Date): Promise<{ readonly facts: MeasureFacts; readonly records: number }> {
  const prisma = getPrisma();
  const window = { from: new Date(Date.UTC(2026, 0, 1)), to: new Date(now.getTime() + 86_400_000) };
  const series = new Map((await researchMetrics(window)).map((entry) => [entry.series, entry.months]));
  const byKey = (name: string): Record<string, number> => {
    const totals: Record<string, number> = {};
    for (const point of series.get(name) ?? []) totals[point.key] = (totals[point.key] ?? 0) + (point.n ?? 0);
    return totals;
  };
  const spend = (series.get("cost-per-run") ?? []).reduce((sum, point) => ({ usd: sum.usd + (point.n ?? 0), runsRead: sum.runsRead + (point.d ?? 0) }), { usd: 0, runsRead: 0 });
  /* the runs and their findings from the same records, so that a yield is over the runs whose findings it counts */
  const records = (await prisma.ledgerRecord.findMany({ where: { kind: "RESEARCH" }, select: { payload: true } })).flatMap((record) => {
    const parsed = ResearchPayloadSchema.safeParse(record.payload);
    return parsed.success ? [parsed.data] : [];
  });
  const findings: Record<string, number> = { all: 0 };
  for (const record of records) {
    for (const finding of record.findings) {
      findings.all = (findings.all ?? 0) + 1;
      findings[finding.outcome] = (findings[finding.outcome] ?? 0) + 1;
    }
  }
  const proposals = byKey("proposals");
  /* the closed proposals as the research log reads them: what refuted each, and its strongest tier */
  const refuted = refutedLinesOf(await closedResearchProposals({ kind: "user", userId: "research-gate", role: "CURATOR", parts: [] }, window.from));
  const refutedBy: Record<string, number> = {};
  const refutedTiers: Record<string, number> = {};
  for (const line of refuted) {
    refutedBy[line.by] = (refutedBy[line.by] ?? 0) + 1;
    if (line.tier !== null) refutedTiers[line.tier] = (refutedTiers[line.tier] ?? 0) + 1;
  }
  /* the researcher's suggestions that reached a curator, their decisions, merges and names */
  const researched = await researcherSuggestionsForGate();
  const shown = researched.filter((row) => row.state === "CURATOR_QUEUE" || row.state === "MERGING" || row.state === "MERGED" || row.actions.length > 0);
  const endorsedRecords = await prisma.ledgerRecord.findMany({ where: { kind: "ENDORSED", suggestionId: { in: shown.map((row) => row.id) } }, select: { suggestionId: true, payload: true } });
  const endorsed = new Set(endorsedRecords.filter((record) => EndorsedPayloadSchema.safeParse(record.payload).data?.withdrawn === false).map((record) => record.suggestionId));
  /* from the answer to a proposal shown: each asker's runs, in their own context, to their proposals' place in the queue */
  const toShownMs: number[] = [];
  /* a finding the sweep kept when it deleted its detached run has no run to measure from (45 § 3.5) */
  let toShownSkipped = 0;
  const queuedAt = new Map(researched.flatMap((row) => (row.decidedAt === null ? [] : [[row.id, row.decidedAt.getTime()] as const])));
  const readers = await withSystem(() => prisma.user.findMany({ select: { id: true, organisationId: true } }));
  for (const reader of readers) {
    const findings = await withTenant({ userId: reader.id, organisationId: reader.organisationId }, () => prisma.researchFinding.findMany({ where: { outcome: "PROPOSED", suggestionId: { not: null } }, select: { suggestionId: true, run: { select: { createdAt: true } } } }));
    for (const finding of findings) {
      const at = queuedAt.get(finding.suggestionId ?? "");
      if (at === undefined) continue;
      if (finding.run === null) toShownSkipped += 1;
      else toShownMs.push(Math.max(0, at - finding.run.createdAt.getTime()));
    }
  }
  /* from a proposal to a curator's decision: the wait each curator record of a researcher's proposal carries */
  const curatorRecords = await prisma.ledgerRecord.findMany({ where: { kind: "CURATOR" }, select: { payload: true } });
  const toDecisionMs = curatorRecords.flatMap((record) => {
    const parsed = CuratorPayloadSchema.safeParse(record.payload);
    return parsed.success && parsed.data.origin === "RESEARCHER" && (parsed.data.action === "ACCEPT" || parsed.data.action === "DECLINE") ? [parsed.data.queueWaitMs] : [];
  });
  const platform = await prisma.organisation.findFirst({ where: { researchPrincipal: true }, select: { id: true } });
  const realRun = platform === null ? false : (await withTenant({ userId: null, organisationId: platform.id }, () => prisma.budgetLedger.count({ where: { kind: "RESEARCH", alias: "hb-frontier", outcome: "ok" } }))) > 0;
  const [research, people] = await Promise.all([adjudicatorAgreement("RESEARCHER"), adjudicatorAgreement("HUMAN")]);
  return {
    facts: {
      realRun,
      runs: { all: records.length, reachedReader: records.filter((record) => record.planned === "brief").length, plannedNothing: records.filter((record) => record.planned === "nothing").length },
      spend,
      findings,
      refutedBy,
      refutedTiers,
      decided: { accepted: proposals.ACCEPT ?? 0, declined: proposals.DECLINE ?? 0 },
      merged: { merged: researched.filter((row) => row.state === "MERGED").length, reverted: researched.filter((row) => row.state === "MERGED" && row.revertedBy !== null).length },
      agreement: { research, people },
      endorsement: { shown: shown.length, endorsed: shown.filter((row) => endorsed.has(row.id)).length },
      toShownMs,
      toShownSkipped,
      toDecisionMs,
    },
    records: records.length,
  };
}

async function main(): Promise<number> {
  const startedAt = new Date();
  if (env.DATABASE_URL === undefined) {
    console.error("gate:research needs DATABASE_URL: the suites, R5, R6, R9 and the measures read the database.");
    return 1;
  }
  const release = await currentRelease();
  console.log(`gate:research · release ${release.id} · running the suites the criteria name (a few minutes)…`);
  /* the suites without the research principal — none of them may start a run this machine's workers would read the web
     for — and with a store of their own, so that R5 reads the workers' store and the suites write nothing into it */
  const store = mkdtempSync(join(tmpdir(), "hb-gate-store-"));
  const suiteEnv: NodeJS.ProcessEnv = { ...process.env, OBJECT_STORE_DIR: store, OBJECT_STORE_SECRET: process.env.OBJECT_STORE_SECRET ?? randomBytes(32).toString("hex") };
  delete suiteEnv.RESEARCH_PRINCIPAL;
  const suites = runVitest(SUITE_FILES, [], suiteEnv);
  rmSync(store, { recursive: true, force: true });
  if (suites.failure !== null) console.warn(`the suites did not report: ${suites.failure}`);
  const outcomes = suites.outcomes;
  const blocked: Unmeasured | null = suites.failure === null ? null : { blocked: suites.failure };
  const s = (label: string, file: string, name?: RegExp): TestSelection => sel(outcomes, label, file, name);
  const RUN = "tests/integration/research-run.test.ts";
  const DONE = /canary word reaches the planner alone/;
  /* research on request (48 § 25, unit 75): the road, a person's run end to end, the start's checks, the run's door and workflow */
  const ROAD = "tests/research/road.test.ts";
  const ON_DEMAND = "tests/integration/research-on-demand.test.ts";
  const FROM_SCRATCH = /runs a question from scratch to DONE/;
  const API = "tests/integration/research-api.test.ts";
  const DOOR = "tests/integration/research-door.test.ts";
  const RUN_WORKFLOW = "tests/workflows/researchRun.test.ts";

  console.log("gate:research · R1: the gate's own turns over the stub…");
  const turns = await ownTurns(release.id).catch((error: unknown): Unmeasured => ({ blocked: `the gate's own turns failed: ${error instanceof Error ? error.message : String(error)}` }));
  const turnsFacts = "questions" in turns ? turns : null;
  const opa = runOpa();

  const criteria = [
    turnsCriterion(
      blocked ?? [
        s("an answer on the stub hands nothing to research, and its Start a research writes nothing", ROAD, /hands nothing to research/),
        s("a research seeded from an answer leaves the answer as it was", ON_DEMAND, /leaves the seed answer as it was/),
        s("no endpoint carries what a turn holds for research", "tests/research-contract.test.ts"),
      ],
      turns,
    ),
    suitesCriterion(
      "R2",
      blocked ?? [
        s("the thirty-first counted run of a day refused, with the instant the window frees", API, /429 at the thirtieth counted run/),
        s("an organisation whose research is off refused", API, /403 for an organisation whose research is off/),
        s("the day counts every run with a workflow but those that spent nothing", DOOR, /counts toward the day every run with a workflow/),
      ],
      "the start's checks on the database (48 § 5.2, A8, D2): the thirty-first run of 24 hours 429 with the instant the window frees, a run that spent nothing (SKIPPED · BUDGET, SKIPPED · UNAVAILABLE) and a rule's refusal not counted; a start in an organisation whose research is off 403",
    ),
    suitesCriterion(
      "R3",
      blocked ?? [
        s("the canary end to end — the planner and the writer, no byte of the reader's request, a search, a line, a span or the run's history", ON_DEMAND, FROM_SCRATCH),
        s("the canary across the three calls, the writer's holding no tool", "workers/agents/researcher/v2/canary.test.ts", /carries the question to the planner and the writer only/),
        s("the reader's half: no byte of its request or of any search or fetch the stub ran", "workers/agents/researcher/v2/reader.test.ts", /canary's second half/),
        /* until unit 78: a legacy run asleep at the platform's cap still plans and reads with the version 1 agents (48 § 22) */
        s("the legacy reader's half: no byte of its request, of any search or of any address it fetched", "workers/agents/researcher/reader.test.ts", /canary's second half/),
        s("the writer holds no tool", "workers/agents/researcher/v2/writer.test.ts", /holds no tool/),
        s("a sent finding's curator pages name nobody who asked", ROAD, /naming nobody who asked/),
      ],
      "a question carrying a marker word (48 § 26, units 69, 70, 75): in the planner's and the writer's requests, in no byte of the reader's request or of any search the stub ran, of a printed line or span, of the run's history; the writer's request holds no tool; the legacy reader's request and searches hold none of it either, while a legacy run may still read (until unit 78); a sent finding's curator pages — the queue with it selected, its record and the research log — carry neither the asker's id, name or address, the marker, nor five words of the question",
    ),
    suitesCriterion(
      "R4",
      blocked ?? [
        s("the injection page end to end", RUN, /injection page's finding/),
        s("the injection page to the reader", "workers/agents/researcher/reader.test.ts", /injection page's finding/),
        s("the injection's notes to the version 2 reader, for the validation to drop", "workers/agents/researcher/v2/reader.test.ts", /injection's notes/),
        s("a source the call did not see", "lib/research/validate.test.ts", /SOURCE_NOT_SEEN/),
      ],
      "the injection fixture (41 § 11.7): no search for its marker, its finding refused SOURCE_NOT_SEEN, its sentence in no content table; the version 2 reader's notes of a page no block returned dropped by the same validation",
    ),
    evidenceCriterion(blocked ?? [s("graded from what the fetcher served", RUN, DONE), s("graded under the floor from what the fetcher served", RUN, /refutes a finding/), s("a sent finding graded from what the fetcher served", ROAD, /opened by the product's fetcher/)], await evidenceFacts()),
    curatorFirstCriterion(
      blocked ?? [s("every decision path of either origin", "lib/improve/decision.test.ts", /where a decision leaves|curator's accept to the merge/), s("the merge refuses a researcher's proposal with no curator's accept", "tests/integration/merge.test.ts", /researcher's proposal on a curator's accept alone/), s("a kept request for more refused on a researcher's", "lib/api/endpoints/curation-decision.test.ts", /NOT_FOR_RESEARCH/)],
      opa,
      await curatorFirstFacts(),
    ),
    suitesCriterion(
      "R7",
      blocked ?? [
        s("refuted end to end", RUN, /refutes a finding/),
        s("closed is refuted", "workers/research/submit.test.ts", /maps a suggestion's place/),
        s("a refuted send read as sent · not proposed, with no record of it", "tests/integration/research-findings.test.ts", /reads a refuted send/),
        s("the log names what refuted it", "lib/improve/researchLog.test.ts", /names what closed each/),
      ],
      "a finding under the floor (42 § 10.2, 43 § 13.5): declined at intake with no frontier call, CLOSED, REFUTED, the four records, no queue item, no proposal of the asker's anywhere; a sent finding Improve refutes read by its sender as `sent · not proposed` with no record to open (48 D3); the research log naming what refuted it",
    ),
    suitesCriterion(
      "R8",
      blocked ?? [
        s("an answer's Start a research, the run, its report, the finding sent and proposed, a name added, a curator's accept", ROAD),
        s("a curator's accept, the check, the merge, a release, the endorser in the merged record", "tests/integration/merge.test.ts", /researcher's proposal on a curator's accept alone/),
        s("the history's research mark and the endorser's credit", "lib/improve/history.test.ts", /began as research/),
      ],
      "the road in the two suites that can run it: tests/research/road.test.ts from an answer on the stub, through its Start a research to the Research page's `?from=`, the page's open and start, the run on the person's principal to a report, the finding sent to Improve and proposed, the asker's name added, to a curator's accept, on the database, the stub and the engine's test server; tests/integration/merge.test.ts from a curator's accept to a release, on a database and a repository of its own, a merge never touching this database's release; and the history's presenter on what the merged record says (44 § 10)",
    ),
    budgetCriterion(
      blocked ?? [
        s("a run's calls on the person's own ledger, none on a research principal's", ON_DEMAND, FROM_SCRATCH),
        s("a sent finding's grading and adjudication on the research principal", ROAD, /under the research principal/),
        s("a run at the person's cap at the planner, not counted", RUN_WORKFLOW, /at the person's cap at the planner/),
        s("a run at the person's cap at the reader and the writer", RUN_WORKFLOW, /at the person's cap at the reader/),
        s("the gateway refuses at the cap", "lib/gateway/client.test.ts", /at the cap/),
      ],
      await budgetFacts(),
    ),
    suitesCriterion(
      "R10",
      blocked ?? [
        s("a person's run's text purged by its own age", DOOR, /research purge empties/),
        s("a purge met on the way ends a person's run", RUN_WORKFLOW, /TEXT_PURGED wherever/),
        s("a person's run's history holds no word of theirs", ON_DEMAND, FROM_SCRATCH),
        s("the legacy purge empties the run's text and stops it", "tests/integration/research-rows.test.ts", /purges the brief/),
        s("a purge met on the way ends a legacy run", "tests/workflows/research.test.ts", /TEXT_PURGED/),
        s("the legacy run's history holds no word of the reader's", RUN, DONE),
      ],
      "the purge at 31 days on each suite's own reader: a person's run's question, steps, report, notes and pages null by the run's own age, a follow-up of yesterday kept (48 § 17.1); a legacy run's brief, found pages and uncovered sentences null with the message's text, its hashes and anchors kept, a waiting run ended SKIPPED · TEXT_PURGED; every payload of a completed run's history an id, a value, a hash or an instant (40 § 12.7, § 12.9)",
    ),
    checkCriterion(checkFacts()),
  ];

  const measured = await measureFacts(new Date());
  const report = researchReport({
    release: release.id,
    appUrl: env.APP_URL,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    criteria,
    measures: researchMeasures(measured.facts),
    measuredFrom: `From this database to date: ${String(measured.records)} RESEARCH record(s), which on a development machine include the test suites' runs beside the real ones; the research principal's calls, which are the real runs' alone; the improvement tables.`,
    outcomes,
    turns: turnsFacts,
  });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `research-gate-${release.id}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatGateReport(report));
  console.log(`\n${formatResearchExtras(report)}`);
  console.log(`\nreport written to ${path}`);
  rmSync(suites.dir, { recursive: true, force: true });
  return report.met ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => (env.DATABASE_URL === undefined ? undefined : getPrisma().$disconnect()));
