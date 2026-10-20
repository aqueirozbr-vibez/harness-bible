import { describe, expect, it } from "vitest";

import {
  AnchorKind,
  ChangeClass,
  ChangeKind,
  CuratorActionKind,
  CuratorReason,
  Decision,
  EvidenceKind,
  EvidenceState,
  EvidenceTier,
  Part,
  SensorResult,
  SuggestionOrigin,
  SuggestionSensor,
  SuggestionState,
} from "@/lib/db/generated/enums";

import { EvidenceTierSchema } from "./domain";
import {
  ANCHOR_KINDS,
  AnchorKindSchema,
  CHANGE_CLASSES,
  CHANGE_KINDS,
  ChangeClassSchema,
  ChangeKindSchema,
  CRITERIA,
  CriterionSchema,
  CURATOR_ACTIONS,
  CURATOR_REASONS,
  CuratorActionSchema,
  CuratorReasonSchema,
  DECIDERS,
  DeciderSchema,
  DECISIONS,
  DecisionSchema,
  EVIDENCE_KINDS,
  EVIDENCE_STATES,
  EvidenceKindSchema,
  EvidenceStateSchema,
  PARTS,
  PartSchema,
  SENSOR_RESULTS,
  SensorResultSchema,
  SUGGESTION_ORIGINS,
  SUGGESTION_SENSORS,
  SUGGESTION_MOVES,
  SUGGESTION_STATES,
  SuggestionOriginSchema,
  SuggestionSensorSchema,
  SuggestionStateSchema,
  isLegalMove,
  takesRevision,
  takesWithdrawal,
  WITHDRAWABLE_STATES,
} from "./improve";
import { SENSOR_VERDICTS } from "./ledger";

/*
 * The vocabulary of Improve against the database's own (feature-specs/29 § 3): a list here and its enum in
 * prisma/schema.prisma name the same things in the same order, or this fails. That the schema spells each enum as
 * the spec does is tests/improve-schema.test.ts.
 */

describe("the improvement enumerations", () => {
  const mirrors: ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>, object]> = [
    ["Part", PARTS, PartSchema.options, Part],
    ["SuggestionOrigin", SUGGESTION_ORIGINS, SuggestionOriginSchema.options, SuggestionOrigin],
    ["AnchorKind", ANCHOR_KINDS, AnchorKindSchema.options, AnchorKind],
    ["ChangeKind", CHANGE_KINDS, ChangeKindSchema.options, ChangeKind],
    ["ChangeClass", CHANGE_CLASSES, ChangeClassSchema.options, ChangeClass],
    ["CuratorReason", CURATOR_REASONS, CuratorReasonSchema.options, CuratorReason],
    ["EvidenceKind", EVIDENCE_KINDS, EvidenceKindSchema.options, EvidenceKind],
    ["EvidenceState", EVIDENCE_STATES, EvidenceStateSchema.options, EvidenceState],
    ["Decision", DECISIONS, DecisionSchema.options, Decision],
    ["SuggestionState", SUGGESTION_STATES, SuggestionStateSchema.options, SuggestionState],
    ["SuggestionSensor", SUGGESTION_SENSORS, SuggestionSensorSchema.options, SuggestionSensor],
    ["SensorResult", SENSOR_RESULTS, SensorResultSchema.options, SensorResult],
    ["CuratorActionKind", CURATOR_ACTIONS, CuratorActionSchema.options, CuratorActionKind],
  ];

  it("mirror their Prisma enums exactly, in order", () => {
    for (const [name, list, options, prisma] of mirrors) {
      expect(Object.values(prisma), name).toEqual([...list]);
      expect(options, name).toEqual([...list]);
    }
  });

  it("include the evidence tiers, which the reader's domain already named", () => {
    expect(Object.values(EvidenceTier)).toEqual(EvidenceTierSchema.options);
  });

  it("give a suggestion's sensors the verdicts every sensor of the product gives", () => {
    expect([...SENSOR_RESULTS]).toEqual([...SENSOR_VERDICTS]);
  });

  it("refuse a value outside their list, whatever its case", () => {
    expect(SuggestionStateSchema.safeParse("draft").success).toBe(false);
    expect(ChangeClassSchema.safeParse("PRICE").success).toBe(false);
    expect(PartSchema.safeParse("P5").success).toBe(false);
    expect(DecisionSchema.safeParse("accept").success).toBe(false);
  });
});

describe("the two lists that are columns of text and not enums of the database", () => {
  it("name the six criteria of an adjudication, as the adjudicator's output does", () => {
    expect([...CRITERIA]).toEqual(["tier", "relevance", "recency", "independence", "corroboration", "threshold"]);
    expect(CriterionSchema.safeParse("Relevance").success).toBe(false);
  });

  it("name who can have decided", () => {
    expect([...DECIDERS]).toEqual(["intake-rules", "router", "adjudicator"]);
    expect(DeciderSchema.safeParse("curator").success).toBe(false);
  });
});

describe("the table of moves (29 § 3.1, unit 50a)", () => {
  it("holds § 3.1's moves and no other, one entry a state, and a closed suggestion goes nowhere", () => {
    expect(Object.keys(SUGGESTION_MOVES)).toEqual([...SUGGESTION_STATES]);
    expect(SUGGESTION_MOVES).toEqual({
      DRAFT: ["SUBMITTED"],
      SUBMITTED: ["INTAKE_DECLINED", "GRADED", "CURATOR_QUEUE"],
      INTAKE_DECLINED: ["CLOSED", "SUBMITTED"],
      GRADED: ["SENSED"],
      SENSED: ["DECIDED", "CURATOR_QUEUE"],
      DECIDED: ["MERGING", "CURATOR_QUEUE", "CLOSED", "SUBMITTED"],
      CURATOR_QUEUE: ["MERGING", "DECIDED", "CLOSED", "SUBMITTED"],
      MERGING: ["MERGED", "DECIDED"],
      MERGED: ["CLOSED"],
      CLOSED: [],
    });
  });

  it("answers whether a move is one: a step skipped, a move back and staying put are not", () => {
    expect(isLegalMove("SUBMITTED", "GRADED")).toBe(true);
    expect(isLegalMove("INTAKE_DECLINED", "SUBMITTED")).toBe(true);
    expect(isLegalMove("SUBMITTED", "SENSED")).toBe(false);
    expect(isLegalMove("GRADED", "SUBMITTED")).toBe(false);
    expect(isLegalMove("CLOSED", "SUBMITTED")).toBe(false);
    for (const state of SUGGESTION_STATES) expect(isLegalMove(state, state), state).toBe(false);
  });
});

describe("where a suggestion is withdrawn (45 § 5.1; unit 63c)", () => {
  it("is where its workflow waits for a person: declined at intake, asked for more, or in a curator's queue", () => {
    const takes = SUGGESTION_STATES.flatMap((state) => [null, ...DECISIONS].filter((outcome) => takesWithdrawal(state, outcome)).map((outcome) => `${state} ${outcome ?? "none"}`));
    expect(takes).toEqual([
      "INTAKE_DECLINED none",
      "INTAKE_DECLINED ACCEPT",
      "INTAKE_DECLINED REQUEST_MORE",
      "INTAKE_DECLINED DECLINE",
      "INTAKE_DECLINED CURATOR_REVIEW",
      "DECIDED REQUEST_MORE",
      "CURATOR_QUEUE none",
      "CURATOR_QUEUE ACCEPT",
      "CURATOR_QUEUE REQUEST_MORE",
      "CURATOR_QUEUE DECLINE",
      "CURATOR_QUEUE CURATOR_REVIEW",
    ]);
    expect(new Set(SUGGESTION_STATES.filter((state) => [null, ...DECISIONS].some((outcome) => takesWithdrawal(state, outcome))))).toEqual(new Set(WITHDRAWABLE_STATES));
    for (const state of SUGGESTION_STATES) for (const outcome of [null, ...DECISIONS]) if (takesRevision(state, outcome)) expect(takesWithdrawal(state, outcome), `${state} ${String(outcome)}`).toBe(true);
  });
});
