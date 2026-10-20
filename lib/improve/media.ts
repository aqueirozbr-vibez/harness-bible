/*
 * PDFs and images as evidence (feature-specs/32 § 9; unit 49f): what code can know about the bytes before a model
 * reads them, exactly and without a dependency. Pure.
 *
 * `sniffMedia` reads the type from the file's own first bytes — `%PDF-`, the PNG signature, a JPEG's start-of-image
 * marker — so that a file uploaded or served as one type and being another is refused by name before it reaches the
 * provider, which would refuse it less legibly. `imageDimensions` reads an image's width and height from its header:
 * a PNG's `IHDR` chunk, a JPEG's first start-of-frame segment. Neither decodes anything; a header that does not read
 * is null, and the caller treats null as "cannot be checked here" rather than as a pass.
 *
 * The limits are the provider's documented ones (§ 9: "read in the unit and recorded, never above D2"), as read on
 * 2026-10-06 from the Claude API documentation this gateway's provider follows (feature-specs/32 § 19 quotes them):
 * a request of at most 32 MB, the base64 of every PDF and image counted; an image of at most 10 MB base64-encoded
 * and 8000 px a side; a PDF of at most 100 pages for a model whose context window is under 1M tokens (Haiku 4.5's
 * is 200K) and without a password or encryption. The documents do not say whether a megabyte is 10^6 or 2^20
 * bytes; the smaller reading is taken, so a file this code passes is within the limit on either. The pages and the
 * encryption are not read here — that would need a PDF reader — and stay the provider's to refuse.
 */

import { UPLOAD_SIZE_MAX, type UploadType } from "@/lib/schemas/storage";

/** The types the grader reads as the provider's own content rather than as text (32 § 4.3, § 9). */
export const GRADER_BYTES_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export type GraderBytesType = (typeof GRADER_BYTES_TYPES)[number];

export function isGraderBytesType(mediaType: string): mediaType is GraderBytesType {
  return (GRADER_BYTES_TYPES as ReadonlyArray<string>).includes(mediaType);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, magic: ReadonlyArray<number>): boolean => bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);

/** The type the bytes say they are, or null for anything else. */
export function sniffMedia(bytes: Uint8Array): GraderBytesType | null {
  if (startsWith(bytes, PDF_MAGIC)) return "application/pdf";
  if (startsWith(bytes, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
  return null;
}

/** "Maximum request size: 32 MB" (pdf-support; api/overview: "Messages, Token Counting | 32 MB"), at 10^6 bytes to the MB. */
export const PROVIDER_REQUEST_MAX_BYTES = 32_000_000;
/** "10 MB (base64-encoded) when using the Claude API directly" (vision), at 10^6 bytes to the MB. */
export const PROVIDER_IMAGE_BASE64_MAX = 10_000_000;
/** "The maximum dimensions per image are 8000x8000 px" (vision); the many-image limit does not arise with one image. */
export const PROVIDER_IMAGE_SIDE_MAX = 8000;
/** "600 (100 when the request's context window is under 1M tokens)" (pdf-support): enforced by the provider, recorded here. */
export const PROVIDER_PDF_PAGES_MAX = 100;

/** The length of the base64 text of `bytes` bytes: four characters for every three bytes, the last group padded. */
export const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);
/** The most bytes whose base64 text is at most `length` characters. */
export const bytesWithinBase64 = (length: number): number => Math.floor(length / 4) * 3;

/**
 * The largest file of a type the grader reads as bytes that the provider could take at all: an image whose base64
 * fits the per-image limit; a PDF whose base64 alone fits the request (the prompt around it is counted at grade
 * time, `requestWithinLimit`).
 */
export function graderBytesMaxOf(type: GraderBytesType): number {
  return type === "application/pdf" ? bytesWithinBase64(PROVIDER_REQUEST_MAX_BYTES) : bytesWithinBase64(PROVIDER_IMAGE_BASE64_MAX);
}

/** Why the provider would refuse these bytes, by what code can see: a code for the item's reason, or null to send them. */
export type MediaRefusal = "media_mismatch" | "pdf_too_large" | "image_too_large" | "image_unreadable" | "image_dimensions";

/**
 * The checks code can make on a PDF's or an image's bytes before the provider sees them: the bytes are the type
 * they were given as; a PDF's base64 fits a request; an image's base64 fits its limit, its header reads, and neither
 * side passes the limit. What it cannot see — a PDF's pages, its encryption, an image the provider cannot decode —
 * stays the provider's refusal, which the grader records as `U` with the gateway's status.
 */
export function checkGraderBytes(bytes: Uint8Array, declared: GraderBytesType): MediaRefusal | null {
  if (sniffMedia(bytes) !== declared) return "media_mismatch";
  if (declared === "application/pdf") return bytes.length > graderBytesMaxOf(declared) ? "pdf_too_large" : null;
  if (bytes.length > graderBytesMaxOf(declared)) return "image_too_large";
  const dimensions = imageDimensions(bytes);
  if (dimensions === null) return "image_unreadable";
  return dimensions.width > PROVIDER_IMAGE_SIDE_MAX || dimensions.height > PROVIDER_IMAGE_SIDE_MAX ? "image_dimensions" : null;
}

/**
 * The most bytes an upload of this type may carry: D2 (`UPLOAD_SIZE_MAX`, Andre's 100 MB), or for a type the grader
 * reads as bytes the provider's limit when that is lower — "never above D2" (§ 9). A file whose base64 alone could
 * never be sent is refused at the store (413) rather than kept and graded `U`; one near that edge whose request with
 * the prompt passes the provider's limit is refused before the call (`request_too_large`).
 */
export function uploadMaxOf(type: UploadType): number {
  return isGraderBytesType(type) ? Math.min(UPLOAD_SIZE_MAX, graderBytesMaxOf(type)) : UPLOAD_SIZE_MAX;
}

/** Whether a request whose JSON body is `bytes` long is within the provider's request limit. */
export const requestWithinLimit = (bytes: number): boolean => bytes <= PROVIDER_REQUEST_MAX_BYTES;

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

const uint16 = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const uint32 = (bytes: Uint8Array, at: number): number => (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);

/** A PNG's width and height from its first chunk, which the format requires to be `IHDR`. */
function pngDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24) return null;
  const ihdr = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (ihdr !== "IHDR") return null;
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/* The start-of-frame markers: C0 to CF, except DHT (C4), JPG (C8) and DAC (CC), which share the range. */
const isStartOfFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
/* Markers that stand alone, with no length after them: TEM, the restart markers, SOI and EOI. */
const standsAlone = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
const START_OF_SCAN = 0xda;

/**
 * A JPEG's width and height from its first start-of-frame segment, walking the segments that precede it as libjpeg's
 * `next_marker` does: bytes that are not 0xFF before a marker are skipped (decoders warn and go on; EXIF writers
 * leave them), as are fill bytes and a stuffed `FF 00`. A frame whose height is 0 defers it to a later DNL segment,
 * which libjpeg refuses (`JERR_EMPTY_IMAGE`, "DNL not supported") as the browsers do: it does not read, and neither
 * does a frame segment too short to hold what is read from it.
 */
function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  let at = 2; // past SOI
  while (at < bytes.length) {
    while (at < bytes.length && bytes[at] !== 0xff) at += 1; // extraneous bytes before a marker
    while (at < bytes.length && bytes[at] === 0xff) at += 1; // fill bytes
    if (at >= bytes.length) return null;
    const marker = bytes[at] ?? 0;
    at += 1; // at the segment's length, for a marker that has one
    if (marker === 0x00 || standsAlone(marker)) continue;
    if (marker === START_OF_SCAN) return null; // entropy-coded data follows: no frame header before it
    if (at + 1 >= bytes.length) return null;
    const length = uint16(bytes, at);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      /* The segment must hold what is read: its length, precision, height, width and component count. */
      if (length < 8 || at + 6 >= bytes.length) return null;
      const height = uint16(bytes, at + 3);
      const width = uint16(bytes, at + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += length;
  }
  return null;
}

/** The image's width and height as its header states them, or null when it is not a PNG or a JPEG whose header reads. */
export function imageDimensions(bytes: Uint8Array): Dimensions | null {
  const type = sniffMedia(bytes);
  if (type === "image/png") return pngDimensions(bytes);
  if (type === "image/jpeg") return jpegDimensions(bytes);
  return null;
}
