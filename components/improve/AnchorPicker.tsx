import { useTranslations } from "next-intl";
import Link from "next/link";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { AnchoredText } from "@/components/improve/AnchoredText";
import { CreateDraft } from "@/components/improve/CreateDraft";
import { SegLinks } from "@/components/improve/SegLinks";
import { TierChip } from "@/components/improve/TierChip";
import type { StartAnchor, StartFigure, StartPicker, StartRow } from "@/lib/db/suggestStart";
import { ANCHOR_KINDS } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

/** The picker is what the loader answers for a resolved anchor (lib/db/suggestStart.ts). */
export type AnchorPickerProps = StartPicker;

/**
 * Step 1's choice (feature-specs/34 § 4; the Improve-Suggest screen's left column): the kind of anchor, the list
 * for that kind, the anchored text at the current version with its chips and what reads it, and the button that
 * creates the draft. Every choice is a link, so the page resolves one anchor at a time on the server and the
 * address says what is chosen.
 */
export function AnchorPicker({ locale, contentLang, kinds, home, sources, chapterDigits, version, figures, rows, anchor, changeKinds }: AnchorPickerProps) {
  const t = useTranslations("improve.suggest");
  return (
    <>
      <div className="col anchor-kind">
        <SegLinks label={t("kindLabel")} items={ANCHOR_KINDS.map((kind) => ({ key: kind, label: t(`kind.${kind}`), href: kinds[kind], current: anchor.kind === kind }))} />
        {kinds.FIGURE === null ? <p className="help">{t("noFigures", { id: home.id })}</p> : null}
        {kinds.SOURCE_ROW === null ? <p className="help">{t("noRows", { n: chapterDigits })}</p> : null}
      </div>
      {anchor.kind === "FIGURE" ? <FigureList home={home} version={version} figures={figures} anchor={anchor} /> : null}
      {anchor.kind === "SOURCE_ROW" ? <RowList sources={sources} contentLang={contentLang} version={version} rows={rows} anchor={anchor} /> : null}
      <AnchoredText home={home} contentLang={contentLang} version={version} anchor={anchor} />
      <CreateDraft key={anchor.id} locale={locale} anchor={{ kind: anchor.kind, id: anchor.id }} changeKinds={changeKinds} />
    </>
  );
}

function ListFooter({ anchor }: { readonly anchor: StartAnchor }) {
  const t = useTranslations("improve.suggest");
  return (
    <>
      <span>{t("selected", { id: anchor.id })}</span>
      <span className="tex">{t("anchorHash", { hash: anchor.hash })}</span>
    </>
  );
}

function FigureList({ home, version, figures, anchor }: { readonly home: AnchorPickerProps["home"]; readonly version: string; readonly figures: ReadonlyArray<StartFigure>; readonly anchor: StartAnchor }) {
  const t = useTranslations("improve.suggest");
  const tr = useTranslations("reader.figures");
  return (
    <InstrumentPanel
      label={tr("label", { id: home.id })}
      meta={[{ key: "version", node: version }]}
      timestamp={t("figures.count", { count: figures.length })}
      body="bare"
      footer={<ListFooter anchor={anchor} />}
      footerClassName="anchor-list-foot"
    >
      <table className="tbl anchor-list">
        <thead>
          <tr>
            <th>{tr("figure")}</th>
            <th className="n">{tr("value")}</th>
            <th>{tr("tier")}</th>
          </tr>
        </thead>
        <tbody>
          {figures.map((figure) => (
            <tr key={figure.id} className={figure.selected ? "sel" : undefined}>
              <td className="anchor-list-entry">
                <Link href={figure.href} scroll={false} aria-current={figure.selected ? "true" : undefined} lang="en">
                  {figure.label}
                </Link>
              </td>
              <td className="n">{figure.valueText}</td>
              <td>
                <TierChip tier={figure.tier} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </InstrumentPanel>
  );
}

function RowList({ sources, contentLang, version, rows, anchor }: { readonly sources: AnchorPickerProps["sources"]; readonly contentLang: "en" | "pt"; readonly version: string; readonly rows: ReadonlyArray<StartRow>; readonly anchor: StartAnchor }) {
  const t = useTranslations("improve.suggest");
  const label = t("sectionLabel", { id: sources.id, title: sources.title });
  return (
    <InstrumentPanel
      label={<span lang={contentLang}>{label}</span>}
      ariaLabel={label}
      meta={[{ key: "version", node: version }]}
      timestamp={t("rows.count", { count: rows.length })}
      body="bare"
      footer={<ListFooter anchor={anchor} />}
      footerClassName="anchor-list-foot"
    >
      <table className="tbl anchor-list">
        <thead>
          <tr>
            <th>{t("rows.row")}</th>
            <th>{t("rows.entry")}</th>
            <th>{t("rows.tier")}</th>
            <th className="n">{t("rows.checked")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.selected ? "sel" : undefined}>
              <td className="meta anchor-list-id">r{row.ordinal}</td>
              <td className="anchor-list-entry">
                <Link href={row.href} scroll={false} aria-current={row.selected ? "true" : undefined} lang="en">
                  {row.entry}
                </Link>
              </td>
              <td>
                <TierChip tier={row.tier} />
              </td>
              <td className={cn("n anchor-list-age", row.stale && "is-stale")}>{t("rows.age", { days: row.ageDays })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </InstrumentPanel>
  );
}
