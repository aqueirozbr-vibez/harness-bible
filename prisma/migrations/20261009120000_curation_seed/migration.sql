-- feature-specs/36 § 7.1 (tracker unit 53e): a seed, a suggestion another curator decided offered again to a curator
-- under a fresh id, with that decision as the known answer; offered only while CURATOR_SEED_SHARE is above 0 (A16).
-- Additive only (architecture § 11, invariant 30): one new table, its indexes and its two keys; no existing row is
-- touched. A seed goes with its suggestion, which past draft is never deleted, and with the curator's account.

-- CreateTable
CREATE TABLE "CurationSeed" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "curatorId" TEXT NOT NULL,
    "answer" "CuratorActionKind" NOT NULL,
    "standing" "Decision",
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionId" TEXT,

    CONSTRAINT "CurationSeed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CurationSeed_actionId_key" ON "CurationSeed"("actionId");

-- CreateIndex
CREATE INDEX "CurationSeed_curatorId_actionId_idx" ON "CurationSeed"("curatorId", "actionId");

-- CreateIndex
CREATE UNIQUE INDEX "CurationSeed_curatorId_suggestionId_key" ON "CurationSeed"("curatorId", "suggestionId");

-- AddForeignKey
ALTER TABLE "CurationSeed" ADD CONSTRAINT "CurationSeed_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurationSeed" ADD CONSTRAINT "CurationSeed_curatorId_fkey" FOREIGN KEY ("curatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
