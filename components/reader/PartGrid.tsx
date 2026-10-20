import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";

import { ChapterTile } from "@/components/reader/ChapterTile";
import { GlanceCell } from "@/components/reader/GlanceCell";
import type { Locale } from "@/lib/i18n/routing";
import type { HomePart } from "@/lib/schemas/home";

/** Lowercase roman numerals as the screen prints them; not text, so not localised. */
export const PART_ROMAN: Record<HomePart["key"], string> = {
  P0: "0",
  P1: "i",
  P2: "ii",
  P3: "iii",
};

/** Grid column counts per breakpoint (spec § 5, D4); the CSS reads the matching custom property. */
const COLUMN_COUNTS: ReadonlyArray<number> = [9, 5, 3];

/** How many columns a trailing cell spans to complete the last row, for each column count. */
function spanStyle(tileCount: number): CSSProperties {
  const vars: Record<string, number> = {};
  for (const cols of COLUMN_COUNTS) {
    const remainder = tileCount % cols;
    vars[`--span-${cols}`] = remainder === 0 ? cols : cols - remainder;
  }
  return vars as CSSProperties;
}

interface PartGridProps {
  readonly part: HomePart;
  /** Total labs in the release, for the part-0 appendix cell. */
  readonly labsTotal: number;
  readonly locale: Locale;
}

/** One part: header line and the edge-to-edge tile grid (spec § 6.5). */
export function PartGrid({ part, labsTotal, locale }: PartGridProps) {
  const t = useTranslations("home.part");
  const roman = PART_ROMAN[part.key];
  const title = t(`title.${part.key}`);
  const caption = t("cap", { roman, title });
  const counts =
    part.key === "P0" ? t("headerProse", { count: part.chapters.length }) : t("header", { count: part.chapters.length, labs: part.labCount });
  const curators = part.curators.length > 0 ? ` · ${t("curators", { names: part.curators.join(", ") })}` : "";
  const trailing = part.key === "P0" || part.glance !== null;

  return (
    <section className="col gap-s2" aria-label={caption}>
      <div className="between">
        <span className="cap">{caption}</span>
        <span className="meta faint">
          {counts}
          {curators}
        </span>
      </div>
      <ol className="part-grid">
        {part.chapters.map((tile) => (
          <ChapterTile key={tile.number} tile={tile} locale={locale} />
        ))}
        {trailing ? (
          <GlanceCell part={part} roman={roman} labsTotal={labsTotal} style={spanStyle(part.chapters.length)} />
        ) : null}
      </ol>
    </section>
  );
}
