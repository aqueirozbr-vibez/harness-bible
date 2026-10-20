import { readAskerProposalView, readClosedResearchView, readMergedSuggestionView, readSuggestionView } from "@/lib/api/endpoints/suggestions";
import { endorserOf } from "@/lib/improve/endorsement";
import { callerOf, readSuggestion } from "@/lib/db/improve";
import type { SessionUser } from "@/lib/auth/session";
import { recordPeople } from "@/lib/db/account";
import { checkedView } from "@/lib/db/ledger";
import { sourceRowVerifiedIn } from "@/lib/db/releases";
import { suggestionContext } from "@/lib/db/suggestEdit";
import type { Locale } from "@/lib/i18n/routing";
import { variantOf, type OutcomeVariant } from "@/lib/improve/outcomeView";
import { entriesOf, personOf, type RecordEntry } from "@/lib/improve/record";
import type { ChainCheck } from "@/lib/ledger/verify";
import type { SuggestionView } from "@/lib/schemas/suggestions";

/*
 * The loader of a suggestion's record (feature-specs/35 § 5; unit 52c): the suggestion as `GET /suggestions/{id}`
 * reads it, so the same people read both pages; its records from the ledger's view, each as the presenter tells it;
 * and the chain checked on this request (`checkedView`), never cached. Nothing is written. Once merged, anyone reads
 * it, signed out included (35 D2; unit 54d): the chapter's history links here.
 */

export type ImproveRecordData =
  /** Not there, or not the person's to read: before a merge, a record is its suggestion's audience's (35 § 5, D2). */
  | { readonly kind: "missing" }
  /** The owner's draft, which has no record: its page is its edit page. */
  | { readonly kind: "draft" }
  | {
      readonly kind: "page";
      readonly view: SuggestionView;
      readonly variant: OutcomeVariant;
      readonly context: Awaited<ReturnType<typeof suggestionContext>>;
      readonly entries: ReadonlyArray<RecordEntry>;
      readonly chain: ChainCheck;
      /** The contributor as the record names them, and whether the submission said their identity was verified. */
      readonly contributor: { readonly name: string | null; readonly pseudonym: string | null; readonly verified: boolean | null };
      /** When the chain was checked: this request. */
      readonly checkedAt: Date;
      /** Who merged it, as the record names them (unit 54c): the curator's `curator` record of action `MERGE`; null before. */
      readonly mergedBy: string | null;
      /** A merged change of a source row: its verification date in the release the merge started from and in the one it made. */
      readonly sourceRow: { readonly before: Date | null; readonly after: Date | null } | null;
      /**
       * How the viewer came to read it: as its owner, as a curator (of one of its parts, or of any, for a researcher's
       * closed proposal: 43 D6), as the reader who asked for a researcher's proposal (43 D7, D12: people by the ledger's
       * pseudonym but for their own name, no export), or as anyone, once merged (35 D2).
       */
      readonly audience: "own" | "curator" | "asker" | "public";
      /** A researcher's proposal (43 § 8; unit 60e): whose name stands on it — by the name this reader may see, or the ledger's pseudonym — and whether their identity was verified; null for a person's suggestion. */
      readonly research: { readonly endorser: { readonly name: string | null; readonly pseudonym: string; readonly verified: boolean } | null } | null;
      /** The viewer may revert it (37 § 8; unit 54e): a curator of one of its parts, not its owner, the change merged and not reverted. */
      readonly mayRevert: boolean;
      /** The viewer may export its records: its owner and a curator of its parts, as the export's endpoint reads them — not a curator reading a closed researcher's proposal across parts (43 D6), the asker or anyone (review of unit 60). */
      readonly mayExport: boolean;
    };

export async function getImproveRecord({ locale, user, id }: { readonly locale: Locale; readonly user: SessionUser | null; readonly id: string }): Promise<ImproveRecordData> {
  const ownRead = user === null ? null : await readSuggestionView(user, id);
  /* a researcher's closed proposal, any curator's (43 D6); a researcher's proposal, the reader's who asked (43 D7) */
  const closedRead = ownRead === null && user !== null ? await readClosedResearchView(user, id) : null;
  const askerRead = ownRead === null && closedRead === null && user !== null ? await readAskerProposalView(user, id) : null;
  const view = ownRead ?? closedRead ?? askerRead ?? (await readMergedSuggestionView(id));
  if (view === null) return { kind: "missing" };
  const audience = ownRead !== null ? (view.own ? "own" : "curator") : closedRead !== null ? "curator" : askerRead !== null ? "asker" : "public";
  /* a curator of one of its parts may revert a merged change that is not their own and not reverted (37 § 8) */
  const curatorRow = user !== null && user.role === "CURATOR" && audience === "curator" ? await readSuggestion(callerOf(user), id) : null;
  const mayRevert = curatorRow !== null && curatorRow.state === "MERGED" && view.merge !== null && view.merge.mergedAt !== null && view.merge.revertedBy === null && curatorRow.parts.some((part) => user?.parts.includes(part) === true);
  if (view.state === "DRAFT") return view.own ? { kind: "draft" } : { kind: "missing" };
  const now = new Date();
  const [context, { rows, chain }] = await Promise.all([suggestionContext(view, locale, now), checkedView({ suggestionId: id })]);

  /* The viewer is the owner or a curator of its parts, to whom people appear by name (35 § 5): the contributor while
     their consent stands, anyone not when their account is gone or going. */
  const submitted = rows.find((row) => row.kind === "SUBMITTED") ?? null;
  const contributorId = submitted === null ? null : personOf(submitted.actor);
  const people = await recordPeople([...new Set(rows.flatMap((row) => personOf(row.actor) ?? []))]);
  const names = new Map<string, string>();
  for (const [personId, person] of people) {
    /* the reader who asked sees people as the ledger names them, but for their own name where they put it (43 D12) */
    if (audience === "asker" && personId !== user?.id) continue;
    if (!person.deleted && (personId !== contributorId || person.consented)) names.set(personId, person.displayName);
  }
  /* a researcher's proposal: its `submitted` record is the researcher's, and whose name stands on it is read from the records alone (42 § 6) */
  const endorser = view.origin === "RESEARCHER" ? endorserOf(rows) : null;
  const endorserId = endorser === null ? null : endorser.slice("user:".length);
  /* a name taken back is not shown on the timeline either (42 D4; review of unit 60): an `endorsed` record whose reader's
     name no longer stands reads by the ledger's pseudonym, as the header, the queue and the history read it */
  const entries = entriesOf(rows, names).map((entry) =>
    view.origin === "RESEARCHER" && entry.facts.kind === "ENDORSED" && entry.actor.kind === "person" && entry.actor.pseudonym !== endorser ? { ...entry, actor: { ...entry.actor, name: null } } : entry,
  );
  const latest = [...entries].reverse().find((entry) => entry.facts.kind === "SUBMITTED");
  /* the curator who merged it, as the timeline names them: by name to this viewer, or the ledger's pseudonym */
  const merger = [...entries].reverse().find((entry) => entry.facts.kind === "CURATOR" && (entry.facts.action === "MERGE" || entry.facts.action === "REVERT"))?.actor ?? null;
  const mergedBy = merger === null ? null : merger.kind === "person" ? (merger.name ?? merger.pseudonym.slice(0, "user:".length + 8)) : merger.service;
  /* a row's change, merged: the date it was verified, before and after (37 § 6) */
  const merged = view.merge !== null && view.merge.mergedAt !== null && view.merge.releaseTo !== null ? view.merge : null;
  const sourceRow =
    merged === null || view.anchor.kind !== "SOURCE_ROW" || merged.releaseTo === null
      ? null
      : { before: await sourceRowVerifiedIn(merged.releaseFrom, view.anchor.id), after: await sourceRowVerifiedIn(merged.releaseTo, view.anchor.id) };
  return {
    kind: "page",
    view,
    variant: variantOf(view),
    context,
    entries,
    chain,
    contributor: { name: contributorId === null ? null : (names.get(contributorId) ?? null), pseudonym: contributorId === null ? null : (submitted?.actor ?? null), verified: latest !== undefined && latest.facts.kind === "SUBMITTED" ? latest.facts.verified : null },
    research: view.origin !== "RESEARCHER" ? null : { endorser: endorser === null || endorserId === null ? null : { name: names.get(endorserId) ?? null, pseudonym: endorser, verified: people.get(endorserId)?.verified ?? false } },
    checkedAt: now,
    mergedBy,
    sourceRow,
    audience,
    mayRevert,
    mayExport: ownRead !== null,
  };
}
