import type { ReactNode } from "react";

import type { SourceTier } from "@/lib/schemas/domain";
import { cn } from "@/lib/utils";

const TIER_CLASS: Record<SourceTier, string> = {
  PRIMARY: "t-pri",
  VENDOR: "t-ven",
  ANALYST: "t-anl",
  PRACTITIONER: "t-pra",
  ILLUSTRATIVE: "t-ill",
  DERIVED: "t-der",
  OPEN: "t-opn",
};

interface ChipProps {
  /** Source tier; decides the line form (solid, single, double, dashed, dotted). */
  readonly tier: SourceTier;
  /** Short localised abbreviation shown bold: `pri`, `ven`, `ƒ`, `ilu`. */
  readonly abbr: string;
  /** Optional localised label after the abbreviation, or a locator such as `21.9 r4`. */
  readonly children?: ReactNode;
  readonly className?: string;
}

/** Source-tier chip. Follows the figure it qualifies (ui-context § 5.1). */
export function Chip({ tier, abbr, children, className }: ChipProps) {
  return (
    <span className={cn("chip", TIER_CLASS[tier], className)}>
      <i>{abbr}</i>
      {children}
    </span>
  );
}
