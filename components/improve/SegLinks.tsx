"use client";

import Link from "next/link";
import { useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegLink {
  readonly key: string;
  readonly label: ReactNode;
  /** Where the segment leads; null when it has nowhere to go, and it is shown disabled. */
  readonly href: string | null;
  readonly current: boolean;
}

interface SegLinksProps {
  readonly items: ReadonlyArray<SegLink>;
  /** Accessible name of the group. */
  readonly label: string;
  readonly className?: string;
}

/**
 * A segmented control whose segments are links (`.seg-links`, ui-context § 9.9): the current one carries
 * `aria-current`. One stop in the tab order (feature-specs/34 § 11.7): it is the current segment when focus comes
 * in, it moves with the arrow keys to the segment they reach, and it goes back to the current segment when focus
 * leaves, as a tab list's does. Enter follows. A segment with nowhere to go is a disabled link the arrows pass over.
 */
export function SegLinks({ items, label, className }: SegLinksProps) {
  const refs = useRef<Array<HTMLAnchorElement | null>>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const live = items.flatMap((item, index) => (item.href === null ? [] : [index]));
  const current = items.findIndex((item) => item.current && item.href !== null);
  const stop = focused ?? (current >= 0 ? current : (live[0] ?? -1));

  const onKey = (event: ReactKeyboardEvent<HTMLAnchorElement>, index: number): void => {
    /* Alt+Arrow is the browser's back and forward; a chord is never the control's. */
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = live.indexOf(index);
    const next = live[(at + step + live.length) % live.length];
    if (next === undefined) return;
    setFocused(next);
    refs.current[next]?.focus();
  };

  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
  };

  return (
    <div className={cn("seg-links", className)} role="group" aria-label={label} onBlur={onBlur}>
      {items.map((item, index) =>
        item.href === null ? (
          <span key={item.key} role="link" aria-disabled="true" className="is-off">
            {item.label}
          </span>
        ) : (
          <Link
            key={item.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            href={item.href}
            scroll={false}
            aria-current={item.current ? "true" : undefined}
            tabIndex={index === stop ? 0 : -1}
            onKeyDown={(event) => onKey(event, index)}
          >
            {item.label}
          </Link>
        ),
      )}
    </div>
  );
}
