import { describe, expect, it } from "vitest";

import { endorserOf, standingEndorsementOf } from "./endorsement";

const KEY = "a".repeat(64);
const AT = "2026-10-10T12:00:00.000Z";
const endorsed = (withdrawn: boolean, actor = "user:11111111-1111-4111-8111-111111111111") => ({ kind: "ENDORSED", actor, payload: { stepKey: KEY, consentAt: AT, withdrawn } });

describe("endorserOf", () => {
  it("names the reader of the latest endorsement, nobody after a withdrawal, nobody with no record, and nobody for a record it cannot read", () => {
    expect(endorserOf([{ kind: "SUBMITTED", actor: "service:researcher", payload: {} }])).toBeNull();
    expect(endorserOf([endorsed(false)])).toBe("user:11111111-1111-4111-8111-111111111111");
    expect(endorserOf([endorsed(false), endorsed(true)])).toBeNull();
    expect(endorserOf([endorsed(false), endorsed(true), endorsed(false)])).toBe("user:11111111-1111-4111-8111-111111111111");
    expect(endorserOf([{ kind: "ENDORSED", actor: "user:11111111-1111-4111-8111-111111111111", payload: { withdrawn: "no" } }])).toBeNull();
    expect(endorserOf([endorsed(false, "service:researcher")])).toBeNull();
  });

  it("gives the standing name's instant, which a withdrawal must name to take it back (unit 59's review)", () => {
    expect(standingEndorsementOf([endorsed(false)])).toEqual({ actor: "user:11111111-1111-4111-8111-111111111111", consentAt: AT });
    expect(standingEndorsementOf([endorsed(false), endorsed(true)])).toBeNull();
    expect(standingEndorsementOf([])).toBeNull();
  });
});
