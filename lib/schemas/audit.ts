import { z } from "zod";

import { IsoInstantSchema, LedgerKindSchema, Sha256Schema, type LedgerKind } from "@/lib/schemas/ledger";

/*
 * The audit export (feature-specs/38 § 3; unit 55b): what an account asks for, the row it gets, and the four kinds of
 * record the screen's checkboxes name, each a selection of the ledger's own kinds. Every schema here passes `freeTextIn`
 * (./freeText.ts): none can hold a sentence.
 */

/** The screen's `records` checkboxes: adjudications, overrides, merges, assistant and research records and deletions. */
export const AUDIT_RECORD_KINDS = ["adjudications", "overrides", "merges", "answers"] as const;
export const AuditRecordKindSchema = z.enum(AUDIT_RECORD_KINDS);
export type AuditRecordKind = z.infer<typeof AuditRecordKindSchema>;

/**
 * The ledger kinds each selects: an adjudication is a `DECIDED` record (the intake's rule or the adjudicator's), and
 * since unit 63c a contributor's withdrawal that ended one (`RETRACTED`, feature-specs/45 § 5), an
 * override a curator's `CURATOR` record (the TRD's word for a decision taken over the adjudicator's), a merge the
 * `MERGED` record (and the revert's, which is a merge), an answer the assistant's `ANSWER` record, and since unit 62d
 * a reader's deletion of a conversation (`ERASED`, feature-specs/45 § 3.7), which says why those records point at nothing.
 * Since unit 71 the same checkbox, `assistant and research records, and deletions`, also selects a person's research
 * runs (`RESEARCH`, feature-specs/48 § 15), and its `ERASED` a research's deletion as well: an account's pack selects by
 * actor (38 § 3), so it takes the records the person signed and never a legacy run's, which `service:researcher`
 * signed. The label keeps "deletions", which the `ERASED` records are; spec 46's unit 65b adds "deletion requests" to it
 * (46 § 3.6, as unit 71 amended it).
 */
export const LEDGER_KINDS_OF: Readonly<Record<AuditRecordKind, ReadonlyArray<LedgerKind>>> = {
  adjudications: ["DECIDED", "RETRACTED"],
  overrides: ["CURATOR"],
  merges: ["MERGED"],
  answers: ["ANSWER", "RESEARCH", "ERASED"],
};

/** The ledger kinds a choice of record kinds selects, in the ledger's order, each once. */
export function ledgerKindsOf(kinds: ReadonlyArray<AuditRecordKind>): ReadonlyArray<LedgerKind> {
  const chosen = new Set(kinds.flatMap((kind) => LEDGER_KINDS_OF[kind]));
  return LedgerKindSchema.options.filter((kind) => chosen.has(kind));
}

/**
 * The pack's scope: an account — a person's own, or an organisation's for its admin (38 § 3, D1) — named by the id the
 * session holds, or a chapter by its two digits, whose records are public once merged.
 */
export const AuditScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("chapter"), id: z.string().regex(/^\d{2}$/, "a chapter number as two digits") }),
]);
export type AuditScope = z.infer<typeof AuditScopeSchema>;

/** `POST /api/v1/org/audit-exports`: the scope, a window, and the kinds of record, at least one. */
export const AuditExportRequestSchema = z
  .strictObject({
    scope: AuditScopeSchema,
    from: IsoInstantSchema,
    to: IsoInstantSchema,
    kinds: z.array(AuditRecordKindSchema).min(1).max(AUDIT_RECORD_KINDS.length),
  })
  .refine((request) => new Date(request.from).getTime() < new Date(request.to).getTime(), { message: "from must be before to", path: ["to"] })
  .refine((request) => new Set(request.kinds).size === request.kinds.length, { message: "each kind once", path: ["kinds"] });
export type AuditExportRequest = z.infer<typeof AuditExportRequestSchema>;

/** The same, as the estimate's query string carries it: `kinds` comma-separated. */
export const AuditEstimateQuerySchema = z.strictObject({
  scope: z.enum(["account", "chapter"]),
  id: z.string().min(1),
  from: IsoInstantSchema,
  to: IsoInstantSchema,
  kinds: z.string().min(1),
});

/** How many records the request would export now (38 § 3: a count query, never a guess). */
export const AuditEstimateSchema = z.strictObject({ records: z.int().nonnegative() });
export type AuditEstimate = z.infer<typeof AuditEstimateSchema>;

/** `PREPARING` until the file is in the store, verified, and its `EXPORT` record appended; then `READY` (38 § 5). */
export const AUDIT_EXPORT_STATES = ["PREPARING", "READY"] as const;
export const AuditExportStateSchema = z.enum(AUDIT_EXPORT_STATES);
export type AuditExportState = z.infer<typeof AuditExportStateSchema>;

/** What the row keeps of the request, as its `scope` column holds it. */
export const AuditExportScopeColumnSchema = z.strictObject({
  scope: AuditScopeSchema,
  from: IsoInstantSchema,
  to: IsoInstantSchema,
  kinds: z.array(AuditRecordKindSchema).min(1),
});
export type AuditExportScopeColumn = z.infer<typeof AuditExportScopeColumnSchema>;

/**
 * An export as its requester reads it (`GET /api/v1/org/audit-exports/{id}`): the request, the state, the count — the
 * estimate while preparing, the file's once ready — the head hash and the signed URL, which serves the file for 24
 * hours from the read (TRD § 7.7) and is null until the file exists.
 */
export const AuditExportSchema = z.strictObject({
  id: z.uuid(),
  state: AuditExportStateSchema,
  scope: AuditScopeSchema,
  from: IsoInstantSchema,
  to: IsoInstantSchema,
  kinds: z.array(AuditRecordKindSchema).min(1),
  records: z.int().nonnegative(),
  headHash: Sha256Schema.nullable(),
  requestedAt: IsoInstantSchema,
  readyAt: IsoInstantSchema.nullable(),
  url: z.url().nullable(),
  urlExpiresAt: IsoInstantSchema.nullable(),
});
export type AuditExportView = z.infer<typeof AuditExportSchema>;

/** `POST`'s answer: the row's id and its state (38 § 3). */
export const AuditExportStartedSchema = z.strictObject({ id: z.uuid(), state: AuditExportStateSchema });
export type AuditExportStarted = z.infer<typeof AuditExportStartedSchema>;

export const AuditExportParamsSchema = z.strictObject({ id: z.uuid() });

/** Four a day (TRD): the day is the UTC calendar day, and the fifth is 429 with the day's end. */
export const AUDIT_EXPORTS_PER_DAY = 4;

/** `audit/<id>.jsonl`: where the pack is kept (32 § 5; the key's root is the store's own). */
export function auditObjectKey(exportId: string): `audit/${string}.jsonl` {
  return `audit/${exportId}.jsonl`;
}

/** The signed URL's life: 24 hours (TRD § 7.7). */
export const AUDIT_URL_TTL_S = 24 * 60 * 60;
