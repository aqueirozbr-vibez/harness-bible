import { useTranslations } from "next-intl";
import Link from "next/link";

import type { Locale } from "@/lib/i18n/routing";
import type { HomeRelease, HomeStatus } from "@/lib/schemas/home";

interface HomeHeroProps {
  readonly release: HomeRelease;
  readonly status: HomeStatus;
  readonly locale: Locale;
}

/** Caption, title, blurb and the reading-paths link; every number comes from the status (spec § 6.1, 05 § 6.9). */
export function HomeHero({ release, status, locale }: HomeHeroProps) {
  const t = useTranslations("home");
  return (
    <div className="col gap-s2">
      <span className="cap">{t("cap", { id: release.id })}</span>
      <h1 className="h1">{t("title")}</h1>
      <p className="muted home-blurb">{t("blurb", { chapters: status.chapters, labs: status.labs })}</p>
      <Link href={`/${locale}/paths`} className="cap home-paths-link">
        {t("pathsLink")} →
      </Link>
    </div>
  );
}
