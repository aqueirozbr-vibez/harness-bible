import "dotenv/config";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { getPrisma } from "@/lib/db/client";
import { adjudicationsVersioned, completionDurationsMs, curatorAlwaysByModel, curatorsOfParts, decisionDurationsMs, firstMergedChapter, mergedOfChapter, suggestionIdsOf } from "@/lib/db/improve";
import { checkedView } from "@/lib/db/ledger";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { formatGateReport } from "@/lib/gate/common";
import { REPORTS_DIR } from "@/lib/gate/goldenRun";
import { runOpa, runVitest } from "@/lib/gate/run";
import { adminCriterion, curatedCriterion, formatPhase4Extras, isUnmeasured, ledgerCriterion, mergeCriterion, phase4Report, policyCriterion, rosterCondition, rubricCriterion, rubricPublishedCriterion, selectTests, suitesCriterion, timingMeasure, COMPLETION_WITHIN_MS, DECISION_WITHIN_MS, type BranchCoverage, type CuratedFacts, type CuratorAlwaysCheck, type LedgerFacts, type TestOutcome, type TestSelection, type Unmeasured } from "@/lib/gate/phase4";
import { CURATED_SET_FILE, curatedLabelsFile, CURATED_RUN_COMMAND, curatedRunEstimateUsd, readCuratedLabels, readCuratedRun, readCuratedSet, type CuratedRunItem } from "@/lib/gate/suggestions";
import { exportJsonl, exportKeyFromPem, verifyExport } from "@/lib/ledger/export";
import { tokensOfUsd } from "@/lib/gateway/prices";
import { PARTS } from "@/lib/schemas/improve";

/*
 * npm run gate:phase4 — the Phase 4 gate report (project-overview § Success criteria · Phase 4; feature-specs/39).
 * Eleven criteria, the roster condition and two measures. Most criteria are the suites the spec names, run here
 * through vitest's JSON reporter against the stub gateway and the test engine, so the gate makes no model call; the
 * policy's tests run through opa; the rest is read from the database and the running app. Writes
 * pipeline/reports/phase4-gate-<release>.json and exits 1 unless every criterion passes.
 *
 * It needs the database (DATABASE_URL), the policy sidecar for the app's answers (P4.10), and `opa` on the PATH or
 * at OPA_BIN for the policy's tests. The suites it runs need what the test suites always need (see
 * context/code-standards.md: the engine's address and namespace, the store's directory and secret). The curated set's
 * run (P4.6) is paid and Andre's to start: the gate prints the command and never starts it (39 D2).
 */

/** The files the criteria name, run once; each criterion then selects its tests by file and name. */
const SUITE_FILES = [
  "tests/integration/worked-examples.test.ts",
  "tests/integration/merge.test.ts",
  "tests/integration/suggestion-workflow.test.ts",
  "lib/api/endpoints/suggestions.test.ts",
  "lib/sensors/intake.test.ts",
  "tests/integration/suggestions.test.ts",
  "lib/api/endpoints/curation-decision.test.ts",
  "workers/agents/adjudicator/adjudicate.test.ts",
  "lib/ledger/export.test.ts",
  "lib/ledger/verify.test.ts",
  "lib/api/endpoints/audit.test.ts",
  "workers/activities/export.test.ts",
  "lib/budget/view.test.ts",
  "lib/gateway/budget.test.ts",
  "lib/gateway/client.test.ts",
  "tests/integration/evidence.test.ts",
];

/** The rubric's branch coverage: vitest over lib/rubric with the json-summary reporter, read back. */
function rubricCoverage(): { readonly coverage: BranchCoverage | Unmeasured; readonly outcomes: ReadonlyArray<TestOutcome> } {
  const dir = mkdtempSync(join(tmpdir(), "hb-gate4-cov-"));
  const run = runVitest(["lib/rubric"], ["--coverage", "--coverage.include=lib/rubric/**", "--coverage.reporter=json-summary", `--coverage.reportsDirectory=${dir}`]);
  const summaryPath = join(dir, "coverage-summary.json");
  if (!existsSync(summaryPath)) return { coverage: { blocked: `the coverage summary was not written${run.failure === null ? "" : `: ${run.failure}`}` }, outcomes: run.outcomes };
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, { readonly branches?: { readonly covered: number; readonly total: number } }>;
  const files = Object.entries(summary).filter(([name]) => name !== "total" && !/\.test\.ts$/.test(name));
  const covered = files.reduce((sum, [, entry]) => sum + (entry.branches?.covered ?? 0), 0);
  const total = files.reduce((sum, [, entry]) => sum + (entry.branches?.total ?? 0), 0);
  rmSync(dir, { recursive: true, force: true });
  return { coverage: { covered, total, files: files.length }, outcomes: run.outcomes };
}

const sel = (outcomes: ReadonlyArray<TestOutcome>, label: string, file: string, name?: RegExp, expected: number | null = null): TestSelection => ({ label, tests: selectTests(outcomes, file, name), expected });

async function appStatus(path: string): Promise<{ readonly status: number | null; readonly body: unknown }> {
  try {
    const response = await fetch(`${env.APP_URL.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json, text/html" } });
    const body: unknown = response.headers.get("content-type")?.includes("json") ? await response.json().catch(() => null) : null;
    return { status: response.status, body };
  } catch {
    return { status: null, body: null };
  }
}

/** The examples' records and exports, verified now (P4.8). */
async function ledgerFacts(outcomes: ReadonlyArray<TestOutcome>): Promise<LedgerFacts> {
  const prisma = getPrisma();
  const seed = await withSystem(() => prisma.user.findFirst({ where: { email: "improve-seed@harness-bible.local" }, select: { id: true } }));
  const examples = seed === null ? [] : await suggestionIdsOf([seed.id]);
  const views = [];
  for (const example of examples) {
    const checked = await checkedView({ suggestionId: example });
    views.push({ suggestionId: example, ok: checked.chain.ok && checked.rows.length > 0, records: checked.rows.length });
  }
  const publicPem = existsSync(join(process.cwd(), "infra", "ledger", "export-public.pem")) ? readFileSync(join(process.cwd(), "infra", "ledger", "export-public.pem"), "utf8") : null;
  const exportOf = async (scope: Parameters<typeof exportJsonl>[0]): Promise<{ readonly ok: boolean; readonly lines: number; readonly carries: boolean } | Unmeasured> => {
    if (env.LEDGER_EXPORT_KEY === undefined || publicPem === null) return { blocked: "the export key (LEDGER_EXPORT_KEY) or its public half (infra/ledger/export-public.pem) is not here: the trailer cannot be signed or checked" };
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });
    await exportJsonl(scope, sink, { key: exportKeyFromPem(env.LEDGER_EXPORT_KEY), now: () => new Date() });
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    const check = verifyExport(lines, publicPem);
    const carries = lines.filter((line) => line !== "" && !line.includes('"trailer"')).some((line) => (JSON.parse(line) as { predecessor?: unknown }).predecessor !== undefined);
    return { ok: check.ok, lines: check.lines, carries };
  };
  const first = examples[0];
  const suggestionExport = first === undefined ? { blocked: "no example's record in the database (npm run improve:seed writes the four)" } : await exportOf({ kind: "suggestion", id: first });
  /* a chapter with a merged change, where the database has one */
  const merged = await firstMergedChapter();
  let chapterExport: LedgerFacts["chapterExport"] = null;
  if (merged !== null) {
    const digits = String(merged).padStart(2, "0");
    const ids = (await mergedOfChapter(merged)).map((row) => row.id);
    const result = await exportOf({ kind: "chapter", id: digits, suggestionIds: ids });
    chapterExport = isUnmeasured(result) ? null : { chapter: digits, ok: result.ok, lines: result.lines, neighbours: result.carries };
  }
  return {
    views,
    suggestionExport,
    chapterExport,
    suites: [sel(outcomes, "the export's suite", "lib/ledger/export.test.ts"), sel(outcomes, "the verifier's suite", "lib/ledger/verify.test.ts")],
  };
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  if (env.DATABASE_URL === undefined) {
    console.error("gate:phase4 needs DATABASE_URL: every criterion but the suites reads the database.");
    return 1;
  }
  const prisma = getPrisma();
  const release = await currentRelease();
  console.log(`gate:phase4 · release ${release.id} · running the suites the criteria name (a few minutes)…`);

  const suites = runVitest(SUITE_FILES);
  if (suites.failure !== null) console.warn(`the suites did not report: ${suites.failure}`);
  const cov = rubricCoverage();
  const outcomes = [...suites.outcomes, ...cov.outcomes];
  const blockedSuites: Unmeasured | null = suites.failure === null ? null : { blocked: suites.failure };

  const opa = runOpa();
  const curatorAlways: CuratorAlwaysCheck = await curatorAlwaysByModel();

  /* P4.6: the curated set, its labels and its run */
  const set = readCuratedSet(release.id);
  const labels = readCuratedLabels(release.id);
  const run = readCuratedRun(release.id);
  const facts: CuratedFacts = {
    set: set === null ? null : { file: CURATED_SET_FILE(release.id), items: set.length },
    labels: labels === null ? null : { file: curatedLabelsFile(release.id), items: labels.length },
    run: run === null ? null : { file: run.file, items: run.items.length, real: run.real },
    command: CURATED_RUN_COMMAND,
    estimateUsd: curatedRunEstimateUsd(set?.length ?? 100),
  };
  const pairs = labels === null || run === null || !run.real ? null : labels.map((label) => {
    const item: CuratedRunItem | undefined = run.items.find((entry) => entry.id === label.id);
    return { id: label.id, label: label.decision, decided: item?.decision ?? null, decidedBy: item?.decidedBy ?? null, disagreed: label.disagreed ?? [] };
  });

  /* P4.10: the app and the adjudications */
  const [page, json] = await Promise.all([appStatus("/en/rubric"), appStatus("/api/v1/rubric/current")]);
  const version = typeof json.body === "object" && json.body !== null && "version" in json.body && typeof json.body.version === "string" ? json.body.version : null;
  const adjudications = await adjudicationsVersioned();

  /* P4.11: every capped principal's months against its cap */
  /* the gateway integration suite's fixture organisations have rows appended by the suite directly, past their caps by design: not the gateway's doing */
  const organisations = await prisma.organisation.findMany({ where: { name: { not: "Gateway integration fixture" } }, select: { id: true, tokenCap: true } });
  let monthsOver = 0;
  let principals = organisations.length;
  for (const organisation of organisations) {
    /* the rows are the organisation's: read inside its tenant context, as the meter reads them */
    const months = await withTenant({ userId: null, organisationId: organisation.id }, () => prisma.budgetLedger.groupBy({ by: ["month"], _sum: { costUsd: true } }));
    for (const month of months) if (tokensOfUsd(Number(month._sum.costUsd ?? 0)) > Number(organisation.tokenCap)) monthsOver += 1;
  }
  /* individual accounts are capped by the configured number (11 D5): each one's months against it, where the number is set */
  const individualCap = env.INDIVIDUAL_TOKEN_CAP === undefined ? null : Number(env.INDIVIDUAL_TOKEN_CAP);
  if (individualCap !== null) {
    const individuals = await withSystem(() => prisma.user.findMany({ where: { organisationId: null }, select: { id: true } }));
    for (const individual of individuals) {
      const months = await withTenant({ userId: individual.id, organisationId: null }, () => prisma.budgetLedger.groupBy({ by: ["month"], _sum: { costUsd: true } }));
      if (months.length === 0) continue;
      principals += 1;
      for (const month of months) if (tokensOfUsd(Number(month._sum.costUsd ?? 0)) > individualCap) monthsOver += 1;
    }
  }

  /* the roster, and the two measures */
  const rostered = await curatorsOfParts(PARTS);
  const rosterCounts = PARTS.map((part) => ({ part, curators: new Set(rostered.filter((row) => row.part === part).map((row) => row.userId)).size }));
  const chaptersByPart = await prisma.chapterVersion.findMany({ where: { releaseId: release.id }, select: { chapter: { select: { part: true } } } });
  const partsOfBook = new Set(chaptersByPart.map((row) => row.chapter.part));
  const rosterOfBook = rosterCondition(rosterCounts.filter((entry) => partsOfBook.has(entry.part)));
  const measures = { decision: timingMeasure(await decisionDurationsMs(), DECISION_WITHIN_MS), completion: timingMeasure(await completionDurationsMs(), COMPLETION_WITHIN_MS) };

  const criteria = [
    suitesCriterion(
      "P4.1",
      blockedSuites ?? [
        sel(outcomes, "the four worked examples", "tests/integration/worked-examples.test.ts", /^[^·]*\b[1-4] · /, 4),
        /* the fourth example's end — the override recorded with OV-IND-02 — and the first's — merged with a patch bump — are the suites of 36 and 37, where the examples' own suite stops at the queue and at the repository */
        sel(outcomes, "the fourth example's override with OV-IND-02", "lib/api/endpoints/curation-decision.test.ts", /OV-IND-02/, 1),
        sel(outcomes, "the first example's merge with a patch bump", "tests/integration/merge.test.ts", /patch/i),
      ],
      "tests/integration/worked-examples.test.ts on the stub gateway: each example's outcome, records and chain (33 § 8); the override of the fourth (36 § 11.2) and the merge of the first (37 § 12.2) in their own suites",
    ),
    rubricCriterion(cov.coverage, blockedSuites ?? [sel(outcomes, "the score's and the thresholds' suites", "lib/rubric/score.test.ts"), sel(outcomes, "the routing by class", "lib/rubric/thresholds.test.ts"), sel(outcomes, "the derive script's rule", "tests/integration/merge.test.ts", /derive/i)]),
    suitesCriterion("P4.3", blockedSuites ?? [sel(outcomes, "the three refusals at the endpoint (31 § 10.3)", "tests/integration/suggestions.test.ts", /§ 10\.3/, 1), sel(outcomes, "no anchor", "lib/api/endpoints/suggestions.test.ts", /ANCHOR_REQUIRED/, 1), sel(outcomes, "the intake's refusals at the endpoint", "lib/api/endpoints/suggestions.test.ts", /INTAKE_|ANCHOR_UNKNOWN/), sel(outcomes, "the four sensors", "lib/sensors/intake.test.ts")], "the three endpoint cases of 31 § 10.3 in the suggestions' integration suite, the creation's ANCHOR_REQUIRED, the sensors' suite and the endpoint's 422s naming the sensor"),
    policyCriterion(opa, curatorAlways, blockedSuites ?? [sel(outcomes, "the router keeps curator-always classes from the adjudicator", "lib/rubric/thresholds.test.ts", /CURATOR|curator/)]),
    suitesCriterion("P4.5", blockedSuites ?? [sel(outcomes, "the adjudicator's input contract", "workers/agents/adjudicator/adjudicate.test.ts", /11\.6|invariant 12/)], "the adjudicator's contract test: nothing that names the contributor or the suggestion's origin (33 § 11.6)"),
    curatedCriterion(facts, pairs),
    mergeCriterion(blockedSuites ?? [sel(outcomes, "the merge's integration suite", "tests/integration/merge.test.ts")], { host: env.BOOK_REPO_DIR !== undefined && /^(https?|git@)/.test(env.BOOK_REPO_DIR), runner: false }),
    ledgerCriterion(await ledgerFacts(outcomes)),
    suitesCriterion("P4.9", blockedSuites ?? [sel(outcomes, "the throttle in the workflow", "tests/integration/suggestion-workflow.test.ts", /throttle/i), sel(outcomes, "429 with the reason at the endpoint", "lib/api/endpoints/suggestions.test.ts", /THROTTLED/)], "the workflow's throttle case (33 § 11.10) and the endpoint's 429 SUGGESTION_THROTTLED"),
    rubricPublishedCriterion({ page: page.status, json: json.status, version, adjudications }),
    adminCriterion({
      suites: blockedSuites === null ? [sel(outcomes, "the audit export's endpoints", "lib/api/endpoints/audit.test.ts"), sel(outcomes, "the audit export's workflow", "workers/activities/export.test.ts"), sel(outcomes, "the meter by consumer", "lib/budget/view.test.ts"), sel(outcomes, "the gateway's budget rows", "lib/gateway/budget.test.ts"), sel(outcomes, "the gateway's refusal at the cap", "lib/gateway/client.test.ts", /at the cap/), sel(outcomes, "a budget refusal in the workflow writes nothing", "tests/integration/suggestion-workflow.test.ts", /budget refusal/), sel(outcomes, "a budget refusal leaves the item pending", "tests/integration/evidence.test.ts", /budget refusal/)] : [],
      cap: principals === 0 ? { blocked: "no capped principal has a month in BudgetLedger: nothing to hold to a cap (an organisation with a cap, or INDIVIDUAL_TOKEN_CAP with an individual's rows)" } : { principals, monthsOver },
      organisations: organisations.length > 0,
    }),
  ];

  const report = phase4Report({ release: release.id, appUrl: env.APP_URL, startedAt, finishedAt: new Date().toISOString(), criteria, roster: rosterOfBook, measures, outcomes });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `phase4-gate-${release.id}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(formatGateReport(report));
  console.log(formatPhase4Extras(report));
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
