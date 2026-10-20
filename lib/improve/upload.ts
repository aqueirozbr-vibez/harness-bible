import { UPLOAD_TYPES, type UploadType } from "@/lib/schemas/storage";

/*
 * A file as the suggest form uploads it (feature-specs/34 § 5; 32 § 5; unit 51d): the type it is sent as, which the
 * ticket is asked for and the store holds it to, and whether a ticket still takes the file. Pure, and light enough
 * for a client island.
 */

/**
 * The extensions of the five types a person may upload (`UPLOAD_TYPES`), for a file the browser gives another type or
 * none. A map, so that a name ending `.constructor` finds nothing an object would inherit (unit 51d's review).
 */
const EXTENSIONS: ReadonlyMap<string, UploadType> = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
]);

/** The file field's `accept`: the five types and their extensions, so that the picker offers what a ticket takes. */
export const UPLOAD_ACCEPT = [...UPLOAD_TYPES, ...[...EXTENSIONS.keys()].map((extension) => `.${extension}`)].join(",");

/** The type a file is sent as: the browser's when it is one of the five, else its name's extension's; null for anything else. */
export function uploadTypeOf(file: { readonly name: string; readonly type: string }): UploadType | null {
  const given = file.type.toLowerCase();
  const known = UPLOAD_TYPES.find((type) => type === given);
  if (known !== undefined) return known;
  const dot = file.name.lastIndexOf(".");
  return dot < 0 ? null : (EXTENSIONS.get(file.name.slice(dot + 1).toLowerCase()) ?? null);
}

/** How long before its end a ticket is still used for a `PUT` about to start (its life is `SIGNED_URL_TTL_S`, ten minutes); past it a new one is asked for. */
export const TICKET_MARGIN_MS = 60_000;

/** Whether a ticket that ends at `expiresAt` still takes a `PUT` starting at `now`. */
export function ticketUsable(expiresAt: string, now: number): boolean {
  return Date.parse(expiresAt) - now >= TICKET_MARGIN_MS;
}
