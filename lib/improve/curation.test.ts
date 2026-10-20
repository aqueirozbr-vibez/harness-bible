import { describe, expect, it } from "vitest";

import { decisionOf, OVERRIDE_CODES, type DecisionInput } from "./curation";

const base: DecisionInput = { action: "ACCEPT", origin: "HUMAN", changeClass: "CITED_FIGURE", standing: "REQUEST_MORE", overrideCode: null, criterion: null, note: null };
const of = (fields: Partial<DecisionInput>) => decisionOf({ ...base, ...fields });

describe("decisionOf: 36 § 5.2's override rule", () => {
  it("refuses a request for more kept on a researcher's proposal, which takes accept or decline alone (42 § 7; 43 D16), and takes the other two as for a person's", () => {
    expect(of({ action: "KEEP_REQUEST_MORE", origin: "RESEARCHER" })).toEqual({ kind: "decision", criterion: null, refusal: "NOT_FOR_RESEARCH" });
    expect(of({ action: "KEEP_REQUEST_MORE", origin: "RESEARCHER", standing: "ACCEPT", note: "x" }).refusal).toBe("NOT_FOR_RESEARCH");
    expect(of({ action: "ACCEPT", origin: "RESEARCHER", standing: "ACCEPT" })).toEqual({ kind: "agreement", criterion: null, refusal: null });
    expect(of({ action: "DECLINE", origin: "RESEARCHER", standing: "ACCEPT", criterion: "relevance", note: "The page does not say so." })).toEqual({ kind: "override", criterion: "relevance", refusal: null });
  });

  it("accepting what was left at request more needs a code, tied to its criterion, and a note — the PRD's fourth example", () => {
    expect(of({})).toEqual({ kind: "override", criterion: null, refusal: "OVERRIDE_CODE_REQUIRED" });
    expect(of({ overrideCode: "OV-IND-02" })).toEqual({ kind: "override", criterion: "independence", refusal: "OVERRIDE_NOTE_REQUIRED" });
    expect(of({ overrideCode: "OV-IND-02", note: "   " }).refusal).toBe("OVERRIDE_NOTE_REQUIRED");
    expect(of({ overrideCode: "OV-IND-02", note: "Vendor page is the sole authoritative source for its own price." })).toEqual({ kind: "override", criterion: "independence", refusal: null });
  });

  it("refuses a code the guide has not, and one tied to another criterion than the one named", () => {
    expect(of({ overrideCode: "OV-TIE-01", note: "x" }).refusal).toBe("OVERRIDE_CODE_INVALID");
    expect(of({ overrideCode: "OV-REC-01", criterion: "independence", note: "x" }).refusal).toBe("OVERRIDE_CODE_INVALID");
    expect(of({ overrideCode: "OV-REC-01", criterion: "recency", note: "x" })).toEqual({ kind: "override", criterion: "recency", refusal: null });
    expect(Object.keys(OVERRIDE_CODES)).toEqual(["OV-IND-01", "OV-IND-02", "OV-REC-01", "OV-REL-01"]);
  });

  it("keeps a request for more as agreement, which takes no code and needs no note", () => {
    expect(of({ action: "KEEP_REQUEST_MORE" })).toEqual({ kind: "agreement", criterion: null, refusal: null });
    expect(of({ action: "KEEP_REQUEST_MORE", overrideCode: "OV-IND-02" }).refusal).toBe("OVERRIDE_CODE_NOT_TAKEN");
  });

  it("refuses a criterion on any decision but an override, which alone names one (unit 53's review)", () => {
    expect(of({ action: "KEEP_REQUEST_MORE", criterion: "independence" })).toEqual({ kind: "agreement", criterion: null, refusal: "OVERRIDE_CRITERION_NOT_TAKEN" });
    expect(of({ action: "ACCEPT", standing: "ACCEPT", criterion: "relevance" }).refusal).toBe("OVERRIDE_CRITERION_NOT_TAKEN");
    expect(of({ action: "DECLINE", criterion: "recency" })).toEqual({ kind: "decision", criterion: null, refusal: "OVERRIDE_CRITERION_NOT_TAKEN" });
    expect(of({ changeClass: "CURATOR_ALWAYS", standing: "CURATOR_REVIEW", criterion: "recency", note: "x" })).toEqual({ kind: "decision", criterion: null, refusal: "OVERRIDE_CRITERION_NOT_TAKEN" });
  });

  it("declining a request for more is a decision, not an override (36 § 5.2)", () => {
    expect(of({ action: "DECLINE" })).toEqual({ kind: "decision", criterion: null, refusal: null });
  });

  it("declining what was accepted needs the criterion disputed and a note, and takes no code (D1)", () => {
    expect(of({ action: "DECLINE", standing: "ACCEPT" }).refusal).toBe("OVERRIDE_CRITERION_REQUIRED");
    expect(of({ action: "DECLINE", standing: "ACCEPT", criterion: "relevance" }).refusal).toBe("OVERRIDE_NOTE_REQUIRED");
    expect(of({ action: "DECLINE", standing: "ACCEPT", criterion: "relevance", note: "x", overrideCode: "OV-REL-01" }).refusal).toBe("OVERRIDE_CODE_NOT_TAKEN");
    expect(of({ action: "DECLINE", standing: "ACCEPT", criterion: "relevance", note: "x" })).toEqual({ kind: "override", criterion: "relevance", refusal: null });
    expect(of({ action: "ACCEPT", standing: "ACCEPT" }).kind).toBe("agreement");
  });

  it("a curator-always change, and an adjudicator's failure, have nothing to override: a note, never a code", () => {
    const always = (fields: Partial<DecisionInput>) => of({ changeClass: "CURATOR_ALWAYS", standing: "CURATOR_REVIEW", ...fields });
    expect(always({})).toEqual({ kind: "decision", criterion: null, refusal: "OVERRIDE_NOTE_REQUIRED" });
    expect(always({ action: "DECLINE", note: "Changes the broker's write path." })).toEqual({ kind: "decision", criterion: null, refusal: null });
    expect(always({ note: "x", overrideCode: "OV-IND-02" }).refusal).toBe("OVERRIDE_CODE_NOT_TAKEN");
    expect(of({ standing: "CURATOR_REVIEW", note: "x" })).toEqual({ kind: "decision", criterion: null, refusal: null });
  });
});
