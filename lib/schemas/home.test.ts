import { describe, expect, it } from "vitest";

import { HomeDataSchema, type HomeDataInput } from "./home";

type TileInput = HomeDataInput["parts"][number]["chapters"][number];

const tile = (n: number, over: Partial<TileInput> = {}): TileInput => ({
  number: n,
  title: `Chapter ${n}`,
  version: "v1.0.0",
  daysSinceVerify: 1,
  verify: "PASSED",
  redteam: "PASSED",
  redteamOpen: 0,
  lab: { kind: "reproduced" },
  staleDays: null,
  current: null,
  href: `/en/ch/${String(n).padStart(2, "0")}`,
  ...over,
});

/* Dates arrive as ISO strings from the release cache (feature-specs/04 D18). */
const input = (): HomeDataInput => ({
  release: { id: "2026.09", gitSha: "e8e9d1730630b2cf1615ef7eb0cdf7d64b33a4e2", publishedAt: "2026-09-22T12:00:00.000Z", nightlyCheckAt: null },
  status: { chapters: 2, verifyPassed: 2, labs: 1, labsReproduced: 1, labsDiverging: [], stale: [{ chapter: 15, days: 97 }], redteamOpen: [] },
  parts: [{ key: "P1", chapters: [tile(15, { staleDays: 97 }), tile(16, { lab: { kind: "no_lab", carries: "prose" } })], labCount: 1, curators: [], glance: null }],
  continueReading: null,
  sourceLang: "EN",
});

describe("HomeData", () => {
  it("coerces ISO dates and keeps the rest", () => {
    const data = HomeDataSchema.parse(input());
    expect(data.release.publishedAt).toBeInstanceOf(Date);
    expect(data.release.publishedAt.toISOString()).toBe("2026-09-22T12:00:00.000Z");
    expect(data.parts[0].chapters[1].lab).toEqual({ kind: "no_lab", carries: "prose" });
  });

  it("rejects a stale age at or under 90 days", () => {
    const broken = { ...input(), status: { ...input().status, stale: [{ chapter: 15, days: 90 }] } };
    expect(() => HomeDataSchema.parse(broken)).toThrow();
  });

  it("rejects an unknown lab state and a short git sha", () => {
    const badLab = input();
    expect(() => HomeDataSchema.parse({ ...badLab, parts: [{ ...badLab.parts[0], chapters: [tile(1, { lab: { kind: "running" } as unknown as TileInput["lab"] })] }] })).toThrow();
    expect(() => HomeDataSchema.parse({ ...badLab, release: { ...badLab.release, gitSha: "7f3a" } })).toThrow();
  });
});
