import { ApplicationFailure } from "@temporalio/activity";

import { readEarlierRuns, readResearchSections, readRunQuestion, readRunSeed, type ConversationRunRow, type ResearchSection } from "@/lib/db/research";
import { defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { rerank } from "@/lib/gateway/rerank";
import { loadGuidePart, type Guide } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import type { Principal } from "@/lib/schemas/gateway";
import { ReleaseIdSchema } from "@/lib/schemas/ids";
import type { PlannerRefusal } from "@/lib/schemas/research";
import { RESEARCHER_GUIDE_VERSION } from "@/lib/schemas/researcher";
import type { Rubric } from "@/lib/schemas/rubric";
import { searchRelease } from "@/lib/search/hybrid";
import { retrieve, type RetrieveRequest } from "@/lib/search/retrieve";
import { withoutRedactionMarks } from "@/lib/security/redact";
import { checkBrief } from "@/lib/sensors/brief";
import { defaultPlannerDeps, earlierQuestionsRead, plan, type PlanInput, type PlannerContext, type PlannerDeps, type PlannerInput, type Planned } from "@/workers/agents/researcher/v2/planner";
import { embedQuery } from "@/workers/embed";
import { currentRubric } from "@/workers/research/plan";

/*
 * The plan of a person's run (feature-specs/48 § 5.3; unit 70b), the activity's own code: the run's sections, the
 * planner called once, its brief checked by the brief sensor before anything else sees it. The sections are at most
 * ten: a seeded first run's are the seed answer's cited sections, then retrieval's for the question as stored, since
 * the person may have edited the question toward another part of the book (A6); a follow-up's are retrieval's with the
 * previous run's targets placed first where retrieval did not return them; a run from scratch's are retrieval's. The
 * Assistant's retrieval, unchanged, in `explain` mode with no context, on the person's principal, its two calls naming
 * the run's id as their `ref`; a refusal of either half degrades to the lexical order, as it does for the Assistant.
 *
 * What comes back is one of four: a brief, with its hash, the targets and the sections, which the activity stores; a
 * refusal by the planner (`NOT_ABOUT_THE_BOOK` is `R-SCOPE`, `PERSONAL` is `R-PERSONAL`); the person's cap, with its
 * reset (`SKIPPED · BUDGET`); or the gateway's refusal before the provider saw the call (`SKIPPED · UNAVAILABLE`). The
 * sections come back with each, so the refusal's card can point at the run's first two (§ 5.3). Every failure is an
 * `ApplicationFailure` with a code and no text: `TEXT_PURGED` where the question or the seed is gone,
 * `PLANNER_FAILED` for the agent's one failure, `BRIEF_<CHECK>` for the sensor's. Nothing here reads
 * `RESEARCH_PRINCIPAL`: a person's run is charged to the person (48 § 7.1).
 */

/* the guide's version is the schema's, which the Research page's header names too (feature-specs/48 § 11.3) */
export const RESEARCHER_V2_GUIDE_VERSION = RESEARCHER_GUIDE_VERSION;
/** The run's sections, at most ten: retrieval's eight re-ranked and the two a question names (48 § 5.3; lib/search/retrieve.ts). */
export const RUN_SECTIONS_MAX = 10;

/** Whose budget a person's run spends (48 § 7.1): their organisation's, or their own on an individual account, as their Assistant turn does. */
export function principalOfRun(run: Pick<ConversationRunRow, "userId" | "organisationId">): Principal {
  return run.organisationId === null ? { userId: run.userId } : { organisationId: run.organisationId };
}

/**
 * The run's sections (48 § 5.3), pure: the seed's cited sections first, then the previous run's targets that
 * retrieval did not return, then retrieval's, each once, at most ten. A run is only one of seeded, a follow-up and
 * from scratch, so at most one of the first two is given.
 */
export function runSectionsOf(input: { readonly retrieved: ReadonlyArray<string>; readonly seed: ReadonlyArray<string>; readonly previousTargets: ReadonlyArray<string> }): ReadonlyArray<string> {
  const retrieved = new Set(input.retrieved);
  return [...new Set([...input.seed, ...input.previousTargets.filter((target) => !retrieved.has(target)), ...input.retrieved])].slice(0, RUN_SECTIONS_MAX);
}

export type PlanRunStep =
  | { readonly planned: "brief"; readonly brief: string; readonly briefSha256: string; readonly targets: ReadonlyArray<string>; readonly sections: ReadonlyArray<string> }
  | { readonly planned: "refused"; readonly refusal: PlannerRefusal; readonly sections: ReadonlyArray<string> }
  | { readonly planned: "budget"; readonly resetsAt: Date; readonly sections: ReadonlyArray<string> }
  | { readonly planned: "unavailable"; readonly sections: ReadonlyArray<string> };

export interface PlanRunDeps {
  readonly guide: () => Guide;
  /** The rubric in force, for the tiers' letters; null before one is published. */
  readonly rubric: () => Promise<Pick<Rubric, "chips"> | null>;
  readonly readQuestion: typeof readRunQuestion;
  readonly readSeed: typeof readRunSeed;
  readonly readEarlier: typeof readEarlierRuns;
  /** The Assistant's retrieval, as the sections it hands over, in its order. */
  readonly retrieve: (request: RetrieveRequest) => Promise<ReadonlyArray<string>>;
  readonly readSections: (releaseId: string, anchors: ReadonlyArray<string>) => Promise<ReadonlyArray<ResearchSection>>;
  readonly plan: (input: PlanInput, deps: PlannerDeps) => Promise<Planned>;
  readonly planner: PlannerDeps;
  readonly log: (line: string) => void;
}

/** Retrieval through the workers' own gateway: the query embedding and the re-rank, both on the request's principal and `ref`. */
export function retrieveSections(gateway: GatewayDeps = defaultGatewayDeps()): (request: RetrieveRequest) => Promise<ReadonlyArray<string>> {
  return async (request) => {
    const retrieved = await retrieve(request, { embed: (call, text) => embedQuery(call, text, gateway), rerank: (call, input) => rerank(call, input, gateway), search: searchRelease });
    return retrieved.sections.map((section) => section.sectionId);
  };
}

export function defaultPlanRunDeps(): PlanRunDeps {
  return {
    guide: () => loadGuidePart("researcher", RESEARCHER_V2_GUIDE_VERSION, "planner"),
    rubric: currentRubric,
    readQuestion: readRunQuestion,
    readSeed: readRunSeed,
    readEarlier: readEarlierRuns,
    retrieve: retrieveSections(),
    readSections: readResearchSections,
    plan,
    planner: defaultPlannerDeps(),
    log: (line) => console.info(line),
  };
}

function fail(type: string, message: string): never {
  throw ApplicationFailure.create({ type, message, nonRetryable: true });
}

export async function planRunStep(run: ConversationRunRow, deps: PlanRunDeps = defaultPlanRunDeps()): Promise<PlanRunStep> {
  const question = await deps.readQuestion(run);
  if (question === null) fail("TEXT_PURGED", `research run ${run.id}: the question is gone`);
  const seed = await deps.readSeed(run);
  if (seed === "gone") fail("TEXT_PURGED", `research run ${run.id}: the answer it was seeded from is gone`);
  const earlier = await deps.readEarlier(run);
  const principal = principalOfRun(run);
  /* the question without the marks a redaction left, as the Assistant retrieves (feature-specs/21 § 6.2) */
  const retrieved = await deps.retrieve({ releaseId: ReleaseIdSchema.parse(run.releaseId), question: withoutRedactionMarks(question) || question, mode: "explain", context: { chapter: null, section: null }, principal, traceId: run.traceId, ref: run.id });
  const sections = runSectionsOf({ retrieved, seed: seed?.cited ?? [], previousTargets: earlier.at(-1)?.targetAnchors ?? [] });
  const [rendered, rubric] = await Promise.all([deps.readSections(run.releaseId, sections), deps.rubric()]);
  /* slots 4 and 5: a seeded first run reads its seed, a follow-up the earlier questions and briefs, never a report */
  const context: PlannerContext =
    seed !== null
      ? { kind: "seeded", claims: seed.claims, uncovered: seed.uncovered }
      : earlier.length > 0
        ? { kind: "followUp", earlier: earlier.flatMap((before) => (before.question === null ? [] : [{ question: before.question, brief: before.brief }])) }
        : { kind: "scratch" };
  const prompt: PlannerInput = { guide: deps.guide(), rubric, language: run.locale, sections: rendered, context, question };

  let planned: Planned;
  try {
    planned = await deps.plan({ prompt, call: { principal, traceId: run.traceId, ref: run.id } }, deps.planner);
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) {
      deps.log(`research ${run.id}: the planner met the person's cap; the run ends, resets ${error.resetsAt.toISOString()} (trace ${run.traceId})`);
      return { planned: "budget", resetsAt: error.resetsAt, sections };
    }
    if (error instanceof GatewayUnavailableError) {
      deps.log(`research ${run.id}: the gateway refused the planner before the provider saw it (${error.cause}; trace ${run.traceId})`);
      return { planned: "unavailable", sections };
    }
    throw error;
  }
  if (!planned.ok) {
    deps.log(`research ${run.id}: the planner failed — ${planned.failure} (trace ${run.traceId})`);
    fail("PLANNER_FAILED", planned.failure);
  }
  if (!planned.output.research) {
    deps.log(`research ${run.id}: refused by the planner (${planned.output.reason}; trace ${run.traceId})`);
    return { planned: "refused", refusal: planned.output.reason === "PERSONAL" ? "R-PERSONAL" : "R-SCOPE", sections };
  }
  const verdict = checkBrief({ brief: planned.output.brief, targets: planned.output.targets, sections, question, earlierQuestions: earlierQuestionsRead(prompt) });
  if (!verdict.ok) {
    deps.log(`research ${run.id}: the brief failed the ${verdict.check} check (trace ${run.traceId})`);
    fail(`BRIEF_${verdict.check}`, `the brief failed the ${verdict.check} check (feature-specs/48 § 5.3)`);
  }
  return { planned: "brief", brief: planned.output.brief, briefSha256: sha256Hex(planned.output.brief), targets: [...new Set(planned.output.targets.map((target) => target.section))], sections };
}
