-- edition mismatch share: of the answers that cite the book, the share whose reader's language is not the cited
-- edition's, one line per reader's language. While the Portuguese editions are pending, a Portuguese answer cites the
-- English edition, and this is the measure of that gap. An answer that cites nothing has no edition to differ from
-- and is outside the share.
-- Parameters: 1 window start (inclusive), 2 window end (exclusive), 3 the bucket, a unit date_trunc takes. UTC, as stored.
SELECT date_trunc($3::text, m."createdAt") AS bucket,
       c.locale AS key,
       count(*) FILTER (WHERE lower(m."citesEdition") <> c.locale)::float8 AS n,
       count(*)::float8 AS d,
       count(*) FILTER (WHERE lower(m."citesEdition") <> c.locale)::float8 / count(*)::float8 AS value
FROM "Message" m
JOIN "Conversation" c ON c.id = m."conversationId"
WHERE m.role = 'ASSISTANT'
  AND m."refusalCause" IS NULL
  AND m."modelId" IS NOT NULL
  AND m."citesEdition" IS NOT NULL
  AND m."createdAt" >= $1::timestamp
  AND m."createdAt" < $2::timestamp
GROUP BY 1, 2
ORDER BY 1, 2
