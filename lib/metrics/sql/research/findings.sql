-- findings by outcome: what came of each finding of the runs whose records were written in the bucket, and all of them.
-- INVALID and DUPLICATE are the validation's and the door's; PROPOSED and REFUTED are Improve's answer; SUBMITTED is a finding still deciding when its run's wait ran out.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored, by the day a record was written.
WITH found AS (
  SELECT date_trunc($3::text, f.day) AS bucket,
         o.outcome
  FROM "ResearchFact" f
  CROSS JOIN LATERAL jsonb_array_elements_text(f.findings) AS o(outcome)
  WHERE f.kind = 'RESEARCH'
    AND f.day >= $1::timestamp
    AND f.day < $2::timestamp
)
SELECT g.bucket,
       COALESCE(g.outcome, 'all') AS key,
       count(*)::float8 AS n,
       NULL::float8 AS d,
       count(*)::float8 AS value
FROM found g
GROUP BY GROUPING SETS ((g.bucket, g.outcome), (g.bucket))
ORDER BY 1, 2
