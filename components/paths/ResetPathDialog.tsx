"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface ResetPathDialogProps {
  readonly path: string;
  readonly locale: string;
  readonly name: string;
  readonly action: (formData: FormData) => Promise<void>;
}

/** Quiet Reset button and its confirm dialog (feature-specs/05 § 6.5), on the shared `ConfirmDialog`. */
export function ResetPathDialog({ path, locale, name, action }: ResetPathDialogProps) {
  const t = useTranslations("paths.reset");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label={t("label")}>
        {t("confirm")}
      </Button>
      <ConfirmDialog open={open} title={t("title", { name })} body={t("body")} cancelLabel={t("cancel")} confirmLabel={t("confirm")} onCancel={close} formAction={action} fields={{ path, locale }} />
    </>
  );
}
