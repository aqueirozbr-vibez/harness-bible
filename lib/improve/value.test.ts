import { describe, expect, it } from "vitest";

import { DecimalTextSchema } from "@/lib/schemas/improve";

import { decimalOfPrinted, isDecimal, percentChange, printedValue } from "./value";

describe("decimalOfPrinted: the number a figure prints, as a proposal writes it", () => {
  it("drops the currency sign, the grouping and the unit, and keeps the digits the book printed", () => {
    expect(decimalOfPrinted("$0.30")).toBe("0.30");
    expect(decimalOfPrinted("7,500 tokens")).toBe("7500");
    expect(decimalOfPrinted("45%")).toBe("45");
    expect(decimalOfPrinted("1.25×")).toBe("1.25");
    expect(decimalOfPrinted("02")).toBe("02");
    expect(decimalOfPrinted(" 99.5% ")).toBe("99.5");
  });

  it("is a decimal the proposal's schema takes", () => {
    for (const printed of ["$0.30", "7,500 tokens", "45%", "1.25×", "02", "1,433,086"]) {
      const decimal = decimalOfPrinted(printed);
      expect(decimal).not.toBeNull();
      expect(DecimalTextSchema.safeParse(decimal).success).toBe(true);
    }
  });

  it("is null where nothing is printed as a number", () => {
    expect(decimalOfPrinted("three")).toBeNull();
    expect(decimalOfPrinted("")).toBeNull();
  });
});

describe("printedValue: a new number in the figure's own shape", () => {
  it("keeps the sign, the unit and the grouping the figure was printed with", () => {
    expect(printedValue("$0.30", "0.25")).toBe("$0.25");
    expect(printedValue("45%", "50")).toBe("50%");
    expect(printedValue("7,500 tokens", "8000")).toBe("8,000 tokens");
    expect(printedValue("1 s", "2")).toBe("2 s");
    expect(printedValue("02", "5")).toBe("05");
  });

  it("groups a number that grows to four digits, unless the figure had four without commas", () => {
    expect(printedValue("500", "1500")).toBe("1,500");
    expect(printedValue("2026", "2027")).toBe("2027");
  });

  it("prints no negative number and nothing for a value that is not a number", () => {
    expect(printedValue("45%", "-5")).toBeNull();
    expect(printedValue("three", "4")).toBeNull();
  });
});

describe("isDecimal and percentChange: the change the form shows beside the two values", () => {
  it("takes what the proposal's schema takes", () => {
    for (const text of ["0.25", "-3", "1450", " 7 ", "0.30", "x", "1,450", "1.", ".5", ""]) {
      expect(isDecimal(text)).toBe(DecimalTextSchema.safeParse(text).success);
    }
  });

  it("is the change in percent of the value before", () => {
    expect(percentChange("0.30", "0.25")).toBeCloseTo(-16.667, 3);
    expect(percentChange("7500", "8000")).toBeCloseTo(6.667, 3);
    expect(percentChange("45", "45")).toBe(0);
    expect(percentChange("-2", "-1")).toBeCloseTo(50, 6);
  });

  it("is null from zero, or where either side is not a decimal", () => {
    expect(percentChange("0", "5")).toBeNull();
    expect(percentChange("0.30", "")).toBeNull();
    expect(percentChange("0.30", "0.2x")).toBeNull();
    expect(percentChange("three", "4")).toBeNull();
  });
});
