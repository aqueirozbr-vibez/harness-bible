import { researchSuggestionStates, type ServiceCaller } from "@/lib/db/improve";
import { readFindings, writeFinding, type ResearchRunRow } from "@/lib/db/research";
import type { Decision, SuggestionState } from "@/lib/schemas/improve";

import { outcomeOfState } from "./pace";

/*
 * Proposed or refuted (feature-specs/42 § 5; unit 59c), the activity's own code: for each finding that became a
 * suggestion, where that suggestion stands now, as `service:researcher` reads it — closed is a refutation, whatever
 * closed it (a sensor, the floor, a request for more nobody could answer, the adjudicator's or a curator's decline);
 * the curator queue, a merge under way or done is a proposal — and the finding's row written with the outcome. A
 * suggestion still deciding leaves its finding `SUBMITTED` and the workflow asks again later. The ids are the asker's
 * own findings'; the suggestions' rows say nothing of them. What a place means for a finding is `outcomeOfState`, in
 * ./pace.ts since unit 74 (feature-specs/48 § 8.4), which `SendFindingWorkflow`'s step reads too.
 */

const RESEARCHER: ServiceCaller = { kind: "service", id: "service:researcher" };

export interface OutcomeCounts {
  readonly pending: number;
  readonly proposed: number;
  readonly refuted: number;
}

export interface OutcomesStepDeps {
  readonly readFindings: typeof readFindings;
  readonly states: (ids: ReadonlyArray<string>) => Promise<ReadonlyArray<{ readonly id: string; readonly state: SuggestionState; readonly outcome: Decision | null }>>;
  readonly writeFinding: typeof writeFinding;
}

export function defaultOutcomesStepDeps(): OutcomesStepDeps {
  return { readFindings, states: (ids) => researchSuggestionStates(RESEARCHER, ids), writeFinding };
}

export async function outcomesStep(run: ResearchRunRow, deps: OutcomesStepDeps = defaultOutcomesStepDeps()): Promise<OutcomeCounts> {
  const findings = await deps.readFindings(run);
  const submitted = findings.filter((finding) => finding.outcome === "SUBMITTED" && finding.suggestionId !== null);
  const states = new Map((await deps.states(submitted.map((finding) => finding.suggestionId ?? ""))).map((row) => [row.id, row]));
  const counts = { pending: 0, proposed: findings.filter((finding) => finding.outcome === "PROPOSED").length, refuted: findings.filter((finding) => finding.outcome === "REFUTED").length };
  for (const finding of submitted) {
    const row = states.get(finding.suggestionId ?? "");
    const outcome = row === undefined ? null : outcomeOfState(row.state, row.outcome);
    if (outcome === null) {
      counts.pending += 1;
      continue;
    }
    await deps.writeFinding(run, { ordinal: finding.ordinal, outcome, invalidReason: null, suggestionId: finding.suggestionId });
    if (outcome === "PROPOSED") counts.proposed += 1;
    else counts.refuted += 1;
  }
  return counts;
}
