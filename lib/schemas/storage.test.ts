import { describe, expect, it } from "vitest";

import { evidenceSourceKey, evidenceTextKey, ObjectKeySchema, SIGNED_URL_TTL_S, suggestionOfKey, UPLOAD_SIZE_MAX, UPLOAD_TYPES, UploadTicketSchema } from "./storage";

/*
 * Object storage's vocabulary (feature-specs/32 § 5, § 15): a key is the product's own and never a path, the upload
 * types are § 4.3's without HTML, and the two numbers are the ones decided.
 */

describe("ObjectKeySchema", () => {
  it("accepts the product's keys", () => {
    for (const key of ["evidence/S-21-0001/4f1c9a2e-0000-4000-8000-000000000000/source", "evidence/S-21-0001/4f1c/text", "audit/exp-2026-10-06.jsonl", "evidence/a/b/c/d/e"]) {
      expect(ObjectKeySchema.safeParse(key).success, key).toBe(true);
    }
  });

  it("refuses a path a person could have written", () => {
    for (const key of ["", "evidence", "evidence/", "/evidence/x", "uploads/x", "evidence/../etc/passwd", "evidence/./x", "evidence/x/..", "evidence/a b", "evidence/x\\y", "evidence/a/b/c/d/e/f", "EVIDENCE/x", `evidence/${"a".repeat(200)}`, "evidence/x?y=1", "evidence/x#y", "evidence//x"]) {
      expect(ObjectKeySchema.safeParse(key).success, key).toBe(false);
    }
  });

  it("builds the evidence keys and reads the suggestion back from them", () => {
    expect(evidenceSourceKey("S-21-0001", "4f1c")).toBe("evidence/S-21-0001/4f1c/source");
    expect(evidenceTextKey("S-21-0001", "4f1c")).toBe("evidence/S-21-0001/4f1c/text");
    expect(suggestionOfKey("evidence/S-21-0001/4f1c/source")).toBe("S-21-0001");
    expect(suggestionOfKey("audit/x.jsonl")).toBeNull();
    expect(suggestionOfKey("evidence/not-an-id/x/source")).toBeNull();
  });
});

describe("the numbers and the types", () => {
  it("hold Andre's upload limit of 100 MB and the architecture's ten minutes", () => {
    expect(UPLOAD_SIZE_MAX).toBe(100 * 1024 * 1024);
    expect(SIGNED_URL_TTL_S).toBe(600);
  });

  it("lists the types of § 4.3 that are not HTML", () => {
    expect([...UPLOAD_TYPES]).toEqual(["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg"]);
  });

  it("describes a ticket", () => {
    const ticket = { uploadKey: "evidence/S-21-0001/4f1c/source", url: "http://localhost:3000/api/v1/storage/abc.def.ghi", method: "PUT", headers: { "content-type": "application/pdf" }, maxBytes: UPLOAD_SIZE_MAX, expiresAt: "2026-10-06T12:10:00.000Z" };
    expect(UploadTicketSchema.safeParse(ticket).success).toBe(true);
    expect(UploadTicketSchema.safeParse({ ...ticket, headers: { "content-type": "text/html" } }).success).toBe(false);
    expect(UploadTicketSchema.safeParse({ ...ticket, method: "POST" }).success).toBe(false);
  });
});
