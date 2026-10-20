import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ResearchRunRow } from "@/lib/db/research";
import type { ReaderFinding, ResearchFound } from "@/lib/schemas/researcher";

import { plannedOf, recordResearch, type RecordStepDeps } from "./record";
import { validateStep, type ValidateStepDeps } from "./validate";

/*
 * The validation step and the record step (feature-specs/41 § 7, 40 § 6.3; unit 58e), the rows doubled: each refused
 * finding gets its row with its reason and nothing of its text, the valid ordinals are left on the run, the fourth is
 * dropped; the record is appended once by its step key for a run that planned, and never for one that did not.
 */

const RUN: ResearchRunRow = { id: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", organisationId: null, releaseId: "2026.09", locale: "EN", state: "VALIDATING", skip: null, failure: null, gap: true, sectionAnchors: ["21.3"], questionSha256: "e".repeat(64), briefSha256: "d".repeat(64), searches: 1, pageReads: 1, workflowId: "research:44444444-4444-4444-8444-444444444444", traceId: "f".repeat(32), textPurgedAt: null, createdAt: new Date("2026-10-10T12:00:00.000Z") };
const SECTION = { id: "21.3", chapter: 21, version: "v1.0.0", title: "Idempotency keys", text: "A retried write without a key is a second write.", verifiedOn: null, figures: [], rows: [] };
const finding = (over: Partial<ReaderFinding> = {}): ReaderFinding => ({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "Keys are kept for 24 hours.", placeAfter: "end", fastMoving: true }, sources: [{ url: "https://standards.example/keys" }], note: "The standard says so.", ...over });

describe("validateStep", () => {
  function harness(found: ResearchFound | null) {
    const rows: Array<Parameters<ValidateStepDeps["writeFinding"]>[1]> = [];
    const written: ResearchFound[] = [];
    const logged: string[] = [];
    const deps: ValidateStepDeps = {
      readFound: async () => found,
      readSections: async () => [SECTION],
      writeFinding: async (_run, row) => {
        rows.push(row);
      },
      writeFound: async (_run, next) => {
        written.push(next);
        return { written: true };
      },
      log: (line) => logged.push(line),
    };
    return { deps, rows, written, logged };
  }

  it("writes an INVALID row with its reason for each refusal, leaves the valid ordinals on the run, drops the fourth", async () => {
    const findings: unknown[] = [finding(), finding({ sources: [{ url: "https://unseen.example/" }] }), finding({ anchor: { kind: "SECTION", id: "22.1" } }), finding()];
    const { deps, rows, written, logged } = harness({ findings, pages: ["https://standards.example/keys"] });
    expect(await validateStep(RUN, deps)).toEqual({ valid: 1, invalid: 2, duplicate: 0 });
    expect(rows).toEqual([
      { ordinal: 2, outcome: "INVALID", invalidReason: "SOURCE_NOT_SEEN", suggestionId: null },
      { ordinal: 3, outcome: "INVALID", invalidReason: "ANCHOR", suggestionId: null },
    ]);
    expect(written).toEqual([{ findings, pages: ["https://standards.example/keys"], valid: [1], dropped: 1 }]);
    expect(logged[0]).toContain("1 valid, 2 invalid, 1 dropped");
    expect(logged.join("\n")).not.toContain("24 hours");
  });

  it("counts an empty list as nothing to validate, and fails TEXT_PURGED where what was found is gone", async () => {
    const empty = harness({ findings: [], pages: [] });
    expect(await validateStep(RUN, empty.deps)).toEqual({ valid: 0, invalid: 0, duplicate: 0 });
    expect(empty.written).toEqual([{ findings: [], pages: [], valid: [], dropped: 0 }]);
    const gone = harness(null);
    await expect(validateStep(RUN, gone.deps)).rejects.toSatisfy((error: unknown) => error instanceof ApplicationFailure && error.type === "TEXT_PURGED");
    const purgedMeanwhile = harness({ findings: [finding()], pages: ["https://standards.example/keys"] });
    purgedMeanwhile.deps = { ...purgedMeanwhile.deps, writeFound: async () => ({ written: false }) };
    await expect(validateStep(RUN, purgedMeanwhile.deps)).rejects.toSatisfy((error: unknown) => error instanceof ApplicationFailure && error.type === "TEXT_PURGED");
  });
});

describe("recordResearch", () => {
  function harness(over: Partial<RecordStepDeps> = {}) {
    const appended: Array<Parameters<RecordStepDeps["append"]>[0]> = [];
    const deps: RecordStepDeps = {
      principal: () => ({ organisationId: "org-research" }),
      guide: () => ({ version: "v1.0", sha256: "a".repeat(64) }),
      readFindings: async () => [{ ordinal: 1, outcome: "INVALID" }],
      calls: async () => [
        { alias: "hb-small", modelId: "claude-haiku-4-5", outcome: "ok", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        { alias: "hb-frontier", modelId: "claude-opus-5", outcome: "ok", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      ],
      recordAt: async () => null,
      append: async (input) => {
        appended.push(input);
        return { seq: 7 } as Awaited<ReturnType<RecordStepDeps["append"]>>;
      },
      log: () => undefined,
      ...over,
    };
    return { deps, appended };
  }

  it("appends the record of a run that planned a brief, as service:researcher with no suggestion and no chapter version, keyed by the workflow's step", async () => {
    const { deps, appended } = harness();
    expect(await recordResearch(RUN, { state: "DONE" }, deps)).toEqual({ seq: 7 });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ kind: "RESEARCH", actor: "service:researcher", suggestionId: null, chapterVersionId: null });
    expect(appended[0].payload).toMatchObject({ runId: RUN.id, planned: "brief", briefSha256: "d".repeat(64), findings: [{ ordinal: 1, outcome: "INVALID" }], models: { planner: "claude-haiku-4-5", reader: "claude-opus-5" }, searches: 1, pageReads: 1, end: { state: "DONE", code: null } });
    expect((appended[0].payload as { stepKey: string }).stepKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds the record a retried conclude already wrote, and writes nothing for a run that never planned or has no principal", async () => {
    const found = harness({ recordAt: async () => ({ seq: 3 }) });
    expect(await recordResearch(RUN, { state: "DONE" }, found.deps)).toEqual({ seq: 3 });
    expect(found.appended).toEqual([]);
    const never = harness();
    expect(await recordResearch({ ...RUN, briefSha256: null }, { state: "FAILED", failure: "RESEARCH_UNCONFIGURED" }, never.deps)).toBeNull();
    expect(await recordResearch({ ...RUN, briefSha256: null }, { state: "SKIPPED", skip: "TEXT_PURGED" }, never.deps)).toBeNull();
    expect(never.appended).toEqual([]);
    const unconfigured = harness({ principal: () => null });
    expect(await recordResearch(RUN, { state: "DONE" }, unconfigured.deps)).toBeNull();
    /* no workflow, no record: the step key was the workflow's, and a detached run has no message to stand in for it (45 § 3.5) */
    const unstarted = harness();
    expect(await recordResearch({ ...RUN, workflowId: null, messageId: null }, { state: "DONE" }, unstarted.deps)).toBeNull();
    expect(unstarted.appended).toEqual([]);
  });

  it("records a run that planned nothing with the planner alone", async () => {
    const { deps, appended } = harness({ readFindings: async () => [], calls: async () => [{ alias: "hb-small", modelId: "claude-haiku-4-5", outcome: "ok", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }] });
    expect(await recordResearch({ ...RUN, briefSha256: null, searches: 0, pageReads: 0 }, { state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" }, deps)).toEqual({ seq: 7 });
    expect(appended[0].payload).toMatchObject({ planned: "nothing", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null }, end: { state: "SKIPPED", code: "NOTHING_TO_RESEARCH" } });
    expect(plannedOf({ briefSha256: null }, { state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" })).toBe("nothing");
    expect(plannedOf({ briefSha256: "d".repeat(64) }, { state: "FAILED", failure: "READER_FAILED" })).toBe("brief");
    expect(plannedOf({ briefSha256: null }, { state: "DONE" })).toBeNull();
    expect(plannedOf({ briefSha256: null }, { state: "FAILED", failure: "PLANNER_FAILED" })).toBe("failed");
    expect(plannedOf({ briefSha256: null }, { state: "FAILED", failure: "BRIEF_QUESTION" })).toBe("failed");
    expect(plannedOf({ briefSha256: null }, { state: "FAILED", failure: "RESEARCH_UNCONFIGURED" })).toBeNull();
  });

  it("records a run whose planner was called and failed, or whose brief the sensor refused, as planned failed: the call was charged", async () => {
    const { deps, appended } = harness({ readFindings: async () => [], calls: async () => [{ alias: "hb-small", modelId: "claude-haiku-4-5", outcome: "ok", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }] });
    expect(await recordResearch({ ...RUN, briefSha256: null, searches: 0, pageReads: 0 }, { state: "FAILED", failure: "BRIEF_QUESTION" }, deps)).toEqual({ seq: 7 });
    expect(appended[0].payload).toMatchObject({ planned: "failed", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null }, findings: [], end: { state: "FAILED", code: "BRIEF_QUESTION" } });
  });
});
