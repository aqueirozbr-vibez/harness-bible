import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { MarkRowCap, MarkRowHead } from "@/components/marks/MarkRowHead";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import type { Locale } from "@/lib/i18n/routing";
import type { BookmarkRow } from "@/lib/schemas/marks";

interface BookmarkListProps {
  readonly rows: ReadonlyArray<BookmarkRow>;
  readonly releaseId: string;
  readonly locale: Locale;
  readonly action: (formData: FormData) => Promise<void>;
}

/** Bookmarks in book order, each with a `Remove` form (feature-specs/07 § 6.4). */
export function BookmarkList({ rows, releaseId, locale, action }: BookmarkListProps) {
  const t = useTranslations("marks.bookmarks");
  const te = useTranslations("marks.empty");
  return (
    <section id="bookmarks" className="col" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel label={t("label")} meta={[{ key: "n", node: String(rows.length) }]} timestamp={t("order")} body="bare" footer={t("shown", { n: rows.length })}>
        {rows.length === 0 ? (
          <div className="inst-b">
            <Empty caption={te("bookmarks").toLowerCase().replace(/\.$/, "")}>
              <p className="ui">{te("bookmarks")}</p>
              <p className="small muted">{te("bookmarksHint")}</p>
            </Empty>
          </div>
        ) : (
          <ol className="mark-list" aria-label={t("list")}>
            {rows.map((row) => (
              <li key={row.sectionId} className="mark-row">
                <MarkRowHead row={row} />
                <div className="between">
                  <MarkRowCap row={row} releaseId={releaseId} />
                  <form action={action}>
                    <input type="hidden" name="sectionId" value={row.sectionId} />
                    <input type="hidden" name="locale" value={locale} />
                    <Button type="submit" variant="quiet" size="sm">
                      {t("remove")}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ol>
        )}
      </InstrumentPanel>
    </section>
  );
}
