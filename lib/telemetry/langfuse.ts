/*
 * What of the product's own spans may reach Langfuse (feature-specs/49 § 5.5, § 6.5; unit 79). The collector holds
 * the road: its Langfuse pipeline keeps, of every span that is not the gateway's, exactly the attributes named here
 * (`keep_keys` in infra/observability/otel-collector.yaml; tests/observability.test.ts compares the two lists).
 * Tempo is not this list's business: it receives every span as spec 21 defined it.
 *
 * An allow-list, not a deny-list: a key a span builder adds stays on this machine until it is named here or among
 * the exclusions below, and lib/telemetry/langfuse.test.ts fails until it is one or the other. So a new attribute is a
 * decision, not an accident (code-standards, Workers). No key here names a person, an account, a session or an
 * address, and none ever may (§ 6.5, D1): only ids of records, counts, codes, hashes, timings and enumerations.
 */

/** Every attribute key of a product span that may go to Langfuse, in the collector's order. */
export const PRODUCT_LANGFUSE_KEYS = [
  "gen_ai.operation.name",
  "hb.aid.exit_code",
  "hb.aid.id",
  "hb.aid.runner",
  "hb.aid.timed_out",
  "hb.alias",
  "hb.candidates",
  "hb.citations.resolved",
  "hb.citations.total",
  "hb.code",
  "hb.cost_usd",
  "hb.edition.cited",
  "hb.edition.locale",
  "hb.edition.mismatch",
  "hb.embed_ms",
  "hb.first_token_ms",
  "hb.gateway.call_id",
  "hb.grounded",
  "hb.guide.sha256",
  "hb.guide.version",
  "hb.job",
  "hb.message_id",
  "hb.mode",
  "hb.outcome",
  "hb.over_budget",
  "hb.policy",
  "hb.price_unknown",
  "hb.prompt.sha256",
  "hb.purpose",
  "hb.refusal.cause",
  "hb.repaired",
  "hb.rerank_ms",
  "hb.research.dropped",
  "hb.research.findings",
  "hb.research.page_reads",
  "hb.research.paragraphs",
  "hb.research.proposed",
  "hb.research.refuted",
  "hb.research.run_id",
  "hb.research.searches",
  "hb.secret.detected",
  "hb.secret.redacted",
  "hb.sql_ms",
  "hb.substituted",
  "hb.total_ms",
  "hb.vector_ready",
] as const;

/**
 * The keys a span builder emits that never go to Langfuse, each for its reason (§ 5.5). A name ending in `.` stands
 * for every key it begins.
 */
export const PRODUCT_LANGFUSE_EXCLUDED: ReadonlyArray<string> = [
  /* a person, an account, an address (§ 6.5, D1) */
  "hb.principal",
  "hb.subject",
  "url.path",
  "http.",
  /* the generation beneath the span carries these, so no call is counted twice (§ 5.3) */
  "gen_ai.usage.",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.system",
  /* the collector's mark, used to make the span a root and then dropped (§ 5.6) */
  "hb.parent",
  /* a job's counts are named by the job, so no fixed list can hold them; a job's span never takes the road (§ 5.5) */
  "hb.count.",
];
