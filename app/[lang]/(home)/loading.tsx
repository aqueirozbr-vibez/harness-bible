import { useTranslations } from "next-intl";

import { Loader } from "@/components/ui/Loader";

/* A status string with no percentage: no skeleton, no spinner (ui-context § 9.6). */
export default function HomeLoading() {
  const t = useTranslations("home");
  return (
    <main className="home-main">
      <Loader>{t("loading")}</Loader>
    </main>
  );
}
