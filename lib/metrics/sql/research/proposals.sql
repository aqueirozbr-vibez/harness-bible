-- researcher proposals by curator decision: the curators' accepts and declines of researchers' proposals in the bucket, each as a share of the decisions in it, from the curator records.
-- The accept line is the researcher's precision of feature-specs/44 § 3, zero in a bucket of declines alone; a curator's merge and a revert are not decisions on a proposal and are not here.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored, by the day a decision was recorded.
WITH decided AS (
  SELECT date_trunc($3::text, f.day) AS bucket,
         f.action
  FROM "ResearchFact" f
  WHERE f.kind = 'CURATOR'
    AND f.day >= $1::timestamp
    AND f.day < $2::timestamp
), totals AS (
  SELECT x.bucket,
         count(*)::float8 AS decisions
  FROM decided x
  GROUP BY 1
), actions AS (
  SELECT a.action FROM (VALUES ('ACCEPT'), ('DECLINE')) AS a(action)
)
SELECT t.bucket,
       a.action AS key,
       count(x.action)::float8 AS n,
       t.decisions AS d,
       count(x.action)::float8 / t.decisions AS value
FROM totals t
CROSS JOIN actions a
LEFT JOIN decided x ON x.bucket = t.bucket AND x.action = a.action
GROUP BY t.bucket, a.action, t.decisions
ORDER BY 1, 2
