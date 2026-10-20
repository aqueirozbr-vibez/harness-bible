import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";

/* Nearest not-found boundary under [lang]: the thing is absent, not broken (ui-context § 9.8). */
export default function LangNotFound() {
  const t = useTranslations("notFound");
  const locale = useLocale();
  return (
    <main className="home-main">
      <Empty caption={t("cap")} action={<Button href={`/${locale}`}>{t("home")}</Button>}>
        <p className="h4">{t("title")}</p>
        <p className="small muted">{t("body")}</p>
      </Empty>
    </main>
  );
}
