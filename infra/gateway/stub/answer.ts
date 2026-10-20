import { createHash } from "node:crypto";

import { z } from "zod";

import { costOf, type ModelPrice, type Usage } from "@/lib/gateway/prices";
import { imageDimensions, PROVIDER_IMAGE_BASE64_MAX } from "@/lib/improve/media";
import { REFUSAL_CAUSES } from "@/lib/schemas/golden";

/*
 * The stub gateway's answers (feature-specs/11 § 4): deterministic from the request, never from a model. Pure: the
 * server hands a parsed request in and writes the result out. A request that carries fenced retrieved sections
 * (spec 13 § 5, the `<section …>` fence with its `figures:` line) gets a structured answer whose claims cite those
 * sections, and the figure the question names in quotation marks when a section holds it, so the citation sensor
 * has something true to check, and something false when `x-hb-stub-claim: uncited` adds one claim its section does
 * not support (the gate's P2.3, feature-specs/22 § 3); a scope-classification request (`hb-small`, the
 * cause codes in the prompt) gets the cause named in the `x-hb-stub-cause` header or `none`; any other request
 * gets the fixed echo object. Usage is character counts (four characters to a token, D: rules § 4.3), and the
 * cached prefix is the system blocks up to the last `cache_control` breakpoint. Prices are the application's
 * table (lib/gateway/prices.ts, spec § 3.2), the stub's stand-in for LiteLLM's cost map.
 *
 * Since unit 49f (feature-specs/32 § 9) the stub knows the provider's `document` and `image` blocks as the Messages
 * API documents them, and refuses one of another shape with the provider's 400: base64 data with no newlines, a PDF
 * as `application/pdf`, an image as one of the four image types and at most 10 MB of base64. It takes a base64
 * source only, which is stricter than the provider: a `url` source would have the provider open a URL a stranger
 * chose, which only the product's own fetcher may do (invariant 34), so a suite that sent one would fail here. The
 * system prompt takes text blocks only, as the provider's does. A media block costs tokens by the stub's own rule
 * (`mediaTokensOf`), which reads an image's header and no PDF page.
 */

const CHARACTERS_PER_TOKEN = 4;
/** The text deltas of a streamed answer are this long (spec § 4: the stream is exercised, its content is not modelled). */
export const STREAM_CHUNK_CHARACTERS = 24;

const CacheControlSchema = z.looseObject({ type: z.string() });
const TextBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControlSchema.optional(),
});

/** Base64 as the provider takes it: the standard alphabet, padded to a multiple of four, no newline (Messages API; 32 § 9). */
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]*={0,2}$/;
const Base64DataSchema = z
  .string()
  .min(1, "data is empty")
  .refine((data) => data.length % 4 === 0 && BASE64_CHARACTERS.test(data), "data must be base64 with no newlines");

/** The image types the provider reads (vision: "JPEG, PNG, GIF, and WebP"). */
export const STUB_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

const ImageBlockSchema = z.strictObject({
  type: z.literal("image"),
  source: z.strictObject({
    type: z.literal("base64"),
    media_type: z.enum(STUB_IMAGE_TYPES),
    data: Base64DataSchema.refine((data) => data.length <= PROVIDER_IMAGE_BASE64_MAX, "image exceeds 10 MB maximum (base64-encoded)"),
  }),
  cache_control: CacheControlSchema.optional(),
  transformations: z.looseObject({}).optional(),
});

const DocumentBlockSchema = z.strictObject({
  type: z.literal("document"),
  source: z.strictObject({ type: z.literal("base64"), media_type: z.literal("application/pdf"), data: Base64DataSchema }),
  title: z.string().optional(),
  context: z.string().optional(),
  citations: z.looseObject({}).optional(),
  cache_control: CacheControlSchema.optional(),
});

/** Any other block the stub does not read (tool results and the like); a block that says it is an image or a document must be one. */
const OtherBlockSchema = z.looseObject({ type: z.string().refine((type) => type !== "image" && type !== "document", "an image or a document block of a shape the provider refuses") });
const BlockSchema = z.union([TextBlockSchema, ImageBlockSchema, DocumentBlockSchema, OtherBlockSchema]);
const ContentSchema = z.union([z.string(), z.array(BlockSchema)]);
/** The provider's `system` is a string or text blocks (SDK `system?: string | Array<TextBlockParam>`). */
const SystemSchema = z.union([z.string(), z.array(TextBlockSchema)]);

/** A tool on the request, by type: the stub knows the provider's two web tools (research.ts) and refuses a client tool. */
const ToolSchema = z.looseObject({ type: z.string().min(1).optional(), name: z.string().optional(), max_uses: z.number().int().positive().optional() });

/** The part of the Anthropic Messages request the stub reads; everything else passes unread. */
export const StubRequestSchema = z.looseObject({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  system: SystemSchema.optional(),
  messages: z.array(z.looseObject({ role: z.enum(["user", "assistant"]), content: ContentSchema })).min(1),
  stream: z.boolean().optional(),
  tools: z.array(ToolSchema).optional(),
});
export type StubRequest = z.infer<typeof StubRequestSchema>;

/** `count_tokens` takes the same body without `max_tokens` and `stream`. */
export const CountTokensRequestSchema = z.looseObject({
  model: z.string().min(1),
  system: SystemSchema.optional(),
  messages: z.array(z.looseObject({ role: z.enum(["user", "assistant"]), content: ContentSchema })).min(1),
});

export const STUB_CAUSES = [...REFUSAL_CAUSES, "none"] as const;
export type StubCause = (typeof STUB_CAUSES)[number];
export const StubCauseSchema = z.enum(STUB_CAUSES);

/**
 * The provider's refusal categories (`RefusalStopDetails.category` of the Messages API): the value of
 * `x-hb-stub-refusal`, which makes the stub answer 200 with `stop_reason: "refusal"` so the client's
 * `ProviderRefusalError` is testable on both paths (spec § 5.2).
 */
export const REFUSAL_CATEGORIES = ["cyber", "bio", "frontier_llm", "reasoning_extraction", "general_harms"] as const;
export const StubRefusalSchema = z.enum(REFUSAL_CATEGORIES);
export type StubRefusalCategory = (typeof REFUSAL_CATEGORIES)[number];

export interface FenceFigure {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}
export type StubMode = "explain" | "compare" | "walk" | "lab" | "brief";

export interface FencedSection {
  /** A lab pseudo-section's `cite` attribute (spec 19 § 4): the section its claims cite. */
  readonly citeAs: string | null;
  readonly id: string;
  readonly text: string;
  readonly figures: ReadonlyArray<FenceFigure>;
}

export type AnswerKind = "assistant" | "classification" | "grading" | "adjudication" | "planning" | "writing" | "echo";

export interface StubAnswer {
  readonly kind: AnswerKind;
  readonly text: string;
  readonly usage: Usage;
  /** sha256 of the cacheable prefix, or null when the request carries no `cache_control` breakpoint in `system`. */
  readonly prefixSha256: string | null;
  readonly costUsd: number;
}

function textsOf(content: z.infer<typeof ContentSchema> | z.infer<typeof SystemSchema>): ReadonlyArray<string> {
  if (typeof content === "string") return [content];
  return content.flatMap((block) => (block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []));
}

/** Every text the request carries, system first, in order. */
export function requestText(request: Pick<StubRequest, "system" | "messages">): string {
  const system = request.system === undefined ? [] : textsOf(request.system);
  const messages = request.messages.flatMap((message) => textsOf(message.content));
  return [...system, ...messages].join("\n");
}

/** Character count to tokens: four characters to a token, never below one (D: rules § 4.3). */
export function tokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARACTERS_PER_TOKEN));
}

/*
 * What a media block costs on the stub (unit 49f): an image by the provider's documented formula on Haiku 4.5's
 * standard tier, ⌈width / 28⌉ × ⌈height / 28⌉ visual tokens, at most 1,568 (larger images are downscaled first),
 * read from the image's header, and the most when the header does not read; a PDF as one page at the top of the
 * documented "1,500–3,000 tokens per page" of text plus a page image at the visual tokens' most. The stub reads no
 * page and decodes no pixel: this is its stand-in, stated as its own.
 */
const PATCH_PIXELS = 28;
const VISUAL_TOKENS_MAX = 1568;
const PDF_PAGE_TEXT_TOKENS = 3000;

export function imageTokensOf(data: string): number {
  const dimensions = imageDimensions(Buffer.from(data, "base64"));
  if (dimensions === null) return VISUAL_TOKENS_MAX;
  return Math.min(VISUAL_TOKENS_MAX, Math.ceil(dimensions.width / PATCH_PIXELS) * Math.ceil(dimensions.height / PATCH_PIXELS));
}

/** Every media block's tokens in the request's messages, by the rule above. */
export function mediaTokensOf(request: Pick<StubRequest, "messages">): number {
  let tokens = 0;
  for (const message of request.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image" && "source" in block && typeof block.source === "object" && block.source !== null && "data" in block.source) tokens += imageTokensOf(String(block.source.data));
      else if (block.type === "document") tokens += PDF_PAGE_TEXT_TOKENS + VISUAL_TOKENS_MAX;
    }
  }
  return tokens;
}

/** The system blocks up to and including the last one that carries `cache_control`; null without a breakpoint. */
export function cacheablePrefix(request: Pick<StubRequest, "system">): string | null {
  if (request.system === undefined || typeof request.system === "string") return null;
  let last = -1;
  request.system.forEach((block, index) => {
    if ("cache_control" in block && block.cache_control !== undefined) last = index;
  });
  if (last < 0) return null;
  return textsOf(request.system.slice(0, last + 1)).join("\n");
}

const SECTION_FENCE = /<section id="([^"]+)"([^>]*)>([\s\S]*?)<\/section>/g;
const CITE_ATTR = /\scite="([^"]+)"/;
const MODE_LINE = /· mode (explain|compare|walk|lab|brief) ·/;
const FIGURE_ITEM = /^(F-\d{2}-\d{2,3}) "([^"]*)" (.+?) \([^)]*\)$/;
const QUESTION_FENCE = /<question>\n([\s\S]*?)\n<\/question>/g;

/** The retrieved sections the assembler fenced (spec 13 § 5 item 3), with their figure lines parsed. */
export function fencedSections(text: string): ReadonlyArray<FencedSection> {
  return [...text.matchAll(SECTION_FENCE)].map((match) => {
    const citeAs = CITE_ATTR.exec(match[2] ?? "")?.[1] ?? null;
    const lines = (match[3] ?? "").trim().split("\n");
    const figureLine = lines.findIndex((line) => line.startsWith("figures: "));
    const body = (figureLine < 0 ? lines : lines.slice(0, figureLine)).join("\n").trim();
    const figures =
      figureLine < 0
        ? []
        : lines[figureLine]
            .slice("figures: ".length)
            .split("; ")
            .flatMap((item) => {
              const parsed = FIGURE_ITEM.exec(item.trim());
              return parsed === null ? [] : [{ id: parsed[1], label: parsed[2], value: parsed[3] }];
            });
    return { id: match[1] ?? "", citeAs, text: body, figures };
  });
}

/** The reader's question as the assembler fences it (spec 13 § 5 slot 6): the last fence, which is the turn being answered. */
export function fencedQuestion(text: string): string | null {
  return [...text.matchAll(QUESTION_FENCE)].at(-1)?.[1] ?? null;
}

/** The mode the assembler's line names, or explain when the request carries none. */
export function modeOf(text: string): StubMode {
  return (MODE_LINE.exec(text)?.[1] as StubMode | undefined) ?? "explain";
}

/** The deterministic `mode_result` of each shaped mode (spec 19 § 5); the walk's comes from its fence. */
export function modeResultFor(mode: StubMode, sections: ReadonlyArray<FencedSection>): unknown {
  if (mode === "compare") return { openPoint: null };
  if (mode === "lab") {
    const readme = sections.find((section) => section.id.endsWith(":readme"));
    /* Inside the schema's 240 characters (lib/schemas/assistant.ts `LabResultSchema`): a real README's first sentence
       can run longer, and a stub that answers outside the schema is a stub that tests the repair and nothing else. */
    const reproduces = readme === undefined ? "" : firstSentence(readme.text.split("\n").slice(1).join(" ")).slice(0, 240).trimEnd();
    return { reproduces: reproduces.length > 0 ? reproduces : "What the chapter derives.", divergingMeans: null };
  }
  if (mode === "brief") return { decision: "the decision the question names", stance: "conditional", condition: "under the conditions Part III states" };
  return null;
}

/** The first sentence of a fenced body, the claim a section without figures gets. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

interface Claim {
  readonly text: string;
  readonly sectionId: string;
  readonly figureId?: string;
}

/**
 * One claim per section in rank order, quoting a figure of the section as printed when it has one: the figure whose
 * label the question quotes (`"expected work redone"`), which is what an answer to a question about a named figure
 * cites, else the section's first. A pseudo-section cites as its `cite`. In lab mode only the run's fence quotes a
 * figure (spec 19 § 5: a quoted figure must be one the lab checks), which is what a compliant answer does.
 */
export function claimsFor(sections: ReadonlyArray<FencedSection>, mode: StubMode = "explain", question: string | null = null): ReadonlyArray<Claim> {
  return sections.map((section) => {
    const sectionId = section.citeAs ?? section.id;
    const named = question === null ? undefined : section.figures.find((candidate) => candidate.label.length > 0 && question.includes(`"${candidate.label}"`));
    const figure = mode === "lab" && section.citeAs === null ? undefined : (named ?? section.figures[0]);
    if (figure !== undefined) {
      return { text: `${figure.label}: ${figure.value} (${sectionId}).`, sectionId, figureId: figure.id };
    }
    const sentence = firstSentence(section.text);
    return { text: sentence.length > 0 ? sentence : `Section ${sectionId}.`, sectionId };
  });
}

/**
 * A scope-classification request (spec 13 § 4.1): the small alias with the cause codes in its instruction. The
 * fixed prompt of `gateway:check` names no cause, so it falls through to the echo.
 */
export function isClassification(alias: string, smallAlias: string, text: string): boolean {
  return alias === smallAlias && text.includes("R-SCOPE");
}

/**
 * An evidence-grading request (feature-specs/32 § 7; unit 49d): the small alias with an evidence fence in its
 * message. The stub knows nothing of the document, so it answers the lowest tier unless `x-hb-stub-grade` names
 * one (B to G), or names a failure for the parser to refuse.
 */
export function isGrading(alias: string, smallAlias: string, text: string): boolean {
  return alias === smallAlias && text.includes("<evidence ");
}

/**
 * An adjudication (feature-specs/33 § 5; unit 50d): the frontier alias with the adjudicator's arithmetic line and a
 * fenced proposal in its message.
 */
export function isAdjudication(alias: string, smallAlias: string, text: string): boolean {
  return alias !== smallAlias && text.includes("\narithmetic: score ") && text.includes("<proposal>");
}

/** The answer's kind from the request alone. */
export function answerKind(alias: string, smallAlias: string, text: string, sections: ReadonlyArray<FencedSection>): AnswerKind {
  if (isClassification(alias, smallAlias, text)) return "classification";
  if (isGrading(alias, smallAlias, text)) return "grading";
  if (isAdjudication(alias, smallAlias, text)) return "adjudication";
  if (sections.length > 0) return "assistant";
  return "echo";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const AID_FENCE = /<aid>\n([\s\S]*?)\n<\/aid>/;

/** The walk's fenced result as the assembler writes it (spec 18 § 4 step 6; `lib/aids/turn.ts` `aidResultForPrompt`). */
export interface FencedAid {
  readonly steps: ReadonlyArray<{
    readonly step: number;
    readonly line: number | null;
    readonly values: Readonly<Record<string, unknown>>;
    readonly headline: { readonly kind: "value"; readonly value: number; readonly unit: string | null } | { readonly kind: "ratio"; readonly times: number } | { readonly kind: "pct"; readonly percent: number } | null;
  }>;
}

export function fencedAid(text: string): FencedAid | null {
  const match = AID_FENCE.exec(text);
  if (match === null) return null;
  try {
    const parsed = JSON.parse(match[1]) as { steps?: unknown };
    return Array.isArray(parsed.steps) ? (parsed as FencedAid) : null;
  } catch {
    return null;
  }
}

function headlineText(headline: FencedAid["steps"][number]["headline"]): string {
  if (headline === null) return "";
  if (headline.kind === "ratio") return `, a ratio of ${String(headline.times)}×`;
  if (headline.kind === "pct") return `, that is ${String(headline.percent)}%`;
  return `, that is ${String(headline.value)}${headline.unit === null ? "" : ` ${headline.unit}`}`;
}

/**
 * The walk's `mode_result` (spec 18 § 4): one explanation per fenced step, quoting the step's values as the fence
 * carries them and naming the derive line. `invent` makes the second step quote a number the script did not write,
 * which is what the derive sensor exists to withhold (§ 12.4).
 */
export function walkResult(aid: FencedAid, invent: boolean): { readonly steps: ReadonlyArray<{ readonly ordinal: number; readonly explained: string }> } {
  return {
    steps: aid.steps.map((step, index) => {
      const pairs = Object.entries(step.values)
        .filter(([, value]) => typeof value === "number")
        .map(([key, value]) => `${key} ${String(value)}`);
      const line = step.line === null ? "" : ` (derive L${String(step.line)})`;
      const body = pairs.length === 0 ? "This step takes the inputs as given." : `Step ${String(step.step)} shows ${pairs.join(", ")}${headlineText(step.headline)}${line}.`;
      return { ordinal: step.step, explained: invent && index === 1 ? `${body} That makes it 42× cheaper.` : body };
    }),
  };
}

/**
 * The claim `x-hb-stub-claim: uncited` adds: a sentence that cites the first fenced section and shares no word with
 * any section of the book, which is what the citation sensor exists to replace (feature-specs/13 D5).
 */
export const UNCITED_CLAIM = "Quokkas yodel zestfully.";
export const STUB_CLAIMS = ["uncited"] as const;
export type StubClaim = (typeof STUB_CLAIMS)[number];

/**
 * What the stub's evidence grader answers (`x-hb-stub-grade`): a tier the grader may give, or one of four outputs
 * the parser must refuse — a key it may not have, tier A, a 31-word reason, text that is not JSON. Without the
 * header, `G`: the stub cannot read a document, and the lowest tier is the honest default.
 */
export const STUB_GRADES = ["B", "C", "D", "E", "F", "G", "unknown-key", "tier-a", "long-reason", "not-json"] as const;
export type StubGrade = (typeof STUB_GRADES)[number];
export const STUB_GRADE_REASON = "answered by the stub gateway";

/**
 * The classifications the stub's grader answers beside its tier (spec 33 § 8: "a tier and classifications chosen by a
 * header the fixture sets"): `x-hb-stub-grade: B:direct:none`. A tier alone is `partial` and `none`, as before.
 */
export interface StubClassifications {
  readonly relevance: "direct" | "partial" | "tangential";
  readonly stake: "none" | "vendor" | "employer";
}

const UNCLASSIFIED: StubClassifications = { relevance: "partial", stake: "none" };
const CLASSIFIED_GRADE = /^([B-G]):(direct|partial|tangential):(none|vendor|employer)$/;

/** The grade header's value: one of `STUB_GRADES`, or a tier with its classifications; null for anything else. */
export function parseStubGrade(value: string): { readonly grade: StubGrade; readonly classes: StubClassifications } | null {
  if ((STUB_GRADES as ReadonlyArray<string>).includes(value)) return { grade: value as StubGrade, classes: UNCLASSIFIED };
  const m = CLASSIFIED_GRADE.exec(value);
  if (m === null) return null;
  return { grade: m[1] as StubGrade, classes: { relevance: m[2] as StubClassifications["relevance"], stake: m[3] as StubClassifications["stake"] } };
}

export function gradingOutput(grade: StubGrade, classes: StubClassifications = UNCLASSIFIED): string {
  const base = { relevance: classes.relevance, stake: classes.stake, publishedOn: null, reason: STUB_GRADE_REASON };
  switch (grade) {
    case "unknown-key":
      return JSON.stringify({ tier: "B", ...base, score: 85 });
    case "tier-a":
      return JSON.stringify({ tier: "A", ...base });
    case "long-reason":
      return JSON.stringify({ tier: "B", ...base, reason: Array.from({ length: 31 }, (_, index) => `w${String(index + 1)}`).join(" ") });
    case "not-json":
      return "The document is a vendor page. Tier C.";
    default:
      return JSON.stringify({ tier: grade, ...base });
  }
}

/**
 * What the stub's adjudicator answers (`x-hb-stub-adjudicate`; spec 33 § 8): by default the decision the arithmetic
 * line allows — accept at the acceptance, ask for more with the first tier that would suffice at the floor, else
 * decline — with six reasons; or a decision forced whatever the arithmetic, for code's checks to refuse; or an output
 * the parser refuses — five criteria, a key it may not have, text that is not JSON.
 */
export const STUB_ADJUDICATIONS = ["arithmetic", "accept", "request-more", "decline", "missing-criterion", "unknown-key", "not-json"] as const;
export type StubAdjudication = (typeof STUB_ADJUDICATIONS)[number];
const ARITHMETIC = /\narithmetic: score (\d+) · accept at (\d+) · floor (\d+) ·[^\n]* would suffice ([^\n]+)/;

export function adjudicationOutput(text: string, mode: StubAdjudication): string {
  const m = ARITHMETIC.exec(text);
  const score = Number(m?.[1] ?? 0);
  const acceptAt = Number(m?.[2] ?? 0);
  const floorAt = Number(m?.[3] ?? 0);
  const suffice = (m?.[4] ?? "none").trim() === "none" ? [] : (m?.[4] ?? "").split(",").map((t) => t.trim());
  if (mode === "not-json") return "The evidence supports the change. Accept.";
  const allowed = score >= acceptAt ? "ACCEPT" : score >= floorAt && suffice.length > 0 ? "REQUEST_MORE" : "DECLINE";
  const decision = mode === "accept" ? "ACCEPT" : mode === "request-more" ? "REQUEST_MORE" : mode === "decline" ? "DECLINE" : allowed;
  const names = ["tier", "relevance", "recency", "independence", "corroboration", "threshold"];
  const criteria = (mode === "missing-criterion" ? names.slice(0, 5) : names).map((name) => ({ name, verdict: name === "threshold" ? `${String(score)}${score >= acceptAt ? ">=" : "<"}${String(acceptAt)}` : "graded", reason: STUB_GRADE_REASON }));
  return JSON.stringify({ decision, criteria, ...(decision === "REQUEST_MORE" ? { sufficientTier: suffice[0] ?? "B" } : {}), ...(mode === "unknown-key" ? { score } : {}) });
}

export interface AnswerInput {
  readonly request: StubRequest;
  readonly smallAlias: string;
  readonly price: ModelPrice;
  readonly cause: StubCause;
  /** Whether the request's cacheable prefix was seen before (the server keeps the set). */
  readonly prefixSeen: (sha256: string) => boolean;
  /** `invent`: the walk's explanation quotes a number the script did not write (`x-hb-stub-walk`). */
  readonly walk?: "invent" | null;
  /** `uncited`: the answer carries one more claim, which its cited section does not support (`x-hb-stub-claim`). */
  readonly claim?: StubClaim | null;
  /** The evidence grader's answer (`x-hb-stub-grade`); `G` when unset. */
  readonly grade?: StubGrade | null;
  /** Its classifications, from the same header; `partial` and `none` when it names a tier alone. */
  readonly classes?: StubClassifications | null;
  /** The adjudicator's answer (`x-hb-stub-adjudicate`); the arithmetic's decision when unset. */
  readonly adjudicate?: StubAdjudication | null;
  /** The planner's output (research.ts `planningOutput`, unit 58a), which the server builds only for a request that carries the planner guide's heading. */
  readonly planned?: string | null;
  /** The research writer's report (research.ts `writingOutput`, unit 69d), which the server builds only for a request with no tool that carries the writer part's heading. */
  readonly written?: string | null;
}

/** The deterministic answer to a `/v1/messages` request. */
export function answer(input: AnswerInput): StubAnswer {
  const { request } = input;
  const text = requestText(request);
  const sections = fencedSections(text);
  const kind: AnswerKind = typeof input.planned === "string" ? "planning" : typeof input.written === "string" ? "writing" : answerKind(request.model, input.smallAlias, text, sections);
  const aid = kind === "assistant" ? fencedAid(text) : null;
  const mode = modeOf(text);
  /* A brief keeps six claims (spec 19 § 5); every other mode cites one claim per fenced section. */
  const question = fencedQuestion(text);
  const supported = mode === "brief" ? claimsFor(sections, mode, question).slice(0, 6) : claimsFor(sections, mode, question);
  const first = sections[0];
  const claims = input.claim === "uncited" && first !== undefined ? [...supported, { text: UNCITED_CLAIM, sectionId: first.citeAs ?? first.id }] : supported;
  const output =
    kind === "classification"
      ? JSON.stringify({ cause: input.cause, reason: "answered by the stub gateway" })
      : kind === "grading"
        ? gradingOutput(input.grade ?? "G", input.classes ?? UNCLASSIFIED)
        : kind === "adjudication"
        ? adjudicationOutput(text, input.adjudicate ?? "arithmetic")
        : kind === "planning"
        ? (input.planned ?? "")
        : kind === "writing"
        ? (input.written ?? "")
        : kind === "assistant"
        ? JSON.stringify(aid === null ? { claims, refusal: null, mode_result: modeResultFor(mode, sections) } : { claims, refusal: null, mode_result: walkResult(aid, input.walk === "invent") })
        : JSON.stringify({ stub: "harness-bible", alias: request.model, characters: text.length });

  return { kind, text: output, ...usageAndCost(request, output, input.price, input.prefixSeen) };
}

/**
 * The usage and the cost of an answer: character counts, four to a token; the cacheable prefix written on its first
 * sight and read after; the price table's cost. Shared with the research answers (research.ts), whose content is
 * blocks rather than one text.
 */
export function usageAndCost(request: StubRequest, output: string, price: ModelPrice, prefixSeen: (sha256: string) => boolean): Pick<StubAnswer, "usage" | "prefixSha256" | "costUsd"> {
  const text = requestText(request);
  const prefix = cacheablePrefix(request);
  const prefixSha256 = prefix === null ? null : sha256Hex(`${request.model}\n${prefix}`);
  const prefixTokens = prefix === null ? 0 : tokensOf(prefix);
  const totalInput = tokensOf(text) + mediaTokensOf(request);
  const cached = prefixSha256 !== null && prefixSeen(prefixSha256);
  const usage: Usage = {
    input_tokens: Math.max(0, totalInput - prefixTokens),
    output_tokens: tokensOf(output),
    cache_creation_input_tokens: prefix !== null && !cached ? prefixTokens : 0,
    cache_read_input_tokens: cached ? prefixTokens : 0,
  };
  return { usage, prefixSha256, costUsd: costOf(price, usage) };
}

/** The text deltas of a streamed answer. */
export function chunks(text: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += STREAM_CHUNK_CHARACTERS) out.push(text.slice(i, i + STREAM_CHUNK_CHARACTERS));
  return out;
}
