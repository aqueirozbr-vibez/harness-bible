import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";

import type { BookmarkRow } from "@/lib/schemas/marks";

interface MarkRowHeadProps {
  readonly row: Pick<BookmarkRow, "sectionId" | "chapterNumber" | "href" | "section">;
  /** Right-aligned node after the context: a time, a count. */
  readonly trailing?: ReactNode;
}

/** The first line of a mark row: id, title link, chapter context (feature-specs/07 § 6.4). */
export function MarkRowHead({ row, trailing }: MarkRowHeadProps) {
  const t = useTranslations("marks.row");
  return (
    <div className="row mark-head">
      <span className="mono mark-id">{row.sectionId}</span>
      {row.section === null ? (
        <span className="small mark-title">{row.sectionId}</span>
      ) : (
        <Link href={row.href} className="small mark-title">
          {row.section.title}
        </Link>
      )}
      {row.section === null ? null : <span className="small faint mark-context">{t("context", { n: String(row.chapterNumber).padStart(2, "0"), title: row.section.chapterTitle })}</span>}
      {trailing !== undefined ? <span className="meta grow" style={{ textAlign: "right" }}>{trailing}</span> : null}
    </div>
  );
}

/** The layer cap, or the warn line when the section left the release. */
export function MarkRowCap({ row, releaseId }: { readonly row: Pick<BookmarkRow, "section">; readonly releaseId: string }) {
  const t = useTranslations("marks.row");
  const tl = useTranslations("reader.layer");
  if (row.section === null) return <span className="cap mark-gone">{t("gone", { id: releaseId })}</span>;
  return <span className="cap">{t("layer", { n: row.section.ordinal, name: tl(String(row.section.ordinal)).toLowerCase() })}</span>;
}
