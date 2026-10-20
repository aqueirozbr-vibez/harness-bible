import { z } from "zod";

import type { SessionUser } from "@/lib/auth/session";
import { RoleSchema, type Role } from "@/lib/schemas/auth";
import { ChangeClassSchema, PartSchema, SuggestionOriginSchema } from "@/lib/schemas/improve";

/*
 * The OPA input (feature-specs/09 § 5.1): who, what, on which resource, in
 * which request. Built by the handler pipeline and by server actions.
 */

export const PolicyActionSchema = z.enum(["read", "write", "delete", "list", "start", "run", "share", "submit", "decide", "recommend", "endorse", "export", "manage", "revoke", "login", "callback", "backchannel", "create", "ask"]);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

/** `research` since unit 71 (feature-specs/48 § 14): a person's research conversation or one of its runs, the asker's own rows. */
export const ResourceKindSchema = z.enum(["content", "search", "bookmark", "note", "path-progress", "session", "user", "org", "lab-session", "lab-run", "suggestion", "curation", "proposal", "audit-export", "auth", "conversation", "message", "object", "research", "finding"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const PolicySubjectSchema = z.object({
  kind: z.enum(["anonymous", "user", "service"]),
  id: z.string().nullable(),
  role: RoleSchema.nullable(),
  organisationId: z.string().nullable(),
  verified: z.boolean(),
  /** The parts a curator has by the roster at the time of the request; empty for everyone else (feature-specs/29 § 6.1). */
  parts: z.array(PartSchema),
  sessionId: z.string().nullable(),
});
export type PolicySubject = z.infer<typeof PolicySubjectSchema>;

export const PolicyResourceSchema = z.object({
  kind: ResourceKindSchema,
  id: z.string().nullable(),
  ownerId: z.string().nullable().optional(),
  organisationId: z.string().nullable().optional(),
  /* A suggestion's own facts, for the rules of policies/hb/improve.rego (feature-specs/29 § 6.2). A rule that reads
     one the caller left out does not fire, so leaving one out refuses. */
  /** The parts the suggestion reaches (`Suggestion.parts`): what a curator's roster is matched against. */
  parts: z.array(PartSchema).optional(),
  changeClass: ChangeClassSchema.nullable().optional(),
  origin: SuggestionOriginSchema.nullable().optional(),
  /** The suggestion is merged, and this is its record (35 D2; unit 54d): anyone's to read. Only the record's endpoints say it. */
  merged: z.boolean().optional(),
  /** A researcher's proposal that is closed: a curator's to read whatever its parts (43 D6; unit 60e). Only the record's endpoint says it. */
  closed: z.boolean().optional(),
  /** An audit pack's scope (38 § 3; unit 55b): an account's — `ownerId` the person's, or `organisationId` the organisation's — or a chapter's. */
  scope: z.enum(["account", "chapter"]).optional(),
});
export type PolicyResource = z.infer<typeof PolicyResourceSchema>;

export const PolicyContextSchema = z.object({
  releaseId: z.string(),
  traceId: z.string(),
  method: z.string(),
  path: z.string(),
  now: z.string(),
});
export type PolicyContext = z.infer<typeof PolicyContextSchema>;

export const PolicyInputSchema = z.object({ subject: PolicySubjectSchema, action: PolicyActionSchema, resource: PolicyResourceSchema, context: PolicyContextSchema });
export type PolicyInput = z.infer<typeof PolicyInputSchema>;

export const ANONYMOUS: PolicySubject = { kind: "anonymous", id: null, role: null, organisationId: null, verified: false, parts: [], sessionId: null };

/**
 * The subject a session implies; anonymous when there is none. `verified` and `parts` are the session's own: until
 * unit 46d this function was never given the first, so the policy had always been told `verified: false`.
 */
export function subjectOf(user: SessionUser | null): PolicySubject {
  if (user === null) return ANONYMOUS;
  return { kind: "user", id: user.id, role: user.role as Role, organisationId: user.organisationId, verified: user.identityVerified, parts: [...user.parts], sessionId: user.sessionId };
}

/** A service identity as the policy is told of one: an agent's, by name. It has no role, no organisation and no part, and is never `verified`. */
export function serviceSubject(id: `service:${string}`): PolicySubject {
  return { kind: "service", id, role: null, organisationId: null, verified: false, parts: [], sessionId: null };
}

/** A user-scoped resource the subject owns by construction (their own bookmark, note, session…). */
export function ownResource(kind: ResourceKind, id: string | null, user: SessionUser): PolicyResource {
  return { kind, id, ownerId: user.id, organisationId: user.organisationId };
}
