import type { SessionUser } from "@/lib/auth/session";
import { getCurrentRelease } from "@/lib/db/content";
import { callerOf, closedResearchProposals } from "@/lib/db/improve";
import { select } from "@/lib/db/ledger";
import { logSince, refutedLinesOf, researchMonthsOf, type RefutedLine, type ResearchMonth } from "@/lib/improve/researchLog";
import type { ChangeClass } from "@/lib/schemas/improve";

/*
 * The research log's loader (feature-specs/43 § 7.2; unit 60d): a curator's, the not-found page for anyone else. The
 * months are the `RESEARCH` records of the last twelve, read with the ledger's own select by kind and window; the
 * refuted and declined list is the researcher's suggestions closed in the same months, across every part (D6). Both are
 * the ledger's and the platform's rows: neither can name an asker.
 */

export type ResearchLogData =
  | { readonly kind: "missing" }
  | {
      readonly kind: "page";
      readonly release: { readonly id: string; readonly gitSha: string };
      readonly months: ReadonlyArray<ResearchMonth>;
      readonly refuted: ReadonlyArray<RefutedLine & { readonly anchor: string; readonly changeClass: ChangeClass }>;
    };

export async function getResearchLog({ user, now = new Date() }: { readonly user: SessionUser; readonly now?: Date }): Promise<ResearchLogData> {
  if (user.role !== "CURATOR") return { kind: "missing" };
  const since = logSince(now);
  /* the researcher's `submitted` records too: the month's proposals sent (feature-specs/48 § 10.3; unit 74) */
  const [records, closed, release] = await Promise.all([select({ view: null, from: since, to: now, kinds: ["RESEARCH", "SUBMITTED"] }), closedResearchProposals(callerOf(user), since), getCurrentRelease()]);
  const byId = new Map(closed.map((row) => [row.id, row]));
  return {
    kind: "page",
    release,
    months: researchMonthsOf(records, now),
    refuted: refutedLinesOf(closed).map((line) => {
      const row = byId.get(line.id);
      const anchor = row?.anchor ?? null;
      return { ...line, anchor: anchor === null ? "—" : (anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor ?? "—"), changeClass: row?.changeClass ?? "WORDING" };
    }),
  };
}
