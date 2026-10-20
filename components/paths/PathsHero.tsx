import { useTranslations } from "next-intl";

interface PathsHeroProps {
  readonly releaseId: string;
}

/** Caption, title and blurb of the paths page (feature-specs/05 § 6.1). */
export function PathsHero({ releaseId }: PathsHeroProps) {
  const t = useTranslations("paths");
  return (
    <div className="col gap-s2">
      <span className="cap">{t("cap", { id: releaseId })}</span>
      <h1 className="h1">{t("title")}</h1>
      <p className="muted paths-blurb">{t("blurb")}</p>
    </div>
  );
}
