import { describe, expect, it } from "vitest";

import { ledgerKindsOf } from "./audit";

/* The audit pack's checkboxes as the ledger's kinds (feature-specs/38 § 3; since unit 71, 48 § 15). */
describe("the record kinds an audit pack's checkboxes select", () => {
  it("selects a person's research records and a research's deletion with the assistant's answers (48 § 15)", () => {
    expect(ledgerKindsOf(["answers"])).toEqual(["ANSWER", "RESEARCH", "ERASED"]);
  });

  it("gives each ledger kind once, in the ledger's order, whatever the order chosen", () => {
    expect(ledgerKindsOf(["answers", "merges", "adjudications", "overrides", "answers"])).toEqual(["DECIDED", "CURATOR", "MERGED", "ANSWER", "RESEARCH", "RETRACTED", "ERASED"]);
  });
});
