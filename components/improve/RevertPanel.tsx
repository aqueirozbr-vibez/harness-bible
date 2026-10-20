"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

interface RevertPanelProps {
  readonly locale: string;
  readonly suggestionId: string;
  /** The curator reading, for the header. */
  readonly curator: string;
  /** Whether the panel also offers "Stands": the monthly sample's verdict (36 § 7.2), where the item was sampled. */
  readonly sampled: boolean;
  /** Where the page is read again after a verdict: the queue keeps its `?s=`. */
  readonly href: string;
}

type Status = { readonly kind: "idle" } | { readonly kind: "confirm" } | { readonly kind: "busy" } | { readonly kind: "stands" } | { readonly kind: "started"; readonly revertId: string } | { readonly kind: "refused"; readonly message: string };

const NOTE_CHARS_MAX = 400;

/**
 * A curator's revert (feature-specs/37 § 8; unit 54e) — and, on a sampled item, the month's verdict (36 § 7.2): that
 * the change stands, or that it is reverted. `POST /api/v1/curation/{id}/decision` with `REVERT` and a note, or with
 * `ACCEPT` for a change that stands. A revert publishes a release, so `Revert` asks for a second press, as `Merge`
 * does. Its idempotency key is kept for a retry of one press that went unanswered. Once started, the panel names the
 * revert and links to its record; the page reads again.
 */
export function RevertPanel({ locale, suggestionId, curator, sampled, href }: RevertPanelProps) {
  const t = useTranslations("improve.revert");
  const router = useRouter();
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const sent = useRef<{ readonly body: string; readonly key: string } | null>(null);
  const over = note.length > NOTE_CHARS_MAX;
  const missing = note.trim() === "";

  const show = (): void => {
    if (href !== "" && window.location.pathname + window.location.search !== href) router.replace(href, { scroll: false });
    router.refresh();
  };

  const post = async (body: string): Promise<Response> => {
    const key = sent.current?.body === body ? sent.current.key : crypto.randomUUID();
    sent.current = { body, key };
    return fetch(`/api/v1/curation/${encodeURIComponent(suggestionId)}/decision`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body });
  };

  const refusedBy = async (response: Response): Promise<string> => {
    const payload = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
    if (response.status === 409) return t("status.conflict");
    if (response.status === 503) return t("status.unavailable");
    if (payload?.code === "REVERT_NOTE_REQUIRED") return t("noteRequired");
    return typeof payload?.message === "string" ? payload.message : t("status.failed");
  };

  const revert = async (): Promise<void> => {
    if (status.kind === "busy") return;
    if (missing || over) {
      setStatus({ kind: "refused", message: missing ? t("noteRequired") : t("noteOver", { max: NOTE_CHARS_MAX }) });
      return;
    }
    if (status.kind !== "confirm") {
      setStatus({ kind: "confirm" });
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const response = await post(JSON.stringify({ action: "REVERT", note }));
      if (response.status === 202) {
        const answer = (await response.json().catch(() => null)) as { revertId?: unknown } | null;
        setStatus({ kind: "started", revertId: typeof answer?.revertId === "string" ? answer.revertId : "" });
        show();
        return;
      }
      setStatus({ kind: "refused", message: await refusedBy(response) });
    } catch {
      setStatus({ kind: "refused", message: t("status.failed") });
    }
  };

  const stands = async (): Promise<void> => {
    if (status.kind === "busy") return;
    setStatus({ kind: "busy" });
    try {
      const response = await post(JSON.stringify({ action: "ACCEPT", ...(note.trim() === "" ? {} : { note }) }));
      if (response.status === 200) {
        setStatus({ kind: "stands" });
        show();
        return;
      }
      setStatus({ kind: "refused", message: await refusedBy(response) });
    } catch {
      setStatus({ kind: "refused", message: t("status.failed") });
    }
  };

  const said =
    status.kind === "confirm"
      ? t("confirm")
      : status.kind === "stands"
        ? t("status.stands")
        : status.kind === "started"
          ? null
          : status.kind === "refused"
            ? status.message
            : "";
  return (
    <section className="inst queue-decision revert-panel" aria-labelledby="revert-panel-title">
      <div className="inst-h">
        <h2 className="t" id="revert-panel-title">
          {sampled ? t("sampleTitle") : t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{curator}</span>
      </div>
      <div className="inst-b col queue-decision-body">
        <p className="small">{sampled ? t("sampleLede") : t("lede")}</p>
        <div className="col revert-note">
          <span className="between">
            <label className="flabel" htmlFor="revert-panel-note">
              {t("note")}
            </label>
            <span id="revert-panel-note-count" className={over ? "counter is-over" : "counter"} aria-live="polite">
              {t("counter", { n: note.length, max: NOTE_CHARS_MAX })}
            </span>
          </span>
          <textarea
            id="revert-panel-note"
            className="queue-decision-note"
            aria-describedby="revert-panel-note-count"
            aria-invalid={over || undefined}
            value={note}
            maxLength={NOTE_CHARS_MAX + 100}
            onChange={(event) => {
              setNote(event.target.value);
              if (status.kind === "refused" || status.kind === "confirm") setStatus({ kind: "idle" });
            }}
            disabled={status.kind === "started" || status.kind === "stands"}
          />
        </div>
        <div className="row queue-decision-actions">
          {sampled ? (
            <button type="button" className="btn btn-sm" aria-busy={status.kind === "busy" || undefined} disabled={status.kind === "started" || status.kind === "stands"} onClick={() => void stands()}>
              {t("stands")}
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-p" aria-busy={status.kind === "busy" || undefined} aria-describedby="revert-panel-said" disabled={status.kind === "started" || status.kind === "stands"} onClick={() => void revert()}>
            {t("revert")}
          </button>
          {status.kind === "confirm" ? (
            <button type="button" className="btn btn-sm btn-q" onClick={() => setStatus({ kind: "idle" })}>
              {t("cancel")}
            </button>
          ) : null}
        </div>
      </div>
      <div className="inst-f queue-decision-status" role="status" id="revert-panel-said">
        {status.kind === "started" ? (
          <span>
            {t("status.started")}{" "}
            {status.revertId === "" ? null : (
              <Link className="xref" href={`/${locale}/improve/${status.revertId}/record`}>
                {status.revertId}
              </Link>
            )}
          </span>
        ) : (
          <span>{said}</span>
        )}
      </div>
    </section>
  );
}
