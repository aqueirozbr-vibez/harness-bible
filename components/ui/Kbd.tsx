import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface KbdProps {
  /** The key as printed: `/`, `j`, `esc`, `ctrl ↵`. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** Keyboard hint (ui-context § 9.1). */
export function Kbd({ children, className }: KbdProps) {
  return <kbd className={cn("kbd", className)}>{children}</kbd>;
}
