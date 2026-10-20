import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { E2E_LOCALES } from "@/lib/schemas/e2e";

import { accountSession, axeFindings, CATALOGUES, CONTRIBUTOR, fill, openDialog, READER, sectionPath, stem, VIEWPORT, type Account } from "./support";

/*
 * The suggest form's step 1 (feature-specs/34 § 4, § 7, § 11.2, § 11.7, § 11.8; unit 51b), in EN and in PT: from the
 * reader's "Suggest a change" to the anchor step with its section chosen; the kind switched by the arrow keys; a
 * figure and a source row chosen, each a link whose address says what is chosen; an anchor that is not in the
 * release; the reader's role notice; the phone's notice; and nothing for axe to find on any of them.
 *
 * And the draft (unit 51b, part 2), in EN only, since every create spends one of the account's twenty a day: a
 * refusal shown in the error form, then a section's kind chosen by the arrow keys and the draft created, landing on
 * its edit page, read back through the API and deleted, so the account keeps no draft of this suite's.
 *
 * And the edit page (unit 51c), in EN and in PT, on a figure's draft made through the API: the strip with the draft's
 * id, the class panel, the value saved a second after the last keystroke with no button, fields that make no
 * proposal held back with the reason, a unit about operating equipment moving the class to the curator's and back,
 * the saved value after a reload, and the phone's notice; axe on each state.
 *
 * And the other five kinds' editors (unit 51c, part 2), in EN, under an account of their own, since they spend five
 * drafts a run: a passage picked from the source with the schema sensor's checks under it, a claim placed after a
 * passage, a restructure, a row's field changed beside its current value, and a new row whose new tier moves the
 * class; each read back through the API, and axe on each.
 *
 * And step 3, the evidence (unit 51d), in EN and PT, under an account of its own: nothing it adds reaches a model. A
 * link that cannot be opened goes through the real workflow and is graded U by rule; its error form, the replace that
 * offers it again, and the read agreeing. The graded, grading and budget-cap states come from reads the browser answers
 * itself, built from the real one: the tier badge's name, the arithmetic, the stake and the window, the corroboration
 * row, the stage, the reset day; axe on each.
 *
 * And uploads (unit 51d, part 2), in EN and PT, under an account of their own, where the server's store can sign (it
 * is skipped, and says why, where it cannot): the picker worded in the page's language; a page held back in the form
 * with nothing asked of the server; an image over its type's most refused after the ticket, with nothing sent; a "PDF"
 * whose bytes are not one sent through the ticket, the PUT and the add, and graded U by intake rules before any model
 * is asked, its reason in words; the replace that opens the form again; the read agreeing, and axe on each.
 *
 * And the rationale, the live score and Submit (unit 51e), in EN and PT, under an account of their own: the rail as
 * the read gives it before anything is graded; 201 words turning the counter to its error state and Submit waiting,
 * with why; a submission refused by the schema sensor, shown beside step 2; and the rail following a grade without a
 * reload, its number and its prediction the read's. Nothing reaches a model, and nothing is submitted for good: a
 * submitted suggestion is a record the database keeps, so a successful submission is checked by hand (spec 34 § 26).
 *
 * And Delete draft (feature-specs/45 § 4; unit 63g), in EN and PT, under an account of its own: the dialog on the rail
 * cancelled, then confirmed, the Improve page's Done notice, and the draft gone; axe on the dialog and the notice.
 *
 * It leaves no part for the report: it measures no criterion of a gate.
 */

const PHONE = { width: 390, height: 844 } as const;
const START = "/ch/21/improve/new";

/** The evidence test's own contributor: one draft a test, two a run (EN and PT), and links that never reach a model. */
const EVIDENCE: Account = { email: "e2e-suggest-evidence@harness-bible.local", role: "CONTRIBUTOR", verified: true };

/** The upload test's own contributor: one draft a test, two a run (EN and PT), and files that never reach a model. */
const UPLOADS: Account = { email: "e2e-suggest-uploads@harness-bible.local", role: "CONTRIBUTOR", verified: true };

/** The submit test's own contributor: one draft a test, two a run, refused and deleted, so its consent is never put on file. */
const SUBMITTER: Account = { email: "e2e-suggest-submit@harness-bible.local", role: "CONTRIBUTOR", verified: true };

/** The editors' own contributor: their five drafts a run are not the other tests' twenty a day. */
const EDITOR: Account = { email: "e2e-suggest-kinds@harness-bible.local", role: "CONTRIBUTOR", verified: true };

/** Delete draft's own contributor: one draft a test, two a run (EN and PT), each deleted by the test itself. */
const DELETER: Account = { email: "e2e-suggest-delete@harness-bible.local", role: "CONTRIBUTOR", verified: true };

for (const locale of E2E_LOCALES) {
  const m = CATALOGUES[locale].improve.suggest;
  const reader = CATALOGUES[locale].reader;

  test(`suggest · step 1 · ${locale} · a contributor anchors a change from the reader`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    try {
      await context.addCookies(await accountSession(browser, baseURL, "suggest-contributor", CONTRIBUTOR));
      const page = await context.newPage();
      await page.goto(sectionPath(locale, "21.3"), { waitUntil: "networkidle" });
      /* The rail's copy: the reading column's is the same link, shown only under 1000px. */
      await page.getByRole("link", { name: new RegExp(reader.actions.suggest) }).filter({ visible: true }).first().click();
      await page.waitForURL((url) => url.pathname === `/${locale}${START}` && url.searchParams.get("anchor") === "21.3");
      await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();
      const kinds = page.getByRole("group", { name: m.kindLabel });
      await expect(kinds.locator("a[aria-current=true]")).toHaveText(m.kind.SECTION);
      await expect(page.locator(".anchor-quote p")).toHaveText(new RegExp(`^21\\.3 `));
      const changes = page.getByRole("group", { name: m.create.changeLabel });
      for (const kind of ["EDIT_TEXT", "ADD_CLAIM", "ADD_ROW", "RESTRUCTURE"] as const) await expect(changes.getByRole("radio", { name: m.create.change[kind] })).toBeVisible();
      await expect(changes.getByRole("radio", { name: m.create.change.EDIT_TEXT })).toBeChecked();
      expect(await axeFindings(page, `suggest-section-${locale}`)).toEqual([]);

      if (locale === "en") {
        /* A refusal is the error form with the server's words and the trace; nothing is created. */
        const refused = { code: "RATE_LIMITED", message: CATALOGUES.en.api.errors.RATE_LIMITED, traceId: "0af7651916cd43dd8448eb211c80319c" };
        await page.route("**/api/v1/suggestions", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify(refused) }));
        await page.getByRole("button", { name: m.create.button }).click();
        const error = page.locator(".anchor-create").getByRole("alert");
        await expect(error).toContainText(m.create.failed);
        await expect(error).toContainText(refused.message);
        await expect(error).toContainText(fill(m.create.trace, { traceId: refused.traceId }));
        await page.unroute("**/api/v1/suggestions");

        /* The kind by the arrow keys, then the draft: the edit page's address, and the draft as the API reads it. */
        await changes.getByRole("radio", { name: m.create.change.EDIT_TEXT }).focus();
        await page.keyboard.press("ArrowDown");
        await expect(changes.getByRole("radio", { name: m.create.change.ADD_CLAIM })).toBeChecked();
        await page.getByRole("button", { name: m.create.button }).click();
        await page.waitForURL((url) => /^\/en\/improve\/S-21-\d{4,}\/edit$/.test(url.pathname));
        const id = new URL(page.url()).pathname.split("/")[3] ?? "";
        await expect(page.locator(".improve-strip")).toContainText(id);
        await expect(page.getByRole("heading", { level: 2, name: m.edit.proposed })).toBeVisible();
        await expect(page.locator("section[aria-labelledby=edit-step-2]")).toContainText(m.edit.kindCap.ADD_CLAIM);
        const view = await context.request.get(`/api/v1/suggestions/${id}`);
        expect(view.status()).toBe(200);
        expect(await view.json()).toMatchObject({ id, state: "DRAFT", changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM", locale: "en" });
        const removed = await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin: new URL(baseURL ?? "").origin } });
        expect(removed.status()).toBe(200);
        await page.goto(`/${locale}${START}?anchor=21.3`, { waitUntil: "networkidle" });
      }

      /* One stop in the tab order; the arrows move to the next kind and Enter follows it: the section's first figure. */
      await kinds.locator("a[aria-current=true]").focus();
      await page.keyboard.press("ArrowRight");
      await expect(kinds.getByRole("link", { name: m.kind.FIGURE })).toBeFocused();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => /^F-21-\d{2,3}$/.test(url.searchParams.get("anchor") ?? ""));
      await expect(page.locator(".anchor-list tr.sel")).toHaveCount(1);
      await expect(kinds.locator("a[aria-current=true]")).toHaveText(m.kind.FIGURE);
      /* A figure takes one kind of change, its value: the button alone. */
      await expect(page.getByRole("group", { name: m.create.changeLabel })).toHaveCount(0);
      await expect(page.getByRole("button", { name: m.create.button })).toBeEnabled();
      expect(await axeFindings(page, `suggest-figure-${locale}`)).toEqual([]);

      /* The source rows: the first one the section's figures cite, then the chapter's last row. */
      await kinds.getByRole("link", { name: m.kind.SOURCE_ROW }).click();
      await page.waitForURL((url) => /^21\.9 r\d+$/.test(url.searchParams.get("anchor") ?? ""));
      const rows = page.locator(".anchor-list tbody tr");
      const last = rows.last().getByRole("link");
      const href = await last.getAttribute("href");
      await last.click();
      await page.waitForURL((url) => `${url.pathname}${url.search}` === href);
      await expect(rows.last()).toHaveClass(/\bsel\b/);
      const anchor = new URL(page.url()).searchParams.get("anchor") ?? "";
      await expect(page.locator(".anchor-list-foot")).toContainText(fill(m.selected, { id: anchor }));
      await expect(page.getByRole("region", { name: m.anchoredLabel })).toContainText(fill(m.anchoredText, { version: "v" }).replace(/v$/, ""));
      expect(await axeFindings(page, `suggest-row-${locale}`)).toEqual([]);

      /* An anchor that is not in the release: said so, with the way to choose another. */
      await page.goto(`/${locale}${START}?anchor=21.9+r999`, { waitUntil: "networkidle" });
      /* Next.js keeps a route announcer with the same role: the step's own alert is the one in its column. */
      await expect(page.locator(".anchor-step").getByRole("alert")).toContainText(m.notFound.title);
      await expect(page.getByRole("link", { name: m.notFound.choose })).toHaveAttribute("href", `/${locale}/ch/21`);
      expect(await axeFindings(page, `suggest-missing-${locale}`)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`suggest · step 1 · ${locale} · a reader is told what a contributor is, and a phone has the step at its width`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const desktop = await browser.newContext({ baseURL, viewport: VIEWPORT });
    try {
      await desktop.addCookies(await accountSession(browser, baseURL, "suggest-reader", { email: READER }));
      const page = await desktop.newPage();
      const response = await page.goto(`/${locale}${START}?anchor=21.3`, { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200);
      await expect(page.locator(".anchor-step .notice")).toContainText(m.role.title);
      await expect(page.getByRole("group", { name: m.kindLabel })).toHaveCount(0);
      expect(await axeFindings(page, `suggest-role-${locale}`)).toEqual([]);
    } finally {
      await desktop.close();
    }

    const phone = await browser.newContext({ baseURL, viewport: PHONE });
    try {
      await phone.addCookies(await accountSession(browser, baseURL, "suggest-contributor", CONTRIBUTOR));
      const page = await phone.newPage();
      await page.goto(`/${locale}${START}?anchor=21.3`, { waitUntil: "networkidle" });
      /* Step 1 renders at every width (34 § 16): a zoomed desktop is a narrow viewport (WCAG 1.4.10). */
      await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();
      await expect(page.getByRole("group", { name: m.kindLabel })).toBeVisible();
      await expect(page.getByRole("button", { name: m.create.button })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await axeFindings(page, `suggest-phone-${locale}`)).toEqual([]);
    } finally {
      await phone.close();
    }
  });

  test(`suggest · edit · ${locale} · a figure's value is saved on its own and moves the class`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const origin = new URL(baseURL ?? "").origin;
    const classes = CATALOGUES[locale].rubric.thresholds.class;
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    let id: string | null = null;
    try {
      await context.addCookies(await accountSession(browser, baseURL, "suggest-contributor", CONTRIBUTOR));
      /* The draft through the API, as step 1's button makes it (above): one of the account's twenty a day. */
      const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: { kind: "FIGURE", id: "F-21-16" }, changeKind: "SET_VALUE", locale } });
      expect(created.ok()).toBe(true);
      id = ((await created.json()) as { id: string }).id;
      const page = await context.newPage();
      await page.goto(`/${locale}/improve/${id}/edit`, { waitUntil: "networkidle" });
      await expect(page.locator(".improve-strip")).toContainText(id);
      await expect(page.locator(".improve-strip .st-block")).toHaveText(m.strip.draft);
      const panel = page.getByRole("region", { name: m.class.label });
      await expect(panel).toContainText(classes.CITED_FIGURE);
      await expect(panel).toContainText(m.class.recencyNone);
      const after = page.getByLabel(m.value.after, { exact: true });
      const unit = page.getByLabel(m.value.unit, { exact: true });
      await expect(page.getByLabel(m.value.before, { exact: true })).toHaveValue("7500");
      await expect(unit).toHaveValue("tokens");
      expect(await axeFindings(page, `suggest-edit-${locale}`)).toEqual([]);

      /* D3: saved a second after the last keystroke, with no button; the line prints it as the merge will. */
      await after.fill("8000");
      await expect(page.locator(".statusbar")).toContainText(stem(m.save.saved));
      await expect(page.locator(".value-line")).toContainText("8,000 tokens");
      expect(await (await context.request.get(`/api/v1/suggestions/${id}`)).json()).toMatchObject({ proposal: { kind: "SET_VALUE", after: "8000", unit: "tokens" }, changeClass: "CITED_FIGURE" });

      /* Fields that make no proposal are not sent; the field says why once it is left, and the status bar after the pause. */
      await after.fill("8,000");
      await expect(after).not.toHaveAttribute("aria-invalid", "true");
      await unit.focus();
      await expect(after).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#value-after-error")).toHaveText(m.value.afterInvalid);
      await expect(page.locator(".statusbar")).toContainText(fill(m.save.invalid, { message: m.value.afterInvalid }));
      expect(await (await context.request.get(`/api/v1/suggestions/${id}`)).json()).toMatchObject({ proposal: { after: "8000" } });
      expect(await axeFindings(page, `suggest-edit-invalid-${locale}`)).toEqual([]);

      /* Rule 3 (30 § 4.2): a unit about operating equipment makes the change the curator's, said in one line. A blur
         saves at once: the request leaves before the pause would have sent it. */
      await after.fill("8000");
      await unit.fill("tokens, then reset the PLC");
      const patched = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith(`/api/v1/suggestions/${id}`), { timeout: 600 });
      await after.focus();
      await patched;
      await expect(panel.getByRole("status")).toHaveText(m.class.moved.SAFETY_OT);
      await expect(panel).toContainText(fill(m.class.curatorYes, { reason: m.class.reason.SAFETY_OT }));
      expect(await (await context.request.get(`/api/v1/suggestions/${id}`)).json()).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT" });
      expect(await axeFindings(page, `suggest-edit-moved-${locale}`)).toEqual([]);
      await unit.fill("tokens");
      await after.focus();
      await expect(panel.getByRole("status")).toHaveText(fill(m.class.moved.other, { class: classes.CITED_FIGURE }));

      /* What was saved is what a reload shows, and what Back shows after leaving: the router does not restore the page as first loaded. */
      await page.reload({ waitUntil: "networkidle" });
      await expect(after).toHaveValue("8000");
      await expect(unit).toHaveValue("tokens");
      await after.fill("8100");
      await expect(page.locator(".statusbar")).toContainText(stem(m.save.saved));
      await page.locator(".improve-strip a").first().click();
      await page.waitForURL((url) => url.pathname === `/${locale}/ch/21/21.3`);
      await page.goBack();
      await page.waitForURL((url) => url.pathname === `/${locale}/improve/${id}/edit`);
      await expect(after).toHaveValue("8100");

      /* A tablet, or a desktop zoomed: the form keeps its width, and nothing scrolls sideways. */
      for (const width of [1024, 820]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await after.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(120);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await page.setViewportSize(VIEWPORT);

      /* Under 768px the page is the "desktop or tablet" notice: three columns do not fit (34 § 16). */
      const phone = await browser.newContext({ baseURL, viewport: PHONE });
      try {
        await phone.addCookies(await context.cookies());
        const small = await phone.newPage();
        await small.goto(`/${locale}/improve/${id}/edit`, { waitUntil: "networkidle" });
        await expect(small.getByRole("heading", { name: m.phone.title })).toBeVisible();
        await expect(small.getByLabel(m.value.after, { exact: true })).toBeHidden();
        expect(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(await axeFindings(small, `suggest-edit-phone-${locale}`)).toEqual([]);
      } finally {
        await phone.close();
      }
    } finally {
      if (id !== null) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
      await context.close();
    }
  });
}

test("suggest · edit · en · the other kinds' editors save what they show", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const m = CATALOGUES.en.improve.suggest;
  const origin = new URL(baseURL ?? "").origin;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  const made: string[] = [];
  const page = await context.newPage();
  const status = page.locator(".statusbar");
  const draft = async (anchor: { readonly kind: "SECTION" | "SOURCE_ROW"; readonly id: string }, changeKind: string): Promise<string> => {
    const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor, changeKind, locale: "en" } });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: string }).id;
    made.push(id);
    await page.goto(`/en/improve/${id}/edit`, { waitUntil: "networkidle" });
    return id;
  };
  const read = async (id: string) => (await (await context.request.get(`/api/v1/suggestions/${id}`)).json()) as { proposal: Record<string, unknown> | null; changeClass: string; curatorReason: string | null };
  /** Select in a source area the first run of words found once in it; the button then takes it. */
  const select = (area: string) =>
    page.evaluate((selector) => {
      const element = document.querySelector<HTMLTextAreaElement>(selector);
      if (element === null) throw new Error(`no ${selector}`);
      const passage = (element.value.match(/[A-Za-z][A-Za-z ,]{34,}/g) ?? []).map((run) => run.slice(0, 32).trim()).find((run) => element.value.split(run).length === 2);
      if (passage === undefined) throw new Error("no passage of the source is found once");
      const at = element.value.indexOf(passage);
      element.focus();
      element.setSelectionRange(at, at + passage.length);
      return passage;
    }, area);
  try {
    await context.addCookies(await accountSession(browser, baseURL, "suggest-kinds", EDITOR));

    /* A passage edited: picked from the file's text, its checks those of the schema sensor (31 § 5). */
    let id = await draft({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    const passage = await select("#text-source");
    await page.getByRole("button", { name: m.source.use }).click();
    await expect(page.getByLabel(m.text.before, { exact: true })).toHaveValue(passage);
    await expect(page.locator("#text-before-check")).toHaveText(fill(m.check.once, { id: "21.3" }));
    await expect(page.locator("#text-after-check")).toHaveText(m.check.same);
    await page.getByLabel(m.text.after, { exact: true }).fill(`${passage} indeed`);
    await expect(status).toContainText(stem(m.save.saved));
    expect((await read(id)).proposal).toEqual({ kind: "EDIT_TEXT", before: passage, after: `${passage} indeed` });
    await page.getByLabel(m.text.after, { exact: true }).fill(`${passage} 7`);
    await expect(page.locator("#text-after-check")).toHaveText(m.check.digits);
    expect(await axeFindings(page, "suggest-edit-passage-en")).toEqual([]);
    /* By the keyboard alone: the source is selectable though it takes no edit, and the passage's field takes the focus. */
    const source = page.locator("#text-source");
    const text = await source.inputValue();
    await source.focus();
    await page.keyboard.press("Control+Home");
    for (let step = 0; step < 12; step += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.type("x");
    await expect(source).toHaveValue(text);
    await page.keyboard.press("Control+Home");
    for (let step = 0; step < 12; step += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel(m.text.before, { exact: true })).toBeFocused();
    await expect(page.getByLabel(m.text.before, { exact: true })).toHaveValue(text.slice(0, 12));

    /* A claim after that passage, fast-moving: the choices save at once. */
    id = await draft({ kind: "SECTION", id: "21.3" }, "ADD_CLAIM");
    await page.getByLabel(m.claim.text, { exact: true }).fill("A claim the book does not make yet.");
    await page.getByRole("radio", { name: m.claim.after }).check();
    await select("#claim-source");
    await page.getByRole("button", { name: m.source.use }).click();
    await page.getByRole("checkbox", { name: m.fastMovingField }).check();
    await expect(status).toContainText(stem(m.save.saved));
    expect(await read(id)).toMatchObject({ proposal: { kind: "ADD_CLAIM", text: "A claim the book does not make yet.", placeAfter: passage, fastMoving: true }, changeClass: "NEW_CLAIM", fastMoving: true });
    /* The declaration is what recency reads for a claim added (30 § 3.4): the panel follows it, with no class moved. */
    await expect(page.getByRole("region", { name: m.class.label })).toContainText(m.class.recencyApplies);
    expect(await axeFindings(page, "suggest-edit-claim-en")).toEqual([]);

    /* A restructure: the curator's by rule 1, whatever it says. */
    id = await draft({ kind: "SECTION", id: "21.3" }, "RESTRUCTURE");
    await page.getByLabel(m.restructure.description, { exact: true }).fill("Split 21.3 into the arithmetic and the recovery.");
    await expect(status).toContainText(stem(m.save.saved));
    expect(await read(id)).toMatchObject({ proposal: { kind: "RESTRUCTURE", description: "Split 21.3 into the arithmetic and the recovery." }, changeClass: "CURATOR_ALWAYS", curatorReason: "STRUCTURE" });
    expect(await axeFindings(page, "suggest-edit-restructure-en")).toEqual([]);

    /* A row's claim changed beside its current one: the proposal holds that field alone. */
    id = await draft({ kind: "SOURCE_ROW", id: "21.9 r10" }, "EDIT_ROW");
    const claim = fill(m.row.proposed, { field: m.row.field.claim });
    const now = await page.getByLabel(fill(m.row.current, { field: m.row.field.claim }), { exact: true }).inputValue();
    await page.getByLabel(claim, { exact: true }).fill(`${now} (rechecked)`);
    await expect(status).toContainText(stem(m.save.saved));
    expect((await read(id)).proposal).toEqual({ kind: "EDIT_ROW", claim: `${now} (rechecked)` });
    await page.getByLabel(fill(m.row.proposed, { field: m.row.field.url }), { exact: true }).fill("not a link");
    await page.getByLabel(claim, { exact: true }).focus();
    await expect(page.locator("#row-url-problem")).toHaveText(m.problem.invalid.url);
    expect(await axeFindings(page, "suggest-edit-row-en")).toEqual([]);

    /* A row added: a tier must be chosen; a new tier makes it the curator's (rule 4), and the panel says why. */
    id = await draft({ kind: "SECTION", id: "21.3" }, "ADD_ROW");
    await page.getByLabel(m.newRow.claim, { exact: true }).fill("batch discount, provider tier 3");
    await page.getByLabel(m.newRow.citation, { exact: true }).fill("Provider three pricing page");
    await page.getByLabel(m.newRow.claim, { exact: true }).focus();
    await expect(status).toContainText(m.problem.chooseTier);
    await page.getByLabel(m.newRow.tier, { exact: true }).selectOption("VENDOR");
    await expect(status).toContainText(stem(m.save.saved));
    expect(await read(id)).toMatchObject({ proposal: { kind: "ADD_ROW", tier: "VENDOR" }, changeClass: "NEW_CLAIM" });
    await page.getByLabel(m.newRow.tier, { exact: true }).selectOption("NEW");
    await page.getByLabel(m.newRow.newTier, { exact: true }).fill("regulator filing");
    await page.getByLabel(m.newRow.claim, { exact: true }).focus();
    await expect(page.getByRole("region", { name: m.class.label }).getByRole("status")).toHaveText(m.class.moved.NEW_SOURCE_TIER);
    expect(await read(id)).toMatchObject({ proposal: { tier: { newTier: "regulator filing" } }, changeClass: "CURATOR_ALWAYS", curatorReason: "NEW_SOURCE_TIER" });
    expect(await axeFindings(page, "suggest-edit-new-row-en")).toEqual([]);
  } finally {
    for (const id of made) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
    await context.close();
  }
});

for (const locale of E2E_LOCALES) {
  test(`suggest · edit · ${locale} · evidence: a link that cannot be opened, and the list's states as the read gives them`, async ({ browser, baseURL }) => {
    test.setTimeout(150_000);
    const m = CATALOGUES[locale].improve.suggest;
    const e = m.evidence;
    const rubric = CATALOGUES[locale].rubric;
    const origin = new URL(baseURL ?? "").origin;
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    let id: string | null = null;
    try {
      await context.addCookies(await accountSession(browser, baseURL, "suggest-evidence", EVIDENCE));
      const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale } });
      expect(created.ok()).toBe(true);
      id = ((await created.json()) as { id: string }).id;
      const draft = id;
      const page = await context.newPage();
      await page.goto(`/${locale}/improve/${draft}/edit`, { waitUntil: "networkidle" });
      const step = page.locator(".evidence-step");
      await expect(step.getByRole("heading", { level: 2, name: e.title })).toBeVisible();
      await expect(step.locator(".evidence-empty")).toContainText(e.empty.title);
      await expect(page.locator(".statusbar")).toContainText(m.edit.grader);
      expect(await axeFindings(page, `suggest-evidence-empty-${locale}`)).toEqual([]);

      /* A link the form holds back, then one the fetcher cannot open: graded U by rule, no model asked. */
      await page.getByRole("button", { name: e.add.link, exact: true }).click();
      const field = page.getByLabel(e.add.linkLabel, { exact: true });
      await expect(field).toBeFocused();
      await field.fill("http://evidence.example/report");
      await page.getByRole("button", { name: e.add.submit, exact: true }).click();
      await expect(page.locator("#evidence-add-value-help")).toHaveText(e.add.linkInvalid);
      await field.fill("https://evidence-e2e.invalid/report");
      await page.getByRole("button", { name: e.add.submit, exact: true }).click();
      const failed = page.locator(".evidence-failed");
      await expect(failed).toContainText(e.unreachable.title, { timeout: 30_000, useInnerText: false });
      /* The cause is the network's, which this machine decides (an unknown name, or no network): the sentence around it is the form's. */
      const [before = "", after = ""] = e.unreachable.cause.split("{why}");
      await expect(failed).toContainText(before.replace("{n}", "1"));
      await expect(failed).toContainText(after);
      const read = async () => (await (await context.request.get(`/api/v1/suggestions/${draft}`)).json()) as { evidence: Array<Record<string, unknown>> };
      expect((await read()).evidence).toMatchObject([{ kind: "LINK", state: "GRADED", tier: "U", stage: null }]);
      expect(await axeFindings(page, `suggest-evidence-unreachable-${locale}`)).toEqual([]);

      /* Replace: removed, and its link offered again in the add row. */
      await page.getByRole("button", { name: fill(e.replaceLabel, { n: 1 }), exact: true }).click();
      await expect(failed).toHaveCount(0);
      await expect(field).toHaveValue("https://evidence-e2e.invalid/report");
      await page.getByRole("button", { name: e.add.cancel, exact: true }).click();
      await expect(page.getByRole("button", { name: e.add.link, exact: true })).toBeFocused();
      expect((await read()).evidence).toEqual([]);

      /* The graded, grading and budget states, from reads the browser answers itself, built on the real one. */
      await page.route(`**/api/v1/suggestions/${draft}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        const json = (await response.json()) as { evidence: Array<Record<string, unknown>> };
        const real = json.evidence[0] ?? {};
        const item = (fields: Record<string, unknown>) => ({ ...real, kind: "LINK", doi: null, labRunId: null, publishedOn: null, gradedAt: null, ...fields });
        await route.fulfill({
          response,
          json: {
            ...json,
            evidence: [
              item({ id: "11111111-1111-4111-8111-111111111111", ordinal: 1, state: "GRADED", url: "https://provider-two.example/pricing", title: "Provider tier 2 pricing page", host: "provider-two.example", ageDays: 12, fetchStatus: "opened:200", tier: "C", baseScore: 70, relevance: 1, recency: 1, independence: 0.8, adjustedScore: 56, reason: "the vendor's page", gradedBy: "suite-model", stage: null }),
              item({ id: "22222222-2222-4222-8222-222222222222", ordinal: 2, state: "GRADED", url: "https://price-tracker.example/tier-2", title: "Independent price tracker", host: "price-tracker.example", ageDays: 150, fetchStatus: "opened:200", tier: "D", baseScore: 60, relevance: 1, recency: 0.7, independence: 1, adjustedScore: 42, reason: "a tracker", gradedBy: "suite-model", stage: null }),
              item({ id: "33333333-3333-4333-8333-333333333333", ordinal: 3, state: "PENDING", url: "https://bench.example/cost", title: "Independent benchmark", host: "bench.example", ageDays: null, fetchStatus: "opened:200", tier: null, baseScore: null, relevance: null, recency: null, independence: null, adjustedScore: null, reason: null, gradedBy: null, stage: "3 of 3" }),
              item({ id: "44444444-4444-4444-8444-444444444444", ordinal: 4, kind: "DOI", state: "PENDING", url: null, doi: "10.1000/182", title: null, host: null, ageDays: null, fetchStatus: "opened:200", tier: null, baseScore: null, relevance: null, recency: null, independence: null, adjustedScore: null, reason: "budget cap; resets 2026-11-01", gradedBy: null, stage: "3 of 3" }),
            ],
            scoring: { score: 66, strongestItemId: "11111111-1111-4111-8111-111111111111", corroboratedById: "22222222-2222-4222-8222-222222222222", gradedItems: 2, pendingItems: 2, prediction: { route: "ADJUDICATE", decision: "REQUEST_MORE", namedTier: "D", acceptAt: 40, floorAt: 5, shortBy: null }, wouldSuffice: [] },
          },
        });
      });
      /* A pending item starts the reads: one more link that cannot be opened, and the next read is the one above. */
      await page.getByRole("button", { name: e.add.link, exact: true }).click();
      await field.fill("https://evidence-e2e-again.invalid/report");
      await page.getByRole("button", { name: e.add.submit, exact: true }).click();
      const list = page.locator(".evidence-list");
      await expect(list.locator(".evidence-corroboration")).toContainText(fill(e.corroboration, { item: "02", tier: "D" }), { timeout: 15_000 });
      await expect(list.locator(".evidence-corroboration")).toContainText(fill(e.corroborationValue, { bonus: 10 }));
      await expect(list.locator(".evidence-item").first().getByRole("img", { name: fill(rubric.tiers.badge, { tier: "C", name: rubric.tiers.name.C }), exact: true })).toBeVisible();
      await expect(list.locator(".evidence-math").first()).toHaveText(locale === "pt" ? "70 × 1,0 × 1,0 × 0,8 = 56" : "70 × 1.0 × 1.0 × 0.8 = 56");
      await expect(list).toContainText(e.stake.vendor);
      await expect(list).toContainText(`${e.stake.none} · ${rubric.adjustments.recency.withinYear}`);
      await expect(list.locator(".is-pending").first()).toHaveAttribute("aria-busy", "true");
      await expect(list.locator(".is-pending").first()).toContainText(fill(e.stage, { n: 3 }));
      await expect(list.locator(".is-pending").first()).toContainText(e.doing["3"]);
      await expect(list.locator(".evidence-wait")).toContainText(e.budget.title, { useInnerText: false });
      await expect(list.locator(".evidence-wait")).toContainText(locale === "pt" ? "01 nov 2026" : "01 Nov 2026");
      await expect(list.locator(".evidence-wait").getByRole("button", { name: fill(e.removeLabel, { n: 4 }), exact: true })).toBeEnabled();
      expect(await axeFindings(page, `suggest-evidence-graded-${locale}`)).toEqual([]);
      await page.unroute(`**/api/v1/suggestions/${draft}`);
    } finally {
      if (id !== null) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
      await context.close();
    }
  });
}

for (const locale of E2E_LOCALES) {
  test(`suggest · edit · ${locale} · evidence: files refused in the form, and an upload graded U by rule`, async ({ browser, baseURL }) => {
    test.setTimeout(150_000);
    const e = CATALOGUES[locale].improve.suggest.evidence;
    const origin = new URL(baseURL ?? "").origin;
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    let id: string | null = null;
    try {
      /* The store signs nothing without its secret: a forged token is 403 where it signs, 503 where it cannot (32 § 15). */
      const probe = await context.request.put("/api/v1/storage/not-a-token", { headers: { "content-type": "text/plain" }, data: "x" });
      test.skip(probe.status() === 503, "the server's store has no OBJECT_STORE_SECRET, so every upload answers 503 STORAGE_UNAVAILABLE (tracker, Session Notes)");
      await context.addCookies(await accountSession(browser, baseURL, "suggest-uploads", UPLOADS));
      const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale } });
      expect(created.ok()).toBe(true);
      id = ((await created.json()) as { id: string }).id;
      const draft = id;
      const page = await context.newPage();
      const sent: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/v1/")) sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
      });
      await page.goto(`/${locale}/improve/${draft}/edit`, { waitUntil: "networkidle" });
      await expect(page.locator(".evidence-empty")).toContainText(e.empty.body);

      /* The form: the file field focused, the picker worded in the page's language. */
      await page.getByRole("button", { name: e.add.upload, exact: true }).click();
      const field = page.getByLabel(e.add.fileLabel, { exact: true });
      await expect(field).toBeFocused();
      await expect(page.locator(".evidence-file-button")).toHaveText(e.add.chooseFile);
      await expect(page.locator(".evidence-file-name")).toHaveText(e.add.noFile);
      expect(await axeFindings(page, `suggest-upload-form-${locale}`)).toEqual([]);

      /* A page is none of the five types: held back in the form, and nothing is asked of the server. */
      sent.length = 0;
      await field.setInputFiles({ name: "page.html", mimeType: "text/html", buffer: Buffer.from("<p>a page</p>") });
      await expect(page.locator(".evidence-file-name")).toHaveText("page.html");
      await page.getByRole("button", { name: e.add.submit, exact: true }).click();
      await expect(page.locator("#evidence-add-value-help")).toHaveText(e.add.fileInvalid);
      expect(sent).toEqual([]);

      /* An image over its type's most: the ticket names the most, and the file is never sent. */
      await field.setInputFiles({ name: "chart.png", mimeType: "image/png", buffer: Buffer.alloc(7_500_001, 1) });
      await page.getByRole("button", { name: e.add.submit, exact: true }).click();
      await expect(page.locator("#evidence-add-value-help")).toHaveText(fill(e.add.fileTooLarge, { max: locale === "pt" ? "7,1 MB" : "7.1 MB" }));
      expect(sent).toEqual([`POST /api/v1/suggestions/${draft}/evidence/uploads`]);

      /* A "PDF" whose bytes are not one: the ticket, the PUT, the add; graded U by intake rules before any model is asked. */
      sent.length = 0;
      await field.setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a PDF: these bytes do not begin as one") });
      await page.getByRole("button", { name: e.add.submit, exact: true }).click();
      const failed = page.locator(".evidence-failed");
      await expect(failed).toContainText(e.ruled.title, { timeout: 40_000, useInnerText: false });
      await expect(failed).toContainText(fill(e.ruled.body, { n: 1, why: e.ruled.why.media_mismatch }));
      await expect(failed).toContainText("report.pdf");
      expect(sent.slice(0, 3)).toEqual([`POST /api/v1/suggestions/${draft}/evidence/uploads`, expect.stringMatching(/^PUT \/api\/v1\/storage\/[^/]+$/), `POST /api/v1/suggestions/${draft}/evidence`]);
      const read = async () => (await (await context.request.get(`/api/v1/suggestions/${draft}`)).json()) as { evidence: Array<Record<string, unknown>> };
      expect((await read()).evidence).toMatchObject([{ kind: "UPLOAD", state: "GRADED", tier: "U", reason: "media_mismatch", gradedBy: "intake-rules", fetchStatus: "opened:200", stage: null }]);
      expect(await axeFindings(page, `suggest-upload-ruled-${locale}`)).toEqual([]);

      /* Replace: removed, and the upload's form opened again with its field focused. */
      await page.getByRole("button", { name: fill(e.replaceLabel, { n: 1 }), exact: true }).click();
      await expect(failed).toHaveCount(0);
      await expect(field).toBeFocused();
      await page.getByRole("button", { name: e.add.cancel, exact: true }).click();
      await expect(page.getByRole("button", { name: e.add.upload, exact: true })).toBeFocused();
      expect((await read()).evidence).toEqual([]);
    } finally {
      if (id !== null) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
      await context.close();
    }
  });
}

for (const locale of E2E_LOCALES) {
  test(`suggest · edit · ${locale} · the rationale, the live score and Submit`, async ({ browser, baseURL }) => {
    test.setTimeout(150_000);
    const m = CATALOGUES[locale].improve.suggest;
    const origin = new URL(baseURL ?? "").origin;
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    let id: string | null = null;
    try {
      await context.addCookies(await accountSession(browser, baseURL, "suggest-submit", SUBMITTER));
      const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale } });
      expect(created.ok()).toBe(true);
      id = ((await created.json()) as { id: string }).id;
      const draft = id;
      const page = await context.newPage();
      await page.goto(`/${locale}/improve/${draft}/edit`, { waitUntil: "networkidle" });

      /* The rail before anything is graded: no score, no prediction, the identity, and the consent asked for. */
      const rail = page.getByRole("complementary", { name: m.score.label });
      await expect(rail).toContainText(m.score.none);
      await expect(rail).toContainText(m.prediction.say.none);
      await expect(rail).toContainText(m.identity.help);
      const consent = page.getByLabel(m.submit.consent, { exact: true });
      await expect(consent).toBeVisible();
      expect(await axeFindings(page, `suggest-submit-empty-${locale}`)).toEqual([]);

      /* 201 words: the counter in its error state, Submit waits, and says why. */
      const rationale = page.getByLabel(m.rationale.label, { exact: true });
      await rationale.fill(Array.from({ length: 201 }, (_, i) => `w${String(i)}`).join(" "));
      await expect(page.locator("#rationale-count")).toHaveText(fill(m.rationale.counter, { n: 201, max: 200 }));
      await expect(page.locator("#rationale-count")).toHaveClass(/is-over/);
      const submit = page.getByRole("button", { name: m.submit.button, exact: true });
      await expect(submit).toHaveAttribute("aria-disabled", "true");
      await expect(rail).toContainText(fill(m.submit.waitWords, { max: 200 }));
      const saved = page.waitForResponse((response) => response.request().method() === "PATCH");
      await rationale.fill("The release raised the retry cap; the section still says three.");
      await saved;

      /* Submit with no proposal written: the schema sensor's refusal, beside step 2, and the draft still a draft. */
      await consent.check();
      await submit.click();
      const problem = page.locator('section[aria-labelledby="edit-step-2"] + .submit-problem');
      await expect(problem).toContainText(m.submit.sensor.SCHEMA, { useInnerText: false });
      await expect(problem).toContainText(m.submit.sensorSource);
      const read = async () => (await (await context.request.get(`/api/v1/suggestions/${draft}`)).json()) as { state: string; scoring: { score: number; prediction: { route: string } } | null };
      expect((await read()).state).toBe("DRAFT");
      expect(await axeFindings(page, `suggest-submit-refused-${locale}`)).toEqual([]);

      /* A link that cannot be opened is graded U: the rail follows without a reload, its numbers the read's. */
      await page.getByRole("button", { name: m.evidence.add.link, exact: true }).click();
      await page.getByLabel(m.evidence.add.linkLabel, { exact: true }).fill("https://evidence-submit.invalid/report");
      await page.getByRole("button", { name: m.evidence.add.submit, exact: true }).click();
      await expect(rail).toContainText(m.prediction.badge.DECLINE, { timeout: 30_000, useInnerText: false });
      const view = await read();
      expect(view.scoring?.prediction.route).toBe("DECLINE_AT_INTAKE");
      await expect(rail.locator(".bignum")).toHaveText(String(view.scoring?.score));
    } finally {
      if (id !== null) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
      await context.close();
    }
  });
}

test("suggest · step 1 · signed out, the page sends the visitor to sign in and back", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto(`/en${START}?anchor=21.9+r1&from=21.3`);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/en/login");
    expect(url.searchParams.get("next")).toBe(`/en${START}?anchor=21.9+r1&from=21.3`);
  } finally {
    await context.close();
  }
});

for (const locale of E2E_LOCALES) {
  test(`suggest · edit · ${locale} · Delete draft: the dialog, the draft gone, the Done notice (45 § 4)`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const d = CATALOGUES[locale].improve.suggest.deleteDraft;
    const home = CATALOGUES[locale].improve.home;
    const origin = new URL(baseURL ?? "").origin;
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    let id: string | null = null;
    try {
      await context.addCookies(await accountSession(browser, baseURL, "suggest-delete", DELETER));
      const created = await context.request.post("/api/v1/suggestions", { headers: { origin, "idempotency-key": randomUUID() }, data: { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale } });
      expect(created.ok()).toBe(true);
      id = ((await created.json()) as { id: string }).id;
      const draft = id;
      const page = await context.newPage();
      await page.goto(`/${locale}/improve/${draft}/edit`, { waitUntil: "networkidle" });
      const trigger = page.locator(".score-column").getByRole("button", { name: d.trigger, exact: true });
      const dialog = page.getByRole("dialog", { name: fill(d.title, { id: draft }) });

      /* opened, its words, nothing for axe; cancelled, the focus back on the trigger and the draft still there */
      await openDialog(trigger, dialog);
      await expect(dialog).toContainText(d.body);
      expect(await axeFindings(page, `suggest-delete-dialog-${locale}`)).toEqual([]);
      await dialog.getByRole("button", { name: d.cancel, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect((await context.request.get(`/api/v1/suggestions/${draft}`)).status()).toBe(200);

      /* confirmed: replaced by the Improve page and its notice, and the draft is gone */
      await openDialog(trigger, dialog);
      await dialog.getByRole("button", { name: d.confirm, exact: true }).click();
      await page.waitForURL(`**/${locale}/improve?deleted=${draft}`);
      await expect(page.locator(".notice")).toContainText(fill(home.notice.deleted, { id: draft }));
      expect((await context.request.get(`/api/v1/suggestions/${draft}`)).status()).toBe(404);
      expect(await axeFindings(page, `improve-home-deleted-${locale}`)).toEqual([]);
      id = null;
    } finally {
      if (id !== null) await context.request.delete(`/api/v1/suggestions/${id}`, { headers: { origin } });
      await context.close();
    }
  });
}
