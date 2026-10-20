import { hashFragment } from "@/lib/assistant/turns";
import { readSuggestionView, SUBMISSIONS_A_DAY } from "@/lib/api/endpoints/suggestions";
import type { SessionUser } from "@/lib/auth/session";
import { resolveAnchor } from "@/lib/db/anchors";
import { contributorStandingOf } from "@/lib/db/account";
import { getChapterData, getCurrentRelease } from "@/lib/db/content";
import { callerOf, readRubricVersion, submittedSince } from "@/lib/db/improve";
import { noteOfDraft } from "@/lib/db/research";
import { ageDays, STALE_AFTER_DAYS } from "@/lib/db/shared";
import type { StartAnchor, StartStrip } from "@/lib/db/suggestStart";
import type { DraftClass } from "@/lib/hooks/draftSave";
import { loadRubric } from "@/lib/rubrics/load";
import type { Locale } from "@/lib/i18n/routing";
import type { RowNow } from "@/lib/improve/editors";
import type { SuggestEvidence } from "@/lib/improve/evidenceView";
import type { SubmitFacts } from "@/lib/improve/scoreView";
import { suggestGate } from "@/lib/improve/suggest";
import { THROTTLE } from "@/lib/improve/throttle";
import { decimalOfPrinted } from "@/lib/improve/value";
import { researchPageHref } from "@/lib/research/links";
import type { Role } from "@/lib/schemas/auth";
import { ITEMS_PER_SUGGESTION_MAX } from "@/lib/schemas/evidence";
import { parseChapterNumber } from "@/lib/schemas/ids";
import { takesRevision, type ChangeKind, type Proposal } from "@/lib/schemas/improve";
import type { SuggestionScoring, SuggestionView } from "@/lib/schemas/suggestions";

/*
 * The loader of the suggest form's edit page (feature-specs/34 § 5, § 7; unit 51c): the draft as
 * `GET /suggestions/{id}` reads it (`readSuggestionView`, the endpoint's own), so that every number on the page is
 * the read's, with what the strip and the anchor column add from the release: the chapter's titles, the anchor's tier
 * and marks, and what an editor starts from — a figure's printed value, a section's source text and figures, a row's
 * fields. Nothing is written; the editors' saves are the endpoint's.
 */

/** A figure's value, which a value's edit starts from (34 § 5: `before · current`). */
export interface EditValue {
  /** As the book prints it: `$0.30`, `7,500 tokens`. */
  readonly printed: string;
  /** Its number as a proposal writes a decimal, the struck-through field: `0.30`; null where the value is not printed as a number. */
  readonly before: string | null;
  /** The figure's unit, which the unit field starts from: `USD`, `%`; null for a count. */
  readonly unit: string | null;
}

export interface SuggestEditForm {
  readonly id: string;
  readonly locale: Locale;
  /**
   * A suggestion returned to its owner for more evidence (31 § 6.5; 35 § 4's `Revise with new evidence`): its evidence
   * and rationale are written as a draft's are, its anchor and proposal stay as submitted, and Submit tells the running
   * workflow instead of starting one.
   */
  readonly revision: boolean;
  /** The language of the sections' titles: the edition's, EN until PT is at parity. */
  readonly contentLang: "en" | "pt";
  /** The anchor as the draft holds it — its text and hash as at creation — with the tier and marks the release gives it. */
  readonly anchor: StartAnchor;
  /** The anchor's section, which a section's anchored text names. */
  readonly home: { readonly id: string; readonly title: string };
  /** The chapter's version the anchor is read at. */
  readonly version: string;
  readonly changeKind: ChangeKind;
  /** The class, its thresholds, and whether recency applies: the anchor's flag, or a claim's or a row's declaration (30 § 3.4). */
  readonly draftClass: DraftClass;
  /** The rubric the draft is written against, whose thresholds the class panel shows. */
  readonly rubricVersion: string;
  readonly proposal: Proposal | null;
  /** For a value's edit, the figure's value; null for every other kind, and for a figure the release no longer has. */
  readonly value: EditValue | null;
  /** For a section's kinds: its source text as the draft stores it, which a passage is picked from, and its figures, which a passage edit keeps out of (31 § 5). */
  readonly section: { readonly source: string; readonly figures: ReadonlyArray<{ readonly id: string; readonly valueText: string }> } | null;
  /** For a row's edit, the row's fields as the release has them; null for every other kind, and for a row the release no longer has. */
  readonly row: RowNow | null;
  /** Step 3: the items as the read gives them, which one corroborates, and the rubric's numbers they are worded by (34 § 5; unit 51d). */
  readonly evidence: SuggestEvidence;
  /** Step 4: the rationale as saved (34 § 5; unit 51e). */
  readonly rationale: string | null;
  /** The right column as the read gives it (34 § 6): the score and prediction, null until an item is graded, and the class's thresholds. */
  readonly score: { readonly scoring: SuggestionScoring | null; readonly thresholds: SuggestionView["thresholds"] };
  /** What Submit needs to know: whether consent is asked for, a pause the throttle set, and how many of the day's submissions are spent. */
  readonly submit: SubmitFacts;
  /** The identity the adjudicator is told of only as verified or not (34 § 6). */
  readonly identity: { readonly name: string; readonly verified: boolean };
  /** The anchor in the current release, where it is no longer what the draft recorded (34 § 7): what it was, and what it is now, or null when it is gone. */
  readonly anchorChanged: { readonly was: string; readonly now: string | null } | null;
  /** Drafted from a research finding (feature-specs/48 § 8.6): the proposal editor says it was prefilled by the researcher. */
  readonly prefilled: boolean;
  /** The rail's `from your research` (48 § 8.2), while the draft is one and its run's text lasts: the note, the run, the finding's sources. */
  readonly research: { readonly note: string; readonly contentLang: "en" | "pt"; readonly runHref: string; readonly sources: ReadonlyArray<{ readonly url: string; readonly host: string }> } | null;
}

/** What the page holds: the form, or why its owner may not write it now: a role that is not a contributor's, or an identity not verified (34 § 7). */
export type EditBody = { readonly kind: "role"; readonly role: Role } | { readonly kind: "unverified" } | { readonly kind: "form"; readonly form: SuggestEditForm };

export type SuggestEditData =
  /** No draft of this id is the person's. A draft is its owner's alone (lib/db/improve.ts): another's is not read at all. */
  | { readonly kind: "missing" }
  /** Past draft, the person's or one a curator reads, and not open to its owner's revision: its page is the suggestion's own (spec 35). */
  | { readonly kind: "submitted" }
  | {
      readonly kind: "page";
      readonly release: { readonly id: string; readonly gitSha: string };
      readonly rubric: { readonly version: string; readonly publishedAt: Date } | null;
      readonly chapterDigits: string;
      readonly anchorId: string;
      readonly strip: StartStrip;
      readonly body: EditBody;
    };

export interface SuggestEditInput {
  readonly locale: Locale;
  readonly user: SessionUser;
  readonly id: string;
}

/**
 * What a suggestion's pages show of where it sits — the edit page and its own page (spec 35 § 4): the release and the
 * rubric, the context strip, and the anchor as the current release has it (null where the release no longer has it),
 * with the chapter's data the strip is read from.
 */
export async function suggestionContext(view: SuggestionView, locale: Locale, now: Date) {
  const { anchor } = view;
  const n = String(view.chapter).padStart(2, "0");
  const chapter = parseChapterNumber(view.chapter);
  const [release, rubricRow, resolved, data] = await Promise.all([
    getCurrentRelease(),
    readRubricVersion(view.rubricVersion),
    resolveAnchor(anchor.kind, anchor.id, locale),
    getChapterData(locale, chapter, anchor.section, null).then((found) => found ?? getChapterData(locale, chapter, `${n}.1`, null)),
  ]);
  if (data === null) throw new Error(`chapter ${n} is in the release without the section ${anchor.section} or its first`);

  const contentLang = data.chapter.editionLang === "PT" ? "pt" : "en";
  const sectionTitle = data.outline.layers.find((layer) => layer.id === anchor.section)?.title ?? anchor.section;
  const version = resolved?.chapterVersion ?? data.chapter.version;
  const age = resolved === null || resolved.verifiedOn === null ? null : ageDays(resolved.verifiedOn, now);
  const fastMoving = resolved?.fastMoving ?? false;
  const stale = fastMoving && age !== null && age > STALE_AFTER_DAYS;
  const strip: StartStrip = {
    back: anchor.section,
    chapter: { digits: n, title: data.chapter.title, version, part: data.chapter.part },
    contentLang,
    anchor: { kind: anchor.kind, section: { id: anchor.section, title: sectionTitle }, item: anchor.kind === "FIGURE" ? anchor.id : anchor.kind === "SOURCE_ROW" ? anchor.id.slice(anchor.id.indexOf(" ") + 1) : null },
    staleDays: stale ? age : null,
  };
  const page = { kind: "page" as const, release, rubric: rubricRow === null ? null : { version: rubricRow.id, publishedAt: rubricRow.publishedAt }, chapterDigits: n, anchorId: anchor.id, strip };
  return { page, resolved, contentLang, sectionTitle, version, fastMoving, stale } as const;
}

export async function getSuggestEdit({ locale, user, id }: SuggestEditInput): Promise<SuggestEditData> {
  const now = new Date();
  const view = await readSuggestionView(user, id);
  if (view === null) return { kind: "missing" };
  /* Past draft, the page is its owner's only where the suggestion takes a revision (31 § 6.5). */
  const revision = view.state !== "DRAFT";
  if (revision && !(view.own && takesRevision(view.state, view.outcome))) return { kind: "submitted" };
  if (!view.own) return { kind: "missing" };

  const { anchor } = view;
  const { page, resolved, contentLang, sectionTitle, version, fastMoving, stale } = await suggestionContext(view, locale, now);

  /* The endpoint takes a proposal from a contributor or a curator (lib/improve/suggest.ts). An identity not verified
     sees the notice and no form; a pause the throttle set leaves the draft readable and Submit waiting (34 § 7). */
  /* a draft from a research finding: the caller's own finding that names it, read in their context, never through the improvement door (48 § 8.2) */
  const [standing, submitted, note] = await Promise.all([contributorStandingOf(user), submittedSince(callerOf(user), new Date(now.getTime() - SUBMISSIONS_A_DAY.windowS * 1000)), view.fromResearch && !revision ? noteOfDraft(user, view.id) : Promise.resolve(null)]);
  const gate = suggestGate(user, standing.throttledUntil, now);
  if (gate.kind === "role") return { ...page, body: { kind: "role", role: gate.role } };
  if (gate.kind === "unverified") return { ...page, body: { kind: "unverified" } };

  const printed = view.changeKind === "SET_VALUE" ? (resolved?.value ?? null) : null;
  const { adjustments } = loadRubric(view.rubricVersion).rubric;
  return {
    ...page,
    body: {
      kind: "form",
      form: {
        id: view.id,
        locale,
        revision,
        contentLang,
        anchor: {
          kind: anchor.kind,
          id: anchor.id,
          text: anchor.currentText,
          tier: resolved?.tier ?? null,
          scenario: resolved?.scenarioParam ?? false,
          fastMoving,
          stale,
          hash: hashFragment(anchor.contentSha256),
          readBy: anchor.readBy.map((reader) => ({ section: reader.section, title: reader.title, href: `/${locale}/ch/${reader.section.slice(0, 2)}/${reader.section}` })),
        },
        home: { id: anchor.section, title: sectionTitle },
        version,
        changeKind: view.changeKind,
        draftClass: { changeClass: view.changeClass, curatorReason: view.curatorReason, thresholds: view.thresholds, fastMoving: view.fastMoving },
        rubricVersion: view.rubricVersion,
        proposal: view.proposal,
        value: printed === null ? null : { printed: printed.text, before: decimalOfPrinted(printed.text), unit: printed.unit },
        evidence: {
          items: view.evidence,
          corroboratedById: view.scoring?.corroboratedById ?? null,
          rubric: { corroboration: adjustments.corroboration, independence: adjustments.independence, recency: adjustments.recency },
          max: ITEMS_PER_SUGGESTION_MAX,
          fastMoving: view.fastMoving,
        },
        rationale: view.rationale,
        score: { scoring: view.scoring, thresholds: view.thresholds },
        submit: { consentNeeded: standing.provenanceConsentAt === null, throttledUntil: gate.kind === "throttled" ? gate.until.toISOString() : null, submitted, perDay: SUBMISSIONS_A_DAY.limit, throttle: { declines: THROTTLE.declines, withinDays: THROTTLE.withinDays } },
        identity: { name: user.displayName, verified: user.identityVerified },
        anchorChanged: resolved === null ? { was: anchor.currentText, now: null } : resolved.contentSha256 !== anchor.contentSha256 ? { was: anchor.currentText, now: resolved.currentText } : null,
        prefilled: view.fromResearch,
        research: note === null ? null : { note: note.note, contentLang: note.contentLang, runHref: `${researchPageHref(locale, { research: note.research.conversationId })}#run-${note.research.runId}`, sources: note.sources },
        section: anchor.kind === "SECTION" ? { source: anchor.currentText, figures: resolved?.figures ?? [] } : null,
        row: view.changeKind === "EDIT_ROW" && resolved !== null && resolved.row !== null ? { ...resolved.row, verifiedOn: resolved.verifiedOn === null ? null : resolved.verifiedOn.toISOString().slice(0, 10) } : null,
      },
    },
  };
}
