import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";

import { decryptKey, encryptKey, keySecret } from "./keys";

const SECRET = "0123456789abcdef".repeat(4);
const OTHER = "fedcba9876543210".repeat(4);
const KEY = "sk-3f2a9c1e7b4d5a6c8e0f1a2b3c4d5e6f";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("did not throw");
}

describe("virtual keys at rest (feature-specs/11 § 3.4)", () => {
  it("round-trips a key under the secret", () => {
    expect(decryptKey(SECRET, encryptKey(SECRET, KEY))).toBe(KEY);
  });

  it("produces a different ciphertext on every call", () => {
    const a = encryptKey(SECRET, KEY);
    const b = encryptKey(SECRET, KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain(KEY);
    expect(decryptKey(SECRET, a)).toBe(KEY);
    expect(decryptKey(SECRET, b)).toBe(KEY);
  });

  it("fails under the wrong secret and on an altered ciphertext", () => {
    const ciphertext = encryptKey(SECRET, KEY);
    expect(codeOf(() => decryptKey(OTHER, ciphertext))).toBe("GATEWAY_KEY_CIPHERTEXT");
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] ^= 0x01;
    expect(codeOf(() => decryptKey(SECRET, bytes.toString("base64")))).toBe("GATEWAY_KEY_CIPHERTEXT");
    expect(codeOf(() => decryptKey(SECRET, "AAAA"))).toBe("GATEWAY_KEY_CIPHERTEXT");
  });

  it("refuses without the secret, which is the web container's case, and refuses a malformed one", () => {
    expect(codeOf(() => keySecret(undefined))).toBe("GATEWAY_KEYS_UNAVAILABLE");
    expect(codeOf(() => encryptKey(undefined, KEY))).toBe("GATEWAY_KEYS_UNAVAILABLE");
    expect(codeOf(() => decryptKey(undefined, encryptKey(SECRET, KEY)))).toBe("GATEWAY_KEYS_UNAVAILABLE");
    expect(codeOf(() => keySecret("too-short"))).toBe("GATEWAY_KEY_SECRET_INVALID");
    expect(codeOf(() => keySecret(SECRET.toUpperCase()))).toBe("GATEWAY_KEY_SECRET_INVALID");
    expect(keySecret(SECRET)).toHaveLength(32);
  });
});
