import { describe, expect, it } from "vitest";

import type { TimedResearchCallRow } from "@/lib/db/budget";
import type { ConversationRunRow } from "@/lib/db/research";
import { stepKeyOf } from "@/lib/ledger/hash";
import { ResearchPayloadSchema } from "@/lib/schemas/ledger";
import { parseSectionId } from "@/lib/schemas/ids";

import { recordPersonRun, reportSha256Of, type PersonRecordDeps } from "./record";

/*
 * A person's run's `RESEARCH` record (feature-specs/48 § 15; unit 70b), the ledger and the rows doubled: signed by the
 * person, `user:<id>`, with no suggestion and no chapter version; its calls read under the person's own principal; the
 * writer named apart from the reader; the report's hash of its canonical form; written once by its step key; none for a
 * run that has no workflow or that no planner answered.
 */

const WRITING = new Date("2026-10-12T10:05:00.000Z");
const RUN = { id: "33333333-3333-4333-8333-333333333333", userId: "55555555-5555-4555-8555-555555555555", organisationId: null, conversationId: "44444444-4444-4444-8444-444444444444", ordinal: 1, releaseId: "2026.09", locale: "EN", state: "DONE", skip: null, failure: null, refusal: null, gap: false, sectionAnchors: ["21.3", "21.4"], targetAnchors: ["21.3"], questionSha256: "e".repeat(64), briefSha256: "d".repeat(64), searches: 2, pageReads: 1, workflowId: "research:33333333-3333-4333-8333-333333333333", traceId: "f".repeat(32), textPurgedAt: null, writingAt: WRITING, budgetResetsAt: null, createdAt: new Date("2026-10-12T10:00:00.000Z") } satisfies ConversationRunRow;
const CALLS: ReadonlyArray<TimedResearchCallRow> = [
  { alias: "hb-small", modelId: "claude-haiku-4-5", outcome: "ok", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, createdAt: new Date("2026-10-12T10:01:00.000Z") },
  { alias: "hb-frontier", modelId: "claude-opus-5", outcome: "ok", inputTokens: 20_000, outputTokens: 1_500, cacheReadTokens: 2_000, createdAt: new Date("2026-10-12T10:03:00.000Z") },
  { alias: "hb-frontier", modelId: "claude-opus-5-writer", outcome: "ok", inputTokens: 4_000, outputTokens: 600, cacheReadTokens: 0, createdAt: new Date("2026-10-12T10:05:30.000Z") },
];
const REPORT = { paragraphs: [{ text: "The pages read give 48 hours [1].", sections: [parseSectionId("21.3")], pages: [1] }], dropped: {} };

function harness(over: Partial<PersonRecordDeps> = {}) {
  const appended: Array<Parameters<PersonRecordDeps["append"]>[0]> = [];
  const principals: unknown[] = [];
  const deps: PersonRecordDeps = {
    guide: () => ({ version: "v2.0", sha256: "a".repeat(64) }),
    readFindings: async () => [{ ordinal: 1, outcome: "VALID" }],
    readReport: async () => REPORT,
    calls: async (principal) => {
      principals.push(principal);
      return CALLS;
    },
    recordAt: async () => null,
    append: (async (input: Parameters<PersonRecordDeps["append"]>[0]) => {
      appended.push(input);
      return { seq: 42 };
    }) as unknown as PersonRecordDeps["append"],
    log: () => undefined,
    ...over,
  };
  return { deps, appended, principals };
}

describe("recordPersonRun", () => {
  it("appends one record signed by the person, of no suggestion, naming the conversation, the three models and the report's hash, its calls read under the person's principal", async () => {
    const run = harness();
    expect(await recordPersonRun(RUN, { state: "DONE" }, run.deps)).toEqual({ seq: 42 });
    expect(run.principals).toEqual([{ userId: RUN.userId }]);
    expect(run.appended).toHaveLength(1);
    const [record] = run.appended;
    expect(record).toMatchObject({ kind: "RESEARCH", actor: `user:${RUN.userId}`, suggestionId: null, chapterVersionId: null });
    const payload = ResearchPayloadSchema.parse(record?.payload);
    expect(payload).toMatchObject({ stepKey: stepKeyOf(RUN.workflowId, "research:1"), runId: RUN.id, conversationId: RUN.conversationId, questionSha256: RUN.questionSha256, reportSha256: reportSha256Of(REPORT), models: { planner: "claude-haiku-4-5", reader: "claude-opus-5", writer: "claude-opus-5-writer" }, refusal: null, end: { state: "DONE", code: null } });
  });

  it("hashes the report's canonical form, so its keys' order changes nothing", () => {
    expect(reportSha256Of({ dropped: {}, paragraphs: [{ pages: [1], sections: [parseSectionId("21.3")], text: "The pages read give 48 hours [1]." }] })).toBe(reportSha256Of(REPORT));
  });

  it("finds the record a retried conclude already wrote, and writes none for a run with no workflow or that no planner answered", async () => {
    const again = harness({ recordAt: async () => ({ seq: 7 }) });
    expect(await recordPersonRun(RUN, { state: "DONE" }, again.deps)).toEqual({ seq: 7 });
    expect(again.appended).toEqual([]);
    const unstarted = harness();
    expect(await recordPersonRun({ ...RUN, workflowId: null }, { state: "DONE" }, unstarted.deps)).toBeNull();
    const capped = harness({ calls: async () => [{ ...CALLS[0], modelId: "hb-small", outcome: "budget" }], readReport: async () => null, readFindings: async () => [] });
    expect(await recordPersonRun({ ...RUN, briefSha256: null, writingAt: null }, { state: "SKIPPED", skip: "BUDGET" }, capped.deps)).toBeNull();
    expect(capped.appended).toEqual([]);
  });
});
