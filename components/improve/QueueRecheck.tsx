"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { OutcomeRefresh } from "@/components/improve/OutcomeRefresh";

interface QueueRecheckProps {
  readonly suggestionId: string;
  /** The suggestion's refresh key as the page was drawn (`refreshKeyOf`): its merge's last check among it. */
  readonly drawn: string;
}

type Status = "idle" | "busy" | "asked" | "started" | "refused" | "failed";

/** How long the page reads the suggestion again after a recheck: the lab tier's ten minutes, which a check's run may take. */
const RECHECK_READ_MS = 600_000;

/**
 * `Re-run check` (feature-specs/37 § 4.3, § 4.5; unit 54b): `POST /api/v1/curation/{id}/recheck`, which has the merge
 * prepare and check again — after a curator's commit on the branch, or once what stopped it is set right — or starts
 * one where none runs. Its idempotency key is kept across retries of one press that went unanswered. Once asked, the
 * page reads the suggestion again until its merge's check has moved, and redraws.
 */
export function QueueRecheck({ suggestionId, drawn }: QueueRecheckProps) {
  const t = useTranslations("improve.queue.merge");
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  /* The key of a press that went unanswered: pressed again, it is that press's retry. */
  const pending = useRef<string | null>(null);

  const press = async (): Promise<void> => {
    if (status === "busy") return;
    setStatus("busy");
    const key = pending.current ?? crypto.randomUUID();
    pending.current = key;
    try {
      const response = await fetch(`/api/v1/curation/${encodeURIComponent(suggestionId)}/recheck`, { method: "POST", headers: { "idempotency-key": key } });
      pending.current = null;
      if (response.status === 202) {
        const answer = (await response.json().catch(() => null)) as { started?: unknown } | null;
        setStatus(answer?.started === true ? "started" : "asked");
        router.refresh();
        return;
      }
      setStatus(response.status === 409 ? "refused" : "failed");
    } catch {
      setStatus("failed");
    }
  };

  const said = status === "asked" ? t("asked") : status === "started" ? t("started") : status === "refused" ? t("refused") : status === "failed" ? t("failed") : "";
  return (
    <div className="row queue-merge-actions">
      <button type="button" className="btn btn-sm" aria-busy={status === "busy" || undefined} onClick={() => void press()}>
        {t("recheck")}
      </button>
      <span className="small muted" role="status">
        {said}
      </span>
      {status === "asked" || status === "started" ? <OutcomeRefresh id={suggestionId} drawn={drawn} forMs={RECHECK_READ_MS} /> : null}
    </div>
  );
}
