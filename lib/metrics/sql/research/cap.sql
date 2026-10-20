-- research calls refused at the cap: the research principal's calls the gateway refused because its budget's cap was reached, by whether the day was before the month's twentieth.
-- The platform's principal alone (feature-specs/48 § 7.3): a person's research meets their own cap, which is their budget's and not this series' to count. The view's payer `platform` is the organisation whose "researchPrincipal" is true (migration 20261012200000_research_principal), never one found by its name. The one alert of feature-specs/44 § 4 reads the line before-20th: the month's research vetting spent before its twentieth day, which is information and not an incident.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored, by the day a call was refused.
SELECT date_trunc($3::text, s.day) AS bucket,
       CASE WHEN extract(day FROM s.day) < 20 THEN 'before-20th' ELSE 'from-20th' END AS key,
       count(*)::float8 AS n,
       NULL::float8 AS d,
       count(*)::float8 AS value
FROM "ResearchSpend" s
WHERE s.outcome = 'budget'
  AND s.payer = 'platform'
  AND s.day >= $1::timestamp
  AND s.day < $2::timestamp
GROUP BY 1, 2
ORDER BY 1, 2
