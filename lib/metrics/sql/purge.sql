-- purge: conversations whose text the retention run cleared, by the instant of the run that cleared them.
-- The count of messages a run nulled is in the run's own job line, not in a row.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
SELECT date_trunc($3::text, c."textPurgedAt") AS bucket,
       ''::text AS key,
       count(*)::float8 AS n,
       NULL::float8 AS d,
       count(*)::float8 AS value
FROM "Conversation" c
WHERE c."textPurgedAt" >= $1::timestamp
  AND c."textPurgedAt" < $2::timestamp
GROUP BY 1
ORDER BY 1
