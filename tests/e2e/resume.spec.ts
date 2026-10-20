import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { E2E_PATHS } from "@/lib/schemas/e2e";

import { awake, keyTo, sectionsOf, settled } from "./book";
import { CATALOGUES, fill, firstLine, onPath, openDialog, readerSession, readRecorded, sectionOf, sectionPath, VIEWPORT, writePart } from "./support";

/*
 * Reading-path resume across two devices (unit 23d; project-overview § Success criteria · Phase 1: "The three
 * reading paths track progress per account; resuming from another device lands on the same section").
 *
 * Two devices are two browser contexts, each with its own session of the suite's reader. On the first the path is
 * started and its second section is read. On the second, which has never opened the book, Book Home's "continue
 * reading" is followed: where it lands is what the part records, next to the section that was read. The paths page
 * of the second device must name the same section.
 *
 * Each path is reset before it is started and after it is measured, so the account holds one path at a time and
 * ends the run with none.
 */

const LOCALE = "en";
const m = CATALOGUES[LOCALE];

async function device(browser: Browser, baseURL: string | undefined, name: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  await context.addCookies(await readerSession(browser, baseURL, name));
  return context;
}

for (const path of E2E_PATHS) {
  test(`resume on another device · ${path}`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const name = m.home.continue.pathName[path];
    const panelOf = (page: Page) => page.getByRole("region", { name: fill(m.paths.path.aria, { name }), exact: true });
    const reset = async (page: Page): Promise<void> => {
      const dialog = page.getByRole("dialog", { name: fill(m.paths.reset.title, { name }), exact: true });
      await openDialog(panelOf(page).getByRole("button", { name: m.paths.reset.label, exact: true }), dialog);
      await dialog.getByRole("button", { name: m.paths.reset.confirm, exact: true }).click();
      await expect(panelOf(page).getByRole("button", { name: m.paths.path.start, exact: true })).toBeVisible();
    };

    let read = "";
    let landed: string | null = null;
    let failure: string | null = null;
    const first = await device(browser, baseURL, "device-1");
    const second = await device(browser, baseURL, "device-2");
    try {
      /* The first device: start the path and read its second section. */
      const reading = await first.newPage();
      await reading.goto(`/${LOCALE}/paths`);
      const start = panelOf(reading).getByRole("button", { name: m.paths.path.start, exact: true });
      await expect(panelOf(reading)).toBeVisible();
      if (!(await start.isVisible())) await reset(reading);
      await start.click();
      await reading.waitForURL((url) => sectionOf(url.href) !== null);
      const opened = sectionOf(reading.url()) ?? "";
      const target = (await sectionsOf(reading, opened.slice(0, 2)))[1] ?? "";
      expect(target, `the path's first chapter has a second section after ${opened}`).not.toBe("");
      await settled(reading, opened);
      await awake(reading, m);
      const recorded = readRecorded(reading, target);
      expect(await keyTo(reading, "j", LOCALE, target), `j from ${opened}`).toBe(true);
      await recorded;
      read = target;

      /* The second device: Book Home's continue reading, followed. */
      const resuming = await second.newPage();
      await resuming.goto(`/${LOCALE}`);
      const resume = resuming.getByRole("region", { name: m.home.continue.label, exact: true }).locator("a.btn-p");
      await expect(resume).toBeVisible();
      await resume.click();
      await resuming.waitForURL((url) => sectionOf(url.href) !== null);
      landed = sectionOf(resuming.url());
      expect(landed, "the section the second device resumed on").toBe(read);
      await resuming.waitForURL(onPath(sectionPath(LOCALE, read)));
      await settled(resuming, read);

      /* And its paths page names the same section for this path. */
      await resuming.goto(`/${LOCALE}/paths`);
      await expect(panelOf(resuming).getByRole("link", { name: fill(m.paths.path.resume, { id: read }), exact: true })).toBeVisible();

      /* Leave the account without the path. */
      await reading.goto(`/${LOCALE}/paths`);
      await reset(reading);
    } catch (error: unknown) {
      failure = firstLine(error);
      throw error;
    } finally {
      writePart({ kind: "resume", path, read, landed, ok: failure === null && read !== "" && landed === read, failure });
      await first.close();
      await second.close();
    }
  });
}
