"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FieldProblem, problemText } from "@/components/improve/FieldProblem";
import { Field } from "@/components/ui/Field";
import { useDraftAutosave } from "@/lib/hooks/draftSave";
import { restructureProposal } from "@/lib/improve/editors";
import type { Proposal } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface RestructureEditorProps {
  /** The draft's id, which the saves are sent to. */
  readonly id: string;
  readonly proposal: Proposal | null;
}

/** A restructure (feature-specs/34 § 5, § 18; 31 § 4): what changes in the section's structure, in words. It is the curator's by rule 1 (30 § 4.2), made by hand. */
export function RestructureEditor({ id, proposal }: RestructureEditorProps) {
  const t = useTranslations("improve.suggest.restructure");
  const tp = useTranslations("improve.suggest.problem");
  const loaded = proposal?.kind === "RESTRUCTURE" ? proposal : null;
  const [description, setDescription] = useState(loaded?.description ?? "");
  const [touched, setTouched] = useState(false);
  const autosave = useDraftAutosave(id, proposal);
  /* A field's problem shows once the person has left it, as the autosave says it after its pause: not at every keystroke. */
  const blur = (): void => {
    setTouched(true);
    autosave.flush();
  };
  const built = restructureProposal(description);
  const problem = touched && built.problem !== null ? built.problem : null;
  return (
    <div className="col edit-fields">
      <Field label={t("description")} htmlFor="restructure-description">
        <textarea
          id="restructure-description"
          className={cn("textarea text-field text-field-tall", problem !== null && "err")}
          value={description}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem !== null ? "restructure-problem" : undefined}
          onChange={(event) => {
            setDescription(event.target.value);
            const next = restructureProposal(event.target.value);
            autosave.change(next.proposal, next.problem === null ? null : problemText(tp, next.problem));
          }}
          onBlur={blur}
        />
      </Field>
      <FieldProblem id="restructure-problem" text={problem !== null ? problemText(tp, problem) : null} />
    </div>
  );
}
