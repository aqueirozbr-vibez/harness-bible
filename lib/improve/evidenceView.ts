import type { EvidenceTier } from "@/lib/schemas/domain";
import type { EvidenceKind } from "@/lib/schemas/improve";
import type { EvidenceItemView } from "@/lib/schemas/suggestions";

/*
 * An evidence item as the suggest form shows it (feature-specs/34 § 5; 32 § 10): what its fetch status says, why it
 * could not be opened, how old it is, which stake and which recency window its factors name, and when a wait at the
 * budget cap ends. Every number is the server's (the view's); these read them into the keys the list words them by.
 *
 * Pure, and light enough for a client island.
 */

/** What an item's `fetchStatus` says (32 § 4.2): opened with its HTTP status, not opened and why, a type no link is read as, nothing to read, or not fetched yet. */
export type FetchState =
  | { readonly kind: "opened"; readonly status: string }
  | { readonly kind: "unreachable"; readonly cause: string }
  | { readonly kind: "unsupported"; readonly type: string }
  | { readonly kind: "notSupplied" }
  | null;

export function fetchStateOf(fetchStatus: string | null): FetchState {
  if (fetchStatus === null) return null;
  if (fetchStatus === "not_supplied") return { kind: "notSupplied" };
  const at = fetchStatus.indexOf(":");
  const head = at < 0 ? fetchStatus : fetchStatus.slice(0, at);
  const rest = at < 0 ? "" : fetchStatus.slice(at + 1);
  if (head === "opened") return { kind: "opened", status: rest };
  if (head === "unsupported") return { kind: "unsupported", type: rest };
  return { kind: "unreachable", cause: rest === "" ? head : rest };
}

/** The fetcher's own causes the form words one by one (workers/fetch/fetch.ts `NetworkCause`, and a DOI's form); every refusal of the guard shares one sentence. */
export const NETWORK_CAUSES = ["dns", "connect", "tls", "reset", "timeout", "size", "redirects", "redirect_target", "encoding", "doi_form"] as const;
export type NetworkCause = (typeof NETWORK_CAUSES)[number];

/** Why a link could not be opened, as the form words it: the HTTP status it answered, one of the network's causes, or the guard's refusal of its address. */
export type UnreachableCause = { readonly kind: "status"; readonly status: string } | { readonly kind: "network"; readonly cause: NetworkCause } | { readonly kind: "guard" };

export function causeOf(cause: string): UnreachableCause {
  if (/^\d{3}$/.test(cause)) return { kind: "status", status: cause };
  const network = NETWORK_CAUSES.find((known) => known === cause);
  return network === undefined ? { kind: "guard" } : { kind: "network", cause: network };
}

/**
 * The reasons intake rules grade an item `U` by once it was opened or uploaded (32 § 9, § 19: workers/activities/evidence.ts
 * and the grader's checks in workers/agents/grader/evidence.ts), which the form words one by one. Any other reason of
 * a `U` that opened — the gateway's or the provider's refusal, an answer that did not parse — is the grader's own.
 */
export const RULED_CAUSES = ["media_mismatch", "pdf_too_large", "image_too_large", "image_unreadable", "image_dimensions", "request_too_large", "source_changed", "no_text", "text_missing"] as const;
export type RuledCause = (typeof RULED_CAUSES)[number] | "grader";

/** Why an item that opened was graded `U`, as the form words it. */
export function ruledOf(reason: string | null): RuledCause {
  return RULED_CAUSES.find((known) => known === reason) ?? "grader";
}

/** An item's age in the unit a person reads it in: days up to sixty, months up to two years, years after. */
export function ageOf(ageDays: number): { readonly unit: "day" | "month" | "year"; readonly n: number } {
  if (ageDays < 60) return { unit: "day", n: Math.max(0, ageDays) };
  if (ageDays < 730) return { unit: "month", n: Math.round(ageDays / 30) };
  return { unit: "year", n: Math.round(ageDays / 365) };
}

/** The rubric's independence table (rubric.json `adjustments.independence`): a factor for each stake. */
export type IndependenceTable = Readonly<Record<"none" | "vendor" | "employer", number>>;

/** The stake an independence factor names, read back from the rubric's own table; null where the factor is none of its values. */
export function stakeOf(independence: number | null, table: IndependenceTable): keyof IndependenceTable | null {
  if (independence === null) return null;
  const found = (Object.keys(table) as Array<keyof IndependenceTable>).find((stake) => table[stake] === independence);
  return found ?? null;
}

/** The rubric's recency rules (rubric.json `adjustments.recency`): the windows by their factor, and the factor past them. */
export interface RecencyRules {
  readonly windows: ReadonlyArray<{ readonly withinDays: number; readonly factor: number }>;
  readonly older: number;
}

/** The recency window a factor below 1.0 names: within so many days, or older than them all. Null at 1.0, where recency cost nothing, and for no factor. */
export function windowOf(recency: number | null, rules: RecencyRules): { readonly kind: "within"; readonly days: number } | { readonly kind: "older" } | null {
  if (recency === null || recency >= 1) return null;
  const window = rules.windows.find((candidate) => candidate.factor === recency);
  if (window !== undefined) return { kind: "within", days: window.withinDays };
  return recency === rules.older ? { kind: "older" } : null;
}

/** D2 (Andre, 2026-10-08, on the recommendation): the pause between two reads of the draft while an item grades. */
export const EVIDENCE_POLL_MS = 2_000;

/** The rubric's numbers the list words its items by (rubric.json `adjustments`): the corroboration, the stakes, the recency windows. */
export interface EvidenceRubric {
  readonly corroboration: { readonly bonus: number; readonly minTier: EvidenceTier };
  readonly independence: IndependenceTable;
  readonly recency: RecencyRules;
}

/** The edit page's evidence as the draft's read gives it: the items, which one corroborates, the rubric's numbers and the most a suggestion holds. */
export interface SuggestEvidence {
  readonly items: ReadonlyArray<EvidenceItemView>;
  readonly corroboratedById: string | null;
  readonly rubric: EvidenceRubric;
  /** 32 D4 (Andre, 2026-10-06): ten. */
  readonly max: number;
  /** Whether recency applies as the page loaded (`fastMovingOf`): a save that changes it has the graded items scored again (34 § 24). */
  readonly fastMoving: boolean;
}

/** The items a read finds graded with a tier that were pending before it: what the list announces. A failure announces itself, as an alert. */
export function newlyGraded(before: ReadonlyArray<EvidenceItemView>, after: ReadonlyArray<EvidenceItemView>): EvidenceItemView[] {
  const pending = new Set(before.filter((item) => item.state === "PENDING").map((item) => item.id));
  return after.filter((item) => pending.has(item.id) && item.state === "GRADED" && item.tier !== null && item.tier !== "U");
}

/** An item the list reads the draft again for: pending and not waiting at the budget cap, which nothing in a draft ends but its removal. */
export function stillGrading(item: EvidenceItemView): boolean {
  return item.state === "PENDING" && budgetResetOf(item.reason) === null;
}

/** The day a wait at the budget cap ends, from the reason the grading activity writes on the row (`budget cap; resets 2026-11-01`); null for any other reason. */
export function budgetResetOf(reason: string | null): string | null {
  if (reason === null) return null;
  return /^budget cap; resets (\d{4}-\d{2}-\d{2})$/.exec(reason)?.[1] ?? null;
}

/** A grading's stage as its number, 1 to 3 (`2 of 3` → 2). */
export function stageNumberOf(stage: "1 of 3" | "2 of 3" | "3 of 3"): 1 | 2 | 3 {
  return Number(stage[0]) as 1 | 2 | 3;
}

/** Where an item points, as its second line shows it: a link without its scheme, a DOI as written, nothing for an upload or a lab run. */
export function locationOf(item: { readonly kind: EvidenceKind; readonly url: string | null; readonly doi: string | null }): string | null {
  if (item.kind === "LINK" && item.url !== null) return item.url.replace(/^https?:\/\//, "");
  if (item.kind === "DOI" && item.doi !== null) return item.doi;
  return null;
}
