import type { QueueGroup } from "@/lib/schemas/curation";
import type { EvidenceTier } from "@/lib/schemas/domain";
import { EvidenceTierSchema } from "@/lib/schemas/domain";
import type { ChangeClass, CuratorReason, Decision, SuggestionOrigin } from "@/lib/schemas/improve";

/*
 * The curator queue's groups and deadlines (feature-specs/36 § 3; unit 53a): which group an open item is in, when it
 * is due, and the header's marks. Pure. The groups are `QUEUE_GROUPS` (lib/schemas/curation.ts); the deadlines are
 * Andre's A15, counted from the decision that queued the item; passing one changes nothing but its colour (36 § 3.3).
 */

/**
 * Each group's deadline in hours (A15): a safety or operating-technology change in a day; a scenario parameter or a
 * structure in five; a new source tier in six; an inspection in seven. The monthly sample has none in hours: it is due
 * by the month's end (36 § 3.1).
 */
export const GROUP_DEADLINE_HOURS: Readonly<Record<QueueGroup, number | null>> = { safety: 24, scenario: 120, structure: 120, newTier: 144, researcher: 168, inspection: 168, ready: 168, merging: 168, sampled: null };

const BY_REASON: Readonly<Record<CuratorReason, QueueGroup | null>> = { SAFETY_OT: "safety", SCENARIO_PARAMETER: "scenario", STRUCTURE: "structure", NEW_SOURCE_TIER: "newTier", RUBRIC: null };

/**
 * An open item's group (36 § 3.1): a curator-always change by its reason, a researcher's among them (its class line
 * says `research`); any other researcher's proposal — the adjudicator's recommendation, or its failure — in
 * "Researcher proposals" (43 § 7.1; unit 60d); anything else a curator inspects — a person's request for more, an
 * adjudicator's failure — in "Request more · for inspection". A rubric change has no group in this build, and no
 * suggestion is given that reason yet (30 § 8).
 */
export function groupOf(row: { readonly changeClass: ChangeClass; readonly curatorReason: CuratorReason | null; readonly outcome: Decision | null; readonly origin: SuggestionOrigin }): QueueGroup | null {
  if (row.changeClass === "CURATOR_ALWAYS" && row.curatorReason !== null) return BY_REASON[row.curatorReason];
  return row.origin === "RESEARCHER" ? "researcher" : "inspection";
}

/** When an item is due: its group's hours from the moment it entered the queue (36 § 3.3), or null before that is known, or for a group not counted in hours. */
export function deadlineOf(group: QueueGroup, queuedAt: Date | null): Date | null {
  const hours = GROUP_DEADLINE_HOURS[group];
  return queuedAt === null || hours === null ? null : new Date(queuedAt.getTime() + hours * 3_600_000);
}

const DAY_MS = 86_400_000;

/** The header's marks (36 § 3.3): overdue, due in under a day, and in its time; an item with no deadline counts in none. */
export function marksOf(deadlines: ReadonlyArray<Date | null>, now: Date): { readonly overdue: number; readonly dueSoon: number; readonly inSla: number } {
  let overdue = 0;
  let dueSoon = 0;
  let inSla = 0;
  for (const deadline of deadlines) {
    if (deadline === null) continue;
    const left = deadline.getTime() - now.getTime();
    if (left < 0) overdue += 1;
    else if (left < DAY_MS) dueSoon += 1;
    else inSla += 1;
  }
  return { overdue, dueSoon, inSla };
}

/**
 * A span as the queue prints an age or the time left (the Curator-Queue screen: `6 h`, `2 d`, `−2 h`): whole hours
 * under a day, whole days from one, and whether it is past.
 */
export function spanOf(ms: number): { readonly past: boolean; readonly unit: "h" | "d"; readonly n: number } {
  const past = ms < 0;
  const hours = Math.floor(Math.abs(ms) / 3_600_000);
  return hours < 24 ? { past, unit: "h", n: hours } : { past, unit: "d", n: Math.floor(hours / 24) };
}

/** The strongest graded item's tier (36 § 3.2): the highest adjusted score, the better tier where two tie; null while none is graded. */
export function strongestTierOf(items: ReadonlyArray<{ readonly tier: EvidenceTier | null; readonly adjustedScore: number | null }>): EvidenceTier | null {
  const order = EvidenceTierSchema.options;
  let best: { readonly tier: EvidenceTier; readonly score: number } | null = null;
  for (const item of items) {
    if (item.tier === null || item.adjustedScore === null) continue;
    if (best === null || item.adjustedScore > best.score || (item.adjustedScore === best.score && order.indexOf(item.tier) < order.indexOf(best.tier))) best = { tier: item.tier, score: item.adjustedScore };
  }
  return best?.tier ?? null;
}
