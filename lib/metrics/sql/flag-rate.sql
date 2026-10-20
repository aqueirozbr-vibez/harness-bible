-- flag rate: flagged assistant messages over assistant messages, as 'any' and one line per coded reason.
-- A message is counted in its own bucket, whenever the flag was placed.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
WITH turns AS (
  SELECT m.id, date_trunc($3::text, m."createdAt") AS bucket
  FROM "Message" m
  WHERE m.role = 'ASSISTANT'
    AND m."createdAt" >= $1::timestamp
    AND m."createdAt" < $2::timestamp
), totals AS (
  SELECT bucket, count(*)::float8 AS d FROM turns GROUP BY 1
), flagged AS (
  SELECT t.bucket, t.id, f.reason
  FROM turns t
  JOIN "Flag" f ON f."messageId" = t.id
)
SELECT tot.bucket,
       'any'::text AS key,
       (SELECT count(DISTINCT x.id) FROM flagged x WHERE x.bucket = tot.bucket)::float8 AS n,
       tot.d,
       (SELECT count(DISTINCT x.id) FROM flagged x WHERE x.bucket = tot.bucket)::float8 / tot.d AS value
FROM totals tot
UNION ALL
SELECT tot.bucket,
       x.reason AS key,
       count(DISTINCT x.id)::float8 AS n,
       tot.d,
       count(DISTINCT x.id)::float8 / tot.d AS value
FROM flagged x
JOIN totals tot ON tot.bucket = x.bucket
GROUP BY tot.bucket, x.reason, tot.d
ORDER BY 1, 2
