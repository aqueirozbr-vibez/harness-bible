import { describe, expect, it } from "vitest";

import { canonicalJson, contentHash, renderHash, sha256, treeHash, withoutRunTimestamp } from "./renderHash";

describe("withoutRunTimestamp", () => {
  it("drops the lab runner's timestamp and nothing else, so a re-run with the same values keeps the hash", () => {
    const a = { timestamp: "2026-09-22T00:17:36+00:00", p_no_failure: 0.878, nested: { x: 1 } };
    const b = { timestamp: "2026-09-23T11:00:11+00:00", p_no_failure: 0.878, nested: { x: 1 } };
    expect(withoutRunTimestamp(a)).toEqual({ p_no_failure: 0.878, nested: { x: 1 } });
    expect(contentHash({ derived: withoutRunTimestamp(a) })).toBe(contentHash({ derived: withoutRunTimestamp(b) }));
    expect(contentHash({ derived: a })).not.toBe(contentHash({ derived: b }));
    expect(withoutRunTimestamp({})).toEqual({});
  });
});

describe("hashes", () => {
  it("canonicalises key order, drops undefined and writes dates as ISO strings", () => {
    const a = canonicalJson({ b: 1, a: [{ d: new Date(Date.UTC(2026, 8, 22)), c: "x", u: undefined }] });
    const b = canonicalJson({ a: [{ c: "x", d: new Date(Date.UTC(2026, 8, 22)) }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[{"c":"x","d":"2026-09-22T00:00:00.000Z"}],"b":1}');
  });

  it("is stable across runs and sensitive to one character", () => {
    const rows = { sections: [{ id: "21.3", html: "<p>45%</p>" }] };
    expect(contentHash(rows)).toBe(contentHash({ sections: [{ html: "<p>45%</p>", id: "21.3" }] }));
    expect(contentHash(rows)).not.toBe(contentHash({ sections: [{ id: "21.3", html: "<p>46%</p>" }] }));
    expect(contentHash(rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders chapters by number before hashing the release", () => {
    const h1 = renderHash([{ number: 28, hash: "b" }, { number: 21, hash: "a" }], "2026.09");
    const h2 = renderHash([{ number: 21, hash: "a" }, { number: 28, hash: "b" }], "2026.09");
    expect(h1).toBe(h2);
    expect(h1).toBe(sha256("a\nb\n2026.09"));
    expect(renderHash([{ number: 21, hash: "a" }], "2026.10")).not.toBe(renderHash([{ number: 21, hash: "a" }], "2026.09"));
  });

  it("tree-hashes files by path, independent of order (D13)", () => {
    const files = [{ path: "book/part2/ch21.md", content: "x" }, { path: "labs/ch21/derive.py", content: "y" }];
    expect(treeHash(files)).toBe(treeHash([...files].reverse()));
    expect(treeHash(files)).toMatch(/^[0-9a-f]{40}$/);
    expect(treeHash(files)).not.toBe(treeHash([{ path: "book/part2/ch21.md", content: "x!" }, files[1]]));
  });
});
