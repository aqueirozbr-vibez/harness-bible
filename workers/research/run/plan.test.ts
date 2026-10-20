import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ConversationRunRow, ResearchSection } from "@/lib/db/research";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { loadGuidePart } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import type { Planned } from "@/workers/agents/researcher/v2/planner";

import { planRunStep, principalOfRun, runSectionsOf, type PlanRunDeps } from "./plan";

/*
 * The plan of a person's run (feature-specs/48 § 5.3; unit 70b), the rows, retrieval and the agent doubled: the run's
 * sections from the seed, the previous targets and retrieval, at most ten; retrieval on the person's principal with the
 * run's id as its `ref`; the planner's slots by the kind of run — a seed's claims, a follow-up's earlier questions and
 * briefs and never a report, nothing for a run from scratch; its two refusals; the cap and the gateway's refusal; the
 * brief held to the run's sections and to every question it read; the text gone before any call.
 */

const NOW = new Date("2026-10-12T12:00:00.000Z");
const QUESTION = "Why does a retried write without an idempotency key become a second write?";
const BRIEF = "Look for the current recommended practice on idempotency keys and their retention window, and whether a revision changes the figures the section cites.";
const RUN: ConversationRunRow = {
  id: "33333333-3333-4333-8333-333333333333",
  userId: "55555555-5555-4555-8555-555555555555",
  organisationId: null,
  conversationId: "44444444-4444-4444-8444-444444444444",
  ordinal: 1,
  releaseId: "2026.09",
  locale: "PT",
  state: "PLANNING",
  skip: null,
  failure: null,
  refusal: null,
  gap: false,
  sectionAnchors: [],
  targetAnchors: [],
  questionSha256: "e".repeat(64),
  briefSha256: null,
  searches: 0,
  pageReads: 0,
  workflowId: "research:33333333-3333-4333-8333-333333333333",
  traceId: "f".repeat(32),
  textPurgedAt: null,
  writingAt: null,
  budgetResetsAt: null,
  createdAt: NOW,
};
const section = (id: string): ResearchSection => ({ id, chapter: Number(id.slice(0, 2)), version: "v1.0.0", title: `Section ${id}`, text: `The prose of ${id}.`, verifiedOn: NOW, figures: [], rows: [] });

function harness(answer: Planned | Error, over: Partial<PlanRunDeps> = {}) {
  const calls: Array<Parameters<PlanRunDeps["plan"]>[0]> = [];
  const retrieved: Array<Parameters<PlanRunDeps["retrieve"]>[0]> = [];
  const deps: PlanRunDeps = {
    guide: () => loadGuidePart("researcher", "v2.0", "planner"),
    rubric: async () => null,
    readQuestion: async () => QUESTION,
    readSeed: async () => null,
    readEarlier: async () => [],
    retrieve: async (request) => {
      retrieved.push(request);
      return ["21.4", "21.3", "20.2"];
    },
    readSections: async (_releaseId, anchors) => anchors.map(section),
    plan: async (input) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    planner: { gateway: {} as PlanRunDeps["planner"]["gateway"] },
    log: () => undefined,
    ...over,
  };
  return { deps, calls, retrieved };
}

const answered = (output: Extract<Planned, { ok: true }>["output"]): Planned => ({ ok: true, output, model: "claude-haiku-4-5", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }, promptSha256: "a".repeat(64) });
const brief = (targets: ReadonlyArray<string> = ["21.3"]) => answered({ research: true, brief: BRIEF, targets: targets.map((target) => ({ section: target, intent: "UPDATE" as const })) });

async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApplicationFailure) return error.type ?? undefined;
    throw error;
  }
  throw new Error("did not fail");
}

describe("runSectionsOf (48 § 5.3)", () => {
  it("puts a seed's sections first, then retrieval's; a follow-up's previous targets first where retrieval did not return them; each once, at most ten", () => {
    expect(runSectionsOf({ retrieved: ["21.4", "21.3"], seed: ["21.3", "20.1"], previousTargets: [] })).toEqual(["21.3", "20.1", "21.4"]);
    expect(runSectionsOf({ retrieved: ["21.4", "21.3"], seed: [], previousTargets: ["21.3", "19.2"] })).toEqual(["19.2", "21.4", "21.3"]);
    const twelve = Array.from({ length: 12 }, (_, index) => `${String(10 + index)}.1`);
    expect(runSectionsOf({ retrieved: twelve, seed: [], previousTargets: [] })).toEqual(twelve.slice(0, 10));
  });

  it("charges an individual's run to them and a member's to their organisation (48 § 7.1)", () => {
    expect(principalOfRun(RUN)).toEqual({ userId: RUN.userId });
    expect(principalOfRun({ ...RUN, organisationId: "org-1" })).toEqual({ organisationId: "org-1" });
  });
});

describe("planRunStep", () => {
  it("retrieves on the person's principal with the run's id as ref, and plans a run from scratch on retrieval's sections, the language and the question alone", async () => {
    const { deps, calls, retrieved } = harness(brief(["21.3"]));
    expect(await planRunStep(RUN, deps)).toEqual({ planned: "brief", brief: BRIEF, briefSha256: sha256Hex(BRIEF), targets: ["21.3"], sections: ["21.4", "21.3", "20.2"] });
    expect(retrieved).toEqual([{ releaseId: "2026.09", question: QUESTION, mode: "explain", context: { chapter: null, section: null }, principal: { userId: RUN.userId }, traceId: RUN.traceId, ref: RUN.id }]);
    expect(calls[0].call).toEqual({ principal: { userId: RUN.userId }, traceId: RUN.traceId, ref: RUN.id });
    expect(calls[0].prompt).toMatchObject({ language: "PT", question: QUESTION, context: { kind: "scratch" } });
    expect(calls[0].prompt.sections.map((one) => one.id)).toEqual(["21.4", "21.3", "20.2"]);
  });

  it("retrieves with the question's redaction marks taken out, as the Assistant does", async () => {
    const { deps, calls, retrieved } = harness(brief(), { readQuestion: async () => "Is [redacted:api-key] safe to retry?" });
    await planRunStep(RUN, deps);
    expect(retrieved[0].question).toBe("Is safe to retry?");
    expect(calls[0].prompt.question).toBe("Is [redacted:api-key] safe to retry?");
  });

  it("gives a seeded first run the seed's claims and uncovered sentences and its cited sections first", async () => {
    const seed = { claims: [{ text: "A retried write without a key is a second write.", sectionId: "20.1", figureId: null }], uncovered: [{ sectionId: "20.1", text: "Refunds too." }], cited: ["20.1"] };
    const { deps, calls } = harness(brief(["20.1"]), { readSeed: async () => seed });
    expect(await planRunStep(RUN, deps)).toMatchObject({ planned: "brief", targets: ["20.1"], sections: ["20.1", "21.4", "21.3", "20.2"] });
    expect(calls[0].prompt.context).toEqual({ kind: "seeded", claims: seed.claims, uncovered: seed.uncovered });
  });

  it("gives a follow-up the earlier questions and briefs, never a report, its previous targets among its sections, and holds the brief to every earlier question", async () => {
    const earlier = [{ ordinal: 1, question: "How long should an idempotency key be kept after the first response arrives?", brief: "Look for the retention window.", report: { paragraphs: [{ text: "The pages read give 24 hours.", sections: [], pages: [1] }], dropped: {} }, targetAnchors: ["19.2"] }];
    const { deps, calls } = harness(brief(["19.2"]), { readEarlier: async () => earlier as never });
    expect(await planRunStep({ ...RUN, ordinal: 2 }, deps)).toMatchObject({ planned: "brief", sections: ["19.2", "21.4", "21.3", "20.2"] });
    expect(calls[0].prompt.context).toEqual({ kind: "followUp", earlier: [{ question: earlier[0].question, brief: "Look for the retention window." }] });
    expect(JSON.stringify(calls[0].prompt)).not.toContain("24 hours");
    const copied = harness(answered({ research: true, brief: `${BRIEF} How long should an idempotency key be kept?`, targets: [{ section: "21.3", intent: "UPDATE" }] }), { readEarlier: async () => earlier as never });
    expect(await failureOf(planRunStep({ ...RUN, ordinal: 2 }, copied.deps))).toBe("BRIEF_QUESTION");
  });

  it("answers the planner's two refusals as their causes, R-SCOPE and R-PERSONAL, with the run's sections", async () => {
    expect(await planRunStep(RUN, harness(answered({ research: false, reason: "NOT_ABOUT_THE_BOOK" })).deps)).toEqual({ planned: "refused", refusal: "R-SCOPE", sections: ["21.4", "21.3", "20.2"] });
    expect(await planRunStep(RUN, harness(answered({ research: false, reason: "PERSONAL" })).deps)).toMatchObject({ planned: "refused", refusal: "R-PERSONAL" });
  });

  it("answers the person's cap with its reset, and the gateway's refusal before the provider saw the call as unavailable (48 § 5.3, § 7.2)", async () => {
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    expect(await planRunStep(RUN, harness(new BudgetExceededError(resetsAt, "Budget has been exceeded!")).deps)).toMatchObject({ planned: "budget", resetsAt });
    expect(await planRunStep(RUN, harness(new GatewayUnavailableError("no_key", "no key for the principal")).deps)).toMatchObject({ planned: "unavailable" });
  });

  it("fails PLANNER_FAILED on the agent's one failure, BRIEF_TARGET on a target that is not a run's section, and TEXT_PURGED before any call where the question or the seed is gone", async () => {
    expect(await failureOf(planRunStep(RUN, harness({ ok: false, failure: "the planner's output is not JSON", model: null, usage: null, promptSha256: "a".repeat(64) }).deps))).toBe("PLANNER_FAILED");
    expect(await failureOf(planRunStep(RUN, harness(brief(["22.1"])).deps))).toBe("BRIEF_TARGET");
    const gone = harness(brief(), { readQuestion: async () => null });
    expect(await failureOf(planRunStep(RUN, gone.deps))).toBe("TEXT_PURGED");
    expect(gone.calls).toEqual([]);
    const seedGone = harness(brief(), { readSeed: async () => "gone" });
    expect(await failureOf(planRunStep(RUN, seedGone.deps))).toBe("TEXT_PURGED");
    expect(seedGone.retrieved).toEqual([]);
  });
});
