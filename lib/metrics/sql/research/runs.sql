-- research runs by how they ended: the runs that reached the planner, from their RESEARCH records, by DONE or by the skip's or the failure's code, and all of them.
-- A turn the hand-over skipped (feature-specs/40 § 5) has no record and is counted by its research.run line in Loki; a record written before unit 61 says what was planned and not how the run ended, and reads as planned and what.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored, by the day a record was written.
WITH runs AS (
  SELECT date_trunc($3::text, f.day) AS bucket,
         CASE
           WHEN f.ended IS NULL THEN 'planned ' || f.planned
           WHEN f.code IS NULL THEN f.ended
           ELSE f.ended || ' ' || f.code
         END AS line
  FROM "ResearchFact" f
  WHERE f.kind = 'RESEARCH'
    AND f.day >= $1::timestamp
    AND f.day < $2::timestamp
)
SELECT r.bucket,
       COALESCE(r.line, 'all') AS key,
       count(*)::float8 AS n,
       NULL::float8 AS d,
       count(*)::float8 AS value
FROM runs r
GROUP BY GROUPING SETS ((r.bucket, r.line), (r.bucket))
ORDER BY 1, 2
