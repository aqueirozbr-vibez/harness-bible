"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";

import { PEEK_ANCHOR_ATTR } from "@/components/reader/ProseInteractions";
import { Empty } from "@/components/ui/Empty";
import { Kbd } from "@/components/ui/Kbd";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { PeekData } from "@/lib/schemas/chapter";

const PANEL_WIDTH = 380;
const GAP = 8;
const MARGIN = 16;

interface PeekPanelProps {
  readonly id: string;
  readonly data: PeekData | null;
  readonly locale: Locale;
  /** The section route without `/ref/[id]`, for closing when there is no history to go back to. */
  readonly basePath: string;
}

/** The cross-reference peek: a dialog floated beside the link it came from (spec § 6.8). */
export function PeekPanel({ id, data, locale, basePath }: PeekPanelProps) {
  const t = useTranslations("reader.peek");
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  /* Position is written straight to the node in page coordinates: the peek slot
     renders beside the page, not inside the reading column, and layout is not React state. */
  useLayoutEffect(() => {
    const panel = panelRef.current;
    /* The prose's cross-references, the assistant's citation chips and a refusal's pointers all open the peek (16
       § 5.5, 17 § 3). The anchor is whichever link marked itself: a pointer is a row, neither `.xref` nor `.cite`,
       and while only those two classes were looked for its peek had no anchor, so `esc` neither went back nor
       returned focus (found in unit 41's browser pass). */
    const anchor = document.querySelector<HTMLElement>(`a[${PEEK_ANCHOR_ATTR}]`);
    anchorRef.current = anchor;
    if (panel !== null && anchor !== null) {
      const rect = anchor.getBoundingClientRect();
      const maxLeft = Math.max(MARGIN, document.documentElement.clientWidth - PANEL_WIDTH - MARGIN);
      panel.style.left = `${Math.min(Math.max(MARGIN, rect.left + window.scrollX), maxLeft)}px`;
      panel.style.top = `${rect.bottom + window.scrollY + GAP}px`;
    }
    panel?.focus();
  }, [id]);

  useEffect(() => {
    const close = () => {
      const anchor = anchorRef.current;
      if (anchor !== null) {
        anchor.removeAttribute(PEEK_ANCHOR_ATTR);
        router.back();
        anchor.focus();
      } else {
        router.replace(basePath);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: MouseEvent) => {
      const panel = panelRef.current;
      if (panel !== null && event.target instanceof Node && !panel.contains(event.target)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [router, basePath]);

  return (
    <div ref={panelRef} className="peek peek-float col" role="dialog" aria-label={t("label", { id })} tabIndex={-1}>
      <div className="inst-h">
        <span className="t">{t("title", { id })}</span>
        {data !== null ? (
          <>
            <span className="sep">·</span>
            <span>{data.version}</span>
          </>
        ) : null}
        <span className="ts">
          <Kbd>esc</Kbd>
        </span>
      </div>
      {data === null ? (
        <Empty className="border-0">
          <p className="ui">{t("missing")}</p>
        </Empty>
      ) : (
        <>
          <div className="col" style={{ padding: "14px 16px", gap: 10 }}>
            <span className="cap">{data.caption}</span>
            <div className="small peek-body" dangerouslySetInnerHTML={{ __html: data.bodyHtml }} />
            {data.verifiedAt !== null ? <StatusMark tone="ok">{t("verified", { date: formatDate(data.verifiedAt, locale) })}</StatusMark> : null}
          </div>
          <div className="inst-f justify-between">
            <Link href={data.openHref} className="xref">
              {t("open")}
            </Link>
            <span className="xref faint" aria-disabled="true" title={t("sideSoon")}>
              {t("side")}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
