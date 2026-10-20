import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBlock } from "@/components/ui/StatusBlock";
import { StatusMark } from "@/components/ui/StatusMark";
import type { PathStop, PathView } from "@/lib/schemas/paths";
import { cn } from "@/lib/utils";

const STATE_GLYPH: Record<PathStop["state"], string> = { unread: "□", in_progress: "◧", read: "■" };
const STATE_CLASS: Record<PathStop["state"], string> = { unread: "", in_progress: "is-progress", read: "is-read" };

interface StopRowProps {
  readonly stop: PathStop;
  readonly last: boolean;
}

/** One stop: tree glyph, read state, label, title with marks, minutes (feature-specs/05 § 6.4). */
function StopRow({ stop, last }: StopRowProps) {
  const t = useTranslations("paths");
  const title = stop.title ?? (stop.titleKey === null ? stop.id : t(`stops.${stop.titleKey}`));
  return (
    <li className={cn("sequence-stop", stop.state === "in_progress" && "stop-current")}>
      <span className="mono faint tree" aria-hidden="true">
        {last ? "└─" : "├─"}
      </span>
      <span className={cn("mono read-state", STATE_CLASS[stop.state])} role="img" aria-label={t(`state.${stop.state}`)}>
        {STATE_GLYPH[stop.state]}
      </span>
      <span className="mono stop-label">{stop.label}</span>
      <Link href={stop.href} className={cn("grow small stop-title", `stop-${stop.state}`)}>
        {title}
        {stop.at !== null ? <span className="meta stop-at"> {t("path.at", { id: stop.at })}</span> : null}
        {stop.stale !== null ? (
          <StatusBlock tone="warn" className="sb-sm stop-mark">
            {t("stop.stale", { days: stop.stale.days })}
          </StatusBlock>
        ) : null}
        {stop.lab !== null ? (
          <StatusMark tone="fail" className="stop-mark">
            {t("stop.lab", { n: stop.lab.id.replace(/^lab-/, "") })}
          </StatusMark>
        ) : null}
      </Link>
      <span className="meta stop-min">{t("path.timeMin", { m: stop.minutes })}</span>
    </li>
  );
}

interface PathSequenceProps {
  readonly path: PathView;
  readonly name: string;
}

/** Grouped stops of a path as one ordered list (feature-specs/05 § 6.4). */
export function PathSequence({ path, name }: PathSequenceProps) {
  const t = useTranslations("paths");
  return (
    <ol className="rt sequence" aria-label={t("path.sequence", { name })}>
      {path.groups.flatMap((group) => [
        <li key={`g-${group.titleKey}`} className="sequence-group">
          <span className="glyph">✢</span>
          <span className="cap">{t(`groups.${group.titleKey}`)}</span>
        </li>,
        ...group.stops.map((stop, i) => <StopRow key={stop.id} stop={stop} last={i === group.stops.length - 1} />),
      ])}
    </ol>
  );
}
