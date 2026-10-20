import { tenantOf, type SessionUser } from "@/lib/auth/session";
import type { StatsWindow } from "@/lib/db/assistantStats";
import { runCostsOf } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { callerOf, listOwnSuggestions, readProposalsForAsker } from "@/lib/db/improve";
import { withTenant } from "@/lib/db/tenant";
import { monthWindow } from "@/lib/metrics/assistant";
import { DRAFT_OUTCOMES, researchStatsOf, SENT_OUTCOMES, type ResearchStats } from "@/lib/research/stats";
import type { Principal } from "@/lib/schemas/gateway";

/*
 * The person's research statistics (feature-specs/48 § 11.6, A9; unit 73): the rows `lib/research/stats.ts` counts, read
 * as the signed-in person, so the Research page's third region is theirs and nobody else's (invariant 24). No endpoint
 * and no policy kind: a server component reads this for the person, as the Assistant page reads `readerStats` and the
 * account page the budget.
 *
 * - **The runs**: the person's, in their research conversations — so never a legacy run of an answered turn, which the
 *   platform paid for, and never a run a delete detached from its research, which went with the research — started in
 *   the window. Every cell but the flags counts those with a workflow: a question a rule refused at its start reached
 *   nothing and is no run of the statistics. Its flag is a flag, though, so the flags count every run (§ 11.7; review
 *   of unit 73); `researchStatsOf` tells them apart by `workflow`.
 * - **Their cost**: the `BudgetLedger` rows that name them, inside the context of the principal each was charged to,
 *   as the meter reads them (`runCostsOf`).
 * - **The pages seen**: the length of each run's `found.read`, while its text is held, read in SQL (`pagesSeenOf`) so
 *   the rest of `found` — every finding, page and note of every run in the window — never leaves the database for one
 *   number a run (review of unit 73). The one raw statement here, registered in lib/db/RAW_SQL.md.
 * - **Accepted**: a finding's suggestion merged — a draft's by the owner's own read of their suggestions, a sent one's
 *   by the improvement door's read for the asker (`readProposalsForAsker`), each asked only where a finding names one.
 */

/** The window's bounds on a run's start; none for all time. */
function boundsOf(window: StatsWindow): { readonly gte: Date; readonly lt: Date } | undefined {
  if (window.kind === "all") return undefined;
  const { from, to } = monthWindow(window.month);
  return { gte: from, lt: to };
}

/**
 * How many pages each of the runs listed (`found.read`), by run id: a run whose text is gone, or whose `found` holds no
 * list, has no entry, and its count reads `—`. Raw, since the client selects a JSON column whole; a raw statement passes
 * no guard, so the person's id is bound beside the ids, inside their tenant context.
 */
async function pagesSeenOf(user: SessionUser, ids: ReadonlyArray<string>): Promise<ReadonlyMap<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await withTenant(tenantOf(user), () =>
    getPrisma().$queryRaw<Array<{ id: string; seen: number }>>`
      SELECT "id", jsonb_array_length("found" -> 'read') AS "seen"
        FROM "ResearchRun"
       WHERE "userId" = ${user.id} AND "id" = ANY(${[...ids]}::text[])
         AND "textPurgedAt" IS NULL AND jsonb_typeof("found" -> 'read') = 'array'`,
  );
  return new Map(rows.map((row) => [row.id, row.seen]));
}

export async function researchStats(user: SessionUser, window: StatsWindow, now: Date): Promise<ResearchStats> {
  const bounds = boundsOf(window);
  const rows = await withTenant(tenantOf(user), () =>
    getPrisma().researchRun.findMany({
      where: { conversationId: { not: null }, ...(bounds === undefined ? {} : { createdAt: bounds }) },
      select: { id: true, organisationId: true, workflowId: true, state: true, skip: true, failure: true, createdAt: true, textPurgedAt: true, searches: true, pageReads: true, flaggedAt: true, findings: { select: { outcome: true, suggestionId: true } } },
    }),
  );
  /* the runs every cell but the flags counts: those with a workflow */
  const working = rows.filter((row) => row.workflowId !== null);

  /* each run's cost under the principal it was charged to: the person's organisation then, or the person */
  const byPrincipal = new Map<string, { readonly principal: Principal; readonly ids: string[] }>();
  for (const row of working) {
    const principal: Principal = row.organisationId === null ? { userId: user.id } : { organisationId: row.organisationId };
    const key = row.organisationId ?? `user:${user.id}`;
    const group = byPrincipal.get(key) ?? { principal, ids: [] };
    group.ids.push(row.id);
    byPrincipal.set(key, group);
  }
  const costs = new Map<string, string>();
  for (const { principal, ids } of byPrincipal.values()) for (const [ref, cost] of await runCostsOf(principal, ids)) costs.set(ref, cost);
  const seen = await pagesSeenOf(user, working.flatMap((row) => (row.textPurgedAt === null ? [row.id] : [])));

  /* the suggestions the findings made, and which of them are merged */
  const findings = working.flatMap((row) => row.findings);
  const drafts = [...new Set(findings.flatMap((finding) => (DRAFT_OUTCOMES.has(finding.outcome) && finding.suggestionId !== null ? [finding.suggestionId] : [])))];
  const sent = [...new Set(findings.flatMap((finding) => (SENT_OUTCOMES.has(finding.outcome) && finding.suggestionId !== null ? [finding.suggestionId] : [])))];
  const caller = callerOf(user);
  const merged = new Set<string>();
  if (drafts.length > 0) for (const own of await listOwnSuggestions(caller)) if (own.state === "MERGED" && drafts.includes(own.id)) merged.add(own.id);
  if (sent.length > 0) for (const proposal of await readProposalsForAsker(caller, sent)) if (proposal.state === "MERGED") merged.add(proposal.id);

  return researchStatsOf(
    rows.map((row) => ({
      state: row.state,
      skip: row.skip,
      failure: row.failure,
      createdAt: row.createdAt,
      textPurgedAt: row.textPurgedAt,
      workflow: row.workflowId !== null,
      searches: row.searches,
      pageReads: row.pageReads,
      pagesSeen: seen.get(row.id) ?? null,
      costUsd: costs.get(row.id) ?? null,
      flagged: row.flaggedAt !== null,
      findings: row.findings,
    })),
    merged,
    now,
  );
}
