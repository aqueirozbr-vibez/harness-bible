-- feature-specs/12 § 4.1: the section embedding, its model pin and its date, and the HNSW index the fused rank
-- reads (architecture § 4.1). Additive and forward-only. The three columns are outside the content hash: the
-- pipeline never writes them, the embedding job does (§ 4.2, under EMBED=1), so `renderHash` is unchanged.
--
-- pgvector has no Windows build for the local PostgreSQL 17 cluster (04 D8), which is why the development
-- database is the compose `db` container (§ 8, D5). The guard below says so instead of failing on a bare
-- `CREATE EXTENSION`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'the vector extension is not available on this server; the development database is the compose db service (pgvector), feature-specs/12 § 8, D5';
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Section" ADD COLUMN "embedding" vector(1024);
ALTER TABLE "Section" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "Section" ADD COLUMN "embeddedAt" TIMESTAMP(3);

-- Cosine distance (`<=>`), the operator class the fused rank's vector CTE orders by (§ 5).
CREATE INDEX "Section_embedding_hnsw" ON "Section" USING hnsw ("embedding" vector_cosine_ops);
