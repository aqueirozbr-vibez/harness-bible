import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { E2E_LOCALES } from "@/lib/schemas/e2e";

import { accountSession, axeFindings, CATALOGUES, openDialog, VIEWPORT, type Account } from "./support";

/*
 * The Research dock on every page (feature-specs/48 § 12, § 20, § 26; unit 77), in EN and PT, under an account of its
 * own: an individual account with no gateway key, its researches the rows the research seed writes for it (`npm run
 * research:seed -- --page --account …`). Nothing here starts a run: a start's request is answered in the page.
 *
 * - `r` opens the dock where the person is — the home page, a reader section, search, Improve, the account page — with
 *   its question in focus; `r` typed in a field is a letter;
 * - `Esc` closes it to the page's own URL and gives the focus back to what had it when `r` was pressed; a dialog's `Esc`
 *   stands back from the dock's; the close and the backdrop close it too; `Open the Research page` keeps the research;
 *   a section in it opens the reader with the dock still open; the dock has no list and no delete;
 * - one dock at a time: `a` over the Research dock opens the Assistant's in its place, `r` over the Assistant's opens
 *   research's, and a URL with both shows the Assistant's;
 * - the parameters by path: `r` on `/assistant?ask=<id>` keeps the conversation, `a` on `/research?research=<id>` keeps
 *   the research, and `r` on step 1 and on `/rubric?from=21.3` keeps `from`;
 * - a start from the dock puts the research on the page's URL, and one answered 503 gives the question back;
 * - axe with the dock open: empty, a done research beside a reader section, signed out; the overlay at 1440, 1200,
 *   1000 and 768 with no horizontal overflow, and under 768px the phone notice with the Research page and the close.
 *
 * It deletes the research it opens. It leaves no part for the report: it measures no criterion of a gate.
 */

const DOCKER: Account = { email: "e2e-research-dock@harness-bible.local" };
const SEED_REPORT = join("test-results", "research-dock-seed.json");
const QUESTION = "What changed in how long idempotency keys are kept since 21.3 was verified?";

interface Seeded {
  readonly done: string;
  readonly seedConversation: string;
}

let seeded: Seeded;

test.use({ viewport: VIEWPORT });

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  /* the account exists once it has signed in; then the seed writes its researches, with no model and no workflow */
  await accountSession(browser, baseURL, "research-dock", DOCKER);
  execFileSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), join("scripts", "research-seed.ts"), "--page", "--account", DOCKER.email, "--report", SEED_REPORT], { stdio: "pipe", env: process.env, timeout: 150_000 });
  seeded = (JSON.parse(readFileSync(SEED_REPORT, "utf8")) as { research: Seeded }).research;
});

async function opened(browser: Browser, baseURL: string | undefined, path: string, viewport: { readonly width: number; readonly height: number } = VIEWPORT): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
  const context = await browser.newContext({ baseURL, viewport });
  await context.addCookies(await accountSession(browser, baseURL, "research-dock", DOCKER));
  const page = await context.newPage();
  /* no start ever leaves the page: a run's request is answered here, as the endpoint would when the engine is away */
  await page.route("**/api/v1/research/conversations/*/runs", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "RESEARCH_UNAVAILABLE", message: "", traceId: "e2e" }) }) : route.continue(),
  );
  await page.goto(path, { waitUntil: "networkidle" });
  return { context, page };
}

/**
 * A key pressed until the address shows it took: the first press on a page the server has just compiled can come before
 * the key's owner is mounted. The focus leaves any field first, unless the case is about where it was.
 */
async function pressed(page: Page, key: string, until: (url: URL) => boolean, keepFocus = false): Promise<void> {
  await expect(async () => {
    if (!keepFocus) await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press(key);
    await page.waitForURL(until, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

const researchDock = (page: Page) => page.locator('.dock[data-dock="research"]');
const assistantDock = (page: Page) => page.locator('.dock[data-dock="assistant"]');
const query = (page: Page, key: string): string | null => new URL(page.url()).searchParams.get(key);

for (const locale of E2E_LOCALES) {
  test.describe(`research dock · ${locale}`, () => {
    const m = CATALOGUES[locale].research;

    test("`r` opens the dock where the person is, its question in focus, and `r` in a field is a letter (48 § 12, § 26)", async ({ browser, baseURL }) => {
      test.setTimeout(240_000);
      const { context, page } = await opened(browser, baseURL, `/${locale}`);
      try {
        for (const path of [`/${locale}`, `/${locale}/ch/21/21.3`, `/${locale}/search?q=cache`, `/${locale}/improve`, `/${locale}/account`]) {
          await page.goto(path, { waitUntil: "networkidle" });
          await pressed(page, "r", (url) => url.searchParams.get("research") === "1");
          await expect(researchDock(page)).toBeVisible();
          await expect(researchDock(page).getByLabel(m.composer.ask, { exact: true })).toBeFocused();
          expect(new URL(page.url()).pathname, path).toBe(path.split("?")[0]);
          if (path.includes("q=cache")) expect(query(page, "q")).toBe("cache");
          await expect(assistantDock(page)).toHaveCount(0);
        }
        /* a key typed in a field is a letter, never the dock */
        await page.goto(`/${locale}/ch/21/21.3`, { waitUntil: "networkidle" });
        const box = page.locator(".searchbox-input");
        await box.click();
        await page.keyboard.press("r");
        await expect(box).toHaveValue("r");
        await page.waitForTimeout(500);
        expect(query(page, "research")).toBeNull();
      } finally {
        await context.close();
      }
    });

    test("`Esc` closes the dock to the page's URL with the focus back where it was; a dialog's `Esc` stands back; the close, the backdrop, `Open the Research page` and a section's link (48 § 12, § 20)", async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const { context, page } = await opened(browser, baseURL, `/${locale}/marks`);
      try {
        /* the focus on the brand when `r` is pressed, and back on it after the field's `Esc` and the dock's */
        const brand = page.locator("a.brand");
        await brand.focus();
        await pressed(page, "r", (url) => url.searchParams.get("research") === "1", true);
        const field = researchDock(page).getByLabel(m.composer.ask, { exact: true });
        await expect(field).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(field).not.toBeFocused();
        await page.keyboard.press("Escape");
        await page.waitForURL((url) => url.pathname === `/${locale}/marks` && url.search === "");
        await expect(researchDock(page)).toHaveCount(0);
        await expect(brand).toBeFocused();

        /* the close and the backdrop */
        await page.goto(`/${locale}/marks?research=1`, { waitUntil: "networkidle" });
        await researchDock(page).getByRole("button", { name: m.dock.close, exact: true }).click();
        await page.waitForURL((url) => url.search === "");
        await page.goto(`/${locale}/marks?research=1`, { waitUntil: "networkidle" });
        await page.locator(".dock-backdrop.is-over").click({ position: { x: 100, y: 300 } });
        await page.waitForURL((url) => url.search === "");

        /* the done research beside a reader section: the reader's grid as it is, no list, no delete */
        await page.goto(`/${locale}/ch/21/21.3?research=${seeded.done}`, { waitUntil: "networkidle" });
        await expect(researchDock(page).locator("article.run")).toHaveCount(2);
        await expect(page.locator(".reader-dock")).toHaveCount(0);
        await expect(page.locator("nav.assistant-conversations")).toHaveCount(0);
        await expect(researchDock(page).getByRole("button", { name: m.delete.trigger })).toHaveCount(0);
        await expect(researchDock(page).getByRole("link", { name: m.dock.openFull, exact: true })).toHaveAttribute("href", `/${locale}/research?research=${seeded.done}`);

        /* a flag's dialog in the dock: `r` and `a` stand back while it holds the focus (the review of unit 77), and its `Esc` cancels it and the dock stays */
        const dialog = page.getByRole("dialog", { name: m.flag.title.report });
        await openDialog(researchDock(page).locator("article.run").first().getByRole("button", { name: m.flag.report, exact: true }), dialog);
        for (const key of ["r", "a"]) {
          await page.keyboard.press(key);
          await page.waitForTimeout(500);
          await expect(dialog, key).toBeVisible();
          expect(query(page, "research"), key).toBe(seeded.done);
          expect(query(page, "ask"), key).toBeNull();
          await expect(researchDock(page).getByLabel(m.composer.ask, { exact: true }), key).not.toBeFocused();
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await page.waitForTimeout(500);
        expect(query(page, "research")).toBe(seeded.done);
        await expect(researchDock(page)).toBeVisible();

        /* a section in the dock opens the reader with the research still open, and never the Assistant's dock */
        const chip = researchDock(page).locator(".run-report a.cite").first();
        const href = (await chip.getAttribute("href")) ?? "";
        expect(href).toMatch(new RegExp(`^/${locale}/ch/\\d{2}/\\d{2}\\.\\d\\?research=${seeded.done}$`));
        await chip.click();
        await page.waitForURL((url) => `${url.pathname}${url.search}` === href);
        await expect(researchDock(page)).toBeVisible();
        await expect(assistantDock(page)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("one dock at a time: `a` over the Research dock opens the Assistant's in its place, `r` over the Assistant's opens research's, and a URL with both shows the Assistant's (48 § 12)", async ({ browser, baseURL }) => {
      const { context, page } = await opened(browser, baseURL, `/${locale}/marks?research=${seeded.done}`);
      try {
        await pressed(page, "a", (url) => url.searchParams.get("ask") === "1" && !url.searchParams.has("research"));
        await expect(assistantDock(page)).toBeVisible();
        await expect(researchDock(page)).toHaveCount(0);
        await pressed(page, "r", (url) => url.searchParams.get("research") === "1" && !url.searchParams.has("ask"));
        await expect(researchDock(page)).toBeVisible();
        await expect(assistantDock(page)).toHaveCount(0);
        await page.goto(`/${locale}/marks?ask=1&research=1`, { waitUntil: "networkidle" });
        await expect(assistantDock(page)).toBeVisible();
        await expect(researchDock(page)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("the parameters by path: `r` on the Assistant page keeps its conversation, `a` on the Research page keeps its research, each key puts its own column back in front, and `r` keeps `from` (48 § 12)", async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const { context, page } = await opened(browser, baseURL, `/${locale}/assistant?ask=${seeded.seedConversation}`);
      try {
        await pressed(page, "r", (url) => url.searchParams.get("research") === "1" && url.searchParams.get("ask") === seeded.seedConversation);
        await expect(researchDock(page)).toBeVisible();
        /* `a` there: the dock goes, and the page's own column has the focus */
        await pressed(page, "a", (url) => !url.searchParams.has("research") && url.searchParams.get("ask") === seeded.seedConversation);
        await expect(researchDock(page)).toHaveCount(0);
        await expect(assistantDock(page).locator(".dock-textarea")).toBeFocused();

        await page.goto(`/${locale}/research?research=${seeded.done}`, { waitUntil: "networkidle" });
        await pressed(page, "a", (url) => url.searchParams.get("ask") === "1" && url.searchParams.get("research") === seeded.done);
        await expect(assistantDock(page)).toBeVisible();
        await expect(researchDock(page).locator("article.run")).toHaveCount(2);
        /* `r` there: the Assistant's dock goes, and the page's own column has the focus */
        await pressed(page, "r", (url) => !url.searchParams.has("ask") && url.searchParams.get("research") === seeded.done);
        await expect(assistantDock(page)).toHaveCount(0);
        await expect(researchDock(page).getByLabel(m.composer.ask, { exact: true })).toBeFocused();

        for (const path of [`/${locale}/ch/21/improve/new?anchor=21.3&from=21.3`, `/${locale}/rubric?from=21.3`]) {
          await page.goto(path, { waitUntil: "networkidle" });
          await pressed(page, "r", (url) => url.searchParams.get("research") === "1" && url.searchParams.get("from") === "21.3");
          await expect(researchDock(page)).toBeVisible();
        }
      } finally {
        await context.close();
      }
    });

    test("a start from the dock puts the research on the page's URL, and one that did not start gives the question back (48 § 11.3, § 12, § 18)", async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL ?? "").origin;
      const { context, page } = await opened(browser, baseURL, `/${locale}/search?q=cache&research=1`);
      const made: string[] = [];
      try {
        const field = researchDock(page).getByLabel(m.composer.ask, { exact: true });
        await field.fill(QUESTION);
        await researchDock(page).getByRole("button", { name: m.composer.submit, exact: true }).click();
        await page.waitForURL((url) => url.pathname === `/${locale}/search` && /^[0-9a-f-]{36}$/.test(url.searchParams.get("research") ?? ""));
        made.push(query(page, "research") ?? "");
        expect(query(page, "q")).toBe("cache");
        await expect(researchDock(page).locator(".error")).toContainText(m.errors.notStarted);
        await expect(researchDock(page).getByRole("button", { name: m.errors.retry, exact: true })).toBeVisible();
        await expect(field).toHaveValue(QUESTION);
        expect(await axeFindings(page, `research-dock-not-started-${locale}`)).toEqual([]);
      } finally {
        for (const id of made) await context.request.delete(`/api/v1/research/conversations/${id}`, { headers: { origin } });
        await context.close();
      }
    });

    test("axe finds nothing with the dock open: empty, a done research beside a reader section, and signed out with the sign-in notice and the form disabled (48 § 20)", async ({ browser, baseURL }) => {
      const { context, page } = await opened(browser, baseURL, `/${locale}/marks?research=1`);
      try {
        await expect(researchDock(page).locator(".empty")).toBeVisible();
        expect(await axeFindings(page, `research-dock-empty-${locale}`)).toEqual([]);
        await page.goto(`/${locale}/ch/21/21.3?research=${seeded.done}`, { waitUntil: "networkidle" });
        await expect(researchDock(page).locator("article.run")).toHaveCount(2);
        expect(await axeFindings(page, `research-dock-done-${locale}`)).toEqual([]);
      } finally {
        await context.close();
      }
      const out = await browser.newContext({ baseURL, viewport: VIEWPORT });
      try {
        const page = await out.newPage();
        await page.goto(`/${locale}/marks?research=1`, { waitUntil: "networkidle" });
        await expect(researchDock(page).getByRole("link", { name: CATALOGUES[locale].paths.signIn.account })).toBeVisible();
        await expect(researchDock(page).getByLabel(m.composer.ask, { exact: true })).toBeDisabled();
        expect(await axeFindings(page, `research-dock-signed-out-${locale}`)).toEqual([]);
      } finally {
        await out.close();
      }
    });
  });
}

test("research dock · en · the overlay from 768px, beside a reader section too, no horizontal overflow, and the phone notice under 768px (48 § 12)", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.research;
  for (const width of [1440, 1200, 1000, 768, 390]) {
    const { context, page } = await opened(browser, baseURL, `/en/ch/21/21.3?research=${seeded.done}`, { width, height: width < 768 ? 844 : 900 });
    try {
      if (width >= 768) {
        const box = await researchDock(page).boundingBox();
        expect(box, `${String(width)}px`).not.toBeNull();
        expect(Math.round((box?.x ?? 0) + (box?.width ?? 0)), `${String(width)}px`).toBe(width);
        expect(box?.width ?? 0, `${String(width)}px`).toBeLessThanOrEqual(520);
        await expect(page.locator(".dock-backdrop.is-over")).toBeVisible();
        await expect(page.locator(".dock-phone")).toBeHidden();
      } else {
        await expect(researchDock(page)).toBeHidden();
        const phone = page.locator(".dock-phone");
        await expect(phone).toBeVisible();
        await expect(phone).toContainText(m.dock.phoneTitle);
        await expect(phone.getByRole("link", { name: m.dock.openFull, exact: true })).toHaveAttribute("href", `/en/research?research=${seeded.done}`);
        await expect(phone.getByRole("link", { name: m.dock.close, exact: true })).toHaveAttribute("href", "/en/ch/21/21.3");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${String(width)}px`).toBe(0);
    } finally {
      await context.close();
    }
  }
});
