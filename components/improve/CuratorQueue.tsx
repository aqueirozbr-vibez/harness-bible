import { useTranslations } from "next-intl";

import { StatusBar } from "@/components/chrome/StatusBar";
import { partRoman, QueueList } from "@/components/improve/QueueList";
import { QueueDetail } from "@/components/improve/QueueDetail";
import { QueueRail } from "@/components/improve/QueueRail";
import type { QueuePageData } from "@/lib/db/queuePage";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";

interface CuratorQueueProps {
  readonly locale: Locale;
  readonly data: Extract<QueuePageData, { readonly kind: "page" }>;
  readonly curator: string;
  readonly loadedMs: number;
}

/**
 * The curator queue's page (feature-specs/36 § 4; unit 53b; the Curator-Queue screen): three columns — the queue
 * (480px), the selected suggestion, the calibration rail (360px). The selected item is in the address (`?s=`), so a
 * reload and a shared link open the same one.
 */
export function CuratorQueue({ locale, data, curator, loadedMs }: CuratorQueueProps) {
  const t = useTranslations("improve.queue");
  const th = useTranslations("home.statusbar");
  const { queue, selected } = data;
  const parts = queue.parts.length === 0 ? "—" : [...new Set(queue.parts.map(partRoman))].join(", ");
  return (
    <>
      <div className="queue-page">
        <QueueList locale={locale} queue={queue} selectedId={selected?.view.id ?? null} curator={curator} />
        {selected !== null ? (
          <QueueDetail locale={locale} selected={selected} curator={curator} parts={t("detail.parts", { parts })} />
        ) : (
          <main className="col queue-detail" aria-labelledby="queue-detail-empty">
            <h2 className="h4" id="queue-detail-empty">
              {t("detail.none")}
            </h2>
          </main>
        )}
        <QueueRail locale={locale} calibration={data.calibration} />
      </div>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar", { parts })}</span>
      </StatusBar>
    </>
  );
}
