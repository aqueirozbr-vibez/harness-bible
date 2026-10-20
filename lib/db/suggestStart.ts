import { hashFragment } from "@/lib/assistant/turns";
import type { SessionUser } from "@/lib/auth/session";
import { contributorStandingOf } from "@/lib/db/account";
import { currentChapterVersion, resolveAnchor } from "@/lib/db/anchors";
import { getChapterData, getCurrentRelease } from "@/lib/db/content";
import { currentRubricVersion } from "@/lib/db/improve";
import { ageDays, STALE_AFTER_DAYS } from "@/lib/db/shared";
import type { Locale } from "@/lib/i18n/routing";
import { anchorKindOf, changeKindsFor, firstOfKind, homeSectionOf, suggestGate, suggestStartHref, type SuggestGate } from "@/lib/improve/suggest";
import type { ChapterData } from "@/lib/schemas/chapter";
import type { SourceTier } from "@/lib/schemas/domain";
import { parseChapterNumber, SectionIdSchema } from "@/lib/schemas/ids";
import type { AnchorKind, ChangeKind } from "@/lib/schemas/improve";

/*
 * The loader of the suggest form's step 1 (feature-specs/34 § 4, § 7, § 13; unit 51b): what the page shows a
 * person for an anchor, read with the queries that exist — the person's standing, the anchor as the create endpoint
 * resolves it, and the reader's chapter data for the lists — and nothing written. The page reads the params, checks
 * the session and the chapter, and renders what this answers.
 */

export interface StartFigure {
  readonly id: string;
  readonly label: string;
  readonly valueText: string;
  readonly tier: SourceTier | "SCENARIO";
  readonly href: string;
  readonly selected: boolean;
}

export interface StartRow {
  readonly id: string;
  readonly ordinal: number;
  /** The row's claim, else its citation. */
  readonly entry: string;
  readonly tier: SourceTier;
  /** Days since the row was checked. */
  readonly ageDays: number;
  readonly stale: boolean;
  readonly href: string;
  readonly selected: boolean;
}

export interface StartAnchor {
  readonly kind: AnchorKind;
  readonly id: string;
  /** The anchored text as the draft would store it: the source edition's, a figure's `label · value unit`, a row's `claim — citation`. */
  readonly text: string;
  readonly tier: SourceTier | null;
  readonly scenario: boolean;
  readonly fastMoving: boolean;
  readonly stale: boolean;
  /** The text's hash as chrome texture: its first four and next four hex digits, as `hashFragment` writes them. */
  readonly hash: string;
  readonly readBy: ReadonlyArray<{ readonly section: string; readonly title: string; readonly href: string }>;
}

export interface StartPicker {
  readonly locale: Locale;
  /** The language of the sections' titles: the edition's, EN until PT is at parity. Rows and figures are EN alone. */
  readonly contentLang: "en" | "pt";
  /** Where each kind leads, and what it selects there; null when the kind has nothing to choose. */
  readonly kinds: Readonly<Record<AnchorKind, string | null>>;
  /** The section the lists are read from, and the chapter's Sources layer. */
  readonly home: { readonly id: string; readonly title: string };
  readonly sources: { readonly id: string; readonly title: string };
  readonly chapterDigits: string;
  /** The chapter's version: what the anchor is read at. */
  readonly version: string;
  readonly figures: ReadonlyArray<StartFigure>;
  readonly rows: ReadonlyArray<StartRow>;
  readonly anchor: StartAnchor;
  /** What can be proposed on the anchor: a section's four kinds, a figure's or a row's one. */
  readonly changeKinds: ReadonlyArray<ChangeKind>;
}

export interface StartStrip {
  /** The reader's section the person returns to. */
  readonly back: string;
  readonly chapter: Pick<ChapterData["chapter"], "title" | "version" | "part"> & { readonly digits: string };
  /** The language of the chapter's and the sections' titles: the edition's, EN until PT is at parity. */
  readonly contentLang: "en" | "pt";
  readonly anchor: {
    readonly kind: AnchorKind;
    /** The section the anchor sits in: the section itself, a figure's, or the Sources layer of a row. */
    readonly section: { readonly id: string; readonly title: string };
    /** A figure's id or a row's `r12`; null for a section. */
    readonly item: string | null;
  };
  /** Days since a fast-moving anchor was checked, once past the 90; null when it is not stale. */
  readonly staleDays: number | null;
}

/** What the step column holds: why the person cannot start a draft, an anchor that is not there, or the choice. */
export type StartBody =
  | { readonly kind: "gate"; readonly gate: Exclude<SuggestGate, { readonly kind: "form" }> }
  | { readonly kind: "missing"; readonly anchor: string; readonly version: string | null }
  | { readonly kind: "picker"; readonly picker: StartPicker };

export interface SuggestStartData {
  readonly release: { readonly id: string; readonly gitSha: string };
  readonly rubric: { readonly version: string; readonly publishedAt: Date } | null;
  /** The reader's section the page returns to. */
  readonly back: string;
  /** The strip, once the anchor is resolved. */
  readonly strip: StartStrip | null;
  readonly body: StartBody;
}

export interface SuggestStartInput {
  readonly locale: Locale;
  /** The chapter's two digits, as the route has them. */
  readonly n: string;
  readonly user: SessionUser;
  /** The anchor's kind by its form; null when it has none or names no chapter of the book. */
  readonly kind: AnchorKind | null;
  readonly anchor: string;
  readonly from: string | undefined;
  /** The page's own address: the current kind's segment points at it. */
  readonly here: string;
}

export async function getSuggestStart({ locale, n, user, kind, anchor, from, here }: SuggestStartInput): Promise<SuggestStartData> {
  const now = new Date();
  const chapter = parseChapterNumber(Number(n));
  const [standing, release, rubricRow] = await Promise.all([contributorStandingOf(user), getCurrentRelease(), currentRubricVersion(now)]);
  const rubric = rubricRow === null ? null : { version: rubricRow.id, publishedAt: rubricRow.publishedAt };
  /* Where the page returns to before anything is resolved: the section the person came from, else the anchor's,
     when the chapter has it (its reader page is cached), else the chapter's first. */
  const wanted = from !== undefined && SectionIdSchema.safeParse(from).success && from.slice(0, 2) === n ? from : kind === "SECTION" ? anchor : `${n}.1`;
  const back = wanted === `${n}.1` || (await getChapterData(locale, chapter, wanted, null)) !== null ? wanted : `${n}.1`;
  const gate = suggestGate(user, standing.throttledUntil, now);
  if (gate.kind !== "form") return { release, rubric, back, strip: null, body: { kind: "gate", gate } };

  const resolved = kind === null ? null : await resolveAnchor(kind, anchor, locale);
  if (kind === null || resolved === null) {
    const version = (await currentChapterVersion(chapter))?.version ?? null;
    /* An id of an anchor's form is echoed as not found; anything else is not repeated back. */
    return { release, rubric, back, strip: null, body: { kind: "missing", anchor: anchorKindOf(anchor) === null ? "" : anchor, version } };
  }

  /* The lists: the figures of the anchor's section (for a row, of the section the person came from), and every row
     of the chapter's Sources layer. A section the chapter does not have falls back to its first. */
  const homeWanted = homeSectionOf(from, anchor, kind, kind === "FIGURE" ? resolved.sectionAnchor : null);
  const homeData = (await getChapterData(locale, chapter, homeWanted, null)) ?? (await getChapterData(locale, chapter, `${n}.1`, null));
  const sourcesData = await getChapterData(locale, chapter, `${n}.9`, null);
  if (homeData === null || sourcesData === null) throw new Error(`chapter ${n} is in the release without its first or its Sources section`);
  const home = { id: homeData.section.id, title: homeData.section.title };
  const sources = { id: sourcesData.section.id, title: sourcesData.section.title };
  const titleOf = (id: string): string => homeData.outline.layers.find((layer) => layer.id === id)?.title ?? id;

  const figures = homeData.section.figures.flatMap((figure) =>
    figure.id === null ? [] : [{ id: figure.id, label: figure.label, valueText: figure.valueText, tier: figure.tier, href: suggestStartHref(locale, figure.id, "FIGURE", home.id), selected: kind === "FIGURE" && figure.id === anchor }],
  );
  const rows = sourcesData.section.sourceRows.map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    entry: row.claim ?? row.citation,
    tier: row.tier,
    ageDays: ageDays(row.verifiedAt, now),
    stale: row.stale,
    href: suggestStartHref(locale, row.id, "SOURCE_ROW", home.id),
    selected: kind === "SOURCE_ROW" && row.id === anchor,
  }));
  const firstFigure = firstOfKind("FIGURE", home.id, homeData.section.figures, homeData.section.sourceRows, sourcesData.section.sourceRows);
  const firstRow = firstOfKind("SOURCE_ROW", home.id, homeData.section.figures, homeData.section.sourceRows, sourcesData.section.sourceRows);
  const kinds: StartPicker["kinds"] = {
    SECTION: suggestStartHref(locale, home.id, "SECTION", home.id),
    FIGURE: kind === "FIGURE" ? here : firstFigure === null ? null : suggestStartHref(locale, firstFigure, "FIGURE", home.id),
    SOURCE_ROW: kind === "SOURCE_ROW" ? here : firstRow === null ? null : suggestStartHref(locale, firstRow, "SOURCE_ROW", home.id),
  };

  const age = resolved.verifiedOn === null ? null : ageDays(resolved.verifiedOn, now);
  const stale = resolved.fastMoving && age !== null && age > STALE_AFTER_DAYS;
  const contentLang = homeData.chapter.editionLang === "PT" ? "pt" : "en";
  const anchorSection = kind === "SOURCE_ROW" ? sources.id : resolved.sectionAnchor;
  return {
    release,
    rubric,
    back: home.id,
    strip: {
      back: home.id,
      chapter: { digits: n, title: homeData.chapter.title, version: resolved.chapterVersion, part: homeData.chapter.part },
      contentLang,
      anchor: { kind, section: { id: anchorSection, title: titleOf(anchorSection) }, item: kind === "FIGURE" ? anchor : kind === "SOURCE_ROW" ? anchor.slice(anchor.indexOf(" ") + 1) : null },
      staleDays: stale ? age : null,
    },
    body: {
      kind: "picker",
      picker: {
        locale,
        contentLang,
        kinds,
        home,
        sources,
        chapterDigits: n,
        version: resolved.chapterVersion,
        figures,
        rows,
        anchor: {
          kind,
          id: anchor,
          text: resolved.currentText,
          tier: resolved.tier,
          scenario: resolved.scenarioParam,
          fastMoving: resolved.fastMoving,
          stale,
          hash: hashFragment(resolved.contentSha256),
          readBy: resolved.readBy.map((reader) => ({ section: reader.section, title: reader.title, href: `/${locale}/ch/${reader.section.slice(0, 2)}/${reader.section}` })),
        },
        changeKinds: changeKindsFor(kind),
      },
    },
  };
}
