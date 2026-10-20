import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface NoticeProps {
  /** Short uppercase title in the warn colour: "Stale > 90 d". */
  readonly title: ReactNode;
  /** The provisional fact and how to treat it. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** Provisional notice: ochre, 3px inset bar; never for errors (ui-context § 9.8). */
export function Notice({ title, children, className }: NoticeProps) {
  return (
    <div className={cn("notice col gap-s2", className)}>
      <p className="label text-warn">{title}</p>
      <div className="ui">{children}</div>
    </div>
  );
}
