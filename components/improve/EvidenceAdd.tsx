"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { EvidenceUpload } from "@/components/improve/EvidenceUpload";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { Field } from "@/components/ui/Field";
import type { Locale } from "@/lib/i18n/routing";
import type { EvidenceItemView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

type AddKind = "LINK" | "DOI" | "UPLOAD";

interface EvidenceAddProps {
  /** The draft's id, which the item is added to. */
  readonly id: string;
  readonly locale: Locale;
  /** The draft holds the most items a suggestion may (32 D4): nothing more is added. */
  readonly full: boolean;
  /** A link or a DOI offered again, or the upload's form opened again, for an item that could not be opened or graded (`Replace evidence`). */
  readonly offered: { readonly kind: AddKind; readonly value: string } | null;
  /** The item the add created, pending; null when the add was answered without one, as a replayed retry is. */
  readonly onAdded: (item: EvidenceItemView | null) => void;
}

interface Refusal {
  readonly message: string;
  readonly traceId: string | null;
}

/** An https link with a host the form can see a name in; the endpoint and the fetcher's guard judge the rest (32 § 4). */
function httpsLink(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * The screen's `add evidence` row (feature-specs/34 § 5; unit 51d): `+ Link` and `+ DOI` each open a field under the
 * row, and the item is added through `POST /api/v1/suggestions/{id}/evidence`, posted as the create posts, so that
 * the endpoint's limit, idempotency and policy apply; the key is kept for one body. A retry the handler replays is
 * answered without the item, and counts as added: the list reads the draft for it. `+ Upload` opens
 * `EvidenceUpload`'s form. `+ Saved lab run` shows disabled, with when it arrives. The form's own check speaks before
 * the browser's, and a field it holds back takes the focus with its reason; a form that closes gives the focus back
 * to the button that opened it. A refusal is the error form with the server's words and the trace.
 */
export function EvidenceAdd({ id, locale, full, offered, onAdded }: EvidenceAddProps) {
  const t = useTranslations("improve.suggest.evidence.add");
  const tc = useTranslations("improve.suggest.create");
  const ta = useTranslations("api.errors");
  const [open, setOpen] = useState<AddKind | null>(offered?.kind ?? null);
  const [value, setValue] = useState(offered?.value ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ readonly body: string; readonly key: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const doiButton = useRef<HTMLButtonElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  /** Which form is open now, for an upload that answers after its form was closed. */
  const openNow = useRef<AddKind | null>(open);

  /* An opened field takes the focus, so the keyboard is where the link goes; so does a field held back, with its reason. */
  useEffect(() => {
    if (open !== null) field.current?.focus();
  }, [open]);
  useEffect(() => {
    if (problem !== null) field.current?.focus();
  }, [problem]);
  useEffect(() => {
    openNow.current = open;
  }, [open]);

  /** The form of `kind` closed, if it is still the one open: the focus goes back to the button that opened it. */
  const closed = (kind: AddKind): void => {
    if (openNow.current !== kind) return;
    openNow.current = null;
    setOpen(null);
    setValue("");
    setProblem(null);
    setRefusal(null);
    (kind === "LINK" ? linkButton : kind === "DOI" ? doiButton : uploadButton).current?.focus();
  };

  const toggle = (kind: AddKind): void => {
    setOpen((was) => (was === kind ? null : kind));
    setValue("");
    setProblem(null);
    setRefusal(null);
  };

  const submit = async (): Promise<void> => {
    if (open === null || open === "UPLOAD" || pending) return;
    const text = value.trim();
    if (open === "LINK" && !httpsLink(text)) {
      setProblem(t("linkInvalid"));
      return;
    }
    if (open === "DOI" && text === "") {
      setProblem(ta("DOI_INVALID"));
      return;
    }
    const body = JSON.stringify(open === "LINK" ? { kind: "LINK", url: text } : { kind: "DOI", doi: text });
    const key = attempt.current !== null && attempt.current.body === body ? attempt.current.key : crypto.randomUUID();
    attempt.current = { body, key };
    setPending(true);
    setProblem(null);
    setRefusal(null);
    try {
      const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}/evidence`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body });
      const payload = (await response.json().catch(() => null)) as { item?: EvidenceItemView; message?: unknown; traceId?: unknown } | null;
      if (response.ok) {
        attempt.current = null;
        closed(open);
        onAdded(payload?.item ?? null);
      } else {
        setRefusal({ message: typeof payload?.message === "string" ? payload.message : tc("unknown"), traceId: typeof payload?.traceId === "string" ? payload.traceId : null });
      }
    } catch {
      /* The answer may be all that was lost: the same text keeps its key, so adding again adds nothing twice. */
      setRefusal({ message: t("network"), traceId: null });
    }
    setPending(false);
  };

  return (
    <div className="col evidence-add">
      <div className="row evidence-add-row">
        <span className="cap">{t("cap")}</span>
        <button ref={linkButton} type="button" className="btn btn-sm" aria-expanded={open === "LINK"} disabled={full} onClick={() => toggle("LINK")}>
          {t("link")}
        </button>
        <button ref={doiButton} type="button" className="btn btn-sm" aria-expanded={open === "DOI"} disabled={full} onClick={() => toggle("DOI")}>
          {t("doi")}
        </button>
        <button ref={uploadButton} type="button" className="btn btn-sm" aria-expanded={open === "UPLOAD"} disabled={full} onClick={() => toggle("UPLOAD")}>
          {t("upload")}
        </button>
        <button type="button" className="btn btn-sm" disabled aria-describedby="evidence-lab-note">
          {t("labRun")}
        </button>
        <span className="help" id="evidence-lab-note">
          {t("labRunNote")}
        </span>
      </div>
      {full ? <p className="help">{ta("EVIDENCE_LIMIT")}</p> : null}
      {open === "UPLOAD" && !full ? (
        <EvidenceUpload
          id={id}
          locale={locale}
          onAdded={(item) => {
            closed("UPLOAD");
            onAdded(item);
          }}
          onClose={() => closed("UPLOAD")}
        />
      ) : open !== null && !full ? (
        <form
          className="row evidence-add-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label={t(open === "LINK" ? "linkLabel" : "doiLabel")} htmlFor="evidence-add-value" error={problem ?? undefined} className="grow">
            <input
              ref={field}
              id="evidence-add-value"
              className={cn("input", problem !== null && "err")}
              type={open === "LINK" ? "url" : "text"}
              value={value}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problem !== null || undefined}
              aria-describedby={problem !== null ? "evidence-add-value-help" : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <button type="submit" className="btn btn-p btn-sm" aria-disabled={pending || undefined} aria-busy={pending}>
            {t("submit")}
          </button>
          <button type="button" className="btn btn-sm btn-q" onClick={() => closed(open)}>
            {t("cancel")}
          </button>
        </form>
      ) : null}
      {refusal !== null ? (
        <ErrorBox title={t("failed")}>
          {refusal.message}
          {refusal.traceId !== null ? ` ${tc("trace", { traceId: refusal.traceId })}` : null}
        </ErrorBox>
      ) : null}
      <p className="help">{t("help")}</p>
    </div>
  );
}
