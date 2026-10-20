import { ASSISTANT_KINDS, IMPROVE_KINDS, type BudgetFacts } from "@/lib/budget/view";
import { getPrisma } from "@/lib/db/client";
import type { BudgetKind } from "@/lib/db/generated/enums";
import { withTenant, type TenantContext } from "@/lib/db/tenant";
import type { Outcome, Principal } from "@/lib/schemas/gateway";

/*
 * The BudgetLedger's queries (feature-specs/11 § 5.4, § 6): one append per model call and the month's sum for
 * the account meter. Importable by the web tier (§ 5.5). Rows are account data keyed by principal: every query
 * runs inside the principal's tenant context, and the client extension injects the principal's column and
 * refuses an update or a delete (the rows are append-only).
 */

/** The tenant context of a principal: the organisation's, or the user's for an individual account. */
export function tenantOfPrincipal(principal: Principal): TenantContext {
  return "organisationId" in principal ? { userId: null, organisationId: principal.organisationId } : { userId: principal.userId, organisationId: null };
}

/** "2026-09": the gateway's budget window is the calendar month, UTC. */
export function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface BudgetRowInput {
  readonly principal: Principal;
  readonly month: string;
  readonly kind: BudgetKind;
  readonly alias: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly outcome: Outcome;
  readonly ref: string | null;
  readonly traceId: string;
  readonly gatewayCallId: string | null;
}

export function appendBudgetRow(input: BudgetRowInput): Promise<{ readonly id: string }> {
  const { principal, ...row } = input;
  return withTenant(tenantOfPrincipal(principal), () => getPrisma().budgetLedger.create({ data: row, select: { id: true } }));
}

export interface MonthSpend {
  readonly month: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** The Decimal sum as the database prints it, never a float. */
  readonly costUsd: string;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * What grading a suggestion's evidence cost, in tokens (feature-specs/33 § 3.2; Andre, 2026-10-06): the `GRADING` rows
 * whose `ref` is the suggestion, under the principal they were charged to, after `since` when one is given — the
 * suggestion's last `graded` record — so a revision's record counts the calls since the one before. An item deleted
 * and added again is counted for each grade it had.
 */
export function gradingUsageOf(principal: Principal, suggestionId: string, since: Date | null): Promise<Usage> {
  return callsUsageOf("GRADING", principal, suggestionId, since);
}

/** The same for the adjudicator's calls (33 § 7; unit 50e): the `decided` record's tokens, since the attempt's `graded` record. */
export function adjudicationUsageOf(principal: Principal, suggestionId: string, since: Date | null): Promise<Usage> {
  return callsUsageOf("ADJUDICATION", principal, suggestionId, since);
}

async function callsUsageOf(kind: "GRADING" | "ADJUDICATION", principal: Principal, suggestionId: string, since: Date | null): Promise<Usage> {
  const sums = await withTenant(tenantOfPrincipal(principal), () =>
    getPrisma().budgetLedger.aggregate({
      where: { kind, ref: suggestionId, ...(since === null ? {} : { createdAt: { gt: since } }) },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true },
    }),
  );
  return { inputTokens: sums._sum.inputTokens ?? 0, outputTokens: sums._sum.outputTokens ?? 0, cacheReadTokens: sums._sum.cacheReadTokens ?? 0 };
}

/** One model call of a research run as the RESEARCH record names it (feature-specs/40 § 6.3; unit 58e): the alias, the id the gateway reported, the counts. */
export interface ResearchCallRow {
  readonly alias: string;
  readonly modelId: string;
  readonly outcome: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

/** A run's call with the instant its row was written: a person's run tells its writer's calls from its reader's by it (feature-specs/48 § 15). */
export interface TimedResearchCallRow extends ResearchCallRow {
  readonly createdAt: Date;
}

/**
 * The `RESEARCH` rows whose `ref` is the run, under the principal they were charged to, oldest first: a legacy run's
 * planner and reader under the research principal; a person's run's planner, reader and writer under the person's own
 * (feature-specs/48 § 7.1, § 15). Each with its instant, which a person's run's record splits at `writingAt`.
 */
export function researchCallsOf(principal: Principal, runId: string): Promise<ReadonlyArray<TimedResearchCallRow>> {
  return withTenant(tenantOfPrincipal(principal), () => getPrisma().budgetLedger.findMany({ where: { kind: "RESEARCH", ref: runId }, orderBy: { createdAt: "asc" }, select: { alias: true, modelId: true, outcome: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, createdAt: true } }));
}

/** The kinds of call a person's run is charged for: its planner, reader and writer, and retrieval's embed and re-rank. */
const RUN_COST_KINDS = ["RESEARCH", "EMBED", "RERANK"] as const;

/**
 * What a person's run cost (feature-specs/48 § 16, § 11.6; unit 71): the rows whose `ref` is the run — its planner's,
 * reader's and writer's (`RESEARCH`) and retrieval's embed and re-rank — under the principal they were charged to, as the
 * meter reads them, summed as the database prints a Decimal. Null where the run has no row yet: nothing was spent.
 */
export async function runCostOf(principal: Principal, runId: string): Promise<string | null> {
  const sums = await withTenant(tenantOfPrincipal(principal), () => getPrisma().budgetLedger.aggregate({ where: { ref: runId, kind: { in: [...RUN_COST_KINDS] } }, _count: { _all: true }, _sum: { costUsd: true } }));
  return sums._count._all === 0 ? null : (sums._sum.costUsd?.toString() ?? "0");
}

/**
 * What each of some runs cost (feature-specs/48 § 11.6; unit 73), as `runCostOf` reads one, in one statement under the
 * principal they were charged to: the research statistics' cost. A run with no row is absent: nothing was spent.
 */
export async function runCostsOf(principal: Principal, runIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> {
  if (runIds.length === 0) return new Map();
  const sums = await withTenant(tenantOfPrincipal(principal), () => getPrisma().budgetLedger.groupBy({ by: ["ref"], where: { ref: { in: [...runIds] }, kind: { in: [...RUN_COST_KINDS] } }, _sum: { costUsd: true } }));
  return new Map(sums.flatMap((sum) => (sum.ref === null ? [] : [[sum.ref, sum._sum.costUsd?.toString() ?? "0"] as const])));
}

/** The month's rows summed for the account meter (Phase 4's Account-Admin and spec 21's dashboard read it). */
export async function monthSpend(principal: Principal, month: string): Promise<MonthSpend> {
  const sums = await withTenant(tenantOfPrincipal(principal), () =>
    getPrisma().budgetLedger.aggregate({
      where: { month },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, costUsd: true },
    }),
  );
  return {
    month,
    calls: sums._count._all,
    inputTokens: sums._sum.inputTokens ?? 0,
    outputTokens: sums._sum.outputTokens ?? 0,
    cacheReadTokens: sums._sum.cacheReadTokens ?? 0,
    cacheWriteTokens: sums._sum.cacheWriteTokens ?? 0,
    costUsd: sums._sum.costUsd?.toString() ?? "0",
  };
}

export interface MonthBreakdown {
  readonly month: string;
  /**
   * One row per kind of call that wrote this month, split by whether its calls served a suggestion (`ref` set), its
   * cost a Decimal as the database prints it. The split tells Improve's grader from the assistant's (38 § 2; unit 55a).
   */
  readonly kinds: ReadonlyArray<{ readonly kind: BudgetKind; readonly suggestion: boolean; readonly calls: number; readonly costUsd: string }>;
  /**
   * The assistant's answers this month: the distinct trace ids of its rows, the grader's included (feature-specs/21
   * D2 as built). A turn is one trace, and every call it makes carries it; `ref` cannot be the count's key, because
   * the message row a call belongs to does not exist yet when the call is made, so the workers write it null — which
   * is also what tells the assistant's grader from Improve's, whose rows name the suggestion they graded.
   */
  readonly answers: number;
  /** The suggestions the month's grading and adjudication served: the distinct refs of each kind (38 § 2). */
  readonly suggestions: { readonly grading: number; readonly adjudication: number };
}

/** The month's rows by kind, the assistant's answers and the suggestions served, for the meter's breakdown (feature-specs/21 § 4.1; 38 § 2). */
export function monthBreakdown(principal: Principal, month: string): Promise<MonthBreakdown> {
  return withTenant(tenantOfPrincipal(principal), async () => {
    const prisma = getPrisma();
    const [unreferenced, referenced, traces, served] = await Promise.all([
      prisma.budgetLedger.groupBy({ by: ["kind"], where: { month, ref: null }, _count: { _all: true }, _sum: { costUsd: true } }),
      prisma.budgetLedger.groupBy({ by: ["kind"], where: { month, ref: { not: null } }, _count: { _all: true }, _sum: { costUsd: true } }),
      prisma.budgetLedger.groupBy({ by: ["traceId"], where: { month, kind: { in: [...ASSISTANT_KINDS] }, ref: null } }),
      prisma.budgetLedger.groupBy({ by: ["kind", "ref"], where: { month, kind: { in: [...IMPROVE_KINDS] }, ref: { not: null } } }),
    ]);
    const rows = (suggestion: boolean, groups: typeof unreferenced) => groups.map((row) => ({ kind: row.kind, suggestion, calls: row._count._all, costUsd: row._sum.costUsd?.toString() ?? "0" }));
    return {
      month,
      kinds: [...rows(false, unreferenced), ...rows(true, referenced)],
      answers: traces.length,
      suggestions: { grading: served.filter((row) => row.kind === "GRADING").length, adjudication: served.filter((row) => row.kind === "ADJUDICATION").length },
    };
  });
}

/**
 * The principal's cap in tokens (feature-specs/21 § 4.1): the organisation's `tokenCap` for a member, the fixed
 * individual cap for an individual account (11 D5, configuration: the caller passes what the environment holds).
 * Null when there is none to show, which the meter renders as `no cap set`. `Organisation` is not a tenant model.
 */
export async function tokenCapOf(principal: Principal, individualCap: number | null): Promise<number | null> {
  if (!("organisationId" in principal)) return individualCap;
  const organisation = await getPrisma().organisation.findUnique({ where: { id: principal.organisationId }, select: { tokenCap: true } });
  return organisation === null ? null : Number(organisation.tokenCap);
}

/** Everything the budget meter is built from, read from the rows and the cap; `budgetView` does the arithmetic. */
export async function budgetFacts(principal: Principal, now: Date, individualCap: number | null): Promise<BudgetFacts> {
  const month = monthOf(now);
  const [breakdown, capTokens] = await Promise.all([monthBreakdown(principal, month), tokenCapOf(principal, individualCap)]);
  return { month, kinds: breakdown.kinds, answers: breakdown.answers, suggestions: breakdown.suggestions, capTokens };
}
