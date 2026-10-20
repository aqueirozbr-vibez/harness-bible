import { describe, expect, it } from "vitest";

import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { ResearchSubmission } from "@/lib/db/improve";
import type { FindingForUse, FindingRef, FindingSent } from "@/lib/db/research";
import type { FindingFailure } from "@/lib/schemas/research";
import type { ReaderFinding } from "@/lib/schemas/researcher";

import { outcomeStep, sendStep, type OutcomeStepDeps, type SendStepDeps } from "./send";

/*
 * A person's finding sent to Improve (feature-specs/48 § 8.4; unit 74), the rows and the door doubled: every end of the
 * send in its order — gone, used, an earlier attempt's suggestion, its text gone, no principal, no rubric, a finding that
 * no longer parses, its anchor gone — each failure written on the finding, which stays VALID; otherwise one
 * transaction with the submission a researcher's suggestion is made from, and a finding moved meanwhile read again. Then
 * the ask: Improve's place written as the outcome, still deciding, or gone.
 */

const REF: FindingRef = { findingId: "77777777-7777-4777-8777-777777777777", userId: "55555555-5555-4555-8555-555555555555" };
const NOW = new Date("2026-10-12T12:00:00.000Z");
const WRITTEN: ReaderFinding = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "Keys are kept for at least 24 hours after the first response.", placeAfter: "end", fastMoving: true }, sources: [{ url: "https://standards.example/keys" }], note: "The standard says so." };
const RESOLVED = { kind: "SECTION", chapterNumber: 21, chapterVersionId: "cv-21", chapterVersion: "v1.0.0", releaseId: "2026.09", part: "P3", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, currentText: "A retried write without a key is a second write.", contentSha256: "c".repeat(64), figures: [], value: null, row: null, tier: null, verifiedOn: null, fastMoving: false, scenarioParam: false, readBy: [] } as ResolvedAnchor;
const VALID: FindingForUse = { id: REF.findingId, runId: "33333333-3333-4333-8333-333333333333", outcome: "VALID", suggestionId: null, failure: null, locale: "PT", text: { kind: "held", finding: WRITTEN } };

function harness(over: Partial<SendStepDeps> = {}, reads: ReadonlyArray<FindingForUse | null> = [VALID]) {
  const queue = [...reads];
  const failures: FindingFailure[] = [];
  const sent: Array<{ readonly at: Date; readonly input: ResearchSubmission }> = [];
  const anchors: string[] = [];
  const deps: SendStepDeps = {
    read: async () => (queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null)),
    principal: () => true,
    rubricVersion: async () => "v1.2",
    anchor: async (kind, id, locale) => {
      anchors.push(`${kind}:${id}:${locale}`);
      return RESOLVED;
    },
    fail: async (_ref, failure) => {
      failures.push(failure);
    },
    send: async (_ref, at, input): Promise<FindingSent> => {
      sent.push({ at, input });
      return { sent: "submitted", suggestionId: "S-21-0101" };
    },
    now: () => NOW,
    ...over,
  };
  return { deps, failures, sent, anchors };
}

describe("sendStep (48 § 8.4)", () => {
  it("makes the researcher's proposal in one transaction: the submission from the finding, its anchor in the run's edition, the rubric in force", async () => {
    const run = harness();
    expect(await sendStep(REF, run.deps)).toEqual({ sent: "submitted", suggestionId: "S-21-0101" });
    expect(run.anchors).toEqual(["SECTION:21.3:pt"]);
    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]?.at).toEqual(NOW);
    expect(run.sent[0]?.input).toMatchObject({ chapterNumber: 21, locale: "PT", rubricVersionId: "v1.2", note: "The standard says so.", sources: [{ url: "https://standards.example/keys", host: "standards.example" }], changeKind: "ADD_CLAIM" });
    expect(run.failures).toEqual([]);
  });

  it("answers a duplicate as the transaction made it", async () => {
    const run = harness({ send: async () => ({ sent: "duplicate", suggestionId: "S-21-0007" }) });
    expect(await sendStep(REF, run.deps)).toEqual({ sent: "duplicate", suggestionId: "S-21-0007" });
  });

  it("ends with nothing written where the finding is gone, or used by another hand; an earlier attempt's suggestion is answered again for its child", async () => {
    expect(await sendStep(REF, harness({}, [null]).deps)).toEqual({ sent: "gone" });
    for (const outcome of ["DRAFTED", "DUPLICATE", "PROPOSED", "REFUTED"] as const) {
      const run = harness({}, [{ ...VALID, outcome, suggestionId: "S-21-0042" }]);
      expect(await sendStep(REF, run.deps)).toEqual({ sent: "used" });
      expect(run.sent).toEqual([]);
    }
    expect(await sendStep(REF, harness({}, [{ ...VALID, outcome: "SUBMITTED", suggestionId: "S-21-0101" }]).deps)).toEqual({ sent: "submitted", suggestionId: "S-21-0101" });
  });

  it("writes each failure on the finding in the spec's order, which stays VALID: its text gone, no principal, no rubric, a finding that does not parse, its anchor gone", async () => {
    const cases: ReadonlyArray<readonly [Partial<SendStepDeps>, FindingForUse, FindingFailure]> = [
      [{}, { ...VALID, text: { kind: "purged" } }, "TEXT_PURGED"],
      [{ principal: () => false }, { ...VALID, text: { kind: "purged" } }, "TEXT_PURGED"],
      [{ principal: () => false }, VALID, "RESEARCH_UNCONFIGURED"],
      [{ rubricVersion: async () => null }, VALID, "NO_RUBRIC"],
      [{ rubricVersion: async () => null }, { ...VALID, text: { kind: "unparsed" } }, "NO_RUBRIC"],
      [{}, { ...VALID, text: { kind: "unparsed" } }, "PARSE"],
      [{ anchor: async () => null }, VALID, "ANCHOR_UNKNOWN"],
    ];
    for (const [over, finding, failure] of cases) {
      const run = harness(over, [finding]);
      expect(await sendStep(REF, run.deps)).toEqual({ sent: "failed", failure });
      expect(run.failures).toEqual([failure]);
      expect(run.sent).toEqual([]);
    }
  });

  it("writes SENDS_LIMIT where the month's thirty were taken by the time the transaction ran, which made nothing (D5; review of unit 74)", async () => {
    const run = harness({ send: async () => ({ sent: "limited" }) });
    expect(await sendStep(REF, run.deps)).toEqual({ sent: "failed", failure: "SENDS_LIMIT" });
    expect(run.failures).toEqual(["SENDS_LIMIT"]);
  });

  it("reads a finding that moved between its read and the claim again, and goes on as it stands", async () => {
    const moved = harness({ send: async () => ({ sent: "moved" }) }, [VALID, { ...VALID, outcome: "SUBMITTED", suggestionId: "S-21-0101" }]);
    expect(await sendStep(REF, moved.deps)).toEqual({ sent: "submitted", suggestionId: "S-21-0101" });
    const gone = harness({ send: async () => ({ sent: "moved" }) }, [VALID, null]);
    expect(await sendStep(REF, gone.deps)).toEqual({ sent: "gone" });
  });
});

describe("outcomeStep (48 § 8.4 step 3)", () => {
  const SUBMITTED: FindingForUse = { ...VALID, outcome: "SUBMITTED", suggestionId: "S-21-0101" };
  function asks(state: string | null, over: Partial<OutcomeStepDeps> = {}, reads: ReadonlyArray<FindingForUse | null> = [SUBMITTED]) {
    const queue = [...reads];
    const written: string[] = [];
    const deps: OutcomeStepDeps = {
      read: async () => (queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null)),
      states: async (ids) => (state === null ? [] : ids.map((id) => ({ id, state: state as "CLOSED", outcome: null }))),
      write: async (_ref, outcome) => {
        written.push(outcome);
        return "written";
      },
      ...over,
    };
    return { deps, written };
  }

  it("writes PROPOSED for the queue, a merge under way or done, and REFUTED for closed; leaves one still deciding PENDING", async () => {
    for (const state of ["CURATOR_QUEUE", "MERGING", "MERGED"]) {
      const run = asks(state);
      expect(await outcomeStep(REF, run.deps)).toBe("PROPOSED");
      expect(run.written).toEqual(["PROPOSED"]);
    }
    const closed = asks("CLOSED");
    expect(await outcomeStep(REF, closed.deps)).toBe("REFUTED");
    expect(closed.written).toEqual(["REFUTED"]);
    for (const state of ["SUBMITTED", "GRADED", "DECIDED", null]) {
      const run = asks(state);
      expect(await outcomeStep(REF, run.deps)).toBe("PENDING");
      expect(run.written).toEqual([]);
    }
  });

  it("ends the wait for a finding gone or no longer a send waiting, and reads back an outcome an earlier ask wrote", async () => {
    expect(await outcomeStep(REF, asks("CLOSED", {}, [null]).deps)).toBe("GONE");
    expect(await outcomeStep(REF, asks("CLOSED", {}, [{ ...VALID }]).deps)).toBe("GONE");
    expect(await outcomeStep(REF, asks("CLOSED", {}, [{ ...SUBMITTED, outcome: "PROPOSED" }]).deps)).toBe("PROPOSED");
    /* moved between the read and the write: what it is now */
    const raced = asks("CLOSED", { write: async () => "unchanged" }, [SUBMITTED, { ...SUBMITTED, outcome: "REFUTED" }]);
    expect(await outcomeStep(REF, raced.deps)).toBe("REFUTED");
    const swept = asks("CLOSED", { write: async () => "unchanged" }, [SUBMITTED, null]);
    expect(await outcomeStep(REF, swept.deps)).toBe("GONE");
  });

  it("answers REFUTED where the write deleted a detached finding, which is no proposal of the asker's", async () => {
    expect(await outcomeStep(REF, asks("CLOSED", { write: async () => "deleted" }).deps)).toBe("REFUTED");
  });
});
