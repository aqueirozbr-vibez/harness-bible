import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UPLOAD_SIZE_MAX } from "@/lib/schemas/storage";

import {
  base64Length,
  bytesWithinBase64,
  checkGraderBytes,
  GRADER_BYTES_TYPES,
  graderBytesMaxOf,
  imageDimensions,
  isGraderBytesType,
  PROVIDER_IMAGE_BASE64_MAX,
  PROVIDER_IMAGE_SIDE_MAX,
  PROVIDER_PDF_PAGES_MAX,
  PROVIDER_REQUEST_MAX_BYTES,
  requestWithinLimit,
  sniffMedia,
  uploadMaxOf,
} from "./media";

/*
 * What code knows of a PDF's or an image's bytes before a model reads them (feature-specs/32 § 9): the type from the
 * file's own first bytes, and an image's dimensions from its header, on the grader's fixtures as Chromium rendered
 * them and on headers built byte by byte for the edges; and the provider's documented limits as code holds them —
 * a 32 MB request, 10 MB of base64 an image, 8000 px a side — at the smaller reading of a megabyte.
 */

const FIXTURES = join(process.cwd(), "workers", "agents", "grader", "__fixtures__");
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(width: number, height: number, chunk = "IHDR"): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from(PNG_SIGNATURE).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write(chunk, 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** A JPEG of segments: SOI, then each `[marker, payload]`, each with its length. */
function jpeg(segments: ReadonlyArray<readonly [number, ReadonlyArray<number>]>, prefix: ReadonlyArray<number> = []): Buffer {
  const parts: number[] = [0xff, 0xd8, ...prefix];
  for (const [marker, payload] of segments) {
    const length = payload.length + 2;
    parts.push(0xff, marker, length >> 8, length & 0xff, ...payload);
  }
  return Buffer.from(parts);
}

/** A start-of-frame payload: precision, height, width, one component. */
const frame = (width: number, height: number): ReadonlyArray<number> => [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0];

describe("sniffMedia", () => {
  it("reads the three types from the fixtures' own first bytes", () => {
    expect(sniffMedia(fixture("C-vendor.pdf"))).toBe("application/pdf");
    expect(sniffMedia(fixture("C-vendor.png"))).toBe("image/png");
    expect(sniffMedia(fixture("C-vendor.jpg"))).toBe("image/jpeg");
  });

  it("is null for text, for an empty file, for a truncated signature and for other images", () => {
    expect(sniffMedia(fixture("C-vendor.txt"))).toBeNull();
    expect(sniffMedia(Buffer.alloc(0))).toBeNull();
    expect(sniffMedia(Buffer.from("%PDF"))).toBeNull();
    expect(sniffMedia(Buffer.from(PNG_SIGNATURE.slice(0, 7)))).toBeNull();
    expect(sniffMedia(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffMedia(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffMedia(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBeNull();
    expect(sniffMedia(Buffer.from("<html><body>%PDF-1.4</body></html>"))).toBeNull();
  });

  it("names exactly the types the grader reads as bytes", () => {
    expect([...GRADER_BYTES_TYPES]).toEqual(["application/pdf", "image/png", "image/jpeg"]);
    expect(isGraderBytesType("image/png")).toBe(true);
    expect(isGraderBytesType("text/plain")).toBe(false);
    expect(isGraderBytesType("image/gif")).toBe(false);
  });
});

describe("imageDimensions", () => {
  it("reads the fixtures' 800 × 420 from a PNG's IHDR and from a JPEG's start of frame", () => {
    expect(imageDimensions(fixture("C-vendor.png"))).toEqual({ width: 800, height: 420 });
    expect(imageDimensions(fixture("C-vendor.jpg"))).toEqual({ width: 800, height: 420 });
  });

  it("reads a PNG's header at its widest, and refuses one whose first chunk is not IHDR, a zero side or a short file", () => {
    expect(imageDimensions(png(8000, 1))).toEqual({ width: 8000, height: 1 });
    expect(imageDimensions(png(0xffffffff, 2))).toEqual({ width: 4294967295, height: 2 });
    expect(imageDimensions(png(10, 10, "IDAT"))).toBeNull();
    expect(imageDimensions(png(0, 10))).toBeNull();
    expect(imageDimensions(png(10, 0))).toBeNull();
    /* One byte short of the height: without the length guard this would read a height from three bytes and a zero. */
    expect(imageDimensions(png(10, 0x0a0a0a0a).subarray(0, 23))).toBeNull();
  });

  it("walks a JPEG's segments to the first frame: past APP and DQT segments, fill bytes and stand-alone markers, for baseline and progressive frames", () => {
    expect(imageDimensions(jpeg([[0xe0, [0x4a, 0x46, 0x49, 0x46, 0]], [0xdb, new Array<number>(65).fill(1)], [0xc0, frame(1024, 768)]]))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(jpeg([[0xc2, frame(9000, 10)]]))).toEqual({ width: 9000, height: 10 });
    /* DHT (C4) shares the range and is not a frame: it is stepped over. */
    expect(imageDimensions(jpeg([[0xc4, [0, 1, 2, 3]], [0xc1, frame(5, 6)]]))).toEqual({ width: 5, height: 6 });
    /* A restart marker standing alone, then fill bytes before the next marker. */
    const withFill = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xff]), jpeg([[0xc0, frame(7, 8)]]).subarray(2)]);
    expect(imageDimensions(withFill)).toEqual({ width: 7, height: 8 });
  });

  it("skips what decoders skip before a marker: stray bytes, a stuffed FF 00; and refuses a deferred height and a frame too short for its fields, as libjpeg does", () => {
    const app = jpeg([[0xe0, [0x4a, 0x46, 0x49, 0x46, 0]]]);
    const sof = jpeg([[0xc0, frame(640, 480)]]).subarray(2);
    expect(imageDimensions(Buffer.concat([app, Buffer.from([0x00, 0x00]), sof]))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(Buffer.concat([app, Buffer.from([0xff, 0x00, 0x12]), sof]))).toEqual({ width: 640, height: 480 });
    /* The fixture with two stray bytes inserted before its quantisation table, as an EXIF writer leaves them. */
    const fixed = fixture("C-vendor.jpg");
    const dqt = fixed.indexOf(Buffer.from([0xff, 0xdb]));
    expect(dqt).toBeGreaterThan(2);
    expect(imageDimensions(Buffer.concat([fixed.subarray(0, dqt), Buffer.from([0x00, 0x00]), fixed.subarray(dqt)]))).toEqual({ width: 800, height: 420 });
    expect(imageDimensions(jpeg([[0xc0, frame(5, 0)]]))).toBeNull();
    /* A frame whose length (2) cannot hold what is read after it: without the guard this would read 32 × 16. */
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]))).toBeNull();
  });

  it("is null for a JPEG whose scan starts before any frame, a broken segment, a truncated frame, a zero width, and for what is not an image", () => {
    expect(imageDimensions(jpeg([[0xda, [1, 2, 3]], [0xc0, frame(5, 6)]]))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00]))).toBeNull();
    /* A frame cut after its height's first byte: without the truncation guard this would read 256 × 256. */
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01]))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00]))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff]))).toBeNull();
    expect(imageDimensions(jpeg([[0xc0, frame(0, 6)]]))).toBeNull();
    expect(imageDimensions(fixture("C-vendor.pdf"))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

describe("the provider's limits (as read on 2026-10-06, feature-specs/32 § 19)", () => {
  it("holds the documented numbers at the smaller reading of a megabyte", () => {
    expect(PROVIDER_REQUEST_MAX_BYTES).toBe(32_000_000);
    expect(PROVIDER_IMAGE_BASE64_MAX).toBe(10_000_000);
    expect(PROVIDER_IMAGE_SIDE_MAX).toBe(8000);
    expect(PROVIDER_PDF_PAGES_MAX).toBe(100);
  });

  it("counts base64 as Node writes it, and the most bytes a base64 length holds", () => {
    for (const size of [0, 1, 2, 3, 4, 5, 6, 7, 1000, 1001, 1002]) expect(base64Length(size), String(size)).toBe(Buffer.alloc(size).toString("base64").length);
    expect(bytesWithinBase64(10_000_000)).toBe(7_500_000);
    expect(base64Length(7_500_000)).toBe(10_000_000);
    expect(base64Length(7_500_001)).toBeGreaterThan(10_000_000);
    expect(bytesWithinBase64(32_000_000)).toBe(24_000_000);
    expect(bytesWithinBase64(7)).toBe(3);
  });

  it("gives the largest file of each type the provider could take, and each upload type its limit, never above D2", () => {
    expect(graderBytesMaxOf("application/pdf")).toBe(24_000_000);
    expect(graderBytesMaxOf("image/png")).toBe(7_500_000);
    expect(graderBytesMaxOf("image/jpeg")).toBe(7_500_000);
    expect(uploadMaxOf("application/pdf")).toBe(24_000_000);
    expect(uploadMaxOf("image/png")).toBe(7_500_000);
    expect(uploadMaxOf("image/jpeg")).toBe(7_500_000);
    expect(uploadMaxOf("text/plain")).toBe(UPLOAD_SIZE_MAX);
    expect(uploadMaxOf("text/markdown")).toBe(UPLOAD_SIZE_MAX);
    for (const type of GRADER_BYTES_TYPES) expect(uploadMaxOf(type)).toBeLessThanOrEqual(UPLOAD_SIZE_MAX);
  });

  it("holds a request to 32 MB", () => {
    expect(requestWithinLimit(32_000_000)).toBe(true);
    expect(requestWithinLimit(32_000_001)).toBe(false);
  });
});

describe("checkGraderBytes", () => {
  it("passes the three fixtures as their own types", () => {
    expect(checkGraderBytes(fixture("C-vendor.pdf"), "application/pdf")).toBeNull();
    expect(checkGraderBytes(fixture("C-vendor.png"), "image/png")).toBeNull();
    expect(checkGraderBytes(fixture("C-vendor.jpg"), "image/jpeg")).toBeNull();
  });

  it("refuses bytes that are not the type they were given as", () => {
    expect(checkGraderBytes(fixture("C-vendor.png"), "application/pdf")).toBe("media_mismatch");
    expect(checkGraderBytes(fixture("C-vendor.pdf"), "image/png")).toBe("media_mismatch");
    expect(checkGraderBytes(fixture("C-vendor.jpg"), "image/png")).toBe("media_mismatch");
    expect(checkGraderBytes(fixture("C-vendor.txt"), "application/pdf")).toBe("media_mismatch");
    expect(checkGraderBytes(Buffer.alloc(0), "image/jpeg")).toBe("media_mismatch");
  });

  it("refuses a PDF whose base64 alone could not fit a request, and passes one at the edge", () => {
    const pdf = (size: number): Buffer => {
      const bytes = Buffer.alloc(size, 0x20);
      Buffer.from("%PDF-1.4\n").copy(bytes, 0);
      return bytes;
    };
    expect(checkGraderBytes(pdf(24_000_000), "application/pdf")).toBeNull();
    expect(checkGraderBytes(pdf(24_000_001), "application/pdf")).toBe("pdf_too_large");
  });

  it("refuses an image over the base64 limit, one whose header does not read, and one with a side over 8000 px", () => {
    const big = Buffer.alloc(7_500_001);
    png(800, 600).copy(big, 0);
    expect(checkGraderBytes(big, "image/png")).toBe("image_too_large");
    expect(checkGraderBytes(big.subarray(0, 7_500_000), "image/png")).toBeNull();
    expect(checkGraderBytes(Buffer.concat([png(8000, 8000), Buffer.alloc(100)]), "image/png")).toBeNull();
    expect(checkGraderBytes(png(8001, 10), "image/png")).toBe("image_dimensions");
    expect(checkGraderBytes(png(10, 8001), "image/png")).toBe("image_dimensions");
    expect(checkGraderBytes(png(10, 10, "IDAT"), "image/png")).toBe("image_unreadable");
    expect(checkGraderBytes(jpeg([[0xc0, frame(9000, 10)]]), "image/jpeg")).toBe("image_dimensions");
    /* A deferred height (DNL) does not read: libjpeg refuses it, so the provider would, and nothing is sent. */
    expect(checkGraderBytes(jpeg([[0xc0, frame(10, 0)]]), "image/jpeg")).toBe("image_unreadable");
    expect(checkGraderBytes(jpeg([[0xc0, frame(8001, 0)]]), "image/jpeg")).toBe("image_unreadable");
    expect(checkGraderBytes(jpeg([[0xda, [1, 2, 3]]]), "image/jpeg")).toBe("image_unreadable");
  });
});
