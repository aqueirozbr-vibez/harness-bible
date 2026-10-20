-- feature-specs/07-bookmarks-notes.md § 4.2: one note per user and section (D1). Written by
-- hand (lib/db/RAW_SQL.md). The index must apply on any data, so all but the newest note per
-- (userId, sectionId) go first; the development database has none to remove.

DELETE FROM "Note" AS n
USING (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId", "sectionId" ORDER BY "updatedAt" DESC, "createdAt" DESC) AS rn
  FROM "Note"
) AS d
WHERE n."id" = d."id" AND d.rn > 1;

CREATE UNIQUE INDEX "Note_userId_sectionId_key" ON "Note"("userId", "sectionId");
