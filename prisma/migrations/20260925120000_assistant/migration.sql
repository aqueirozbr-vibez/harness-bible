-- Unit 29a · the assistant's activity rows (feature-specs/15 § 3; architecture § 4.2).
--
-- Five tables, every one carrying `userId` so the tenant guard of lib/db/client.ts scopes it. Message text and
-- Citation.claimText are the only free text, and the 30-day purge of § 8 nulls exactly those two, keeping the
-- citations, verdicts, timings and ledger hashes a reader's metrics and a curator's calibration set need.
--
-- Written by hand from `prisma migrate diff`, with the pre-existing `tsv` and HNSW index drift removed: those
-- indexes are created by raw SQL in earlier migrations and Prisma's model of them is not the database's.

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');
-- CreateEnum
CREATE TYPE "AssistantMode" AS ENUM ('EXPLAIN', 'COMPARE', 'WALK', 'LAB', 'BRIEF');
-- CreateEnum
CREATE TYPE "FlagKind" AS ENUM ('ANSWER', 'REFUSAL');
-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organisationId" TEXT,
    "releaseId" TEXT NOT NULL,
    "chapter" INTEGER NOT NULL,
    "sectionId" TEXT,
    "locale" TEXT NOT NULL,
    "contextLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "textPurgedAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "mode" "AssistantMode" NOT NULL,
    "text" TEXT,
    "refusalCause" TEXT,
    "refusalBeforeRetrieval" BOOLEAN,
    "guideVersion" TEXT,
    "guideSha256" TEXT,
    "modelId" TEXT,
    "promptSha256" TEXT,
    "grounded" DECIMAL(65,30),
    "repaired" BOOLEAN NOT NULL DEFAULT false,
    "substituted" INTEGER NOT NULL DEFAULT 0,
    "citesEdition" TEXT,
    "firstTokenMs" INTEGER,
    "totalMs" INTEGER,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "cacheReadTokens" INTEGER,
    "overBudget" BOOLEAN NOT NULL DEFAULT false,
    "traceId" TEXT NOT NULL,
    "ledgerSeq" INTEGER,
    "ledgerHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sectionId" TEXT NOT NULL,
    "figureId" TEXT,
    "version" TEXT NOT NULL,
    "editionLang" TEXT NOT NULL,
    "claimText" TEXT,

    CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "SensorVerdict" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sensor" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "SensorVerdict_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Flag" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "FlagKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "Conversation_userId_lastMessageAt_idx" ON "Conversation"("userId", "lastMessageAt");
-- CreateIndex
CREATE INDEX "Message_userId_createdAt_idx" ON "Message"("userId", "createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_ordinal_key" ON "Message"("conversationId", "ordinal");
-- CreateIndex
CREATE INDEX "Citation_sectionId_idx" ON "Citation"("sectionId");
-- CreateIndex
CREATE UNIQUE INDEX "Citation_messageId_ordinal_key" ON "Citation"("messageId", "ordinal");
-- CreateIndex
CREATE UNIQUE INDEX "SensorVerdict_messageId_sensor_key" ON "SensorVerdict"("messageId", "sensor");
-- CreateIndex
CREATE INDEX "Flag_createdAt_idx" ON "Flag"("createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "Flag_messageId_userId_key" ON "Flag"("messageId", "userId");
-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SensorVerdict" ADD CONSTRAINT "SensorVerdict_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Flag" ADD CONSTRAINT "Flag_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
