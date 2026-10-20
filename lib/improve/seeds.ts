import { sha256Hex } from "@/lib/ledger/hash";
import type { CuratorAction } from "@/lib/schemas/improve";

/*
 * The curator queue's two calibration mechanisms (feature-specs/36 § 7; unit 53e), both off until a number is set.
 * Pure.
 *
 * - Seeds (§ 7.1, A16): a suggestion another curator decided, offered again under a fresh id to a curator who has not
 *   seen it, with that decision as the known answer. They measure the curator's consistency, never the adjudicator,
 *   and are in none of § 6.1's measures.
 * - The monthly sample of accepted tier B (§ 7.2, D2): merged suggestions whose strongest item was tier B, drawn per
 *   part each month into the "Sampled" group, due by the month's end.
 */

/**
 * How many seeds a queue of `real` items may carry at `share` (§ 7.1): seeds may be at most that share of all the
 * items, so `share × real / (1 − share)` of them, rounded down. None at 0 (A16), none in an empty queue, none for a
 * share of 1 or more, which no setting allows.
 */
export function seedsWanted(share: number, real: number): number {
  if (!(share > 0) || share >= 1 || !(real > 0)) return 0;
  /* the epsilon keeps 0.5 × 3 / 0.5 at 3 where floating point gives 2.9999999999999996 */
  return Math.floor((share * real) / (1 - share) + 1e-9);
}

/** Whether a seed's decision matched the answer another curator set: the same action. */
export const seedMatched = (action: CuratorAction, answer: CuratorAction): boolean => action === answer;

/** A calendar month, UTC: `2026-10`, from its first instant to the next month's, the sample's deadline (§ 3.1: "the last day of the month"). */
export interface Month {
  readonly label: string;
  readonly from: Date;
  readonly to: Date;
}

export function monthOf(at: Date): Month {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return { label: `${String(year)}-${String(month + 1).padStart(2, "0")}`, from: new Date(Date.UTC(year, month, 1)), to: new Date(Date.UTC(year, month + 1, 1)) };
}

/**
 * The month's sample of one part (§ 7.2): `perMonth` of the candidates, in the order of a hash of the month and each
 * id, so that a month's draw reads the same on every request and the next month's is another.
 */
export function sampleOf(ids: ReadonlyArray<string>, month: string, perMonth: number): ReadonlyArray<string> {
  if (!(perMonth > 0)) return [];
  return [...new Set(ids)]
    .map((id) => ({ id, rank: sha256Hex(`${month}:${id}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, perMonth)
    .map((entry) => entry.id);
}
