import { useTranslations } from "next-intl";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import { formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { ProposalView } from "@/lib/schemas/api";
import type { Part } from "@/lib/schemas/improve";

/** A part as the outcome page writes it (`part iii`): `P4` has no chapter of the book and reads as the third. */
const ROMAN: Readonly<Record<Part, string>> = { ...PART_ROMAN, P4: PART_ROMAN.P3 };

interface ProposalWhereProps {
  readonly where: ProposalView["where"];
  readonly endorsed: ProposalView["endorsed"];
  readonly locale: Locale;
}

/**
 * Where a research proposal stands, in the words of feature-specs/43 § 5.1: `with a curator · part i · decision by 18
 * Oct`, `being merged`, `accepted · in v1.3.3` (`· with your name` where the reader's name is on it), `declined by a
 * curator`, `not merged · the chapter's check failed`; nothing for a state a proposal is not shown in. The panel under
 * the answer and the landing page's list say it the same way (units 60b, 60c).
 */
export function ProposalWhere({ where, endorsed, locale }: ProposalWhereProps) {
  const t = useTranslations("improve.proposal");
  switch (where.state) {
    case "CURATOR_QUEUE":
      return <>{t("where.queue", { part: where.parts.map((part) => ROMAN[part]).join(", "), date: where.decisionBy === null ? "—" : formatDayMonth(new Date(where.decisionBy), locale) })}</>;
    case "MERGING":
      return <>{t("where.merging")}</>;
    case "MERGED":
      return <>{endorsed === null ? t("where.merged", { version: where.version ?? "—" }) : `${t("where.merged", { version: where.version ?? "—" })} · ${t("withName")}`}</>;
    case "CLOSED":
      return <>{where.closedBy === "check" ? t("where.notMerged") : t("where.declined")}</>;
    default:
      return null;
  }
}

/** Whether a proposal in this state has a where line. */
export function hasWhere(state: ProposalView["where"]["state"]): boolean {
  return state === "CURATOR_QUEUE" || state === "MERGING" || state === "MERGED" || state === "CLOSED";
}
