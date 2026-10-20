"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { useMarkKey } from "@/lib/hooks/markKeys";
import { cn } from "@/lib/utils";

import type { ToggleBookmarkAction } from "@/app/[lang]/ch/[n]/[section]/actions";

interface MarkActionsProps {
  readonly sectionId: string;
  readonly releaseId: string;
  readonly bookmarked: boolean;
  readonly toggle: ToggleBookmarkAction;
  /** `rail` or `inline`: the rail renders twice, one copy hidden per breakpoint. */
  readonly idPrefix: string;
}

const ERROR_SHOWN_MS = 6000;

/** The bookmark toggle in the actions rail: pressed state, key `b`, optimistic (feature-specs/07 § 6.1). */
export function MarkActions({ sectionId, releaseId, bookmarked, toggle, idPrefix }: MarkActionsProps) {
  const t = useTranslations("reader.marks");
  const [on, setOn] = useState(bookmarked);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const buttonRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const messageFor = useCallback(
    (code: string): string => {
      if (code === "UNKNOWN_SECTION") return t("error.unknownSection", { id: sectionId, release: releaseId });
      if (code === "NO_SESSION") return t("error.noSession");
      return t("error.failed");
    },
    [t, sectionId, releaseId],
  );

  const flip = useCallback(() => {
    if (pending) return;
    const next = !on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await toggle({ sectionId, on: next });
      if (result.ok) {
        setOn(result.data.bookmarked);
        return;
      }
      setOn(!next);
      setError(messageFor(result.error.code));
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setError(null), ERROR_SHOWN_MS);
    });
  }, [on, pending, sectionId, toggle, messageFor]);

  useMarkKey("bookmark", buttonRef, flip);

  const errorId = `${idPrefix}-bookmark-error`;
  return (
    <div ref={buttonRef} className="col gap-s1">
      <Button
        className={cn("rail-btn mark-btn", on && "is-on")}
        onClick={flip}
        aria-pressed={on}
        aria-busy={pending || undefined}
        aria-label={t("bookmarkLabel", { id: sectionId })}
        aria-describedby={error === null ? undefined : errorId}
      >
        <span className="row" style={{ gap: 8 }}>
          {on ? <span className="mark-square" aria-hidden="true" /> : null}
          <span>{on ? t("bookmarked") : t("bookmark")}</span>
        </span>
        <Kbd>b</Kbd>
      </Button>
      <p className="help err" id={errorId} role="status" aria-live="polite" hidden={error === null}>
        {error}
      </p>
    </div>
  );
}
