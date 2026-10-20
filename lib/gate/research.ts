import { gateVerdict, percentile, type Criterion, type GateReportBase } from "@/lib/gate/common";
import { isUnmeasured, summarise, type PolicyTests, type TestOutcome, type TestSelection, type Unmeasured } from "@/lib/gate/phase4";

/*
 * The researcher's gate (feature-specs/44; unit 61b): the pure rules behind `npm run gate:research`. The script
 * measures — it runs the suites the criteria name through vitest's JSON reporter and the policy's tests through opa,
 * asks golden questions of its own through the workers over the stub gateway, and reads the database — and this module
 * selects, counts, compares and words the result. A criterion nothing measured is never a pass: one that needs
 * something outside the repository is `blocked` and says what (R11, Andre's one paid call).
 *
 * Eleven criteria, and the measures of § 3, which have no target (D1) and never move the exit. R1, R2, R3, R8 and R9 read
 * as feature-specs/48 § 25 rewrote them for unit 75, when research became a person's to start and to pay for: nothing
 * follows an answer any more, a run is the person's, and only Improve's vetting of a sent finding is the platform's.
 */

export type RId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11";

export const R_TEXT: Readonly<Record<RId, string>> = {
  R1: "An answered turn starts no run and its answer is unchanged by research; a refusal starts none.",
  R2: "A person's research obeys its limits: 30 runs a day, and none where their organisation switched research off.",
  R3: "The question never reaches the side that reads the web: no byte of the reader's request or of its searches holds it, and the writer's request, which holds it, holds no tool.",
  R4: "A page cannot make the researcher act.",
  R5: "Evidence is only what the product opened itself.",
  R6: "Nothing the researcher proposed is merged without a curator.",
  R7: "What Improve refutes is logged and not proposed.",
  R8: "The whole road once, from the Research page: an answer's Start a research, the run, its report, a finding sent to Improve and proposed, a name added, a curator's accept, the merge, the history's research mark and the endorser's credit.",
  R9: "A run spends the person's own budget and stops at their cap; Improve's vetting of a sent finding spends the platform's research principal, within its cap.",
  R10: "A reader's words are gone after 30 days, from the product's rows and from every workflow history.",
  R11: "The provider's tools pass through the gateway and their cost is known.",
};

/** The command R11 waits for: one paid call, Andre's to make (41 § 11.1). */
export const RESEARCH_CHECK_COMMAND = "npm run research:check";

const criterion = (id: RId, status: Criterion["status"], measured: string, note: string): Criterion => ({ id, text: R_TEXT[id], status, measured, note });
const unmeasured = (id: RId, why: Unmeasured): Criterion => ("blocked" in why ? criterion(id, "blocked", "—", why.blocked) : criterion(id, "deferred", "—", why.deferred));
const percent = (share: number): string => `${(share * 100).toFixed(1)} %`;
const tests = (summary: ReturnType<typeof summarise>): string => `${String(summary.passed)}/${String(summary.total)} tests passed`;

/**
 * A criterion that is the suites it names and, where it has them, facts of its own: a pass when every named test ran
 * and passed and the facts found nothing wrong; a fail otherwise, with what was wrong in the note.
 */
function judged(id: RId, selections: ReadonlyArray<TestSelection> | Unmeasured, how: string, own: { readonly measured: string; readonly problems: ReadonlyArray<string> } | null = null): Criterion {
  if (isUnmeasured(selections)) return unmeasured(id, selections);
  const summary = summarise(selections);
  const problems = [...summary.problems, ...(own?.problems ?? [])];
  const ok = problems.length === 0 && summary.total > 0;
  const measured = own === null ? tests(summary) : `${tests(summary)} · ${own.measured}`;
  return criterion(id, ok ? "pass" : "fail", measured, `${how}${problems.length === 0 ? "" : ` · ${problems.join("; ")}`}`);
}

/** R2, R3, R4, R7, R8, R10: the suites alone. */
export function suitesCriterion(id: RId, selections: ReadonlyArray<TestSelection> | Unmeasured, how: string): Criterion {
  return judged(id, selections, how);
}

/* ------------------------------------------------------------------ R1: the gate's own turns */

/**
 * The gate's own turns (workers/gate/researchTurns.ts): answered golden questions and one refusal of each cause, through
 * the workers over the stub. Since unit 75 nothing of research follows a turn (feature-specs/48 § 9.2), and that is
 * what is counted; until then the turns were asked with research off, configured and off again, and timed (44 D2).
 */
export interface TurnsFacts {
  /** The answered questions asked. */
  readonly questions: number;
  /** The golden ids whose `final` event carried `research`, answers and refusals alike: none may. */
  readonly withResearch: ReadonlyArray<string>;
  /** The answered ones whose answer the conversation read back other than its `final` gave it: none may. */
  readonly changed: ReadonlyArray<string>;
  /** `ResearchRun` rows naming any of the turns' messages: none may. */
  readonly runs: number;
  /** Research calls on the answered turns' traces: none may. */
  readonly researchCalls: number;
  /** One refusal of each cause (40 § 12.5): whether it was refused, whether its `final` carried research, the research calls its trace made. */
  readonly refusals: ReadonlyArray<{ readonly cause: string; readonly refused: boolean; readonly research: boolean; readonly researchCalls: number }>;
}

export function turnsCriterion(selections: ReadonlyArray<TestSelection> | Unmeasured, turns: TurnsFacts | Unmeasured): Criterion {
  if (isUnmeasured(turns)) return unmeasured("R1", turns);
  const problems: string[] = [];
  if (turns.questions === 0) problems.push("no answered question to ask");
  if (turns.withResearch.length > 0) problems.push(`${String(turns.withResearch.length)} final event(s) carried research: ${turns.withResearch.slice(0, 5).join(", ")}`);
  if (turns.changed.length > 0) problems.push(`${String(turns.changed.length)} answer(s) read back other than their final event gave them: ${turns.changed.slice(0, 5).join(", ")}`);
  if (turns.runs > 0) problems.push(`${String(turns.runs)} research run(s) written for the gate's turns`);
  if (turns.researchCalls > 0) problems.push(`${String(turns.researchCalls)} research call(s) on the answered turns' traces`);
  for (const refusal of turns.refusals) {
    if (!refusal.refused) problems.push(`${refusal.cause} was not refused`);
    if (refusal.research) problems.push(`${refusal.cause}'s refusal carried research in its final event`);
    if (refusal.researchCalls > 0) problems.push(`${refusal.cause}'s refusal made ${String(refusal.researchCalls)} research call(s)`);
  }
  if (turns.refusals.length === 0) problems.push("no refusal was asked");
  return judged("R1", selections, "the gate's own turns through the workers over the stub gateway: answered golden questions and one refusal of each cause, none followed by a run, a research call or research in its final event, each answer read back as its final event gave it (the turns' own consistency, with nothing to compare it against); the road suite's answer that writes no run and whose Start a research writes nothing; invariant 31's evidence that research never changes an answer: research-on-demand's seeded case and the road suite, each comparing every column of the seed answer and every row hanging from it before and after a research seeded from it, on the stub and the engine's test server; the contract that no endpoint carries what a turn holds for research", {
    measured: `${String(turns.questions - turns.changed.length)}/${String(turns.questions)} answers read back as their final gave them · ${String(turns.runs)} run(s) · ${String(turns.researchCalls)} research call(s) · ${String(turns.withResearch.length)} final event(s) with research · refusals ${String(turns.refusals.filter((refusal) => refusal.refused && !refusal.research && refusal.researchCalls === 0).length)}/${String(turns.refusals.length)} with nothing of research`,
    problems,
  });
}

/* ------------------------------------------------------------------ R5: the evidence of researchers' suggestions */

export interface EvidenceFacts {
  readonly suggestions: number;
  /** Their items past `PENDING`. */
  readonly items: number;
  /** Items still being graded: not judged yet. */
  readonly pending: number;
  /** Those with a stored text. */
  readonly opened: number;
  /** Items with no fetch status: graded without the product's fetcher having tried. */
  readonly withoutFetch: ReadonlyArray<string>;
  /** A text without its hash, or a hash without its text. */
  readonly textWithoutHash: ReadonlyArray<string>;
  /** A text where the fetcher did not open the page. */
  readonly textNotOpened: ReadonlyArray<string>;
  /** A text the store does not hold. */
  readonly missingText: ReadonlyArray<string>;
  /** An opened page whose source the store does not hold as the row's hash says (review of unit 61). */
  readonly sourceMismatch: ReadonlyArray<string>;
}

export function evidenceCriterion(selections: ReadonlyArray<TestSelection> | Unmeasured, facts: EvidenceFacts | Unmeasured): Criterion {
  if (isUnmeasured(facts)) return unmeasured("R5", facts);
  const named = (what: string, ids: ReadonlyArray<string>): ReadonlyArray<string> => (ids.length === 0 ? [] : [`${String(ids.length)} item(s) ${what}: ${ids.slice(0, 3).join(", ")}`]);
  const problems = [...named("with no fetch status", facts.withoutFetch), ...named("with a text and no hash, or a hash and no text", facts.textWithoutHash), ...named("with a text the fetcher did not open", facts.textNotOpened), ...named("whose text the store does not hold", facts.missingText), ...named("whose source is not what the fetcher hashed", facts.sourceMismatch)];
  return judged("R5", selections, `every evidence item of every researcher's suggestion in the database: a fetch status the product's fetcher wrote, a text only where it opened the page, the source it received matching the row's hash, and the text in the store${facts.suggestions === 0 ? "; this database has no researcher's suggestion, so the suites carry it" : ""}; the suite's finding graded from what the fetcher served`, {
    measured: `${String(facts.items)} item(s) of ${String(facts.suggestions)} researcher suggestion(s), ${String(facts.opened)} opened with a stored text${facts.pending === 0 ? "" : `, ${String(facts.pending)} still pending`}`,
    problems,
  });
}

/* ------------------------------------------------------------------ R6: the curator before every merge */

export interface CuratorFirstFacts {
  /** `merged` records of researchers' suggestions in the ledger. */
  readonly merged: number;
  /** Those with no earlier `curator` record of action `ACCEPT` on the same suggestion. */
  readonly withoutAccept: ReadonlyArray<string>;
}

export function curatorFirstCriterion(selections: ReadonlyArray<TestSelection> | Unmeasured, opa: PolicyTests | Unmeasured, ledger: CuratorFirstFacts | Unmeasured): Criterion {
  if (isUnmeasured(opa)) return unmeasured("R6", opa);
  if (isUnmeasured(ledger)) return unmeasured("R6", ledger);
  const problems = [...(opa.failed === 0 && opa.total > 0 ? [] : [`${String(opa.failed)} policy test(s) failed`]), ...(ledger.withoutAccept.length === 0 ? [] : [`${String(ledger.withoutAccept.length)} researcher suggestion(s) merged with no curator's accept before: ${ledger.withoutAccept.slice(0, 3).join(", ")}`])];
  return judged("R6", selections, "over the ledger, every merged record of a researcher's suggestion preceded by a curator record of action ACCEPT on it; every decision path of origin RESEARCHER, the merge's own refusal without a curator's accept, and the policy's (the adjudicator recommends and never decides one)", {
    measured: `${String(ledger.merged)} researcher suggestion(s) merged, ${String(ledger.merged - ledger.withoutAccept.length)} after a curator's accept · opa ${String(opa.passed)}/${String(opa.total)}`,
    problems,
  });
}

/* ------------------------------------------------------------------ R9: whose budget a run spends */

/**
 * Who paid for research (feature-specs/48 § 7, A3; unit 75's reading of R9): a person's run on their own principal,
 * never on the platform's research principal, which since unit 75 pays only Improve's vetting of the findings people
 * send (§ 7.3) and the legacy runs still under way, within its cap.
 */
export interface ResearchBudgetFacts {
  /** The platform's research principal (`org:<id>`, the organisation whose `researchPrincipal` is true), or null where there is none. */
  readonly principal: string | null;
  /** A person's runs — a run of a research — with a call on the platform's research principal: none may have one. */
  readonly personRunsOnPlatform: ReadonlyArray<string>;
  /** The research calls of people's runs on their own principals, counted: what A3 has them pay. */
  readonly personCalls: number;
  /** The principal's months against its cap. */
  readonly months: ReadonlyArray<{ readonly month: string; readonly spentUsd: number; readonly capUsd: number | null }>;
}

export function budgetCriterion(selections: ReadonlyArray<TestSelection> | Unmeasured, facts: ResearchBudgetFacts | Unmeasured): Criterion {
  if (isUnmeasured(facts)) return unmeasured("R9", facts);
  const over = facts.months.filter((month) => month.capUsd !== null && month.spentUsd > month.capUsd);
  const problems = [
    ...(facts.personRunsOnPlatform.length === 0 ? [] : [`${String(facts.personRunsOnPlatform.length)} person's run(s) with a call on the platform's research principal: ${facts.personRunsOnPlatform.slice(0, 3).join(", ")}`]),
    ...over.map((month) => `${month.month}: $${month.spentUsd.toFixed(2)} past the cap of $${(month.capUsd ?? 0).toFixed(2)}`),
  ];
  const months = facts.months.map((month) => `${month.month} $${month.spentUsd.toFixed(2)}${month.capUsd === null ? "" : ` of $${month.capUsd.toFixed(2)}`}`).join(", ");
  return judged("R9", selections, `BudgetLedger: no person's run with a call on the platform's research principal, and that principal's months within its cap${facts.principal === null ? " (no research principal here: no platform month to read)" : ""}; the suites: a run's planner, reader, writer and retrieval on the person's own ledger and none on a research principal's; a run stopped at the person's cap at the planner, the reader and the writer; Improve's grading and adjudication of a sent finding on the research principal; the gateway's refusal at a cap`, {
    measured: `${String(facts.personRunsOnPlatform.length)} person's run(s) on the platform · ${String(facts.personCalls)} research call(s) of people's runs on their own principals · ${months === "" ? "no platform month spent" : months}`,
    problems,
  });
}

/* ------------------------------------------------------------------ R11: the one paid call */

/** What `npm run research:check` writes beside its printed report (unit 61b): the facts, never the answer's text. */
export interface ResearchCheckFacts {
  readonly at: string;
  readonly toolsCarried: boolean;
  readonly fetchCarried: boolean;
  readonly searches: number;
  readonly fetches: number;
  readonly costUsd: number;
  readonly searchFeeUsd: number;
  readonly gatewayDeltaUsd: number | null;
}

export function checkCriterion(check: { readonly file: string; readonly facts: ResearchCheckFacts } | null): Criterion {
  if (check === null) return criterion("R11", "blocked", "—", `Needs one real call through the gateway: ${RESEARCH_CHECK_COMMAND} (a few cents, Andre's to run); it writes pipeline/reports/research-check-<date>.json, which this criterion reads`);
  const { facts } = check;
  const problems = [...(facts.toolsCarried ? [] : ["the proxy did not carry the web tools' blocks"]), ...(facts.fetchCarried ? [] : ["the proxy did not carry the fetch tool's blocks"]), ...(facts.costUsd > 0 ? [] : ["the ledger recorded no cost for the call"])];
  return criterion(
    "R11",
    problems.length === 0 ? "pass" : "fail",
    `tools ${facts.toolsCarried ? "carried" : "NOT carried"} · fetch ${facts.fetchCarried ? "carried" : "NOT carried"} · ${String(facts.searches)} search(es), ${String(facts.fetches)} fetch(es) · $${facts.costUsd.toFixed(4)} in the ledger (fee $${facts.searchFeeUsd.toFixed(4)})${facts.gatewayDeltaUsd === null ? "" : ` · the gateway's $${facts.gatewayDeltaUsd.toFixed(4)}`}`,
    `${check.file}, ${facts.at}${problems.length === 0 ? "" : ` · ${problems.join("; ")}`}`,
  );
}

/* ------------------------------------------------------------------ § 3: measures without a verdict */

export interface MeasureFacts {
  /**
   * A reader call the gateway answered under the platform's research principal: until one exists, every measure is not
   * yet measured. A person's real run is not told from a suite's run on the stub by its rows, both on a person's ledger
   * (48 § 7.1), so the flag stays the platform's (on this machine, the legacy run of 2026-10-10).
   */
  readonly realRun: boolean;
  readonly runs: { readonly all: number; readonly reachedReader: number; readonly plannedNothing: number };
  readonly spend: { readonly usd: number; readonly runsRead: number };
  readonly findings: Readonly<Record<string, number>>;
  readonly refutedBy: Readonly<Record<string, number>>;
  readonly refutedTiers: Readonly<Record<string, number>>;
  readonly decided: { readonly accepted: number; readonly declined: number };
  readonly merged: { readonly merged: number; readonly reverted: number };
  readonly agreement: { readonly research: { readonly agreed: number; readonly decided: number }; readonly people: { readonly agreed: number; readonly decided: number } };
  readonly endorsement: { readonly shown: number; readonly endorsed: number };
  readonly toShownMs: ReadonlyArray<number>;
  /** Proposals shown whose finding has no run left to measure from: the sweep deleted it (feature-specs/45 § 3.5). */
  readonly toShownSkipped: number;
  readonly toDecisionMs: ReadonlyArray<number>;
}

/** Seven days to a curator's decision on a researcher's proposal (43 § 7.1). */
export const DECISION_WITHIN_MS = 7 * 86_400_000;

export interface Measure {
  readonly name: string;
  readonly value: string;
}

const hours = (ms: number): string => (ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const share = (n: number, d: number): string => (d === 0 ? "—" : `${percent(n / d)} (${String(n)}/${String(d)})`);
const counts = (record: Readonly<Record<string, number>>): string => {
  const entries = Object.entries(record).filter(([, n]) => n > 0);
  return entries.length === 0 ? "none" : entries.map(([key, n]) => `${key} ${String(n)}`).join(", ");
};

/** § 3, each with its counts; `not yet measured` until a real run exists. No number here has a target (D1). */
export function researchMeasures(facts: MeasureFacts): ReadonlyArray<Measure> {
  const unmeasuredYet = "not yet measured: no run has read the web through the real gateway";
  const value = (text: string): string => (facts.realRun ? text : `${unmeasuredYet} · ${text}`);
  const refuted = Object.values(facts.refutedTiers).reduce((sum, n) => sum + n, 0);
  return [
    /* the calls that name a run, whoever paid, over the runs whose reader answered (cost-per-run.sql on `ResearchSpend`, 48 § 7.1; unit 70c) */
    { name: "cost of a run", value: value(facts.spend.runsRead === 0 ? `$${facts.spend.usd.toFixed(4)} over no run that read` : `$${(facts.spend.usd / facts.spend.runsRead).toFixed(4)} a run that read ($${facts.spend.usd.toFixed(4)} over ${String(facts.spend.runsRead)}, whoever paid)`) },
    { name: "what a run yields", value: value(`${facts.runs.reachedReader === 0 ? "—" : ((facts.findings.all ?? 0) / facts.runs.reachedReader).toFixed(2)} finding(s) a run that planned a brief (${String(facts.runs.reachedReader)}) · planned nothing ${share(facts.runs.plannedNothing, facts.runs.all)}`) },
    { name: "what Improve does with findings", value: value(`${counts(facts.findings)} · of the ${String(Object.values(facts.refutedBy).reduce((sum, n) => sum + n, 0))} closed proposal(s) still in the database, refuted by ${counts(facts.refutedBy)}`) },
    { name: "the strongest tier of refuted findings", value: value(`${counts(facts.refutedTiers)} · graded U ${share(facts.refutedTiers.U ?? 0, refuted)}`) },
    { name: "the researcher's precision", value: value(`accepted ${share(facts.decided.accepted, facts.decided.accepted + facts.decided.declined)} of the proposals a curator decided · reverted ${share(facts.merged.reverted, facts.merged.merged)} of those merged`) },
    { name: "the adjudicator on research", value: value(`agreed with curators on ${share(facts.agreement.research.agreed, facts.agreement.research.decided)} of researchers' proposals, beside ${share(facts.agreement.people.agreed, facts.agreement.people.decided)} of people's`) },
    { name: "endorsement", value: value(`a reader put their name to ${share(facts.endorsement.endorsed, facts.endorsement.shown)} of the proposals shown`) },
    {
      name: "time",
      value: value(`from a run's start to a proposal shown: ${facts.toShownMs.length === 0 ? "—" : `median ${hours(percentile(facts.toShownMs, 50))} over ${String(facts.toShownMs.length)}`}${facts.toShownSkipped === 0 ? "" : ` (${String(facts.toShownSkipped)} skipped: no run left)`} · from a proposal to a curator's decision: ${facts.toDecisionMs.length === 0 ? "—" : `median ${hours(percentile(facts.toDecisionMs, 50))}, ${share(facts.toDecisionMs.filter((ms) => ms <= DECISION_WITHIN_MS).length, facts.toDecisionMs.length)} within 7 days`}`),
    },
  ];
}

/* ------------------------------------------------------------------ the report */

export interface ResearchReport extends GateReportBase {
  readonly phase: 5;
  readonly measures: ReadonlyArray<Measure>;
  /** R1's own numbers, turn by turn, for whoever reads the verdict: null where the turns were not asked. */
  readonly turns: TurnsFacts | null;
  /** The suites the gate ran, each with how it ended. */
  readonly suites: ReadonlyArray<{ readonly file: string; readonly passed: number; readonly failed: number; readonly total: number }>;
  /** What the measures were read from, said beside them: this machine's ledger holds the suites' runs too (44 § 9). */
  readonly measuredFrom: string;
}

export function researchReport(input: { readonly release: string; readonly appUrl: string; readonly startedAt: string; readonly finishedAt: string; readonly criteria: ReadonlyArray<Criterion>; readonly measures: ReadonlyArray<Measure>; readonly measuredFrom: string; readonly outcomes: ReadonlyArray<TestOutcome>; readonly turns?: TurnsFacts | null }): ResearchReport {
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
    phase: 5,
    release: input.release,
    appUrl: input.appUrl,
    criteria: input.criteria,
    met: gateVerdict(input.criteria).met,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    measures: input.measures,
    turns: input.turns ?? null,
    measuredFrom: input.measuredFrom,
    suites: [...byFile.entries()].map(([file, entry]) => ({ file, ...entry })).sort((a, b) => a.file.localeCompare(b.file)),
  };
}

/** The lines printed after the criteria (§ 5): the measures, each with its counts, under the line that says they move nothing. */
export function formatResearchExtras(report: ResearchReport): string {
  return ["Measures without a verdict (44 § 3; none has a target and none moves the exit):", `  ${report.measuredFrom}`, ...report.measures.map((measure) => `  · ${measure.name}: ${measure.value}`)].join("\n");
}
