import { useTranslations } from "next-intl";

import type { SuggestionView } from "@/lib/schemas/suggestions";

interface OutcomeReasonsProps {
  readonly adjudication: SuggestionView["adjudication"];
}

/**
 * The page's Reasons (feature-specs/35 § 4): one line per rubric criterion, its verdict as the record has it (a value,
 * never a phrase) and its reason, from whoever decided. Before a decision there are none, and it says so.
 */
export function OutcomeReasons({ adjudication }: OutcomeReasonsProps) {
  const t = useTranslations("improve.outcome.reasons");
  const criteria = adjudication?.criteria ?? [];
  return (
    <section className="inst" aria-labelledby="outcome-reasons-title">
      <div className="inst-h">
        <h2 className="t" id="outcome-reasons-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{t("cap")}</span>
        {adjudication !== null ? <span className="ts">{t("by", { version: adjudication.rubricVersion })}</span> : null}
      </div>
      {criteria.length === 0 ? (
        <p className="inst-b small muted">{t("none")}</p>
      ) : (
        <table className="tbl outcome-reasons">
          <thead>
            <tr>
              <th scope="col">{t("criterion")}</th>
              <th scope="col">{t("verdict")}</th>
              <th scope="col">{t("reason")}</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((line) => (
              <tr key={line.criterion}>
                <td>{t(`name.${line.criterion}`)}</td>
                <td className="m">{line.verdict}</td>
                <td>{line.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
