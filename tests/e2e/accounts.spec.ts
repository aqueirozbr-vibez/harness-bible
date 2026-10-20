import { expect, test } from "@playwright/test";

import { accountSession, axeFindings, CATALOGUES, CONTRIBUTOR, CURATOR, onPath, READER, signIn, SWITCHER, VIEWPORT, type Account } from "./support";

/*
 * The suite's three accounts (unit 46e; feature-specs/29 § 6.4). The flows of Improve are written as a contributor
 * and as a curator, and those accounts exist only because the development sign-in can be asked for a role. This
 * signs each in through a browser and reads back who the product says they are, from the API and from the account
 * page, so that a flow which later fails as "not a curator" is failing for its own reason and not for this one.
 *
 * And the account page's role switch (29 § 16), which is that same sign-in behind a row of segments: a fourth
 * account, whose role is this spec's to change, is walked from reader to curator and back.
 *
 * It leaves no part for the report: it measures no criterion of a gate.
 */

const m = CATALOGUES.en;

const ACCOUNTS: ReadonlyArray<readonly [string, Account, "READER" | "CONTRIBUTOR" | "CURATOR"]> = [
  ["accounts-contributor", CONTRIBUTOR, "CONTRIBUTOR"],
  ["accounts-curator", CURATOR, "CURATOR"],
  ["accounts-reader", { email: READER }, "READER"],
];

for (const [name, account, role] of ACCOUNTS) {
  test(`the suite's ${role.toLowerCase()} signs in as a ${role.toLowerCase()}`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    try {
      await context.addCookies(await accountSession(browser, baseURL, name, account));
      const me = await context.request.get("/api/v1/me");
      expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({ email: account.email, role });

      const page = await context.newPage();
      const response = await page.goto("/en/account");
      expect(response?.status()).toBe(200);
      await expect(page.getByText(`${account.email} · ${m.account.role[role]}`, { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test("the account page's role switch changes a development account's role, and says which it has", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    const role = async (): Promise<unknown> => ((await (await context.request.get("/api/v1/me")).json()) as { readonly role?: unknown }).role;
    const group = page.getByRole("group", { name: m.account.profile.role, exact: true });

    /* Whatever an earlier run left it as, it starts a reader: three sign-ins in all, of the ten a minute the endpoint allows. */
    await signIn(page, SWITCHER, "/en/account", { role: "READER" });
    await page.waitForURL(onPath("/en/account"));
    await expect(group.getByRole("link")).toHaveText([m.account.role.READER, m.account.role.BUILDER, m.account.role.CONTRIBUTOR, m.account.role.CURATOR, m.account.role.ORG_ADMIN]);
    await expect(group.locator("[aria-current]")).toHaveText([m.account.role.READER]);
    expect(await axeFindings(page, "account with the role switch")).toEqual([]);

    await group.getByRole("link", { name: m.account.role.CURATOR, exact: true }).click();
    await page.waitForURL(onPath("/en/account"));
    await expect(group.locator("[aria-current]")).toHaveText([m.account.role.CURATOR]);
    await expect(page.getByText(`${SWITCHER} · ${m.account.role.CURATOR}`, { exact: true })).toBeVisible();
    expect(await role()).toBe("CURATOR");

    await group.getByRole("link", { name: m.account.role.READER, exact: true }).click();
    await page.waitForURL(onPath("/en/account"));
    await expect(group.locator("[aria-current]")).toHaveText([m.account.role.READER]);
    expect(await role()).toBe("READER");
  } finally {
    await context.close();
  }
});
