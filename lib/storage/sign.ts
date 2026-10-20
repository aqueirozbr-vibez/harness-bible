import { jwtVerify, SignJWT } from "jose";

import { ObjectTokenClaimsSchema, type ObjectKey, type ObjectMethod, type ObjectTokenClaims } from "@/lib/schemas/storage";

/*
 * The signature of a URL that reaches an object (feature-specs/32 § 5, § 15): an HS256 token under the store's
 * secret, carrying one key, one method, and for a PUT the type and the size it may carry, for ten minutes. It is
 * the whole credential — the storage routes ask no session — so it is scoped to one object and one thing to do with
 * it, as a bucket's pre-signed URL is (architecture § 5.3). `jose` is the signer the product already has for its
 * sessions; the `typ` names this token so a session's token is never taken for one.
 */

const ALG = "HS256";
const TYP = "hb-object";

const secretBytes = (secretHex: string): Uint8Array => Buffer.from(secretHex, "hex");

export interface ObjectGrant {
  readonly key: ObjectKey;
  readonly method: ObjectMethod;
  /** A PUT's: the one `Content-Type` the body may have, and the most bytes it may carry. Null for a GET. */
  readonly contentType: string | null;
  readonly maxBytes: number | null;
}

export interface SignedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export async function signObjectToken(grant: ObjectGrant, ttlS: number, secretHex: string, now: Date = new Date()): Promise<SignedToken> {
  const issued = Math.floor(now.getTime() / 1000);
  const exp = issued + ttlS;
  const token = await new SignJWT({ key: grant.key, method: grant.method, contentType: grant.contentType, maxBytes: grant.maxBytes })
    .setProtectedHeader({ alg: ALG, typ: TYP })
    .setIssuedAt(issued)
    .setExpirationTime(exp)
    .sign(secretBytes(secretHex));
  return { token, expiresAt: new Date(exp * 1000) };
}

/** The claims of a token that verifies under the secret and has not expired; null for any other token. */
export async function verifyObjectToken(token: string, secretHex: string, now: Date = new Date()): Promise<ObjectTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretBytes(secretHex), { algorithms: [ALG], typ: TYP, currentDate: now });
    const parsed = ObjectTokenClaimsSchema.safeParse({ key: payload["key"], method: payload["method"], contentType: payload["contentType"] ?? null, maxBytes: payload["maxBytes"] ?? null, exp: payload.exp });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
