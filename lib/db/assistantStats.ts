import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { ASSISTANT_KINDS } from "@/lib/budget/view";
import { tenantOfPrincipal } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";
import { monthWindow } from "@/lib/metrics/assistant";
import { ratio, statsOf, type Ratio, type ReaderStats } from "@/lib/metrics/reader";
import type { Principal } from "@/lib/schemas/gateway";

/*
 * The reader's own statistics (feature-specs/25 § 4): the rows `lib/metrics/reader.ts` counts, read through the
 * tenant guard, so what a reader's page shows is that reader's turns and nobody else's (invariant 24). No raw SQL:
 * the statements of `lib/metrics/sql/` stay the script's and the gate's (lib/db/RAW_SQL.md) and nothing is added to
 * that register. No endpoint and no policy kind either: a server component reads this for the signed-in reader, as
 * the account page reads the budget.
 */

/** The window a reader's statistics cover: one calendar month in UTC, as the budget meter's, or everything. */
export type StatsWindow = { readonly kind: "month"; readonly month: string } | { readonly kind: "all" };

export interface ReaderPanelStats extends ReaderStats {
  readonly window: StatsWindow;
  /** purge.sql: conversations whose text the retention run cleared in the window. */
  readonly purged: number;
  /** cache-read-share.sql: tokens read from the prompt cache over all prompt tokens, on the frontier alias's answered calls of the Assistant's kinds (`ASSISTANT`, `GRADING`). */
  readonly cacheReadShare: Ratio;
  /** Whose calls the cache share is of: `BudgetLedger` rows belong to whoever pays, the reader or their organisation. */
  readonly payer: "account" | "organisation";
}

/** The alias and the outcome cache-read-share.sql counts. */
const FRONTIER = "hb-frontier";
const ANSWERED = "ok";

function boundsOf(window: StatsWindow): { readonly gte: Date; readonly lt: Date } | undefined {
  if (window.kind === "all") return undefined;
  const { from, to } = monthWindow(window.month);
  return { gte: from, lt: to };
}

export async function readerStats(user: SessionUser, window: StatsWindow): Promise<ReaderPanelStats> {
  const bounds = boundsOf(window);

  const { rows, purged } = await withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const messages = await prisma.message.findMany({
      where: { role: "ASSISTANT", ...(bounds === undefined ? {} : { createdAt: bounds }) },
      select: {
        refusalCause: true,
        modelId: true,
        substituted: true,
        firstTokenMs: true,
        grounded: true,
        citesEdition: true,
        verdicts: { where: { sensor: "citation" }, select: { verdict: true } },
        flags: { select: { reason: true } },
        conversation: { select: { locale: true } },
      },
    });
    const cleared = await prisma.conversation.count({ where: { textPurgedAt: bounds === undefined ? { not: null } : bounds } });
    return { rows: messages, purged: cleared };
  });

  /* The calls are the payer's: the organisation's for a member, the reader's own on an individual account (spec 11 § 3.4).
     By kind as well as by alias (feature-specs/48 § 7.1): a person's research is charged to the same principal now, and
     its reader and writer are frontier calls of kind RESEARCH, which are not the Assistant's to count. */
  const principal: Principal = user.organisationId === null ? { userId: user.id } : { organisationId: user.organisationId };
  const tokens = await withTenant(tenantOfPrincipal(principal), () =>
    getPrisma().budgetLedger.aggregate({
      where: { alias: FRONTIER, outcome: ANSWERED, kind: { in: [...ASSISTANT_KINDS] }, ...(bounds === undefined ? {} : { createdAt: bounds }) },
      _sum: { inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
    }),
  );
  const read = tokens._sum.cacheReadTokens ?? 0;

  return {
    ...statsOf(
      rows.map((row) => ({
        refusalCause: row.refusalCause,
        modelId: row.modelId,
        substituted: row.substituted,
        firstTokenMs: row.firstTokenMs,
        grounded: row.grounded === null ? null : Number(row.grounded),
        citesEdition: row.citesEdition,
        citationVerdict: row.verdicts[0]?.verdict ?? null,
        flagReasons: row.flags.map((flag) => flag.reason),
        locale: row.conversation.locale,
      })),
    ),
    window,
    purged,
    cacheReadShare: ratio(read, (tokens._sum.inputTokens ?? 0) + read + (tokens._sum.cacheWriteTokens ?? 0)),
    payer: user.organisationId === null ? "account" : "organisation",
  };
}
