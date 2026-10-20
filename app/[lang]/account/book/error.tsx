"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/Button";
import { ErrorBox } from "@/components/ui/ErrorBox";

interface BookManagementErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

/* Book management's own boundary (feature-specs/47 § 3), so that a failed read names this page and not the account's: what failed, the trace, and what to do next (ui-context § 9.8). */
export default function BookManagementErrorBoundary({ error, reset }: BookManagementErrorProps) {
  const t = useTranslations("account");
  return (
    <main className="account">
      <ErrorBox title={t("book.error")} actions={<Button size="sm" onClick={reset}>{t("error.retry")}</Button>}>
        {t("error.body", { traceId: error.digest ?? "—" })}
      </ErrorBox>
    </main>
  );
}
