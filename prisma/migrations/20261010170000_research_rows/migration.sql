-- The research rows (feature-specs/40 § 3; unit 57a): the run of an answered turn and what it found, the asker's own under the tenant filter; the
-- platform's marks; the two switches; what a turn hands over on Message; the RESEARCH budget kind. Additive.

-- CreateEnum
CREATE TYPE "ResearchState" AS ENUM ('QUEUED', 'PLANNING', 'READING', 'VALIDATING', 'SUBMITTING', 'DONE', 'SKIPPED', 'WAITING_BUDGET', 'FAILED');

-- CreateEnum
CREATE TYPE "ResearchSkip" AS ENUM ('OFF_USER', 'OFF_ORGANISATION', 'NOT_AN_ANSWER', 'NO_CITATION', 'DEDUPED', 'SAME_QUESTION', 'DAILY_LIMIT', 'BUDGET', 'NOTHING_TO_RESEARCH', 'TEXT_PURGED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "FindingOutcome" AS ENUM ('INVALID', 'DUPLICATE', 'REFUTED', 'PROPOSED');

-- AlterEnum
ALTER TYPE "BudgetKind" ADD VALUE 'RESEARCH';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "retrievedSections" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "uncovered" JSONB;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "researchEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "researchEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organisationId" TEXT,
    "releaseId" TEXT NOT NULL,
    "locale" "Lang" NOT NULL,
    "state" "ResearchState" NOT NULL,
    "skip" "ResearchSkip",
    "failure" TEXT,
    "gap" BOOLEAN NOT NULL,
    "sectionAnchors" TEXT[],
    "questionSha256" TEXT NOT NULL,
    "brief" TEXT,
    "briefSha256" TEXT,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "pageReads" INTEGER NOT NULL DEFAULT 0,
    "workflowId" TEXT,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "textPurgedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "outcome" "FindingOutcome" NOT NULL,
    "invalidReason" TEXT,
    "suggestionId" TEXT,

    CONSTRAINT "ResearchFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchMark" (
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3),

    CONSTRAINT "ResearchMark_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRun_messageId_key" ON "ResearchRun"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRun_workflowId_key" ON "ResearchRun"("workflowId");

-- CreateIndex
CREATE INDEX "ResearchRun_userId_createdAt_idx" ON "ResearchRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchRun_state_idx" ON "ResearchRun"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchFinding_runId_ordinal_key" ON "ResearchFinding"("runId", "ordinal");

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
