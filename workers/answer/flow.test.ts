import { describe, expect, it } from "vitest";

import type { Guide } from "@/lib/guides/load";
import { GatewayUnavailableError } from "@/lib/gateway/errors";
import { NO_COVER, type AnswerRequest, type SensorVerdict } from "@/lib/schemas/assistant";
import { parseFigureId, parseReleaseId, parseSectionId } from "@/lib/schemas/ids";
import type { RetrievedSection } from "@/lib/search/retrieve";
import type { PromptSection } from "@/workers/agents/assistant/assemble";

import { answer, type AnswerDeps, type AnswerSinks, type DraftedText } from "./flow";

/*
 * The answer flow (feature-specs/13 § 9). Everything the flow touches arrives through `AnswerDeps`, so the whole
 * order — refuse early, retrieve, draft, check, grade, repair once — is testable without a gateway or a database.
 *
 * What these cases are really protecting: a refusal before retrieval costs nothing; a claim the sensors reject is
 * replaced rather than shown; the grader's low score buys exactly one repair and no more.
 */

const GUIDE: Guide = { agent: "assistant", version: "v1.8", prefix: "guide prefix\n", sha256: "a".repeat(64) };
const GRADER: Guide = { agent: "assistant", version: "v1.8", prefix: "grader prefix\n", sha256: "b".repeat(64), part: "grader" };

function promptSection(id: string, text: string, figures: PromptSection["figures"] = []): PromptSection {
  const section: RetrievedSection = {
    sectionId: parseSectionId(id),
    chapter: Number(id.split(".")[0]),
    layer: 3,
    title: `Section ${id}`,
    version: "v1.0.0",
    verify: "PASSED",
    editionLang: "EN",
    text,
    figureIds: figures.map((figure) => figure.figureId),
    rank: { lexicalPos: 1, vectorPos: 1, rerankScore: 0.9, final: 1 },
    truncated: false,
  };
  return { section, figures };
}

const SECTIONS = [
  promptSection("21.3", "A retried write without an idempotency key is a second write.", [
    { figureId: parseFigureId("F-21-07"), label: "duplicate side effects a day", valueText: "117", tier: "DERIVED", derive: null },
  ]),
  promptSection("28.1", "Permissions are granted by policy."),
];

function request(overrides: Partial<AnswerRequest> = {}): AnswerRequest {
  return {
    releaseId: parseReleaseId("2026.09"),
    locale: "en",
    mode: "explain",
    context: { chapter: 21, section: parseSectionId("21.3") },
    question: "Why do idempotency keys matter?",
    conversation: [],
    aidResult: null,
    principal: { organisationId: "org-1" },
    traceId: "f".repeat(32),
    ...overrides,
  };
}

function sinks(): AnswerSinks & { readonly tokens: string[]; readonly states: string[] } {
  const tokens: string[] = [];
  const states: string[] = [];
  return { tokens, states, token: (delta) => tokens.push(delta), status: (state) => states.push(state) };
}

const ANSWERED = (text: string, stopReason: string | null = "end_turn"): DraftedText => ({
  text,
  stopReason,
  modelId: "hb-frontier",
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 80 },
  firstTokenMs: 900,
});

const output = (claims: { text: string; sectionId: string; figureId?: string | null }[]) =>
  JSON.stringify({ claims: claims.map((claim) => ({ text: claim.text, sectionId: claim.sectionId, figureId: claim.figureId ?? null })), refusal: null, mode_result: null });

const GRADE_PASS = JSON.stringify({ criteria: ["supported", "precise", "complete", "in_scope"].map((name) => ({ name, verdict: "PASS", reason: "ok" })) });
const GRADE_FAIL = JSON.stringify({ criteria: ["supported", "precise", "complete", "in_scope"].map((name, index) => ({ name, verdict: index < 3 ? "FAIL" : "PASS", reason: "no" })) });

function deps(overrides: Partial<AnswerDeps> = {}): AnswerDeps {
  let clock = 0;
  return {
    guide: GUIDE,
    graderGuide: GRADER,
    chaptersVerified: async () => true,
    retrieve: async () => SECTIONS,
    classify: async () => null,
    draft: async () => ANSWERED(output([{ text: "A retried write is a second write.", sectionId: "21.3" }])),
    grade: async () => GRADE_PASS,
    titleOf: async (sectionId) => `Title of ${sectionId}`,
    versionOf: () => "v1.0.0",
    now: () => (clock += 10),
    ...overrides,
  };
}

const detailOf = (verdicts: ReadonlyArray<SensorVerdict>, sensor: SensorVerdict["sensor"]) => verdicts.find((entry) => entry.sensor === sensor);

describe("the answer flow (feature-specs/13 § 9)", () => {
  it("refuses an unverified chapter before retrieval, with no call of any kind", async () => {
    let retrieved = 0;
    let classified = 0;
    let drafted = 0;
    const result = await answer(
      request(),
      sinks(),
      deps({
        chaptersVerified: async () => false,
        retrieve: async () => { retrieved += 1; return SECTIONS; },
        classify: async () => { classified += 1; return null; },
        draft: async () => { drafted += 1; return ANSWERED("{}"); },
      }),
    );
    expect(result.kind).toBe("refusal");
    expect(result.refusal?.cause).toBe("R-UNVERIFIED");
    expect(result.refusal?.beforeRetrieval).toBe(true);
    expect([retrieved, classified, drafted]).toEqual([0, 0, 0]);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });

  it("refuses an operations question with the two sections the guide names", async () => {
    const result = await answer(request({ question: "How do I bypass the interlock on the compressor?" }), sinks(), deps());
    expect(result.refusal?.cause).toBe("R-SCOPE-OT");
    expect(result.refusal?.pointers.map((pointer) => pointer.sectionId)).toEqual(["35.2", "28.1"]);
    expect(result.refusal?.pointers[0]?.title).toBe("Title of 35.2");
  });

  it("refuses on the classifier and keeps the retrieved sections as the pointers", async () => {
    let drafted = 0;
    const result = await answer(
      request({ question: "What is the weather in São Paulo today?" }),
      sinks(),
      deps({ classify: async () => "R-SCOPE", draft: async () => { drafted += 1; return ANSWERED("{}"); } }),
    );
    expect(result.refusal?.cause).toBe("R-SCOPE");
    expect(result.refusal?.pointers.map((pointer) => pointer.sectionId)).toEqual(["21.3", "28.1"]);
    expect(drafted).toBe(0);
  });

  it("points a classified unverified chapter at nothing, although retrieval ran beside the classifier", async () => {
    /* A chapter named by its title has no number for the rule to read; the classifier names the cause, and the
       cause's rule is "then nothing from it" (feature-specs/23 § 5.2, D6). */
    const result = await answer(request({ question: "What does the chapter on regulation recommend?" }), sinks(), deps({ classify: async () => "R-UNVERIFIED" }));
    expect(result.refusal?.cause).toBe("R-UNVERIFIED");
    expect(result.refusal?.pointers).toEqual([]);
    expect(result.refusal?.beforeRetrieval).toBe(true);
  });

  it("points a recompute refusal at the sections the question names, and at nothing when it names none", async () => {
    /* Assistant 1 pointed at the section the reader was on; the context carries none now (feature-specs/23 § 5.4). */
    const named = await answer(request({ question: "Recompute the figure of section 37.8 at 4,000 queries a day, as 21.3 does" }), sinks(), deps());
    expect(named.refusal?.cause).toBe("R-RECOMPUTE");
    expect(named.refusal?.pointers.map((pointer) => pointer.sectionId)).toEqual(["37.8", "21.3"]);

    const three = await answer(request({ question: "Recompute sections 37.8, then section 21.3 and section 09.2 at 4,000 queries a day" }), sinks(), deps());
    expect(three.refusal?.pointers.map((pointer) => pointer.sectionId)).toEqual(["37.8", "21.3"]);

    /* A section the release does not have is not a pointer: the card would link to nothing. */
    const absent = await answer(request({ question: "Recompute the figure of section 37.8 at 4,000 queries a day" }), sinks(), deps({ versionOf: () => null }));
    expect(absent.refusal?.pointers).toEqual([]);

    const none = await answer(request({ question: "Recompute the monthly cost at 4,000 queries a day" }), sinks(), deps());
    expect(none.refusal?.cause).toBe("R-RECOMPUTE");
    expect(none.refusal?.pointers).toEqual([]);
    /* The position a client might still send changes nothing. */
    const positioned = await answer(request({ question: "Recompute the monthly cost at 4,000 queries a day", context: { chapter: 21, section: parseSectionId("21.3") } }), sinks(), deps());
    expect(positioned.refusal?.pointers).toEqual([]);
  });

  it("answers, cites, and reports five verdicts in the panel's order", async () => {
    const out = sinks();
    const result = await answer(request(), out, deps());
    expect(result.kind).toBe("answer");
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.substituted).toBe(false);
    expect(result.citations).toEqual([{ sectionId: "21.3", figureId: null, version: "v1.0.0", editionLang: "EN" }]);
    expect(result.verdicts.map((entry) => entry.sensor)).toEqual(["scope", "citation", "edition", "grader", "latency"]);
    expect(result.grounded).toBe(1);
    expect(result.repaired).toBe(false);
    expect(out.states).toEqual(["retrieving", "drafting", "checking", "grading"]);
  });

  it("replaces a claim the sensors reject and says so in the scope verdict", async () => {
    const result = await answer(
      request(),
      sinks(),
      deps({ draft: async () => ANSWERED(output([{ text: "Vendors publish quarterly roadmaps.", sectionId: "21.3" }])) }),
    );
    expect(result.claims[0]?.text).toBe(NO_COVER.en);
    expect(result.claims[0]?.substituted).toBe(true);
    expect(result.citations).toEqual([]);
    expect(detailOf(result.verdicts, "scope")?.detail).toBe("in corpus · 1 claim out of scope, replaced");
  });

  it("quotes a figure only when the claim carries it as printed", async () => {
    const good = await answer(request(), sinks(), deps({ draft: async () => ANSWERED(output([{ text: "There are 117 duplicate writes a day.", sectionId: "21.3", figureId: "F-21-07" }])) }));
    expect(good.claims[0]?.substituted).toBe(false);
    expect(good.citations[0]?.figureId).toBe("F-21-07");

    const rounded = await answer(request(), sinks(), deps({ draft: async () => ANSWERED(output([{ text: "There are about 120 duplicate writes a day.", sectionId: "21.3", figureId: "F-21-07" }])) }));
    expect(rounded.claims[0]?.substituted).toBe(true);
  });

  it("buys exactly one repair with a low score, and ships whatever the second score is", async () => {
    let drafts = 0;
    let grades = 0;
    const agents: string[] = [];
    const result = await answer(
      request(),
      sinks(),
      deps({
        classify: async (_request, call) => { agents.push(call.agent); return null; },
        draft: async (_prompt, call) => { drafts += 1; agents.push(call.agent); return ANSWERED(output([{ text: "A retried write is a second write.", sectionId: "21.3" }])); },
        grade: async (_prompt, call) => { grades += 1; agents.push(call.agent); return GRADE_FAIL; },
      }),
    );
    expect(drafts).toBe(2);
    expect(grades).toBe(2);
    /* each call named for its agent: the draft and the repair are the same purpose and alias (49 § 6.2) */
    expect(agents).toEqual(["assistant.classify", "assistant.draft", "assistant.grade", "assistant.repair", "assistant.grade"]);
    expect(result.repaired).toBe(true);
    /* The second score was still low, and the answer ships anyway with the score in the log (architecture § 6.3). */
    expect(result.grounded).toBe(0.25);
    expect(detailOf(result.verdicts, "grader")?.verdict).toBe("FAIL");
  });

  it("tells the mode sensor's run where the mode has a shape, and a refusal by the rules as one FAIL with its rule and cause (49 § 8)", async () => {
    const runs: Array<{ readonly sensor: string; readonly verdict: string; readonly rule?: string; readonly code?: string }> = [];
    const onSensor: AnswerDeps["onSensor"] = (verdict, _ms, facts) => {
      runs.push({ sensor: verdict.sensor, verdict: verdict.verdict, ...(facts?.rule === undefined ? {} : { rule: facts.rule }), ...(facts?.code === undefined ? {} : { code: facts.code }) });
    };
    const compareDraft = async () =>
      ANSWERED(
        JSON.stringify({
          claims: [
            { text: "A retried write is a second write.", sectionId: "21.3", figureId: null },
            { text: "Permissions are granted by policy.", sectionId: "28.1", figureId: null },
          ],
          refusal: null,
          mode_result: { openPoint: "Which side owns the key." },
        }),
      );
    await answer(request({ mode: "compare", context: { chapter: 21, section: null, chapters: [21, 28] } }), sinks(), deps({ draft: compareDraft, onSensor }));
    expect(runs.map((run) => run.sensor)).toEqual(["scope", "citation", "mode", "edition"]);
    /* a pass carries no rule and no cause */
    expect(runs[0]).toEqual({ sensor: "scope", verdict: "PASS" });
    runs.length = 0;
    await answer(request(), sinks(), deps({ chaptersVerified: async () => false, onSensor }));
    expect(runs).toEqual([{ sensor: "scope", verdict: "FAIL", rule: "unverified", code: "R-UNVERIFIED" }]);
  });

  it("tells each sensor's run as it happens: the scope rules once, the citation and edition sensors in each pass (49 § 8)", async () => {
    const runs: Array<{ readonly sensor: string; readonly verdict: string; readonly ms: number; readonly claims: number | undefined }> = [];
    await answer(
      request(),
      sinks(),
      deps({
        grade: async () => GRADE_FAIL,
        onSensor: (verdict, ms, facts) => {
          runs.push({ sensor: verdict.sensor, verdict: verdict.verdict, ms, claims: facts?.claims });
        },
      }),
    );
    /* a repaired turn: two passes; an explain turn has no shape for the mode sensor to check */
    expect(runs.map((run) => run.sensor)).toEqual(["scope", "citation", "edition", "citation", "edition"]);
    expect(runs[0]?.verdict).toBe("PASS");
    expect(runs.filter((run) => run.sensor === "citation").every((run) => run.claims === 1)).toBe(true);
    expect(runs.every((run) => run.ms >= 0)).toBe(true);
  });

  it("repairs an unparseable answer once, and refuses rather than show raw text when it happens twice", async () => {
    const once = await answer(
      request(),
      sinks(),
      deps({
        draft: async (_prompt, _call, _sinks, extra) =>
          extra === null ? ANSWERED("Here is my answer in prose.") : ANSWERED(output([{ text: "A retried write is a second write.", sectionId: "21.3" }])),
      }),
    );
    expect(once.kind).toBe("answer");
    expect(once.repaired).toBe(true);

    const twice = await answer(request(), sinks(), deps({ draft: async () => ANSWERED("Still prose, no JSON at all.") }));
    expect(twice.kind).toBe("refusal");
    expect(twice.refusal?.cause).toBe("R-SCOPE");
    expect(twice.refusal?.beforeRetrieval).toBe(false);
    expect(twice.repaired).toBe(true);
    expect(twice.claims).toEqual([]);
  });

  it("repairs a truncated answer", async () => {
    const seen: (string | null)[] = [];
    await answer(
      request(),
      sinks(),
      deps({
        draft: async (_prompt, _call, _sinks, extra) => {
          seen.push(extra);
          return ANSWERED(output([{ text: "A retried write is a second write.", sectionId: "21.3" }]), extra === null ? "max_tokens" : "end_turn");
        },
      }),
    );
    expect(seen[0]).toBeNull();
    expect(seen[1]).toContain("cut off by the length limit");
  });

  it("ships without a score when the grader cannot be reached", async () => {
    const result = await answer(request(), sinks(), deps({ grade: async () => { throw new GatewayUnavailableError("connection", "no grader"); } }));
    expect(result.kind).toBe("answer");
    expect(result.grounded).toBeNull();
    expect(detailOf(result.verdicts, "grader")?.verdict).toBe("NA");
    expect(detailOf(result.verdicts, "grader")?.detail).toContain("connection");
    expect(result.repaired).toBe(false);
  });

  it("says the answer cites another edition when the reader's language differs", async () => {
    const result = await answer(request({ locale: "pt" }), sinks(), deps());
    expect(detailOf(result.verdicts, "edition")?.data.mismatch).toBe(true);
  });

  it("keeps a compare's shape as a sixth row, between citation and edition, and substitutes a claim from a third chapter (spec 19 § 5)", async () => {
    const compare = request({ mode: "compare", context: { chapter: 21, section: null, chapters: [21, 28] } });
    const both = await answer(
      compare,
      sinks(),
      deps({
        draft: async () =>
          ANSWERED(
            JSON.stringify({
              claims: [
                { text: "A retried write is a second write.", sectionId: "21.3", figureId: null },
                { text: "Permissions are granted by policy.", sectionId: "28.1", figureId: null },
              ],
              refusal: null,
              mode_result: { openPoint: "Which side owns the key." },
            }),
          ),
      }),
    );
    expect(both.verdicts.map((verdict) => verdict.sensor)).toEqual(["scope", "citation", "mode", "edition", "grader", "latency"]);
    expect(detailOf(both.verdicts, "mode")).toMatchObject({ verdict: "PASS", detail: "compare · both chapters cited" });
    expect(both.modeResult).toEqual({ openPoint: "Which side owns the key." });

    /* A claim on a third chapter is retrieved (so the citation sensor passes it) and still not the pair's: the mode
       sensor replaces it, and the scope row counts the replacement. */
    const third = await answer(
      request({ mode: "compare", context: { chapter: 21, section: null, chapters: [21, 12] } }),
      sinks(),
      deps({
        draft: async () =>
          ANSWERED(JSON.stringify({ claims: [{ text: "A retried write is a second write.", sectionId: "21.3", figureId: null }, { text: "Permissions are granted by policy.", sectionId: "28.1", figureId: null }], refusal: null, mode_result: { openPoint: null } })),
      }),
    );
    expect(detailOf(third.verdicts, "mode")).toMatchObject({ verdict: "FAIL", detail: "compare · cites chapter 28, outside the pair" });
    expect(third.claims[1]).toMatchObject({ text: NO_COVER.en, substituted: true });
    expect(third.citations.map((citation) => citation.sectionId)).toEqual(["21.3"]);
    expect(detailOf(third.verdicts, "scope")?.detail).toContain("1 claim out of scope");
  });

  it("buys the one repair when a shaped mode's result is missing, and keeps explain at five rows", async () => {
    let drafts = 0;
    const result = await answer(
      request({ mode: "lab", context: { chapter: 21, section: null, labId: "lab-21" } }),
      sinks(),
      deps({
        draft: async () => {
          drafts += 1;
          return ANSWERED(drafts === 1 ? output([{ text: "A retried write is a second write.", sectionId: "21.3" }]) : JSON.stringify({ claims: [{ text: "A retried write is a second write.", sectionId: "21.3", figureId: null }], refusal: null, mode_result: { reproduces: "The duplicate-write count.", divergingMeans: null } }));
        },
      }),
    );
    expect(drafts).toBe(2);
    expect(result.repaired).toBe(true);
    expect(detailOf(result.verdicts, "mode")).toMatchObject({ verdict: "PASS" });
    const explain = await answer(request(), sinks(), deps());
    expect(explain.verdicts).toHaveLength(5);
  });

  it("reads a lab's pseudo-sections merged into its section, and holds a quoted figure to the ones the run checks (spec 19 § 4)", async () => {
    const labSection = promptSection("21.4", "Lab 21 reproduces the survival arithmetic of chapter 21.");
    const lastRun: PromptSection = {
      section: { ...labSection.section, title: "Lab 21 · last run", text: "last run: REPRODUCED · CI · 23 Sep 2026\nF-21-07 duplicates · chapter 117 · last run 117 · match", figureIds: [parseFigureId("F-21-07")], pseudo: { id: "lab:lab-21:lastRun", labId: "lab-21", kind: "lastRun" } },
      figures: [{ figureId: parseFigureId("F-21-07"), label: "duplicate side effects a day", valueText: "117", tier: "DERIVED", derive: { filePath: "derive.py", line: 27 } }],
    };
    const labRequest = request({ mode: "lab", context: { chapter: 21, section: null, labId: "lab-21" } });
    const quoted = await answer(
      labRequest,
      sinks(),
      deps({
        retrieve: async () => [labSection, lastRun],
        draft: async () =>
          ANSWERED(JSON.stringify({ claims: [{ text: "The lab reproduces the survival arithmetic.", sectionId: "21.4", figureId: null }, { text: "The last run matched 117 duplicate side effects a day.", sectionId: "21.4", figureId: "F-21-07" }], refusal: null, mode_result: { reproduces: "The survival arithmetic.", divergingMeans: null } })),
      }),
    );
    /* The claim about the README's fact cites 21.4 and passes the term check against the merged text; the figure is one the run checks. */
    expect(quoted.claims.map((claim) => claim.substituted)).toEqual([false, false]);
    expect(detailOf(quoted.verdicts, "mode")).toMatchObject({ verdict: "PASS", detail: "lab · 1 figure from the run" });
    expect(quoted.citations.map((citation) => citation.figureId)).toEqual([null, "F-21-07"]);

    const unchecked = await answer(
      labRequest,
      sinks(),
      deps({
        retrieve: async () => [labSection, lastRun, SECTIONS[0] as PromptSection],
        draft: async () =>
          ANSWERED(JSON.stringify({ claims: [{ text: "The lab reproduces the survival arithmetic.", sectionId: "21.4", figureId: null }, { text: "A loop that restarts causes 117 duplicate side effects a day.", sectionId: "21.3", figureId: "F-21-07" }], refusal: null, mode_result: { reproduces: "x", divergingMeans: null } })),
      }),
    );
    /* 21.3 is the lab's chapter, so the chapter rule passes it; F-21-07 is checked by the run, so the figure rule passes too. */
    expect(detailOf(unchecked.verdicts, "mode")?.verdict).toBe("PASS");
  });

  it("marks the latency verdict a warning when the first token was late", async () => {
    const late = await answer(request(), sinks(), deps({ draft: async () => ({ ...ANSWERED(output([{ text: "A retried write is a second write.", sectionId: "21.3" }])), firstTokenMs: 2600 }) }));
    expect(detailOf(late.verdicts, "latency")?.verdict).toBe("WARN");
    expect(detailOf(late.verdicts, "latency")?.detail).toContain("first token 2.6 s");
  });
});
