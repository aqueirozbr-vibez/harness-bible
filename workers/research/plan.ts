import { ApplicationFailure } from "@temporalio/activity";

import { currentRubricVersion } from "@/lib/db/improve";
import { readResearchCitations, readResearchSections, readResearchTurn, writeBudgetMark, type ResearchRunRow, type ResearchSection } from "@/lib/db/research";
import { env } from "@/lib/env";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuidePart, type Guide } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import { loadRubric } from "@/lib/rubrics/load";
import { principalOfId, type Principal } from "@/lib/schemas/gateway";
import type { Rubric } from "@/lib/schemas/rubric";
import { checkBrief } from "@/lib/sensors/brief";
import { defaultPlannerDeps, plan, type Planned, type PlannerDeps, type PlannerInput } from "@/workers/agents/researcher/planner";

/*
 * The planner's step of a run (feature-specs/41 § 5; unit 58c), the activity's own code: the turn and its citations
 * read inside the asker's context, the cited sections read at the run's release, the planner called once with the
 * planner part of the researcher's guide, and its brief checked by the brief sensor before anything else sees it.
 * What comes back to the activity is one of three: a brief, which the activity stores on the run with its hash; nothing
 * to research, which ends the run SKIPPED; or the cap, with the reset the run sleeps until and the `budget` mark
 * written so new turns are skipped meanwhile (40 § 7.2). Every failure is an `ApplicationFailure` with a code and no
 * text of the turn: `PLANNER_FAILED` for the agent's one failure, `BRIEF_<CHECK>` for the sensor's, `TEXT_PURGED`
 * where the purge took the turn between the load and the plan, `RESEARCH_UNCONFIGURED` without a principal. The
 * call is charged to the research principal and never to the asker (40 § 7.1).
 */

export const RESEARCHER_GUIDE_VERSION = "v1.0";

export type PlanStep = { readonly planned: "brief"; readonly brief: string; readonly briefSha256: string } | { readonly planned: "nothing" } | { readonly planned: "budget"; readonly resetsAt: string; readonly waitMs: number };

export interface PlanStepDeps {
  readonly principal: () => Principal | null;
  readonly guide: () => Guide;
  /** The rubric in force, for the tiers' letters; null before one is published. */
  readonly rubric: () => Promise<Pick<Rubric, "chips"> | null>;
  readonly readTurn: typeof readResearchTurn;
  readonly readCitations: typeof readResearchCitations;
  readonly readSections: (releaseId: string, anchors: ReadonlyArray<string>) => Promise<ReadonlyArray<ResearchSection>>;
  readonly plan: (input: Parameters<typeof plan>[0], deps: PlannerDeps) => Promise<Planned>;
  readonly planner: PlannerDeps;
  readonly writeBudgetMark: typeof writeBudgetMark;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

/** `RESEARCH_PRINCIPAL` as a principal (40 § 7.1); null while unset, so the activity can say the run is unconfigured rather than guess. */
export function researchPrincipalOf(value: string | undefined = env.RESEARCH_PRINCIPAL): Principal | null {
  return value === undefined ? null : principalOfId(value);
}

export function defaultPlanStepDeps(): PlanStepDeps {
  return {
    principal: () => researchPrincipalOf(),
    guide: () => loadGuidePart("researcher", RESEARCHER_GUIDE_VERSION, "planner"),
    rubric: currentRubric,
    readTurn: readResearchTurn,
    readCitations: readResearchCitations,
    readSections: readResearchSections,
    plan,
    planner: defaultPlannerDeps(),
    writeBudgetMark,
    log: (line) => console.info(line),
    now: () => new Date(),
  };
}

/** The published rubric in force now, by its row; null while none is published. */
export async function currentRubric(): Promise<Rubric | null> {
  const row = await currentRubricVersion();
  return row === null ? null : loadRubric(row.id).rubric;
}

function fail(type: string, message: string): never {
  throw ApplicationFailure.create({ type, message, nonRetryable: true });
}

export async function planStep(run: ResearchRunRow, deps: PlanStepDeps = defaultPlanStepDeps()): Promise<PlanStep> {
  const principal = deps.principal();
  if (principal === null) fail("RESEARCH_UNCONFIGURED", "RESEARCH_PRINCIPAL is not set: a run cannot call a model (feature-specs/40 § 7.1)");
  const turn = await deps.readTurn(run);
  if (turn === null || turn.question === null || turn.answer === null) fail("TEXT_PURGED", `research run ${run.id}: the turn's text is gone`);
  const [citations, sections, rubric] = await Promise.all([deps.readCitations(run), deps.readSections(run.releaseId, run.sectionAnchors), deps.rubric()]);
  const prompt: PlannerInput = {
    guide: deps.guide(),
    rubric,
    sections,
    claims: citations.map((citation) => ({ text: citation.claimText, sectionId: citation.sectionId, figureId: citation.figureId })),
    uncovered: turn.uncovered,
    question: turn.question,
    language: run.locale,
  };

  let planned: Planned;
  try {
    planned = await deps.plan({ prompt, call: { principal, traceId: run.traceId, ref: run.id } }, deps.planner);
  } catch (error: unknown) {
    if (!(error instanceof BudgetExceededError)) throw error;
    const now = deps.now();
    await deps.writeBudgetMark(now, error.resetsAt);
    deps.log(`research ${run.id}: the planner met the cap; waiting until ${error.resetsAt.toISOString()} (trace ${run.traceId})`);
    return { planned: "budget", resetsAt: error.resetsAt.toISOString(), waitMs: Math.max(0, error.resetsAt.getTime() - now.getTime()) };
  }
  if (!planned.ok) {
    deps.log(`research ${run.id}: the planner failed — ${planned.failure} (trace ${run.traceId})`);
    fail("PLANNER_FAILED", planned.failure);
  }
  if (!planned.output.research) {
    deps.log(`research ${run.id}: nothing to research (${planned.output.reason}; trace ${run.traceId})`);
    return { planned: "nothing" };
  }
  const verdict = checkBrief({ brief: planned.output.brief, targets: planned.output.targets, sections: run.sectionAnchors, question: turn.question });
  if (!verdict.ok) {
    deps.log(`research ${run.id}: the brief failed the ${verdict.check} check (trace ${run.traceId})`);
    fail(`BRIEF_${verdict.check}`, `the brief failed the ${verdict.check} check (feature-specs/41 § 5.3)`);
  }
  return { planned: "brief", brief: planned.output.brief, briefSha256: sha256Hex(planned.output.brief) };
}
