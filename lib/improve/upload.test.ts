import { describe, expect, it } from "vitest";

import { UPLOAD_TYPES } from "@/lib/schemas/storage";

import { TICKET_MARGIN_MS, ticketUsable, UPLOAD_ACCEPT, uploadTypeOf } from "./upload";

describe("uploadTypeOf: the type a file is sent as (32 § 5)", () => {
  it("takes the browser's type when it is one of the five, in any case", () => {
    for (const type of UPLOAD_TYPES) expect(uploadTypeOf({ name: "evidence", type })).toBe(type);
    expect(uploadTypeOf({ name: "report.png", type: "Application/PDF" })).toBe("application/pdf");
  });

  it("reads the extension when the browser gives another type or none", () => {
    expect(uploadTypeOf({ name: "notes.md", type: "" })).toBe("text/markdown");
    expect(uploadTypeOf({ name: "notes.MARKDOWN", type: "text/x-markdown" })).toBe("text/markdown");
    expect(uploadTypeOf({ name: "scan.JPEG", type: "" })).toBe("image/jpeg");
    expect(uploadTypeOf({ name: "photo.jpg", type: "" })).toBe("image/jpeg");
    expect(uploadTypeOf({ name: "paper.v2.pdf", type: "application/octet-stream" })).toBe("application/pdf");
    expect(uploadTypeOf({ name: "readme.txt", type: "" })).toBe("text/plain");
  });

  it("refuses anything else: a page, another image, no extension", () => {
    expect(uploadTypeOf({ name: "page.html", type: "text/html" })).toBeNull();
    expect(uploadTypeOf({ name: "chart.gif", type: "image/gif" })).toBeNull();
    expect(uploadTypeOf({ name: "chart.webp", type: "" })).toBeNull();
    expect(uploadTypeOf({ name: "README", type: "" })).toBeNull();
    expect(uploadTypeOf({ name: "archive.pdf.zip", type: "application/zip" })).toBeNull();
  });

  it("finds nothing an object would inherit in a name's extension", () => {
    for (const name of ["x.constructor", "x.__proto__", "x.toString", "x.hasOwnProperty", "x.valueOf"]) expect(uploadTypeOf({ name, type: "" }), name).toBeNull();
  });

  it("offers the picker the five types and their extensions", () => {
    expect(UPLOAD_ACCEPT.split(",")).toEqual([...UPLOAD_TYPES, ".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md", ".markdown"]);
  });
});

describe("ticketUsable: a ticket still takes a PUT about to start", () => {
  it("until a minute before it ends", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    expect(ticketUsable("2026-10-08T12:10:00.000Z", now)).toBe(true);
    expect(ticketUsable(new Date(now + TICKET_MARGIN_MS).toISOString(), now)).toBe(true);
    expect(ticketUsable(new Date(now + TICKET_MARGIN_MS - 1).toISOString(), now)).toBe(false);
    expect(ticketUsable("2026-10-08T11:59:00.000Z", now)).toBe(false);
  });
});
