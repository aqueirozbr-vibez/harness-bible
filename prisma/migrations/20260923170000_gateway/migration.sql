-- feature-specs/11 § 6: the model gateway's rows (architecture § 5.5; § 11 invariants 6 and 7). Additive only;
-- written from `prisma migrate diff` with the known `tsv` drift lines removed (lib/db/RAW_SQL.md). The two CHECKs
-- make the database itself refuse a row that names no principal or both: a key or a budget row belongs to one
-- organisation or, for an individual account, to one user (spec § 3.4).

-- CreateEnum
CREATE TYPE "BudgetKind" AS ENUM ('ASSISTANT', 'GRADING', 'ADJUDICATION', 'LAB', 'EMBED', 'RERANK');

-- AlterTable (spec D4: no default; the value for a new organisation is owed and recorded as blocked)
ALTER TABLE "Organisation" ADD COLUMN     "tokensPerMinute" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "GatewayKey" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "userId" TEXT,
    "litellmKeyId" TEXT NOT NULL,
    "keyCiphertext" TEXT NOT NULL,
    "maxBudgetUsd" DECIMAL(65,30) NOT NULL,
    "tokensPerMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "GatewayKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GatewayKey_one_principal" CHECK (("organisationId" IS NULL) <> ("userId" IS NULL))
);

-- CreateTable
CREATE TABLE "BudgetLedger" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "userId" TEXT,
    "month" TEXT NOT NULL,
    "kind" "BudgetKind" NOT NULL,
    "alias" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(65,30) NOT NULL,
    "outcome" TEXT NOT NULL,
    "ref" TEXT,
    "traceId" TEXT NOT NULL,
    "gatewayCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BudgetLedger_one_principal" CHECK (("organisationId" IS NULL) <> ("userId" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "GatewayKey_organisationId_key" ON "GatewayKey"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayKey_userId_key" ON "GatewayKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayKey_litellmKeyId_key" ON "GatewayKey"("litellmKeyId");

-- CreateIndex
CREATE INDEX "BudgetLedger_organisationId_month_idx" ON "BudgetLedger"("organisationId", "month");

-- CreateIndex
CREATE INDEX "BudgetLedger_userId_month_idx" ON "BudgetLedger"("userId", "month");

-- AddForeignKey
ALTER TABLE "GatewayKey" ADD CONSTRAINT "GatewayKey_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayKey" ADD CONSTRAINT "GatewayKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
