import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";

import { localStore, ObjectTooLargeError, type ObjectStore } from "./local";

/*
 * The directory store (feature-specs/32 § 5, § 15): an object written whole or not at all, read back with its
 * sidecar, cut off at the size it was allowed with nothing left behind, and a key that is never a path.
 */

const KEY = "evidence/S-21-0001/4f1c9a2e-0000-4000-8000-000000000000/source";
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const drain = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

let dir: string;
let store: ObjectStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hb-store-"));
  store = localStore(dir, () => new Date("2026-10-06T12:00:00Z"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("put and get", () => {
  it("stores bytes under the key with their type, size, hash and time, and reads them back", async () => {
    const meta = await store.put(KEY, PDF, "application/pdf");
    expect(meta).toEqual({ key: KEY, contentType: "application/pdf", bytes: PDF.length, sha256: sha(PDF), storedAt: "2026-10-06T12:00:00.000Z" });
    const object = await store.get(KEY);
    expect(object?.meta).toEqual(meta);
    expect((await drain(object!.body)).equals(PDF)).toBe(true);
    expect(await store.head(KEY)).toEqual(meta);
    expect(await readdir(join(dir, "evidence", "S-21-0001", "4f1c9a2e-0000-4000-8000-000000000000"))).toEqual(["source", "source.meta.json"]);
  });

  it("takes a stream and counts and hashes what passes", async () => {
    const chunks = [Buffer.alloc(64 * 1024, 0x61), Buffer.alloc(64 * 1024, 0x62), Buffer.from("tail")];
    const meta = await store.put("evidence/S-21-0001/stream/source", Readable.from(chunks), "text/plain");
    expect(meta.bytes).toBe(128 * 1024 + 4);
    expect(meta.sha256).toBe(sha(Buffer.concat(chunks)));
    expect((await drain((await store.get("evidence/S-21-0001/stream/source"))!.body)).length).toBe(meta.bytes);
  });

  it("replaces an object written again under the same key", async () => {
    await store.put("evidence/S-21-0001/again/source", Buffer.from("one"), "text/plain");
    const meta = await store.put("evidence/S-21-0001/again/source", Buffer.from("two, longer"), "text/markdown");
    expect(meta).toMatchObject({ contentType: "text/markdown", bytes: 11 });
    expect((await drain((await store.get("evidence/S-21-0001/again/source"))!.body)).toString()).toBe("two, longer");
  });

  it("answers null for a key nothing is under, and after a remove", async () => {
    expect(await store.get("evidence/S-21-0001/nothing/source")).toBeNull();
    expect(await store.head("evidence/S-21-0001/nothing/source")).toBeNull();
    await store.put("evidence/S-21-0001/gone/source", Buffer.from("x"), "text/plain");
    expect(await store.remove("evidence/S-21-0001/gone/source")).toBe(true);
    expect(await store.remove("evidence/S-21-0001/gone/source")).toBe(false);
    expect(await store.get("evidence/S-21-0001/gone/source")).toBeNull();
    expect(await readdir(join(dir, "evidence", "S-21-0001", "gone"))).toEqual([]);
  });

  it("removes every object under a prefix, sidecars and all, an object at the prefix itself included, and nothing beside it (45 § 4)", async () => {
    await store.put("evidence/S-21-0007/one/source", Buffer.from("a"), "text/plain");
    await store.put("evidence/S-21-0007/one/text", Buffer.from("b"), "text/plain");
    await store.put("evidence/S-21-0007/two/source", Buffer.from("c"), "text/plain");
    await store.put("evidence/S-21-0008/kept/source", Buffer.from("d"), "text/plain");
    expect(await store.removeUnder("evidence/S-21-0007/one")).toBe(true);
    expect(await store.head("evidence/S-21-0007/one/source")).toBeNull();
    expect(await store.head("evidence/S-21-0007/two/source")).not.toBeNull();
    expect(await store.removeUnder("evidence/S-21-0007")).toBe(true);
    expect(await store.removeUnder("evidence/S-21-0007")).toBe(false);
    expect(await readdir(join(dir, "evidence"))).not.toContain("S-21-0007");
    expect(await store.head("evidence/S-21-0008/kept/source")).not.toBeNull();
    /* an object at the prefix itself: a key and a prefix share their form */
    await store.put("evidence/S-21-0009/whole", Buffer.from("e"), "text/plain");
    expect(await store.removeUnder("evidence/S-21-0009/whole")).toBe(true);
    expect(await store.head("evidence/S-21-0009/whole")).toBeNull();
    expect(await readdir(join(dir, "evidence", "S-21-0009"))).toEqual([]);
    /* a prefix is checked as a key is: never the store's root, never outside it */
    await expect(store.removeUnder("evidence")).rejects.toThrow(/not an object key/);
    await expect(store.removeUnder("evidence/../..")).rejects.toThrow(/not an object key/);
  });
});

describe("the size limit", () => {
  it("cuts a body off the moment it passes the limit and keeps nothing, the part file included", async () => {
    const key = "evidence/S-21-0001/big/source";
    const stream = Readable.from([Buffer.alloc(1024, 0x61), Buffer.alloc(1024, 0x62), Buffer.alloc(1024, 0x63)]);
    await expect(store.put(key, stream, "text/plain", 2048)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(await store.get(key)).toBeNull();
    expect(await readdir(join(dir, "evidence", "S-21-0001", "big")).catch(() => [])).toEqual([]);
  });

  it("keeps a body exactly at the limit", async () => {
    const meta = await store.put("evidence/S-21-0001/exact/source", Buffer.alloc(2048, 0x61), "text/plain", 2048);
    expect(meta.bytes).toBe(2048);
  });

  it("leaves an object that was there when a replacement is cut off", async () => {
    const key = "evidence/S-21-0001/kept/source";
    await store.put(key, Buffer.from("kept"), "text/plain");
    await expect(store.put(key, Buffer.alloc(10, 0x61), "text/plain", 4)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect((await drain((await store.get(key))!.body)).toString()).toBe("kept");
  });
});

describe("the key", () => {
  it("refuses a key that is not the product's, before anything is opened", async () => {
    for (const key of ["../outside", "evidence/../../x", "/etc/passwd", "evidence/a b", "uploads/x", ""]) {
      await expect(store.put(key as never, Buffer.from("x"), "text/plain"), key).rejects.toMatchObject({ code: "OBJECT_KEY_INVALID" });
      await expect(store.get(key as never), key).rejects.toBeInstanceOf(AppError);
    }
    expect(await readdir(dir)).toEqual(["evidence"]);
  });

  it("refuses a sidecar that does not read", async () => {
    await store.put("evidence/S-21-0001/broken/source", Buffer.from("x"), "text/plain");
    const sidecar = join(dir, "evidence", "S-21-0001", "broken", "source.meta.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sidecar, JSON.stringify({ key: "evidence/S-21-0001/broken/source", contentType: "text/plain" }), "utf8");
    await expect(store.get("evidence/S-21-0001/broken/source")).rejects.toMatchObject({ code: "OBJECT_META_INVALID" });
    expect(JSON.parse(await readFile(sidecar, "utf8"))).toHaveProperty("contentType");
  });
});
