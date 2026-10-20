-- research cost per run: what the runs' own calls cost in the bucket, in USD, over the runs whose reader the gateway answered in it.
-- A run's calls are the ones that name it (feature-specs/48 § 7.1): its planner, its reader and its writer, and its retrieval's embedding and re-rank, whoever paid; the platform's vetting of the findings people send names a suggestion, not a run, and is not a run's cost. A run that planned nothing costs the runs that read.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored, by the day a call was made.
WITH spend AS (
  SELECT date_trunc($3::text, s.day) AS bucket,
         sum(s."costUsd")::float8 AS usd,
         count(DISTINCT s.run) FILTER (WHERE s.kind = 'RESEARCH' AND s.alias = 'hb-frontier' AND s.outcome = 'ok')::float8 AS reads
  FROM "ResearchSpend" s
  WHERE s.run IS NOT NULL
    AND s.day >= $1::timestamp
    AND s.day < $2::timestamp
  GROUP BY 1
)
SELECT p.bucket,
       ''::text AS key,
       p.usd AS n,
       p.reads AS d,
       p.usd / NULLIF(p.reads, 0) AS value
FROM spend p
ORDER BY 1
