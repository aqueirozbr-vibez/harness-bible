import type { EvidenceTier } from "@/lib/schemas/domain";
import { cn } from "@/lib/utils";

const TIER_CLASS: Record<EvidenceTier, string> = {
  A: "ev-a",
  B: "ev-b",
  C: "ev-c",
  D: "ev-d",
  E: "ev-e",
  F: "ev-f",
  G: "ev-g",
  U: "ev-u",
};

interface EvidenceBadgeProps {
  readonly tier: EvidenceTier;
  /** 24px by default; 40px in the grading instrument. */
  readonly size?: "sm" | "lg";
  /** Localised accessible name, e.g. "Tier C, primary vendor". */
  readonly label?: string;
  readonly className?: string;
}

/**
 * Evidence tier badge A–G, U. Weight falls with strength; only G is red (ui-context § 7). A badge with a label is an
 * image by that name, since a screen reader speaks no `aria-label` on a span with no role (unit 51d's review).
 */
export function EvidenceBadge({ tier, size = "sm", label, className }: EvidenceBadgeProps) {
  return (
    <span className={cn("ev", TIER_CLASS[tier], size === "lg" && "ev-lg", className)} role={label === undefined ? undefined : "img"} aria-label={label}>
      {tier}
    </span>
  );
}
