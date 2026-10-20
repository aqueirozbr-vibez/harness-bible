import { ApiError } from "@/lib/api/errors";
import { recordConsent } from "@/lib/api/endpoints/suggestions";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { callerOf, readProposalsForAsker, type ProposalPlace } from "@/lib/db/improve";
import { view } from "@/lib/db/ledger";
import { askerOfProposal, readEndorsement, removeEndorsement, writeEndorsement, type EndorsementRow } from "@/lib/db/research";
import type { PolicyResource } from "@/lib/policy/input";
import { EndorseBodySchema, EndorsementSchema, ProposalParamsSchema, type Endorsement } from "@/lib/schemas/api";
import { SUGGESTION_ENDORSED_SIGNAL, SUGGESTION_WORKFLOW, type EndorsedSignal } from "@/lib/schemas/workflows";
import { signalWorkflow, WorkflowNotFoundError } from "@/lib/workflows/client";

/*
 * A reader's name on a research proposal (feature-specs/42 § 6; 43 § 5.1; unit 59d). The reader who asked — whatever
 * their role, with no identity check — puts their name to a proposal that came from one of their runs, and takes it back
 * until the merge. The policy's `endorse` on the kind `proposal` names them its owner, and the endpoint sets that
 * owner from the asker's own finding that names the suggestion: the one direction that link is followed (40 § 3).
 *
 * The order is the decision endpoint's (36 § 8): the consent on file, the row written, the workflow told; a workflow
 * that could not be told takes back the row this request wrote — the engine down is the pipeline's 503, an ended
 * workflow a 409. The record is the workflow's activity's (invariant 17), which reads the row again before it writes,
 * so a signal the engine took after the endpoint had given up records nothing (unit 59's review). The workflow is told
 * on every press, a name already there included, with the row's own instant: a record that never followed is written
 * then, and one written is not written twice, its step key being that instant.
 *
 * Names stop when the curator's merge is taken (its `curator` record written, before `main` moves): what the merged
 * record credits is read from the records then, and a name after it would miss that record. A proposal takes at most
 * ENDORSEMENTS_MAX records of names given and taken back; past them a name is refused, its withdrawal never is (D4).
 */

/** 10 a minute a reader (42 § 6). */
const ENDORSE_RATE = { key: "user", limit: 10, windowS: 60 } as const;

/** The records of names given and taken back a proposal takes (unit 59's review): each is a signal and a step in its workflow's history, which the engine bounds. */
export const ENDORSEMENTS_MAX = 20;

/** The states in which a name is added or taken back (42 § 6): in the queue, or merging. After the merge the credit is written. */
const ENDORSABLE = new Set<ProposalPlace["state"]>(["CURATOR_QUEUE", "MERGING"]);

type ProposalRecord = { readonly kind: string; readonly actor: string; readonly payload: unknown };

export interface ProposalEndpointDeps {
  /** Whether a finding of the caller's names the suggestion and is proposed (43 D7). */
  readonly asker: (user: SessionUser, suggestionId: string) => Promise<boolean>;
  /** The suggestion as the asker is shown it; null where it is not a researcher's. */
  readonly proposal: (user: SessionUser, suggestionId: string) => Promise<ProposalPlace | null>;
  /** The suggestion's ledger records: whether its merge is taken, and how many names it has had. */
  readonly records: (suggestionId: string) => Promise<ReadonlyArray<ProposalRecord>>;
  readonly endorsement: (user: SessionUser, suggestionId: string) => Promise<EndorsementRow | null>;
  readonly consent: (user: SessionUser, at: Date) => Promise<void>;
  readonly write: typeof writeEndorsement;
  /** The row of that instant taken back, and no other. */
  readonly remove: (user: SessionUser, suggestionId: string, createdAt: Date) => Promise<boolean>;
  readonly signal: (workflowId: string, endorsed: EndorsedSignal) => Promise<void>;
  readonly now: () => Date;
}

export function defaultProposalDeps(): ProposalEndpointDeps {
  return {
    asker: askerOfProposal,
    proposal: async (user, suggestionId) => (await readProposalsForAsker(callerOf(user), [suggestionId]))[0] ?? null,
    records: (suggestionId) => view({ suggestionId }),
    endorsement: readEndorsement,
    consent: recordConsent,
    write: writeEndorsement,
    remove: removeEndorsement,
    signal: (workflowId, endorsed) => signalWorkflow(SUGGESTION_WORKFLOW, workflowId, SUGGESTION_ENDORSED_SIGNAL, endorsed),
    now: () => new Date(),
  };
}

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to put your name to a proposal");
  return session;
}

/** The proposal as the policy decides on it: its owner is the asker, when the caller is one; nobody otherwise, which the policy refuses. */
async function proposalResourceOf(deps: Pick<ProposalEndpointDeps, "asker">, session: SessionUser | null, suggestionId: string): Promise<PolicyResource> {
  const user = requireUser(session);
  return { kind: "proposal", id: suggestionId, ownerId: (await deps.asker(user, suggestionId)) ? user.id : null };
}

/** A record's action, as the `curator` record holds it: the ledger checked the payload when it was appended. */
function actionOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null ? (payload as { readonly action?: unknown }).action : undefined;
}

/** The curator's merge is taken: its `curator` record of action `MERGE`, or the merged record itself. */
function mergeTaken(records: ReadonlyArray<ProposalRecord>): boolean {
  return records.some((record) => record.kind === "MERGED" || (record.kind === "CURATOR" && actionOf(record.payload) === "MERGE"));
}

/** The suggestion, in a state that takes a name or gives one back (42 § 6), with its records; 404 where there is none, 409 where it is past that. */
async function endorsable(deps: ProposalEndpointDeps, user: SessionUser, suggestionId: string): Promise<ProposalPlace & { readonly workflowId: string; readonly records: ReadonlyArray<ProposalRecord> }> {
  const row = await deps.proposal(user, suggestionId);
  if (row === null) throw new ApiError("NOT_FOUND", `no proposal ${suggestionId}`);
  if (row.state === "MERGED") throw new ApiError("CONFLICT", `proposal ${suggestionId} is merged: its credit is written`, { state: row.state });
  if (!ENDORSABLE.has(row.state)) throw new ApiError("CONFLICT", `proposal ${suggestionId} is ${row.state}: a name goes on a proposal with a curator or being merged`, { state: row.state });
  if (row.workflowId === null) throw new ApiError("CONFLICT", `proposal ${suggestionId} has no workflow to tell`, { state: row.state });
  const records = await deps.records(row.id);
  if (mergeTaken(records)) throw new ApiError("CONFLICT", `proposal ${suggestionId} is being merged: its credit is being written`, { state: row.state, merge: true });
  return { ...row, workflowId: row.workflowId, records };
}

/** The workflow told; not told, `undo` puts the row back as it was and the engine's answer is the pipeline's (503) or a conflict (409). */
async function tell(deps: ProposalEndpointDeps, workflowId: string, endorsed: EndorsedSignal, undo: () => Promise<unknown>): Promise<void> {
  try {
    await deps.signal(workflowId, endorsed);
  } catch (error: unknown) {
    await undo();
    if (error instanceof WorkflowNotFoundError) throw new ApiError("CONFLICT", `proposal ${workflowId}: its workflow has ended and cannot take a name`, { workflowId });
    throw error;
  }
}

export function proposalEndpoints(deps: ProposalEndpointDeps = defaultProposalDeps()): {
  readonly proposalEndorse: Spec<typeof ProposalParamsSchema, undefined, typeof EndorseBodySchema, typeof EndorsementSchema>;
  readonly proposalWithdraw: Spec<typeof ProposalParamsSchema, undefined, undefined, typeof EndorsementSchema>;
} {
  return {
    proposalEndorse: {
      path: "/api/v1/proposals/{suggestionId}/endorse",
      method: "POST",
      summary: "The reader who asked puts their name to a research proposal that came from their question, with consent to keep it for provenance; while the proposal waits for a curator or is being merged, until the curator's merge is taken",
      auth: "session",
      params: ProposalParamsSchema,
      body: EndorseBodySchema,
      response: EndorsementSchema,
      rateLimit: ENDORSE_RATE,
      policy: { action: "endorse", resource: ({ session, params }) => proposalResourceOf(deps, session, params.suggestionId) },
      run: async ({ session, params, body }) => {
        const user = requireUser(session);
        if (!body.consent) throw new ApiError("CONSENT_REQUIRED", "a name goes on a proposal with consent to keep it for its provenance (feature-specs/42 § 6)");
        const row = await endorsable(deps, user, params.suggestionId);
        /* a new name past the proposal's records of names refused; a name already there is told again whatever the count */
        const standing = await deps.endorsement(user, row.id);
        if (standing === null && row.records.filter((record) => record.kind === "ENDORSED").length >= ENDORSEMENTS_MAX) throw new ApiError("CONFLICT", `proposal ${row.id} has had its name given and taken back ${String(ENDORSEMENTS_MAX)} times: it takes no new one`, { state: row.state });
        const now = deps.now();
        /* the consent first, as the submission has it (31 § 6.2): a start that fails leaves it on file, the person's all the same */
        await deps.consent(user, now);
        const written = await deps.write(user, row.id, now);
        if (!written.written) throw new ApiError("CONFLICT", `proposal ${row.id} carries another name`);
        /* told every time with the row's own instant; only a row this request wrote is taken back */
        const at = written.createdAt;
        await tell(deps, row.workflowId, { userId: user.id, at: at.toISOString(), withdrawn: false }, written.existed ? async () => undefined : () => deps.remove(user, row.id, at));
        const answer: Endorsement = { suggestionId: row.id, endorsed: { byMe: true, at: at.toISOString() } };
        return answer;
      },
    },
    proposalWithdraw: {
      path: "/api/v1/proposals/{suggestionId}/endorse",
      method: "DELETE",
      summary: "The reader takes their name off a research proposal, until the curator's merge is taken; the ledger keeps the endorsement and its withdrawal",
      auth: "session",
      params: ProposalParamsSchema,
      response: EndorsementSchema,
      rateLimit: ENDORSE_RATE,
      policy: { action: "endorse", resource: ({ session, params }) => proposalResourceOf(deps, session, params.suggestionId) },
      run: async ({ session, params }) => {
        const user = requireUser(session);
        const row = await endorsable(deps, user, params.suggestionId);
        const standing = await deps.endorsement(user, row.id);
        if (standing === null) throw new ApiError("NOT_FOUND", `your name is not on proposal ${row.id}`);
        await deps.remove(user, row.id, standing.createdAt);
        await tell(deps, row.workflowId, { userId: user.id, at: standing.createdAt.toISOString(), withdrawn: true }, () => deps.write(user, row.id, standing.createdAt));
        const answer: Endorsement = { suggestionId: row.id, endorsed: null };
        return answer;
      },
    },
  };
}

export const { proposalEndorse, proposalWithdraw } = proposalEndpoints();
