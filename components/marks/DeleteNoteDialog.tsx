"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface DeleteNoteDialogProps {
  readonly sectionId: string;
  readonly locale: string;
  readonly action: (formData: FormData) => Promise<void>;
}

/** Quiet `Delete` and its confirm, submitting the list's form action (feature-specs/07 § 6.3). */
export function DeleteNoteDialog({ sectionId, locale, action }: DeleteNoteDialogProps) {
  const t = useTranslations("reader.marks.confirm");
  const tl = useTranslations("marks.notes");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label={t("title", { id: sectionId })}>
        {tl("delete")}
      </Button>
      <ConfirmDialog open={open} title={t("title", { id: sectionId })} body={t("body")} cancelLabel={t("cancel")} confirmLabel={t("confirm")} onCancel={close} formAction={action} fields={{ sectionId, locale }} />
    </>
  );
}
