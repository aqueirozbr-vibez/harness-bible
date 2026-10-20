import { resolveAnchor } from "@/lib/db/anchors";
import { createFromResearch, currentRubricVersion, researchSuggestionStates, type ResearchCreated, type ResearchSubmission, type ServiceCaller } from "@/lib/db/improve";
import { readFindingToSend, sendFindingTx, writeFindingFailure, writeFindingOutcome, type FindingForUse, type FindingRef, type FindingSent } from "@/lib/db/research";
import { env } from "@/lib/env";
import { submissionOf } from "@/lib/research/submission";
import type { Decision, SuggestionState } from "@/lib/schemas/improve";
import type { FindingFailure } from "@/lib/schemas/research";

import { outcomeOfState } from "./pace";

/*
 * A person's finding sent to Improve (feature-specs/48 § 8.4; unit 74), the activities' own code: `sendStep`, which
 * claims the finding and makes the researcher's proposal in one transaction, or writes on the finding why it could not;
 * and `outcomeStep`, which asks where the proposal stands and writes the finding's outcome once Improve has placed it.
 * Both run as `service:researcher` against the improvement rows and inside the asker's own tenant context for the
 * finding, by the ids the workflow was given (invariant 35); nothing they answer is text.
 *
 * Every way the send can end is defined, in this order:
 *   - the finding gone (its research's run swept, the account erased): `gone`, nothing written;
 *   - not `VALID`: `SUBMITTED` with its suggestion is an earlier attempt's, whose child is still to start; anything
 *     else is `used`, by another hand;
 *   - its run's text gone (a delete or the 30 days since the press): `TEXT_PURGED`;
 *   - no research principal in the workers (a deployment whose workers and web tier disagree): `RESEARCH_UNCONFIGURED`,
 *     since the suggestion's grading and adjudication are the platform's (§ 7.3);
 *   - no rubric in force: `NO_RUBRIC`;
 *   - a finding that no longer parses, possible only across a schema change: `PARSE`;
 *   - its anchor gone, a release published between the press and the step: `ANCHOR_UNKNOWN`;
 *   - otherwise one transaction (`sendFindingTx`): `SUBMITTED` with its `sentAt` and the new suggestion, a place taken
 *     in the month's thirty, or `DUPLICATE` with the one it doubles, which takes none; a finding that moved meanwhile is
 *     read again and goes on as above;
 *   - the month's thirty taken by the time that transaction ran (D5; review of unit 74): it is rolled back, nothing
 *     made, and `SENDS_LIMIT`.
 * Each failure leaves the finding `VALID` with its code, which the block turns into its line (§ 8.1).
 *
 * The suggestion is spec 42's researcher proposal in every respect: origin `RESEARCHER`, no owner, the note as its
 * rationale and kept from the adjudicator, one pending `LINK` item per source, which the product's fetcher opens again.
 */

export const RESEARCHER: ServiceCaller = { kind: "service", id: "service:researcher" };

export type SendStep =
  | { readonly sent: "gone" }
  | { readonly sent: "used" }
  | { readonly sent: "failed"; readonly failure: FindingFailure }
  | { readonly sent: "submitted"; readonly suggestionId: string }
  | { readonly sent: "duplicate"; readonly suggestionId: string };

export interface SendStepDeps {
  readonly read: typeof readFindingToSend;
  /** Whether the workers hold a research principal (`RESEARCH_PRINCIPAL`), which pays the proposal's vetting (§ 7.3). */
  readonly principal: () => boolean;
  readonly rubricVersion: () => Promise<string | null>;
  readonly anchor: typeof resolveAnchor;
  readonly fail: typeof writeFindingFailure;
  /** The finding's claim, the door's create and the row naming what it made, in one transaction. */
  readonly send: (ref: FindingRef, at: Date, input: ResearchSubmission) => Promise<FindingSent>;
  readonly now: () => Date;
}

export function defaultSendStepDeps(): SendStepDeps {
  return {
    read: readFindingToSend,
    /* its value is the workers' to charge (lib/env.ts checks its form); here only whether it is set */
    principal: () => env.RESEARCH_PRINCIPAL !== undefined,
    rubricVersion: async () => (await currentRubricVersion())?.id ?? null,
    anchor: resolveAnchor,
    fail: writeFindingFailure,
    send: (ref, at, input) => sendFindingTx(ref, at, (client): Promise<ResearchCreated> => createFromResearch(RESEARCHER, input, client)),
    now: () => new Date(),
  };
}

/** A finding that is no longer `VALID`, as it stands: what an earlier attempt made, or used by another hand. */
function standing(finding: FindingForUse): SendStep {
  if (finding.outcome === "SUBMITTED" && finding.suggestionId !== null) return { sent: "submitted", suggestionId: finding.suggestionId };
  return { sent: "used" };
}

export async function sendStep(ref: FindingRef, deps: SendStepDeps = defaultSendStepDeps()): Promise<SendStep> {
  const finding = await deps.read(ref);
  if (finding === null) return { sent: "gone" };
  if (finding.outcome !== "VALID") return standing(finding);
  const failed = async (failure: FindingFailure): Promise<SendStep> => {
    await deps.fail(ref, failure);
    return { sent: "failed", failure };
  };
  if (finding.text.kind === "purged" || finding.locale === null) return failed("TEXT_PURGED");
  if (!deps.principal()) return failed("RESEARCH_UNCONFIGURED");
  const rubricVersionId = await deps.rubricVersion();
  if (rubricVersionId === null) return failed("NO_RUBRIC");
  if (finding.text.kind === "unparsed") return failed("PARSE");
  const written = finding.text.finding;
  const resolved = await deps.anchor(written.anchor.kind, written.anchor.id, finding.locale === "PT" ? "pt" : "en");
  if (resolved === null) return failed("ANCHOR_UNKNOWN");
  const now = deps.now();
  const sent = await deps.send(ref, now, submissionOf(written, resolved, rubricVersionId, finding.locale, now));
  /* the month's thirty taken by the time the transaction ran: it made nothing (D5; review of unit 74) */
  if (sent.sent === "limited") return failed("SENDS_LIMIT");
  if (sent.sent !== "moved") return sent;
  /* another hand moved it between the read and the claim: read again, and go on as above */
  const again = await deps.read(ref);
  return again === null ? { sent: "gone" } : standing(again);
}

/** Where a sent finding stands now (§ 8.4 step 3): Improve's place written as its outcome, still deciding, or gone. */
export type OutcomeStep = "PENDING" | "PROPOSED" | "REFUTED" | "GONE";

export interface OutcomeStepDeps {
  readonly read: typeof readFindingToSend;
  readonly states: (ids: ReadonlyArray<string>) => Promise<ReadonlyArray<{ readonly id: string; readonly state: SuggestionState; readonly outcome: Decision | null }>>;
  readonly write: typeof writeFindingOutcome;
}

export function defaultOutcomeStepDeps(): OutcomeStepDeps {
  return { read: readFindingToSend, states: (ids) => researchSuggestionStates(RESEARCHER, ids), write: writeFindingOutcome };
}

/**
 * The finding's suggestion asked where it stands, as `service:researcher` reads it (`outcomeOfState`, ./pace.ts): the
 * queue, a merge under way or done is `PROPOSED`; closed, whatever closed it, is `REFUTED` — and a refuted finding a
 * delete detached is deleted with the write (`writeFindingOutcome`); still deciding is `PENDING`. A finding gone, or one
 * that is no longer a sent one waiting, ends the wait: `GONE`. A retried ask after the write reads the outcome back.
 */
export async function outcomeStep(ref: FindingRef, deps: OutcomeStepDeps = defaultOutcomeStepDeps()): Promise<OutcomeStep> {
  const finding = await deps.read(ref);
  if (finding === null) return "GONE";
  if (finding.outcome === "PROPOSED" || finding.outcome === "REFUTED") return finding.outcome;
  if (finding.outcome !== "SUBMITTED" || finding.suggestionId === null) return "GONE";
  const [row] = await deps.states([finding.suggestionId]);
  const outcome = row === undefined ? null : outcomeOfState(row.state, row.outcome);
  if (outcome !== "PROPOSED" && outcome !== "REFUTED") return "PENDING";
  if ((await deps.write(ref, outcome)) !== "unchanged") return outcome;
  /* moved between the read and the write: a retried ask that wrote it, or a sweep that took it */
  const after = await deps.read(ref);
  return after !== null && (after.outcome === "PROPOSED" || after.outcome === "REFUTED") ? after.outcome : "GONE";
}
