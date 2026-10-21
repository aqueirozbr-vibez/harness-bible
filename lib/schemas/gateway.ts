import { z } from "zod";

/*
 * The model gateway's vocabulary (feature-specs/11 § 5.1, § 6): the aliases the application may name, the
 * purposes a call is attributed to, the principal whose key and ledger row a call uses, and the outcome a
 * ledger row records. The workers' routes (25d) validate their bodies with these; every other module takes the
 * inferred types.
 */

/** The four aliases of infra/gateway/litellm.yaml (spec § 3.2), in the configuration's order. */
export const ALIASES = ["hb-frontier", "hb-small", "hb-embed", "hb-rerank"] as const;
export const AliasSchema = z.enum(ALIASES);
export type Alias = z.infer<typeof AliasSchema>;

export const PURPOSES = ["assistant", "grading", "adjudication", "lab", "embed", "rerank", "research"] as const;
export const PurposeSchema = z.enum(PURPOSES);
export type Purpose = z.infer<typeof PurposeSchema>;

/** Whose key, whose ledger row: an organisation, or a user for an individual account (spec § 3.4). */
export const PrincipalSchema = z.union([z.strictObject({ organisationId: z.string().min(1) }), z.strictObject({ userId: z.string().min(1) })]);
export type Principal = z.infer<typeof PrincipalSchema>;

export const OUTCOMES = ["ok", "budget", "unavailable", "refused", "provider_refusal"] as const;
export const OutcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const AGENTS = ["assistant", "grader", "adjudicator", "researcher"] as const;

/**
 * The request rows of lib/gateway/policy.ts by name (spec § 5.3). A call is given its row by its purpose and alias;
 * a call names a row only where two rows share both (unit 49f: the evidence grader's text and its PDFs and images;
 * unit 69d: the research reader and its writer, feature-specs/48 § 5.6).
 */
export const REQUEST_ROWS = ["assistantDraft", "assistantRepair", "groundingGrader", "scopeClassifier", "evidenceGrader", "evidenceGraderBytes", "adjudicator", "researchPlanner", "researchReader", "researchWriter"] as const;
export const RequestRowSchema = z.enum(REQUEST_ROWS);

/*
 * The provider's own tools a call may carry (feature-specs/41 § 3; unit 58a): web search and web fetch, in the
 * versions the Claude API reference names for the pinned frontier model (`claude-opus-5`, 2026-02-09 variants; the
 * installed SDK types both, and the proxy's forwarding of them is `npm run research:check`, Andre's). Each carries
 * its limit of uses for the request (A13: 10 searches and 10 page reads a run). Nothing else: no client tool, no
 * domain list in either direction (A3), no citations and no user location, so the model cannot ask this product to
 * do anything and the tools carry nothing about who asked. The schema is strict, so a tool of any other shape is
 * refused before the request is built.
 */
export const WEB_SEARCH_TOOL_TYPE = "web_search_20260209";
export const WEB_FETCH_TOOL_TYPE = "web_fetch_20260209";
export const WEB_SEARCH_MAX_USES = 10;
export const WEB_FETCH_MAX_USES = 10;

export const WebSearchToolSchema = z.strictObject({ type: z.literal(WEB_SEARCH_TOOL_TYPE), name: z.literal("web_search"), max_uses: z.number().int().min(1).max(WEB_SEARCH_MAX_USES) });
export const WebFetchToolSchema = z.strictObject({ type: z.literal(WEB_FETCH_TOOL_TYPE), name: z.literal("web_fetch"), max_uses: z.number().int().min(1).max(WEB_FETCH_MAX_USES) });
export const ServerToolSchema = z.union([WebSearchToolSchema, WebFetchToolSchema]);
export type ServerTool = z.infer<typeof ServerToolSchema>;
/** One to two tools, each kind at most once. */
export const ServerToolsSchema = z
  .array(ServerToolSchema)
  .min(1)
  .max(2)
  .refine((tools) => new Set(tools.map((tool) => tool.type)).size === tools.length, "each server tool at most once");
export type ServerTools = z.infer<typeof ServerToolsSchema>;

/**
 * The reader's two tools (41 § 6.1) with their uses; `remaining` lowers a limit for a continued turn so the whole
 * turn stays within the run's ten and ten (41 § 3, "the limits of uses bound the whole"). A tool with no use left
 * is left out, which is why the result may hold one tool, and `null` says neither has a use left.
 */
export function researchTools(remaining: { readonly searches: number; readonly fetches: number } = { searches: WEB_SEARCH_MAX_USES, fetches: WEB_FETCH_MAX_USES }): ServerTools | null {
  const tools: ServerTool[] = [];
  if (remaining.searches >= 1) tools.push({ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: Math.min(WEB_SEARCH_MAX_USES, remaining.searches) });
  if (remaining.fetches >= 1) tools.push({ type: WEB_FETCH_TOOL_TYPE, name: "web_fetch", max_uses: Math.min(WEB_FETCH_MAX_USES, remaining.fetches) });
  return tools.length === 0 ? null : tools;
}

/**
 * Who makes a model call (feature-specs/49 § 6.2): the purpose and the alias cannot tell a draft from a repair, so
 * every call names its agent. It is the generation's name in Langfuse (the `langfuse_generation_name` header) and
 * `hb.agent` on the call's own span. An enumeration, never text.
 */
export const AGENT_NAMES = [
  "assistant.classify",
  "assistant.draft",
  "assistant.repair",
  "assistant.grade",
  "evidence.grade",
  "evidence.grade.bytes",
  "adjudicator.decide",
  "researcher.plan",
  "researcher.read",
  "researcher.write",
  "embed.query",
  "embed.release",
  "rerank",
  "gateway.check",
  "research.check",
] as const;
export const AgentNameSchema = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentNameSchema>;

/** What every call carries (spec § 5.1): the ledger row and the span are written from these fields alone. */
export const GatewayCallSchema = z.strictObject({
  purpose: PurposeSchema,
  alias: AliasSchema,
  agent: AgentNameSchema,
  guide: z.strictObject({ agent: z.enum(AGENTS), version: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
  principal: PrincipalSchema,
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  /** message id, suggestion id, run id */
  ref: z.string().min(1).nullable(),
  /** The request row whose limits apply, when the purpose and the alias do not settle it (unit 49f). */
  row: RequestRowSchema.optional(),
  /** The provider's tools the call carries (41 § 3): the reader's two and nothing else; absent, the request holds no tool. */
  serverTools: ServerToolsSchema.optional(),
});
export type GatewayCall = z.infer<typeof GatewayCallSchema>;

/**
 * The dimensions of `hb-embed`'s vectors and of `Section.embedding` (feature-specs/12 § 3, § 4.1): a vector of any
 * other length is a pin the column cannot hold, refused before the database sees it.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * The gateway's `/v1/embeddings` answer, in the OpenAI shape LiteLLM's route returns (feature-specs/12 § 4.3): the
 * fields the client reads and nothing else, so a proxy that adds a field does not fail a call. `usage` carries
 * `prompt_tokens` on the real proxy; the ledger row reads `total_tokens` when it does not.
 */
export const EmbeddingsResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })).min(1),
  model: z.string().min(1),
  usage: z.looseObject({ prompt_tokens: z.number().int().nonnegative().optional(), total_tokens: z.number().int().nonnegative().optional() }).optional(),
});
export type EmbeddingsResponse = z.infer<typeof EmbeddingsResponseSchema>;

/**
 * The gateway's `/rerank` answer (feature-specs/12 § 7.1), in the Cohere shape LiteLLM's route normalises the
 * provider's into: one result per document by index, with its relevance score. `model` and the token counts are
 * optional because the shape that carries them differs between the proxy's `meta` and the provider's own `usage`,
 * and a call the gateway answered is recorded whichever arrived (spec 11 § 5.4).
 */
export const RerankResponseSchema = z.looseObject({
  results: z.array(z.looseObject({ index: z.number().int().nonnegative(), relevance_score: z.number() })),
  model: z.string().min(1).optional(),
  meta: z
    .looseObject({
      tokens: z.looseObject({ input_tokens: z.number().int().nonnegative().optional() }).optional(),
      billed_units: z.looseObject({ total_tokens: z.number().int().nonnegative().optional() }).optional(),
    })
    .optional(),
  usage: z.looseObject({ total_tokens: z.number().int().nonnegative().optional() }).optional(),
});
export type RerankResponse = z.infer<typeof RerankResponseSchema>;

/** `org:<id>` or `user:<id>`: the principal as one string, for `metadata.user_id` and the span. */
export function principalId(principal: Principal): string {
  return "organisationId" in principal ? `org:${principal.organisationId}` : `user:${principal.userId}`;
}

/** The inverse, for an operator-typed value (`GATEWAY_CHECK_PRINCIPAL`); null when the string is neither form. */
export function principalOfId(value: string): Principal | null {
  const org = value.startsWith("org:") ? value.slice("org:".length) : null;
  if (org !== null) return org.length === 0 ? null : { organisationId: org };
  const user = value.startsWith("user:") ? value.slice("user:".length) : null;
  if (user !== null) return user.length === 0 ? null : { userId: user };
  return null;
}
