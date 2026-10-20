import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { GoldenItemSchema, type GoldenItem, type GoldenItemInput } from "@/lib/schemas/golden";
import { GoldenRunHeaderSchema, type GoldenRunHeader } from "@/lib/schemas/goldenRun";
import type { TurnEventLine } from "@/lib/schemas/workers";

import { contextOf, estimateOf, expectedHit, graderCriteriaOf, newestRun, readRunFile, recordOf, runFileName, runGolden, writeRunFile, type GoldenRunDeps, type LedgerCall } from "./goldenRun";

/*
 * The golden run's own rules (feature-specs/22 § 4, § 7, § 10.2): what a turn's context is, what one line of the
 * run file says of a turn, how the run stops on a budget refusal, and which file the gate reads. The turns here are
 * hand-made event lists; the run against the stub gateway is `npm run gate:golden -- --stub`.
 */

const HASH = "c".repeat(64);
const TRACE = "0".repeat(31);

function golden(n: number, overrides: Partial<GoldenItemInput> = {}): GoldenItem {
  return GoldenItemSchema.parse({
    id: `G-${String(n).padStart(4, "0")}`,
    kind: "figure",
    mode: "explain",
    language: "en",
    context: { chapter: 21, section: "21.3" },
    question: 'In section 21.3, what is the value of "expected work redone"?',
    expected: { citations: [{ sectionId: "21.3", figureId: "F-21-05" }], chapters: [21], sourceRowId: null, valueText: "45%", refusal: null },
    generator: { template: "figure.en", release: "2026.09" },
    ...overrides,
  });
}

const refusalItem = (n: number, cause: "R-SCOPE" | "R-UNVERIFIED") =>
  golden(n, { kind: "refusal", question: "What is the capital of Australia?", expected: { citations: [], chapters: [], sourceRowId: null, valueText: null, refusal: { cause } } });

function final(overrides: Record<string, unknown> = {}): TurnEventLine {
  return {
    event: "final",
    data: {
      messageId: "m-1",
      kind: "answer",
      refusal: null,
      claims: [
        { text: "expected work redone: 45% (21.3).", found: true, substituted: false },
        { text: "the book does not cover this", found: false, substituted: true },
        { text: "a claim the sensor could not place", found: false, substituted: false },
      ],
      citations: [
        { sectionId: "21.3", figureId: "F-21-05" },
        { sectionId: "21.3", figureId: null },
        { sectionId: "26.3", figureId: null },
      ],
      verdicts: [
        { sensor: "citation", verdict: "WARN", detail: "one replaced", data: { substituted: 1 } },
        { sensor: "grader", verdict: "PASS", detail: "grounded 0.75", data: { grounded: 0.75, criteria: 4, failed: 1, failedCriteria: "complete" } },
      ],
      grounded: 0.75,
      timings: { firstTokenMs: 640, totalMs: 5200 },
      ledger: { seq: 91, hash: HASH },
      ...overrides,
    },
  };
}

/* Costs that add up exactly in binary, so the sum is compared as written. */
const CALLS: ReadonlyArray<LedgerCall> = [
  { alias: "hb-small", kind: "ASSISTANT", cacheRead: 0, costUsd: 0.125 },
  { alias: "hb-frontier", kind: "ASSISTANT", cacheRead: 0, costUsd: 0.5 },
  { alias: "hb-frontier", kind: "GRADING", cacheRead: 1800, costUsd: 0.25 },
  { alias: "hb-embed", kind: "EMBED", cacheRead: 0, costUsd: 0 },
];

describe("the turn's context", () => {
  it("sends no position: where an item's question came from stays in the set (feature-specs/23 § 8)", () => {
    expect(contextOf(golden(1))).toEqual({});
    expect(contextOf(golden(2, { context: { chapter: 21, section: null } }))).toEqual({});
  });

  it("is the pair of a compare and the lab of a lab question, and nothing else", () => {
    const compare = golden(3, { kind: "compare", mode: "compare", expected: { citations: [], chapters: [21, 26], sourceRowId: null, valueText: null, refusal: null } });
    expect(contextOf(compare)).toEqual({ chapters: [21, 26] });
    expect(contextOf(golden(4, { kind: "lab", mode: "lab", context: { chapter: 7, section: null } }))).toEqual({ labId: "lab-07" });
  });
});

describe("the grader's criteria, read from its verdict's data", () => {
  it("is true for every criterion the verdict does not name as failed", () => {
    expect(graderCriteriaOf([{ sensor: "grader", verdict: "FAIL", data: { grounded: 0.5, criteria: 4, failed: 2, failedCriteria: "supported,precise" } }])).toEqual({ supported: false, precise: false, complete: true, in_scope: true });
    expect(graderCriteriaOf([{ sensor: "grader", verdict: "PASS", data: { grounded: 1, criteria: 4, failed: 0, failedCriteria: "" } }])).toEqual({ supported: true, precise: true, complete: true, in_scope: true });
  });

  it("is null when the answer was not graded, or the verdict does not say which criteria failed", () => {
    expect(graderCriteriaOf([{ sensor: "citation", verdict: "PASS" }])).toBeNull();
    expect(graderCriteriaOf([{ sensor: "grader", verdict: "NA", data: { criteria: 0 } }])).toBeNull();
    /* A count without the names (a verdict written before the names were kept) is not four passes. */
    expect(graderCriteriaOf([{ sensor: "grader", verdict: "PASS", data: { grounded: 1, criteria: 4, failed: 0 } }])).toBeNull();
    expect(graderCriteriaOf([{ sensor: "grader", verdict: "PASS", data: { grounded: 1, criteria: 3, failed: 0, failedCriteria: "" } }])).toBeNull();
  });
});

describe("whether a turn did what its golden label expects", () => {
  const cites = [{ sectionId: "21.3", figureId: "F-21-05" }];

  it("wants every expected citation, and the figure only when the label names one", () => {
    expect(expectedHit(golden(1), "answer", null, cites)).toBe(true);
    expect(expectedHit(golden(1), "answer", null, [{ sectionId: "21.3", figureId: "F-21-07" }])).toBe(false);
    expect(expectedHit(golden(1), "answer", null, [{ sectionId: "21.4", figureId: "F-21-05" }])).toBe(false);
    const claim = golden(2, { kind: "claim", expected: { citations: [{ sectionId: "21.3", figureId: null }], chapters: [21], sourceRowId: null, valueText: null, refusal: null } });
    expect(expectedHit(claim, "answer", null, [{ sectionId: "21.3", figureId: "F-21-07" }])).toBe(true);
    /* An answer was expected: a refusal or a failed turn is a miss whatever it cites. */
    expect(expectedHit(golden(1), "refusal", "R-SCOPE", cites)).toBe(false);
    expect(expectedHit(golden(1), "failed", null, cites)).toBe(false);
  });

  it("wants a compare to cite from every chapter of its pair", () => {
    const compare = golden(3, { kind: "compare", mode: "compare", expected: { citations: [], chapters: [21, 26], sourceRowId: null, valueText: null, refusal: null } });
    expect(expectedHit(compare, "answer", null, [{ sectionId: "21.3", figureId: null }, { sectionId: "26.1", figureId: null }])).toBe(true);
    expect(expectedHit(compare, "answer", null, [{ sectionId: "21.3", figureId: null }, { sectionId: "21.4", figureId: null }])).toBe(false);
  });

  it("wants a refusal item refused for the cause its label names", () => {
    expect(expectedHit(refusalItem(4, "R-SCOPE"), "refusal", "R-SCOPE", [])).toBe(true);
    expect(expectedHit(refusalItem(4, "R-SCOPE"), "refusal", "R-UNVERIFIED", [])).toBe(false);
    expect(expectedHit(refusalItem(4, "R-SCOPE"), "answer", null, cites)).toBe(false);
  });
});

describe("one line of the run file", () => {
  it("says what the turn cited, counted, was graded and cost, and holds no text", () => {
    const record = recordOf(golden(1), { traceId: `${TRACE}1`, events: [{ event: "meta", data: {} }, { event: "token", data: { text: "expected" } }, final()] }, CALLS, HASH);
    expect(record).toEqual({
      id: "G-0001",
      kind: "figure",
      mode: "explain",
      language: "en",
      outcome: "answer",
      refusalCause: null,
      code: null,
      messageId: "m-1",
      traceId: `${TRACE}1`,
      citedSections: ["21.3", "26.3"],
      citedFigures: ["F-21-05"],
      expectedHit: true,
      claims: { total: 3, notFound: 1, substituted: 1 },
      verdicts: [
        { sensor: "citation", verdict: "WARN" },
        { sensor: "grader", verdict: "PASS" },
      ],
      grounded: 0.75,
      graderCriteria: { supported: true, precise: true, complete: false, in_scope: true },
      prefixSha256: HASH,
      firstTokenMs: 640,
      totalMs: 5200,
      /* The frontier's calls in the order they were made; the classifier's is counted, the embedding's is neither. */
      frontier: [
        { kind: "assistant", cacheRead: 0 },
        { kind: "grading", cacheRead: 1800 },
      ],
      smallCalls: 1,
      costUsd: 0.875,
      ledgerSeq: 91,
    });
    expect(JSON.stringify(record)).not.toContain("expected work redone");
  });

  it("records a refusal with its cause and the calls it did not make", () => {
    const refused = final({ kind: "refusal", refusal: { cause: "R-UNVERIFIED", message: "…" }, claims: [], citations: [], verdicts: [], grounded: null, timings: { firstTokenMs: null, totalMs: 12 }, ledger: null });
    expect(recordOf(refusalItem(2, "R-UNVERIFIED"), { traceId: `${TRACE}2`, events: [refused] }, [], null)).toMatchObject({
      outcome: "refusal",
      refusalCause: "R-UNVERIFIED",
      expectedHit: true,
      claims: { total: 0, notFound: 0, substituted: 0 },
      graderCriteria: null,
      prefixSha256: null,
      firstTokenMs: null,
      frontier: [],
      smallCalls: 0,
      costUsd: 0,
      ledgerSeq: null,
    });
  });

  it("records a turn that ended in an error by its code, and one that ended in nothing as having no final", () => {
    const failed = recordOf(golden(3), { traceId: `${TRACE}3`, events: [{ event: "error", data: { code: "BUDGET_EXCEEDED", message: "the cap is spent", traceId: `${TRACE}3` } }] }, [], null);
    expect(failed).toMatchObject({ outcome: "failed", code: "BUDGET_EXCEEDED", messageId: null, expectedHit: false, totalMs: null });
    expect(recordOf(golden(4), { traceId: `${TRACE}4`, events: [] }, [], null)).toMatchObject({ outcome: "failed", code: "NO_FINAL" });
    /* A last event called `final` that is not one is a failed turn, not an answer with nothing in it. */
    expect(recordOf(golden(5), { traceId: `${TRACE}5`, events: [{ event: "final", data: { kind: "answer" } }] }, [], null)).toMatchObject({ outcome: "failed", code: "NO_FINAL" });
  });
});

describe("the run", () => {
  function deps(script: (item: GoldenItem) => { readonly events: ReadonlyArray<TurnEventLine>; readonly waitMs?: number }) {
    const asked: string[] = [];
    const prefixed: string[] = [];
    let trace = 0;
    const made: GoldenRunDeps = {
      traceId: () => {
        trace += 1;
        return trace.toString(16).padStart(32, "0");
      },
      open: async (item) => `c-${item.id}`,
      ask: async (item, conversationId) => {
        expect(conversationId).toBe(`c-${item.id}`);
        asked.push(item.id);
        const { events, waitMs } = script(item);
        if (waitMs !== undefined) await new Promise((resolve) => setTimeout(resolve, waitMs));
        return events;
      },
      calls: async () => [],
      prefixOf: async (messageId) => {
        prefixed.push(messageId);
        return HASH;
      },
    };
    return { made, asked, prefixed };
  }

  it("returns the lines in the golden set's order, whatever order the turns finish in", async () => {
    const items = [1, 2, 3, 4, 5].map((n) => golden(n));
    /* The first item is the slowest, so with three in flight it finishes after its neighbours. */
    const { made, asked } = deps((item) => ({ events: [final({ messageId: `m-${item.id}` })], waitMs: item.id === "G-0001" ? 40 : 1 }));
    const finished: string[] = [];
    const result = await runGolden(items, { concurrency: 3, onRecord: (record, done) => finished.push(`${record.id}#${String(done)}`) }, made);
    expect(result.partial).toBe(false);
    expect(result.records.map((record) => record.id)).toEqual(["G-0001", "G-0002", "G-0003", "G-0004", "G-0005"]);
    expect(result.records.map((record) => record.messageId)).toEqual(["m-G-0001", "m-G-0002", "m-G-0003", "m-G-0004", "m-G-0005"]);
    expect([...asked].sort()).toEqual(["G-0001", "G-0002", "G-0003", "G-0004", "G-0005"]);
    expect(finished).toHaveLength(5);
    expect(finished[0]).not.toBe("G-0001#1");
    expect(finished.at(-1)).toMatch(/#5$/);
  });

  it("stops at a budget refusal: no item after it is asked, and the result says partial", async () => {
    const items = [1, 2, 3, 4, 5].map((n) => golden(n));
    const { made, asked, prefixed } = deps((item) =>
      item.id === "G-0003" ? { events: [{ event: "error", data: { code: "BUDGET_EXCEEDED", message: "the cap is spent", traceId: TRACE } }] } : { events: [final({ messageId: `m-${item.id}` })] },
    );
    const result = await runGolden(items, { concurrency: 1 }, made);
    expect(asked).toEqual(["G-0001", "G-0002", "G-0003"]);
    expect(result.partial).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["answer", "answer", "failed"]);
    /* A turn with no answer row has no prefix to look up. */
    expect(prefixed).toEqual(["m-G-0001", "m-G-0002"]);
  });

  it("carries on past a failure that is not the budget's", async () => {
    const items = [1, 2, 3].map((n) => golden(n));
    const { made, asked } = deps((item) => (item.id === "G-0002" ? { events: [{ event: "error", data: { code: "ASSISTANT_UNAVAILABLE", message: "…", traceId: TRACE } }] } : { events: [final()] }));
    const result = await runGolden(items, { concurrency: 1 }, made);
    expect(asked).toEqual(["G-0001", "G-0002", "G-0003"]);
    expect(result.partial).toBe(false);
    expect(result.records.map((record) => record.code)).toEqual([null, "ASSISTANT_UNAVAILABLE", null]);
  });
});

describe("the run file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-golden-run-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const header = (grade: "stub" | "real", startedAt: string, partial = false): GoldenRunHeader => GoldenRunHeaderSchema.parse({ run: "golden", release: "2026.09", grade, startedAt, userId: "u-gate", partial });
  const line = (n: number) => recordOf(golden(n), { traceId: n.toString(16).padStart(32, "0"), events: [final({ messageId: `m-${String(n)}` })] }, CALLS, HASH);

  it("is named by release and grade: one file for the stub, one per run for a real one", () => {
    const at = new Date("2026-10-04T13:53:25.991Z");
    expect(runFileName("2026.09", "stub", at)).toBe("golden-run-2026.09-stub.jsonl");
    expect(runFileName("2026.09", "real", at)).toBe("golden-run-2026.09-real-20261004T135325Z.jsonl");
    /* A pilot is named apart, the word before the grade, so no reader of runs finds it by a run's prefix. */
    expect(runFileName("2026.09", "real", at, true)).toBe("golden-run-2026.09-pilot-real-20261004T135325Z.jsonl");
    expect(runFileName("2026.09", "stub", at, true)).toBe("golden-run-2026.09-pilot-stub.jsonl");
  });

  it("reads back what it wrote: the header, then a line an item", () => {
    const name = runFileName("2026.09", "stub", new Date("2026-10-04T13:00:00.000Z"));
    writeRunFile(dir, name, header("stub", "2026-10-04T13:00:00.000Z"), [line(1), line(2)]);
    const read = readRunFile(dir, name);
    expect(read).toMatchObject({ grade: "stub", file: name, partial: false, header: { userId: "u-gate", release: "2026.09" } });
    expect(read.items).toEqual([line(1), line(2)]);
  });

  it("gives the gate the newest run of the grade it asks for, and nothing when there is none", () => {
    expect(newestRun(dir, "2026.09", "real")).toBeNull();
    expect(newestRun(join(dir, "absent"), "2026.09", "stub")).toBeNull();
    const first = new Date("2026-10-04T09:00:00.000Z");
    const second = new Date("2026-10-05T08:30:00.000Z");
    writeRunFile(dir, runFileName("2026.09", "real", second), header("real", second.toISOString(), true), [line(3)]);
    writeRunFile(dir, runFileName("2026.09", "real", first), header("real", first.toISOString()), [line(1), line(2)]);
    expect(newestRun(dir, "2026.09", "real")).toMatchObject({ file: "golden-run-2026.09-real-20261005T083000Z.jsonl", partial: true, items: [{ id: "G-0003" }] });
    expect(newestRun(dir, "2026.09", "stub")?.file).toBe("golden-run-2026.09-stub.jsonl");
    /* Another release's runs are not this release's. */
    expect(newestRun(dir, "2026.10", "real")).toBeNull();
  });

  it("never gives the gate a pilot, however new: five items are not the golden set", () => {
    const later = new Date("2026-10-06T08:00:00.000Z");
    writeRunFile(dir, runFileName("2026.09", "real", later, true), header("real", later.toISOString(), true), [line(4)]);
    writeRunFile(dir, runFileName("2026.09", "stub", later, true), header("stub", later.toISOString(), true), [line(5)]);
    expect(newestRun(dir, "2026.09", "real")?.file).toBe("golden-run-2026.09-real-20261005T083000Z.jsonl");
    expect(newestRun(dir, "2026.09", "stub")?.file).toBe("golden-run-2026.09-stub.jsonl");
    /* It is still a file a person can read by name. */
    expect(readRunFile(dir, "golden-run-2026.09-pilot-real-20261006T080000Z.jsonl").items.map((item) => item.id)).toEqual(["G-0004"]);
  });
});

describe("what a real run would cost", () => {
  /* Each line costs 0.875 (CALLS above), so a run's mean per item is 0.875 whatever its length. */
  const runOf = (grade: "stub" | "real", file: string, count: number, partial = false) => ({
    grade,
    file,
    partial,
    items: Array.from({ length: count }, (_, index) => recordOf(golden(index + 1), { traceId: (index + 1).toString(16).padStart(32, "0"), events: [final()] }, CALLS, HASH)),
  });

  it("is an earlier real run's mean per item, when there is one", () => {
    const estimate = estimateOf(300, { real: runOf("real", "golden-run-2026.09-real-20261004T090000Z.jsonl", 4), stub: runOf("stub", "golden-run-2026.09-stub.jsonl", 2), paidTurns: [9] });
    expect(estimate.usd).toBe(262.5);
    expect(estimate.text).toBe("about $262.50 for 300 items, at the $0.8750 an item of golden-run-2026.09-real-20261004T090000Z.jsonl");
  });

  it("is otherwise the larger of the stub's priced prompts and the principal's paid turns, and says the lower", () => {
    const stub = runOf("stub", "golden-run-2026.09-stub.jsonl", 2);
    const dearer = estimateOf(100, { real: null, stub, paidTurns: [1, 2, 0] });
    expect(dearer.usd).toBe(150);
    expect(dearer.text).toBe("about $150.00 for 100 items, from this principal's last 2 paid turns, $1.5000 a turn; the lower figure, $87.50, is from the stub run's own prompts priced by prices.ts, $0.8750 an item (golden-run-2026.09-stub.jsonl)");
    const cheaper = estimateOf(100, { real: null, stub, paidTurns: [0.5] });
    expect(cheaper.usd).toBe(87.5);
    expect(cheaper.text).toContain("from the stub run's own prompts priced by prices.ts");
    expect(cheaper.text).toContain("the lower figure, $50.00, is from this principal's last 1 paid turns");
  });

  it("uses the one figure there is, takes nothing from a stub run that stopped early, and gives no number without a basis", () => {
    expect(estimateOf(10, { real: null, stub: null, paidTurns: [2] })).toEqual({ usd: 20, text: "about $20.00 for 10 items, from this principal's last 1 paid turns, $2.0000 a turn" });
    expect(estimateOf(10, { real: null, stub: runOf("stub", "golden-run-2026.09-stub.jsonl", 2, true), paidTurns: [] }).usd).toBeNull();
    const none = estimateOf(10, { real: null, stub: null, paidTurns: [0] });
    expect(none.usd).toBeNull();
    expect(none.text).toContain("no basis for an estimate");
  });
});
