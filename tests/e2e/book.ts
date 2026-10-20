import { expect, type Page } from "@playwright/test";

import type { E2eLocale } from "@/lib/schemas/e2e";

import { reaches, sectionPath, type Catalogue } from "./support";

/*
 * The book as the suite moves through it (unit 23d). Nothing here knows a chapter number or a section count: the
 * chapters are the tiles Book Home shows, a chapter's sections are the ones its outline lists, and the suite goes
 * from one to the next with the reader's own keys — `j` inside a chapter, `]` across to the next one.
 */

const OUTLINE = "ul.outline-layers a";
const CURRENT = `${OUTLINE}[aria-current=location] .n`;

/** The book's chapters in order, as Book Home lists them: `["00", "01", …]`. Leaves the page on Book Home. */
export async function chaptersOf(page: Page, locale: E2eLocale): Promise<ReadonlyArray<string>> {
  await page.goto(`/${locale}`);
  const hrefs = await page.locator("a.tile-title").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  return hrefs.flatMap((href) => {
    const chapter = /\/ch\/(\d{2})$/.exec(href)?.[1];
    return chapter === undefined ? [] : [chapter];
  });
}

/** The sections of the chapter on screen, in the outline's order. Waits for the outline to be that chapter's. */
export async function sectionsOf(page: Page, chapter: string): Promise<ReadonlyArray<string>> {
  await expect(page.locator(CURRENT)).toHaveText(new RegExp(`^${chapter}\\.`));
  return page.locator(`${OUTLINE} .n`).evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim() ?? ""));
}

/** The reader is on `section`: the outline marks it and its heading is there. A URL alone changes before the page does. */
export async function settled(page: Page, section: string): Promise<void> {
  await expect(page.locator(CURRENT)).toHaveText(section);
  await expect(page.locator("h2.section-title")).toBeVisible();
}

/**
 * A page that has just loaded answers a key only once its client code is live. `?` is asked until the keyboard map
 * shows, then the map is closed: after this the page's keys and its prose's clicks are the product's, not the
 * browser's.
 */
export async function awake(page: Page, m: Catalogue): Promise<void> {
  const map = page.getByRole("dialog", { name: m.reader.keys.mapLabel, exact: true });
  await expect(async () => {
    if (!(await map.isVisible())) await page.keyboard.press("?");
    await expect(map).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(map).toBeHidden();
}

/** Press a key that should take the reader to `section`; false when it did not. */
export async function keyTo(page: Page, key: string, locale: E2eLocale, section: string): Promise<boolean> {
  await page.keyboard.press(key);
  const marked = page.locator(CURRENT).filter({ hasText: new RegExp(`^${section.replace(".", "\\.")}$`) });
  if (!(await reaches(marked, "visible", 15_000))) return false;
  return new URL(page.url()).pathname === sectionPath(locale, section);
}

/** Press a key that has nowhere to go from here; true when the reader stayed. */
export async function keyStays(page: Page, key: string): Promise<boolean> {
  const before = page.url();
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
  return page.url() === before;
}

export interface BookPage {
  readonly chapter: string;
  readonly section: string;
  /** Positions in the book's chapters and in the chapter's sections. */
  readonly chapterIndex: number;
  readonly sectionIndex: number;
  readonly chapters: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<string>;
  /** The first section of the chapter before this one; null in the book's first chapter. */
  readonly previousChapterStart: string | null;
  /** The book's last reader page. */
  readonly last: boolean;
}

export interface WalkHooks {
  /** Called on every reader page, once, with the page settled. It must leave the reader on that page. */
  readonly visit: (at: BookPage) => Promise<void>;
  /** Called after each move the walk makes with a key: `j` to the next section, `]` to the next chapter. */
  readonly moved?: (key: "j" | "]", from: string, to: string, worked: boolean) => void;
}

/**
 * Every reader page of the book, in order, reached with the keyboard: from the first chapter's first section, `j`
 * until the chapter ends and `]` into the next. A key that does not move is reported and the walk goes on by
 * address, so one dead key costs one finding and not the rest of the book.
 */
export async function walkBook(page: Page, locale: E2eLocale, m: Catalogue, hooks: WalkHooks): Promise<void> {
  const chapters = await chaptersOf(page, locale);
  expect(chapters.length, "Book Home lists the chapters").toBeGreaterThan(0);
  const arrive = async (section: string): Promise<void> => {
    await page.goto(sectionPath(locale, section));
    await settled(page, section);
    await awake(page, m);
  };

  await page.goto(`/${locale}/ch/${chapters[0] ?? ""}`);
  let previousChapterStart: string | null = null;
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const sections = await sectionsOf(page, chapter);
    const start = sections[0] ?? "";
    if (chapterIndex === 0) await awake(page, m);
    for (const [sectionIndex, section] of sections.entries()) {
      await settled(page, section);
      const last = chapterIndex === chapters.length - 1 && sectionIndex === sections.length - 1;
      await hooks.visit({ chapter, section, chapterIndex, sectionIndex, chapters, sections, previousChapterStart, last });
      const next = sections[sectionIndex + 1];
      if (next === undefined) continue;
      const worked = await keyTo(page, "j", locale, next);
      hooks.moved?.("j", section, next, worked);
      if (!worked) await arrive(next);
    }
    previousChapterStart = start;
    const nextChapter = chapters[chapterIndex + 1];
    if (nextChapter === undefined) continue;
    /* A chapter opens at its first section (feature-specs/03 § 11 D4). */
    const to = `${nextChapter}.1`;
    const worked = await keyTo(page, "]", locale, to);
    hooks.moved?.("]", sections[sections.length - 1] ?? chapter, to, worked);
    if (!worked) await arrive(to);
  }
}
