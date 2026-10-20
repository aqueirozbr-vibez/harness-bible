-- Withdrawing a suggestion (feature-specs/45 § 5; unit 63b): a contributor's withdrawal of a suggestion that waits for a
-- person is a ledger record of its own kind, and the suggestion keeps when it was asked for. Additive (invariant 30).

-- AlterEnum
ALTER TYPE "LedgerKind" ADD VALUE 'RETRACTED';

-- AlterTable
ALTER TABLE "Suggestion" ADD COLUMN "withdrawnAt" TIMESTAMP(3);
