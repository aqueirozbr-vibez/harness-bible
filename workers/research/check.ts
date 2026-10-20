import { newTraceId } from "@/lib/api/trace";
import { appendBudgetRow, type BudgetRowInput } from "@/lib/db/budget";
import { findGatewayKey } from "@/lib/db/gateway";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { defaultGatewayDeps } from "@/lib/gateway/client";
import { decryptKey } from "@/lib/gateway/keys";
import { requestFor } from "@/lib/gateway/policy";
import { webSearchFeeUsd } from "@/lib/gateway/prices";
import { callModelTurn } from "@/lib/gateway/turn";
import { researchTools, type Principal } from "@/lib/schemas/gateway";

/*
 * The research check (feature-specs/41 § 3, § 11.1; unit 58a), the workers' own code that `npm run research:check` runs
 * on the command line: one reader-row call on `hb-frontier` with both web tools limited to one use each — one search,
 * then one fetch of what it returned — through the real gateway with the research principal's key, so the proxy's
 * carrying of the fetch tool and its result block is shown too (review of units 57–58). It reports the content blocks'
 * types, the provider's counts, the gateway's recorded spend before and after (its `/key/info`, read with the key
 * itself, so whether `max_budget` moved by the fee or by the tokens alone shows; 40 § 7.3) and the ledger row's cost.
 * The key is never returned or printed.
 */

export interface ResearchCheck {
  readonly model: string;
  readonly stopReason: string | null;
  readonly continuations: number;
  readonly blockTypes: ReadonlyArray<string>;
  /** Both a `server_tool_use` and a `web_search_tool_result` block came back: the proxy carried the search tool. */
  readonly toolsCarried: boolean;
  /** A `web_fetch_tool_result` block came back: the proxy carried the fetch tool and its result. */
  readonly fetchCarried: boolean;
  readonly searches: { readonly usage: number; readonly blocks: number };
  readonly fetches: { readonly usage: number; readonly blocks: number };
  readonly pagesSeen: number;
  readonly ledger: ReadonlyArray<{ readonly kind: string; readonly costUsd: number; readonly inputTokens: number; readonly outputTokens: number; readonly outcome: string }>;
  readonly searchFeeUsd: number;
  readonly gatewaySpend: { readonly before: number | null; readonly after: number | null; readonly delta: number | null };
  readonly answer: string;
}

/** LiteLLM's `/key/info` for the key itself: `info.spend` is what the gateway has counted against the key. */
async function spendOf(baseUrl: string, key: string): Promise<number | null> {
  const response = await fetch(`${baseUrl}/key/info`, { headers: { authorization: `Bearer ${key}` } });
  if (!response.ok) return null;
  const body = (await response.json()) as { info?: { spend?: number } };
  return typeof body.info?.spend === "number" ? body.info.spend : null;
}

const PROMPT = 'Use the web_search tool exactly once, with the query "RFC idempotency-key header draft status". Then use the web_fetch tool exactly once, on the first address the search returned. Then answer with one line: that address and the page\'s title, and nothing else. Do not search or fetch again.';

export async function researchCheck(principal: Principal): Promise<ResearchCheck> {
  if (env.GATEWAY_URL === undefined) throw new AppError("GATEWAY_UNCONFIGURED", "GATEWAY_URL is not set");
  const row = await findGatewayKey(principal);
  if (row === null) throw new AppError("GATEWAY_NO_KEY", "the research principal has no gateway key: npm run gateway:key -- --org <organisationId> mints one (feature-specs/11 § 7.3)");
  const key = decryptKey(env.GATEWAY_KEY_SECRET, row.keyCiphertext);
  const before = await spendOf(env.GATEWAY_URL, key);

  const rows: BudgetRowInput[] = [];
  const deps = {
    ...defaultGatewayDeps(),
    append: async (input: BudgetRowInput) => {
      rows.push(input);
      return appendBudgetRow(input);
    },
  };
  const tools = researchTools({ searches: 1, fetches: 1 });
  if (tools === null) throw new AppError("RESEARCH_CHECK", "no tool");
  const turn = await callModelTurn(
    { purpose: "research", alias: "hb-frontier", guide: null, principal, traceId: newTraceId(), ref: null, serverTools: tools },
    { ...requestFor("researchReader"), messages: [{ role: "user", content: PROMPT }] },
    deps,
  );
  const after = await spendOf(env.GATEWAY_URL, key);

  return {
    model: turn.message.model,
    stopReason: turn.message.stop_reason,
    continuations: turn.continuations,
    blockTypes: turn.content.map((block) => block.type),
    toolsCarried: turn.content.some((block) => block.type === "server_tool_use") && turn.content.some((block) => block.type === "web_search_tool_result"),
    fetchCarried: turn.content.some((block) => block.type === "web_fetch_tool_result"),
    searches: { usage: turn.searches, blocks: turn.seen.searches.length },
    fetches: { usage: turn.fetches, blocks: turn.seen.fetches.length },
    pagesSeen: turn.pages.length,
    ledger: rows.map((ledgerRow) => ({ kind: ledgerRow.kind, costUsd: ledgerRow.costUsd, inputTokens: ledgerRow.inputTokens, outputTokens: ledgerRow.outputTokens, outcome: ledgerRow.outcome })),
    searchFeeUsd: webSearchFeeUsd(turn.searches),
    gatewaySpend: { before, after, delta: before === null || after === null ? null : after - before },
    answer: turn.seen.texts.join("\n").slice(0, 200),
  };
}
