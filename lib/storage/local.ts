import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AppError } from "@/lib/errors";
import { ObjectKeySchema, StoredObjectSchema, type ObjectKey, type StoredObject } from "@/lib/schemas/storage";

/*
 * Object storage as a directory (feature-specs/32 § 5, § 15; Andre, 2026-10-06: "it'll be stored locally for now,
 * we don't have a cloud infra"). An object is a file under the root at its key's path and a sidecar beside it
 * (`<key>.meta.json`: type, size, hash, when), written whole or not at all: the bytes go to a part file, counted
 * and hashed as they pass, and are renamed into place only after the sidecar is written; a body that passes the
 * size it was allowed is cut off and the part removed. The key is checked against `ObjectKeySchema` and the path
 * against the root before anything is opened, so a key is never a path a person wrote. When a bucket exists it
 * stands behind this same `ObjectStore` interface, and nothing above it changes.
 */

export interface ObjectBody {
  readonly meta: StoredObject;
  readonly body: Readable;
}

export interface ObjectStore {
  /** Stores the body under the key; throws `ObjectTooLargeError` when it passes `maxBytes`, with nothing kept. */
  put(key: ObjectKey, body: Readable | Uint8Array, contentType: string, maxBytes?: number): Promise<StoredObject>;
  get(key: ObjectKey): Promise<ObjectBody | null>;
  head(key: ObjectKey): Promise<StoredObject | null>;
  /** True when something was there. */
  remove(key: ObjectKey): Promise<boolean>;
  /** Every object whose key begins with the prefix's segments removed, an object at the prefix itself included (feature-specs/45 § 4); true when something was there. */
  removeUnder(prefix: ObjectKey): Promise<boolean>;
}

export class ObjectTooLargeError extends Error {
  readonly code = "OBJECT_TOO_LARGE";

  constructor(readonly maxBytes: number) {
    super(`the body passes ${String(maxBytes)} bytes`);
    this.name = "ObjectTooLargeError";
  }
}

const META = ".meta.json";

/** Counts and hashes what passes, and ends the stream with `ObjectTooLargeError` the moment it passes the limit. */
class Meter extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;

  constructor(private readonly maxBytes: number | undefined) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.maxBytes !== undefined && this.bytes > this.maxBytes) {
      callback(new ObjectTooLargeError(this.maxBytes));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

export function localStore(dir: string, now: () => Date = () => new Date()): ObjectStore {
  const root = resolve(dir);

  const pathOf = (key: string): string => {
    const parsed = ObjectKeySchema.safeParse(key);
    if (!parsed.success) throw new AppError("OBJECT_KEY_INVALID", `not an object key: ${key}`);
    const path = resolve(join(root, ...parsed.data.split("/")));
    if (!path.startsWith(`${root}${sep}`)) throw new AppError("OBJECT_KEY_INVALID", `the key leaves the store: ${key}`);
    return path;
  };

  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "ENOENT") return false;
      throw error;
    }
  };

  const readMeta = async (path: string): Promise<StoredObject | null> => {
    let text: string;
    try {
      text = await readFile(`${path}${META}`, "utf8");
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    const parsed = StoredObjectSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new AppError("OBJECT_META_INVALID", `the sidecar at ${path}${META} does not read`);
    return parsed.data;
  };

  return {
    async put(key, body, contentType, maxBytes) {
      const path = pathOf(key);
      await mkdir(join(path, ".."), { recursive: true });
      const part = `${path}.${randomBytes(6).toString("hex")}.part`;
      const meter = new Meter(maxBytes);
      const source = body instanceof Readable ? body : Readable.from([Buffer.from(body)]);
      try {
        await pipeline(source, meter, createWriteStream(part));
      } catch (error: unknown) {
        await rm(part, { force: true });
        throw error;
      }
      const meta: StoredObject = { key, contentType, bytes: meter.bytes, sha256: meter.hash.digest("hex"), storedAt: now().toISOString() };
      await writeFile(`${path}${META}`, JSON.stringify(meta), "utf8");
      await rename(part, path);
      return meta;
    },

    async get(key) {
      const path = pathOf(key);
      const meta = await readMeta(path);
      if (meta === null) return null;
      try {
        await stat(path);
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
      return { meta, body: createReadStream(path) };
    },

    async head(key) {
      const path = pathOf(key);
      const meta = await readMeta(path);
      if (meta === null) return null;
      try {
        await stat(path);
        return meta;
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },

    async remove(key) {
      const path = pathOf(key);
      const was = (await readMeta(path)) !== null;
      await rm(`${path}${META}`, { force: true });
      await rm(path, { force: true });
      return was;
    },

    async removeUnder(prefix) {
      /* a prefix is checked as a key is, so it is never the store's root nor a root's whole tree: `evidence/<id>` at the least */
      const path = pathOf(prefix);
      const was = (await exists(path)) || (await exists(`${path}${META}`));
      await rm(path, { recursive: true, force: true });
      await rm(`${path}${META}`, { force: true });
      return was;
    },
  };
}
