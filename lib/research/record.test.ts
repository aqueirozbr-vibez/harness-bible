import { describe, expect, it } from "vitest";

import { ResearchPayloadSchema } from "@/lib/schemas/ledger";

import { frontierCallsOf, modelCallOf, personPayloadOf, personPlannedOf, researchPayloadOf, runEndOf, type PersonRecordFacts, type RecordFacts } from "./record";

/*
 * The RESEARCH record's payload (feature-specs/40 § 6.3; unit 58e): a run that planned a brief names both models and
 * the brief's hash; one that planned nothing names the planner alone; one that never planned has no record; the usage
 * is every call summed; and what is built passes the ledger's own schema.
 */

const RUN = { id: "33333333-3333-4333-8333-333333333333", releaseId: "2026.09", sectionAnchors: ["21.3", "21.4"], gap: true, briefSha256: "d".repeat(64), searches: 3, pageReads: 2, traceId: "f".repeat(32) };
const GUIDE = { version: "v1.0", sha256: "a".repeat(64) };
const STEP = "b".repeat(64);
const PLANNER = { alias: "hb-small", modelId: "claude-haiku-4-5", outcome: "ok", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500 };
const READER = { alias: "hb-frontier", modelId: "claude-opus-5", outcome: "ok", inputTokens: 20_000, outputTokens: 1_500, cacheReadTokens: 2_000 };

const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({ run: RUN, planned: "brief", end: { state: "DONE", code: null }, findings: [{ ordinal: 1, outcome: "INVALID" }, { ordinal: 2, outcome: "PROPOSED" }], calls: [PLANNER, READER], guide: GUIDE, stepKey: STEP, ...over });

describe("researchPayloadOf", () => {
  it("builds the record of a run that planned a brief: both models, the brief's hash, the findings, the usage summed", () => {
    const payload = researchPayloadOf(facts());
    expect(payload).toEqual({
      stepKey: STEP,
      runId: RUN.id,
      releaseId: "2026.09",
      sections: ["21.3", "21.4"],
      gap: true,
      planned: "brief",
      briefSha256: "d".repeat(64),
      searches: 3,
      pageReads: 2,
      findings: [{ ordinal: 1, outcome: "INVALID" }, { ordinal: 2, outcome: "PROPOSED" }],
      guide: GUIDE,
      models: { planner: "claude-haiku-4-5", reader: "claude-opus-5" },
      usage: { inputTokens: 21_000, outputTokens: 1_700, cacheReadTokens: 2_500 },
      traceId: "f".repeat(32),
      end: { state: "DONE", code: null },
    });
    expect(ResearchPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("builds the record of a run that planned nothing: the planner alone, no brief, no reader", () => {
    const payload = researchPayloadOf(facts({ planned: "nothing", run: { ...RUN, briefSha256: null, searches: 0, pageReads: 0 }, findings: [], calls: [PLANNER] }));
    expect(payload).toMatchObject({ planned: "nothing", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null }, findings: [], usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500 } });
    expect(ResearchPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("names the reader by the gateway's alias when it never answered, and the last frontier call when the turn was continued", () => {
    const unanswered = { ...READER, modelId: "hb-frontier", outcome: "unavailable", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    expect(researchPayloadOf(facts({ calls: [PLANNER, unanswered], findings: [] }))?.models).toEqual({ planner: "claude-haiku-4-5", reader: "hb-frontier" });
    expect(researchPayloadOf(facts({ calls: [PLANNER, READER, { ...READER, modelId: "claude-opus-5-20260101" }] }))?.models.reader).toBe("claude-opus-5-20260101");
  });

  it("prefers the call the gateway answered over the one it refused at the cap, so a wait at the budget does not name the alias", () => {
    const refused = { ...PLANNER, modelId: "hb-small", outcome: "budget", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    expect(modelCallOf([refused, PLANNER], "hb-small")?.modelId).toBe("claude-haiku-4-5");
    expect(modelCallOf([refused], "hb-small")?.modelId).toBe("hb-small");
    expect(modelCallOf([], "hb-small")).toBeUndefined();
    expect(researchPayloadOf(facts({ calls: [refused, PLANNER, READER] }))?.models.planner).toBe("claude-haiku-4-5");
    expect(researchPayloadOf(facts({ calls: [refused, PLANNER, READER] }))?.usage.inputTokens).toBe(21_000);
  });

  it("records a planner that was called and failed as planned failed, which the ledger's schema takes", () => {
    const payload = researchPayloadOf(facts({ planned: "failed", run: { ...RUN, briefSha256: null, searches: 0, pageReads: 0 }, findings: [], calls: [PLANNER] }));
    expect(payload).toMatchObject({ planned: "failed", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null } });
    expect(ResearchPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("says how the run ended, by a code of ours or INTERNAL, and the ledger's schema holds the pair together (unit 61a)", () => {
    expect(runEndOf({ state: "DONE" })).toEqual({ state: "DONE", code: null });
    expect(runEndOf({ state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" })).toEqual({ state: "SKIPPED", code: "NOTHING_TO_RESEARCH" });
    expect(runEndOf({ state: "FAILED", failure: "READER_FAILED" })).toEqual({ state: "FAILED", code: "READER_FAILED" });
    /* a person's run the planner refused (feature-specs/48 § 15): the cause as a code, which has no hyphen */
    expect(runEndOf({ state: "REFUSED", refusal: "R-SCOPE" })).toEqual({ state: "REFUSED", code: "R_SCOPE" });
    expect(runEndOf({ state: "REFUSED", refusal: "R-PERSONAL" })).toEqual({ state: "REFUSED", code: "R_PERSONAL" });
    /* an error the engine wrapped by its name, and anything that is not a code */
    expect(runEndOf({ state: "FAILED", failure: "TypeError" })).toEqual({ state: "FAILED", code: "INTERNAL" });
    expect(runEndOf({ state: "FAILED", failure: "the database went away" })).toEqual({ state: "FAILED", code: "INTERNAL" });
    const failed = researchPayloadOf(facts({ end: { state: "FAILED", code: "READER_FAILED" }, findings: [] }));
    expect(failed?.end).toEqual({ state: "FAILED", code: "READER_FAILED" });
    expect(ResearchPayloadSchema.safeParse(failed).success).toBe(true);
    /* the two halves together; and a record written before unit 61, which has none */
    expect(ResearchPayloadSchema.safeParse({ ...failed, end: { state: "DONE", code: "READER_FAILED" } }).success).toBe(false);
    expect(ResearchPayloadSchema.safeParse({ ...failed, end: { state: "FAILED", code: null } }).success).toBe(false);
    expect(ResearchPayloadSchema.safeParse({ ...failed, end: { state: "FAILED", code: "reader failed" } }).success).toBe(false);
    expect(ResearchPayloadSchema.safeParse({ ...failed, end: undefined }).success).toBe(true);
  });

  it("has no record for a run that never planned, or whose calls' rows do not say by what", () => {
    expect(researchPayloadOf(facts({ planned: null }))).toBeNull();
    expect(researchPayloadOf(facts({ calls: [] }))).toBeNull();
    expect(researchPayloadOf(facts({ calls: [PLANNER] }))).toBeNull();
    expect(researchPayloadOf(facts({ run: { ...RUN, briefSha256: null } }))).toBeNull();
  });
});

/* A person's run's record (feature-specs/48 § 15; unit 70b): the writer told from the reader by `writingAt`, the person's members, the refusal's code. */
describe("personPayloadOf", () => {
  const WRITING = new Date("2026-10-12T10:05:00.000Z");
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 10, minute));
  const PERSON_RUN = { ...RUN, conversationId: "44444444-4444-4444-8444-444444444444", questionSha256: "e".repeat(64), writingAt: WRITING };
  const planner = { ...PLANNER, createdAt: at(0) };
  const reader = { ...READER, createdAt: at(1) };
  const continued = { ...READER, modelId: "claude-opus-5-20260101", createdAt: at(3) };
  const writer = { ...READER, modelId: "claude-opus-5-writer", inputTokens: 4_000, outputTokens: 600, cacheReadTokens: 0, createdAt: WRITING };
  const person = (over: Partial<PersonRecordFacts> = {}): PersonRecordFacts => ({ run: PERSON_RUN, end: { state: "DONE" }, findings: [{ ordinal: 1, outcome: "INVALID" }, { ordinal: 2, outcome: "VALID" }], calls: [planner, reader, continued, writer], guide: { version: "v2.0", sha256: "a".repeat(64) }, stepKey: STEP, reportSha256: "9".repeat(64), ...over });

  it("splits the run's frontier calls at writingAt: the reader's before it, the writer's from it; all the reader's when the writer was never called", () => {
    expect(frontierCallsOf([planner, reader, continued, writer], WRITING)).toEqual({ reader: [reader, continued], writer: [writer] });
    expect(frontierCallsOf([planner, reader], null)).toEqual({ reader: [reader], writer: [] });
  });

  it("builds a done run's record: the three models, the person's members, the findings as the checks left them, every call's usage", () => {
    const payload = personPayloadOf(person({ findings: [{ ordinal: 1, outcome: "INVALID" }, { ordinal: 2, outcome: "DRAFTED" }] }));
    expect(payload).toMatchObject({
      runId: RUN.id,
      planned: "brief",
      briefSha256: "d".repeat(64),
      findings: [{ ordinal: 1, outcome: "INVALID" }, { ordinal: 2, outcome: "VALID" }],
      models: { planner: "claude-haiku-4-5", reader: "claude-opus-5-20260101", writer: "claude-opus-5-writer" },
      usage: { inputTokens: 45_000, outputTokens: 3_800, cacheReadTokens: 4_500 },
      end: { state: "DONE", code: null },
      conversationId: PERSON_RUN.conversationId,
      questionSha256: "e".repeat(64),
      reportSha256: "9".repeat(64),
      refusal: null,
    });
    expect(ResearchPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("names no writer for a run whose writer was never called, and a refused writer by the alias", () => {
    const failed = personPayloadOf(person({ run: { ...PERSON_RUN, writingAt: null }, calls: [planner, reader], end: { state: "FAILED", failure: "READER_FAILED" }, reportSha256: null }));
    expect(failed?.models).toEqual({ planner: "claude-haiku-4-5", reader: "claude-opus-5", writer: null });
    expect(ResearchPayloadSchema.safeParse(failed).success).toBe(true);
    const refusedAtTheRate = { ...writer, modelId: "hb-frontier", outcome: "unavailable", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const atRate = personPayloadOf(person({ calls: [planner, reader, refusedAtTheRate, { ...refusedAtTheRate, createdAt: at(7) }], end: { state: "FAILED", failure: "RATE_LIMIT" }, reportSha256: null }));
    expect(atRate?.models.writer).toBe("hb-frontier");
    expect(ResearchPayloadSchema.safeParse(atRate).success).toBe(true);
  });

  it("records a run its planner refused with the cause and its code, R_SCOPE and R_PERSONAL, and the planner alone", () => {
    for (const refusal of ["R-SCOPE", "R-PERSONAL"] as const) {
      const payload = personPayloadOf(person({ run: { ...PERSON_RUN, briefSha256: null, writingAt: null, searches: 0, pageReads: 0 }, end: { state: "REFUSED", refusal }, findings: [], calls: [planner], reportSha256: null }));
      expect(payload).toMatchObject({ planned: "refused", refusal, end: { state: "REFUSED", code: refusal.replace("-", "_") }, models: { planner: "claude-haiku-4-5", reader: null, writer: null }, briefSha256: null });
      expect(ResearchPayloadSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("records a planner that answered and left no brief as planned failed; has no record where no planner answered — the cap, the gateway, the text gone first", () => {
    const noBrief = { ...PERSON_RUN, briefSha256: null, writingAt: null, searches: 0, pageReads: 0 };
    const failed = personPayloadOf(person({ run: noBrief, end: { state: "FAILED", failure: "BRIEF_QUESTION" }, findings: [], calls: [planner], reportSha256: null }));
    expect(failed).toMatchObject({ planned: "failed", end: { state: "FAILED", code: "BRIEF_QUESTION" }, models: { reader: null, writer: null } });
    expect(ResearchPayloadSchema.safeParse(failed).success).toBe(true);
    const refusedAtTheCap = { ...planner, modelId: "hb-small", outcome: "budget", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    expect(personPlannedOf(noBrief, { state: "SKIPPED", skip: "BUDGET" }, [refusedAtTheCap])).toBeNull();
    expect(personPayloadOf(person({ run: noBrief, end: { state: "SKIPPED", skip: "BUDGET" }, findings: [], calls: [refusedAtTheCap], reportSha256: null }))).toBeNull();
    expect(personPayloadOf(person({ run: noBrief, end: { state: "SKIPPED", skip: "UNAVAILABLE" }, findings: [], calls: [], reportSha256: null }))).toBeNull();
    expect(personPayloadOf(person({ run: noBrief, end: { state: "SKIPPED", skip: "TEXT_PURGED" }, findings: [], calls: [], reportSha256: null }))).toBeNull();
  });

  it("records a run whose brief was stored and whose reader never ran — deleted, erased or cancelled between the plan and the read — as planned failed, with no brief's hash and no reader (48 § 15; review of unit 70)", () => {
    for (const end of [{ state: "SKIPPED", skip: "TEXT_PURGED" }, { state: "FAILED", failure: "CANCELLED" }, { state: "FAILED", failure: "TIMEOUT" }] as const) {
      const payload = personPayloadOf(person({ run: { ...PERSON_RUN, writingAt: null, searches: 0, pageReads: 0 }, end, findings: [], calls: [planner], reportSha256: null }));
      expect(payload).toMatchObject({ planned: "failed", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null, writer: null }, searches: 0, findings: [] });
      expect(ResearchPayloadSchema.safeParse(payload).success).toBe(true);
    }
    /* the reader called and refused at the cap is still the reader's: the brief stands */
    const refusedReader = { ...reader, modelId: "hb-frontier", outcome: "budget", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    expect(personPayloadOf(person({ run: { ...PERSON_RUN, writingAt: null }, end: { state: "FAILED", failure: "BUDGET" }, findings: [], calls: [planner, refusedReader], reportSha256: null }))).toMatchObject({ planned: "brief", briefSha256: "d".repeat(64), models: { reader: "hb-frontier" } });
  });
});
