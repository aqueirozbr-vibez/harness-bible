import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface InstrumentPanelProps {
  /** Uppercase mono label: what the instrument measures. */
  readonly label: ReactNode;
  /** Header segments after the label, each separated by a middle dot: version, sha. */
  readonly meta?: ReadonlyArray<{ readonly key: string; readonly node: ReactNode }>;
  /** Right-aligned faint timestamp that names its event: "verified 12 Sep 2026". */
  readonly timestamp?: ReactNode;
  readonly children: ReactNode;
  /** `padded` wraps children in `.inst-b`; `bare` lets the body lay itself out (grids of cells). */
  readonly body?: "padded" | "bare";
  readonly footer?: ReactNode;
  readonly footerClassName?: string;
  /** Accessible name of the region; defaults to the label when it is a string. */
  readonly ariaLabel?: string;
  readonly className?: string;
}

/** The core component: label, version, timestamp, body, footer (ui-context § 8). */
export function InstrumentPanel({
  label,
  meta = [],
  timestamp,
  children,
  body = "padded",
  footer,
  footerClassName,
  ariaLabel,
  className,
}: InstrumentPanelProps) {
  const name = ariaLabel ?? (typeof label === "string" ? label : undefined);
  return (
    <section className={cn("inst", className)} aria-label={name}>
      <div className="inst-h">
        <span className="t">{label}</span>
        {meta.map((m) => (
          <span key={m.key} className="contents">
            <span className="sep">·</span>
            <span>{m.node}</span>
          </span>
        ))}
        {timestamp !== undefined ? <span className="ts">{timestamp}</span> : null}
      </div>
      {body === "padded" ? <div className="inst-b">{children}</div> : children}
      {footer !== undefined ? <div className={cn("inst-f", footerClassName)}>{footer}</div> : null}
    </section>
  );
}
