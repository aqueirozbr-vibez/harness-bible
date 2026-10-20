import { describe, expect, it } from "vitest";

import { CONTRIBUTOR, CURATOR, CURATOR_PAYLOAD, DECIDED_PAYLOAD, GRADED_PAYLOAD, MERGED_PAYLOAD, RETRACTED_PAYLOAD, SENSORS_PAYLOAD, SUBMITTED_PAYLOAD } from "@/tests/fixtures/ledger";

import { entriesOf, personOf, type RecordRow } from "./record";

const AT = new Date("2026-10-08T12:00:00.000Z");
let seq = 100;
const row = (kind: RecordRow["kind"], actor: string, payload: unknown): RecordRow => {
  seq += 1;
  return { seq, kind, actor, payload, createdAt: AT, prevHash: "a".repeat(64), hash: String(seq).padStart(64, "0") };
};

const CONTRIBUTOR_ID = CONTRIBUTOR.slice("user:".length);
const CURATOR_ID = CURATOR.slice("user:".length);

describe("entriesOf: a suggestion's record as its page tells it (35 § 5)", () => {
  const rows = [
    row("SUBMITTED", CONTRIBUTOR, SUBMITTED_PAYLOAD),
    row("GRADED", "service:grader", GRADED_PAYLOAD),
    row("SENSORS", "service:intake", SENSORS_PAYLOAD),
    row("DECIDED", "service:adjudicator", DECIDED_PAYLOAD),
    row("SUBMITTED", CONTRIBUTOR, SUBMITTED_PAYLOAD),
    row("CURATOR", CURATOR, CURATOR_PAYLOAD),
    row("MERGED", "service:merge", MERGED_PAYLOAD),
  ];

  it("tells each kind from its payload's own facts: ids, codes, counts and versions", () => {
    const [submitted, graded, sensors, decided] = entriesOf(rows, new Map());
    expect(submitted.facts).toEqual({ kind: "SUBMITTED", attempt: 1, anchor: "15.9 r4", changeClass: "CITED_FIGURE", items: 2, words: 41, verified: true, rubricVersion: "v1.2" });
    expect(graded.facts).toMatchObject({ kind: "GRADED", score: 66, gradedBy: "hb-small", items: [{ ordinal: 1, tier: "C", base: 70, independence: 0.8, adjusted: 56 }, { ordinal: 2, tier: "D", recency: 0.7, adjusted: 42 }] });
    expect(sensors.facts).toMatchObject({ kind: "SENSORS", verdicts: expect.arrayContaining([{ sensor: "CROSS_CHAPTER", result: "WARN" }]) });
    expect(decided.facts).toEqual({ kind: "DECIDED", decision: "REQUEST_MORE", decidedBy: "adjudicator", score: 66, acceptAt: 70, floorAt: 25, failingSensor: null, criteria: 6, guide: "v2.1", rubricVersion: "v1.2", tokens: 6610 });
  });

  it("counts a second submission as the attempt it is, and marks the view's last record as its head", () => {
    const entries = entriesOf(rows, new Map());
    expect(entries.filter((entry) => entry.facts.kind === "SUBMITTED").map((entry) => (entry.facts.kind === "SUBMITTED" ? entry.facts.attempt : 0))).toEqual([1, 2]);
    expect(entries.map((entry) => entry.head)).toEqual([false, false, false, false, false, false, true]);
  });

  it("marks a submission open, an accept and a merge in the verified colour, a decline in the failure colour", () => {
    const declined = { ...DECIDED_PAYLOAD, decision: "DECLINE", decidedBy: "intake-rules", guide: null, modelId: null, promptSha256: null };
    const markers = entriesOf([...rows, row("DECIDED", "service:intake", declined)], new Map()).map((entry) => entry.marker);
    expect(markers).toEqual(["o", null, null, null, "o", "v", "v", "f"]);
  });

  it("names a person where the loader allowed it, and otherwise by the ledger's pseudonym; a service as what it is", () => {
    const named = entriesOf(rows, new Map([[CURATOR_ID, "M. Tavares"]]));
    expect(named[0].actor).toEqual({ kind: "person", pseudonym: CONTRIBUTOR, name: null });
    expect(named[5].actor).toEqual({ kind: "person", pseudonym: CURATOR, name: "M. Tavares" });
    expect(named[1].actor).toEqual({ kind: "service", service: "grader" });
    expect(personOf(CONTRIBUTOR)).toBe(CONTRIBUTOR_ID);
    expect(personOf("service:intake")).toBeNull();
  });

  it("says a curator's action with its code and criterion, and only that a note exists, by its hash", () => {
    const [, , , , , curator] = entriesOf(rows, new Map());
    expect(curator.facts).toEqual({ kind: "CURATOR", action: "ACCEPT", overrideCode: "OV-IND-02", criterion: "independence", part: "P1", noted: true });
    expect(JSON.stringify(curator)).not.toContain("note\"");
  });

  it("tells a contributor's withdrawal from where and under which decision, by the contributor, with no marker (45 § 5.4)", () => {
    const [retracted, malformed] = entriesOf([row("RETRACTED", CONTRIBUTOR, RETRACTED_PAYLOAD), row("RETRACTED", CONTRIBUTOR, { ...RETRACTED_PAYLOAD, from: "MERGED" })], new Map());
    expect(retracted.facts).toEqual({ kind: "RETRACTED", from: "CURATOR_QUEUE", outcome: "CURATOR_REVIEW" });
    expect(retracted.actor).toEqual({ kind: "person", pseudonym: CONTRIBUTOR, name: null });
    expect(retracted.marker).toBeNull();
    expect(malformed.facts).toEqual({ kind: "UNREADABLE" });
  });

  it("tells a payload that does not read as its kind for what it is, and keeps its hash line", () => {
    const [entry] = entriesOf([row("GRADED", "service:grader", { score: "sixty-six" })], new Map());
    expect(entry.facts).toEqual({ kind: "UNREADABLE" });
    expect(entry.hash).toMatch(/^\d{64}$/);
  });
});
