"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FieldProblem, problemText } from "@/components/improve/FieldProblem";
import { Field } from "@/components/ui/Field";
import { useDraftAutosave } from "@/lib/hooks/draftSave";
import { newRowProposal, type NewRowFields, type RowTier } from "@/lib/improve/editors";
import { SourceTierSchema } from "@/lib/schemas/domain";
import type { Proposal } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface NewRowEditorProps {
  /** The draft's id, which the saves are sent to. */
  readonly id: string;
  readonly proposal: Proposal | null;
}

/**
 * A source row added (feature-specs/34 § 5, § 18; 31 § 4): its claim and citation, a link or a DOI where there is one,
 * its tier — one of the book's seven, chosen, or a new one by name, which makes the change the curator's (30 § 4.2
 * rule 4) — and whether it is fast-moving, a declaration the curator sees (30 § 3.4). The class panel says so when
 * a new tier moves the class.
 */
export function NewRowEditor({ id, proposal }: NewRowEditorProps) {
  const t = useTranslations("improve.suggest.newRow");
  const ts = useTranslations("improve.suggest");
  const tp = useTranslations("improve.suggest.problem");
  const tt = useTranslations("search.tier");
  const loaded = proposal?.kind === "ADD_ROW" ? proposal : null;
  const [fields, setFields] = useState<NewRowFields>({
    claim: loaded?.claim ?? "",
    citation: loaded?.citation ?? "",
    url: loaded?.url ?? "",
    doi: loaded?.doi ?? "",
    tier: loaded === null ? null : typeof loaded.tier === "string" ? loaded.tier : "NEW",
    newTier: loaded !== null && typeof loaded.tier !== "string" ? loaded.tier.newTier : "",
    fastMoving: loaded?.fastMoving ?? false,
  });
  const [touched, setTouched] = useState(false);
  const autosave = useDraftAutosave(id, proposal);
  /* A field's problem shows once the person has left it, as the autosave says it after its pause: not at every keystroke. */
  const blur = (): void => {
    setTouched(true);
    autosave.flush();
  };

  const edit = (next: NewRowFields, now = false): void => {
    setFields(next);
    if (now) setTouched(true);
    const result = newRowProposal(next);
    autosave.change(result.proposal, result.problem === null ? null : problemText(tp, result.problem));
    if (now) autosave.flush();
  };
  const built = newRowProposal(fields);
  const problem = touched && built.problem !== null ? built.problem : null;
  const textField = (key: "claim" | "citation" | "url" | "doi" | "newTier", label: string, type: "area" | "text" | "url" = "text") => {
    const control = {
      id: `new-row-${key}`,
      value: fields[key],
      lang: "en",
      "aria-invalid": problem?.field === key || undefined,
      "aria-describedby": problem?.field === key ? `new-row-${key}-problem` : undefined,
      onChange: (event: { readonly target: { readonly value: string } }) => edit({ ...fields, [key]: event.target.value }),
      onBlur: blur,
    };
    return (
      <div className="col">
        <Field label={label} htmlFor={`new-row-${key}`}>
          {type === "area" ? (
            <textarea {...control} className={cn("textarea row-text", problem?.field === key && "err")} />
          ) : (
            <input {...control} type={type} className={cn("input", problem?.field === key && "err")} autoComplete="off" maxLength={key === "newTier" ? 40 : undefined} />
          )}
        </Field>
        <FieldProblem id={`new-row-${key}-problem`} text={problem?.field === key ? problemText(tp, problem) : null} />
      </div>
    );
  };
  return (
    <div className="col edit-fields">
      {textField("claim", t("claim"), "area")}
      {textField("citation", t("citation"), "area")}
      <div className="new-row-links">
        {textField("url", t("url"), "url")}
        {textField("doi", t("doi"))}
      </div>
      <div className="col">
        <Field label={t("tier")} htmlFor="new-row-tier">
          <select
            id="new-row-tier"
            className={cn("select", problem?.field === "tier" && "err")}
            value={fields.tier ?? ""}
            aria-invalid={problem?.field === "tier" || undefined}
            aria-describedby={problem?.field === "tier" ? "new-row-tier-problem" : undefined}
            onChange={(event) => edit({ ...fields, tier: event.target.value === "" ? null : (event.target.value as Exclude<RowTier, null>) }, true)}
          >
            <option value="">{t("choose")}</option>
            {SourceTierSchema.options.map((tier) => (
              <option key={tier} value={tier}>
                {tt(tier)}
              </option>
            ))}
            <option value="NEW">{t("another")}</option>
          </select>
        </Field>
        <FieldProblem id="new-row-tier-problem" text={problem?.field === "tier" ? problemText(tp, problem) : null} />
      </div>
      {fields.tier === "NEW" ? textField("newTier", t("newTier")) : null}
      <label className="check edit-check">
        <input type="checkbox" checked={fields.fastMoving} onChange={(event) => edit({ ...fields, fastMoving: event.target.checked }, true)} />
        {ts("fastMovingField")}
      </label>
    </div>
  );
}
