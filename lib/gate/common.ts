/*
 * What every phase's gate shares (feature-specs/22 § 2; lifted from lib/gate/phase1.ts, which re-exports it): a
 * criterion with what was measured and how, the verdict that is met only when every criterion passes on its own
 * evidence, the nearest-rank percentile, and the printed report. "Done means every item below can be demonstrated,
 * not asserted" (project-overview § Success criteria), so a criterion that could not be measured is never a pass:
 * it is `blocked` and says what is missing, or `deferred` and names the unit that measures it.
 */

/** pass: measured and within the criterion · fail: measured and outside it · blocked: needs something outside this repository (the book, CI, a provider key, labels, real accounts) · deferred: a later unit measures it. */
export type CriterionStatus = "pass" | "fail" | "blocked" | "deferred";

export interface Criterion {
  /** `P1.1` … `P1.10`, `P2.1a` … `P2.7`: the order of project-overview § Success criteria. */
  readonly id: string;
  readonly text: string;
  readonly status: CriterionStatus;
  /** What was measured, as text a reviewer can check (`41/41`, `p95 38 ms`, `227/250 · 90.8 %`). */
  readonly measured: string;
  /** How it was measured, or why it could not be. */
  readonly note: string;
}

/** What every gate's report holds; a phase adds its own fields beside these. */
export interface GateReportBase {
  readonly phase: number;
  readonly release: string;
  readonly appUrl: string;
  readonly criteria: ReadonlyArray<Criterion>;
  readonly met: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export function gateVerdict(criteria: ReadonlyArray<Criterion>): { readonly met: boolean; readonly counts: Record<CriterionStatus, number> } {
  const counts: Record<CriterionStatus, number> = { pass: 0, fail: 0, blocked: 0, deferred: 0 };
  for (const c of criteria) counts[c.status] += 1;
  return { met: criteria.length > 0 && counts.pass === criteria.length, counts };
}

/** Nearest-rank percentile (p in 0–100) of a non-empty sample; NaN for an empty one. */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

const STATUS_MARK: Record<CriterionStatus, string> = { pass: "■ pass    ", fail: "□ FAIL    ", blocked: "◧ blocked ", deferred: "· deferred" };

export function formatGateReport(report: GateReportBase): string {
  const { counts } = gateVerdict(report.criteria);
  const lines = [`Phase ${String(report.phase)} gate · release ${report.release} · ${report.appUrl} · ${report.finishedAt}`, ""];
  for (const c of report.criteria) {
    lines.push(`${STATUS_MARK[c.status]} ${c.id}  ${c.text}`);
    lines.push(`             measured: ${c.measured}`);
    lines.push(`             ${c.note}`);
    lines.push("");
  }
  lines.push(`${report.met ? "GATE MET" : "GATE NOT MET"} · ${counts.pass} pass · ${counts.fail} fail · ${counts.blocked} blocked · ${counts.deferred} deferred`);
  return lines.join("\n");
}
