import { useTranslations } from "next-intl";

import { StatusBar } from "@/components/chrome/StatusBar";
import { ContinueReading } from "@/components/reader/ContinueReading";
import { HomeHero } from "@/components/reader/HomeHero";
import { HomeLegend } from "@/components/reader/HomeLegend";
import { PartGrid } from "@/components/reader/PartGrid";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { HomeData } from "@/lib/schemas/home";
import { cn } from "@/lib/utils";

interface BookHomeProps {
  readonly data: HomeData;
  readonly locale: Locale;
  /** Continue reading renders only for a signed-in reader (spec § 7). */
  readonly signedIn: boolean;
  /** Server render time of this request, for the status bar. */
  readonly loadedMs: number;
}

/**
 * Book Home: hero, parts grid, the grid's legend at the foot of the page, status bar (feature-specs/02-book-home.md
 * § 5). Book status was the last instrument until 2026-10-12; it is on Book management, for curators and
 * organisation admins, and its legend stayed here (feature-specs/47 § 5).
 */
export function BookHome({ data, locale, signedIn, loadedMs }: BookHomeProps) {
  const t = useTranslations("home.statusbar");
  const showContinue = signedIn;
  return (
    <>
      <main className={cn("home-main")}>
        <div className={cn("home-hero", !showContinue && "home-hero-solo")}>
          <HomeHero release={data.release} status={data.status} locale={locale} />
          {showContinue ? <ContinueReading data={data.continueReading} locale={locale} /> : null}
        </div>
        {data.parts.map((part) => (
          <PartGrid key={part.key} part={part} labsTotal={data.status.labs} locale={locale} />
        ))}
        <HomeLegend />
      </main>
      <StatusBar trailing={t("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("home", { n: data.status.chapters })}</span>
        <span>{t("lang", { lang: locale.toUpperCase(), src: data.sourceLang })}</span>
        <span>{t("release", { id: data.release.id })}</span>
        <span>
          {t("counts", {
            a: data.status.verifyPassed,
            b: data.status.chapters,
            c: data.status.labsReproduced,
            d: data.status.labs,
          })}
        </span>
      </StatusBar>
    </>
  );
}
