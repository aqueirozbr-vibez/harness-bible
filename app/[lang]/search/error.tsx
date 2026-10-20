"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/Button";
import { ErrorBox } from "@/components/ui/ErrorBox";

interface SearchErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

/* Says what failed, what was kept and what to do next (ui-context § 9.8). */
export default function SearchError({ error, reset }: SearchErrorProps) {
  const t = useTranslations("search.error");
  return (
    <main className="search-main">
      <ErrorBox title={t("title")} actions={<Button size="sm" onClick={reset}>{t("retry")}</Button>}>
        {t("body", { traceId: error.digest ?? "—" })}
      </ErrorBox>
    </main>
  );
}
