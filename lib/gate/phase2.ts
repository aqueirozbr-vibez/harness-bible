import { gateVerdict, percentile, type Criterion, type GateReportBase } from "@/lib/gate/common";
import { cohenKappa, KAPPA_FLOOR, KAPPA_RETIRE } from "@/lib/gate/kappa";
import type { GoldenItem } from "@/lib/schemas/golden";
import { GRADER_CRITERIA, type GoldenRunItem, type GraderCriterion, type RunGrade } from "@/lib/schemas/goldenRun";
import type { Label } from "@/lib/schemas/labels";
import { AnswerPayloadSchema } from "@/lib/schemas/ledger";

/*
 * The Phase 2 gate (project-overview § Success criteria · Phase 2; feature-specs/22): the pure rules behind
 * `npm run gate:phase2`. The script measures; this module counts, compares and words the result. Every threshold
 * here is the overview's or the architecture's, named where it is used, and every criterion that could not be
 * measured says what is missing rather than passing.
 *
 * Seven promises, ten criteria: (1), (5) and (6) each make two claims, and a gate that reported them as one would
 * hide which half failed.
 */

export type P2Id = "P2.1a" | "P2.1b" | "P2.2" | "P2.3" | "P2.4" | "P2.5a" | "P2.5b" | "P2.6a" | "P2.6b" | "P2.7";

export const P2_TEXT: Readonly<Record<P2Id, string>> = {
  "P2.1a": "On the golden set, at least 90% of answers carry a chapter citation on every claim.",
  "P2.1b": "The grounding grader reaches κ ≥ 0.7 against curator labels.",
  "P2.2": "Each of the four refusal causes produces a refusal before retrieval with zero gateway calls, a refusal code and a pointer to the covering section, verifiable in the ledger.",
  "P2.3": 'A question whose draft contains an uncited claim ships with that claim replaced by "the book does not cover this", and the substitution is visible only after the final SSE event.',
  "P2.4": "A decision-aid walk on 37.8 with the book's P-101 inputs returns the chapter's own figure with a derive chip and the source verification date.",
  "P2.5a": "First token arrives in under 2 s at p95.",
  "P2.5b": "The guide prefix is byte-stable across requests, with the cache hit visible in gateway usage.",
  "P2.6a": "A flagged answer appears in the calibration set.",
  "P2.6b": "Message text is null after 30 days while citations and verdicts remain.",
  "P2.7": "Every answer is a ledger record with citations, verdicts, guide version and model id, and the chain verifies.",
};

/** The gateway's two messages aliases (infra/gateway/litellm.yaml): the draft's and the grader's, and the scope classifier's. */
export const FRONTIER_ALIAS = "hb-frontier";
export const SMALL_ALIAS = "hb-small";

/** At least 90 % of answers with a citation on every claim (overview, Phase 2 (1)). */
export const CITATION_FLOOR = 0.9;
/** The gate's κ needs at least this many labelled answers (feature-specs/22 § 3). */
export const LABELS_MIN = 100;
/** First token under 2 s at p95 (architecture § 8). */
export const FIRST_TOKEN_MS = 2000;
/** The grader's own floor: an answer is grounded for the gate at or above it (feature-specs/13 § 7.3; 22 D4). */
export const GROUNDED_FLOOR = 0.7;

/** A run of the golden set, as the gate reads it back from its file. */
export interface GoldenRun {
  readonly grade: RunGrade;
  /** The file's name, which the report and a label both carry. */
  readonly file: string;
  readonly items: ReadonlyArray<GoldenRunItem>;
  /** The run stopped before the last item. */
  readonly partial: boolean;
}

export interface Phase2Report extends GateReportBase {
  readonly phase: 2;
  /** Which gateway the measured run went through: the numbers of P2.1a and P2.5 mean something only on `real`. */
  readonly gateway: RunGrade;
  readonly run: { readonly file: string; readonly items: number; readonly cost_usd: number } | null;
}

const criterion = (id: P2Id, status: Criterion["status"], measured: string, note: string): Criterion => ({ id, text: P2_TEXT[id], status, measured, note });
/** What the criteria that read a provider's answers wait for: not a key alone, a whole run made with it. A pilot is not one. */
const NEEDS_REAL = "Needs a whole run of the golden set through the provider (npm run gate:golden -- --real, which is paid)";
const percent = (share: number) => `${(share * 100).toFixed(1)} %`;
const thousands = (value: number) => Math.round(value).toLocaleString("en-US");

/* ------------------------------------------------------------------ P2.1a: citation on every claim */

export interface CitationRate {
  /** The non-refusal items: what the rate is over. */
  readonly items: number;
  readonly cited: number;
  /** Null with nothing to divide by. */
  readonly rate: number | null;
  /** The refusal items, reported beside the rate: correct when the cause is the expected one. */
  readonly refusals: { readonly items: number; readonly correct: number };
}

/** An answer counts when it is an answer, every claim was found where it was cited, and none was replaced. */
export function cited(item: GoldenRunItem): boolean {
  return item.outcome === "answer" && item.claims.notFound === 0 && item.claims.substituted === 0;
}

export function citationRate(items: ReadonlyArray<GoldenRunItem>): CitationRate {
  const asked = items.filter((item) => item.kind !== "refusal");
  const refusals = items.filter((item) => item.kind === "refusal");
  const count = asked.filter(cited).length;
  return {
    items: asked.length,
    cited: count,
    rate: asked.length === 0 ? null : count / asked.length,
    refusals: { items: refusals.length, correct: refusals.filter((item) => item.outcome === "refusal" && item.expectedHit).length },
  };
}

function shapeOf(stub: GoldenRun | null): string {
  if (stub === null) return "no stub run either";
  const rate = citationRate(stub.items);
  return `the stub run is shape only: ${String(rate.cited)}/${String(rate.items)} cited, ${String(rate.refusals.correct)}/${String(rate.refusals.items)} refusals with the expected cause (${stub.file})`;
}

export function citationCriterion(real: GoldenRun | null, stub: GoldenRun | null): Criterion {
  if (real === null) return criterion("P2.1a", "blocked", "not measured", `${NEEDS_REAL}: the rate means something only through the real gateway; ${shapeOf(stub)}.`);
  const rate = citationRate(real.items);
  const measured = `${String(rate.cited)}/${String(rate.items)} · ${rate.rate === null ? "no items" : percent(rate.rate)}`;
  const beside = `refusal items with the expected cause ${String(rate.refusals.correct)}/${String(rate.refusals.items)}; ${real.file}`;
  if (real.partial) return criterion("P2.1a", "fail", measured, `The run stopped before the last item (${String(real.items.length)} answered), so the rate is not the golden set's; ${beside}.`);
  return criterion("P2.1a", rate.rate !== null && rate.rate >= CITATION_FLOOR ? "pass" : "fail", measured, `An answer counts when every claim was found where it was cited and none was replaced; ${beside}.`);
}

/* ------------------------------------------------------------------ P2.1b: κ against curator labels */

/* Cohen's κ and its lines live in ./kappa, which the adjudicator's calibration measures with too (feature-specs/36 § 6.1). */
export { cohenKappa, KAPPA_FLOOR, KAPPA_MIN_PAIRS, KAPPA_RETIRE } from "@/lib/gate/kappa";

/** A label beside the answer it is of: the pair is made only when that answer was graded. */
function joined(labels: ReadonlyArray<Label>, items: ReadonlyArray<GoldenRunItem>): ReadonlyArray<{ readonly label: Label; readonly item: GoldenRunItem }> {
  const byMessage = new Map(items.flatMap((item) => (item.messageId === null ? [] : [[item.messageId, item] as const])));
  return labels.flatMap((label) => {
    const item = byMessage.get(label.messageId);
    return item === undefined || item.grounded === null ? [] : [{ label, item }];
  });
}

/** The gate's pair (D4): the grader's binary verdict, `grounded ≥ 0.7`, against the label's. */
export function groundedPairs(labels: ReadonlyArray<Label>, items: ReadonlyArray<GoldenRunItem>): ReadonlyArray<readonly [boolean, boolean]> {
  return joined(labels, items).map(({ label, item }) => [(item.grounded ?? 0) >= GROUNDED_FLOOR, label.grounded] as const);
}

/** κ per grader criterion, for the retirement rule: the grader's PASS against the label's boolean. */
export function criterionKappa(labels: ReadonlyArray<Label>, items: ReadonlyArray<GoldenRunItem>): Readonly<Record<GraderCriterion, number | undefined>> {
  const pairs = joined(labels, items).filter(({ item }) => item.graderCriteria !== null);
  const of = (name: GraderCriterion) => cohenKappa(pairs.map(({ label, item }) => [item.graderCriteria?.[name] ?? false, label.criteria[name]] as const));
  return { supported: of("supported"), precise: of("precise"), complete: of("complete"), in_scope: of("in_scope") };
}

export function kappaCriterion(labels: ReadonlyArray<Label>, items: ReadonlyArray<GoldenRunItem>): Criterion {
  const pairs = groundedPairs(labels, items);
  if (pairs.length < LABELS_MIN) {
    const unmatched = labels.length - pairs.length;
    return criterion(
      "P2.1b",
      "blocked",
      `${String(pairs.length)} of ${String(LABELS_MIN)} labels`,
      `Needs ${String(LABELS_MIN)} labelled answers in golden/assistant/labels/ (a curator's or Andre's reading; npm run gate:show prints an answer to label)` +
        (unmatched > 0 ? `; ${String(unmatched)} label(s) name an answer that is not in the run or was not graded.` : "."),
    );
  }
  const kappa = cohenKappa(pairs) ?? 0;
  const each = criterionKappa(labels, items);
  const beside = GRADER_CRITERIA.map((name) => `${name} ${each[name] === undefined ? "n/a" : (each[name] ?? 0).toFixed(2)}`).join(" · ");
  const retire = GRADER_CRITERIA.filter((name) => (each[name] ?? 1) < KAPPA_RETIRE);
  return criterion(
    "P2.1b",
    kappa >= KAPPA_FLOOR ? "pass" : "fail",
    `κ ${kappa.toFixed(2)} on ${String(pairs.length)}`,
    `Cohen's κ between the grader's verdict (grounded ≥ ${String(GROUNDED_FLOOR)}) and the label; per criterion: ${beside}` +
      (retire.length === 0 ? "." : `; below ${String(KAPPA_RETIRE)} and due to be retired from the grader: ${retire.join(", ")}.`),
  );
}

/* ------------------------------------------------------------------ P2.5a: first token */

export function latencyCriterion(real: GoldenRun | null, stub: GoldenRun | null): Criterion {
  const sample = (run: GoldenRun) => run.items.flatMap((item) => (item.outcome === "answer" && item.firstTokenMs !== null ? [item.firstTokenMs] : []));
  if (real === null) {
    const shape = stub === null ? "no stub run either" : `the stub's first token says nothing of a provider's (p95 ${thousands(percentile(sample(stub), 95))} ms over ${String(sample(stub).length)})`;
    return criterion("P2.5a", "blocked", "not measured", `${NEEDS_REAL}; ${shape}.`);
  }
  const times = sample(real);
  if (times.length === 0) return criterion("P2.5a", "fail", "no answer streamed a first token", `Nothing to take a percentile of in ${real.file}.`);
  const p95 = percentile(times, 95);
  return criterion("P2.5a", p95 < FIRST_TOKEN_MS ? "pass" : "fail", `p95 ${thousands(p95)} ms`, `Nearest rank over ${String(times.length)} answered items of the golden run, one reader at a time; ${real.file}.${real.partial ? " The run stopped before the last item." : ""}`);
}

/* ------------------------------------------------------------------ P2.5b: the prefix and the cache */

/** The prompt prefix is byte-stable when every hash is the same hash. */
export function prefixStable(hashes: ReadonlyArray<string>): { readonly stable: boolean; readonly distinct: number } {
  const distinct = new Set(hashes).size;
  return { stable: hashes.length > 0 && distinct === 1, distinct };
}

/**
 * The cache hit, call by call: the first frontier call of each kind writes the prefix and reads nothing, and every
 * one after it must read some. `misses` counts the later calls that read none.
 */
export function cacheVisible(calls: ReadonlyArray<{ readonly kind: "assistant" | "grading"; readonly cacheRead: number }>): { readonly calls: number; readonly later: number; readonly misses: number } {
  const seen = new Set<string>();
  let later = 0;
  let misses = 0;
  for (const call of calls) {
    if (!seen.has(call.kind)) {
      seen.add(call.kind);
      continue;
    }
    later += 1;
    if (call.cacheRead === 0) misses += 1;
  }
  return { calls: calls.length, later, misses };
}

export function prefixCriterion(real: GoldenRun | null, stub: GoldenRun | null): Criterion {
  /* The cached prefix is the guide alone, whatever the mode: the mode's line, the sections and the question all sit after the breakpoint. */
  const hashes = (run: GoldenRun) => run.items.flatMap((item) => (item.outcome === "answer" && item.prefixSha256 !== null ? [item.prefixSha256] : []));
  const said = (run: GoldenRun) => {
    const all = hashes(run);
    const { stable, distinct } = prefixStable(all);
    return `${stable ? `one prefix (${(all[0] ?? "").slice(0, 12)}…)` : `${String(distinct)} prefixes`} over ${String(all.length)} answers`;
  };
  if (real === null) {
    const shape = stub === null ? "no stub run either" : `the stub shows the hash and its own pretend cache, not a provider's: ${said(stub)}`;
    return criterion("P2.5b", "blocked", "not measured", `${NEEDS_REAL}: a cache hit is the provider's to report; ${shape}.`);
  }
  const { stable } = prefixStable(hashes(real));
  const cache = cacheVisible(real.items.flatMap((item) => item.frontier));
  return criterion(
    "P2.5b",
    stable && cache.later > 0 && cache.misses === 0 ? "pass" : "fail",
    `${stable ? "prefix stable" : "prefix changed"} · cache read on ${String(cache.later - cache.misses)}/${String(cache.later)} later calls`,
    `The cached prefix is the guide's bytes: ${said(real)}. Every frontier call after the first of its kind must read from the cache (${String(cache.calls)} calls); ${real.file}.${real.partial ? " The run stopped before the last item." : ""}`,
  );
}

/* ------------------------------------------------------------------ the criteria the script measures on the running system */

/** What the script could not measure, and why: nothing outside the repository to measure with, or a unit not built. */
export type Unmeasured = { readonly blocked: string } | { readonly deferred: string };

function unmeasured(id: P2Id, fact: Unmeasured): Criterion {
  return "blocked" in fact ? criterion(id, "blocked", "not measured", fact.blocked) : criterion(id, "deferred", "not measured", fact.deferred);
}

const isUnmeasured = (fact: object): fact is Unmeasured => "blocked" in fact || "deferred" in fact;

/** One refusal cause, asked through the API (P2.2). */
export interface RefusalCheck {
  readonly cause: string;
  /** What came back: the cause the turn refused with, or null when it answered or failed instead. */
  readonly refusedWith: string | null;
  readonly beforeRetrieval: boolean;
  readonly code: string | null;
  readonly pointers: number;
  readonly frontierCalls: number;
  /** The classifier's calls on the small alias: one is the cost of the cause it names, and is reported. */
  readonly smallCalls: number;
  /** The turn's `ANSWER` record: found with `kind: refusal` and its hash verifying. */
  readonly ledger: "verified" | "missing" | "mismatch";
}

/** The causes whose refusal must point at the section that does cover the matter (feature-specs/22 § 3). */
const POINTER_CAUSES: ReadonlySet<string> = new Set(["R-SCOPE-OT", "R-RECOMPUTE"]);
export const REFUSAL_CAUSES_GATED = ["R-SCOPE", "R-SCOPE-OT", "R-RECOMPUTE", "R-UNVERIFIED"] as const;

export function refusalFailures(check: RefusalCheck): ReadonlyArray<string> {
  const failures: string[] = [];
  if (check.refusedWith !== check.cause) failures.push(check.refusedWith === null ? "did not refuse" : `refused as ${check.refusedWith}`);
  if (!check.beforeRetrieval) failures.push("after retrieval");
  if (check.code === null) failures.push("no code");
  if (POINTER_CAUSES.has(check.cause) && check.pointers < 1) failures.push("no pointer");
  if (check.frontierCalls > 0) failures.push(`${String(check.frontierCalls)} frontier call(s)`);
  if (check.ledger !== "verified") failures.push(`ledger record ${check.ledger}`);
  return failures;
}

/**
 * One question per gated cause from the golden set: the first whose label is that cause and whose context can
 * produce it. `R-UNVERIFIED` is asked from a chapter the release has not verified; the other three from one it has,
 * because an unverified chapter refuses for its own cause before any other rule is reached.
 */
export function pickRefusalItems(items: ReadonlyArray<GoldenItem>, verified: ReadonlySet<number>): ReadonlyMap<string, GoldenItem> {
  const picked = new Map<string, GoldenItem>();
  for (const cause of REFUSAL_CAUSES_GATED) {
    const item = items.find((candidate) => candidate.expected.refusal?.cause === cause && verified.has(candidate.context.chapter) === (cause !== "R-UNVERIFIED"));
    if (item !== undefined) picked.set(cause, item);
  }
  return picked;
}

/**
 * P2.2's facts for one cause, from the turn's `final` event, its gateway calls and the record `final` names.
 * `final` null: the turn did not end in one. The record is verified when it is an `ANSWER` record of this very
 * message, a refusal for this cause, whose stored hash is the hash of its own fields and the one `final` carried.
 */
export function refusalCheckOf(
  cause: string,
  final: Pick<GateFinal, "messageId" | "refusal" | "ledger"> | null,
  calls: ReadonlyArray<{ readonly alias: string }>,
  record: { readonly row: LedgerRow; readonly hash: string; readonly rehashed: string } | null,
): RefusalCheck {
  const payload = record === null || record.row.kind !== "ANSWER" ? null : AnswerPayloadSchema.safeParse(record.row.payload);
  const verified =
    final !== null && record !== null && payload !== null && payload.success && payload.data.messageId === final.messageId && payload.data.refusal?.cause === cause && record.rehashed === record.hash && record.hash === final.ledger.hash;
  return {
    cause,
    refusedWith: final?.refusal?.cause ?? null,
    beforeRetrieval: final?.refusal?.beforeRetrieval ?? false,
    code: final?.refusal?.code ?? null,
    pointers: final?.refusal?.pointers.length ?? 0,
    frontierCalls: calls.filter((call) => call.alias === FRONTIER_ALIAS).length,
    smallCalls: calls.filter((call) => call.alias === SMALL_ALIAS).length,
    ledger: record === null ? "missing" : verified ? "verified" : "mismatch",
  };
}

export function refusalCriterion(fact: ReadonlyArray<RefusalCheck> | Unmeasured): Criterion {
  if (isUnmeasured(fact)) return unmeasured("P2.2", fact);
  const results = REFUSAL_CAUSES_GATED.map((cause) => {
    const check = fact.find((entry) => entry.cause === cause);
    return { cause, failures: check === undefined ? ["not asked"] : refusalFailures(check), small: check?.smallCalls ?? 0 };
  });
  const passed = results.filter((result) => result.failures.length === 0);
  const small = results.filter((result) => result.small > 0).map((result) => `${result.cause} ${String(result.small)}`);
  return criterion(
    "P2.2",
    passed.length === REFUSAL_CAUSES_GATED.length ? "pass" : "fail",
    `${String(passed.length)}/${String(REFUSAL_CAUSES_GATED.length)} causes`,
    results.map((result) => `${result.cause}: ${result.failures.length === 0 ? "ok" : result.failures.join(", ")}`).join(" · ") +
      (small.length === 0 ? ". No call on the small alias either." : `. Calls on the small alias, the classifier's and allowed: ${small.join(", ")}.`),
  );
}

/**
 * The stub's uncited claim through the stream (P2.3). The criterion is the overview's: the claim ships replaced,
 * and the substitution is visible only after `final`. The stream is the draft as it is written (architecture § 6.4;
 * feature-specs/16 § 5.4: pending text, replaced on `final`, never shown as a cited claim), so the claim's own words
 * going by are reported in the note and are not the defect; the sentence appearing before `final` would be.
 */
export interface SubstitutionCheck {
  /** A `token` event carried the substitution sentence: the defect. */
  readonly tokensHeldSentence: boolean;
  /** The token stream carried the uncited claim's own words: the draft, as written. Reported, not failed. */
  readonly tokensHeldClaim: boolean;
  /** Claims of `final` marked `substituted`. */
  readonly finalSubstituted: number;
  /** `final` still carries the uncited claim's text: it was not replaced. */
  readonly finalHoldsClaim: boolean;
  /** The stored `Message.text` holds the sentence, and not the claim. */
  readonly storedHoldsSentence: boolean;
  readonly storedHoldsClaim: boolean;
}

/** What the gate reads of a turn's `final` event (`SseFinalSchema` gives it). */
export interface GateFinal {
  readonly messageId: string;
  readonly refusal: { readonly cause: string; readonly code: string; readonly pointers: ReadonlyArray<unknown>; readonly beforeRetrieval: boolean } | null;
  readonly claims: ReadonlyArray<{ readonly text: string; readonly substituted: boolean }>;
  readonly verdicts: ReadonlyArray<{ readonly sensor: string; readonly verdict: string; readonly detail: string }>;
  readonly grounded: number | null;
  /** A walk turn's run and values (`WalkModeResultSchema`); null on other turns. */
  readonly modeResult: unknown;
  readonly ledger: { readonly seq: number; readonly hash: string };
}

/** P2.3's facts from what the turn streamed, what `final` carried and what the row keeps. `final` null: the turn did not end in one. */
export function substitutionCheckOf(input: { readonly tokens: string; readonly final: Pick<GateFinal, "claims"> | null; readonly stored: string | null; readonly sentence: string; readonly claim: string }): SubstitutionCheck {
  const claims = input.final?.claims ?? [];
  return {
    tokensHeldSentence: input.tokens.includes(input.sentence),
    tokensHeldClaim: input.tokens.includes(input.claim),
    finalSubstituted: claims.filter((claim) => claim.substituted).length,
    finalHoldsClaim: claims.some((claim) => claim.text.includes(input.claim)),
    storedHoldsSentence: input.stored !== null && input.stored.includes(input.sentence),
    storedHoldsClaim: input.stored !== null && input.stored.includes(input.claim),
  };
}

export function substitutionCriterion(fact: SubstitutionCheck | Unmeasured): Criterion {
  if (isUnmeasured(fact)) return unmeasured("P2.3", fact);
  const failures = [
    fact.tokensHeldSentence ? "a token event carried the substitution sentence" : null,
    fact.finalSubstituted < 1 ? "final marks no claim as substituted" : null,
    fact.finalHoldsClaim ? "final still carries the uncited claim" : null,
    fact.storedHoldsSentence ? null : "the stored text does not hold the sentence",
    fact.storedHoldsClaim ? "the stored text holds the uncited claim" : null,
  ].filter((failure): failure is string => failure !== null);
  const streamed = fact.tokensHeldClaim ? "The draft's own words for that claim did stream, as the pending text the client replaces on final (architecture § 6.4)." : "The claim's own words did not stream either.";
  return criterion(
    "P2.3",
    failures.length === 0 ? "pass" : "fail",
    `${String(fact.finalSubstituted)} claim(s) replaced in final · the sentence ${fact.tokensHeldSentence ? "streamed before final" : "only after final"}`,
    failures.length === 0
      ? `The stub's uncited claim through the stream: no token event held the substitution sentence; final and the stored row hold it, and not the claim. ${streamed}`
      : `${failures.join("; ")}. ${streamed}`,
  );
}

/** The 37.8 walk at the aid's defaults (P2.4). */
export interface WalkCheck {
  readonly exitCode: number | null;
  /** Step 2's headline as the turn gave it, and as computed here from the script's own values. */
  readonly headline: string | null;
  readonly expectedHeadline: string;
  readonly line: number | null;
  readonly expectedLine: number;
  /** The verification date of the prices' source section; null when the turn gave none. */
  readonly pricesVerifiedAt: string | null;
  /** The derive sensor's detail: `derive output matched · 3 of 3`. */
  readonly derive: string | null;
  /** The values equal the release's own run of the lab (`results/derived.json`). */
  readonly valuesEqualRelease: boolean;
}

export function walkCriterion(fact: WalkCheck | Unmeasured): Criterion {
  if (isUnmeasured(fact)) return unmeasured("P2.4", fact);
  const failures = [
    fact.exitCode === 0 ? null : `the script exited ${fact.exitCode === null ? "without a code" : String(fact.exitCode)}`,
    fact.headline === fact.expectedHeadline ? null : `headline ${fact.headline ?? "absent"}, the script gives ${fact.expectedHeadline}`,
    fact.line === fact.expectedLine ? null : `derive line ${fact.line === null ? "absent" : String(fact.line)}, the step declares ${String(fact.expectedLine)}`,
    fact.pricesVerifiedAt === null ? "no verification date for the prices" : null,
    fact.derive !== null && /matched · (\d+) of \1$/.test(fact.derive) ? null : `derive sensor: ${fact.derive ?? "absent"}`,
    fact.valuesEqualRelease ? null : "the values differ from the release's own run",
  ].filter((failure): failure is string => failure !== null);
  return criterion(
    "P2.4",
    failures.length === 0 ? "pass" : "fail",
    `${fact.headline ?? "no headline"} · ƒ L${fact.line === null ? "?" : String(fact.line)} · prices verified ${fact.pricesVerifiedAt ?? "?"}`,
    failures.length === 0 ? `The script's own figure, not the model's: ${fact.derive ?? ""}; the values equal the release's run of the lab.` : `${failures.join("; ")}.`,
  );
}

/** One answer of the run, flagged through the API, then looked for in the calibration set (P2.6a). */
export interface FlagCheck {
  readonly flagged: boolean;
  readonly inCalibration: boolean;
  /** What the calibration row carries beside the answer: its verdicts, its score as the answer has it (none when the grader gave none), the reason the flag gave. */
  readonly carries: { readonly verdicts: boolean; readonly grounded: boolean; readonly reason: boolean };
  /** The answer's own score, for the note; null when it was not graded, which is every answer of the stub. */
  readonly score: number | null;
}

/** P2.6a's facts: whether the API took the flag, and the calibration set's row for the answer beside the answer itself. `row` null: the set does not hold it. */
export function flagCheckOf(
  accepted: boolean,
  row: { readonly reason: string; readonly grounded: number | null; readonly verdicts: number } | null,
  answer: { readonly reason: string; readonly grounded: number | null; readonly verdicts: number },
): FlagCheck {
  return {
    flagged: accepted,
    inCalibration: row !== null,
    carries: { verdicts: row !== null && row.verdicts > 0 && row.verdicts === answer.verdicts, grounded: row !== null && row.grounded === answer.grounded, reason: row !== null && row.reason === answer.reason },
    score: answer.grounded,
  };
}

export function flagCriterion(fact: FlagCheck | Unmeasured): Criterion {
  if (isUnmeasured(fact)) return unmeasured("P2.6a", fact);
  const missing = (Object.entries(fact.carries) as ReadonlyArray<[string, boolean]>).filter(([, present]) => !present).map(([name]) => name);
  const ok = fact.flagged && fact.inCalibration && missing.length === 0;
  return criterion(
    "P2.6a",
    ok ? "pass" : "fail",
    fact.inCalibration ? "in the calibration set" : "not in the calibration set",
    ok ? `Flagged through the API; the calibration query returns it with its verdicts, the reason and ${fact.score === null ? "no score, as the answer has none: the stub's grader gives no verdict" : `its score (${fact.score.toFixed(2)})`}.` : !fact.flagged ? "The flag was not accepted." : !fact.inCalibration ? "The calibration query does not return the flagged answer." : `The calibration row lacks: ${missing.join(", ")}.`,
  );
}

/** The purge 31 days ahead, kept to the gate's own reader, watched on one answered turn of its own (P2.6b). */
export interface RetentionCheck {
  readonly textNull: boolean;
  readonly claimTextNull: boolean;
  readonly textPurgedAt: boolean;
  readonly citations: { readonly before: number; readonly after: number };
  readonly verdicts: { readonly before: number; readonly after: number };
  /** The turn's ledger record is the same record after the purge. */
  readonly ledgerUnchanged: boolean;
}

/** One conversation as the purge finds it and as it leaves it: what P2.6b compares. */
export interface RetentionSnapshot {
  readonly textPurgedAt: boolean;
  /** Every message's text, the question's and the answer's. */
  readonly texts: ReadonlyArray<string | null>;
  readonly citations: ReadonlyArray<{ readonly ordinal: number; readonly sectionId: string; readonly figureId: string | null; readonly version: string; readonly editionLang: string; readonly claimText: string | null }>;
  readonly verdicts: ReadonlyArray<{ readonly sensor: string; readonly verdict: string; readonly detail: string }>;
  /** The answer's ledger record: its hash and its payload in canonical form. Null when the turn has none. */
  readonly ledger: { readonly hash: string; readonly payload: string } | null;
}

/**
 * P2.6b's facts from the conversation before the purge and after it. The words must have been there and be gone;
 * `after` counts the citations and verdicts that are still what they were, the quoted claim aside, so a row that
 * survived altered is a row lost.
 */
export function retentionCheckOf(before: RetentionSnapshot, after: RetentionSnapshot): RetentionCheck {
  const citationKey = (row: RetentionSnapshot["citations"][number]) => JSON.stringify([row.ordinal, row.sectionId, row.figureId, row.version, row.editionLang]);
  const verdictKey = (row: RetentionSnapshot["verdicts"][number]) => JSON.stringify([row.sensor, row.verdict, row.detail]);
  const citations = new Set(before.citations.map(citationKey));
  const verdicts = new Set(before.verdicts.map(verdictKey));
  return {
    textNull: before.texts.some((text) => text !== null) && after.texts.length === before.texts.length && after.texts.every((text) => text === null),
    claimTextNull: before.citations.some((row) => row.claimText !== null) && after.citations.every((row) => row.claimText === null),
    textPurgedAt: !before.textPurgedAt && after.textPurgedAt,
    citations: { before: before.citations.length, after: after.citations.filter((row) => citations.has(citationKey(row))).length },
    verdicts: { before: before.verdicts.length, after: after.verdicts.filter((row) => verdicts.has(verdictKey(row))).length },
    ledgerUnchanged: before.ledger !== null && after.ledger !== null && before.ledger.hash === after.ledger.hash && before.ledger.payload === after.ledger.payload,
  };
}

export function retentionCriterion(fact: RetentionCheck | Unmeasured): Criterion {
  if (isUnmeasured(fact)) return unmeasured("P2.6b", fact);
  const failures = [
    fact.textNull ? null : "message text remains",
    fact.claimTextNull ? null : "claim text remains",
    fact.textPurgedAt ? null : "textPurgedAt not set",
    fact.citations.before === fact.citations.after && fact.citations.after > 0 ? null : `citations ${String(fact.citations.before)} → ${String(fact.citations.after)}`,
    fact.verdicts.before === fact.verdicts.after && fact.verdicts.after > 0 ? null : `verdicts ${String(fact.verdicts.before)} → ${String(fact.verdicts.after)}`,
    fact.ledgerUnchanged ? null : "the ledger record changed",
  ].filter((failure): failure is string => failure !== null);
  return criterion(
    "P2.6b",
    failures.length === 0 ? "pass" : "fail",
    `text ${fact.textNull ? "null" : "kept"} · ${String(fact.citations.after)} citations · ${String(fact.verdicts.after)} verdicts`,
    failures.length === 0 ? "The purge run with its clock 31 days ahead, for the gate's own reader alone, and watched on the answer it flagged: the words gone, the citations, verdicts and ledger record as they were." : `${failures.join("; ")}.`,
  );
}

/** Every answer of the run against the ledger, and the chain from genesis (P2.7). */
export interface LedgerCheck {
  /** The run whose answers were looked up: its file's name. */
  readonly file: string;
  readonly answers: number;
  /** Answers with an `ANSWER` record. */
  readonly recorded: number;
  /** Of those, the records holding citations, verdicts, the guide's version and hash, and the model id. */
  readonly complete: number;
  readonly chain: { readonly ok: boolean; readonly records: number; readonly brokenAt: number | null };
}

export function ledgerCriterion(fact: LedgerCheck | Unmeasured): Criterion {
  if (isUnmeasured(fact)) return unmeasured("P2.7", fact);
  const ok = fact.answers > 0 && fact.recorded === fact.answers && fact.complete === fact.answers && fact.chain.ok;
  return criterion(
    "P2.7",
    ok ? "pass" : "fail",
    `${String(fact.complete)}/${String(fact.answers)} records complete · chain ${fact.chain.ok ? "ok" : `broken at ${String(fact.chain.brokenAt ?? "?")}`} · ${thousands(fact.chain.records)} records`,
    ok
      ? `Every answer of ${fact.file} has an ANSWER record with its citations, verdicts, guide version and hash, and model id; the chain verifies from genesis. The records are the product's own, whichever gateway answered.`
      : `Of ${fact.file}: ${String(fact.answers - fact.recorded)} answer(s) without a record, ${String(fact.recorded - fact.complete)} record(s) incomplete${fact.chain.ok ? "" : "; the chain does not verify"}.`,
  );
}

/* ------------------------------------------------------------------ P2.7's facts, from the rows */

/** A ledger record as P2.7 reads it. */
export interface LedgerRow {
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * Whether a record is this answer's and holds what the criterion names. It is an `ANSWER` record that reads under
 * the payload's own schema, so its citations, verdicts, guide version and hash, and model id are all there; it names
 * this answer's message and is not a refusal's; its verdicts are not empty; and it holds citations whenever the
 * answer cited anything.
 */
export function answerRecordComplete(item: GoldenRunItem, row: LedgerRow): boolean {
  if (row.kind !== "ANSWER") return false;
  const payload = AnswerPayloadSchema.safeParse(row.payload);
  if (!payload.success) return false;
  const { data } = payload;
  return data.messageId === item.messageId && data.refusal === null && data.verdicts.length > 0 && data.guide.version.length > 0 && data.modelId.length > 0 && (data.citations.length > 0 || item.citedSections.length === 0);
}

/** The run's answers against the records at their `ledgerSeq`, and the chain's own check. */
export function ledgerCheckOf(
  run: Pick<GoldenRun, "file" | "items">,
  rows: ReadonlyArray<LedgerRow>,
  chain: { readonly ok: boolean; readonly records: number; readonly firstBreak: { readonly seq: number } | null },
): LedgerCheck {
  const answers = run.items.filter((item) => item.outcome === "answer");
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  const recorded = answers.flatMap((item) => {
    const row = item.ledgerSeq === null ? undefined : bySeq.get(item.ledgerSeq);
    return row === undefined || row.kind !== "ANSWER" ? [] : [{ item, row }];
  });
  return {
    file: run.file,
    answers: answers.length,
    recorded: recorded.length,
    complete: recorded.filter(({ item, row }) => answerRecordComplete(item, row)).length,
    chain: { ok: chain.ok, records: chain.records, brokenAt: chain.firstBreak?.seq ?? null },
  };
}

/* ------------------------------------------------------------------ the report */

/** What the script measured on the system, or why it could not: one entry per criterion that is not read from a run file. */
export interface Phase2Facts {
  readonly refusals: ReadonlyArray<RefusalCheck> | Unmeasured;
  readonly substitution: SubstitutionCheck | Unmeasured;
  readonly walk: WalkCheck | Unmeasured;
  readonly flag: FlagCheck | Unmeasured;
  readonly retention: RetentionCheck | Unmeasured;
  readonly ledger: LedgerCheck | Unmeasured;
}

export interface Phase2Input {
  readonly release: string;
  readonly appUrl: string;
  /** The newest whole real run, and the newest stub run: either may be absent. */
  readonly real: GoldenRun | null;
  readonly stub: GoldenRun | null;
  readonly labels: ReadonlyArray<Label>;
  readonly facts: Phase2Facts;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** The ten criteria, in the overview's order. */
export function phase2Criteria(input: Pick<Phase2Input, "real" | "stub" | "labels" | "facts">): ReadonlyArray<Criterion> {
  const { real, stub, labels, facts } = input;
  return [
    citationCriterion(real, stub),
    /* A label is of a provider's answer: without a real run there is nothing for it to pair with. */
    kappaCriterion(labels, real?.items ?? []),
    refusalCriterion(facts.refusals),
    substitutionCriterion(facts.substitution),
    walkCriterion(facts.walk),
    latencyCriterion(real, stub),
    prefixCriterion(real, stub),
    flagCriterion(facts.flag),
    retentionCriterion(facts.retention),
    ledgerCriterion(facts.ledger),
  ];
}

/**
 * The report (feature-specs/22 § 6). `run` is the golden run the report read, the real one when there is one, and
 * `gateway` is its grade. `cost_usd` is what the run was charged: a stub run's lines carry the price of its prompts,
 * which nobody paid, so its cost here is 0.
 */
export function phase2Report(input: Phase2Input): Phase2Report {
  const criteria = phase2Criteria(input);
  const run = input.real ?? input.stub;
  return {
    phase: 2,
    release: input.release,
    appUrl: input.appUrl,
    gateway: run?.grade ?? "stub",
    run: run === null ? null : { file: run.file, items: run.items.length, cost_usd: run.grade === "real" ? run.items.reduce((sum, item) => sum + item.costUsd, 0) : 0 },
    criteria,
    met: gateVerdict(criteria).met,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}
