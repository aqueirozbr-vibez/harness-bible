import { useTranslations } from "next-intl";

import { Chip } from "@/components/ui/Chip";
import type { SourceTier } from "@/lib/schemas/domain";

interface TierChipProps {
  readonly tier: SourceTier | "SCENARIO" | null;
  /** A figure that is a scenario parameter, whatever its tier. */
  readonly scenario?: boolean;
  /** The chip's word after its abbreviation: `vendor · 15.9 r12`. */
  readonly word?: string;
}

/** A figure's or a row's tier as its chip; a scenario parameter as the reader's word for it (feature-specs/34 § 4). */
export function TierChip({ tier, scenario, word }: TierChipProps) {
  const t = useTranslations("reader");
  if (tier === null) return null;
  if (tier === "SCENARIO" || scenario === true) return <span className="meta">{t("figures.scenario")}</span>;
  return (
    <Chip tier={tier} abbr={tier === "DERIVED" ? "ƒ" : t(`tier.abbr.${tier}`)}>
      {word}
    </Chip>
  );
}
