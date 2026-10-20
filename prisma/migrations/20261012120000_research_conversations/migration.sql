-- Research on request (feature-specs/48 § 4.2; unit 68a): a person's research is a conversation of runs. A run of it
-- reuses ResearchRun, keyed by its own id; it carries its question, its live steps, its report and its refusal, and a
-- finding that passed the checks gets a row of its own (VALID) for the buttons that use it. Additive and relaxing
-- (invariant 30): every new column is nullable or has a default, and a legacy run keeps its messageId.

-- AlterEnum
ALTER TYPE "FindingOutcome" ADD VALUE 'VALID';
ALTER TYPE "FindingOutcome" ADD VALUE 'DRAFTED';

-- AlterEnum
ALTER TYPE "ResearchState" ADD VALUE 'WRITING';
ALTER TYPE "ResearchState" ADD VALUE 'REFUSED';

-- AlterTable
ALTER TABLE "ResearchFinding" ADD COLUMN     "failure" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ResearchRun" ADD COLUMN     "budgetResetsAt" TIMESTAMP(3),
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "flagReason" TEXT,
ADD COLUMN     "flaggedAt" TIMESTAMP(3),
ADD COLUMN     "ordinal" INTEGER,
ADD COLUMN     "question" TEXT,
ADD COLUMN     "refusal" TEXT,
ADD COLUMN     "report" JSONB,
ADD COLUMN     "steps" JSONB,
ADD COLUMN     "targetAnchors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "writingAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Suggestion" ADD COLUMN     "fromResearch" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ResearchConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organisationId" TEXT,
    "locale" "Lang" NOT NULL,
    "seedMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "textPurgedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchConversation_userId_lastRunAt_idx" ON "ResearchConversation"("userId", "lastRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRun_conversationId_ordinal_key" ON "ResearchRun"("conversationId", "ordinal");

-- AddForeignKey
ALTER TABLE "ResearchConversation" ADD CONSTRAINT "ResearchConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ResearchConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A run follows an answered turn (a legacy run) or belongs to a research conversation, never both (48 § 4.2). Prisma
-- cannot express a CHECK; it is written here by hand.
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_message_or_conversation" CHECK ("messageId" IS NULL OR "conversationId" IS NULL);
