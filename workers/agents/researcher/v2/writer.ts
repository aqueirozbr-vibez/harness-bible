import type { ResearchSection } from "@/lib/db/research";
import { callModel, defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { requestFor } from "@/lib/gateway/policy";
import type { Guide } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import type { GatewayCall, Principal } from "@/lib/schemas/gateway";
import type { AnchorKind, ChangeKind } from "@/lib/schemas/improve";
import { WriterOutputSchema, type ReaderNote, type ReadPage, type WriterOutput } from "@/lib/schemas/researcher";
import type { Rubric } from "@/lib/schemas/rubric";
import { CONVERSATION_TURNS, type TextBlock } from "@/workers/agents/assistant/assemble";

import { fenced, renderSection, tierOfChips } from "../render";
import { failureOf, parseOutput, usageOf, type CallUsage, type ParsedOutput } from "./output";

/*
 * The writer of a person's research (feature-specs/48 § 5.6, D1; unit 69d): one call on `hb-frontier` with no tool,
 * after the reader and the validation, that writes the report the person who asked reads. The reader holds the web and
 * must not hold the question, so a report that answers the question in the person's language is written by a third
 * call that holds the question and what the reader wrote of the pages, and nothing it could act with (invariant 33).
 * The prompt in its fixed order: 1 the writer part of the researcher's guide version 2, byte-stable and cached; then
 * per call 2 the language to write in, 3 the question, 4 for a follow-up only the earlier runs' questions and
 * reports, the last six, 5 the targets' sections with their figures and rows, 6 the findings that passed the checks —
 * the anchor, the change kind, the change's before and after as `changeOf` (lib/improve/outcomeView.ts) computes them,
 * the note — and 7 the pages whose note passed, numbered as the run's page list numbers them, each with its note and
 * nothing else of the page: not its address, and not its title, which the page set and no check bounds (the review of
 * unit 69). The parameter type lists exactly what the writer may read: there is no field for who asked, for the
 * brief, or for a page itself, so none can be passed. Every text in slots 3 to 7 is fenced as data: the notes, the
 * changes and the earlier reports were shaped by pages a stranger wrote.
 *
 * Its own request row (`researchWriter`, named by the call, since the reader's row shares its purpose and alias):
 * unstreamed, since the report is shown whole once the report sensor (lib/sensors/report.ts) has passed it. The
 * output is parsed strictly to `WriterOutputSchema` here; the sensor's paragraph rules are the step's, which reads
 * `reportReferencesOf` for what the paragraphs may cite. One attempt (invariant 15): a provider's refusal, a failure
 * of the gateway or an output the parse refuses is the writer's one failure, named, and the run ends
 * FAILED · WRITER_FAILED with what it has. Two refusals are thrown for the workflow (48 § 5.6, § 7.2): the gateway's
 * budget refusal (FAILED · BUDGET) and its 429 at the key's rate (`GatewayUnavailableError`, cause `rate_limit`), which
 * never reached the provider, so it is not the writer's attempt: the workflow waits it out once.
 */

export const WRITER_REQUEST = requestFor("researchWriter");

/** A finding that passed the checks, as the writer reads it (48 § 5.6 slot 6). */
export interface WriterFinding {
  /** The section the anchor is in: the section itself, or a figure's or a row's own section. */
  readonly section: string;
  readonly anchor: { readonly kind: AnchorKind; readonly id: string };
  readonly changeKind: ChangeKind;
  /** The change as `changeOf` computes it: the text it replaces (null for an addition) and the text it proposes. */
  readonly before: string | null;
  readonly after: string | null;
  /** The reader's note, at most 200 words. */
  readonly note: string;
}

/** A page the writer may cite (48 § 5.6 slot 7): its number in the run's page list and the note that passed. Never its address, nor its title, which the page wrote. */
export interface WriterPage {
  readonly n: number;
  readonly says: string;
}

/** An earlier run of the conversation (slot 4): its question, and its report's paragraphs, none where it has no report. */
export interface WriterEarlierRun {
  readonly question: string;
  readonly report: ReadonlyArray<string>;
}

/** Everything the writer may read, and nothing else. */
export interface WriterInput {
  readonly guide: Guide;
  /** The published rubric's chip map, so a figure's tier is shown as the letter the guides explain; null before a rubric is published. */
  readonly rubric: Pick<Rubric, "chips"> | null;
  /** The language to write in: the run's, the language the question was asked in. */
  readonly language: "EN" | "PT";
  readonly question: string;
  /** Oldest first; the assembler keeps the last `CONVERSATION_TURNS`. Empty for a first run. */
  readonly earlier: ReadonlyArray<WriterEarlierRun>;
  /** The targets' sections, at most three. */
  readonly sections: ReadonlyArray<ResearchSection>;
  readonly findings: ReadonlyArray<WriterFinding>;
  readonly pages: ReadonlyArray<WriterPage>;
}

export interface WriterPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly sha256: string;
}

/**
 * The pages the writer is given (slot 7), from what the run stored (48 § 5.4, § 5.5): each note that passed, under its
 * page's number in the run's page list (`found.read`, one-based), in the list's order. A note
 * names a page the list holds, since both are the turn's `https` addresses; one that does not, or a second note on the
 * same page, is left out.
 */
export function pagesForWriter(read: ReadonlyArray<ReadPage>, says: ReadonlyArray<ReaderNote>): ReadonlyArray<WriterPage> {
  const numbered = new Map(read.map((page, index) => [page.url, index + 1]));
  const pages = new Map<number, WriterPage>();
  for (const note of says) {
    const n = numbered.get(note.url);
    if (n === undefined || pages.has(n)) continue;
    pages.set(n, { n, says: note.says });
  }
  return [...pages.values()].sort((a, b) => a.n - b.n);
}

/** What a paragraph of the report may cite (48 § 5.7), from exactly what the writer was given: the targets and the findings' sections, and the numbered pages with a note. */
export function reportReferencesOf(input: Pick<WriterInput, "sections" | "findings" | "pages">): { readonly sections: ReadonlyArray<string>; readonly pages: ReadonlyArray<number> } {
  return { sections: [...new Set([...input.sections.map((section) => section.id), ...input.findings.map((finding) => finding.section)])], pages: input.pages.map((page) => page.n) };
}

/** An attribute's value: the product's ids, with a quote that could close it replaced. */
const attribute = (value: string): string => value.replace(/["<>\n]/g, "'");

function renderFinding(finding: WriterFinding, n: number): string {
  const body = [`before: ${finding.before ?? "(nothing: the change adds)"}`, `after: ${finding.after ?? "(nothing)"}`, `note: ${finding.note}`].join("\n");
  return fenced("finding", body, ` n="${String(n)}" section="${attribute(finding.section)}" anchor="${finding.anchor.kind} ${attribute(finding.anchor.id)}" change="${finding.changeKind}"`);
}

export function assembleWriter(input: WriterInput): WriterPrompt {
  const system: ReadonlyArray<TextBlock> = [{ type: "text", text: input.guide.prefix, cache_control: { type: "ephemeral" } }];
  const earlier = input.earlier.slice(-CONVERSATION_TURNS).flatMap((run, index) => {
    const n = ` n="${String(index + 1)}"`;
    return [fenced("earlier-question", run.question, n), fenced("earlier-report", run.report.length === 0 ? "(no report)" : run.report.join("\n\n"), n)];
  });
  const parts = [
    `language: ${input.language.toLowerCase()}`,
    fenced("question", input.question),
    ...earlier,
    input.sections.map((section) => renderSection(section, tierOfChips(input.rubric))).join("\n\n"),
    input.findings.length === 0 ? "changes: none passed the checks" : input.findings.map((finding, index) => renderFinding(finding, index + 1)).join("\n\n"),
    input.pages.length === 0 ? "pages: none with a note" : input.pages.map((page) => fenced("page", page.says, ` n="${String(page.n)}"`)).join("\n\n"),
  ].filter((part) => part.length > 0);
  const messages = [{ role: "user" as const, content: parts.join("\n\n") }];
  return { system, messages, sha256: sha256Hex(JSON.stringify({ system, messages })) };
}

/** The output held to the guide's object: one to eight paragraphs, each with its text, sections and page numbers, and no key the guide did not name. */
export function parseReport(text: string): ParsedOutput<WriterOutput> {
  return parseOutput(text, WriterOutputSchema, "writer");
}

export interface WriteInput {
  readonly prompt: WriterInput;
  /** The person's principal (48 § 7.1), the run's trace and its id as the call's `ref`. */
  readonly call: { readonly principal: Principal; readonly traceId: string; readonly ref: string };
}

export interface WriterDeps {
  readonly gateway: GatewayDeps;
}

export const defaultWriterDeps = (): WriterDeps => ({ gateway: defaultGatewayDeps() });

interface Answered {
  readonly model: string | null;
  readonly usage: CallUsage | null;
  readonly promptSha256: string;
}

export type Written = (Answered & { readonly ok: true; readonly output: WriterOutput }) | (Answered & { readonly ok: false; readonly failure: string });

/** The call and the request the writer makes: one place, so what is recorded is what is sent. Its own row, and no tool (invariant 33). */
export function writerRequestOf(input: WriteInput) {
  const prompt = assembleWriter(input.prompt);
  const call: GatewayCall = {
    purpose: "research",
    alias: "hb-frontier",
    agent: "researcher.write",
    row: "researchWriter",
    guide: { agent: "researcher", version: input.prompt.guide.version, sha256: input.prompt.guide.sha256 },
    principal: input.call.principal,
    traceId: input.call.traceId,
    ref: input.call.ref,
  };
  const request = { ...WRITER_REQUEST, system: [...prompt.system], messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })) };
  return { call, request, promptSha256: prompt.sha256 };
}

export async function write(input: WriteInput, deps: WriterDeps = defaultWriterDeps()): Promise<Written> {
  const { call, request, promptSha256 } = writerRequestOf(input);
  let model: string;
  let text: string;
  let usage: CallUsage;
  try {
    const message = await callModel(call, request, deps.gateway);
    model = message.model;
    text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
    usage = usageOf(message.usage);
  } catch (error: unknown) {
    /* the budget and the key's rate are the workflow's: the run ends, or waits once and asks again */
    if (error instanceof BudgetExceededError) throw error;
    if (error instanceof GatewayUnavailableError && error.cause === "rate_limit") throw error;
    return { ok: false, failure: failureOf(error), model: null, usage: null, promptSha256 };
  }
  const parsed = parseReport(text);
  if (!parsed.ok) return { ok: false, failure: parsed.reason, model, usage, promptSha256 };
  return { ok: true, output: parsed.output, model, usage, promptSha256 };
}
