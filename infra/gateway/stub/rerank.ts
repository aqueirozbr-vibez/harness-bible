import { z } from "zod";

import { tokensOf } from "./answer";
import { wordsOf } from "./embed";

/*
 * The stub gateway's re-ranker (feature-specs/12 § 9): a document scores by how much of the query's vocabulary it
 * carries, normalised to 0–1, and `top_n` is respected. It models nothing a cross-encoder does; it is enough for
 * the plumbing tests and for retrieval to order 40 candidates deterministically without a provider. Pure: the
 * server hands the parsed request in and writes the answer out.
 */

/** The part of the Cohere-shaped request the stub reads (LiteLLM's `/rerank` route). */
export const RerankRequestSchema = z.looseObject({
  model: z.string().min(1),
  query: z.string().min(1),
  documents: z.array(z.string()).min(1),
  top_n: z.number().int().positive().optional(),
});
export type RerankRequest = z.infer<typeof RerankRequestSchema>;

/**
 * The share of the query's distinct words the document carries: 1 when it holds all of them, 0 when it holds none.
 * A query with no word at all scores every document 0, since there is nothing to overlap with.
 */
export function overlapScore(query: string, document: string): number {
  const asked = new Set(wordsOf(query));
  if (asked.size === 0) return 0;
  const held = new Set(wordsOf(document));
  let found = 0;
  for (const word of asked) if (held.has(word)) found += 1;
  return found / asked.size;
}

export interface StubRerank {
  readonly results: ReadonlyArray<{ readonly index: number; readonly relevance_score: number }>;
  readonly meta: { readonly tokens: { readonly input_tokens: number; readonly output_tokens: number } };
}

/** Every document scored, by score descending and then by position, cut to `top_n` when the request gave one. */
export function reranked(request: RerankRequest): StubRerank {
  const scored = request.documents.map((document, index) => ({ index, relevance_score: overlapScore(request.query, document) }));
  const ordered = [...scored].sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
  const tokens = request.documents.reduce((sum, document) => sum + tokensOf(document), tokensOf(request.query));
  return { results: ordered.slice(0, request.top_n ?? ordered.length), meta: { tokens: { input_tokens: tokens, output_tokens: 0 } } };
}
