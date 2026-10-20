"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { OutcomeRefresh } from "@/components/improve/OutcomeRefresh";

interface QueueMergeButtonProps {
  readonly suggestionId: string;
  /** The suggestion's refresh key as the page was drawn (`refreshKeyOf`): its merge's release and its state among it. */
  readonly drawn: string;
}

type Status = "idle" | "confirm" | "busy" | "merging" | "recording" | "refused" | "failed";

/** How long a first press waits for the second before it lapses. */
const CONFIRM_MS = 10_000;
/** How long the page reads the suggestion again after a merge: the ingestion of the whole book with its diagrams, and the record. */
const MERGE_READ_MS = 1_800_000;

/**
 * `Merge` (feature-specs/37 § 5; unit 54c): `POST /api/v1/curation/{id}/decision` with `MERGE`, on a suggestion whose
 * check passed. A merge publishes a release, so it takes a second press, which the button asks for in words; the first
 * lapses after ten seconds. Its idempotency key is kept across retries of one press that went unanswered. Once sent,
 * the page reads the suggestion again until its merge has moved — the release set aside, then merged — and redraws.
 */
export function QueueMergeButton({ suggestionId, drawn }: QueueMergeButtonProps) {
  const t = useTranslations("improve.queue.merge");
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  /* The key of a press that went unanswered: pressed again, it is that press's retry. */
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "confirm") return;
    const lapse = setTimeout(() => setStatus("idle"), CONFIRM_MS);
    return () => clearTimeout(lapse);
  }, [status]);

  const merge = async (): Promise<void> => {
    setStatus("busy");
    const key = pending.current ?? crypto.randomUUID();
    pending.current = key;
    try {
      const response = await fetch(`/api/v1/curation/${encodeURIComponent(suggestionId)}/decision`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ action: "MERGE" }) });
      pending.current = null;
      if (response.status === 200 || response.status === 202) {
        setStatus(response.status === 200 ? "merging" : "recording");
        router.refresh();
        return;
      }
      setStatus(response.status === 409 ? "refused" : "failed");
    } catch {
      setStatus("failed");
    }
  };

  const press = (): void => {
    if (status === "busy" || status === "merging" || status === "recording") return;
    if (status === "confirm") void merge();
    else setStatus("confirm");
  };

  const said = status === "confirm" ? t("confirm") : status === "merging" ? t("merging") : status === "recording" ? t("recording") : status === "refused" ? t("mergeRefused") : status === "failed" ? t("mergeFailed") : "";
  return (
    <div className="row queue-merge-actions">
      <button type="button" className="btn btn-sm btn-p" aria-busy={status === "busy" || undefined} aria-describedby={`queue-merge-said-${suggestionId}`} disabled={status === "merging" || status === "recording"} onClick={press}>
        {t("mergeButton")}
      </button>
      {status === "confirm" ? (
        <button type="button" className="btn btn-sm btn-q" onClick={() => setStatus("idle")}>
          {t("cancel")}
        </button>
      ) : null}
      <span className="small muted" role="status" id={`queue-merge-said-${suggestionId}`}>
        {said}
      </span>
      {status === "merging" || status === "recording" ? <OutcomeRefresh id={suggestionId} drawn={drawn} forMs={MERGE_READ_MS} /> : null}
    </div>
  );
}
