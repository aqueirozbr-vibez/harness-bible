import type { ReactNode } from "react";

import type { StatusTone } from "@/lib/schemas/domain";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "sb-ok",
  fail: "sb-fail",
  warn: "sb-warn",
  mute: "sb-mute",
  run: "sb-act",
};

interface StatusBlockProps {
  readonly tone: StatusTone;
  /** The full status word, localised. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** Block status: heads an instrument or a run (ui-context § 6). */
export function StatusBlock({ tone, children, className }: StatusBlockProps) {
  return <span className={cn("st-block", TONE_CLASS[tone], className)}>{children}</span>;
}
