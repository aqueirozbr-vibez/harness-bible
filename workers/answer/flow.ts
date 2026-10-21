import { loadGuide, loadGuidePart, type Guide } from "@/lib/guides/load";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { limitsFor, requestFor } from "@/lib/gateway/policy";
import { citationSensor, type SensorSection } from "@/lib/sensors/citation";
import { deriveSensor, numbersOf } from "@/lib/sensors/deriveConsistency";
import { editionSensor } from "@/lib/sensors/edition";
import { modeSensor, SHAPED_MODES } from "@/lib/sensors/mode";
import { referencesOf } from "@/lib/sensors/references";
import { OT_POINTERS, scopeRules } from "@/lib/sensors/scope";
import {
  ASSISTANT_GUIDE_VERSION,
  NO_COVER,
  REFUSAL_CODES,
  WalkResultSchema,
  type AnswerRequest,
  type AnswerResult,
  type Citation,
  type RefusalCause,
  type ResolvedClaim,
  type SensorVerdict,
} from "@/lib/schemas/assistant";
import type { GatewayCall } from "@/lib/schemas/gateway";
import type { FigureId, SectionId } from "@/lib/schemas/ids";
import { assembleGrader, readGrade, repairFromGrade, unavailable, type Graded } from "@/workers/agents/grader/grade";
import { assemble, citableFigures, citableSections, type AssistantPromptInput, type PromptSection } from "@/workers/agents/assistant/assemble";
import { parseOutput, repairInstruction, type ParseFailure, type ParsedOutput } from "@/workers/agents/assistant/parse";

/*
 * The answer flow (feature-specs/13 § 9): the one place the assistant's steps are ordered, and the only file that
 * knows they are steps. It knows nothing of HTTP, SSE or rows — spec 15 owns those and calls this — and nothing of
 * the database: everything it reads arrives through `AnswerDeps`, which is what makes the whole flow testable
 * against fakes and what keeps the gateway out of the web tier.
 *
 *   scope rules                    a refusal here costs nothing: no retrieval, no model call
 *   classifier ∥ retrieval         a refusal here costs one small call and discards the retrieval
 *   assemble → draft (streamed)    the tokens go to the caller's sink as they arrive
 *   parse → citation → mode → edition   the substitution happens here, server side, once; the mode's shape too (spec 19)
 *   grader                         in its own context, and the score is computed from its criteria
 *   repair, at most once           for a low score, an unparseable answer, or a truncated one
 *   derive, walk mode only         the explanations against the numbers the script wrote (spec 18 § 4)
 *
 * Two rules the ordering exists to keep: the reader never sees a claim the sensors did not pass, because the
 * client renders the final result and not the stream; and the assistant never computes, because every number in
 * an answer had to be quoted from a figure the prompt carried.
 */

export interface AnswerSinks {
  /** Text deltas as they arrive, for spec 15's SSE. Nothing here is a citation until the result is returned. */
  readonly token: (delta: string) => void;
  /** Coarse progress for the dock's status line: `retrieving`, `drafting`, `checking`, `grading`, `repairing` (15 § 6.1). */
  readonly status: (state: "retrieving" | "drafting" | "checking" | "grading" | "repairing") => void;
  /** Why the one repair was spent, as the instruction the model is given: the caller logs it with the trace id, so a draft that keeps missing the schema is a fact and not a guess (measured on the first real walk, 2026-10-03). */
  readonly onRepair?: (instruction: string) => void;
}

export interface DraftedText {
  readonly text: string;
  readonly stopReason: string | null;
  readonly modelId: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number };
  readonly firstTokenMs: number | null;
}

export interface AnswerDeps {
  /** The sections retrieval chose, with the figures each one prints (spec 12 § 6, spec 13 § 5 slot 3). */
  readonly retrieve: (request: AnswerRequest) => Promise<ReadonlyArray<PromptSection>>;
  /** Whether every chapter the question is asked of passed verification in this release. */
  readonly chaptersVerified: (request: AnswerRequest) => Promise<boolean>;
  /** The scope classifier (`hb-small`): the cause it names, or null to proceed. A failure means proceed (D2). */
  readonly classify: (request: AnswerRequest, call: GatewayCall) => Promise<RefusalCause | null>;
  /** The draft call, streamed; the deltas reach `sinks.token` before this resolves. */
  readonly draft: (prompt: ReturnType<typeof assemble>, call: GatewayCall, sinks: AnswerSinks, extra: string | null) => Promise<DraftedText>;
  /** The grader call, unstreamed, in its own context. */
  readonly grade: (prompt: ReturnType<typeof assembleGrader>, call: GatewayCall) => Promise<string>;
  /** A section's title, for a refusal's pointers. */
  readonly titleOf: (sectionId: SectionId) => Promise<string>;
  /** The release's version for a cited section, for the edition sensor. */
  readonly versionOf: (sectionId: SectionId) => string | null;
  /** The release's Part III, for the brief's mode sensor (spec 19 § 5); absent means the part is unknown and the rule is not applied. */
  readonly briefChapters?: (request: AnswerRequest) => Promise<ReadonlyArray<number>>;
  readonly now: () => number;
  readonly guide?: Guide;
  readonly graderGuide?: Guide;
  /**
   * A sensor's run, as it happens (feature-specs/49 § 8): the scope rules once, and the citation, mode and edition
   * sensors of each pass, each timed around its pure call. The turn prints the line; the verdict's detail is not for it.
   */
  readonly onSensor?: (verdict: SensorVerdict, ms: number, facts?: SensorFacts) => void;
}

/** What a sensor's line says of its run besides the verdict: the rule and the code that decided it, and its counts. */
export interface SensorFacts {
  readonly rule?: string;
  readonly code?: string;
  readonly claims?: number;
  readonly substituted?: number;
}


function verdict(sensor: SensorVerdict["sensor"], value: SensorVerdict["verdict"], detail: string, data: SensorVerdict["data"] = {}): SensorVerdict {
  return { sensor, verdict: value, detail, data };
}

function latencyVerdict(firstTokenMs: number | null, totalMs: number): SensorVerdict {
  if (firstTokenMs === null) return verdict("latency", "NA", `complete ${(totalMs / 1000).toFixed(1)} s`, { totalMs });
  const within = firstTokenMs <= 2000;
  return verdict(
    "latency",
    within ? "PASS" : "WARN",
    `first token ${(firstTokenMs / 1000).toFixed(1)} s · complete ${(totalMs / 1000).toFixed(1)} s`,
    { firstTokenMs, totalMs },
  );
}

/** How many of the sections a question names a recompute refusal points to. */
const RECOMPUTE_POINTERS = 2;

/**
 * Where a recompute refusal sends the reader (feature-specs/23 § 5.4): the sections the question itself names, a
 * cue word's first, that the release has. Assistant 1 pointed at the section the reader was on; a conversation has
 * no such section now, and a question that names none gets a refusal with no pointer.
 */
function recomputePointers(question: string, deps: AnswerDeps): ReadonlyArray<string> {
  const references = referencesOf(question);
  return [...references.namedSections, ...references.bareSections].filter((sectionId) => deps.versionOf(sectionId) !== null).slice(0, RECOMPUTE_POINTERS);
}

/** A refusal, with the sections the reader should read instead. Costs whatever it cost to decide, and no more. */
async function refuse(
  cause: RefusalCause,
  pointerIds: ReadonlyArray<string>,
  beforeRetrieval: boolean,
  deps: AnswerDeps,
  guide: Guide,
  timings: AnswerResult["timings"],
  scopeVerdict: SensorVerdict,
): Promise<AnswerResult> {
  const pointers = await Promise.all(
    pointerIds.map(async (sectionId) => ({ sectionId: sectionId as SectionId, title: await deps.titleOf(sectionId as SectionId) })),
  );
  return {
    kind: "refusal",
    refusal: { cause, code: REFUSAL_CODES[cause], pointers, beforeRetrieval },
    claims: [],
    citations: [],
    verdicts: [
      scopeVerdict,
      verdict("citation", "NA", "no claims to check"),
      verdict("edition", "NA", "no citations to resolve"),
      verdict("grader", "NA", "not graded: the question was refused"),
      latencyVerdict(null, timings.totalMs),
    ],
    grounded: null,
    repaired: false,
    guide: { version: guide.version, sha256: guide.sha256 },
    modelId: "",
    timings,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    modeResult: null,
    uncovered: [],
    retrievedSections: [],
  };
}

/**
 * What the assistant would have said where a claim was replaced (feature-specs/40 § 4, D4): the model's own sentence,
 * which the citation sensor took out, with the section the claim named. The sensors keep one claim per claim, in
 * order; were they ever not to, nothing is paired and the gap is a count alone.
 */
function uncoveredOf(parsed: ParsedOutput, sensed: ReadonlyArray<ResolvedClaim>): ReadonlyArray<{ readonly sectionId: string | null; readonly text: string }> {
  if (parsed.claims.length !== sensed.length) return [];
  return sensed.flatMap((claim, index) => {
    const own = parsed.claims[index];
    return claim.substituted && own !== undefined && own.text.trim() !== "" ? [{ sectionId: own.sectionId ?? null, text: own.text }] : [];
  });
}

function citationsOf(claims: ReadonlyArray<ResolvedClaim>, sections: ReadonlyArray<PromptSection>): ReadonlyArray<Citation> {
  /* The first entry under an id is the section itself; a lab's pseudo-sections follow it with the same version. */
  const byId = new Map<SectionId, PromptSection["section"]>();
  for (const entry of sections) if (!byId.has(entry.section.sectionId)) byId.set(entry.section.sectionId, entry.section);
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const claim of claims) {
    if (claim.substituted) continue;
    const key = `${claim.sectionId}:${claim.figureId ?? ""}`;
    if (seen.has(key)) continue;
    const section = byId.get(claim.sectionId);
    if (section === undefined) continue;
    seen.add(key);
    citations.push({ sectionId: claim.sectionId, figureId: claim.figureId, version: section.version, editionLang: section.editionLang });
  }
  return citations;
}

/** The sections as the citation sensor reads them: a lab's README and last run merged into its section's text and figures (spec 19 § 4). */
function sensorSectionsOf(sections: ReadonlyArray<PromptSection>): ReadonlyArray<SensorSection> {
  const merged = new Map<SectionId, { text: string[]; figures: SensorSection["figures"][number][] }>();
  for (const entry of sections) {
    const got = merged.get(entry.section.sectionId) ?? { text: [], figures: [] };
    got.text.push(entry.section.text);
    got.figures.push(...entry.figures.map((figure) => ({ figureId: figure.figureId, valueText: figure.valueText })));
    merged.set(entry.section.sectionId, got);
  }
  return [...merged.entries()].map(([sectionId, got]) => ({ sectionId, text: got.text.join("\n\n"), figures: got.figures }));
}

/** The figures a lab's last run checks, from its pseudo-section, for the mode sensor (spec 19 § 5). */
function labFiguresOf(sections: ReadonlyArray<PromptSection>): ReadonlyArray<FigureId> {
  return sections.filter((entry) => entry.section.pseudo?.kind === "lastRun").flatMap((entry) => entry.figures.map((figure) => figure.figureId));
}

/**
 * One pass of the sensors over a parsed output: the substitution, the mode's shape, the citations, and the verdicts.
 * The mode sensor reads the claims the citation sensor resolved and substitutes the same way (spec 19 § 5); the
 * citations are listed after it, so a claim it rejected cites nothing. The figures a lab's last run checks come from
 * its pseudo-section (spec 19 § 4); with none, the figure rule stands down and the row says so.
 */
function runSensors(parsed: ParsedOutput, sections: ReadonlyArray<PromptSection>, request: AnswerRequest, deps: AnswerDeps, briefChapters: ReadonlyArray<number>) {
  const substitutedIn = (claims: ReadonlyArray<ResolvedClaim>) => claims.filter((claim) => claim.substituted).length;
  const citationStarted = performance.now();
  const citation = citationSensor(
    parsed.claims.map((claim) => ({ text: claim.text, sectionId: claim.sectionId, figureId: claim.cited ? claim.figureId : null })),
    sensorSectionsOf(sections),
    request.locale,
  );
  const modeStarted = performance.now();
  const mode = modeSensor({ mode: request.mode, context: request.context, claims: citation.claims, modeResult: parsed.modeResult, briefChapters, labFigures: labFiguresOf(sections) }, request.locale);
  const modeEnded = performance.now();
  const citations = citationsOf(mode.claims, sections);
  const editionStarted = performance.now();
  const edition = editionSensor(citations, request.locale, deps.versionOf);
  const editionEnded = performance.now();
  /* each sensor's own line (49 § 8): the mode's only where the mode has a shape to check, as the result's verdicts have it */
  deps.onSensor?.(citation.verdict, modeStarted - citationStarted, { claims: parsed.claims.length, substituted: substitutedIn(citation.claims) });
  if (SHAPED_MODES.has(request.mode)) deps.onSensor?.(mode.verdict, modeEnded - modeStarted, { claims: citation.claims.length, substituted: substitutedIn(mode.claims) });
  deps.onSensor?.(edition.verdict, editionEnded - editionStarted);
  return { claims: mode.claims, citation, mode, citations, edition };
}

export async function answer(request: AnswerRequest, sinks: AnswerSinks, deps: AnswerDeps): Promise<AnswerResult> {
  const t0 = deps.now();
  const guide = deps.guide ?? loadGuide("assistant", ASSISTANT_GUIDE_VERSION);
  const graderGuide = deps.graderGuide ?? loadGuidePart("assistant", ASSISTANT_GUIDE_VERSION, "grader");
  const call = (purpose: GatewayCall["purpose"], alias: GatewayCall["alias"], agent: GatewayCall["agent"]): GatewayCall => ({
    purpose,
    alias,
    agent,
    guide: { agent: "assistant", version: guide.version, sha256: guide.sha256 },
    principal: request.principal,
    traceId: request.traceId,
    ref: null,
  });

  /* A walk with the script's result in the prompt (spec 18 § 4): the reader has already run the aid at their inputs,
     so the recompute rule — which exists to send them to the aid — does not apply, and the classifier is not asked
     about a sentence the dock wrote. Every other rule stands. */
  const walking = request.mode === "walk" && request.aidResult !== null && request.aidResult !== undefined;

  /* Step 1: the rules. A refusal here has cost nothing at all. */
  const chaptersVerified = await deps.chaptersVerified(request);
  const rulesStarted = performance.now();
  const ruled = scopeRules({ question: request.question, chaptersVerified });
  const scopeMs = deps.now() - t0;
  const refusedByRule = ruled.cause !== null && !(walking && ruled.cause === "R-RECOMPUTE");
  /* the rule and the cause only where they refused: a walk's recompute rule stands down and is a pass, with no code (unit 83's review) */
  deps.onSensor?.(verdict("scope", refusedByRule ? "FAIL" : "PASS", ""), performance.now() - rulesStarted, refusedByRule ? { ...(ruled.rule === null ? {} : { rule: ruled.rule }), ...(ruled.cause === null ? {} : { code: ruled.cause }) } : {});
  if (refusedByRule && ruled.cause !== null) {
    const pointers = ruled.cause === "R-SCOPE-OT" ? OT_POINTERS : ruled.cause === "R-RECOMPUTE" ? recomputePointers(request.question, deps) : [];
    const totalMs = deps.now() - t0;
    return refuse(ruled.cause, pointers, true, deps, guide, { scopeMs, retrieveMs: 0, firstTokenMs: null, draftMs: 0, sensorsMs: 0, graderMs: 0, totalMs }, verdict("scope", "FAIL", `scope · ${ruled.cause}`, { rule: ruled.rule ?? "" }));
  }

  /* Step 2: the classifier and retrieval together (architecture § 8). A cause discards the retrieval. */
  sinks.status("retrieving");
  const retrieveStarted = deps.now();
  const [classified, sections] = await Promise.all([walking ? Promise.resolve<RefusalCause | null>(null) : deps.classify(request, call("assistant", "hb-small", "assistant.classify")), deps.retrieve(request)]);
  const retrieveMs = deps.now() - retrieveStarted;
  if (classified !== null) {
    /* The nearest sections the book does cover — except for an unverified chapter, whose refusal points at
       nothing: "then nothing from it" (the guide's rule for the cause; feature-specs/23 § 5.2). */
    const pointers = classified === "R-UNVERIFIED" ? [] : sections.slice(0, 2).map((entry) => entry.section.sectionId);
    const totalMs = deps.now() - t0;
    return refuse(classified, pointers, true, deps, guide, { scopeMs, retrieveMs, firstTokenMs: null, draftMs: 0, sensorsMs: 0, graderMs: 0, totalMs }, verdict("scope", "FAIL", `scope · ${classified}`, { classifier: true }));
  }

  /* Step 3: the draft, streamed. */
  sinks.status("drafting");
  const promptInput: AssistantPromptInput = {
    guide,
    releaseId: request.releaseId,
    sections,
    conversation: request.conversation,
    question: request.question,
    mode: request.mode,
    locale: request.locale,
    aidResult: request.aidResult,
  };
  const prompt = assemble(promptInput);
  const draftStarted = deps.now();
  let drafted = await deps.draft(prompt, call("assistant", "hb-frontier", "assistant.draft"), sinks, null);
  let draftMs = deps.now() - draftStarted;

  /* A walk with a result in the prompt holds the output to the walk's shape as well (spec 18 § 4); compare, lab and
     brief each to theirs (spec 19 § 5). */
  const context = { sections: citableSections(promptInput), figures: citableFigures(promptInput), walk: walking, mode: request.mode };
  const briefChapters = request.mode === "brief" && deps.briefChapters !== undefined ? await deps.briefChapters(request) : [];
  let parsedResult = parseOutput(drafted.text, context);

  /* Step 4: the sensors, then the grader; then at most one repair (invariant 15). */
  let repaired = false;
  let graded: Graded = unavailable("not graded");
  let sensorsMs = 0;
  let graderMs = 0;

  const gradeNow = async (claims: ReadonlyArray<ResolvedClaim>): Promise<Graded> => {
    sinks.status("grading");
    const graderStarted = deps.now();
    try {
      const text = await deps.grade(assembleGrader({ guide: graderGuide, sections, claims }), call("grading", "hb-frontier", "assistant.grade"));
      return readGrade(text);
    } catch (error: unknown) {
      if (error instanceof BudgetExceededError) throw error;
      return unavailable(error instanceof GatewayUnavailableError ? `not graded: ${error.cause}` : "not graded: the grader failed");
    } finally {
      graderMs += deps.now() - graderStarted;
    }
  };

  const repairWith = async (instruction: string): Promise<void> => {
    sinks.status("repairing");
    sinks.onRepair?.(instruction);
    repaired = true;
    const started = deps.now();
    const repairedDraft = await deps.draft(prompt, call("assistant", "hb-frontier", "assistant.repair"), { ...sinks, token: () => undefined }, instruction);
    /* The reader saw the first draft's first token; a repair is not streamed and has none of its own. The time the
       latency sensor judges is the one the reader waited (measured lost on every repaired turn, 2026-10-03). */
    drafted = { ...repairedDraft, firstTokenMs: drafted.firstTokenMs ?? repairedDraft.firstTokenMs };
    draftMs += deps.now() - started;
    parsedResult = parseOutput(drafted.text, context);
  };

  /* An unparseable answer, or one the model ran out of room for, is repaired before anything is measured. */
  if (!parsedResult.ok) {
    await repairWith(repairInstruction(parsedResult.failure));
  } else if (drafted.stopReason === "max_tokens") {
    await repairWith("Your previous answer was cut off by the length limit. Answer again, within it.");
  }

  if (!parsedResult.ok) {
    /* Twice unparseable: the reader gets a refusal, never raw text (§ 6). */
    const failure: ParseFailure = parsedResult.failure;
    const totalMs = deps.now() - t0;
    const result = await refuse("R-SCOPE", sections.slice(0, 2).map((entry) => entry.section.sectionId), false, deps, guide, { scopeMs, retrieveMs, firstTokenMs: drafted.firstTokenMs, draftMs, sensorsMs, graderMs, totalMs }, verdict("scope", "WARN", "in corpus · the answer could not be read", { failure: failure.kind }));
    return { ...result, repaired, modelId: drafted.modelId, usage: drafted.usage };
  }

  sinks.status("checking");
  const sensorsStarted = deps.now();
  let sensed = runSensors(parsedResult.output, sections, request, deps, briefChapters);
  sensorsMs += deps.now() - sensorsStarted;

  /* The grader reads the claims the sensors passed. On a walk the claims are not the content — the explanations are,
     and the derive sensor holds them — so there the grader reads what was cited and never buys the repair (spec 18
     § 4; measured 2026-10-03: a walk whose four claims were all replaced bought a grader repair for nothing). */
  const gradable = walking ? sensed.claims.filter((claim) => !claim.substituted) : sensed.claims;
  graded = walking && gradable.length === 0 ? unavailable("not graded: a walk's explanations are checked by the derive sensor") : await gradeNow(gradable);

  /* A low score earns the one repair, unless it was already spent. */
  if (graded.grounded !== null && graded.verdict.verdict === "FAIL" && !repaired && !walking) {
    await repairWith(repairFromGrade(graded));
    if (parsedResult.ok) {
      const again = deps.now();
      sensed = runSensors(parsedResult.output, sections, request, deps, briefChapters);
      sensorsMs += deps.now() - again;
      graded = await gradeNow(walking ? sensed.claims.filter((claim) => !claim.substituted) : sensed.claims);
    }
  }

  const substituted = sensed.claims.filter((claim) => claim.substituted).length;
  /* The mode row stands on the modes that have a shape to keep; explain and walk keep their five (spec 19 D5). */
  const modeVerdicts: SensorVerdict[] = SHAPED_MODES.has(request.mode) ? [sensed.mode.verdict] : [];
  const scope = verdict(
    "scope",
    substituted === 0 ? "PASS" : "WARN",
    substituted === 0 ? "in corpus" : `in corpus · ${String(substituted)} claim${substituted === 1 ? "" : "s"} out of scope, replaced`,
    { substituted },
  );

  /* The walk's own sensor (spec 18 § 4): every number an explanation quotes must be one the fenced result carries,
     or the explanation is withheld and the step's values stand alone. Its verdict goes first on a walk turn. */
  let modeResult: unknown = parsedResult.output.modeResult;
  const walkVerdicts: SensorVerdict[] = [];
  if (walking) {
    const walk = WalkResultSchema.safeParse(parsedResult.output.modeResult);
    if (walk.success) {
      const deriveStarted = deps.now();
      const checked = deriveSensor(
        walk.data.steps.map((step) => ({ ordinal: step.ordinal, text: step.explained })),
        numbersOf(request.aidResult),
        request.locale,
      );
      sensorsMs += deps.now() - deriveStarted;
      walkVerdicts.push(checked.verdict);
      modeResult = { steps: checked.explanations.map((explanation) => ({ ordinal: explanation.ordinal, explained: explanation.text, withheld: explanation.withheld })) };
    }
  }

  const totalMs = deps.now() - t0;
  return {
    kind: "answer",
    refusal: null,
    claims: sensed.claims,
    citations: sensed.citations,
    verdicts: [...walkVerdicts, scope, sensed.citation.verdict, ...modeVerdicts, sensed.edition.verdict, graded.verdict, latencyVerdict(drafted.firstTokenMs, totalMs)],
    grounded: graded.grounded,
    repaired,
    guide: { version: guide.version, sha256: guide.sha256 },
    modelId: drafted.modelId,
    timings: { scopeMs, retrieveMs, firstTokenMs: drafted.firstTokenMs, draftMs, sensorsMs, graderMs, totalMs },
    usage: drafted.usage,
    modeResult,
    uncovered: uncoveredOf(parsedResult.output, sensed.claims),
    retrievedSections: [...new Set(sections.map((entry) => entry.section.sectionId))],
  };
}

/** The request policy the draft and the grader use, so spec 15's caller does not repeat the table (spec 11 § 5.3). */
export const DRAFT_REQUEST = requestFor("assistantDraft");
export const REPAIR_REQUEST = requestFor("assistantRepair");
export const GRADER_REQUEST = requestFor("groundingGrader");
export const DRAFT_LIMITS = limitsFor("assistant", "hb-frontier");
export const GRADER_LIMITS = limitsFor("grading", "hb-frontier");

/** The sentence a substituted claim carries, re-exported so spec 15 and the dock never spell it a second time. */
export { NO_COVER };
