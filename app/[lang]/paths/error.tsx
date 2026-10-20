"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/Button";
import { ErrorBox } from "@/components/ui/ErrorBox";

interface PathsErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

/* Says what failed, what was kept and what to do next (ui-context § 9.8). */
export default function PathsError({ error, reset }: PathsErrorProps) {
  const t = useTranslations("paths.error");
  return (
    <main className="paths">
      <ErrorBox title={t("pageTitle")} actions={<Button size="sm" onClick={reset}>{t("retry")}</Button>}>
        {t("body", { traceId: error.digest ?? "—" })}
      </ErrorBox>
    </main>
  );
}
