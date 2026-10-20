-- feature-specs/29-improvement-schema.md § 3 (tracker unit 46a): the rows Improve is made of. Thirteen enums,
-- fourteen tables, two more kinds for the ledger. Additive only (architecture § 11, invariant 30): nothing that
-- existed is dropped, renamed or changed, and no existing row is touched.
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema`, the known drift on the generated
-- `tsv` columns and the HNSW index removed by hand as in every migration here, and the last part written by hand
-- (lib/db/RAW_SQL.md): the checks and the trigger are what Prisma cannot state.
--
-- These are platform tables, outside the tenant filter (29 § 2): all access is through lib/db/improve.ts.

-- CreateEnum
CREATE TYPE "SuggestionOrigin" AS ENUM ('HUMAN', 'RESEARCHER');

-- CreateEnum
CREATE TYPE "AnchorKind" AS ENUM ('SECTION', 'FIGURE', 'SOURCE_ROW');

-- CreateEnum
CREATE TYPE "ChangeKind" AS ENUM ('EDIT_TEXT', 'SET_VALUE', 'EDIT_ROW', 'ADD_CLAIM', 'ADD_ROW', 'RESTRUCTURE');

-- CreateEnum
CREATE TYPE "ChangeClass" AS ENUM ('WORDING', 'CITED_FIGURE', 'DERIVED_FIGURE', 'NEW_CLAIM', 'CURATOR_ALWAYS');

-- CreateEnum
CREATE TYPE "CuratorReason" AS ENUM ('SAFETY_OT', 'SCENARIO_PARAMETER', 'STRUCTURE', 'NEW_SOURCE_TIER', 'RUBRIC');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('LINK', 'DOI', 'UPLOAD', 'LAB_RUN');

-- CreateEnum
CREATE TYPE "EvidenceTier" AS ENUM ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'U');

-- CreateEnum
CREATE TYPE "EvidenceState" AS ENUM ('PENDING', 'GRADED');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('ACCEPT', 'REQUEST_MORE', 'DECLINE', 'CURATOR_REVIEW');

-- CreateEnum
CREATE TYPE "SuggestionState" AS ENUM ('DRAFT', 'SUBMITTED', 'INTAKE_DECLINED', 'GRADED', 'SENSED', 'DECIDED', 'CURATOR_QUEUE', 'MERGING', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SuggestionSensor" AS ENUM ('SCHEMA', 'ANCHOR_EXISTS', 'EVIDENCE_PARSES', 'RATIONALE_LENGTH', 'DERIVE_CONSISTENCY', 'CROSS_CHAPTER', 'LINT');

-- CreateEnum
CREATE TYPE "SensorResult" AS ENUM ('PASS', 'FAIL', 'WARN', 'NA');

-- CreateEnum
CREATE TYPE "CuratorActionKind" AS ENUM ('ACCEPT', 'KEEP_REQUEST_MORE', 'DECLINE', 'MERGE', 'REVERT');

-- AlterEnum
-- Two kinds join the ledger's (feature-specs/29 § 3, § 5). The database is PostgreSQL 17: two values in one
-- migration are allowed since 12, as long as the migration itself does not use them, and it does not.
ALTER TYPE "LedgerKind" ADD VALUE 'RESEARCH';
ALTER TYPE "LedgerKind" ADD VALUE 'ENDORSED';

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "origin" "SuggestionOrigin" NOT NULL,
    "userId" TEXT,
    "chapterNumber" INTEGER NOT NULL,
    "chapterVersionId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "parts" "Part"[],
    "changeKind" "ChangeKind" NOT NULL,
    "changeClass" "ChangeClass" NOT NULL,
    "curatorReason" "CuratorReason",
    "proposal" JSONB,
    "proposalKey" TEXT,
    "rationale" TEXT,
    "locale" "Lang" NOT NULL,
    "state" "SuggestionState" NOT NULL DEFAULT 'DRAFT',
    "outcome" "Decision",
    "score" INTEGER,
    "rubricVersionId" TEXT NOT NULL,
    "workflowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Anchor" (
    "suggestionId" TEXT NOT NULL,
    "kind" "AnchorKind" NOT NULL,
    "sectionAnchor" TEXT NOT NULL,
    "figureAnchor" TEXT,
    "sourceRowAnchor" TEXT,
    "currentText" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "existsAtVersion" BOOLEAN NOT NULL,

    CONSTRAINT "Anchor_pkey" PRIMARY KEY ("suggestionId")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "state" "EvidenceState" NOT NULL DEFAULT 'PENDING',
    "url" TEXT,
    "doi" TEXT,
    "storageKey" TEXT,
    "labRunId" TEXT,
    "title" TEXT,
    "host" TEXT,
    "publishedOn" DATE,
    "ageDays" INTEGER,
    "fetchStatus" TEXT,
    "contentSha256" TEXT,
    "textKey" TEXT,
    "tier" "EvidenceTier",
    "baseScore" INTEGER,
    "relevance" DECIMAL(65,30),
    "recency" DECIMAL(65,30),
    "independence" DECIMAL(65,30),
    "adjustedScore" INTEGER,
    "reason" TEXT,
    "gradedBy" TEXT,
    "gradedAt" TIMESTAMP(3),

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuggestionSensorVerdict" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "sensor" "SuggestionSensor" NOT NULL,
    "result" "SensorResult" NOT NULL,
    "detail" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuggestionSensorVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Adjudication" (
    "suggestionId" TEXT NOT NULL,
    "decision" "Decision" NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "acceptAt" INTEGER,
    "floorAt" INTEGER,
    "sufficientTier" "EvidenceTier",
    "failingSensor" "SuggestionSensor",
    "guideVersion" TEXT,
    "guideSha256" TEXT,
    "modelId" TEXT,
    "promptSha256" TEXT,
    "rubricVersionId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "traceId" TEXT NOT NULL,

    CONSTRAINT "Adjudication_pkey" PRIMARY KEY ("suggestionId")
);

-- CreateTable
CREATE TABLE "CriterionVerdict" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "criterion" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "CriterionVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuratorAction" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "curatorId" TEXT,
    "action" "CuratorActionKind" NOT NULL,
    "overrideCode" TEXT,
    "criterion" TEXT,
    "note" TEXT,
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "seedMatched" BOOLEAN,
    "queueWaitMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuratorAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationEvent" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "criterion" TEXT,
    "adjudicatorDecision" "Decision",
    "adjudicatorScore" INTEGER,
    "curatorAction" "CuratorActionKind" NOT NULL,
    "overrideCode" TEXT,
    "seeded" BOOLEAN NOT NULL,
    "rubricVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubricVersion" (
    "id" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "appliesAt" TIMESTAMP(3) NOT NULL,
    "sha256" TEXT NOT NULL,
    "tiers" JSONB NOT NULL,
    "adjustments" JSONB NOT NULL,
    "examples" JSONB NOT NULL,

    CONSTRAINT "RubricVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Threshold" (
    "id" TEXT NOT NULL,
    "rubricVersionId" TEXT NOT NULL,
    "changeClass" "ChangeClass" NOT NULL,
    "acceptAt" INTEGER,
    "floorAt" INTEGER,

    CONSTRAINT "Threshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuratorRoster" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "part" "Part" NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3),

    CONSTRAINT "CuratorRoster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuggestionCounter" (
    "chapterNumber" INTEGER NOT NULL,
    "next" INTEGER NOT NULL,

    CONSTRAINT "SuggestionCounter_pkey" PRIMARY KEY ("chapterNumber")
);

-- CreateTable
CREATE TABLE "Merge" (
    "suggestionId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT,
    "versionFrom" TEXT NOT NULL,
    "versionTo" TEXT,
    "bump" TEXT NOT NULL,
    "check" JSONB,
    "mergedById" TEXT,
    "mergedAt" TIMESTAMP(3),
    "releaseFrom" TEXT NOT NULL,
    "releaseTo" TEXT,
    "revertedBy" TEXT,

    CONSTRAINT "Merge_pkey" PRIMARY KEY ("suggestionId")
);

-- CreateTable
CREATE TABLE "AuditExport" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT,
    "scope" JSONB NOT NULL,
    "fromSeq" INTEGER NOT NULL,
    "toSeq" INTEGER NOT NULL,
    "records" INTEGER NOT NULL,
    "headHash" TEXT NOT NULL,
    "storageKey" TEXT,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Suggestion_workflowId_key" ON "Suggestion"("workflowId");

-- CreateIndex
CREATE INDEX "Suggestion_state_changeClass_idx" ON "Suggestion"("state", "changeClass");

-- CreateIndex
CREATE INDEX "Suggestion_userId_createdAt_idx" ON "Suggestion"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Suggestion_chapterNumber_state_idx" ON "Suggestion"("chapterNumber", "state");

-- CreateIndex
CREATE INDEX "Suggestion_proposalKey_idx" ON "Suggestion"("proposalKey");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_suggestionId_ordinal_key" ON "EvidenceItem"("suggestionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "SuggestionSensorVerdict_suggestionId_sensor_key" ON "SuggestionSensorVerdict"("suggestionId", "sensor");

-- CreateIndex
CREATE UNIQUE INDEX "CriterionVerdict_suggestionId_criterion_key" ON "CriterionVerdict"("suggestionId", "criterion");

-- CreateIndex
CREATE INDEX "CuratorAction_suggestionId_idx" ON "CuratorAction"("suggestionId");

-- CreateIndex
CREATE INDEX "CuratorAction_overrideCode_idx" ON "CuratorAction"("overrideCode");

-- CreateIndex
CREATE INDEX "CuratorAction_curatorId_createdAt_idx" ON "CuratorAction"("curatorId", "createdAt");

-- CreateIndex
CREATE INDEX "CalibrationEvent_suggestionId_idx" ON "CalibrationEvent"("suggestionId");

-- CreateIndex
CREATE INDEX "CalibrationEvent_createdAt_idx" ON "CalibrationEvent"("createdAt");

-- CreateIndex
CREATE INDEX "CalibrationEvent_criterion_createdAt_idx" ON "CalibrationEvent"("criterion", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Threshold_rubricVersionId_changeClass_key" ON "Threshold"("rubricVersionId", "changeClass");

-- CreateIndex
CREATE UNIQUE INDEX "CuratorRoster_userId_part_key" ON "CuratorRoster"("userId", "part");

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "RubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Anchor" ADD CONSTRAINT "Anchor_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionSensorVerdict" ADD CONSTRAINT "SuggestionSensorVerdict_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjudication" ADD CONSTRAINT "Adjudication_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjudication" ADD CONSTRAINT "Adjudication_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "RubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriterionVerdict" ADD CONSTRAINT "CriterionVerdict_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuratorAction" ADD CONSTRAINT "CuratorAction_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuratorAction" ADD CONSTRAINT "CuratorAction_curatorId_fkey" FOREIGN KEY ("curatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationEvent" ADD CONSTRAINT "CalibrationEvent_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationEvent" ADD CONSTRAINT "CalibrationEvent_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "RubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Threshold" ADD CONSTRAINT "Threshold_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "RubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuratorRoster" ADD CONSTRAINT "CuratorRoster_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merge" ADD CONSTRAINT "Merge_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merge" ADD CONSTRAINT "Merge_mergedById_fkey" FOREIGN KEY ("mergedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditExport" ADD CONSTRAINT "AuditExport_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- written by hand ----------

-- A suggestion's id is S, its chapter in two digits and a serial of four digits or more (29 § 4.2), and the
-- chapter in the id is the row's own. The CASE keeps the cast from running on an id of another form.
ALTER TABLE "Suggestion"
  ADD CONSTRAINT "Suggestion_id_form" CHECK (
    CASE WHEN "id" ~ '^S-[0-9]{2}-[0-9]{4,}$' THEN substring("id" from 3 for 2)::int = "chapterNumber" ELSE false END
  ),
  -- A researcher's proposal has no contributor. A person's may lose its own: the account's hard delete nulls it.
  ADD CONSTRAINT "Suggestion_researcher_has_no_user" CHECK ("origin" = 'HUMAN' OR "userId" IS NULL),
  -- The reason is why a suggestion is CURATOR_ALWAYS: set for that class and for no other.
  ADD CONSTRAINT "Suggestion_curatorReason_with_its_class" CHECK (("changeClass" = 'CURATOR_ALWAYS') = ("curatorReason" IS NOT NULL)),
  -- At least the anchor's own part: a suggestion in no part is one no curator could be handed.
  ADD CONSTRAINT "Suggestion_parts_named" CHECK ("parts" IS NOT NULL AND cardinality("parts") >= 1),
  -- The key is the hash of a proposal: the two are there together or not at all.
  ADD CONSTRAINT "Suggestion_proposalKey_with_its_proposal" CHECK (("proposal" IS NULL) = ("proposalKey" IS NULL)),
  ADD CONSTRAINT "Suggestion_proposalKey_form" CHECK ("proposalKey" ~ '^[0-9a-f]{64}$');

-- An anchor names a section always, and beside it the one figure or the one source row its kind says (31 § 3:
-- the request is `{ kind, id }`, one id).
ALTER TABLE "Anchor"
  ADD CONSTRAINT "Anchor_kind_names_its_row" CHECK (
    ("kind" = 'SECTION' AND "figureAnchor" IS NULL AND "sourceRowAnchor" IS NULL)
    OR ("kind" = 'FIGURE' AND "figureAnchor" IS NOT NULL AND "sourceRowAnchor" IS NULL)
    OR ("kind" = 'SOURCE_ROW' AND "sourceRowAnchor" IS NOT NULL AND "figureAnchor" IS NULL)
  ),
  ADD CONSTRAINT "Anchor_contentSha256_form" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$');

-- Every sha256 in these tables is 64 lower-case hex characters, as the ledger's hashes are (migration
-- 20260923143500_ledger). A null passes: the column is there before the thing it hashes.
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_contentSha256_form" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "Adjudication"
  ADD CONSTRAINT "Adjudication_guideSha256_form" CHECK ("guideSha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Adjudication_promptSha256_form" CHECK ("promptSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "RubricVersion" ADD CONSTRAINT "RubricVersion_sha256_form" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "AuditExport" ADD CONSTRAINT "AuditExport_headHash_form" CHECK ("headHash" ~ '^[0-9a-f]{64}$');

-- The bounds the spec gives in words.
ALTER TABLE "CuratorAction" ADD CONSTRAINT "CuratorAction_note_length" CHECK (char_length("note") <= 400);
ALTER TABLE "CuratorRoster" ADD CONSTRAINT "CuratorRoster_until_after_since" CHECK ("until" IS NULL OR "until" > "since");
ALTER TABLE "SuggestionCounter" ADD CONSTRAINT "SuggestionCounter_next_from_one" CHECK ("next" >= 1);

-- "From SUBMITTED on nothing is deleted, because the ledger refers to it" (29 § 3). Every child of a suggestion
-- cascades from it, so this one refusal covers them all: a draft goes with everything it has, and a suggestion
-- past draft cannot go, whatever the client code does.
CREATE FUNCTION suggestion_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'SUGGESTION_KEPT: % is past draft and is never deleted, because the ledger refers to it (feature-specs/29 § 3)', OLD."id";
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER suggestion_kept BEFORE DELETE ON "Suggestion" FOR EACH ROW EXECUTE FUNCTION suggestion_kept();
