"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { requestDraftStop } from "@/lib/hooks/draftView";
import type { Locale } from "@/lib/i18n/routing";

interface DeleteDraftProps {
  readonly id: string;
  readonly locale: Locale;
}

/**
 * `Delete draft` (feature-specs/45 § 4; unit 63g), on the edit page's rail and never on a revision: a quiet button and
 * the shared confirm, whose body says what goes. Deleted — or already gone, a 404 — every field's autosave stops, and the
 * page is replaced by the Improve page's `Done` notice: replaced, so Back never returns to a draft that is gone. Anything
 * else keeps the dialog open with what failed and the trace. Cancel and `esc` wait while the request is out.
 */
export function DeleteDraft({ id, locale }: DeleteDraftProps) {
  const t = useTranslations("improve.suggest.deleteDraft");
  const tc = useTranslations("improve.suggest.create");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setFailure(null);
  }, []);

  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (response.ok || response.status === 404) {
        requestDraftStop();
        router.replace(`/${locale}/improve?deleted=${encodeURIComponent(id)}`);
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: unknown; traceId?: unknown } | null;
      setFailure({ message: typeof body?.message === "string" ? body.message : "", traceId: typeof body?.traceId === "string" ? body.traceId : null });
    } catch {
      setFailure({ message: t("network"), traceId: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        {t("trigger")}
      </Button>
      <ConfirmDialog open={open} title={t("title", { id })} body={t("body")} cancelLabel={t("cancel")} confirmLabel={t("confirm")} onCancel={close} onConfirm={() => void remove()} confirmDisabled={busy} cancelDisabled={busy}>
        {failure !== null ? (
          <ErrorBox title={t("failed")}>
            {failure.message}
            {failure.traceId !== null ? ` ${tc("trace", { traceId: failure.traceId })}` : null}
          </ErrorBox>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
