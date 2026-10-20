import { useTranslations } from "next-intl";
import Link from "next/link";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import type { ChapterData } from "@/lib/schemas/chapter";
import { padChapter } from "@/lib/schemas/ids";

interface OutlineCondensedProps {
  readonly data: ChapterData;
  readonly signedIn: boolean;
  /** The three-column reader: the same section without `ask`. Expanding the rail closes the dock (spec 16 D2). */
  readonly expandHref: string;
}

/**
 * The outline at 64px while the dock is open (feature-specs/16 § 4): the part, the chapter window as mono numbers,
 * the current chapter taller with its section's ordinal under it, and the reading path's count at the foot.
 *
 * Expanding it closes the dock rather than covering it (D2): two rails and a 520px dock do not fit 1440, and the
 * three-column reader is what the expanded state means.
 */
export function OutlineCondensed({ data, signedIn, expandHref }: OutlineCondensedProps) {
  const t = useTranslations("reader");
  const tc = useTranslations("home.continue");
  const { outline, chapter, section, progress } = data;

  return (
    <nav className="reader-outline outline-condensed rr" aria-label={t("outline.condensedLabel")}>
      <Link href={expandHref} className="rb outline-expand" aria-label={t("outline.expand")} aria-expanded="false">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <path d="M2 3.5h12M2 8h12M2 12.5h12" />
          <path d="M10 6l2 2-2 2" />
        </svg>
      </Link>
      <span className="cap outline-part">{PART_ROMAN[outline.partTitleKey]}</span>
      <ul className="col outline-numbers">
        {outline.neighbours.map((n) => {
          const current = n.number === chapter.number;
          return (
            <li key={n.number}>
              <Link
                href={n.href}
                className="mono"
                aria-current={current ? "page" : undefined}
                aria-label={current ? t("outline.currentChapter", { n: n.number, title: n.title, id: section.id }) : t("outline.chapter", { n: n.number, title: n.title })}
              >
                <span>{padChapter(n.number)}</span>
                {current ? <span className="outline-layer">.{section.ordinal}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {signedIn && progress !== null ? (
        <div className="rt outline-path">
          <span className="cap">{t("outline.path")}</span>
          <span className="meta">{tc("of", { done: progress.done, total: progress.total })}</span>
        </div>
      ) : null}
    </nav>
  );
}
