"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { StatusMark } from "@/components/ui/StatusMark";
import { Xref } from "@/components/ui/Xref";
import { formatDateTime, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { AUDIT_RECORD_KINDS, AuditEstimateSchema, AuditExportSchema, AuditExportStartedSchema, type AuditExportView, type AuditRecordKind, type AuditScope } from "@/lib/schemas/audit";

/*
 * The audit export's form (feature-specs/38 § 3; the Account-Admin screen's `Audit export` instrument): the scope —
 * the reader's own account, or a chapter — the window, the four kinds of record, the estimate (a count, asked of the
 * server as the form changes), `Export audit pack`, and the last export's line with its head hash and `chain verified`.
 * A pack asked for is followed until it is ready: the row is read every two seconds, as the merge's page is.
 *
 * The estimate and the pack are the server's: `GET …/estimate`, `POST /api/v1/org/audit-exports` with an idempotency
 * key, `GET …/{id}`; nothing here counts. A refusal is said in words beside the button: the day's four spent, nothing in
 * range, or a request that did not reach the server, after which nothing was asked.
 */

/** The chapter that explains the audit chain. */
const AUDIT_CHAPTER = 29;
const ESTIMATE_DEBOUNCE_MS = 400;
const POLL_MS = 2_000;
/** A pack is read every two seconds for ten minutes — one of the whole chain is written in seconds — and every thirty after that, for a store the workflow waits out (38 § 5). */
const POLL_FOR_MS = 600_000;
const POLL_SLOW_MS = 30_000;
const HASH_SHOWN = 12;

export interface AuditChapterOption {
  /** Two digits, as the scope names a chapter. */
  readonly digits: string;
  readonly title: string;
}

interface AuditExportPanelProps {
  readonly locale: Locale;
  /** The reader's own id: the account scope the form offers. */
  readonly userId: string;
  readonly chapters: ReadonlyArray<AuditChapterOption>;
  /** The reader's latest pack as the server read it when the page was drawn; null before their first. */
  readonly latest: AuditExportView | null;
  /** The page's clock, ISO-8601: the default window ends today. */
  readonly today: string;
}

type Status = { readonly kind: "idle" } | { readonly kind: "sending" } | { readonly kind: "following"; readonly id: string } | { readonly kind: "refused"; readonly text: string } | { readonly kind: "network" };

/** `YYYY-MM-DD` of an instant, UTC, as a date input takes it. */
const dayOf = (iso: string): string => iso.slice(0, 10);

export function AuditExportPanel({ locale, userId, chapters, latest: latestAtDraw, today }: AuditExportPanelProps) {
  const t = useTranslations("account.audit");
  const ids = useId();
  const [scope, setScope] = useState<AuditScope["kind"]>("account");
  const [chapter, setChapter] = useState<string>(chapters[0]?.digits ?? "00");
  const [from, setFrom] = useState<string>(dayOf(new Date(new Date(today).getTime() - 30 * 86_400_000).toISOString()));
  const [to, setTo] = useState<string>(dayOf(today));
  const [kinds, setKinds] = useState<ReadonlySet<AuditRecordKind>>(new Set(AUDIT_RECORD_KINDS));
  /* the last count the server gave, with the request it was of: the estimate is "loading" until a count of the current request is here */
  const [counted, setCounted] = useState<{ readonly key: string; readonly value: number | "failed" } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [latest, setLatest] = useState<AuditExportView | null>(latestAtDraw);
  const router = useRouter();
  /* the press's body and its idempotency key, kept while no answer came, so a retry of the same body replays the first pack and never asks for a second */
  const sent = useRef<{ readonly body: string; readonly key: string } | null>(null);

  const request = useMemo(() => {
    const window = { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` };
    const chosen = AUDIT_RECORD_KINDS.filter((kind) => kinds.has(kind));
    const target: AuditScope = scope === "chapter" ? { kind: "chapter", id: chapter } : { kind: "account", id: userId };
    const wellFormed = chosen.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && new Date(window.from).getTime() < new Date(window.to).getTime();
    return { scope: target, ...window, kinds: chosen, wellFormed };
  }, [scope, chapter, from, to, kinds, userId]);

  /* the estimate, asked of the server as the form settles (38 § 3: a count query, never a guess) */
  const requestKey = JSON.stringify(request);
  useEffect(() => {
    if (!request.wellFormed) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let value: number | "failed" = "failed";
      try {
        const query = new URLSearchParams({ scope: request.scope.kind, id: request.scope.id, from: request.from, to: request.to, kinds: request.kinds.join(",") });
        const response = await fetch(`/api/v1/org/audit-exports/estimate?${query.toString()}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (response.ok) {
          const parsed = AuditEstimateSchema.safeParse(await response.json());
          if (parsed.success) value = parsed.data.records;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (!controller.signal.aborted) setCounted({ key: requestKey, value });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, requestKey]);
  const estimate: number | "loading" | "failed" | null = !request.wellFormed ? null : counted?.key === requestKey ? counted.value : "loading";

  /* a pack under way is followed until it is ready, the one drawn with the page included */
  const following = status.kind === "following" ? status.id : latest !== null && latest.state === "PREPARING" ? latest.id : null;
  useEffect(() => {
    if (following === null) return;
    const started = Date.now();
    let stopped = false;
    const controller = new AbortController();
    const read = async () => {
      try {
        const response = await fetch(`/api/v1/org/audit-exports/${following}`, { headers: { accept: "application/json" }, signal: controller.signal });
        if (stopped) return;
        if (response.ok) {
          const parsed = AuditExportSchema.safeParse(await response.json());
          if (stopped) return;
          if (parsed.success) {
            setLatest(parsed.data);
            if (parsed.data.state === "READY") {
              setStatus((current) => (current.kind === "following" ? { kind: "idle" } : current));
              /* the server's page holds the pack now: a Back to it is drawn with it */
              router.refresh();
              return;
            }
          }
        }
      } catch {
        /* a read that did not answer is read again; one cut short by the cleanup is not */
        if (stopped) return;
      }
      if (!stopped) timer = setTimeout(read, Date.now() - started < POLL_FOR_MS ? POLL_MS : POLL_SLOW_MS);
    };
    let timer = setTimeout(read, POLL_MS);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [following, router]);

  const send = useCallback(async () => {
    if (!request.wellFormed || typeof estimate !== "number" || estimate === 0 || status.kind === "sending" || status.kind === "following") return;
    const payload = JSON.stringify({ scope: request.scope, from: request.from, to: request.to, kinds: request.kinds });
    const key = sent.current !== null && sent.current.body === payload ? sent.current.key : crypto.randomUUID();
    sent.current = { body: payload, key };
    setStatus({ kind: "sending" });
    try {
      const response = await fetch("/api/v1/org/audit-exports", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": key },
        body: payload,
      });
      /* an answer came, whatever it says: the next press is a new request */
      sent.current = null;
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const parsed = AuditExportStartedSchema.safeParse(body);
        if (parsed.success) {
          setLatest({ id: parsed.data.id, state: parsed.data.state, scope: request.scope, from: request.from, to: request.to, kinds: request.kinds, records: estimate, headHash: null, requestedAt: new Date().toISOString(), readyAt: null, url: null, urlExpiresAt: null });
          setStatus({ kind: "following", id: parsed.data.id });
          router.refresh();
          return;
        }
      }
      const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
      const detail = typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "object" && body.detail !== null ? (body.detail as { resetsAt?: string }) : {};
      if (code === "RATE_LIMITED") setStatus({ kind: "refused", text: t("refused.limit", { time: detail.resetsAt === undefined ? "" : formatDateTime(new Date(detail.resetsAt), locale) }) });
      else if (code === "NOTHING_TO_EXPORT") setStatus({ kind: "refused", text: t("refused.nothing") });
      else setStatus({ kind: "refused", text: t("refused.failed", { code: code === "" ? String(response.status) : code }) });
    } catch {
      /* no answer: the key is kept, so the retry of this body replays rather than asks again */
      setStatus({ kind: "network" });
    }
  }, [request, estimate, status.kind, t, locale, router]);

  const disabled = !request.wellFormed || typeof estimate !== "number" || estimate === 0 || status.kind === "sending" || status.kind === "following";
  const estimateText = estimate === null ? t("estimate.incomplete") : estimate === "loading" ? t("estimate.counting") : estimate === "failed" ? t("estimate.failed") : t("estimate.records", { n: estimate, formatted: formatNumber(estimate, locale) });

  return (
    <section id="audit" className="col account-audit" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel
        label={t("label")}
        meta={[{ key: "chapter", node: <Xref href={`/${locale}/ch/${String(AUDIT_CHAPTER)}`}>{t("chapter", { n: AUDIT_CHAPTER })}</Xref> }]}
        timestamp={t("ts")}
        className="account-inst audit-inst"
        footer={<span>{t("footer")}</span>}
      >
        <div className="col gap-s3 audit-form">
          <div className="audit-scope-row">
            <div className="field">
              <span className="flabel" id={`${ids}-scope`}>
                {t("scope")}
              </span>
              <div className="seg audit-seg" role="group" aria-labelledby={`${ids}-scope`}>
                <button type="button" aria-pressed={scope === "account"} onClick={() => setScope("account")}>
                  {t("perAccount")}
                </button>
                <button type="button" aria-pressed={scope === "chapter"} onClick={() => setScope("chapter")}>
                  {t("perChapter")}
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor={`${ids}-chapter`}>{t("chapterField")}</label>
              <select id={`${ids}-chapter`} className="select" value={chapter} disabled={scope !== "chapter"} onChange={(event) => setChapter(event.target.value)}>
                {chapters.map((option) => (
                  <option key={option.digits} value={option.digits}>
                    {option.digits} · {option.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="audit-window-row">
            <div className="field">
              <label htmlFor={`${ids}-from`}>{t("from")}</label>
              <input id={`${ids}-from`} className="input mono" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${ids}-to`}>{t("to")}</label>
              <input id={`${ids}-to`} className="input mono" type="date" value={to} min={from} max={dayOf(today)} onChange={(event) => setTo(event.target.value)} />
            </div>
          </div>
          <fieldset className="audit-kinds">
            <legend className="flabel">{t("records")}</legend>
            {AUDIT_RECORD_KINDS.map((kind) => (
              <label key={kind} className="check">
                <input
                  type="checkbox"
                  checked={kinds.has(kind)}
                  onChange={(event) => {
                    const next = new Set(kinds);
                    if (event.target.checked) next.add(kind);
                    else next.delete(kind);
                    setKinds(next);
                  }}
                />
                {t(`kind.${kind}`)}
              </label>
            ))}
          </fieldset>
          <div className="between audit-ask">
            <span className="meta" aria-live="polite">
              {estimateText}
            </span>
            <button type="button" className="btn btn-p" disabled={disabled} onClick={send}>
              {status.kind === "sending" ? t("sending") : t("button")}
            </button>
          </div>
          <p className="small audit-status" role="status">
            {status.kind === "refused" ? <span className="text-fail">{status.text}</span> : status.kind === "network" ? <span className="text-fail">{t("refused.network")}</span> : status.kind === "following" || latest?.state === "PREPARING" ? t("preparing", { n: latest?.records ?? 0 }) : null}
          </p>
          <dl className="kv rt audit-last">
            <dt>{t("last.label")}</dt>
            <dd>{latest === null ? t("last.none") : t("last.value", { date: formatDateTime(new Date(latest.requestedAt), locale), n: latest.records })}</dd>
            {latest !== null && latest.state === "READY" && latest.headHash !== null ? (
              <>
                <dt>{t("last.head")}</dt>
                <dd>
                  <span className="mono">{latest.headHash.slice(0, HASH_SHOWN)}</span> · <StatusMark tone="ok">{t("last.verified")}</StatusMark>
                </dd>
                {latest.url !== null ? (
                  <>
                    <dt>{t("last.file")}</dt>
                    <dd>
                      <a className="xref" href={latest.url} download={`hb-audit-${latest.id}.jsonl`}>
                        {t("last.download")}
                      </a>
                      {latest.urlExpiresAt !== null ? <span className="faint"> · {t("last.until", { time: formatDateTime(new Date(latest.urlExpiresAt), locale) })}</span> : null}
                    </dd>
                  </>
                ) : null}
              </>
            ) : null}
          </dl>
        </div>
      </InstrumentPanel>
    </section>
  );
}
