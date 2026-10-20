import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBlock } from "@/components/ui/StatusBlock";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { HomeChapterTile } from "@/lib/schemas/home";
import { padChapter } from "@/lib/schemas/ids";
import { cn } from "@/lib/utils";

interface ChapterTileProps {
  readonly tile: HomeChapterTile;
  readonly locale: Locale;
}

/** One chapter in the part grid: number, chip, title, version, V/R marks, lab state (spec § 6.6). */
export function ChapterTile({ tile, locale }: ChapterTileProps) {
  const t = useTranslations("home.tile");
  const isStale = tile.staleDays !== null;
  const isFail = tile.lab.kind === "not_reproduced";
  const isCurrent = tile.current !== null;
  const verifyOk = tile.verify === "PASSED";
  const redteamOk = tile.redteam === "PASSED" && tile.redteamOpen === 0;
  const redteamTone = tile.redteamOpen > 0 ? "warn" : redteamOk ? "ok" : "mute";
  const redteamLabel =
    tile.redteamOpen > 0 ? t("redteamOpen", { n: tile.redteamOpen }) : redteamOk ? t("redteamPassed") : t("redteamNot");

  return (
    <li className={cn("tile", isCurrent && "tile-cur", isStale && "tile-stale", isFail && "tile-fail")}>
      <div className="between tile-head">
        <span className="tile-n">{padChapter(tile.number)}</span>
        {tile.staleDays !== null ? (
          <StatusBlock tone="warn" className="sb-sm">
            {t("stale", { days: tile.staleDays })}
          </StatusBlock>
        ) : tile.redteamOpen > 0 ? (
          <StatusBlock tone="warn" className="sb-sm">
            {t("open", { n: tile.redteamOpen })}
          </StatusBlock>
        ) : tile.current !== null ? (
          <span className="cap reading-mark">{t("reading", { section: tile.current.sectionId })}</span>
        ) : null}
      </div>
      <Link href={tile.href} className="tile-title" aria-current={isCurrent ? "true" : undefined}>
        {tile.title}
      </Link>
      <div className="between tile-meta">
        <span className="meta">
          {tile.daysSinceVerify === null
            ? t("version", { version: tile.version })
            : t("versionDays", { version: tile.version, days: tile.daysSinceVerify })}
        </span>
        <span className="row tile-marks">
          <StatusMark tone={verifyOk ? "ok" : "mute"} label={verifyOk ? t("verifyPassed") : t("verifyNot")}>
            V
          </StatusMark>
          <StatusMark tone={redteamTone} label={redteamLabel}>
            R
          </StatusMark>
        </span>
      </div>
      {tile.lab.kind === "reproduced" ? (
        <StatusMark tone="ok">{t("reproduced")}</StatusMark>
      ) : tile.lab.kind === "not_reproduced" ? (
        <span className="col" style={{ gap: 2 }}>
          <StatusMark tone="fail">{t("notReproduced")}</StatusMark>
          <span className="meta text-fail">{t("since", { n: tile.number, when: formatDayMonth(tile.lab.since, locale) })}</span>
        </span>
      ) : (
        <StatusMark tone="mute" className="st-plain">
          {tile.lab.carries === "prose" ? t("noLabProse") : t("noLabInstrument")}
        </StatusMark>
      )}
    </li>
  );
}
