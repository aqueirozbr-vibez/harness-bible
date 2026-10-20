"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { describedBy, FieldProblem, problemText } from "@/components/improve/FieldProblem";
import { PassageChecks } from "@/components/improve/PassageChecks";
import { SourcePicker } from "@/components/improve/SourcePicker";
import { Field } from "@/components/ui/Field";
import { useDraftAutosave } from "@/lib/hooks/draftSave";
import { checkPassage, textProposal } from "@/lib/improve/editors";
import type { Proposal } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface TextEditorProps {
  /** The draft's id, which the saves are sent to. */
  readonly id: string;
  readonly sectionId: string;
  readonly version: string;
  /** The section's source text as the draft stores it, and its figures, which a passage edit keeps out of. */
  readonly section: { readonly source: string; readonly figures: ReadonlyArray<{ readonly id: string; readonly valueText: string }> };
  readonly proposal: Proposal | null;
}

/**
 * A passage edited (feature-specs/34 § 5, § 18; 31 § 4): the passage picked from the section's source text, or written,
 * and its replacement, plain text (34 § 9). Under each, what the schema sensor will say of it at submit (31 § 5); the
 * draft is saved all the same, since the sensor decides then and a draft may be half written.
 */
export function TextEditor({ id, sectionId, version, section, proposal }: TextEditorProps) {
  const t = useTranslations("improve.suggest.text");
  const tp = useTranslations("improve.suggest.problem");
  const loaded = proposal?.kind === "EDIT_TEXT" ? proposal : null;
  const [before, setBefore] = useState(loaded?.before ?? "");
  const [after, setAfter] = useState(loaded?.after ?? "");
  const [touched, setTouched] = useState(false);
  const autosave = useDraftAutosave(id, proposal);
  /* A field's problem shows once the person has left it, as the autosave says it after its pause: not at every keystroke. */
  const blur = (): void => {
    setTouched(true);
    autosave.flush();
  };

  const save = (nextBefore: string, nextAfter: string): void => {
    const built = textProposal(nextBefore, nextAfter);
    autosave.change(built.proposal, built.problem === null ? null : problemText(tp, built.problem));
  };
  const built = textProposal(before, after);
  const problem = touched && built.problem !== null ? built.problem : null;
  const check = checkPassage(section.source, section.figures, before, after);
  const hinted = before.trim() !== "";
  return (
    <div className="col edit-fields">
      <SourcePicker
        id="text"
        source={section.source}
        version={version}
        target="text-before"
        onPick={(picked) => {
          /* A replacement not yet written starts as the passage, to be edited. */
          const nextAfter = after.trim() === "" ? picked : after;
          setBefore(picked);
          setAfter(nextAfter);
          save(picked, nextAfter);
          autosave.flush();
        }}
      />
      <div className="text-grid">
        <div className="col">
          <Field label={t("before")} htmlFor="text-before">
            <textarea
              id="text-before"
              className={cn("textarea text-field", problem?.field === "before" && "err")}
              value={before}
              lang="en"
              aria-invalid={problem?.field === "before" || undefined}
              aria-describedby={describedBy(problem?.field === "before" && "text-before-problem", hinted && "text-before-check")}
              onChange={(event) => {
                setBefore(event.target.value);
                save(event.target.value, after);
              }}
              onBlur={blur}
            />
          </Field>
          <FieldProblem id="text-before-problem" text={problem?.field === "before" ? problemText(tp, problem) : null} />
          {hinted ? <PassageChecks id="text-before-check" check={check} section={sectionId} part="passage" /> : null}
        </div>
        <div className="mono faint value-arrow" aria-hidden="true">
          →
        </div>
        <div className="col">
          <Field label={t("after")} htmlFor="text-after">
            <textarea
              id="text-after"
              className={cn("textarea text-field", problem?.field === "after" && "err")}
              value={after}
              lang="en"
              aria-invalid={problem?.field === "after" || undefined}
              aria-describedby={describedBy(problem?.field === "after" && "text-after-problem", hinted && (check.digits || check.same) && "text-after-check")}
              onChange={(event) => {
                setAfter(event.target.value);
                save(before, event.target.value);
              }}
              onBlur={blur}
            />
          </Field>
          <FieldProblem id="text-after-problem" text={problem?.field === "after" ? problemText(tp, problem) : null} />
          {hinted ? <PassageChecks id="text-after-check" check={check} section={sectionId} part="replacement" /> : null}
        </div>
      </div>
    </div>
  );
}
