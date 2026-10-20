import { z } from "zod";

import { SuggestionIdSchema } from "@/lib/schemas/ids";

/*
 * Object storage's vocabulary (feature-specs/32 § 5, § 15): the keys an object may have, the types a person may
 * upload, the ticket an upload endpoint answers, the claims a signed URL carries, and what the store says of an
 * object it holds. The two numbers are decisions: the upload size limit is Andre's (D2, 2026-10-06: 100 MB), the
 * life of a signed URL is the architecture's own ten minutes (§ 2.2, as the spec names it).
 */

/** D2 (Andre, 2026-10-06): 100 MB, 1024 to the kilobyte as the gates count. */
export const UPLOAD_SIZE_MAX = 100 * 1024 * 1024;
/** A signed URL's life (32 § 5: "the sandbox's 10 minutes", architecture § 2.2). */
export const SIGNED_URL_TTL_S = 600;

/**
 * A key: a root the product owns, then segments of letters, digits, `.`, `_` and `-`, none of them `.` or `..`.
 * `evidence/<suggestionId>/<itemId>/source` and `/text` (32 § 5), `audit/<exportId>.jsonl` (spec 38), and since unit
 * 54b `merges/<suggestionId>/<commit>.log`, a merge's lab run (37 § 4.4). Never a path a person wrote.
 */
export const ObjectKeySchema = z
  .string()
  .max(200)
  .regex(/^(?:evidence|audit|merges)(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+){1,5}$/, "a key of the product's own: evidence/…, audit/… or merges/…");
export type ObjectKey = z.infer<typeof ObjectKeySchema>;

/** The types a person may upload (32 § 5): those of § 4.3 that are not HTML. */
export const UPLOAD_TYPES = ["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg"] as const;
export const UploadTypeSchema = z.enum(UPLOAD_TYPES);
export type UploadType = z.infer<typeof UploadTypeSchema>;

export const UploadRequestSchema = z.strictObject({ contentType: UploadTypeSchema });
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

/** What `POST /suggestions/{id}/evidence/uploads` answers: where to PUT the file, with what header, until when. */
export const UploadTicketSchema = z.strictObject({
  /** The object's key, which `POST …/evidence` takes as `uploadKey` (49e). */
  uploadKey: ObjectKeySchema,
  url: z.url(),
  method: z.literal("PUT"),
  headers: z.strictObject({ "content-type": UploadTypeSchema }),
  maxBytes: z.int().positive(),
  expiresAt: z.iso.datetime(),
});
export type UploadTicket = z.infer<typeof UploadTicketSchema>;

export const ObjectMethodSchema = z.enum(["PUT", "GET"]);
export type ObjectMethod = z.infer<typeof ObjectMethodSchema>;

/** The claims of a signed URL's token: one key, one method, and for a PUT the type and the size it may carry. */
export const ObjectTokenClaimsSchema = z.strictObject({
  key: ObjectKeySchema,
  method: ObjectMethodSchema,
  contentType: z.string().min(1).nullable(),
  maxBytes: z.int().positive().nullable(),
  /** Unix seconds, as the token carries it. */
  exp: z.int().positive(),
});
export type ObjectTokenClaims = z.infer<typeof ObjectTokenClaimsSchema>;

export const ObjectTokenParamsSchema = z.object({ token: z.string().min(1).max(2048) });

/** What the store knows of an object: its type, its size, its hash and when it was stored. */
export const StoredObjectSchema = z.strictObject({
  key: ObjectKeySchema,
  contentType: z.string().min(1),
  bytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storedAt: z.iso.datetime(),
});
export type StoredObject = z.infer<typeof StoredObjectSchema>;

export const evidenceSourceKey = (suggestionId: string, itemId: string): ObjectKey => `evidence/${suggestionId}/${itemId}/source`;
export const evidenceTextKey = (suggestionId: string, itemId: string): ObjectKey => `evidence/${suggestionId}/${itemId}/text`;
/** Everything one item stored, under its own segment: its source (an upload's included, whose key names the item) and its text. */
export const evidenceItemPrefix = (suggestionId: string, itemId: string): ObjectKey => `evidence/${suggestionId}/${itemId}`;
/** Everything a suggestion's evidence stored, every item's and every upload's, one never added as an item included (feature-specs/45 § 4). */
export const evidencePrefix = (suggestionId: string): ObjectKey => `evidence/${suggestionId}`;
/** What a merge's lab run printed on a commit of its branch, whole (feature-specs/37 § 4.4: the runner's output key). */
export const mergeOutputKey = (suggestionId: string, sha: string): ObjectKey => `merges/${suggestionId}/${sha}.log`;

/** The suggestion a key under `evidence/` belongs to, or null for any other key. */
export function suggestionOfKey(key: string): string | null {
  const match = /^evidence\/([^/]+)\//.exec(key);
  if (match === null) return null;
  const parsed = SuggestionIdSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : null;
}
