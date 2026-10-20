import { useTranslations } from "next-intl";

import { StatusBar } from "@/components/chrome/StatusBar";
import { StatusNote } from "@/components/chrome/StatusNote";
import { BottomActionBar } from "@/components/reader/BottomActionBar";
import { ChapterHeader } from "@/components/reader/ChapterHeader";
import { ChapterInstrument } from "@/components/reader/ChapterInstrument";
import { AssistantStatusCells } from "@/components/reader/AssistantStatusCells";
import { ChapterStrip } from "@/components/reader/ChapterStrip";
import { CitedPassages } from "@/components/reader/CitedPassages";
import { WalkingBand } from "@/components/reader/WalkingBand";
import { FiguresTable } from "@/components/reader/FiguresTable";
import { NoteEditor } from "@/components/reader/NoteEditor";
import { Outline } from "@/components/reader/Outline";
import { OutlineCondensed } from "@/components/reader/OutlineCondensed";
import { ReadingProgress } from "@/components/reader/ReadingProgress";
import { RenderCheck } from "@/components/reader/RenderCheck";
import { SectionActions } from "@/components/reader/SectionActions";
import { SectionBody } from "@/components/reader/SectionBody";
import { SectionHead } from "@/components/reader/SectionHead";
import { SourceLangBand } from "@/components/reader/SourceLangBand";
import { SourceRows } from "@/components/reader/SourceRows";
import { Notice } from "@/components/ui/Notice";
import { signInHref } from "@/lib/auth/signIn";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { ChapterData } from "@/lib/schemas/chapter";

import type { DeleteNoteAction, SaveNoteAction, ToggleBookmarkAction } from "@/app/[lang]/ch/[n]/[section]/actions";
import type { Aid } from "@/lib/aids/schema";

interface ReaderChapterProps {
  readonly data: ChapterData;
  readonly locale: Locale;
  readonly signedIn: boolean;
  readonly loadedMs: number;
  readonly labHref: string | null;
  readonly askHref: string;
  /** Where sign-in returns a signed-out reader to, as `TopBar` takes it: the phone bar's bookmark cell links there (spec 03 § 6.10). */
  readonly nextPath: string;
  /**
   * The assistant dock is open (`?ask=…`, feature-specs/16 § 4): the grid narrows to make room for the 520px dock
   * the `@assistant` slot renders, the outline condenses to 64px, and the right rail's instruments move into the
   * reading column, exactly as they do under 1000px.
   */
  readonly dockOpen?: boolean;
  /** The chapter's decision aids, for the reading column's walking band and tree while the dock walks one (feature-specs/18 § 5). */
  readonly aids?: ReadonlyArray<Aid>;
  /** Server action that records the view against the active reading path (feature-specs/05 § 5.3). */
  readonly recordRead?: (input: { sectionId: string; locale: string }) => Promise<unknown>;
  /** Server actions behind the bookmark toggle and the note editor (feature-specs/07 § 5.3). */
  readonly markActions?: { readonly toggleBookmark: ToggleBookmarkAction; readonly saveNote: SaveNoteAction; readonly deleteNote: DeleteNoteAction };
}

/** The chapter reader: outline, reading column, rail, status bar (feature-specs/03-reader-chapter.md § 5). */
export function ReaderChapter({ data, locale, signedIn, loadedMs, labHref, askHref, nextPath, dockOpen = false, aids = [], recordRead, markActions }: ReaderChapterProps) {
  const t = useTranslations("reader");
  const th = useTranslations("home.statusbar");
  const ta = useTranslations("assistant.dock");
  const { chapter, section, marks } = data;
  const staleCount = section.figures.filter((f) => f.fastMoving && f.ageDays !== null && f.ageDays > 90).length;
  const editionPending = chapter.editionLang !== (locale === "pt" ? "PT" : "EN");
  const withMarks = signedIn && marks !== null && markActions !== undefined;

  /* With the dock open the chapter's instrument moves to the head of the reading column as one strip (16 § 4), so
     the rail's own copy of it would be a second reading of the same fact. */
  const rail = (idPrefix: "rail" | "inline", withInstrument = true) => (
    <>
      {withInstrument ? <ChapterInstrument chapter={chapter} locale={locale} /> : null}
      {section.figures.length > 0 ? <FiguresTable sectionId={section.id} figures={section.figures} /> : null}
      <SectionActions sectionId={section.id} chapter={chapter} labHref={labHref} askHref={askHref} locale={locale} marks={withMarks ? marks : null} releaseId={data.release.id} toggleBookmark={markActions?.toggleBookmark} idPrefix={idPrefix} />
      {withMarks ? <NoteEditor sectionId={section.id} releaseId={data.release.id} locale={locale} note={marks.note} save={markActions.saveNote} remove={markActions.deleteNote} idPrefix={idPrefix} /> : null}
      <RenderCheck releaseId={data.release.id} ok />
    </>
  );

  return (
    <>
      {signedIn && recordRead !== undefined ? <ReadingProgress sectionId={section.id} locale={locale} record={recordRead} /> : null}
      <div className={dockOpen ? "reader reader-dock" : "reader"}>
        {dockOpen ? <OutlineCondensed data={data} signedIn={signedIn} expandHref={nextPath} /> : <Outline data={data} signedIn={signedIn} />}
        <main className="reader-main">
          <SourceLangBand chapter={chapter} locale={locale} pending={editionPending} />
          <ChapterStrip chapter={chapter} locale={locale} />
          <ChapterHeader chapter={chapter} locale={locale} pending={editionPending} />
          {dockOpen ? <ChapterInstrument chapter={chapter} locale={locale} condensed /> : null}
          {chapter.verify !== "PASSED" ? <Notice title={t("notice.unverifiedTitle")}>{t("notice.unverified")}</Notice> : null}
          <section className="col rt-s section" style={{ gap: 18, paddingTop: 18 }}>
            <SectionHead section={section} bookmarked={withMarks && marks.bookmarked} />
            {/* What the open answer cites, highlighted in the prose below (feature-specs/16 § 7). */}
            {dockOpen ? <CitedPassages sectionId={section.id} /> : null}
            {/* The walk the dock is on, as the reading column sees it: the band and the aid's steps as a tree (feature-specs/18 § 5). */}
            {dockOpen ? <WalkingBand aids={aids} /> : null}
            {/* Under 768px the dock does not render (the phone sheet of feature-specs/20 was skipped, 2026-10-03): the
                page says so, rather than leave the phone bar's `Ask about 21.3` a dead end. */}
            {dockOpen ? (
              <div className="col phone-only">
                <Notice title={ta("phoneTitle")}>{ta("phoneBody")}</Notice>
              </div>
            ) : null}
            {staleCount > 0 ? <Notice title={t("notice.staleTitle")}>{t("notice.stale", { k: staleCount })}</Notice> : null}
            <SectionBody section={section} lang={chapter.editionLang} pending={editionPending} />
            {section.layer === "SOURCES" ? <SourceRows rows={section.sourceRows} hasLinks={section.hasSourceLinks} locale={locale} /> : null}
          </section>
          <div className="reader-rail-inline">{rail("inline", !dockOpen)}</div>
        </main>
        {/* The dock takes the rail's place: the instruments are in the reading column, so a hidden second copy of
            them would be two of everything for a screen reader (§ 4). */}
        {dockOpen ? null : (
          <aside className="reader-rail rl" aria-label={t("rail.label")}>
            {rail("rail")}
          </aside>
        )}
      </div>
      <BottomActionBar
        layers={data.outline.layers}
        sectionId={section.id}
        chapterNumber={chapter.number}
        askHref={askHref}
        editionLang={chapter.editionLang}
        releaseId={data.release.id}
        bookmarked={withMarks ? marks.bookmarked : null}
        toggleBookmark={markActions?.toggleBookmark}
        signInHref={signInHref(locale, nextPath)}
      />
      <StatusBar
        className="desktop-only"
        trailing={
          <>
            <StatusNote />
            {th("loaded", { s: formatSeconds(loadedMs) })}
          </>
        }
      >
        <span>{t("statusbar.section", { n: chapter.number, id: section.id, title: section.title.toLowerCase() })}</span>
        <AssistantStatusCells open={dockOpen} />
        <span>{th("lang", { lang: locale.toUpperCase(), src: chapter.sourceLang })}</span>
        <span>{th("release", { id: data.release.id })}</span>
      </StatusBar>
    </>
  );
}
