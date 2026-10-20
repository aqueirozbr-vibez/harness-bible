import type { SessionUser } from "@/lib/auth/session";
import { budgetView, type BudgetView } from "@/lib/budget/view";
import { contributorStandingOf } from "@/lib/db/account";
import { TEXT_RETENTION_DAYS } from "@/lib/db/assistant";
import { budgetFacts, monthOf } from "@/lib/db/budget";
import {
  dailyLimitUntil,
  latestBudgetReset,
  listResearchConversations,
  readResearchConversationView,
  readSeedView,
  researchConversationCounts,
  researchRecordSeqs,
  researchStartGates,
  runsStartedSince,
  type ResearchConversationSummary,
  type SeedView,
} from "@/lib/db/research";
import { researchStats } from "@/lib/db/researchStats";
import { env } from "@/lib/env";
import { findingRoleOf, type FindingRole } from "@/lib/research/findingAction";
import type { ResearchPageState } from "@/lib/research/links";
import type { ResearchStats } from "@/lib/research/stats";
import type { ResearchRunView } from "@/lib/schemas/api";

/*
 * The Research page's loader (feature-specs/48 § 11; unit 72): everything the page shows, read as the signed-in
 * person through the tenant guard, so the list, the open research, its seed and the counts are theirs alone. A foreign
 * or unknown `research` reads as no research open; a `from` that is not the person's answered turn with its words held
 * reads as an invalid seed, and the page drops it with a notice. The composer's states are read here too, each the
 * start endpoint's own check (§ 5.2), so the page says before Start what the start would answer: the engine configured
 * (check 8), the organisation's switch (5), the budget's reset the person's latest run met (6), the day's thirty (7).
 *
 * Since unit 73 the statistics too, in the window `w` names (§ 11.6): the calendar month in UTC, or all time; the day the
 * oldest research text held is kept until, which the retention line names, as the Assistant page's statistics name
 * theirs; and whether the open research has a record to export, so its `Export JSONL` is offered only where the export
 * would answer one (§ 11.10), never a link to a 404.
 *
 * Since unit 74 who the person is to their findings (§ 8.1): `suggestGate`'s answer, the draft door's own order — a
 * contributor or curator, verified, drafts; one the throttle pauses sees its notice; anyone else sends, and is told
 * where research proposals are not configured here (the web tier reads only whether `RESEARCH_PRINCIPAL` is set, § 8.3).
 *
 * Since unit 77 the Research dock's loader too (§ 12), `loadResearchDock`: the open research with its runs and its seed,
 * the composer's closed states and the person's role to their findings, read as the page reads them — and nothing of
 * the list, the statistics or the export, which the dock does not show (the page holds the list).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** A seed as the card shows it: the answer's facts, or `deleted` for an open research whose answer is gone (§ 9.5). */
export type SeedCardView = { readonly kind: "answer"; readonly messageId: string; readonly view: SeedView } | { readonly kind: "deleted" };

/** Why Start would be refused before anything is spent, the first of the start's own checks that holds; null when it would not. */
export type ResearchClosedView = { readonly kind: "unavailable" } | { readonly kind: "offOrganisation" } | { readonly kind: "budget"; readonly resetsAt: Date } | { readonly kind: "dailyLimit"; readonly until: Date } | null;

/** A seed as the client card takes it, the page's and the dock's alike: instants as strings. */
export function seedCardOf(seed: SeedCardView): { readonly kind: "answer"; readonly conversationId: string; readonly answeredAt: string; readonly cited: ReadonlyArray<string> } | { readonly kind: "deleted" } {
  return seed.kind === "deleted" ? seed : { kind: "answer", conversationId: seed.view.conversationId, answeredAt: seed.view.answeredAt.toISOString(), cited: seed.view.cited };
}

/** The composer's closed state as the client column takes it, the page's and the dock's alike: instants as strings. */
export function closedCardOf(closed: ResearchClosedView): { readonly kind: "unavailable" } | { readonly kind: "offOrganisation" } | { readonly kind: "budget"; readonly resetsAt: string } | { readonly kind: "dailyLimit"; readonly until: string } | null {
  if (closed === null || closed.kind === "unavailable" || closed.kind === "offOrganisation") return closed;
  return closed.kind === "budget" ? { kind: "budget", resetsAt: closed.resetsAt.toISOString() } : { kind: "dailyLimit", until: closed.until.toISOString() };
}

export interface ResearchPageData {
  /** The open research with its runs' views, oldest first, and whether it has a record to export; null for the empty column. */
  readonly open: { readonly id: string; readonly openedAt: Date; readonly runs: ReadonlyArray<ResearchRunView>; readonly seed: SeedCardView | null; readonly textPurged: boolean; readonly exportable: boolean } | null;
  /** `?from=` with no research open: the seed card and the question the composer opens with; `invalid` drops it with a notice. */
  readonly from: { readonly kind: "seed"; readonly messageId: string; readonly view: SeedView } | { readonly kind: "invalid" } | null;
  readonly list: ReadonlyArray<ResearchConversationSummary>;
  readonly conversations: number;
  readonly oldestTextAt: Date | null;
  /** The runs that count toward the day's thirty, started in the last 24 hours (A8). */
  readonly today: number;
  /** Why Start would be refused before anything is spent, the first of the start's own checks that holds; null when it would not. */
  readonly closed: ResearchClosedView;
  readonly budget: BudgetView;
  /** The person's research statistics in the window (§ 11.6). */
  readonly stats: ResearchStats;
  /** Until when the oldest research text held is kept (§ 17.1); null when none is held. */
  readonly keptUntil: Date | null;
  /** Who the person is to their findings: they draft, the throttle pauses them, or they send (§ 8.1). */
  readonly findingRole: FindingRole;
}


export async function loadResearchPage(user: SessionUser, state: Required<ResearchPageState>, now: Date): Promise<ResearchPageData> {
  const asked = state.research !== null && UUID.test(state.research) ? state.research : null;
  const principal = user.organisationId === null ? { userId: user.id } : { organisationId: user.organisationId };
  const [opened, list, counts, today, gates, reset, full, facts, stats, standing] = await Promise.all([
    asked === null ? Promise.resolve(null) : readResearchConversationView(user, asked, now),
    listResearchConversations(user, { limit: state.listed }),
    researchConversationCounts(user),
    runsStartedSince(user, new Date(now.getTime() - DAY_MS)),
    researchStartGates(user),
    latestBudgetReset(user),
    dailyLimitUntil(user, now),
    budgetFacts(principal, now, env.INDIVIDUAL_TOKEN_CAP === undefined ? null : Number(env.INDIVIDUAL_TOKEN_CAP)),
    researchStats(user, state.window === "all" ? { kind: "all" } : { kind: "month", month: monthOf(now) }, now),
    contributorStandingOf(user),
  ]);

  let open: ResearchPageData["open"] = null;
  if (opened !== null) {
    const [seed, records] = await Promise.all([seedOf(user, opened.conversation.seedMessageId), researchRecordSeqs(user, opened.conversation.id)]);
    open = { id: opened.conversation.id, openedAt: opened.conversation.createdAt, runs: opened.runs, seed, textPurged: opened.conversation.textPurgedAt !== null, exportable: records !== null && records.length > 0 };
  }

  /* `from` is read only while no research is open, and only an answered turn of the person's with its words held seeds one (A6) */
  let from: ResearchPageData["from"] = null;
  if (open === null && state.from !== null) {
    const view = UUID.test(state.from) ? await readSeedView(user, state.from) : null;
    from = view !== null && view.answered ? { kind: "seed", messageId: state.from, view } : { kind: "invalid" };
  }

  return {
    open,
    from,
    list,
    conversations: counts.conversations,
    oldestTextAt: counts.oldestTextAt,
    today,
    closed: closedOf(gates, reset, full, now),
    budget: budgetView(facts, now),
    stats,
    keptUntil: counts.oldestTextAt === null ? null : new Date(counts.oldestTextAt.getTime() + TEXT_RETENTION_DAYS * DAY_MS),
    findingRole: findingRoleOf(user, standing.throttledUntil, env.RESEARCH_PRINCIPAL !== undefined, now),
  };
}

/** What the Research dock shows (§ 12): the open research, the composer's closed states and the person's role to their findings. */
export interface ResearchDockData {
  /** The open research with its runs' views, oldest first, and its seed; null for the empty dock, a foreign or unknown id among it. */
  readonly open: { readonly id: string; readonly openedAt: Date; readonly runs: ReadonlyArray<ResearchRunView>; readonly seed: SeedCardView | null } | null;
  readonly closed: ResearchClosedView;
  readonly findingRole: FindingRole;
}

/**
 * The Research dock's loader (§ 12; unit 77): `research` as the dock's parameter carries it, `1` or a research's id. A
 * signed-out person has nothing open and nothing closed — the dock shows them the sign-in notice with the form disabled —
 * and the role they would read is a reader's, the one a sign-in starts as, though with no research open no finding reads it.
 */
export async function loadResearchDock(user: SessionUser | null, research: string, now: Date): Promise<ResearchDockData> {
  if (user === null) return { open: null, closed: null, findingRole: findingRoleOf({ role: "READER", identityVerified: false }, null, env.RESEARCH_PRINCIPAL !== undefined, now) };
  const asked = UUID.test(research) ? research : null;
  const [opened, gates, reset, full, standing] = await Promise.all([
    asked === null ? Promise.resolve(null) : readResearchConversationView(user, asked, now),
    researchStartGates(user),
    latestBudgetReset(user),
    dailyLimitUntil(user, now),
    contributorStandingOf(user),
  ]);
  const open = opened === null ? null : { id: opened.conversation.id, openedAt: opened.conversation.createdAt, runs: opened.runs, seed: await seedOf(user, opened.conversation.seedMessageId) };
  return { open, closed: closedOf(gates, reset, full, now), findingRole: findingRoleOf(user, standing.throttledUntil, env.RESEARCH_PRINCIPAL !== undefined, now) };
}

/** The open research's seed (§ 11.3): the answer's card before its first question and above its runs, or the deleted line. */
async function seedOf(user: SessionUser, seedId: string | null): Promise<SeedCardView | null> {
  if (seedId === null) return null;
  const view = await readSeedView(user, seedId);
  return view === null ? { kind: "deleted" } : { kind: "answer", messageId: seedId, view };
}

/** The composer's closed state: the first of the start's own checks that holds (§ 5.2) — the engine configured (8), the organisation's switch (5), the budget's reset (6), the day's thirty (7). */
function closedOf(gates: { readonly organisation: boolean }, reset: Date | null, full: Date | null, now: Date): ResearchClosedView {
  if (env.TEMPORAL_ADDRESS === undefined || env.TEMPORAL_NAMESPACE === undefined) return { kind: "unavailable" };
  if (!gates.organisation) return { kind: "offOrganisation" };
  if (reset !== null && reset.getTime() > now.getTime()) return { kind: "budget", resetsAt: reset };
  return full === null ? null : { kind: "dailyLimit", until: full };
}
