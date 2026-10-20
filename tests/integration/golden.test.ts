import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import { loadGuide, loadGuidePart } from "@/lib/guides/load";
import { callModel, type GatewayDeps } from "@/lib/gateway/client";
import { encryptKey } from "@/lib/gateway/keys";
import { DRAFT_REQUEST, GRADER_REQUEST } from "@/workers/answer/flow";
import { answer, type AnswerDeps, type AnswerSinks, type DraftedText } from "@/workers/answer/flow";
import type { AnswerRequest, RefusalCause } from "@/lib/schemas/assistant";
import { parseFigureId, parseReleaseId, parseSectionId } from "@/lib/schemas/ids";
import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";
import type { RetrievedSection } from "@/lib/search/retrieve";
import type { PromptSection } from "@/workers/agents/assistant/assemble";
import { checkedFigures } from "@/lib/labs/checkedFigures";
import { labPromptSections } from "@/workers/answer/lab";

/*
 * The whole flow over the golden set, against the stub gateway (feature-specs/13 § 13.3). The stub answers
 * deterministically from the sections it is given, so what this measures is the flow: that a figure question
 * produces a cited claim, that a refusal refuses for the labelled reason, and that a rule refusal never reaches
 * the gateway at all.
 *
 * Retrieval is stubbed too: the golden item names the section a correct answer cites, so the "retrieved" set is
 * that section and one other. Real retrieval quality is spec 12's measurement and needs the compose stack; what
 * belongs here is the flow's own behaviour, which must not depend on a model or a database.
 */

const GUIDE = loadGuide("assistant", "v1.8");
const GRADER_GUIDE = loadGuidePart("assistant", "v1.8", "grader");
const MASTER_KEY = "golden-master-key";
const SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-09-25T12:00:00.000Z");
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));

const ITEMS: ReadonlyArray<GoldenItem> = readFileSync(join(import.meta.dirname, "..", "..", "golden", "assistant", "2026.09.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => GoldenItemSchema.parse(JSON.parse(line)));

function section(id: string, text: string, figures: PromptSection["figures"] = []): PromptSection {
  const retrieved: RetrievedSection = {
    sectionId: parseSectionId(id),
    chapter: Number(id.split(".")[0]),
    layer: Number(id.split(".")[1] ?? 1),
    title: `Section ${id}`,
    version: "v1.0.0",
    verify: "PASSED",
    editionLang: "EN",
    text,
    figureIds: figures.map((figure) => figure.figureId),
    rank: { lexicalPos: 1, vectorPos: 1, rerankScore: 0.9, final: 1 },
    truncated: false,
  };
  return { section: retrieved, figures };
}

describe("the answer flow over the golden set, against the stub gateway", () => {
  let stub: RunningStub;
  const rows: BudgetRowInput[] = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: () => undefined, now: () => NOW });
  });
  afterAll(async () => {
    await stub.close();
  });

  function gateway(key: string, overrides: Partial<GatewayDeps> = {}): GatewayDeps {
    return {
      baseUrl: stub.url,
      keySecret: SECRET,
      findKey: async () => ({ keyCiphertext: encryptKey(SECRET, key) }),
      append: async (row) => {
        rows.push(row);
      },
      log: () => undefined,
      fetch: globalThis.fetch,
      now: () => NOW,
      ...overrides,
    };
  }

  async function mint(): Promise<string> {
    const response = await fetch(`${stub.url}/key/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ models: [...ALIASES.keys()], max_budget: 5 }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { key: string }).key;
  }

  /** The flow's dependencies, with the gateway calls going to the stub and retrieval faked from the item's label. */
  async function deps(item: GoldenItem, cause: RefusalCause | null, sections: ReadonlyArray<PromptSection>): Promise<AnswerDeps> {
    const key = await mint();
    const gatewayDeps = gateway(key);
    let clock = 0;
    return {
      guide: GUIDE,
      graderGuide: GRADER_GUIDE,
      chaptersVerified: async () => item.expected.refusal?.cause !== "R-UNVERIFIED",
      retrieve: async () => sections,
      classify: async (_request, call) => {
        /* The classifier is a real call to the stub, which answers the cause the header names (§ 4.1 step 2). */
        const message = await callModel(
          call,
          {
            model: "hb-small",
            max_tokens: 256,
            /* The real classifier sends the guide's scope statement, which names the four causes; the stub reads
               `R-SCOPE` in the prompt as "this is a classification" and answers the header's cause. */
            messages: [{ role: "user", content: `Answer R-SCOPE, R-SCOPE-OT, R-RECOMPUTE or none for: ${request(item).question}` }],
          },
          gateway(key, {
            fetch: async (url, init) => {
              /* `init.headers` is a `Headers` instance, whose spread is empty: spreading it dropped the
                 Authorization header and every call came back 401. */
              const headers = new Headers(init?.headers);
              headers.set("x-hb-stub-cause", cause ?? "none");
              return globalThis.fetch(url, { ...init, headers });
            },
          }),
        );
        const text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
        /* A classifier answer that cannot be read means proceed (§ 4.1, D2): it is a gate against wasted frontier
           calls, not the last defence, and the sensors still stand behind it. */
        const causes: ReadonlyArray<RefusalCause> = ["R-SCOPE", "R-SCOPE-OT", "R-RECOMPUTE", "R-UNVERIFIED"];
        const parsed = JSON.parse(text) as { cause?: unknown };
        const named = causes.find((candidate) => candidate === parsed.cause);
        return named ?? null;
      },
      draft: async (prompt, call, sinks, extra): Promise<DraftedText> => {
        const messages = [
          ...prompt.messages.map((message) => ({ role: message.role, content: message.content })),
          ...(extra === null ? [] : [{ role: "user" as const, content: extra }]),
        ];
        const message = await callModel(call, { ...DRAFT_REQUEST, system: [...prompt.system], messages, max_tokens: 4096 }, gatewayDeps);
        const text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
        sinks.token(text);
        return {
          text,
          stopReason: message.stop_reason,
          modelId: message.model,
          usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cacheReadTokens: message.usage.cache_read_input_tokens ?? 0 },
          firstTokenMs: 400,
        };
      },
      grade: async (prompt, call) => {
        const message = await callModel(
          call,
          { ...GRADER_REQUEST, system: [...prompt.system], messages: prompt.messages.map((entry) => ({ role: entry.role, content: entry.content })) },
          gatewayDeps,
        );
        const text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
        /* The stub does not know the grader's schema, so the grade is read from a fixed answer: what this case
           measures is the flow's handling of a score, not the stub's judgement. */
        return text.includes("criteria") ? text : JSON.stringify({ criteria: ["supported", "precise", "complete", "in_scope"].map((name) => ({ name, verdict: "PASS", reason: "stub" })) });
      },
      titleOf: async (sectionId) => `Title of ${sectionId}`,
      versionOf: () => "v1.0.0",
      now: () => (clock += 10),
    };
  }

  function request(item: GoldenItem): AnswerRequest {
    const pad = (chapter: number): string => String(chapter).padStart(2, "0");
    return {
      releaseId: parseReleaseId("2026.09"),
      locale: item.language,
      mode: item.mode,
      context: {
        chapter: item.context.chapter,
        section: item.context.section === null ? null : parseSectionId(item.context.section),
        /* The modes' own context (spec 19 § 3): a compare's pair is the item's two chapters, a lab's is the chapter's lab. */
        ...(item.mode === "compare" && item.expected.chapters.length === 2 ? { chapters: [item.expected.chapters[0] ?? 0, item.expected.chapters[1] ?? 0] as const } : {}),
        ...(item.mode === "lab" ? { labId: `lab-${pad(item.context.chapter)}` } : {}),
      },
      question: item.question,
      conversation: [],
      aidResult: null,
      principal: { organisationId: "00000000-0000-4000-8000-00000000d001" },
      traceId: "f".repeat(32),
    };
  }

  const sinks = (): AnswerSinks => ({ token: () => undefined, status: () => undefined });

  it("answers a figure question with a claim citing the expected section and figure", async () => {
    const item = ITEMS.find((candidate) => candidate.kind === "figure" && candidate.expected.citations[0]?.figureId !== null && candidate.expected.valueText !== null);
    expect(item).toBeDefined();
    if (item === undefined) return;

    const expected = item.expected.citations[0];
    if (expected === undefined || expected.figureId === null || item.expected.valueText === null) return;
    const sections = [
      section(expected.sectionId, "The section's own prose about the figure.", [
        { figureId: parseFigureId(expected.figureId), label: "the figure", valueText: item.expected.valueText, tier: "DERIVED", derive: null },
      ]),
    ];

    const result = await answer(request(item), sinks(), await deps(item, null, sections));

    expect(result.kind).toBe("answer");
    expect(result.claims.some((claim) => claim.sectionId === expected.sectionId && !claim.substituted)).toBe(true);
    expect(result.citations.some((citation) => citation.figureId === expected.figureId)).toBe(true);
    expect(result.verdicts.filter((verdict) => verdict.verdict === "PASS" || verdict.verdict === "NA")).toHaveLength(5);
    expect(result.grounded).toBe(1);
  });

  it("refuses every rule-refusable question without reaching the gateway", async () => {
    const ruled = ITEMS.filter((item) => ["R-RECOMPUTE", "R-SCOPE-OT", "R-UNVERIFIED"].includes(item.expected.refusal?.cause ?? ""));
    expect(ruled.length).toBeGreaterThanOrEqual(37);

    const before = rows.length;
    for (const item of ruled.slice(0, 12)) {
      const result = await answer(request(item), sinks(), await deps(item, null, []));
      expect(result.kind, item.question).toBe("refusal");
      expect(result.refusal?.cause, item.question).toBe(item.expected.refusal?.cause);
      expect(result.refusal?.beforeRetrieval, item.question).toBe(true);
      expect(result.claims).toEqual([]);
    }
    /* Not one gateway call for any of them: the rules are the cheapest refusal there is (invariant 11). */
    expect(rows).toHaveLength(before);
  });

  it("refuses an out-of-scope question on the classifier, at the cost of one small call", async () => {
    const item = ITEMS.find((candidate) => candidate.expected.refusal?.cause === "R-SCOPE");
    expect(item).toBeDefined();
    if (item === undefined) return;

    const before = rows.length;
    const result = await answer(request(item), sinks(), await deps(item, "R-SCOPE", [section("21.3", "Some prose."), section("28.1", "Other prose.")]));

    expect(result.kind).toBe("refusal");
    expect(result.refusal?.cause).toBe("R-SCOPE");
    expect(result.refusal?.pointers.map((pointer) => pointer.sectionId)).toEqual(["21.3", "28.1"]);
    const made = rows.slice(before);
    expect(made).toHaveLength(1);
    expect(made[0]?.alias).toBe("hb-small");
  });

  it("substitutes a claim the stub cites to a section it was not given", async () => {
    const item = ITEMS.find((candidate) => candidate.kind === "claim");
    expect(item).toBeDefined();
    if (item === undefined) return;

    /* The stub cites the sections it is given; give it one and grade against another, so the claim cannot match. */
    const drafted = section("21.3", "A retried write without a key is a second write.");
    const result = await answer(
      request(item),
      sinks(),
      { ...(await deps(item, null, [drafted])), retrieve: async () => [drafted] },
    );
    expect(result.kind).toBe("answer");
    expect(result.claims.length).toBeGreaterThan(0);
  });

  it("answers every compare item with both chapters cited and the mode row passing (feature-specs/19 § 12.5)", async () => {
    const compares = ITEMS.filter((item) => item.kind === "compare" && item.expected.refusal === null);
    expect(compares).toHaveLength(30);
    const pad = (chapter: number): string => String(chapter).padStart(2, "0");
    for (const item of compares) {
      const [a, b] = item.expected.chapters;
      if (a === undefined || b === undefined) throw new Error(`${item.id} has no pair`);
      /* Retrieval's always-included sections for a compare: each chapter's `NN.1` (spec 12 § 7.2). */
      const sections = [section(`${pad(a)}.1`, `Chapter ${String(a)} opens with its position on the question.`), section(`${pad(b)}.1`, `Chapter ${String(b)} opens with its own position.`)];
      const result = await answer(request(item), sinks(), await deps(item, null, sections));
      expect(result.kind, item.id).toBe("answer");
      expect(result.verdicts.map((verdict) => verdict.sensor), item.id).toEqual(["scope", "citation", "mode", "edition", "grader", "latency"]);
      expect(result.verdicts[2], item.id).toMatchObject({ verdict: "PASS", detail: "compare · both chapters cited" });
      expect(new Set(result.claims.filter((claim) => !claim.substituted).map((claim) => Number(claim.sectionId.slice(0, 2)))), item.id).toEqual(new Set([a, b]));
      expect(result.modeResult, item.id).toEqual({ openPoint: null });
    }
  }, 120_000);

  it("answers every lab item from the lab section and its pseudo-sections, citing NN.4 and quoting a figure the run checks (feature-specs/19 § 12.5)", async () => {
    const labs = ITEMS.filter((item) => item.kind === "lab" && item.expected.refusal === null);
    expect(labs).toHaveLength(20);
    for (const item of labs) {
      const chapter = item.context.chapter;
      const n = String(chapter).padStart(2, "0");
      const labSection = section(`${n}.4`, `Lab ${n} reproduces the chapter's derived figures.`);
      const figureId = parseFigureId(`F-${n}-01`);
      const figures = checkedFigures([{ figureId, sectionId: parseSectionId(`${n}.3`), label: "the checked figure", valueText: "45%", tier: "DERIVED", key: "checked_value", line: 12, filePath: "derive.py" }], { checked_value: 0.45 });
      const pseudo = labPromptSections(
        {
          facts: { labId: `lab-${n}`, number: chapter, title: `Lab ${n}`, expectedRuntimeS: 120, declaresModelCalls: false, egressExtra: [], ciVerdict: "REPRODUCED", ciCheckedAt: "2026-09-23T11:00:00.000Z", figures },
          textEn: `Lab ${n} runs derive.py and compares its output to the chapter.`,
          anchor: { chapter, version: "v1.0.0", verify: "PASSED" },
        },
        2,
      );
      const result = await answer(request(item), sinks(), await deps(item, null, [labSection, ...pseudo]));
      expect(result.kind, item.id).toBe("answer");
      expect(result.verdicts[2], item.id).toMatchObject({ sensor: "mode", verdict: "PASS", detail: "lab · 1 figure from the run" });
      /* Every claim cites the lab's section, the golden item's expected citation; none was replaced. */
      expect(result.claims.every((claim) => claim.sectionId === `${n}.4` && !claim.substituted), item.id).toBe(true);
      expect(result.citations.some((citation) => citation.sectionId === item.expected.citations[0]?.sectionId), item.id).toBe(true);
      expect(result.citations.some((citation) => citation.figureId === figureId), item.id).toBe(true);
    }
  }, 120_000);

  it("caches the guide prefix across questions, which is what the gate measures", async () => {
    const item = ITEMS.find((candidate) => candidate.kind === "figure");
    expect(item).toBeDefined();
    if (item === undefined) return;

    const sections = [section("21.3", "A retried write without a key is a second write.")];
    const shared = await deps(item, null, sections);
    await answer(request(item), sinks(), shared);
    const before = rows.length;
    await answer({ ...request(item), question: "A different question about the same page?" }, sinks(), shared);

    const second = rows.slice(before).filter((row) => row.alias === "hb-frontier");
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((row) => row.cacheReadTokens > 0)).toBe(true);
  });
});
