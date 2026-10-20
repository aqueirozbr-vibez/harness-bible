import { BriefResultSchema, NO_COVER, type Locale, type Mode, type ResolvedClaim, type SensorVerdict } from "@/lib/schemas/assistant";
import type { FigureId } from "@/lib/schemas/ids";

/*
 * The mode sensor (feature-specs/19 § 5), pure. Compare, lab and brief change what the assistant reads and the shape
 * its answer takes; this is the check that the shape was kept, in the same form as the five sensors of spec 13:
 * `(input) => verdict`, and a claim that breaks the mode's shape is substituted exactly as an uncited one is, so
 * nothing the shape forbids reaches the screen (invariant 14).
 *
 *   compare   at least one surviving claim cites each of the two chapters, and no claim cites a third
 *   lab       every claim cites the lab's chapter, and every figure quoted is one the lab's last run checks
 *   brief     one to six claims, every one in Part III, and the mode result carries a stance
 *
 * It runs after the citation sensor, so it reads resolved claims, and before the citations are listed, so a claim
 * it rejects cites nothing. Explain and walk have no shape to keep: NA, and the flow shows no row for them (D5).
 * Everything counted here is counted in code from the claims and the context; the model's `mode_result` is checked
 * for its shape, never trusted for a count (invariant 12).
 */

export interface ModeSensorInput {
  readonly mode: Mode;
  readonly context: { readonly chapter: number | null; readonly chapters?: readonly [number, number]; readonly labId?: string };
  /** The claims as the citation sensor resolved them. */
  readonly claims: ReadonlyArray<ResolvedClaim>;
  readonly modeResult: unknown;
  /** The release's Part III, for the brief; an empty list means the part is unknown and the rule is not applied. */
  readonly briefChapters: ReadonlyArray<number>;
  /** The figures the lab's last run checks (the lastRun pseudo-section, spec 19 § 4); empty when there is no run to match against. */
  readonly labFigures: ReadonlyArray<FigureId>;
}

export interface ModeResult {
  readonly claims: ReadonlyArray<ResolvedClaim>;
  readonly verdict: SensorVerdict;
}

/** The brief's cap (guide § The five modes): the seventh claim and later are dropped, and the row says so. */
export const BRIEF_MAX_CLAIMS = 6;

/** The modes with a shape to keep: the ones whose verdicts carry the row. */
export const SHAPED_MODES: ReadonlySet<Mode> = new Set<Mode>(["compare", "lab", "brief"]);

function chapterOf(sectionId: string): number {
  return Number(sectionId.slice(0, 2));
}

function labNumberOf(context: ModeSensorInput["context"]): string {
  const fromId = context.labId === undefined ? null : /\d+$/.exec(context.labId)?.[0];
  return (fromId ?? String(context.chapter ?? 0)).padStart(2, "0");
}

function substitute(claim: ResolvedClaim, locale: Locale): ResolvedClaim {
  return { text: NO_COVER[locale], sectionId: claim.sectionId, figureId: null, valueText: null, found: false, substituted: true };
}

function verdict(value: SensorVerdict["verdict"], detail: string, data: SensorVerdict["data"] = {}): SensorVerdict {
  return { sensor: "mode", verdict: value, detail, data };
}

function compare(input: ModeSensorInput, locale: Locale): ModeResult {
  const pair = input.context.chapters;
  if (pair === undefined) return { claims: input.claims, verdict: verdict("FAIL", "compare · no chapter pair in the context") };
  const [a, b] = pair;
  let outside: number | null = null;
  const claims = input.claims.map((claim) => {
    if (claim.substituted) return claim;
    const chapter = chapterOf(claim.sectionId);
    if (chapter === a || chapter === b) return claim;
    outside ??= chapter;
    return substitute(claim, locale);
  });
  const cited = new Set(claims.filter((claim) => !claim.substituted).map((claim) => chapterOf(claim.sectionId)));
  const data = { a, b, citedA: cited.has(a), citedB: cited.has(b), replaced: claims.filter((claim) => claim.substituted).length - input.claims.filter((claim) => claim.substituted).length };
  if (outside !== null) return { claims, verdict: verdict("FAIL", `compare · cites chapter ${String(outside)}, outside the pair`, { ...data, outside }) };
  if (cited.has(a) && cited.has(b)) return { claims, verdict: verdict("PASS", "compare · both chapters cited", data) };
  if (cited.size === 0) return { claims, verdict: verdict("FAIL", "compare · neither chapter cited", data) };
  return { claims, verdict: verdict("FAIL", `compare · only chapter ${String(cited.has(a) ? a : b)} cited`, data) };
}

function lab(input: ModeSensorInput, locale: Locale): ModeResult {
  const labNumber = labNumberOf(input.context);
  /* The lab's chapter, as the turn resolved it from the lab picked (feature-specs/23 § 5.1); a lab is numbered after its chapter. */
  const chapter = input.context.chapter ?? Number(labNumber);
  const checked = new Set<string>(input.labFigures);
  let failure: string | null = null;
  const claims = input.claims.map((claim) => {
    if (claim.substituted) return claim;
    if (chapterOf(claim.sectionId) !== chapter) {
      failure ??= `lab · cites ${claim.sectionId}, outside Lab ${labNumber}'s chapter`;
      return substitute(claim, locale);
    }
    if (claim.figureId !== null && checked.size > 0 && !checked.has(claim.figureId)) {
      failure ??= `lab · quotes ${claim.figureId}, not checked by Lab ${labNumber}`;
      return substitute(claim, locale);
    }
    return claim;
  });
  const surviving = claims.filter((claim) => !claim.substituted);
  const fromRun = surviving.filter((claim) => claim.figureId !== null && checked.has(claim.figureId)).length;
  const data = { chapter, checked: checked.size, fromRun, claims: surviving.length };
  if (failure !== null) return { claims, verdict: verdict("FAIL", failure, data) };
  if (surviving.length === 0) return { claims, verdict: verdict("FAIL", "lab · no claims", data) };
  if (checked.size === 0) return { claims, verdict: verdict("PASS", `lab · ${String(surviving.length)} claim${surviving.length === 1 ? "" : "s"} in Lab ${labNumber}'s chapter, no run to match figures against`, data) };
  return { claims, verdict: verdict("PASS", `lab · ${String(fromRun)} figure${fromRun === 1 ? "" : "s"} from the run`, data) };
}

function brief(input: ModeSensorInput, locale: Locale): ModeResult {
  const part = new Set(input.briefChapters);
  const stance = BriefResultSchema.safeParse(input.modeResult);
  let outside: string | null = null;
  const resolved = input.claims.map((claim) => {
    if (claim.substituted || part.size === 0 || part.has(chapterOf(claim.sectionId))) return claim;
    outside ??= claim.sectionId;
    return substitute(claim, locale);
  });
  const total = resolved.length;
  const claims = resolved.slice(0, BRIEF_MAX_CLAIMS);
  const kept = claims.filter((claim) => !claim.substituted).length;
  const data = { claims: total, kept, dropped: total - claims.length, stance: stance.success ? stance.data.stance : "" };
  if (total === 0) return { claims, verdict: verdict("FAIL", "brief · no claims", data) };
  if (outside !== null) return { claims, verdict: verdict("FAIL", `brief · cites ${outside}, outside Part III`, data) };
  if (!stance.success) return { claims, verdict: verdict("FAIL", "brief · no stance in the mode result", data) };
  if (total > BRIEF_MAX_CLAIMS) return { claims, verdict: verdict("WARN", `brief · ${String(total)} claims, six kept`, data) };
  return { claims, verdict: verdict("PASS", `brief · ${String(kept)} of ${String(claims.length)} in Part III`, data) };
}

export function modeSensor(input: ModeSensorInput, locale: Locale): ModeResult {
  switch (input.mode) {
    case "compare":
      return compare(input, locale);
    case "lab":
      return lab(input, locale);
    case "brief":
      return brief(input, locale);
    default:
      return { claims: input.claims, verdict: verdict("NA", "n/a", { mode: input.mode }) };
  }
}
