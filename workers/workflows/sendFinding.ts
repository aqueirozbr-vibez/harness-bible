import { ActivityFailure, isCancellation, log, ParentClosePolicy, proxyActivities, sleep, startChild } from "@temporalio/workflow";

import { SuggestionIdSchema } from "@/lib/schemas/ids";
import { SendFindingWorkflowInputSchema, suggestionWorkflowId, type SendFindingWorkflowInput, type SendFindingWorkflowResult } from "@/lib/schemas/workflows";
import { nextOutcomesWaitMs, OUTCOMES_EVERY_MS, OUTCOMES_FOR_MS } from "@/workers/research/pace";

import type { SendFindingActivities } from "./activities";
import { SuggestionWorkflow } from "./suggestion";

/*
 * SendFindingWorkflow (feature-specs/48 § 8.4; unit 74), under `finding:<findingId>` on the research queue: a person's
 * finding sent to Improve as a researcher's proposal. Its argument is the finding's id and its asker's (invariant 35).
 *
 *   1. `sendFinding` (2 min × 3), as `service:researcher`: the finding claimed and the suggestion made in one
 *      transaction, or the code of why not written on the finding, which stays `VALID` — every end of it defined
 *      (workers/research/send.ts). The finding gone, used by another hand, failed or a duplicate ends the workflow here.
 *   2. The suggestion's own workflow as a child under `suggestion:<id>`, abandoned at this one's close, as the legacy run
 *      starts it: a curator's decision days later is still its to take. A child that could not be started is logged,
 *      and the wait below reads the suggestion as still deciding.
 *   3. Where the proposal stands, asked as `nextOutcomesWaitMs` paces it (`workers/research/pace.ts`, the legacy run's
 *      pacing moved unchanged) for at most `OUTCOMES_FOR_MS`, forty days: the finding becomes `PROPOSED` or `REFUTED`,
 *      and the ask that writes it ends the wait. A finding gone while it waits ends it; its child runs on. An ask that
 *      fails is asked again at the next, never the workflow's end.
 *
 * A cancellation (spec 46's erasure) ends it wherever it is, and nothing is owed: the workflow writes no record of its
 * own — the suggestion's `submitted` record is the record of the sending, and the asker's name joins the ledger only by
 * an endorsement. It is new, so it needs no `patched()`; it replays the pacing module, which unit 78 keeps for it.
 */

/* the send is idempotent on the row (a retry finds what an earlier attempt committed); the ask reads and writes one row */
const { sendFinding, findingOutcome } = proxyActivities<SendFindingActivities>({ startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 3 } });

export async function SendFindingWorkflow(rawInput: SendFindingWorkflowInput): Promise<SendFindingWorkflowResult> {
  const input = SendFindingWorkflowInputSchema.parse(rawInput);
  const finding = { findingId: input.findingId, userId: input.userId };
  const ended = (end: SendFindingWorkflowResult["end"], suggestionId: string | null = null, failure: SendFindingWorkflowResult["failure"] = null): SendFindingWorkflowResult => ({ findingId: finding.findingId, end, suggestionId: suggestionId === null ? null : SuggestionIdSchema.parse(suggestionId), failure });

  const sent = await sendFinding(finding);
  if (sent.sent === "gone") return ended("GONE");
  if (sent.sent === "used") return ended("USED");
  if (sent.sent === "failed") return ended("FAILED", null, sent.failure);
  if (sent.sent === "duplicate") return ended("DUPLICATE", sent.suggestionId);
  const { suggestionId } = sent;

  try {
    await startChild(SuggestionWorkflow, { workflowId: suggestionWorkflowId(suggestionId), args: [{ suggestionId: SuggestionIdSchema.parse(suggestionId) }], parentClosePolicy: ParentClosePolicy.ABANDON });
  } catch (error: unknown) {
    if (isCancellation(error)) throw error;
    log.warn("send finding: the suggestion's workflow could not be started", { findingId: finding.findingId, suggestionId });
  }

  const waitingSince = Date.now();
  let outcome: Awaited<ReturnType<SendFindingActivities["findingOutcome"]>>["outcome"] = "PENDING";
  const ask = async (): Promise<void> => {
    try {
      outcome = (await findingOutcome(finding)).outcome;
    } catch (error: unknown) {
      if (isCancellation(error) || !(error instanceof ActivityFailure)) throw error;
      log.warn("send finding: where the proposal stands could not be read, and is asked again", { findingId: finding.findingId });
    }
  };
  await ask();
  let every = OUTCOMES_EVERY_MS;
  while (outcome === "PENDING" && Date.now() - waitingSince < OUTCOMES_FOR_MS) {
    await sleep(every);
    await ask();
    every = nextOutcomesWaitMs(every, Date.now() - waitingSince);
  }
  log.info("send finding: outcome", { findingId: finding.findingId, outcome });
  return ended(outcome === "PENDING" ? "UNDECIDED" : outcome, suggestionId);
}
