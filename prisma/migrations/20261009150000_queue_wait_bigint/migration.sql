-- A curator's wait in the queue is milliseconds, and a wait of 25 days is past what an INTEGER holds (unit 53's review):
-- the decision on an item that waited that long failed on the insert, on every retry.

-- AlterTable
ALTER TABLE "CuratorAction" ALTER COLUMN "queueWaitMs" SET DATA TYPE BIGINT;
