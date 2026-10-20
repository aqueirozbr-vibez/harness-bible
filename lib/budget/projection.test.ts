import { describe, expect, it } from "vitest";

import { daysInMonth, projection } from "./projection";

/* The projection of the budget meter (feature-specs/21 § 4.1, § 13.3), checked against the screen's own numbers. */

const at = (iso: string) => new Date(iso);

describe("projection", () => {
  it("reads the screen's numbers: 1.84 M on 21 Sep of a 2.50 M cap is 0.088 M a day and the cap on 29 Sep", () => {
    const result = projection(1_840_000, 2_500_000, at("2026-09-21T15:00:00Z"));
    expect((result.perDay / 1_000_000).toFixed(3)).toBe("0.088");
    expect(result.capDate?.toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });

  it("gives no date when the pace does not reach the cap inside the month", () => {
    const result = projection(300_000, 2_500_000, at("2026-09-21T15:00:00Z"));
    expect(result.perDay).toBeCloseTo(14_285.71, 1);
    expect(result.capDate).toBeNull();
  });

  it("divides by one on the first of the month, and by the day of the month after", () => {
    expect(projection(50_000, 1_000_000, at("2026-10-01T00:00:01Z"))).toEqual({ perDay: 50_000, capDate: new Date("2026-10-20T00:00:00Z") });
    expect(projection(50_000, 1_000_000, at("2026-10-02T23:59:59Z")).perDay).toBe(25_000);
  });

  it("lands on the day itself when the pace reaches the cap exactly, the last day of the month included", () => {
    expect(projection(1_000_000, 3_000_000, at("2026-09-10T12:00:00Z")).capDate?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(projection(1_000_000, 3_100_000, at("2026-09-10T12:00:00Z")).capDate).toBeNull();
    expect(projection(1_000_000, 3_100_000, at("2026-10-10T12:00:00Z")).capDate?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });

  it("has no pace and no date with nothing spent or no cap to reach", () => {
    expect(projection(0, 2_500_000, at("2026-09-21T15:00:00Z"))).toEqual({ perDay: 0, capDate: null });
    expect(projection(100, 0, at("2026-09-21T15:00:00Z"))).toEqual({ perDay: 0, capDate: null });
  });

  it("reads the month in UTC, as the gateway's window does", () => {
    /* 23:30 on 30 Sep in São Paulo is already 1 Oct in UTC: the first day of a new window. */
    expect(projection(40_000, 1_000_000, at("2026-10-01T02:30:00Z")).perDay).toBe(40_000);
    expect(daysInMonth(at("2028-02-10T00:00:00Z"))).toBe(29);
    expect(daysInMonth(at("2026-02-10T00:00:00Z"))).toBe(28);
  });
});
