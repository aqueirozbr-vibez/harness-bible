import { ApplicationFailure, condition, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";

import { PROVING_QUERY, PROVING_SIGNAL, ProvingInputSchema, type ProvingInput, type ProvingResult, type ProvingStage } from "@/lib/schemas/workflows";

import type { ProvingActivities } from "./activities";

/*
 * The proving workflow (feature-specs/28 § 4.5): it does nothing the product needs and everything a real workflow
 * will do. It checks its argument against the shared schema, runs an activity, waits on a signal with a timer
 * beside it, runs a second activity and returns, and says which of those it is doing to whoever asks. `npm run
 * workflows:check` starts one, and it stays in the repository as the engine's health check.
 */

/** § 4.5: "waits for the signal `proceed` or for a timer of one minute, whichever comes first". */
const WAIT_FOR_PROCEED = "1 minute";

/*
 * Two single-row reads. No spec gives them numbers, so both are the product's own for the same kind of thing: five
 * seconds is the deadline it already uses to ask whether another process is there (`/health`, feature-specs/11
 * § 7.2), and three attempts is the gateway client's default of two retries (11 § 5.3). Recorded in spec 28 § 12.
 */
const { currentReleaseId, ledgerHeadSeq } = proxyActivities<ProvingActivities>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 3 },
});

const proceed = defineSignal(PROVING_SIGNAL);
const stageQuery = defineQuery<ProvingStage>(PROVING_QUERY);

export async function ProvingWorkflow(input: ProvingInput): Promise<ProvingResult> {
  /* A thrown error that is not a failure of the engine's own kind would be retried forever as a broken task. */
  if (!ProvingInputSchema.safeParse(input).success) {
    throw ApplicationFailure.nonRetryable("ProvingWorkflow takes { token: uuid }", "WORKFLOW_INPUT");
  }

  let signalled = false;
  let stage: ProvingStage = "release";
  setHandler(proceed, () => {
    signalled = true;
  });
  setHandler(stageQuery, () => stage);

  const releaseId = await currentReleaseId();
  stage = "waiting";
  await condition(() => signalled, WAIT_FOR_PROCEED);
  stage = "head";
  const headSeq = await ledgerHeadSeq();
  stage = "done";
  return { releaseId, headSeq, signalled };
}
