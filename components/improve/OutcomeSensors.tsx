import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import type { SuggestionView } from "@/lib/schemas/suggestions";

interface OutcomeSensorsProps {
  readonly sensors: SuggestionView["sensors"];
}

const TONE = { PASS: "ok", FAIL: "fail", WARN: "warn", NA: "mute" } as const;

/** The page's Sensors (feature-specs/35 § 4): each deterministic sensor's verdict and its note, a failing one marked. */
export function OutcomeSensors({ sensors }: OutcomeSensorsProps) {
  const t = useTranslations("improve.outcome.sensors");
  return (
    <section className="inst" aria-labelledby="outcome-sensors-title">
      <div className="inst-h">
        <h2 className="t" id="outcome-sensors-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{t("cap")}</span>
      </div>
      {sensors.length === 0 ? (
        <p className="inst-b small muted">{t("none")}</p>
      ) : (
        <table className="tbl outcome-sensors">
          <thead>
            <tr>
              <th scope="col">{t("sensor")}</th>
              <th scope="col">{t("verdict")}</th>
              <th scope="col">{t("note")}</th>
            </tr>
          </thead>
          <tbody>
            {sensors.map((verdict) => (
              <tr key={verdict.sensor} className={verdict.result === "FAIL" ? "outcome-sensor-failed" : undefined}>
                <td>{t(`name.${verdict.sensor}`)}</td>
                <td>
                  <StatusMark tone={TONE[verdict.result]}>{t(`result.${verdict.result}`)}</StatusMark>
                </td>
                <td className="small">{verdict.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
