-- feature-specs/34 § 25 (unit 51d's follow-up, decided on Andre's "use your recommendation"): an upload's file name as
-- the contributor's browser gave it, shown on the evidence list and to the curator. The grader's input never reads it
-- (32 § 7.1: the grader may never read the contributor, and a name is the contributor's words). Additive only
-- (architecture § 11, invariant 30): one nullable column; no existing row is touched.

-- AlterTable
ALTER TABLE "EvidenceItem" ADD COLUMN "fileName" TEXT;
