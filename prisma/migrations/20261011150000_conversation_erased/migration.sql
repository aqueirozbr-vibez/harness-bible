-- Deleting a conversation (feature-specs/45 § 3; unit 62b): a reader's deletion is a ledger record of its own kind (D2);
-- a research run still working when its conversation is deleted is detached from its message, and a proposal the sweep
-- keeps outlives its run. Relaxing only: both keys keep ON DELETE CASCADE, so a message deleted with its run attached
-- still takes the run, as the gates' and the suites' cleanups rely on (invariant 30).

-- AlterEnum
ALTER TYPE "LedgerKind" ADD VALUE 'ERASED';

-- AlterTable
ALTER TABLE "ResearchRun" ALTER COLUMN "messageId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ResearchFinding" ALTER COLUMN "runId" DROP NOT NULL;
