import { defaultOutcomeStepDeps, defaultSendStepDeps, outcomeStep, sendStep, type OutcomeStepDeps, type SendStepDeps } from "@/workers/research/send";

import type { SendFindingActivities } from "../workflows/activities";

/*
 * SendFindingWorkflow's activities (feature-specs/48 § 8.4; unit 74): the send and the ask, each the step's own code in
 * workers/research/send.ts, by the finding's id and its asker's. The send is idempotent on the row: a retry after its
 * transaction committed finds the finding `SUBMITTED` with its suggestion and answers that, so the workflow starts the
 * suggestion's workflow once; a retry of the ask reads back the outcome an earlier attempt wrote. Neither writes a
 * ledger record: the suggestion's `submitted` record, `service:researcher`'s, is the record of the sending.
 */

export interface SendFindingActivityDeps {
  readonly send: SendStepDeps;
  readonly outcome: OutcomeStepDeps;
}

export function sendFindingActivities(deps: SendFindingActivityDeps = { send: defaultSendStepDeps(), outcome: defaultOutcomeStepDeps() }): SendFindingActivities {
  return {
    async sendFinding(finding) {
      const sent = await sendStep(finding, deps.send);
      console.info(`research finding ${finding.findingId}: ${sent.sent}${sent.sent === "failed" ? ` ${sent.failure}` : ""}`);
      return sent;
    },
    async findingOutcome(finding) {
      return { outcome: await outcomeStep(finding, deps.outcome) };
    },
  };
}

export const sendFindingActivitiesDefault: SendFindingActivities = sendFindingActivities();
