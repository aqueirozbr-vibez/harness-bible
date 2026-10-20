import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import { fetchStateOf } from "@/lib/improve/evidenceView";
import type { SuggestionView } from "@/lib/schemas/suggestions";

interface EvidenceStatusProps {
  readonly item: SuggestionView["evidence"][number];
}

/**
 * How an evidence item was read, in the edit page's words (feature-specs/34 § 5): grading, uploaded or opened with its
 * status, or why it was not graded. A suggestion's own page and its record show it beside each item (35 § 4, § 5).
 */
export function EvidenceStatus({ item }: EvidenceStatusProps) {
  const te = useTranslations("improve.suggest.evidence");
  const fetched = fetchStateOf(item.fetchStatus);
  const words =
    item.state === "PENDING"
      ? te("grading")
      : fetched !== null && fetched.kind === "unreachable"
        ? te("unreachable.title")
        : fetched !== null && fetched.kind === "unsupported"
          ? fetched.type === "unknown"
            ? te("noType")
            : fetched.type
          : item.tier === "U" || (fetched !== null && fetched.kind === "notSupplied")
            ? te("ruled.title")
            : fetched === null || fetched.kind !== "opened"
              ? "—"
              : item.kind === "UPLOAD"
                ? te("status.uploaded")
                : te("status.opened", { status: fetched.status });
  return <StatusMark tone={item.state === "PENDING" ? "mute" : item.tier === "U" ? "fail" : "ok"}>{words}</StatusMark>;
}
