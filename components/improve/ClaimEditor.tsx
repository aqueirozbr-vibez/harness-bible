"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { describedBy, FieldProblem, problemText } from "@/components/improve/FieldProblem";
import { PassageChecks } from "@/components/improve/PassageChecks";
import { SourcePicker } from "@/components/improve/SourcePicker";
import { Field } from "@/components/ui/Field";
import { useDraftAutosave } from "@/lib/hooks/draftSave";
import { checkPassage, claimProposal } from "@/lib/improve/editors";
import type { Proposal } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface ClaimEditorProps {
  /** The draft's id, which the saves are sent to. */
  readonly id: string;
  readonly sectionId: string;
  readonly version: string;
  /** The section's source text as the draft stores it, which the passage the claim follows is picked from. */
  readonly section: { readonly source: string; readonly figures: ReadonlyArray<{ readonly id: string; readonly valueText: string }> };
  readonly proposal: Proposal | null;
}

/**
 * A claim added (feature-specs/34 § 5, § 18; 31 § 4): its text, where it goes — the section's end, or after a passage
 * picked from its source text, which the sensor finds as it finds an edited one — and whether it is fast-moving, a
 * declaration the curator sees (30 § 3.4: recency is read from the anchor's own flag). A choice saves at once, as a
 * blur does.
 */
export function ClaimEditor({ id, sectionId, version, section, proposal }: ClaimEditorProps) {
  const t = useTranslations("improve.suggest.claim");
  const ts = useTranslations("improve.suggest");
  const tp = useTranslations("improve.suggest.problem");
  const loaded = proposal?.kind === "ADD_CLAIM" ? proposal : null;
  const [text, setText] = useState(loaded?.text ?? "");
  const [place, setPlace] = useState<"end" | "after">(loaded === null || loaded.placeAfter === "end" ? "end" : "after");
  const [passage, setPassage] = useState(loaded === null || loaded.placeAfter === "end" ? "" : loaded.placeAfter);
  const [fastMoving, setFastMoving] = useState(loaded?.fastMoving ?? false);
  const [touched, setTouched] = useState(false);
  const autosave = useDraftAutosave(id, proposal);
  /* A field's problem shows once the person has left it, as the autosave says it after its pause: not at every keystroke. */
  const blur = (): void => {
    setTouched(true);
    autosave.flush();
  };

  const save = (next: { readonly text?: string; readonly place?: "end" | "after"; readonly passage?: string; readonly fastMoving?: boolean }, now = false): void => {
    if (now) setTouched(true);
    const built = claimProposal(next.text ?? text, next.place ?? place, next.passage ?? passage, next.fastMoving ?? fastMoving);
    autosave.change(built.proposal, built.problem === null ? null : problemText(tp, built.problem));
    if (now) autosave.flush();
  };
  const built = claimProposal(text, place, passage, fastMoving);
  const problem = touched && built.problem !== null ? built.problem : null;
  const hinted = place === "after" && passage.trim() !== "";
  return (
    <div className="col edit-fields">
      <Field label={t("text")} htmlFor="claim-text">
        <textarea
          id="claim-text"
          className={cn("textarea text-field", problem?.field === "text" && "err")}
          value={text}
          lang="en"
          aria-invalid={problem?.field === "text" || undefined}
          aria-describedby={problem?.field === "text" ? "claim-text-problem" : undefined}
          onChange={(event) => {
            setText(event.target.value);
            save({ text: event.target.value });
          }}
          onBlur={blur}
        />
      </Field>
      <FieldProblem id="claim-text-problem" text={problem?.field === "text" ? problemText(tp, problem) : null} />
      <fieldset className="col edit-choice">
        <legend className="flabel">{t("place")}</legend>
        {(["end", "after"] as const).map((option) => (
          <label key={option} className="check">
            <input
              type="radio"
              name="claim-place"
              value={option}
              checked={place === option}
              onChange={() => {
                setPlace(option);
                save({ place: option }, true);
              }}
            />
            {t(option)}
          </label>
        ))}
      </fieldset>
      {place === "after" ? (
        <>
          <SourcePicker
            id="claim"
            source={section.source}
            version={version}
            target="claim-passage"
            onPick={(picked) => {
              setPassage(picked);
              save({ passage: picked }, true);
            }}
          />
          <Field label={t("passage")} htmlFor="claim-passage">
            <textarea
              id="claim-passage"
              className={cn("textarea text-field", problem?.field === "placeAfter" && "err")}
              value={passage}
              lang="en"
              aria-invalid={problem?.field === "placeAfter" || undefined}
              aria-describedby={describedBy(problem?.field === "placeAfter" && "claim-passage-problem", hinted && "claim-passage-check")}
              onChange={(event) => {
                setPassage(event.target.value);
                save({ passage: event.target.value });
              }}
              onBlur={blur}
            />
          </Field>
          <FieldProblem id="claim-passage-problem" text={problem?.field === "placeAfter" ? problemText(tp, problem) : null} />
          {hinted ? <PassageChecks id="claim-passage-check" check={checkPassage(section.source, section.figures, passage, null)} section={sectionId} part="passage" /> : null}
        </>
      ) : null}
      <label className="check edit-check">
        <input
          type="checkbox"
          checked={fastMoving}
          onChange={(event) => {
            setFastMoving(event.target.checked);
            save({ fastMoving: event.target.checked }, true);
          }}
        />
        {ts("fastMovingField")}
      </label>
    </div>
  );
}
