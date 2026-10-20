-- CreateEnum
CREATE TYPE "Part" AS ENUM ('P0', 'P1', 'P2', 'P3', 'P4');

-- CreateEnum
CREATE TYPE "Carries" AS ENUM ('PROSE', 'INSTRUMENT', 'LAB');

-- CreateEnum
CREATE TYPE "Layer" AS ENUM ('INTUITION', 'MECHANISM', 'WORKED_NUMBERS', 'MEASUREMENT', 'FAILURE', 'FRONTIER', 'INDUSTRIAL_APPLICATION', 'DECISION_AIDS', 'SOURCES');

-- CreateEnum
CREATE TYPE "SourceTier" AS ENUM ('PRIMARY', 'VENDOR', 'ANALYST', 'PRACTITIONER', 'ILLUSTRATIVE', 'DERIVED', 'OPEN');

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('EN', 'PT');

-- CreateEnum
CREATE TYPE "VerifyStatus" AS ENUM ('PASSED', 'FAILED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('REPRODUCED', 'NOT_REPRODUCED', 'KILLED', 'ERROR');

-- CreateEnum
CREATE TYPE "EditionStatus" AS ENUM ('PARITY', 'PENDING');

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "gitSha" TEXT NOT NULL,
    "renderHash" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chapter" (
    "number" INTEGER NOT NULL,
    "part" "Part" NOT NULL,
    "slug" TEXT NOT NULL,
    "carries" "Carries" NOT NULL,

    CONSTRAINT "Chapter_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "ChapterVersion" (
    "id" TEXT NOT NULL,
    "chapterNumber" INTEGER NOT NULL,
    "releaseId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourceLang" "Lang" NOT NULL DEFAULT 'EN',
    "verifyStatus" "VerifyStatus" NOT NULL,
    "redteamStatus" "VerifyStatus" NOT NULL,
    "redteamOpen" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "words" INTEGER NOT NULL,
    "derivedLinked" INTEGER NOT NULL,
    "derivedTotal" INTEGER NOT NULL,
    "citedTotal" INTEGER NOT NULL,
    "citedFastMoving" INTEGER NOT NULL,

    CONSTRAINT "ChapterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Edition" (
    "id" TEXT NOT NULL,
    "chapterVersionId" TEXT NOT NULL,
    "lang" "Lang" NOT NULL,
    "status" "EditionStatus" NOT NULL,
    "title" TEXT NOT NULL,
    "standfirst" TEXT NOT NULL,

    CONSTRAINT "Edition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "chapterVersionId" TEXT NOT NULL,
    "layer" "Layer" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titlePt" TEXT,
    "markdownEn" TEXT NOT NULL,
    "markdownPt" TEXT,
    "htmlEn" TEXT NOT NULL,
    "htmlPt" TEXT,
    "codeBlocks" JSONB NOT NULL,
    "tsv" tsvector,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Figure" (
    "id" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "valueText" TEXT NOT NULL,
    "value" DECIMAL(65,30),
    "unit" TEXT,
    "tier" "SourceTier" NOT NULL,
    "fastMoving" BOOLEAN NOT NULL DEFAULT false,
    "scenarioParam" BOOLEAN NOT NULL DEFAULT false,
    "sourceRowId" TEXT,

    CONSTRAINT "Figure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeriveLink" (
    "figureId" TEXT NOT NULL,
    "labId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL DEFAULT 'derive.py',
    "line" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "expression" TEXT NOT NULL,

    CONSTRAINT "DeriveLink_pkey" PRIMARY KEY ("figureId")
);

-- CreateTable
CREATE TABLE "SourceRow" (
    "id" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "chapterVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "claim" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "url" TEXT,
    "doi" TEXT,
    "tier" "SourceTier" NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "fastMoving" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SourceRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrossReference" (
    "id" TEXT NOT NULL,
    "chapterVersionId" TEXT NOT NULL,
    "fromSectionId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,

    CONSTRAINT "CrossReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lab" (
    "id" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "chapterVersionId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "readme" TEXT NOT NULL,
    "expectedRuntimeS" INTEGER,
    "wallClockCapS" INTEGER NOT NULL DEFAULT 600,
    "cpu" INTEGER NOT NULL DEFAULT 2,
    "memoryGiB" INTEGER NOT NULL DEFAULT 4,
    "declaresModelCalls" BOOLEAN NOT NULL DEFAULT false,
    "egressExtra" TEXT[],
    "ciVerdict" "Verdict",
    "ciCheckedAt" TIMESTAMP(3),
    "ciDivergedSince" TIMESTAMP(3),
    "derived" JSONB NOT NULL,

    CONSTRAINT "Lab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabFile" (
    "id" TEXT NOT NULL,
    "labId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "LabFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Release_gitSha_key" ON "Release"("gitSha");

-- CreateIndex
CREATE UNIQUE INDEX "Chapter_slug_key" ON "Chapter"("slug");

-- CreateIndex
CREATE INDEX "ChapterVersion_releaseId_idx" ON "ChapterVersion"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ChapterVersion_chapterNumber_version_key" ON "ChapterVersion"("chapterNumber", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ChapterVersion_chapterNumber_releaseId_key" ON "ChapterVersion"("chapterNumber", "releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Edition_chapterVersionId_lang_key" ON "Edition"("chapterVersionId", "lang");

-- CreateIndex
CREATE INDEX "Section_anchor_idx" ON "Section"("anchor");

-- CreateIndex
CREATE INDEX "Section_chapterVersionId_layer_idx" ON "Section"("chapterVersionId", "layer");

-- CreateIndex
CREATE UNIQUE INDEX "Section_chapterVersionId_ordinal_key" ON "Section"("chapterVersionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Section_chapterVersionId_anchor_key" ON "Section"("chapterVersionId", "anchor");

-- CreateIndex
CREATE INDEX "Figure_anchor_idx" ON "Figure"("anchor");

-- CreateIndex
CREATE INDEX "Figure_tier_fastMoving_idx" ON "Figure"("tier", "fastMoving");

-- CreateIndex
CREATE UNIQUE INDEX "Figure_sectionId_anchor_key" ON "Figure"("sectionId", "anchor");

-- CreateIndex
CREATE INDEX "SourceRow_verifiedAt_idx" ON "SourceRow"("verifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRow_chapterVersionId_ordinal_key" ON "SourceRow"("chapterVersionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRow_chapterVersionId_anchor_key" ON "SourceRow"("chapterVersionId", "anchor");

-- CreateIndex
CREATE INDEX "CrossReference_targetId_idx" ON "CrossReference"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Lab_chapterVersionId_key" ON "Lab"("chapterVersionId");

-- CreateIndex
CREATE INDEX "Lab_anchor_idx" ON "Lab"("anchor");

-- CreateIndex
CREATE UNIQUE INDEX "LabFile_labId_path_key" ON "LabFile"("labId", "path");

-- AddForeignKey
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_chapterNumber_fkey" FOREIGN KEY ("chapterNumber") REFERENCES "Chapter"("number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edition" ADD CONSTRAINT "Edition_chapterVersionId_fkey" FOREIGN KEY ("chapterVersionId") REFERENCES "ChapterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_chapterVersionId_fkey" FOREIGN KEY ("chapterVersionId") REFERENCES "ChapterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Figure" ADD CONSTRAINT "Figure_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Figure" ADD CONSTRAINT "Figure_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "SourceRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeriveLink" ADD CONSTRAINT "DeriveLink_figureId_fkey" FOREIGN KEY ("figureId") REFERENCES "Figure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRow" ADD CONSTRAINT "SourceRow_chapterVersionId_fkey" FOREIGN KEY ("chapterVersionId") REFERENCES "ChapterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossReference" ADD CONSTRAINT "CrossReference_chapterVersionId_fkey" FOREIGN KEY ("chapterVersionId") REFERENCES "ChapterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossReference" ADD CONSTRAINT "CrossReference_fromSectionId_fkey" FOREIGN KEY ("fromSectionId") REFERENCES "Section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lab" ADD CONSTRAINT "Lab_chapterVersionId_fkey" FOREIGN KEY ("chapterVersionId") REFERENCES "ChapterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabFile" ADD CONSTRAINT "LabFile_labId_fkey" FOREIGN KEY ("labId") REFERENCES "Lab"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL Prisma cannot declare (lib/db/RAW_SQL.md; feature-specs/04 § 3).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Section.tsv is a generated column; the schema declares it Unsupported("tsvector").
ALTER TABLE "Section" DROP COLUMN "tsv";
ALTER TABLE "Section" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("titleEn", '') || ' ' || coalesce("markdownEn", ''))) STORED;
CREATE INDEX "Section_tsv_idx" ON "Section" USING GIN ("tsv");

-- Exactly one current release (feature-specs/04 § 11 D9).
CREATE UNIQUE INDEX "release_one_current" ON "Release" ("isCurrent") WHERE "isCurrent";
