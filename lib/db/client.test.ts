import { describe, expect, it } from "vitest";

import { contentWriteAllowed } from "@/lib/db/client";
import { EMBED_TARGET } from "@/lib/gateway/prices";

/*
 * The content guard and its one exemption (architecture § 11.3; feature-specs/12 D3). The extension itself needs
 * a database; this is the rule it asks, tested on its own.
 */

const READER = { pipeline: false, embed: false };
const PIPELINE = { pipeline: true, embed: false };
const EMBED = { pipeline: false, embed: true };

describe("contentWriteAllowed", () => {
  it("lets any process read a content row and write a row that is not content", () => {
    expect(contentWriteAllowed("Section", "findMany", { where: {} }, READER)).toBe(true);
    expect(contentWriteAllowed("Bookmark", "create", { data: { sectionId: "21.3" } }, READER)).toBe(true);
  });

  it("refuses a content write outside the pipeline", () => {
    expect(contentWriteAllowed("Section", "update", { data: { titleEn: "x" } }, READER)).toBe(false);
    expect(contentWriteAllowed("Release", "deleteMany", {}, READER)).toBe(false);
  });

  it("lets the pipeline write any content row", () => {
    expect(contentWriteAllowed("Section", "update", { data: { titleEn: "x" } }, PIPELINE)).toBe(true);
    expect(contentWriteAllowed("Release", "deleteMany", {}, PIPELINE)).toBe(true);
  });

  it("lets the embedding job update the three embedding columns of a Section", () => {
    expect(contentWriteAllowed("Section", "update", { data: { embedding: [0.1], embeddingModel: EMBED_TARGET, embeddedAt: new Date() } }, EMBED)).toBe(true);
    expect(contentWriteAllowed("Section", "updateMany", { data: { embeddedAt: new Date() } }, EMBED)).toBe(true);
  });

  it("refuses everything else under EMBED=1", () => {
    expect(contentWriteAllowed("Section", "update", { data: { titleEn: "x" } }, EMBED)).toBe(false);
    expect(contentWriteAllowed("Section", "update", { data: { embedding: [0.1], titleEn: "x" } }, EMBED)).toBe(false);
    expect(contentWriteAllowed("Section", "update", { data: {} }, EMBED)).toBe(false);
    expect(contentWriteAllowed("Section", "update", {}, EMBED)).toBe(false);
    expect(contentWriteAllowed("Section", "update", { data: [{ embedding: [0.1] }] }, EMBED)).toBe(false);
    expect(contentWriteAllowed("Section", "delete", { where: { id: "x" } }, EMBED)).toBe(false);
    expect(contentWriteAllowed("Section", "create", { data: { embeddingModel: EMBED_TARGET } }, EMBED)).toBe(false);
    expect(contentWriteAllowed("Figure", "update", { data: { embeddingModel: EMBED_TARGET } }, EMBED)).toBe(false);
    expect(contentWriteAllowed("Section", "update", "not a record", EMBED)).toBe(false);
  });
});
