-- cache read share: tokens read from the prompt cache over all prompt tokens, on the frontier alias's answered calls.
-- The prompt is what was sent: the uncached input, the cache reads and the cache writes.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
SELECT date_trunc($3::text, b."createdAt") AS bucket,
       ''::text AS key,
       sum(b."cacheReadTokens")::float8 AS n,
       sum(b."inputTokens" + b."cacheReadTokens" + b."cacheWriteTokens")::float8 AS d,
       sum(b."cacheReadTokens")::float8 / NULLIF(sum(b."inputTokens" + b."cacheReadTokens" + b."cacheWriteTokens"), 0)::float8 AS value
FROM "BudgetLedger" b
WHERE b.alias = 'hb-frontier'
  AND b.outcome = 'ok'
  AND b."createdAt" >= $1::timestamp
  AND b."createdAt" < $2::timestamp
GROUP BY 1
ORDER BY 1
