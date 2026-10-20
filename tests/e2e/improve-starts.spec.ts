import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { E2E_LOCALES } from "@/lib/schemas/e2e";

import { accountSession, axeFindings, CATALOGUES, fill, openDialog, VIEWPORT, type Account } from "./support";

/*
 * Improve's two starts (feature-specs/48 § 10, § 20, § 26; unit 76), in EN and PT, under accounts of the suite's own:
 *
 * - signed out, the landing page offers `New suggestion`, which leads to the sign-in and back, and no `From a research`;
 * - a verified contributor chooses a chapter, then a section, and lands on step 1 at that section; `← chapters` goes
 *   back; the status bar names the chapter; at 1440 and 390 nothing scrolls sideways;
 * - a reader and an unverified contributor read step 1's notice at the chooser's top and no list;
 * - `From a research` on the landing page for the person whose research found something (the research seed's rows,
 *   `npm run research:seed -- --page --account …`): the head's link to it, each finding's research linked to its run,
 *   its anchor and its kind of change; a reader's `Send to Improve` confirmed, then `sending to Improve` with the focus on
 *   it and `sent · being checked by Improve` in the same row, from the run's own view served as Improve would move it; a
 *   verified contributor's `Draft it in Improve` with its help line, the draft posted with its key and the page's
 *   language, and the page at the edit page the answer names; an account with nothing unused sees neither the section
 *   nor its link; a finding's research opens the Research page with the column at its run, not at the newest.
 *
 * Every press is answered in the page: a real send starts `SendFindingWorkflow` and a real draft its gradings, which this
 * suite must not. A guard on each context refuses any other write to the findings' endpoints, and each test asserts none
 * was tried. Axe on every state. A throttled contributor's notices are the database suite's (`improve-starts`), since no
 * page makes an account throttled. It leaves no part for the report: it measures no criterion of a gate.
 */

const READER: Account = { email: "e2e-starts-reader@harness-bible.local", role: "READER", verified: true };
const CONTRIBUTOR: Account = { email: "e2e-starts-contributor@harness-bible.local", role: "CONTRIBUTOR", verified: true };
const UNVERIFIED: Account = { email: "e2e-starts-unverified@harness-bible.local", role: "CONTRIBUTOR", verified: false };
const PHONE = { width: 390, height: 844 } as const;

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  /* each account exists once it has signed in; then the seed writes its research, with no model and no workflow */
  for (const [name, account] of [["starts-reader", READER], ["starts-contributor", CONTRIBUTOR]] as const) {
    await accountSession(browser, baseURL, name, account);
    execFileSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), join("scripts", "research-seed.ts"), "--page", "--account", account.email, "--report", join("test-results", `${name}-seed.json`)], { stdio: "pipe", env: process.env, timeout: 150_000 });
  }
  await accountSession(browser, baseURL, "starts-unverified", UNVERIFIED);
});

/** A context of one of the suite's accounts (or signed out), with the guard: a write to a finding that no test answers is refused and recorded. */
async function opened(browser: Browser, baseURL: string | undefined, path: string, as: { readonly name: string; readonly account: Account } | null, viewport: { readonly width: number; readonly height: number } = VIEWPORT): Promise<{ readonly context: BrowserContext; readonly page: Page; readonly unanswered: string[] }> {
  const context = await browser.newContext({ baseURL, viewport });
  const unanswered: string[] = [];
  await context.route("**/api/v1/research/findings/**", (route) => {
    if (route.request().method() === "GET") return route.continue();
    unanswered.push(`${route.request().method()} ${route.request().url()}`);
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  if (as !== null) await context.addCookies(await accountSession(browser, baseURL, as.name, as.account));
  const page = await context.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  return { context, page, unanswered };
}

async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const locale of E2E_LOCALES) {
  const m = CATALOGUES[locale];

  test(`improve starts · ${locale} · signed out: New suggestion leads to the sign-in and back, and no From a research`, async ({ browser, baseURL }) => {
    const { context, page } = await opened(browser, baseURL, `/${locale}/improve`, null);
    try {
      await expect(page.getByRole("link", { name: m.improve.home.new, exact: true })).toHaveAttribute("href", `/${locale}/improve/new`);
      await expect(page.locator("#from-research")).toHaveCount(0);
      await expect(page.locator('a[href="#from-research"]')).toHaveCount(0);
      expect(await axeFindings(page, `improve-starts-out-${locale}`)).toEqual([]);
      await page.goto(`/${locale}/improve/new?ch=21`);
      await page.waitForURL((url) => url.pathname === `/${locale}/login` && url.searchParams.get("next") === `/${locale}/improve/new?ch=21`);
    } finally {
      await context.close();
    }
  });

  test(`improve starts · ${locale} · a verified contributor: a chapter, then a section, then step 1 at that section`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const { context, page, unanswered } = await opened(browser, baseURL, `/${locale}/improve`, { name: "starts-contributor", account: CONTRIBUTOR });
    try {
      await page.getByRole("link", { name: m.improve.home.new, exact: true }).click();
      await page.waitForURL((url) => url.pathname === `/${locale}/improve/new` && url.search === "");
      await expect(page.getByRole("heading", { level: 1, name: m.improve.new.title })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: m.improve.new.chapters })).toBeVisible();
      /* the parts' captions as Book Home prints them, every chapter of the release under one */
      await expect(page.getByRole("heading", { level: 3, name: fill(m.home.part.cap, { roman: "ii", title: m.home.part.title.P2 }) })).toBeVisible();
      await expect(page.locator(".improve-new-list a")).toHaveCount(41);
      await expect(page.locator(".statusbar")).toContainText(m.improve.new.statusbarNone);
      expect(await axeFindings(page, `improve-new-chapters-${locale}`)).toEqual([]);

      await page.getByRole("link", { name: /^21 · / }).click();
      await page.waitForURL((url) => url.pathname === `/${locale}/improve/new` && url.searchParams.get("ch") === "21");
      await expect(page.getByRole("heading", { level: 2, name: fill(m.improve.new.sections, { n: "21" }) })).toBeVisible();
      const sections = page.locator(".improve-new-list a");
      await expect(sections).toHaveCount(9);
      await expect(sections.first()).toHaveAttribute("href", `/${locale}/ch/21/improve/new?anchor=21.1`);
      await expect(page.locator(".statusbar")).toContainText(fill(m.improve.new.statusbar, { n: "21" }));
      expect(await axeFindings(page, `improve-new-sections-${locale}`)).toEqual([]);

      await page.getByRole("link", { name: m.improve.new.back, exact: true }).click();
      await page.waitForURL((url) => url.pathname === `/${locale}/improve/new` && url.search === "");
      await page.goto(`/${locale}/improve/new?ch=21`, { waitUntil: "networkidle" });
      await page.getByRole("link", { name: /^21\.3 · / }).click();
      await page.waitForURL((url) => url.pathname === `/${locale}/ch/21/improve/new` && url.searchParams.get("anchor") === "21.3");
      await expect(page.getByRole("heading", { level: 1, name: m.improve.suggest.title })).toBeVisible();
      await expect(page.getByRole("group", { name: m.improve.suggest.kindLabel }).locator("a[aria-current=true]")).toHaveText(m.improve.suggest.kind.SECTION);

      /* a phone: one column of rows, nothing sideways */
      await page.setViewportSize(PHONE);
      for (const path of [`/${locale}/improve/new`, `/${locale}/improve/new?ch=21`]) {
        await page.goto(path, { waitUntil: "networkidle" });
        expect(await sideways(page), path).toBeLessThanOrEqual(0);
        expect(await axeFindings(page, `improve-new-phone-${locale}`)).toEqual([]);
      }
      expect(unanswered).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`improve starts · ${locale} · a reader and an unverified contributor: step 1's notice at the chooser's top, and no list`, async ({ browser, baseURL }) => {
    for (const [as, title] of [
      [{ name: "starts-reader", account: READER }, m.improve.suggest.role.title],
      [{ name: "starts-unverified", account: UNVERIFIED }, m.improve.suggest.unverified.title],
    ] as const) {
      const { context, page } = await opened(browser, baseURL, `/${locale}/improve/new?ch=21`, as);
      try {
        await expect(page.locator("main .notice").first()).toContainText(title);
        await expect(page.locator(".improve-new-list")).toHaveCount(0);
        expect(await axeFindings(page, `improve-new-${as.name}-${locale}`)).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  test(`improve starts · ${locale} · From a research: a reader's Send to Improve, confirmed and followed in its row`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const { context, page, unanswered } = await opened(browser, baseURL, `/${locale}/improve`, { name: "starts-reader", account: READER });
    try {
      const section = page.getByRole("region", { name: m.improve.home.fromResearch.title });
      await expect(page.locator('main a[href="#from-research"]')).toHaveText(m.improve.home.fromResearch.title);
      await expect(section).toHaveAttribute("id", "from-research");
      const rows = section.locator("[data-finding-row]");
      await expect(rows).toHaveCount(2);
      const row = rows.first();
      const findingId = (await row.getAttribute("data-finding-row")) ?? "";
      const research = row.locator("td").first().getByRole("link");
      await expect(research).toHaveText("ch21");
      const href = (await research.getAttribute("href")) ?? "";
      expect(href).toMatch(new RegExp(`^/${locale}/research\\?research=[0-9a-f-]{36}#run-[0-9a-f-]{36}$`));
      const runId = href.split("#run-")[1] ?? "";
      await expect(row).toContainText("21.3");
      await expect(row).toContainText(m.improve.suggest.edit.kindCap.ADD_CLAIM);
      await expect(section).toContainText(m.improve.home.fromResearch.kept);
      await expect(section.getByRole("button", { name: m.research.findings.draft, exact: true })).toHaveCount(0);
      expect(await axeFindings(page, `improve-from-research-${locale}`)).toEqual([]);

      /* the send answered here, as the endpoint would; the run's own view, the finding moved as Improve would move it */
      const posts: Array<string | undefined> = [];
      await page.route(`**/api/v1/research/findings/${findingId}/propose`, async (route) => {
        posts.push(route.request().headers()["idempotency-key"]);
        await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ findingId, use: "SENDING" }) });
      });
      let reads = 0;
      await page.route(`**/api/v1/research/runs/${runId}`, async (route) => {
        reads += 1;
        const view = (await (await route.fetch()).json()) as { findings: Array<{ id: string; use: unknown }> };
        const findings = view.findings.map((each) => (each.id === findingId && reads > 1 ? { ...each, use: { state: "SENT", suggestionId: null, href: null, failure: null } } : each));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...view, findings }) });
      });
      const dialog = page.getByRole("dialog", { name: m.research.findings.sendTitle });
      await openDialog(row.getByRole("button", { name: m.research.findings.send, exact: true }), dialog);
      await expect(dialog.getByRole("button", { name: m.research.findings.sendCancel, exact: true })).toBeFocused();
      await dialog.getByRole("button", { name: m.research.findings.sendConfirm, exact: true }).click();
      const line = row.locator(".finding-use");
      await expect(line).toHaveText(m.research.findings.sending);
      await expect(line).toBeFocused();
      await expect(line).toHaveText(m.research.findings.sent);
      /* the row stays, with what became of its finding; the page was not reloaded under it */
      await expect(rows).toHaveCount(2);
      expect(posts).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string]);
      expect(await axeFindings(page, `improve-from-research-sent-${locale}`)).toEqual([]);

      await page.setViewportSize(PHONE);
      await page.goto(`/${locale}/improve`, { waitUntil: "networkidle" });
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(await axeFindings(page, `improve-from-research-phone-${locale}`)).toEqual([]);
      expect(unanswered).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`improve starts · ${locale} · From a research: a finding's research opens the Research page at its run, not at the newest`, async ({ browser, baseURL }) => {
    const { context, page } = await opened(browser, baseURL, `/${locale}/improve`, { name: "starts-reader", account: READER });
    try {
      const research = page.locator("#from-research [data-finding-row]").first().locator("td").first().getByRole("link");
      const runId = ((await research.getAttribute("href")) ?? "").split("#run-")[1] ?? "";
      await research.click();
      await page.waitForURL((url) => url.pathname === `/${locale}/research` && url.hash === `#run-${runId}`);
      const run = page.locator(`article.run#run-${runId}`);
      await expect(run).toBeVisible();
      /* the seed's done research has a follow-up after this run: the column lands on the run named, its head in view */
      await expect(async () => {
        const where = await run.evaluate((article) => {
          const log = article.closest('[role="log"]');
          return log === null ? null : article.getBoundingClientRect().top - log.getBoundingClientRect().top;
        });
        expect(where).not.toBeNull();
        expect(where ?? -1).toBeGreaterThanOrEqual(0);
        expect(where ?? 999).toBeLessThan(40);
      }).toPass({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  });

  test(`improve starts · ${locale} · From a research: a verified contributor's Draft it in Improve, and nothing for an account with no finding`, async ({ browser, baseURL }) => {
    const { context, page, unanswered } = await opened(browser, baseURL, `/${locale}/improve`, { name: "starts-contributor", account: CONTRIBUTOR });
    try {
      const row = page.locator("#from-research [data-finding-row]").first();
      const findingId = (await row.getAttribute("data-finding-row")) ?? "";
      const button = row.getByRole("button", { name: m.research.findings.draft, exact: true });
      await expect(button).toHaveAccessibleDescription(m.research.findings.draftHelp);
      await expect(row.getByRole("button", { name: m.research.findings.send, exact: true })).toHaveCount(0);
      expect(await axeFindings(page, `improve-from-research-draft-${locale}`)).toEqual([]);
      const href = `/${locale}/improve/S-21-0999/edit`;
      const posts: Array<{ readonly key: string | undefined; readonly body: string | null }> = [];
      await page.route(`**/api/v1/research/findings/${findingId}/draft`, async (route) => {
        posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ suggestionId: "S-21-0999", href, items: 2 }) });
      });
      await button.click();
      await page.waitForURL((url) => url.pathname === href);
      expect(posts).toEqual([{ key: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string, body: JSON.stringify({ locale }) }]);
      expect(unanswered).toEqual([]);
    } finally {
      await context.close();
    }
    const none = await opened(browser, baseURL, `/${locale}/improve`, { name: "starts-unverified", account: UNVERIFIED });
    try {
      await expect(none.page.getByRole("link", { name: m.improve.home.new, exact: true })).toBeVisible();
      await expect(none.page.locator("#from-research")).toHaveCount(0);
      await expect(none.page.locator('a[href="#from-research"]')).toHaveCount(0);
    } finally {
      await none.context.close();
    }
  });
}
