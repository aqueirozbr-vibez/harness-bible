"use client";

import { useTranslations } from "next-intl";
import { useCallback, useRef, useState, useTransition, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { useMarkKey } from "@/lib/hooks/markKeys";
import { formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { NOTE_MAX, NOTE_NEAR, noteLength, normaliseNote } from "@/lib/marks/rules";
import { cn } from "@/lib/utils";

import type { DeleteNoteAction, SaveNoteAction } from "@/app/[lang]/ch/[n]/[section]/actions";

interface NoteEditorProps {
  readonly sectionId: string;
  readonly releaseId: string;
  readonly locale: Locale;
  readonly note: { readonly body: string; readonly updatedAt: Date } | null;
  readonly save: SaveNoteAction;
  readonly remove: DeleteNoteAction;
  /** `rail` or `inline`: the rail renders twice, one copy hidden per breakpoint. */
  readonly idPrefix: string;
}

type Flash = { readonly kind: "deleted" } | { readonly kind: "error"; readonly message: string } | null;

const ROWS = 4;

/** One note per section: explicit save, `ctrl+enter`, delete behind a confirm, key `n` (feature-specs/07 § 6.2). */
export function NoteEditor({ sectionId, releaseId, locale, note, save, remove, idPrefix }: NoteEditorProps) {
  const t = useTranslations("reader.marks");
  const [text, setText] = useState(note?.body ?? "");
  const [saved, setSaved] = useState(note);
  const [flash, setFlash] = useState<Flash>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  const length = noteLength(text);
  const over = length > NOTE_MAX;
  const dirty = normaliseNote(text) !== (saved?.body ?? "");
  const id = `${idPrefix}-note-${sectionId.replace(".", "-")}`;
  const statusId = `${id}-status`;
  const captionId = `${id}-cap`;

  const messageFor = useCallback(
    (code: string): string => {
      if (code === "UNKNOWN_SECTION") return t("error.unknownSection", { id: sectionId, release: releaseId });
      if (code === "NO_SESSION") return t("error.noSession");
      if (code === "NOTE_TOO_LONG") return t("status.tooLong", { max: NOTE_MAX });
      return t("error.failed");
    },
    [t, sectionId, releaseId],
  );

  const submit = useCallback(() => {
    if (pending || over || !dirty) return;
    setFlash(null);
    startTransition(async () => {
      const result = await save({ sectionId, body: text });
      if (!result.ok) {
        setFlash({ kind: "error", message: messageFor(result.error.code) });
        return;
      }
      setSaved(result.data.note);
      setText(result.data.note?.body ?? "");
      setFlash(result.data.note === null ? { kind: "deleted" } : null);
    });
  }, [pending, over, dirty, save, sectionId, text, messageFor]);

  const erase = useCallback(() => {
    setConfirming(false);
    if (pending) return;
    startTransition(async () => {
      const result = await remove({ sectionId });
      if (!result.ok) {
        setFlash({ kind: "error", message: messageFor(result.error.code) });
        return;
      }
      setSaved(null);
      setText("");
      setFlash({ kind: "deleted" });
    });
  }, [pending, remove, sectionId, messageFor]);

  const focusArea = useCallback(() => {
    const area = areaRef.current;
    if (area === null) return;
    area.scrollIntoView({ block: "center" });
    area.focus();
  }, []);
  useMarkKey("note", rootRef, focusArea);

  const closeConfirm = useCallback(() => setConfirming(false), []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.currentTarget.blur();
    }
  };

  let status: string;
  let statusClass = "";
  if (pending) status = t("status.saving");
  else if (flash?.kind === "error") {
    status = t("status.error", { message: flash.message });
    statusClass = "is-error";
  } else if (over) {
    status = t("status.tooLong", { max: NOTE_MAX });
    statusClass = "is-error";
  } else if (dirty) {
    status = t("status.dirty");
    statusClass = "is-dirty";
  } else if (flash?.kind === "deleted") status = t("status.deleted");
  else if (saved !== null) status = t("status.saved", { when: formatDayMonthTime(saved.updatedAt, locale) });
  else status = t("status.none");

  return (
    <section ref={rootRef} className="note-editor" aria-labelledby={captionId}>
      <Field
        label={<span id={captionId}>{t("noteLabel", { id: sectionId })}</span>}
        htmlFor={id}
        counter={t("counter", { n: length, max: NOTE_MAX })}
        counterLive={false}
        counterClassName={cn(over ? "is-over" : length >= NOTE_NEAR && "is-near")}
      >
        <textarea
          ref={areaRef}
          id={id}
          className="textarea"
          rows={ROWS}
          value={text}
          spellCheck
          aria-label={t("editorLabel", { id: sectionId })}
          aria-describedby={`${id}-count ${statusId}`}
          aria-invalid={over || undefined}
          onChange={(event) => {
            setText(event.target.value);
            if (flash !== null) setFlash(null);
          }}
          onKeyDown={onKeyDown}
        />
      </Field>
      <div className="between note-foot">
        <span className={cn("meta note-status", statusClass)} id={statusId} aria-live="polite">
          {status}
        </span>
        <span className="row gap-s2">
          {saved !== null ? (
            <Button variant="quiet" size="sm" onClick={() => setConfirming(true)} aria-haspopup="dialog" aria-expanded={confirming} disabled={pending}>
              {t("delete")}
            </Button>
          ) : null}
          <Button size="sm" onClick={submit} disabled={pending || over || !dirty}>
            {t("save")}
          </Button>
        </span>
      </div>
      <ConfirmDialog open={confirming} title={t("confirm.title", { id: sectionId })} body={t("confirm.body")} cancelLabel={t("confirm.cancel")} confirmLabel={t("confirm.confirm")} onCancel={closeConfirm} onConfirm={erase} />
    </section>
  );
}
