"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Field } from "@/components/ui/Field";
import type { EditValue } from "@/lib/db/suggestEdit";
import { useDraftAutosave } from "@/lib/hooks/draftSave";
import { formatPercent } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { isDecimal, percentChange, printedValue } from "@/lib/improve/value";
import type { Proposal } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface ValueEditorProps {
  /** The draft's id, which the saves are sent to. */
  readonly id: string;
  readonly locale: Locale;
  readonly value: EditValue;
  /** The draft's proposal as loaded: a value set, or nothing yet. */
  readonly proposal: Proposal | null;
}

/** A proposal's unit is at most forty characters (`ValueSchema`, lib/schemas/improve.ts). */
const UNIT_MAX = 40;

/**
 * Step 2 for a figure's value (feature-specs/34 § 5; the Improve-Suggest screen's proposed change): the value now,
 * struck through and read-only, the proposed one, its unit, and the line that prints the new value as the merge will
 * with its change in percent. Every edit goes to the autosave; fields that make no proposal are not sent and say why.
 */
export function ValueEditor({ id, locale, value, proposal }: ValueEditorProps) {
  const t = useTranslations("improve.suggest.value");
  const set = proposal?.kind === "SET_VALUE" ? proposal : null;
  const [after, setAfter] = useState(set?.after ?? "");
  const [unit, setUnit] = useState(set !== null ? (set.unit ?? "") : (value.unit ?? ""));
  const [touched, setTouched] = useState(false);
  const autosave = useDraftAutosave(id, proposal);
  /* A field's problem shows once the person has left it, as the autosave says it after its pause: not at every keystroke. */
  const blur = (): void => {
    setTouched(true);
    autosave.flush();
  };

  const valid = isDecimal(after);
  const edit = (nextAfter: string, nextUnit: string): void => {
    const proposed = nextUnit.trim();
    autosave.change(isDecimal(nextAfter) ? { kind: "SET_VALUE", after: nextAfter.trim(), unit: proposed === "" ? null : proposed } : null, isDecimal(nextAfter) ? null : t("afterInvalid"));
  };

  const before = value.before ?? value.printed;
  const sameUnit = (unit.trim() === "" ? null : unit.trim()) === value.unit;
  const printed = valid && sameUnit ? printedValue(value.printed, after.trim()) : null;
  const change = valid && value.before !== null ? percentChange(value.before, after) : null;
  const showError = touched && !valid;
  return (
    <>
      <div className="value-grid">
        <Field label={t("before")} htmlFor="value-before">
          <input id="value-before" className="input mono value-before" value={before} readOnly />
        </Field>
        <div className="mono faint value-arrow" aria-hidden="true">
          →
        </div>
        <Field label={t("after")} htmlFor="value-after">
          <input
            id="value-after"
            className={cn("input mono value-after", showError && "err")}
            value={after}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={showError || undefined}
            aria-describedby={showError ? "value-after-error" : undefined}
            onChange={(event) => {
              setAfter(event.target.value);
              edit(event.target.value, unit);
            }}
            onBlur={blur}
          />
        </Field>
        <Field label={t("unit")} htmlFor="value-unit">
          <input
            id="value-unit"
            className="input mono"
            value={unit}
            maxLength={UNIT_MAX}
            autoComplete="off"
            onChange={(event) => {
              setUnit(event.target.value);
              edit(after, event.target.value);
            }}
            onBlur={blur}
          />
        </Field>
      </div>
      {showError ? (
        <p className="help err" id="value-after-error">
          {t("afterInvalid")}
        </p>
      ) : null}
      {valid ? (
        <div className="row value-line">
          <span className="meta">
            {value.printed} → <span className="d-new">{printed ?? (unit.trim() === "" ? after.trim() : `${after.trim()} ${unit.trim()}`)}</span>
          </span>
          {change !== null ? <span className="cap">{t("change", { pct: `${change < 0 ? "−" : change > 0 ? "+" : ""}${formatPercent(Math.abs(change), locale)}` })}</span> : null}
        </div>
      ) : null}
    </>
  );
}
