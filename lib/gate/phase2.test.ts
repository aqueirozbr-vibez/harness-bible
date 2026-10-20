import { describe, expect, it } from "vitest";

import { CITATION_RATE_FLOOR, FIRST_TOKEN_P95_MS } from "@/lib/metrics/dashboard";
import { GoldenItemSchema, REFUSAL_CAUSES, type GoldenItem } from "@/lib/schemas/golden";
import { GoldenRunHeaderSchema, GoldenRunItemSchema, GRADER_CRITERIA, type GoldenRunItem } from "@/lib/schemas/goldenRun";
import { LabelSchema, type Label } from "@/lib/schemas/labels";
import { CRITERIA, GROUNDED_FLOOR as GRADER_FLOOR } from "@/workers/agents/grader/grade";

import { formatGateReport, gateVerdict } from "./common";
import {
  answerRecordComplete,
  cacheVisible,
  CITATION_FLOOR,
  citationCriterion,
  citationRate,
  cohenKappa,
  criterionKappa,
  FIRST_TOKEN_MS,
  flagCheckOf,
  flagCriterion,
  GROUNDED_FLOOR,
  groundedPairs,
  kappaCriterion,
  KAPPA_FLOOR,
  KAPPA_MIN_PAIRS,
  KAPPA_RETIRE,
  LABELS_MIN,
  latencyCriterion,
  ledgerCheckOf,
  ledgerCriterion,
  P2_TEXT,
  phase2Criteria,
  phase2Report,
  pickRefusalItems,
  prefixCriterion,
  prefixStable,
  REFUSAL_CAUSES_GATED,
  refusalCheckOf,
  refusalCriterion,
  retentionCheckOf,
  retentionCriterion,
  substitutionCheckOf,
  substitutionCriterion,
  walkCriterion,
  type GoldenRun,
  type LedgerRow,
  type Phase2Facts,
  type Phase2Report,
  type RefusalCheck,
  type RetentionSnapshot,
  type SubstitutionCheck,
} from "./phase2";

/*
 * The Phase 2 gate's pure rules (feature-specs/22 § 3, § 5, § 10.1). The numbers a criterion passes at are the
 * overview's and the architecture's; the κ example is the book's own (chapter 12's worked example).
 */

const HASH = "a".repeat(64);
const REAL_FILE = "golden-run-2026.09-real.jsonl";
const OTHER_HASH = "b".repeat(64);

function item(n: number, overrides: Partial<GoldenRunItem> = {}): GoldenRunItem {
  return GoldenRunItemSchema.parse({
    id: `G-${String(n).padStart(4, "0")}`,
    kind: "figure",
    mode: "explain",
    language: "en",
    outcome: "answer",
    refusalCause: null,
    code: null,
    messageId: `m-${String(n)}`,
    traceId: n.toString(16).padStart(32, "0"),
    citedSections: ["21.3"],
    citedFigures: ["F-21-07"],
    expectedHit: true,
    claims: { total: 3, notFound: 0, substituted: 0 },
    verdicts: [{ sensor: "citation", verdict: "PASS" }],
    grounded: 1,
    graderCriteria: { supported: true, precise: true, complete: true, in_scope: true },
    prefixSha256: HASH,
    firstTokenMs: 900,
    totalMs: 4000,
    frontier: [
      { kind: "assistant", cacheRead: 1200 },
      { kind: "grading", cacheRead: 800 },
    ],
    smallCalls: 1,
    costUsd: 0.2,
    ledgerSeq: n,
    ...overrides,
  });
}

function label(n: number, overrides: Partial<Label> = {}): Label {
  return LabelSchema.parse({
    goldenId: `G-${String(n).padStart(4, "0")}`,
    runFile: "golden-run-2026.09-real.jsonl",
    messageId: `m-${String(n)}`,
    grounded: true,
    criteria: { supported: true, precise: true, complete: true, in_scope: true },
    labeller: "andre",
    labelledAt: "2026-10-04T12:00:00.000Z",
    ...overrides,
  });
}

/** An uncited claim replaced as the criterion wants it: the sentence only in final and in the row, the claim in neither. */
const REPLACED: SubstitutionCheck = { tokensHeldSentence: false, tokensHeldClaim: false, finalSubstituted: 1, finalHoldsClaim: false, storedHoldsSentence: true, storedHoldsClaim: false };

const run = (items: ReadonlyArray<GoldenRunItem>, overrides: Partial<GoldenRun> = {}): GoldenRun => ({ grade: "real", file: REAL_FILE, items, partial: false, ...overrides });
const range = (count: number, from = 1) => Array.from({ length: count }, (_, index) => from + index);
/** `count` pairs of one kind. */
const pairs = (count: number, a: boolean, b: boolean) => Array.from({ length: count }, () => [a, b] as const);

describe("the thresholds", () => {
  it("are the overview's and the architecture's, and the same numbers the alerts and the grader use", () => {
    expect([CITATION_FLOOR, KAPPA_FLOOR, KAPPA_RETIRE, LABELS_MIN, KAPPA_MIN_PAIRS, FIRST_TOKEN_MS, GROUNDED_FLOOR]).toEqual([0.9, 0.7, 0.6, 100, 20, 2000, 0.7]);
    expect(CITATION_FLOOR).toBe(CITATION_RATE_FLOOR);
    expect(FIRST_TOKEN_MS).toBe(FIRST_TOKEN_P95_MS);
    expect(GROUNDED_FLOOR).toBe(GRADER_FLOOR);
    expect([...GRADER_CRITERIA]).toEqual([...CRITERIA]);
    expect([...REFUSAL_CAUSES_GATED].sort()).toEqual([...REFUSAL_CAUSES].sort());
  });

  it("word ten criteria for the overview's seven promises", () => {
    expect(Object.keys(P2_TEXT)).toEqual(["P2.1a", "P2.1b", "P2.2", "P2.3", "P2.4", "P2.5a", "P2.5b", "P2.6a", "P2.6b", "P2.7"]);
  });
});

describe("the run file's lines", () => {
  it("are read by a strict schema: a line with a field the gate does not know is not a line of a run", () => {
    expect(GoldenRunItemSchema.safeParse({ ...item(1), question: "Why?" }).success).toBe(false);
    expect(GoldenRunItemSchema.safeParse({ ...item(1), claims: { total: 3, notFound: -1, substituted: 0 } }).success).toBe(false);
    expect(GoldenRunHeaderSchema.parse({ run: "golden", release: "2026.09", grade: "stub", startedAt: "2026-10-04T12:00:00.000Z", userId: "u-gate", partial: false }).grade).toBe("stub");
    expect(LabelSchema.safeParse({ ...label(1), runFile: "../elsewhere.jsonl" }).success).toBe(false);
    expect(LabelSchema.safeParse({ ...label(1), labeller: "the grader" }).success).toBe(false);
  });
});

describe("citationRate", () => {
  it("counts an answer when every claim was found and none replaced, over the non-refusal items", () => {
    const items = [
      item(1),
      item(2, { claims: { total: 3, notFound: 0, substituted: 1 } }),
      item(3, { claims: { total: 3, notFound: 1, substituted: 0 } }),
      item(4, { outcome: "refusal", refusalCause: "R-SCOPE", expectedHit: false }),
      item(5, { outcome: "failed", code: "ASSISTANT_UNAVAILABLE", messageId: null }),
      item(6, { kind: "refusal", outcome: "refusal", refusalCause: "R-SCOPE-OT", expectedHit: true }),
      item(7, { kind: "refusal", outcome: "refusal", refusalCause: "R-SCOPE", expectedHit: false }),
      item(8, { kind: "refusal", outcome: "answer", expectedHit: false }),
    ];
    expect(citationRate(items)).toEqual({ items: 5, cited: 1, rate: 0.2, refusals: { items: 3, correct: 1 } });
    expect(citationRate([])).toEqual({ items: 0, cited: 0, rate: null, refusals: { items: 0, correct: 0 } });
  });

  it("passes at 90 % of the 250 and not one answer below", () => {
    const at = (citedCount: number) => run([...range(citedCount).map((n) => item(n)), ...range(250 - citedCount, citedCount + 1).map((n) => item(n, { claims: { total: 2, notFound: 0, substituted: 1 } })), ...range(50, 251).map((n) => item(n, { kind: "refusal", outcome: "refusal", refusalCause: "R-SCOPE", expectedHit: true }))]);
    expect(citationCriterion(at(225), null)).toMatchObject({ id: "P2.1a", status: "pass", measured: "225/250 · 90.0 %" });
    expect(citationCriterion(at(224), null)).toMatchObject({ status: "fail", measured: "224/250 · 89.6 %" });
    expect(citationCriterion(at(225), null).note).toContain("refusal items with the expected cause 50/50");
  });

  it("is blocked without a real run, with the stub's numbers beside it as shape only", () => {
    const stub = run([item(1), item(2)], { grade: "stub", file: "golden-run-2026.09-stub.jsonl" });
    const blocked = citationCriterion(null, stub);
    expect(blocked).toMatchObject({ status: "blocked", measured: "not measured" });
    expect(blocked.note).toContain("Needs a whole run of the golden set through the provider");
    expect(blocked.note).toContain("the stub run is shape only: 2/2 cited");
    expect(citationCriterion(null, null).note).toContain("no stub run either");
  });

  it("fails a run that stopped early, whatever its rate so far", () => {
    const partial = citationCriterion(run(range(40).map((n) => item(n)), { partial: true }), null);
    expect(partial).toMatchObject({ status: "fail", measured: "40/40 · 100.0 %" });
    expect(partial.note).toContain("stopped before the last item (40 answered)");
  });
});

describe("cohenKappa", () => {
  it("is 1 on perfect agreement and 0 on agreement no better than chance", () => {
    expect(cohenKappa([...pairs(10, true, true), ...pairs(10, false, false)])).toBe(1);
    expect(cohenKappa([...pairs(5, true, true), ...pairs(5, true, false), ...pairs(5, false, true), ...pairs(5, false, false)])).toBe(0);
    expect(cohenKappa(pairs(20, true, true))).toBe(1);
  });

  it("gives the book's own worked example: agreement 0.85, chance 0.53, κ 0.68 (chapter 12)", () => {
    /* Marginals 0.60 and 0.65 of a hundred: 55 both yes, 5 and 10 apart, 30 both no. */
    const example = [...pairs(55, true, true), ...pairs(5, true, false), ...pairs(10, false, true), ...pairs(30, false, false)];
    expect(cohenKappa(example)).toBeCloseTo((0.85 - 0.53) / (1 - 0.53), 12);
    expect(cohenKappa(example)?.toFixed(2)).toBe("0.68");
  });

  it("is negative when two readers disagree more than chance would have them, and says nothing under twenty pairs", () => {
    expect(cohenKappa([...pairs(10, true, false), ...pairs(10, false, true)])).toBe(-1);
    expect(cohenKappa(pairs(19, true, true))).toBeUndefined();
    expect(cohenKappa([])).toBeUndefined();
  });
});

describe("the grader against the labels", () => {
  const items = [...range(60).map((n) => item(n, { grounded: 1 })), ...range(60, 61).map((n) => item(n, { grounded: 0.5, graderCriteria: { supported: false, precise: true, complete: false, in_scope: true } }))];

  it("pairs the grader's verdict at its own floor with the label, by the answer the label names", () => {
    const labels = [label(1), label(61, { grounded: false }), label(999), label(2, { messageId: "m-of-another-run" })];
    expect(groundedPairs(labels, items)).toEqual([
      [true, true],
      [false, false],
    ]);
    /* 0.75 is grounded, 0.5 is not: three of four criteria is the floor in practice. */
    expect(groundedPairs([label(1)], [item(1, { grounded: 0.75 })])).toEqual([[true, true]]);
    expect(groundedPairs([label(1)], [item(1, { grounded: null, graderCriteria: null })])).toEqual([]);
  });

  it("is blocked under a hundred labels and says how many there are", () => {
    const ninetyNine = kappaCriterion(range(99).map((n) => label(n, { grounded: n <= 60 })), items);
    expect(ninetyNine).toMatchObject({ id: "P2.1b", status: "blocked", measured: "99 of 100 labels" });
    expect(ninetyNine.note).toContain("npm run gate:show");
    expect(kappaCriterion([], items).measured).toBe("0 of 100 labels");
    const strays = kappaCriterion([...range(50).map((n) => label(n)), label(500), label(501)], items);
    expect(strays.measured).toBe("50 of 100 labels");
    expect(strays.note).toContain("2 label(s) name an answer that is not in the run or was not graded");
  });

  it("passes on a hundred and twenty labels the grader agrees with, with κ per criterion beside it", () => {
    const labels = range(120).map((n) => label(n, n <= 60 ? {} : { grounded: false, criteria: { supported: false, precise: true, complete: false, in_scope: true } }));
    const passed = kappaCriterion(labels, items);
    expect(passed).toMatchObject({ status: "pass", measured: "κ 1.00 on 120" });
    expect(passed.note).toContain("supported 1.00 · precise 1.00 · complete 1.00 · in_scope 1.00");
    expect(criterionKappa(labels, items)).toEqual({ supported: 1, precise: 1, complete: 1, in_scope: 1 });
  });

  it("fails below 0.7 and names a criterion below 0.6 as due to be retired", () => {
    /* The curator calls 30 of the grader's 60 grounded answers ungrounded, and disagrees on `complete` throughout. */
    const labels = range(120).map((n) =>
      label(n, n <= 30 ? { criteria: { supported: true, precise: true, complete: false, in_scope: true } } : n <= 60 ? { grounded: false, criteria: { supported: true, precise: true, complete: false, in_scope: true } } : { grounded: false, criteria: { supported: false, precise: true, complete: true, in_scope: true } }),
    );
    const failed = kappaCriterion(labels, items);
    expect(failed.status).toBe("fail");
    expect(failed.measured).toBe("κ 0.50 on 120");
    expect(failed.note).toContain("due to be retired from the grader: complete");
    expect(criterionKappa(labels, items).complete).toBe(-1);
  });
});

describe("first token", () => {
  it("takes the nearest-rank p95 over the answered items of the real run, and passes under two seconds", () => {
    const fast = run(range(100).map((n) => item(n, { firstTokenMs: n <= 95 ? 1500 : 1990 })));
    expect(latencyCriterion(fast, null)).toMatchObject({ id: "P2.5a", status: "pass", measured: "p95 1,500 ms" });
    const slow = run(range(100).map((n) => item(n, { firstTokenMs: n <= 94 ? 1500 : 2000 })));
    expect(latencyCriterion(slow, null)).toMatchObject({ status: "fail", measured: "p95 2,000 ms" });
  });

  it("leaves out what did not stream, is blocked without a real run, and fails a run with no first token at all", () => {
    const mixed = run([item(1, { firstTokenMs: 800 }), item(2, { outcome: "refusal", refusalCause: "R-SCOPE", firstTokenMs: null }), item(3, { firstTokenMs: null })]);
    expect(latencyCriterion(mixed, null)).toMatchObject({ status: "pass", measured: "p95 800 ms" });
    expect(latencyCriterion(mixed, null).note).toContain("over 1 answered items");
    expect(latencyCriterion(null, run([item(1)], { grade: "stub" }))).toMatchObject({ status: "blocked" });
    expect(latencyCriterion(run([item(1, { firstTokenMs: null })]), null).status).toBe("fail");
  });
});

describe("the prefix and the cache", () => {
  it("calls a prefix stable on equal hashes and not on one that differs", () => {
    expect(prefixStable([HASH, HASH, HASH])).toEqual({ stable: true, distinct: 1 });
    expect(prefixStable([HASH, OTHER_HASH, HASH])).toEqual({ stable: false, distinct: 2 });
    expect(prefixStable([])).toEqual({ stable: false, distinct: 0 });
  });

  it("holds one prefix for every mode, because the mode's line sits after the cache breakpoint", () => {
    const first = item(1, { frontier: [{ kind: "assistant", cacheRead: 0 }, { kind: "grading", cacheRead: 0 }] });
    const mixed = run([first, item(2, { mode: "compare" }), item(3, { mode: "lab" }), item(4, { outcome: "refusal", refusalCause: "R-SCOPE", prefixSha256: OTHER_HASH })]);
    /* A refusal drafts nothing, so its row's guide does not count against the prefix. */
    expect(prefixCriterion(mixed, null)).toMatchObject({ status: "pass" });
    expect(prefixCriterion(mixed, null).note).toContain("one prefix (aaaaaaaaaaaa…) over 3 answers");
  });

  it("forgives the first call of each kind and no call after it", () => {
    expect(cacheVisible([{ kind: "assistant", cacheRead: 0 }, { kind: "grading", cacheRead: 0 }, { kind: "assistant", cacheRead: 1200 }, { kind: "grading", cacheRead: 800 }])).toEqual({ calls: 4, later: 2, misses: 0 });
    expect(cacheVisible([{ kind: "assistant", cacheRead: 0 }, { kind: "assistant", cacheRead: 0 }, { kind: "assistant", cacheRead: 900 }])).toEqual({ calls: 3, later: 2, misses: 1 });
    expect(cacheVisible([])).toEqual({ calls: 0, later: 0, misses: 0 });
  });

  it("passes when every mode keeps one prefix and every later call read the cache; fails on either, and is blocked on the stub", () => {
    const first = item(1, { frontier: [{ kind: "assistant", cacheRead: 0 }, { kind: "grading", cacheRead: 0 }] });
    expect(prefixCriterion(run([first, item(2), item(3)]), null)).toMatchObject({ id: "P2.5b", status: "pass", measured: "prefix stable · cache read on 4/4 later calls" });
    expect(prefixCriterion(run([first, item(2, { prefixSha256: OTHER_HASH })]), null)).toMatchObject({ status: "fail", measured: "prefix changed · cache read on 2/2 later calls" });
    expect(prefixCriterion(run([first, item(2, { frontier: [{ kind: "assistant", cacheRead: 0 }] })]), null)).toMatchObject({ status: "fail", measured: "prefix stable · cache read on 0/1 later calls" });
    /* One answer alone shows no later call: there is nothing to see the cache in. */
    expect(prefixCriterion(run([first]), null).status).toBe("fail");
    const blocked = prefixCriterion(null, run([item(1), item(2)], { grade: "stub" }));
    expect(blocked.status).toBe("blocked");
    expect(blocked.note).toContain("the stub shows the hash and its own pretend cache, not a provider's: one prefix (aaaaaaaaaaaa…) over 2 answers");
  });
});

describe("the criteria measured on the running system", () => {
  const refused = (cause: string, overrides: Partial<RefusalCheck> = {}): RefusalCheck => ({ cause, refusedWith: cause, beforeRetrieval: true, code: cause, pointers: 1, frontierCalls: 0, smallCalls: 0, ledger: "verified", ...overrides });

  it("passes the refusals when all four refuse before retrieval, with a code, no frontier call and a verified record", () => {
    const all = [refused("R-SCOPE", { pointers: 0, smallCalls: 1 }), refused("R-SCOPE-OT"), refused("R-RECOMPUTE"), refused("R-UNVERIFIED", { pointers: 0 })];
    const passed = refusalCriterion(all);
    expect(passed).toMatchObject({ id: "P2.2", status: "pass", measured: "4/4 causes" });
    /* The classifier's one small call is the cost of the cause it names: allowed, and said. */
    expect(passed.note).toContain("Calls on the small alias, the classifier's and allowed: R-SCOPE 1");
  });

  it("fails the refusals naming what each cause lacked, a cause never asked included", () => {
    const failed = refusalCriterion([refused("R-SCOPE", { refusedWith: null }), refused("R-SCOPE-OT", { pointers: 0, frontierCalls: 1 }), refused("R-RECOMPUTE", { beforeRetrieval: false, ledger: "missing", code: null })]);
    expect(failed).toMatchObject({ status: "fail", measured: "0/4 causes" });
    expect(failed.note).toContain("R-SCOPE: did not refuse");
    expect(failed.note).toContain("R-SCOPE-OT: no pointer, 1 frontier call(s)");
    expect(failed.note).toContain("R-RECOMPUTE: after retrieval, no code, ledger record missing");
    expect(failed.note).toContain("R-UNVERIFIED: not asked");
  });

  it("passes the substitution only when no token carried the sentence or the claim and final and the row do", () => {
    expect(substitutionCriterion(REPLACED)).toMatchObject({ id: "P2.3", status: "pass", measured: "1 claim(s) replaced in final · the sentence only after final" });
    expect(substitutionCriterion({ ...REPLACED, tokensHeldSentence: true })).toMatchObject({ status: "fail", measured: "1 claim(s) replaced in final · the sentence streamed before final" });
    expect(substitutionCriterion({ ...REPLACED, finalSubstituted: 0, storedHoldsSentence: false }).note).toBe("final marks no claim as substituted; the stored text does not hold the sentence. The claim's own words did not stream either.");
    expect(substitutionCriterion({ ...REPLACED, finalHoldsClaim: true, storedHoldsClaim: true }).note).toContain("final still carries the uncited claim; the stored text holds the uncited claim");
    /* The draft streams as it is written and is replaced on final (architecture § 6.4): the claim's own words going by
       are said in the note and are not the defect. The sentence before final would be. */
    const streamed = substitutionCriterion({ ...REPLACED, tokensHeldClaim: true });
    expect(streamed.status).toBe("pass");
    expect(streamed.note).toContain("The draft's own words for that claim did stream, as the pending text the client replaces on final");
  });

  it("passes the walk on the script's own figure, line and date, and names what differs", () => {
    const walk = { exitCode: 0, headline: "3.4×", expectedHeadline: "3.4×", line: 24, expectedLine: 24, pricesVerifiedAt: "2026-09-12", derive: "derive output matched · 3 of 3", valuesEqualRelease: true };
    expect(walkCriterion(walk)).toMatchObject({ id: "P2.4", status: "pass", measured: "3.4× · ƒ L24 · prices verified 2026-09-12" });
    const off = walkCriterion({ ...walk, headline: "13×", line: 142, derive: "derive output matched · 2 of 3", pricesVerifiedAt: null });
    expect(off.status).toBe("fail");
    expect(off.note).toBe("headline 13×, the script gives 3.4×; derive line 142, the step declares 24; no verification date for the prices; derive sensor: derive output matched · 2 of 3.");
    expect(walkCriterion({ ...walk, exitCode: 1, valuesEqualRelease: false }).note).toContain("the script exited 1");
  });

  it("passes the flag, the retention and the ledger on their facts, and fails each with its reason", () => {
    expect(flagCriterion({ flagged: true, inCalibration: true, carries: { verdicts: true, grounded: true, reason: true }, score: 0.75 })).toMatchObject({ id: "P2.6a", status: "pass" });
    expect(flagCriterion({ flagged: true, inCalibration: true, carries: { verdicts: true, grounded: false, reason: false }, score: 0.75 }).note).toBe("The calibration row lacks: grounded, reason.");
    expect(flagCriterion({ flagged: true, inCalibration: false, carries: { verdicts: false, grounded: false, reason: false }, score: null })).toMatchObject({ status: "fail", measured: "not in the calibration set" });

    const kept = { textNull: true, claimTextNull: true, textPurgedAt: true, citations: { before: 4, after: 4 }, verdicts: { before: 5, after: 5 }, ledgerUnchanged: true };
    expect(retentionCriterion(kept)).toMatchObject({ id: "P2.6b", status: "pass", measured: "text null · 4 citations · 5 verdicts" });
    expect(retentionCriterion({ ...kept, textNull: false, citations: { before: 4, after: 0 } }).note).toBe("message text remains; citations 4 → 0.");

    expect(ledgerCriterion({ file: REAL_FILE, answers: 300, recorded: 300, complete: 300, chain: { ok: true, records: 1312, brokenAt: null } })).toMatchObject({ id: "P2.7", status: "pass", measured: "300/300 records complete · chain ok · 1,312 records" });
    expect(ledgerCriterion({ file: REAL_FILE, answers: 300, recorded: 298, complete: 297, chain: { ok: false, records: 1312, brokenAt: 77 } })).toMatchObject({ status: "fail", measured: "297/300 records complete · chain broken at 77 · 1,312 records" });
    expect(ledgerCriterion({ file: REAL_FILE, answers: 0, recorded: 0, complete: 0, chain: { ok: true, records: 10, brokenAt: null } }).status).toBe("fail");
    expect(ledgerCriterion({ file: REAL_FILE, answers: 3, recorded: 3, complete: 3, chain: { ok: true, records: 10, brokenAt: null } }).note).toContain(`Every answer of ${REAL_FILE} has an ANSWER record`);
  });

  it("reports what it could not measure as blocked or deferred, with the reason it was given, and never as a pass", () => {
    expect(walkCriterion({ blocked: "Docker is not running: the walk's script runs in the lab tier's container." })).toMatchObject({ id: "P2.4", status: "blocked", measured: "not measured", note: "Docker is not running: the walk's script runs in the lab tier's container." });
    expect(refusalCriterion({ deferred: "Unit 31 measures this." })).toMatchObject({ id: "P2.2", status: "deferred" });
    for (const build of [substitutionCriterion, flagCriterion, retentionCriterion, ledgerCriterion]) expect(build({ blocked: "x" }).status).toBe("blocked");
  });
});

describe("the report", () => {
  it("is met only when all ten pass, and prints as Phase 1's does", () => {
    const stub = run([item(1), item(2)], { grade: "stub", file: "golden-run-2026.09-stub.jsonl" });
    const criteria = [
      citationCriterion(null, stub),
      kappaCriterion([], stub.items),
      refusalCriterion({ deferred: "measured by the script" }),
      latencyCriterion(null, stub),
      prefixCriterion(null, stub),
    ];
    const report: Phase2Report = { phase: 2, release: "2026.09", appUrl: "http://localhost:3000", gateway: "stub", run: { file: stub.file, items: 2, cost_usd: 0 }, criteria, met: gateVerdict(criteria).met, startedAt: "2026-10-04T12:00:00.000Z", finishedAt: "2026-10-04T12:01:00.000Z" };
    const text = formatGateReport(report);
    expect(report.met).toBe(false);
    expect(text.split("\n")[0]).toBe("Phase 2 gate · release 2026.09 · http://localhost:3000 · 2026-10-04T12:01:00.000Z");
    expect(text).toContain("◧ blocked  P2.1a  On the golden set, at least 90% of answers");
    expect(text).toContain("             measured: 0 of 100 labels");
    expect(text.trim().endsWith("GATE NOT MET · 0 pass · 0 fail · 4 blocked · 1 deferred")).toBe(true);
  });
});

/* The gate as a whole (feature-specs/22 § 6, unit 36c): the record P2.7 looks for, and the report the script writes. */

const MESSAGE = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** An `ANSWER` record's payload as `lib/schemas/ledger.ts` writes one. */
function answerRow(n: number, overrides: Record<string, unknown> = {}, kind = "ANSWER"): LedgerRow {
  return {
    seq: n,
    kind,
    payload: {
      messageId: MESSAGE(n),
      conversationId: MESSAGE(9000 + n),
      releaseId: "2026.09",
      mode: "explain",
      refusal: null,
      citations: [{ sectionId: "21.3", figureId: "F-21-07", version: "v1.0.0", editionLang: "EN" }],
      claims: { total: 3, substituted: 0 },
      verdicts: [{ sensor: "citation", verdict: "PASS" }],
      grounded: 1,
      repaired: false,
      guide: { version: "v1.12", sha256: HASH },
      modelId: "claude-opus-5",
      promptSha256: HASH,
      questionSha256: HASH,
      answerSha256: HASH,
      timings: { firstTokenMs: 900, totalMs: 4000 },
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
      traceId: n.toString(16).padStart(32, "0"),
      ...overrides,
    },
  };
}

const answered = (n: number, overrides: Partial<GoldenRunItem> = {}) => item(n, { messageId: MESSAGE(n), ...overrides });

describe("the ledger record of an answer (P2.7)", () => {
  it("is complete when it is this answer's ANSWER record and reads under the payload's schema", () => {
    expect(answerRecordComplete(answered(1), answerRow(1))).toBe(true);
  });

  it("is not when it is another kind, another answer's, a refusal's, or lacks what the criterion names", () => {
    expect(answerRecordComplete(answered(1), answerRow(1, {}, "EXPORT"))).toBe(false);
    expect(answerRecordComplete(answered(1), answerRow(1, { messageId: MESSAGE(2) }))).toBe(false);
    expect(answerRecordComplete(answered(1), answerRow(1, { refusal: { cause: "R-SCOPE", beforeRetrieval: true } }))).toBe(false);
    expect(answerRecordComplete(answered(1), answerRow(1, { verdicts: [] }))).toBe(false);
    expect(answerRecordComplete(answered(1), answerRow(1, { modelId: "" }))).toBe(false);
    /* A payload without its guide does not read under the schema at all. */
    expect(answerRecordComplete(answered(1), answerRow(1, { guide: undefined }))).toBe(false);
    expect(answerRecordComplete(answered(1), { seq: 1, kind: "ANSWER", payload: null })).toBe(false);
  });

  it("wants citations in the record whenever the answer cited, and none when it cited nothing", () => {
    expect(answerRecordComplete(answered(1), answerRow(1, { citations: [] }))).toBe(false);
    expect(answerRecordComplete(answered(1, { citedSections: [], citedFigures: [] }), answerRow(1, { citations: [] }))).toBe(true);
  });

  it("counts the run's answers, the ones with a record and the complete ones, and carries the chain's first break", () => {
    const items = [answered(1), answered(2), answered(3), answered(4, { ledgerSeq: null }), item(5, { kind: "refusal", outcome: "refusal", refusalCause: "R-SCOPE", ledgerSeq: 5 })];
    const rows = [answerRow(1), answerRow(2, { verdicts: [] }), answerRow(3, {}, "EXPORT"), answerRow(5)];
    expect(ledgerCheckOf({ file: REAL_FILE, items }, rows, { ok: true, records: 40, firstBreak: null })).toEqual({ file: REAL_FILE, answers: 4, recorded: 2, complete: 1, chain: { ok: true, records: 40, brokenAt: null } });
    expect(ledgerCheckOf({ file: REAL_FILE, items }, rows, { ok: false, records: 40, firstBreak: { seq: 17 } }).chain).toEqual({ ok: false, records: 40, brokenAt: 17 });
    expect(ledgerCriterion(ledgerCheckOf({ file: REAL_FILE, items }, rows, { ok: true, records: 40, firstBreak: null }))).toMatchObject({ status: "fail", measured: "1/4 records complete · chain ok · 40 records" });
  });
});

describe("the gate's report, assembled", () => {
  const DEFERRED = { deferred: "a later unit" };
  const unmeasured: Phase2Facts = { refusals: DEFERRED, substitution: DEFERRED, walk: DEFERRED, flag: DEFERRED, retention: DEFERRED, ledger: DEFERRED };
  const passing: Phase2Facts = {
    refusals: REFUSAL_CAUSES_GATED.map((cause) => ({ cause, refusedWith: cause, beforeRetrieval: true, code: cause, pointers: 1, frontierCalls: 0, smallCalls: cause === "R-SCOPE" ? 1 : 0, ledger: "verified" as const })),
    substitution: REPLACED,
    walk: { exitCode: 0, headline: "3.4×", expectedHeadline: "3.4×", line: 24, expectedLine: 24, pricesVerifiedAt: "2026-09-01", derive: "derive output matched · 3 of 3", valuesEqualRelease: true },
    flag: { flagged: true, inCalibration: true, carries: { verdicts: true, grounded: true, reason: true }, score: 0.75 },
    retention: { textNull: true, claimTextNull: true, textPurgedAt: true, citations: { before: 4, after: 4 }, verdicts: { before: 5, after: 5 }, ledgerUnchanged: true },
    ledger: { file: REAL_FILE, answers: 250, recorded: 250, complete: 250, chain: { ok: true, records: 900, brokenAt: null } },
  };
  const whole = run(range(250).map((n) => item(n)));
  const labels = range(120).map((n) => label(n));
  const base = { release: "2026.09", appUrl: "http://localhost:3000", startedAt: "2026-10-04T12:00:00.000Z", finishedAt: "2026-10-04T12:00:05.000Z" };

  it("lists the ten criteria in the overview's order", () => {
    expect(phase2Criteria({ real: null, stub: null, labels: [], facts: unmeasured }).map((entry) => entry.id)).toEqual(Object.keys(P2_TEXT));
  });

  it("is met when every one of the ten passes on its own evidence, and names the run it read and what it was charged", () => {
    const report: Phase2Report = phase2Report({ ...base, real: whole, stub: null, labels, facts: passing });
    expect(report.criteria.map((entry) => `${entry.id} ${entry.status}`)).toEqual(Object.keys(P2_TEXT).map((id) => `${id} pass`));
    expect(report).toMatchObject({ phase: 2, release: "2026.09", met: true, gateway: "real", run: { file: REAL_FILE, items: 250 } });
    expect(report.run?.cost_usd).toBeCloseTo(50, 6);
    expect(formatGateReport(report)).toContain("GATE MET · 10 pass · 0 fail · 0 blocked · 0 deferred");
  });

  it("is not met by a stub run: its criteria are blocked, its cost is nothing, and the report says which gateway answered", () => {
    const stub = run(range(4).map((n) => item(n)), { grade: "stub", file: "golden-run-2026.09-stub.jsonl" });
    const report = phase2Report({ ...base, real: null, stub, labels: [], facts: { ...passing, ledger: { ...(passing.ledger as object), file: stub.file } as Phase2Facts["ledger"] } });
    expect(report).toMatchObject({ met: false, gateway: "stub", run: { file: "golden-run-2026.09-stub.jsonl", items: 4, cost_usd: 0 } });
    expect(Object.fromEntries(report.criteria.map((entry) => [entry.id, entry.status]))).toMatchObject({ "P2.1a": "blocked", "P2.1b": "blocked", "P2.5a": "blocked", "P2.5b": "blocked", "P2.2": "pass", "P2.7": "pass" });
    expect(gateVerdict(report.criteria).counts).toEqual({ pass: 6, fail: 0, blocked: 4, deferred: 0 });
  });

  it("has no run to name when none was made, and one failing criterion is enough to leave the gate unmet", () => {
    expect(phase2Report({ ...base, real: null, stub: null, labels: [], facts: unmeasured })).toMatchObject({ met: false, gateway: "stub", run: null });
    const slow = run(range(250).map((n) => item(n, { firstTokenMs: 2600 })));
    const report = phase2Report({ ...base, real: slow, stub: null, labels, facts: passing });
    expect(report.met).toBe(false);
    expect(report.criteria.filter((entry) => entry.status !== "pass").map((entry) => entry.id)).toEqual(["P2.5a"]);
  });

  it("says so in the note when the real run it measured stopped early", () => {
    const stopped = run(range(40).map((n) => item(n)), { partial: true });
    const report = phase2Report({ ...base, real: stopped, stub: null, labels: [], facts: unmeasured });
    const of = (id: string) => report.criteria.find((entry) => entry.id === id);
    expect(of("P2.1a")?.status).toBe("fail");
    expect(of("P2.5a")?.note).toContain("The run stopped before the last item.");
    expect(of("P2.5b")?.note).toContain("The run stopped before the last item.");
  });
});

/* The gate's own turns (feature-specs/22 § 3, unit 36c-2): what a turn's `final` event, its gateway calls and its rows amount to. */

describe("the facts of the gate's own turns", () => {
  const SENTENCE = "the book does not cover this";
  const CLAIM = "Quokkas yodel zestfully.";

  function refusalItem(n: number, cause: (typeof REFUSAL_CAUSES)[number], chapter: number): GoldenItem {
    return GoldenItemSchema.parse({
      id: `G-${String(n).padStart(4, "0")}`,
      kind: "refusal",
      mode: "explain",
      language: "en",
      context: { chapter, section: null },
      question: `a question that refuses as ${cause}`,
      expected: { citations: [], chapters: [], sourceRowId: null, valueText: null, refusal: { cause } },
      generator: { template: "refusal", release: "2026.09" },
    });
  }

  it("asks each cause from a context that can produce it: an unverified chapter for R-UNVERIFIED, a verified one for the rest", () => {
    const verified = new Set([21, 26]);
    const items = [refusalItem(1, "R-SCOPE", 35), refusalItem(2, "R-SCOPE", 21), refusalItem(3, "R-SCOPE-OT", 26), refusalItem(4, "R-UNVERIFIED", 21), refusalItem(5, "R-UNVERIFIED", 37), refusalItem(6, "R-RECOMPUTE", 37)];
    const picked = pickRefusalItems(items, verified);
    expect([...picked].map(([cause, picked_]) => `${cause} ${picked_.id}`)).toEqual(["R-SCOPE G-0002", "R-SCOPE-OT G-0003", "R-UNVERIFIED G-0005"]);
    /* No question for a cause in a context that can produce it: the cause is left out, and the criterion says it was not asked. */
    expect(picked.has("R-RECOMPUTE")).toBe(false);
    expect(refusalCriterion([]).note).toContain("R-RECOMPUTE: not asked");
  });

  const refusalFinal = (cause: string, overrides: Partial<{ code: string; pointers: ReadonlyArray<unknown>; beforeRetrieval: boolean }> = {}) => ({
    messageId: MESSAGE(1),
    refusal: { cause, code: cause, pointers: [{ sectionId: "21.3", title: "Worked numbers" }], beforeRetrieval: true, ...overrides },
    claims: [],
    ledger: { seq: 1, hash: HASH },
  });
  const refusalRecord = (cause: string, overrides: Record<string, unknown> = {}, hashes: { hash?: string; rehashed?: string } = {}) => ({
    row: answerRow(1, { refusal: { cause, beforeRetrieval: true }, citations: [], verdicts: [], ...overrides }),
    hash: hashes.hash ?? HASH,
    rehashed: hashes.rehashed ?? HASH,
  });

  it("reads a refusal's cause, code, pointers and calls, and verifies the record final names", () => {
    const check = refusalCheckOf("R-SCOPE", refusalFinal("R-SCOPE"), [{ alias: "hb-small" }], refusalRecord("R-SCOPE"));
    expect(check).toEqual({ cause: "R-SCOPE", refusedWith: "R-SCOPE", beforeRetrieval: true, code: "R-SCOPE", pointers: 1, frontierCalls: 0, smallCalls: 1, ledger: "verified" });
    /* Embedding and re-ranking calls are neither alias: only a frontier call breaks the criterion. */
    expect(refusalCheckOf("R-SCOPE-OT", refusalFinal("R-SCOPE-OT"), [{ alias: "hb-embed" }, { alias: "hb-frontier" }], refusalRecord("R-SCOPE-OT"))).toMatchObject({ frontierCalls: 1, smallCalls: 0 });
  });

  it("does not verify a record that is missing, another message's, another cause's, or whose hash is not its own", () => {
    const final = refusalFinal("R-RECOMPUTE");
    expect(refusalCheckOf("R-RECOMPUTE", final, [], null).ledger).toBe("missing");
    expect(refusalCheckOf("R-RECOMPUTE", final, [], refusalRecord("R-RECOMPUTE", { messageId: MESSAGE(2) })).ledger).toBe("mismatch");
    expect(refusalCheckOf("R-RECOMPUTE", final, [], refusalRecord("R-SCOPE")).ledger).toBe("mismatch");
    expect(refusalCheckOf("R-RECOMPUTE", final, [], refusalRecord("R-RECOMPUTE", { refusal: null })).ledger).toBe("mismatch");
    expect(refusalCheckOf("R-RECOMPUTE", final, [], refusalRecord("R-RECOMPUTE", {}, { rehashed: OTHER_HASH })).ledger).toBe("mismatch");
    expect(refusalCheckOf("R-RECOMPUTE", final, [], refusalRecord("R-RECOMPUTE", {}, { hash: OTHER_HASH, rehashed: OTHER_HASH })).ledger).toBe("mismatch");
    expect(refusalCheckOf("R-RECOMPUTE", final, [], { ...refusalRecord("R-RECOMPUTE"), row: { ...refusalRecord("R-RECOMPUTE").row, kind: "EXPORT" } }).ledger).toBe("mismatch");
  });

  it("says a turn that answered, or ended without a final event, did not refuse", () => {
    const answered_ = { messageId: MESSAGE(1), refusal: null, claims: [{ text: "a claim", substituted: false }], ledger: { seq: 1, hash: HASH } };
    expect(refusalCheckOf("R-SCOPE", answered_, [{ alias: "hb-small" }, { alias: "hb-frontier" }, { alias: "hb-frontier" }], null)).toEqual({ cause: "R-SCOPE", refusedWith: null, beforeRetrieval: false, code: null, pointers: 0, frontierCalls: 2, smallCalls: 1, ledger: "missing" });
    const none = refusalCheckOf("R-SCOPE", null, [], null);
    expect(none).toMatchObject({ refusedWith: null, code: null, ledger: "missing" });
    expect(refusalCriterion([none]).note).toContain("R-SCOPE: did not refuse");
  });

  it("reads the substitution from the joined token stream, the final claims and the stored text", () => {
    const final = { claims: [{ text: "expected work redone: 45% (21.3).", substituted: false }, { text: SENTENCE, substituted: true }] };
    /* The stream is the draft as written: the claim's words are in it, split across deltas, and the sentence is not. */
    const tokens = ['{"claims":[{"text":"expected work redone: 45% (21.3)."},{"text":"Quokkas yo', 'del zestfully."}]}'].join("");
    const check = substitutionCheckOf({ tokens, final, stored: `expected work redone: 45% (21.3). ${SENTENCE}`, sentence: SENTENCE, claim: CLAIM });
    expect(check).toEqual({ tokensHeldSentence: false, tokensHeldClaim: true, finalSubstituted: 1, finalHoldsClaim: false, storedHoldsSentence: true, storedHoldsClaim: false });
    expect(substitutionCriterion(check).status).toBe("pass");
  });

  it("finds the defects: the sentence in the stream, the claim left in final or in the row, a turn without a final", () => {
    const kept = { claims: [{ text: CLAIM, substituted: false }] };
    expect(substitutionCheckOf({ tokens: `… ${SENTENCE} …`, final: kept, stored: CLAIM, sentence: SENTENCE, claim: CLAIM })).toEqual({ tokensHeldSentence: true, tokensHeldClaim: false, finalSubstituted: 0, finalHoldsClaim: true, storedHoldsSentence: false, storedHoldsClaim: true });
    const none = substitutionCheckOf({ tokens: "", final: null, stored: null, sentence: SENTENCE, claim: CLAIM });
    expect(none).toEqual({ tokensHeldSentence: false, tokensHeldClaim: false, finalSubstituted: 0, finalHoldsClaim: false, storedHoldsSentence: false, storedHoldsClaim: false });
    expect(substitutionCriterion(none).status).toBe("fail");
  });
});

/* The rows the gate's own answer leaves (feature-specs/22 § 3, unit 36c-3): the flag in the calibration set, and the purge.
   The cases' names avoid the word, because the suites are run on this machine with every case named for it left out. */

describe("a flagged answer in the calibration set (P2.6a)", () => {
  const answer = { reason: "wrong_citation", grounded: 0.75, verdicts: 5 };

  it("is carried with its verdicts, its score and the reason, each as the answer has it", () => {
    const check = flagCheckOf(true, { reason: "wrong_citation", grounded: 0.75, verdicts: 5 }, answer);
    expect(check).toEqual({ flagged: true, inCalibration: true, carries: { verdicts: true, grounded: true, reason: true }, score: 0.75 });
    expect(flagCriterion(check)).toMatchObject({ status: "pass", measured: "in the calibration set" });
    expect(flagCriterion(check).note).toContain("its score (0.75)");
  });

  it("carries no score for an answer the grader did not grade, and says so rather than failing", () => {
    const ungraded = flagCheckOf(true, { reason: "wrong_citation", grounded: null, verdicts: 5 }, { ...answer, grounded: null });
    expect(ungraded.carries.grounded).toBe(true);
    expect(flagCriterion(ungraded)).toMatchObject({ status: "pass" });
    expect(flagCriterion(ungraded).note).toContain("no score, as the answer has none: the stub's grader gives no verdict");
  });

  it("fails on a row that differs from the answer, a set without the row, and a flag the API did not take", () => {
    expect(flagCheckOf(true, { reason: "other", grounded: 0.5, verdicts: 4 }, answer).carries).toEqual({ verdicts: false, grounded: false, reason: false });
    expect(flagCheckOf(true, { reason: "wrong_citation", grounded: 0.75, verdicts: 0 }, { ...answer, verdicts: 0 }).carries.verdicts).toBe(false);
    const absent = flagCheckOf(true, null, answer);
    expect(absent).toMatchObject({ inCalibration: false, carries: { verdicts: false, grounded: false, reason: false } });
    expect(flagCriterion(absent).note).toBe("The calibration query does not return the flagged answer.");
    expect(flagCriterion(flagCheckOf(false, null, answer)).note).toBe("The flag was not accepted.");
  });
});

describe("a conversation before and after the retention run (P2.6b)", () => {
  const citation = (ordinal: number, claimText: string | null) => ({ ordinal, sectionId: "21.3", figureId: ordinal === 1 ? "F-21-05" : null, version: "v1.0.0", editionLang: "EN", claimText });
  const verdict = (sensor: string, detail = "fixture") => ({ sensor, verdict: "PASS", detail });
  const before: RetentionSnapshot = {
    textPurgedAt: false,
    texts: ["the question", "the answer"],
    citations: [citation(1, "expected work redone: 45% (21.3)."), citation(2, "A second claim.")],
    verdicts: [verdict("citation"), verdict("scope"), verdict("latency")],
    ledger: { hash: HASH, payload: '{"messageId":"m"}' },
  };
  const purged: RetentionSnapshot = { ...before, textPurgedAt: true, texts: [null, null], citations: [citation(1, null), citation(2, null)] };

  it("has lost its words and kept its citations, verdicts and record", () => {
    const check = retentionCheckOf(before, purged);
    expect(check).toEqual({ textNull: true, claimTextNull: true, textPurgedAt: true, citations: { before: 2, after: 2 }, verdicts: { before: 3, after: 3 }, ledgerUnchanged: true });
    expect(retentionCriterion(check)).toMatchObject({ status: "pass", measured: "text null · 2 citations · 3 verdicts" });
  });

  it("counts a citation or a verdict that survived altered as lost, and a record that changed as changed", () => {
    const altered: RetentionSnapshot = { ...purged, citations: [citation(1, null), { ...citation(2, null), sectionId: "21.4" }], verdicts: [verdict("citation"), verdict("scope", "rewritten")], ledger: { hash: OTHER_HASH, payload: '{"messageId":"m"}' } };
    expect(retentionCheckOf(before, altered)).toMatchObject({ citations: { before: 2, after: 1 }, verdicts: { before: 3, after: 1 }, ledgerUnchanged: false });
    expect(retentionCheckOf(before, { ...purged, ledger: null }).ledgerUnchanged).toBe(false);
    expect(retentionCheckOf(before, { ...purged, ledger: { hash: HASH, payload: '{"messageId":"other"}' } }).ledgerUnchanged).toBe(false);
  });

  it("is not satisfied by a run that did nothing, or by a conversation that had no words to lose", () => {
    expect(retentionCheckOf(before, before)).toMatchObject({ textNull: false, claimTextNull: false, textPurgedAt: false });
    expect(retentionCheckOf(before, { ...purged, texts: [null, "the answer"] }).textNull).toBe(false);
    expect(retentionCheckOf(before, { ...purged, citations: [citation(1, null), citation(2, "A second claim.")] }).claimTextNull).toBe(false);
    /* Already empty before: nothing was shown to go, so nothing is claimed. */
    expect(retentionCheckOf(purged, purged)).toMatchObject({ textNull: false, claimTextNull: false, textPurgedAt: false });
  });
});
