"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { onDraftSave, type DraftSaveDetail } from "@/lib/hooks/draftSave";
import { formatClock } from "@/lib/i18n/format";

interface SaveStatusProps {
  /** What the cell says before the first edit: the page's own `loaded 0.38 s`. */
  readonly loaded: string;
}

/**
 * The status bar's last cell on the edit page (feature-specs/34 § 5): `autosaved 14:02:31` after a save, and what
 * the autosave is doing in between — a change not yet saved, a save under way, fields that make no proposal, a save
 * the server refused. The editor owns those facts in another tree, so it sends them (lib/hooks/draftSave.ts).
 * Polite, as the note editor's status is.
 */
export function SaveStatus({ loaded }: SaveStatusProps) {
  const t = useTranslations("improve.suggest.save");
  const [detail, setDetail] = useState<DraftSaveDetail | null>(null);
  /** The last save's time, which a clean state shows again. */
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(
    () =>
      onDraftSave((next) => {
        setDetail(next);
        if (next.state === "saved") setSavedAt(next.at);
      }),
    [],
  );

  let text: string;
  if (detail === null || detail.state === "clean") text = savedAt === null ? loaded : t("saved", { time: formatClock(new Date(savedAt)) });
  else if (detail.state === "dirty") text = t("dirty");
  else if (detail.state === "saving") text = t("saving");
  else if (detail.state === "saved") text = t("saved", { time: formatClock(new Date(detail.at)) });
  else if (detail.state === "invalid") text = t("invalid", { message: detail.message });
  else text = t("failed", { message: detail.message ?? t(detail.reached ? "unknown" : "network") }) + (detail.traceId === null ? "" : ` · ${t("trace", { traceId: detail.traceId })}`);
  return (
    <span className="save-status" aria-live="polite">
      {text}
    </span>
  );
}
