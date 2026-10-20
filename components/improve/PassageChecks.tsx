import { useTranslations } from "next-intl";

import type { PassageCheck } from "@/lib/improve/editors";

interface PassageChecksProps {
  /** The lines' id, which their field names in `aria-describedby`. */
  readonly id: string;
  readonly check: PassageCheck;
  /** The section's id, which the passage's lines name. */
  readonly section: string;
  /** Under the passage: found once, not found, found more than once, a figure in it. Under the replacement: a digit changed, nothing changed. */
  readonly part: "passage" | "replacement";
}

/** What the schema sensor will say at submit (feature-specs/31 § 5; 34 § 18), under the field it concerns; nothing under a replacement it will pass. */
export function PassageChecks({ id, check, section, part }: PassageChecksProps) {
  const t = useTranslations("improve.suggest.check");
  if (part === "replacement" && !check.digits && !check.same) return null;
  return (
    <div className="col passage-hints" id={id}>
      {part === "passage" ? (
        <>
          {check.times === 1 ? <p className="help">{t("once", { id: section })}</p> : check.times === 0 ? <p className="help err">{t("none", { id: section })}</p> : <p className="help err">{t("many", { count: check.times, id: section })}</p>}
          {check.figure !== null ? <p className="help err">{t("figure", { figure: check.figure })}</p> : null}
        </>
      ) : (
        <>
          {check.digits ? <p className="help err">{t("digits")}</p> : null}
          {check.same ? <p className="help err">{t("same")}</p> : null}
        </>
      )}
    </div>
  );
}
