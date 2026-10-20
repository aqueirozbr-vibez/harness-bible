-- first-token p95: the 95th percentile of the time to the first token, in milliseconds, over the turns that streamed one.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
SELECT date_trunc($3::text, m."createdAt") AS bucket,
       ''::text AS key,
       NULL::float8 AS n,
       count(*)::float8 AS d,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY m."firstTokenMs") AS value
FROM "Message" m
WHERE m.role = 'ASSISTANT'
  AND m."firstTokenMs" IS NOT NULL
  AND m."createdAt" >= $1::timestamp
  AND m."createdAt" < $2::timestamp
GROUP BY 1
ORDER BY 1
