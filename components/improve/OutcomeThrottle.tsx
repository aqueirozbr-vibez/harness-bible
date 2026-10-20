import { useTranslations } from "next-intl";

import type { EvidenceTier } from "@/lib/schemas/domain";

interface OutcomeThrottleProps {
  readonly id: string;
  /** The owner's declines on unverifiable evidence in the window, by the throttle's own query, and the rule's numbers. */
  readonly throttle: { readonly count: number; readonly declines: number; readonly withinDays: number };
  /** Whether this suggestion's decline counts, and the strongest tier graded; null where it was not declined. */
  readonly note: { readonly counts: boolean; readonly tier: EvidenceTier } | null;
}

/**
 * The throttle rule (feature-specs/35 § 4; the screen's right column): three declines for unverifiable evidence in a
 * month throttle a person's suggestions (33 § 7), with the owner's own count; and of a decline, whether it counts — a
 * tier G one does not.
 */
export function OutcomeThrottle({ id, throttle, note }: OutcomeThrottleProps) {
  const t = useTranslations("improve.outcome.throttle");
  return (
    <section className="col rt outcome-aside-note" aria-labelledby="outcome-throttle-title">
      <h2 className="cap" id="outcome-throttle-title">
        {t("cap")}
      </h2>
      <p className="small muted">{t("rule", { max: throttle.declines, n: throttle.count })}</p>
      {note !== null ? <p className="help">{note.counts ? t("counts", { id, days: throttle.withinDays }) : t("notCounted", { id, tier: note.tier })}</p> : null}
    </section>
  );
}
