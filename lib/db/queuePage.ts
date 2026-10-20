import { readCurationMetrics, readCurationQueue } from "@/lib/api/endpoints/curation";
import { readSuggestionView } from "@/lib/api/endpoints/suggestions";
import type { SessionUser } from "@/lib/auth/session";
import { recordPeople } from "@/lib/db/account";
import { getCurrentRelease } from "@/lib/db/content";
import { callerOf, curatorsOfParts, currentRubricVersion, mergedVerdictOf, queueDecisionOf, readSuggestion, seedOf, type SeedForCurator } from "@/lib/db/improve";
import { recordAt, view as recordsOf } from "@/lib/db/ledger";
import { suggestionContext } from "@/lib/db/suggestEdit";
import type { Locale } from "@/lib/i18n/routing";
import { endorserOf } from "@/lib/improve/endorsement";
import { variantOf, type OutcomeVariant } from "@/lib/improve/outcomeView";
import { stepKeyOf } from "@/lib/ledger/hash";
import type { CurationMetrics, CurationQueue } from "@/lib/schemas/curation";
import type { CuratorAction, Part } from "@/lib/schemas/improve";
import type { SuggestionView } from "@/lib/schemas/suggestions";

/*
 * The loader of the curator queue's page (feature-specs/36 § 4; unit 53b): the queue as `GET /curation/queue` answers
 * it, and the selected suggestion as `GET /suggestions/{id}` reads it — a curator reads one past draft in their parts
 * — with what its detail adds: its place in the release, its contributor by name, its parts' curators for the
 * routing sentence, and the curator's decision once one is made (53c); and the calibration rail's quarter, as
 * `GET /curation/metrics` answers it (53d). Nothing is written.
 */

/** The rail's reading (36 § 6.4): this quarter's measures and reviews, the lines, the minimum, and the rubric in force for the footer's link. */
export interface QueueCalibration {
  readonly quarter: CurationMetrics["quarters"][number];
  readonly lines: CurationMetrics["lines"];
  readonly minimum: number;
  readonly rubric: { readonly version: string; readonly sha256: string } | null;
}

/** A curator's decision as the detail shows it (36 § 5, § 8): who and when, what, and the `curator` record's hashes once the workflow has written it. */
export interface QueueDecided {
  /** The curator's name; null where the account is gone. */
  readonly by: string | null;
  readonly at: string;
  readonly action: CuratorAction;
  readonly overrideCode: string | null;
  readonly criterion: string | null;
  /** The record (`prev → hash`), or null while the workflow is recording it: the status footer's `recording`. */
  readonly record: { readonly prevHash: string; readonly hash: string } | null;
  /** The suggestion is decided in its present visit to the queue: the panel is not offered again. */
  readonly open: boolean;
}

/** The selected suggestion's detail (36 § 4). */
export interface QueueSelection {
  readonly view: SuggestionView;
  readonly variant: OutcomeVariant;
  readonly context: Awaited<ReturnType<typeof suggestionContext>>;
  /** The contributor as the curator sees them (36 § 4): by name, but where the account is going or consent no longer stands; a researcher's proposal has none. */
  readonly contributor: { readonly name: string | null; readonly verified: boolean } | null;
  /**
   * A researcher's proposal (43 § 7.1; unit 60d): the reader whose name stands on it, by the name they put there, or
   * nobody; and the researcher's note, which the adjudicator did not read. Nothing of who asked or what. Null for a
   * person's suggestion.
   */
  readonly research: { readonly endorser: string | null; readonly note: string | null } | null;
  /** Each part the suggestion reaches, with its curators' names: the routing sentence. */
  readonly routing: ReadonlyArray<{ readonly part: Part; readonly curators: ReadonlyArray<string> }>;
  /** The curator's decision, recorded or recording; null when no curator has decided it. */
  readonly decided: QueueDecided | null;
  /**
   * A seed's (36 § 7.1): shown as the suggestion it is of under its own id, as the queue showed it; once decided,
   * revealed with the answer and whether the decision matched it. Null for any other item. The answer is in it only
   * once the decision is made.
   */
  readonly seed: { readonly decided: { readonly action: CuratorAction; readonly answer: CuratorAction; readonly matched: boolean } | null } | null;
  /** A sampled item's (36 § 7.2; unit 54e): the month's verdict once given — stands, or reverted, by whom and when, with the revert — or none yet. Null for any other item. */
  readonly sample: { readonly verdict: { readonly action: "ACCEPT" | "REVERT"; readonly by: string | null; readonly at: string; readonly revertId: string | null } | null } | null;
}

/** A seed as its curator sees it before deciding (36 § 7.1): the suggestion it is of under the seed's id, in the queue with what stood then, since the offer; nothing decided since. */
function maskedAsSeed(view: SuggestionView, seed: SeedForCurator): SuggestionView {
  const offered = seed.offeredAt.toISOString();
  return { ...view, id: seed.id as SuggestionView["id"], own: false, state: "CURATOR_QUEUE", outcome: seed.standing, submittedAt: offered, decidedAt: offered, closedAt: null, withdrawnAt: null, budgetResetsAt: null, adjudication: view.adjudication === null ? null : { ...view.adjudication, decidedAt: offered } };
}

export type QueuePageData =
  /** Not a curator: the product's not-found page (36 § 8). */
  | { readonly kind: "missing" }
  | {
      readonly kind: "page";
      readonly release: { readonly id: string; readonly gitSha: string };
      readonly queue: CurationQueue;
      /** The suggestion `?s=` names when the curator may read it, else the queue's first; null when there is none. */
      readonly selected: QueueSelection | null;
      readonly calibration: QueueCalibration;
    };

export async function getQueuePage({ locale, user, selectedId }: { readonly locale: Locale; readonly user: SessionUser; readonly selectedId: string | null }): Promise<QueuePageData> {
  if (user.role !== "CURATOR") return { kind: "missing" };
  const now = new Date();
  const [queue, metrics, rubric] = await Promise.all([readCurationQueue(user, { part: null, changeClass: null }), readCurationMetrics(user), currentRubricVersion(now)]);
  const [quarter] = metrics.quarters;
  if (quarter === undefined) throw new Error("the metrics gave no quarter");
  const calibration: QueueCalibration = { quarter, lines: metrics.lines, minimum: metrics.minimum, rubric: rubric === null ? null : { version: rubric.id, sha256: rubric.sha256 } };
  const first = queue.groups[0]?.items[0]?.id ?? null;
  /* An id the curator may read past draft, or a seed of theirs, shown as the suggestion it is of (36 § 7.1). */
  const resolve = async (id: string): Promise<{ readonly view: SuggestionView; readonly realId: string; readonly seed: SeedForCurator | null } | null> => {
    const real = await readSuggestionView(user, id);
    if (real !== null) return real.state === "DRAFT" ? null : { view: real, realId: real.id, seed: null };
    const seed = await seedOf(callerOf(user), id);
    const of = seed === null ? null : await readSuggestionView(user, seed.suggestionId);
    return seed === null || of === null ? null : { view: maskedAsSeed(of, seed), realId: of.id, seed };
  };
  const picked = (selectedId === null ? null : await resolve(selectedId)) ?? (first === null ? null : await resolve(first));
  if (picked === null) return { kind: "page", release: await getCurrentRelease(), queue, selected: null, calibration };
  const { view, realId, seed } = picked;

  /* A seed's own decision is its reveal; a curator's decision of the suggestion it is of is never shown on it. */
  /* a sampled item (36 § 7.2): in the month's group, its verdict read since it merged (unit 54e) */
  const sampled = seed === null && queue.groups.some((group) => group.group === "sampled" && group.items.some((item) => item.id === realId));
  const [context, row, decision, verdict] = await Promise.all([suggestionContext(view, locale, now), readSuggestion(callerOf(user), realId), seed === null ? queueDecisionOf(callerOf(user), realId) : Promise.resolve(null), sampled ? mergedVerdictOf(callerOf(user), realId) : Promise.resolve(null)]);
  const parts = row?.parts ?? [];
  const [rostered, record] = await Promise.all([
    curatorsOfParts(parts, now),
    decision === null || !decision.recorded || row === null || row.workflowId === null ? Promise.resolve(null) : recordAt(realId, "CURATOR", stepKeyOf(row.workflowId, `curator:${decision.actionId}`)),
  ]);
  /* a researcher's proposal: whose name stands on it, from its records alone (42 § 6), the endorser by the name they put there */
  const endorsedBy = view.origin === "RESEARCHER" && seed === null ? endorserOf(await recordsOf({ suggestionId: realId })) : null;
  const endorserId = endorsedBy === null ? null : endorsedBy.slice("user:".length);
  const people = await recordPeople([...new Set([...(endorserId === null ? [] : [endorserId]), ...(row?.userId === null || row === null ? [] : [row.userId]), ...rostered.map((entry) => entry.userId), ...(decision?.curatorId == null ? [] : [decision.curatorId]), ...(verdict?.curatorId == null ? [] : [verdict.curatorId])])]);
  const decider = decision?.curatorId == null ? null : (people.get(decision.curatorId) ?? null);
  const judge = verdict?.curatorId == null ? null : (people.get(verdict.curatorId) ?? null);
  const owner = row === null || row.userId === null ? null : (people.get(row.userId) ?? null);
  const routing = parts.map((part) => ({ part, curators: rostered.filter((entry) => entry.part === part).flatMap((entry) => {
    const person = people.get(entry.userId);
    return person === undefined || person.deleted ? [] : [person.displayName];
  }) }));
  return {
    kind: "page",
    release: context.page.release,
    queue,
    calibration,
    selected: {
      view,
      variant: variantOf(view),
      context,
      contributor: owner === null ? null : { name: owner.deleted || !owner.consented ? null : owner.displayName, verified: owner.verified },
      research:
        view.origin !== "RESEARCHER"
          ? null
          : {
              endorser: endorserId === null ? null : ((person) => (person === undefined || person.deleted ? null : person.displayName))(people.get(endorserId)),
              note: view.rationale,
            },
      routing,
      decided:
        decision === null
          ? null
          : {
              by: decider === null || decider.deleted ? null : decider.displayName,
              at: decision.createdAt.toISOString(),
              action: decision.action,
              overrideCode: decision.overrideCode,
              criterion: decision.criterion,
              record: record === null ? null : { prevHash: record.prevHash, hash: record.hash },
              open: decision.open,
            },
      seed: seed === null ? null : { decided: seed.decided === null ? null : { action: seed.decided.action, answer: seed.answer, matched: seed.decided.matched } },
      sample: !sampled ? null : { verdict: verdict === null ? null : { action: verdict.action, by: judge === null || judge.deleted ? null : judge.displayName, at: verdict.createdAt.toISOString(), revertId: verdict.revertId } },
    },
  };
}
