import type { Readable } from "node:stream";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { SIGNED_URL_TTL_S, type ObjectKey, type ObjectTokenClaims, type StoredObject } from "@/lib/schemas/storage";

import { localStore, type ObjectBody, type ObjectStore } from "./local";
import { signObjectToken, verifyObjectToken } from "./sign";

/*
 * The storage client (feature-specs/32 § 5): `putObject`, `getObject`, `signedPutUrl`, `signedGetUrl`, the four
 * names the spec gives, over the directory store of local.ts and the signatures of sign.ts. A signed URL points at
 * the app's own storage routes (`/api/v1/storage/{token}`), which verify the token and read or write the store:
 * with a directory and no bucket, the web tier is the store's front, and an upload does pass through it
 * (32 § 15 records the deviation). Without `OBJECT_STORE_SECRET` every signature is refused as
 * `STORAGE_UNAVAILABLE`, the way a missing gateway refuses a model call.
 */

export type { ObjectBody, ObjectStore } from "./local";
export { ObjectTooLargeError } from "./local";

export interface StorageConfig {
  readonly dir: string;
  readonly secret: string | null;
  readonly baseUrl: string;
}

export const storageConfig = (): StorageConfig => ({ dir: env.OBJECT_STORE_DIR, secret: env.OBJECT_STORE_SECRET ?? null, baseUrl: env.APP_URL });

export const storageAvailable = (config: StorageConfig = storageConfig()): boolean => config.secret !== null;

let store: ObjectStore | null = null;

/** The process's store, on the configured directory. */
export function objectStore(config: StorageConfig = storageConfig()): ObjectStore {
  store ??= localStore(config.dir);
  return store;
}

function requireSecret(config: StorageConfig): string {
  if (config.secret === null) throw new AppError("STORAGE_UNAVAILABLE", "OBJECT_STORE_SECRET is not set: nothing can be signed (feature-specs/32 § 5; see .env.example).");
  return config.secret;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export const putObject = (key: ObjectKey, body: Readable | Uint8Array, contentType: string, maxBytes?: number): Promise<StoredObject> => objectStore().put(key, body, contentType, maxBytes);
export const getObject = (key: ObjectKey): Promise<ObjectBody | null> => objectStore().get(key);
export const headObject = (key: ObjectKey): Promise<StoredObject | null> => objectStore().head(key);
/** Every object under a prefix removed (feature-specs/45 § 4): a deleted draft's, or one item's of a draft. */
export const removeObjectsUnder = (prefix: ObjectKey): Promise<boolean> => objectStore().removeUnder(prefix);

const urlOf = (config: StorageConfig, token: string): string => `${config.baseUrl.replace(/\/$/, "")}/api/v1/storage/${token}`;

/**
 * A URL that accepts PUTs of one type up to `maxBytes` under one key for `ttlS` seconds: not one PUT, since a later
 * one replaces the object, which is why storeText checks the source against the hash fetchItem recorded (unit 49f).
 */
export async function signedPutUrl(key: ObjectKey, grant: { readonly contentType: string; readonly maxBytes: number }, ttlS: number = SIGNED_URL_TTL_S, config: StorageConfig = storageConfig(), now: Date = new Date()): Promise<SignedUrl> {
  const signed = await signObjectToken({ key, method: "PUT", contentType: grant.contentType, maxBytes: grant.maxBytes }, ttlS, requireSecret(config), now);
  return { url: urlOf(config, signed.token), expiresAt: signed.expiresAt };
}

/** A URL that serves one object, for `ttlS` seconds. */
export async function signedGetUrl(key: ObjectKey, ttlS: number = SIGNED_URL_TTL_S, config: StorageConfig = storageConfig(), now: Date = new Date()): Promise<SignedUrl> {
  const signed = await signObjectToken({ key, method: "GET", contentType: null, maxBytes: null }, ttlS, requireSecret(config), now);
  return { url: urlOf(config, signed.token), expiresAt: signed.expiresAt };
}

/** The claims of a storage route's token, or null when it does not verify; `STORAGE_UNAVAILABLE` without a secret. */
export const verifySignedToken = (token: string, config: StorageConfig = storageConfig(), now: Date = new Date()): Promise<ObjectTokenClaims | null> => verifyObjectToken(token, requireSecret(config), now);
