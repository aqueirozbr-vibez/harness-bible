import { getPrisma } from "@/lib/db/client";
import { chaptersPassed } from "@/lib/db/content";
import { chaptersOfPart } from "@/lib/db/search";
import { withSystem } from "@/lib/db/tenant";
import { rerank } from "@/lib/gateway/rerank";
import { callModel, type GatewayDeps } from "@/lib/gateway/client";
import { DRAFT_REQUEST, GRADER_REQUEST, REPAIR_REQUEST } from "@/workers/answer/flow";
import { answer, type AnswerDeps, type AnswerSinks, type DraftedText } from "@/workers/answer/flow";
import type { AnswerRequest, AnswerResult, RefusalCause } from "@/lib/schemas/assistant";
import type { GatewayCall } from "@/lib/schemas/gateway";
import type { FigureId, SectionId } from "@/lib/schemas/ids";
import { parseFigureId } from "@/lib/schemas/ids";
import { BRIEF_PART, retrieve, type RetrieveDeps } from "@/lib/search/retrieve";
import { searchRelease } from "@/lib/search/hybrid";
import { withoutRedactionMarks } from "@/lib/security/redact";
import { namedChaptersOf, referencesOf } from "@/lib/sensors/references";
import { logRetrieve } from "@/lib/telemetry/lines";
import { inSpan } from "@/lib/telemetry/spans";
import type { PromptFigure, PromptSection } from "@/workers/agents/assistant/assemble";
import { labPromptSections, loadLab } from "@/workers/answer/lab";
import { embedQuery } from "@/workers/embed";
import type { LabFacts } from "@/lib/labs/pseudoSections";

/*
 * The flow's dependencies, built from the real ones (feature-specs/15 § 6.3). This is the seam between a flow
 * that knows nothing of databases or gateways and the world that has both: `workers/answer/flow.ts` stays
 * testable against fakes because everything here is passed in rather than imported there.
 *
 * It runs in the workers alone. The web tier cannot reach a model (invariant 6) and the ESLint rule of spec 11
 * § 5.5 keeps the client out of it, so this file is one of the places that boundary is real rather than polite.
 */

/** The figures a section prints, for the prompt's fence and the citation sensor (spec 13 § 5 slot 3). */
export async function figuresOf(releaseId: string, anchors: ReadonlyArray<string>): Promise<ReadonlyMap<string, ReadonlyArray<PromptFigure>>> {
  if (anchors.length === 0) return new Map();
  const rows = await getPrisma().figure.findMany({
    where: { section: { anchor: { in: [...anchors] }, chapterVersion: { releaseId } } },
    orderBy: { ordinal: "asc" },
    select: {
      anchor: true,
      label: true,
      valueText: true,
      tier: true,
      section: { select: { anchor: true } },
      derive: { select: { filePath: true, line: true } },
    },
  });

  const bySection = new Map<string, PromptFigure[]>();
  for (const row of rows) {
    const list = bySection.get(row.section.anchor) ?? [];
    list.push({
      figureId: parseFigureId(row.anchor),
      label: row.label,
      valueText: row.valueText,
      tier: row.tier,
      derive: row.derive === null ? null : { filePath: row.derive.filePath, line: row.derive.line },
    });
    bySection.set(row.section.anchor, list);
  }
  return bySection;
}

/**
 * Retrieval, then the figures of what it chose: what the prompt and the sensors both need. In lab mode the lab's
 * README and last run follow the retrieved sections as pseudo-sections (spec 19 § 4), and the lab's facts go back to
 * the turn so the final event carries the run the model read.
 */
async function retrieveAndRead(request: AnswerRequest, gateway: GatewayDeps): Promise<{ readonly sections: ReadonlyArray<PromptSection>; readonly overBudget: boolean; readonly lab: LabFacts | null }> {
  const deps: RetrieveDeps = {
    embed: (call, text) => embedQuery(call, text, gateway),
    rerank: (call, input) => rerank(call, input, gateway),
    search: searchRelease,
  };
  const retrieved = await retrieve(
    {
      releaseId: request.releaseId,
      /* The question without the marks a redaction left (feature-specs/21 § 6.2): the statement requires every word
         it is given, and a mark is three words the reader did not write. A question that was nothing but a secret
         keeps its mark, so retrieval still has something to be asked and finds what it finds. */
      question: withoutRedactionMarks(request.question) || request.question,
      mode: request.mode,
      context: { chapter: request.context.chapter, section: request.context.section, chapters: request.context.chapters, labId: request.context.labId },
      principal: request.principal,
      traceId: request.traceId,
    },
    deps,
  );
  /* One line per retrieval and, with a collector, one span (feature-specs/21 § 5.1): counts and timings, never the question. */
  logRetrieve({
    traceId: request.traceId,
    mode: request.mode,
    candidates: retrieved.candidates,
    embedMs: retrieved.timings.embedMs,
    sqlMs: retrieved.timings.sqlMs,
    rerankMs: retrieved.timings.rerankMs,
    ms: retrieved.timings.totalMs,
    overBudget: retrieved.overBudget,
    vectorReady: retrieved.vectorReady,
  });

  const figures = await figuresOf(request.releaseId, retrieved.sections.map((section) => section.sectionId));
  const sections: PromptSection[] = retrieved.sections.map((section) => ({ section, figures: figures.get(section.sectionId) ?? [] }));
  const loaded = request.mode === "lab" && request.context.labId !== undefined ? await loadLab(request.releaseId, request.context.labId) : null;
  return {
    sections: loaded === null ? sections : [...sections, ...labPromptSections(loaded, sections.length + 1)],
    overBudget: retrieved.overBudget,
    lab: loaded?.facts ?? null,
  };
}

/**
 * Retrieval for a turn as a scope of its own (feature-specs/49 § 6.3): the query's embedding and the re-rank nest under
 * `assistant.retrieve`, which is the retrieve line the work prints at its end.
 */
export function retrieveForAnswer(request: AnswerRequest, gateway: GatewayDeps): Promise<{ readonly sections: ReadonlyArray<PromptSection>; readonly overBudget: boolean; readonly lab: LabFacts | null }> {
  return inSpan({ name: "assistant.retrieve", traceId: request.traceId }, () => retrieveAndRead(request, gateway));
}

/** The four causes the classifier may name; anything else means proceed (spec 13 § 4.1, D2). */
const CAUSES: ReadonlyArray<RefusalCause> = ["R-SCOPE", "R-SCOPE-OT", "R-RECOMPUTE", "R-UNVERIFIED"];

/**
 * The scope classifier: one small-model call, asked only when the rules did not decide. A timeout, a refusal or
 * an answer that cannot be read all mean proceed — it is a gate against wasted frontier calls, not the last
 * defence, and the citation sensor and the grader still stand behind it.
 */
async function classify(request: AnswerRequest, call: GatewayCall, gateway: GatewayDeps, unverified: ReadonlyArray<UnverifiedChapter> = []): Promise<RefusalCause | null> {
  try {
    const message = await callModel(
      call,
      {
        model: "hb-small",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content:
              `Answer with JSON {"cause": ${classifierCauses(unverified)}, "reason": "≤ 20 words"}.\n` +
              `R-SCOPE: not about the book, its labs or its registries. R-SCOPE-OT: asks how to act on plant equipment. ` +
              `R-RECOMPUTE: asks for a figure the book did not compute.${unverifiedLine(unverified)}\n<question>\n${request.question}\n</question>`,
          },
        ],
      },
      gateway,
    );
    const text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
    const parsed = JSON.parse(text) as { cause?: unknown };
    return CAUSES.find((candidate) => candidate === parsed.cause) ?? null;
  } catch {
    return null;
  }
}

/** A chapter of the release that has not passed VERIFY, as the classifier is told of it. */
export interface UnverifiedChapter {
  readonly number: number;
  readonly title: string;
}

function classifierCauses(unverified: ReadonlyArray<UnverifiedChapter>): string {
  return unverified.length === 0 ? `"R-SCOPE" | "R-SCOPE-OT" | "R-RECOMPUTE" | "none"` : `"R-SCOPE" | "R-SCOPE-OT" | "R-RECOMPUTE" | "R-UNVERIFIED" | "none"`;
}

/**
 * The classifier's fourth cause (feature-specs/23 § 5.2, D6): a chapter named by its title carries no number for
 * the rule to read, and without this line the assistant would say the book does not cover a chapter the contents
 * page lists. A question about a topic is not this cause — retrieval answers it from the verified chapters. With
 * every chapter verified the line is absent and the prompt is the one it always was.
 */
export function unverifiedLine(unverified: ReadonlyArray<UnverifiedChapter>): string {
  if (unverified.length === 0) return "";
  const list = unverified.map((chapter) => `${String(chapter.number)} ${chapter.title}`).join("; ");
  return ` R-UNVERIFIED: asks about one of these chapters by its number or its title; they have not passed verification: ${list}.`;
}

const UNVERIFIED = new Map<string, Promise<ReadonlyArray<UnverifiedChapter>>>();

/** The release's unverified chapters with their EN titles. A release is immutable, so one read serves the process. */
export function unverifiedChapters(releaseId: string): Promise<ReadonlyArray<UnverifiedChapter>> {
  const known = UNVERIFIED.get(releaseId);
  if (known !== undefined) return known;
  const loading = withSystem(async () =>
    getPrisma().chapterVersion.findMany({
      where: { releaseId, verifyStatus: { not: "PASSED" } },
      orderBy: { chapterNumber: "asc" },
      select: { chapterNumber: true, editions: { where: { lang: "EN" }, select: { title: true } } },
    }),
  ).then((rows) => rows.map((row) => ({ number: row.chapterNumber, title: row.editions[0]?.title ?? "" })));
  UNVERIFIED.set(releaseId, loading);
  /* A failed read is not remembered: the next turn asks again. */
  loading.catch(() => UNVERIFIED.delete(releaseId));
  return loading;
}

export interface RunDeps {
  readonly gateway: GatewayDeps;
  readonly releaseVersions: ReadonlyMap<SectionId, string>;
  readonly titles: ReadonlyMap<SectionId, string>;
  readonly chaptersVerified: (request: AnswerRequest) => Promise<boolean>;
  /** The release's unverified chapters, for the classifier's line; the database by default, a test passes its own. */
  readonly unverified?: (releaseId: string) => Promise<ReadonlyArray<UnverifiedChapter>>;
  readonly now?: () => number;
  /** Each sensor's run, for the turn's line (feature-specs/49 § 8). */
  readonly onSensor?: AnswerDeps["onSensor"];
}

export interface RunResult {
  readonly result: AnswerResult;
  readonly overBudget: boolean;
  readonly promptSha256: string | null;
  /** Lab mode: the run the model read, for the turn's result (spec 19 § 6.2); null in every other mode. */
  readonly lab: LabFacts | null;
}

/** Run one turn: the flow with real retrieval, a real draft and a real grader, streaming to `sinks`. */
export async function runAnswer(request: AnswerRequest, sinks: AnswerSinks, deps: RunDeps): Promise<RunResult> {
  let overBudget = false;
  let promptSha256: string | null = null;
  let lab: LabFacts | null = null;

  const flowDeps: AnswerDeps = {
    ...(deps.onSensor === undefined ? {} : { onSensor: deps.onSensor }),
    chaptersVerified: deps.chaptersVerified,
    retrieve: async (current) => {
      const retrieved = await retrieveForAnswer(current, deps.gateway);
      overBudget = retrieved.overBudget;
      lab = retrieved.lab;
      return retrieved.sections;
    },
    /* A release whose chapters cannot be read is classified without the line: the rule and retrieval still stand. */
    classify: async (current, call) => classify(current, call, deps.gateway, await (deps.unverified ?? unverifiedChapters)(current.releaseId).catch(() => [])),
    draft: async (prompt, call, streamSinks, extra): Promise<DraftedText> => {
      promptSha256 = prompt.promptSha256;
      const messages = [
        ...prompt.messages.map((message) => ({ role: message.role, content: message.content })),
        ...(extra === null ? [] : [{ role: "user" as const, content: extra }]),
      ];
      const params = extra === null ? DRAFT_REQUEST : REPAIR_REQUEST;

      if (extra !== null) {
        /* A repair is not streamed: the reader has already seen a draft, and replaying a second one over it
           would show them words the sensors have not passed (spec 13 § 8). */
        const message = await callModel(call, { ...params, system: [...prompt.system], messages }, deps.gateway);
        return textOf(message, null);
      }

      const started = performance.now();
      let firstTokenMs: number | null = null;
      const stream = await callModel(call, { ...params, system: [...prompt.system], messages, stream: true }, deps.gateway);
      stream.on("text", (delta: string) => {
        firstTokenMs ??= Math.round(performance.now() - started);
        streamSinks.token(delta);
      });
      const message = await stream.finalMessage();
      return textOf(message, firstTokenMs);
    },
    grade: async (prompt, call) => {
      const message = await callModel(
        call,
        { ...GRADER_REQUEST, system: [...prompt.system], messages: prompt.messages.map((entry) => ({ role: entry.role, content: entry.content })) },
        deps.gateway,
      );
      return message.content.map((block) => ("text" in block ? block.text : "")).join("");
    },
    titleOf: async (sectionId) => deps.titles.get(sectionId) ?? sectionId,
    versionOf: (sectionId) => deps.releaseVersions.get(sectionId) ?? null,
    /* The brief's Part III as the release has it, the same lookup retrieval scopes by (spec 19 § 5). */
    briefChapters: async (current) => chaptersOfPart(current.releaseId, BRIEF_PART),
    now: deps.now ?? (() => Date.now()),
  };

  const result = await answer(request, sinks, flowDeps);
  return { result, overBudget, promptSha256, lab };
}

interface ModelMessage {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly stop_reason: string | null;
  readonly model: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number; readonly cache_read_input_tokens?: number | null };
}

function textOf(message: ModelMessage, firstTokenMs: number | null): DraftedText {
  return {
    text: message.content.map((block) => block.text ?? "").join(""),
    stopReason: message.stop_reason,
    modelId: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
    firstTokenMs,
  };
}

/** The titles and versions a refusal's pointers and the edition sensor need, for the sections of one release. */
export async function sectionFacts(releaseId: string): Promise<{ readonly titles: ReadonlyMap<SectionId, string>; readonly versions: ReadonlyMap<SectionId, string> }> {
  const rows = await withSystem(async () =>
    getPrisma().section.findMany({
      where: { chapterVersion: { releaseId } },
      select: { anchor: true, titleEn: true, chapterVersion: { select: { version: true } } },
    }),
  );
  const titles = new Map<SectionId, string>();
  const versions = new Map<SectionId, string>();
  for (const row of rows) {
    titles.set(row.anchor as SectionId, row.titleEn);
    versions.set(row.anchor as SectionId, row.chapterVersion.version);
  }
  return { titles, versions };
}

export type { FigureId };

/**
 * Whether every chapter a question is asked of has passed verification in this release (spec 13 § 4.1's
 * `R-UNVERIFIED`). The rule is the caller's fact so the sensor stays pure; this is where the fact comes from.
 */
/**
 * Whether everything a turn is asked of has passed verification (feature-specs/23 § 5.2). Since Assistant 2.0 there
 * is no context chapter to judge: the turn is asked of what its mode picked — the aid's chapter of a walk, the
 * lab's chapter, both chapters of a compare — and of every chapter the question names with a cue word ("chapter
 * 34", "section 37.8", "Lab 23"). One unverified chapter among them refuses the turn (D5): a refusal never carries
 * a partial answer. A bare `37.8` is not a name and never refuses (`lib/sensors/references.ts`).
 *
 * A brief also needs its sources — at least one chapter of Part III (spec 19 D4): with no verified source it
 * refuses before retrieval, like any unverified chapter, instead of running with nothing to read.
 */
export async function chaptersVerifiedFor(request: Pick<AnswerRequest, "releaseId" | "mode" | "context" | "question">): Promise<boolean> {
  const picked = [...(request.context.chapter === null ? [] : [request.context.chapter]), ...(request.context.chapters ?? [])];
  const named = namedChaptersOf(referencesOf(request.question));
  if (!(await chaptersPassed(request.releaseId, [...picked, ...named]))) return false;
  if (request.mode !== "brief") return true;
  const part = await chaptersOfPart(request.releaseId, BRIEF_PART);
  if (part.length === 0) return false;
  const passed = await withSystem(async () => getPrisma().chapterVersion.count({ where: { releaseId: request.releaseId, chapterNumber: { in: [...part] }, verifyStatus: "PASSED" } }));
  return passed > 0;
}
