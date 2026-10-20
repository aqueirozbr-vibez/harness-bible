import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EMBED_MODEL_ID, RERANK_MODEL_ID } from "@/lib/gateway/prices";

import {
  answer,
  cacheablePrefix,
  chunks,
  claimsFor,
  fencedQuestion,
  fencedSections,
  gradingOutput,
  imageTokensOf,
  isClassification,
  mediaTokensOf,
  parseStubGrade,
  requestText,
  STREAM_CHUNK_CHARACTERS,
  StubRequestSchema,
  tokensOf,
  type StubRequest,
  UNCITED_CLAIM,
} from "@/infra/gateway/stub/answer";
import { budgetExceeded, budgetMessage, charge, deleteKeys, findKey, firstOfNextMonth, keyInfo, keyName, mintKey, type KeyTable } from "@/infra/gateway/stub/keys";
import { dimensionOf, embeddings, stubEmbedding, wordsOf } from "@/infra/gateway/stub/embed";
import { overlapScore, reranked } from "@/infra/gateway/stub/rerank";
import { aliasesFromConfig, SMALL_ALIAS, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import { costOf, MODEL_PRICES as PRICES } from "@/lib/gateway/prices";
import { PROVIDER_REQUEST_MAX_BYTES } from "@/lib/improve/media";
import { EMBEDDING_DIMENSIONS } from "@/lib/schemas/gateway";

/*
 * The stub gateway (feature-specs/11 § 4): its answers are pure functions of the request, its key table holds
 * LiteLLM's shapes, and the HTTP surface is what lib/gateway/client.ts (25c) and the key script will use. The
 * server runs in-process on a free port; the same code path listens on 4001 under `npm run gateway:stub`.
 */

const MASTER_KEY = "test-master-key-for-the-stub";
const CONFIG = readFileSync(join(import.meta.dirname, "..", "infra", "gateway", "litellm.yaml"), "utf8");
const ALIASES = aliasesFromConfig(CONFIG);

const GUIDE = "You are the assistant of the book. Cite a section for every claim.".repeat(8);
const SECTION_21_3 = `<section id="21.3" chapter="21" version="v1.0.0" edition="EN" verify="PASSED">
A loop that restarts from step 1 repeats every side effect before the failure. The expected work redone is measured here.
figures: F-21-05 "expected work redone" 45% (derived, L14); F-21-07 "duplicate side effects a day" 117 (derived, L47)
</section>`;
const SECTION_26_3 = `<section id="26.3" chapter="26" version="v1.0.0" edition="EN" verify="PASSED">
The grader sees the answer and the sections only. It never sees the question.
</section>`;

function assistantRequest(question: string, stream = false): StubRequest {
  return {
    model: "hb-frontier",
    max_tokens: 4096,
    stream,
    system: [
      { type: "text", text: GUIDE, cache_control: { type: "ephemeral" } },
      { type: "text", text: "release 2026.09 · mode explain · answer in en · edition EN" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: `${SECTION_21_3}\n${SECTION_26_3}` }] },
      { role: "user", content: `<question>${question}</question>` },
    ],
  };
}

const CLASSIFIER_REQUEST: StubRequest = {
  model: "hb-small",
  max_tokens: 256,
  system: 'Answer {"cause": "R-SCOPE" | "R-SCOPE-OT" | "R-RECOMPUTE" | "none", "reason": ≤ 20 words}.',
  messages: [{ role: "user", content: "How is the P-101 loop retried?" }],
};

/* The grader's fixtures as Chromium rendered them (unit 49f), and the provider's two media blocks built from them. */
const GRADER_FIXTURES = join(process.cwd(), "workers", "agents", "grader", "__fixtures__");
const PDF_B64 = readFileSync(join(GRADER_FIXTURES, "C-vendor.pdf")).toString("base64");
const PNG_B64 = readFileSync(join(GRADER_FIXTURES, "C-vendor.png")).toString("base64");
const documentBlock = (data = PDF_B64, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data }, ...extra });
const imageBlock = (data = PNG_B64, mediaType = "image/png", extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "image", source: { type: "base64", media_type: mediaType, data }, ...extra });

/** The evidence grader's shape (feature-specs/32 § 7; unit 49d): the small alias with an evidence fence in the message. */
const GRADER_REQUEST: StubRequest = {
  model: "hb-small",
  max_tokens: 512,
  system: [{ type: "text", text: "You classify one piece of evidence." }, { type: "text", text: "rubric v1.2", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: ['<anchor kind="SECTION" id="21.3" chapter="21" fast-moving="false">', "Retries are not optional.", "</anchor>", "", '<change kind="EDIT_TEXT">', "after: Retries are required.", "</change>", "", '<evidence kind="LINK" source="provider-two.example" type="text/html" published="unknown" truncated="false">', "A pricing page.", "</evidence>"].join("\n") }],
};

const CHECK_REQUEST: StubRequest = { model: "hb-small", max_tokens: 64, messages: [{ role: "user", content: "gateway check" }] };

function never(): boolean {
  return false;
}

describe("aliasesFromConfig", () => {
  it("reads the four aliases and drops the provider prefix", () => {
    expect([...ALIASES.entries()]).toEqual([
      ["hb-frontier", "claude-opus-5"],
      ["hb-small", "claude-haiku-4-5"],
      ["hb-embed", EMBED_MODEL_ID],
      ["hb-rerank", RERANK_MODEL_ID],
    ]);
  });

  it("refuses a configuration whose names and models do not pair", () => {
    expect(() => aliasesFromConfig("model_list:\n  - model_name: a\n")).toThrow("every model_name needs one model");
    expect(() => aliasesFromConfig("")).toThrow("every model_name needs one model");
  });
});

describe("request text and tokens", () => {
  it("joins the system blocks, a system string and every message text, in order", () => {
    expect(requestText({ system: "s", messages: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text", text: "b" }, imageBlock() as { type: string }] }] })).toBe("s\na\nb");
    expect(requestText({ system: [{ type: "text", text: "x" }, { type: "text", text: "y" }], messages: [{ role: "user", content: "q" }] })).toBe("x\ny\nq");
    expect(requestText({ messages: [{ role: "user", content: "q" }] })).toBe("q");
  });

  it("counts four characters to a token and never fewer than one", () => {
    expect(tokensOf("")).toBe(1);
    expect(tokensOf("abcd")).toBe(1);
    expect(tokensOf("abcde")).toBe(2);
    expect(tokensOf("a".repeat(400))).toBe(100);
  });

  it("takes the cacheable prefix up to the last cache_control block, or none", () => {
    expect(cacheablePrefix(assistantRequest("q"))).toBe(GUIDE);
    expect(cacheablePrefix({ system: [{ type: "text", text: "a" }, { type: "text", text: "b", cache_control: { type: "ephemeral" } }] })).toBe("a\nb");
    expect(cacheablePrefix({ system: [{ type: "text", text: "a" }] })).toBeNull();
    expect(cacheablePrefix({ system: "plain" })).toBeNull();
    expect(cacheablePrefix({})).toBeNull();
  });

  it("validates the request shape the stub reads", () => {
    expect(StubRequestSchema.safeParse({ model: "hb-small", messages: [] }).success).toBe(false);
    expect(StubRequestSchema.safeParse({ model: "", messages: [{ role: "user", content: "q" }] }).success).toBe(false);
    expect(StubRequestSchema.safeParse({ model: "hb-small", messages: [{ role: "user", content: "q" }], output_config: { effort: "high" } }).success).toBe(true);
  });

  it("takes a PDF and an image as the provider documents them, base64 only, with their optional fields (unit 49f)", () => {
    const ok = (block: Record<string, unknown>): boolean => StubRequestSchema.safeParse({ model: "hb-small", messages: [{ role: "user", content: [{ type: "text", text: "q" }, block] }] }).success;
    expect(ok(documentBlock())).toBe(true);
    expect(ok(documentBlock(PDF_B64, { title: "t", context: "c", citations: { enabled: false }, cache_control: { type: "ephemeral" } }))).toBe(true);
    expect(ok(imageBlock())).toBe(true);
    for (const type of ["image/jpeg", "image/gif", "image/webp"]) expect(ok(imageBlock(PNG_B64, type)), type).toBe(true);
    expect(ok(imageBlock(PNG_B64, "image/png", { cache_control: { type: "ephemeral" }, transformations: { oversized_image: "error" } }))).toBe(true);
  });

  it("refuses a media block of any other shape: a url source, another media type, data that is not base64 or holds a newline, an empty one, a field the provider does not know, an image over 10 MB of base64, and a media block in the system prompt", () => {
    const refused = (block: Record<string, unknown>): boolean => !StubRequestSchema.safeParse({ model: "hb-small", messages: [{ role: "user", content: [block] }] }).success;
    expect(refused({ type: "document", source: { type: "url", url: "https://provider-two.example/a.pdf" } })).toBe(true);
    expect(refused({ type: "image", source: { type: "url", url: "https://provider-two.example/a.png" } })).toBe(true);
    expect(refused({ type: "document", source: { type: "file", file_id: "file_1" } })).toBe(true);
    expect(refused({ type: "document" })).toBe(true);
    expect(refused({ type: "image" })).toBe(true);
    expect(refused(documentBlock(PDF_B64, { transformations: { oversized_image: "error" } }))).toBe(true);
    expect(refused({ type: "document", source: { type: "base64", media_type: "application/x-pdf", data: PDF_B64 } })).toBe(true);
    expect(refused(imageBlock(PNG_B64, "image/bmp"))).toBe(true);
    expect(refused(imageBlock(PNG_B64, "application/pdf"))).toBe(true);
    expect(refused(documentBlock(`${PDF_B64.slice(0, 76)}\n${PDF_B64.slice(76)}`))).toBe(true);
    expect(refused(documentBlock("not base64!"))).toBe(true);
    expect(refused(documentBlock("abc"))).toBe(true);
    expect(refused(documentBlock(""))).toBe(true);
    expect(refused(imageBlock("A".repeat(10_000_004)))).toBe(true);
    expect(refused(imageBlock("A".repeat(10_000_000)))).toBe(false);
    expect(StubRequestSchema.safeParse({ model: "hb-small", system: [{ type: "text", text: "s" }, imageBlock()], messages: [{ role: "user", content: "q" }] }).success).toBe(false);
  });

  it("counts a media block by the stub's own rule: an image by its header's patches, at most 1,568; a PDF as one page of text and image", () => {
    /* The PNG fixture is 800 × 420: ⌈800/28⌉ × ⌈420/28⌉ = 29 × 15. */
    expect(imageTokensOf(PNG_B64)).toBe(435);
    expect(imageTokensOf(Buffer.from("not an image").toString("base64"))).toBe(1568);
    expect(mediaTokensOf({ messages: [{ role: "user", content: [{ type: "text", text: "q" }, imageBlock(), documentBlock()] }] } as Pick<StubRequest, "messages">)).toBe(435 + 3000 + 1568);
    expect(mediaTokensOf({ messages: [{ role: "user", content: "q" }] })).toBe(0);
  });
});

describe("fenced sections and claims", () => {
  it("parses each fence's id, body and figure line", () => {
    const sections = fencedSections(`${SECTION_21_3}\n${SECTION_26_3}`);
    expect(sections.map((s) => s.id)).toEqual(["21.3", "26.3"]);
    expect(sections[0].text).toBe("A loop that restarts from step 1 repeats every side effect before the failure. The expected work redone is measured here.");
    expect(sections[0].figures).toEqual([
      { id: "F-21-05", label: "expected work redone", value: "45%" },
      { id: "F-21-07", label: "duplicate side effects a day", value: "117" },
    ]);
    expect(sections[1].figures).toEqual([]);
    expect(fencedSections("no fence here")).toEqual([]);
  });

  it("skips a figure item it cannot parse and keeps the rest", () => {
    const [section] = fencedSections('<section id="21.4">body\nfigures: not a figure; F-21-09 "label" 3 (open)\n</section>');
    expect(section.figures).toEqual([{ id: "F-21-09", label: "label", value: "3" }]);
  });

  it("cites the first figure as printed, else the first sentence, else the section alone", () => {
    const claims = claimsFor(fencedSections(`${SECTION_21_3}\n${SECTION_26_3}\n<section id="30.1">\n</section>\n<section id="30.2">no full stop here</section>`));
    expect(claims).toEqual([
      { text: "expected work redone: 45% (21.3).", sectionId: "21.3", figureId: "F-21-05" },
      { text: "The grader sees the answer and the sections only.", sectionId: "26.3" },
      { text: "Section 30.1.", sectionId: "30.1" },
      { text: "no full stop here", sectionId: "30.2" },
    ]);
  });

  it("cites the figure the question names in quotation marks, and the first one when it names none of the section's", () => {
    const sections = fencedSections(SECTION_21_3);
    const question = fencedQuestion(`${SECTION_21_3}\n<question>\nan earlier turn\n</question>\n<question>\nIn section 21.3, what is the value of "duplicate side effects a day"?\n</question>`);
    expect(question).toBe('In section 21.3, what is the value of "duplicate side effects a day"?');
    expect(claimsFor(sections, "explain", question)).toEqual([{ text: "duplicate side effects a day: 117 (21.3).", sectionId: "21.3", figureId: "F-21-07" }]);
    expect(claimsFor(sections, "explain", 'what is "a label no section holds"?')[0]?.figureId).toBe("F-21-05");
    /* Words without the quotation marks name nothing: the stub does not guess at meaning. */
    expect(claimsFor(sections, "explain", "how many duplicate side effects a day?")[0]?.figureId).toBe("F-21-05");
    expect(fencedQuestion("no fence")).toBeNull();
  });

  it("recognises a classification request by the small alias and a cause code", () => {
    expect(isClassification("hb-small", SMALL_ALIAS, requestText(CLASSIFIER_REQUEST))).toBe(true);
    expect(isClassification("hb-frontier", SMALL_ALIAS, requestText(CLASSIFIER_REQUEST))).toBe(false);
    expect(isClassification("hb-small", SMALL_ALIAS, requestText(CHECK_REQUEST))).toBe(false);
  });
});

describe("answer", () => {
  const price = PRICES["claude-opus-5"];

  it("adds one claim its section does not support when asked for an uncited one, and none otherwise", () => {
    const plain = JSON.parse(answer({ request: assistantRequest("What is redone?"), smallAlias: SMALL_ALIAS, price, cause: "none", prefixSeen: never }).text) as { claims: Array<{ text: string }> };
    const uncited = JSON.parse(answer({ request: assistantRequest("What is redone?"), smallAlias: SMALL_ALIAS, price, cause: "none", prefixSeen: never, claim: "uncited" }).text) as { claims: Array<{ text: string; sectionId: string; figureId?: string }> };
    expect(plain.claims.some((claim) => claim.text === UNCITED_CLAIM)).toBe(false);
    expect(uncited.claims).toHaveLength(plain.claims.length + 1);
    /* It cites the first fenced section, names no figure, and shares no word with a section. */
    expect(uncited.claims.at(-1)).toEqual({ text: UNCITED_CLAIM, sectionId: "21.3" });
    /* A classifier's answer has no claims to add one to. */
    expect(JSON.parse(answer({ request: CLASSIFIER_REQUEST, smallAlias: SMALL_ALIAS, price: PRICES["claude-haiku-4-5"], cause: "none", prefixSeen: never, claim: "uncited" }).text)).toEqual({ cause: "none", reason: "answered by the stub gateway" });
  });

  it("answers an assistant request with claims that cite the fenced sections", () => {
    const result = answer({ request: assistantRequest("What is redone?"), smallAlias: SMALL_ALIAS, price, cause: "none", prefixSeen: never });
    expect(result.kind).toBe("assistant");
    /* The envelope carries the mode result and the refusal beside the claims (spec 19 § 5): null in explain. */
    expect(JSON.parse(result.text)).toEqual({
      refusal: null,
      mode_result: null,
      claims: [
        { text: "expected work redone: 45% (21.3).", sectionId: "21.3", figureId: "F-21-05" },
        { text: "The grader sees the answer and the sections only.", sectionId: "26.3" },
      ],
    });
  });

  it("answers a classification with the header's cause, or none", () => {
    const withCause = answer({ request: CLASSIFIER_REQUEST, smallAlias: SMALL_ALIAS, price: PRICES["claude-haiku-4-5"], cause: "R-SCOPE-OT", prefixSeen: never });
    expect(withCause.kind).toBe("classification");
    expect(JSON.parse(withCause.text)).toEqual({ cause: "R-SCOPE-OT", reason: "answered by the stub gateway" });
    const plain = answer({ request: CLASSIFIER_REQUEST, smallAlias: SMALL_ALIAS, price: PRICES["claude-haiku-4-5"], cause: "none", prefixSeen: never });
    expect(JSON.parse(plain.text).cause).toBe("none");
  });

  it("grades with the header's tier and, when it names them, its relevance and stake (spec 33 § 8; unit 50g)", () => {
    expect(parseStubGrade("C")).toEqual({ grade: "C", classes: { relevance: "partial", stake: "none" } });
    expect(parseStubGrade("B:direct:none")).toEqual({ grade: "B", classes: { relevance: "direct", stake: "none" } });
    expect(parseStubGrade("C:direct:vendor")).toEqual({ grade: "C", classes: { relevance: "direct", stake: "vendor" } });
    for (const refused of ["A:direct:none", "B:sideways:none", "B:direct", "b:direct:none", "Z"]) expect(parseStubGrade(refused), refused).toBeNull();
    expect(JSON.parse(gradingOutput("G", { relevance: "direct", stake: "none" }))).toMatchObject({ tier: "G", relevance: "direct", stake: "none", publishedOn: null });
    expect(JSON.parse(gradingOutput("G"))).toMatchObject({ tier: "G", relevance: "partial", stake: "none" });
  });

  it("echoes a fixed object for any other request", () => {
    const result = answer({ request: CHECK_REQUEST, smallAlias: SMALL_ALIAS, price: PRICES["claude-haiku-4-5"], cause: "none", prefixSeen: never });
    expect(result.kind).toBe("echo");
    expect(JSON.parse(result.text)).toEqual({ stub: "harness-bible", alias: "hb-small", characters: "gateway check".length });
    expect(result.prefixSha256).toBeNull();
    expect(result.usage).toEqual({ input_tokens: 4, output_tokens: tokensOf(result.text), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  });

  it("writes the prefix to the cache on first sight and reads it on the second request", () => {
    const request = assistantRequest("first");
    const first = answer({ request, smallAlias: SMALL_ALIAS, price, cause: "none", prefixSeen: never });
    const prefixTokens = tokensOf(GUIDE);
    expect(first.prefixSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.usage.cache_creation_input_tokens).toBe(prefixTokens);
    expect(first.usage.cache_read_input_tokens).toBe(0);
    expect(first.usage.input_tokens).toBe(tokensOf(requestText(request)) - prefixTokens);

    const second = answer({ request: assistantRequest("a different question"), smallAlias: SMALL_ALIAS, price, cause: "none", prefixSeen: (sha) => sha === first.prefixSha256 });
    expect(second.prefixSha256).toBe(first.prefixSha256);
    expect(second.usage.cache_read_input_tokens).toBe(prefixTokens);
    expect(second.usage.cache_creation_input_tokens).toBe(0);
    expect(second.costUsd).toBeLessThan(first.costUsd);
  });

  it("prices a usage block at the pinned rates", () => {
    expect(costOf(price, { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(5);
    expect(costOf(price, { input_tokens: 0, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(25);
    expect(costOf(price, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0 })).toBe(6.25);
    expect(costOf(price, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBe(0.5);
    expect(PRICES["claude-haiku-4-5"]).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  it("splits a streamed answer into fixed-size deltas that join back to the text", () => {
    const text = "x".repeat(STREAM_CHUNK_CHARACTERS * 2 + 5);
    const parts = chunks(text);
    expect(parts).toHaveLength(3);
    expect(parts.join("")).toBe(text);
    expect(chunks("")).toEqual([]);
  });
});

describe("key table", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");

  it("mints a key with the first of next month as its reset, findable by key or by hash", () => {
    const table: KeyTable = new Map();
    const record = mintKey(table, { max_budget: 0.5, budget_duration: "1mo", tpm_limit: 1000, models: ["hb-small"], metadata: { organisationId: "org-1", kind: "organisation" } }, now);
    expect(record.key).toMatch(/^sk-[0-9a-f]{32}$/);
    expect(record.budgetResetAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(findKey(table, record.key, now)).toEqual(record);
    expect(findKey(table, record.token, now)).toEqual(record);
    expect(findKey(table, "sk-unknown", now)).toBeNull();
    expect(keyName(record.key)).toBe(`sk-...${record.key.slice(-4)}`);
    expect(firstOfNextMonth(new Date("2026-12-31T23:59:59.000Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("mints a key without a budget when none is given", () => {
    const table: KeyTable = new Map();
    const record = mintKey(table, {}, now);
    expect(record.maxBudget).toBeNull();
    expect(record.budgetResetAt).toBeNull();
    expect(record.models).toEqual([]);
    expect(budgetExceeded(record)).toBe(false);
    expect(keyInfo(record, false)).not.toHaveProperty("key");
    expect(keyInfo(record, true)).toHaveProperty("key", record.key);
  });

  it("refuses once the spend reaches the budget and rolls the window on the reset date", () => {
    const table: KeyTable = new Map();
    const record = mintKey(table, { max_budget: 0.001, budget_duration: "1mo", key_alias: "org-1" }, now);
    expect(budgetExceeded(record)).toBe(false);
    const charged = charge(table, record, 0.001);
    expect(budgetExceeded(charged)).toBe(true);
    expect(budgetMessage(charged)).toBe(`Budget has been exceeded! Key=org-1 (${keyName(record.key)}) Current cost: 0.001, Max budget: 0.001`);
    expect(budgetMessage({ ...charged, keyAlias: null })).toContain("Key=key (");
    const rolled = findKey(table, record.key, new Date("2026-10-01T00:00:00.000Z"));
    expect(rolled?.spend).toBe(0);
    expect(rolled?.budgetResetAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(budgetExceeded(rolled ?? charged)).toBe(false);
  });

  it("deletes by key or by hash and reports what it deleted", () => {
    const table: KeyTable = new Map();
    const a = mintKey(table, {}, now);
    const b = mintKey(table, {}, now);
    expect(deleteKeys(table, [a.key, b.token, "sk-nothing"])).toEqual([a.key, b.token]);
    expect(table.size).toBe(0);
  });
});

describe("the stub over HTTP", () => {
  let stub: RunningStub;
  const lines: string[] = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: (line) => lines.push(line) });
  });
  afterAll(async () => {
    await stub.close();
  });

  async function mint(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  function post(path: string, key: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${stub.url}${path}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  }

  it("answers the liveliness probe", async () => {
    const res = await fetch(`${stub.url}/health/liveliness`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBe("I'm alive!");
  });

  it("manages keys under the master key only, in LiteLLM's shapes", async () => {
    const denied = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: "Bearer sk-not-the-master", "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { type: "auth_error", code: "401" } });

    const minted = await mint({ max_budget: 0.5, budget_duration: "1mo", tpm_limit: 1000, models: ["hb-frontier", "hb-small"], metadata: { organisationId: "org-1", kind: "organisation" } });
    expect(minted).toMatchObject({ max_budget: 0.5, budget_duration: "1mo", tpm_limit: 1000, spend: 0, models: ["hb-frontier", "hb-small"], metadata: { organisationId: "org-1", kind: "organisation" } });
    expect(minted.key).toMatch(/^sk-[0-9a-f]{32}$/);
    expect(minted.budget_reset_at).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);

    const info = await fetch(`${stub.url}/key/info?key=${minted.token as string}`, { headers: { authorization: `Bearer ${MASTER_KEY}` } });
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as { key: string; info: Record<string, unknown> };
    expect(infoBody.key).toBe(minted.token);
    expect(infoBody.info).toMatchObject({ spend: 0, max_budget: 0.5, budget_reset_at: minted.budget_reset_at });
    expect(infoBody.info).not.toHaveProperty("key");

    const missing = await fetch(`${stub.url}/key/info?key=sk-nothing`, { headers: { authorization: `Bearer ${MASTER_KEY}` } });
    expect(missing.status).toBe(404);
    const noKey = await fetch(`${stub.url}/key/info`, { headers: { authorization: `Bearer ${MASTER_KEY}` } });
    expect(noKey.status).toBe(400);

    const badBudget = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ budget_duration: "30d" }) });
    expect(badBudget.status).toBe(400);
    expect(((await badBudget.json()) as { error: { message: string } }).error.message).toContain("budget_duration");

    const deleted = await fetch(`${stub.url}/key/delete`, { method: "POST", headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ keys: [minted.key] }) });
    expect(await deleted.json()).toEqual({ deleted_keys: [minted.key] });
    const again = await fetch(`${stub.url}/key/delete`, { method: "POST", headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ keys: [minted.key] }) });
    expect(again.status).toBe(404);
    const gone = await post("/v1/messages", minted.key as string, CHECK_REQUEST);
    expect(gone.status).toBe(401);
    expect(await gone.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("refuses a call without a key, with an unknown alias, or outside the key's models", async () => {
    const noKey = await fetch(`${stub.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(CHECK_REQUEST) });
    expect(noKey.status).toBe(401);
    const minted = await mint({ models: ["hb-small"] });
    const embed = await post("/v1/messages", minted.key as string, { ...CHECK_REQUEST, model: "hb-embed" });
    expect(embed.status).toBe(400);
    expect(await embed.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    const outside = await post("/v1/messages", minted.key as string, { ...CHECK_REQUEST, model: "hb-frontier" });
    expect(outside.status).toBe(401);
    const malformed = await fetch(`${stub.url}/v1/messages`, { method: "POST", headers: { "x-api-key": minted.key as string, "content-type": "application/json" }, body: "{not json" });
    expect(malformed.status).toBe(400);
    const empty = await post("/v1/messages", minted.key as string, { model: "hb-small", messages: [] });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { message: string } }).error.message).toContain("messages");
    const unknownRoute = await fetch(`${stub.url}/v1/complete`, { method: "POST", headers: { "x-api-key": minted.key as string }, body: "{}" });
    expect(unknownRoute.status).toBe(404);
  });

  it("answers hb-small with a usage block, a call id and the pinned model, and counts tokens by the same rule", async () => {
    const minted = await mint({ max_budget: 1, budget_duration: "1mo" });
    const res = await post("/v1/messages", minted.key as string, CHECK_REQUEST);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-litellm-call-id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await res.json()) as { model: string; role: string; stop_reason: string; content: ReadonlyArray<{ type: string; text: string }>; usage: Record<string, number> };
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.role).toBe("assistant");
    expect(body.stop_reason).toBe("end_turn");
    expect(JSON.parse(body.content[0].text)).toMatchObject({ stub: "harness-bible", alias: "hb-small" });
    expect(body.usage).toEqual({ input_tokens: 4, output_tokens: tokensOf(body.content[0].text), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

    const count = await post("/v1/messages/count_tokens", minted.key as string, { model: "hb-small", messages: CHECK_REQUEST.messages });
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ input_tokens: 4 });

    const info = await fetch(`${stub.url}/key/info?key=${minted.key as string}`, { headers: { authorization: `Bearer ${MASTER_KEY}` } });
    const spend = ((await info.json()) as { info: { spend: number } }).info.spend;
    expect(spend).toBeCloseTo((4 * 1 + body.usage.output_tokens * 5) / 1_000_000, 12);
  });

  it("accepts the master key as a caller and the bearer form of the key", async () => {
    const res = await fetch(`${stub.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" }, body: JSON.stringify(CHECK_REQUEST) });
    expect(res.status).toBe(200);
  });

  it("answers the classifier with the header's cause and refuses a cause it does not know", async () => {
    const minted = await mint({});
    const res = await post("/v1/messages", minted.key as string, CLASSIFIER_REQUEST, { "x-hb-stub-cause": "R-RECOMPUTE" });
    const body = (await res.json()) as { content: ReadonlyArray<{ text: string }> };
    expect(JSON.parse(body.content[0].text)).toEqual({ cause: "R-RECOMPUTE", reason: "answered by the stub gateway" });
    const bad = await post("/v1/messages", minted.key as string, CLASSIFIER_REQUEST, { "x-hb-stub-cause": "R-NOPE" });
    expect(bad.status).toBe(400);
  });

  it("answers the evidence grader the lowest tier, the header's tier, or one of the four outputs its parser refuses, and refuses a grade it does not know", async () => {
    const minted = await mint({});
    const text = async (headers: Record<string, string>): Promise<string> => {
      const res = await post("/v1/messages", minted.key as string, GRADER_REQUEST, headers);
      expect(res.status).toBe(200);
      return ((await res.json()) as { content: ReadonlyArray<{ text: string }> }).content[0].text;
    };
    expect(JSON.parse(await text({}))).toEqual({ tier: "G", relevance: "partial", stake: "none", publishedOn: null, reason: "answered by the stub gateway" });
    expect(JSON.parse(await text({ "x-hb-stub-grade": "C" }))).toMatchObject({ tier: "C" });
    expect(JSON.parse(await text({ "x-hb-stub-grade": "unknown-key" }))).toMatchObject({ tier: "B", score: 85 });
    expect(JSON.parse(await text({ "x-hb-stub-grade": "tier-a" }))).toMatchObject({ tier: "A" });
    expect((JSON.parse(await text({ "x-hb-stub-grade": "long-reason" })) as { reason: string }).reason.split(" ")).toHaveLength(31);
    const notJson = await text({ "x-hb-stub-grade": "not-json" });
    expect(() => JSON.parse(notJson)).toThrow();
    const bad = await post("/v1/messages", minted.key as string, GRADER_REQUEST, { "x-hb-stub-grade": "Z" });
    expect(bad.status).toBe(400);
    /* The same message without an evidence fence is an echo, and a grading fence on the frontier alias is too. */
    const echo = await post("/v1/messages", minted.key as string, { ...GRADER_REQUEST, messages: [{ role: "user", content: "no fence" }] }, {});
    expect(JSON.parse(((await echo.json()) as { content: ReadonlyArray<{ text: string }> }).content[0].text)).toMatchObject({ stub: "harness-bible" });
  });

  it("grades a PDF and an image sent as the provider's blocks inside the evidence fence, and counts their tokens in the usage and in count_tokens (unit 49f)", async () => {
    const minted = await mint({});
    const withMedia = (block: Record<string, unknown>): Record<string, unknown> => ({
      ...GRADER_REQUEST,
      messages: [{ role: "user", content: [{ type: "text", text: '<anchor kind="SECTION" id="21.3" chapter="21" fast-moving="false">\nRetries are not optional.\n</anchor>\n\n<evidence kind="UPLOAD" source="upload" type="application/pdf" published="unknown" truncated="false">\n' }, block, { type: "text", text: "</evidence>" }] }],
    });
    for (const [block, media] of [[documentBlock(), 3000 + 1568], [imageBlock(), 435]] as const) {
      const request = withMedia(block);
      const res = await post("/v1/messages", minted.key as string, request, { "x-hb-stub-grade": "C" });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { content: ReadonlyArray<{ text: string }>; usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } };
      expect(JSON.parse(body.content[0].text)).toMatchObject({ tier: "C" });
      const prefix = body.usage.cache_creation_input_tokens + body.usage.cache_read_input_tokens;
      expect(body.usage.input_tokens + prefix).toBe(tokensOf(requestText(request as StubRequest)) + media);
      const count = await post("/v1/messages/count_tokens", minted.key as string, { model: "hb-small", system: GRADER_REQUEST.system, messages: request.messages });
      expect(await count.json()).toEqual({ input_tokens: tokensOf(requestText(request as StubRequest)) + media });
    }
  });

  it("answers the provider's 400 for a well-formed request it cannot read on x-hb-stub-fail: 400 (unit 49f)", async () => {
    const minted = await mint({});
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const res = await post(path, minted.key as string, path === "/v1/messages" ? GRADER_REQUEST : { model: "hb-small", messages: GRADER_REQUEST.messages }, { "x-hb-stub-fail": "400" });
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    }
    expect((await post("/v1/messages", minted.key as string, GRADER_REQUEST, { "x-hb-stub-fail": "418" })).status).toBe(400);
  });

  it("answers a malformed media block with the provider's 400 and a body over 32 MB with its 413, on the messages and the count_tokens routes", async () => {
    const minted = await mint({});
    const malformed = { ...GRADER_REQUEST, messages: [{ role: "user", content: [{ type: "text", text: "<evidence kind=\"LINK\">" }, { type: "document", source: { type: "url", url: "https://provider-two.example/a.pdf" } }] }] };
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const bad = await post(path, minted.key as string, malformed);
      expect(bad.status, path).toBe(400);
      expect(await bad.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    }
    const over = JSON.stringify({ ...CHECK_REQUEST, padding: "x".repeat(PROVIDER_REQUEST_MAX_BYTES) });
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const res = await fetch(`${stub.url}${path}`, { method: "POST", headers: { "x-api-key": minted.key as string, "content-type": "application/json" }, body: over });
      expect(res.status, path).toBe(413);
      expect(await res.json()).toMatchObject({ type: "error", error: { type: "request_too_large" } });
    }
  });

  it("stops the answer as the provider's refusal on x-hb-stub-refusal, on both paths, and refuses a category it does not know", async () => {
    const minted = await mint({});
    const res = await post("/v1/messages", minted.key as string, CHECK_REQUEST, { "x-hb-stub-refusal": "general_harms" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: null } });
    const streamed = await post("/v1/messages", minted.key as string, { ...CHECK_REQUEST, stream: true }, { "x-hb-stub-refusal": "cyber" });
    expect(streamed.status).toBe(200);
    expect(await streamed.text()).toContain('"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":null}');
    const bad = await post("/v1/messages", minted.key as string, CHECK_REQUEST, { "x-hb-stub-refusal": "nonsense" });
    expect(bad.status).toBe(400);
  });

  it("reads the cache on the second request with the same prefix, at a lower cost", async () => {
    const minted = await mint({ max_budget: 1, budget_duration: "1mo" });
    const first = (await (await post("/v1/messages", minted.key as string, assistantRequest("first question"))).json()) as { usage: Record<string, number> };
    const second = (await (await post("/v1/messages", minted.key as string, assistantRequest("second question"))).json()) as { usage: Record<string, number> };
    expect(first.usage.cache_creation_input_tokens).toBe(tokensOf(GUIDE));
    expect(first.usage.cache_read_input_tokens).toBe(0);
    expect(second.usage.cache_read_input_tokens).toBe(tokensOf(GUIDE));
    expect(second.usage.cache_creation_input_tokens).toBe(0);
  });

  it("streams the answer as the Messages events and ends with the usage", async () => {
    const minted = await mint({});
    const res = await post("/v1/messages", minted.key as string, assistantRequest("stream it", true));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-litellm-call-id")).toMatch(/^[0-9a-f-]{36}$/);
    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .filter((block) => block.length > 0)
      .map((block) => {
        const [eventLine, dataLine] = block.split("\n");
        return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) as Record<string, unknown> };
      });
    expect(events[0].event).toBe("message_start");
    expect(events[0].data.message).toMatchObject({ type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null });
    expect(events[1]).toMatchObject({ event: "content_block_start", data: { index: 0, content_block: { type: "text", text: "" } } });
    const deltas = events.filter((e) => e.event === "content_block_delta");
    const text = deltas.map((e) => (e.data.delta as { text: string }).text).join("");
    expect(JSON.parse(text)).toMatchObject({ claims: [{ sectionId: "21.3", figureId: "F-21-05" }, { sectionId: "26.3" }] });
    expect(deltas.every((e) => (e.data.delta as { text: string }).text.length <= STREAM_CHUNK_CHARACTERS)).toBe(true);
    expect(events.at(-3)).toMatchObject({ event: "content_block_stop", data: { index: 0 } });
    expect(events.at(-2)).toMatchObject({ event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: tokensOf(text) } } });
    expect(events.at(-1)).toMatchObject({ event: "message_stop" });
  });

  it("refuses at the budget before answering, in the proxy's form", async () => {
    const minted = await mint({ max_budget: 0.000001, budget_duration: "1mo", key_alias: "tiny" });
    const first = await post("/v1/messages", minted.key as string, CHECK_REQUEST);
    expect(first.status).toBe(200);
    const second = await post("/v1/messages", minted.key as string, CHECK_REQUEST);
    expect(second.status).toBe(429);
    const body = (await second.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toMatch(/^Budget has been exceeded! Key=tiny \(sk-\.\.\.[0-9a-f]{4}\) Current cost: [0-9.e-]+, Max budget: 0\.000001$/);
    const zero = await mint({ max_budget: 0 });
    expect((await post("/v1/messages", zero.key as string, CHECK_REQUEST)).status).toBe(429);
  });

  it("fails on request: 500 at once, timeout never", async () => {
    const minted = await mint({});
    const failed = await post("/v1/messages", minted.key as string, CHECK_REQUEST, { "x-hb-stub-fail": "500" });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    const failedCount = await post("/v1/messages/count_tokens", minted.key as string, { model: "hb-small", messages: CHECK_REQUEST.messages }, { "x-hb-stub-fail": "500" });
    expect(failedCount.status).toBe(500);
    const unknown = await post("/v1/messages", minted.key as string, CHECK_REQUEST, { "x-hb-stub-fail": "later" });
    expect(unknown.status).toBe(400);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    await expect(
      fetch(`${stub.url}/v1/messages`, { method: "POST", headers: { "x-api-key": minted.key as string, "content-type": "application/json", "x-hb-stub-fail": "timeout" }, body: JSON.stringify(CHECK_REQUEST), signal: controller.signal }),
    ).rejects.toThrow();
    clearTimeout(timer);
    expect(lines.some((line) => line.endsWith("held"))).toBe(true);
  });

  /*
   * The embeddings route (feature-specs/12 § 9): the deterministic vectors under the same key, budget and failure
   * switches as a messages call, and the pinned id of `hb-embed` in the answer.
   */
  it("embeds a batch under a key, with the pinned id and the call id", async () => {
    const minted = await mint({ models: ["hb-embed"] });
    const response = await post("/v1/embeddings", minted.key as string, { model: "hb-embed", input: ["retries and idempotency keys", "the ledger head lock"] });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-litellm-call-id")).not.toBeNull();
    const body = (await response.json()) as { object: string; model: string; data: { index: number; embedding: number[] }[]; usage: { prompt_tokens: number; total_tokens: number } };
    expect(body.object).toBe("list");
    expect(body.model).toBe(ALIASES.get("hb-embed"));
    expect(body.data.map((item) => item.index)).toEqual([0, 1]);
    expect(body.data[1].embedding).toEqual(stubEmbedding("the ledger head lock"));
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("refuses an embedding on a key without the alias, an unknown alias, and under the failure switch", async () => {
    const messagesOnly = await mint({ models: ["hb-small"] });
    expect((await post("/v1/embeddings", messagesOnly.key as string, { model: "hb-embed", input: "x" })).status).toBe(401);
    const minted = await mint({ models: ["hb-embed"] });
    expect((await post("/v1/embeddings", minted.key as string, { model: "hb-nowhere", input: "x" })).status).toBe(400);
    expect((await post("/v1/embeddings", minted.key as string, { model: "hb-embed" })).status).toBe(400);
    expect((await post("/v1/embeddings", minted.key as string, { model: "hb-embed", input: "x" }, { "x-hb-stub-fail": "500" })).status).toBe(500);
  });

  it("refuses the embedding alias on /v1/messages", async () => {
    const minted = await mint({ models: ["hb-embed", "hb-small"] });
    const response = await post("/v1/messages", minted.key as string, { model: "hb-embed", max_tokens: 16, messages: [{ role: "user", content: "hello" }] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("not a messages alias");
  });

  /*
   * The rerank route (feature-specs/12 § 9): the overlap scores under the same key, budget and failure switches,
   * `top_n` respected, and the pinned id of `hb-rerank` in the answer.
   */
  it("scores documents under a key, in score order, cut to top_n, with the pinned id and the call id", async () => {
    const minted = await mint({ models: ["hb-rerank"] });
    const documents = ["a retry that is safe", "sandbox egress default-deny", "a retry"];
    const response = await post("/rerank", minted.key as string, { model: "hb-rerank", query: "a safe retry", documents, top_n: 2 });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-litellm-call-id")).not.toBeNull();
    const body = (await response.json()) as { id: string; model: string; results: { index: number; relevance_score: number }[]; meta: { tokens: { input_tokens: number; output_tokens: number } } };
    expect(body.model).toBe(ALIASES.get("hb-rerank"));
    expect(body.results).toHaveLength(2);
    expect(body.results[0].index).toBe(0);
    expect(body.results[0].relevance_score).toBeGreaterThan(body.results[1].relevance_score);
    expect(body.meta.tokens.input_tokens).toBeGreaterThan(0);
    expect(body.meta.tokens.output_tokens).toBe(0);
  });

  it("refuses a rerank on a key without the alias, an unknown alias, a body off the shape, and under the failure switch", async () => {
    const messagesOnly = await mint({ models: ["hb-small"] });
    expect((await post("/rerank", messagesOnly.key as string, { model: "hb-rerank", query: "q", documents: ["d"] })).status).toBe(401);
    const minted = await mint({ models: ["hb-rerank"] });
    expect((await post("/rerank", minted.key as string, { model: "hb-nowhere", query: "q", documents: ["d"] })).status).toBe(400);
    expect((await post("/rerank", minted.key as string, { model: "hb-rerank", query: "q", documents: [] })).status).toBe(400);
    expect((await post("/rerank", minted.key as string, { model: "hb-rerank", documents: ["d"] })).status).toBe(400);
    expect((await post("/rerank", minted.key as string, { model: "hb-rerank", query: "q", documents: ["d"] }, { "x-hb-stub-fail": "500" })).status).toBe(500);
  });

  it("refuses the rerank alias on /v1/messages", async () => {
    const minted = await mint({ models: ["hb-rerank", "hb-small"] });
    const response = await post("/v1/messages", minted.key as string, { model: "hb-rerank", max_tokens: 16, messages: [{ role: "user", content: "hello" }] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("not a messages alias");
  });

  it("refuses a rerank once the key's budget is spent", async () => {
    const minted = await mint({ max_budget: 0.0000001, budget_duration: "1mo", models: ["hb-rerank", "hb-small"] });
    await post("/v1/messages", minted.key as string, CHECK_REQUEST);
    const response = await post("/rerank", minted.key as string, { model: "hb-rerank", query: "q", documents: ["d"] });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("Budget has been exceeded!");
  });

  it("refuses an embedding once the key's budget is spent", async () => {
    const minted = await mint({ max_budget: 0.0000001, budget_duration: "1mo", models: ["hb-embed", "hb-small"] });
    await post("/v1/messages", minted.key as string, CHECK_REQUEST);
    const response = await post("/v1/embeddings", minted.key as string, { model: "hb-embed", input: "x" });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("Budget has been exceeded!");
  });
});

/*
 * The stub's embeddings as a pure function (feature-specs/12 § 9): the same text always embeds the same way, texts
 * sharing words come out close, and every vector is a unit vector of the column's size.
 */
describe("stub embeddings", () => {
  const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => a.reduce((sum, value, i) => sum + value * b[i], 0);

  it("embeds a text as a unit vector of the column's size, deterministically and case-blind", () => {
    const first = stubEmbedding("idempotency keys make a retry safe");
    expect(first).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(stubEmbedding("Idempotency keys make a retry safe.")).toEqual(first);
    expect(dot(first, first)).toBeCloseTo(1, 10);
  });

  it("puts texts that share words closer than texts that share none", () => {
    const anchor = stubEmbedding("retries and idempotency keys");
    expect(dot(anchor, stubEmbedding("idempotency keys"))).toBeGreaterThan(dot(anchor, stubEmbedding("sandbox egress allow-list")));
  });

  it("gives a text without a word a unit vector in dimension 0", () => {
    const empty = stubEmbedding("  ,.  ");
    expect(empty[0]).toBe(1);
    expect(dot(empty, empty)).toBeCloseTo(1, 10);
  });

  it("splits words on anything but letters and digits and hashes each into the column's range", () => {
    expect(wordsOf("Retry-safe, twice? 42")).toEqual(["retry", "safe", "twice", "42"]);
    expect(wordsOf("   ")).toEqual([]);
    for (const word of ["a", "retry", "idempotency", "42", "ledger"]) {
      expect(dimensionOf(word)).toBeGreaterThanOrEqual(0);
      expect(dimensionOf(word)).toBeLessThan(EMBEDDING_DIMENSIONS);
    }
  });

  it("answers one vector per input text, in order, with the input tokens counted", () => {
    const one = embeddings("abcd");
    expect(one.data).toEqual([{ object: "embedding", index: 0, embedding: stubEmbedding("abcd") }]);
    expect(one.usage).toEqual({ prompt_tokens: 1, total_tokens: 1 });
    const many = embeddings(["abcd", "abcdefgh"]);
    expect(many.data.map((item) => item.index)).toEqual([0, 1]);
    expect(many.usage).toEqual({ prompt_tokens: 3, total_tokens: 3 });
  });
});

/*
 * The stub's re-ranker as a pure function (feature-specs/12 § 9): the share of the query's vocabulary a document
 * carries, every document scored, `top_n` respected, ties by position.
 */
describe("stub rerank", () => {
  it("scores a document by the share of the query's distinct words it holds", () => {
    expect(overlapScore("a safe retry", "a safe retry")).toBe(1);
    expect(overlapScore("a safe retry", "a retry")).toBeCloseTo(2 / 3, 10);
    expect(overlapScore("a safe retry", "the ledger head lock")).toBe(0);
    /* Case and punctuation do not change a score; a query with no word overlaps with nothing. */
    expect(overlapScore("Safe, retry?", "safe retry")).toBe(1);
    expect(overlapScore("  ,.  ", "safe retry")).toBe(0);
  });

  it("scores every document, orders by score then position, and cuts to top_n", () => {
    const request = { model: "hb-rerank", query: "a safe retry", documents: ["the ledger head lock", "a safe retry", "a retry"] };
    const all = reranked(request);
    expect(all.results.map((result) => result.index)).toEqual([1, 2, 0]);
    expect(all.results[0].relevance_score).toBe(1);
    expect(all.meta.tokens.input_tokens).toBeGreaterThan(0);
    expect(reranked({ ...request, top_n: 1 }).results).toEqual([{ index: 1, relevance_score: 1 }]);
    /* Two documents of the same score keep the order they were given in. */
    const tied = reranked({ model: "hb-rerank", query: "retry", documents: ["retry once", "retry twice"] });
    expect(tied.results.map((result) => result.index)).toEqual([0, 1]);
  });
});
