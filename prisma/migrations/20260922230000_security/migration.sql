-- feature-specs/09-keycloak-oauth.md § 9: the audit table, the rate-limit buckets and the
-- idempotency keys. Additive only; written by hand (lib/db/RAW_SQL.md).

CREATE TABLE "AuthEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "sessionId" TEXT,
  "kind" TEXT NOT NULL,
  "detail" JSONB NOT NULL,
  "ipHash" TEXT NOT NULL,
  "userAgent" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuthEvent_userId_createdAt_idx" ON "AuthEvent"("userId", "createdAt");
CREATE INDEX "AuthEvent_createdAt_idx" ON "AuthEvent"("createdAt");
ALTER TABLE "AuthEvent" ADD CONSTRAINT "AuthEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RateLimitBucket" (
  "key" TEXT NOT NULL,
  "tokens" DOUBLE PRECISION NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "IdempotencyKey" (
  "userId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "bodyHash" TEXT NOT NULL,
  "status" INTEGER,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("userId", "path", "key")
);
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");
