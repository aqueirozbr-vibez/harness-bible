import { describe, expect, it } from "vitest";

import { THROTTLE, throttleUntil, throttleWindowStart } from "./throttle";

/* The throttle's rule (feature-specs/33 § 7): three declines on unverifiable evidence in thirty days, thirty days' pause. */

const NOW = new Date("2026-10-07T12:00:00.000Z");

describe("the throttle (33 § 7)", () => {
  it("counts the thirty days before now, and pauses for thirty days from now at the third decline, not before", () => {
    expect(THROTTLE).toEqual({ declines: 3, withinDays: 30, forDays: 30 });
    expect(throttleWindowStart(NOW).toISOString()).toBe("2026-09-07T12:00:00.000Z");
    expect(throttleUntil(0, NOW)).toBeNull();
    expect(throttleUntil(2, NOW)).toBeNull();
    expect(throttleUntil(3, NOW)?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
    expect(throttleUntil(4, NOW)?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
  });
});
