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
  "hb.activity.attempt",
  "hb.agent",
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
  "hb.legacy",
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
  "hb.sensor.claims",
  "hb.sensor.result",
  "hb.sensor.rule",
  "hb.sensor.substituted",
  "hb.sql_ms",
  "hb.substituted",
  "hb.total_ms",
  "hb.vector_ready",
  "hb.workflow.id",
  "hb.workflow.type",
  "langfuse.observation.level",
  "langfuse.observation.type",
  "langfuse.release",
  "langfuse.trace.metadata.code",
  "langfuse.trace.metadata.message_id",
  "langfuse.trace.metadata.outcome",
  "langfuse.trace.metadata.refusal_cause",
  "langfuse.trace.metadata.run_id",
  "langfuse.trace.metadata.suggestion_id",
  "langfuse.trace.metadata.workflow_id",
  "langfuse.trace.name",
  "langfuse.trace.tags",
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

/** The record ids a subject's trace carries as metadata (§ 6.4): fixed keys, so the collector's list can name them. */
export type TraceMetadataKey = "run_id" | "suggestion_id" | "workflow_id";

/**
 * A subject's trace attributes (feature-specs/49 § 6.4): its name, its tags (enumerations without whitespace), the
 * release it ran against and the ids of its records, carried by the subject's scope and set on every span recorded
 * inside it.
 */
export interface TraceAttributes {
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly release?: string;
  readonly metadata?: Readonly<Partial<Record<TraceMetadataKey, string>>>;
}

type LangfuseValue = string | ReadonlyArray<string>;

/** The observation types other than Langfuse's default `span` (§ 6.3). */
function typeOf(name: string): string | null {
  if (name === "assistant.answer") return "agent";
  if (name === "assistant.retrieve") return "retriever";
  if (name.startsWith("sensor.")) return "guardrail";
  return null;
}

/** The subject's own span carries how it ended, as trace metadata Langfuse can filter on (§ 6.4): never a tag. */
const OUTCOME_OF: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "assistant.answer": { outcome: "hb.outcome", refusal_cause: "hb.refusal.cause", code: "hb.code", message_id: "hb.message_id" },
  /* the run's state, with its skip's or failure's code (unit 84) */
  "research.run": { outcome: "hb.outcome", code: "hb.code" },
};

/**
 * The `langfuse.*` attributes of a product span (feature-specs/49 § 6.3, § 6.4, § 8), from its name, its own
 * attributes and its scope's trace attributes: the observation's type, a failing sensor's level `WARNING` (a sensor
 * that did not pass is the product working, never an error), the subject's name, tags, release and record ids, and on
 * the subject's own span its outcome. A legacy research run's `research.run` lands in its turn's trace (§ 7.2), whose
 * outcome is the turn's, so a run's outcome is set only in a research's own trace. This is the only module of the
 * product that names a `langfuse.` attribute.
 */
export function langfuseAttributesOf(name: string, attributes: Readonly<Record<string, unknown>>, trace?: TraceAttributes): Readonly<Record<string, LangfuseValue>> {
  const out: Record<string, LangfuseValue> = {};
  const type = typeOf(name);
  if (type !== null) out["langfuse.observation.type"] = type;
  if (name.startsWith("sensor.") && (attributes["hb.sensor.result"] === "FAIL" || attributes["hb.sensor.result"] === "WARN")) out["langfuse.observation.level"] = "WARNING";
  if (trace !== undefined) {
    out["langfuse.trace.name"] = trace.name;
    out["langfuse.trace.tags"] = trace.tags;
    if (trace.release !== undefined) out["langfuse.release"] = trace.release;
    for (const [key, value] of Object.entries(trace.metadata ?? {})) if (value !== undefined && value !== "") out[`langfuse.trace.metadata.${key}`] = value;
  }
  const outcome = name === "research.run" && trace?.name !== "research.run" ? undefined : OUTCOME_OF[name];
  for (const [key, from] of Object.entries(outcome ?? {})) {
    const value = attributes[from];
    if (typeof value === "string" && value !== "") out[`langfuse.trace.metadata.${key}`] = value;
  }
  return out;
}
