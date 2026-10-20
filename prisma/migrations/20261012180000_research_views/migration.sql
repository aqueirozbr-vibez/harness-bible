-- The research views after research on request (feature-specs/48 § 7, § 11.7, § 21; unit 70c). A person's run is now
-- charged to the person's own principal (A3): their organisation's, or their own on an individual account. Read as it
-- was built, "ResearchSpend" took every call of an organisation with a RESEARCH row, so the first person's research in
-- an organisation would have brought all of that organisation's Assistant calls into the research series, and an
-- individual's research none of it. It is redefined by run and by payer, and the flags a person puts on a report get a
-- view of their own. Relaxing and additive (invariant 30): "ResearchSpend" keeps its six columns, in their order and
-- of their types, and gains `payer` after them, which CREATE OR REPLACE keeps the grants through; "ResearchFlag" is new.

-- What research spends, by the run it served and by who paid (48 § 7.1, § 7.3):
--   * every call charged to the platform's research principal — a legacy run's planner and reader, and the grading and
--     the adjudication of the suggestions the researcher made or a person sent — payer `platform`. The principal is
--     the organisation `npm run research:org -- --create` makes (lib/db/research.ts `ensureResearchOrganisation`): the
--     one named `Research`, with no seats, which no organisation of people can be;
--   * a person's research charged to anyone else — its planner, reader and writer (kind RESEARCH), and its retrieval's
--     query embedding and re-rank, which name the run's id as their `ref` (48 § 5.3) — payer `person`. Nothing else
--     embeds or re-ranks with a uuid for its `ref`: the Assistant's retrieval names none, and the embedding job names its
--     release (`release:<id>`). An organisation's Assistant calls are never in it.
-- The run's id is the row's `ref` for the three kinds that serve a run; it names nobody to a role that cannot read
-- "ResearchRun". Each row is dated to its day; no row names a principal.
CREATE OR REPLACE VIEW "ResearchSpend" AS
SELECT date_trunc('day', b."createdAt") AS day,
       b.kind::text AS kind,
       b.alias,
       b.outcome,
       b."costUsd",
       CASE WHEN b.kind = 'RESEARCH' OR (b.kind IN ('EMBED', 'RERANK') AND b.ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN b.ref END AS run,
       CASE WHEN o.id IS NULL THEN 'person' ELSE 'platform' END AS payer
FROM "BudgetLedger" b
LEFT JOIN "Organisation" o ON o.id = b."organisationId" AND o.name = 'Research' AND o."seatLimit" = 0
WHERE o.id IS NOT NULL
   OR b.kind = 'RESEARCH'
   OR (b.kind IN ('EMBED', 'RERANK') AND b.ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- The flags people put on their research (48 § 11.7): the day of each and its coded reason, and whether it is on a
-- report or on a refusal. No person, no run id, no text: the dashboard's role reads the month's flagged reports by
-- reason through this and never "ResearchRun", which names who asked.
CREATE VIEW "ResearchFlag" AS
SELECT date_trunc('day', r."flaggedAt") AS day,
       CASE WHEN r.state = 'REFUSED' THEN 'refusal' ELSE 'report' END AS kind,
       r."flagReason" AS reason
FROM "ResearchRun" r
WHERE r."flagReason" IS NOT NULL
  AND r."flaggedAt" IS NOT NULL;
