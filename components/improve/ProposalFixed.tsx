import { useTranslations } from "next-intl";

import { ChangeTable } from "@/components/improve/ChangeTable";
import { changeOf } from "@/lib/improve/outcomeView";
import type { Proposal } from "@/lib/schemas/improve";

interface ProposalFixedProps {
  /** The anchored text as the suggestion recorded it. */
  readonly text: string;
  readonly contentLang: "en" | "pt";
  readonly proposal: Proposal | null;
}

/**
 * Step 2 in a revision (feature-specs/31 § 6.5; 35 § 4): the change as it was submitted, before and after, read-only —
 * a revision takes new evidence and a changed rationale, never a changed anchor or proposal, which would be another
 * suggestion — and the sentence that says so.
 */
export function ProposalFixed({ text, contentLang, proposal }: ProposalFixedProps) {
  const t = useTranslations("improve.suggest.edit");
  const change = changeOf({ anchor: { currentText: text }, proposal });
  return (
    <div className="col proposal-fixed">
      <p className="small muted">{t("fixed")}</p>
      <ChangeTable before={change.before} after={change.after} contentLang={contentLang} />
    </div>
  );
}
