import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { createAuditExport, dayOf, estimateAuditExport, latestOwnAuditExport, readOwnAuditExport, removeAuditExport, type AuditExportRow } from "@/lib/db/auditExport";
import type { PolicyResource } from "@/lib/policy/input";
import { AUDIT_EXPORTS_PER_DAY, AUDIT_URL_TTL_S, AuditEstimateQuerySchema, AuditEstimateSchema, AuditExportParamsSchema, AuditExportRequestSchema, AuditExportSchema, AuditExportStartedSchema, AuditRecordKindSchema, AuditScopeSchema, type AuditEstimate, type AuditExportRequest, type AuditExportScopeColumn, type AuditExportStarted, type AuditExportView, type AuditScope } from "@/lib/schemas/audit";
import { EXPORT_WORKFLOW, exportWorkflowId } from "@/lib/schemas/workflows";
import { signedGetUrl, storageAvailable } from "@/lib/storage";
import { startWorkflow } from "@/lib/workflows/client";

/*
 * The audit export's endpoints (feature-specs/38 § 3; unit 55b): ask for a pack, read one, and the form's estimate.
 * The policy decides who asks (policies/hb/audit.rego): any signed-in person for their own account (38 D1) or for a
 * chapter, an organisation's admin for the organisation. Four a day a person (TRD; the UTC day); the fifth is 429 with
 * the day's end. A scope that selects nothing is refused before the row is made (38 § 5: the ledger's own refusal, as
 * NOTHING_TO_EXPORT, 404 as a suggestion's and a chapter's exports answer it). A pack is read by its requester, with a
 * signed URL good for 24 hours from the read (TRD § 7.7).
 */

const RATE = { key: "user", limit: 60, windowS: 60 } as const;

export interface AuditEndpointDeps {
  readonly estimate: (request: AuditExportScopeColumn) => Promise<number>;
  /** The row, or the day's count where the four are spent (38 § 5): one transaction, so two requests at once cannot both pass. */
  readonly create: (userId: string, request: AuditExportRequest, estimate: number, now: Date, limit: number) => Promise<{ readonly created: true; readonly row: AuditExportRow } | { readonly created: false; readonly spent: number }>;
  readonly start: (exportId: string) => Promise<void>;
  /** A row whose start the engine refused, gone: never a pack, and none of the day's four. */
  readonly remove: (exportId: string) => Promise<void>;
  readonly readOwn: (userId: string, id: string) => Promise<AuditExportRow | null>;
  /** The signed URL of a ready pack, or null where nothing can be signed (the store without its secret). */
  readonly url: (storageKey: string, now: Date) => Promise<{ readonly url: string; readonly expiresAt: Date } | null>;
  readonly now: () => Date;
}

const DEPS: AuditEndpointDeps = {
  estimate: estimateAuditExport,
  create: createAuditExport,
  start: async (exportId) => {
    await startWorkflow(EXPORT_WORKFLOW, exportWorkflowId(exportId), { exportId });
  },
  remove: removeAuditExport,
  readOwn: readOwnAuditExport,
  url: async (storageKey, now) => (storageAvailable() ? signedGetUrl(storageKey as Parameters<typeof signedGetUrl>[0], AUDIT_URL_TTL_S, undefined, now) : null),
  now: () => new Date(),
};

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use this endpoint");
  return session;
}

/**
 * The policy's resource for a scope (policies/hb/audit.rego): an account scope names its owner when the id is the
 * caller's own, its organisation when the id is the caller's organisation's, and neither otherwise, which no rule
 * allows; a chapter scope names the chapter. The organisation is always the caller's, for the tenant rule.
 */
export function auditResourceOf(session: SessionUser | null, scope: AuditScope): PolicyResource {
  const organisationId = session?.organisationId ?? null;
  if (scope.kind === "chapter") return { kind: "audit-export", id: scope.id, scope: "chapter", ownerId: null, organisationId };
  if (session !== null && scope.id === session.id) return { kind: "audit-export", id: scope.id, scope: "account", ownerId: session.id, organisationId };
  if (session !== null && organisationId !== null && scope.id === organisationId) return { kind: "audit-export", id: scope.id, scope: "account", ownerId: null, organisationId };
  return { kind: "audit-export", id: scope.id, scope: "account", ownerId: null, organisationId: null };
}

/** The estimate's query as a request column: the kinds split on commas, each one of the four. */
function requestOfQuery(query: { readonly scope: "account" | "chapter"; readonly id: string; readonly from: string; readonly to: string; readonly kinds: string }): AuditExportScopeColumn {
  const scope = AuditScopeSchema.safeParse({ kind: query.scope, id: query.id });
  if (!scope.success) throw new ApiError("INVALID_INPUT", "scope.id is not an account's id or a chapter's two digits");
  const kinds = query.kinds.split(",").map((kind) => AuditRecordKindSchema.safeParse(kind.trim()));
  if (kinds.some((kind) => !kind.success) || kinds.length === 0) throw new ApiError("INVALID_INPUT", "kinds names adjudications, overrides, merges or answers, comma-separated");
  const request = AuditExportRequestSchema.safeParse({ scope: scope.data, from: query.from, to: query.to, kinds: [...new Set(kinds.map((kind) => (kind.success ? kind.data : "answers")))] });
  if (!request.success) throw new ApiError("INVALID_INPUT", request.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return { scope: request.data.scope, from: request.data.from, to: request.data.to, kinds: request.data.kinds };
}

async function viewOf(row: AuditExportRow, deps: AuditEndpointDeps): Promise<AuditExportView> {
  const signed = row.state === "READY" && row.storageKey !== null ? await deps.url(row.storageKey, deps.now()) : null;
  return {
    id: row.id,
    state: row.state,
    scope: row.request.scope,
    from: row.request.from,
    to: row.request.to,
    kinds: row.request.kinds,
    records: row.records,
    headHash: row.headHash,
    requestedAt: row.createdAt.toISOString(),
    readyAt: row.readyAt === null ? null : row.readyAt.toISOString(),
    url: signed === null ? null : signed.url,
    urlExpiresAt: signed === null ? null : signed.expiresAt.toISOString(),
  };
}

/** The reader's latest pack as the account page draws it (38 § 3): the row and, once ready, its signed URL from now. */
export async function latestAuditExportView(userId: string, now: Date): Promise<AuditExportView | null> {
  const row = await latestOwnAuditExport(userId);
  return row === null ? null : viewOf(row, { ...DEPS, now: () => now });
}

export function auditEndpoints(deps: AuditEndpointDeps = DEPS): {
  readonly auditExportCreate: Spec<undefined, undefined, typeof AuditExportRequestSchema, typeof AuditExportStartedSchema>;
  readonly auditExportRead: Spec<typeof AuditExportParamsSchema, undefined, undefined, typeof AuditExportSchema>;
  readonly auditExportEstimate: Spec<undefined, typeof AuditEstimateQuerySchema, undefined, typeof AuditEstimateSchema>;
} {
  return {
    auditExportCreate: {
      path: "/api/v1/org/audit-exports",
      method: "POST",
      summary: "Ask for an audit pack: the ledger's records in a scope — your own account, your organisation as its admin, or a chapter — a window and some kinds, as signed JSONL prepared by a workflow; four a day",
      auth: "session",
      body: AuditExportRequestSchema,
      response: AuditExportStartedSchema,
      rateLimit: RATE,
      idempotent: true,
      policy: { action: "export", resource: ({ session, body }) => auditResourceOf(session, body.scope) },
      run: async ({ session, body }) => {
        const user = requireUser(session);
        const now = deps.now();
        const estimate = await deps.estimate({ scope: body.scope, from: body.from, to: body.to, kinds: body.kinds });
        if (estimate === 0) throw new ApiError("NOTHING_TO_EXPORT", "the scope, window and kinds select no record: nothing to sign");
        const made = await deps.create(user.id, body, estimate, now, AUDIT_EXPORTS_PER_DAY);
        if (!made.created) throw new ApiError("RATE_LIMITED", `${AUDIT_EXPORTS_PER_DAY} audit packs a day; the day ends at ${dayOf(now).end.toISOString()}`, { resetsAt: dayOf(now).end.toISOString(), limit: AUDIT_EXPORTS_PER_DAY });
        const { row } = made;
        try {
          await deps.start(row.id);
        } catch (error: unknown) {
          /* the engine did not take it: the row goes, so it is never read as preparing and spends none of the day's four (unit 55's review) */
          await deps.remove(row.id).catch(() => undefined);
          if (error instanceof ApiError) throw new ApiError(error.code, `${error.message}; no pack was asked for`, error.detail);
          throw error;
        }
        const answer: AuditExportStarted = { id: row.id, state: row.state };
        return answer;
      },
    },
    auditExportRead: {
      path: "/api/v1/org/audit-exports/{id}",
      method: "GET",
      summary: "An audit pack you asked for: its state, count and head hash, and once ready a signed URL that serves the file for 24 hours",
      auth: "session",
      params: AuditExportParamsSchema,
      response: AuditExportSchema,
      rateLimit: RATE,
      policy: { action: "read", resource: ({ session, params }) => ({ kind: "audit-export", id: params.id, scope: "account", ownerId: session?.id ?? null, organisationId: session?.organisationId ?? null }) },
      run: async ({ session, params }) => {
        const user = requireUser(session);
        const row = await deps.readOwn(user.id, params.id);
        if (row === null) throw new ApiError("NOT_FOUND", `audit export ${params.id} is not one you asked for`);
        return viewOf(row, deps);
      },
    },
    auditExportEstimate: {
      path: "/api/v1/org/audit-exports/estimate",
      method: "GET",
      summary: "How many records an audit pack would hold now, for the form: a count, never a guess",
      auth: "session",
      query: AuditEstimateQuerySchema,
      response: AuditEstimateSchema,
      rateLimit: RATE,
      policy: { action: "export", resource: ({ session, query }) => auditResourceOf(session, query.scope === "chapter" ? { kind: "chapter", id: query.id } : { kind: "account", id: query.id }) },
      run: async ({ session, query }) => {
        requireUser(session);
        const answer: AuditEstimate = { records: await deps.estimate(requestOfQuery(query)) };
        return answer;
      },
    },
  };
}

export const { auditExportCreate, auditExportRead, auditExportEstimate } = auditEndpoints();
