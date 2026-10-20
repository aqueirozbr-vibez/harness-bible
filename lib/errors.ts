/**
 * Typed application error. Application code throws subclasses of this, never a
 * bare Error or a string (code-standards § TypeScript). `code` is a stable
 * identifier from the API error catalogue; `message` names the fix.
 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

/*
 * Two Prisma error codes the callers must tell apart from a real failure, named here so no module repeats the
 * code string (lib/ledger/append.ts on the chain head, workers/keys.ts on a raced key row).
 */

function prismaCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

/** P2002: a unique constraint refused the write, so a concurrent writer took the row first. */
export function isUniqueViolation(error: unknown): boolean {
  return prismaCode(error) === "P2002";
}

/** P2025: the row the write named was not there, so a concurrent writer changed it first. */
export function isRecordNotFound(error: unknown): boolean {
  return prismaCode(error) === "P2025";
}

/** P2003: a foreign key refused the write, so the row it hangs from is gone: a reader's conversation deleted under a write to it (feature-specs/45 § 3.3). */
export function isForeignKeyViolation(error: unknown): boolean {
  return prismaCode(error) === "P2003";
}
