import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as authDev } from "@/app/api/v1/auth/dev/route";
import { GET as objectGetRoute, PUT as objectPutRoute } from "@/app/api/v1/storage/[token]/route";
import { POST as uploadsRoute } from "@/app/api/v1/suggestions/[id]/evidence/uploads/route";
import { POST as suggestionsRoute } from "@/app/api/v1/suggestions/route";
import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { StoredObjectSchema, UploadTicketSchema } from "@/lib/schemas/storage";
import { headObject } from "@/lib/storage";

/*
 * An upload round trip through the routes, against the database, the sidecar and the configured store
 * (feature-specs/32 § 5, § 13.4, § 15): the owner of a draft asks for a ticket, PUTs the file to the URL it names
 * and only the type it names, and the object is readable through a signed GET and no other way; a reader and a
 * stranger get no ticket; the policy's `object` kind is asked by the sidecar for real. Runs where DATABASE_URL,
 * OPA_URL, AUTH_DEV_PROVIDER and OBJECT_STORE_SECRET are set; the objects it writes are its own and removed after.
 */

const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined && env.AUTH_DEV_PROVIDER === "1" && env.OBJECT_STORE_SECRET !== undefined;

const CONTRIBUTOR = "storage-contributor@harness-bible.local";
const READER = "storage-reader@harness-bible.local";
const OTHER = "storage-other@harness-bible.local";
const EMAILS = [CONTRIBUTOR, READER, OTHER];
const ADDRESS = `2001:db8:3::${Date.now().toString(16)}`;
const base = env.APP_URL.replace(/\/$/, "");
const PDF = Buffer.from(`%PDF-1.4\n% integration suite ${randomUUID()}\n%%EOF\n`);

const tokens: Record<string, string> = {};
const written: string[] = [];

async function signIn(email: string, role: "READER" | "CONTRIBUTOR", verified: boolean): Promise<string> {
  const response = await authDev(new Request(`${base}/api/v1/auth/dev?email=${encodeURIComponent(email)}&role=${role}&verified=${String(verified)}&next=/en`, { headers: { "x-forwarded-for": ADDRESS } }), { params: Promise.resolve({}) });
  expect(response.status).toBe(302);
  return /hb\.session=([^;]+)/.exec(response.headers.getSetCookie().join("\n"))?.[1] ?? "";
}

const headersOf = (token: string): Record<string, string> => ({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ADDRESS, cookie: `hb.session=${token}` });
const createDraft = (token: string): Promise<Response> =>
  suggestionsRoute(new Request(`${base}/api/v1/suggestions`, { method: "POST", headers: { ...headersOf(token), "idempotency-key": randomUUID() }, body: JSON.stringify({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" }) }), { params: Promise.resolve({}) });
const ticket = (token: string, id: string, contentType: string): Promise<Response> =>
  uploadsRoute(new Request(`${base}/api/v1/suggestions/${id}/evidence/uploads`, { method: "POST", headers: headersOf(token), body: JSON.stringify({ contentType }) }), { params: Promise.resolve({ id }) });
const tokenOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);
const put = (url: string, body: Buffer, contentType: string): Promise<Response> =>
  objectPutRoute(new Request(url, { method: "PUT", headers: { "x-forwarded-for": ADDRESS, "content-type": contentType }, body: new Uint8Array(body) }), { params: Promise.resolve({ token: tokenOf(url) }) });
const get = (url: string): Promise<Response> => objectGetRoute(new Request(url, { headers: { "x-forwarded-for": ADDRESS } }), { params: Promise.resolve({ token: tokenOf(url) }) });

async function cleanup(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    const ids = (await prisma.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true } })).map((user) => user.id);
    await prisma.suggestion.deleteMany({ where: { userId: { in: ids }, state: "DRAFT" } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.authEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  for (const key of written) await rm(`${env.OBJECT_STORE_DIR}/${key.split("/").slice(0, 2).join("/")}`, { recursive: true, force: true });
}

describe.skipIf(!ready)("an upload round trip through the routes, against the database, the sidecar and the store", () => {
  let draftId = "";

  beforeAll(async () => {
    await cleanup();
    tokens.contributor = await signIn(CONTRIBUTOR, "CONTRIBUTOR", true);
    tokens.reader = await signIn(READER, "READER", true);
    tokens.other = await signIn(OTHER, "CONTRIBUTOR", true);
    const created = await createDraft(tokens.contributor ?? "");
    expect(created.status, await created.clone().text()).toBe(200);
    draftId = ((await created.json()) as { id: string }).id;
  }, 120_000);

  afterAll(cleanup);

  it("gives the owner a ticket, takes the file at its URL, and serves it back through a signed GET (§ 13.4)", async () => {
    const asked = await ticket(tokens.contributor ?? "", draftId, "application/pdf");
    expect(asked.status, await asked.clone().text()).toBe(200);
    const granted = UploadTicketSchema.parse(await asked.json());
    expect(granted.uploadKey.startsWith(`evidence/${draftId}/`)).toBe(true);
    expect(granted.url.startsWith(`${base}/api/v1/storage/`)).toBe(true);
    /* A PDF's ticket is the provider's limit, under D2 (unit 49f, § 9). */
    expect(granted.maxBytes).toBe(24_000_000);
    expect(new Date(granted.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    written.push(granted.uploadKey);

    const stored = await put(granted.url, PDF, "application/pdf");
    expect(stored.status, await stored.clone().text()).toBe(200);
    const meta = StoredObjectSchema.parse(await stored.json());
    expect(meta).toMatchObject({ key: granted.uploadKey, contentType: "application/pdf", bytes: PDF.length, sha256: createHash("sha256").update(PDF).digest("hex") });
    expect(await headObject(granted.uploadKey)).toEqual(meta);

    /* The GET URL is the store's to sign (49e's read will do it); here signed as the product would. */
    const { signedGetUrl } = await import("@/lib/storage");
    const served = await get((await signedGetUrl(granted.uploadKey)).url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await served.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("refuses another type at the signed URL, and a GET at a PUT's URL (§ 13.4: the URL accepts the declared type and refuses another)", async () => {
    const granted = UploadTicketSchema.parse(await (await ticket(tokens.contributor ?? "", draftId, "image/png")).json());
    written.push(granted.uploadKey);
    const wrong = await put(granted.url, PDF, "application/pdf");
    expect(wrong.status).toBe(415);
    expect(await wrong.json()).toMatchObject({ code: "UPLOAD_TYPE_MISMATCH", detail: { contentType: "image/png" } });
    expect(await headObject(granted.uploadKey)).toBeNull();
    const read = await get(granted.url);
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ code: "SIGNED_URL_INVALID" });
  });

  it("is readable only through a signed URL: the store's key alone opens nothing, and a token that does not verify is refused by the route before the policy", async () => {
    const forged = `${base}/api/v1/storage/eyJhbGciOiJIUzI1NiJ9.eyJrZXkiOiJldmlkZW5jZS94L3kvc291cmNlIiwibWV0aG9kIjoiR0VUIn0.AAAA`;
    expect((await get(forged)).status).toBe(403);
    expect((await get(`${base}/api/v1/storage/${encodeURIComponent(written[0] ?? "")}`)).status).toBe(403);
  });

  it("gives no ticket to a reader, to another contributor, or for a type a person may not upload", async () => {
    expect((await ticket(tokens.reader ?? "", draftId, "application/pdf")).status).toBe(403);
    expect((await ticket(tokens.other ?? "", draftId, "application/pdf")).status).toBe(404);
    expect((await ticket(tokens.contributor ?? "", draftId, "text/html")).status).toBe(400);
  });
});
