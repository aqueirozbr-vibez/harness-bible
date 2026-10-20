import type { ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

interface ErrorBoxProps {
  /** Short uppercase title in the fail colour: "Sandbox did not start". */
  readonly title: ReactNode;
  /** What failed, what was kept, what to do next. */
  readonly children: ReactNode;
  /** Buttons, rendered in a row under the text. */
  readonly actions?: ReactNode;
  readonly className?: string;
  /**
   * Given where the control the focus was in is gone or disabled by what failed (feature-specs/48 § 20): the box takes
   * `tabIndex={-1}` so the caller can move the focus to it.
   */
  readonly ref?: Ref<HTMLDivElement>;
}

/** Error state; announced as an alert (ui-context § 9.8). */
export function ErrorBox({ title, children, actions, className, ref }: ErrorBoxProps) {
  return (
    <div className={cn("error col gap-s2", className)} role="alert" ref={ref} tabIndex={ref === undefined ? undefined : -1}>
      <p className="label text-fail">{title}</p>
      <div className="ui">{children}</div>
      {actions !== undefined ? <div className="row">{actions}</div> : null}
    </div>
  );
}
