import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { contributorStandingOf, type ContributorStanding } from "@/lib/db/account";
import { resolveAnchor, type ResolvedAnchor } from "@/lib/db/anchors";
import { callerOf, createDraftFromFinding, currentRubricVersion, liveSuggestionWithKey, ownSuggestionStates, removeEvidenceItem, type FindingDraftInput, type ResearchSubmission, type RubricVersionRow } from "@/lib/db/improve";
import { claimFindingForDraft, clearFindingFailure, duplicateVisibleTo, readFindingForUse, sendsInMonth, type FindingClaimed, type FindingForUse } from "@/lib/db/research";
import { env } from "@/lib/env";
import type { Locale } from "@/lib/i18n/routing";
import { ownResource } from "@/lib/policy/input";
import { findingKeyOf, submissionOf } from "@/lib/research/submission";
import { findingUseOf } from "@/lib/research/runView";
import { loadRubric, type LoadedRubric } from "@/lib/rubrics/load";
import { ConversationParamsSchema, ResearchFindingDraftedSchema, ResearchFindingDraftSchema, ResearchFindingSendingSchema, ResearchFindingSendSchema, type ResearchFindingDrafted, type ResearchFindingSending } from "@/lib/schemas/api";
import { ITEMS_PER_SUGGESTION_MAX } from "@/lib/schemas/evidence";
import type { SuggestionState } from "@/lib/schemas/improve";
import { RESEARCH_SENDS_PER_MONTH, sendsMonthOf } from "@/lib/schemas/research";
import type { ReaderFinding } from "@/lib/schemas/researcher";
import { findingWorkflowId, GRADE_EVIDENCE_WORKFLOW, gradeEvidenceWorkflowId, SEND_FINDING_WORKFLOW } from "@/lib/schemas/workflows";
import { startWorkflow } from "@/lib/workflows/client";

import { DRAFTS_A_DAY, refuseIfThrottled, rubricInForce, SUBMISSIONS_A_DAY } from "./suggestions";

/*
 * A finding turned into an improvement (feature-specs/48 § 8, § 13; unit 74): one button a finding, by role (A4, A12).
 *
 * `POST /research/findings/{id}/draft` is a verified contributor's: the draft door's own gates — the role, the policy's
 * `create` on `suggestion` (verified), twenty drafts a day in `POST /api/v1/suggestions`'s bucket, so the cap counts
 * drafts whatever door made them — then the throttle, the finding (another's or none a 404, used a 409 with its use,
 * its run's text gone a 409), its anchor again at the current release (gone, a 422: the anchor's drift since the run),
 * the class and the key as a researcher's submission computes them (lib/research/submission.ts), no live suggestion
 * with that key (409, its id only where it is the caller's to see, § 8.5), and one transaction in which the finding
 * becomes `DRAFTED` and the draft is made with `fromResearch`, the proposal prefilled, the rationale empty — the
 * researcher's note is never copied into it, since the adjudicator reads a person's rationale (spec 42 § 3) — and one
 * pending `LINK` item a source. After the commit each item's grading starts on its own (`GradeEvidenceWorkflow`), on the
 * contributor's principal like any item they add; a start that fails removes its item and the draft stands, so the
 * draft answers no 503. 201 with the suggestion, its edit page and how many items it holds.
 *
 * `POST /research/findings/{id}/propose` is anyone else's: the policy's `submit` on `finding`, which refuses a verified
 * contributor (they draft); twenty a day in its own bucket, the shape of a person's submissions; the finding as above;
 * research proposals configured — the web tier reads only whether `RESEARCH_PRINCIPAL` is set, whose value the workers
 * charge — else 503; the anchor and the key as above; fewer than thirty sends in the caller's row of this calendar month
 * in UTC (D5), else 429 with the month's reset — a fast check, so the common case is refused before a workflow starts;
 * what holds under a burst of presses is the send's transaction, which takes the place atomically (lib/db/research.ts
 * `sendFindingTx`; review of unit 74); a failure an earlier send left cleared; and `SendFindingWorkflow` started under
 * `finding:<id>`. Nothing is claimed first: the finding stays `VALID` until the workflow's first step makes the
 * suggestion, so no crash between two writes leaves it claimed with nothing behind it, and a second press while the
 * workflow runs is handed the same run. 202 `SENDING`.
 *
 * Both keep their first answer for the same `Idempotency-Key` (`idempotent: "endpoint"`): a retry of a draft that was
 * made is the same draft, answered after the finding is looked up, so a research deleted since is a 404. Neither answer
 * holds an address or a word of the finding (§ 17.2).
 */

export interface ResearchFindingEndpointDeps {
  readonly finding: (user: SessionUser, findingId: string) => Promise<FindingForUse | null>;
  readonly standing: (user: SessionUser) => Promise<ContributorStanding>;
  readonly anchor: (kind: ResolvedAnchor["kind"], id: string, locale: Locale) => Promise<ResolvedAnchor | null>;
  readonly rubric: () => Promise<RubricVersionRow | null>;
  readonly loadRubric: (version: string) => LoadedRubric;
  /** A live suggestion with the proposal's key (§ 8.2 step 6): its id, or null. */
  readonly live: (user: SessionUser, proposalKey: string) => Promise<string | null>;
  /** Whether the caller may be told a suggestion's id (§ 8.5). */
  readonly visible: (user: SessionUser, suggestionId: string) => Promise<boolean>;
  /** The caller's own suggestions among some ids, with their states: a drafted finding's draft. */
  readonly ownStates: (user: SessionUser, ids: ReadonlyArray<string>) => Promise<ReadonlyMap<string, SuggestionState>>;
  /** The finding claimed and the draft made, in the asker's one transaction (§ 8.2 step 7). */
  readonly claim: (user: SessionUser, findingId: string, input: FindingDraftInput) => Promise<FindingClaimed>;
  readonly startGrading: (itemId: string) => Promise<void>;
  /** An item whose grading did not start, taken off the draft. */
  readonly removeItem: (user: SessionUser, suggestionId: string, itemId: string) => Promise<void>;
  /** Research proposals are configured here: the research principal is set (§ 8.3 step 3). */
  readonly configured: () => boolean;
  /** The caller's sends in a calendar month in UTC (`2026-10`), read off the month's counter (§ 8.3 step 5, D5). */
  readonly sentIn: (user: SessionUser, month: string) => Promise<number>;
  readonly clearFailure: (user: SessionUser, findingId: string) => Promise<void>;
  /** `SendFindingWorkflow` started under `finding:<id>`, or the run already there handed back. */
  readonly send: (findingId: string, userId: string) => Promise<void>;
  readonly now: () => Date;
}

export const defaultResearchFindingEndpointDeps: ResearchFindingEndpointDeps = {
  finding: readFindingForUse,
  standing: (user) => contributorStandingOf(user),
  anchor: (kind, id, locale) => resolveAnchor(kind, id, locale),
  rubric: () => currentRubricVersion(),
  loadRubric: (version) => loadRubric(version),
  live: (user, key) => liveSuggestionWithKey(callerOf(user), key),
  visible: duplicateVisibleTo,
  ownStates: (user, ids) => ownSuggestionStates(callerOf(user), ids),
  claim: (user, findingId, input) => claimFindingForDraft(user, findingId, (client) => createDraftFromFinding(callerOf(user), input, ITEMS_PER_SUGGESTION_MAX, client)),
  startGrading: async (itemId) => {
    await startWorkflow(GRADE_EVIDENCE_WORKFLOW, gradeEvidenceWorkflowId(itemId), { itemId });
  },
  removeItem: async (user, suggestionId, itemId) => {
    await removeEvidenceItem(callerOf(user), suggestionId, itemId);
  },
  configured: () => env.RESEARCH_PRINCIPAL !== undefined,
  sentIn: sendsInMonth,
  clearFailure: clearFindingFailure,
  send: async (findingId, userId) => {
    await startWorkflow(SEND_FINDING_WORKFLOW, findingWorkflowId(findingId), { findingId, userId });
  },
  now: () => new Date(),
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use a finding");
  return session;
}

/**
 * Why a finding that is not `VALID` cannot be used, as the person is told it (§ 8.2 step 3, § 8.3 step 2, § 16): 409
 * `FINDING_USED` with its use in the view's own words (`findingUseOf`: `SENT`, never the row's `SUBMITTED`) and the
 * suggestion's id where it is theirs to see; an invalid finding is never shown (A7), so it reads as absent, 404.
 */
async function usedRefusal(deps: ResearchFindingEndpointDeps, user: SessionUser, row: FindingForUse): Promise<ApiError> {
  if (row.outcome === "INVALID") return new ApiError("NOT_FOUND", "no such finding");
  const draft = row.outcome === "DRAFTED" && row.suggestionId !== null ? ((await deps.ownStates(user, [row.suggestionId])).get(row.suggestionId) ?? null) : null;
  const visible = row.outcome === "DUPLICATE" && row.suggestionId !== null && (await deps.visible(user, row.suggestionId));
  const use = findingUseOf({ id: row.id, outcome: row.outcome, suggestionId: row.suggestionId, failure: row.failure }, { draftState: draft, duplicateVisible: visible });
  return new ApiError("FINDING_USED", "this finding was already used", { use: use.state, suggestionId: use.suggestionId });
}

/**
 * The finding the caller may use, with what the reader wrote of it, or the refusal that says why not (§ 8.2 step 3,
 * § 8.3 step 2): another's or none, 404; used, 409 `FINDING_USED` (`usedRefusal`); its run's text gone, 409
 * `FINDING_PURGED`; a finding that no longer parses, possible only across a schema change, 422 naming `PARSE`, which
 * the block reads as `start a new research to look again`.
 */
async function usableFinding(deps: ResearchFindingEndpointDeps, user: SessionUser, findingId: string): Promise<{ readonly row: FindingForUse; readonly finding: ReaderFinding }> {
  const row = await deps.finding(user, findingId);
  if (row === null) throw new ApiError("NOT_FOUND", "no such finding");
  if (row.outcome !== "VALID") throw await usedRefusal(deps, user, row);
  if (row.text.kind === "purged" || row.locale === null) throw new ApiError("FINDING_PURGED", "this finding's text was removed after 30 days");
  if (row.text.kind === "unparsed") throw new ApiError("UNPROCESSABLE", "this finding can no longer be read: start a new research to look again", { failure: "PARSE" });
  return { row, finding: row.text.finding };
}

/** The finding's anchor at the current release (§ 8.2 step 4): gone is the anchor's drift since the run, a 422. */
async function anchorNow(deps: ResearchFindingEndpointDeps, row: FindingForUse, finding: ReaderFinding): Promise<ResolvedAnchor> {
  const resolved = await deps.anchor(finding.anchor.kind, finding.anchor.id, row.locale === "PT" ? "pt" : "en");
  if (resolved === null) throw new ApiError("ANCHOR_UNKNOWN", `${finding.anchor.id} is not in the pinned release any more: start a new research to look again`, { anchor: finding.anchor.id });
  return resolved;
}

/** No live suggestion with the key (§ 8.2 step 6, § 8.5): a 409 whose id is the caller's to see, or null. */
async function refuseDuplicate(deps: ResearchFindingEndpointDeps, user: SessionUser, proposalKey: string): Promise<void> {
  const same = await deps.live(user, proposalKey);
  if (same === null) return;
  throw new ApiError("PROPOSAL_DUPLICATE", "the same change is already proposed in Improve", { suggestionId: (await deps.visible(user, same)) ? same : null });
}

/** A draft's input from a finding's submission: everything but the note, which never becomes the rationale (spec 42 § 3), and what only a researcher's proposal takes. */
function draftInputOf(submission: ResearchSubmission): FindingDraftInput {
  const { chapterNumber, chapterVersionId, releaseId, parts, changeKind, changeClass, curatorReason, locale, rubricVersionId, anchor, proposal, proposalKey, sources } = submission;
  return { chapterNumber, chapterVersionId, releaseId, parts, changeKind, changeClass, curatorReason, locale, rubricVersionId, anchor, proposal, proposalKey, sources };
}

export function researchFindingEndpoints(deps: ResearchFindingEndpointDeps = defaultResearchFindingEndpointDeps): {
  readonly researchFindingDraft: Spec<typeof ConversationParamsSchema, undefined, typeof ResearchFindingDraftSchema, typeof ResearchFindingDraftedSchema>;
  readonly researchFindingPropose: Spec<typeof ConversationParamsSchema, undefined, typeof ResearchFindingSendSchema, typeof ResearchFindingSendingSchema>;
} {
  return {
    researchFindingDraft: {
      path: "/api/v1/research/findings/{id}/draft",
      method: "POST",
      summary: "Turn a finding of one's own research into a draft suggestion of one's own in Improve, its sources added as links and graded on one's own budget",
      auth: "session",
      role: "CONTRIBUTOR",
      params: ConversationParamsSchema,
      body: ResearchFindingDraftSchema,
      response: ResearchFindingDraftedSchema,
      /* the drafts' cap counts drafts whatever door made them (§ 8.2 step 1) */
      rateLimit: { ...DRAFTS_A_DAY, bucket: "/api/v1/suggestions" },
      idempotent: "endpoint",
      policy: { action: "create", resource: ({ session }) => ({ kind: "suggestion", id: null, ownerId: requireUser(session).id, origin: "HUMAN" }) },
      run: async ({ session, params, body, traceId, idempotency }) => {
        const user = requireUser(session);
        /* 2 the throttle, as the create endpoint refuses it */
        await refuseIfThrottled(deps, user);
        /* 3 the finding; then a retry of the same key answers the draft it made */
        const stored = idempotency?.replay ?? null;
        if (stored !== null) {
          if ((await deps.finding(user, params.id)) === null) throw new ApiError("NOT_FOUND", "no such finding");
          return new Response(JSON.stringify(stored.body), { status: stored.status, headers: JSON_HEADERS });
        }
        const { row, finding } = await usableFinding(deps, user, params.id);
        /* 4 the anchor at the current release; 5 the class and the key as a researcher's submission computes them */
        const resolved = await anchorNow(deps, row, finding);
        const { rubric } = await rubricInForce(deps);
        const locale = row.locale ?? "EN";
        const submission = submissionOf(finding, resolved, rubric.version, locale, deps.now());
        /* 6 no live suggestion with the key */
        await refuseDuplicate(deps, user, submission.proposalKey);
        /* 7 one transaction: the finding DRAFTED, the draft made with its items, the finding naming it */
        const claimed = await deps.claim(user, params.id, draftInputOf(submission));
        if (!claimed.claimed) {
          /* another hand used it since step 3 (a second press, a send's step): read again, and told as step 3 tells it (review of unit 74) */
          const now = await deps.finding(user, params.id);
          if (now === null) throw new ApiError("NOT_FOUND", "no such finding");
          throw await usedRefusal(deps, user, now);
        }
        /* 8 each item graded on its own; a start that fails takes its item off, and the draft stands */
        let items = 0;
        for (const itemId of claimed.items) {
          try {
            await deps.startGrading(itemId);
            items += 1;
          } catch (error: unknown) {
            console.warn("draft from a finding: a grading did not start, its item removed", traceId, claimed.suggestionId, itemId, error instanceof Error ? error.message : String(error));
            await deps.removeItem(user, claimed.suggestionId, itemId).catch((undo: unknown) => console.error("draft from a finding: an item whose grading did not start was not removed", traceId, itemId, undo instanceof Error ? undo.message : String(undo)));
          }
        }
        /* 9 no address in the answer, so the stored copy holds none */
        const answer: ResearchFindingDrafted = { suggestionId: claimed.suggestionId, href: `/${body.locale}/improve/${claimed.suggestionId}/edit`, items };
        await idempotency?.complete(201, answer);
        return new Response(JSON.stringify(ResearchFindingDraftedSchema.parse(answer)), { status: 201, headers: JSON_HEADERS });
      },
    },

    researchFindingPropose: {
      path: "/api/v1/research/findings/{id}/propose",
      method: "POST",
      summary: "Send a finding of one's own research to Improve as a researcher's proposal; Improve opens its sources, grades them, and a curator decides",
      auth: "session",
      params: ConversationParamsSchema,
      body: ResearchFindingSendSchema,
      response: ResearchFindingSendingSchema,
      /* twenty a day in its own bucket, the shape of a person's submissions (§ 8.3 step 1) */
      rateLimit: SUBMISSIONS_A_DAY,
      idempotent: "endpoint",
      policy: { action: "submit", resource: ({ session, params }) => ownResource("finding", params.id, requireUser(session)) },
      run: async ({ session, params, idempotency }) => {
        const user = requireUser(session);
        /* 2 the finding; then a retry of the same key answers its stored start */
        const stored = idempotency?.replay ?? null;
        if (stored !== null) {
          if ((await deps.finding(user, params.id)) === null) throw new ApiError("NOT_FOUND", "no such finding");
          return new Response(JSON.stringify(stored.body), { status: stored.status, headers: JSON_HEADERS });
        }
        const { row, finding } = await usableFinding(deps, user, params.id);
        /* 3 research proposals configured: their vetting is the platform's (§ 7.3) */
        if (!deps.configured()) throw new ApiError("RESEARCH_UNAVAILABLE", "research proposals are not configured here");
        /* 4 the anchor and the key */
        const resolved = await anchorNow(deps, row, finding);
        await refuseDuplicate(deps, user, findingKeyOf(finding, resolved));
        /* 5 the month's sends (D5): the counter's row, a fast check; the send's transaction takes the place atomically */
        const month = sendsMonthOf(deps.now());
        if ((await deps.sentIn(user, month.month)) >= RESEARCH_SENDS_PER_MONTH) throw new ApiError("RESEARCH_SENDS_LIMIT", `${String(RESEARCH_SENDS_PER_MONTH)} findings were sent this month`, { resetsAt: month.resetsAt.toISOString() });
        /* 6 a failure an earlier send left, cleared before the start, so a quick new failure is not erased after it */
        await deps.clearFailure(user, params.id);
        /* 7 the start: nothing claimed first; the engine refusing is a 503 and nothing changed */
        await deps.send(params.id, user.id);
        const answer: ResearchFindingSending = { findingId: params.id, use: "SENDING" };
        await idempotency?.complete(202, answer);
        return new Response(JSON.stringify(ResearchFindingSendingSchema.parse(answer)), { status: 202, headers: JSON_HEADERS });
      },
    },
  };
}

/** The endpoints as the routes serve them. */
export const { researchFindingDraft, researchFindingPropose } = researchFindingEndpoints();
