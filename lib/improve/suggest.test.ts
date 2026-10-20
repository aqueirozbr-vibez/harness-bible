import { describe, expect, it } from "vitest";

import { RoleSchema } from "@/lib/schemas/auth";

import { anchorKindOf, changeKindsFor, chapterDigitsOf, chooserChapterOf, firstOfKind, homeSectionOf, suggestChooserHref, suggestGate, suggestStartHref } from "./suggest";

describe("changeKindsFor: what an anchor of each kind can have proposed", () => {
  it("gives a section the four kinds of 34 D4, in their order, a figure its value and a row its edit", () => {
    expect(changeKindsFor("SECTION")).toEqual(["EDIT_TEXT", "ADD_CLAIM", "ADD_ROW", "RESTRUCTURE"]);
    expect(changeKindsFor("FIGURE")).toEqual(["SET_VALUE"]);
    expect(changeKindsFor("SOURCE_ROW")).toEqual(["EDIT_ROW"]);
  });
});

describe("anchorKindOf: the kind an id is written as", () => {
  it("reads the three disjoint forms", () => {
    expect(anchorKindOf("21.3")).toBe("SECTION");
    expect(anchorKindOf("21.9")).toBe("SECTION");
    expect(anchorKindOf("F-21-03")).toBe("FIGURE");
    expect(anchorKindOf("F-21-103")).toBe("FIGURE");
    expect(anchorKindOf("21.9 r4")).toBe("SOURCE_ROW");
    expect(anchorKindOf("15.9 r12")).toBe("SOURCE_ROW");
  });

  it("answers null for anything else", () => {
    for (const id of ["", "21", "21.0", "21.10", "21.3 r4", "21.9 r", "21.9r4", "F-21-3", "f-21-03", "21.3 ", " 21.3", "S-15-0377", "x"]) expect(anchorKindOf(id), id).toBeNull();
  });
});

describe("chapterDigitsOf", () => {
  it("takes the chapter from where each form writes it", () => {
    expect(chapterDigitsOf("15.3", "SECTION")).toBe("15");
    expect(chapterDigitsOf("15.9 r12", "SOURCE_ROW")).toBe("15");
    expect(chapterDigitsOf("F-07-12", "FIGURE")).toBe("07");
  });
});

describe("suggestStartHref: step 1's address", () => {
  it("is the anchor's chapter with the anchor, and no `from` when the anchor is the section itself", () => {
    expect(suggestStartHref("en", "21.3", "SECTION", "21.3")).toBe("/en/ch/21/improve/new?anchor=21.3");
  });

  it("carries the section the person came from, and writes a row's space as +", () => {
    const href = suggestStartHref("pt", "15.9 r12", "SOURCE_ROW", "15.3");
    expect(href).toBe("/pt/ch/15/improve/new?anchor=15.9+r12&from=15.3");
    expect(href).not.toMatch(/\s/);
    expect(new URL(href, "http://x").searchParams.get("anchor")).toBe("15.9 r12");
  });

  it("follows the anchor's chapter, whatever the section", () => {
    expect(suggestStartHref("en", "F-07-12", "FIGURE", "07.3")).toBe("/en/ch/07/improve/new?anchor=F-07-12&from=07.3");
  });
});

describe("suggestChooserHref and chooserChapterOf: the new-suggestion chooser's address (48 § 10.1)", () => {
  it("is the chapters' list, or with a chapter's two digits its sections", () => {
    expect(suggestChooserHref("en")).toBe("/en/improve/new");
    expect(suggestChooserHref("pt", null)).toBe("/pt/improve/new");
    expect(suggestChooserHref("en", "21")).toBe("/en/improve/new?ch=21");
    expect(suggestChooserHref("pt", "00")).toBe("/pt/improve/new?ch=00");
  });

  it("reads `ch` as two digits and nothing else", () => {
    expect(chooserChapterOf("21")).toBe("21");
    expect(chooserChapterOf("00")).toBe("00");
    for (const value of [undefined, null, "", "1", "021", "21 ", "ab", "2a", ["21"], 21]) expect(chooserChapterOf(value), String(value)).toBeNull();
  });
});

describe("homeSectionOf: the section the lists are read from", () => {
  it("is a section's own and a figure's own, whatever `from` says", () => {
    expect(homeSectionOf(undefined, "15.3", "SECTION", null)).toBe("15.3");
    expect(homeSectionOf("15.4", "15.3", "SECTION", null)).toBe("15.3");
    expect(homeSectionOf(undefined, "F-15-12", "FIGURE", "15.3")).toBe("15.3");
    expect(homeSectionOf("15.4", "F-15-12", "FIGURE", "15.3")).toBe("15.3");
  });

  it("is, for a row, the section the person came from when it is one of the chapter's", () => {
    expect(homeSectionOf("15.3", "15.9 r12", "SOURCE_ROW", null)).toBe("15.3");
  });

  it("is otherwise the chapter's first section: a row without a usable `from`, a figure without its section", () => {
    expect(homeSectionOf(undefined, "15.9 r12", "SOURCE_ROW", null)).toBe("15.1");
    expect(homeSectionOf("16.3", "15.9 r12", "SOURCE_ROW", null)).toBe("15.1");
    expect(homeSectionOf("15.9 r1", "15.9 r12", "SOURCE_ROW", null)).toBe("15.1");
    expect(homeSectionOf(undefined, "F-15-12", "FIGURE", null)).toBe("15.1");
  });
});

describe("firstOfKind: what choosing a kind selects", () => {
  const figures = [{ id: null }, { id: "F-15-04" }, { id: "F-15-05" }];
  const cited = [{ id: "15.9 r3" }];
  const rows = [{ id: "15.9 r1" }, { id: "15.9 r3" }];

  it("selects the section, its first figure with an id, and the first row its figures cite", () => {
    expect(firstOfKind("SECTION", "15.3", figures, cited, rows)).toBe("15.3");
    expect(firstOfKind("FIGURE", "15.3", figures, cited, rows)).toBe("F-15-04");
    expect(firstOfKind("SOURCE_ROW", "15.3", figures, cited, rows)).toBe("15.9 r3");
  });

  it("falls back to the chapter's first row, and answers null when there is nothing to choose", () => {
    expect(firstOfKind("SOURCE_ROW", "15.3", figures, [], rows)).toBe("15.9 r1");
    expect(firstOfKind("SOURCE_ROW", "00.1", [], [], [])).toBeNull();
    expect(firstOfKind("FIGURE", "15.1", [{ id: null }], cited, rows)).toBeNull();
  });
});

describe("suggestGate: who may start a draft", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("lets a verified contributor or curator, not throttled, have the form", () => {
    expect(suggestGate({ role: "CONTRIBUTOR", identityVerified: true }, null, now)).toEqual({ kind: "form" });
    expect(suggestGate({ role: "CURATOR", identityVerified: true }, null, now)).toEqual({ kind: "form" });
  });

  it("refuses every other role first, as the endpoint's role gate does, verified or not", () => {
    for (const role of RoleSchema.options.filter((r) => r !== "CONTRIBUTOR" && r !== "CURATOR")) {
      expect(suggestGate({ role, identityVerified: true }, null, now), role).toEqual({ kind: "role", role });
      expect(suggestGate({ role, identityVerified: false }, new Date("2026-11-01T00:00:00Z"), now), role).toEqual({ kind: "role", role });
    }
  });

  it("then asks a verified identity, then the throttle", () => {
    expect(suggestGate({ role: "CONTRIBUTOR", identityVerified: false }, new Date("2026-11-01T00:00:00Z"), now)).toEqual({ kind: "unverified" });
    const until = new Date("2026-11-01T00:00:00Z");
    expect(suggestGate({ role: "CONTRIBUTOR", identityVerified: true }, until, now)).toEqual({ kind: "throttled", until });
  });

  it("forgets a throttle that has run out, the instant it does", () => {
    expect(suggestGate({ role: "CONTRIBUTOR", identityVerified: true }, new Date("2026-10-01T00:00:00Z"), now)).toEqual({ kind: "form" });
    expect(suggestGate({ role: "CONTRIBUTOR", identityVerified: true }, now, now)).toEqual({ kind: "form" });
  });
});
