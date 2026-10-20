import { createHash } from "node:crypto";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";

/*
 * Idempotency keys (feature-specs/09 § 7 step 6): scoped to user, path and key;
 * the first response is stored and replayed; a different body under the same
 * key is refused; rows expire after 24 hours.
 */

export const IDEMPOTENCY_TTL_MS = 86_400_000;

export type IdempotencyStart =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "in-flight" }
  | { readonly kind: "mismatch" };

export function bodyHashOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/** Claim the key: a new row means the request runs; otherwise the stored outcome decides. */
export async function beginIdempotent(user: SessionUser, path: string, key: string, bodyHash: string, now = new Date()): Promise<IdempotencyStart> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    try {
      await prisma.idempotencyKey.create({ data: { userId: user.id, path, key, bodyHash, createdAt: now } });
      return { kind: "new" };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const row = await prisma.idempotencyKey.findUnique({ where: { userId_path_key: { userId: user.id, path, key } } });
    if (row === null) return { kind: "new" };
    if (row.createdAt.getTime() < now.getTime() - IDEMPOTENCY_TTL_MS) {
      await prisma.idempotencyKey.update({ where: { userId_path_key: { userId: user.id, path, key } }, data: { bodyHash, status: null, response: undefined, createdAt: now } });
      return { kind: "new" };
    }
    if (row.bodyHash !== bodyHash) return { kind: "mismatch" };
    if (row.status === null) return { kind: "in-flight" };
    return { kind: "replay", status: row.status, body: row.response };
  });
}

/** Store the first response so a repeat replays it. */
export async function completeIdempotent(user: SessionUser, path: string, key: string, status: number, body: unknown): Promise<void> {
  await withTenant(tenantOf(user), () =>
    getPrisma().idempotencyKey.update({ where: { userId_path_key: { userId: user.id, path, key } }, data: { status, response: body === undefined ? undefined : (body as object) } }),
  );
}

/** Release a claimed key when the request failed before producing a storable response. */
export async function abandonIdempotent(user: SessionUser, path: string, key: string): Promise<void> {
  await withTenant(tenantOf(user), () => getPrisma().idempotencyKey.deleteMany({ where: { path, key } }));
}

/**
 * Keys past their 24 hours. `IdempotencyKey` is a tenant model, and the guard exempts no model but the auth four from
 * the reader's context (architecture § 11), so there is no cross-reader delete: one raw statement names the readers
 * who have a stale key, and each reader's are removed inside that reader's own context — the shape the assistant's
 * purge uses (`lib/db/assistant.ts`). Until 2026-10-03 this ran under `withSystem`, which the guard refuses, and the
 * whole of `npm run auth:sweep` failed with it.
 */
export async function sweepIdempotencyKeys(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
  const prisma = getPrisma();
  const owners = await prisma.$queryRaw<Array<{ userId: string }>>`SELECT DISTINCT "userId" FROM "IdempotencyKey" WHERE "createdAt" < ${cutoff}`;
  let removed = 0;
  for (const owner of owners) {
    const result = await withTenant({ userId: owner.userId, organisationId: null }, () => prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } }));
    removed += result.count;
  }
  return removed;
}
