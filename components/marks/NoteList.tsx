import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { DeleteNoteDialog } from "@/components/marks/DeleteNoteDialog";
import { MarkRowCap, MarkRowHead } from "@/components/marks/MarkRowHead";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { NoteRow } from "@/lib/schemas/marks";

interface NoteListProps {
  readonly rows: ReadonlyArray<NoteRow>;
  readonly releaseId: string;
  readonly locale: Locale;
  readonly action: (formData: FormData) => Promise<void>;
}

/** Notes newest first, the full text, `Open` and `Delete` (feature-specs/07 § 6.4). */
export function NoteList({ rows, releaseId, locale, action }: NoteListProps) {
  const t = useTranslations("marks.notes");
  const te = useTranslations("marks.empty");
  return (
    <section id="notes" className="col" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel label={t("label")} meta={[{ key: "n", node: String(rows.length) }]} timestamp={t("order")} body="bare" footer={t("shown", { n: rows.length })}>
        {rows.length === 0 ? (
          <div className="inst-b">
            <Empty caption={te("notes").toLowerCase().replace(/\.$/, "")}>
              <p className="ui">{te("notes")}</p>
              <p className="small muted">{te("notesHint")}</p>
            </Empty>
          </div>
        ) : (
          <ol className="mark-list" aria-label={t("list")}>
            {rows.map((row) => (
              <li key={row.sectionId} className="mark-row">
                <MarkRowHead row={row} trailing={formatDayMonthTime(row.updatedAt, locale)} />
                <p className="small note-body">{row.body}</p>
                <div className="between">
                  <MarkRowCap row={row} releaseId={releaseId} />
                  <span className="row gap-s2">
                    {row.section === null ? null : (
                      <Button size="sm" href={row.href}>
                        {t("open")}
                      </Button>
                    )}
                    <DeleteNoteDialog sectionId={row.sectionId} locale={locale} action={action} />
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </InstrumentPanel>
    </section>
  );
}
