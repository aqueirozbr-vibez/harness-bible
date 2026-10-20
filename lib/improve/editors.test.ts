import { describe, expect, it } from "vitest";

import { schemaSensor } from "@/lib/sensors/intake";

import { checkPassage, claimProposal, newRowProposal, restructureProposal, rowProposal, textProposal, type NewRowFields, type RowNow } from "./editors";

const SOURCE = "The agent retries the call three times before it gives up. If each has a 2% chance to fail, the task fails 6% of the time.\n\nRetries are not optional. Retries are not optional.";
const FIGURES = [
  { id: "F-21-05", valueText: "2%" },
  { id: "F-21-06", valueText: "6%" },
];

describe("textProposal: a passage and its replacement", () => {
  it("makes the schema's proposal, trimmed", () => {
    expect(textProposal("  three times ", "four times")).toEqual({ proposal: { kind: "EDIT_TEXT", before: "three times", after: "four times" }, problem: null });
  });

  it("refuses a proposal over the pipeline's body limit before it is sent", () => {
    const section = "a sentence of the section. ".repeat(1_400);
    expect(textProposal(section, section).problem).toEqual({ field: "before", code: "tooLong" });
    expect(textProposal(section, "short").proposal).not.toBeNull();
  });

  it("names the empty field", () => {
    expect(textProposal(" ", "x").problem).toEqual({ field: "before", code: "required" });
    expect(textProposal("three times", "").problem).toEqual({ field: "after", code: "required" });
  });
});

describe("claimProposal: a claim, its place and its pace", () => {
  it("places a claim at the end or after a passage", () => {
    expect(claimProposal("A new claim.", "end", "ignored", false).proposal).toEqual({ kind: "ADD_CLAIM", text: "A new claim.", placeAfter: "end", fastMoving: false });
    expect(claimProposal("A new claim.", "after", " before it gives up. ", true).proposal).toEqual({ kind: "ADD_CLAIM", text: "A new claim.", placeAfter: "before it gives up.", fastMoving: true });
  });

  it("names the empty text, and the empty passage of a claim placed after one", () => {
    expect(claimProposal("", "end", "", false).problem).toEqual({ field: "text", code: "required" });
    expect(claimProposal("A claim.", "after", "  ", false).problem).toEqual({ field: "placeAfter", code: "required" });
  });
});

describe("rowProposal: the fields of a row that change", () => {
  const now: RowNow = { claim: "cached-input price, provider tier 2", citation: "Pricing page", url: "https://provider-two.example/pricing", doi: null, verifiedOn: "2026-06-16" };
  const keep = { claim: "", citation: "", url: "", doi: "", verifiedOn: "" };

  it("sends the fields that differ from the row's, and keeps an empty one", () => {
    expect(rowProposal(now, { ...keep, claim: " cached-input price, provider tier 2 (Sep 2026) ", verifiedOn: "2026-09-12" }).proposal).toEqual({ kind: "EDIT_ROW", claim: "cached-input price, provider tier 2 (Sep 2026)", verifiedOn: "2026-09-12" });
    expect(rowProposal(now, { ...keep, citation: "Pricing page", url: "https://provider-two.example/pricing" }).problem).toEqual({ field: "row", code: "unchanged" });
    expect(rowProposal(now, keep).problem).toEqual({ field: "row", code: "unchanged" });
  });

  it("names the field the schema refuses", () => {
    expect(rowProposal(now, { ...keep, url: "provider-two pricing" }).problem).toEqual({ field: "url", code: "invalid" });
    expect(rowProposal(now, { ...keep, doi: "doi:10.1000" }).problem).toEqual({ field: "doi", code: "invalid" });
    expect(rowProposal(now, { ...keep, verifiedOn: "16/06/2026" }).problem).toEqual({ field: "verifiedOn", code: "invalid" });
  });
});

describe("newRowProposal: a row added", () => {
  const row: NewRowFields = { claim: "batch discount, provider tier 3", citation: "Provider three pricing", url: "", doi: "", tier: "VENDOR", fastMoving: true, newTier: "" };

  it("leaves out an empty link and DOI and takes one of the book's tiers", () => {
    expect(newRowProposal(row).proposal).toEqual({ kind: "ADD_ROW", claim: "batch discount, provider tier 3", citation: "Provider three pricing", tier: "VENDOR", fastMoving: true });
    expect(newRowProposal({ ...row, url: "https://provider-three.example/pricing", doi: "10.1000/182" }).proposal).toMatchObject({ url: "https://provider-three.example/pricing", doi: "10.1000/182" });
  });

  it("takes a new tier by its name, and names what is missing or refused", () => {
    expect(newRowProposal({ ...row, tier: "NEW", newTier: "regulator filing" }).proposal).toMatchObject({ tier: { newTier: "regulator filing" } });
    expect(newRowProposal({ ...row, tier: "NEW" }).problem).toEqual({ field: "newTier", code: "required" });
    expect(newRowProposal({ ...row, tier: "NEW", newTier: "x".repeat(41) }).problem).toEqual({ field: "newTier", code: "invalid" });
    expect(newRowProposal({ ...row, claim: "" }).problem).toEqual({ field: "claim", code: "required" });
    expect(newRowProposal({ ...row, citation: " " }).problem).toEqual({ field: "citation", code: "required" });
    expect(newRowProposal({ ...row, tier: null }).problem).toEqual({ field: "tier", code: "required" });
    expect(newRowProposal({ ...row, url: "not a url" }).problem).toEqual({ field: "url", code: "invalid" });
  });
});

describe("restructureProposal", () => {
  it("takes a description, and names an empty one", () => {
    expect(restructureProposal("Split 21.3 into two sections.").proposal).toEqual({ kind: "RESTRUCTURE", description: "Split 21.3 into two sections." });
    expect(restructureProposal("").problem).toEqual({ field: "description", code: "required" });
  });
});

describe("checkPassage: what the schema sensor will say, before it is asked", () => {
  const sensor = (before: string, after: string) => schemaSensor({ changeKind: "EDIT_TEXT", anchorKind: "SECTION", proposal: { kind: "EDIT_TEXT", before, after }, section: { id: "21.3", sourceText: SOURCE, figures: FIGURES } });

  it("finds a passage once, never, or more than once", () => {
    expect(checkPassage(SOURCE, FIGURES, "before it gives up", "until it gives up")).toEqual({ times: 1, figure: null, digits: false, same: false });
    expect(checkPassage(SOURCE, FIGURES, "fourteen calls", "fifteen calls").times).toBe(0);
    expect(checkPassage(SOURCE, FIGURES, "Retries are not optional", null)).toEqual({ times: 2, figure: null, digits: false, same: false });
  });

  it("names a figure the passage holds, a changed digit and an unchanged replacement", () => {
    expect(checkPassage(SOURCE, FIGURES, "a 2% chance to fail", "a small chance to fail").figure).toBe("F-21-05");
    expect(checkPassage(SOURCE, FIGURES, "three times before", "3 times before").digits).toBe(true);
    expect(checkPassage(SOURCE, FIGURES, " before it gives up ", "before it gives up").same).toBe(true);
  });

  it("agrees with the sensor check by check: the sensor's first refusal is the check's first finding, and it passes exactly what the check finds clean", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["before it gives up", "until it gives up"],
      ["fourteen calls", "fifteen calls"],
      ["Retries are not optional", "Retries are required"],
      ["a 2% chance to fail", "a small chance to fail"],
      ["three times before", "3 times before"],
      ["before it gives up", "before it gives up"],
      ["If each has a 2% chance", "If each has a 2% chance"],
    ];
    for (const [before, after] of cases) {
      const check = checkPassage(SOURCE, FIGURES, before, after);
      const verdict = sensor(before, after);
      const data = verdict.data as { field?: string; occurrences?: number; figure?: string | null };
      /* The sensor tests in this order and answers the first that fails (lib/sensors/intake.ts). */
      const first = check.times !== 1 ? { field: "before", occurrences: check.times } : check.figure !== null ? { field: "before", figure: check.figure } : check.digits ? { field: "after" } : check.same ? { field: "after" } : null;
      if (first === null) expect(verdict.result, `${before} → ${after}`).toBe("PASS");
      else expect(data, `${before} → ${after}`).toMatchObject(first);
      if (first !== null && check.times === 1 && check.figure === null) expect(verdict.detail, `${before} → ${after}`).toContain(check.digits ? "changes a digit" : "is the same as before");
    }
  });
});
