import { gateVerdict, percentile, type Criterion, type GateReportBase } from "@/lib/gate/common";
import type { Part } from "@/lib/schemas/improve";

/*
 * The Phase 4 gate (project-overview § Success criteria · Phase 4; feature-specs/39): the pure rules behind
 * `npm run gate:phase4`. The script measures — it runs the suites the criteria name through vitest's JSON reporter,
 * the policy's tests through opa, reads the database and the app — and this module selects, counts, compares and
 * words the result. "A criterion nothing measured is never a pass" (39 § 1): one that needs something outside the
 * repository is `blocked` and says what, one a later unit measures is `deferred`.
 *
 * Eleven criteria, one condition the PRD lists beside them (two curators a part), and two measures without a
 * verdict of their own (the time to a decision and to completion).
 */

export type P4Id = "P4.1" | "P4.2" | "P4.3" | "P4.4" | "P4.5" | "P4.6" | "P4.7" | "P4.8" | "P4.9" | "P4.10" | "P4.11";

export const P4_TEXT: Readonly<Record<P4Id, string>> = {
  "P4.1": "The four worked examples run end to end with their documented outcomes: accepted and merged with a patch bump; declined at intake with zero frontier tokens, tiers B and D named; request more naming a tier A run; request more, then accepted only by an override recorded with OV-IND-02.",
  "P4.2": "100 % of rubric branches are tested; the score is a maximum plus at most one 10; thresholds route by class; a derived change needs the derive script in the branch.",
  "P4.3": "No anchor, a rationale over 200 words, an anchor missing at the current version: rejected at intake with the sensor named.",
  "P4.4": "Curator-always classes never reach the adjudicator; the policy denies it and denies a curator outside the part.",
  "P4.5": "The adjudicator's input has no name, employer or other suggestion.",
  "P4.6": "On 100 curated suggestions: adjudication precision under 3 %, override rate under 10 %, the meter per criterion, a rubric review record over 20 %.",
  "P4.7": "An accepted change opens a branch, the lab suite runs, the merge is blocked when the chapter's lab fails and proceeds when an unrelated one fails, the version bumps, the next release ingests with a matching render hash.",
  "P4.8": "Every record from submission to merge verifies; the exported trailer's head hash matches; a per-chapter export includes neighbours from other chapters.",
  "P4.9": "Three tier U declines in 30 days set throttledUntil; new submissions return 429 with the reason.",
  "P4.10": "The rubric is published at /[lang]/rubric, downloadable as JSON, its version on every adjudication.",
  "P4.11": "An admin exports an audit pack per account and per chapter, sees the budget by consumer, and the gateway refuses at the cap with no overage in BudgetLedger.",
};

/** Precision under 3 %, the override rate under 10 %, a rubric review opened over 20 % (PRD; overview Phase 4 (6)). */
export const PRECISION_CEILING = 0.03;
export const OVERRIDE_CEILING = 0.1;
export const REVIEW_THRESHOLD = 0.2;
/** The curated set is 100 suggestions (TRD § 8.1). */
export const CURATED_SIZE = 100;
/** Two curators a part (the PRD's dependency, 39 § 2). */
export const CURATORS_PER_PART = 2;
/** The cross-cutting measures: ten minutes to a decision for automatic classes, twenty-four hours to completion. */
export const DECISION_WITHIN_MS = 10 * 60_000;
export const COMPLETION_WITHIN_MS = 24 * 3_600_000;

export type Unmeasured = { readonly blocked: string } | { readonly deferred: string };

export function isUnmeasured(value: unknown): value is Unmeasured {
  return typeof value === "object" && value !== null && ("blocked" in value || "deferred" in value);
}

const criterion = (id: P4Id, status: Criterion["status"], measured: string, note: string): Criterion => ({ id, text: P4_TEXT[id], status, measured, note });
const unmeasured = (id: P4Id, why: Unmeasured): Criterion => ("blocked" in why ? criterion(id, "blocked", "—", why.blocked) : criterion(id, "deferred", "—", why.deferred));
const percent = (share: number) => `${(share * 100).toFixed(1)} %`;

/* ------------------------------------------------------------------ the suites the criteria name */

/** One test as vitest's JSON reporter gives it: the file it is in, its full name, and how it ended. */
export interface TestOutcome {
  readonly file: string;
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped" | "pending" | "todo";
}

/** The tests a criterion names, as the run found them: a selection by file and, where given, by name. */
export interface TestSelection {
  readonly label: string;
  readonly tests: ReadonlyArray<TestOutcome>;
  /** How many the criterion expects, where it names them one by one (the four examples); null where any number will do. */
  readonly expected: number | null;
}

/** The tests of a file (its path's end) whose name matches, in the run's order. */
export function selectTests(all: ReadonlyArray<TestOutcome>, file: string, name?: RegExp): ReadonlyArray<TestOutcome> {
  const normalised = file.replace(/\\/g, "/");
  return all.filter((test) => test.file.replace(/\\/g, "/").endsWith(normalised) && (name === undefined || name.test(test.name)));
}

export interface SelectionSummary {
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
  readonly total: number;
  /** What is wrong, in words a reviewer can check: a selection with nothing in it, fewer tests than expected, a test that failed or did not run. */
  readonly problems: ReadonlyArray<string>;
}

export function summarise(selections: ReadonlyArray<TestSelection>): SelectionSummary {
  let passed = 0;
  let failed = 0;
  let notRun = 0;
  const problems: string[] = [];
  for (const selection of selections) {
    if (selection.tests.length === 0) problems.push(`${selection.label}: no such test in the run`);
    else if (selection.expected !== null && selection.tests.length !== selection.expected) problems.push(`${selection.label}: ${String(selection.tests.length)} tests where ${String(selection.expected)} are named`);
    for (const test of selection.tests) {
      if (test.status === "passed") passed += 1;
      else if (test.status === "failed") {
        failed += 1;
        problems.push(`${selection.label}: failed — ${test.name}`);
      } else {
        notRun += 1;
        problems.push(`${selection.label}: ${test.status} — ${test.name}`);
      }
    }
  }
  return { passed, failed, notRun, total: passed + failed + notRun, problems };
}

/** A criterion that is the suites it names: a pass when every named test ran and passed, a fail otherwise, with what failed in the note. */
export function suitesCriterion(id: P4Id, selections: ReadonlyArray<TestSelection> | Unmeasured, how: string, extra: string | null = null): Criterion {
  if (isUnmeasured(selections)) return unmeasured(id, selections);
  const summary = summarise(selections);
  const measured = `${String(summary.passed)}/${String(summary.total)} tests passed`;
  const ok = summary.problems.length === 0 && summary.total > 0;
  const note = ok ? `${how}${extra === null ? "" : ` · ${extra}`}` : `${how} · ${summary.problems.join("; ")}${extra === null ? "" : ` · ${extra}`}`;
  return criterion(id, ok ? "pass" : "fail", measured, note);
}

/* ------------------------------------------------------------------ P4.2: the rubric's branches */

export interface BranchCoverage {
  readonly covered: number;
  readonly total: number;
  /** The files the coverage is over, for the note. */
  readonly files: number;
}

export function rubricCriterion(coverage: BranchCoverage | Unmeasured, tests: ReadonlyArray<TestSelection> | Unmeasured): Criterion {
  if (isUnmeasured(coverage)) return unmeasured("P4.2", coverage);
  if (isUnmeasured(tests)) return unmeasured("P4.2", tests);
  const summary = summarise(tests);
  const share = coverage.total === 0 ? 0 : coverage.covered / coverage.total;
  const complete = coverage.total > 0 && coverage.covered === coverage.total;
  const ok = complete && summary.problems.length === 0 && summary.total > 0;
  const measured = `branches ${String(coverage.covered)}/${String(coverage.total)} (${percent(share)}) · ${String(summary.passed)}/${String(summary.total)} tests passed`;
  const problems = [...(complete ? [] : [`${String(coverage.total - coverage.covered)} branch(es) of lib/rubric untested`]), ...summary.problems];
  return criterion("P4.2", ok ? "pass" : "fail", measured, `npm run test:rubric with branch coverage over lib/rubric (${String(coverage.files)} files); the property tests of the score and the thresholds; the derive script's rule in the merge's suite${problems.length === 0 ? "" : ` · ${problems.join("; ")}`}`);
}

/* ------------------------------------------------------------------ P4.4: the policy, and the database */

export interface PolicyTests {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

export interface CuratorAlwaysCheck {
  /** Decided suggestions of class CURATOR_ALWAYS in the database. */
  readonly decided: number;
  /** Those with an adjudication a model made (an adjudicator's row naming a model). */
  readonly byModel: number;
}

export function policyCriterion(opa: PolicyTests | Unmeasured, check: CuratorAlwaysCheck | Unmeasured, tests: ReadonlyArray<TestSelection> | Unmeasured): Criterion {
  if (isUnmeasured(opa)) return unmeasured("P4.4", opa);
  if (isUnmeasured(check)) return unmeasured("P4.4", check);
  if (isUnmeasured(tests)) return unmeasured("P4.4", tests);
  const summary = summarise(tests);
  const problems = [...(opa.failed === 0 && opa.total > 0 ? [] : [`${String(opa.failed)} policy test(s) failed`]), ...(check.byModel === 0 ? [] : [`${String(check.byModel)} curator-always suggestion(s) adjudicated by a model`]), ...summary.problems];
  return criterion(
    "P4.4",
    problems.length === 0 ? "pass" : "fail",
    `opa ${String(opa.passed)}/${String(opa.total)} · curator-always decided ${String(check.decided)}, by a model ${String(check.byModel)} · ${String(summary.passed)}/${String(summary.total)} tests passed`,
    `opa test policies (the curator's part and the adjudicator's refusal of curator-always classes); every decided CURATOR_ALWAYS suggestion in the database checked for an adjudicator's row naming a model; the router's suite${problems.length === 0 ? "" : ` · ${problems.join("; ")}`}`,
  );
}

/* ------------------------------------------------------------------ P4.6: the curated set */

/** What the gate found of the set, the labels and the run; null where the file is not there. */
export interface CuratedFacts {
  readonly set: { readonly file: string; readonly items: number } | null;
  readonly labels: { readonly file: string; readonly items: number } | null;
  readonly run: { readonly file: string; readonly items: number; readonly real: boolean } | null;
  /** The command that makes the run, printed for Andre: a paid run is his to start (39 D2). */
  readonly command: string;
  /** The run's estimate in dollars, for the same line. */
  readonly estimateUsd: number;
}

/** A labelled item against the run's decision on it. */
export interface CuratedPair {
  readonly id: string;
  /** The curator's decision. */
  readonly label: "ACCEPT" | "REQUEST_MORE" | "DECLINE";
  /** The run's decision, and who made it: a rule at intake, the router, the adjudicator; null where the item did not run. */
  readonly decided: "ACCEPT" | "REQUEST_MORE" | "DECLINE" | "CURATOR_REVIEW" | null;
  readonly decidedBy: "intake-rules" | "router" | "adjudicator" | null;
  /** The criteria the labels disagree with, when the label names them. */
  readonly disagreed: ReadonlyArray<string>;
}

export interface CuratedMeasures {
  /** The labelled items that ran. */
  readonly items: number;
  /** The adjudicator's own decisions, which the two rates are over (39 § 3): a rule's and the router's are not its to get wrong. */
  readonly adjudicated: number;
  readonly byRule: number;
  readonly toCurator: number;
  /** Precision read as D1: accepted by the adjudicator where the curator's label declines, over the adjudicator's decisions. */
  readonly precision: number;
  /** The share of the adjudicator's decisions the labels disagree with. */
  readonly overrideRate: number;
  readonly perCriterion: Readonly<Record<string, number>>;
  readonly reviewOpened: ReadonlyArray<string>;
}

export function curatedMeasures(pairs: ReadonlyArray<CuratedPair>): CuratedMeasures {
  const ran = pairs.filter((pair) => pair.decided !== null);
  const adjudicated = ran.filter((pair) => pair.decidedBy === "adjudicator" && pair.decided !== "CURATOR_REVIEW");
  const n = adjudicated.length;
  const falseAccepts = adjudicated.filter((pair) => pair.decided === "ACCEPT" && pair.label === "DECLINE").length;
  const overridden = adjudicated.filter((pair) => pair.decided !== pair.label).length;
  const counts = new Map<string, number>();
  for (const pair of adjudicated) for (const name of pair.disagreed) counts.set(name, (counts.get(name) ?? 0) + 1);
  const perCriterion: Record<string, number> = {};
  for (const [name, count] of counts) perCriterion[name] = n === 0 ? 0 : count / n;
  return {
    items: ran.length,
    adjudicated: n,
    byRule: ran.filter((pair) => pair.decidedBy === "intake-rules").length,
    toCurator: ran.filter((pair) => pair.decidedBy === "router" || pair.decided === "CURATOR_REVIEW").length,
    precision: n === 0 ? 0 : falseAccepts / n,
    overrideRate: n === 0 ? 0 : overridden / n,
    perCriterion,
    reviewOpened: Object.entries(perCriterion).filter(([, rate]) => rate > REVIEW_THRESHOLD).map(([name]) => name),
  };
}

export function curatedCriterion(facts: CuratedFacts, pairs: ReadonlyArray<CuratedPair> | null): Criterion {
  const missing: string[] = [];
  if (facts.set === null) missing.push("the set (npm run gate:suggestions writes golden/suggestions-<release>.jsonl from the release's rows)");
  if (facts.labels === null) missing.push("the curators' labels (golden/suggestions/labels/<release>.jsonl, one label a line)");
  if (facts.run === null || !facts.run.real) missing.push(`one real run of the set (${facts.command}; about $${facts.estimateUsd.toFixed(2)}, which is Andre's to start)`);
  if (missing.length > 0 || pairs === null) {
    const have = [facts.set === null ? null : `set ${String(facts.set.items)} items`, facts.labels === null ? null : `labels ${String(facts.labels.items)}`, facts.run === null ? null : `${facts.run.real ? "real" : "stub"} run ${String(facts.run.items)} items`].filter((part) => part !== null).join(" · ");
    return criterion("P4.6", "blocked", have === "" ? "—" : have, `Needs ${missing.join("; ")}`);
  }
  const measures = curatedMeasures(pairs);
  /* the whole set labelled and run: the hundred, the rule's and the curator's items among them, the two rates over the adjudicator's own */
  const whole = pairs.length >= CURATED_SIZE && measures.items === pairs.length;
  const ok = whole && measures.adjudicated > 0 && measures.precision < PRECISION_CEILING && measures.overrideRate < OVERRIDE_CEILING;
  const per = Object.entries(measures.perCriterion)
    .map(([name, rate]) => `${name} ${percent(rate)}`)
    .join(", ");
  return criterion(
    "P4.6",
    ok ? "pass" : "fail",
    `${String(measures.items)} items ran (${String(measures.adjudicated)} adjudicated, ${String(measures.byRule)} by rule, ${String(measures.toCurator)} a curator's) · precision ${percent(measures.precision)} · override ${percent(measures.overrideRate)}`,
    `${facts.run?.file ?? ""} against ${facts.labels?.file ?? ""}; both rates over the adjudicator's decisions, precision read as accepted where the label declines (39 D1); per criterion ${per === "" ? "—" : per}; rubric review ${measures.reviewOpened.length === 0 ? "none over 20 %" : `opened for ${measures.reviewOpened.join(", ")}`}${whole ? "" : ` · ${String(pairs.length)} labelled and ${String(measures.items)} run of the ${String(CURATED_SIZE)}`}${measures.adjudicated === 0 && whole ? " · no adjudicator's decision to measure" : ""}`,
  );
}

/* ------------------------------------------------------------------ P4.7: the merge, local and CI */

export function mergeCriterion(local: ReadonlyArray<TestSelection> | Unmeasured, ci: { readonly host: boolean; readonly runner: boolean }): Criterion {
  if (isUnmeasured(local)) return unmeasured("P4.7", local);
  const summary = summarise(local);
  const ok = summary.problems.length === 0 && summary.total > 0;
  const blockedPart = ci.host && ci.runner ? "CI's run of the lab suite is measured by the host's runs" : `"CI runs the lab suite" is blocked: ${[ci.host ? null : "no host for the book's repository", ci.runner ? null : "no runner"].filter((part) => part !== null).join(" and ")} (37 § 9)`;
  return criterion("P4.7", ok ? "pass" : "fail", `${String(summary.passed)}/${String(summary.total)} tests passed on a local repository`, `tests/integration/merge.test.ts on repositories the suite makes: the branch, the check with the chapter's lab failing and an unrelated one, the bump, the release ingested under the check's render hash${summary.problems.length === 0 ? "" : ` · ${summary.problems.join("; ")}`} · ${blockedPart}`);
}

/* ------------------------------------------------------------------ P4.8: the records */

export interface LedgerFacts {
  /** Each example's view, verified with its neighbours. */
  readonly views: ReadonlyArray<{ readonly suggestionId: string; readonly ok: boolean; readonly records: number }>;
  /** A suggestion-scope export of the examples, verified: its head matched the trailer, its lines carried predecessors. */
  readonly suggestionExport: { readonly ok: boolean; readonly lines: number; readonly carries: boolean } | Unmeasured;
  /** A chapter-scope export, where the database has a chapter with a merged change; else the suite's case stands for it. */
  readonly chapterExport: { readonly chapter: string; readonly ok: boolean; readonly lines: number; readonly neighbours: boolean } | null;
  readonly suites: ReadonlyArray<TestSelection>;
}

export function ledgerCriterion(facts: LedgerFacts | Unmeasured): Criterion {
  if (isUnmeasured(facts)) return unmeasured("P4.8", facts);
  const summary = summarise(facts.suites);
  const brokenViews = facts.views.filter((view) => !view.ok);
  const problems = [...brokenViews.map((view) => `the record of ${view.suggestionId} does not verify`), ...summary.problems];
  if (facts.views.length === 0) problems.push("no example's record in the database (npm run improve:seed writes the four)");
  let exportWords: string;
  if (isUnmeasured(facts.suggestionExport)) exportWords = "blocked" in facts.suggestionExport ? facts.suggestionExport.blocked : facts.suggestionExport.deferred;
  else {
    if (!facts.suggestionExport.ok) problems.push("the examples' export does not verify");
    if (!facts.suggestionExport.carries) problems.push("the examples' export carries no predecessor");
    exportWords = `an export of the examples' records: ${String(facts.suggestionExport.lines)} lines, ${facts.suggestionExport.ok ? "verified" : "NOT verified"}, predecessors ${facts.suggestionExport.carries ? "carried" : "missing"}`;
  }
  if (facts.chapterExport !== null && (!facts.chapterExport.ok || !facts.chapterExport.neighbours)) problems.push(`chapter ${facts.chapterExport.chapter}'s export ${facts.chapterExport.ok ? "carries no neighbour" : "does not verify"}`);
  const chapterWords = facts.chapterExport === null ? "no chapter in the database has a merged change, so the per-chapter neighbours are the export suite's case" : `chapter ${facts.chapterExport.chapter}'s export: ${String(facts.chapterExport.lines)} lines, ${facts.chapterExport.ok ? "verified" : "NOT verified"}, neighbours ${facts.chapterExport.neighbours ? "carried" : "missing"}`;
  const ok = problems.length === 0 && !isUnmeasured(facts.suggestionExport);
  const status: Criterion["status"] = ok ? "pass" : isUnmeasured(facts.suggestionExport) && problems.length === 0 ? "blocked" : "fail";
  return criterion("P4.8", status, `${String(facts.views.length - brokenViews.length)}/${String(facts.views.length)} records verify · ${String(summary.passed)}/${String(summary.total)} tests passed`, `verifyView over each example's records with their chain neighbours; ${exportWords}; ${chapterWords}; the ledger's export suite${problems.length === 0 ? "" : ` · ${problems.join("; ")}`}`);
}

/* ------------------------------------------------------------------ P4.10: the rubric published */

export interface RubricPublishedFacts {
  /** The page's and the JSON endpoint's HTTP statuses; null where the app did not answer. */
  readonly page: number | null;
  readonly json: number | null;
  readonly version: string | null;
  readonly adjudications: { readonly total: number; readonly withRubric: number };
}

export function rubricPublishedCriterion(facts: RubricPublishedFacts | Unmeasured): Criterion {
  if (isUnmeasured(facts)) return unmeasured("P4.10", facts);
  const problems = [
    ...(facts.page === 200 ? [] : [`/en/rubric answered ${facts.page === null ? "nothing" : String(facts.page)}`]),
    ...(facts.json === 200 ? [] : [`/api/v1/rubric/current answered ${facts.json === null ? "nothing" : String(facts.json)}`]),
    ...(facts.json === 200 && facts.version === null ? ["/api/v1/rubric/current answered no rubric version"] : []),
    ...(facts.adjudications.withRubric === facts.adjudications.total ? [] : [`${String(facts.adjudications.total - facts.adjudications.withRubric)} adjudication(s) without a rubric version`]),
  ];
  return criterion("P4.10", problems.length === 0 ? "pass" : "fail", `page ${facts.page === null ? "—" : String(facts.page)} · json ${facts.json === null ? "—" : String(facts.json)}${facts.version === null ? "" : ` (${facts.version})`} · ${String(facts.adjudications.withRubric)}/${String(facts.adjudications.total)} adjudications versioned`, `GET /en/rubric and GET /api/v1/rubric/current on the running app; every Adjudication row's rubricVersionId${problems.length === 0 ? "" : ` · ${problems.join("; ")}`}`);
}

/* ------------------------------------------------------------------ P4.11: the account's instruments */

export interface AdminFacts {
  readonly suites: ReadonlyArray<TestSelection>;
  /** Principals with a cap, and how many of their months the ledger shows past it. */
  readonly cap: { readonly principals: number; readonly monthsOver: number } | Unmeasured;
  /** Whether organisational accounts exist: the admin's half is blocked without them. */
  readonly organisations: boolean;
}

export function adminCriterion(facts: AdminFacts | Unmeasured): Criterion {
  if (isUnmeasured(facts)) return unmeasured("P4.11", facts);
  const summary = summarise(facts.suites);
  const problems = [...summary.problems];
  let capWords: string;
  if (isUnmeasured(facts.cap)) capWords = "blocked" in facts.cap ? facts.cap.blocked : facts.cap.deferred;
  else {
    if (facts.cap.monthsOver > 0) problems.push(`${String(facts.cap.monthsOver)} month(s) of a capped principal past the cap in BudgetLedger`);
    capWords = `${String(facts.cap.principals)} capped principal(s), ${String(facts.cap.monthsOver)} month(s) over`;
  }
  const ok = problems.length === 0 && summary.total > 0 && !isUnmeasured(facts.cap);
  return criterion(
    "P4.11",
    ok ? "pass" : isUnmeasured(facts.cap) && problems.length === 0 ? "blocked" : "fail",
    `${String(summary.passed)}/${String(summary.total)} tests passed · ${capWords}`,
    `the audit export's endpoints and workflow, the meter's rows, the gateway's refusal at the cap, in their suites; BudgetLedger's months against each capped principal's cap${facts.organisations ? "" : "; the organisation's admin is blocked with organisational accounts, which do not exist yet — the individual account's pack is what passes (39 § 2)"}${problems.length === 0 ? "" : ` · ${problems.join("; ")}`}`,
  );
}

/* ------------------------------------------------------------------ the roster condition, and the two measures */

export interface RosterCondition {
  readonly met: boolean;
  readonly parts: ReadonlyArray<{ readonly part: Part; readonly curators: number }>;
  readonly short: ReadonlyArray<Part>;
}

export function rosterCondition(parts: ReadonlyArray<{ readonly part: Part; readonly curators: number }>): RosterCondition {
  const short = parts.filter((entry) => entry.curators < CURATORS_PER_PART).map((entry) => entry.part);
  return { met: parts.length > 0 && short.length === 0, parts, short };
}

export interface TimingMeasure {
  readonly items: number;
  readonly p95Ms: number | null;
  readonly within: number;
  readonly limitMs: number;
}

export function timingMeasure(durationsMs: ReadonlyArray<number>, limitMs: number): TimingMeasure {
  return { items: durationsMs.length, p95Ms: durationsMs.length === 0 ? null : percentile(durationsMs, 95), within: durationsMs.filter((ms) => ms <= limitMs).length, limitMs };
}

export interface Phase4Report extends GateReportBase {
  readonly phase: 4;
  readonly roster: RosterCondition;
  readonly measures: { readonly decision: TimingMeasure; readonly completion: TimingMeasure };
  /** The suites the gate ran, each with how it ended, for the reviewer who asks what was run. */
  readonly suites: ReadonlyArray<{ readonly file: string; readonly passed: number; readonly failed: number; readonly total: number }>;
}

export interface Phase4Input {
  readonly release: string;
  readonly appUrl: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly criteria: ReadonlyArray<Criterion>;
  readonly roster: RosterCondition;
  readonly measures: Phase4Report["measures"];
  readonly outcomes: ReadonlyArray<TestOutcome>;
}

export function phase4Report(input: Phase4Input): Phase4Report {
  const byFile = new Map<string, { passed: number; failed: number; total: number }>();
  for (const outcome of input.outcomes) {
    const file = outcome.file.replace(/\\/g, "/").replace(/^.*?\/(tests|lib|workers|pipeline)\//, "$1/");
    const entry = byFile.get(file) ?? { passed: 0, failed: 0, total: 0 };
    entry.total += 1;
    if (outcome.status === "passed") entry.passed += 1;
    if (outcome.status === "failed") entry.failed += 1;
    byFile.set(file, entry);
  }
  return {
    phase: 4,
    release: input.release,
    appUrl: input.appUrl,
    criteria: input.criteria,
    met: gateVerdict(input.criteria).met,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    roster: input.roster,
    measures: input.measures,
    suites: [...byFile.entries()].map(([file, counts]) => ({ file, ...counts })).sort((a, b) => a.file.localeCompare(b.file)),
  };
}

const ms = (value: number | null): string => (value === null ? "—" : value < 60_000 ? `${(value / 1000).toFixed(1)} s` : value < 3_600_000 ? `${(value / 60_000).toFixed(1)} min` : `${(value / 3_600_000).toFixed(1)} h`);

/** The lines the printed report adds after the criteria: the roster condition and the two measures. */
export function formatPhase4Extras(report: Phase4Report): string {
  const lines = [
    `${report.roster.met ? "■" : "□"} roster: at least ${String(CURATORS_PER_PART)} curators a part — ${report.roster.parts.map((entry) => `${entry.part} ${String(entry.curators)}`).join(", ")}${report.roster.short.length === 0 ? "" : ` · short: ${report.roster.short.join(", ")}`}`,
    `· time to decision, automatic classes: ${String(report.measures.decision.items)} suggestions, p95 ${ms(report.measures.decision.p95Ms)}, ${String(report.measures.decision.within)} within ${ms(report.measures.decision.limitMs)}`,
    `· time to completion: ${String(report.measures.completion.items)} merged, p95 ${ms(report.measures.completion.p95Ms)}, ${String(report.measures.completion.within)} within ${ms(report.measures.completion.limitMs)}`,
  ];
  return lines.join("\n");
}
