import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { signObjectToken, verifyObjectToken } from "./sign";

/*
 * The signature of a URL that reaches an object (feature-specs/32 § 5, § 15): a token that verifies under the
 * secret carries exactly its grant until it expires; one signed under another secret, altered, expired, of another
 * kind, or carrying a key that is not the product's does not verify.
 */

const SECRET = "0".repeat(63) + "1";
const OTHER = "0".repeat(63) + "2";
const NOW = new Date("2026-10-06T12:00:00Z");
const KEY = "evidence/S-21-0001/4f1c/source";

describe("signObjectToken and verifyObjectToken", () => {
  it("round-trips a PUT grant with its type and size, for the time given", async () => {
    const { token, expiresAt } = await signObjectToken({ key: KEY, method: "PUT", contentType: "application/pdf", maxBytes: 100 }, 600, SECRET, NOW);
    expect(expiresAt.toISOString()).toBe("2026-10-06T12:10:00.000Z");
    expect(token.split(".")).toHaveLength(3);
    expect(await verifyObjectToken(token, SECRET, NOW)).toEqual({ key: KEY, method: "PUT", contentType: "application/pdf", maxBytes: 100, exp: Math.floor(expiresAt.getTime() / 1000) });
    expect(await verifyObjectToken(token, SECRET, new Date("2026-10-06T12:09:59Z"))).not.toBeNull();
  });

  it("round-trips a GET grant, which names no type and no size", async () => {
    const { token } = await signObjectToken({ key: KEY, method: "GET", contentType: null, maxBytes: null }, 600, SECRET, NOW);
    expect(await verifyObjectToken(token, SECRET, NOW)).toMatchObject({ key: KEY, method: "GET", contentType: null, maxBytes: null });
  });

  it("refuses a token past its time, under another secret, altered, or not a token", async () => {
    const { token } = await signObjectToken({ key: KEY, method: "GET", contentType: null, maxBytes: null }, 600, SECRET, NOW);
    expect(await verifyObjectToken(token, SECRET, new Date("2026-10-06T12:10:01Z"))).toBeNull();
    expect(await verifyObjectToken(token, OTHER, NOW)).toBeNull();
    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(await verifyObjectToken(`${header}.${payload}.${signature.slice(0, -2)}xx`, SECRET, NOW)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(payload, "base64url").toString()) as object), method: "PUT" })).toString("base64url");
    expect(await verifyObjectToken(`${header}.${forged}.${signature}`, SECRET, NOW)).toBeNull();
    expect(await verifyObjectToken("not.a.token", SECRET, NOW)).toBeNull();
    expect(await verifyObjectToken("", SECRET, NOW)).toBeNull();
  });

  it("refuses a token of another kind under the same secret, and one whose key is not the product's", async () => {
    const secret = Buffer.from(SECRET, "hex");
    const issued = Math.floor(NOW.getTime() / 1000);
    const session = await new SignJWT({ key: KEY, method: "GET", contentType: null, maxBytes: null }).setProtectedHeader({ alg: "HS256" }).setIssuedAt(issued).setExpirationTime(issued + 600).sign(secret);
    expect(await verifyObjectToken(session, SECRET, NOW)).toBeNull();
    const path = await new SignJWT({ key: "../etc/passwd", method: "GET", contentType: null, maxBytes: null }).setProtectedHeader({ alg: "HS256", typ: "hb-object" }).setIssuedAt(issued).setExpirationTime(issued + 600).sign(secret);
    expect(await verifyObjectToken(path, SECRET, NOW)).toBeNull();
    const method = await new SignJWT({ key: KEY, method: "DELETE", contentType: null, maxBytes: null }).setProtectedHeader({ alg: "HS256", typ: "hb-object" }).setIssuedAt(issued).setExpirationTime(issued + 600).sign(secret);
    expect(await verifyObjectToken(method, SECRET, NOW)).toBeNull();
  });
});
