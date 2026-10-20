-- cost per active account: the model spend recorded in the bucket, in USD, over the accounts with at least one message in it.
-- The spend is every BudgetLedger row, whatever its kind; an account is a reader.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
WITH spend AS (
  SELECT date_trunc($3::text, b."createdAt") AS bucket, sum(b."costUsd")::float8 AS usd
  FROM "BudgetLedger" b
  WHERE b."createdAt" >= $1::timestamp
    AND b."createdAt" < $2::timestamp
  GROUP BY 1
), active AS (
  SELECT date_trunc($3::text, m."createdAt") AS bucket, count(DISTINCT m."userId")::float8 AS accounts
  FROM "Message" m
  WHERE m."createdAt" >= $1::timestamp
    AND m."createdAt" < $2::timestamp
  GROUP BY 1
)
SELECT COALESCE(s.bucket, a.bucket) AS bucket,
       ''::text AS key,
       COALESCE(s.usd, 0) AS n,
       COALESCE(a.accounts, 0) AS d,
       COALESCE(s.usd, 0) / NULLIF(a.accounts, 0) AS value
FROM spend s
FULL JOIN active a ON a.bucket = s.bucket
ORDER BY 1
