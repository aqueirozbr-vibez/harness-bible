import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { E2E_LOCALES } from "@/lib/schemas/e2e";

import { accountSession, axeFindings, CATALOGUES, CURATOR, VIEWPORT, type Account } from "./support";

/*
 * The Improve landing page (feature-specs/35 § 3, § 9.6; unit 52a), for each of § 3's visitors: signed out, in EN and
 * PT, what Improve is with the rubric's link and the sign-in notice, and no list; a reader, the same without the
 * notice; a contributor, in EN and PT, their own draft first in "Your suggestions", linked to its edit page, and
 * nobody else's; a curator, the queue's line and its link beside their own list. Axe on each. The contributor's draft
 * is made through the API and deleted after, so the account keeps nothing of this suite's.
 *
 * And a suggestion's own page (35 § 4; unit 52b) as far as a draft takes it: the draft goes to its edit page, and a
 * reader, a signed-out visitor and an id that is none find the not-found page. Nothing is submitted, since a submitted
 * suggestion is a record the database keeps: the page's variants are checked by hand against the worked examples
 * (`npm run improve:seed`; spec 35 § 11).
 */

/** This spec's own reader and contributor: the other specs' accounts keep what they keep. */
const READER: Account = { email: "e2e-improve-reader@harness-bible.local", role: "READER", verified: true };
const CONTRIBUTOR: Account = { email: "e2e-improve-contributor@harness-bible.local", role: "CONTRIBUTOR", verified: true };
/** The own-page test's contributor, apart, so its draft never heads the landing tests' list. */
const OWNER: Account = { email: "e2e-improve-owner@harness-bible.local", role: "CONTRIBUTOR", verified: true };

for (const locale of E2E_LOCALES) {
  const m = CATALOGUES[locale].improve.home;

  test(`improve · ${locale} · signed out: what Improve is, the rubric, and the sign-in notice`, async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto(`/${locale}/improve`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();
    await expect(page.locator("main")).toContainText(m.what);
    await expect(page.getByRole("link", { name: m.rubric, exact: true })).toHaveAttribute("href", `/${locale}/rubric`);
    const signIn = page.locator("main").getByRole("link", { name: m.signIn.link, exact: true });
    await expect(signIn).toHaveAttribute("href", new RegExp(`next=${encodeURIComponent(`/${locale}/improve`)}`));
    await expect(page.getByRole("heading", { name: m.own.title })).toHaveCount(0);
    expect(await axeFindings(page, `improve-out-${locale}`)).toEqual([]);
  });

  test(`improve · ${locale} · a contributor: their own draft first, linked to its edit page`, async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const origin = new URL(baseURL ?? "").origin;
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    let id: string | null = null;
    try {
      await context.addCookies(await accountSession(browser, baseURL, "improve-contributor", CONTRIBUTOR));
      const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale } });
      expect(created.ok()).toBe(true);
      id = ((await created.json()) as { id: string }).id;
      const page = await context.newPage();
      await page.goto(`/${locale}/improve`, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 2, name: m.own.title })).toBeVisible();
      const first = page.locator(".improve-home-table tbody tr").first();
      await expect(first.getByRole("link", { name: id, exact: true })).toHaveAttribute("href", `/${locale}/improve/${id}/edit`);
      await expect(first).toContainText("21.3");
      await expect(first).toContainText(m.state.DRAFT);
      await expect(page.getByText(m.signIn.title)).toHaveCount(0);
      await expect(page.getByRole("heading", { name: m.queue.title })).toHaveCount(0);
      expect(await axeFindings(page, `improve-contributor-${locale}`)).toEqual([]);
    } finally {
      if (id !== null) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
      await context.close();
    }
  });
}

test("improve · en · a suggestion's own page and its record: a draft goes to its edit page, and anyone else finds nothing", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const origin = new URL(baseURL ?? "").origin;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  const reader = await browser.newContext({ baseURL, viewport: VIEWPORT });
  const anonymous = await browser.newContext({ baseURL, viewport: VIEWPORT });
  let id: string | null = null;
  try {
    await context.addCookies(await accountSession(browser, baseURL, "improve-owner", OWNER));
    const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" } });
    expect(created.ok()).toBe(true);
    id = ((await created.json()) as { id: string }).id;
    const page = await context.newPage();
    await page.goto(`/en/improve/${id}`, { waitUntil: "networkidle" });
    await expect(page).toHaveURL(new RegExp(`/en/improve/${id}/edit$`));
    /* Its record (52c): a draft has none yet, so the page goes to the edit page, and the JSON read is empty. */
    await page.goto(`/en/improve/${id}/record`, { waitUntil: "networkidle" });
    await expect(page).toHaveURL(new RegExp(`/en/improve/${id}/edit$`));
    const record = await context.request.get(`/api/v1/suggestions/${id}/record`);
    expect(record.ok()).toBe(true);
    expect(await record.json()).toMatchObject({ id, records: [], chain: { ok: true, records: 0, headHash: null, firstBreak: null } });
    /* Nor anything to export (52c, part 2), and nothing is recorded for it. */
    /* An export is a read that writes: asked as the page's own link asks (the 52c review). */
    const exported = await context.request.get(`/api/v1/suggestions/${id}/record/export`, { headers: { "sec-fetch-site": "same-origin" } });
    expect(exported.status()).toBe(404);
    expect(await exported.json()).toMatchObject({ code: "NOTHING_TO_EXPORT" });
    await reader.addCookies(await accountSession(browser, baseURL, "improve-reader", READER));
    const readerPage = await reader.newPage();
    expect((await readerPage.goto(`/en/improve/${id}`))?.status()).toBe(404);
    expect((await readerPage.goto(`/en/improve/${id}/record`))?.status()).toBe(404);
    expect((await reader.request.get(`/api/v1/suggestions/${id}/record`)).status()).toBe(404);
    expect((await reader.request.get(`/api/v1/suggestions/${id}/record/export`, { headers: { "sec-fetch-site": "same-origin" } })).status()).toBe(404);
    expect((await (await anonymous.newPage()).goto(`/en/improve/${id}`))?.status()).toBe(404);
    expect((await (await anonymous.newPage()).goto(`/en/improve/${id}/record`))?.status()).toBe(404);
    expect((await page.goto("/en/improve/not-a-suggestion"))?.status()).toBe(404);
  } finally {
    if (id !== null) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
    await Promise.all([context.close(), reader.close(), anonymous.close()]);
  }
});

test("improve · en · a reader: what Improve is, no notice and no list", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.improve.home;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    await context.addCookies(await accountSession(browser, baseURL, "improve-reader", READER));
    const page = await context.newPage();
    await page.goto("/en/improve", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();
    await expect(page.getByText(m.signIn.title)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: m.own.title })).toHaveCount(0);
    expect(await axeFindings(page, "improve-reader-en")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("improve · en · the curator queue (53b): a curator's page with its rail, and the not-found page for a contributor", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.improve.queue;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  const contributor = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    await context.addCookies(await accountSession(browser, baseURL, "improve-curator", CURATOR));
    const page = await context.newPage();
    expect((await page.goto("/en/improve/queue", { waitUntil: "networkidle" }))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();
    await expect(page.getByRole("complementary", { name: m.rail.label })).toBeVisible();
    expect(await axeFindings(page, "curator-queue-en")).toEqual([]);
    /* an item's row selects it wherever it is clicked, not on its id alone (Andre, 2026-10-11) */
    const rows = page.locator(".queue-table tr.queue-item");
    if ((await rows.count()) > 1) {
      const row = rows.nth(1);
      const id = await row.locator("a.queue-id").innerText();
      /* clicked where a person would, at the anchor cell's middle: the row's link lies over it */
      const cell = await row.locator("td").nth(1).boundingBox();
      expect(cell).not.toBeNull();
      await page.mouse.click((cell?.x ?? 0) + (cell?.width ?? 0) / 2, (cell?.y ?? 0) + (cell?.height ?? 0) / 2);
      await page.waitForURL(`**/en/improve/queue?s=${id}`);
      await expect(page.locator("#queue-detail-title")).toHaveText(id);
      await expect(row).toHaveClass(/is-selected/);
    }
    await contributor.addCookies(await accountSession(browser, baseURL, "improve-contributor", CONTRIBUTOR));
    expect((await (await contributor.newPage()).goto("/en/improve/queue"))?.status()).toBe(404);
  } finally {
    await Promise.all([context.close(), contributor.close()]);
  }
});

test("improve · en · a curator: the queue's line and its link, beside their own list", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.improve.home;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    await context.addCookies(await accountSession(browser, baseURL, "improve-curator", CURATOR));
    const page = await context.newPage();
    await page.goto("/en/improve", { waitUntil: "networkidle" });
    const queue = page.getByRole("region", { name: m.queue.title });
    await expect(queue).toContainText(/queue for your parts/);
    await expect(queue.getByRole("link", { name: m.queue.link, exact: true })).toHaveAttribute("href", "/en/improve/queue");
    await expect(page.getByRole("heading", { level: 2, name: m.own.title })).toBeVisible();
    expect(await axeFindings(page, "improve-curator-en")).toEqual([]);
  } finally {
    await context.close();
  }
});
