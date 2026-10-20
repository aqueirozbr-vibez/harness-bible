"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { decisionOf, NOTE_CHARS_MAX, OVERRIDE_CODES, type CuratorDecisionAction } from "@/lib/improve/curation";
import { CRITERIA, type ChangeClass, type Criterion, type Decision, type SuggestionOrigin } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface QueueDecisionProps {
  readonly suggestionId: string;
  /** Whose the suggestion is: a researcher's proposal takes accept or decline alone (42 § 7; unit 59e). */
  readonly origin: SuggestionOrigin;
  readonly changeClass: ChangeClass;
  /** What stands: the suggestion's outcome as it entered the queue. */
  readonly standing: Decision | null;
  /** The adjudicator decided what stands — not the intake rules, not the router — so the decision is calibration data on it (33 § 6.3). */
  readonly adjudicated: boolean;
  /** The deciding curator and their parts, as the panel's header names them. */
  readonly curator: string;
  readonly parts: string;
  /** The address that keeps this suggestion selected, so its decision shows once made. */
  readonly href: string;
}

type Status = { readonly kind: "idle" } | { readonly kind: "busy" } | { readonly kind: "recorded" } | { readonly kind: "recording" } | { readonly kind: "refused"; readonly message: string };

const ACTIONS: ReadonlyArray<CuratorDecisionAction> = ["ACCEPT", "KEEP_REQUEST_MORE", "DECLINE"];
/** The segments a suggestion of this origin takes: nobody would answer a request for more on a researcher's (42 § 7). */
const actionsOf = (origin: SuggestionOrigin): ReadonlyArray<CuratorDecisionAction> => (origin === "RESEARCHER" ? ACTIONS.filter((option) => option !== "KEEP_REQUEST_MORE") : ACTIONS);

/**
 * The curator's decision (feature-specs/36 § 5.3; unit 53c; the Curator-Queue screen's `Curator override` panel):
 * `Accept on inspection | Keep request more | Decline`; for an accept against what stands, the coded reason, which
 * names the criterion overridden; for a decline against an accept, the criterion disputed; the note with its counter;
 * the sentence on what the decision counts toward; the button, which says what it records; `Cancel`. Which controls
 * show follows § 5.2 (`decisionOf`): no code on a curator-always change. `POST /api/v1/curation/{id}/decision`, its
 * idempotency key kept across retries of one body, so that a retry after a lost answer is the first decision's replay;
 * once it answers, the page reads the suggestion again, kept selected, and its decision shows (`QueueDecided`). While
 * the decision is incomplete the button says why beside it, and a press says so in the live region (unit 53's review).
 */
export function QueueDecision({ suggestionId, origin, changeClass, standing, adjudicated, curator, parts, href }: QueueDecisionProps) {
  const t = useTranslations("improve.queue.decision");
  const te = useTranslations("api.errors");
  const tc = useTranslations("improve.outcome.reasons.name");
  const router = useRouter();
  const [action, setAction] = useState<CuratorDecisionAction | null>(null);
  const [code, setCode] = useState("");
  const [disputed, setDisputed] = useState<Criterion | "">("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  /* The key of the last body sent: the same body sent again is a retry, and keeps it. */
  const sent = useRef<{ readonly body: string; readonly key: string } | null>(null);

  const kindOf = action === null ? null : decisionOf({ action, origin, changeClass, standing, overrideCode: null, criterion: null, note: "-" }).kind;
  const coded = action === "ACCEPT" && kindOf === "override";
  const disputing = action === "DECLINE" && kindOf === "override";
  const criterion: Criterion | null = coded ? (code === "" ? null : (OVERRIDE_CODES[code] ?? null)) : disputing && disputed !== "" ? disputed : null;
  const decided = action === null ? null : decisionOf({ action, origin, changeClass, standing, overrideCode: coded && code !== "" ? code : null, criterion: disputing ? criterion : null, note: note.trim() === "" ? null : note });
  const over = note.length > NOTE_CHARS_MAX;
  const blocked = decided === null || decided.refusal !== null || over || status.kind === "busy";
  /* What the decision still needs, in the words its refusal would have. */
  const why = decided === null ? null : over ? t("noteOver", { max: NOTE_CHARS_MAX }) : decided.refusal !== null ? te(decided.refusal) : null;
  const sentence =
    decided === null
      ? null
      : changeClass === "CURATOR_ALWAYS" || standing === null || standing === "CURATOR_REVIEW"
        ? t("calibration.none")
        : !adjudicated
          ? t("calibration.rules")
          : decided.kind === "override"
            ? criterion === null
              ? t("calibration.overrideUnnamed")
              : t("calibration.override", { criterion: tc(criterion) })
            : t("calibration.counted");

  /* An edit makes a refusal said before it stale: the live region says nothing until the next press. */
  const edited = (): void => {
    if (status.kind === "refused") setStatus({ kind: "idle" });
  };

  const reset = (): void => {
    setAction(null);
    setCode("");
    setDisputed("");
    setNote("");
    setStatus({ kind: "idle" });
  };

  /* The suggestion stays selected (`?s=`), so the read that follows shows its decision; the refresh clears the router's copy of the page as it was (code-standards: an island that writes refreshes). */
  const show = (): void => {
    if (new URLSearchParams(window.location.search).get("s") !== suggestionId) router.replace(href, { scroll: false });
    router.refresh();
  };

  const submit = async (): Promise<void> => {
    if (status.kind === "busy" || action === null) return;
    if (blocked) {
      if (why !== null) setStatus({ kind: "refused", message: why });
      return;
    }
    setStatus({ kind: "busy" });
    const body = JSON.stringify({ action, ...(coded ? { overrideCode: code } : {}), ...(disputing && criterion !== null ? { criterion } : {}), ...(note.trim() === "" ? {} : { note }) });
    const key = sent.current?.body === body ? sent.current.key : crypto.randomUUID();
    sent.current = { body, key };
    try {
      const response = await fetch(`/api/v1/curation/${encodeURIComponent(suggestionId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      });
      if (response.status === 200 || response.status === 202) {
        setStatus({ kind: response.status === 200 ? "recorded" : "recording" });
        show();
        return;
      }
      const payload = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
      const errorCode = typeof payload?.code === "string" ? payload.code : "";
      const message =
        response.status === 409
          ? t("status.conflict")
          : response.status === 503
            ? t("status.unavailable")
            : errorCode.startsWith("OVERRIDE_")
              ? te(errorCode as "OVERRIDE_CODE_REQUIRED")
              : typeof payload?.message === "string"
                ? payload.message
                : t("status.failed");
      setStatus({ kind: "refused", message });
      /* Decided by another curator meanwhile (36 § 8): the detail reads again and says who and when. */
      if (response.status === 409) show();
    } catch {
      setStatus({ kind: "refused", message: t("status.failed") });
    }
  };

  return (
    <section className="inst queue-decision" aria-labelledby="queue-decision-title">
      <div className="inst-h">
        <h2 className="t" id="queue-decision-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{curator}</span>
        <span className="sep">·</span>
        <span>{parts}</span>
      </div>
      <div className="inst-b col queue-decision-body">
        <div className="between queue-decision-top">
          <div className="seg" role="group" aria-label={t("actionsLabel")}>
            {actionsOf(origin).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={action === option}
                onClick={() => {
                  setAction(option);
                  edited();
                }}
              >
                {t(`action.${option === "ACCEPT" && origin === "RESEARCHER" ? "ACCEPT_RESEARCH" : option}`)}
              </button>
            ))}
          </div>
          {criterion !== null ? <span className="meta">{t(coded ? "criterionOverridden" : "criterionDisputed", { criterion: tc(criterion) })}</span> : null}
        </div>
        {action !== null ? (
          <>
            <div className={cn("queue-decision-fields", (coded || disputing) && "has-select")}>
              {coded ? (
                <div className="field">
                  <label htmlFor="queue-decision-code">{t("code")}</label>
                  <select
                    id="queue-decision-code"
                    className="select mono queue-decision-select"
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                      edited();
                    }}
                  >
                    <option value="">{t("codeChoose")}</option>
                    {Object.keys(OVERRIDE_CODES).map((option) => (
                      <option key={option} value={option}>
                        {t(`codes.${option}` as "codes.OV-IND-01")}
                      </option>
                    ))}
                  </select>
                  <span className="help">{t("codesFrom")}</span>
                </div>
              ) : null}
              {disputing ? (
                <div className="field">
                  <label htmlFor="queue-decision-criterion">{t("criterion")}</label>
                  <select
                    id="queue-decision-criterion"
                    className="select mono queue-decision-select"
                    value={disputed}
                    onChange={(event) => {
                      setDisputed(event.target.value as Criterion | "");
                      edited();
                    }}
                  >
                    <option value="">{t("criterionChoose")}</option>
                    {CRITERIA.map((option) => (
                      <option key={option} value={option}>
                        {tc(option)}
                      </option>
                    ))}
                  </select>
                  <span className="help">{t("noCodes")}</span>
                </div>
              ) : null}
              <div className="field">
                <div className="between">
                  <label className="flabel" htmlFor="queue-decision-note">
                    {t("note")}
                    {decided?.refusal === "OVERRIDE_NOTE_REQUIRED" ? ` · ${t("noteRequired")}` : ""}
                  </label>
                  <span className={cn("counter", over && "is-over")} id="queue-decision-note-count" aria-live="polite">
                    {t("noteCount", { n: note.length, max: NOTE_CHARS_MAX })}
                  </span>
                </div>
                <textarea
                  id="queue-decision-note"
                  className="textarea queue-decision-note"
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    edited();
                  }}
                  aria-invalid={over || undefined}
                  aria-describedby="queue-decision-note-count"
                />
              </div>
            </div>
            {sentence !== null ? <p className="small muted">{sentence}</p> : null}
            {why !== null ? (
              <p className="small muted" id="queue-decision-why">
                {why}
              </p>
            ) : null}
            <div className="row queue-decision-actions">
              <button type="button" className="btn btn-p" aria-disabled={blocked || undefined} aria-busy={status.kind === "busy" || undefined} aria-describedby={why !== null ? "queue-decision-why" : undefined} onClick={() => void submit()}>
                {t(coded ? "submit.overrideACCEPT" : disputing ? "submit.overrideDECLINE" : `submit.${action}`)}
              </button>
              <button type="button" className="btn btn-q" onClick={reset}>
                {t("cancel")}
              </button>
            </div>
          </>
        ) : null}
      </div>
      {/* The live region is always there, so what it says next is announced; drawn only once it says something. */}
      <div className={cn("inst-f queue-decision-status", status.kind === "idle" && "sr-only")} role="status">
        {status.kind === "busy" || status.kind === "recording" ? <span className="st st-run">{t("status.recording")}</span> : status.kind === "recorded" ? <span className="st st-ok">{t("status.recorded")}</span> : status.kind === "refused" ? <span>{status.message}</span> : null}
      </div>
    </section>
  );
}
