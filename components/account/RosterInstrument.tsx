import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { PART_ROMAN } from "@/components/reader/PartGrid";
import { Xref } from "@/components/ui/Xref";
import { formatDate, formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { RosterPanel } from "@/lib/improve/roster";
import type { Part } from "@/lib/schemas/improve";

/*
 * The curator roster (feature-specs/38 § 4; the Account-Admin screen's `Curator roster` instrument): one row per
 * part — its chapters, its curators by display name, the queue's count and the median decision time over the
 * quarter — read-only, on Book management for curators and organisation admins since 2026-10-12 (38 D2 as
 * feature-specs/47 D1 amends it). Nothing is computed here: `rosterPanelOf` did; this component formats. A part with fewer than two curators is shown as it is; the Phase 4 gate judges that (spec 39).
 */

/** The screen's roman numerals; this table prints them in capitals (`Part I · Foundations`). `P4`, a part with no chapter of the book, never reaches a row. */
const ROMAN: Readonly<Record<Part, string>> = { ...PART_ROMAN, P4: PART_ROMAN.P3 };

const two = (n: number): string => String(n).padStart(2, "0");

interface RosterInstrumentProps {
  readonly roster: RosterPanel;
  readonly locale: Locale;
}

export function RosterInstrument({ roster, locale }: RosterInstrumentProps) {
  const t = useTranslations("account.roster");
  return (
    <section id="roster" className="col account-roster" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel
        label={t("label")}
        meta={[
          { key: "who", node: t("editorial") },
          { key: "visibility", node: t("visibility") },
        ]}
        timestamp={t("since", { date: formatDate(new Date(roster.since), locale) })}
        body="bare"
        className="account-inst roster-inst"
        footer={
          <>
            <span>{t("footer")}</span>
            <Xref href={`/${locale}/rubric`}>{t("rubric")}</Xref>
          </>
        }
      >
        {/* a region a keyboard reaches: on a phone the five columns scroll inside it, and a scrollable region must be focusable */}
        <div className="roster-scroll" tabIndex={0} role="region" aria-label={t("label")}>
        <table className="tbl roster-table">
          <thead>
            <tr>
              <th scope="col">{t("th.part")}</th>
              <th scope="col">{t("th.chapters")}</th>
              <th scope="col">{t("th.curators")}</th>
              <th scope="col" className="n">
                {t("th.queue")}
              </th>
              <th scope="col" className="n">
                {t("th.median")}
              </th>
            </tr>
          </thead>
          <tbody>
            {roster.rows.map((row) => (
              <tr key={row.part}>
                <td>{t("part", { roman: ROMAN[row.part].toUpperCase(), title: t(`partTitle.${row.part}`) })}</td>
                <td className="meta">{row.chapters.first === row.chapters.last ? two(row.chapters.first) : t("span", { first: two(row.chapters.first), last: two(row.chapters.last) })}</td>
                <td>{row.curators.length === 0 ? <span className="faint">{t("nobody")}</span> : row.curators.join(", ")}</td>
                <td className="n">{row.queue}</td>
                <td className="n">{row.medianWaitMs === null ? <span className="faint">{t("noDecision")}</span> : t("days", { d: formatFactor(row.medianWaitMs / 86_400_000, locale) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </InstrumentPanel>
    </section>
  );
}
