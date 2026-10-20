/*
 * Cohen's κ, the gate's agreement statistic (feature-specs/22 § 5; architecture § 6.2), on its own so that what else
 * measures agreement measures it the same way: the Phase 2 gate's grader against curator labels, and the adjudicator
 * against the curators (feature-specs/36 § 6.1). Pure; no import.
 */

/** κ ≥ 0.7 to ship Phase 2; a criterion below 0.6 is retired from the grader (architecture § 6.2). */
export const KAPPA_FLOOR = 0.7;
export const KAPPA_RETIRE = 0.6;
/** Below this many pairs an agreement statistic says nothing (feature-specs/22 § 5). */
export const KAPPA_MIN_PAIRS = 20;

/**
 * Cohen's κ for two raters and a binary judgement: observed agreement minus the agreement chance would give, over
 * one minus that chance. `undefined` under twenty pairs, where it says nothing; 1 when the two agree on every pair,
 * the case in which chance agreement can itself be 1 and the fraction has no value.
 */
export function cohenKappa(pairs: ReadonlyArray<readonly [boolean, boolean]>): number | undefined {
  const n = pairs.length;
  if (n < KAPPA_MIN_PAIRS) return undefined;
  const agree = pairs.filter(([a, b]) => a === b).length;
  if (agree === n) return 1;
  const aTrue = pairs.filter(([a]) => a).length / n;
  const bTrue = pairs.filter(([, b]) => b).length / n;
  const expected = aTrue * bTrue + (1 - aTrue) * (1 - bTrue);
  return (agree / n - expected) / (1 - expected);
}
