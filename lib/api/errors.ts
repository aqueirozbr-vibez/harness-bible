import { AppError } from "@/lib/errors";

/*
 * The API error catalogue (code-standards § API Routes; feature-specs/09 § 7, § 11).
 * One body everywhere: { code, message, detail?, traceId }.
 */

export const STATUS_OF: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  NO_SESSION: 401,
  BUDGET_EXCEEDED: 402,
  ROLE_REQUIRED: 403,
  FORBIDDEN: 403,
  BAD_ORIGIN: 403,
  NOT_FOUND: 404,
  /* A HEAD to a read that writes, an export (the 52c review): Next answers HEAD with the GET's handler. */
  METHOD_NOT_ALLOWED: 405,
  UNKNOWN_SECTION: 404,
  CONFLICT: 409,
  /* The assistant (feature-specs/15 § 5): a context the release does not have, a second flag on one message, a
     conversation pinned to a release that is no longer current, and a turn whose answer is still being written. */
  CONTEXT_INVALID: 422,
  FLAG_DUPLICATE: 409,
  RELEASE_CHANGED: 409,
  TURN_IN_PROGRESS: 409,
  TEXT_TOO_LONG: 400,
  ASSISTANT_UNAVAILABLE: 503,
  NOTHING_TO_EXPORT: 404,
  AID_UNKNOWN: 422,
  AID_INPUTS: 422,
  AID_RUN_FAILED: 422,
  IN_PROGRESS: 409,
  NOT_DERIVED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  UNPROCESSABLE: 422,
  NOTE_TOO_LONG: 422,
  IDEMPOTENCY_MISMATCH: 422,
  RATE_LIMITED: 429,
  AUTH_NOT_CONFIGURED: 503,
  WORKERS_UNAVAILABLE: 503,
  /* The workflow engine is not configured, cannot be reached or did not answer in time (feature-specs/28 § 5). */
  WORKFLOWS_UNAVAILABLE: 503,
  /* Intake (feature-specs/31 § 3): a suggestion with no anchor, an anchor the pinned release has not, a change kind the anchor's kind does not take, and a contributor's throttle. */
  ANCHOR_REQUIRED: 422,
  ANCHOR_UNKNOWN: 422,
  CHANGE_KIND_INVALID: 422,
  SUGGESTION_THROTTLED: 429,
  /* Submission (feature-specs/31 § 6): the consent a person's suggestion leaves draft with, and the intake sensor that failed. */
  CONSENT_REQUIRED: 422,
  INTAKE_SCHEMA: 422,
  INTAKE_ANCHOR_EXISTS: 422,
  INTAKE_EVIDENCE_PARSES: 422,
  INTAKE_RATIONALE_LENGTH: 422,
  /* Storage (feature-specs/32 § 5): the store's secret is not set; a signed URL that does not verify, is expired, or is for another method; an upload of another type than the URL was signed for, or past the size it allows. */
  STORAGE_UNAVAILABLE: 503,
  SIGNED_URL_INVALID: 403,
  UPLOAD_TYPE_MISMATCH: 415,
  UPLOAD_TOO_LARGE: 413,
  /* Evidence (feature-specs/32 § 8): a kind the build does not take yet, a suggestion at its ten items, an upload key that is not this suggestion's or holds nothing, a DOI that is not one. */
  EVIDENCE_KIND_NOT_YET: 422,
  /* A curator's decision (feature-specs/36 § 5.2, unit 53c). */
  OVERRIDE_CODE_REQUIRED: 422,
  OVERRIDE_CODE_INVALID: 422,
  OVERRIDE_CODE_NOT_TAKEN: 422,
  OVERRIDE_CRITERION_NOT_TAKEN: 422,
  OVERRIDE_CRITERION_REQUIRED: 422,
  OVERRIDE_NOTE_REQUIRED: 422,
  NOT_FOR_RESEARCH: 422,
  /* A curator's revert (feature-specs/37 § 8, unit 54e) says why. */
  REVERT_NOTE_REQUIRED: 422,
  EVIDENCE_LIMIT: 422,
  UPLOAD_KEY_INVALID: 422,
  UPLOAD_NOT_FOUND: 422,
  DOI_INVALID: 422,
  /* A person's research (feature-specs/48 § 13; unit 71): a run already under way in the conversation, an account with a
     deletion request standing, the organisation's switch off, the day's thirty, research not available here (no engine,
     or the engine refused the start), and an Assistant answer that cannot seed one; and the codes of a finding's two
     endpoints (unit 74): used once, its text purged, the same change already proposed, the month's thirty sends (D5). */
  RESEARCH_IN_PROGRESS: 409,
  ACCOUNT_DELETION_REQUESTED: 403,
  RESEARCH_OFF_ORGANISATION: 403,
  RESEARCH_DAILY_LIMIT: 429,
  RESEARCH_UNAVAILABLE: 503,
  SEED_INVALID: 422,
  FINDING_USED: 409,
  FINDING_PURGED: 409,
  PROPOSAL_DUPLICATE: 409,
  RESEARCH_SENDS_LIMIT: 429,
  INTERNAL: 500,
};

export class ApiError extends AppError {
  readonly status: number;
  readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(code, message);
    this.name = "ApiError";
    this.status = STATUS_OF[code] ?? 500;
    this.detail = detail;
  }
}

/** Any thrown value becomes a catalogued error; unknown errors are 500 with no message from the error. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AppError && STATUS_OF[error.code] !== undefined) return new ApiError(error.code, error.message);
  return new ApiError("INTERNAL", "the request did not complete");
}
