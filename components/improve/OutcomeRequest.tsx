import { useTranslations } from "next-intl";

import type { EvidenceTier } from "@/lib/schemas/domain";

interface OutcomeRequestProps {
  /** The chapter whose lab the run is asked of: `22`. */
  readonly chapterDigits: string;
  /** The tier the class is accepted on: A for a derived figure. */
  readonly tier: EvidenceTier;
}

/**
 * A request for more by rule, for a derived figure (feature-specs/35 § 4; the screen's dock for `S-22-0356`): a tier A
 * run of the chapter's lab with the change applied. The screen's `Open Lab 22 with this change` is absent until the
 * IDE exists (Phase 3), and the box says so: until then a curator inspects the request.
 */
export function OutcomeRequest({ chapterDigits, tier }: OutcomeRequestProps) {
  const t = useTranslations("improve.outcome.request");
  return (
    <section className="notice col outcome-request" aria-label={t("cap")}>
      <span className="cap outcome-request-cap">{t("cap")}</span>
      <p className="small outcome-request-what">{t("what", { tier, n: Number(chapterDigits) })}</p>
      <p className="help">{t("noLab")}</p>
    </section>
  );
}
