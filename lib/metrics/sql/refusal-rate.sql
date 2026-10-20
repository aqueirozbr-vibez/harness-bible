-- refusal rate by cause: refusals over turns, as 'any' and one line per cause.
-- A turn is an assistant row: an answer, a refusal or a failed turn.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
WITH turns AS (
  SELECT date_trunc($3::text, m."createdAt") AS bucket, m."refusalCause" AS cause
  FROM "Message" m
  WHERE m.role = 'ASSISTANT'
    AND m."createdAt" >= $1::timestamp
    AND m."createdAt" < $2::timestamp
), totals AS (
  SELECT bucket, count(*)::float8 AS d, count(cause)::float8 AS refused FROM turns GROUP BY 1
)
SELECT tot.bucket, 'any'::text AS key, tot.refused AS n, tot.d, tot.refused / tot.d AS value
FROM totals tot
UNION ALL
SELECT tot.bucket, t.cause AS key, count(*)::float8 AS n, tot.d, count(*)::float8 / tot.d AS value
FROM turns t
JOIN totals tot ON tot.bucket = t.bucket
WHERE t.cause IS NOT NULL
GROUP BY tot.bucket, t.cause, tot.d
ORDER BY 1, 2
