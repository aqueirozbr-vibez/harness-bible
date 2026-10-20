import { describe, expect, it } from "vitest";

import { rateLimitFrom } from "./ratelimit";

describe("rateLimitFrom", () => {
  it("allows while tokens remain and refuses below zero", () => {
    expect(rateLimitFrom(9, 10, 60)).toMatchObject({ allowed: true, limit: 10, remaining: 9, retryAfterS: 0 });
    expect(rateLimitFrom(0.4, 10, 60)).toMatchObject({ allowed: true, remaining: 0 });
    expect(rateLimitFrom(-0.6, 10, 60)).toMatchObject({ allowed: false, remaining: 0 });
    expect(rateLimitFrom(-1, 10, 60).retryAfterS).toBe(12);
    expect(rateLimitFrom(-0.6, 10, 60).retryAfterS).toBe(10);
  });
  it("reports the seconds to a full bucket", () => {
    expect(rateLimitFrom(10, 10, 60).resetS).toBe(0);
    expect(rateLimitFrom(5, 10, 60).resetS).toBe(30);
    expect(rateLimitFrom(0, 120, 60).resetS).toBe(60);
  });
});
