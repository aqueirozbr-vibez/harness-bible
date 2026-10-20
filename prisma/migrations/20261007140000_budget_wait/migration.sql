-- feature-specs/33 § 7 (tracker unit 50f, part 2): the reset a suggestion's run sleeps until at a budget cap, which the
-- suggestion shows where its state is shown (`waiting for budget · resets 01 Nov`). Additive only (architecture § 11,
-- invariant 30): one nullable column; no existing row is touched.

-- AlterTable
ALTER TABLE "Suggestion" ADD COLUMN "budgetResetsAt" TIMESTAMP(3);
