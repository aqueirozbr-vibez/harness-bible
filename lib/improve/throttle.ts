/*
 * The throttle (feature-specs/33 § 7; TRD § 6.4; unit 50f): a contributor three of whose suggestions were declined in
 * thirty days, each with every item graded `U` — evidence nobody could verify — makes no new suggestion for thirty days
 * (31 § 6.3 refuses it). A decline on tier G does not count ("S-23-0412 was graded G, not U. It does not count", the
 * screen), and a researcher is never throttled. Pure: the count is the door's, the clock the caller's.
 */

export const THROTTLE = { declines: 3, withinDays: 30, forDays: 30 } as const;

const DAY_MS = 86_400_000;

/** From when a contributor's declines are counted. */
export function throttleWindowStart(now: Date): Date {
  return new Date(now.getTime() - THROTTLE.withinDays * DAY_MS);
}

/** Until when a contributor with this many such declines in the window is throttled; null under the threshold. */
export function throttleUntil(declines: number, now: Date): Date | null {
  return declines >= THROTTLE.declines ? new Date(now.getTime() + THROTTLE.forDays * DAY_MS) : null;
}
