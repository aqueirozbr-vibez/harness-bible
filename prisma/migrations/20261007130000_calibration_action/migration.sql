-- feature-specs/33 § 6.3 (tracker unit 50e, part 2): the workflow writes a curator's `curator` record and its
-- calibration event in one step (invariant 17), and the engine may run that step again; the event names the action
-- it was made from, once. Additive only (architecture § 11, invariant 30): one nullable column and its unique index;
-- no existing row is touched.

-- AlterTable
ALTER TABLE "CalibrationEvent" ADD COLUMN "curatorActionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationEvent_curatorActionId_key" ON "CalibrationEvent"("curatorActionId");
