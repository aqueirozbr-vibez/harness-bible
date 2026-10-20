import type { Guide } from "@/lib/guides/load";
import type { GraderBytesType } from "@/lib/improve/media";
import type { AnchorKind, ChangeKind, EvidenceKind } from "@/lib/schemas/improve";
import type { Rubric } from "@/lib/schemas/rubric";
import type { TextBlock } from "@/workers/agents/assistant/assemble";

/*
 * The evidence grader's prompt (feature-specs/32 § 7.1; architecture § 6.1), in the fixed order: 1 the guide,
 * 2 the rubric's tiers and factors rendered once per version — both byte-stable and cached — then, per call, 3 the
 * anchored passage and the proposed change, 4 the evidence document. The document goes inside a fence the guide
 * names as data to classify, never instructions to follow (§ 7.3); the fence is applied here and not by the caller
 * (code-standards: workers, workflows and agents). A document longer than DOCUMENT_CHARS_MAX is cut at a paragraph
 * boundary and the fence says so (§ 7.5, `truncated`).
 *
 * The parameter type lists exactly what the grader may read: the document as fetched, the anchored text, the
 * proposed change. There is no field for the contributor, the rationale, other items or other suggestions, so none
 * can be passed (invariant 12); assemble.test.ts holds the payload to it. Independence is decided by code from the
 * contributor's address in evidence.ts, where no prompt is built.
 *
 * Since unit 49f (§ 9) a PDF or an image is not text the product can cut: it goes to the model as the provider's
 * own document or image content, base64, inside the same fence — the fence's opening and its closing are text
 * blocks on either side of it, so the guide's sentence ("the document arrives inside <evidence> … </evidence>")
 * holds for it as for a page. It stays in slot 4, after the anchor and the change, because § 7.1 fixes the slots'
 * order; the provider's general advice to put a document first is not the spec's order.
 */

/**
 * The row's input ceiling (§ 7.5), in characters, under Andre's delegation of 2026-09-24 for the request table: at
 * four characters to a token (the stub's rule, rules § 4.3) some 15,000 tokens of document, an order of magnitude
 * under the small model's context and above any article's text (a Nature page gave 7,739 characters of text on
 * 2026-10-06; the fixture article 3,000), while bounding what one grade spends on input to roughly 16,000 tokens.
 */
export const DOCUMENT_CHARS_MAX = 60_000;

export interface EvidenceAnchor {
  readonly kind: AnchorKind;
  /** `21.3`, `F-21-04`, `21.9 r1`. */
  readonly id: string;
  readonly chapter: number;
  /** The anchored passage as the release has it: the section's text, the figure's line, the row's text. */
  readonly text: string;
  readonly fastMoving: boolean;
}

export interface EvidenceChange {
  readonly kind: ChangeKind;
  /** For a text edit the passage the proposal quotes; empty for a figure or a row, whose text is the anchor's. */
  readonly anchoredPassage: string;
  readonly proposedText: string;
}

/**
 * What the grader reads: text the assembler cuts and fences — `truncated` when it was already cut before it was
 * stored, so the fence says so (§ 7.5) — or a PDF's or an image's bytes the provider reads itself (§ 9).
 */
export type EvidenceContent = { readonly kind: "text"; readonly text: string; readonly truncated?: boolean } | { readonly kind: "bytes"; readonly mediaType: GraderBytesType; readonly data: Uint8Array };

export interface EvidenceDocument {
  readonly kind: EvidenceKind;
  /** The host the document came from (the final URL's), or null for an upload. */
  readonly host: string | null;
  /** The source's media type, as the fence states it. */
  readonly mediaType: string;
  readonly title: string | null;
  /** The document's own metadata date, as the fetcher read it; null when it states none. */
  readonly publishedOn: string | null;
  readonly content: EvidenceContent;
}

/** Everything the grader may read, and nothing else. */
export interface EvidenceGraderInput {
  readonly guide: Guide;
  readonly rubric: Rubric;
  readonly anchor: EvidenceAnchor;
  readonly change: EvidenceChange;
  readonly document: EvidenceDocument;
}

/** A block of the user message: text, a PDF as the provider's document block, an image as its image block (§ 9). */
export type EvidenceBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "document"; readonly source: { readonly type: "base64"; readonly media_type: "application/pdf"; readonly data: string } }
  | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: "image/png" | "image/jpeg"; readonly data: string } };

export interface EvidenceMessage {
  readonly role: "user";
  /** One string for a text document, as since unit 49d; blocks for a PDF or an image, which sits between the fence's two text blocks. */
  readonly content: string | ReadonlyArray<EvidenceBlock>;
}

export interface EvidencePrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<EvidenceMessage>;
  /** Whether the document was cut to DOCUMENT_CHARS_MAX; a PDF or an image is never cut. */
  readonly truncated: boolean;
  /** The text the grader reads, cut or whole: what the item's `text` key stores (§ 5). Null for a PDF or an image, whose bytes it reads from the copy the item's `text` key holds. */
  readonly text: string | null;
}

const TIER_NOTES: Readonly<Record<string, string>> = { A: " (reproducible; never yours to give)", U: " (unverifiable; never yours to give)" };

/** The rubric's tiers and factors as one block, deterministic from the rubric, so a version renders to the same bytes every call. */
export function renderRubric(rubric: Rubric): string {
  const tiers = Object.entries(rubric.tiers)
    .map(([tier, row]) => `${tier} ${String(row.base)}${TIER_NOTES[tier] ?? ""}`)
    .join(" · ");
  const factor = (value: number): string => `×${value.toFixed(1)}`;
  const relevance = Object.entries(rubric.adjustments.relevance)
    .map(([name, value]) => `${name} ${factor(value)}`)
    .join(" · ");
  const recency = rubric.adjustments.recency.windows.map((window) => `≤ ${String(window.withinDays)} days ${factor(window.factor)}`).join(" · ");
  const independence = Object.entries(rubric.adjustments.independence)
    .map(([name, value]) => `${name} ${factor(value)}`)
    .join(" · ");
  return [
    `rubric ${rubric.version} (applies from ${rubric.appliesAt})`,
    `tiers and base scores: ${tiers}`,
    `relevance: ${relevance}`,
    `recency (fast-moving anchors only): ${recency} · older ${factor(rubric.adjustments.recency.older)} · stable anchors ${factor(rubric.adjustments.recency.stable)}`,
    `independence: ${independence} (decided by the product, not by you)`,
    "The numbers are code's. You classify; you never score.",
  ].join("\n");
}

/**
 * The text cut to `max` characters at a paragraph boundary: the last blank line before the limit, else the last
 * line break, else the last sentence end, else the limit itself. A text within the limit is returned whole.
 */
export function cutDocument(text: string, max: number = DOCUMENT_CHARS_MAX): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const floor = Math.floor(max * 0.8);
  const at = [head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.search(/[.!?](?=[^.!?]*$)/)].find((index) => index >= floor);
  return { text: (at === undefined ? head : head.slice(0, at + (head[at] === "\n" ? 0 : 1))).trimEnd(), truncated: true };
}

/** An attribute value the assembler controls: quotes and angle brackets cannot break the fence. */
const attribute = (value: string): string => value.replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char] ?? char);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function anchorFence(anchor: EvidenceAnchor): string {
  return `<anchor kind="${anchor.kind}" id="${attribute(anchor.id)}" chapter="${String(anchor.chapter)}" fast-moving="${String(anchor.fastMoving)}">\n${anchor.text.trim()}\n</anchor>`;
}

export function changeFence(change: EvidenceChange): string {
  const before = change.anchoredPassage.trim() === "" ? "" : `before: ${change.anchoredPassage.trim()}\n`;
  return `<change kind="${change.kind}">\n${before}after: ${change.proposedText.trim()}\n</change>`;
}

export const EVIDENCE_CLOSE = "</evidence>";

/** The fence's opening line and the document's title under it: the attributes are the product's facts about it, the title is its own and sits inside. */
export function evidenceOpening(document: EvidenceDocument, truncated: boolean): string {
  const published = document.publishedOn !== null && DATE.test(document.publishedOn) ? document.publishedOn : "unknown";
  const head = `<evidence kind="${document.kind}" source="${attribute(document.host ?? "upload")}" type="${attribute(document.mediaType)}" published="${published}" truncated="${String(truncated)}">`;
  const title = document.title === null || document.title.trim() === "" ? "" : `title: ${document.title.trim()}\n`;
  return `${head}\n${title}`;
}

/** The document as untrusted data, whole: the opening, the text, the closing. */
export function evidenceFence(document: EvidenceDocument, text: string, truncated: boolean): string {
  return `${evidenceOpening(document, truncated)}${text.trim()}\n${EVIDENCE_CLOSE}`;
}

/** A PDF as the provider's document block, an image as its image block, base64 (§ 9). */
export function bytesBlock(content: Extract<EvidenceContent, { kind: "bytes" }>): EvidenceBlock {
  /* A view of the same memory, not a copy: a PDF may be 24 MB. */
  const data = Buffer.from(content.data.buffer, content.data.byteOffset, content.data.byteLength).toString("base64");
  if (content.mediaType === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  return { type: "image", source: { type: "base64", media_type: content.mediaType, data } };
}

export function assembleEvidenceGrader(input: EvidenceGraderInput): EvidencePrompt {
  const system: ReadonlyArray<TextBlock> = [
    /* Slot 1 and slot 2: both byte-stable per version; the one breakpoint falls after the rubric, so the two are cached together. */
    { type: "text", text: input.guide.prefix },
    { type: "text", text: renderRubric(input.rubric), cache_control: { type: "ephemeral" } },
  ];
  const before = `${anchorFence(input.anchor)}\n\n${changeFence(input.change)}\n\n`;
  const { content } = input.document;
  if (content.kind === "text") {
    const cut = cutDocument(content.text);
    const truncated = cut.truncated || content.truncated === true;
    return { system, messages: [{ role: "user", content: `${before}${evidenceFence(input.document, cut.text, truncated)}` }], truncated, text: cut.text };
  }
  /* Slot 3 and the fence's opening, the document itself, the fence's closing: three blocks in one user message. */
  return {
    system,
    messages: [{ role: "user", content: [{ type: "text", text: `${before}${evidenceOpening(input.document, false)}` }, bytesBlock(content), { type: "text", text: EVIDENCE_CLOSE }] }],
    truncated: false,
    text: null,
  };
}
