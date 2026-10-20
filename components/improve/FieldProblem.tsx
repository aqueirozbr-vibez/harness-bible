import type { Built } from "@/lib/improve/editors";

type Problem = NonNullable<Built["problem"]>;

/** The fields whose refusal by the schema has words of its own; any other is the generic one. */
const INVALID_WORDED: ReadonlySet<string> = new Set(["url", "doi", "verifiedOn", "newTier"]);

/** What keeps an editor's fields from making a proposal, in the catalogue's words (`improve.suggest.problem`). */
export function problemText(t: (key: string, values?: Record<string, string | number>) => string, problem: Problem): string {
  /* A list left on its first option is not empty: it asks for a choice. */
  if (problem.code === "required" && problem.field === "tier") return t("chooseTier");
  if (problem.code === "required") return t("required", { field: t(`field.${problem.field}`) });
  if (problem.code === "unchanged") return t("unchanged");
  if (problem.code === "tooLong") return t("tooLong");
  return t(`invalid.${INVALID_WORDED.has(problem.field) ? problem.field : "other"}`);
}

/** The ids a field's description lines take, joined for `aria-describedby`; undefined when there are none. */
export function describedBy(...ids: ReadonlyArray<string | false>): string | undefined {
  const named = ids.filter((part): part is string => part !== false);
  return named.length === 0 ? undefined : named.join(" ");
}

interface FieldProblemProps {
  /** The line's id, which its field names in `aria-describedby`. */
  readonly id: string;
  /** The problem in words, or null while there is none to show. */
  readonly text: string | null;
}

/** A field's problem under it, once the person has left the field: the words the status bar shows too (feature-specs/34 § 18). */
export function FieldProblem({ id, text }: FieldProblemProps) {
  if (text === null) return null;
  return (
    <p className="help err" id={id}>
      {text}
    </p>
  );
}
