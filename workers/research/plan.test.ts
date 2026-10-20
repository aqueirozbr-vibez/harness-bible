import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ResearchRunRow } from "@/lib/db/research";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuidePart } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import type { Planned } from "@/workers/agents/researcher/planner";

import { planStep, researchPrincipalOf, type PlanStepDeps } from "./plan";

/*
 * The planner's step (feature-specs/41 § 5, § 11.5; unit 58c), the rows and the agent doubled: a plan of nothing ends
 * the step with nothing and no brief; a brief passes the sensor and comes back with its hash; a brief that copies the
 * question is the sensor's failure, named by its check and holding none of the text; the cap writes the budget mark
 * and says how long to wait; a run without a principal, or whose text the purge took, fails with its code.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z");
const QUESTION = "Why does a retried write without an idempotency key become a second write?";
const BRIEF = "Look for the current recommended practice on idempotency keys and their retention window, and whether a revision changes the figures the section cites.";
const RUN: ResearchRunRow = { id: "33333333-3333-4333-8333-333333333333", messageId: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", organisationId: null, releaseId: "2026.09", locale: "EN", state: "PLANNING", skip: null, failure: null, gap: true, sectionAnchors: ["21.3"], questionSha256: "e".repeat(64), briefSha256: null, searches: 0, pageReads: 0, workflowId: "research:44444444-4444-4444-8444-444444444444", traceId: "f".repeat(32), textPurgedAt: null, createdAt: new Date("2026-10-10T12:00:00.000Z") };

function harness(answer: Planned | Error, over: Partial<PlanStepDeps> = {}) {
  const marks: Array<{ at: Date; until: Date }> = [];
  const logged: string[] = [];
  const calls: Array<Parameters<PlanStepDeps["plan"]>[0]> = [];
  const deps: PlanStepDeps = {
    principal: () => ({ organisationId: "org-research" }),
    guide: () => loadGuidePart("researcher", "v1.0", "planner"),
    rubric: async () => null,
    readTurn: async () => ({ question: QUESTION, answer: "A retried write without a key is a second write.", uncovered: [{ sectionId: "21.3", text: "Refunds too." }], retrievedSections: ["21.3", "21.4"] }),
    readCitations: async () => [{ sectionId: "21.3", figureId: null, claimText: "A retried write without a key is a second write." }],
    readSections: async () => [{ id: "21.3", chapter: 21, version: "v1.0.0", title: "Idempotency keys", text: "A retried write without a key is a second write.", verifiedOn: NOW, figures: [], rows: [] }],
    plan: async (input) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    planner: { gateway: {} as PlanStepDeps["planner"]["gateway"] },
    writeBudgetMark: async (at, until) => {
      marks.push({ at, until });
    },
    log: (line) => logged.push(line),
    now: () => NOW,
    ...over,
  };
  return { deps, marks, logged, calls };
}

const answered = (output: Extract<Planned, { ok: true }>["output"]): Planned => ({ ok: true, output, model: "claude-haiku-4-5", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }, promptSha256: "a".repeat(64) });

async function failureOf(promise: Promise<unknown>): Promise<{ type: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApplicationFailure) return { type: error.type ?? undefined, message: error.message };
    throw error;
  }
  throw new Error("did not fail");
}

describe("planStep", () => {
  it("gives the planner exactly the turn's side of things — the question, the claims, the uncovered sentences, the sections, the language — charged to the research principal under the run's trace and id", async () => {
    const { deps, calls } = harness(answered({ research: false, reason: "COVERED" }));
    expect(await planStep(RUN, deps)).toEqual({ planned: "nothing" });
    expect(calls).toHaveLength(1);
    expect(calls[0].call).toEqual({ principal: { organisationId: "org-research" }, traceId: RUN.traceId, ref: RUN.id });
    expect(calls[0].prompt).toMatchObject({ question: QUESTION, language: "EN", claims: [{ text: "A retried write without a key is a second write.", sectionId: "21.3", figureId: null }], uncovered: [{ sectionId: "21.3", text: "Refunds too." }] });
    expect(calls[0].prompt.sections.map((section) => section.id)).toEqual(["21.3"]);
    expect(Object.keys(calls[0].prompt).sort()).toEqual(["claims", "guide", "language", "question", "rubric", "sections", "uncovered"]);
  });

  it("returns a brief that passes the sensor with its hash", async () => {
    const { deps } = harness(answered({ research: true, brief: BRIEF, targets: [{ section: "21.3", intent: "UPDATE" }] }));
    expect(await planStep(RUN, deps)).toEqual({ planned: "brief", brief: BRIEF, briefSha256: sha256Hex(BRIEF) });
  });

  it("fails BRIEF_QUESTION on a brief that copies the question, BRIEF_TARGET on a target the answer did not cite, with nothing of the text", async () => {
    const leak = harness(answered({ research: true, brief: `${BRIEF} The reader asked: ${QUESTION}`, targets: [{ section: "21.3", intent: "UPDATE" }] }));
    const failed = await failureOf(planStep(RUN, leak.deps));
    expect(failed.type).toBe("BRIEF_QUESTION");
    expect(failed.message).not.toContain("retried");
    expect(leak.logged.join("\n")).not.toContain("retried");
    const elsewhere = harness(answered({ research: true, brief: BRIEF, targets: [{ section: "22.1", intent: "GAP" }] }));
    expect((await failureOf(planStep(RUN, elsewhere.deps))).type).toBe("BRIEF_TARGET");
  });

  it("fails PLANNER_FAILED on the agent's one failure, and TEXT_PURGED or RESEARCH_UNCONFIGURED before any call", async () => {
    const failing = harness({ ok: false, failure: "the planner's output is not JSON", model: "claude-haiku-4-5", usage: null, promptSha256: "a".repeat(64) });
    expect(await failureOf(planStep(RUN, failing.deps))).toEqual({ type: "PLANNER_FAILED", message: "the planner's output is not JSON" });
    const purged = harness(answered({ research: false, reason: "COVERED" }), { readTurn: async () => ({ question: null, answer: null, uncovered: [], retrievedSections: [] }) });
    expect((await failureOf(planStep(RUN, purged.deps))).type).toBe("TEXT_PURGED");
    expect(purged.calls).toHaveLength(0);
    const unconfigured = harness(answered({ research: false, reason: "COVERED" }), { principal: () => null });
    expect((await failureOf(planStep(RUN, unconfigured.deps))).type).toBe("RESEARCH_UNCONFIGURED");
    expect(unconfigured.calls).toHaveLength(0);
  });

  it("at the cap, writes the budget mark until the reset and says how long to wait (40 § 7.2)", async () => {
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    const { deps, marks } = harness(new BudgetExceededError(resetsAt, "Budget has been exceeded!"));
    expect(await planStep(RUN, deps)).toEqual({ planned: "budget", resetsAt: resetsAt.toISOString(), waitMs: resetsAt.getTime() - NOW.getTime() });
    expect(marks).toEqual([{ at: NOW, until: resetsAt }]);
  });

  it("reads the research principal as org:<id>, null while unset", () => {
    expect(researchPrincipalOf("org:abc")).toEqual({ organisationId: "abc" });
    expect(researchPrincipalOf(undefined)).toBeNull();
  });
});
