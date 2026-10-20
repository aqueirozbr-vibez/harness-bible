import { useTranslations } from "next-intl";
import Link from "next/link";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import { Kbd } from "@/components/ui/Kbd";
import { Meter } from "@/components/ui/Meter";
import type { ChapterData } from "@/lib/schemas/chapter";
import { padChapter } from "@/lib/schemas/ids";

interface OutlineProps {
  readonly data: ChapterData;
  readonly signedIn: boolean;
}

/** Left rail: part, chapter window with the current chapter's nine layers, reading path, keys (spec § 6.1). */
export function Outline({ data, signedIn }: OutlineProps) {
  const t = useTranslations("reader");
  const tp = useTranslations("home.part");
  const tc = useTranslations("home.continue");
  const { outline, chapter, section, progress } = data;
  const pathName = progress === null ? null : tc(`pathName.${progress.path}`);

  return (
    <aside className="reader-outline rr" aria-label={t("outline.label")}>
      <div className="col" style={{ gap: 4 }}>
        <span className="cap">{tp("cap", { roman: PART_ROMAN[outline.partTitleKey], title: tp(`title.${outline.partTitleKey}`) })}</span>
        <div className="between">
          <span className="h4">{t("outline.range", { from: padChapter(outline.range.from), to: padChapter(outline.range.to) })}</span>
          <span className="meta">{outline.range.count}</span>
        </div>
      </div>
      <ul className="outline col">
        {outline.neighbours.map((n) => {
          const current = n.number === chapter.number;
          return (
            <li key={n.number}>
              <Link href={n.href} aria-current={current ? "page" : undefined}>
                <span className="n">{padChapter(n.number)}</span>
                {n.title}
              </Link>
              {current ? (
                <ul className="col outline-layers">
                  {outline.layers.map((layer) => (
                    <li key={layer.id}>
                      <Link href={layer.href} aria-current={layer.id === section.id ? "location" : undefined}>
                        <span className="n">{layer.id}</span>
                        {layer.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {signedIn && progress !== null && pathName !== null ? (
        <div className="rt col" style={{ paddingTop: 14, gap: 8 }}>
          <span className="cap">{t("outline.path")}</span>
          <div className="between small">
            <span>{pathName}</span>
            <span className="meta">{tc("of", { done: progress.done, total: progress.total })}</span>
          </div>
          <Meter value={progress.done} max={progress.total} label={tc("meterLabel", { name: pathName })} />
        </div>
      ) : null}
      <div className="rt col" style={{ paddingTop: 14, gap: 6 }}>
        <span className="cap">{t("outline.keys")}</span>
        <div className="row small muted">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> {t("keys.section")}
        </div>
        <div className="row small muted">
          <Kbd>g</Kbd>
          <Kbd>l</Kbd> {t("keys.lab")}
        </div>
        <div className="row small muted">
          <Kbd>a</Kbd> {t("keys.ask")}
        </div>
      </div>
    </aside>
  );
}
