-- feature-specs/36 § 6.3 (tracker unit 53d): a rubric review due, opened by the workflow's step that wrote the
-- calibration event which took a criterion's override rate past 20 % in a quarter; one per criterion and quarter.
-- Additive only (architecture § 11, invariant 30): one new table, its indexes and its key to the rubric version, which
-- it keeps as everything decided under a version does; no existing row is touched.

-- CreateTable
CREATE TABLE "RubricReview" (
    "id" TEXT NOT NULL,
    "rubricVersionId" TEXT NOT NULL,
    "criterion" TEXT NOT NULL,
    "quarter" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "overridden" INTEGER NOT NULL,
    "reviewed" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RubricReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RubricReview_quarter_idx" ON "RubricReview"("quarter");

-- CreateIndex
CREATE UNIQUE INDEX "RubricReview_criterion_quarter_key" ON "RubricReview"("criterion", "quarter");

-- AddForeignKey
ALTER TABLE "RubricReview" ADD CONSTRAINT "RubricReview_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "RubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
