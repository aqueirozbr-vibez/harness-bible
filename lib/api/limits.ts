/*
 * The API pipeline's limits that a client also reads (lib/api/handler.ts): a module of its own, with nothing
 * imported, so that a client island can keep within them without the handler. The suggest form's editors refuse a
 * proposal the pipeline would refuse for its size (feature-specs/34 § 19).
 */

/** A request body's most: the `Content-Length` and the text read are both held to it. */
export const MAX_BODY_BYTES = 65_536;
