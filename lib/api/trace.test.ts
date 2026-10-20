import { describe, expect, it } from "vitest";

import { newSpanId, newTraceId, parseTraceparent, traceparent } from "./trace";

describe("trace context", () => {
  it("parses a valid traceparent and refuses malformed or all-zero ones", () => {
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toEqual({ traceId: "0af7651916cd43dd8448eb211c80319c", parentId: "b7ad6b7169203331" });
    expect(parseTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01")).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent(null)).toBeNull();
  });
  it("makes well-formed ids", () => {
    const t = newTraceId();
    const s = newSpanId();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(s).toMatch(/^[0-9a-f]{16}$/);
    expect(parseTraceparent(traceparent(t, s))).toEqual({ traceId: t, parentId: s });
  });
});
