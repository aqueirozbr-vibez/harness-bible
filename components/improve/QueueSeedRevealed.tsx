import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import type { CuratorAction } from "@/lib/schemas/improve";

interface QueueSeedRevealedProps {
  readonly decided: { readonly action: CuratorAction; readonly answer: CuratorAction; readonly matched: boolean };
}

/**
 * A seed once decided (feature-specs/36 § 7.1; unit 53e; the Curator-Queue screen's chip and legend): the dotted
 * `seed · known answer`, the curator's decision beside the answer a second curator set, and whether it matched —
 * `match`, or `diverged · to calibration`. A seed measures the curator's consistency, never the adjudicator.
 */
export function QueueSeedRevealed({ decided }: QueueSeedRevealedProps) {
  const t = useTranslations("improve.queue.seed");
  const ta = useTranslations("improve.queue.action");
  return (
    <section className="inst queue-decision" aria-labelledby="queue-seed-title">
      <div className="inst-h">
        <h2 className="t" id="queue-seed-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span className="seed-chip">{t("chip")}</span>
      </div>
      <div className="inst-b col queue-decision-body">
        <dl className="kv">
          <dt>{t("yours")}</dt>
          <dd>{ta(decided.action)}</dd>
          <dt>{t("answer")}</dt>
          <dd>{ta(decided.answer)}</dd>
        </dl>
        <p className="small muted">{t("legend")}</p>
      </div>
      <div className="inst-f queue-decision-status" role="status">
        <StatusMark tone={decided.matched ? "ok" : "warn"}>{t(decided.matched ? "match" : "diverged")}</StatusMark>
      </div>
    </section>
  );
}
