import { projection } from "@/lib/budget/projection";
import type { BudgetKind } from "@/lib/db/generated/enums";
import { tokensOfUsd } from "@/lib/gateway/prices";

/*
 * What the budget meter shows (feature-specs/21 § 4), built from the rows the gateway's calls wrote and nothing
 * else: the page never asks the gateway (invariants 6 and 17). Pure; every number the instrument prints is computed
 * here (invariant 12) and the component only formats.
 *
 * The unit (D7): the gateway caps dollars — the token cap priced at the frontier input rate (11 D3) — so "used" is
 * the month's cost read back at that same rate. Percent used is then cost over budget, which is exactly what the
 * gateway compares before it refuses a call.
 */

export type BudgetConsumer = "assistant" | "research" | "grading" | "adjudication" | "retrieval" | "labs";
export type BudgetState = "nocap" | "empty" | "running" | "atcap";

/**
 * Which row of the breakdown a call belongs to (feature-specs/38 § 2; unit 55a). The `GRADING` kind serves two
 * callers: the assistant's grader, part of every answer (21 D2), and Improve's grader of a suggestion's evidence
 * (33 § 3.2), whose rows name the suggestion they served in `ref`. The adjudicator's rows (33 § 7) always do.
 */
function consumerOf(kind: BudgetKind, suggestion: boolean): BudgetConsumer {
  switch (kind) {
    /* a person's research is on their own budget since unit 68 (feature-specs/48 § 7.1, A3): the planner, the reader and
       the writer of their runs. A legacy run's calls were the platform's research principal's, never on a reader's meter. */
    case "RESEARCH":
      return "research";
    case "ASSISTANT":
      return "assistant";
    case "GRADING":
      return suggestion ? "grading" : "assistant";
    case "ADJUDICATION":
      return "adjudication";
    case "EMBED":
    case "RERANK":
      return "retrieval";
    case "LAB":
      return "labs";
  }
}

const CONSUMERS: ReadonlyArray<BudgetConsumer> = ["assistant", "research", "grading", "adjudication", "retrieval", "labs"];

/** The kinds whose distinct traces are the breakdown's answers (D2: the grader is part of every answer), among the rows that served no suggestion. */
export const ASSISTANT_KINDS: ReadonlyArray<BudgetKind> = ["ASSISTANT", "GRADING"];

/** The kinds a contributor's principal pays for in Improve (33 § 7), whose rows name the suggestion they served. */
export const IMPROVE_KINDS: ReadonlyArray<BudgetKind> = ["GRADING", "ADJUDICATION"];

export interface BudgetFacts {
  /** "2026-10": the gateway's window, the calendar month in UTC. */
  readonly month: string;
  /**
   * The month's cost per kind of call, each a Decimal as the database prints it, split by whether the calls served a
   * suggestion (`ref` set): Improve's grader and the adjudicator name the suggestion, the assistant's calls name nothing.
   */
  readonly kinds: ReadonlyArray<{ readonly kind: BudgetKind; readonly costUsd: string; readonly suggestion: boolean }>;
  /** Turns that reached a model: the distinct trace ids of the assistant's rows (D2). */
  readonly answers: number;
  /** The suggestions the month's grading and adjudication served: the distinct refs of each kind (38 § 2). */
  readonly suggestions: { readonly grading: number; readonly adjudication: number };
  /** The principal's cap in tokens; null when none is set. */
  readonly capTokens: number | null;
}

export interface BudgetRow {
  readonly consumer: BudgetConsumer;
  readonly tokens: number;
  /** Percent of the cap, as the rows have it: not clamped, so the rows still sum to the total past the cap. Null without a cap. */
  readonly share: number | null;
}

export interface BudgetView {
  readonly state: BudgetState;
  /** The first instant of the month and of the next, ISO-8601: what "used this month" and "resets" name. */
  readonly monthStart: string;
  readonly resetsAt: string;
  readonly used: number;
  readonly cap: number | null;
  readonly left: number | null;
  /**
   * The headline: 0 to 100; null without a cap. Never above 100, because the gateway refuses at the cap and does
   * not lend; the call that crossed it is in `used` and in `share`, which is the breakdown's own total.
   */
  readonly percent: number | null;
  readonly share: number | null;
  readonly perDay: number;
  /** The day the cap is reached at this pace, ISO-8601; null when it is not reached this month. */
  readonly capDate: string | null;
  readonly answers: number;
  /** What the grading and the adjudication rows served, named beside them as the answers are beside the assistant's. */
  readonly suggestions: { readonly grading: number; readonly adjudication: number };
  readonly rows: ReadonlyArray<BudgetRow>;
}

/** Percent of the cap; null when there is no cap to take a share of. */
function share(tokens: number, cap: number | null): number | null {
  return cap === null || cap <= 0 ? null : (tokens / cap) * 100;
}

export function budgetView(facts: BudgetFacts, now: Date): BudgetView {
  const [year, month] = facts.month.split("-").map(Number);
  const monthIndex = (month ?? 1) - 1;
  const usd: Record<BudgetConsumer, number> = { assistant: 0, research: 0, grading: 0, adjudication: 0, retrieval: 0, labs: 0 };
  let total = 0;
  for (const row of facts.kinds) {
    const cost = Number(row.costUsd);
    total += cost;
    usd[consumerOf(row.kind, row.suggestion)] += cost;
  }

  const used = tokensOfUsd(total);
  const cap = facts.capTokens;
  const state: BudgetState = cap === null ? "nocap" : used >= cap ? "atcap" : used === 0 ? "empty" : "running";
  const pace = cap === null ? { perDay: 0, capDate: null } : projection(used, cap, now);

  return {
    state,
    monthStart: new Date(Date.UTC(year ?? 1970, monthIndex, 1)).toISOString(),
    resetsAt: new Date(Date.UTC(year ?? 1970, monthIndex + 1, 1)).toISOString(),
    used,
    cap,
    left: cap === null ? null : Math.max(0, cap - used),
    percent: cap === null ? null : cap <= 0 ? 100 : Math.min(100, (used / cap) * 100),
    share: share(used, cap),
    perDay: pace.perDay,
    capDate: state === "running" && pace.capDate !== null ? pace.capDate.toISOString() : null,
    answers: facts.answers,
    suggestions: facts.suggestions,
    rows: CONSUMERS.map((consumer) => {
      const tokens = tokensOfUsd(usd[consumer]);
      return { consumer, tokens, share: share(tokens, cap) };
    }),
  };
}
