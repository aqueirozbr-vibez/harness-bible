import { describe, expect, it } from "vitest";

import { ProposalSchema } from "@/lib/schemas/improve";

import { returnPathOf } from "./merge";
import { reverseOf, revertSubjectOf } from "./revert";

/* A revert's rules (feature-specs/37 § 8; unit 54e), pure: the proposal that undoes a merged one, or the curator's hand. */

describe("reverseOf", () => {
  it("exchanges a passage's before and after", () => {
    expect(reverseOf("S-21-0001", "EDIT_TEXT", { kind: "EDIT_TEXT", before: "retries the call", after: "tries the call again" }, "It retries the call.")).toEqual({ byHand: false, proposal: { kind: "EDIT_TEXT", before: "tries the call again", after: "retries the call" } });
  });

  it("sets a figure back to the value it had, in the original's unit, as a proposal the schema takes", () => {
    /* the digits as the book printed them (`0.50`, not `0.5`), so the reverted file is the original byte for byte (unit 54's review) */
    const reverse = reverseOf("S-21-0002", "SET_VALUE", { kind: "SET_VALUE", after: "0.40", unit: "USD" }, "cached-input price · $0.50");
    expect(reverse).toEqual({ byHand: false, proposal: { kind: "SET_VALUE", after: "0.50", unit: "USD" } });
    expect(ProposalSchema.safeParse(reverse.proposal).success).toBe(true);
    expect(reverseOf("S-21-0003", "SET_VALUE", { kind: "SET_VALUE", after: "1.3", unit: "×" }, "cost reduction at 95% quality retention · 2.4×")).toMatchObject({ byHand: false, proposal: { kind: "SET_VALUE", after: "2.4", unit: "×" } });
    /* the anchor's text is `label · valueText unit`, the unit in the value already: `77% %`, `1 s s`, `2.4× ×` (unit 54's review) */
    expect(reverseOf("S-21-0004", "SET_VALUE", { kind: "SET_VALUE", after: "80", unit: "%" }, "no failure only · 77% %")).toMatchObject({ byHand: false, proposal: { kind: "SET_VALUE", after: "77", unit: "%" } });
    expect(reverseOf("S-21-0005", "SET_VALUE", { kind: "SET_VALUE", after: "2", unit: "s" }, "sandbox ready · 1 s s")).toMatchObject({ byHand: false, proposal: { kind: "SET_VALUE", after: "1", unit: "s" } });
    expect(reverseOf("S-21-0006", "SET_VALUE", { kind: "SET_VALUE", after: "1.3", unit: "×" }, "cost reduction · 2.4× ×")).toMatchObject({ byHand: false, proposal: { kind: "SET_VALUE", after: "2.4", unit: "×" } });
    expect(reverseOf("S-21-0007", "SET_VALUE", { kind: "SET_VALUE", after: "8000", unit: "tokens" }, "context used · 7,500 tokens tokens")).toMatchObject({ byHand: false, proposal: { kind: "SET_VALUE", after: "7500", unit: "tokens" } });
    /* a value the figure's text does not give is the curator's hand */
    expect(reverseOf("S-21-0004", "SET_VALUE", { kind: "SET_VALUE", after: "3", unit: null }, "a figure with no value")).toMatchObject({ byHand: true, proposal: { kind: "RESTRUCTURE" } });
  });

  it("leaves a claim or a row added, a row edited, a restructure and a proposal that is gone to the curator's hand, in the product's words", () => {
    for (const [kind, proposal, why] of [
      ["ADD_CLAIM", { kind: "ADD_CLAIM", text: "A claim.", placeAfter: "end", fastMoving: false }, "the claim added is taken out by hand"],
      ["ADD_ROW", { kind: "ADD_ROW", claim: "c", citation: "d", tier: "VENDOR", fastMoving: false }, "the source row added is taken out by hand"],
      ["EDIT_ROW", { kind: "EDIT_ROW", claim: "c" }, "the source row's fields are put back by hand"],
      ["RESTRUCTURE", { kind: "RESTRUCTURE", description: "split the section" }, "the restructure is undone by hand"],
      ["EDIT_TEXT", null, "the original's proposal is not here"],
    ] as const) {
      const reverse = reverseOf("S-21-0005", kind, proposal as never, "text");
      expect(reverse).toEqual({ byHand: true, why, proposal: { kind: "RESTRUCTURE", description: `Revert of S-21-0005: ${why}` } });
      expect(ProposalSchema.safeParse(reverse.proposal).success).toBe(true);
    }
  });

  it("words a revert's commit, and leaves a revert merging where its check failed", () => {
    expect(revertSubjectOf("S-21-0010", "S-21-0001", "21.3")).toBe("S-21-0010: revert S-21-0001 at 21.3");
    expect(returnPathOf("CURATOR")).toEqual([]);
    expect(returnPathOf("HUMAN")).toEqual(["MERGING", "DECIDED"]);
  });
});
