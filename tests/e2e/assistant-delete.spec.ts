import { expect, test } from "@playwright/test";

import { E2E_LOCALES } from "@/lib/schemas/e2e";

import { accountSession, axeFindings, CATALOGUES, openDialog, VIEWPORT, type Account } from "./support";

/*
 * Deleting a conversation from the assistant's page (feature-specs/45 § 3.9; unit 62i), in EN and PT, under an account
 * of its own: `Delete conversation` in the open conversation's block, the dialog and its words, cancelled with focus
 * back on the trigger and the conversation still there, then confirmed — the page again without it and with
 * `?deleted=<id>`, the column's head saying so and `New conversation` taking focus, the conversation's read a 404, and
 * Back showing the list without it — and, between 1000px and 1359px, the conversations overlay standing open to show
 * it. axe on the dialog and on the page after. The conversation has no turn, made through the API: a turn would ask a
 * model, and the button shows whether or not a conversation has turns (45 § 3.9). And one the page made itself, by a
 * walk refused at its inputs before anything was written, deleted with the dock's session gone with it (review of
 * unit 62).
 *
 * It leaves no part for the report: it measures no criterion of a gate.
 */

const DELETER: Account = { email: "e2e-assistant-delete@harness-bible.local" };

for (const locale of E2E_LOCALES) {
  test(`assistant · ${locale} · Delete conversation: the dialog, the page after it, focus on New conversation (45 § 3.9)`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const m = CATALOGUES[locale].assistant;
    const origin = new URL(baseURL ?? "").origin;
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    let id: string | null = null;
    try {
      await context.addCookies(await accountSession(browser, baseURL, "assistant-delete", DELETER));
      const created = await context.request.post("/api/v1/assistant/conversations", { headers: { origin }, data: { locale } });
      expect(created.ok()).toBe(true);
      id = ((await created.json()) as { id: string }).id;
      const conversation = id;
      const page = await context.newPage();
      /* opened from the list, so that Back has an entry that listed it */
      await page.goto(`/${locale}/assistant`, { waitUntil: "networkidle" });
      const column = page.locator(".assistant-conversations");
      const row = column.locator(`a[href*="ask=${conversation}"]`);
      await row.click();
      await page.waitForURL(`**/${locale}/assistant?ask=${conversation}`);
      const trigger = column.getByRole("button", { name: m.delete.trigger, exact: true });
      /* a conversation that cites nothing is named by no chapter */
      const dialog = page.getByRole("dialog", { name: m.delete.titleNone });

      /* opened, its words, nothing for axe; cancelled, the focus back on the trigger and the conversation still there */
      await openDialog(trigger, dialog);
      await expect(dialog).toContainText(m.delete.body);
      expect(await axeFindings(page, `assistant-delete-dialog-${locale}`)).toEqual([]);
      await dialog.getByRole("button", { name: m.delete.cancel, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect((await context.request.get(`/api/v1/assistant/conversations/${conversation}`)).status()).toBe(200);

      /* confirmed: the page without it, saying so, and New conversation in focus with that line as its description */
      await openDialog(trigger, dialog);
      await dialog.getByRole("button", { name: m.delete.confirm, exact: true }).click();
      await page.waitForURL(`**/${locale}/assistant?deleted=${conversation}`);
      await expect(column.getByRole("status")).toHaveText(m.delete.done);
      const fresh = column.getByRole("link", { name: m.dock.newConversation, exact: true });
      await expect(fresh).toBeFocused();
      await expect(fresh).toHaveAccessibleDescription(m.delete.done);
      expect((await context.request.get(`/api/v1/assistant/conversations/${conversation}`)).status()).toBe(404);
      expect(await axeFindings(page, `assistant-deleted-${locale}`)).toEqual([]);
      id = null;
      /* Back asks the server: the list it shows no longer has the conversation (review of unit 62) */
      await page.goBack({ waitUntil: "networkidle" });
      await expect(column.getByRole("link", { name: m.dock.newConversation, exact: true })).toBeVisible();
      await expect(row).toHaveCount(0);
    } finally {
      if (id !== null) await context.request.delete(`/api/v1/assistant/conversations/${id}`, { headers: { origin } });
      await context.close();
    }
  });
}

test("assistant · en · after a delete, between 1000px and 1359px, the conversations overlay stands open to say so (45 § 3.9)", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.assistant;
  const context = await browser.newContext({ baseURL, viewport: { width: 1200, height: 900 } });
  try {
    await context.addCookies(await accountSession(browser, baseURL, "assistant-delete", DELETER));
    const page = await context.newPage();
    await page.goto("/en/assistant?deleted=00000000-0000-4000-8000-0000000062e1", { waitUntil: "networkidle" });
    const column = page.locator(".assistant-conversations");
    await expect(column).toBeVisible();
    await expect(column.getByRole("status")).toHaveText(m.delete.done);
    await expect(column.getByRole("link", { name: m.dock.newConversation, exact: true })).toBeFocused();
    expect(await axeFindings(page, "assistant-deleted-1200")).toEqual([]);
    /* its backdrop closes it, as the toggle's overlay always closes */
    await page.locator(".log-backdrop.is-open").click({ position: { x: 900, y: 400 } });
    await expect(column).toBeHidden();
  } finally {
    await context.close();
  }
});

test("assistant · en · a conversation the page made itself, by a walk refused at its inputs, deleted with the dock's session (45 § 3.9; review of unit 62)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const m = CATALOGUES.en.assistant;
  const origin = new URL(baseURL ?? "").origin;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  const made: string[] = [];
  try {
    await context.addCookies(await accountSession(browser, baseURL, "assistant-delete", DELETER));
    const page = await context.newPage();
    await page.goto("/en/assistant", { waitUntil: "networkidle" });
    /* a walk at an input out of its range: the conversation is made, then the run is refused before anything is written, and no model is asked */
    const refusedWalk = async (): Promise<string> => {
      await page.locator(".dock-mode-row [role=radio]").nth(2).click();
      const input = page.locator("#walk-form input").first();
      await input.fill("999999999999");
      await page.getByRole("button", { name: m.walk.run, exact: true }).click();
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await page.waitForURL(/[?&]ask=/);
      const ask = new URL(page.url()).searchParams.get("ask") ?? "";
      made.push(ask);
      return ask;
    };
    const first = await refusedWalk();
    const column = page.locator(".assistant-conversations");
    const dialog = page.getByRole("dialog", { name: m.delete.titleNone });
    await openDialog(column.getByRole("button", { name: m.delete.trigger, exact: true }), dialog);
    await dialog.getByRole("button", { name: m.delete.confirm, exact: true }).click();
    await page.waitForURL(`**/en/assistant?deleted=${first}`);
    /* the session went with it: no dialog, no row, focus on New conversation */
    await expect(dialog).toHaveCount(0);
    await expect(column.locator(`a[href*="ask=${first}"]`)).toHaveCount(0);
    await expect(column.getByRole("link", { name: m.dock.newConversation, exact: true })).toBeFocused();
    expect((await context.request.get(`/api/v1/assistant/conversations/${first}`)).status()).toBe(404);
    /* the next run makes a conversation of its own rather than post to the one deleted */
    const second = await refusedWalk();
    expect(second).not.toBe(first);
  } finally {
    for (const id of made) await context.request.delete(`/api/v1/assistant/conversations/${id}`, { headers: { origin } });
    await context.close();
  }
});
