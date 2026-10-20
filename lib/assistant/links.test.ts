import { describe, expect, it } from "vitest";

import { assistantPageHref, assistantPageStateOf, pageHref, readerSectionOf, refHref, withAsk, withDraft } from "./links";

describe("the dock's links (feature-specs/24 § 4, § 5.5)", () => {
  it("opens a reference in the peek when the dock stands beside a reader section", () => {
    const base = { peek: "/en/ch/21/21.3", locale: "en", ask: "c-1" };
    expect(refHref(base, "26.3")).toBe("/en/ch/21/21.3/ref/26.3");
    expect(refHref(base, "lab21")).toBe("/en/ch/21/21.3/ref/lab21");
  });

  it("opens a cited section in the reader, the conversation with it, from any other page", () => {
    const base = { peek: null, locale: "pt", ask: "c-1" };
    expect(refHref(base, "26.3")).toBe("/pt/ch/26/26.3?ask=c-1");
    expect(refHref({ ...base, ask: "1" }, "09.2")).toBe("/pt/ch/09/09.2?ask=1");
    /* A lab is not a reader section: the book's resolver takes it. */
    expect(refHref(base, "lab21")).toBe("/pt/ref/lab21");
  });

  it("adds ask to a page that has parameters of its own, and a draft after it", () => {
    expect(withAsk("/en/marks", "1")).toBe("/en/marks?ask=1");
    expect(withAsk("/en/search?q=cache", "c-1")).toBe("/en/search?q=cache&ask=c-1");
    expect(withDraft("/en/ch/21/21.3", "About 21.3: ")).toBe("/en/ch/21/21.3?ask=1&draft=About%2021.3%3A%20");
    expect(withDraft("/en/search?q=cache", "cache")).toBe("/en/search?q=cache&ask=1&draft=cache");
  });
});

describe("where the dock is mounted (feature-specs/24 § 3)", () => {
  it("knows a reader section's page from its path, and nothing else as one", () => {
    expect(readerSectionOf(["ch", "21", "21.3"])).toBe("21.3");
    expect(readerSectionOf(["ch", "00", "00.1"])).toBe("00.1");
    /* The chapter's own page, a section of another chapter, the peek's standalone page and every other route. */
    expect(readerSectionOf(["ch", "21"])).toBeNull();
    expect(readerSectionOf(["ch", "21", "28.1"])).toBeNull();
    expect(readerSectionOf(["ch", "21", "21.3", "ref", "26.3"])).toBeNull();
    expect(readerSectionOf(["search"])).toBeNull();
    expect(readerSectionOf([])).toBeNull();
  });

  it("closes to the page's own URL: its parameters kept, the dock's two dropped", () => {
    expect(pageHref("en", [], { ask: "1" })).toBe("/en");
    expect(pageHref("en", ["marks"], { ask: "1", draft: "About 21.3: " })).toBe("/en/marks");
    expect(pageHref("pt", ["search"], { q: "cache", part: ["P1", "P2"], ask: "c-1" })).toBe("/pt/search?q=cache&part=P1&part=P2");
    expect(pageHref("en", ["ch", "21", "21.3"], {})).toBe("/en/ch/21/21.3");
  });
});

describe("the assistant page's URL state (feature-specs/26 § 3)", () => {
  it("leaves every default out, so the plain URL is the plain page", () => {
    expect(assistantPageHref("en")).toBe("/en/assistant");
    expect(assistantPageHref("en", { ask: null, window: "month", listed: 20, view: "dock" })).toBe("/en/assistant");
    expect(assistantPageHref("pt", { ask: "c-1", window: "all", listed: 40, view: "stats" })).toBe("/pt/assistant?ask=c-1&w=all&n=40&view=stats");
    expect(assistantPageHref("en", { listed: 900 })).toBe("/en/assistant?n=200");
  });

  it("reads the state back, and anything it does not know as the default", () => {
    expect(assistantPageStateOf({})).toEqual({ ask: null, window: "month", listed: 20, view: "dock" });
    expect(assistantPageStateOf({ ask: "c-1", w: "all", n: "40", view: "conversations" })).toEqual({ ask: "c-1", window: "all", listed: 40, view: "conversations" });
    expect(assistantPageStateOf({ w: "year", n: "7", view: "everything", ask: ["a", "b"] })).toEqual({ ask: null, window: "month", listed: 20, view: "dock" });
    expect(assistantPageStateOf({ n: "100000" }).listed).toBe(200);
  });
});
