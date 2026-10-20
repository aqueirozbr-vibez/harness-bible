import { useTranslations } from "next-intl";

import { Loader } from "@/components/ui/Loader";

/* A status string with no percentage: no skeleton, no spinner (ui-context § 9.6). */
export default function PathsLoading() {
  const t = useTranslations("paths");
  return (
    <main className="paths">
      <Loader>{t("loading")}</Loader>
    </main>
  );
}
