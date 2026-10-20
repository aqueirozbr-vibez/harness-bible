"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";

interface DeleteAccountDialogProps {
  readonly locale: string;
  readonly action: (formData: FormData) => Promise<void>;
}

/** `Request deletion` with a typed confirmation: the confirm enables when the word matches (feature-specs/08 § 6.3). */
export function DeleteAccountDialog({ locale, action }: DeleteAccountDialogProps) {
  const t = useTranslations("account.delete");
  const tr = useTranslations("account.retention");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const close = useCallback(() => {
    setOpen(false);
    setTyped("");
  }, []);
  const word = t("word");
  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        {tr("request")}
      </Button>
      <ConfirmDialog open={open} title={t("title")} body={t("body")} cancelLabel={t("cancel")} confirmLabel={t("confirm")} onCancel={close} formAction={action} fields={{ locale }} confirmDisabled={typed !== word}>
        <Field label={t("field")} htmlFor="delete-confirm" help={typed.length > 0 && typed !== word ? t("mismatch") : undefined}>
          <input id="delete-confirm" name="confirm" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
