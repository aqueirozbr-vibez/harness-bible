import { newTraceId } from "@/lib/api/trace";
import { embedReleaseStatus, sectionsToEmbed, writeSectionEmbeddings, type EmbedReleaseStatus, type SectionToEmbed } from "@/lib/db/search";
import { AppError } from "@/lib/errors";
import { defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { embedTexts, type EmbedCall } from "@/lib/gateway/embed";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import type { Principal } from "@/lib/schemas/gateway";

/*
 * The embedding job (feature-specs/12 § 4.2) and the query embedding (§ 4.3). The job is run by
 * `npm run embed:release` after an ingestion and whenever the `hb-embed` pin changes. Both run in the workers, the
 * only process that holds a gateway key (invariant 6), and the job is the only writer of `Section`'s three
 * embedding columns, under `EMBED=1` (invariant 3 with the one exemption of D3). The job is idempotent and
 * resumable: a re-run embeds what is missing or stale and nothing else, and a batch the gateway could not answer
 * stops the run with the count done and the count left, for the next run to continue.
 */

export interface EmbedReleaseOptions {
  readonly releaseId: string;
  /** Whose key and whose budget rows: D4's platform principal is owed, so the caller names one (see the script). */
  readonly principal: Principal;
  /** Texts per `hb-embed` call. The provider's own limit is owed (§ 4.2, BLOCKED), so the operator names it. */
  readonly batchSize: number;
  /**
   * The characters of a section's text that are embedded. Not a product rule and not invented here: what a long
   * section's vector should represent is BLOCKED on Andre (tracker Open Questions, 2026-09-25), so the operator
   * states the bound the machine can serve and the report says how many sections it cut. Measured on this machine:
   * the self-hosted embedder serves 16,000 characters in 26 s and is killed by the OOM killer at 24,000, because
   * attention cost grows with the square of the length. The tail of a cut section stays findable: `Section.tsv`
   * indexes the whole text and retrieval is hybrid (§ 7).
   */
  readonly maxCharacters: number;
}

export interface EmbedReleaseReport {
  readonly releaseId: string;
  readonly model: string;
  /** Sections in the release, and how many hold a vector at the pin once the run ended. */
  readonly sections: number;
  readonly embedded: number;
  /** Rows the update statements reported, and the planned sections this run left for the next one. */
  readonly written: number;
  readonly left: number;
  readonly batches: number;
  readonly inputTokens: number;
  /** Sections whose text was longer than `maxCharacters`, so their vector represents the first part alone. */
  readonly truncated: number;
  readonly stopped: { readonly reason: "budget" | "unavailable"; readonly message: string } | null;
  readonly ms: number;
}

export interface EmbedJobDeps {
  readonly gateway: GatewayDeps;
  readonly pending: (releaseId: string) => Promise<ReadonlyArray<SectionToEmbed>>;
  readonly write: (rows: ReadonlyArray<{ readonly sectionId: string; readonly embedding: ReadonlyArray<number> }>, now: Date) => Promise<number>;
  readonly status: (releaseId: string) => Promise<EmbedReleaseStatus>;
}

export function defaultEmbedJobDeps(): EmbedJobDeps {
  return { gateway: defaultGatewayDeps(), pending: sectionsToEmbed, write: writeSectionEmbeddings, status: embedReleaseStatus };
}

/** The pending sections cut into calls of at most `size` texts, in the order the query returned them. */
export function batchesOf<T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> {
  if (!Number.isInteger(size) || size < 1) {
    throw new AppError("EMBED_BATCH_SIZE", `the batch size must be a whole number of at least 1, not ${size} (feature-specs/12 § 4.2)`);
  }
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push([...items.slice(start, start + size)]);
  return batches;
}

/** The reason a batch stopped the run, or null for an error that is a defect rather than a failing service. */
function stopReasonOf(error: unknown): "budget" | "unavailable" | null {
  if (error instanceof BudgetExceededError) return "budget";
  if (error instanceof GatewayUnavailableError) return "unavailable";
  return null;
}

/**
 * Embeds every section of the release that has no vector or one from another pin, one `hb-embed` call per batch and
 * one update per batch. Every call writes its own `BudgetLedger` row and span line (spec 11 § 5.4); this function
 * adds the counts an operator reads.
 */
export async function embedRelease(options: EmbedReleaseOptions, deps: EmbedJobDeps = defaultEmbedJobDeps()): Promise<EmbedReleaseReport> {
  const started = performance.now();
  const pending = await deps.pending(options.releaseId);
  const batches = batchesOf(pending, options.batchSize);
  let written = 0;
  let calls = 0;
  let inputTokens = 0;
  let truncated = 0;
  let stopped: EmbedReleaseReport["stopped"] = null;

  for (const batch of batches) {
    try {
      const result = await embedTexts(
        { guide: null, principal: options.principal, traceId: newTraceId(), ref: `release:${options.releaseId}` },
        batch.map((section) => {
          if (section.text.length <= options.maxCharacters) return section.text;
          truncated += 1;
          return section.text.slice(0, options.maxCharacters);
        }),
        deps.gateway,
      );
      /* The rows the statement actually updated, not the batch's size: a section that left the release between the
         plan and the write is not progress, and `left` must not claim it (review round 2, 2026-09-24). */
      written += await deps.write(
        batch.map((section, index) => ({ sectionId: section.sectionId, embedding: result.vectors[index] })),
        deps.gateway.now(),
      );
      calls += 1;
      inputTokens += result.usage.input_tokens;
    } catch (error: unknown) {
      const reason = stopReasonOf(error);
      if (reason === null) throw error;
      stopped = { reason, message: error instanceof Error ? error.message : String(error) };
      break;
    }
  }

  const status = await deps.status(options.releaseId);
  return {
    releaseId: options.releaseId,
    model: status.model,
    sections: status.sections,
    embedded: status.embedded,
    written,
    left: pending.length - written,
    batches: calls,
    inputTokens,
    truncated,
    stopped,
    ms: Math.round(performance.now() - started),
  };
}

export interface EmbeddedQuery {
  readonly embedding: ReadonlyArray<number>;
  /** The id the gateway reported; the vectors it is compared with carry the pin `EMBED_TARGET`. */
  readonly modelId: string;
  readonly ms: number;
}

/**
 * One question or search query embedded for the vector half (§ 4.3), the same `hb-embed` call of kind `EMBED` on the
 * principal's ledger as a batch of the job. The assistant calls this function directly; the web tier reaches it
 * through `POST /embed/query` (workers/server.ts), because invariant 6 keeps the gateway out of the web tier.
 */
export async function embedQuery(call: EmbedCall, text: string, deps: GatewayDeps = defaultGatewayDeps()): Promise<EmbeddedQuery> {
  const embedded = await embedTexts(call, [text], deps);
  return { embedding: embedded.vectors[0], modelId: embedded.modelId, ms: embedded.ms };
}
