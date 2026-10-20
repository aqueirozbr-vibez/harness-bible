import { describe, expect, it } from "vitest";

import { uploadMaxOf } from "@/lib/improve/media";

import { formatDayMonth, formatDuration, formatKappa, formatMegabytes, formatMillions, formatMonthYear, formatPercent } from "./format";

/* The budget meter's formats (feature-specs/21 § 4.2; ui-context § 11, § 13.5), in the screen's own numbers. */

describe("the budget meter's formats", () => {
  it("prints tokens in millions to two decimals, three for the pace, and nothing as 0", () => {
    expect(formatMillions(1_840_000, "en")).toBe("1.84 M");
    expect(formatMillions(2_500_000, "en")).toBe("2.50 M");
    expect(formatMillions(660_000, "pt")).toBe("0,66 M");
    expect(formatMillions(87_619.05, "en", 3)).toBe("0.088 M");
    expect(formatMillions(87_619.05, "pt", 3)).toBe("0,088 M");
    expect(formatMillions(0, "en")).toBe("0");
    expect(formatMillions(1_433_086_000, "en")).toBe("1,433.09 M");
  });

  it("prints a percentage to one decimal in the locale's form", () => {
    expect(formatPercent(73.60000000000001, "en")).toBe("73.6");
    expect(formatPercent(73.6, "pt")).toBe("73,6");
    expect(formatPercent(0, "en")).toBe("0.0");
    expect(formatPercent(100, "pt")).toBe("100,0");
  });

  it("prints κ to two decimals in the locale's form (36 § 6.4)", () => {
    expect(formatKappa(0.6797, "en")).toBe("0.68");
    expect(formatKappa(0.7, "pt")).toBe("0,70");
    expect(formatKappa(-0.25, "en")).toBe("-0.25");
  });

  it("names the month in lower case and the reset as a day and month, in UTC", () => {
    expect(formatMonthYear(new Date("2026-09-01T00:00:00Z"), "en")).toBe("september 2026");
    expect(formatMonthYear(new Date("2026-09-01T00:00:00Z"), "pt")).toBe("setembro 2026");
    expect(formatDayMonth(new Date("2026-10-01T00:00:00Z"), "en")).toBe("01 Oct");
    expect(formatDayMonth(new Date("2026-10-01T00:00:00Z"), "pt")).toBe("01 out");
  });
});

describe("the upload form's sizes (feature-specs/34 § 5)", () => {
  it("words each type's most in MB of 1024 × 1024 bytes, as D2 counts its 100 MB, to one decimal rounded down", () => {
    expect(formatMegabytes(uploadMaxOf("text/plain"), "en")).toBe("100 MB");
    expect(formatMegabytes(uploadMaxOf("application/pdf"), "en")).toBe("22.8 MB");
    expect(formatMegabytes(uploadMaxOf("image/png"), "en")).toBe("7.1 MB");
    expect(formatMegabytes(uploadMaxOf("image/jpeg"), "pt")).toBe("7,1 MB");
    expect(formatMegabytes(1024 * 1024 * 1.25, "pt")).toBe("1,2 MB");
    /* A file under the number shown is under the limit. */
    for (const type of ["application/pdf", "image/png", "text/plain"] as const) expect(Number.parseFloat(formatMegabytes(uploadMaxOf(type), "en")) * 1024 * 1024).toBeLessThanOrEqual(uploadMaxOf(type));
  });
});

describe("a research run's duration (feature-specs/48 § 11.3)", () => {
  it("prints whole seconds, minutes and seconds, or hours and minutes, the larger unit only where it is not zero", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(14_999)).toBe("14 s");
    expect(formatDuration(134_000)).toBe("2 min 14 s");
    expect(formatDuration(60_000)).toBe("1 min 0 s");
    expect(formatDuration(3_780_000)).toBe("1 h 3 min");
    /* a clock that ran backwards between two machines is no time at all */
    expect(formatDuration(-5_000)).toBe("0 s");
  });
});
