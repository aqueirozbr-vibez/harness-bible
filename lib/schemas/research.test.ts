import { describe, expect, it } from "vitest";

import { FINDING_FAILURES, sendsMonthOf } from "./research";

/*
 * The month a person's sends to Improve are counted in (feature-specs/48 § 8.3, D5): the calendar month in UTC, its key
 * the month's row in `ResearchSendMonth` is kept under, and its reset. Moved here from lib/research/submission.ts in unit
 * 74's review, so the page's line and the send's transaction compute one month.
 */

describe("the month a person's sends are counted in (48 D5)", () => {
  it("is the calendar month in UTC, resetting at the first instant of the next, December into January", () => {
    expect(sendsMonthOf(new Date("2026-10-12T15:00:00.000Z"))).toEqual({ month: "2026-10", since: new Date("2026-10-01T00:00:00.000Z"), resetsAt: new Date("2026-11-01T00:00:00.000Z") });
    expect(sendsMonthOf(new Date("2026-12-31T23:59:59.999Z"))).toEqual({ month: "2026-12", since: new Date("2026-12-01T00:00:00.000Z"), resetsAt: new Date("2027-01-01T00:00:00.000Z") });
    expect(sendsMonthOf(new Date("2027-01-01T00:00:00.000Z")).month).toBe("2027-01");
    /* 21:30 on the 31st in São Paulo is already the next month in UTC */
    const lateInSaoPaulo = sendsMonthOf(new Date("2026-10-31T21:30:00.000-03:00"));
    expect(lateInSaoPaulo).toEqual({ month: "2026-11", since: new Date("2026-11-01T00:00:00.000Z"), resetsAt: new Date("2026-12-01T00:00:00.000Z") });
    /* and 21:30 on the 30th there is still October */
    expect(sendsMonthOf(new Date("2026-10-30T21:30:00.000-03:00")).month).toBe("2026-10");
  });

  it("names the month as the counter's check holds it, and the code a send at the thirtieth ends with", () => {
    for (const at of ["2026-01-15T00:00:00.000Z", "2026-09-30T23:59:59.999Z", "2099-12-01T00:00:00.000Z"]) expect(sendsMonthOf(new Date(at)).month).toMatch(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
    expect(FINDING_FAILURES).toContain("SENDS_LIMIT");
  });
});
