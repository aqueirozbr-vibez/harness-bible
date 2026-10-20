import { useTranslations } from "next-intl";

interface OutcomeSawProps {
  /** The adjudicator's guide and the rubric it read, as the decision recorded them. */
  readonly guide: string;
  readonly rubric: string;
}

/**
 * What the adjudicator saw (the Improve-Adjudication screen's right column): the suggestion, the graded evidence, the
 * sensors' verdicts and the anchored text, and of the person only whether their identity is verified (invariant 12).
 * Shown where the adjudicator decided; a rule or the router read nothing of the kind.
 */
export function OutcomeSaw({ guide, rubric }: OutcomeSawProps) {
  const t = useTranslations("improve.outcome.saw");
  return (
    <section className="col rt outcome-aside-note" aria-labelledby="outcome-saw-title">
      <h2 className="cap" id="outcome-saw-title">
        {t("cap")}
      </h2>
      <p className="help">{t("body")}</p>
      <span className="tex">{t("versions", { guide, rubric })}</span>
    </section>
  );
}
