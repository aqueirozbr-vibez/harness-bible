import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ResearchRunRow } from "@/lib/db/research";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuidePart } from "@/lib/guides/load";
import type { ReaderFinding } from "@/lib/schemas/researcher";
import type { Read } from "@/workers/agents/researcher/reader";

import { readStep, type ReadStepDeps } from "./read";

/*
 * The reader's step (feature-specs/41 § 6; unit 58d), the rows and the agent doubled: the reader is given the brief,
 * today, the cited sections and the rubric and nothing of the turn; what it found is left on the run with the pages
 * seen and the counts, and the workflow learns the count; the cap writes the budget mark; a failure has its code.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");
const BRIEF = "Look for the current recommended practice on idempotency keys.";
const RUN: ResearchRunRow = { id: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", organisationId: null, releaseId: "2026.09", locale: "EN", state: "READING", skip: null, failure: null, gap: true, sectionAnchors: ["21.3", "21.4"], questionSha256: "e".repeat(64), briefSha256: "d".repeat(64), searches: 0, pageReads: 0, workflowId: "research:44444444-4444-4444-8444-444444444444", traceId: "f".repeat(32), textPurgedAt: null, createdAt: new Date("2026-10-10T12:00:00.000Z") };
const FINDING: ReaderFinding = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "A claim.", placeAfter: "end", fastMoving: true }, sources: [{ url: "https://standards.example/keys" }], note: "The standard says so." };

function harness(answer: Read | Error, over: Partial<ReadStepDeps> = {}) {
  const found: Array<Parameters<ReadStepDeps["writeFound"]>> = [];
  const counted: Array<{ searches: number; pageReads: number }> = [];
  const marks: Array<{ at: Date; until: Date }> = [];
  const calls: Array<Parameters<ReadStepDeps["read"]>[0]> = [];
  const logged: string[] = [];
  const deps: ReadStepDeps = {
    principal: () => ({ organisationId: "org-research" }),
    guide: () => loadGuidePart("researcher", "v1.0", "reader"),
    rubric: async () => null,
    readBrief: async () => BRIEF,
    readSections: async (_release, anchors) => anchors.map((id) => ({ id, chapter: 21, version: "v1.0.0", title: `Section ${id}`, text: "Text.", verifiedOn: NOW, figures: [], rows: [] })),
    read: async (input) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    reader: { gateway: {} as ReadStepDeps["reader"]["gateway"] },
    writeFound: async (...args) => {
      found.push(args);
      return { written: true };
    },
    writeCounts: async (_run, counts) => {
      counted.push(counts);
    },
    writeBudgetMark: async (at, until) => {
      marks.push({ at, until });
    },
    log: (line) => logged.push(line),
    now: () => NOW,
    ...over,
  };
  return { deps, found, counted, marks, calls, logged };
}

const answered = (findings: ReadonlyArray<ReaderFinding>): Read => ({ ok: true, output: { findings: [...findings] }, model: "claude-opus-5", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 }, promptSha256: "a".repeat(64), searches: 2, fetches: 1, pages: ["https://standards.example/keys", "https://forum.example/t/1"], continuations: 0 });

async function failureOf(promise: Promise<unknown>): Promise<{ type: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApplicationFailure) return { type: error.type ?? undefined, message: error.message };
    throw error;
  }
  throw new Error("did not fail");
}

describe("readStep", () => {
  it("gives the reader the brief, today, the cited sections and the rubric — and no field for the turn — charged to the research principal under the run's trace and id", async () => {
    const { deps, calls, found, counted } = harness(answered([FINDING]));
    expect(await readStep(RUN, deps)).toEqual({ findings: 1, searches: 2, pageReads: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].call).toEqual({ principal: { organisationId: "org-research" }, traceId: RUN.traceId, ref: RUN.id });
    expect(Object.keys(calls[0].prompt).sort()).toEqual(["brief", "guide", "rubric", "sections", "today"]);
    expect(calls[0].prompt).toMatchObject({ brief: BRIEF, today: "2026-10-10" });
    expect(calls[0].prompt.sections.map((section) => section.id)).toEqual(["21.3", "21.4"]);
    /* what it found stays on the run, with the pages seen; the counts are written first, on their own */
    expect(found).toEqual([[RUN, { findings: [FINDING], pages: ["https://standards.example/keys", "https://forum.example/t/1"] }]]);
    expect(counted).toEqual([{ searches: 2, pageReads: 1 }]);
  });

  it("leaves an empty list on the run as a good outcome", async () => {
    const { deps, found } = harness(answered([]));
    expect(await readStep(RUN, deps)).toEqual({ findings: 0, searches: 2, pageReads: 1 });
    expect(found[0]?.[1]).toEqual({ findings: [], pages: ["https://standards.example/keys", "https://forum.example/t/1"] });
  });

  it("fails READER_FAILED on the agent's one failure, writing nothing; TEXT_PURGED where the brief is gone; RESEARCH_UNCONFIGURED without a principal", async () => {
    const failing = harness({ ok: false, failure: "the reader's output is not JSON", model: "claude-opus-5", usage: null, promptSha256: "a".repeat(64), searches: 3, fetches: 2, pages: [], continuations: 1 });
    expect(await failureOf(readStep(RUN, failing.deps))).toEqual({ type: "READER_FAILED", message: "the reader's output is not JSON" });
    expect(failing.found).toEqual([]);
    /* the searches the provider ran before the failure were charged: the run keeps their count */
    expect(failing.counted).toEqual([{ searches: 3, pageReads: 2 }]);
    const purgedMeanwhile = harness(answered([FINDING]), { writeFound: async () => ({ written: false }) });
    expect((await failureOf(readStep(RUN, purgedMeanwhile.deps))).type).toBe("TEXT_PURGED");
    /* purged, or its conversation deleted, while the reader ran: the run still says what the provider charged (45 § 3.5) */
    expect(purgedMeanwhile.counted).toEqual([{ searches: 2, pageReads: 1 }]);
    const purged = harness(answered([]), { readBrief: async () => null });
    expect((await failureOf(readStep(RUN, purged.deps))).type).toBe("TEXT_PURGED");
    expect(purged.calls).toHaveLength(0);
    const unconfigured = harness(answered([]), { principal: () => null });
    expect((await failureOf(readStep(RUN, unconfigured.deps))).type).toBe("RESEARCH_UNCONFIGURED");
  });

  it("at the cap, writes the budget mark until the reset and says how long to wait (40 § 7.2)", async () => {
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    const { deps, marks, found } = harness(new BudgetExceededError(resetsAt, "Budget has been exceeded!"));
    expect(await readStep(RUN, deps)).toEqual({ planned: "budget", resetsAt: resetsAt.toISOString(), waitMs: resetsAt.getTime() - NOW.getTime() });
    expect(marks).toEqual([{ at: NOW, until: resetsAt }]);
    expect(found).toEqual([]);
  });
});
