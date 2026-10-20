import { useTranslations } from "next-intl";

import type { QueueDecided as QueueDecidedData } from "@/lib/db/queuePage";
import { formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { hashLine } from "@/lib/ledger/display";
import { CRITERIA, type Criterion } from "@/lib/schemas/improve";

interface QueueDecidedProps {
  readonly locale: Locale;
  readonly decided: QueueDecidedData;
  /** A researcher's proposal is accepted, not accepted on inspection: its accept is a curator's on a recommendation (43 § 7.1). */
  readonly origin: "HUMAN" | "RESEARCHER" | "CURATOR";
}

const isCriterion = (value: string | null): value is Criterion => value !== null && (CRITERIA as ReadonlyArray<string>).includes(value);

/**
 * A curator's decision once made (feature-specs/36 § 5, § 8; unit 53c; the Curator-Queue screen's status footer): who
 * decided and when — a curator who arrives after another decided sees who — then, once the workflow has written the
 * `curator` record, `override recorded · OV-IND-02 · independence · accepted on inspection · prev … → …`; until then
 * `recording`. An override is a decision with a code or a criterion; any other is recorded as a decision.
 */
export function QueueDecided({ locale, decided, origin }: QueueDecidedProps) {
  const t = useTranslations("improve.queue.decided");
  const td = useTranslations("improve.queue.decision.done");
  const tc = useTranslations("improve.outcome.reasons.name");
  const override = decided.overrideCode !== null || decided.criterion !== null;
  const what = [decided.overrideCode, isCriterion(decided.criterion) ? tc(decided.criterion) : decided.criterion, decided.action === "ACCEPT" && origin === "RESEARCHER" ? td("ACCEPT_RESEARCH") : decided.action === "ACCEPT" || decided.action === "KEEP_REQUEST_MORE" || decided.action === "DECLINE" ? td(decided.action) : decided.action].filter((part) => part !== null);
  return (
    <section className="inst queue-decision" aria-labelledby="queue-decision-done-title">
      <div className="inst-h">
        <h2 className="t" id="queue-decision-done-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{decided.by ?? t("someone")}</span>
        <span className="ts">{formatDateTime(new Date(decided.at), locale)}</span>
      </div>
      <div className="inst-f queue-decision-status" role="status">
        {decided.record === null ? <span className="st st-run">{t("recording")}</span> : <span className="st st-ok">{t(override ? "override" : "recorded")}</span>}
        <span>{what.join(" · ")}</span>
        {decided.record !== null ? <span className="hash">{t("hashes", { prev: hashLine(decided.record.prevHash), hash: hashLine(decided.record.hash) })}</span> : null}
      </div>
    </section>
  );
}
