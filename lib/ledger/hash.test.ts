import { describe, expect, it } from "vitest";

import { canonicalize } from "./canonical";
import { GENESIS_PREV_HASH, hashable, recordHash, sha256Hex, shortHash, stepKeyOf, type HashableRecord } from "./hash";

const payload = { messageId: "6c1f0b2e-4d9a-4c2b-9e1f-2a7b8c9d0e1f", citations: [{ sectionId: "21.3", figureId: null }], claims: { total: 3, substituted: 0 } };

const record: HashableRecord = {
  seq: 1,
  kind: "ANSWER",
  actor: "u-7f3a9c1e",
  suggestionId: null,
  chapterVersionId: null,
  payload,
  createdAt: new Date("2026-09-23T10:00:00.000Z"),
  prevHash: GENESIS_PREV_HASH,
};

describe("sha256Hex", () => {
  it("is lower-case hex sha256 (FIPS 180-2 vectors)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });
});

describe("GENESIS_PREV_HASH", () => {
  it("is the pinned sha256 of the genesis phrase", () => {
    expect(GENESIS_PREV_HASH).toBe("ebe4996dd2a72beea926ad3070d840f0e5a5e13969ff1a6ee244e48a784a1d7c");
    expect(sha256Hex("harness-bible-ledger-genesis")).toBe(GENESIS_PREV_HASH);
  });
});

describe("hashable", () => {
  it("is exactly the eight fields, nulls kept, createdAt as ISO-8601 UTC with milliseconds", () => {
    const form = hashable(record);
    expect(Object.keys(form).sort()).toEqual(["actor", "chapterVersionId", "createdAt", "kind", "payload", "prevHash", "seq", "suggestionId"]);
    expect(form.createdAt).toBe("2026-09-23T10:00:00.000Z");
    expect(form.suggestionId).toBeNull();
    expect(canonicalize(form)).toBe(
      `{"actor":"u-7f3a9c1e","chapterVersionId":null,"createdAt":"2026-09-23T10:00:00.000Z","kind":"ANSWER","payload":{"citations":[{"figureId":null,"sectionId":"21.3"}],"claims":{"substituted":0,"total":3},"messageId":"6c1f0b2e-4d9a-4c2b-9e1f-2a7b8c9d0e1f"},"prevHash":"${GENESIS_PREV_HASH}","seq":1,"suggestionId":null}`,
    );
  });

  it("keeps a suggestion and chapter version id when set", () => {
    const form = hashable({ ...record, kind: "SUBMITTED", suggestionId: "S-15-0377", chapterVersionId: "cv-21-1.5.0" });
    expect(form.suggestionId).toBe("S-15-0377");
    expect(form.chapterVersionId).toBe("cv-21-1.5.0");
  });
});

describe("recordHash", () => {
  it("is sha256 over the canonical hashed form", () => {
    expect(recordHash(record)).toBe(sha256Hex(canonicalize(hashable(record))));
    expect(recordHash(record)).toMatch(/^[0-9a-f]{64}$/);
    expect(recordHash(record)).toBe(recordHash({ ...record }));
  });

  it("ignores payload key order and changes with any hashed field", () => {
    const reordered = { ...record, payload: { claims: { substituted: 0, total: 3 }, citations: [{ figureId: null, sectionId: "21.3" }], messageId: "6c1f0b2e-4d9a-4c2b-9e1f-2a7b8c9d0e1f" } };
    expect(recordHash(reordered)).toBe(recordHash(record));
    const otherPrev = { ...record, prevHash: sha256Hex("another head") };
    expect(recordHash(otherPrev)).not.toBe(recordHash(record));
    expect(recordHash({ ...record, createdAt: new Date("2026-09-23T10:00:00.001Z") })).not.toBe(recordHash(record));
    expect(recordHash({ ...record, seq: 2 })).not.toBe(recordHash(record));
    expect(recordHash({ ...record, payload: { ...payload, claims: { total: 3, substituted: 1 } } })).not.toBe(recordHash(record));
  });
});

describe("shortHash", () => {
  it("is the first 12 hex characters", () => {
    expect(shortHash("8c21f04e9ab3d4f1e2a3b4c5d6e7f80912345678901234567890abcdef012345")).toBe("8c21f04e9ab3");
    expect(shortHash(GENESIS_PREV_HASH)).toBe(GENESIS_PREV_HASH.slice(0, 12));
  });
});

describe("stepKeyOf", () => {
  it("is the hash of the workflow's id and the step, which the workers and the decision endpoint both look a record up by (28 § 4.4; 36 § 5.1)", () => {
    expect(stepKeyOf("suggestion:S-15-0377", "curator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(sha256Hex("suggestion:S-15-0377:curator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    expect(stepKeyOf("suggestion:S-15-0377", "curator:a")).not.toBe(stepKeyOf("suggestion:S-15-0378", "curator:a"));
  });
});
