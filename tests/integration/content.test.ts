import { describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/db/client";
import { getChapterData, getCurrentRelease, getHomeData, getPeek } from "@/lib/db/content";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/*
 * Runs against the ingested release when DATABASE_URL is set (feature-specs/04 § 10);
 * skipped otherwise, so `npm test` stays green on a machine without the database.
 * Counts are the ones the ingestion report prints for chapter 21.
 */
const hasDatabase = env.DATABASE_URL !== undefined;

describe.skipIf(!hasDatabase)("content loaders against the release database", () => {
  it("has exactly one current release with a 40-hex tree sha", async () => {
    const release = await getCurrentRelease();
    expect(release.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await getPrisma().release.count({ where: { isCurrent: true } })).toBe(1);
  });

  it("serves Book Home from the database", async () => {
    const home = await getHomeData("en", null);
    const tiles = home.parts.flatMap((p) => p.chapters);
    expect(home.status.chapters).toBe(tiles.length);
    expect(home.status.chapters).toBe(await getPrisma().chapterVersion.count({ where: { release: { isCurrent: true } } }));
    expect(tiles.every((t) => t.version === "v1.0.0")).toBe(true);
    expect(tiles.find((t) => t.number === 21)?.lab.kind).toBe("reproduced");
    expect(home.continueReading).toBeNull();
    const pt = await getHomeData("pt", null);
    expect(pt.parts[0].chapters[0].href.startsWith("/pt/ch/")).toBe(true);
  });

  it("serves 21.3 with its derived figures, source rows and code pane", async () => {
    const data = await getChapterData("en", 21, "21.3", null);
    expect(data).not.toBeNull();
    expect(data?.section.layer).toBe("WORKED_NUMBERS");
    expect(data?.outline.layers).toHaveLength(9);
    expect(data?.chapter.derivedFigures).toEqual({ linked: 12, total: 12 });
    expect(data?.section.figures.filter((f) => f.tier === "DERIVED").every((f) => f.derive !== null)).toBe(true);
    expect(data?.section.bodyHtml).toContain('href="/en/labs/lab-21/derive.py#L14"');
    expect(data?.section.prev?.id).toBe("21.2");
    expect(data?.section.next?.id).toBe("21.4");
    expect(data?.chapter.lab?.verdict).toBe("REPRODUCED");
    const sources = await getChapterData("en", 21, "21.9", null);
    expect(sources?.section.sourceRows).toHaveLength(10);
    /* the book's Link column (feature-specs/10 § 4): r1 a URL, r4 a doi.org target, r8 a repository path, r9 a dash */
    expect(sources?.section.hasSourceLinks).toBe(true);
    expect(sources?.section.sourceRows[0].link).toEqual({ href: "https://docs.temporal.io/", kind: "url" });
    expect(sources?.section.sourceRows[3].link).toEqual({ href: "https://doi.org/10.1145/38713.38742", kind: "doi" });
    expect(sources?.section.sourceRows[3].doi).toBe("10.1145/38713.38742");
    expect(sources?.section.sourceRows[7].link).toBeNull();
    expect(sources?.section.sourceRows[8].link).toBeNull();
    expect(data?.section.hasSourceLinks).toBe(false);
    expect(await getChapterData("en", 21, "21.0", null)).toBeNull();
    const pt = await getChapterData("pt", 21, "21.3", null);
    expect(pt?.chapter.editionLang).toBe("EN");
    expect(pt?.section.bodyHtml).toContain('href="/pt/labs/lab-21/derive.py#L14"');
  });

  it("resolves peeks for a section, a chapter and a lab", async () => {
    expect((await getPeek("en", "21.3"))?.openHref).toBe("/en/ch/21/21.3");
    expect((await getPeek("en", "ch21"))?.kind).toBe("chapter");
    expect((await getPeek("en", "lab21"))?.openHref).toBe("/en/labs/lab-21");
    expect(await getPeek("en", "99.1")).toBeNull();
  });

  it("refuses content writes outside the pipeline (invariant 3)", async () => {
    const prisma = getPrisma();
    const section = await prisma.section.findFirst({ select: { id: true } });
    expect(section).not.toBeNull();
    await expect(prisma.section.update({ where: { id: section?.id }, data: { titleEn: "x" } })).rejects.toMatchObject({ code: "CONTENT_READ_ONLY" });
    await expect(prisma.release.deleteMany({})).rejects.toBeInstanceOf(AppError);
  });
});
