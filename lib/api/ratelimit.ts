import { getPrisma } from "@/lib/db/client";

/*
 * Token bucket in PostgreSQL (feature-specs/09 § 7 step 5, D9): one atomic
 * upsert per request. A refused request may push the bucket to -1 at most, so
 * hammering costs the caller about one extra token, never more.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the bucket is full again (or until one token is back when refused). */
  readonly resetS: number;
  readonly retryAfterS: number;
}

/** Header values from the bucket state; pure. */
export function rateLimitFrom(tokens: number, limit: number, windowS: number): RateLimitResult {
  const rate = limit / windowS;
  const allowed = tokens >= 0;
  const remaining = Math.max(0, Math.floor(tokens));
  const resetS = allowed ? Math.ceil(Math.max(0, limit - tokens) / rate) : Math.ceil((1 - tokens) / rate);
  return { allowed, limit, remaining, resetS, retryAfterS: allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) / rate)) };
}

/** Take one token from the bucket `key` (capacity `limit`, refilled over `windowS`). Listed in RAW_SQL.md. */
export async function consumeToken(key: string, limit: number, windowS: number, now = new Date()): Promise<RateLimitResult> {
  const rate = limit / windowS;
  const rows = await getPrisma().$queryRaw<Array<{ tokens: number }>>`
    INSERT INTO "RateLimitBucket" AS b ("key", "tokens", "updatedAt")
    VALUES (${key}, ${limit}::float8 - 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "tokens" = GREATEST(-1::float8, LEAST(${limit}::float8, b."tokens" + GREATEST(0::float8, EXTRACT(EPOCH FROM (${now}::timestamp - b."updatedAt"))) * ${rate}::float8) - 1),
      "updatedAt" = ${now}
    RETURNING "tokens"`;
  const tokens = rows[0]?.tokens ?? -1;
  return rateLimitFrom(tokens, limit, windowS);
}

/** Buckets untouched for a day are garbage; the sweep removes them. */
export async function sweepRateLimitBuckets(now = new Date()): Promise<number> {
  const result = await getPrisma().rateLimitBucket.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  return result.count;
}
