-- The month's thirty sends to Improve (feature-specs/48 § 8.3, D5; review of unit 74). As unit 74 built them, they
-- were counted as the person's findings with a "sentAt" in the month: rows the person's own deletes remove (a refuted
-- finding of a deleted research, the nightly sweep's second pass), and a "sentAt" that only the send's transaction
-- writes, after the press, so a burst of presses all read the old count. The thirty are now a counter of their own,
-- one row a person a calendar month in UTC, in which the send's transaction takes a place, atomically, exactly when a
-- finding becomes a suggestion (lib/db/research.ts `sendFindingTx`, lib/db/RAW_SQL.md). No delete of a finding or a
-- research reaches it; the account's erasure takes it by the key's cascade (spec 46).
-- Additive (invariant 30): a new table, and its rows for the months already sent in, from the findings that still
-- hold a "sentAt" (stored in UTC, as every timestamp here).

-- CreateTable
CREATE TABLE "ResearchSendMonth" (
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ResearchSendMonth_pkey" PRIMARY KEY ("userId","month"),
    CONSTRAINT "ResearchSendMonth_month_check" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "ResearchSendMonth_count_check" CHECK ("count" >= 0)
);

-- AddForeignKey
ALTER TABLE "ResearchSendMonth" ADD CONSTRAINT "ResearchSendMonth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The months already sent in. A finding has no key to its person, so one whose account is gone is left out.
INSERT INTO "ResearchSendMonth" ("userId", "month", "count")
SELECT f."userId", to_char(f."sentAt", 'YYYY-MM'), count(*)::integer
FROM "ResearchFinding" f
JOIN "User" u ON u."id" = f."userId"
WHERE f."sentAt" IS NOT NULL
GROUP BY f."userId", to_char(f."sentAt", 'YYYY-MM');
