-- An audit pack is prepared by a workflow (feature-specs/38 § 3; unit 55b): its span and head are known once the file
-- is written, so they are null while it prepares; `readyAt` says when it was; the day's count is read by requester.

-- AlterTable
ALTER TABLE "AuditExport" ADD COLUMN     "readyAt" TIMESTAMP(3),
ALTER COLUMN "fromSeq" DROP NOT NULL,
ALTER COLUMN "toSeq" DROP NOT NULL,
ALTER COLUMN "headHash" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "AuditExport_requestedById_createdAt_idx" ON "AuditExport"("requestedById", "createdAt");
