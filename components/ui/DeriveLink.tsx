import Link from "next/link";

import { cn } from "@/lib/utils";

interface DeriveLinkProps {
  /** Line in the lab's derive script that produced the figure. */
  readonly line: number;
  /** Where the link opens the code pane; omit to render a static mark. */
  readonly href?: string;
  /** Localised tooltip, e.g. "derive.py line 38". */
  readonly title?: string;
  readonly className?: string;
}

/** `ƒ L38` derive chip: links a derived figure to the exact derive.py line (ui-context § 5.2). */
export function DeriveLink({ line, href, title, className }: DeriveLinkProps) {
  const label = `L${line}`;
  const classes = cn("derive", className);
  if (href === undefined) {
    return (
      <span className={classes} title={title}>
        ƒ {label}
      </span>
    );
  }
  return (
    <Link href={href} className={classes} title={title}>
      ƒ {label}
    </Link>
  );
}
