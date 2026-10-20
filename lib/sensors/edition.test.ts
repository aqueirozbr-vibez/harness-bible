import { describe, expect, it } from "vitest";

import type { Citation } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";

import { editionSensor } from "./edition";

/*
 * The edition sensor (feature-specs/13 § 7.2). It has two jobs: catch a defect in retrieval, and tell the reader
 * which edition they are being cited from when it is not their own language.
 */

const citation = (sectionId: string, version = "v1.0.0", editionLang: "EN" | "PT" = "EN"): Citation => ({
  sectionId: parseSectionId(sectionId),
  figureId: null,
  version,
  editionLang,
});

const atVersion = (version: string) => () => version;

describe("the edition sensor (feature-specs/13 § 7.2)", () => {
  it("passes when every citation resolves in one edition at the release's version", () => {
    const result = editionSensor([citation("21.3"), citation("28.1")], "en", atVersion("v1.0.0"));
    expect(result.verdict.verdict).toBe("PASS");
    expect(result.verdict.detail).toBe("2 / 2 citations resolve in EN v1.0.0");
    expect(result.citesEdition).toBe("EN");
    expect(result.mismatch).toBe(false);
  });

  it("says the answer cites another edition when the reader's language is not the edition's", () => {
    /* A Portuguese answer quoting the English book should say so: the PT editions do not exist yet (Reader D6). */
    const result = editionSensor([citation("21.3")], "pt", atVersion("v1.0.0"));
    expect(result.verdict.verdict).toBe("PASS");
    expect(result.citesEdition).toBe("EN");
    expect(result.mismatch).toBe(true);
    expect(result.verdict.data.mismatch).toBe(true);
  });

  it("fails when the citations span two editions, which retrieval should have made impossible", () => {
    const result = editionSensor([citation("21.3", "v1.0.0", "EN"), citation("28.1", "v1.0.0", "PT")], "en", atVersion("v1.0.0"));
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.verdict.detail).toContain("span EN and PT");
  });

  it("fails and names the citation that is not at the release's version", () => {
    const result = editionSensor([citation("21.3", "v0.9.0")], "en", atVersion("v1.0.0"));
    expect(result.verdict.verdict).toBe("FAIL");
    expect(result.verdict.detail).toContain("21.3");
  });

  it("is not applicable when there are no citations, which is a refusal's normal state", () => {
    const result = editionSensor([], "en", atVersion("v1.0.0"));
    expect(result.verdict.verdict).toBe("NA");
    expect(result.citesEdition).toBeNull();
    expect(result.mismatch).toBe(false);
  });
});
