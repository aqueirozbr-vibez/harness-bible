"use client";

import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { FIGURE_EVENT } from "@/components/reader/ProseInteractions";
import { Chip } from "@/components/ui/Chip";
import { StatusBlock } from "@/components/ui/StatusBlock";
import type { SectionFigure } from "@/lib/schemas/chapter";

interface FiguresTableProps {
  readonly sectionId: string;
  readonly figures: ReadonlyArray<SectionFigure>;
}

/** The section's figures with their tiers; a row scrolls to its figure in the prose (spec § 6.9). */
export function FiguresTable({ sectionId, figures }: FiguresTableProps) {
  const t = useTranslations("reader");

  const jump = (figure: SectionFigure) => {
    window.dispatchEvent(new CustomEvent(FIGURE_EVENT, { detail: { id: figure.id } }));
  };

  return (
    <InstrumentPanel label={t("figures.label", { id: sectionId })} timestamp={String(figures.length)} body="bare">
      <table className="tbl figures-table" style={{ fontSize: 12.5 }}>
        <thead>
          <tr>
            <th>{t("figures.figure")}</th>
            <th className="n">{t("figures.value")}</th>
            <th>{t("figures.tier")}</th>
          </tr>
        </thead>
        <tbody>
          {figures.map((figure) => {
            const stale = figure.fastMoving && figure.ageDays !== null && figure.ageDays > 90;
            return (
              <tr key={figure.id ?? figure.label} className={figure.id === null ? undefined : "figures-row"} onClick={figure.id === null ? undefined : () => jump(figure)}>
                <td>{figure.label}</td>
                <td className="n">{figure.valueText}</td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    {figure.tier === "SCENARIO" ? (
                      <span className="meta">{t("figures.scenario")}</span>
                    ) : figure.tier === "DERIVED" ? (
                      <Chip tier="DERIVED" abbr="ƒ">
                        {t("tier.derLabel")}
                      </Chip>
                    ) : (
                      <Chip tier={figure.tier} abbr={t(`tier.abbr.${figure.tier}`)} />
                    )}
                    {stale && figure.ageDays !== null ? (
                      <StatusBlock tone="warn" className="sb-sm">
                        {t("figures.stale", { days: figure.ageDays })}
                      </StatusBlock>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </InstrumentPanel>
  );
}
