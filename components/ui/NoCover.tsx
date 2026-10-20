import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface NoCoverProps {
  /** Localised text: "the book does not cover this". */
  readonly children: ReactNode;
  readonly className?: string;
}

/** The assistant's uncited-claim substitution (ui-context § 5.2). */
export function NoCover({ children, className }: NoCoverProps) {
  return <span className={cn("nocover", className)}>{children}</span>;
}
