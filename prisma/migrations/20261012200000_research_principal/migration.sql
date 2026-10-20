-- The platform's research principal marked by a column of its own (feature-specs/48 § 7.3; review of unit 70). As
-- 20261012180000_research_views built it, "ResearchSpend" took the principal to be the organisation named 'Research'
-- with no seats: a name any organisation could be given, and one an operator could change, moving the platform's calls
-- into a person's column or a person's into the platform's. The principal is now the one organisation whose
-- "researchPrincipal" is true, which `npm run research:org -- --create` sets (lib/db/research.ts
-- `ensureResearchOrganisation`, which also finds it by the column), and a partial unique index keeps it to one at most.
-- Additive and relaxing (invariant 30): a column with a default, an index, and the view redefined with its seven
-- columns in their order and of their types, which CREATE OR REPLACE keeps the grants of (infra/observability/init.sql).

ALTER TABLE "Organisation" ADD COLUMN "researchPrincipal" BOOLEAN NOT NULL DEFAULT false;

-- The organisation the command made before this column, as the earlier view recognised it; the oldest, should a second
-- such row exist, since the command found the first and created no other.
UPDATE "Organisation"
SET "researchPrincipal" = true
WHERE "id" = (
  SELECT "id" FROM "Organisation"
  WHERE "name" = 'Research' AND "seatLimit" = 0
  ORDER BY "createdAt", "id"
  LIMIT 1
);

-- One research principal at most: a second `true` is refused.
CREATE UNIQUE INDEX "Organisation_researchPrincipal_key" ON "Organisation" ("researchPrincipal") WHERE "researchPrincipal";

-- What research spends, by the run it served and by who paid (48 § 7.1, § 7.3), as 20261012180000_research_views
-- defined it but for how the platform's principal is found: by its column, never by its name.
CREATE OR REPLACE VIEW "ResearchSpend" AS
SELECT date_trunc('day', b."createdAt") AS day,
       b.kind::text AS kind,
       b.alias,
       b.outcome,
       b."costUsd",
       CASE WHEN b.kind = 'RESEARCH' OR (b.kind IN ('EMBED', 'RERANK') AND b.ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN b.ref END AS run,
       CASE WHEN o.id IS NULL THEN 'person' ELSE 'platform' END AS payer
FROM "BudgetLedger" b
LEFT JOIN "Organisation" o ON o.id = b."organisationId" AND o."researchPrincipal"
WHERE o.id IS NOT NULL
   OR b.kind = 'RESEARCH'
   OR (b.kind IN ('EMBED', 'RERANK') AND b.ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
