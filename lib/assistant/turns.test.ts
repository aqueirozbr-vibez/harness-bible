import { describe, expect, it } from "vitest";

import { answerOfFinal, bodyClaims, citationCounts, claimGroups, copyWithCitations, deriveLineOf, hashFragment, logMarkOf, seedsResearch, shapedOf, splitAroundValue, turnsOf, verdictSummary, type MessageView, type SseFinal, type Turn } from "@/lib/assistant/turns";
import { parseSectionId } from "@/lib/schemas/ids";

/*
 * The dock's turn model (feature-specs/16 § 5.4, § 5.6, § 5.7). These are the decisions that would be invisible in
 * a screenshot and wrong in the record: which row answers which question, what `Copy with citations` puts on the
 * clipboard, and what `n of m pass` counts.
 */

const ROW: MessageView = {
  id: "00000000-0000-4000-8000-000000000001",
  role: "USER",
  ordinal: 1,
  mode: "EXPLAIN",
  text: "Why do idempotency keys matter?",
  refusal: null,
  citations: [],
  verdicts: [],
  grounded: null,
  repaired: false,
  substituted: 0,
  citesEdition: null,
  firstTokenMs: null,
  totalMs: null,
  ledger: null,
  flag: null,
  traceId: "f".repeat(32),
  modeResult: null,
  research: null,
  createdAt: "2026-09-25T10:42:00.000Z",
};

function answerRow(overrides: Partial<MessageView> = {}): MessageView {
  return {
    ...ROW,
    id: "00000000-0000-4000-8000-000000000002",
    role: "ASSISTANT",
    ordinal: 2,
    text: "A retried write without a key is a second write.",
    citations: [{ ordinal: 1, sectionId: "21.3", figureId: "F-21-07", version: "v1.0.0", editionLang: "EN", claimText: null, deriveLine: null }],
    verdicts: [
      { sensor: "scope", verdict: "PASS", detail: "in corpus" },
      { sensor: "citation", verdict: "PASS", detail: "1 / 1 figures found at cited location" },
    ],
    grounded: 0.94,
    citesEdition: "EN",
    firstTokenMs: 900,
    totalMs: 4100,
    ledger: { seq: 42, hash: "c".repeat(64) },
    ...overrides,
  };
}

const FINAL: SseFinal = {
  messageId: "00000000-0000-4000-8000-00000000000f",
  ordinal: 2,
  kind: "answer",
  refusal: null,
  claims: [
    { text: "A retried write without a key is a second write.", sectionId: "21.3", figureId: null, valueText: null, found: true, substituted: false },
    { text: "the book does not cover this", sectionId: null, figureId: null, valueText: null, found: false, substituted: true },
  ],
  citations: [{ sectionId: "21.3", figureId: "F-21-07", version: "v1.0.0", editionLang: "EN" }],
  verdicts: [
    { sensor: "scope", verdict: "WARN", detail: "in corpus · 1 claim out of scope, replaced", data: {} },
    { sensor: "citation", verdict: "PASS", detail: "1 / 1 figures found at cited location", data: {} },
  ],
  grounded: 0.75,
  repaired: false,
  citesEdition: "EN",
  timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
  overBudget: false,
  ledger: { seq: 43, hash: "d".repeat(64), prevHash: "c".repeat(64) },
} as SseFinal;

describe("turnsOf", () => {
  it("pairs each question with the answer that followed it", () => {
    const turns = turnsOf([ROW, answerRow()]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.question.text).toBe(ROW.text);
    expect(turns[0]?.answer?.messageId).toBe(answerRow().id);
    /* A row read back has no claims: its text is the claims already joined (§ 5.4). */
    expect(turns[0]?.answer?.claims).toBeNull();
    expect(turns[0]?.answer?.text).toContain("second write");
  });

  it("leaves a question with nothing after it as a turn still open", () => {
    const turns = turnsOf([ROW]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.answer).toBeNull();
  });

  it("reads a failed turn as an answer with no words and its NA verdict", () => {
    const failed = answerRow({ text: null, citations: [], verdicts: [{ sensor: "scope", verdict: "NA", detail: "ASSISTANT_UNAVAILABLE" }], grounded: null, ledger: null });
    const turns = turnsOf([ROW, failed]);
    expect(turns[0]?.answer?.text).toBeNull();
    expect(turns[0]?.answer?.verdicts[0]).toEqual({ sensor: "scope", verdict: "NA", detail: "ASSISTANT_UNAVAILABLE" });
    expect(verdictSummary(turns[0]?.answer?.verdicts ?? []).tone).toBe("mute");
  });

  it("orders turns by ordinal whatever order the rows arrive in", () => {
    const second = { ...ROW, id: "00000000-0000-4000-8000-000000000003", ordinal: 3, text: "And the second question?" };
    const turns = turnsOf([answerRow(), second, ROW]);
    expect(turns.map((turn) => turn.question.text)).toEqual([ROW.text, second.text]);
  });
});

describe("answerOfFinal", () => {
  it("takes the claims, the citations and the verdicts from the event and nothing else", () => {
    const answer = answerOfFinal(FINAL, "explain");
    expect(answer.claims).toHaveLength(2);
    expect(answer.claims?.[1]?.substituted).toBe(true);
    expect(answer.text).toBeNull();
    expect(answer.ledger).toEqual({ seq: 43, hash: "d".repeat(64), prevHash: "c".repeat(64) });
    expect(answer.firstTokenMs).toBe(900);
  });
});

describe("Start a research (feature-specs/48 § 9.1, § 9.2; unit 75)", () => {
  const turnOf = (rows: ReadonlyArray<MessageView>): Turn => {
    const [turn] = turnsOf(rows);
    if (turn === undefined) throw new Error("no turn");
    return turn;
  };

  it("is offered on an answer of every mode, read back or just streamed", () => {
    for (const mode of ["EXPLAIN", "COMPARE", "WALK", "LAB", "BRIEF"]) expect(seedsResearch(turnOf([{ ...ROW, mode }, answerRow({ mode })]))).toBe(true);
    expect(seedsResearch({ key: "k", mode: "explain", question: { text: ROW.text, at: null }, answer: answerOfFinal(FINAL, "explain") })).toBe(true);
  });

  it("is offered on no refusal, no failed turn, no turn still open, and no turn the 30 days purged", () => {
    expect(seedsResearch(turnOf([ROW, answerRow({ refusal: { cause: "R-SCOPE", beforeRetrieval: true }, text: null, citations: [] })]))).toBe(false);
    expect(seedsResearch(turnOf([ROW, answerRow({ text: null, citations: [], ledger: null })]))).toBe(false);
    expect(seedsResearch(turnOf([ROW]))).toBe(false);
    expect(seedsResearch(turnOf([{ ...ROW, text: null }, answerRow({ text: null })]))).toBe(false);
  });

  it("reads a final with no research as a turn with no research line, and a stored final of an earlier turn still with its legacy line", () => {
    expect(answerOfFinal(FINAL, "explain").research).toBeNull();
    const stored = { ...FINAL, research: { state: "SKIPPED", skip: "OFF_USER", runId: null, days: null, resetsAt: null } } as SseFinal;
    expect(answerOfFinal(stored, "explain").research).toEqual({ state: "SKIPPED", skip: "OFF_USER", days: null, resetsAt: null, proposals: [] });
  });
});

describe("a walk turn's view (feature-specs/18 § 5.2)", () => {
  const WALK = {
    aidId: "21.8-task-survival",
    inputs: { steps: 11, calls: 13, tokens_per_step: 7500 },
    run: { exitCode: 0, timedOut: false, ms: 640 },
    pricesVerifiedAt: null,
    sameAsBook: true,
    steps: [{ ordinal: 1, titleKey: "inputs", line: null, pricesFrom: null, values: {}, bars: [], headline: null, missing: [] }],
    explanations: [{ ordinal: 1, text: "The inputs are the book's.", withheld: false }],
  };

  it("reads the walk from the event and from the row alike, and none from another mode's result", () => {
    expect(answerOfFinal({ ...FINAL, modeResult: WALK }, "walk").walk?.aidId).toBe("21.8-task-survival");
    expect(answerOfFinal(FINAL, "explain").walk).toBeNull();
    const rows = turnsOf([ROW, { ...ROW, id: "00000000-0000-4000-8000-000000000009", role: "ASSISTANT", ordinal: 2, mode: "WALK", modeResult: WALK }]);
    expect(rows[0]?.answer?.walk?.run.ms).toBe(640);
    expect(turnsOf([ROW, { ...ROW, id: "00000000-0000-4000-8000-000000000009", role: "ASSISTANT", ordinal: 2, modeResult: { decision: "park" } }])[0]?.answer?.walk).toBeNull();
  });
});

describe("the shaped modes' views (feature-specs/19 § 6)", () => {
  it("parses each result only for its own mode, from the event and from the row", () => {
    expect(shapedOf("compare", { openPoint: "Who owns the key." })).toEqual({ compare: { openPoint: "Who owns the key." }, lab: null, brief: null });
    expect(shapedOf("BRIEF", { decision: "route first", stance: "conditional", condition: null }).brief?.stance).toBe("conditional");
    expect(shapedOf("explain", { openPoint: null })).toEqual({ compare: null, lab: null, brief: null });
    expect(shapedOf("lab", { openPoint: null }).lab).toBeNull();
    expect(answerOfFinal({ ...FINAL, modeResult: { openPoint: null } }, "compare").compare).toEqual({ openPoint: null });
  });

  it("lays out a reloaded turn's claims from the citations that kept their claim's text", () => {
    const fromEvent = answerOfFinal(FINAL, "compare");
    expect(bodyClaims(fromEvent)).toBe(fromEvent.claims);
    const rows = turnsOf([
      ROW,
      {
        ...ROW,
        id: "00000000-0000-4000-8000-000000000009",
        role: "ASSISTANT",
        ordinal: 2,
        mode: "COMPARE",
        citations: [
          { ordinal: 1, sectionId: "21.1", figureId: null, version: "v1.0.0", editionLang: "EN", claimText: "Chapter 21 retries with a key.", deriveLine: null },
          { ordinal: 2, sectionId: "28.1", figureId: null, version: "v1.0.0", editionLang: "EN", claimText: null, deriveLine: null },
        ],
      },
    ]);
    const answer = rows[0]?.answer;
    expect(answer === null || answer === undefined ? [] : bodyClaims(answer)).toEqual([{ text: "Chapter 21 retries with a key.", sectionId: "21.1", figureId: null, valueText: null, substituted: false }]);
  });
});

describe("a cited figure's derive line (feature-specs/24 § 5.5)", () => {
  it("travels with the answer, so the mark shows for a figure of any chapter", () => {
    const figure = FINAL.citations[0]?.figureId ?? null;
    expect(figure).not.toBeNull();
    /* From the event: the `derives` list, by figure. A final stored before the list existed carries none. */
    const live = answerOfFinal({ ...FINAL, derives: [{ figureId: figure ?? "", line: 45 }] } as SseFinal, "explain");
    expect(deriveLineOf(live, figure)).toBe(45);
    expect(deriveLineOf(answerOfFinal(FINAL, "explain"), figure)).toBeNull();
    /* From a row: the citation's own `deriveLine`. */
    expect(deriveLineOf({ citations: [{ sectionId: "09.2", figureId: "F-09-04", version: "v1.0.0", editionLang: "EN", deriveLine: 12 }] }, "F-09-04")).toBe(12);
    expect(deriveLineOf({ citations: [] }, "F-09-04")).toBeNull();
    expect(deriveLineOf(live, null)).toBeNull();
  });
});

describe("citationCounts", () => {
  it("counts distinct sections and the citations that name a figure", () => {
    const counts = citationCounts([
      { sectionId: "21.3", figureId: "F-21-07", version: "v1.0.0", editionLang: "EN" },
      { sectionId: "21.3", figureId: "F-21-08", version: "v1.0.0", editionLang: "EN" },
      { sectionId: "26.3", figureId: null, version: "v1.0.0", editionLang: "EN" },
    ]);
    expect(counts).toEqual({ citations: 2, figures: 2 });
  });
});

describe("copyWithCitations", () => {
  it("marks each cited claim with its section and copies a substituted sentence as it was shown", () => {
    const copied = copyWithCitations(answerOfFinal(FINAL, "explain"));
    expect(copied).toBe("A retried write without a key is a second write. [21.3]\n\nthe book does not cover this");
  });

  it("copies a reloaded turn's text, which is the claims already joined", () => {
    const turns = turnsOf([ROW, answerRow()]);
    expect(copyWithCitations(turns[0]?.answer ?? answerOfFinal(FINAL, "explain"))).toBe(answerRow().text);
  });
});

describe("verdictSummary", () => {
  it("counts a PASS and an NA as passed and takes its tone from the worst verdict", () => {
    expect(verdictSummary([{ sensor: "a", verdict: "PASS", detail: "" }, { sensor: "b", verdict: "NA", detail: "" }])).toEqual({ passed: 2, total: 2, tone: "ok" });
    expect(verdictSummary([{ sensor: "a", verdict: "PASS", detail: "" }, { sensor: "b", verdict: "WARN", detail: "" }])).toMatchObject({ passed: 1, tone: "warn" });
    expect(verdictSummary([{ sensor: "a", verdict: "WARN", detail: "" }, { sensor: "b", verdict: "FAIL", detail: "" }])).toMatchObject({ tone: "fail" });
  });
});

describe("claimGroups", () => {
  it("joins consecutive claims citing the same section into one paragraph with one chip", () => {
    const claim = (text: string, sectionId: string | null, substituted = false): { text: string; sectionId: string | null; figureId: null; valueText: null; substituted: boolean } => ({
      text,
      sectionId,
      figureId: null,
      valueText: null,
      substituted,
    });
    const groups = claimGroups([claim("One.", "21.3"), claim("Two.", "21.3"), claim("Three.", "26.3"), claim("the book does not cover this", null, true), claim("Four.", "26.3")]);
    expect(groups.map((group) => group.claims.length)).toEqual([2, 1, 1, 1]);
    expect(groups.map((group) => group.sectionId)).toEqual(["21.3", "26.3", null, "26.3"]);
    /* A substituted claim stands alone and carries no chip, whatever it sits between. */
    expect(groups[2]?.substituted).toBe(true);
  });
});

describe("splitAroundValue", () => {
  it("finds the figure the claim quotes so it can be rendered as a derived value", () => {
    expect(splitAroundValue("That is 117 duplicate writes a day.", "117")).toEqual({ before: "That is ", value: "117", after: " duplicate writes a day." });
  });

  it("says nothing when the claim quotes no figure, or quotes it in other words", () => {
    expect(splitAroundValue("A retried write is a second write.", null)).toBeNull();
    expect(splitAroundValue("about 45 percent of the runs", "45%")).toBeNull();
  });
});

describe("a refusal's view", () => {
  it("carries the event's code and pointers, and a row's cause with no pointers", () => {
    const refused = answerOfFinal(
      {
        ...FINAL,
        kind: "refusal",
        claims: [],
        citations: [],
        refusal: { cause: "R-SCOPE-OT", code: "R-SCOPE-OT", pointers: [{ sectionId: parseSectionId("35.2"), title: "What an agent may read" }], beforeRetrieval: true },
      } as unknown as SseFinal,
      "explain",
    );
    expect(refused.kind).toBe("refusal");
    expect(refused.refusal).toEqual({ cause: "R-SCOPE-OT", code: "R-SCOPE-OT", pointers: [{ sectionId: "35.2", title: "What an agent may read" }], beforeRetrieval: true });

    /* Pointers are not a column: a reloaded refusal keeps its cause and code and the card omits the covers block. */
    const turns = turnsOf([ROW, answerRow({ text: null, citations: [], refusal: { cause: "R-UNVERIFIED", beforeRetrieval: true }, grounded: null })]);
    expect(turns[0]?.answer?.kind).toBe("refusal");
    expect(turns[0]?.answer?.refusal).toEqual({ cause: "R-UNVERIFIED", code: "R-UNVERIFIED", pointers: [], beforeRetrieval: true });
  });
});

describe("logMarkOf", () => {
  const open: Turn = { key: "live", question: { text: "Q", at: null }, mode: "explain", answer: null };
  it("reads a turn still running as answering, and one left open by a crash as failed", () => {
    expect(logMarkOf(open, true)).toEqual({ kind: "answering", tone: "run" });
    expect(logMarkOf(open, false)).toEqual({ kind: "failed", tone: "mute" });
  });
  it("marks a refusal with its cause, a clean answer as pass, and a substituted one in the warn tone", () => {
    const refused = turnsOf([ROW, answerRow({ text: null, citations: [], refusal: { cause: "R-SCOPE-OT", beforeRetrieval: true } })])[0];
    expect(logMarkOf(refused as Turn, false)).toEqual({ kind: "refused", tone: "fail", cause: "R-SCOPE-OT" });
    const clean = turnsOf([ROW, answerRow()])[0];
    expect(logMarkOf(clean as Turn, false)).toEqual({ kind: "pass", tone: "ok", replaced: 0 });
    const live: Turn = { ...open, key: "x", answer: answerOfFinal(FINAL, "explain") };
    expect(logMarkOf(live, false)).toEqual({ kind: "pass", tone: "warn", replaced: 1 });
  });
  it("reads an answer with no words and a lone NA as a failed turn", () => {
    const failed = turnsOf([ROW, answerRow({ text: null, citations: [], verdicts: [{ sensor: "scope", verdict: "NA", detail: "ASSISTANT_UNAVAILABLE" }], grounded: null, ledger: null })])[0];
    expect(logMarkOf(failed as Turn, false)).toEqual({ kind: "failed", tone: "mute" });
  });
});

describe("hashFragment", () => {
  it("prints the first eight hex as two halves", () => {
    expect(hashFragment("5b0ea4c1" + "f".repeat(56))).toBe("#5b0e\u00b7a4c1");
  });
});
