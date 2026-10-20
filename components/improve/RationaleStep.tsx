"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { useDraftAutosave } from "@/lib/hooks/draftSave";
import { dispatchDraftWords } from "@/lib/hooks/draftView";
import { countWords, RATIONALE_WORDS_MAX } from "@/lib/improve/words";
import { RATIONALE_CHARS_MAX } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface RationaleStepProps {
  /** The draft's id, which the rationale is saved to. */
  readonly id: string;
  /** As saved. */
  readonly rationale: string | null;
}

/**
 * Step 4, the rationale (feature-specs/34 § 5; unit 51e; the Improve-Suggest screen): the textarea, its help and the
 * counter `142 / 200 words` from the shared word count, which the sensor counts with too. Over 200 the counter and
 * the field turn to the error state, the help says why, and Submit waits; the server would refuse it anyway. It is
 * saved by the autosave as the proposal is, as its own field.
 */
export function RationaleStep({ id, rationale }: RationaleStepProps) {
  const t = useTranslations("improve.suggest.rationale");
  const [text, setText] = useState(rationale ?? "");
  const autosave = useDraftAutosave(id, rationale, "rationale");
  const words = countWords(text);
  const over = words > RATIONALE_WORDS_MAX;

  /* Submit, in another column, waits on the words as they stand, saved or not. */
  useEffect(() => {
    dispatchDraftWords({ words, over });
  }, [words, over]);

  return (
    <section className="col rt-s edit-step rationale-step desktop-only" aria-labelledby="edit-step-4">
      <div className="between">
        <div className="row edit-step-title">
          <span className="meta">4</span>
          <h2 className="h4" id="edit-step-4">
            {t("title")}
          </h2>
        </div>
        <span className="cap">{t("cap")}</span>
      </div>
      <div className="field">
        <label htmlFor="rationale">{t("label")}</label>
        <textarea
          id="rationale"
          className={cn("textarea rationale-text", over && "err")}
          value={text}
          aria-invalid={over || undefined}
          aria-describedby="rationale-help rationale-count"
          onChange={(event) => {
            setText(event.target.value);
            autosave.change(event.target.value, event.target.value.trim().length > RATIONALE_CHARS_MAX ? t("tooLong") : null);
          }}
          onBlur={autosave.flush}
        />
        <div className="between rationale-foot">
          <span className={cn("help", over && "err")} id="rationale-help" aria-live="polite">
            {over ? t("over", { max: RATIONALE_WORDS_MAX }) : t("help")}
          </span>
          <span className={cn("counter", over && "is-over")} id="rationale-count">
            {t("counter", { n: words, max: RATIONALE_WORDS_MAX })}
          </span>
        </div>
      </div>
    </section>
  );
}
