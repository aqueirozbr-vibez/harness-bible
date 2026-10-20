import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";

import type { HomePart } from "@/lib/schemas/home";

interface GlanceCellProps {
  readonly part: HomePart;
  readonly roman: string;
  readonly labsTotal: number;
  /** `--span-*` custom properties computed by the grid; a data-driven style is permitted (ui-context § 13.2). */
  readonly style: CSSProperties;
}

/** The banded cell that completes a part's last row: at-a-glance counts, or the part-iv appendix note for part 0 (spec § 6.7). */
export function GlanceCell({ part, roman, labsTotal, style }: GlanceCellProps) {
  const t = useTranslations("home");

  if (part.key === "P0" || part.glance === null) {
    return (
      <li className="tile tile-glance" style={style}>
        <span className="cap">{t("appendix.label")}</span>
        <span className="meta">{t("appendix.labs", { labs: labsTotal })}</span>
        <span className="meta">{t("appendix.list")}</span>
      </li>
    );
  }

  const g = part.glance;
  return (
    <li className="tile tile-glance" style={style}>
      <span className="cap">{t("glance.label", { roman })}</span>
      <span className="meta">
        {t("glance.counts", { v: g.verifyPassed, n: part.chapters.length, r: g.labsReproduced, l: part.labCount })}
      </span>
      {g.stale.map((s) => (
        <span key={s.chapter} className="meta">
          {t("glance.stale", { count: g.stale.length, n: s.chapter, what: s.what, days: s.days })}
        </span>
      ))}
    </li>
  );
}
