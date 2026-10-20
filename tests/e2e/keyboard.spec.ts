import { expect, test } from "@playwright/test";

import { E2E_LOCALES } from "@/lib/schemas/e2e";

import { awake, keyStays, keyTo, settled, walkBook } from "./book";
import { CATALOGUES, firstLine, reaches, sectionPath, VIEWPORT, writePart } from "./support";

/*
 * The keyboard map on every reader page (unit 23d; project-overview § Success criteria · Phase 1: "the global
 * keyboard map works on every reader page"), in EN and in PT.
 *
 * The suite reads the whole book with the keyboard. On every page `?` must show the map and `esc` close it, and the
 * page is left with the key that goes on: `j` to the next section, `]` to the next chapter. The keys that go back
 * are tried once in every chapter (`k` from its second section, `[` from its first), and the rest once in the walk:
 * `/`, that a key typed in a field is a letter and not a shortcut, `g l`, `a`, `r` (the Research dock, and its row in
 * the map; feature-specs/48 § 12), and that a key with nowhere to go stays where it is at the book's two ends. `b` and
 * `n` are a signed-in reader's and belong to the marks flow.
 */

test.use({ viewport: VIEWPORT });

for (const locale of E2E_LOCALES) {
  test(`keyboard map · ${locale}`, async ({ page }) => {
    test.setTimeout(30 * 60_000);
    const m = CATALOGUES[locale];
    const map = page.getByRole("dialog", { name: m.reader.keys.mapLabel, exact: true });
    const keys: Record<string, boolean> = {};
    const failures: string[] = [];
    let walked = 0;
    let helped = 0;
    let labTried = false;
    const note = (key: string, worked: boolean, where: string): void => {
      keys[key] = (keys[key] ?? true) && worked;
      if (!worked) failures.push(`${key} on ${where}`);
    };

    try {
      await walkBook(page, locale, m, {
        moved: (key, from, to, worked) => note(key, worked, `${from} (to ${to})`),
        visit: async (at) => {
          walked += 1;
          const here = sectionPath(locale, at.section);

          /* ? and esc, on every page. */
          await page.keyboard.press("?");
          const shown = await reaches(map, "visible");
          await page.keyboard.press("Escape");
          const closed = await reaches(map, "hidden");
          if (shown && closed) helped += 1;
          else failures.push(`${shown ? "esc" : "?"} on ${at.section}`);

          if (at.chapterIndex === 0 && at.sectionIndex === 0) {
            /* The book's first page: nothing before it. */
            note("k", await keyStays(page, "k"), `${at.section} (the book's first page)`);
            note("[", await keyStays(page, "["), `${at.section} (the book's first chapter)`);

            /* / goes to the search box, and a key typed there is a letter. */
            const box = page.locator(".searchbox-input");
            await page.keyboard.press("/");
            const focused = await box.evaluate((node) => document.activeElement === node);
            await page.keyboard.press("j");
            await page.waitForTimeout(400);
            const typed = (await box.inputValue()) === "j" && new URL(page.url()).pathname === here;
            note("/", focused, at.section);
            note("a key in a field", typed, at.section);
            await box.fill("");
            await box.blur();

            /* a opens the assistant's dock on the page. */
            await page.keyboard.press("a");
            const asked = await page
              .waitForURL((url) => url.pathname === here && url.searchParams.has("ask"), { timeout: 10_000 })
              .then(() => true)
              .catch(() => false);
            note("a", asked, at.section);
            await page.goto(here);
            await settled(page, at.section);
            await awake(page, m);

            /* r opens the Research dock on the page (feature-specs/48 § 12, D4), and the map lists it. */
            await page.keyboard.press("r");
            const researched = await page
              .waitForURL((url) => url.pathname === here && url.searchParams.get("research") === "1", { timeout: 10_000 })
              .then(() => page.locator('.dock[data-dock="research"]').waitFor({ timeout: 10_000 }))
              .then(() => true)
              .catch(() => false);
            note("r", researched, at.section);
            await page.goto(here);
            await settled(page, at.section);
            await awake(page, m);
            await page.keyboard.press("?");
            const listed = (await reaches(map, "visible")) && (await map.locator("tr", { hasText: m.reader.keys.research }).locator(".kbd").allTextContents()).join("") === "r";
            note("r in the map", listed, at.section);
            await page.keyboard.press("Escape");
            await reaches(map, "hidden");
          }

          /* g l, once, from the first chapter that has a lab. */
          if (!labTried && (await page.locator('aside.reader-rail a[href$="/@lab"]').count()) > 0) {
            labTried = true;
            await page.keyboard.press("g");
            await page.keyboard.press("l");
            const opened = await page
              .waitForURL((url) => url.pathname === `/${locale}/ch/${at.chapter}/@lab`, { timeout: 15_000 })
              .then(() => true)
              .catch(() => false);
            note("g l", opened, at.section);
            await page.goto(here);
            await settled(page, at.section);
            await awake(page, m);
          }

          /* k, from the chapter's second section, and back. */
          const first = at.sections[0];
          if (at.sectionIndex === 1 && first !== undefined) {
            note("k", await keyTo(page, "k", locale, first), `${at.section} (to ${first})`);
            note("j", await keyTo(page, "j", locale, at.section), `${first} (to ${at.section})`);
          }

          /* [, from the chapter's first section, and back. */
          if (at.sectionIndex === 0 && at.previousChapterStart !== null) {
            note("[", await keyTo(page, "[", locale, at.previousChapterStart), `${at.section} (to ${at.previousChapterStart})`);
            note("]", await keyTo(page, "]", locale, at.section), `${at.previousChapterStart} (to ${at.section})`);
          }

          /* The book's last page: nothing after it. */
          if (at.last) {
            note("j", await keyStays(page, "j"), `${at.section} (the book's last page)`);
            note("]", await keyStays(page, "]"), `${at.section} (the book's last chapter)`);
          }

          /* Whatever a failed key did, the walk goes on from this page. */
          if (new URL(page.url()).pathname !== here) {
            await page.goto(here);
            await settled(page, at.section);
            await awake(page, m);
          }
        },
      });
    } catch (error: unknown) {
      failures.push(firstLine(error));
      throw error;
    } finally {
      writePart({ kind: "keyboard", locale, walked, helped, keys, failures: failures.slice(0, 50) });
    }
    expect(failures, "keys that did not do what the map says").toEqual([]);
  });
}
