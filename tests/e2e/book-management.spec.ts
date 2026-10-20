import { expect, test } from "@playwright/test";

import { accountSession, axeFindings, CATALOGUES, CONTRIBUTOR, CURATOR, onPath, READER, VIEWPORT, type Account } from "./support";

/*
 * Book management (feature-specs/47; unit 67): the account's page for curators and organisation admins, with Book
 * status, the curator roster and the audit export, which the home and the account page drew until 2026-10-12. A
 * curator reaches it from the account page's head; a contributor sees no button and is answered 404; a visitor
 * signed out is sent to sign in. The home keeps the grid's legend and loses Book status; the Rubric page links to
 * the roster for the page's roles alone.
 *
 * It leaves no part for the report: it measures no criterion of a gate.
 */

const m = CATALOGUES.en;

/** The suite's organisation admin: the page's second role (47 D1), made by the dev sign-in on first use. */
const ORG_ADMIN: Account = { email: "e2e-org-admin@harness-bible.local", role: "ORG_ADMIN" };

test("book management · en · a curator opens it from the account page: Book status without its legend, the roster, the audit export", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    await context.addCookies(await accountSession(browser, baseURL, "book-curator", CURATOR));
    const page = await context.newPage();
    expect((await page.goto("/en/account"))?.status()).toBe(200);
    /* the two instruments are no longer on the account page (47 § 4) */
    await expect(page.locator("#roster")).toHaveCount(0);
    await expect(page.locator("#audit")).toHaveCount(0);

    await page.getByRole("link", { name: m.account.book.open, exact: true }).click();
    await page.waitForURL(onPath("/en/account/book"));
    await expect(page.getByRole("heading", { level: 1, name: m.account.book.title })).toBeVisible();
    await expect(page.getByRole("region", { name: m.home.status.label, exact: true })).toBeVisible();
    /* four cells: the legend stayed on the home (47 D7) */
    await expect(page.locator(".status-cells .status-cell")).toHaveCount(4);
    await expect(page.locator("#roster")).toBeVisible();
    await expect(page.locator("#roster")).toContainText(m.account.roster.visibility);
    await expect(page.locator("#audit")).toBeVisible();
    await expect(page.locator("footer.statusbar")).toContainText(m.account.book.statusbar.replace(" · {name}", ""));
    expect(await axeFindings(page, "book-management-en")).toEqual([]);

    /* the Rubric page links to the roster where it now is */
    await page.goto("/en/rubric");
    await expect(page.locator(`a[href="/en/account/book#roster"]`)).toHaveText(m.rubric.roster);

    await page.goto("/en/account/book");
    await page.getByRole("link", { name: m.account.book.back, exact: true }).click();
    await page.waitForURL(onPath("/en/account"));
  } finally {
    await context.close();
  }
});

test("book management · en · an organisation admin opens it too, and its anchors land on their instruments", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    await context.addCookies(await accountSession(browser, baseURL, "book-org-admin", ORG_ADMIN));
    const page = await context.newPage();
    expect((await page.goto("/en/account"))?.status()).toBe(200);
    await expect(page.getByRole("link", { name: m.account.book.open, exact: true })).toBeVisible();
    for (const anchor of ["#roster", "#audit"]) {
      /* from the account page each time: a navigation that changes only the hash answers no response */
      await page.goto("/en/account");
      expect((await page.goto(`/en/account/book${anchor}`))?.status()).toBe(200);
      await expect(page.locator(anchor)).toBeInViewport();
    }
  } finally {
    await context.close();
  }
});

for (const [name, account] of [
  ["contributor", CONTRIBUTOR],
  ["reader", { email: READER }],
] as const) {
  test(`book management · en · a ${name} has no button, the page answers 404, and the Rubric page has no roster link`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    try {
      await context.addCookies(await accountSession(browser, baseURL, `book-${name}`, account));
      const page = await context.newPage();
      expect((await page.goto("/en/account"))?.status()).toBe(200);
      await expect(page.getByRole("link", { name: m.account.book.open, exact: true })).toHaveCount(0);
      await expect(page.locator("#roster")).toHaveCount(0);
      await expect(page.locator("#audit")).toHaveCount(0);
      expect((await page.goto("/en/account/book"))?.status()).toBe(404);
      await page.goto("/en/rubric");
      await expect(page.locator(`a[href*="#roster"]`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test("book management · en · signed out, the page sends to sign-in, and the home has the grid's legend and no Book status", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto("/en/account/book");
    await page.waitForURL(onPath("/en/login"));
    expect(new URL(page.url()).searchParams.get("next")).toBe("/en/account/book");

    expect((await page.goto("/en"))?.status()).toBe(200);
    await expect(page.getByRole("region", { name: m.home.status.label, exact: true })).toHaveCount(0);
    const legend = page.getByRole("region", { name: m.home.legend.label, exact: true });
    await expect(legend).toBeVisible();
    await expect(legend.locator(".legend-row")).toHaveCount(8);
    expect(await axeFindings(page, "home-legend-en")).toEqual([]);
  } finally {
    await context.close();
  }
});
