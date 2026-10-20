import { useTranslations } from "next-intl";

import { Notice } from "@/components/ui/Notice";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { SuggestGate } from "@/lib/improve/suggest";
import { THROTTLE } from "@/lib/improve/throttle";

interface SuggestGateNoticeProps {
  /** Why the person cannot start a draft, as `suggestGate` answers it: the role, an unverified identity, or the throttle. */
  readonly gate: Exclude<SuggestGate, { readonly kind: "form" }>;
  readonly locale: Locale;
}

/**
 * Why a person cannot start a draft (feature-specs/34 § 7; 48 § 10.1, § 18; unit 76): a role that does not draft, with the
 * account's role named; an identity not verified; or the throttle, with the day it lifts. Step 1's own notices, taken out
 * of its column so the pages that meet the same gate say it in the same words: step 1, the new-suggestion chooser at its
 * top in place of its lists, and a finding's block and the Improve landing page's `From a research` for a throttled
 * contributor (48 § 8.1, § 10.2). Hooks only, no state: it renders on the server and inside a client island alike.
 */
export function SuggestGateNotice({ gate, locale }: SuggestGateNoticeProps) {
  const t = useTranslations("improve.suggest");
  const tr = useTranslations("account.role");
  if (gate.kind === "role") return <Notice title={t("role.title")}>{t("role.body", { role: tr(gate.role) })}</Notice>;
  if (gate.kind === "unverified") return <Notice title={t("unverified.title")}>{t("unverified.body")}</Notice>;
  const date = formatDate(gate.until, locale);
  return <Notice title={t("throttled.title", { date })}>{t("throttled.body", { declines: THROTTLE.declines, days: THROTTLE.withinDays, date })}</Notice>;
}
