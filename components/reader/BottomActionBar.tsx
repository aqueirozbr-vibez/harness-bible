"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { IconButton } from "@/components/ui/IconButton";
import { useMarkKey } from "@/lib/hooks/markKeys";
import type { ChapterData } from "@/lib/schemas/chapter";
import { cn } from "@/lib/utils";

import type { ToggleBookmarkAction } from "@/app/[lang]/ch/[n]/[section]/actions";

interface BottomActionBarProps {
  readonly layers: ChapterData["outline"]["layers"];
  readonly sectionId: string;
  readonly chapterNumber: number;
  readonly askHref: string;
  readonly editionLang: "EN" | "PT";
  readonly releaseId: string;
  /** The reader's bookmark on this section; null when signed out (feature-specs/07 § 6.1). */
  readonly bookmarked: boolean | null;
  readonly toggleBookmark?: ToggleBookmarkAction;
  /** Where the signed-out cell sends the reader (feature-specs/08 § 6.1). */
  readonly signInHref: string;
}

const ERROR_SHOWN_MS = 6000;
/** The bar renders once per page, so one id is enough (`MarkActions` needs a prefix: the rail renders twice). */
const ERROR_ID = "action-bar-bookmark-error";

/**
 * Phone-only bottom bar: contents sheet, bookmark toggle, ask action (spec 03 § 6.10).
 * The bookmark cell is the phone's only way to mark a section, because the rail
 * that carries `MarkActions` is hidden under 768px (Andre, 2026-09-24). It calls
 * the same `toggleBookmark` action, optimistic then confirmed, as the rail does.
 */
export function BottomActionBar({ layers, sectionId, chapterNumber, askHref, editionLang, releaseId, bookmarked, toggleBookmark, signInHref }: BottomActionBarProps) {
  const t = useTranslations("reader.mobile");
  const tm = useTranslations("reader.marks");
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(bookmarked === true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sheetRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    sheetRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const messageFor = useCallback(
    (code: string): string => {
      if (code === "UNKNOWN_SECTION") return tm("error.unknownSection", { id: sectionId, release: releaseId });
      if (code === "NO_SESSION") return tm("error.noSession");
      return tm("error.failed");
    },
    [tm, sectionId, releaseId],
  );

  const flip = useCallback(() => {
    if (pending || toggleBookmark === undefined) return;
    const next = !on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await toggleBookmark({ sectionId, on: next });
      if (result.ok) {
        setOn(result.data.bookmarked);
        return;
      }
      setOn(!next);
      setError(messageFor(result.error.code));
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setError(null), ERROR_SHOWN_MS);
    });
  }, [on, pending, sectionId, toggleBookmark, messageFor]);

  useMarkKey("bookmark", markRef, flip);

  return (
    <>
      {open ? (
        <div ref={sheetRef} className="peek sheet col" role="dialog" aria-label={t("toc")} tabIndex={-1}>
          <div className="inst-h">
            <span className="t">{t("toc")}</span>
            <span className="ts">
              <IconButton label={t("close")} onClick={() => setOpen(false)}>
                ×
              </IconButton>
            </span>
          </div>
          <ul className="outline col" style={{ padding: "8px 16px 12px" }}>
            {layers.map((layer) => (
              <li key={layer.id}>
                <Link href={layer.href} aria-current={layer.id === sectionId ? "location" : undefined} onClick={() => setOpen(false)}>
                  <span className="n">{layer.id}</span>
                  {layer.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <nav className="rt-s action-bar action-bar-three phone-only" aria-label={t("barLabel")}>
        <button type="button" className="rr action-bar-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="ui" style={{ fontWeight: 500 }}>
            {t("toc")}
          </span>
          <span className="cap">{t("tocSub", { id: sectionId, n: String(chapterNumber).padStart(2, "0") })}</span>
        </button>
        {bookmarked === null || toggleBookmark === undefined ? (
          <Link href={signInHref} className="rr action-bar-btn">
            <span className="ui" style={{ fontWeight: 500 }}>
              {tm("bookmark")}
            </span>
            <span className="cap">{tm("error.noSession")}</span>
          </Link>
        ) : (
          /* The failure message is the cell's second line, not part of the button: inside it, it would join the
             accessible name the `aria-label` fixes and no `aria-describedby` could reach it (review of unit 37). */
          <div className="rr col">
            <button
              ref={markRef}
              type="button"
              className={cn("action-bar-btn mark-btn grow", on && "is-on")}
              aria-pressed={on}
              aria-busy={pending || undefined}
              aria-label={tm("bookmarkLabel", { id: sectionId })}
              aria-describedby={error === null ? undefined : ERROR_ID}
              onClick={flip}
            >
              <span className="row ui justify-center" style={{ fontWeight: 500 }}>
                {on ? <span className="mark-square" aria-hidden="true" /> : null}
                <span>{on ? tm("bookmarked") : tm("bookmark")}</span>
              </span>
            </button>
            <span className="help err" id={ERROR_ID} role="status" aria-live="polite" hidden={error === null}>
              {error}
            </span>
          </div>
        )}
        <Link href={askHref} className="action-bar-btn action-bar-primary">
          <span className="ui" style={{ fontWeight: 500 }}>
            {t("ask", { id: sectionId })}
          </span>
          <span className="mono" style={{ fontSize: 11, lineHeight: "14px" }}>
            {t("askSub", { edition: editionLang })}
          </span>
        </Link>
      </nav>
    </>
  );
}
