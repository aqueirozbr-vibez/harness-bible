import { strongestTierOf } from "@/lib/improve/queue";
import type { EvidenceTier } from "@/lib/schemas/domain";
import type { Decision } from "@/lib/schemas/improve";
import { ResearchPayloadSchema } from "@/lib/schemas/ledger";

/*
 * The research log (feature-specs/43 § 7.2; unit 60d), pure: the last twelve months of research from the `RESEARCH`
 * records — runs, those that planned nothing, those whose planner failed, the findings by outcome, the searches and the
 * pages read — a month with nothing a row of zeros, newest first; and for each refuted or declined proposal, what closed
 * it. Built from the ledger and the platform's suggestion rows alone, so it cannot name an asker.
 *
 * Since unit 74 (feature-specs/48 § 10.3) a person's run's record holds only `INVALID` and `VALID` findings — what a
 * person later does with one is the draft's or the researcher proposal's own record — so the table counts three more:
 * the runs the planner refused, the findings that passed the checks, and the researcher's proposals submitted in the
 * month, from the `SUBMITTED` records `service:researcher` signs, the one actor a sent finding's suggestion has. The
 * duplicate, refuted and proposed columns keep reading the records, which only the legacy runs fill. A sent finding's
 * fate is the refuted list's and the queue's. Nothing names who asked or who sent.
 */

export const LOG_MONTHS = 12;

export interface ResearchMonth {
  /** `2026-10`, in UTC. */
  readonly month: string;
  readonly runs: number;
  readonly nothing: number;
  /** Runs the planner refused: not about the book, or about the person's own system (48 § 5.3). */
  readonly refused: number;
  readonly failed: number;
  readonly invalid: number;
  /** Findings that passed the checks, as a person's run's record lists them (48 § 15). */
  readonly valid: number;
  /** Researcher's proposals submitted: the `SUBMITTED` records of `service:researcher` (48 § 10.3). */
  readonly sent: number;
  readonly duplicate: number;
  readonly refuted: number;
  readonly proposed: number;
  readonly searches: number;
  readonly pageReads: number;
}

const monthOf = (at: Date): string => `${String(at.getUTCFullYear())}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;

/** The first instant of the oldest month the log shows. */
export function logSince(now: Date, months: number = LOG_MONTHS): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}

/** The actor of a researcher's proposal's `submitted` record: the sending's record (48 § 8.4). */
const RESEARCHER_ACTOR = "service:researcher";

/**
 * The months, newest first: each `RESEARCH` record counted as its run — a payload that does not read counts as a run and
 * nothing more — and each `SUBMITTED` record of the researcher's as one proposal sent. Any other record counts nothing.
 */
export function researchMonthsOf(records: ReadonlyArray<{ readonly kind: string; readonly actor: string; readonly createdAt: Date; readonly payload: unknown }>, now: Date, months: number = LOG_MONTHS): ReadonlyArray<ResearchMonth> {
  const empty = (month: string): ResearchMonth => ({ month, runs: 0, nothing: 0, refused: 0, failed: 0, invalid: 0, valid: 0, sent: 0, duplicate: 0, refuted: 0, proposed: 0, searches: 0, pageReads: 0 });
  const byMonth = new Map<string, ResearchMonth>();
  for (let back = 0; back < months; back += 1) {
    const month = monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)));
    byMonth.set(month, empty(month));
  }
  for (const record of records) {
    const month = byMonth.get(monthOf(record.createdAt));
    if (month === undefined) continue;
    if (record.kind === "SUBMITTED") {
      if (record.actor === RESEARCHER_ACTOR) byMonth.set(month.month, { ...month, sent: month.sent + 1 });
      continue;
    }
    if (record.kind !== "RESEARCH") continue;
    const parsed = ResearchPayloadSchema.safeParse(record.payload);
    const count = (outcome: string): number => (parsed.success ? parsed.data.findings.filter((finding) => finding.outcome === outcome).length : 0);
    byMonth.set(month.month, {
      month: month.month,
      runs: month.runs + 1,
      nothing: month.nothing + (parsed.success && parsed.data.planned === "nothing" ? 1 : 0),
      refused: month.refused + (parsed.success && parsed.data.planned === "refused" ? 1 : 0),
      failed: month.failed + (parsed.success && parsed.data.planned === "failed" ? 1 : 0),
      invalid: month.invalid + count("INVALID"),
      valid: month.valid + count("VALID"),
      sent: month.sent,
      duplicate: month.duplicate + count("DUPLICATE"),
      refuted: month.refuted + count("REFUTED"),
      proposed: month.proposed + count("PROPOSED"),
      searches: month.searches + (parsed.success ? parsed.data.searches : 0),
      pageReads: month.pageReads + (parsed.success ? parsed.data.pageReads : 0),
    });
  }
  return [...byMonth.values()];
}

/** What closed a researcher's proposal (43 § 7.2): the floor, a sensor, the rules' request for more, the adjudicator's request for more or its decline, a curator's decline, or the chapter's check after a curator's accept. */
export type RefutedBy = "floor" | "sensor" | "rule" | "adjudicatorRequest" | "adjudicatorDecline" | "curator" | "check";

export interface ClosedProposalRow {
  readonly id: string;
  readonly outcome: Decision | null;
  readonly closedAt: Date | null;
  readonly score: number | null;
  readonly adjudication: { readonly decision: Decision; readonly decidedBy: string; readonly failingSensor: string | null; readonly acceptAt: number | null; readonly floorAt: number | null } | null;
  readonly evidence: ReadonlyArray<{ readonly tier: EvidenceTier | null; readonly adjustedScore: number | null }>;
}

/** What closed it, and the sensor's name where one did. */
export function refutedByOf(row: ClosedProposalRow): { readonly by: RefutedBy; readonly sensor: string | null } {
  const decided = row.adjudication;
  if (decided?.failingSensor != null) return { by: "sensor", sensor: decided.failingSensor };
  if (decided?.decidedBy === "intake-rules") return { by: decided.decision === "REQUEST_MORE" ? "rule" : "floor", sensor: null };
  /* accepted by a curator, then returned by the chapter's check, which closes a researcher's (37 § 4.5) */
  if (row.outcome === "REQUEST_MORE" && (decided === null || decided.decision === "ACCEPT" || decided.decision === "CURATOR_REVIEW")) return { by: "check", sensor: null };
  if (decided?.decidedBy === "adjudicator" && decided.decision === "REQUEST_MORE") return { by: "adjudicatorRequest", sensor: null };
  if (decided?.decidedBy === "adjudicator" && decided.decision === "DECLINE") return { by: "adjudicatorDecline", sensor: null };
  /* recommended, or a class no score decides, and declined in the queue */
  return { by: "curator", sensor: null };
}

export interface RefutedLine {
  readonly id: string;
  readonly closedAt: string | null;
  readonly tier: EvidenceTier | null;
  readonly score: number | null;
  readonly floorAt: number | null;
  readonly acceptAt: number | null;
  readonly by: RefutedBy;
  readonly sensor: string | null;
}

/** The refuted and declined proposals, newest first. */
export function refutedLinesOf(rows: ReadonlyArray<ClosedProposalRow>): ReadonlyArray<RefutedLine> {
  return [...rows]
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0) || b.id.localeCompare(a.id))
    .map((row) => ({ id: row.id, closedAt: row.closedAt === null ? null : row.closedAt.toISOString(), tier: strongestTierOf(row.evidence), score: row.score, floorAt: row.adjudication?.floorAt ?? null, acceptAt: row.adjudication?.acceptAt ?? null, ...refutedByOf(row) }));
}
