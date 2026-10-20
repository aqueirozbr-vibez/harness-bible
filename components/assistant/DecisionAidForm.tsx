"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { Field } from "@/components/ui/Field";
import { Seg } from "@/components/ui/Seg";
import type { InputError } from "@/lib/aids/apply";
import type { Aid } from "@/lib/aids/schema";
import { aidKey } from "@/lib/assistant/walk";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

/*
 * The walk's form in place of the composer (feature-specs/18 § 5.1): the chapter's aids as a segmented control (one
 * aid: preselected and the control hidden; none: the empty state naming the chapters that have one), the inputs grid
 * with the aid's defaults, and the one primary action, `Run at these inputs`. There is no question text: the walk's
 * user turn is the inputs.
 *
 * The values stay as the reader typed them (plain digits, `.` or `,`), because the endpoint's `checkInputs` is what
 * reads them: a word is a 422 field error under its own input, naming the range (§ 6), not a schema refusal.
 */

export const WALK_FORM_ID = "walk-form";

interface DecisionAidFormProps {
  /** Every decision aid the release has: an aid is picked for the turn, not taken from a chapter (feature-specs/24 § 5.3). */
  readonly aids: ReadonlyArray<Aid>;
  readonly locale: Locale;
  /** Signed out, a conversation pinned to a superseded release, or a turn running. */
  readonly disabled: boolean;
  readonly selected: string | null;
  readonly onSelect: (aidId: string) => void;
  /** The typed values by input key; a key with none shows the aid's default. */
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (key: string, value: string) => void;
  /** The endpoint's field errors from the last run, each under its input. */
  readonly errors: ReadonlyArray<InputError>;
  readonly onRun: (aid: Aid) => void;
}

export function DecisionAidForm({ aids, locale, disabled, selected, onSelect, values, onChange, errors, onRun }: DecisionAidFormProps) {
  const t = useTranslations("assistant.walk");
  const ta = useTranslations("aids");
  const pickId = useId();
  const aid = aids.find((candidate) => candidate.id === selected) ?? aids[0] ?? null;

  const errorText = (error: InputError, aidOf: Aid): string => {
    if (error.reason === "not_integer") return t("integer");
    if (error.reason === "not_a_number" || error.reason === "missing") return t("number");
    const input = aidOf.inputs.find((candidate) => candidate.key === error.key);
    return t("range", { min: formatNumber(input?.min ?? error.min, locale), max: formatNumber(input?.max ?? error.max, locale) });
  };

  return (
    <form
      id={WALK_FORM_ID}
      className="walk-form rt-s"
      aria-label={t("formLabel")}
      onSubmit={(event) => {
        event.preventDefault();
        if (aid !== null && !disabled) onRun(aid);
      }}
    >
      {aid === null ? (
        <Empty caption={t("pick")}>{t("none")}</Empty>
      ) : (
        <>
          {aids.length > 1 ? (
            <div className="walk-pick">
              <span className="flabel" id={pickId}>
                {t("pick")}
              </span>
              <Seg options={aids.map((candidate) => ({ value: candidate.id, label: `${candidate.section} · ${ta(aidKey(candidate, "title"))}` }))} value={aid.id} onChange={onSelect} labelledBy={pickId} />
            </div>
          ) : null}
          <div className="walk-inputs">
            {aid.inputs.map((input) => {
              const id = `${WALK_FORM_ID}-${input.key}`;
              const error = errors.find((candidate) => candidate.key === input.key);
              return (
                <Field key={input.key} label={ta(aidKey(aid, "inputs", input.labelKey))} htmlFor={id} help={t("range", { min: formatNumber(input.min, locale), max: formatNumber(input.max, locale) })} error={error === undefined ? undefined : errorText(error, aid)}>
                  <input
                    id={id}
                    className={cn("input mono", error !== undefined && "err")}
                    inputMode={input.integer ? "numeric" : "decimal"}
                    autoComplete="off"
                    value={values[input.key] ?? String(input.default)}
                    disabled={disabled}
                    aria-describedby={`${id}-help`}
                    aria-invalid={error === undefined ? undefined : true}
                    onChange={(event) => onChange(input.key, event.target.value)}
                  />
                </Field>
              );
            })}
          </div>
          <div className="row walk-form-row">
            <span className="meta">
              {aid.section} · {ta(aidKey(aid, "title")).toLowerCase()}
            </span>
            <span className="grow" />
            <Button variant="primary" type="submit" disabled={disabled}>
              {t("run")}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
