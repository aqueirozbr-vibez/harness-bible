import { cn } from "@/lib/utils";

type MeterTone = "ink" | "warn" | "fail" | "ver";

const TONE_CLASS: Record<MeterTone, string> = {
  ink: "",
  warn: "warn",
  fail: "fail",
  ver: "ver",
};

interface MeterMark {
  /** Position of the tick in the meter's own units. */
  readonly at: number;
  /** Cool tick for a gate that is good to cross; red by default. */
  readonly ok?: boolean;
}

interface MeterProps {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  /** Localised accessible name that also names the marks: "Judge kappa; floor 0.6, gate 0.7". */
  readonly label: string;
  readonly tone?: MeterTone;
  readonly marks?: ReadonlyArray<MeterMark>;
  readonly className?: string;
}

function percent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  const clamped = Math.min(Math.max(value, min), max);
  return ((clamped - min) / (max - min)) * 100;
}

/** 8px framed meter, flat fill, 2px threshold ticks. Print the value in text beside it (ui-context § 9.6). */
export function Meter({ value, min = 0, max = 100, label, tone = "ink", marks = [], className }: MeterProps) {
  return (
    <div
      className={cn("meter", TONE_CLASS[tone], className)}
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
    >
      <i style={{ width: `${percent(value, min, max)}%` }} />
      {/* Two ticks may stand at one place: a derived figure's floor is its acceptance. */}
      {marks.map((mark, index) => (
        <span
          key={`${mark.at}:${index}`}
          className={cn("mark", mark.ok && "ok")}
          style={{ left: `${percent(mark.at, min, max)}%` }}
        />
      ))}
    </div>
  );
}
