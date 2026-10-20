"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { Locale } from "@/lib/i18n/routing";
import { QUESTION_MAX } from "@/lib/schemas/api";
import { cn } from "@/lib/utils";

/*
 * The ask form (feature-specs/16 § 5.8). One warm action on the screen, and the only one here: `Ask`. `enter`
 * inserts a newline, because a question may run several lines; `ctrl`/`⌘ + enter` submits, as the note editor does;
 * `esc` inside the field blurs it, so the next `esc` closes the dock rather than fighting the field for it.
 *
 * The 800 characters are the endpoint's cap (`QUESTION_MAX`), so the counter and the button read the same number the
 * server refuses at: nothing longer is ever posted, and nothing longer ever reaches a prompt.
 *
 * Since unit 72 the Research page's column uses it too (feature-specs/48 § 11.5): its words are a namespace's, the
 * Assistant's `assistant.dock` by default or research's `research.composer`, which holds every key read here. And it
 * can be `busy`, which is not `disabled`: while a research is under way in the conversation the field stays focusable
 * and read-only and only the submit is disabled, because a disabled field loses the focus `Start` leaves in it (§ 20).
 * A start that did not start gives its question back (`restore`): the words and their language return to the field, so
 * a refusal or a failure never loses what was typed (unit 72's review), and its form can be submitted again from the
 * error's `Retry` (`ref`), which posts the text the person can see.
 */

interface ComposerProps {
  readonly locale: Locale;
  /** The edition the answers will cite: the one retrieval reads, not the reader's interface language. */
  readonly editionLang: string;
  /**
   * What the box opens holding (feature-specs/24 § 6.2): the reader's `Ask about 21.3` writes the section into the
   * question, where it can be seen and edited, and the search page's ask action brings the query. Null opens it empty.
   */
  readonly draft?: string | null;
  /** The reader typed over the draft, or asked: the dock takes `draft` off the URL. */
  readonly onDraftUsed?: () => void;
  /** Streaming, signed out, or a conversation pinned to a superseded release. */
  readonly disabled: boolean;
  /** Set when the dock was just opened with no conversation: the reader came here to type (§ 8). */
  readonly autoFocus: boolean;
  readonly onSubmit: (text: string, language: Locale) => void;
  /** The mode's own label and example (feature-specs/19 § 3); explain's by default. */
  readonly label?: string;
  readonly placeholder?: string;
  /** Why the submit is disabled, under the field: compare without its second chapter (§ 7), research's day or budget (48 § 18). */
  readonly help?: ReactNode;
  /** Whose words the form reads (48 § 11.5): the Assistant's by default, or research's. */
  readonly namespace?: "assistant.dock" | "research.composer";
  /** A run is under way (48 § 11.3): the field read-only and focusable, the submit disabled. */
  readonly busy?: boolean;
  /** A question given back (48 § 18): each new object puts its words and language in the field; null leaves it as it is. */
  readonly restore?: { readonly text: string; readonly language: Locale } | null;
  /** The form, for a `Retry` that submits it as `Start` would. */
  readonly ref?: Ref<HTMLFormElement>;
}

export function Composer({ locale, editionLang, draft = null, onDraftUsed, disabled, autoFocus, onSubmit, label, placeholder, help, namespace = "assistant.dock", busy = false, restore = null, ref }: ComposerProps) {
  const t = useTranslations(namespace);
  const [text, setText] = useState(draft ?? "");
  const [language, setLanguage] = useState<Locale>(locale);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /* the question given back is state set while rendering, as React adjusts state to a prop: once per object */
  const [restored, setRestored] = useState(restore);
  if (restore !== restored) {
    setRestored(restore);
    if (restore !== null) {
      setText(restore.text);
      setLanguage(restore.language);
    }
  }

  useEffect(() => {
    if (!autoFocus) return;
    const area = areaRef.current;
    if (area === null) return;
    area.focus();
    /* A draft is a start, not a selection: the caret goes after it, so the next key continues the question. */
    area.setSelectionRange(area.value.length, area.value.length);
  }, [autoFocus]);

  const trimmed = text.trim();
  const over = trimmed.length > QUESTION_MAX;
  const canAsk = !disabled && !busy && trimmed.length > 0 && !over;
  const id = useId();

  const submit = (): void => {
    if (!canAsk) return;
    onSubmit(trimmed, language);
    setText("");
    onDraftUsed?.();
    /* the focus stays in the field, never on a submit that is about to wait (48 § 20): research's field is read-only meanwhile, never disabled */
    areaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      areaRef.current?.blur();
    }
  };

  return (
    <form
      ref={ref}
      className="dock-ask rt-s"
      aria-label={t("formLabel")}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field
        label={label ?? t("ask")}
        htmlFor={id}
        help={help}
        counter={t("counter", { n: trimmed.length, max: QUESTION_MAX })}
        counterLive={false}
        counterClassName={cn(over && "is-over")}
      >
        <textarea
          ref={areaRef}
          id={id}
          className="textarea dock-textarea"
          value={text}
          placeholder={placeholder ?? t("placeholder")}
          disabled={disabled}
          readOnly={busy}
          aria-describedby={help === undefined ? undefined : `${id}-help`}
          onChange={(event) => {
            setText(event.target.value);
            onDraftUsed?.();
          }}
          onKeyDown={onKeyDown}
        />
      </Field>
      <div className="row dock-ask-row">
        <label className="flabel" htmlFor={`${id}-lang`}>
          {t("language")}
        </label>
        <select className="select mono dock-lang" id={`${id}-lang`} value={language} disabled={disabled} onChange={(event) => setLanguage(event.target.value === "pt" ? "pt" : "en")}>
          <option value="en">EN</option>
          <option value="pt">PT</option>
        </select>
        <span className="help">{t("citesHelp", { edition: editionLang })}</span>
        <span className="grow" />
        <Button variant="primary" type="submit" disabled={!canAsk}>
          {t("submit")}
        </Button>
      </div>
      <span className="tex">{t("scope")}</span>
    </form>
  );
}
