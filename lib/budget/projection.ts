/*
 * When the month's spend reaches the cap at the pace so far (feature-specs/21 § 4.1). Pure, and arithmetic in code
 * (invariant 12): the account page prints what this returns and computes nothing itself.
 *
 * The pace is the spend divided by the days of the month so far, today included, so the first of the month divides
 * by one. The cap day is the first day whose running total reaches the cap at that pace; it is a date only when it
 * falls inside the month, because the gateway's window resets on the first (11 § 3.4) and a date after that would
 * describe a month that starts again from zero. The month is the calendar month in UTC, as the gateway's is.
 */

export interface Projection {
  /** Tokens a day at the month's pace so far. */
  readonly perDay: number;
  /** The UTC day the running total reaches the cap at that pace; null when that day is not in this month. */
  readonly capDate: Date | null;
}

/** The number of days in the UTC month `now` falls in. */
export function daysInMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

export function projection(spend: number, cap: number, now: Date): Projection {
  const elapsed = Math.max(1, now.getUTCDate());
  if (!(spend > 0) || !(cap > 0)) return { perDay: 0, capDate: null };
  /* One division on whole numbers, so a pace that lands exactly on a day does not round up to the next. */
  const day = Math.ceil((cap * elapsed) / spend);
  return {
    perDay: spend / elapsed,
    capDate: day <= daysInMonth(now) ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day)) : null,
  };
}
