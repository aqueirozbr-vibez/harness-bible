-- Research proposals (feature-specs/42 § 4, § 6; unit 59): a finding that became a suggestion waits for Improve's
-- answer as SUBMITTED, and a reader's name put to a proposal is the asker's own row, one per suggestion. Additive.

-- AlterEnum
ALTER TYPE "FindingOutcome" ADD VALUE 'SUBMITTED';

-- CreateTable
CREATE TABLE "ProposalEndorsement" (
    "suggestionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalEndorsement_pkey" PRIMARY KEY ("suggestionId")
);

-- CreateIndex
CREATE INDEX "ProposalEndorsement_userId_idx" ON "ProposalEndorsement"("userId");

-- AddForeignKey
ALTER TABLE "ProposalEndorsement" ADD CONSTRAINT "ProposalEndorsement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
