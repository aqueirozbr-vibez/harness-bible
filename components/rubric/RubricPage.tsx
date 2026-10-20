import { useTranslations } from "next-intl";
import Link from "next/link";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { StatusBar } from "@/components/chrome/StatusBar";
import { RubricExamples } from "@/components/rubric/RubricExamples";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { formatDate, formatFactor, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { EvidenceTierSchema, type SourceTier } from "@/lib/schemas/domain";
import { chapterStartHref, parseChapterNumber, type SectionId } from "@/lib/schemas/ids";
import { CHANGE_CLASSES, type ChangeClass } from "@/lib/schemas/improve";
import { RELEVANCES, STAKES, type Rubric } from "@/lib/schemas/rubric";
import { cn } from "@/lib/utils";

/*
 * The Rubric page (feature-specs/30 § 6): the Rubric screen's layout and strings, every number read from the
 * published rubric and none typed here. What differs from the screen is deliberate and recorded in § 14 of the
 * spec: no "Suggest a change", no κ cell until one is measured, no adjudicator guide until one exists, no "next
 * review" date the file does not hold, the record links until the record page exists, and "opened from" only when
 * the page was opened from a chapter.
 */

/** The chapters the header points at: the grader's design and the recalibration, as the screen names them. */
const GRADER_DESIGN_CHAPTER = 27;
const RECALIBRATION_CHAPTER = 32;

/** The screen's order of the book's chips: the strongest tier first, then the two that are not evidence. */
const CHIP_ORDER: ReadonlyArray<SourceTier> = ["DERIVED", "PRIMARY", "VENDOR", "ANALYST", "PRACTITIONER", "ILLUSTRATIVE", "OPEN"];

export interface RubricPageProps {
  readonly rubric: Rubric;
  /** The published file's hash, as the status bar prints it. */
  readonly sha256: string;
  readonly release: { readonly id: string; readonly gitSha: string };
  /** How many chapters the release has: the rubric applies to all of them. */
  readonly chapters: number;
  readonly locale: Locale;
  /** The section the page was opened from, when it was. */
  readonly from: SectionId | null;
  /** The viewer opens Book management, where the curator roster is: the caption links to it for them alone (feature-specs/47 § 6). */
  readonly roster: boolean;
  readonly loadedMs: number;
}

export function RubricPage({ rubric, sha256, release, chapters, locale, from, roster, loadedMs }: RubricPageProps) {
  const t = useTranslations("rubric");
  const th = useTranslations("home.statusbar");
  const chapterRef = (n: number) => (
    <Link className="xref" href={chapterStartHref(locale, parseChapterNumber(n))}>
      {t("chapterRef", { n })}
    </Link>
  );
  return (
    <>
      <main className="rubric">
        <div className="col rubric-head">
          <div className="row rubric-head-caps">
            {from !== null ? (
              <>
                <Link href={`/${locale}/ch/${from.slice(0, 2)}/${from}`} className="cap">
                  {t("openedFrom", { chapter: from.slice(0, 2), section: from })}
                </Link>
                <span className="cap">·</span>
              </>
            ) : null}
            <span className="cap">
              {t("applies", { n: chapters })} · {t("graderDesign")} {chapterRef(GRADER_DESIGN_CHAPTER)} · {t("recalibration")} {chapterRef(RECALIBRATION_CHAPTER)}
              {roster ? (
                <>
                  {" · "}
                  <Link className="xref" href={`/${locale}/account/book#roster`}>
                    {t("roster")}
                  </Link>
                </>
              ) : null}
            </span>
          </div>
          <div className="between rubric-title-row">
            <h1 className="h1">{t("title")}</h1>
            <Button href={`/api/v1/rubric/${rubric.version}`} native size="sm">
              {t("download", { version: rubric.version })}
            </Button>
          </div>
          <p className="meta rubric-stamp">{t("stamp", { version: rubric.version, date: formatDate(new Date(`${rubric.publishedAt}T00:00:00Z`), locale) })}</p>
          <p className="muted rubric-blurb">{t("blurb")}</p>
        </div>

        <div className="rubric-top">
          <Tiers rubric={rubric} />
          <div className="col rubric-top-rail">
            <ScoringRule rubric={rubric} />
            <Chips rubric={rubric} />
          </div>
        </div>

        <div className="rubric-mid">
          <Adjustments rubric={rubric} locale={locale} />
          <Thresholds rubric={rubric} />
        </div>

        <RubricExamples rubric={rubric} locale={locale} />
        <Changelog rubric={rubric} locale={locale} />
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar.page", { version: rubric.version })}</span>
        <span className="desktop-only">{t("statusbar.release", { id: release.id })}</span>
        <span className="desktop-only tex">{t("statusbar.sha", { sha: sha256.slice(0, 8) })}</span>
      </StatusBar>
    </>
  );
}

function Tiers({ rubric }: { readonly rubric: Rubric }) {
  const t = useTranslations("rubric.tiers");
  return (
    <InstrumentPanel label={t("label")} meta={[{ key: "range", node: t("range") }]} timestamp={t("ts")} body="bare">
      <table className="tbl rubric-tiers">
        <thead>
          <tr>
            <th className="rubric-col-tier">{t("th.tier")}</th>
            <th className="rubric-col-name">{t("th.name")}</th>
            <th>{t("th.examples")}</th>
            <th className="n rubric-col-base">{t("th.base")}</th>
          </tr>
        </thead>
        <tbody>
          {EvidenceTierSchema.options.map((tier) => (
            <tr key={tier}>
              <td>
                <EvidenceBadge tier={tier} size="lg" label={t("badge", { tier, name: t(`name.${tier}`) })} />
              </td>
              <td className="h4 rubric-tier-name">{t(`name.${tier}`)}</td>
              <td className="small muted">{t(`example.${tier}`)}</td>
              <td className="n">
                <span className={cn("midnum rubric-base", tier === "G" && "rubric-base-fail", tier === "U" && "rubric-base-mute")}>{rubric.tiers[tier].base}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </InstrumentPanel>
  );
}

function ScoringRule({ rubric }: { readonly rubric: Rubric }) {
  const t = useTranslations("rubric.rule");
  const { bonus, minTier } = rubric.adjustments.corroboration;
  return (
    <section className="rt-s rb-s col rubric-rule" aria-label={t("cap")}>
      <span className="cap">{t("cap")}</span>
      <p className="rubric-rule-statement">{t("statement")}</p>
      <div className="code rubric-rule-formula">
        {t("formula")}
        <br />
        {" ".repeat(6)}
        {t("formulaBonus", { bonus, tier: minTier })}
      </div>
      <p className="small muted">{t("note", { bonus })}</p>
    </section>
  );
}

function Chips({ rubric }: { readonly rubric: Rubric }) {
  const t = useTranslations("rubric.chips");
  const ta = useTranslations("reader.tier.abbr");
  const tn = useTranslations("search.tier");
  const unmapped = EvidenceTierSchema.options.filter((tier) => !Object.values(rubric.chips).includes(tier));
  return (
    <InstrumentPanel label={t("label")} timestamp={t("ts")} body="bare">
      <table className="tbl rubric-chips">
        <thead>
          <tr>
            <th>{t("th.chip")}</th>
            <th>{t("th.evidence")}</th>
            <th>{t("th.note")}</th>
          </tr>
        </thead>
        <tbody>
          {CHIP_ORDER.map((chip) => {
            const tier = rubric.chips[chip];
            return (
              <tr key={chip}>
                <td>
                  <Chip tier={chip} abbr={ta(chip)}>
                    {tn(chip)}
                  </Chip>
                </td>
                <td>{tier === null ? <span className="faint mono">—</span> : <EvidenceBadge tier={tier} />}</td>
                <td className="small muted">{t(`note.${chip}`)}</td>
              </tr>
            );
          })}
          {unmapped.length > 0 ? (
            <tr>
              <td>
                <span className="nocover">{t("none")}</span>
              </td>
              <td>
                <span className="row rubric-badges">
                  {unmapped.map((tier) => (
                    <EvidenceBadge key={tier} tier={tier} />
                  ))}
                </span>
              </td>
              <td className="small muted">{t("noneNote")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </InstrumentPanel>
  );
}

function Adjustments({ rubric, locale }: { readonly rubric: Rubric; readonly locale: Locale }) {
  const t = useTranslations("rubric.adjustments");
  const { relevance, recency, independence, corroboration } = rubric.adjustments;
  const factors = (values: ReadonlyArray<number>): string => values.map((value) => formatFactor(value, locale)).join(" / ");
  const windows = recency.windows.map((window) => (window.withinDays === 365 ? t("recency.withinYear") : t("recency.withinDays", { n: window.withinDays }))).join(" / ");
  const rows: ReadonlyArray<{ readonly key: string; readonly name: string; readonly rule: string; readonly value: string }> = [
    { key: "relevance", name: t("relevance.name"), rule: t("relevance.rule"), value: factors(RELEVANCES.map((name) => relevance[name])) },
    { key: "recency", name: t("recency.name"), rule: t("recency.rule", { windows }), value: factors([...recency.windows.map((window) => window.factor), recency.older]) },
    { key: "independence", name: t("independence.name"), rule: t("independence.rule"), value: factors(STAKES.map((name) => independence[name])) },
    { key: "corroboration", name: t("corroboration.name"), rule: t("corroboration.rule", { tier: corroboration.minTier }), value: t("corroboration.value", { bonus: corroboration.bonus }) },
  ];
  return (
    <InstrumentPanel label={t("label")} meta={[{ key: "kind", node: t("kind") }]} timestamp={t("ts")} body="bare" footer={<span>{t("footer")}</span>}>
      <table className="tbl rubric-adjustments">
        <thead>
          <tr>
            <th>{t("th.factor")}</th>
            <th>{t("th.rule")}</th>
            <th className="n">{t("th.multiplier")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="h4 rubric-factor-name">{row.name}</td>
              <td className="small muted">{row.rule}</td>
              <td className="n">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </InstrumentPanel>
  );
}

function Thresholds({ rubric }: { readonly rubric: Rubric }) {
  const t = useTranslations("rubric.thresholds");
  return (
    <InstrumentPanel
      label={t("label")}
      timestamp={t("ts")}
      body="bare"
      footerClassName="rubric-legend"
      footer={
        <>
          <span className="row rubric-legend-item">
            <span className="rubric-swatch rubric-swatch-fail" />
            {t("legend.decline")}
          </span>
          <span className="row rubric-legend-item">
            <span className="rubric-swatch rubric-swatch-warn" />
            {t("legend.requestMore")}
          </span>
          <span className="row rubric-legend-item">
            <span className="rubric-swatch rubric-swatch-ver" />
            {t("legend.accept")}
          </span>
          <span className="faint">{t("legend.sensor")}</span>
        </>
      }
    >
      <table className="tbl rubric-thresholds">
        <thead>
          <tr>
            <th>{t("th.class")}</th>
            <th className="n rubric-col-accept">{t("th.accept")}</th>
            <th className="n rubric-col-floor">{t("th.floor")}</th>
            <th className="rubric-col-scale">{t("th.scale")}</th>
          </tr>
        </thead>
        <tbody>
          {CHANGE_CLASSES.map((changeClass) => (
            <ThresholdRow key={changeClass} changeClass={changeClass} rubric={rubric} />
          ))}
        </tbody>
      </table>
    </InstrumentPanel>
  );
}

function ThresholdRow({ changeClass, rubric }: { readonly changeClass: ChangeClass; readonly rubric: Rubric }) {
  const t = useTranslations("rubric.thresholds");
  const threshold = rubric.thresholds[changeClass];
  if (threshold === null) {
    return (
      <tr>
        <td className="small">{t(`class.${changeClass}`)}</td>
        <td className="n rubric-curator" colSpan={2}>
          {t("curatorAlways")}
        </td>
        <td className="rubric-cell-scale">
          <div className="rubric-band rubric-band-none" aria-hidden="true" />
          <span className="meta faint">{t("noScore")}</span>
        </td>
      </tr>
    );
  }
  const { acceptAt, floorAt, onlyTier } = threshold;
  return (
    <tr>
      <td className="small">
        {t(`class.${changeClass}`)}
        {changeClass === "DERIVED_FIGURE" ? <span className="faint"> {t("derivedNote")}</span> : null}
      </td>
      <td className="n">
        {acceptAt}
        {onlyTier !== null ? <span className="faint"> {t("onlyTier", { tier: onlyTier })}</span> : null}
      </td>
      <td className="n">{floorAt}</td>
      <td className="rubric-cell-scale">
        <div className="rubric-band" role="img" aria-label={t("bar", { floor: floorAt, accept: acceptAt })}>
          <i className="rubric-band-fail" style={{ left: 0, width: `${String(floorAt)}%` }} />
          <i className="rubric-band-warn" style={{ left: `${String(floorAt)}%`, width: `${String(acceptAt - floorAt)}%` }} />
          <i className="rubric-band-ver" style={{ left: `${String(acceptAt)}%`, width: `${String(100 - acceptAt)}%` }} />
          <span className="rubric-mark rubric-mark-floor" style={{ left: `${String(floorAt)}%` }} />
          <span className="rubric-mark rubric-mark-accept" style={{ left: `${String(acceptAt)}%` }} />
        </div>
      </td>
    </tr>
  );
}

function Changelog({ rubric, locale }: { readonly rubric: Rubric; readonly locale: Locale }) {
  const t = useTranslations("rubric.changelog");
  return (
    <InstrumentPanel label={t("label")} meta={[{ key: "kind", node: t("kind") }]} timestamp={t("ts")} body="bare">
      <div className="rubric-changelog">
        {rubric.changelog.map((entry, index) => {
          const current = entry.version === rubric.version;
          return (
            <div key={entry.version} className={cn("col rubric-changelog-cell", index < rubric.changelog.length - 1 && "rr", current && "rubric-changelog-current")}>
              <div className="between">
                <span className="mono rubric-changelog-version">
                  {entry.version}
                  {current ? <span className="faint"> {t("current")}</span> : null}
                </span>
                <span className="meta">{formatDate(new Date(`${entry.on}T00:00:00Z`), locale)}</span>
              </div>
              <p className={cn("small", !current && "muted")}>{t(`text.${entry.version.replace(".", "_")}`)}</p>
            </div>
          );
        })}
      </div>
    </InstrumentPanel>
  );
}
