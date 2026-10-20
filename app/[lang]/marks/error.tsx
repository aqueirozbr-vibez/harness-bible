"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/Button";
import { ErrorBox } from "@/components/ui/ErrorBox";

interface MarksErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

/* Says what failed, what was kept and what to do next (ui-context § 9.8). */
export default function MarksError({ error, reset }: MarksErrorProps) {
  const t = useTranslations("marks.error");
  return (
    <main className="marks-page">
      <ErrorBox title={t("pageTitle")} actions={<Button size="sm" onClick={reset}>{t("retry")}</Button>}>
        {t("body", { traceId: error.digest ?? "—" })}
      </ErrorBox>
    </main>
  );
}
