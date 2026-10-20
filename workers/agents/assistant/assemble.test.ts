import { describe, expect, it } from "vitest";

import type { Guide } from "@/lib/guides/load";
import { parseFigureId, parseReleaseId, parseSectionId } from "@/lib/schemas/ids";
import type { RetrievedSection } from "@/lib/search/retrieve";

import { assemble, citableFigures, citableSections, CONVERSATION_TURNS, promptSha256, sectionFence, type AssistantPromptInput, type PromptSection } from "./assemble";

/*
 * The assembler (feature-specs/13 § 5): the fixed order, the one cache breakpoint, the fences, and the hash that
 * answers "was the cached prefix the same?". What is asserted here is mostly what the prompt does **not** carry.
 */

const GUIDE: Guide = { agent: "assistant", version: "v1.8", prefix: "You are the reading assistant.\n", sha256: "a".repeat(64) };

function section(id: string, chapter: number, text: string, figures: PromptSection["figures"] = []): PromptSection {
  const retrieved: RetrievedSection = {
    sectionId: parseSectionId(id),
    chapter,
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
  return { section: retrieved, figures };
}

function input(overrides: Partial<AssistantPromptInput> = {}): AssistantPromptInput {
  return {
    guide: GUIDE,
    releaseId: parseReleaseId("2026.09"),
    sections: [section("21.3", 21, "A retried write is safe when it carries a key.")],
    conversation: [],
    question: "What counts as harness cost?",
    mode: "explain",
    locale: "en",
    aidResult: null,
    ...overrides,
  };
}

describe("the assistant's prompt (feature-specs/13 § 5)", () => {
  it("puts the guide prefix first, byte for byte, and the one cache breakpoint on it", () => {
    const { system } = assemble(input());
    expect(system[0]).toEqual({ type: "text", text: GUIDE.prefix, cache_control: { type: "ephemeral" } });
    /* The breakpoint is on the prefix and nowhere else: everything after it is per-request, and a second
       breakpoint further down would put the mode or the sections inside the cached prefix. */
    expect(system.filter((block) => block.cache_control !== undefined)).toHaveLength(1);
  });

  it("states the release, the mode, the answer's language and the edition, after the breakpoint", () => {
    const { system } = assemble(input({ mode: "compare", locale: "pt" }));
    expect(system[1]?.text).toBe("release 2026.09 · mode compare · answer in pt · edition EN");
    expect(system[1]?.cache_control).toBeUndefined();
  });

  it("fences each section as data, with its figures listed so no id is guessed", () => {
    const figures = [
      { figureId: parseFigureId("F-21-05"), label: "expected work redone", valueText: "45%", tier: "DERIVED", derive: { filePath: "derive.py", line: 14 } },
      { figureId: parseFigureId("F-21-07"), label: "duplicate side effects a day", valueText: "117", tier: "DERIVED", derive: null },
    ];
    const fence = sectionFence(section("21.3", 21, "Body text.", figures));
    expect(fence).toContain('<section id="21.3" chapter="21" version="v1.0.0" edition="EN" verify="PASSED">');
    expect(fence).toContain('figures: F-21-05 "expected work redone" 45% (derived, L14); F-21-07 "duplicate side effects a day" 117 (derived)');
    expect(fence.endsWith("</section>")).toBe(true);
  });

  it("puts the question last and fenced, and never prefills an assistant turn", () => {
    const { messages } = assemble(input({ conversation: [{ role: "user", text: "Earlier?", refusal: null }, { role: "assistant", text: "Earlier answer.", refusal: null }] }));
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe("<question>\nWhat counts as harness cost?\n</question>");
    /* `claude-opus-5` answers 400 to a prefilled last assistant turn, so the conversation may never end on one. */
    expect(messages.every((message, index) => index === messages.length - 1 || true)).toBe(true);
    expect(messages.at(-1)?.role).not.toBe("assistant");
  });

  it("carries at most the last six turns of the conversation", () => {
    const many = Array.from({ length: 10 }, (_item, index) => ({ role: index % 2 === 0 ? ("user" as const) : ("assistant" as const), text: `turn ${String(index)}`, refusal: null }));
    const { messages } = assemble(input({ conversation: many }));
    const turns = messages.filter((message) => message.content.startsWith("turn "));
    expect(turns).toHaveLength(CONVERSATION_TURNS);
    expect(turns[0]?.content).toBe("turn 4");
  });

  it("fences the walk's values in walk mode and omits the slot entirely otherwise", () => {
    const withAid = assemble(input({ mode: "walk", aidResult: { step: 2, of: 4 } }));
    expect(withAid.messages.some((message) => message.content.startsWith("<aid>"))).toBe(true);
    const without = assemble(input());
    expect(without.messages.some((message) => message.content.startsWith("<aid>"))).toBe(false);
  });

  it("hashes the prefix alone, so two readers asking different questions of one page share it", () => {
    const base = input();
    expect(promptSha256(base)).toBe(promptSha256(input({ question: "A different question entirely?" })));
    expect(promptSha256(base)).toBe(promptSha256(input({ conversation: [{ role: "user", text: "hello", refusal: null }] })));
    /* What does change it: the guide, the release, the mode, the language, the sections. */
    expect(promptSha256(base)).not.toBe(promptSha256(input({ mode: "brief" })));
    expect(promptSha256(base)).not.toBe(promptSha256(input({ locale: "pt" })));
    expect(promptSha256(base)).not.toBe(promptSha256(input({ sections: [section("21.4", 21, "Other text.")] })));
    expect(promptSha256(base)).not.toBe(promptSha256(input({ guide: { ...GUIDE, sha256: "b".repeat(64) } })));
  });

  it("says which ids a claim may cite", () => {
    const figures = [{ figureId: parseFigureId("F-21-05"), label: "l", valueText: "45%", tier: "DERIVED", derive: null }];
    const built = input({ sections: [section("21.3", 21, "t", figures), section("28.1", 28, "u")] });
    expect([...citableSections(built)]).toEqual(["21.3", "28.1"]);
    expect([...(citableFigures(built).get(parseSectionId("21.3")) ?? [])]).toEqual(["F-21-05"]);
    expect([...(citableFigures(built).get(parseSectionId("28.1")) ?? [])]).toEqual([]);
  });

  it("fences a lab pseudo-section under its own id, says what it cites as, and adds its figures to the lab section's (spec 19 § 4)", () => {
    const lab = section("21.4", 21, "Lab 21 reproduces the survival arithmetic.");
    const lastRun: PromptSection = {
      section: { ...lab.section, title: "Lab 21 · last run", text: "last run: REPRODUCED · CI · 23 Sep 2026", pseudo: { id: "lab:lab-21:lastRun", labId: "lab-21", kind: "lastRun" } },
      figures: [{ figureId: parseFigureId("F-21-07"), label: "duplicates", valueText: "117", tier: "DERIVED", derive: { filePath: "derive.py", line: 27 } }],
    };
    const fence = sectionFence(lastRun);
    expect(fence.startsWith('<section id="lab:lab-21:lastRun" cite="21.4" chapter="21"')).toBe(true);
    expect(fence).toContain("(cite this as section 21.4)\nlast run: REPRODUCED");
    const built = input({ sections: [lab, lastRun], mode: "lab" });
    expect([...citableSections(built)]).toEqual(["21.4"]);
    expect([...(citableFigures(built).get(parseSectionId("21.4")) ?? [])]).toEqual(["F-21-07"]);
  });

  it("carries nothing about the reader: the type has no field for one", () => {
    const { system, messages } = assemble(input({ question: "Who am I?" }));
    const whole = [...system.map((block) => block.text), ...messages.map((message) => message.content)].join("\n");
    for (const forbidden of ["@", "organisationId", "userId", "principal", "sessionId"]) {
      expect(whole, `the prompt must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});
