import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface FieldProps {
  /** Lowercase mono label, always visible above the control. */
  readonly label: ReactNode;
  /** Id of the control this field labels. */
  readonly htmlFor: string;
  /** The control: `.input`, `.select`, `.textarea`, `.seg`. */
  readonly children: ReactNode;
  /** Help line under the control. */
  readonly help?: ReactNode;
  /** Error line under the control; says what failed and what would pass. */
  readonly error?: ReactNode;
  /** Live counter such as `142 / 200 words`. */
  readonly counter?: ReactNode;
  /** Announce counter changes; off when another live region reports the crossing (feature-specs/07 § 9). */
  readonly counterLive?: boolean;
  readonly counterClassName?: string;
  readonly className?: string;
}

/** Form field wrapper: label above, help or error below, never placeholder-only (ui-context § 9.2). */
export function Field({ label, htmlFor, children, help, error, counter, counterLive = true, counterClassName, className }: FieldProps) {
  const helpId = `${htmlFor}-help`;
  const counterId = `${htmlFor}-count`;
  return (
    <div className={cn("field", className)}>
      {counter === undefined ? (
        <label htmlFor={htmlFor}>{label}</label>
      ) : (
        <div className="between">
          <label htmlFor={htmlFor}>{label}</label>
          <span className={cn("counter", counterClassName)} id={counterId} aria-live={counterLive ? "polite" : "off"}>
            {counter}
          </span>
        </div>
      )}
      {children}
      {error !== undefined ? (
        <p className="help err" id={helpId}>
          {error}
        </p>
      ) : help !== undefined ? (
        <p className="help" id={helpId}>
          {help}
        </p>
      ) : null}
    </div>
  );
}
