-- feature-specs/14-ledger-core.md § 4.1: the hash-chained ledger (architecture § 4.3; § 11 invariant 16).
-- Additive only; written by hand (lib/db/RAW_SQL.md). The trigger makes the database itself refuse
-- an UPDATE or a DELETE whatever the client code does; the CHECK pins both hashes to 64 lower-case hex.

CREATE TYPE "LedgerKind" AS ENUM ('SUBMITTED', 'GRADED', 'SENSORS', 'DECIDED', 'CURATOR', 'MERGED', 'ANSWER', 'EXPORT');

CREATE TABLE "LedgerRecord" (
  "seq" SERIAL NOT NULL,
  "kind" "LedgerKind" NOT NULL,
  "actor" TEXT NOT NULL,
  "suggestionId" TEXT,
  "chapterVersionId" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "prevHash" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  CONSTRAINT "LedgerRecord_pkey" PRIMARY KEY ("seq"),
  CONSTRAINT "LedgerRecord_hash_form" CHECK ("hash" ~ '^[0-9a-f]{64}$' AND "prevHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "LedgerRecord_hash_key" ON "LedgerRecord"("hash");
CREATE INDEX "LedgerRecord_suggestionId_seq_idx" ON "LedgerRecord"("suggestionId", "seq");
CREATE INDEX "LedgerRecord_chapterVersionId_seq_idx" ON "LedgerRecord"("chapterVersionId", "seq");
CREATE INDEX "LedgerRecord_kind_createdAt_idx" ON "LedgerRecord"("kind", "createdAt");

CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_APPEND_ONLY: a LedgerRecord row is never updated or deleted (architecture § 11, invariant 16)';
END
$$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON "LedgerRecord" FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
