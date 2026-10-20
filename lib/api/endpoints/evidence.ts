import { randomUUID } from "node:crypto";

import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { addEvidenceItem, callerOf, readSuggestion, removeEvidenceItem, type Added, type EvidenceInput, type Removed, type SuggestionForUser } from "@/lib/db/improve";
import { normaliseDoi } from "@/lib/improve/doi";
import { uploadMaxOf } from "@/lib/improve/media";
import { EvidenceAddedSchema, EvidenceAddSchema, EvidenceDeletedSchema, EvidenceItemParamsSchema, ITEMS_PER_SUGGESTION_MAX, type EvidenceAdd, type EvidenceAdded, type EvidenceDeleted } from "@/lib/schemas/evidence";
import { evidenceItemPrefix, evidenceSourceKey, suggestionOfKey, UploadRequestSchema, UploadTicketSchema, UploadTypeSchema, type ObjectKey, type StoredObject, type UploadTicket } from "@/lib/schemas/storage";
import { SuggestionParamsSchema } from "@/lib/schemas/suggestions";
import { GRADE_EVIDENCE_WORKFLOW, gradeEvidenceWorkflowId } from "@/lib/schemas/workflows";
import { headObject, removeObjectsUnder, signedPutUrl, type SignedUrl } from "@/lib/storage";
import { startWorkflow, type StartedWorkflow } from "@/lib/workflows/client";

import { cancelEvidenceGrading, itemViewOf, requireUser, resourceOf, revisable, SUGGESTION_RATE } from "./suggestions";

/*
 * The evidence endpoints (feature-specs/32 § 5, § 8): what a contributor adds to a suggestion for the rubric to score.
 * Unit 49b is the upload's ticket — a signed URL the browser PUTs the file to; unit 49e the item itself, graded on
 * add: `POST …/evidence` creates the item pending with its ordinal, starts `GradeEvidenceWorkflow` under
 * `evidence:<itemId>` and answers 202 with the item; the workflow fetches, stores the text and grades (workers), and
 * `GET /suggestions/{id}` then carries the item with its arithmetic and the suggestion's score and prediction.
 * `DELETE …/evidence/{itemId}` removes an item and cancels a pending one's grading.
 *
 * Every endpoint is the owner's while the suggestion is a draft or open for revision (31 § 6.5). A suggestion holds
 * at most ITEMS_PER_SUGGESTION_MAX items (D4, Andre, 2026-10-06: ten). A lab run is refused by name until the IDE
 * exists (§ 3). Nothing here calls a model or fetches a URL: the workflow does both, in the workers.
 */

export interface EvidenceEndpointDeps {
  readonly read: (user: SessionUser, id: string) => Promise<SuggestionForUser | null>;
  readonly signPut: (key: ObjectKey, grant: { readonly contentType: string; readonly maxBytes: number }) => Promise<SignedUrl>;
  readonly newItemId: () => string;
  /** The store's record of an upload, or null when nothing arrived under the key. */
  readonly stored: (key: ObjectKey) => Promise<StoredObject | null>;
  readonly add: (user: SessionUser, suggestionId: string, input: EvidenceInput) => Promise<Added>;
  readonly remove: (user: SessionUser, suggestionId: string, itemId: string) => Promise<Removed>;
  readonly startGrading: (itemId: string) => Promise<StartedWorkflow>;
  /** True when a run was there to cancel. */
  readonly cancelGrading: (itemId: string) => Promise<boolean>;
  /** Every object under a prefix removed (45 § 4): an item's, when it leaves a draft. */
  readonly removeObjects: (prefix: ObjectKey) => Promise<boolean>;
}

const DEPS: EvidenceEndpointDeps = {
  read: (user, id) => readSuggestion(callerOf(user), id),
  signPut: (key, grant) => signedPutUrl(key, grant),
  newItemId: randomUUID,
  stored: (key) => headObject(key),
  add: (user, suggestionId, input) => addEvidenceItem(callerOf(user), suggestionId, input, ITEMS_PER_SUGGESTION_MAX),
  remove: (user, suggestionId, itemId) => removeEvidenceItem(callerOf(user), suggestionId, itemId),
  startGrading: (itemId) => startWorkflow(GRADE_EVIDENCE_WORKFLOW, gradeEvidenceWorkflowId(itemId), { itemId }),
  cancelGrading: (itemId) => cancelEvidenceGrading(itemId),
  removeObjects: (prefix) => removeObjectsUnder(prefix),
};

/** The suggestion, the owner's and open for evidence; the refusals of § 8 in the API's error form. */
async function openSuggestion(deps: Pick<EvidenceEndpointDeps, "read">, user: SessionUser, id: string): Promise<SuggestionForUser> {
  const row = await deps.read(user, id);
  if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${id} is not here, or not yours to read`);
  if (row.state !== "DRAFT" && !revisable(row)) throw new ApiError("CONFLICT", `suggestion ${row.id} is ${row.state}: it takes no new evidence`, { state: row.state });
  return row;
}

export function evidenceEndpoints(deps: EvidenceEndpointDeps = DEPS): {
  readonly evidenceUploadCreate: Spec<typeof SuggestionParamsSchema, undefined, typeof UploadRequestSchema, typeof UploadTicketSchema>;
  readonly evidenceAdd: Spec<typeof SuggestionParamsSchema, undefined, typeof EvidenceAddSchema, typeof EvidenceAddedSchema>;
  readonly evidenceDelete: Spec<typeof EvidenceItemParamsSchema, undefined, undefined, typeof EvidenceDeletedSchema>;
} {
  return {
    evidenceUploadCreate: {
      path: "/api/v1/suggestions/{id}/evidence/uploads",
      method: "POST",
      summary: "A signed URL to upload a file as evidence for a draft suggestion",
      auth: "session",
      role: "CONTRIBUTOR",
      params: SuggestionParamsSchema,
      body: UploadRequestSchema,
      response: UploadTicketSchema,
      rateLimit: SUGGESTION_RATE,
      policy: { action: "write", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, body }): Promise<UploadTicket> => {
        const row = await openSuggestion(deps, requireUser(session), params.id);
        const uploadKey = evidenceSourceKey(row.id, deps.newItemId());
        /* D2, or the provider's limit for a PDF or an image when lower (unit 49f, § 9). */
        const maxBytes = uploadMaxOf(body.contentType);
        const signed = await deps.signPut(uploadKey, { contentType: body.contentType, maxBytes });
        return { uploadKey, url: signed.url, method: "PUT", headers: { "content-type": body.contentType }, maxBytes, expiresAt: signed.expiresAt.toISOString() };
      },
    },

    evidenceAdd: {
      path: "/api/v1/suggestions/{id}/evidence",
      method: "POST",
      summary: "Add an evidence item to a draft suggestion; it is fetched and graded by a workflow",
      auth: "session",
      role: "CONTRIBUTOR",
      params: SuggestionParamsSchema,
      body: EvidenceAddSchema,
      response: EvidenceAddedSchema,
      rateLimit: SUGGESTION_RATE,
      idempotent: true,
      policy: { action: "write", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, body }): Promise<Response> => {
        const user = requireUser(session);
        const row = await openSuggestion(deps, user, params.id);
        if (row.evidence.length >= ITEMS_PER_SUGGESTION_MAX) throw new ApiError("EVIDENCE_LIMIT", `suggestion ${row.id} holds ${String(ITEMS_PER_SUGGESTION_MAX)} items`, { max: ITEMS_PER_SUGGESTION_MAX });
        const input = await inputOf(deps, row.id, body);

        const added = await deps.add(user, row.id, input);
        if (!added.added) {
          if (added.reason === "limit") throw new ApiError("EVIDENCE_LIMIT", `suggestion ${row.id} holds ${String(ITEMS_PER_SUGGESTION_MAX)} items`, { max: ITEMS_PER_SUGGESTION_MAX });
          throw new ApiError("CONFLICT", `suggestion ${row.id} takes no new evidence now`);
        }
        /* The engine first; a start that fails leaves no item behind (§ 8: workflows unavailable, nothing is created). */
        let started: StartedWorkflow;
        try {
          started = await deps.startGrading(added.item.id);
        } catch (error: unknown) {
          if (!added.existed) await deps.remove(user, row.id, added.item.id);
          throw error;
        }
        const answer: EvidenceAdded = { suggestionId: row.id as EvidenceAdded["suggestionId"], item: itemViewOf(added.item), workflowId: started.workflowId, stage: "1 of 3" };
        return new Response(JSON.stringify(EvidenceAddedSchema.parse(answer)), { status: 202, headers: { "content-type": "application/json; charset=utf-8" } });
      },
    },

    evidenceDelete: {
      path: "/api/v1/suggestions/{id}/evidence/{itemId}",
      method: "DELETE",
      summary: "Remove an evidence item from a draft suggestion; a pending item's grading is cancelled",
      auth: "session",
      role: "CONTRIBUTOR",
      params: EvidenceItemParamsSchema,
      response: EvidenceDeletedSchema,
      rateLimit: SUGGESTION_RATE,
      policy: { action: "write", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, traceId }): Promise<EvidenceDeleted> => {
        const user = requireUser(session);
        const row = await openSuggestion(deps, user, params.id);
        if (!row.evidence.some((item) => item.id === params.itemId)) throw new ApiError("NOT_FOUND", `suggestion ${row.id} has no item ${params.itemId}`);
        const removed = await deps.remove(user, row.id, params.itemId);
        if (!removed.removed) throw new ApiError("NOT_FOUND", `suggestion ${row.id} has no item ${params.itemId}`);
        /* an item that leaves a draft takes what it stored (45 § 4), before the cancel, whose 503 would otherwise leave it (review of unit 63); one that
           leaves a suggestion under revision keeps it, since an earlier attempt's records name it */
        if (row.state === "DRAFT") await deps.removeObjects(evidenceItemPrefix(row.id, params.itemId)).catch((error: unknown) => console.warn("evidence removed: its stored objects were not", traceId, params.itemId, error instanceof Error ? error.message : String(error)));
        const cancelled = removed.state === "PENDING" ? await deps.cancelGrading(params.itemId) : false;
        return { suggestionId: row.id as EvidenceDeleted["suggestionId"], itemId: params.itemId, removed: true, cancelled };
      },
    },
  };
}

/** What the item is created from, by kind, with § 8's refusals: a lab run by name, a DOI by form, an upload by key and by presence. */
async function inputOf(deps: Pick<EvidenceEndpointDeps, "stored">, suggestionId: string, body: EvidenceAdd): Promise<EvidenceInput> {
  switch (body.kind) {
    case "LAB_RUN":
      throw new ApiError("EVIDENCE_KIND_NOT_YET", "saved lab runs arrive with the IDE (feature-specs/32 § 3)");
    case "LINK":
      return { id: randomUUID(), kind: "LINK", url: body.url, doi: null, storageKey: null, host: new URL(body.url).hostname.toLowerCase() };
    case "DOI": {
      const doi = normaliseDoi(body.doi);
      if (doi === null) throw new ApiError("DOI_INVALID", `${body.doi} is not a DOI`);
      return { id: randomUUID(), kind: "DOI", url: null, doi, storageKey: null, host: null };
    }
    case "UPLOAD": {
      const itemId = /^evidence\/[^/]+\/([0-9a-f-]{36})\/source$/.exec(body.uploadKey)?.[1];
      if (suggestionOfKey(body.uploadKey) !== suggestionId || itemId === undefined) throw new ApiError("UPLOAD_KEY_INVALID", `${body.uploadKey} is not an upload key of suggestion ${suggestionId}`);
      const stored = await deps.stored(body.uploadKey);
      if (stored === null) throw new ApiError("UPLOAD_NOT_FOUND", `nothing has arrived under ${body.uploadKey}`);
      if (!UploadTypeSchema.safeParse(stored.contentType).success) throw new ApiError("UPLOAD_KEY_INVALID", `the file under ${body.uploadKey} is ${stored.contentType}, which is not a type a person may upload`);
      return { id: itemId, kind: "UPLOAD", url: null, doi: null, storageKey: body.uploadKey, host: null, fileName: body.fileName ?? null };
    }
    default:
      throw new ApiError("INVALID_INPUT", "an evidence kind the API does not know", { in: "body", path: ["kind"] });
  }
}

export const { evidenceUploadCreate, evidenceAdd, evidenceDelete } = evidenceEndpoints();
