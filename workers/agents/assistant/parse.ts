import { AppError } from "@/lib/errors";
import { AssistantOutputSchema, MODE_RESULT_SCHEMAS, WalkResultSchema, type AssistantOutput, type Claim, type Mode } from "@/lib/schemas/assistant";
import type { FigureId, SectionId } from "@/lib/schemas/ids";
import { jsonBody, unfenced } from "@/workers/agents/unfenced";

/*
 * The output parser (feature-specs/13 § 6). The model's text is JSON by construction — the guide asks for it — so
 * this reads it, validates it, and says which claims cite something the prompt did not contain.
 *
 * A fence is not a failure. `claude-opus-5` answers the guide's "return this JSON object" with the object inside a
 * ```json block (measured 2026-10-03 on every real turn: the fenced text was valid JSON every time, and the bare parse
 * bought the repair pass on each of them, a second frontier call for nothing). `unfenced` takes the fence off before
 * the parse; what is inside it is held to the schema exactly as before. The request itself carries no output format
 * yet (`requestFor` emits only the effort), which is the stronger fix and is recorded against unit 27.
 *
 * The distinction the spec insists on: a claim that cites an id outside the prompt is **not dropped**. Dropping it
 * would hide from the reader that the model said something, and hide from the ledger that it was said. It becomes
 * an uncited claim, and the citation sensor substitutes it in one place, server side (invariant 14).
 *
 * A failure of the whole output is the agent's one cap. `parseOutput` reports it; the flow runs the repair pass
 * once with the error as the instruction, and a second failure ends as a refusal, never as raw text on a screen.
 */

export interface ParseContext {
  /** The section ids the prompt carried: a claim may cite these and nothing else. */
  readonly sections: ReadonlySet<SectionId>;
  /** Per section, the figure ids its fence listed. */
  readonly figures: ReadonlyMap<SectionId, ReadonlySet<FigureId>>;
  /** A walk turn with an aid result in the prompt: `mode_result` must then be the walk's shape (spec 18 § 4), unless the model refused. */
  readonly walk?: boolean;
  /** The request's mode: compare, lab and brief each have a `mode_result` shape of their own (spec 19 § 5), checked here unless the model refused. */
  readonly mode?: Mode;
}

/** How the repair names each shape, so a draft that missed it is told what it is. */
const MODE_RESULT_SHAPES: Readonly<Record<"compare" | "lab" | "brief", string>> = {
  compare: '{ "openPoint": "…" | null }',
  lab: '{ "reproduces": "…", "divergingMeans": "…" | null }',
  brief: '{ "decision": "…", "stance": "recommends" | "conditional" | "leaves-open", "condition": "…" | null }',
};

export interface ParsedClaim extends Claim {
  /** False when the claim cites a section the prompt did not carry, or a figure that section does not hold. */
  readonly cited: boolean;
  /** Why it is not cited, for the verdict's detail and the log. */
  readonly reason: "section-not-retrieved" | "figure-not-in-section" | null;
}

export interface ParsedOutput {
  readonly claims: ReadonlyArray<ParsedClaim>;
  readonly refusal: AssistantOutput["refusal"];
  readonly modeResult: unknown;
}

export type ParseFailure =
  | { readonly kind: "not-json"; readonly detail: string }
  | { readonly kind: "schema"; readonly detail: string };

export type ParseResult = { readonly ok: true; readonly output: ParsedOutput } | { readonly ok: false; readonly failure: ParseFailure };

/** The model's raw text in, a parsed output or the one failure the repair pass answers, out. Never throws. */
export function parseOutput(text: string, context: ParseContext): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(jsonBody(unfenced(text)));
  } catch (error: unknown) {
    return { ok: false, failure: { kind: "not-json", detail: error instanceof Error ? error.message : String(error) } };
  }

  const parsed = AssistantOutputSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`).join("; ");
    return { ok: false, failure: { kind: "schema", detail } };
  }

  const shaped = context.mode === "compare" || context.mode === "lab" || context.mode === "brief" ? context.mode : null;
  if (shaped !== null && parsed.data.refusal === null) {
    const branch = MODE_RESULT_SCHEMAS[shaped].safeParse(parsed.data.mode_result);
    if (!branch.success) {
      const detail = branch.error.issues.map((issue) => `mode_result.${issue.path.join(".") || shaped}: ${issue.message}`).join("; ");
      return { ok: false, failure: { kind: "schema", detail: `${detail} (${shaped} mode: mode_result is ${MODE_RESULT_SHAPES[shaped]})` } };
    }
  }

  if (context.walk === true && parsed.data.refusal === null) {
    /* The walk's explanations are the answer; an output without them is an output the reader cannot use, and the
       one repair is spent on it as on any other schema failure. */
    const walk = WalkResultSchema.safeParse(parsed.data.mode_result);
    if (!walk.success) {
      const detail = walk.error.issues.map((issue) => `mode_result.${issue.path.join(".") || "steps"}: ${issue.message}`).join("; ");
      return { ok: false, failure: { kind: "schema", detail: `${detail} (walk mode: mode_result is { "steps": [{ "ordinal", "explained" }] }, one per step of the <aid> result)` } };
    }
  }

  return { ok: true, output: { claims: parsed.data.claims.map((claim) => check(claim, context)), refusal: parsed.data.refusal, modeResult: parsed.data.mode_result } };
}

function check(claim: Claim, context: ParseContext): ParsedClaim {
  if (!context.sections.has(claim.sectionId)) return { ...claim, cited: false, reason: "section-not-retrieved" };
  if (claim.figureId !== null && context.figures.get(claim.sectionId)?.has(claim.figureId) !== true) {
    return { ...claim, cited: false, reason: "figure-not-in-section" };
  }
  return { ...claim, cited: true, reason: null };
}

/** The instruction the repair pass carries (§ 8): the parser's own words, so the model is told what was wrong. */
export function repairInstruction(failure: ParseFailure): string {
  return failure.kind === "not-json"
    ? `Your previous answer was not valid JSON (${failure.detail}). Answer again, as JSON matching the schema, with no prose outside it.`
    : `Your previous answer did not match the schema (${failure.detail}). Answer again, as JSON matching the schema exactly.`;
}

/** A parse failure the flow could not repair: the caller turns it into a refusal, so no raw text reaches a screen. */
export class UnparseableAnswerError extends AppError {
  constructor(failure: ParseFailure) {
    super("ASSISTANT_UNPARSEABLE", `the model's answer could not be parsed twice (${failure.kind}: ${failure.detail}); the turn ends as a refusal (feature-specs/13 § 6)`);
  }
}
