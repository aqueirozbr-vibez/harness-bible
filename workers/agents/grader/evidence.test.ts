import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aliasesFromConfig, startStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import { BudgetExceededError } from "@/lib/gateway/errors";
import type { GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";
import { loadGuide } from "@/lib/guides/load";
import { RubricSchema, type Rubric } from "@/lib/schemas/rubric";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";

import { base64Length, bytesWithinBase64, PROVIDER_REQUEST_MAX_BYTES } from "@/lib/improve/media";

import { DOCUMENT_CHARS_MAX, type EvidenceGraderInput } from "./assemble";
import { ageDaysOf, EVIDENCE_GRADER_BYTES_REQUEST, EVIDENCE_GRADER_REQUEST, gradeEvidence, gradeRequestOf, requestBytesBound, type GradeDeps, type GradeEvidenceInput } from "./evidence";

/*
 * One evidence item graded on the stub gateway, started in this process (feature-specs/32 § 7, § 13.5): a document
 * fixture per tier B to G returns that tier with the arithmetic `lib/rubric` makes of it; a fixture whose text says
 * to award tier B is classified by the stub's own answer and not by the text; an output with an unknown key, tier A,
 * a 31-word reason or no JSON is tier U with the parser's reason; a gateway failure is tier U with its cause; a
 * budget refusal is thrown for the workflow; the ledger gets one GRADING row per call with the guide's version and
 * the suggestion as `ref`; independence is code's and the contributor's address is in no request (§ 13.6). The stub
 * cannot read a document, so the tier is the header's: what this proves is the plumbing and the arithmetic, and a
 * real-model run of the fixtures is Andre's to start.
 *
 * Since unit 49f (§ 9): the PDF, PNG and JPEG fixtures go to the stub as the provider's document and image blocks,
 * which the stub refuses in any shape the provider would; bytes code can see the provider would refuse — another
 * type than declared, a side over 8000 px, a PDF whose request would pass 32 MB — are `U` by intake rules with no
 * request sent.
 */

const GUIDE = loadGuide("grader", "v1.3");
const RUBRIC: Rubric = RubricSchema.parse({ ...RUBRIC_V1_2, version: "v1.2", publishedAt: "2026-07-01", appliesAt: "2026-07-01", chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" }, examples: [{ id: "S-36-0198", section: "36.3", changeKind: "EDIT_ROW", changeClass: "CITED_FIGURE", fastMoving: true, items: [{ tier: "B", relevance: "direct", stake: "none", ageDays: 9, base: 85, factors: { relevance: 1, recency: 1, independence: 1 }, adjusted: 85 }], score: 85, strongestItem: 0, corroboratedBy: null, acceptAt: 70, floorAt: 25, route: "ADJUDICATE", decision: "ACCEPT" }], changelog: [{ version: "v1.2", on: "2026-07-01" }] });
const TODAY = new Date("2026-10-06T12:00:00Z");
const TRACE = "0123456789abcdef0123456789abcdef";
const SUGGESTION = "S-21-0001";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8");

function promptOf(document: Partial<EvidenceGraderInput["document"]> = {}, anchor: Partial<EvidenceGraderInput["anchor"]> = {}): EvidenceGraderInput {
  return {
    guide: GUIDE,
    rubric: RUBRIC,
    anchor: { kind: "SECTION", id: "21.3", chapter: 21, text: "Retries are not optional at eleven steps.", fastMoving: false, ...anchor },
    change: { kind: "EDIT_TEXT", anchoredPassage: "Retries are not optional at eleven steps.", proposedText: "Retries are required at eleven steps." },
    document: { kind: "LINK", host: "provider-two.example", mediaType: "text/plain", title: "Pricing", publishedOn: "2026-07-14", content: { kind: "text", text: fixture("C-vendor.txt") }, ...document },
  };
}

const inputOf = (prompt: EvidenceGraderInput, contributorEmail: string | null = "ana@provider-one.example"): GradeEvidenceInput => ({
  prompt,
  independence: { publisherHost: prompt.document.host, contributorEmail },
  call: { principal: { userId: "11111111-1111-4111-8111-111111111111" }, traceId: TRACE, ref: SUGGESTION },
});

let stub: Awaited<ReturnType<typeof startStub>>;
let key = "";
const keySecret = randomBytes(32).toString("hex");
const rows: BudgetRowInput[] = [];
const requests: Array<{ readonly headers: Headers; readonly body: string }> = [];

function depsOf(headers: Record<string, string> = {}, overrides: Partial<GatewayDeps> = {}): GradeDeps {
  const gateway: GatewayDeps = {
    baseUrl: stub.url,
    keySecret,
    findKey: async () => ({ keyCiphertext: encryptKey(keySecret, key) }),
    append: async (row) => {
      rows.push(row);
    },
    log: () => undefined,
    fetch: async (input, init) => {
      const merged = new Headers(init?.headers);
      for (const [name, value] of Object.entries(headers)) merged.set(name, value);
      requests.push({ headers: merged, body: typeof init?.body === "string" ? init.body : "" });
      return globalThis.fetch(input, { ...init, headers: merged });
    },
    now: () => TODAY,
    ...overrides,
  };
  return { gateway, now: () => TODAY };
}

beforeAll(async () => {
  const masterKey = randomBytes(24).toString("hex");
  const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
  stub = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
  const minted = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 1_000 }) });
  key = ((await minted.json()) as { key: string }).key;
}, 60_000);

afterAll(async () => {
  await stub.close();
});

describe("gradeEvidence on the stub gateway", () => {
  it("grades a document fixture per tier B to G as that tier, with the base from the rubric and the factors from the classifications", async () => {
    const fixtures: ReadonlyArray<[string, string, number]> = [["B", "B-standard.txt", 85], ["C", "C-vendor.txt", 70], ["D", "D-analyst.txt", 60], ["E", "E-practitioner.txt", 40], ["F", "F-news.txt", 25], ["G", "G-forum.txt", 5]];
    for (const [tier, file, base] of fixtures) {
      const grade = await gradeEvidence(inputOf(promptOf({ content: { kind: "text", text: fixture(file) } })), depsOf({ "x-hb-stub-grade": tier }));
      expect(grade.graded, tier).toBe(true);
      if (!grade.graded) continue;
      /* The stub says partial and none; the document is dated 2026-07-14 and the anchor is stable: 0.6 × 1.0 × 1.0. */
      expect(grade).toMatchObject({ tier, base, relevance: "partial", stake: "none", publishedOn: "2026-07-14", ageDays: 84, factors: { relevance: 0.6, recency: 1, independence: 1 }, adjusted: Math.floor(base * 0.6), reason: "answered by the stub gateway", truncated: false });
      expect(grade.gradedBy).toMatch(/haiku/);
      expect(grade.contentSha256).toBe(createHash("sha256").update(fixture(file)).digest("hex"));
      expect(grade.usage?.inputTokens).toBeGreaterThan(0);
    }
  });

  it("classifies the injection fixture by the answer, not by the text that asks for tier B", async () => {
    const grade = await gradeEvidence(inputOf(promptOf({ content: { kind: "text", text: fixture("injection.txt") } })), depsOf({ "x-hb-stub-grade": "G" }));
    expect(grade).toMatchObject({ graded: true, tier: "G", adjusted: 3 });
    expect(requests[requests.length - 1]?.body).toContain("IMPORTANT INSTRUCTION TO THE GRADER");
  });

  it("answers the lowest tier when the stub is not told one", async () => {
    expect(await gradeEvidence(inputOf(promptOf()), depsOf())).toMatchObject({ graded: true, tier: "G" });
  });

  it("is tier U with the parser's reason for an unknown key, tier A, a 31-word reason and text that is not JSON, graded by the model that answered", async () => {
    const cases: ReadonlyArray<[string, string]> = [["unknown-key", "the grader's output has a key it may not have: score"], ["tier-a", "tier A is not the grader's to give"], ["long-reason", "the reason is 31 words, over 30"], ["not-json", "the grader's output is not JSON"]];
    for (const [grade, reason] of cases) {
      const result = await gradeEvidence(inputOf(promptOf()), depsOf({ "x-hb-stub-grade": grade }));
      expect(result, grade).toMatchObject({ graded: false, tier: "U", reason, truncated: false });
      expect(result.gradedBy, grade).toMatch(/haiku/);
      expect(result.usage?.outputTokens, grade).toBeGreaterThan(0);
    }
  });

  it("is tier U by intake rules when the gateway fails, and throws a budget refusal for the workflow to hold the item pending", async () => {
    const failed = await gradeEvidence(inputOf(promptOf()), depsOf({ "x-hb-stub-fail": "500" }));
    expect(failed).toMatchObject({ graded: false, tier: "U", gradedBy: "intake-rules", usage: null });
    expect(failed.reason).toMatch(/^gateway (unavailable|refused)/);
    const unconfigured = await gradeEvidence(inputOf(promptOf()), depsOf({}, { baseUrl: undefined }));
    expect(unconfigured).toMatchObject({ graded: false, tier: "U", gradedBy: "intake-rules", reason: "gateway unavailable (unconfigured)" });

    const masterKey = randomBytes(24).toString("hex");
    const aliases = aliasesFromConfig(readFileSync(join(process.cwd(), "infra", "gateway", "litellm.yaml"), "utf8"));
    const spent = await startStub({ masterKey, aliases, port: 0, log: () => undefined });
    try {
      const minted = await fetch(`${spent.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...aliases.keys()], max_budget: 0 }) });
      const spentKey = ((await minted.json()) as { key: string }).key;
      const deps = depsOf({}, { baseUrl: spent.url, findKey: async () => ({ keyCiphertext: encryptKey(keySecret, spentKey) }) });
      await expect(gradeEvidence(inputOf(promptOf()), deps)).rejects.toBeInstanceOf(BudgetExceededError);
    } finally {
      await spent.close();
    }
  });

  it("decides independence by code: the contributor at the publisher's domain is employer, another contributor is what the grader said, and no request names either address", async () => {
    requests.length = 0;
    const employer = await gradeEvidence(inputOf(promptOf({ host: "provider-two.example" }), "ana@provider-two.example"), depsOf({ "x-hb-stub-grade": "C" }));
    expect(employer).toMatchObject({ graded: true, tier: "C", stake: "employer", factors: { relevance: 0.6, recency: 1, independence: 0.7 }, adjusted: 29 });
    const other = await gradeEvidence(inputOf(promptOf({ host: "provider-two.example" }), "ana@provider-one.example"), depsOf({ "x-hb-stub-grade": "C" }));
    expect(other).toMatchObject({ graded: true, stake: "none", factors: { independence: 1 }, adjusted: 42 });
    const researcher = await gradeEvidence(inputOf(promptOf({ host: "provider-two.example" }), null), depsOf({ "x-hb-stub-grade": "C" }));
    expect(researcher).toMatchObject({ graded: true, stake: "none" });
    /* The guide itself says "the contributor" once, in telling the model it sees nothing of them; the values are what must be absent. */
    for (const request of requests) {
      expect(request.body).not.toContain("ana@");
      expect(request.body).not.toContain("provider-one.example");
      expect(request.body).not.toMatch(/contributor(?!\b attached| and nothing)/);
    }
    expect(requests).toHaveLength(3);
  });

  it("takes the document's own date over the grader's, counts the age on the day of grading, and applies recency to a fast-moving anchor only", async () => {
    const stable = await gradeEvidence(inputOf(promptOf({ publishedOn: "2024-01-01" })), depsOf({ "x-hb-stub-grade": "C" }));
    expect(stable).toMatchObject({ graded: true, publishedOn: "2024-01-01", ageDays: 1009, factors: { recency: 1 } });
    const fast = await gradeEvidence(inputOf(promptOf({ publishedOn: "2024-01-01" }, { fastMoving: true })), depsOf({ "x-hb-stub-grade": "C" }));
    expect(fast).toMatchObject({ graded: true, factors: { recency: 0.3 }, adjusted: 12 });
    const recent = await gradeEvidence(inputOf(promptOf({ publishedOn: "2026-09-01" }, { fastMoving: true })), depsOf({ "x-hb-stub-grade": "C" }));
    expect(recent).toMatchObject({ graded: true, ageDays: 35, factors: { recency: 1 }, adjusted: 42 });
    /* The stub's grader gives no date, so a document without one has none: old for a fast-moving anchor. */
    const undated = await gradeEvidence(inputOf(promptOf({ publishedOn: null }, { fastMoving: true })), depsOf({ "x-hb-stub-grade": "C" }));
    expect(undated).toMatchObject({ graded: true, publishedOn: null, ageDays: null, factors: { recency: 0.3 } });
    expect(ageDaysOf("2026-10-07", TODAY)).toBe(0);
    expect(ageDaysOf("nonsense", TODAY)).toBeNull();
  });

  it("cuts a long document, says so, and hashes the text it read", async () => {
    const long = `${"Paragraph. ".repeat(4000)}\n\n${"Tail. ".repeat(4000)}`;
    const grade = await gradeEvidence(inputOf(promptOf({ content: { kind: "text", text: long } })), depsOf({ "x-hb-stub-grade": "E" }));
    expect(grade.truncated).toBe(true);
    expect(grade.text?.length).toBeLessThanOrEqual(DOCUMENT_CHARS_MAX);
    expect(long.startsWith(grade.text ?? "-")).toBe(true);
    expect(grade.contentSha256).toBe(createHash("sha256").update(grade.text ?? "").digest("hex"));
    expect(grade.contentSha256).not.toBe(createHash("sha256").update(long).digest("hex"));
    expect(requests[requests.length - 1]?.body).toContain('truncated=\\"true\\"');
  });

  it("writes one GRADING row per call with the guide's version and the suggestion as ref, on the evidenceGrader request row", async () => {
    rows.length = 0;
    await gradeEvidence(inputOf(promptOf()), depsOf({ "x-hb-stub-grade": "D" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "GRADING", alias: "hb-small", ref: SUGGESTION, traceId: TRACE, outcome: "ok" });
    expect(rows[0]?.modelId).toMatch(/haiku/);
    const body = JSON.parse(requests[requests.length - 1]?.body ?? "{}") as { model: string; max_tokens: number; output_config?: unknown; system: ReadonlyArray<{ cache_control?: unknown }> };
    expect(body).toMatchObject({ model: "hb-small", max_tokens: 512 });
    expect(body.output_config).toBeUndefined();
    expect(body.system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(EVIDENCE_GRADER_REQUEST).toEqual({ model: "hb-small", max_tokens: 512 });
  });

  describe("a PDF and an image (unit 49f, § 9)", () => {
    const bytesOf = (name: string): Buffer => readFileSync(join(import.meta.dirname, "__fixtures__", name));
    const PDF = bytesOf("C-vendor.pdf");
    const PNG = bytesOf("C-vendor.png");
    const JPG = bytesOf("C-vendor.jpg");
    const bytesPrompt = (mediaType: "application/pdf" | "image/png" | "image/jpeg", data: Buffer, host: string | null = null): EvidenceGraderInput =>
      promptOf({ kind: host === null ? "UPLOAD" : "LINK", host, mediaType, title: null, publishedOn: null, content: { kind: "bytes", mediaType, data } });
    const sent = (): { messages: ReadonlyArray<{ content: ReadonlyArray<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> }> } => JSON.parse(requests[requests.length - 1]?.body ?? "{}") as never;

    it("sends the PDF fixture as the provider's document block between the fence's text blocks, and grades it as the stub says", async () => {
      requests.length = 0;
      const grade = await gradeEvidence(inputOf(bytesPrompt("application/pdf", PDF)), depsOf({ "x-hb-stub-grade": "C" }));
      expect(grade).toMatchObject({ graded: true, tier: "C", base: 70, text: null, truncated: false, contentSha256: createHash("sha256").update(PDF).digest("hex") });
      expect(requests).toHaveLength(1);
      const [message] = sent().messages;
      expect(message?.content.map((block) => block.type)).toEqual(["text", "document", "text"]);
      expect(message?.content[1]?.source).toEqual({ type: "base64", media_type: "application/pdf", data: PDF.toString("base64") });
      expect(message?.content[0]?.text).toContain('<evidence kind="UPLOAD" source="upload" type="application/pdf" published="unknown" truncated="false">');
      expect(message?.content[2]?.text).toBe("</evidence>");
      /* The stub counts a PDF as one page of text and image: 4,568 tokens on top of the text's. */
      expect((grade.usage?.inputTokens ?? 0) + (grade.usage?.cacheReadTokens ?? 0)).toBeGreaterThan(4568);
    });

    it("sends the PNG and the JPEG fixtures as the provider's image blocks with their own media types", async () => {
      for (const [mediaType, data] of [["image/png", PNG], ["image/jpeg", JPG]] as const) {
        requests.length = 0;
        const grade = await gradeEvidence(inputOf(bytesPrompt(mediaType, data, "provider-two.example")), depsOf({ "x-hb-stub-grade": "C" }));
        expect(grade, mediaType).toMatchObject({ graded: true, tier: "C", text: null, contentSha256: createHash("sha256").update(data).digest("hex") });
        expect(sent().messages[0]?.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });
      }
    });

    it("grades a screenshot by its classifications like any item: independence from the host, recency from the anchor", async () => {
      const grade = await gradeEvidence(inputOf(bytesPrompt("image/png", PNG, "provider-two.example"), "ana@provider-two.example"), depsOf({ "x-hb-stub-grade": "G" }));
      expect(grade).toMatchObject({ graded: true, tier: "G", stake: "employer", factors: { relevance: 0.6, recency: 1, independence: 0.7 }, base: 5, adjusted: 2 });
    });

    it("is U by intake rules with no request sent for bytes that are not the type given, an image wider than 8000 px, an image over 10 MB of base64 and a PDF over the request's limit", async () => {
      const wide = Buffer.alloc(64);
      PNG.copy(wide, 0, 0, 33);
      wide.writeUInt32BE(8001, 16);
      const heavy = Buffer.alloc(7_500_001);
      PNG.copy(heavy, 0, 0, 33);
      const pdfOf = (size: number): Buffer => {
        const bytes = Buffer.alloc(size, 0x20);
        PDF.copy(bytes, 0, 0, 16);
        return bytes;
      };
      const cases: ReadonlyArray<readonly [EvidenceGraderInput, string]> = [
        [bytesPrompt("application/pdf", PNG), "media_mismatch"],
        [bytesPrompt("image/png", JPG), "media_mismatch"],
        [bytesPrompt("image/png", wide), "image_dimensions"],
        [bytesPrompt("image/png", heavy), "image_too_large"],
        [bytesPrompt("application/pdf", pdfOf(24_000_001)), "pdf_too_large"],
        /* Its base64 alone is 32,000,000 bytes: with the guide, the rubric and the fences the request passes 32 MB. */
        [bytesPrompt("application/pdf", pdfOf(24_000_000)), "request_too_large"],
      ];
      for (const [prompt, reason] of cases) {
        requests.length = 0;
        rows.length = 0;
        const grade = await gradeEvidence(inputOf(prompt), depsOf({ "x-hb-stub-grade": "B" }));
        expect(grade, reason).toMatchObject({ graded: false, tier: "U", reason, gradedBy: "intake-rules", usage: null, text: null });
        expect(requests, reason).toHaveLength(0);
        expect(rows, reason).toHaveLength(0);
      }
    });

    it("is U with the gateway's status when the provider refuses what code cannot see, such as a PDF's pages: one request and one refused row", async () => {
      requests.length = 0;
      rows.length = 0;
      /* The stub's 400 stands in for the provider refusing a well-formed PDF it cannot read. */
      const refused = await gradeEvidence(inputOf(bytesPrompt("application/pdf", PDF)), depsOf({ "x-hb-stub-fail": "400" }));
      expect(refused).toMatchObject({ graded: false, tier: "U", reason: "gateway refused (400)", gradedBy: "intake-rules", usage: null });
      expect(requests).toHaveLength(1);
      expect(rows).toEqual([expect.objectContaining({ kind: "GRADING", outcome: "refused" })]);
    });

    it("names its own request row: a PDF's call is one try, so a 500 is not retried and the body goes once", async () => {
      expect(gradeRequestOf(inputOf(bytesPrompt("application/pdf", PDF))).call.row).toBe("evidenceGraderBytes");
      expect(gradeRequestOf(inputOf(promptOf())).call.row).toBeUndefined();
      /* and names its agent by the same test: the name the collector's lock reads, so a PDF's or an image's
         base64 never reaches Langfuse whatever the text switch says (feature-specs/49 § 9.3; unit 81's review) */
      expect(gradeRequestOf(inputOf(bytesPrompt("application/pdf", PDF))).call.agent).toBe("evidence.grade.bytes");
      expect(gradeRequestOf(inputOf(promptOf())).call.agent).toBe("evidence.grade");
      /* The body is built from the row the call names, as the limits are (the two rows agree today). */
      expect(gradeRequestOf(inputOf(bytesPrompt("application/pdf", PDF))).request).toMatchObject(EVIDENCE_GRADER_BYTES_REQUEST);
      expect(gradeRequestOf(inputOf(promptOf())).request).toMatchObject(EVIDENCE_GRADER_REQUEST);
      requests.length = 0;
      const failed = await gradeEvidence(inputOf(bytesPrompt("application/pdf", PDF)), depsOf({ "x-hb-stub-fail": "500" }));
      expect(failed).toMatchObject({ graded: false, tier: "U", reason: "gateway unavailable (server)", gradedBy: "intake-rules" });
      expect(requests).toHaveLength(1);
    });

    it("counts U+007F as six bytes, as Python's json.dumps writes it, and any other character of the rest as three at most", () => {
      const withChange = (proposedText: string): EvidenceGraderInput => {
        const prompt = promptOf();
        return { ...prompt, change: { ...prompt.change, proposedText } };
      };
      const boundOf = (prompt: EvidenceGraderInput): number => {
        const { call, request } = gradeRequestOf(inputOf(prompt));
        return requestBytesBound(request, call);
      };
      /* A thousand "x" become a thousand U+007F: each counted three bytes more. */
      expect(boundOf(withChange(`a${"\u007f".repeat(1000)}`)) - boundOf(withChange(`a${"x".repeat(1000)}`))).toBe(3000);
    });

    it("measures an upper bound of the body as sent, and refuses at it: the largest PDF that fits is sent once, one base64 group more is not", { timeout: 60_000 }, async () => {
      const pdfOf = (size: number): Buffer => {
        const bytes = Buffer.alloc(size, 0x20);
        PDF.copy(bytes, 0, 0, 16);
        return bytes;
      };
      const boundOf = (data: Buffer): number => {
        const { call, request } = gradeRequestOf(inputOf(bytesPrompt("application/pdf", data)));
        return requestBytesBound(request, call);
      };
      /* The rest of the request does not depend on the PDF's size: the bound is the base64 plus three times the rest. */
      const tiny = pdfOf(16);
      const rest = boundOf(tiny) - base64Length(tiny.length);
      expect(rest).toBeGreaterThan(3 * 4096);
      const largest = bytesWithinBase64(PROVIDER_REQUEST_MAX_BYTES - rest);
      expect(boundOf(pdfOf(largest))).toBeLessThanOrEqual(PROVIDER_REQUEST_MAX_BYTES);

      requests.length = 0;
      const sent = await gradeEvidence(inputOf(bytesPrompt("application/pdf", pdfOf(largest))), depsOf({ "x-hb-stub-grade": "C" }));
      expect(sent).toMatchObject({ graded: true, tier: "C" });
      expect(requests).toHaveLength(1);
      expect(Buffer.byteLength(requests[0]?.body ?? "")).toBeLessThanOrEqual(PROVIDER_REQUEST_MAX_BYTES);

      requests.length = 0;
      const over = await gradeEvidence(inputOf(bytesPrompt("application/pdf", pdfOf(largest + 3))), depsOf({ "x-hb-stub-grade": "C" }));
      expect(over).toMatchObject({ graded: false, tier: "U", reason: "request_too_large", gradedBy: "intake-rules" });
      expect(requests).toHaveLength(0);
    });
  });
});
