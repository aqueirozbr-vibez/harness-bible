import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ConversationRunRow, ResearchSection } from "@/lib/db/research";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuidePart } from "@/lib/guides/load";
import type { ResearchFound } from "@/lib/schemas/researcher";
import type { Read } from "@/workers/agents/researcher/v2/reader";

import { readRunStep, type ReadRunDeps } from "./read";

/*
 * The read of a person's run (feature-specs/48 § 5.4; unit 70b), the rows and the agent doubled: the targets' sections
 * and the brief, the reader on the person's principal with the run's id as `ref` and its blocks handed to the live
 * steps; `found` with the notes and the pages read, after the steps' chain settled; the counts written whatever the
 * turn ended as — at the person's cap read from the error, before the agent's failure — and the text gone; and a
 * cancellation, whose signal goes with the reader's call and after which nothing is written (48 § 5.1).
 */

const NOW = new Date("2026-10-12T12:00:00.000Z");
const RUN = { id: "33333333-3333-4333-8333-333333333333", userId: "55555555-5555-4555-8555-555555555555", organisationId: "org-1", conversationId: "44444444-4444-4444-8444-444444444444", ordinal: 1, releaseId: "2026.09", locale: "EN", state: "READING", skip: null, failure: null, refusal: null, gap: false, sectionAnchors: ["21.3", "21.4"], targetAnchors: ["21.4"], questionSha256: "e".repeat(64), briefSha256: "d".repeat(64), searches: 0, pageReads: 0, workflowId: "research:33333333-3333-4333-8333-333333333333", traceId: "f".repeat(32), textPurgedAt: null, writingAt: null, budgetResetsAt: null, createdAt: NOW } satisfies ConversationRunRow;
const section = (id: string): ResearchSection => ({ id, chapter: 21, version: "v1.0.0", title: `Section ${id}`, text: `The prose of ${id}.`, verifiedOn: NOW, figures: [], rows: [] });
const PAGE = { url: "https://standards.example/keys", title: "Keys", opened: true, search: 1 };

function harness(answer: Read | Error, over: Partial<ReadRunDeps> = {}) {
  const order: string[] = [];
  const counts: Array<{ searches: number; pageReads: number }> = [];
  const found: ResearchFound[] = [];
  const calls: Array<Parameters<ReadRunDeps["read"]>[0]> = [];
  const deps: ReadRunDeps = {
    guide: () => loadGuidePart("researcher", "v2.0", "reader"),
    rubric: async () => null,
    readBrief: async () => "Look for the retention window.",
    readSections: async (_releaseId, anchors) => anchors.map(section),
    read: async (input) => {
      calls.push(input);
      input.onBlock?.({ type: "text", text: "" } as never);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    reader: { gateway: {} as ReadRunDeps["reader"]["gateway"] },
    writeFound: async (_run, written) => {
      order.push("found");
      found.push(written);
      return { written: true };
    },
    writeCounts: async (_run, written) => {
      order.push("counts");
      counts.push(written);
    },
    log: () => undefined,
    now: () => NOW,
    ...over,
  };
  const blocks: unknown[] = [];
  const steps = {
    onBlock: (block: unknown) => {
      blocks.push(block);
    },
    settled: async () => {
      order.push("settled");
    },
  };
  return { deps, steps, order, counts, found, calls, blocks };
}

const answered = (over: Partial<Extract<Read, { ok: true }>> = {}): Read => ({ ok: true, output: { findings: [{ x: 1 }], notes: [{ url: PAGE.url, says: "A note." }] }, model: "claude-opus-5", usage: null, promptSha256: "a".repeat(64), searches: 2, fetches: 1, pages: [PAGE.url], read: [PAGE], continuations: 0, ...over });

async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApplicationFailure) return error.type ?? undefined;
    throw error;
  }
  throw new Error("did not fail");
}

describe("readRunStep", () => {
  it("reads the targets' sections and the brief on the person's principal, hands the blocks to the steps, and stores found — the findings, the notes, the pages and the pages read — after the counts and the chain", async () => {
    const run = harness(answered());
    expect(await readRunStep(RUN, run.steps, run.deps)).toEqual({ read: "found", findings: 1, searches: 2, pageReads: 1 });
    expect(run.calls[0].call).toEqual({ principal: { organisationId: "org-1" }, traceId: RUN.traceId, ref: RUN.id });
    expect(run.calls[0].prompt).toMatchObject({ brief: "Look for the retention window.", today: "2026-10-12" });
    expect(run.calls[0].prompt.sections.map((one) => one.id)).toEqual(["21.4"]);
    expect(run.blocks).toHaveLength(1);
    expect(run.order).toEqual(["counts", "settled", "found"]);
    expect(run.found).toEqual([{ findings: [{ x: 1 }], pages: [PAGE.url], notes: [{ url: PAGE.url, says: "A note." }], read: [PAGE] }]);
  });

  it("at the person's cap, writes the counts the turn had before it and answers the reset (48 § 5.4, § 7.2)", async () => {
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    const run = harness(new BudgetExceededError(resetsAt, "Budget has been exceeded!"));
    expect(await readRunStep(RUN, run.steps, run.deps)).toEqual({ read: "budget", resetsAt, searches: 0, pageReads: 0 });
    expect(run.counts).toEqual([{ searches: 0, pageReads: 0 }]);
    expect(run.found).toEqual([]);
  });

  it("fails READER_FAILED after writing what the provider charged, and TEXT_PURGED where the brief is gone or found could not be stored", async () => {
    const failing = harness({ ok: false, failure: "the turn was left unfinished", model: null, usage: null, promptSha256: "a".repeat(64), searches: 3, fetches: 2, pages: [], read: [], continuations: 2 });
    expect(await failureOf(readRunStep(RUN, failing.steps, failing.deps))).toBe("READER_FAILED");
    expect(failing.counts).toEqual([{ searches: 3, pageReads: 2 }]);
    const gone = harness(answered(), { readBrief: async () => null });
    expect(await failureOf(readRunStep(RUN, gone.steps, gone.deps))).toBe("TEXT_PURGED");
    expect(gone.calls).toEqual([]);
    const purged = harness(answered(), { writeFound: async () => ({ written: false }) });
    expect(await failureOf(readRunStep(RUN, purged.steps, purged.deps))).toBe("TEXT_PURGED");
  });

  it("hands the reader the activity's signal, and once it fired writes neither the counts nor found, failing CANCELLED, whatever the reader answered (48 § 5.1; review of unit 70)", async () => {
    const controller = new AbortController();
    /* a reader that answers after the run was cancelled, as a stream past its abort would */
    const late = harness(answered(), {
      read: async (input) => {
        late.calls.push(input);
        controller.abort();
        return answered();
      },
    });
    expect(await failureOf(readRunStep(RUN, late.steps, late.deps, controller.signal))).toBe("CANCELLED");
    expect(late.calls[0].signal).toBe(controller.signal);
    expect(late.order).toEqual([]);
    /* at the person's cap after the cancellation: no counts either */
    const capped = new AbortController();
    const atCap = harness(new BudgetExceededError(new Date("2026-11-01T00:00:00.000Z"), "Budget has been exceeded!"), {
      read: async () => {
        capped.abort();
        throw new BudgetExceededError(new Date("2026-11-01T00:00:00.000Z"), "Budget has been exceeded!");
      },
    });
    expect(await failureOf(readRunStep(RUN, atCap.steps, atCap.deps, capped.signal))).toBe("CANCELLED");
    expect(atCap.counts).toEqual([]);
  });
});
