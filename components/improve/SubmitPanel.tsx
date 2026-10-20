"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { SubmitProblem } from "@/components/improve/SubmitProblem";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { Notice } from "@/components/ui/Notice";
import { onDraftSave, type DraftField, type DraftSaveDetail } from "@/lib/hooks/draftSave";
import { dispatchSubmitRefused, onDraftWords, requestDraftFlush } from "@/lib/hooks/draftView";
import { formatDate, formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { SubmitFacts } from "@/lib/improve/scoreView";
import { RATIONALE_WORDS_MAX } from "@/lib/improve/words";

interface SubmitPanelProps {
  readonly id: string;
  readonly locale: Locale;
  readonly submit: SubmitFacts;
  /** The saved rationale's words, until its field says otherwise. */
  readonly words: number;
  /** A revision (31 § 6.5): the same submission, which tells the running workflow; its two buttons say so. */
  readonly revision: boolean;
}

interface Refusal {
  readonly message: string;
  readonly traceId: string | null;
}

/** Where the fields' saves stand: all landed, one still out, or one that did not land. */
type Saves = "landed" | "out" | "failed";

/**
 * The column's foot (feature-specs/34 § 6, § 7; unit 51e): the consent, once, while none is on file; `Submit for
 * grading`; `Save draft`; and the meta line with the last save's time and the day's submissions. Submit first asks
 * every field to save and waits for those saves, so what the server checks is what the page shows; then
 * `POST …/submit`, the key kept for one body. Success goes to the suggestion's page. A refusal of the intake or of
 * consent is shown beside the field it concerns (`SubmitProblem`); any other — the throttle, the engine down — here.
 * It waits, and says why, for a rationale of more than 200 words, for the consent, and through a pause the throttle
 * set.
 */
export function SubmitPanel({ id, locale, submit, words, revision }: SubmitPanelProps) {
  const t = useTranslations("improve.suggest.submit");
  const tc = useTranslations("improve.suggest.create");
  const tt = useTranslations("improve.suggest.throttled");
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  const [over, setOver] = useState(words > RATIONALE_WORDS_MAX);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /** Each field's last save state, as its autosave told it. */
  const fields = useRef<Partial<Record<DraftField, DraftSaveDetail["state"]>>>({});
  const attempt = useRef<{ readonly body: string; readonly key: string } | null>(null);
  const throttled = submit.throttledUntil !== null;
  const waitsFor = over ? "words" : submit.consentNeeded && !consent ? "consent" : null;
  const blocked = throttled || waitsFor !== null;

  useEffect(() => onDraftWords((detail) => setOver(detail.over)), []);
  useEffect(
    () =>
      onDraftSave((detail) => {
        if (detail.field !== undefined) fields.current[detail.field] = detail.state;
        if (detail.state === "saved") setSavedAt(detail.at);
      }),
    [],
  );

  const saves = (): Saves => {
    const states = Object.values(fields.current);
    if (states.some((state) => state === "failed" || state === "invalid")) return "failed";
    return states.some((state) => state === "dirty" || state === "saving") ? "out" : "landed";
  };
  /** Every field saves now; answers whether all of it landed. A field that never changed has nothing to save. */
  const saveAll = (): Promise<boolean> =>
    new Promise((resolve) => {
      let off = (): void => undefined;
      const settled = (): boolean => {
        const now = saves();
        if (now === "out") return false;
        off();
        resolve(now === "landed");
        return true;
      };
      off = onDraftSave(() => void settled());
      requestDraftFlush();
      settled();
    });

  const send = async (): Promise<void> => {
    const body = JSON.stringify({ consent: submit.consentNeeded && consent });
    const key = attempt.current !== null && attempt.current.body === body ? attempt.current.key : crypto.randomUUID();
    attempt.current = { body, key };
    try {
      const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}/submit`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body });
      const payload = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; traceId?: unknown; detail?: { detail?: unknown } } | null;
      if (response.ok) {
        router.push(`/${locale}/improve/${encodeURIComponent(id)}`);
        return;
      }
      const code = typeof payload?.code === "string" ? payload.code : "";
      const message = typeof payload?.message === "string" ? payload.message : tc("unknown");
      const traceId = typeof payload?.traceId === "string" ? payload.traceId : null;
      if (code.startsWith("INTAKE_") || code === "CONSENT_REQUIRED") dispatchSubmitRefused({ code, message, detail: typeof payload?.detail?.detail === "string" ? payload.detail.detail : null, traceId });
      else setRefusal({ message, traceId });
    } catch {
      setRefusal({ message: t("network"), traceId: null });
    }
    setBusy(false);
  };

  const click = async (): Promise<void> => {
    if (busy || blocked) return;
    setBusy(true);
    setRefusal(null);
    dispatchSubmitRefused(null);
    if (!(await saveAll())) {
      setRefusal({ message: t("unsaved"), traceId: null });
      setBusy(false);
      return;
    }
    await send();
  };

  return (
    <div className="col submit-panel">
      {throttled && submit.throttledUntil !== null ? <Notice title={tt("title", { date: formatDate(new Date(submit.throttledUntil), locale) })}>{t("throttled", { declines: submit.throttle.declines, days: submit.throttle.withinDays, date: formatDate(new Date(submit.throttledUntil), locale) })}</Notice> : null}
      {submit.consentNeeded ? (
        <label className="check submit-consent">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          {t("consent")}
        </label>
      ) : null}
      <SubmitProblem codes="CONSENT_REQUIRED" />
      <button type="button" className="btn btn-p btn-lg submit-button" aria-disabled={blocked || busy || undefined} aria-busy={busy} aria-describedby={waitsFor !== null ? "submit-why" : undefined} onClick={() => void click()}>
        {t(revision ? "revise" : "button")}
      </button>
      {waitsFor !== null && !throttled ? (
        <p className="help" id="submit-why">
          {waitsFor === "words" ? t("waitWords", { max: RATIONALE_WORDS_MAX }) : t("waitConsent")}
        </p>
      ) : null}
      <button type="button" className="btn submit-save" onClick={requestDraftFlush}>
        {t(revision ? "saveRevision" : "save")}
      </button>
      <div className="between submit-meta">
        <span className="meta faint">{savedAt === null ? "" : t("saved", { time: formatTime(new Date(savedAt)) })}</span>
        <span className="meta faint">{t("count", { n: submit.submitted, max: submit.perDay })}</span>
      </div>
      {refusal !== null ? (
        <ErrorBox title={t("failed")}>
          {refusal.message}
          {refusal.traceId !== null ? ` ${tc("trace", { traceId: refusal.traceId })}` : null}
        </ErrorBox>
      ) : null}
    </div>
  );
}
