import type { ReactNode } from "react";

import type { StatusTone } from "@/lib/schemas/domain";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "st-ok",
  fail: "st-fail",
  warn: "st-warn",
  mute: "st-mute",
  run: "st-run",
};

interface StatusMarkProps {
  readonly tone: StatusTone;
  /** The full status word, localised: "Verified", "Not reproduced", "Stale > 90 d"; or a letter mark such as `V`. */
  readonly children: ReactNode;
  /** Accessible name and tooltip when the visible text is a letter mark: "VERIFY passed". */
  readonly label?: string;
  /** Blinking caret for a running state; static under reduced motion. */
  readonly caret?: boolean;
  readonly className?: string;
}

/** Inline status mark: an 8px square (filled, hollow or half-filled) and the word (ui-context § 6). */
export function StatusMark({ tone, children, label, caret = false, className }: StatusMarkProps) {
  return (
    <span className={cn("st", TONE_CLASS[tone], caret && "caret", className)} aria-label={label} title={label}>
      {children}
    </span>
  );
}
