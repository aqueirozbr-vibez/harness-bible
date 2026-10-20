import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Loader } from "@/components/ui/Loader";
import { formatDateTime, formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { HomeRelease, HomeStatus } from "@/lib/schemas/home";

interface BookStatusProps {
  readonly release: HomeRelease;
  readonly status: HomeStatus;
  readonly locale: Locale;
}

const LOADER_WIDTH = 20;

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/**
 * The full-width "Book status" instrument: four cells and a loader footer (spec § 6.3). On Book management since
 * 2026-10-12, without the legend cell it had on the home: the legend stays on the home, under the grid it explains
 * (feature-specs/47 D2, D7).
 */
export function BookStatus({ release, status, locale }: BookStatusProps) {
  const t = useTranslations("home.status");
  const sha = release.gitSha.slice(0, 8);

  return (
    <InstrumentPanel
      label={t("label")}
      meta={[
        { key: "release", node: t("release", { id: release.id }) },
        { key: "sha", node: t("sha", { sha }) },
      ]}
      timestamp={release.nightlyCheckAt === null ? undefined : t("nightly", { when: formatDateTime(release.nightlyCheckAt, locale) })}
      body="bare"
      footerClassName="justify-between"
      footer={
        <>
          <span className="row gap-s5">
            <Loader prefix={t("loaderVerify")} progress={{ done: status.verifyPassed, total: status.chapters }} width={LOADER_WIDTH} glyphs="█░">
              {t("loaderValue", { pct: percent(status.verifyPassed, status.chapters), a: status.verifyPassed, b: status.chapters })}
            </Loader>
            <Loader prefix={t("loaderLab")} progress={{ done: status.labsReproduced, total: status.labs }} width={LOADER_WIDTH} glyphs="█░">
              {t("loaderValue", { pct: percent(status.labsReproduced, status.labs), a: status.labsReproduced, b: status.labs })}
            </Loader>
          </span>
          <span className="tex">
            #{sha.slice(0, 4)}·{sha.slice(4, 8)}
          </span>
        </>
      }
    >
      <div className="status-cells">
        <div className="status-cell status-cell-first">
          <span className="bignum">
            {status.verifyPassed}/{status.chapters}
          </span>
          <span className="cap">{t("verify")}</span>
        </div>
        <div className="status-cell">
          <span className="cellnum">
            {status.labsReproduced}/{status.labs}
          </span>
          <span className="cap">{t("labs")}</span>
          {status.labsDiverging.map((d) => (
            <span key={d.chapter} className="meta text-fail">
              {t("diverges", { n: d.chapter, when: formatDayMonth(d.since, locale) })}
            </span>
          ))}
        </div>
        <div className="status-cell">
          <span className="cellnum">{status.stale.length}</span>
          <span className="cap">{t("stale")}</span>
          {status.stale.length > 0 ? (
            <span className="meta text-warn">{status.stale.map((s) => t("staleItem", { n: s.chapter, days: s.days })).join(" · ")}</span>
          ) : null}
        </div>
        <div className="status-cell">
          <span className="cellnum">{release.id}</span>
          <span className="cap">{t("releasePinned")}</span>
          {status.redteamOpen.map((r) => (
            <span key={r.chapter} className="meta">
              {t("redteam", { count: r.count, n: r.chapter })}
            </span>
          ))}
        </div>
      </div>
    </InstrumentPanel>
  );
}
