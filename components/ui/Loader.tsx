import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface LoaderProgress {
  readonly done: number;
  readonly total: number;
}

type LoaderGlyphs = "▮▯" | "█░";

interface LoaderProps {
  /** Status string that always carries a number: `62% · 3.2 s`, `2 of 3 items`. */
  readonly children: ReactNode;
  /** Label printed before the bar: `verify`, `sandbox`. */
  readonly prefix?: ReactNode;
  /** Optional block bar drawn before the text. */
  readonly progress?: LoaderProgress;
  /** Number of blocks; defaults to `total`. */
  readonly width?: number;
  /** Block characters; `▮▯` for short bars, `█░` for wide ones (ui-context § 9.6). */
  readonly glyphs?: LoaderGlyphs;
  readonly className?: string;
}

function blocks({ done, total }: LoaderProgress, width: number, glyphs: LoaderGlyphs): string {
  const [on, off] = [glyphs[0], glyphs[1]];
  const filled = total <= 0 ? 0 : Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return on.repeat(filled) + off.repeat(width - filled);
}

/** Loader string. No spinners, no skeleton shimmer; a number is always shown (ui-context § 9.6). */
export function Loader({ children, prefix, progress, width, glyphs = "▮▯", className }: LoaderProps) {
  const bar = progress === undefined ? null : blocks(progress, width ?? progress.total, glyphs);
  return (
    <span className={cn("loader", className)} role="status">
      {prefix !== undefined ? <>{prefix} </> : null}
      {bar !== null ? (
        <>
          <span className="blocks">{bar}</span>{" "}
        </>
      ) : null}
      {children}
    </span>
  );
}
