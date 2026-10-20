-- research flags by reason: the flags people put on their research reports and refusals in the bucket, by what was flagged and the coded reason, and all of them.
-- A flag is a person's label on their own run (feature-specs/48 § 11.7), read through a view that holds its day, its kind and its reason and names no person and no run.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored, by the day a flag was put.
WITH flagged AS (
  SELECT date_trunc($3::text, f.day) AS bucket,
         f.kind || ' ' || f.reason AS line
  FROM "ResearchFlag" f
  WHERE f.day >= $1::timestamp
    AND f.day < $2::timestamp
)
SELECT g.bucket,
       COALESCE(g.line, 'all') AS key,
       count(*)::float8 AS n,
       NULL::float8 AS d,
       count(*)::float8 AS value
FROM flagged g
GROUP BY GROUPING SETS ((g.bucket, g.line), (g.bucket))
ORDER BY 1, 2
