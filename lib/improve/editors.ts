import { MAX_BODY_BYTES } from "@/lib/api/limits";
import { digitsOf, figureIn, occurrences } from "@/lib/improve/passage";
import type { SourceTier } from "@/lib/schemas/domain";
import { ProposalSchema, type Proposal } from "@/lib/schemas/improve";

/*
 * What the suggest form's editors make of their fields (feature-specs/34 § 5; 31 § 4): a proposal `PATCH` takes, or
 * the field that keeps them from making one and why. The schema decides: every proposal is `ProposalSchema`'s parse,
 * so the form sends nothing the endpoint would refuse. And what intake's schema sensor will say of a quoted passage,
 * from its own functions (lib/improve/passage.ts), which the form shows while the draft is saved all the same: the
 * sensor decides at submit (31 § 5).
 *
 * Pure.
 */

/** The fields the editors name, by the proposal's own keys; `row` is a row edit's fields together. */
export type EditorField = "before" | "after" | "text" | "placeAfter" | "claim" | "citation" | "url" | "doi" | "verifiedOn" | "tier" | "newTier" | "description" | "row";

/** `required`: empty; `invalid`: the schema refuses it; `unchanged`: a row edit that changes nothing; `tooLong`: a body the pipeline refuses for its size. */
export type ProblemCode = "required" | "invalid" | "unchanged" | "tooLong";

export type Built = { readonly proposal: Proposal; readonly problem: null } | { readonly proposal: null; readonly problem: { readonly field: EditorField; readonly code: ProblemCode } };

const problem = (field: EditorField, code: ProblemCode): Built => ({ proposal: null, problem: { field, code } });

const FIELDS: ReadonlySet<string> = new Set<EditorField>(["before", "after", "text", "placeAfter", "claim", "citation", "url", "doi", "verifiedOn", "newTier", "description"]);

/** The field a proposal too long to save is named by: the one most likely to hold the length. */
const LONGEST: Readonly<Record<Proposal["kind"], EditorField>> = { EDIT_TEXT: "before", SET_VALUE: "after", EDIT_ROW: "claim", ADD_CLAIM: "text", ADD_ROW: "claim", RESTRUCTURE: "description" };

/** The schema's parse; its first issue names the field it refuses. A proposal over the pipeline's body limit is refused here, before it is sent: a whole long section picked as a passage, with its replacement, is (34 § 19). */
function parse(candidate: Record<string, unknown>): Built {
  const parsed = ProposalSchema.safeParse(candidate);
  if (parsed.success && new TextEncoder().encode(JSON.stringify({ proposal: parsed.data })).length > MAX_BODY_BYTES) return problem(LONGEST[parsed.data.kind], "tooLong");
  if (parsed.success) return { proposal: parsed.data, problem: null };
  const path = parsed.error.issues[0]?.path ?? [];
  const named = path.find((part): part is string => typeof part === "string" && FIELDS.has(part));
  /* A row's tier refused is its new tier's name; the refine that wants a field changed is the row's. */
  return problem(named === "newTier" || path.includes("tier") ? "newTier" : ((named as EditorField | undefined) ?? "row"), "invalid");
}

const blank = (text: string): boolean => text.trim() === "";

/** A passage edited: the passage as the section's source has it, and its replacement. */
export function textProposal(before: string, after: string): Built {
  if (blank(before)) return problem("before", "required");
  if (blank(after)) return problem("after", "required");
  return parse({ kind: "EDIT_TEXT", before, after });
}

/** A claim added: its text, at the section's end or after a passage of it, and whether it is fast-moving. */
export function claimProposal(text: string, place: "end" | "after", passage: string, fastMoving: boolean): Built {
  if (blank(text)) return problem("text", "required");
  if (place === "after" && blank(passage)) return problem("placeAfter", "required");
  return parse({ kind: "ADD_CLAIM", text, placeAfter: place === "end" ? "end" : passage, fastMoving });
}

/** A source row's fields as the release has them, which a row edit is read against. */
export interface RowNow {
  readonly claim: string;
  readonly citation: string;
  readonly url: string | null;
  readonly doi: string | null;
  /** `2026-06-16`, the day the row was last checked. */
  readonly verifiedOn: string | null;
}

/** A row edit's proposed fields; an empty one keeps the row's own. */
export type RowFields = Readonly<Record<"claim" | "citation" | "url" | "doi" | "verifiedOn", string>>;

const ROW_KEYS = ["claim", "citation", "url", "doi", "verifiedOn"] as const;

/**
 * A row edited: the fields that differ from the row's own. An empty field keeps the row's, since a suggestion cannot
 * take a row's link away (31 § 4: the fields are optional, never null), and a row's value is not a field of its
 * table, so the form does not offer it (unit 50b refuses it at the merge).
 */
export function rowProposal(now: RowNow, fields: RowFields): Built {
  const changed: Record<string, string> = {};
  for (const key of ROW_KEYS) {
    const proposed = fields[key].trim();
    if (proposed !== "" && proposed !== (now[key] ?? "")) changed[key] = proposed;
  }
  if (Object.keys(changed).length === 0) return problem("row", "unchanged");
  return parse({ kind: "EDIT_ROW", ...changed });
}

/** A new row's tier: one of the book's seven, or a new one by name, which makes the change the curator's (30 § 4.2 rule 4); null until one is chosen, since a tier is the contributor's claim and the form proposes none. */
export type RowTier = SourceTier | "NEW" | null;

export interface NewRowFields {
  readonly claim: string;
  readonly citation: string;
  readonly url: string;
  readonly doi: string;
  readonly tier: RowTier;
  readonly newTier: string;
  readonly fastMoving: boolean;
}

/** A source row added: claim and citation, a link or a DOI if there is one, its tier, and whether it is fast-moving. */
export function newRowProposal(fields: NewRowFields): Built {
  if (blank(fields.claim)) return problem("claim", "required");
  if (blank(fields.citation)) return problem("citation", "required");
  if (fields.tier === null) return problem("tier", "required");
  if (fields.tier === "NEW" && blank(fields.newTier)) return problem("newTier", "required");
  return parse({
    kind: "ADD_ROW",
    claim: fields.claim,
    citation: fields.citation,
    ...(blank(fields.url) ? {} : { url: fields.url }),
    ...(blank(fields.doi) ? {} : { doi: fields.doi }),
    tier: fields.tier === "NEW" ? { newTier: fields.newTier } : fields.tier,
    fastMoving: fields.fastMoving,
  });
}

/** A restructure: what changes, in words; a curator makes it by hand (33 § 4.3). */
export function restructureProposal(description: string): Built {
  if (blank(description)) return problem("description", "required");
  return parse({ kind: "RESTRUCTURE", description });
}

/** What the schema sensor will say of a quoted passage, before it is asked (31 § 5). */
export interface PassageCheck {
  /** How many times the passage occurs in the section's source text: intake wants one. */
  readonly times: number;
  /** For a passage edited: the figure whose number it holds, which intake refuses. */
  readonly figure: string | null;
  /** For a passage edited: whether the replacement changes a digit, which intake refuses. */
  readonly digits: boolean;
  /** For a passage edited: whether the replacement is the passage itself. */
  readonly same: boolean;
}

/**
 * The sensor's tests on the trimmed texts, as the schema leaves them: the passage found once in the source, and for a
 * passage edited, no figure in it, no digit changed, and a replacement that differs. `after` is null for a claim's
 * place, which the sensor reads for its occurrences alone.
 */
export function checkPassage(source: string, figures: ReadonlyArray<{ readonly id: string; readonly valueText: string }>, passage: string, after: string | null): PassageCheck {
  const before = passage.trim();
  const times = occurrences(source, before);
  if (after === null) return { times, figure: null, digits: false, same: false };
  const replacement = after.trim();
  return { times, figure: figureIn(before, figures), digits: replacement !== "" && digitsOf(before) !== digitsOf(replacement), same: before === replacement };
}
