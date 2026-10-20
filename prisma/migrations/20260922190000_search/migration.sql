-- feature-specs/06-search.md § 4.3: plain-text columns for headlines and ranks, three generated
-- tsvector columns with GIN indexes. Written by hand (lib/db/RAW_SQL.md): Prisma cannot declare
-- generated columns, and its diff would drop the existing one as drift.

-- Section: plain text beside the markdown; the index reads the title and the plain text.
ALTER TABLE "Section" ADD COLUMN "textEn" TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "Section_tsv_idx";
ALTER TABLE "Section" DROP COLUMN "tsv";
ALTER TABLE "Section" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("titleEn", '') || ' ' || coalesce("textEn", ''))) STORED;
CREATE INDEX "Section_tsv_idx" ON "Section" USING GIN ("tsv");

-- Lab: README title and plain text.
ALTER TABLE "Lab" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Lab" ADD COLUMN "textEn" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Lab" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("textEn", ''))) STORED;
CREATE INDEX "Lab_tsv_idx" ON "Lab" USING GIN ("tsv");

-- SourceRow: claim and citation.
ALTER TABLE "SourceRow" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("claim", '') || ' ' || coalesce("citation", ''))) STORED;
CREATE INDEX "SourceRow_tsv_idx" ON "SourceRow" USING GIN ("tsv");
