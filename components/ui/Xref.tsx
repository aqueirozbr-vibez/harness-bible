import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface XrefProps {
  readonly href: string;
  /** The reference text as the book writes it: `26.3`, `ch12`, `Lab 21`. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** Cross-reference link. Cool, dotted underline; opens the peek panel (ui-context § 5.2). */
export function Xref({ href, children, className }: XrefProps) {
  return (
    <Link href={href} className={cn("xref", className)}>
      {children}
    </Link>
  );
}
