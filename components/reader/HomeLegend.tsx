import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { StatusBlock } from "@/components/ui/StatusBlock";
import { StatusMark } from "@/components/ui/StatusMark";

/**
 * The status vocabulary of the home grid, one row per mark (spec 02 § 6.4): the home's last instrument since
 * 2026-10-12, where Book status was, which moved to Book management without it (feature-specs/47 § 5, D2).
 */
export function HomeLegend() {
  const t = useTranslations("home.legend");
  return (
    <InstrumentPanel label={t("label")} className="home-legend">
      <div className="home-legend-rows">
        <div className="legend-row">
          <span className="legend-mark">
            <StatusMark tone="ok">V</StatusMark>
          </span>
          <span className="small muted">{t("verify")}</span>
        </div>
        <div className="legend-row">
          <span className="legend-mark">
            <StatusMark tone="ok">R</StatusMark>
          </span>
          <span className="small muted">{t("redteam")}</span>
        </div>
        <div className="legend-row">
          <span className="legend-mark">
            <StatusMark tone="warn">R</StatusMark>
          </span>
          <span className="small muted">{t("redteamOpen")}</span>
        </div>
        <div className="legend-row">
          <span className="legend-mark">
            <StatusBlock tone="warn" className="sb-sm">
              {t("staleMark")}
            </StatusBlock>
          </span>
          <span className="small muted">{t("stale")}</span>
        </div>
        <div className="legend-row">
          <span className="legend-mark">
            <StatusMark tone="ok">{t("reproducedMark")}</StatusMark>
          </span>
          <span className="small muted">{t("reproduced")}</span>
        </div>
        <div className="legend-row">
          <span className="legend-mark">
            <StatusMark tone="fail">{t("notReproducedMark")}</StatusMark>
          </span>
          <span className="small muted">{t("notReproduced")}</span>
        </div>
        <div className="legend-row">
          <span className="legend-mark">
            <StatusMark tone="mute" className="st-plain">
              {t("noLabMark")}
            </StatusMark>
          </span>
          <span className="small muted">{t("noLab")}</span>
        </div>
        <div className="legend-row">
          <span className="legend-mark">
            <span className="meta">{t("versionMark")}</span>
          </span>
          <span className="small muted">{t("version")}</span>
        </div>
      </div>
    </InstrumentPanel>
  );
}
