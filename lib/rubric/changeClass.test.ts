import { describe, expect, it } from "vitest";

import { SourceTierSchema } from "@/lib/schemas/domain";
import { ANCHOR_KINDS, CHANGE_KINDS } from "@/lib/schemas/improve";
import { WORKED_EXAMPLES } from "@/tests/fixtures/rubric";

import { ANCHOR_OF_CHANGE_KIND, classOf, type ClassAnchor, type ClassProposal } from "./changeClass";

/*
 * The class of a change (feature-specs/30 § 4.2, § 10.3): every row of the table has a case, in its order, and the
 * order itself is tested where two rows would both match. The four worked examples fall in the classes their
 * screens print.
 */

const section = (text = "The agent retries the call three times before it gives up."): ClassAnchor => ({ kind: "SECTION", figure: null, text });
const figure = (tier: "DERIVED" | "ANALYST" | "VENDOR" = "ANALYST", scenarioParam = false, text = "cached-input price $0.30 per M tokens"): ClassAnchor => ({ kind: "FIGURE", figure: { tier, scenarioParam }, text });
const row = (text = "r12 · cached-input price · provider tier 2 pricing page"): ClassAnchor => ({ kind: "SOURCE_ROW", figure: null, text });
const proposal = (text = "The agent retries the call four times before it gives up.", sourceTier: string | null = null): ClassProposal => ({ text, sourceTier });

const OT_PASSAGE = "Force the transmitter to its last good value and bypass the interlock while the batch runs.";
const OT_PROPOSAL = "When the historian lags, write the setpoint to the PLC directly.";

describe("the anchor of each kind of change (30 § 4.1)", () => {
  it("names one anchor kind per change kind, and every change kind", () => {
    expect(Object.keys(ANCHOR_OF_CHANGE_KIND)).toEqual([...CHANGE_KINDS]);
    for (const kind of Object.values(ANCHOR_OF_CHANGE_KIND)) expect(ANCHOR_KINDS).toContain(kind);
    expect(ANCHOR_OF_CHANGE_KIND).toEqual({ EDIT_TEXT: "SECTION", SET_VALUE: "FIGURE", EDIT_ROW: "SOURCE_ROW", ADD_CLAIM: "SECTION", ADD_ROW: "SECTION", RESTRUCTURE: "SECTION" });
  });
});

describe("classOf: the rows of 30 § 4.2, in order", () => {
  it("1 · a restructure is the curator's, for its structure", () => {
    expect(classOf(section(), "RESTRUCTURE", proposal("Split 21.3 at the second heading."))).toEqual({ changeClass: "CURATOR_ALWAYS", curatorReason: "STRUCTURE", rule: 1 });
  });

  it("2 · a figure that is a scenario parameter is the curator's, whatever its tier", () => {
    expect(classOf(figure("ANALYST", true), "SET_VALUE", proposal("$0.25"))).toEqual({ changeClass: "CURATOR_ALWAYS", curatorReason: "SCENARIO_PARAMETER", rule: 2 });
    expect(classOf(figure("DERIVED", true), "SET_VALUE", proposal("$0.25"))).toEqual({ changeClass: "CURATOR_ALWAYS", curatorReason: "SCENARIO_PARAMETER", rule: 2 });
  });

  it("3 · a text edit whose passage or whose proposal is about operating equipment is the curator's", () => {
    expect(classOf(section(OT_PASSAGE), "EDIT_TEXT", proposal("Keep the transmitter at its last good value."))).toEqual({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", rule: 3 });
    expect(classOf(section(), "EDIT_TEXT", proposal(OT_PROPOSAL))).toEqual({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", rule: 3 });
    expect(classOf(section(), "ADD_CLAIM", proposal(OT_PROPOSAL))).toEqual({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", rule: 3 });
    /* Either text alone: "set the budget" and "start the run" are ordinary English about software. */
    expect(classOf(section("Set the budget for the run."), "EDIT_TEXT", proposal("Start the run from the dashboard.")).rule).toBe(8);
  });

  it("4 · a proposed row that names a source tier the book has not is the curator's", () => {
    expect(classOf(section(), "ADD_ROW", proposal("A regulator's guidance on model cards.", "REGULATOR"))).toEqual({ changeClass: "CURATOR_ALWAYS", curatorReason: "NEW_SOURCE_TIER", rule: 4 });
    expect(classOf(section(), "ADD_ROW", proposal("A vendor's page.", "vendor")).rule, "the book's tiers are spelled as the book spells them").toBe(4);
    for (const tier of SourceTierSchema.options) expect(classOf(section(), "ADD_ROW", proposal("A row.", tier)).rule, tier).toBe(7);
  });

  it("5 · a value set on a derived figure", () => {
    expect(classOf(figure("DERIVED", false, "repair cap 3"), "SET_VALUE", proposal("4"))).toEqual({ changeClass: "DERIVED_FIGURE", curatorReason: null, rule: 5 });
  });

  it("6 · a value set on any other figure, and a row edited", () => {
    expect(classOf(figure("ANALYST"), "SET_VALUE", proposal("1.3×"))).toEqual({ changeClass: "CITED_FIGURE", curatorReason: null, rule: 6 });
    expect(classOf(figure("VENDOR"), "SET_VALUE", proposal("$0.25"))).toEqual({ changeClass: "CITED_FIGURE", curatorReason: null, rule: 6 });
    expect(classOf(row(), "EDIT_ROW", proposal("cached-input price $0.25 per M tokens"))).toEqual({ changeClass: "CITED_FIGURE", curatorReason: null, rule: 6 });
    /* A value set with no figure row is a pairing the schema sensor refuses; here it is a cited figure, not a derived one. */
    expect(classOf(section(), "SET_VALUE", proposal("4")).rule).toBe(6);
  });

  it("7 · a claim or a row added", () => {
    expect(classOf(section(), "ADD_CLAIM", proposal("Retries are capped at four since the 2026.09 release."))).toEqual({ changeClass: "NEW_CLAIM", curatorReason: null, rule: 7 });
    expect(classOf(section(), "ADD_ROW", proposal("A paper on retry budgets.", "PRIMARY"))).toEqual({ changeClass: "NEW_CLAIM", curatorReason: null, rule: 7 });
  });

  it("8 · a passage edited", () => {
    expect(classOf(section(), "EDIT_TEXT", proposal())).toEqual({ changeClass: "WORDING", curatorReason: null, rule: 8 });
  });

  it("first match wins: a restructure about equipment is its structure's, an equipment text with a new tier is the equipment's, a derived scenario parameter is the parameter's", () => {
    expect(classOf(section(OT_PASSAGE), "RESTRUCTURE", proposal(OT_PROPOSAL, "REGULATOR")).curatorReason).toBe("STRUCTURE");
    expect(classOf(figure("DERIVED", true, OT_PASSAGE), "SET_VALUE", proposal("4")).curatorReason).toBe("SCENARIO_PARAMETER");
    expect(classOf(section(), "ADD_ROW", proposal(OT_PROPOSAL, "REGULATOR")).curatorReason).toBe("SAFETY_OT");
    expect(classOf(figure("DERIVED"), "SET_VALUE", proposal(OT_PROPOSAL)).curatorReason).toBe("SAFETY_OT");
  });

  it("gives a curator's reason to the curator's class and to no other", () => {
    for (const changeKind of CHANGE_KINDS) {
      for (const anchor of [section(), figure("DERIVED"), figure("ANALYST", true), row()]) {
        const classified = classOf(anchor, changeKind, proposal());
        expect(classified.curatorReason !== null, `${changeKind} on ${anchor.kind}`).toBe(classified.changeClass === "CURATOR_ALWAYS");
      }
    }
  });

  it("puts the four worked examples in the classes their screens print", () => {
    for (const example of WORKED_EXAMPLES) {
      expect(classOf(example.anchor, example.changeKind, example.proposal).changeClass, example.id).toBe(example.changeClass);
    }
  });
});
