"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Field } from "@/components/ui/Field";

interface SourcePickerProps {
  /** The editor's id, which the controls' ids start with. */
  readonly id: string;
  /** The section's source text, as the book's file has it. */
  readonly source: string;
  readonly version: string;
  /** The id of the field the passage goes to, which takes the focus once it has it. */
  readonly target: string;
  /** The text selected in the source, exactly as the file has it. */
  readonly onPick: (passage: string) => void;
}

/**
 * A passage picked from the section's source text (feature-specs/34 § 5, § 18): the text in a read-only area, where a
 * selection is made by the pointer or by the keyboard, and the button that takes it. The schema sensor finds a
 * passage in the file's text (31 § 5), which a passage copied from the rendered page is not where a paragraph has a
 * link or emphasis. The field the passage goes to takes the focus, so that a screen reader reads what was taken.
 *
 * The area is not `readonly`: in Chromium that takes the keyboard's selection away with it, and a passage could then be
 * picked by the pointer alone. It says it is read-only (`aria-readonly`), refuses every edit before it is made, and
 * asks a tablet for no keyboard.
 */
export function SourcePicker({ id, source, version, target, onPick }: SourcePickerProps) {
  const t = useTranslations("improve.suggest.source");
  const area = useRef<HTMLTextAreaElement>(null);
  const [nothing, setNothing] = useState(false);
  useEffect(() => {
    const element = area.current;
    if (element === null) return;
    const refuse = (event: Event): void => event.preventDefault();
    element.addEventListener("beforeinput", refuse);
    return () => element.removeEventListener("beforeinput", refuse);
  }, []);
  const pick = (): void => {
    const element = area.current;
    if (element === null) return;
    const picked = element.value.slice(element.selectionStart, element.selectionEnd);
    setNothing(picked.trim() === "");
    if (picked.trim() === "") return;
    onPick(picked);
    document.getElementById(target)?.focus();
  };
  return (
    <div className="col source-pick">
      <Field label={t("label", { version })} htmlFor={`${id}-source`} help={t("help")}>
        <textarea
          ref={area}
          id={`${id}-source`}
          className="textarea source-text"
          value={source}
          onChange={() => undefined}
          aria-readonly="true"
          inputMode="none"
          lang="en"
          spellCheck={false}
          aria-describedby={`${id}-source-help`}
        />
      </Field>
      <div className="row source-pick-use">
        <button type="button" className="btn btn-sm" onClick={pick}>
          {t("use")}
        </button>
        <span className="help err" role="status">
          {nothing ? t("nothing") : null}
        </span>
      </div>
    </div>
  );
}
