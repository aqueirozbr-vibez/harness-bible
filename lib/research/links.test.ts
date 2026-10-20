import { describe, expect, it } from "vitest";

import { openDockHref, otherDockClosedHref, researchDockCloseHref, researchPageHref, researchPageStateOf, researchRefHref, runPageId, withResearch } from "./links";

describe("the Research page's URL (feature-specs/48 § 11.1)", () => {
  it("leaves out each parameter at its default, so the plain URL is the plain page", () => {
    expect(researchPageHref("en")).toBe("/en/research");
    expect(researchPageHref("pt", { research: null, from: null, window: "month", listed: 20, view: "dock" })).toBe("/pt/research");
    expect(researchPageHref("en", { research: "r-1", window: "all", listed: 40, view: "conversations" })).toBe("/en/research?research=r-1&w=all&n=40&view=conversations");
    expect(researchPageHref("en", { from: "m-1", view: "stats" })).toBe("/en/research?from=m-1&view=stats");
    expect(researchPageHref("en", { listed: 900 })).toBe("/en/research?n=200");
  });

  it("reads the state back, anything it does not know as the default, and `n` in steps of twenty", () => {
    expect(researchPageStateOf({})).toEqual({ research: null, from: null, window: "month", listed: 20, view: "dock" });
    expect(researchPageStateOf({ research: "1", from: "m-1", w: "all", n: "60", view: "stats" })).toEqual({ research: "1", from: "m-1", window: "all", listed: 60, view: "stats" });
    expect(researchPageStateOf({ w: "year", n: "abc", view: "elsewhere" })).toEqual({ research: null, from: null, window: "month", listed: 20, view: "dock" });
    expect(researchPageStateOf({ n: "25" }).listed).toBe(40);
    expect(researchPageStateOf({ n: "5" }).listed).toBe(20);
    expect(researchPageStateOf({ n: "1000" }).listed).toBe(200);
    /* a repeated parameter is not a value */
    expect(researchPageStateOf({ research: ["a", "b"] }).research).toBeNull();
  });
});

describe("a research's links into the book (§ 11.3)", () => {
  it("opens a section in the reader with no dock parameter from the Research page", () => {
    expect(researchRefHref({ locale: "en", research: null }, "21.3")).toBe("/en/ch/21/21.3");
    expect(researchRefHref({ locale: "pt", research: null }, "09.2")).toBe("/pt/ch/09/09.2");
  });

  it("keeps the Research dock open there from the dock, and never adds the Assistant's `ask`", () => {
    expect(researchRefHref({ locale: "en", research: "r-1" }, "21.3")).toBe("/en/ch/21/21.3?research=r-1");
    expect(researchRefHref({ locale: "en", research: "1" }, "21.3")).not.toContain("ask=");
  });

  it("hands any other id to the book's resolver", () => {
    expect(researchRefHref({ locale: "en", research: null }, "F-21-03")).toBe("/en/ref/F-21-03");
    expect(researchRefHref({ locale: "en", research: "r-1" }, "21.9 r10")).toBe("/en/ref/21.9%20r10");
    expect(researchRefHref({ locale: "en", research: null }, "lab21")).toBe("/en/ref/lab21");
  });

  it("names a page row by its run and its number, so two runs' page 3 are two ids", () => {
    expect(runPageId("a", 3)).toBe("run-a-page-3");
    expect(runPageId("a", 3)).not.toBe(runPageId("b", 3));
  });
});

describe("the two docks' parameters by path (§ 12; unit 77)", () => {
  it("opens the Research dock empty, dropping the Assistant's `ask` and `draft` but on the Assistant page, and touching nothing else", () => {
    expect(openDockHref("/en", "research")).toBe("/en?research=1");
    expect(openDockHref("/en/ch/21/21.3?ask=1&draft=About+21.3", "research")).toBe("/en/ch/21/21.3?research=1");
    expect(openDockHref("/en/search?q=cache&research=r-1", "research")).toBe("/en/search?q=cache&research=1");
    /* on `/assistant` the conversation is the page's: the dock opens over it */
    expect(openDockHref("/en/assistant?ask=c-1", "research")).toBe("/en/assistant?ask=c-1&research=1");
    /* no key drops `from` */
    expect(openDockHref("/en/ch/21/improve/new?anchor=21.3&from=21.3", "research")).toBe("/en/ch/21/improve/new?anchor=21.3&from=21.3&research=1");
    expect(openDockHref("/en/rubric?from=21.3", "research")).toBe("/en/rubric?from=21.3&research=1");
  });

  it("opens the Assistant's dock empty, dropping `research` but on the Research page", () => {
    expect(openDockHref("/en/marks?research=r-1", "assistant")).toBe("/en/marks?ask=1");
    expect(openDockHref("/en/ch/21/21.3?ask=c-1&draft=x", "assistant")).toBe("/en/ch/21/21.3?ask=1");
    /* on `/research` the research is the page's: the Assistant's dock opens over it */
    expect(openDockHref("/en/research?research=r-1&w=all", "assistant")).toBe("/en/research?research=r-1&w=all&ask=1");
    expect(openDockHref("/en/rubric?from=21.3&research=1", "assistant")).toBe("/en/rubric?from=21.3&ask=1");
  });

  it("closes the other dock over a page whose own column the key focuses, and says when there is none", () => {
    /* `a` on the Assistant page with the Research dock over it: the dock goes, the conversation stays */
    expect(otherDockClosedHref("/en/assistant?ask=c-1&research=r-1", "assistant")).toBe("/en/assistant?ask=c-1");
    /* `r` on the Research page with the Assistant's dock over it */
    expect(otherDockClosedHref("/en/research?research=r-1&ask=1&draft=x", "research")).toBe("/en/research?research=r-1");
    expect(otherDockClosedHref("/en/assistant?ask=c-1", "assistant")).toBeNull();
    expect(otherDockClosedHref("/en/research?research=r-1", "research")).toBeNull();
    /* each page's own parameter is never the other dock's */
    expect(otherDockClosedHref("/en/research?research=r-1&ask=1", "assistant")).toBeNull();
    expect(otherDockClosedHref("/en/assistant?ask=c-1&research=1", "research")).toBeNull();
  });

  it("closes the Research dock to the page's own URL, which keeps every other parameter", () => {
    expect(researchDockCloseHref("en", [], { research: "1" })).toBe("/en");
    expect(researchDockCloseHref("pt", ["ch", "21", "21.3"], { research: "r-1" })).toBe("/pt/ch/21/21.3");
    expect(researchDockCloseHref("en", ["assistant"], { ask: "c-1", research: "1" })).toBe("/en/assistant?ask=c-1");
    expect(researchDockCloseHref("en", ["search"], { q: "cache key", research: "1", t: ["a", "b"] })).toBe("/en/search?q=cache+key&t=a&t=b");
    expect(withResearch("/en/search?q=cache", "r-1")).toBe("/en/search?q=cache&research=r-1");
    expect(withResearch("/en", "1")).toBe("/en?research=1");
  });
});
