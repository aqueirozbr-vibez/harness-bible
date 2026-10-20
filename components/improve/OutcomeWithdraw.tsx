"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBox } from "@/components/ui/ErrorBox";

interface OutcomeWithdrawProps {
  readonly id: string;
}

/** The Decision's heading, which every redraw keeps: where focus goes once the dialog closes on an answer (review of unit 63). */
const DECISION_HEADING = "outcome-decision-title";

/**
 * `Withdraw` (feature-specs/45 § 5.2, § 5.4; unit 63g), for the owner of a person's suggestion where its workflow waits
 * for a person: the shared confirm, whose body says what stays, then the withdrawal posted with an Idempotency-Key kept
 * across retries of one press that went unanswered; Cancel and `esc` wait while it is out. Answered — 200, 202 or 409 —
 * the page redraws and its Decision says the answer, live: withdrawn, being recorded (never done), or where the
 * suggestion now stands. Focus goes to the Decision's heading, since the redraw may remove this control. A 409 that
 * leaves the suggestion where it waits, the control kept, says why here and no longer offers Withdraw (review of unit
 * 63). Anything else keeps the dialog open with what failed and the trace.
 */
export function OutcomeWithdraw({ id }: OutcomeWithdrawProps) {
  const t = useTranslations("improve.outcome.withdraw");
  const tc = useTranslations("improve.suggest.create");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  const [failure, setFailure] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);
  /* The key of a press that went unanswered: pressed again, it is that press's retry. */
  const pending = useRef<string | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setFailure(null);
  }, []);

  /* Set by an answer that closes the dialog: focus then goes to the Decision, after the dialog's own cleanup has given it
     back to the trigger, which the redraw may remove. */
  const toDecision = useRef(false);
  useEffect(() => {
    if (open || !toDecision.current) return;
    toDecision.current = false;
    document.getElementById(DECISION_HEADING)?.focus();
  }, [open]);

  const withdraw = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const key = pending.current ?? crypto.randomUUID();
    pending.current = key;
    try {
      const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}/withdraw`, { method: "POST", headers: { "idempotency-key": key } });
      pending.current = null;
      if (response.status === 200 || response.status === 202 || response.status === 409) {
        if (response.status === 409) setMoved(true);
        toDecision.current = true;
        setOpen(false);
        router.refresh();
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
      {moved ? null : (
        <Button onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
          {t("trigger")}
        </Button>
      )}
      {/* mounted and empty until it speaks, so that what it says is read out */}
      <span className="small muted" role="status">
        {moved ? t("moved") : null}
      </span>
      <ConfirmDialog open={open} title={t("title", { id })} body={t("body")} cancelLabel={t("cancel")} confirmLabel={t("confirm")} onCancel={close} onConfirm={() => void withdraw()} confirmDisabled={busy} cancelDisabled={busy}>
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
