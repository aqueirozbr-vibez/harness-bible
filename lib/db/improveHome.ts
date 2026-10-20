import type { SessionUser } from "@/lib/auth/session";
import { contributorStandingOf } from "@/lib/db/account";
import { getCurrentRelease } from "@/lib/db/content";
import { callerOf, curatorQueueCount, listOwnSuggestions, type OwnSuggestionRow } from "@/lib/db/improve";
import { readProposalsOfAsker, unusedFindingsOf, type UnusedFinding } from "@/lib/db/research";
import { env } from "@/lib/env";
import { findingRoleOf, type FindingRole } from "@/lib/research/findingAction";
import type { ProposalView } from "@/lib/schemas/api";
import type { Locale } from "@/lib/i18n/routing";
import { loadRubric } from "@/lib/rubrics/load";
import { takesRevision, type ChangeClass, type Decision, type SuggestionState } from "@/lib/schemas/improve";

/*
 * The Improve landing page's loader (feature-specs/35 § 3; unit 52a): what each visitor sees. Signed out or a reader:
 * what Improve is, nothing of anyone's. A contributor, and a curator, who is one on the ladder: their own suggestions,
 * drafts first, each with where it is anchored, its class, its state, its score against the class's acceptance and
 * how long since it last moved; a row that waits on them (a request for more, a failed intake) is marked, which is
 * this page's notification of a decision (35 D3). A curator: also how many suggestions wait in the queue for their
 * parts. No count of suggestions by person is made (invariant 26).
 *
 * Since unit 76 (feature-specs/48 § 10.2, story 4), for any signed-in person, their findings not yet turned into an
 * improvement (`unusedFindingsOf`, inside their tenant) and who they are to them (`findingRoleOf`, the Research page's
 * own reading of `suggestGate`): they draft, the throttle pauses them, or they send, with whether research proposals are
 * configured here (the web tier reads only whether `RESEARCH_PRINCIPAL` is set, § 8.3). None, and the section is not
 * shown.
 */

/** One row of "Your suggestions". */
export interface ImproveHomeRow {
  readonly id: string;
  /** A draft's edit page; any other's own page (spec 35 § 4, unit 52b). */
  readonly href: string;
  /** As the reader prints it: `21.3`, `F-21-03`, `15.9 r12`. */
  readonly anchor: string;
  readonly changeClass: ChangeClass;
  readonly state: SuggestionState;
  readonly outcome: Decision | null;
  readonly score: number | null;
  /** The class's acceptance under the rubric the suggestion was written against; null where no score decides. */
  readonly acceptAt: number | null;
  /** A request for more or a failed intake: the move is the contributor's (31 § 6.5); not while their withdrawal is recorded. */
  readonly waitsOnYou: boolean;
  /** Its contributor asked to withdraw it (45 § 5.2): being recorded while it waits, withdrawn once closed. */
  readonly withdrawn: boolean;
  /** Whole days since its last move: decided, submitted, or created. */
  readonly days: number;
}

export interface ImproveHomeData {
  readonly release: { readonly id: string; readonly gitSha: string };
  readonly signedIn: boolean;
  /** The visitor's own suggestions; null for a visitor who cannot make one (signed out, a reader, a builder). */
  readonly own: ReadonlyArray<ImproveHomeRow> | null;
  /** For a curator, how many wait in the queue for their parts; null for anyone else. */
  readonly queue: number | null;
  /** The research proposals from the visitor's own questions, newest first (43 § 6; unit 60c), whatever their role; none signed out. */
  readonly proposals: ReadonlyArray<ProposalView>;
  /** `From a research` (48 § 10.2): the visitor's unused findings, newest first, and who they are to them; null signed out or with none. */
  readonly fromResearch: { readonly role: FindingRole; readonly findings: ReadonlyArray<UnusedFinding> } | null;
}

const anchorOf = (row: OwnSuggestionRow): string => row.anchor?.figureAnchor ?? row.anchor?.sourceRowAnchor ?? row.anchor?.sectionAnchor ?? "—";

const DAY_MS = 86_400_000;

export async function getImproveHome({ locale, user }: { readonly locale: Locale; readonly user: SessionUser | null }): Promise<ImproveHomeData> {
  const now = Date.now();
  const release = await getCurrentRelease();
  const suggests = user !== null && (user.role === "CONTRIBUTOR" || user.role === "CURATOR");
  const [proposals, unused] = user === null ? [[], []] : await Promise.all([readProposalsOfAsker(user), unusedFindingsOf(user)]);
  const fromResearch = user === null || unused.length === 0 ? null : { role: findingRoleOf(user, (await contributorStandingOf(user)).throttledUntil, env.RESEARCH_PRINCIPAL !== undefined, new Date(now)), findings: unused };
  if (user === null || !suggests) return { release, signedIn: user !== null, own: null, queue: null, proposals, fromResearch };

  const caller = callerOf(user);
  const [rows, queue] = await Promise.all([listOwnSuggestions(caller), user.role === "CURATOR" ? curatorQueueCount(caller) : Promise.resolve(null)]);
  /* Each version's thresholds read once, from its published file (the loader checks its hash for the pages that show it). */
  const thresholds = new Map<string, ReturnType<typeof loadRubric>["rubric"]["thresholds"]>();
  const acceptOf = (row: OwnSuggestionRow): number | null => {
    const known = thresholds.get(row.rubricVersionId) ?? loadRubric(row.rubricVersionId).rubric.thresholds;
    thresholds.set(row.rubricVersionId, known);
    return known[row.changeClass]?.acceptAt ?? null;
  };
  return {
    release,
    signedIn: true,
    own: rows.map((row) => ({
      id: row.id,
      href: row.state === "DRAFT" ? `/${locale}/improve/${row.id}/edit` : `/${locale}/improve/${row.id}`,
      anchor: anchorOf(row),
      changeClass: row.changeClass,
      state: row.state,
      outcome: row.outcome,
      score: row.score,
      acceptAt: acceptOf(row),
      waitsOnYou: row.withdrawnAt === null && takesRevision(row.state, row.outcome),
      withdrawn: row.withdrawnAt !== null,
      days: Math.max(0, Math.floor((now - (row.decidedAt ?? row.submittedAt ?? row.createdAt).getTime()) / DAY_MS)),
    })),
    queue,
    proposals,
    fromResearch,
  };
}
