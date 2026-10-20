-- feature-specs/33 § 5.4 and § 6.1 (tracker unit 50d): the adjudicator's one failure, named on its row, which is
-- what the curator's queue shows for it (36 § 3.1, "an adjudicator's failure"). Additive only (architecture § 11,
-- invariant 30): one nullable column and its check; no existing row is touched.

-- AlterTable
ALTER TABLE "Adjudication" ADD COLUMN "failure" TEXT;

-- A failure is named only on the row of a suggestion it sent to a curator.
ALTER TABLE "Adjudication" ADD CONSTRAINT "Adjudication_failure_with_curator_review" CHECK ("failure" IS NULL OR "decision" = 'CURATOR_REVIEW');
