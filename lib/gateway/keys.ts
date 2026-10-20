import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { AppError } from "@/lib/errors";

/*
 * Virtual keys at rest (feature-specs/11 § 3.4, D9): AES-256-GCM under GATEWAY_KEY_SECRET, a 32-byte secret the
 * workers hold and the web container does not. The ciphertext is base64 of iv (12 bytes) · tag (16 bytes) ·
 * cipher text; a fresh iv per call, so the same key never encrypts to the same bytes twice. Without the secret
 * the module refuses (`GATEWAY_KEYS_UNAVAILABLE`), which is the web container's case by design (§ 5.1). Not
 * importable by the web tier: the lint rule of § 5.5.
 */

export const KEY_SECRET_HEX = /^[0-9a-f]{64}$/;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The secret as bytes; refuses an absent or malformed one. */
export function keySecret(secret: string | undefined): Buffer {
  if (secret === undefined) {
    throw new AppError("GATEWAY_KEYS_UNAVAILABLE", "GATEWAY_KEY_SECRET is not set: virtual keys are readable by the workers only (feature-specs/11 § 3.4).");
  }
  if (!KEY_SECRET_HEX.test(secret)) {
    throw new AppError("GATEWAY_KEY_SECRET_INVALID", "GATEWAY_KEY_SECRET must be 32 bytes as 64 lower-case hex characters (see .env.example).");
  }
  return Buffer.from(secret, "hex");
}

export function encryptKey(secret: string | undefined, key: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keySecret(secret), iv);
  const body = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** The key, or `GATEWAY_KEY_CIPHERTEXT` when the bytes were not produced under this secret (a wrong secret, a changed row). */
export function decryptKey(secret: string | undefined, ciphertext: string): string {
  const bytes = keySecret(secret);
  const packed = Buffer.from(ciphertext, "base64");
  if (packed.length < IV_BYTES + TAG_BYTES + 1) {
    throw new AppError("GATEWAY_KEY_CIPHERTEXT", "the stored key is not a ciphertext of this module");
  }
  const decipher = createDecipheriv(ALGORITHM, bytes, packed.subarray(0, IV_BYTES));
  decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("GATEWAY_KEY_CIPHERTEXT", "the stored key does not decrypt under GATEWAY_KEY_SECRET: the secret changed or the row was altered; rotate the key");
  }
}
