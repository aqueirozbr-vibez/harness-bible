"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { EvidenceAdd } from "@/components/improve/EvidenceAdd";
import { EvidenceItem } from "@/components/improve/EvidenceItem";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { onDraftSave } from "@/lib/hooks/draftSave";
import { dispatchDraftView } from "@/lib/hooks/draftView";
import type { Locale } from "@/lib/i18n/routing";
import { EVIDENCE_POLL_MS, newlyGraded, stillGrading, type SuggestEvidence } from "@/lib/improve/evidenceView";
import { SuggestionViewSchema, type EvidenceItemView } from "@/lib/schemas/suggestions";

interface EvidenceListProps {
  /** The draft's id, which the list reads and writes. */
  readonly id: string;
  readonly locale: Locale;
  readonly evidence: SuggestEvidence;
}

interface Refusal {
  readonly message: string;
  readonly traceId: string | null;
}

/** The API's error form, read from an answer's body: its message (or `fallback`) and its trace. */
function refusalOf(payload: unknown, fallback: string): Refusal {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as { message?: unknown; traceId?: unknown };
  return { message: typeof body.message === "string" ? body.message : fallback, traceId: typeof body.traceId === "string" ? body.traceId : null };
}

/**
 * Step 3 of the edit page, the evidence items (feature-specs/34 § 5; unit 51d): the list as the draft's `GET` gives it,
 * read again two seconds after the last read answered while any item is still grading (D2), and no longer once none
 * is. An item waiting at the budget cap is not read for: nothing in a draft ends that wait but its removal. A hidden
 * tab is not read, and is read once when it is seen again; a 429 waits as long as the server says. A read that the
 * session, the draft or the page's own age refuses stops the reads and says so. A read that started before a write
 * of the list's own is older than the list, and is dropped.
 *
 * Each item is `EvidenceItem`'s; the corroboration row follows the item that corroborates. An item is removed, or its
 * grading cancelled, through `DELETE …/evidence/{itemId}`, and the focus goes to the step's heading; one that could not
 * be opened or graded is replaced: removed, and its link or DOI offered again in the add row, or for an upload the
 * upload's form opened. A grade that lands is announced; a failure is an alert of its own. A save that changes whether
 * recency applies has the server score the graded items again, and the list reads them. After each write the router
 * is refreshed (code-standards: Back restores what the server holds).
 */
export function EvidenceList({ id, locale, evidence }: EvidenceListProps) {
  const t = useTranslations("improve.suggest.evidence");
  const tc = useTranslations("improve.suggest.create");
  const router = useRouter();
  const [items, setItems] = useState<ReadonlyArray<EvidenceItemView>>(evidence.items);
  const [corroboratedById, setCorroboratedById] = useState(evidence.corroboratedById);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [readRefusal, setReadRefusal] = useState<Refusal | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [offered, setOffered] = useState<{ readonly kind: "LINK" | "DOI" | "UPLOAD"; readonly value: string; readonly turn: number } | null>(null);
  /** The items as last drawn, for what a read finds changed. */
  const shown = useRef(items);
  /** Counts the list's own writes, so that a read which started before one is known to be older than it. */
  const writes = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const grading = items.some(stillGrading);

  useEffect(() => {
    shown.current = items;
  }, [items]);

  /**
   * The draft as `GET` reads it now. Answers when to read again: D2's pause, or the server's own wait on a 429; null
   * when no read will do better — a session or a draft gone, or an answer this page is too old to read — which it
   * says.
   */
  const reread = useCallback(async (): Promise<number | null> => {
    const at = writes.current;
    try {
      const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (response.status === 429) return Math.max(EVIDENCE_POLL_MS, Number(response.headers.get("retry-after") ?? "0") * 1000);
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        setReadRefusal(refusalOf(await response.json().catch(() => null), tc("unknown")));
        return null;
      }
      if (!response.ok) return EVIDENCE_POLL_MS;
      const view = SuggestionViewSchema.safeParse(await response.json());
      if (!view.success) {
        setReadRefusal({ message: t("read.stale"), traceId: null });
        return null;
      }
      /* The score column draws every read, the list only one no write of its own has passed. */
      dispatchDraftView(view.data);
      if (at !== writes.current) return EVIDENCE_POLL_MS;
      const graded = newlyGraded(shown.current, view.data.evidence);
      if (graded.length > 0) setAnnouncement(graded.map((item) => t("announce.graded", { n: item.ordinal, tier: item.tier ?? "U", score: item.adjustedScore ?? 0 })).join(" "));
      setItems(view.data.evidence);
      setCorroboratedById(view.data.scoring?.corroboratedById ?? null);
      return EVIDENCE_POLL_MS;
    } catch {
      return EVIDENCE_POLL_MS;
    }
  }, [id, t, tc]);

  /* D2: every two seconds while an item grades, one read after the last has answered; none once nothing does. */
  useEffect(() => {
    if (!grading || readRefusal !== null) return;
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      timer = null;
      if (stopped || reading) return;
      reading = true;
      const next = await reread();
      reading = false;
      if (!stopped && next !== null && document.visibilityState !== "hidden") timer = setTimeout(() => void tick(), next);
    };
    /* A hidden tab is not read; once it is seen again it is read at once, and then as before. */
    const seen = (): void => {
      if (document.visibilityState === "visible" && timer === null && !reading) void tick();
    };
    document.addEventListener("visibilitychange", seen);
    if (document.visibilityState !== "hidden") timer = setTimeout(() => void tick(), EVIDENCE_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [grading, readRefusal, reread]);

  /* A save that changed whether recency applies has had the graded items scored again on the server (34 § 24): read them. */
  useEffect(() => {
    let fastMoving = evidence.fastMoving;
    return onDraftSave((detail) => {
      if (detail.state !== "saved" || detail.draftClass.fastMoving === fastMoving) return;
      fastMoving = detail.draftClass.fastMoving;
      void reread();
    });
  }, [evidence.fastMoving, reread]);

  /** Removes the item, or cancels its grading; true once the server has. With `focus`, the step's heading takes the focus its button had. */
  const remove = async (item: EvidenceItemView, focus: boolean): Promise<boolean> => {
    setBusy(item.id);
    setRefusal(null);
    try {
      const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}/evidence/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (!response.ok) {
        setRefusal(refusalOf(await response.json().catch(() => null), tc("unknown")));
        return false;
      }
      writes.current += 1;
      setItems((was) => was.filter((other) => other.id !== item.id));
      if (focus) heading.current?.focus();
      await reread();
      router.refresh();
      return true;
    } catch {
      setRefusal({ message: t("removeNetwork"), traceId: null });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const replace = async (item: EvidenceItemView): Promise<void> => {
    if (!(await remove(item, false))) return;
    const kind = item.kind === "DOI" ? "DOI" : item.kind === "UPLOAD" ? "UPLOAD" : "LINK";
    setOffered((was) => ({ kind, value: (kind === "DOI" ? item.doi : kind === "LINK" ? item.url : null) ?? "", turn: (was?.turn ?? 0) + 1 }));
  };

  /**
   * The item an add created, or null when the add was answered without one (a retry the handler replays with no body):
   * the draft's read has it then. What was offered stays, so the add row is not drawn again and keeps its focus.
   */
  const added = (item: EvidenceItemView | null): void => {
    writes.current += 1;
    if (item !== null) setItems((was) => [...was.filter((other) => other.id !== item.id), item].sort((a, b) => a.ordinal - b.ordinal));
    else void reread();
    router.refresh();
  };

  const corroborating = items.find((item) => item.id === corroboratedById) ?? null;
  return (
    <section className="col rt-s edit-step evidence-step desktop-only" aria-labelledby="edit-step-3">
      <div className="between">
        <div className="row edit-step-title">
          <span className="meta">3</span>
          <h2 className="h4" id="edit-step-3" ref={heading} tabIndex={-1}>
            {t("title")}
          </h2>
        </div>
        <span className="cap">{t("cap")}</span>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {items.length === 0 ? (
        <div className="empty evidence-empty">
          <span className="cap">{t("empty.cap", { id })}</span>
          <span className="h4">{t("empty.title")}</span>
          <span className="small muted">{t("empty.body")}</span>
        </div>
      ) : (
        <ol className="col evidence-list">
          {items.map((item) => (
            <Fragment key={item.id}>
              <EvidenceItem item={item} locale={locale} rubric={evidence.rubric} busy={busy === item.id} onRemove={(gone) => void remove(gone, true)} onReplace={(gone) => void replace(gone)} />
              {corroborating !== null && corroborating.id === item.id ? (
                <li className="rl rr rb evidence-corroboration">
                  <span className="meta faint evidence-corroboration-mark" aria-hidden="true">
                    +
                  </span>
                  <span className="small grow">{t("corroboration", { item: String(item.ordinal).padStart(2, "0"), tier: evidence.rubric.corroboration.minTier })}</span>
                  <span className="mono evidence-math">{t("corroborationValue", { bonus: evidence.rubric.corroboration.bonus })}</span>
                </li>
              ) : null}
            </Fragment>
          ))}
        </ol>
      )}
      {refusal !== null ? (
        <ErrorBox title={t("removeFailed")}>
          {refusal.message}
          {refusal.traceId !== null ? ` ${tc("trace", { traceId: refusal.traceId })}` : null}
        </ErrorBox>
      ) : null}
      {readRefusal !== null ? (
        <ErrorBox title={t("read.failed")}>
          {readRefusal.message}
          {readRefusal.traceId !== null ? ` ${tc("trace", { traceId: readRefusal.traceId })}` : null}
        </ErrorBox>
      ) : null}
      <EvidenceAdd key={offered?.turn ?? 0} id={id} locale={locale} full={items.length >= evidence.max} offered={offered} onAdded={added} />
    </section>
  );
}
