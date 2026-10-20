import { createHash } from "node:crypto";

import { z } from "zod";

import { EMBEDDING_DIMENSIONS } from "@/lib/schemas/gateway";

import { tokensOf } from "./answer";

/*
 * The stub gateway's embeddings (feature-specs/12 § 9): a deterministic unit vector per text from a bag-of-words
 * hash — each lower-cased word hashed to one of the 1,024 dimensions, the counts normalised — so the same text
 * always embeds the same way and two texts sharing words come out close. It models nothing about meaning; it is
 * enough for the plumbing tests, for the fused rank to order something, and for the search page's vector row to
 * move in development. Pure: the server hands the parsed request in and writes the answer out.
 */

/** The part of the OpenAI-shaped request the stub reads; `input` is one text or a list of them. */
export const EmbeddingsRequestSchema = z.looseObject({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
});
export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

/** The words of a text: lower case, letters and digits, so punctuation and case do not change a vector. */
export function wordsOf(text: string): ReadonlyArray<string> {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** The dimension a word lands in: the first four bytes of its sha256, modulo the column's size. */
export function dimensionOf(word: string): number {
  return createHash("sha256").update(word).digest().readUInt32BE(0) % EMBEDDING_DIMENSIONS;
}

/**
 * The unit vector of a text. A text with no word at all still has to be a unit vector, because the cosine
 * distance of a zero vector is undefined: it takes dimension 0, which no word can be confused with, since an
 * empty text is the only input that reaches it.
 */
export function stubEmbedding(text: string): ReadonlyArray<number> {
  const weights = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of wordsOf(text)) weights[dimensionOf(word)] += 1;
  const norm = Math.sqrt(weights.reduce((sum, weight) => sum + weight * weight, 0));
  if (norm === 0) {
    const empty = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    empty[0] = 1;
    return empty;
  }
  return weights.map((weight) => weight / norm);
}

export interface StubEmbeddings {
  readonly data: ReadonlyArray<{ readonly object: "embedding"; readonly index: number; readonly embedding: ReadonlyArray<number> }>;
  readonly usage: { readonly prompt_tokens: number; readonly total_tokens: number };
}

/** One vector per input text, with the usage the proxy reports (input tokens only: nothing is generated). */
export function embeddings(input: EmbeddingsRequest["input"]): StubEmbeddings {
  const texts = typeof input === "string" ? [input] : input;
  const tokens = texts.reduce((sum, text) => sum + tokensOf(text), 0);
  return {
    data: texts.map((text, index) => ({ object: "embedding" as const, index, embedding: stubEmbedding(text) })),
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}
