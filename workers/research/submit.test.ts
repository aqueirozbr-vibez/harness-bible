import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { ResearchRunRow } from "@/lib/db/research";
import type { ReaderFinding } from "@/lib/schemas/researcher";

import { outcomesStep, type OutcomesStepDeps } from "./outcomes";
import { outcomeOfState } from "./pace";
import { submitStep, type SubmitStepDeps } from "./submit";

/*
 * The submission and the outcomes (feature-specs/42 § 4, § 5; units 59b, 59c), the rows and the door doubled: a valid
 * finding becomes a submission (lib/research/submission.ts, whose suite holds what it is made of since unit 74) and its
 * row names the suggestion; a key already made is a duplicate; an anchor gone is invalid.
 * Then where each suggestion stands becomes the finding's outcome, or stays pending.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");
const RUN: ResearchRunRow = { id: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", organisationId: null, releaseId: "2026.09", locale: "EN", state: "SUBMITTING", skip: null, failure: null, gap: true, sectionAnchors: ["21.3"], questionSha256: "e".repeat(64), briefSha256: "d".repeat(64), searches: 1, pageReads: 1, workflowId: "research:44444444-4444-4444-8444-444444444444", traceId: "f".repeat(32), textPurgedAt: null, createdAt: new Date("2026-10-10T12:00:00.000Z") };
const RESOLVED: ResolvedAnchor = {
  kind: "SECTION",
  chapterNumber: 21,
  chapterVersionId: "cv-21",
  chapterVersion: "v1.0.0",
  releaseId: "2026.09",
  part: "P3",
  sectionAnchor: "21.3",
  figureAnchor: null,
  sourceRowAnchor: null,
  currentText: "A retried write without a key is a second write. Keep the key for 24 hours.",
  contentSha256: "c".repeat(64),
  figures: [],
  value: null,
  row: null,
  tier: null,
  verifiedOn: null,
  fastMoving: false,
  scenarioParam: false,
  readBy: [{ section: "23.1", title: "Gateways", chapterNumber: 23, part: "P4" }],
};
const finding = (over: Partial<ReaderFinding> = {}): ReaderFinding => ({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "Keys are kept for at least 24 hours after the first response.", placeAfter: "end", fastMoving: true }, sources: [{ url: "https://standards.example/keys" }, { url: " https://standards.example/keys " }, { url: "http://plain.example/" }], note: "The standard says so.", ...over });

describe("submitStep", () => {
  type Row = Parameters<SubmitStepDeps["writeFinding"]>[1];
  function harness(over: Partial<SubmitStepDeps> = {}, valid: ReadonlyArray<number> = [1], earlier: ReadonlyArray<Row> = []) {
    const created: string[] = [];
    const rows: Row[] = [];
    const deps: SubmitStepDeps = {
      readFound: async () => ({ findings: [finding(), finding({ note: "second" })], pages: ["https://standards.example/keys"], valid: [...valid] }),
      readFindings: async () => earlier,
      anchor: async () => RESOLVED,
      rubricVersion: async () => "v1.2",
      /* the door's create and the finding's row, as the one transaction writes them */
      submit: async (_run, ordinal, input) => {
        created.push(input.proposalKey);
        const id = `S-21-010${String(created.length)}`;
        rows.push({ ordinal, outcome: "SUBMITTED", invalidReason: null, suggestionId: id });
        return { created: true, id };
      },
      writeFinding: async (_run, row) => {
        rows.push(row);
      },
      log: () => undefined,
      now: () => NOW,
      ...over,
    };
    return { deps, created, rows };
  }

  it("creates one suggestion per valid finding and names it on the finding's row, SUBMITTED", async () => {
    const { deps, created, rows } = harness({}, [1, 2]);
    expect(await submitStep(RUN, deps)).toEqual({ suggestionIds: ["S-21-0101", "S-21-0102"] });
    expect(created).toHaveLength(2);
    expect(rows).toEqual([
      { ordinal: 1, outcome: "SUBMITTED", invalidReason: null, suggestionId: "S-21-0101" },
      { ordinal: 2, outcome: "SUBMITTED", invalidReason: null, suggestionId: "S-21-0102" },
    ]);
  });

  it("writes DUPLICATE with the suggestion it doubles, and INVALID · ANCHOR where the anchor is gone, creating nothing for either", async () => {
    const duplicate = harness({
      submit: async (_run, ordinal) => {
        duplicate.rows.push({ ordinal, outcome: "DUPLICATE", invalidReason: null, suggestionId: "S-21-0042" });
        return { created: false, duplicateOf: "S-21-0042" };
      },
    });
    expect(await submitStep(RUN, duplicate.deps)).toEqual({ suggestionIds: [] });
    expect(duplicate.rows).toEqual([{ ordinal: 1, outcome: "DUPLICATE", invalidReason: null, suggestionId: "S-21-0042" }]);
    const gone = harness({ anchor: async () => null });
    expect(await submitStep(RUN, gone.deps)).toEqual({ suggestionIds: [] });
    expect(gone.rows).toEqual([{ ordinal: 1, outcome: "INVALID", invalidReason: "ANCHOR", suggestionId: null }]);
    expect(gone.created).toEqual([]);
  });

  it("takes what an earlier attempt of the step wrote on a retry: a finding SUBMITTED is its suggestion, returned to be started and never made again; one DUPLICATE or INVALID stays as written (unit 59's review)", async () => {
    const earlier: Row[] = [
      { ordinal: 1, outcome: "SUBMITTED", invalidReason: null, suggestionId: "S-21-0050" },
      { ordinal: 2, outcome: "DUPLICATE", invalidReason: null, suggestionId: "S-21-0042" },
    ];
    const retried = harness({ readFound: async () => ({ findings: [finding(), finding({ note: "second" }), finding({ note: "third" })], pages: ["https://standards.example/keys"], valid: [1, 2, 3] }) }, [1, 2, 3], earlier);
    expect(await submitStep(RUN, retried.deps)).toEqual({ suggestionIds: ["S-21-0050", "S-21-0101"] });
    /* the first two were not touched; the third was made now */
    expect(retried.rows).toEqual([{ ordinal: 3, outcome: "SUBMITTED", invalidReason: null, suggestionId: "S-21-0101" }]);
    expect(retried.created).toHaveLength(1);
  });

  it("fails TEXT_PURGED where what was found is gone, and NO_RUBRIC without a published rubric", async () => {
    const purged = harness({ readFound: async () => null });
    await expect(submitStep(RUN, purged.deps)).rejects.toSatisfy((error: unknown) => error instanceof ApplicationFailure && error.type === "TEXT_PURGED");
    const noRubric = harness({ rubricVersion: async () => null });
    await expect(submitStep(RUN, noRubric.deps)).rejects.toSatisfy((error: unknown) => error instanceof ApplicationFailure && error.type === "NO_RUBRIC");
  });
});

describe("outcomesStep", () => {
  it("maps a suggestion's place to the finding's outcome: closed is refuted, the queue and a merge are proposed, the rest still deciding", () => {
    expect(outcomeOfState("CLOSED", "DECLINE")).toBe("REFUTED");
    expect(outcomeOfState("CLOSED", "REQUEST_MORE")).toBe("REFUTED");
    expect(outcomeOfState("CURATOR_QUEUE", "ACCEPT")).toBe("PROPOSED");
    expect(outcomeOfState("CURATOR_QUEUE", "CURATOR_REVIEW")).toBe("PROPOSED");
    expect(outcomeOfState("MERGING", "ACCEPT")).toBe("PROPOSED");
    expect(outcomeOfState("MERGED", "ACCEPT")).toBe("PROPOSED");
    for (const state of ["SUBMITTED", "GRADED", "SENSED", "DECIDED", "INTAKE_DECLINED"] as const) expect(outcomeOfState(state, null)).toBeNull();
  });

  it("writes each submitted finding's outcome as its suggestion stands, counts what is still deciding, and leaves the decided ones", async () => {
    const rows: Array<Parameters<OutcomesStepDeps["writeFinding"]>[1]> = [];
    const deps: OutcomesStepDeps = {
      readFindings: async () => [
        { ordinal: 1, outcome: "SUBMITTED", invalidReason: null, suggestionId: "S-21-0101" },
        { ordinal: 2, outcome: "SUBMITTED", invalidReason: null, suggestionId: "S-21-0102" },
        { ordinal: 3, outcome: "SUBMITTED", invalidReason: null, suggestionId: "S-21-0103" },
        { ordinal: 4, outcome: "INVALID", invalidReason: "ANCHOR", suggestionId: null },
        { ordinal: 5, outcome: "PROPOSED", invalidReason: null, suggestionId: "S-21-0099" },
      ],
      states: async () => [
        { id: "S-21-0101", state: "CURATOR_QUEUE", outcome: "ACCEPT" },
        { id: "S-21-0102", state: "CLOSED", outcome: "DECLINE" },
        { id: "S-21-0103", state: "GRADED", outcome: null },
      ],
      writeFinding: async (_run, row) => {
        rows.push(row);
      },
    };
    expect(await outcomesStep(RUN, deps)).toEqual({ pending: 1, proposed: 2, refuted: 1 });
    expect(rows).toEqual([
      { ordinal: 1, outcome: "PROPOSED", invalidReason: null, suggestionId: "S-21-0101" },
      { ordinal: 2, outcome: "REFUTED", invalidReason: null, suggestionId: "S-21-0102" },
    ]);
  });
});
