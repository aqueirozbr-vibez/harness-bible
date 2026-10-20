import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { PolicyResource } from "@/lib/policy/input";
import { ObjectTokenParamsSchema, StoredObjectSchema, type ObjectMethod, type ObjectTokenClaims, type StoredObject } from "@/lib/schemas/storage";
import { objectStore, ObjectTooLargeError, verifySignedToken, type ObjectStore } from "@/lib/storage";

/*
 * The storage routes (feature-specs/32 § 5, § 15): `PUT /api/v1/storage/{token}` takes the bytes a signed URL
 * allows, `GET` serves the object a signed URL names. With a directory for a store and no bucket, these are what a
 * bucket's pre-signed URLs would be: the token is the whole credential — one key, one method, for a PUT one type
 * and one size, ten minutes — verified before the policy is asked, and the policy's `object` kind says that anyone
 * holding the URL may do the one thing it names (public.rego). No session is read. The web tier is the store's
 * front for now, so an upload does pass through it, which the spec's bucket avoided; § 15 records it.
 *
 * The PUT reads the body itself, as a stream, since the pipeline reads no body when the spec declares none: the
 * type must be the one signed for, the length — declared or counted — may not pass the size signed for, and a body
 * cut off at the limit leaves nothing stored. The GET streams the object with its own type, `nosniff`, and no cache.
 *
 * The token is the path, so neither route's line, span nor policy context carries the path as asked: they name the
 * template (`credentialInPath`), since the secret guard would redact the token and page on every upload.
 */

/** As the content routes count anonymous traffic (lib/api/endpoints/content.ts). */
const PUBLIC_RATE = { key: "ip", limit: 120, windowS: 60 } as const;

export interface StorageEndpointDeps {
  /** The token's claims, or null when it does not verify; `STORAGE_UNAVAILABLE` without a secret. */
  readonly verify: (token: string) => Promise<ObjectTokenClaims | null>;
  readonly store: () => ObjectStore;
}

const DEPS: StorageEndpointDeps = { verify: (token) => verifySignedToken(token), store: objectStore };

/** The media type of a `Content-Type`, lowercased and without its parameters. */
const mediaTypeOf = (contentType: string | null): string => (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const EXTENSION: Readonly<Record<string, string>> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "text/plain": "txt", "text/markdown": "md" };

/** The claims of a token that verifies and was signed for this method. */
async function claimsOf(deps: StorageEndpointDeps, token: string, method: ObjectMethod): Promise<ObjectTokenClaims> {
  const claims = await deps.verify(token);
  if (claims === null) throw new ApiError("SIGNED_URL_INVALID", "the link does not verify, or has expired");
  if (claims.method !== method) throw new ApiError("SIGNED_URL_INVALID", `the link is for ${claims.method}, not ${method}`, { method: claims.method });
  return claims;
}

const resourceOf = async (deps: StorageEndpointDeps, token: string, method: ObjectMethod): Promise<PolicyResource> => ({ kind: "object", id: (await claimsOf(deps, token, method)).key });

export function storageEndpoints(deps: StorageEndpointDeps = DEPS): {
  readonly objectPut: Spec<typeof ObjectTokenParamsSchema, undefined, undefined, typeof StoredObjectSchema>;
  readonly objectGet: Spec<typeof ObjectTokenParamsSchema, undefined, undefined, typeof StoredObjectSchema>;
} {
  return {
    objectPut: {
      path: "/api/v1/storage/{token}",
      method: "PUT",
      summary: "Store the bytes a signed upload URL allows",
      auth: "public",
      params: ObjectTokenParamsSchema,
      response: StoredObjectSchema,
      raw: { request: "*/*" },
      credentialInPath: true,
      rateLimit: PUBLIC_RATE,
      policy: { action: "write", resource: ({ params }) => resourceOf(deps, params.token, "PUT") },
      run: async ({ params, request }): Promise<StoredObject> => {
        const claims = await claimsOf(deps, params.token, "PUT");
        const contentType = claims.contentType ?? "";
        const maxBytes = claims.maxBytes ?? 0;
        if (mediaTypeOf(request.headers.get("content-type")) !== contentType) throw new ApiError("UPLOAD_TYPE_MISMATCH", `send ${contentType}`, { contentType });
        const declared = request.headers.get("content-length");
        if (declared !== null && Number(declared) > maxBytes) throw new ApiError("UPLOAD_TOO_LARGE", `the file passes ${String(maxBytes)} bytes`, { maxBytes });
        if (request.body === null) throw new ApiError("INVALID_INPUT", "send the file as the body", { in: "body", path: [] });
        try {
          return await deps.store().put(claims.key, Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>), contentType, maxBytes);
        } catch (error: unknown) {
          if (error instanceof ObjectTooLargeError) throw new ApiError("UPLOAD_TOO_LARGE", `the file passes ${String(maxBytes)} bytes`, { maxBytes });
          throw error;
        }
      },
    },

    objectGet: {
      path: "/api/v1/storage/{token}",
      method: "GET",
      summary: "Serve the object a signed URL names",
      auth: "public",
      params: ObjectTokenParamsSchema,
      /* The document's schema is the sidecar's; the body is the object's bytes (`raw.response`). */
      response: StoredObjectSchema,
      raw: { response: "*/*" },
      credentialInPath: true,
      rateLimit: PUBLIC_RATE,
      policy: { action: "read", resource: ({ params }) => resourceOf(deps, params.token, "GET") },
      run: async ({ params }): Promise<Response> => {
        const claims = await claimsOf(deps, params.token, "GET");
        const object = await deps.store().get(claims.key);
        if (object === null) throw new ApiError("NOT_FOUND", "nothing is stored under this link");
        const { meta } = object;
        const extension = EXTENSION[meta.contentType];
        const name = `${meta.key.split("/").slice(1).join("-")}${extension === undefined ? "" : `.${extension}`}`;
        return new Response(Readable.toWeb(object.body) as unknown as ReadableStream<Uint8Array>, {
          status: 200,
          headers: {
            "content-type": meta.contentType,
            "content-length": String(meta.bytes),
            "content-disposition": `inline; filename="${name}"`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
            etag: `"${meta.sha256}"`,
          },
        });
      },
    },
  };
}

export const { objectPut, objectGet } = storageEndpoints();
