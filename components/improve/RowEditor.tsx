"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FieldProblem, problemText } from "@/components/improve/FieldProblem";
import { Field } from "@/components/ui/Field";
import { useDraftAutosave } from "@/lib/hooks/draftSave";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { rowProposal, type RowFields, type RowNow } from "@/lib/improve/editors";
import type { Proposal } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

const ROW_KEYS = ["claim", "citation", "url", "doi", "verifiedOn"] as const;
type RowKey = (typeof ROW_KEYS)[number];

/** A claim and a citation are sentences, written in a short area; a link, a DOI and a date are one line each. */
const INPUT_TYPE: Readonly<Record<RowKey, "area" | "text" | "url" | "date">> = { claim: "area", citation: "area", url: "url", doi: "text", verifiedOn: "date" };

interface RowEditorProps {
  /** The draft's id, which the saves are sent to. */
  readonly id: string;
  readonly locale: Locale;
  /** The row's fields as the release has them. */
  readonly row: RowNow;
  readonly proposal: Proposal | null;
}

/**
 * A row edited (feature-specs/34 § 5, § 18; 31 § 4): each of the row's fields beside its current value, which is
 * struck through once a new one is written. An empty field keeps the row's own; the proposal holds the fields that
 * differ. A row's value is not offered: the Sources table has no column for it, and the merge refuses it (unit 50b).
 */
export function RowEditor({ id, locale, row, proposal }: RowEditorProps) {
  const t = useTranslations("improve.suggest.row");
  const tp = useTranslations("improve.suggest.problem");
  const loaded = proposal?.kind === "EDIT_ROW" ? proposal : null;
  const [fields, setFields] = useState<RowFields>({ claim: loaded?.claim ?? "", citation: loaded?.citation ?? "", url: loaded?.url ?? "", doi: loaded?.doi ?? "", verifiedOn: loaded?.verifiedOn ?? "" });
  const [touched, setTouched] = useState(false);
  const autosave = useDraftAutosave(id, proposal);
  /* A field's problem shows once the person has left it, as the autosave says it after its pause: not at every keystroke. */
  const blur = (): void => {
    setTouched(true);
    autosave.flush();
  };

  const built = rowProposal(row, fields);
  const problem = touched && built.problem !== null ? built.problem : null;
  return (
    <div className="col edit-fields">
      {ROW_KEYS.map((key) => {
        const name = t(`field.${key}`);
        const refused = problem?.field === key;
        const type = INPUT_TYPE[key];
        const lang = key === "verifiedOn" ? undefined : "en";
        const struck = fields[key].trim() !== "" && "value-before";
        const proposed = {
          id: `row-${key}`,
          value: fields[key],
          lang,
          "aria-invalid": refused || undefined,
          "aria-describedby": refused ? `row-${key}-problem` : "row-help",
          onChange: (event: { readonly target: { readonly value: string } }) => {
            const next = { ...fields, [key]: event.target.value };
            setFields(next);
            const result = rowProposal(row, next);
            autosave.change(result.proposal, result.problem === null ? null : problemText(tp, result.problem));
          },
          onBlur: blur,
        };
        return (
          <div key={key} className="col">
            <div className="row-edit-grid">
              <Field label={t("current", { field: name })} htmlFor={`row-${key}-now`}>
                {type === "area" ? (
                  <textarea id={`row-${key}-now`} className={cn("textarea row-text row-now", struck)} value={row[key] ?? ""} readOnly lang={lang} />
                ) : (
                  <input id={`row-${key}-now`} className={cn("input row-now", struck)} value={key === "verifiedOn" && row.verifiedOn !== null ? formatDate(new Date(`${row.verifiedOn}T00:00:00Z`), locale) : (row[key] ?? "")} readOnly lang={lang} />
                )}
              </Field>
              <div className="mono faint value-arrow" aria-hidden="true">
                →
              </div>
              <Field label={t("proposed", { field: name })} htmlFor={`row-${key}`}>
                {type === "area" ? <textarea {...proposed} className={cn("textarea row-text", refused && "err")} /> : <input {...proposed} type={type} className={cn("input", refused && "err")} autoComplete="off" />}
              </Field>
            </div>
            <FieldProblem id={`row-${key}-problem`} text={refused && problem !== null ? problemText(tp, problem) : null} />
          </div>
        );
      })}
      <p className="help" id="row-help">
        {t("help")}
      </p>
      <FieldProblem id="row-problem" text={problem?.field === "row" ? problemText(tp, problem) : null} />
    </div>
  );
}
