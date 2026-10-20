"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { ErrorBox } from "@/components/ui/ErrorBox";
import { Field } from "@/components/ui/Field";
import { Loader } from "@/components/ui/Loader";
import { formatMegabytes } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { ticketUsable, UPLOAD_ACCEPT, uploadTypeOf } from "@/lib/improve/upload";
import { UploadTicketSchema, type UploadTicket } from "@/lib/schemas/storage";
import type { EvidenceItemView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface EvidenceUploadProps {
  /** The draft's id, which the file is added to. */
  readonly id: string;
  readonly locale: Locale;
  /** The item the add created, pending; null when the add was answered without one, as a replayed retry is. */
  readonly onAdded: (item: EvidenceItemView | null) => void;
  readonly onClose: () => void;
}

interface Refusal {
  readonly message: string;
  readonly traceId: string | null;
}

/** What one file's upload holds between tries: its ticket, whether the store has the file, and the add's key for its one body. */
interface Held {
  readonly file: File;
  readonly ticket: UploadTicket;
  readonly stored: boolean;
  readonly key: string;
}

type Step = 1 | 2 | 3;

/** The API's error form, read from an answer's body: its message (or `fallback`) and its trace. */
function refusalOf(payload: unknown, fallback: string): Refusal {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as { message?: unknown; traceId?: unknown };
  return { message: typeof body.message === "string" ? body.message : fallback, traceId: typeof body.traceId === "string" ? body.traceId : null };
}

/**
 * `+ Upload`'s form (feature-specs/34 § 5; 32 § 5, § 9; unit 51d): a file of the five types, sent in three steps. The
 * ticket (`POST …/evidence/uploads`) names the most the type may weigh, so a file over it is refused before a byte is
 * sent; the file is `PUT` to the ticket's URL; the item is added (`POST …/evidence` with its `uploadKey`, the key kept
 * for that one body). A try after a failure starts at the step that failed, with a new ticket once the old one is
 * near its end. The loader shows the step; `Cancel` stops the first two and closes the form, and the add, once sent,
 * is waited for, so that an item the server took is never missing from the list.
 */
export function EvidenceUpload({ id, locale, onAdded, onClose }: EvidenceUploadProps) {
  const t = useTranslations("improve.suggest.evidence.add");
  const te = useTranslations("improve.suggest.evidence");
  const tc = useTranslations("improve.suggest.create");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const holding = useRef<Held | null>(null);
  const abort = useRef<AbortController | null>(null);
  const field = useRef<HTMLInputElement>(null);

  /* The opened form's field takes the focus, as the link's does; so does a file held back, with its reason. */
  useEffect(() => {
    field.current?.focus();
  }, []);
  useEffect(() => {
    if (problem !== null) field.current?.focus();
  }, [problem]);
  /* A form closed any way at all — `Cancel`, the row's buttons, a replace elsewhere, the page left — stops the first two steps; an add once sent is waited for. */
  useEffect(() => () => abort.current?.abort(), []);

  const submit = async (): Promise<void> => {
    if (step !== null) return;
    const type = file === null ? null : uploadTypeOf(file);
    if (file === null || type === null) {
      setProblem(t("fileInvalid"));
      return;
    }
    setProblem(null);
    setRefusal(null);
    const controller = new AbortController();
    abort.current = controller;
    /* The step a failure of the network ends: before the add, nothing was added; at it, the answer alone may be what was lost. */
    let reached: Step = 1;
    try {
      let held = holding.current !== null && holding.current.file === file ? holding.current : null;
      if (held === null || (!held.stored && !ticketUsable(held.ticket.expiresAt, Date.now()))) {
        setStep(1);
        const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}/evidence/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contentType: type }), signal: controller.signal });
        const payload: unknown = await response.json().catch(() => null);
        const ticket = response.ok ? UploadTicketSchema.safeParse(payload) : null;
        if (ticket === null || !ticket.success) {
          setRefusal(refusalOf(payload, tc("unknown")));
          return;
        }
        held = { file, ticket: ticket.data, stored: false, key: crypto.randomUUID() };
        holding.current = held;
      }
      if (file.size > held.ticket.maxBytes) {
        setProblem(t("fileTooLarge", { max: formatMegabytes(held.ticket.maxBytes, locale) }));
        return;
      }
      if (!held.stored) {
        reached = 2;
        setStep(2);
        const response = await fetch(held.ticket.url, { method: held.ticket.method, headers: held.ticket.headers, body: file, signal: controller.signal });
        if (!response.ok) {
          /* A refused link is not tried again: the next try asks for a new one (32 § 15, `SIGNED_URL_INVALID`). */
          holding.current = null;
          setRefusal(refusalOf(await response.json().catch(() => null), tc("unknown")));
          return;
        }
        held = { ...held, stored: true };
        holding.current = held;
      }
      reached = 3;
      setStep(3);
      const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}/evidence`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": held.key }, body: JSON.stringify({ kind: "UPLOAD", uploadKey: held.ticket.uploadKey, fileName: held.file.name.slice(0, 255) }) });
      const payload = (await response.json().catch(() => null)) as { item?: EvidenceItemView } | null;
      /* A retry the handler replays is answered with no body: the item was added all the same. */
      if (response.ok) {
        holding.current = null;
        onAdded(payload?.item ?? null);
        return;
      }
      setRefusal(refusalOf(payload, tc("unknown")));
    } catch {
      if (!controller.signal.aborted) setRefusal({ message: reached === 3 ? t("network") : tc("network"), traceId: null });
    } finally {
      setStep(null);
      if (abort.current === controller) abort.current = null;
    }
  };

  const cancel = (): void => {
    if (step === 3) return;
    abort.current?.abort();
    onClose();
  };

  return (
    <>
      <form
        className="row evidence-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t("fileLabel")} htmlFor="evidence-add-value" error={problem ?? undefined} className="grow">
          {/* The browser's own picker words its button in the browser's language: the box shows the page's, and the
              file input, transparent over the whole box, stays the control that takes the focus, the keys and the click. */}
          <div className={cn("input evidence-file", problem !== null && "err", step !== null && "is-busy")}>
            <input
              ref={field}
              id="evidence-add-value"
              className="evidence-file-input"
              type="file"
              accept={UPLOAD_ACCEPT}
              disabled={step !== null}
              aria-invalid={problem !== null || undefined}
              aria-describedby={problem !== null ? "evidence-add-value-help" : undefined}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setProblem(null);
              }}
            />
            <span className="evidence-file-button" aria-hidden="true">
              {t("chooseFile")}
            </span>
            <span className={cn("evidence-file-name", file === null && "muted")} aria-hidden="true">
              {file?.name ?? t("noFile")}
            </span>
          </div>
        </Field>
        <button type="submit" className="btn btn-p btn-sm" aria-disabled={step !== null || undefined} aria-busy={step !== null}>
          {t("submit")}
        </button>
        <button type="button" className="btn btn-sm btn-q" aria-disabled={step === 3 || undefined} onClick={cancel}>
          {t("cancel")}
        </button>
        {step !== null ? (
          <span className="row evidence-upload-step">
            <Loader prefix={t("uploading")} progress={{ done: step, total: 3 }} className="evidence-loader">
              {te("stage", { n: step })}
            </Loader>
            <span className="cap">{t(`step.${step}`)}</span>
          </span>
        ) : null}
      </form>
      {refusal !== null ? (
        <ErrorBox title={t("failed")}>
          {refusal.message}
          {refusal.traceId !== null ? ` ${tc("trace", { traceId: refusal.traceId })}` : null}
        </ErrorBox>
      ) : null}
    </>
  );
}
