import { createHash } from "node:crypto";

import type { Guide } from "@/lib/guides/load";
import type { AnswerRequest, ConversationTurn, Locale, Mode } from "@/lib/schemas/assistant";
import type { FigureId, ReleaseId, SectionId } from "@/lib/schemas/ids";
import type { RetrievedSection } from "@/lib/search/retrieve";

/*
 * Prompt assembly for the assistant (feature-specs/13 § 5; architecture § 6.1). One function, one fixed order, and
 * a parameter type that lists exactly what the agent may read — the point of the type is what it cannot express:
 * there is no field for a reader's name, organisation or e-mail, and no field for another conversation. A prompt
 * this function did not build cannot reach the model, because `callModel` is given its output and nothing else.
 *
 * The order is the architecture's, and each slot is a labelled block:
 *
 *   system[0]  the guide prefix, byte for byte, carrying the one cache breakpoint
 *   system[1]  the release and mode line
 *   user       the retrieved sections, each fenced as untrusted data
 *   user       the walk's aid result, fenced, walk mode only
 *   …          the conversation, as its own alternating turns
 *   user       the question, fenced
 *
 * Two provider constraints the spec records (§ 5, from the Claude API guidance):
 *
 *   The breakpoint sits immediately after the prefix. Caching is a prefix match, so every byte before the last
 *   `cache_control` is the cached prefix; putting the release line, the mode or the sections inside it would make
 *   the prefix per-request and the gate's cache-read check could not pass.
 *
 *   No assistant prefill. `claude-opus-5` answers 400 to a prefilled last assistant turn, so the JSON envelope is
 *   asked for by the guide and constrained by `output_config.format`, never by opening the answer with a brace.
 *   The conversation therefore always ends on the question, never on a half-written assistant turn.
 */

/** A figure as the fence prints it, so the model can cite an id it did not have to guess (§ 5 slot 3). */
export interface PromptFigure {
  readonly figureId: FigureId;
  readonly label: string;
  /** The value exactly as the release prints it; the model quotes this string and the citation sensor checks it. */
  readonly valueText: string;
  readonly tier: string;
  /** `derive.py` and the line that printed it, when the figure is derived. */
  readonly derive: { readonly filePath: string; readonly line: number } | null;
}

/** A retrieved section with the figures of its own text: what slot 3 needs and `RetrievedSection` does not carry. */
export interface PromptSection {
  readonly section: RetrievedSection;
  readonly figures: ReadonlyArray<PromptFigure>;
}

/** Exactly what the agent may read. Nothing else has a place here (§ 5). */
export interface AssistantPromptInput {
  readonly guide: Guide;
  readonly releaseId: ReleaseId;
  readonly sections: ReadonlyArray<PromptSection>;
  readonly conversation: ReadonlyArray<ConversationTurn>;
  readonly question: string;
  readonly mode: Mode;
  readonly locale: Locale;
  /** The walk's values with their derive lines (spec 18); `null` in every other mode. */
  readonly aidResult: unknown;
}

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
}

export interface PromptMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AssembledPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<PromptMessage>;
  /** sha256 of the prefix slots alone (§ 5): the same guide, release and sections hash the same. */
  readonly promptSha256: string;
}

/** The last six turns (§ 5 slot 4, D4): enough for a follow-up, short enough that the prefix stays the prefix. */
export const CONVERSATION_TURNS = 6;

/** The edition the answer cites, which is the edition the sections came from (§ 5 slot 2). */
function editionOf(sections: ReadonlyArray<PromptSection>): string {
  return sections[0]?.section.editionLang ?? "EN";
}

function figureLine(figures: ReadonlyArray<PromptFigure>): string {
  return figures
    .map((figure) => {
      const derive = figure.derive === null ? figure.tier.toLowerCase() : `derived, L${figure.derive.line}`;
      return `${figure.figureId} "${figure.label}" ${figure.valueText} (${derive})`;
    })
    .join("; ");
}

/**
 * One section as untrusted data. The attributes are the assembler's, never the section's own text, so a section
 * whose prose contains `</section>` cannot close its own fence: the text is the element's content and the guide
 * tells the model that everything inside a fence is data to cite, not instructions to follow.
 */
export function sectionFence(entry: PromptSection): string {
  const { section, figures } = entry;
  /* A lab pseudo-section (spec 19 § 4) is read under its own id and cited as the chapter's lab section. */
  const id = section.pseudo === undefined ? section.sectionId : section.pseudo.id;
  const cite = section.pseudo === undefined ? "" : ` cite="${section.sectionId}"`;
  const head = `<section id="${id}"${cite} chapter="${String(section.chapter)}" version="${section.version}" edition="${section.editionLang}" verify="${section.verify}">`;
  const body = section.pseudo === undefined ? section.text.trim() : `(cite this as section ${section.sectionId})\n${section.text.trim()}`;
  const line = figures.length === 0 ? "" : `\nfigures: ${figureLine(figures)}`;
  return `${head}\n${body}${line}\n</section>`;
}

/** The release and mode line of slot 2. */
export function modeLine(input: AssistantPromptInput): string {
  return `release ${input.releaseId} · mode ${input.mode} · answer in ${input.locale} · edition ${editionOf(input.sections)}`;
}

export function assemble(input: AssistantPromptInput): AssembledPrompt {
  const system: TextBlock[] = [
    /* Slot 1. The one breakpoint, and it is here so that everything volatile falls after it. */
    { type: "text", text: input.guide.prefix, cache_control: { type: "ephemeral" } },
    /* Slot 2. */
    { type: "text", text: modeLine(input) },
  ];

  const messages: PromptMessage[] = [];

  /* Slot 3: the sections, in rank order, one fence each. */
  if (input.sections.length > 0) {
    messages.push({ role: "user", content: input.sections.map(sectionFence).join("\n\n") });
  }

  /* Slot 5: the walk's own values, fenced like the sections and for the same reason. */
  if (input.aidResult !== null && input.aidResult !== undefined) {
    messages.push({ role: "user", content: `<aid>\n${JSON.stringify(input.aidResult)}\n</aid>` });
  }

  /* Slot 4: the conversation, newest last, at most the last six turns. An earlier refusal is its one sentence. */
  for (const turn of input.conversation.slice(-CONVERSATION_TURNS)) {
    messages.push({ role: turn.role, content: turn.text });
  }

  /* Slot 6: the question, last and fenced. The reader's words are data, and the guide says so. */
  messages.push({ role: "user", content: `<question>\n${input.question.trim()}\n</question>` });

  return { system, messages, promptSha256: promptSha256(input) };
}

/**
 * The prefix hash of spec 11 § 5.4: the guide, the release, the mode line and the sections — everything that is
 * the same for two readers asking different questions of the same page. The conversation, the aid result and the
 * question are excluded, which is what makes this hash answer "was the cached prefix the same?".
 */
export function promptSha256(input: AssistantPromptInput): string {
  const canonical = JSON.stringify({
    guide: input.guide.sha256,
    release: input.releaseId,
    mode: input.mode,
    locale: input.locale,
    sections: input.sections.map((entry) => sectionFence(entry)),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The section ids the answer may cite: a claim naming anything else is not a citation (§ 6). */
export function citableSections(input: AssistantPromptInput): ReadonlySet<SectionId> {
  return new Set(input.sections.map((entry) => entry.section.sectionId));
}

/** The figure ids each section may be cited for, for the same reason; a lab's pseudo-sections add theirs to the lab section's. */
export function citableFigures(input: AssistantPromptInput): ReadonlyMap<SectionId, ReadonlySet<FigureId>> {
  const out = new Map<SectionId, Set<FigureId>>();
  for (const entry of input.sections) {
    const set = out.get(entry.section.sectionId) ?? new Set<FigureId>();
    for (const figure of entry.figures) set.add(figure.figureId);
    out.set(entry.section.sectionId, set);
  }
  return out;
}

/** The request's own fields the assembler is allowed to see, so a caller cannot widen it by passing the request. */
export function promptInputOf(
  request: Pick<AnswerRequest, "releaseId" | "locale" | "mode" | "question" | "conversation" | "aidResult">,
  guide: Guide,
  sections: ReadonlyArray<PromptSection>,
): AssistantPromptInput {
  return {
    guide,
    releaseId: request.releaseId,
    sections,
    conversation: request.conversation,
    question: request.question,
    mode: request.mode,
    locale: request.locale,
    aidResult: request.aidResult,
  };
}
