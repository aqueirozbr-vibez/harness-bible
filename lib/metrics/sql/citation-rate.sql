-- citation rate: of the answers that made claims, the share whose citation verdict is PASS with no claim replaced.
-- An answer is an assistant row that is neither a refusal nor a failed turn. One with no claims to check
-- (citation verdict NA: a walk, whose numbers are the script's) is outside the rate.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
SELECT date_trunc($3::text, m."createdAt") AS bucket,
       ''::text AS key,
       count(*) FILTER (WHERE v.verdict = 'PASS' AND m.substituted = 0)::float8 AS n,
       count(*)::float8 AS d,
       count(*) FILTER (WHERE v.verdict = 'PASS' AND m.substituted = 0)::float8 / count(*)::float8 AS value
FROM "Message" m
JOIN "SensorVerdict" v ON v."messageId" = m.id AND v.sensor = 'citation'
WHERE m.role = 'ASSISTANT'
  AND m."refusalCause" IS NULL
  AND m."modelId" IS NOT NULL
  AND v.verdict <> 'NA'
  AND m."createdAt" >= $1::timestamp
  AND m."createdAt" < $2::timestamp
GROUP BY 1
ORDER BY 1
