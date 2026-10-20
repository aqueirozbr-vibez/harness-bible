import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";

import { cn } from "@/lib/utils";

interface CiteProps {
  /** Citation text: `ch21 · 21.3`, `Lab 21 · README`. */
  readonly children: ReactNode;
  /** Section the citation resolves to; omit for an unresolved display-only chip. */
  readonly href?: string;
  /**
   * The figure this citation names, if any: the reading column highlights the paragraph that prints it
   * (feature-specs/16 § 7), and the reader's own prose carries the same attribute on its figures.
   */
  readonly figureId?: string | null;
  /** The assistant's chip marks itself as the peek's anchor before it navigates (16 § 5.5). */
  readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
  readonly className?: string;
}

/** Assistant citation chip, one per claim (ui-context § 5.2). */
export function Cite({ children, href, figureId, onClick, className }: CiteProps) {
  const classes = cn("cite", className);
  if (href === undefined) {
    return (
      <span className={classes} data-figure={figureId ?? undefined}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={classes} data-figure={figureId ?? undefined} onClick={onClick}>
      {children}
    </Link>
  );
}
