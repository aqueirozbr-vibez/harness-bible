import { describe, expect, it } from "vitest";

import type { LedgerRecord } from "@/lib/db/generated/client";

import { hashLine, ledgerLine } from "./display";

/*
 * The record line the screens print (feature-specs/14 § 6): the Assistant-
 * Answer footer `hash 8c21f04e9ab3 · prev 3f7a91c2d0e5`, the record page's
 * `prev b18e44f02d97 · hash 9b41d2e07a3c`.
 */

const AT = new Date("2026-09-23T14:35:00.123Z");

describe("ledgerLine", () => {
  it("takes the first 12 hex characters of both hashes and carries seq, kind and createdAt unchanged", () => {
    const line = ledgerLine({ seq: 83, kind: "ANSWER", hash: "8c21f04e9ab3".padEnd(64, "7"), prevHash: "3f7a91c2d0e5".padEnd(64, "7"), createdAt: AT });
    expect(line).toEqual({ short: "8c21f04e9ab3", prevShort: "3f7a91c2d0e5", seq: 83, kind: "ANSWER", createdAt: AT });
  });

  it("reads a database row as it is", () => {
    const row: LedgerRecord = { seq: 10, kind: "EXPORT", actor: "service:export", suggestionId: null, chapterVersionId: null, payload: {}, createdAt: AT, prevHash: "b18e44f02d97".padEnd(64, "0"), hash: "9b41d2e07a3c".padEnd(64, "0") };
    expect(ledgerLine(row)).toEqual({ short: "9b41d2e07a3c", prevShort: "b18e44f02d97", seq: 10, kind: "EXPORT", createdAt: AT });
  });
});

describe("hashLine", () => {
  it("is a hash alone in the same 12-character form: a chain's head (35 § 5)", () => {
    expect(hashLine("3c07e9a14b52".padEnd(64, "f"))).toBe("3c07e9a14b52");
  });
});
