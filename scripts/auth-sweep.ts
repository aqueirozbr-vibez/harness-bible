import "dotenv/config";

import { sweepIdempotencyKeys } from "@/lib/api/idempotency";
import { logJob } from "@/lib/api/log";
import { sweepRateLimitBuckets } from "@/lib/api/ratelimit";
import { newTraceId } from "@/lib/api/trace";
import { sweepExpiredSessions } from "@/lib/auth/session";
import { sweepAuthEvents } from "@/lib/db/audit";
import { getPrisma } from "@/lib/db/client";
import { startTelemetry, stopTelemetry } from "@/lib/telemetry/tracer";

/*
 * npm run auth:sweep (feature-specs/08 § 5.2, 09 § 8.6): removes expired sessions, idempotency keys past their 24
 * hours, stale rate buckets and audit rows past 90 days. It runs nightly from `infra/schedules/` (feature-specs/21
 * § 3.1), prints its counts and one `kind: "job"` line, and exits 1 with the line's `error` when it throws.
 */

const JOB = "auth:sweep";

async function main(): Promise<void> {
  /* The job's line is a span too when a collector is configured (feature-specs/21 § 5.1). */
  await startTelemetry("hb-jobs");
  const traceId = newTraceId();
  const started = performance.now();
  try {
    const [sessions, keys, buckets, events] = await Promise.all([sweepExpiredSessions(), sweepIdempotencyKeys(), sweepRateLimitBuckets(), sweepAuthEvents()]);
    console.log(`auth:sweep removed ${String(sessions)} session(s), ${String(keys)} idempotency key(s), ${String(buckets)} rate bucket(s), ${String(events)} audit row(s)`);
    logJob({ traceId, job: JOB, counts: { sessions, keys, buckets, events }, ms: Math.round(performance.now() - started) });
  } catch (error: unknown) {
    logJob({ traceId, job: JOB, counts: {}, ms: Math.round(performance.now() - started), error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopTelemetry();
    await getPrisma().$disconnect();
  });
