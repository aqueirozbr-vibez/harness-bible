import { useTranslations } from "next-intl";

import { Chip } from "@/components/ui/Chip";
import { StatusBlock } from "@/components/ui/StatusBlock";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { SourceRowView } from "@/lib/schemas/chapter";

interface SourceRowsProps {
  readonly rows: ReadonlyArray<SourceRowView>;
  /** The link column renders only when a row has somewhere to go (feature-specs/10 D4). */
  readonly hasLinks: boolean;
  readonly locale: Locale;
}

/** Layer 9: the chapter's source registry, the anchor target for cited figures and suggestions; each linked row opens its document in a new tab (feature-specs/10 § 6). */
export function SourceRows({ rows, hasLinks, locale }: SourceRowsProps) {
  const t = useTranslations("reader");
  return (
    <div className="scroll" style={{ maxWidth: 680 }}>
      <table className="tbl source-rows">
        <thead>
          <tr>
            <th>#</th>
            <th>{t("sources.claim")}</th>
            <th>{t("sources.source")}</th>
            {hasLinks ? <th>{t("sources.link")}</th> : null}
            <th>{t("sources.tier")}</th>
            <th>{t("sources.verified")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} id={`r${row.ordinal}`}>
              <td className="m">r{row.ordinal}</td>
              <td>{row.claim}</td>
              <td>{row.citation}</td>
              {hasLinks ? (
                <td>
                  {row.link !== null ? (
                    <a className="src-link" href={row.link.href} target="_blank" rel="noopener noreferrer" aria-label={t("sources.linkLabel", { ordinal: row.ordinal, citation: row.citation })}>
                      {t(row.link.kind === "doi" ? "sources.doi" : "sources.link")}
                    </a>
                  ) : null}
                </td>
              ) : null}
              <td>
                <Chip tier={row.tier} abbr={row.tier === "DERIVED" ? "ƒ" : t(`tier.abbr.${row.tier}`)} />
              </td>
              <td className="m">
                <span className="row" style={{ gap: 6 }}>
                  {formatDate(row.verifiedAt, locale)}
                  {row.stale ? (
                    <StatusBlock tone="warn" className="sb-sm">
                      {t("sources.stale")}
                    </StatusBlock>
                  ) : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
