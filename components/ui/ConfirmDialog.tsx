"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  /** Runs on confirm when there is no form. */
  readonly onConfirm?: () => void;
  /** When set, the confirm button submits this server action with `fields` as hidden inputs (works without JavaScript once open). */
  readonly formAction?: (formData: FormData) => Promise<void>;
  readonly fields?: Readonly<Record<string, string>>;
  /** Extra controls inside the form, above the buttons: a typed confirmation (feature-specs/08 § 6.3). */
  readonly children?: ReactNode;
  readonly confirmDisabled?: boolean;
  /** While a confirmed request is out: Cancel is disabled and `esc` waits, so the request's answer never lands behind a closed dialog. */
  readonly cancelDisabled?: boolean;
}

/**
 * Confirm dialog for a destructive step: focus trapped and returned to the element
 * that had it, `esc` cancels, destructive confirm (feature-specs/07 § 6.3, from 05 § 6.5).
 */
export function ConfirmDialog({ open, title, body, cancelLabel, confirmLabel, onCancel, onConfirm, formAction, fields = {}, children, confirmDisabled = false, cancelDisabled = false }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  /* read by the key handler, so that a request going out does not run the focus effect again (review of unit 63) */
  const cancelDisabledRef = useRef(cancelDisabled);
  const requestOut = useRef(false);
  useEffect(() => {
    cancelDisabledRef.current = cancelDisabled;
    if (cancelDisabled) {
      requestOut.current = true;
      return;
    }
    if (!requestOut.current) return;
    requestOut.current = false;
    /* the request ended with the dialog still open, its pressed button disabled meanwhile and focus lost with it: back on
       the confirm, which the failure offers again (review of unit 62) */
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>(".btn-d:not(:disabled)")?.focus();
  }, [cancelDisabled]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.querySelector<HTMLElement>("input:not([type=hidden]), select, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!cancelDisabledRef.current) onCancel();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("input:not([type=hidden]), select, button:not(:disabled), a[href]")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      /* focus outside the dialog — a control disabled under it, a click behind it — is on its edge (review of unit 62) */
      const inside = dialog.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, [open, onCancel]);

  if (!open) return null;

  const buttons = (
    <div className="row gap-s2">
      <Button size="sm" onClick={onCancel} disabled={cancelDisabled}>
        {cancelLabel}
      </Button>
      {formAction === undefined ? (
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      ) : (
        <Button type="submit" variant="destructive" size="sm" disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      )}
    </div>
  );

  return (
    <div ref={dialogRef} className="peek dialog-box col" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="inst-h">
        <span className="t" id={titleId}>
          {title}
        </span>
      </div>
      <div className="inst-b col gap-s3">
        <p className="ui">{body}</p>
        {formAction === undefined ? (
          <>
            {children}
            {buttons}
          </>
        ) : (
          <form action={formAction} className="col gap-s3">
            {Object.entries(fields).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            {children}
            {buttons}
          </form>
        )}
      </div>
    </div>
  );
}
