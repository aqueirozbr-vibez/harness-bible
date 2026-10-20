-- grounded distribution: the median (p50) and the 10th percentile (p10) of the grader's score, over the graded answers.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
SELECT g.bucket, q.key, NULL::float8 AS n, g.d, q.value
FROM (
  SELECT date_trunc($3::text, m."createdAt") AS bucket,
         count(*)::float8 AS d,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.grounded::float8) AS p50,
         percentile_cont(0.1) WITHIN GROUP (ORDER BY m.grounded::float8) AS p10
  FROM "Message" m
  WHERE m.role = 'ASSISTANT'
    AND m.grounded IS NOT NULL
    AND m."createdAt" >= $1::timestamp
    AND m."createdAt" < $2::timestamp
  GROUP BY 1
) g
CROSS JOIN LATERAL (VALUES ('p10'::text, g.p10), ('p50'::text, g.p50)) AS q(key, value)
ORDER BY 1, 2
