-- The research series' two views (feature-specs/44 § 4; unit 61a). The dashboard's role reads research through these
-- and through nothing else of it: never "LedgerRecord", whose payloads hold the hashes of readers' words and the ids of
-- their messages (feature-specs/21 § 5.2), and never "ResearchRun", which names who asked (44 § 8.3). A row is a run, a
-- decision or a model call, dated to its day so that no row can be matched to a reader's message by its instant, with no
-- section, no hash, no trace and no person. npm run research:metrics reads the same views. Additive.

-- What the RESEARCH records say of each run — what it planned, how it ended, its counts, what its findings came to —
-- and the curators' accepts and declines of researchers' proposals, from their curator records.
CREATE VIEW "ResearchFact" AS
SELECT date_trunc('day', l."createdAt") AS day,
       l.kind::text AS kind,
       l.payload ->> 'planned' AS planned,
       l.payload -> 'end' ->> 'state' AS ended,
       l.payload -> 'end' ->> 'code' AS code,
       (l.payload ->> 'searches')::integer AS searches,
       (l.payload ->> 'pageReads')::integer AS "pageReads",
       jsonb_path_query_array(l.payload, '$.findings[*].outcome') AS findings,
       l.payload ->> 'action' AS action
FROM "LedgerRecord" l
WHERE l.kind = 'RESEARCH'
   OR (l.kind = 'CURATOR' AND l.payload ->> 'origin' = 'RESEARCHER' AND l.payload ->> 'action' IN ('ACCEPT', 'DECLINE'));

-- The research principal's model calls — its planner's and its reader's, and the grading and the adjudication of its
-- suggestions — the principal being the organisation research is charged to (feature-specs/40 § 7.1); and the run a
-- research call served, an id that names nobody to a role that cannot read "ResearchRun".
CREATE VIEW "ResearchSpend" AS
SELECT date_trunc('day', b."createdAt") AS day,
       b.kind::text AS kind,
       b.alias,
       b.outcome,
       b."costUsd",
       CASE WHEN b.kind = 'RESEARCH' THEN b.ref END AS run
FROM "BudgetLedger" b
WHERE b."organisationId" IN (SELECT r."organisationId" FROM "BudgetLedger" r WHERE r.kind = 'RESEARCH');
