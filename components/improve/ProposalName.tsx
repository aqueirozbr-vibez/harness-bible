"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface ProposalNameProps {
  readonly suggestionId: string;
  /** The proposal waits for a curator or is being merged: the name can be taken back (42 § 6, D4). */
  readonly removable: boolean;
}

type Failure = "failedRemove" | "rate";

/**
 * The name column of the Improve list's proposals (feature-specs/45 § 3.6; unit 62i): "with your name", and beside it
 * `Remove my name` while the proposal takes names, through the panel's own endpoint and on its rule — until the
 * curator's merge is taken. The panel under the answer goes with a deleted conversation, so the list is where a reader
 * keeps that right. Removed — or gone already, a 404 — the cell reads "—" and focus goes to the proposal's record,
 * as the panel's does when nothing is left to press, and the router is refreshed, so Back shows the list as it now is.
 * A 409: the proposal no longer takes names, the name stays, and focus goes to the record too (review of unit 62).
 * The panel's strings.
 */
export function ProposalName({ suggestionId, removable }: ProposalNameProps) {
  const t = useTranslations("improve.home.proposals");
  const tp = useTranslations("improve.proposal");
  const router = useRouter();
  const [named, setNamed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [settled, setSettled] = useState(false);
  const toRecord = useRef(false);

  /* once the button pressed is no longer there — the name gone, or the proposal past taking names — its row's record takes focus */
  useEffect(() => {
    if ((named && !settled) || !toRecord.current) return;
    toRecord.current = false;
    document.querySelector<HTMLAnchorElement>(`[data-proposal-row="${suggestionId}"] a`)?.focus();
  }, [named, settled, suggestionId]);

  const remove = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/v1/proposals/${encodeURIComponent(suggestionId)}/endorse`, { method: "DELETE" });
      if (response.ok || response.status === 404) {
        toRecord.current = true;
        setNamed(false);
        router.refresh();
        return;
      }
      if (response.status === 409) {
        toRecord.current = true;
        setSettled(true);
        return;
      }
      setFailure(response.status === 429 ? "rate" : "failedRemove");
    } catch {
      setFailure("failedRemove");
    } finally {
      setBusy(false);
    }
  };

  if (!named) return <>—</>;
  return (
    <span className="row">
      <span>{t("withName")}</span>
      {removable && !settled ? (
        <button type="button" className="btn btn-sm btn-q" disabled={busy} onClick={() => void remove()}>
          {tp("unendorse")}
        </button>
      ) : null}
      {/* mounted and empty until it speaks, so that what it says is read out */}
      <span className="small" role="status">
        {/* the cell says "with your name" already: the panel's shorter line */}
        {settled ? tp("settled") : failure !== null ? tp(failure) : null}
      </span>
    </span>
  );
}
