import { useTranslations } from "next-intl";

import type { ChapterData } from "@/lib/schemas/chapter";

interface SectionHeadProps {
  readonly section: ChapterData["section"];
  /** Shows the read-only `■ bookmarked` flag (feature-specs/07 § 6.5). */
  readonly bookmarked?: boolean;
}

/** `21.3 / Worked numbers · layer 3 of 9` (spec § 6.3). */
export function SectionHead({ section, bookmarked = false }: SectionHeadProps) {
  const t = useTranslations("reader.section");
  const tm = useTranslations("reader.marks");
  return (
    <div className="between section-head">
      <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
        <span className="meta">{section.id}</span>
        <h2 className="h2 section-title">{section.title}</h2>
      </div>
      <span className="row" style={{ gap: 0 }}>
        <span className="cap">{t("layer", { n: section.ordinal })}</span>
        {bookmarked ? <span className="meta mark-flag">■ {tm("flag")}</span> : null}
      </span>
    </div>
  );
}
