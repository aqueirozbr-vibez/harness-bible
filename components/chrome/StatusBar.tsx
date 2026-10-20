import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface StatusBarProps {
  /** Cells, each a `<span>`; they wrap rather than clip. */
  readonly children: ReactNode;
  /** Right-aligned last cell, usually a timing: `loaded 0.38 s`. */
  readonly trailing?: ReactNode;
  readonly className?: string;
}

/** 28px mono status bar with ruled cells (ui-context § 9.8). */
export function StatusBar({ children, trailing, className }: StatusBarProps) {
  return (
    <footer className={cn("statusbar", className)}>
      {children}
      {trailing !== undefined ? <span className="statusbar-end">{trailing}</span> : null}
    </footer>
  );
}
