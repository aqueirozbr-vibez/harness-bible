import { describe, expect, it } from "vitest";

import type { SuggestionScore } from "@/lib/rubric/score";
import { CRITERIA, DECIDERS, isLegalMove, type Decision } from "@/lib/schemas/improve";
import { CriterionVerdictValueSchema } from "@/lib/schemas/ledger";

import { curatorPathOf, detailSha256Of, pathOf, ruleCriteria, type RuleCriteriaInput } from "./decision";

/*
 * The decision, pure (feature-specs/33 § 6; unit 50e): each path is moves the table has, and ends where § 6.1 says;
 * a decision by rule has its six lines in the record's form; the sensors' hash is of what they said.
 */

const DECISIONS: ReadonlyArray<Decision> = ["ACCEPT", "REQUEST_MORE", "DECLINE", "CURATOR_REVIEW"];

describe("where a decision leaves a suggestion (33 § 6.1)", () => {
  it("is a path of the table's moves from SUBMITTED, whoever decided and whatever the origin", () => {
    for (const decidedBy of DECIDERS)
      for (const decision of DECISIONS)
        for (const origin of ["HUMAN", "RESEARCHER"] as const) {
          const path = pathOf(decision, decidedBy, origin);
          expect(path[0], `${decidedBy} ${decision} ${origin}`).toBe("SUBMITTED");
          expect(
            path.slice(1).every((state, index) => isLegalMove(path[index] ?? "SUBMITTED", state)),
            `${decidedBy} ${decision} ${origin}: ${path.join(" → ")}`,
          ).toBe(true);
        }
  });

  it("ends where § 6.1 puts each outcome, for a person's suggestion and a researcher's", () => {
    const end = (decision: Decision, decidedBy: (typeof DECIDERS)[number], origin: "HUMAN" | "RESEARCHER") => pathOf(decision, decidedBy, origin).at(-1);
    /* by rule: a person's decline may be revised, a request for more waits for inspection; a researcher's is refuted */
    expect(end("DECLINE", "intake-rules", "HUMAN")).toBe("INTAKE_DECLINED");
    expect(pathOf("REQUEST_MORE", "intake-rules", "HUMAN")).toEqual(["SUBMITTED", "CURATOR_QUEUE"]);
    expect(end("DECLINE", "intake-rules", "RESEARCHER")).toBe("CLOSED");
    expect(end("REQUEST_MORE", "intake-rules", "RESEARCHER")).toBe("CLOSED");
    /* a class no score decides, or a refusal of the adjudicator: the curator, through the states the steps reached */
    expect(pathOf("CURATOR_REVIEW", "router", "HUMAN")).toEqual(["SUBMITTED", "GRADED", "SENSED", "CURATOR_QUEUE"]);
    expect(end("CURATOR_REVIEW", "router", "RESEARCHER")).toBe("CURATOR_QUEUE");
    /* the adjudicator: a person's accept stays decided until the merge (54b); a researcher's goes to a curator (invariant 32) */
    expect(pathOf("ACCEPT", "adjudicator", "HUMAN")).toEqual(["SUBMITTED", "GRADED", "SENSED", "DECIDED"]);
    expect(end("ACCEPT", "adjudicator", "RESEARCHER")).toBe("CURATOR_QUEUE");
    expect(end("REQUEST_MORE", "adjudicator", "HUMAN")).toBe("CURATOR_QUEUE");
    expect(end("REQUEST_MORE", "adjudicator", "RESEARCHER")).toBe("CLOSED");
    expect(end("DECLINE", "adjudicator", "HUMAN")).toBe("CLOSED");
    expect(end("CURATOR_REVIEW", "adjudicator", "HUMAN")).toBe("CURATOR_QUEUE");
  });

  it("takes a curator's accept to the merge and a decline to closed for either origin; a kept request for more waits for a person's revision and is no decision on a researcher's (42 § 7; 43 D16); a merge and a revert are no queue's decision", () => {
    for (const origin of ["HUMAN", "RESEARCHER"] as const) {
      expect(curatorPathOf("ACCEPT", origin)).toEqual({ path: ["CURATOR_QUEUE", "MERGING"], decision: "ACCEPT" });
      expect(curatorPathOf("DECLINE", origin)).toEqual({ path: ["CURATOR_QUEUE", "CLOSED"], decision: "DECLINE" });
      expect(curatorPathOf("MERGE", origin)).toBeNull();
      expect(curatorPathOf("REVERT", origin)).toBeNull();
    }
    expect(curatorPathOf("KEEP_REQUEST_MORE", "HUMAN")).toEqual({ path: ["CURATOR_QUEUE", "DECIDED"], decision: "REQUEST_MORE" });
    expect(curatorPathOf("KEEP_REQUEST_MORE", "RESEARCHER")).toBeNull();
  });
});

const VENDOR = "00000000-0000-4000-8000-0000000050e1";
const ANALYST = "00000000-0000-4000-8000-0000000050e2";

/** The PRD's second example: one screenshot graded G, 5 against a floor of 25. */
const SCREENSHOT: RuleCriteriaInput = {
  scored: { score: 5, strongestId: VENDOR, corroboratedById: null, perItem: [{ id: VENDOR, tier: "G", base: 5, relevance: 1, recency: 1, independence: 1, adjusted: 5 }] },
  items: [{ id: VENDOR, ordinal: 1, reason: "A screenshot with no source shows the figure." }],
  threshold: { acceptAt: 70, floorAt: 25 },
  decision: "DECLINE",
  failingSensor: null,
  namedTier: null,
};

const valid = (input: RuleCriteriaInput): void => {
  const lines = ruleCriteria(input);
  expect(lines.map((line) => line.criterion)).toEqual([...CRITERIA]);
  for (const line of lines) {
    expect(CriterionVerdictValueSchema.safeParse(line.verdict).success, `${line.criterion}: ${line.verdict}`).toBe(true);
    expect(line.reason.trim().length, line.criterion).toBeGreaterThan(0);
    expect(line.reason.split(/\s+/).length, line.criterion).toBeLessThanOrEqual(30);
  }
};

describe("the six lines of a decision by rule (33 § 3.1)", () => {
  it("are the strongest item's tier with the grader's reason, its three factors, the corroboration and the score against the floor", () => {
    expect(ruleCriteria(SCREENSHOT).map((line) => [line.criterion, line.verdict])).toEqual([
      ["tier", "G"],
      ["relevance", "1.00"],
      ["recency", "1.00"],
      ["independence", "1.00"],
      ["corroboration", "none"],
      ["threshold", "5<25"],
    ]);
    expect(ruleCriteria(SCREENSHOT)[0]?.reason).toBe("A screenshot with no source shows the figure.");
    expect(ruleCriteria(SCREENSHOT)[5]?.reason).toBe("Score 5 is under the class's floor of 25: declined without an adjudicator.");
    valid(SCREENSHOT);
  });

  it("say what a corroboration added, what a request for more by rule asks for, which sensor declined, and that no item decided", () => {
    const corroborated: RuleCriteriaInput = {
      ...SCREENSHOT,
      scored: { score: 66, strongestId: VENDOR, corroboratedById: ANALYST, perItem: [{ id: VENDOR, tier: "C", base: 70, relevance: 1, recency: 1, independence: 0.8, adjusted: 56 }, { id: ANALYST, tier: "D", base: 60, relevance: 1, recency: 0.7, independence: 1, adjusted: 42 }] },
      items: [...SCREENSHOT.items, { id: ANALYST, ordinal: 2, reason: "An analyst's table." }],
      decision: "REQUEST_MORE",
      threshold: { acceptAt: 100, floorAt: 100 },
      namedTier: "A",
    };
    const lines = ruleCriteria(corroborated);
    expect(lines.find((line) => line.criterion === "corroboration")).toMatchObject({ verdict: "+10", reason: "Item 2 corroborates item 1 from another publisher." });
    expect(lines.find((line) => line.criterion === "independence")?.verdict).toBe("0.80");
    expect(lines.find((line) => line.criterion === "threshold")).toMatchObject({ verdict: "66<100", reason: "Score 66 is under the acceptance of 100, which only an item of tier A reaches: more is asked for by rule." });
    valid(corroborated);

    const sensor = ruleCriteria({ ...SCREENSHOT, failingSensor: "LINT" }).find((line) => line.criterion === "threshold");
    expect(sensor?.reason).toBe("Declined by the LINT sensor before any adjudicator, whatever the score.");
    /* the derived class declines whenever its strongest item is not its tier, whatever else is there (30 § 4.4) */
    expect(ruleCriteria({ ...SCREENSHOT, namedTier: "A" }).at(-1)?.reason).toBe("The class accepts only tier A, and the strongest item is tier G: declined by rule.");
    expect(ruleCriteria({ ...SCREENSHOT, threshold: null, failingSensor: "SCHEMA" }).at(-1)?.verdict).toBe("none");

    const nothing: RuleCriteriaInput = { ...SCREENSHOT, scored: { score: 0, strongestId: null, corroboratedById: null, perItem: [] } satisfies SuggestionScore, items: [] };
    expect(ruleCriteria(nothing).map((line) => line.verdict)).toEqual(["none", "none", "none", "none", "none", "0<25"]);
    expect(ruleCriteria({ ...nothing, namedTier: "A" }).at(-1)?.reason).toBe("The class accepts only tier A, and no item scores above zero: declined by rule.");
    valid(nothing);
  });
});

describe("the sensors record's one hash (29 § 5)", () => {
  it("is of each sensor's detail in the sensors' order, whatever order the rows come in", () => {
    const rows = [
      { sensor: "LINT" as const, detail: "the change applied and proved" },
      { sensor: "SCHEMA" as const, detail: "parses as EDIT_TEXT on a section" },
    ];
    expect(detailSha256Of(rows)).toBe(detailSha256Of([...rows].reverse()));
    expect(detailSha256Of(rows)).toMatch(/^[0-9a-f]{64}$/);
    expect(detailSha256Of([{ ...rows[0], detail: "refused" } as (typeof rows)[number], rows[1] as (typeof rows)[number]])).not.toBe(detailSha256Of(rows));
  });
});
