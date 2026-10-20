import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { storageEndpoints, type StorageEndpointDeps } from "@/lib/api/endpoints/storage";
import { handler, type HandlerDeps } from "@/lib/api/handler";
import { AppError } from "@/lib/errors";
import { StoredObjectSchema } from "@/lib/schemas/storage";
import { localStore, type ObjectStore } from "@/lib/storage/local";
import { signObjectToken, verifyObjectToken } from "@/lib/storage/sign";

/*
 * The storage routes through the pipeline, on a real directory and real signatures (feature-specs/32 § 5, § 15):
 * a PUT under a signed URL stores the bytes of the type and size the URL allows and nothing else; a GET under a
 * signed URL serves the object with its type and no cache; a token that does not verify, is expired, or is for the
 * other method is refused with nothing stored or served; without a secret the routes answer 503.
 */

const SECRET = "0".repeat(63) + "1";
const NOW = new Date("2026-10-06T12:00:00Z");
const KEY = "evidence/S-21-0001/4f1c9a2e-0000-4000-8000-000000000000/source";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

let dir: string;
let store: ObjectStore;
let clock = NOW;

const deps: StorageEndpointDeps = {
  verify: (token) => verifyObjectToken(token, SECRET, clock),
  store: () => store,
};
const unavailable: StorageEndpointDeps = {
  verify: async () => {
    throw new AppError("STORAGE_UNAVAILABLE", "OBJECT_STORE_SECRET is not set");
  },
  store: () => store,
};

/** The request lines the pipeline wrote, and the paths the policy was asked about. */
const lines: Array<Record<string, unknown>> = [];
const asked: string[] = [];

const pipeline = (): HandlerDeps => ({
  sessionFromRequest: async () => null,
  authorize: async (_subject, _action, _resource, context) => {
    asked.push(context.path);
    return { allow: true };
  },
  consume: async () => ({ allowed: true, limit: 120, remaining: 119, resetS: 60, retryAfterS: 0 }),
  idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
  audit: async () => undefined,
  log: (line) => {
    lines.push(line as unknown as Record<string, unknown>);
  },
});

const { objectPut, objectGet } = storageEndpoints(deps);
const HEADERS = { "x-forwarded-for": "198.51.100.48" };

const putToken = (key = KEY, contentType = "application/pdf", maxBytes = 4096) => signObjectToken({ key, method: "PUT", contentType, maxBytes }, 600, SECRET, NOW);
const getToken = (key = KEY) => signObjectToken({ key, method: "GET", contentType: null, maxBytes: null }, 600, SECRET, NOW);
const put = (token: string, body: BodyInit | null, headers: Record<string, string> = {}, endpoints = { objectPut }) =>
  handler(endpoints.objectPut, pipeline())(new Request(`http://localhost:3000/api/v1/storage/${token}`, { method: "PUT", headers: { ...HEADERS, ...headers }, body, ...(body === null ? {} : { duplex: "half" }) } as RequestInit), { params: { token } });
const get = (token: string, endpoints = { objectGet }) => handler(endpoints.objectGet, pipeline())(new Request(`http://localhost:3000/api/v1/storage/${token}`, { headers: HEADERS }), { params: { token } });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hb-storage-routes-"));
  store = localStore(dir, () => NOW);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the token in the path", () => {
  it("never reaches a line, a span or the policy: they name the template, a refusal's line too (unit 51d's review)", async () => {
    lines.length = 0;
    asked.length = 0;
    const { token } = await putToken();
    expect((await put(token, PDF, { "content-type": "application/pdf" })).status).toBe(200);
    expect((await get(token)).status).toBe(403);
    expect(lines.map((line) => [line.method, line.path, line.status])).toEqual([
      ["PUT", "/api/v1/storage/{token}", 200],
      ["GET", "/api/v1/storage/{token}", 403],
    ]);
    expect(asked).toEqual(["/api/v1/storage/{token}"]);
    expect(JSON.stringify(lines)).not.toContain(token);
  });
});

describe("the declarations", () => {
  it("are public routes on one path, limited by address, asking the policy about the object with the method's action", () => {
    expect(objectPut).toMatchObject({ path: "/api/v1/storage/{token}", method: "PUT", auth: "public", rateLimit: { key: "ip", limit: 120, windowS: 60 }, policy: { action: "write" }, raw: { request: "*/*" } });
    expect(objectGet).toMatchObject({ path: "/api/v1/storage/{token}", method: "GET", auth: "public", rateLimit: { key: "ip", limit: 120, windowS: 60 }, policy: { action: "read" }, raw: { response: "*/*" } });
    expect(objectPut.body).toBeUndefined();
  });

  it("name the object the token carries as the policy's resource, and refuse before the policy a token that does not verify or is for the other method", async () => {
    const { token } = await putToken();
    expect(await objectPut.policy.resource({ params: { token }, query: undefined, body: undefined, session: null })).toEqual({ kind: "object", id: KEY });
    await expect(objectGet.policy.resource({ params: { token }, query: undefined, body: undefined, session: null })).rejects.toMatchObject({ code: "SIGNED_URL_INVALID", detail: { method: "PUT" } });
    await expect(objectPut.policy.resource({ params: { token: "nonsense" }, query: undefined, body: undefined, session: null })).rejects.toMatchObject({ code: "SIGNED_URL_INVALID" });
  });
});

describe("PUT /api/v1/storage/{token}", () => {
  it("stores the bytes of the type signed for and answers the sidecar", async () => {
    const { token } = await putToken();
    const response = await put(token, PDF, { "content-type": "application/pdf" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(StoredObjectSchema.parse(await response.json())).toEqual({ key: KEY, contentType: "application/pdf", bytes: PDF.length, sha256: sha(PDF), storedAt: NOW.toISOString() });
    expect(await store.head(KEY)).toMatchObject({ bytes: PDF.length });
  });

  it("takes the type with parameters and in any case, and refuses another type with nothing stored", async () => {
    const { token } = await putToken("evidence/S-21-0001/typed/source", "text/plain");
    expect((await put(token, "plain", { "content-type": "Text/Plain; charset=utf-8" })).status).toBe(200);
    const { token: other } = await putToken("evidence/S-21-0001/other/source", "text/plain");
    for (const type of ["text/markdown", "application/pdf", ""]) {
      /* Bytes, not a string: a string body would get a text/plain header from the Request itself. */
      const response = await put(other, Buffer.from("x"), type === "" ? {} : { "content-type": type });
      expect(response.status, type).toBe(415);
      expect(await response.json()).toMatchObject({ code: "UPLOAD_TYPE_MISMATCH", detail: { contentType: "text/plain" } });
    }
    expect(await store.head("evidence/S-21-0001/other/source")).toBeNull();
  });

  it("refuses a declared length over the size signed for before reading, and a body that passes it while reading, with nothing stored", async () => {
    const { token } = await putToken("evidence/S-21-0001/big/source", "text/plain", 100);
    const declared = await put(token, Buffer.alloc(50, 0x61), { "content-type": "text/plain", "content-length": "101" });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ code: "UPLOAD_TOO_LARGE", detail: { maxBytes: 100 } });
    const chunks = [Buffer.alloc(60, 0x61), Buffer.alloc(60, 0x62)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const counted = await put(token, stream, { "content-type": "text/plain" });
    expect(counted.status).toBe(413);
    expect(await counted.json()).toMatchObject({ code: "UPLOAD_TOO_LARGE", detail: { maxBytes: 100 } });
    expect(await store.head("evidence/S-21-0001/big/source")).toBeNull();
    expect((await put(token, Buffer.alloc(100, 0x61), { "content-type": "text/plain" })).status).toBe(200);
  });

  it("refuses a token that is expired, for a GET, altered, or not one, and refuses without a body", async () => {
    const { token } = await putToken("evidence/S-21-0001/refused/source", "text/plain");
    clock = new Date("2026-10-06T12:10:01Z");
    expect((await put(token, "x", { "content-type": "text/plain" })).status).toBe(403);
    clock = NOW;
    const { token: forGet } = await getToken("evidence/S-21-0001/refused/source");
    const wrongMethod = await put(forGet, "x", { "content-type": "text/plain" });
    expect(wrongMethod.status).toBe(403);
    expect(await wrongMethod.json()).toMatchObject({ code: "SIGNED_URL_INVALID", detail: { method: "GET" } });
    expect((await put(`${token}x`, "x", { "content-type": "text/plain" })).status).toBe(403);
    expect((await put("nonsense", "x", { "content-type": "text/plain" })).status).toBe(403);
    expect((await put(token, null, { "content-type": "text/plain" })).status).toBe(400);
    expect(await store.head("evidence/S-21-0001/refused/source")).toBeNull();
  });
});

describe("GET /api/v1/storage/{token}", () => {
  it("serves the object with its type, length, hash, no cache and nosniff", async () => {
    const { token } = await getToken();
    const response = await get(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(PDF.length));
    expect(response.headers.get("etag")).toBe(`"${sha(PDF)}"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="S-21-0001-4f1c9a2e-0000-4000-8000-000000000000-source.pdf"');
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("answers 404 for a key nothing is under, and 403 for a token that is expired, for a PUT, or not one", async () => {
    const { token } = await getToken("evidence/S-21-0001/nothing/source");
    expect((await get(token)).status).toBe(404);
    clock = new Date("2026-10-06T12:10:01Z");
    expect((await get((await getToken()).token)).status).toBe(403);
    clock = NOW;
    const { token: forPut } = await putToken();
    const wrongMethod = await get(forPut);
    expect(wrongMethod.status).toBe(403);
    expect(await wrongMethod.json()).toMatchObject({ code: "SIGNED_URL_INVALID", detail: { method: "PUT" } });
    expect((await get("nonsense")).status).toBe(403);
  });
});

describe("without a secret", () => {
  it("both routes answer 503 STORAGE_UNAVAILABLE and touch nothing", async () => {
    const endpoints = storageEndpoints(unavailable);
    const { token } = await putToken("evidence/S-21-0001/unavailable/source", "text/plain");
    const response = await put(token, "x", { "content-type": "text/plain" }, endpoints);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect((await get((await getToken()).token, endpoints)).status).toBe(503);
    expect(await store.head("evidence/S-21-0001/unavailable/source")).toBeNull();
  });
});
