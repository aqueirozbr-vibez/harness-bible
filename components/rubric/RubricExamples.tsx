import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { Rubric, RubricExample } from "@/lib/schemas/rubric";
import { cn } from "@/lib/utils";

/*
 * The four worked examples of the Rubric page (feature-specs/30 § 6; the Rubric screen): each an instrument with
 * the example's words from the catalogue and every number from the published rubric. The arithmetic box has two
 * forms, as the screen draws them: one item shows its three factors line by line; several items show one product
 * line each, the maximum, and the corroboration.
 *
 * The example's record is not linked: the record page is unit 52c, and the screen links only where the
 * suggestion exists in this database (§ 6).
 */

const STATUS_CLASS: Record<RubricExample["decision"], string> = { ACCEPT: "sb-ok", DECLINE: "sb-fail", REQUEST_MORE: "sb-warn", CURATOR_REVIEW: "sb-mute" };

/** The catalogue's key of an example: its position, as the screen numbers them. */
const exampleKey = (index: number): "ex1" | "ex2" | "ex3" | "ex4" => (["ex1", "ex2", "ex3", "ex4"] as const)[index] ?? "ex4";

interface RubricExamplesProps {
  readonly rubric: Rubric;
  readonly locale: Locale;
}

export function RubricExamples({ rubric, locale }: RubricExamplesProps) {
  const t = useTranslations("rubric.examples");
  return (
    <section className="col rubric-examples-section" aria-labelledby="rubric-examples">
      <div className="between rubric-examples-head">
        <div className="row rubric-examples-title">
          <span className="cap">{t("cap")}</span>
          <h2 className="h3" id="rubric-examples">
            {t("title")}
          </h2>
        </div>
        <span className="meta">{t("meta", { version: rubric.version })}</span>
      </div>
      <div className="rubric-examples">
        {rubric.examples.map((example, index) => (
          <Example key={example.id} example={example} index={index} rubric={rubric} locale={locale} />
        ))}
      </div>
    </section>
  );
}

interface ExampleProps {
  readonly example: RubricExample;
  readonly index: number;
  readonly rubric: Rubric;
  readonly locale: Locale;
}

function Example({ example, index, rubric, locale }: ExampleProps) {
  const t = useTranslations("rubric.examples");
  const key = exampleKey(index);
  const threshold = rubric.thresholds[example.changeClass];
  const numbers = { accept: threshold?.acceptAt ?? 0, floor: threshold?.floorAt ?? 0, tier: threshold?.onlyTier ?? "" };
  const strongest = example.items[example.strongestItem];
  return (
    <InstrumentPanel label={t("ex", { n: index + 1 })} meta={[{ key: "id", node: <span className="mono">{example.id}</span> }]} timestamp={example.section} className="rubric-example" footer={<span>{t(`${key}.footer`)}</span>} ariaLabel={`${t("ex", { n: index + 1 })} · ${example.id}`}>
      <p className="small">{t(`${key}.text`)}</p>
      <div className="mono rubric-math">
        {example.items.length === 1 && strongest !== undefined ? <OneItem item={strongest} exampleKey={key} floor={numbers.floor} locale={locale} /> : <ManyItems example={example} rubric={rubric} locale={locale} />}
        <div className={cn("between rt rubric-math-result", example.decision === "ACCEPT" ? "rubric-math-ok" : example.decision === "DECLINE" ? "rubric-math-fail" : "rubric-math-warn")}>
          <span>{t("result", { score: example.score })}</span>
          <span>{t(`${key}.threshold`, numbers)}</span>
        </div>
      </div>
      {key === "ex2" || key === "ex3" || key === "ex4" ? <p className="small muted">{t(`${key}.note`)}</p> : null}
      <div className="grow" />
      <div className="between">
        <span className={cn("st-block", STATUS_CLASS[example.decision])}>{t(`status.${example.decision}`)}</span>
        {key === "ex4" ? <span className="st st-ok">{t("ex4.override")}</span> : <span className="meta">{t(`${key}.outcomeMeta`, numbers)}</span>}
      </div>
    </InstrumentPanel>
  );
}

interface OneItemProps {
  readonly item: RubricExample["items"][number];
  readonly exampleKey: "ex1" | "ex2" | "ex3" | "ex4";
  readonly floor: number;
  readonly locale: Locale;
}

/** One item: its base with the tier's note, then each factor with its note; or, where the base is under the floor, that nothing could lift it. */
function OneItem({ item, exampleKey, floor, locale }: OneItemProps) {
  const t = useTranslations("rubric.examples");
  const relevanceNote = exampleKey === "ex3" ? t("ex3.relevanceNote") : t(`relevance.${item.relevance}`);
  const recencyNote = item.ageDays === null ? t("recency.stable") : t("recency.days", { n: item.ageDays });
  const lines: ReadonlyArray<{ readonly key: string; readonly value: string; readonly note: string; readonly warn: boolean }> = [
    { key: "relevance", value: `× ${formatFactor(item.factors.relevance, locale)}`, note: t("factor.relevance", { note: relevanceNote }), warn: item.factors.relevance < 1 },
    { key: "recency", value: `× ${formatFactor(item.factors.recency, locale)}`, note: t("factor.recency", { note: recencyNote }), warn: item.factors.recency < 1 },
    { key: "independence", value: `× ${formatFactor(item.factors.independence, locale)}`, note: t("factor.independence", { note: t(`stake.${item.stake}`) }), warn: item.factors.independence < 1 },
  ];
  return (
    <>
      <div className="between">
        <span>{item.base}</span>
        <span className="faint">{exampleKey === "ex4" ? item.tier : t(`${exampleKey}.tierNote`)}</span>
      </div>
      {item.base < floor ? (
        <div className="between faint">
          <span>× —</span>
          <span>{t("noLift")}</span>
        </div>
      ) : (
        lines.map((line) => (
          <div key={line.key} className={cn("between", line.warn && "rubric-math-warn")}>
            <span>{line.value}</span>
            <span className={cn(!line.warn && "faint")}>{line.note}</span>
          </div>
        ))
      )}
    </>
  );
}

interface ManyItemsProps {
  readonly example: RubricExample;
  readonly rubric: Rubric;
  readonly locale: Locale;
}

/** Several items: a product line each, the maximum, and the corroboration when there is one. */
function ManyItems({ example, rubric, locale }: ManyItemsProps) {
  const t = useTranslations("rubric.examples");
  const strongest = example.items[example.strongestItem];
  const corroborator = example.corroboratedBy === null ? undefined : example.items[example.corroboratedBy];
  return (
    <>
      {example.items.map((item, index) => (
        <div key={`${example.id}-${String(index)}`} className={cn("between", index !== example.strongestItem && "faint")}>
          <span>{t("product", { base: item.base, relevance: formatFactor(item.factors.relevance, locale), recency: formatFactor(item.factors.recency, locale), independence: formatFactor(item.factors.independence, locale) })}</span>
          <span>
            {item.adjusted} <span className="faint">{item.tier}</span>
          </span>
        </div>
      ))}
      <div className="between">
        <span>{t("max")}</span>
        <span>{strongest?.adjusted ?? 0}</span>
      </div>
      {corroborator !== undefined ? (
        <div className="between">
          <span>{t("bonus", { bonus: rubric.adjustments.corroboration.bonus })}</span>
          <span className="faint">{t("corroborates", { tier: corroborator.tier })}</span>
        </div>
      ) : null}
    </>
  );
}
