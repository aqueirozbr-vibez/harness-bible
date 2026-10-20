import { expect, test, type Locator, type Page } from "@playwright/test";

import type { E2eLocale } from "@/lib/schemas/e2e";

import { awake, chaptersOf, keyTo, sectionsOf, settled } from "./book";
import { CATALOGUES, defineFlow, fill, onPath, openDialog, READER, readRecorded, sectionOf, sectionPath, serverAction, signIn, stem, VIEWPORT, type Catalogue } from "./support";

/*
 * The reader's primary flows (unit 23d; project-overview § Success criteria · Phase 1: "Playwright runs the reader's
 * primary flows in PT and EN with zero axe WCAG 2.2 AA violations"). Six flows, each in both languages, each
 * scanning its screens with axe as it reaches them:
 *
 *   home-to-section   Book Home, a chapter tile, the outline, the language switch
 *   read-a-section    a cross-reference's peek, the keyboard map, the section keys, a code pane's copy
 *   search            the top bar's box, the results, a filter, a hit, a term with no match
 *   reading-path      start a path, read, see the progress and resume from the paths page and from Book Home, reset
 *   marks             bookmark and note a section with the keys, find them on the marks page, remove them
 *   account           the sign-in page, the account page, sign out
 *
 * A flow takes its chapter from Book Home and its sections from the outline; it holds no content of the release.
 * The signed-in flows are the suite's own reader's, and each leaves the account as it found it.
 */

test.use({ viewport: VIEWPORT });

/** The chapter the flows read: the second tile of Book Home. The first chapter is the book's preface, shorter than the rest. */
const TILE = 1;
/** The path the reading-path flow starts and resets. */
const PATH = "builder";
/** A word the book uses throughout, and a string it does not hold. */
const TERM = "cache";
const NO_MATCH = "qzxjvk";
const NOTE = "e2e: a note the suite wrote and removes";

async function chapterOf(page: Page, locale: E2eLocale): Promise<string> {
  const chapter = (await chaptersOf(page, locale))[TILE];
  expect(chapter, "Book Home lists the chapters").toBeDefined();
  return chapter ?? "";
}

function pathPanel(page: Page, m: Catalogue, path: keyof Catalogue["home"]["continue"]["pathName"]): Locator {
  return page.getByRole("region", { name: fill(m.paths.path.aria, { name: m.home.continue.pathName[path] }), exact: true });
}

/** Reset the path through its dialog; the page comes back with the path not started. */
async function resetPath(page: Page, m: Catalogue, panel: Locator, name: string, seen?: () => Promise<void>): Promise<void> {
  const dialog = page.getByRole("dialog", { name: fill(m.paths.reset.title, { name }), exact: true });
  await openDialog(panel.getByRole("button", { name: m.paths.reset.label, exact: true }), dialog);
  await seen?.();
  await dialog.getByRole("button", { name: m.paths.reset.confirm, exact: true }).click();
  await expect(panel.getByRole("button", { name: m.paths.path.start, exact: true })).toBeVisible();
}

defineFlow("home-to-section", { signedIn: false }, async ({ page, locale, m, scan }) => {
  await page.goto(`/${locale}`);
  await expect(page.getByRole("heading", { level: 1, name: m.home.title })).toBeVisible();
  await expect(page.getByRole("navigation", { name: m.chrome.navLabel, exact: true })).toBeVisible();
  await scan("home");

  /* A chapter tile opens the chapter at its first section. */
  const tile = page.locator("a.tile-title").nth(TILE);
  const chapter = /\/ch\/(\d{2})$/.exec((await tile.getAttribute("href")) ?? "")?.[1] ?? "";
  expect(chapter, "a chapter tile links to its chapter").not.toBe("");
  await tile.click();
  const sections = await sectionsOf(page, chapter);
  const first = sections[0] ?? "";
  const third = sections[2] ?? "";
  await page.waitForURL(onPath(sectionPath(locale, first)));
  await settled(page, first);
  await expect(page.locator("h1.reader-title")).toBeVisible();
  await expect(page.getByRole("complementary", { name: m.reader.outline.label, exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: m.reader.rail.label, exact: true })).toBeVisible();
  await scan(`section ${first}`);

  /* The outline moves the reader inside the chapter. */
  await page.locator("ul.outline-layers a").nth(2).click();
  await page.waitForURL(onPath(sectionPath(locale, third)));
  await settled(page, third);

  /* The language switch keeps the section. */
  const other = locale === "en" ? "pt" : "en";
  await page.getByRole("group", { name: m.chrome.lang.label, exact: true }).getByRole("button", { name: other.toUpperCase(), exact: true }).click();
  await page.waitForURL(onPath(sectionPath(other, third)));
  await settled(page, third);
  await expect(page.getByRole("complementary", { name: CATALOGUES[other].reader.outline.label, exact: true })).toBeVisible();

  /* The brand goes back to Book Home. */
  await page.getByRole("link", { name: CATALOGUES[other].chrome.brandLabel, exact: true }).click();
  await page.waitForURL(onPath(`/${other}`));
  await expect(page.getByRole("heading", { level: 1, name: CATALOGUES[other].home.title })).toBeVisible();
});

defineFlow("read-a-section", { signedIn: false }, async ({ page, locale, m, scan }) => {
  /* What a code pane copies is kept in the page: the machine's own clipboard is not the suite's to write. */
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.defineProperty(window, "__copied", { value: copied });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => Promise.resolve(void copied.push(text)) } });
  });
  const chapter = await chapterOf(page, locale);
  await page.goto(`/${locale}/ch/${chapter}`);
  const sections = await sectionsOf(page, chapter);
  await awake(page, m);

  /* The chapter's first section whose prose has both things prose does: a cross-reference and a code pane. */
  const references = page.locator(".prose a.xref[data-ref]");
  const panes = page.locator(".prose .code");
  let section = "";
  for (const [index, candidate] of sections.entries()) {
    await settled(page, candidate);
    if ((await references.count()) > 0 && (await panes.count()) > 0) {
      section = candidate;
      break;
    }
    const next = sections[index + 1];
    if (next !== undefined) expect(await keyTo(page, "j", locale, next), `j from ${candidate}`).toBe(true);
  }
  expect(section, `a section of chapter ${chapter} with a cross-reference and a code pane`).not.toBe("");
  const here = sectionPath(locale, section);
  await scan(`section ${section}`);

  /* A cross-reference opens a peek over the section; esc closes it and the reference has the focus again. */
  const reference = references.first();
  const target = (await reference.getAttribute("data-ref")) ?? "";
  const peek = page.getByRole("dialog", { name: fill(m.reader.peek.label, { id: target }), exact: true });
  await reference.click();
  await expect(peek).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${here}/ref/${target}`);
  await expect(page.locator("h2.section-title")).toBeVisible();
  await scan("peek");
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();
  await expect(reference).toBeFocused();
  await page.waitForURL(onPath(here));

  /* "Open in place" follows the reference. */
  await reference.click();
  const open = peek.getByRole("link", { name: m.reader.peek.open, exact: true });
  const destination = (await open.getAttribute("href")) ?? "";
  expect(destination).not.toBe("");
  await open.click();
  await page.waitForURL((url) => url.pathname.startsWith(destination) && !url.pathname.includes("/ref/"));
  await page.goto(here);
  await settled(page, section);
  await awake(page, m);

  /* The keyboard map, and its own close button. */
  const map = page.getByRole("dialog", { name: m.reader.keys.mapLabel, exact: true });
  await page.keyboard.press("?");
  await expect(map).toBeVisible();
  await expect(map.getByText(m.reader.keys.section, { exact: true })).toBeVisible();
  await scan("keyboard map");
  await map.getByRole("button", { name: m.reader.keys.close, exact: true }).click();
  await expect(map).toBeHidden();

  /* j and k move through the chapter's sections. */
  const index = sections.indexOf(section);
  const forward = index + 1 < sections.length;
  const neighbour = sections[forward ? index + 1 : index - 1] ?? "";
  expect(await keyTo(page, forward ? "j" : "k", locale, neighbour), `${forward ? "j" : "k"} from ${section}`).toBe(true);
  expect(await keyTo(page, forward ? "k" : "j", locale, section), `${forward ? "k" : "j"} back to ${section}`).toBe(true);

  /* A code pane copies its source, and says so. */
  const pane = panes.first();
  const source = await pane.evaluate((node) => node.querySelector<HTMLTemplateElement>("template[data-raw]")?.content.textContent ?? node.querySelector(".code-b")?.textContent ?? "");
  await pane.getByRole("button", { name: m.reader.code.copyLabel, exact: true }).click();
  await expect(page.locator(".statusnote").filter({ hasText: m.reader.code.copied })).toBeVisible();
  expect(source).not.toBe("");
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([source]);
});

defineFlow("search", { signedIn: false }, async ({ page, locale, m, scan }) => {
  const release = ((await (await page.request.get("/api/v1/releases/current")).json()) as { id: string }).id;
  await page.goto(`/${locale}`);
  const box = page.getByRole("searchbox", { name: m.chrome.search.label, exact: true });
  await box.fill(TERM);
  await box.press("Enter");
  await page.waitForURL((url) => url.pathname === `/${locale}/search` && url.searchParams.get("q") === TERM);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`${m.search.title} ${TERM}`);
  const hits = page.getByRole("list", { name: m.search.list.label, exact: true }).locator("li.hit");
  await expect(hits.first()).toBeVisible();
  await expect(page.locator(`section.inst[aria-label="${m.search.query.label}"]`)).toBeVisible();
  await scan("search results");

  /* `/` puts the caret in the search box: the keyboard map is the search page's too. */
  await awake(page, m);
  await page.keyboard.press("/");
  await expect(box).toBeFocused();
  await box.blur();

  /* A filter narrows the results as soon as it is ticked. */
  await page.locator('input[type=checkbox][name=type][value=section]').check();
  await page.waitForURL((url) => url.searchParams.get("type") === "section" && url.searchParams.get("q") === TERM);
  await expect(hits.first()).toBeVisible();
  /* The text as the markup has it: the label is set in capitals by the stylesheet. */
  const kinds = await hits.locator(".hit-kind").allTextContents();
  expect(kinds.length).toBeGreaterThan(0);
  expect(kinds.filter((kind) => kind.trim() !== m.search.kind.section)).toEqual([]);
  await scan("search results, filtered");

  /* A hit opens the reader at its section. */
  const title = hits.first().locator("a.hit-title");
  const href = (await title.getAttribute("href")) ?? "";
  await title.click();
  await page.waitForURL(onPath(href));
  expect(sectionOf(page.url()), `the hit's address ${href}`).not.toBeNull();
  await expect(page.locator("h2.section-title")).toBeVisible();

  /* A term the book does not hold says so. */
  await page.goto(`/${locale}/search?q=${NO_MATCH}`);
  await expect(page.getByText(fill(m.search.empty.none, { q: NO_MATCH, id: release }), { exact: true })).toBeVisible();
  await expect(hits).toHaveCount(0);
  await scan("search without a match");
});

defineFlow("reading-path", { signedIn: true }, async ({ page, locale, m, scan }) => {
  const name = m.home.continue.pathName[PATH];
  const panel = pathPanel(page, m, PATH);
  const start = panel.getByRole("button", { name: m.paths.path.start, exact: true });

  await page.goto(`/${locale}/paths`);
  await expect(page.getByRole("heading", { level: 1, name: m.paths.title })).toBeVisible();
  await expect(panel).toBeVisible();
  /* A run that failed half-way leaves the path started: begin from a path that is not. */
  if (!(await start.isVisible())) await resetPath(page, m, panel, name);
  await scan("paths");

  /* Starting the path opens its first section, and the outline shows the path. */
  await start.click();
  await page.waitForURL((url) => sectionOf(url.href) !== null);
  const first = sectionOf(page.url()) ?? "";
  const sections = await sectionsOf(page, first.slice(0, 2));
  const second = sections[1] ?? "";
  await settled(page, first);
  await expect(page.getByRole("complementary", { name: m.reader.outline.label, exact: true }).getByText(m.reader.outline.path, { exact: true })).toBeVisible();
  await scan("section on a path");

  /* Reading on: the next section, kept as the place to resume once it has been read. */
  await awake(page, m);
  const read = readRecorded(page, second);
  expect(await keyTo(page, "j", locale, second), `j from ${first}`).toBe(true);
  await read;

  /* The paths page shows the progress and resumes there. */
  await page.goto(`/${locale}/paths`);
  await expect(panel.getByText(m.paths.path.progress, { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: fill(m.paths.path.resume, { id: second }), exact: true })).toBeVisible();
  await scan("paths, one in progress");

  /* Book Home offers the same place. */
  await page.goto(`/${locale}`);
  const resume = page.getByRole("region", { name: m.home.continue.label, exact: true }).getByRole("link", { name: fill(m.home.continue.resume, { section: second }), exact: true });
  await expect(resume).toBeVisible();
  await scan("home, signed in");
  await resume.click();
  await page.waitForURL(onPath(sectionPath(locale, second)));
  await settled(page, second);

  /* Reset: the dialog, and the path as it was. */
  await page.goto(`/${locale}/paths`);
  await resetPath(page, m, panel, name, () => scan("reset dialog"));
});

defineFlow("marks", { signedIn: true }, async ({ page, locale, m, scan }) => {
  const chapter = await chapterOf(page, locale);
  await page.goto(`/${locale}/ch/${chapter}`);
  const section = (await sectionsOf(page, chapter))[0] ?? "";
  await settled(page, section);
  await awake(page, m);

  const rail = page.getByRole("complementary", { name: m.reader.rail.label, exact: true });
  const bookmark = rail.getByRole("button", { name: fill(m.reader.marks.bookmarkLabel, { id: section }), exact: true });
  const editor = rail.getByRole("textbox", { name: fill(m.reader.marks.editorLabel, { id: section }), exact: true });
  const status = rail.locator(".note-status");
  const save = rail.getByRole("button", { name: m.reader.marks.save, exact: true });

  /* A run that failed half-way leaves its marks: begin from a section that has none. */
  if ((await bookmark.getAttribute("aria-pressed")) === "true") {
    const removed = serverAction(page, '"on":false');
    await bookmark.click();
    await removed;
  }
  if ((await editor.inputValue()) !== "") {
    await editor.fill("");
    await save.click();
    await expect(status).toHaveText(m.reader.marks.status.deleted);
    await editor.blur();
  }
  await expect(bookmark).toHaveAttribute("aria-pressed", "false");

  /* b bookmarks the section. */
  const kept = serverAction(page, '"on":true');
  await page.keyboard.press("b");
  await expect(bookmark).toHaveAttribute("aria-pressed", "true");
  await expect(bookmark).toContainText(m.reader.marks.bookmarked);
  await kept;

  /* n goes to the note; the note is saved. */
  await page.keyboard.press("n");
  await expect(editor).toBeFocused();
  await page.keyboard.type(NOTE);
  await expect(status).toHaveText(m.reader.marks.status.dirty);
  await save.click();
  await expect(status).toContainText(stem(m.reader.marks.status.saved));
  await scan(`section ${section} with marks`);

  /* The marks page lists both, and a row opens its section. */
  await page.goto(`/${locale}/marks`);
  await expect(page.getByRole("heading", { level: 1, name: m.marks.title })).toBeVisible();
  const row = (list: string): Locator => page.getByRole("list", { name: list, exact: true }).locator("li.mark-row").filter({ has: page.locator(".mark-id", { hasText: section }) });
  await expect(row(m.marks.bookmarks.list)).toBeVisible();
  await expect(row(m.marks.notes.list)).toContainText(NOTE);
  await scan("marks");
  await row(m.marks.bookmarks.list).locator("a.mark-title").click();
  await page.waitForURL(onPath(sectionPath(locale, section)));
  await expect(page.locator(".mark-flag")).toContainText(m.reader.marks.flag);

  /* Both are removed from the marks page. */
  await page.goto(`/${locale}/marks`);
  await row(m.marks.bookmarks.list).getByRole("button", { name: m.marks.bookmarks.remove, exact: true }).click();
  await expect(page.getByText(fill(m.marks.notice.removed, { id: section }), { exact: true })).toBeVisible();
  await expect(row(m.marks.bookmarks.list)).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: fill(m.reader.marks.confirm.title, { id: section }), exact: true });
  await openDialog(row(m.marks.notes.list).getByRole("button", { name: fill(m.reader.marks.confirm.title, { id: section }), exact: true }), dialog);
  await scan("delete dialog");
  await dialog.getByRole("button", { name: m.reader.marks.confirm.confirm, exact: true }).click();
  await expect(page.getByText(fill(m.marks.notice.deleted, { id: section }), { exact: true })).toBeVisible();
  await expect(row(m.marks.notes.list)).toHaveCount(0);
});

defineFlow("account", { signedIn: false }, async ({ page, locale, m, scan }) => {
  const bar = page.locator("header.topbar");

  /* A signed-out reader is offered the sign-in page from the top bar. */
  await page.goto(`/${locale}`);
  await bar.getByRole("link", { name: m.chrome.signIn, exact: true }).click();
  await page.waitForURL(onPath(`/${locale}/login`));
  await expect(page.getByRole("heading", { level: 1, name: m.auth.title })).toBeVisible();
  await expect(page.locator("a.auth-btn").filter({ hasText: m.auth.panel.dev })).toHaveAttribute("href", /^\/api\/v1\/auth\/dev\?/);
  await scan("sign in");

  /* The page's button signs in the development reader; the suite signs in its own, at the same endpoint. */
  await signIn(page, READER, `/${locale}/account`);
  await page.waitForURL(onPath(`/${locale}/account`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("footer.statusbar")).toContainText(READER);
  await expect(bar.getByRole("link", { name: m.chrome.account, exact: true })).toBeVisible();
  await scan("account");

  /* Signing this session out, from the sessions table, leaves a signed-out reader on Book Home. */
  await page.locator("#sessions tr").filter({ hasText: m.account.sessions.current }).getByRole("button", { name: m.account.sessions.signOut, exact: true }).click();
  await page.waitForURL(onPath(`/${locale}`));
  await expect(bar.getByRole("link", { name: m.chrome.signIn, exact: true })).toBeVisible();

  /* The account page is then closed. */
  await page.goto(`/${locale}/account`);
  await page.waitForURL(onPath(`/${locale}/login`));
});
