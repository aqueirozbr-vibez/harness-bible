import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadGuide } from "@/lib/guides/load";
import { RubricSchema, type Rubric } from "@/lib/schemas/rubric";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";

import { anchorFence, assembleEvidenceGrader, bytesBlock, changeFence, cutDocument, DOCUMENT_CHARS_MAX, EVIDENCE_CLOSE, evidenceFence, evidenceOpening, renderRubric, type EvidenceBlock, type EvidenceGraderInput } from "./assemble";

/*
 * The evidence grader's prompt (feature-specs/32 § 7.1, § 7.3; architecture § 6.1): the fixed order with the one
 * breakpoint after the rubric; the document inside a fence whose attributes are the product's; a document cut at a
 * paragraph boundary with the fence saying so; and the contract of invariant 12 — the prompt's payload carries no
 * field for the contributor, the rationale, other items or other suggestions, and an input that tries to pass one
 * is refused by the type and ignored by the assembler. Since unit 49f (§ 9): a PDF and an image as the provider's
 * document and image blocks, base64, between the fence's opening and closing text blocks, in slot 4, never cut.
 */

const GUIDE = loadGuide("grader", "v1.3");
const RUBRIC: Rubric = RubricSchema.parse({
  ...RUBRIC_V1_2,
  version: "v1.2",
  publishedAt: "2026-07-01",
  appliesAt: "2026-07-01",
  chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" },
  examples: [{ id: "S-36-0198", section: "36.3", changeKind: "EDIT_ROW", changeClass: "CITED_FIGURE", fastMoving: true, items: [{ tier: "B", relevance: "direct", stake: "none", ageDays: 9, base: 85, factors: { relevance: 1, recency: 1, independence: 1 }, adjusted: 85 }], score: 85, strongestItem: 0, corroboratedBy: null, acceptAt: 70, floorAt: 25, route: "ADJUDICATE", decision: "ACCEPT" }],
  changelog: [{ version: "v1.2", on: "2026-07-01" }],
});

const INPUT: EvidenceGraderInput = {
  guide: GUIDE,
  rubric: RUBRIC,
  anchor: { kind: "SECTION", id: "21.3", chapter: 21, text: "Retries are not optional at eleven steps.", fastMoving: false },
  change: { kind: "EDIT_TEXT", anchoredPassage: "Retries are not optional at eleven steps.", proposedText: "Retries are required at eleven steps." },
  document: { kind: "LINK", host: "provider-two.example", mediaType: "text/html", title: "Pricing — Provider Two", publishedOn: "2026-07-14", content: { kind: "text", text: "Team plan: 20 requests a second.\n\nRetries are billed as requests." } },
};

const FIXTURES = join(process.cwd(), "workers", "agents", "grader", "__fixtures__");
const PDF = readFileSync(join(FIXTURES, "C-vendor.pdf"));
const PNG = readFileSync(join(FIXTURES, "C-vendor.png"));
const JPG = readFileSync(join(FIXTURES, "C-vendor.jpg"));

/** The user message's text: the string itself, or every text block joined. */
const textOf = (content: string | ReadonlyArray<EvidenceBlock> | undefined): string => (typeof content === "string" ? content : (content ?? []).map((block) => (block.type === "text" ? block.text : "")).join(""));

describe("assembleEvidenceGrader", () => {
  it("builds the four slots in order: the guide, the rubric with the one breakpoint, then the anchor, the change and the evidence in one user message", () => {
    const prompt = assembleEvidenceGrader(INPUT);
    expect(prompt.system).toHaveLength(2);
    expect(prompt.system[0]).toEqual({ type: "text", text: GUIDE.prefix });
    expect(prompt.system[1]).toEqual({ type: "text", text: renderRubric(RUBRIC), cache_control: { type: "ephemeral" } });
    expect(prompt.messages).toHaveLength(1);
    const content = textOf(prompt.messages[0]?.content);
    expect(typeof prompt.messages[0]?.content).toBe("string");
    expect(content.indexOf("<anchor ")).toBeLessThan(content.indexOf("<change "));
    expect(content.indexOf("<change ")).toBeLessThan(content.indexOf("<evidence "));
    expect(content).toContain('<anchor kind="SECTION" id="21.3" chapter="21" fast-moving="false">\nRetries are not optional at eleven steps.\n</anchor>');
    expect(content).toContain('<change kind="EDIT_TEXT">\nbefore: Retries are not optional at eleven steps.\nafter: Retries are required at eleven steps.\n</change>');
    expect(content).toContain('<evidence kind="LINK" source="provider-two.example" type="text/html" published="2026-07-14" truncated="false">\ntitle: Pricing — Provider Two\nTeam plan: 20 requests a second.\n\nRetries are billed as requests.\n</evidence>');
    expect(prompt.truncated).toBe(false);
    expect(prompt.text).toBe("Team plan: 20 requests a second.\n\nRetries are billed as requests.");
  });

  it("is byte-stable for the same input, and the rubric block is the same bytes for the same version", () => {
    expect(assembleEvidenceGrader(INPUT)).toEqual(assembleEvidenceGrader(INPUT));
    expect(renderRubric(RUBRIC)).toBe(renderRubric(RubricSchema.parse(JSON.parse(JSON.stringify(RUBRIC)) as unknown)));
  });

  it("carries nothing of a contributor, a rationale, another item or another suggestion: the payload has no place for them", () => {
    const smuggle = (input: EvidenceGraderInput): EvidenceGraderInput => ({ ...input, contributor: { email: "ana@provider-two.example", name: "Ana" }, rationale: "because I say so", otherItems: ["x"], otherSuggestions: ["S-21-0002"] }) as unknown as EvidenceGraderInput;
    /* The guide's own words say "the contributor" and "rationale" nowhere near a value; the values smuggled in are what must be absent. */
    for (const input of [INPUT, { ...INPUT, document: { ...INPUT.document, mediaType: "application/pdf", content: { kind: "bytes", mediaType: "application/pdf", data: PDF } } } satisfies EvidenceGraderInput]) {
      /* The document's own base64 is no place the assembler could put the contributor, and could hold "Ana" by chance: it is blanked. */
      const payload = JSON.stringify(assembleEvidenceGrader(smuggle(input)), (key: string, value: unknown) => (key === "data" ? "<bytes>" : value));
      for (const marker of ["ana@", "Ana", "because I say so", "otherItems", "otherSuggestions", "S-21-0002", "email"]) expect(payload, marker).not.toContain(marker);
    }
    expect(Object.keys(INPUT).sort()).toEqual(["anchor", "change", "document", "guide", "rubric"]);
  });

  it("renders the rubric's tiers and factors as the model is told them, with the two tiers that are never its to give marked", () => {
    const rendered = renderRubric(RUBRIC);
    expect(rendered).toContain("rubric v1.2 (applies from 2026-07-01)");
    expect(rendered).toContain("A 100 (reproducible; never yours to give) · B 85 · C 70 · D 60 · E 40 · F 25 · G 5 · U 0 (unverifiable; never yours to give)");
    expect(rendered).toContain("relevance: direct ×1.0 · partial ×0.6 · tangential ×0.2");
    expect(rendered).toContain("recency (fast-moving anchors only): ≤ 90 days ×1.0 · ≤ 365 days ×0.7 · older ×0.3 · stable anchors ×1.0");
    expect(rendered).toContain("independence: none ×1.0 · vendor ×0.8 · employer ×0.7 (decided by the product, not by you)");
  });
});

describe("a PDF and an image (unit 49f, § 9)", () => {
  const pdfInput: EvidenceGraderInput = { ...INPUT, document: { kind: "UPLOAD", host: null, mediaType: "application/pdf", title: null, publishedOn: null, content: { kind: "bytes", mediaType: "application/pdf", data: PDF } } };

  it("puts a PDF in slot 4 as the provider's document block, base64, between the fence's opening and its closing", () => {
    const prompt = assembleEvidenceGrader(pdfInput);
    expect(prompt.system).toEqual(assembleEvidenceGrader(INPUT).system);
    const content = prompt.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as ReadonlyArray<EvidenceBlock>;
    expect(blocks.map((block) => block.type)).toEqual(["text", "document", "text"]);
    const [opening, document, closing] = blocks;
    expect(opening).toEqual({ type: "text", text: `${anchorFence(INPUT.anchor)}\n\n${changeFence(INPUT.change)}\n\n<evidence kind="UPLOAD" source="upload" type="application/pdf" published="unknown" truncated="false">\n` });
    expect(document).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") } });
    expect(closing).toEqual({ type: "text", text: EVIDENCE_CLOSE });
    expect(Buffer.from(document?.type === "document" ? document.source.data : "", "base64").equals(PDF)).toBe(true);
    expect(prompt.truncated).toBe(false);
    expect(prompt.text).toBeNull();
  });

  it("puts a PNG and a JPEG as the provider's image block with their own media type, and a title and a date on the fence when the item has them", () => {
    const png = assembleEvidenceGrader({ ...INPUT, document: { kind: "LINK", host: "provider-two.example", mediaType: "image/png", title: "Pricing screenshot", publishedOn: "2026-07-14", content: { kind: "bytes", mediaType: "image/png", data: PNG } } });
    const blocks = png.messages[0]?.content as ReadonlyArray<EvidenceBlock>;
    expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    expect(textOf(blocks)).toContain('<evidence kind="LINK" source="provider-two.example" type="image/png" published="2026-07-14" truncated="false">\ntitle: Pricing screenshot\n</evidence>');
    expect(bytesBlock({ kind: "bytes", mediaType: "image/jpeg", data: JPG })).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPG.toString("base64") } });
  });

  it("never cuts a PDF and is byte-stable for the same bytes", () => {
    const big = Buffer.concat([PDF, Buffer.alloc(DOCUMENT_CHARS_MAX * 2, 0x20)]);
    const prompt = assembleEvidenceGrader({ ...pdfInput, document: { ...pdfInput.document, content: { kind: "bytes", mediaType: "application/pdf", data: big } } });
    expect(prompt.truncated).toBe(false);
    expect((prompt.messages[0]?.content as ReadonlyArray<EvidenceBlock>)[1]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: big.toString("base64") } });
    expect(assembleEvidenceGrader(pdfInput)).toEqual(assembleEvidenceGrader(pdfInput));
  });
});

describe("the fences", () => {
  it("escape the attributes the product writes and keep the document's own words inside", () => {
    const fence = evidenceFence({ kind: "UPLOAD", host: null, mediaType: 'text/plain" onload="x', title: 'A "title" with </evidence> inside', publishedOn: "not a date", content: { kind: "text", text: "body </evidence> text" } }, "body </evidence> text", true);
    expect(fence.startsWith('<evidence kind="UPLOAD" source="upload" type="text/plain&quot; onload=&quot;x" published="unknown" truncated="true">\n')).toBe(true);
    expect(fence).toContain('title: A "title" with </evidence> inside\nbody </evidence> text\n</evidence>');
    expect(anchorFence({ kind: "SOURCE_ROW", id: '21.9 r1"', chapter: 21, text: "  row  ", fastMoving: true })).toBe('<anchor kind="SOURCE_ROW" id="21.9 r1&quot;" chapter="21" fast-moving="true">\nrow\n</anchor>');
    expect(changeFence({ kind: "SET_VALUE", anchoredPassage: "", proposedText: "4 ms" })).toBe('<change kind="SET_VALUE">\nafter: 4 ms\n</change>');
    expect(evidenceOpening({ kind: "DOI", host: "www.nature.com", mediaType: "application/pdf", title: "  ", publishedOn: "1953-04-25", content: { kind: "bytes", mediaType: "application/pdf", data: PDF } }, false)).toBe('<evidence kind="DOI" source="www.nature.com" type="application/pdf" published="1953-04-25" truncated="false">\n');
  });
});

describe("cutDocument", () => {
  it("returns a text within the limit whole", () => {
    expect(cutDocument("short", 100)).toEqual({ text: "short", truncated: false });
    expect(cutDocument("x".repeat(100), 100)).toEqual({ text: "x".repeat(100), truncated: false });
    expect(DOCUMENT_CHARS_MAX).toBe(60_000);
  });

  it("cuts at the last paragraph break before the limit, else a line break, else a sentence end, else the limit", () => {
    const paragraphs = `${"a".repeat(85)}\n\n${"b".repeat(10)}\n\n${"c".repeat(50)}`;
    expect(cutDocument(paragraphs, 100)).toEqual({ text: `${"a".repeat(85)}\n\n${"b".repeat(10)}`, truncated: true });
    const lines = `${"a".repeat(90)}\n${"b".repeat(50)}`;
    expect(cutDocument(lines, 100)).toEqual({ text: "a".repeat(90), truncated: true });
    const sentences = `${"a".repeat(88)}. ${"b".repeat(50)}`;
    expect(cutDocument(sentences, 100)).toEqual({ text: `${"a".repeat(88)}.`, truncated: true });
    expect(cutDocument("a".repeat(200), 100)).toEqual({ text: "a".repeat(100), truncated: true });
    /* A break too early (before 80 % of the limit) is not taken: the cut stays near the limit. */
    expect(cutDocument(`${"a".repeat(10)}\n\n${"b".repeat(200)}`, 100)).toEqual({ text: `${"a".repeat(10)}\n\n${"b".repeat(88)}`, truncated: true });
  });

  it("is applied by the assembler, which says so on the fence and hands back the text it read", () => {
    const long: EvidenceGraderInput = { ...INPUT, document: { ...INPUT.document, content: { kind: "text", text: `${"Paragraph one. ".repeat(3000)}\n\n${"Paragraph two. ".repeat(3000)}` } } };
    const prompt = assembleEvidenceGrader(long);
    expect(prompt.truncated).toBe(true);
    expect(prompt.text?.length).toBeLessThanOrEqual(DOCUMENT_CHARS_MAX);
    expect(textOf(prompt.messages[0]?.content)).toContain('truncated="true"');
    expect(textOf(prompt.messages[0]?.content)).toContain(`${prompt.text ?? ""}\n</evidence>`);
  });
});
