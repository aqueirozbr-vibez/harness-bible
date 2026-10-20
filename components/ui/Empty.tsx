import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface EmptyProps {
  /** Lowercase mono classifier: "labs · lab 21 · saved runs". */
  readonly caption?: ReactNode;
  /** One line saying what is absent, then an optional muted reason. */
  readonly children: ReactNode;
  /** The one action that fills the state. */
  readonly action?: ReactNode;
  readonly className?: string;
}

/** Empty state: dashed frame, the thing is absent not broken (ui-context § 9.8). */
export function Empty({ caption, children, action, className }: EmptyProps) {
  return (
    <div className={cn("empty", className)}>
      {caption !== undefined ? <p className="cap">{caption}</p> : null}
      {children}
      {action}
    </div>
  );
}
