import { describe, expect, it } from "vitest";

import { logSince, refutedByOf, refutedLinesOf, researchMonthsOf, type ClosedProposalRow } from "./researchLog";

/*
 * The research log (feature-specs/43 § 7.2; unit 60d): twelve months newest first, a month with nothing a row of zeros,
 * each run counted from its `RESEARCH` record — planned nothing, planner failed, the findings by outcome, the searches
 * and the pages read; and what closed each refuted or declined proposal, newest first.
 */

const NOW = new Date("2026-10-11T12:00:00.000Z");
const payload = (over: Record<string, unknown> = {}) => ({
  stepKey: "a".repeat(64),
  runId: "33333333-3333-4333-8333-333333333333",
  releaseId: "2026.09",
  sections: ["21.3"],
  gap: true,
  planned: "brief",
  briefSha256: "b".repeat(64),
  searches: 3,
  pageReads: 2,
  findings: [
    { ordinal: 1, outcome: "PROPOSED" },
    { ordinal: 2, outcome: "REFUTED" },
    { ordinal: 3, outcome: "INVALID" },
  ],
  guide: { version: "v1.0", sha256: "c".repeat(64) },
  models: { planner: "claude-haiku-4-5", reader: "claude-opus-5" },
  usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 },
  traceId: "d".repeat(32),
  ...over,
});

/* a legacy run's record, signed by the researcher */
const RESEARCH = { kind: "RESEARCH", actor: "service:researcher" } as const;

describe("researchMonthsOf", () => {
  it("counts each month's runs from their records, newest first, twelve months, a month with nothing a row of zeros", () => {
    const months = researchMonthsOf(
      [
        { ...RESEARCH, createdAt: new Date("2026-10-02T10:00:00.000Z"), payload: payload() },
        { ...RESEARCH, createdAt: new Date("2026-10-05T10:00:00.000Z"), payload: payload({ planned: "nothing", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null }, searches: 0, pageReads: 0, findings: [] }) },
        { ...RESEARCH, createdAt: new Date("2026-09-20T10:00:00.000Z"), payload: payload({ planned: "failed", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null }, searches: 0, pageReads: 0, findings: [] }) },
        { ...RESEARCH, createdAt: new Date("2026-09-21T10:00:00.000Z"), payload: payload({ findings: [{ ordinal: 1, outcome: "DUPLICATE" }] }) },
        /* older than the twelve months: not counted */
        { ...RESEARCH, createdAt: new Date("2025-09-30T10:00:00.000Z"), payload: payload() },
      ],
      NOW,
    );
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ month: "2026-10", runs: 2, nothing: 1, refused: 0, failed: 0, invalid: 1, valid: 0, sent: 0, duplicate: 0, refuted: 1, proposed: 1, searches: 3, pageReads: 2 });
    expect(months[1]).toEqual({ month: "2026-09", runs: 2, nothing: 0, refused: 0, failed: 1, invalid: 0, valid: 0, sent: 0, duplicate: 1, refuted: 0, proposed: 0, searches: 3, pageReads: 2 });
    expect(months[11]).toEqual({ month: "2025-11", runs: 0, nothing: 0, refused: 0, failed: 0, invalid: 0, valid: 0, sent: 0, duplicate: 0, refuted: 0, proposed: 0, searches: 0, pageReads: 0 });
    expect(logSince(NOW).toISOString()).toBe("2025-11-01T00:00:00.000Z");
  });
});

describe("researchMonthsOf for a person's runs (feature-specs/48 § 10.3; unit 74)", () => {
  it("counts the runs the planner refused, the findings that passed, and the researcher's proposals sent, from the SUBMITTED records service:researcher signs", () => {
    const person = { ...RESEARCH, actor: "user:66666666-6666-4666-8666-666666666666" };
    const months = researchMonthsOf(
      [
        { ...person, createdAt: new Date("2026-10-03T10:00:00.000Z"), payload: payload({ findings: [{ ordinal: 1, outcome: "VALID" }, { ordinal: 2, outcome: "VALID" }, { ordinal: 3, outcome: "INVALID" }] }) },
        { ...person, createdAt: new Date("2026-10-04T10:00:00.000Z"), payload: payload({ planned: "refused", refusal: "R-PERSONAL", end: { state: "REFUSED", code: "R_PERSONAL" }, briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null }, searches: 0, pageReads: 0, findings: [] }) },
        /* two proposals sent, and a person's own submission, which is no proposal of the researcher's */
        { kind: "SUBMITTED", actor: "service:researcher", createdAt: new Date("2026-10-06T10:00:00.000Z"), payload: {} },
        { kind: "SUBMITTED", actor: "service:researcher", createdAt: new Date("2026-09-06T10:00:00.000Z"), payload: {} },
        { kind: "SUBMITTED", actor: "user:77777777-7777-4777-8777-777777777777", createdAt: new Date("2026-10-06T11:00:00.000Z"), payload: {} },
        /* another kind of record counts nothing */
        { kind: "GRADED", actor: "service:grader", createdAt: new Date("2026-10-06T12:00:00.000Z"), payload: {} },
      ],
      NOW,
    );
    expect(months[0]).toMatchObject({ month: "2026-10", runs: 2, refused: 1, valid: 2, invalid: 1, sent: 1 });
    expect(months[1]).toMatchObject({ month: "2026-09", runs: 0, sent: 1 });
  });
});

describe("refutedByOf and refutedLinesOf", () => {
  const row = (over: Partial<ClosedProposalRow>): ClosedProposalRow => ({ id: "S-21-0101", outcome: "DECLINE", closedAt: new Date("2026-10-10T12:00:00.000Z"), score: 40, adjudication: { decision: "DECLINE", decidedBy: "adjudicator", failingSensor: null, acceptAt: 85, floorAt: 40 }, evidence: [{ tier: "C", adjustedScore: 40 }], ...over });

  it("names what closed each: the floor, a sensor, the rules' request for more, the adjudicator's request or decline, a curator, the check", () => {
    expect(refutedByOf(row({ adjudication: { decision: "DECLINE", decidedBy: "intake-rules", failingSensor: null, acceptAt: 85, floorAt: 40 } }))).toEqual({ by: "floor", sensor: null });
    expect(refutedByOf(row({ adjudication: { decision: "DECLINE", decidedBy: "intake-rules", failingSensor: "SCHEMA", acceptAt: 85, floorAt: 40 } }))).toEqual({ by: "sensor", sensor: "SCHEMA" });
    expect(refutedByOf(row({ outcome: "REQUEST_MORE", adjudication: { decision: "REQUEST_MORE", decidedBy: "intake-rules", failingSensor: null, acceptAt: 85, floorAt: 40 } }))).toEqual({ by: "rule", sensor: null });
    expect(refutedByOf(row({ outcome: "REQUEST_MORE", adjudication: { decision: "REQUEST_MORE", decidedBy: "adjudicator", failingSensor: null, acceptAt: 85, floorAt: 40 } }))).toEqual({ by: "adjudicatorRequest", sensor: null });
    expect(refutedByOf(row({}))).toEqual({ by: "adjudicatorDecline", sensor: null });
    expect(refutedByOf(row({ outcome: "DECLINE", adjudication: { decision: "ACCEPT", decidedBy: "adjudicator", failingSensor: null, acceptAt: 85, floorAt: 40 } }))).toEqual({ by: "curator", sensor: null });
    expect(refutedByOf(row({ outcome: "REQUEST_MORE", adjudication: { decision: "ACCEPT", decidedBy: "adjudicator", failingSensor: null, acceptAt: 85, floorAt: 40 } }))).toEqual({ by: "check", sensor: null });
  });

  it("lists them newest first, with the strongest tier and the score against the floor and the accept", () => {
    const lines = refutedLinesOf([row({ id: "S-21-0101", closedAt: new Date("2026-10-01T00:00:00.000Z") }), row({ id: "S-21-0102", closedAt: new Date("2026-10-09T00:00:00.000Z"), evidence: [{ tier: "G", adjustedScore: 3 }, { tier: "D", adjustedScore: 30 }] })]);
    expect(lines.map((line) => line.id)).toEqual(["S-21-0102", "S-21-0101"]);
    expect(lines[0]).toMatchObject({ tier: "D", score: 40, floorAt: 40, acceptAt: 85, by: "adjudicatorDecline", closedAt: "2026-10-09T00:00:00.000Z" });
  });
});
