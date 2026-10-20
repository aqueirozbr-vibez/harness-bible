"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SegOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
}

interface SegProps<T extends string> {
  readonly options: ReadonlyArray<SegOption<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Id of the visible `.flabel` that names the group. */
  readonly labelledBy?: string;
  /** Accessible name when there is no visible label. */
  readonly label?: string;
  readonly className?: string;
}

/** Segmented control; pressed segment is ink-filled (ui-context § 9.2). */
export function Seg<T extends string>({ options, value, onChange, labelledBy, label, className }: SegProps<T>) {
  return (
    <div className={cn("seg", className)} role="group" aria-labelledby={labelledBy} aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
