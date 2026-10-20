import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";

import { canonicalize, type JsonValue } from "./canonical";

/** A double from its IEEE-754 bit pattern, as RFC 8785 Appendix B lists its samples. */
function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

function notJson(value: unknown): AppError {
  try {
    canonicalize(value as JsonValue);
  } catch (error) {
    if (error instanceof AppError) return error;
  }
  throw new Error("canonicalize accepted a non-JSON value");
}

describe("canonicalize", () => {
  it("serialises the RFC 8785 § 3.2.3 example byte for byte", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/",
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`);
  });

  it("sorts member names by UTF-16 code unit (RFC 8785 § 3.2.3)", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\u010d": "Latin Small Letter C With Caron",
      "1": "One",
      "\ud83d\ude02": "Face with Tears of Joy",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    const text = canonicalize(input);
    expect(text).toBe(String.raw`{"\r":"Carriage Return","1":"One","` + "\u0080" + String.raw`":"Control","ö":"Latin Small Letter O With Diaeresis","č":"Latin Small Letter C With Caron","€":"Euro Sign","😂":"Face with Tears of Joy"}`);
  });

  it("orders by code unit where code point order differs: a surrogate pair sorts before U+FF01", () => {
    const text = canonicalize({ "\uff01": 2, "\ud83d\ude02": 1 });
    expect(text).toBe('{"\ud83d\ude02":1,"\uff01":2}');
    expect("\ud83d\ude02".codePointAt(0)).toBeGreaterThan("\uff01".codePointAt(0) ?? 0);
  });

  it("serialises numbers in ECMAScript form (RFC 8785 Appendix B samples)", () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ];
    for (const [bits, expected] of samples) expect(canonicalize(fromBits(bits))).toBe(expected);
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(1.0)).toBe("1");
    expect(canonicalize(0.1)).toBe("0.1");
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(100000000000000000000)).toBe("100000000000000000000");
  });

  it("refuses NaN and the infinities, naming the path", () => {
    expect(notJson(fromBits("7fffffffffffffff")).message).toBe("$ is NaN, not a JSON value; a ledger record is hashed as JSON only");
    expect(notJson(fromBits("7ff0000000000000")).code).toBe("LEDGER_NOT_JSON");
    expect(notJson([1, -Infinity]).message).toContain("$[1] is -Infinity");
  });

  it("escapes strings minimally: quote, backslash and controls below U+0020 only, lower-case hex", () => {
    expect(canonicalize("\u0000\u001f\u007f\"\\/")).toBe(String.raw`"\u0000\u001f` + "\u007f" + String.raw`\"\\/"`);
    expect(canonicalize("\b\t\n\f\r")).toBe(String.raw`"\b\t\n\f\r"`);
    expect(canonicalize("ção · 12 set 2026 · ✢")).toBe('"ção · 12 set 2026 · ✢"');
    expect(canonicalize("")).toBe('""');
  });

  it("serialises literals, empty and nested containers without whitespace", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize({ b: [{ z: null, a: [1, "x"] }], a: { " ": false } })).toBe('{"a":{" ":false},"b":[{"a":[1,"x"],"z":null}]}');
  });

  it("accepts an object with no prototype", () => {
    const bare: Record<string, JsonValue> = Object.create(null);
    bare.seq = 1;
    expect(canonicalize(bare)).toBe('{"seq":1}');
  });

  it("refuses undefined, a Date, a bigint, a class instance, a function and a symbol at run time", () => {
    expect(notJson(undefined).message).toContain("$ is undefined");
    expect(notJson({ payload: { total: undefined } }).message).toContain("$.payload.total is undefined");
    expect(notJson(new Date(0)).message).toContain("$ is Date");
    expect(notJson({ createdAt: new Date(0) }).message).toContain("$.createdAt is Date");
    expect(notJson(BigInt(10)).message).toContain("$ is bigint");
    expect(notJson(new Map()).message).toContain("$ is Map");
    expect(notJson(() => 1).message).toContain("$ is function");
    expect(notJson(Object.create(Object.create(null) as object) as object).message).toContain("$ is an object without a constructor");
    expect(notJson(Symbol("s")).message).toContain("$ is symbol");
  });

  it("refuses them at compile time too", () => {
    // @ts-expect-error a Date is not a JsonValue
    expect(() => canonicalize(new Date(0))).toThrow(AppError);
    // @ts-expect-error undefined is not a JsonValue
    expect(() => canonicalize(undefined)).toThrow(AppError);
    // @ts-expect-error a bigint is not a JsonValue
    expect(() => canonicalize(BigInt(1))).toThrow(AppError);
    // @ts-expect-error a member may not be undefined
    expect(() => canonicalize({ seq: undefined })).toThrow(AppError);
  });
});
