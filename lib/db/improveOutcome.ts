import { readAskerProposal, readAskerProposalView, readClosedResearchView, readSuggestionView } from "@/lib/api/endpoints/suggestions";
import type { SessionUser } from "@/lib/auth/session";
import { callerOf, latestCuratorDecision, latestOwnOpenSuggestion, ownUnverifiableDeclines, readClosedResearchProposal, readSuggestion, type CuratorDecisionForUser } from "@/lib/db/improve";
import { view as ledgerView } from "@/lib/db/ledger";
import { suggestionContext } from "@/lib/db/suggestEdit";
import type { Locale } from "@/lib/i18n/routing";
import { refreshKeyOf, resendsWithdrawal, variantOf, type OutcomeVariant } from "@/lib/improve/outcomeView";
import { THROTTLE, throttleWindowStart } from "@/lib/improve/throttle";
import type { Part } from "@/lib/schemas/improve";
import { DecidedPayloadSchema } from "@/lib/schemas/ledger";
import type { SuggestionView } from "@/lib/schemas/suggestions";

/*
 * The loader of a suggestion's own page, the adjudication page (feature-specs/35 § 4; unit 52b): the suggestion as
 * `GET /suggestions/{id}` reads it (`readSuggestionView`: the owner, and a curator of one of its parts past draft, as
 * the door reads; anyone else nothing), its place in the release, and the `decided` record for the decision's footer:
 * its tokens and its hash. With a curator, its parts; closed by one, the coded reason. For the owner, the right
 * column: their most recent other open suggestion, and their own throttle count. Nothing is written.
 */

/** The right column's `also yours · open` (35 § 4): another of the owner's suggestions, as its own page would read it. */
export interface OtherOpen {
  readonly view: SuggestionView;
  readonly context: Awaited<ReturnType<typeof suggestionContext>>;
}

export type ImproveOutcomeData =
  /** Not there, or not the person's to read: the existence of a suggestion is not public until it is merged (35 § 4). */
  | { readonly kind: "missing" }
  /** The owner's draft, whose page is its edit page. */
  | { readonly kind: "draft" }
  | {
      readonly kind: "page";
      /**
       * The suggestion as the page draws it. Under way, it is drawn with no decision: a revision returns it to
       * `SUBMITTED` with the earlier attempt's decision still in its row (33 § 6.4), and that decision is the record's
       * now, not the page's.
       */
      readonly view: SuggestionView;
      readonly variant: OutcomeVariant;
      /** The read as it came, in the form the page's later reads compare (`refreshKeyOf`). */
      readonly refreshKey: string;
      readonly context: Awaited<ReturnType<typeof suggestionContext>>;
      /** The `decided` record: its hash and what the decision cost; null until something is decided. */
      readonly decided: { readonly hash: string; readonly tokens: number } | null;
      /** The parts whose curators decide it, with a curator; empty otherwise. */
      readonly parts: ReadonlyArray<Part>;
      /** A curator's last action, once closed; null otherwise, or where no curator acted. */
      readonly curator: CuratorDecisionForUser | null;
      /** The owner's alone: absent for a curator reading another's suggestion. */
      readonly own: { readonly other: OtherOpen | null; readonly throttle: { readonly count: number; readonly declines: number; readonly withinDays: number } } | null;
      /** The owner's withdrawal asked for and still unrecorded past `WITHDRAWAL_RESEND_MS`: `Withdraw` is offered again, and sends that request again (review of unit 63). */
      readonly withdrawAgain: boolean;
    };

export async function getImproveOutcome({ locale, user, id }: { readonly locale: Locale; readonly user: SessionUser; readonly id: string }): Promise<ImproveOutcomeData> {
  const ownRead = await readSuggestionView(user, id);
  /* a researcher's closed proposal, any curator's (43 D6); a researcher's proposal, the reader's who asked (43 D7, D12) */
  const closedRead = ownRead === null ? await readClosedResearchView(user, id) : null;
  const askerRead = ownRead === null && closedRead === null ? await readAskerProposalView(user, id) : null;
  const read = ownRead ?? closedRead ?? askerRead;
  if (read === null) return { kind: "missing" };
  if (read.state === "DRAFT") return read.own ? { kind: "draft" } : { kind: "missing" };
  const now = new Date();
  const caller = callerOf(user);
  const variant = variantOf(read);
  const underWay = variant === "progress" || variant === "budget";
  const view: SuggestionView = underWay ? { ...read, adjudication: null, decidedAt: null } : read;

  const [context, records, parts, curator, own] = await Promise.all([
    suggestionContext(view, locale, now),
    underWay ? Promise.resolve([]) : ledgerView({ suggestionId: id }),
    /* the parts whose curators decide it, from whichever read gave it */
    variant === "curator" || variant === "recommended"
      ? (ownRead !== null ? readSuggestion(caller, id) : closedRead !== null ? readClosedResearchProposal(caller, id) : readAskerProposal(user, id)).then((row) => row?.parts ?? [])
      : Promise.resolve([]),
    variant === "closed" ? latestCuratorDecision(caller, id) : Promise.resolve(null),
    view.own ? ownColumn(user, id, locale, now) : Promise.resolve(null),
  ]);
  const record = [...records].reverse().find((entry) => entry.kind === "DECIDED") ?? null;
  const payload = record === null ? null : DecidedPayloadSchema.safeParse(record.payload);
  return {
    kind: "page",
    view,
    variant,
    refreshKey: refreshKeyOf(read),
    context,
    decided: record === null ? null : { hash: record.hash, tokens: payload !== null && payload.success ? payload.data.usage.inputTokens + payload.data.usage.outputTokens : 0 },
    parts,
    curator,
    own,
    withdrawAgain: read.own && resendsWithdrawal(read.withdrawnAt, now),
  };
}

/** The owner's right column: their most recent other open suggestion, read as its own page reads it, and the throttle's count of their own declines. */
async function ownColumn(user: SessionUser, id: string, locale: Locale, now: Date): Promise<NonNullable<Extract<ImproveOutcomeData, { readonly kind: "page" }>["own"]>> {
  const caller = callerOf(user);
  const [otherId, count] = await Promise.all([latestOwnOpenSuggestion(caller, id), ownUnverifiableDeclines(caller, throttleWindowStart(now))]);
  const otherView = otherId === null ? null : await readSuggestionView(user, otherId);
  const other = otherView === null ? null : { view: otherView, context: await suggestionContext(otherView, locale, now) };
  return { other, throttle: { count, declines: THROTTLE.declines, withinDays: THROTTLE.withinDays } };
}
