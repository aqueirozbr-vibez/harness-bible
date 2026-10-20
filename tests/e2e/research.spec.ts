import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { formatDayMonth } from "@/lib/i18n/format";
import type { ResearchRunView } from "@/lib/schemas/api";
import { E2E_LOCALES, type E2eLocale } from "@/lib/schemas/e2e";

import { accountSession, axeFindings, CATALOGUES, openDialog, VIEWPORT, type Account } from "./support";

/*
 * The Research page (feature-specs/48 § 11, § 20, § 26; unit 72), in EN and PT, under an account of its own: an
 * individual account with no gateway key, so the one real run it starts ends `SKIPPED · UNAVAILABLE` at the planner and
 * no model is asked. Every other state is rows the research seed writes for this account (`npm run research:seed --
 * --page --account …`, tests/fixtures/research/page.ts), and the run that shows its steps one by one is a progression of
 * the run's own view served to the page in place of the server's, which is what the page follows.
 *
 * - a question from scratch: the URL gains `?research=<id>`, the focus stays in the field, the list gains the row, and
 *   the run's line moves to its end without a reload;
 * - a start answered 503, 402 or 429 gives the question back to the field; a 503's `Retry` posts what the field holds,
 *   under the same key while it is unchanged; a 402 and a 429 close the composer and put the focus on their box; the
 *   new research's row is dated today; a follow-up answered 503 in a research opened at an older run (`#run-<id>`)
 *   keeps its box in view (review of unit 76);
 * - the steps one by one, then the report, the pages and the findings; the log announces each state once, the read's
 *   twenty steps and the end included; a report's paragraph links nothing but its chips and its page numbers;
 * - in a research with a follow-up every `[n]` of run 2 lands on run 2's own page row, and no id repeats;
 * - a section link opens the reader with no Assistant dock; `a` opens the Assistant's dock and writes nothing into the
 *   research composer;
 * - `?from=` prefills the question and spends nothing until Start; an invalid one shows its notice and leaves the URL;
 * - since unit 75 (§ 9.1, § 9.4), the seed answer's Assistant conversation: the answer's `Start a research` links to
 *   `?from=<id>` and opens the page prefilled with nothing written, the refusal after it offers none, no turn has a
 *   research line; the account page has no research switch and its Retention line says what research keeps;
 * - the columns at 1440, 1360, 1200, 1000, 900 and 390, no horizontal overflow; axe on each state in EN and PT.
 *
 * Since unit 73 (§ 11.6 to § 11.10, § 26):
 *
 * - the statistics in the catalogue's words, each window's link, the retention line and the meter's `research` row;
 * - `Flag this report` stored once, its dialog research's own words and reasons, a second flag answered 409 and the
 *   stored one shown after a reload; a refused run's quiet `Flag this refusal` with the refusal's two reasons;
 * - `Delete research` from the list: the dialog, cancelled with the focus back on the trigger, then confirmed — the page
 *   with `?deleted=<id>`, its status line, `New research` in focus described by it, the research a 404 — and at 1200px
 *   the researches' overlay open to show the line, and closed by `New research`, which gives the field the focus; no
 *   export offered for a research with no record; the first start
 *   after a delete, answered 503, keeps its question, its box and `Retry` through the start's refresh (the review);
 * - `Copy report`'s text on the clipboard, and `copied` in the status bar.
 *
 * Since unit 74 (§ 8.1 to § 8.3, § 20), each finding's button by role — the research account, a reader, sends; a
 * contributor of the suite's own, verified, drafts — with the presses answered in the page, since a real send starts a
 * workflow and a real draft starts its gradings, which this suite must not:
 *
 * - `Send to Improve`: the confirm with its words and the focus on Cancel, then `sending to Improve` with the focus on
 *   it, then `sent · being checked by Improve` and `sent · proposed` with its panel, `not part of the report`, without a
 *   reload, from the run's own view served as Improve would move it;
 * - `Draft it in Improve` with its help line: the draft posted with its key and the page's language, and the page going
 *   to the draft's edit page the answer names; axe on the contributor's block.
 *
 * It deletes the researches it starts. It leaves no part for the report: it measures no criterion of a gate.
 */

const RESEARCHER: Account = { email: "e2e-research@harness-bible.local" };
/* the suite's own verified contributor, whose findings offer the draft (48 § 8.1; unit 74) */
const DRAFTER: Account = { email: "e2e-research-drafter@harness-bible.local", role: "CONTRIBUTOR", verified: true };
const SEED_REPORT = join("test-results", "research-page-seed.json");
const DRAFTER_SEED_REPORT = join("test-results", "research-page-seed-drafter.json");
const QUESTION = "What changed in how long idempotency keys are kept since 21.3 was verified?";

interface Seeded {
  readonly done: string;
  readonly underWay: string;
  readonly refused: string;
  readonly stopped: string;
  readonly purged: string;
  readonly seeded: string;
  readonly seedAnswer: string;
  readonly seedConversation: string;
}

let seeded: Seeded;
let drafterSeeded: Seeded;

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  /* the account exists once it has signed in; then the seed writes its states, with no model and no workflow */
  await accountSession(browser, baseURL, "research", RESEARCHER);
  execFileSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), join("scripts", "research-seed.ts"), "--page", "--account", RESEARCHER.email, "--report", SEED_REPORT], { stdio: "pipe", env: process.env, timeout: 150_000 });
  seeded = (JSON.parse(readFileSync(SEED_REPORT, "utf8")) as { research: Seeded }).research;
  await accountSession(browser, baseURL, "research-drafter", DRAFTER);
  execFileSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), join("scripts", "research-seed.ts"), "--page", "--account", DRAFTER.email, "--report", DRAFTER_SEED_REPORT], { stdio: "pipe", env: process.env, timeout: 150_000 });
  drafterSeeded = (JSON.parse(readFileSync(DRAFTER_SEED_REPORT, "utf8")) as { research: Seeded }).research;
});

async function opened(browser: Browser, baseURL: string | undefined, path: string, viewport: { readonly width: number; readonly height: number } = VIEWPORT, as: { readonly name: string; readonly account: Account } = { name: "research", account: RESEARCHER }): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
  const context = await browser.newContext({ baseURL, viewport });
  await context.addCookies(await accountSession(browser, baseURL, as.name, as.account));
  const page = await context.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  return { context, page };
}

/** The log's text as a screen reader is given it: without the `aria-live="off"` regions, which change silently. */
async function watchAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log = document.querySelector<HTMLElement>('.dock[data-dock="research"] [role="log"]');
    if (log === null) throw new Error("no log");
    const announced = (): string => {
      const copy = log.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[aria-live="off"]').forEach((node) => node.remove());
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    };
    const seen: string[] = [announced()];
    (window as unknown as { __announced: string[] }).__announced = seen;
    new MutationObserver(() => {
      const now = announced();
      if (now !== seen.at(-1)) seen.push(now);
    }).observe(log, { subtree: true, childList: true, characterData: true, attributes: false });
  });
}

const RUN = "00000000-0000-4000-8000-0000000072e2";
const PAGES = [
  { n: 1, url: "https://docs.stripe.com/api/idempotent_requests", host: "docs.stripe.com", title: "Idempotent requests", opened: true, search: 1 },
  { n: 2, url: "https://developer.paypal.com/reference/guidelines/idempotency/", host: "developer.paypal.com", title: "Idempotency guidelines", opened: true, search: 1 },
  { n: 3, url: "https://www.rfc-editor.org/rfc/rfc9110.html", host: "www.rfc-editor.org", title: null, opened: false, search: 2 },
];

/** The run's own view at each state, as the endpoint would answer the page: twenty steps over five reads of the read, then the end. */
function progression(question: string, at: string, locale: E2eLocale): ReadonlyArray<ResearchRunView> {
  const base: ResearchRunView = { id: RUN, conversationId: RUN, ordinal: 1, question, language: locale, seeded: false, state: "QUEUED", line: { key: "queued", tone: "run" }, stale: false, refusal: null, resetsAt: null, steps: [], sections: [], report: null, pages: [], findings: [], usage: { searches: 0, pagesOpened: 0, pagesSeen: null, costUsd: null }, flag: null, createdAt: at, finishedAt: null, textPurged: false };
  const steps: ResearchRunView["steps"] = [{ seq: 0, at, kind: "PLANNING" }];
  const views: ResearchRunView[] = [base, { ...base, state: "PLANNING", line: { key: "planning", tone: "run" }, steps: [...steps] }];
  steps.push({ seq: 1, at, kind: "SECTIONS", sections: ["21.3" as never] });
  while (steps.length < 20) {
    const seq = steps.length;
    steps.push(seq % 2 === 0 ? { seq, at, kind: "SEARCH", query: `idempotency key retention ${String(seq)}`, results: 4 } : { seq, at, kind: "PAGE", url: PAGES[seq % 3]?.url ?? "", title: "A page", opened: true });
    if (steps.length % 4 === 0) views.push({ ...base, state: "READING", line: { key: "reading", tone: "run" }, steps: [...steps], pages: PAGES.slice(0, 2) });
  }
  const read = [...steps];
  views.push({ ...base, state: "VALIDATING", line: { key: "checking", tone: "run" }, steps: [...read, { seq: 20, at, kind: "CHECKING" }], pages: PAGES });
  views.push({ ...base, state: "WRITING", line: { key: "writing", tone: "run" }, steps: [...read, { seq: 20, at, kind: "CHECKING" }, { seq: 21, at, kind: "WRITING" }], pages: PAGES });
  views.push({
    ...base,
    state: "DONE",
    line: { key: "done", tone: "ok" },
    steps: [...read, { seq: 20, at, kind: "CHECKING" }, { seq: 21, at, kind: "WRITING" }],
    sections: [{ id: "21.3", title: "Worked numbers" }],
    report: { paragraphs: [{ text: "Keys are kept for 24 hours [1], and a retry after that is a new write [2].", sections: ["21.3" as never], pages: [1, 2] }] },
    pages: PAGES,
    findings: [{ id: "00000000-0000-4000-8000-0000000072f1", n: 1, textPurged: false, anchor: { kind: "SECTION", id: "21.3", section: "21.3", title: "Worked numbers" }, changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM", curatorReason: null, change: { before: null, after: "Providers keep a key for at least 24 hours." }, sources: [{ url: PAGES[0]?.url ?? "", host: "docs.stripe.com" }], note: "Both providers document a 24-hour floor.", use: { state: "VALID", suggestionId: null, href: null, failure: null }, proposal: null }],
    usage: { searches: 10, pagesOpened: 2, pagesSeen: 3, costUsd: null },
    finishedAt: at,
  });
  return views;
}

for (const locale of E2E_LOCALES) {
  test.describe(`research · ${locale}`, () => {
    const m = CATALOGUES[locale].research;

    test("a question from scratch: the URL names the research, the focus stays in the field, the list gains its row, the run ends without a reload (48 § 11.3)", async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL ?? "").origin;
      const { context, page } = await opened(browser, baseURL, `/${locale}/research`);
      const made: string[] = [];
      try {
        const field = page.getByLabel(m.composer.ask, { exact: true });
        await field.fill(QUESTION);
        await page.getByRole("button", { name: m.composer.submit, exact: true }).click();
        await page.waitForURL(/[?&]research=/);
        const id = new URL(page.url()).searchParams.get("research") ?? "";
        made.push(id);
        await expect(field).toBeFocused();
        await expect(field).toHaveValue("");
        const run = page.locator('.dock[data-dock="research"] article.run').last();
        await expect(run).toContainText(QUESTION);
        /* an account with no gateway key: the planner's call is refused before a provider sees it, and the run is not run */
        await expect(run.locator(".research-line")).toHaveAttribute("data-line", "notRun", { timeout: 60_000 });
        await expect(field).not.toHaveAttribute("readonly", /.*/);
        await expect(page.locator("nav.assistant-conversations").locator(`a[href*="research=${id}"]`)).toHaveAttribute("aria-current", "page");
        expect(await axeFindings(page, `research-started-${locale}`)).toEqual([]);
      } finally {
        for (const id of made) await context.request.delete(`/api/v1/research/conversations/${id}`, { headers: { origin } });
        await context.close();
      }
    });

    test("a start that did not start gives the question back: a 503's Retry posts what the field holds, a 402 and a 429 close the composer with their box in focus, and the list's row is today's (48 § 18, § 20; unit 72's review)", async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL ?? "").origin;
      const errors = CATALOGUES[locale].api.errors;
      const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
      const answers = {
        503: { code: "RESEARCH_UNAVAILABLE", message: errors.RESEARCH_UNAVAILABLE, traceId: "e2e" },
        402: { code: "BUDGET_EXCEEDED", message: errors.BUDGET_EXCEEDED, detail: { resetsAt }, traceId: "e2e" },
        429: { code: "RESEARCH_DAILY_LIMIT", message: errors.RESEARCH_DAILY_LIMIT, detail: { resetsAt }, traceId: "e2e" },
      } as const;
      const { context, page } = await opened(browser, baseURL, `/${locale}/research`);
      const made: string[] = [];
      try {
        /* the research is opened for real; its start is answered as the endpoint would refuse it, so nothing runs */
        let status: keyof typeof answers = 503;
        const posts: Array<{ readonly question: string; readonly key: string }> = [];
        await page.route("**/api/v1/research/conversations/*/runs", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          posts.push({ question: (route.request().postDataJSON() as { question: string }).question, key: (await route.request().headerValue("idempotency-key")) ?? "" });
          return route.fulfill({ status, json: answers[status] });
        });
        const dock = page.locator('.dock[data-dock="research"]');
        const field = page.getByLabel(m.composer.ask, { exact: true });
        /* the box is in the log, which announces it */
        const box = dock.locator('[role="log"] .error');
        const retry = dock.getByRole("button", { name: m.errors.retry, exact: true });
        const ask = async (): Promise<string> => {
          await field.fill(QUESTION);
          await dock.getByRole("button", { name: m.composer.submit, exact: true }).click();
          await page.waitForURL(/[?&]research=/);
          const id = new URL(page.url()).searchParams.get("research") ?? "";
          made.push(id);
          return id;
        };

        /* 503: the question back in the field, which keeps the focus; the row dated today, never the epoch */
        const id = await ask();
        await expect(box).toContainText(m.errors.notStarted);
        await expect(box).toContainText(errors.RESEARCH_UNAVAILABLE);
        await expect(field).toHaveValue(QUESTION);
        await expect(field).toBeEnabled();
        await expect(field).toBeFocused();
        const row = page.locator("nav.assistant-conversations").locator(`a[href*="research=${id}"]`);
        await expect(row).toHaveAttribute("aria-current", "page");
        await expect(row.locator(".meta")).toContainText(formatDayMonth(new Date(), locale));
        /* Retry posts what the field holds: the same question under the same key, then an edit under a new one */
        await retry.click();
        await expect.poll(() => posts.length).toBe(2);
        expect(posts[1]).toEqual(posts[0]);
        await expect(field).toHaveValue(QUESTION);
        await field.fill(`${QUESTION} And since 2025?`);
        await retry.click();
        await expect.poll(() => posts.length).toBe(3);
        expect(posts[2]?.question).toBe(`${QUESTION} And since 2025?`);
        expect(posts[2]?.key).not.toBe(posts[0]?.key);
        await expect(field).toHaveValue(`${QUESTION} And since 2025?`);

        /* 402 and 429: the box says why and takes the focus from the field they disable, which keeps the question */
        for (const closing of [402, 429] as const) {
          status = closing;
          /* the last start's `router.refresh()` may still be under way and abort this load (net::ERR_ABORTED; the flake
             recorded at unit 73's commit, 48 § 33): the load is asked again until it lands */
          await expect(async () => {
            await page.goto(`/${locale}/research`, { waitUntil: "networkidle" });
          }).toPass({ timeout: 30_000 });
          await ask();
          await expect(box).toContainText(m.errors.notStarted);
          await expect(box).toContainText(answers[closing].message);
          await expect(box).toBeFocused();
          await expect(field).toBeDisabled();
          await expect(field).toHaveValue(QUESTION);
          await expect(retry).toHaveCount(0);
          if (closing === 402) await expect(dock.getByRole("link", { name: CATALOGUES[locale].account.budget.see, exact: true })).toBeVisible();
        }
        expect(await axeFindings(page, `research-refused-start-${locale}`)).toEqual([]);
      } finally {
        for (const research of made) await context.request.delete(`/api/v1/research/conversations/${research}`, { headers: { origin } });
        await context.close();
      }
    });

    test("a follow-up refused 503 in a research opened at an older run (`#run-<id>`) keeps its box in view: the column does not go back to the run the address named (48 § 18; review of unit 76)", async ({ browser, baseURL }) => {
      const errors = CATALOGUES[locale].api.errors;
      const { context, page } = await opened(browser, baseURL, `/${locale}/research?research=${seeded.done}`);
      try {
        const dock = page.locator('.dock[data-dock="research"]');
        const runs = dock.locator("article.run");
        await expect(runs).toHaveCount(2);
        const first = (await runs.first().getAttribute("data-run")) ?? "";
        /* a new document at the address the Improve landing page's row links to: the seed's first run, a follow-up after it */
        await page.goto("about:blank");
        await page.goto(`/${locale}/research?research=${seeded.done}#run-${first}`, { waitUntil: "networkidle" });
        const named = dock.locator(`article.run#run-${first}`);
        /* the column landed on the run named, its head in view (unit 76) */
        await expect(async () => {
          const where = await named.evaluate((element) => {
            const log = element.closest('[role="log"]');
            return log === null ? null : element.getBoundingClientRect().top - log.getBoundingClientRect().top;
          });
          expect(where ?? -1).toBeGreaterThanOrEqual(0);
          expect(where ?? 999).toBeLessThan(40);
        }).toPass({ timeout: 5_000 });
        /* the follow-up's start answered as the endpoint refuses it, so nothing runs */
        const posts: string[] = [];
        await page.route("**/api/v1/research/conversations/*/runs", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          posts.push((route.request().postDataJSON() as { question: string }).question);
          return route.fulfill({ status: 503, json: { code: "RESEARCH_UNAVAILABLE", message: errors.RESEARCH_UNAVAILABLE, traceId: "e2e" } });
        });
        const field = page.getByLabel(m.composer.ask, { exact: true });
        await field.fill(QUESTION);
        await dock.getByRole("button", { name: m.composer.submit, exact: true }).click();
        const box = dock.locator('[role="log"] .error');
        await expect(box).toContainText(errors.RESEARCH_UNAVAILABLE);
        expect(posts).toEqual([QUESTION]);
        await expect(field).toHaveValue(QUESTION);
        await expect(field).toBeFocused();
        /* the column's effect runs after the box is painted, and the start's refresh after it: two frames, then the settled page */
        await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))));
        await page.waitForLoadState("networkidle");
        await expect(box).toBeInViewport();
        expect(new URL(page.url()).hash).toBe(`#run-${first}`);
      } finally {
        await context.close();
      }
    });

    test("the steps one by one, then the report, the pages and the findings; the log announces each state once (48 § 6, § 20)", async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL ?? "").origin;
      const { context, page } = await opened(browser, baseURL, `/${locale}/research`);
      const made: string[] = [];
      try {
        let views: ReadonlyArray<ResearchRunView> = [];
        let reads = 0;
        /* the start answered as the endpoint answers it, so no workflow runs; the run's reads answered by its progression */
        await page.route("**/api/v1/research/conversations/*/runs", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          views = progression(QUESTION, new Date().toISOString(), locale);
          return route.fulfill({ status: 202, json: { runId: RUN, state: "QUEUED" } });
        });
        await page.route(`**/api/v1/research/runs/${RUN}`, async (route) => {
          const view = views[Math.min(reads, views.length - 1)];
          reads += 1;
          return route.fulfill({ json: view });
        });
        await watchAnnouncements(page);
        await page.getByLabel(m.composer.ask, { exact: true }).fill(QUESTION);
        await page.getByRole("button", { name: m.composer.submit, exact: true }).click();
        await page.waitForURL(/[?&]research=/);
        made.push(new URL(page.url()).searchParams.get("research") ?? "");
        const run = page.locator('.dock[data-dock="research"] article.run').last();
        /* the steps grow while the run reads, each without a reload */
        await expect(run.locator(".run-steps-list li")).toHaveCount(4, { timeout: 30_000 });
        await expect(run.locator(".run-steps-list li")).toHaveCount(12, { timeout: 30_000 });
        await expect(run.locator(".research-line")).toHaveAttribute("data-line", "done", { timeout: 60_000 });
        /* folded at the end, the report, the pages and the finding filled in */
        await expect(run.locator(".run-steps-toggle")).toHaveAttribute("aria-expanded", "false");
        await expect(run.locator(".run-report-body p")).toHaveCount(1);
        await expect(run.locator(".run-page")).toHaveCount(3);
        await expect(run.locator(".finding")).toHaveCount(1);
        /* a report's paragraph links nothing but its chips and its page numbers */
        const links = await run.locator(".run-report-body p a").evaluateAll((anchors) => anchors.map((anchor) => anchor.className));
        expect(links.length).toBeGreaterThan(0);
        expect(links.filter((name) => !/\b(cite|run-ref)\b/.test(name))).toEqual([]);
        /* the empty column, then one announcement per state: queued, planning, reading, checking, writing, done */
        const announced = await page.evaluate(() => (window as unknown as { __announced: string[] }).__announced);
        expect(announced, announced.join("\n")).toHaveLength(7);
        expect(await axeFindings(page, `research-done-${locale}`)).toEqual([]);
      } finally {
        for (const id of made) await context.request.delete(`/api/v1/research/conversations/${id}`, { headers: { origin } });
        await context.close();
      }
    });

    test("a follow-up's `[n]` lands on its own run's page row, no id repeats, and a section opens the reader with no Assistant dock (48 § 11.3)", async ({ browser, baseURL }) => {
      const { context, page } = await opened(browser, baseURL, `/${locale}/research?research=${seeded.done}`);
      try {
        const runs = page.locator('.dock[data-dock="research"] article.run');
        await expect(runs).toHaveCount(2);
        for (const index of [0, 1]) {
          const run = runs.nth(index);
          const id = (await run.getAttribute("data-run")) ?? "";
          const refs = await run.locator(".run-ref").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
          expect(refs.length).toBeGreaterThan(0);
          for (const href of refs) {
            expect(href).toMatch(new RegExp(`^#run-${id}-page-\\d+$`));
            await expect(run.locator(href)).toHaveCount(1);
          }
        }
        const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((element) => element.id));
        expect(ids.length).toBe(new Set(ids).size);
        await runs.first().locator(".run-report .cite").first().click();
        await page.waitForURL(new RegExp(`/${locale}/ch/21/21\\.3$`));
        await expect(page.locator('.dock[data-dock="assistant"]')).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("`a` opens the Assistant's dock over the page and writes nothing into the research composer (48 § 12)", async ({ browser, baseURL }) => {
      const { context, page } = await opened(browser, baseURL, `/${locale}/research?research=${seeded.done}`);
      try {
        const field = page.getByLabel(m.composer.ask, { exact: true });
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expect(async () => {
          await page.keyboard.press("a");
          await expect(page.locator('.dock[data-dock="assistant"]')).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        expect(new URL(page.url()).searchParams.get("ask")).toBe("1");
        expect(new URL(page.url()).searchParams.get("research")).toBe(seeded.done);
        await expect(field).toHaveValue("");
        await expect(page.locator('.dock[data-dock="research"] article.run')).toHaveCount(2);
      } finally {
        await context.close();
      }
    });

    test("`?from=` prefills the question and spends nothing until Start; an invalid one says so and leaves the URL (48 § 11.3, § 18)", async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
      try {
        await context.addCookies(await accountSession(browser, baseURL, "research", RESEARCHER));
        const page = await context.newPage();
        const writes: string[] = [];
        page.on("request", (request) => {
          if (request.method() !== "GET" && request.url().includes("/api/v1/research")) writes.push(request.url());
        });
        await page.goto(`/${locale}/research?from=${seeded.seedAnswer}`, { waitUntil: "networkidle" });
        await expect(page.getByLabel(m.composer.ask, { exact: true })).toHaveValue("How long should a server keep an idempotency key?");
        await expect(page.locator(".seed-card")).toContainText("21.3 · 21.4");
        await expect(page.locator(".seed-card")).toContainText(m.seed.body);
        await page.waitForTimeout(2_500);
        expect(writes).toEqual([]);
        await page.getByRole("link", { name: m.seed.scratch, exact: true }).click();
        await page.waitForURL(new RegExp(`/${locale}/research$`));
        await expect(page.getByLabel(m.composer.ask, { exact: true })).toHaveValue("");

        await page.goto(`/${locale}/research?from=00000000-0000-4000-8000-000000000000`, { waitUntil: "networkidle" });
        await expect(page.locator(".notice")).toContainText(m.seed.invalid);
        await expect(page).toHaveURL(new RegExp(`/${locale}/research$`));
        expect(writes).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test("an Assistant answer offers Start a research, which opens the page seeded from it and spends nothing; its refusal offers none, no turn has a research line, and the account page has no research switch (48 § 9.1, § 9.4; unit 75)", async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
      try {
        await context.addCookies(await accountSession(browser, baseURL, "research", RESEARCHER));
        const page = await context.newPage();
        const writes: string[] = [];
        page.on("request", (request) => {
          if (request.method() !== "GET" && request.url().includes("/api/v1/")) writes.push(request.url());
        });
        const start = CATALOGUES[locale].assistant.dock.startResearch;
        await page.goto(`/${locale}/assistant?ask=${seeded.seedConversation}`, { waitUntil: "networkidle" });
        const turns = page.locator("article.turn");
        await expect(turns).toHaveCount(2);
        /* the answer offers it, as a link to the page seeded from it; the refusal after it offers none */
        const link = turns.nth(0).getByRole("link", { name: start, exact: true });
        await expect(link).toHaveAttribute("href", `/${locale}/research?from=${seeded.seedAnswer}`);
        await expect(turns.nth(1).getByRole("link", { name: start, exact: true })).toHaveCount(0);
        await expect(turns.nth(1).locator("section.refusal")).toHaveCount(1);
        /* no turn has been handed to research since unit 75: no line under either */
        await expect(page.locator(".research-line")).toHaveCount(0);
        /* the turns, which unit 75 changed: the open conversation's `export JSONL` in the column fails target-size on its own, a defect of the Assistant page's recorded in 48 § 35 */
        expect(await axeFindings(page, `assistant answer with Start a research · ${locale}`, "article.turn")).toEqual([]);

        await link.click();
        await page.waitForURL(`**/${locale}/research?from=${seeded.seedAnswer}`);
        await expect(page.getByLabel(m.composer.ask, { exact: true })).toHaveValue("How long should a server keep an idempotency key?");
        await expect(page.locator(".seed-card")).toContainText(m.seed.body);
        await page.waitForTimeout(2_500);
        expect(writes).toEqual([]);

        /* the account page: no research switch, and the Retention line says what research keeps */
        await page.goto(`/${locale}/account`, { waitUntil: "networkidle" });
        await expect(page.locator("#pref-research")).toHaveCount(0);
        const kept = page.locator("dt", { hasText: CATALOGUES[locale].account.retention.research });
        await expect(kept).toHaveText(CATALOGUES[locale].account.retention.research);
        await expect(kept.locator("xpath=following-sibling::dd[1]")).toHaveText(CATALOGUES[locale].account.retention.researchValue);
      } finally {
        await context.close();
      }
    });

    test("the statistics: the cells in the catalogue's words, the window's links, the retention line and the meter's research row (48 § 11.6; unit 73)", async ({ browser, baseURL }) => {
      const { context, page } = await opened(browser, baseURL, `/${locale}/research?w=all`);
      try {
        const stats = page.getByRole("complementary", { name: m.stats.title, exact: true });
        await expect(stats).toBeVisible();
        for (const name of [m.stats.runs, m.stats.cost, m.stats.sources, m.stats.findings, m.stats.flagged]) await expect(stats.locator(".stats-cell > .cap").filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(1);
        /* the seed's twelve runs with a workflow over all time, one of them flagged; nothing was charged, so no cost */
        const cell = (index: number) => stats.locator(".stats-cell").nth(index);
        expect(Number(await cell(0).locator(".cellnum").textContent())).toBeGreaterThanOrEqual(12);
        /* the line a part a row, each a count before its word */
        for (const part of m.stats.ends.split(" · ")) await expect(cell(0)).toContainText(new RegExp(part.replace(/\{\w+\}/, "\\d+")));
        await expect(cell(1).locator(".cellnum")).toHaveText("—");
        expect(Number(await cell(4).locator(".cellnum").textContent())).toBeGreaterThanOrEqual(1);
        await expect(stats.getByRole("link", { name: CATALOGUES[locale].assistant.stats.all, exact: true })).toHaveAttribute("aria-current", "page");
        await expect(stats).toContainText(m.stats.keptUntil.replace(" {date}", ""));
        await expect(stats.locator(".budget-breakdown")).toContainText(CATALOGUES[locale].account.budget.research);
        /* the month's link leaves `w` off the URL */
        await stats.getByRole("link", { name: CATALOGUES[locale].assistant.stats.month, exact: true }).click();
        await page.waitForURL(new RegExp(`/${locale}/research$`));
        expect(await axeFindings(page, `research-statistics-${locale}`)).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test("Flag this report: its own words and reasons, stored once, a second flag answered 409 and the first shown; a refusal's quiet flag (48 § 11.7; unit 73)", async ({ browser, baseURL }) => {
      const origin = new URL(baseURL ?? "").origin;
      const { context, page } = await opened(browser, baseURL, `/${locale}/research?research=${seeded.done}`);
      try {
        /* EN flags the follow-up, PT the first run: each locale its own run of the seed */
        const run = page.locator('.dock[data-dock="research"] article.run').nth(locale === "en" ? 1 : 0);
        const runId = (await run.getAttribute("data-run")) ?? "";
        const trigger = run.getByRole("button", { name: m.flag.report, exact: true });
        const dialog = page.getByRole("dialog", { name: m.flag.title.report });
        await openDialog(trigger, dialog);
        await expect(dialog).toContainText(m.flag.body);
        await expect(dialog.locator("option")).toHaveText([m.flag.reasons.wrong_citation, m.flag.reasons.missing_citation, m.flag.reasons.wrong_number, m.flag.reasons.should_refuse, m.flag.reasons.other]);
        expect(await axeFindings(page, `research-flag-dialog-${locale}`)).toEqual([]);
        await dialog.getByRole("combobox").selectOption("missing_citation");
        await dialog.getByRole("button", { name: m.flag.confirm, exact: true }).click();
        const flagged = m.flag.flagged.replace("{reason}", m.flag.reasons.missing_citation);
        await expect(run.locator(".run-actions .flag-flagged")).toHaveText(flagged);
        const again = await context.request.post(`/api/v1/research/runs/${runId}/flag`, { headers: { origin }, data: { kind: "report", reason: "other" } });
        expect(again.status()).toBe(409);
        expect(await again.json()).toMatchObject({ code: "FLAG_DUPLICATE", detail: { kind: "report", reason: "missing_citation" } });
        await page.reload({ waitUntil: "networkidle" });
        await expect(page.locator('.dock[data-dock="research"] article.run').nth(locale === "en" ? 1 : 0).locator(".run-actions .flag-flagged")).toHaveText(flagged);

        /* a refused run's card carries the refusal's quiet flag, with the refusal's two reasons */
        await page.goto(`/${locale}/research?research=${seeded.refused}`, { waitUntil: "networkidle" });
        const refusal = page.getByRole("dialog", { name: m.flag.title.refusal });
        await openDialog(page.locator(".refusal-foot").first().getByRole("button", { name: m.flag.refusal, exact: true }), refusal);
        await expect(refusal.locator("option")).toHaveText([m.flag.reasons.should_not_refuse, m.flag.reasons.other]);
        await refusal.getByRole("button", { name: m.flag.cancel, exact: true }).click();
        await expect(refusal).toBeHidden();
      } finally {
        await context.close();
      }
    });

    test("Send to Improve: the confirm, `sending to Improve` with the focus on it, then `sent · being checked by Improve` and `sent · proposed` with its panel, without a reload (48 § 8.1, § 8.3, § 20; unit 74)", async ({ browser, baseURL }) => {
      const { context, page } = await opened(browser, baseURL, `/${locale}/research?research=${seeded.done}`);
      try {
        const run = page.locator('.dock[data-dock="research"] article.run').first();
        const runId = (await run.getAttribute("data-run")) ?? "";
        const finding = run.locator("section.finding").first();
        const findingId = (await finding.getAttribute("data-finding")) ?? "";
        /* the send answered here, as the endpoint would: a real one starts the send's workflow, which this suite must not */
        const posts: Array<{ readonly key: string | undefined; readonly body: string | null }> = [];
        await page.route(`**/api/v1/research/findings/${findingId}/propose`, async (route) => {
          posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
          await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ findingId, use: "SENDING" }) });
        });
        /* the run's own view, the finding moved as Improve would move it: being checked, then proposed with its panel */
        let reads = 0;
        await page.route(`**/api/v1/research/runs/${runId}`, async (route) => {
          reads += 1;
          const view = (await (await route.fetch()).json()) as ResearchRunView;
          const proposal = { suggestionId: "S-21-0999", anchor: { kind: "SECTION", id: "21.3", section: "21.3", title: "Worked numbers" }, changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM", curatorReason: null, change: { before: null, after: "Payment providers keep an idempotency key for at least 24 hours." }, contentLang: "en", sources: [{ host: "docs.stripe.com", tier: "B", adjusted: 72 }], score: 72, acceptAt: 85, note: "Both providers document a 24-hour floor.", where: { state: "CURATOR_QUEUE", parts: ["P2"], decisionBy: new Date(Date.now() + 7 * 86_400_000).toISOString(), version: null, closedBy: null }, endorsed: null } as const;
          const moved = view.findings.map((each) => (each.id !== findingId ? each : reads < 2 ? { ...each, use: { state: "SENT" as const, suggestionId: null, href: null, failure: null } } : { ...each, use: { state: "PROPOSED" as const, suggestionId: "S-21-0999", href: null, failure: null }, proposal }));
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...view, findings: moved }) });
        });
        const send = finding.getByRole("button", { name: m.findings.send, exact: true });
        const dialog = page.getByRole("dialog", { name: m.findings.sendTitle });
        await openDialog(send, dialog);
        await expect(dialog).toContainText(m.findings.sendBody);
        await expect(dialog.getByRole("button", { name: m.findings.sendCancel, exact: true })).toBeFocused();
        expect(await axeFindings(page, `research-send-dialog-${locale}`)).toEqual([]);
        await dialog.getByRole("button", { name: m.findings.sendConfirm, exact: true }).click();
        const line = finding.locator(".finding-use");
        await expect(line).toHaveText(m.findings.sending);
        await expect(line).toBeFocused();
        expect(posts).toEqual([{ key: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string, body: "{}" }]);
        await expect(line).toHaveText(m.findings.sent);
        await expect(line).toHaveText(m.findings.proposed);
        await expect(line).toBeFocused();
        await expect(finding.locator(".proposal-panel")).toContainText(CATALOGUES[locale].improve.proposal.notReport);
        expect(page.url()).toContain(`research=${seeded.done}`);
        expect(await axeFindings(page, `research-sent-${locale}`)).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test("Draft it in Improve as a verified contributor: the help line, the draft posted with its key and the page's language, and the page at the draft's edit page (48 § 8.1, § 8.2; unit 74)", async ({ browser, baseURL }) => {
      const { context, page } = await opened(browser, baseURL, `/${locale}/research?research=${drafterSeeded.done}`, VIEWPORT, { name: "research-drafter", account: DRAFTER });
      try {
        const finding = page.locator('.dock[data-dock="research"] article.run').first().locator("section.finding").first();
        const findingId = (await finding.getAttribute("data-finding")) ?? "";
        const button = finding.getByRole("button", { name: m.findings.draft, exact: true });
        await expect(button).toBeEnabled();
        await expect(finding.getByRole("button", { name: m.findings.send, exact: true })).toHaveCount(0);
        await expect(button).toHaveAccessibleDescription(m.findings.draftHelp);
        expect(await axeFindings(page, `research-draft-button-${locale}`)).toEqual([]);
        /* the draft answered here, as the endpoint would: a real one starts a grading per source, which this suite must not */
        const href = `/${locale}/improve/S-21-0999/edit`;
        const posts: Array<{ readonly key: string | undefined; readonly body: string | null }> = [];
        await page.route(`**/api/v1/research/findings/${findingId}/draft`, async (route) => {
          posts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
          await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ suggestionId: "S-21-0999", href, items: 2 }) });
        });
        await button.click();
        await page.waitForURL((url) => url.pathname === href);
        expect(posts).toEqual([{ key: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string, body: JSON.stringify({ locale }) }]);
      } finally {
        await context.close();
      }
    });

    test("Delete research from the list: the dialog, cancelled then confirmed, the page after it with New research in focus (48 § 11.8; unit 73)", async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL ?? "").origin;
      const { context, page } = await opened(browser, baseURL, `/${locale}/research`);
      let id: string | null = null;
      try {
        const created = await context.request.post("/api/v1/research/conversations", { headers: { origin }, data: { locale } });
        expect(created.status()).toBe(201);
        id = ((await created.json()) as { id: string }).id;
        const research = id;
        await page.goto(`/${locale}/research?research=${research}`, { waitUntil: "networkidle" });
        const list = page.locator("nav.assistant-conversations");
        /* a research with no record offers no export */
        await expect(list.locator(".log-foot a[download]")).toHaveCount(0);
        const trigger = list.getByRole("button", { name: m.delete.trigger, exact: true });
        /* a research of no section is named by no chapter */
        const dialog = page.getByRole("dialog", { name: m.delete.titleNone });
        await openDialog(trigger, dialog);
        await expect(dialog).toContainText(m.delete.body);
        expect(await axeFindings(page, `research-delete-dialog-${locale}`)).toEqual([]);
        await dialog.getByRole("button", { name: m.delete.cancel, exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        expect((await context.request.get(`/api/v1/research/conversations/${research}`)).status()).toBe(200);

        await openDialog(trigger, dialog);
        await dialog.getByRole("button", { name: m.delete.confirm, exact: true }).click();
        await page.waitForURL(`**/${locale}/research?deleted=${research}`);
        await expect(list.getByRole("status")).toHaveText(m.delete.done);
        const fresh = list.getByRole("link", { name: m.list.new, exact: true });
        await expect(fresh).toBeFocused();
        await expect(fresh).toHaveAccessibleDescription(m.delete.done);
        expect((await context.request.get(`/api/v1/research/conversations/${research}`)).status()).toBe(404);
        id = null;
        expect(await axeFindings(page, `research-deleted-${locale}`)).toEqual([]);
      } finally {
        if (id !== null) await context.request.delete(`/api/v1/research/conversations/${id}`, { headers: { origin } });
        await context.close();
      }
    });

    test("axe finds nothing on the empty, seeded, under-way, done, refused, stopped and purged states (48 § 26)", async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const { context, page } = await opened(browser, baseURL, `/${locale}/research`);
      try {
        const states: ReadonlyArray<readonly [string, string]> = [
          ["empty", `/${locale}/research`],
          ["seeded", `/${locale}/research?from=${seeded.seedAnswer}`],
          ["under-way", `/${locale}/research?research=${seeded.underWay}`],
          ["done", `/${locale}/research?research=${seeded.done}`],
          ["refused", `/${locale}/research?research=${seeded.refused}`],
          ["stopped", `/${locale}/research?research=${seeded.stopped}`],
          ["purged", `/${locale}/research?research=${seeded.purged}`],
        ];
        const findings: string[] = [];
        for (const [name, path] of states) {
          await page.goto(path, { waitUntil: "networkidle" });
          findings.push(...(await axeFindings(page, `research-${name}-${locale}`)).map((finding) => `${finding.screen}: ${finding.rule} (${String(finding.nodes)}) ${finding.target}`));
        }
        expect(findings).toEqual([]);
      } finally {
        await context.close();
      }
    });
  });
}

test("research · en · the columns at each width, and no horizontal overflow (48 § 11.2)", async ({ browser, baseURL }) => {
  const widths: ReadonlyArray<{ readonly width: number; readonly columns: readonly [boolean, boolean, boolean] }> = [
    { width: 1440, columns: [true, true, true] },
    { width: 1360, columns: [true, true, true] },
    { width: 1200, columns: [false, true, true] },
    { width: 1000, columns: [false, true, true] },
    { width: 900, columns: [false, true, false] },
    { width: 390, columns: [false, true, false] },
  ];
  for (const { width, columns } of widths) {
    const { context, page } = await opened(browser, baseURL, `/en/research?research=${seeded.done}`, { width, height: 900 });
    try {
      const shown = await Promise.all(["nav.assistant-conversations", '.dock[data-dock="research"]', ".assistant-stats"].map((selector) => page.locator(selector).isVisible()));
      expect(shown, `${String(width)}px`).toEqual(columns);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${String(width)}px`).toBe(0);
      /* between 1000px and 1359px the researches open over the page from the column's header; under 1000px the region switch puts them in front */
      if (width >= 1000 && width < 1360) {
        await page.locator('.dock[data-dock="research"] .log-toggle').click();
        await expect(page.locator("nav.assistant-conversations")).toBeVisible();
      }
      if (width < 1000) await expect(page.locator("nav.assistant-views")).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test("research · en · after a delete, between 1000px and 1359px, the researches' overlay stands open to say so (48 § 11.8; unit 73)", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.research;
  const origin = new URL(baseURL ?? "").origin;
  const { context, page } = await opened(browser, baseURL, "/en/research", { width: 1200, height: 900 });
  let id: string | null = null;
  try {
    const created = await context.request.post("/api/v1/research/conversations", { headers: { origin }, data: { locale: "en" } });
    id = ((await created.json()) as { id: string }).id;
    const research = id;
    await page.goto(`/en/research?research=${research}`, { waitUntil: "networkidle" });
    const list = page.locator("nav.assistant-conversations");
    await page.locator('.dock[data-dock="research"] .log-toggle').click();
    await expect(list).toBeVisible();
    const dialog = page.getByRole("dialog", { name: m.delete.titleNone });
    await openDialog(list.getByRole("button", { name: m.delete.trigger, exact: true }), dialog);
    await dialog.getByRole("button", { name: m.delete.confirm, exact: true }).click();
    await page.waitForURL(`**/en/research?deleted=${research}`);
    id = null;
    await expect(list).toBeVisible();
    await expect(list.getByRole("status")).toHaveText(m.delete.done);
    const fresh = list.getByRole("link", { name: m.list.new, exact: true });
    await expect(fresh).toBeFocused();
    /* leaving the delete's page starts the column again: the overlay it opened closes, and the field takes the focus */
    await fresh.click();
    await page.waitForURL(/\/en\/research$/);
    await expect(list).toBeHidden();
    await expect(page.getByLabel(m.composer.ask, { exact: true })).toBeFocused();
  } finally {
    if (id !== null) await context.request.delete(`/api/v1/research/conversations/${id}`, { headers: { origin } });
    await context.close();
  }
});

test("research · en · the first start after a delete keeps what it shows: a 503's question, box and Retry stay through the start's refresh (48 § 11.8, § 18; review of unit 73)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const m = CATALOGUES.en.research;
  const errors = CATALOGUES.en.api.errors;
  const origin = new URL(baseURL ?? "").origin;
  const { context, page } = await opened(browser, baseURL, "/en/research");
  /* both researches, the deleted one's second delete answered 404 */
  const made: string[] = [];
  try {
    const created = await context.request.post("/api/v1/research/conversations", { headers: { origin }, data: { locale: "en" } });
    expect(created.status()).toBe(201);
    const research = ((await created.json()) as { id: string }).id;
    made.push(research);
    await page.goto(`/en/research?research=${research}`, { waitUntil: "networkidle" });
    const list = page.locator("nav.assistant-conversations");
    const dialog = page.getByRole("dialog", { name: m.delete.titleNone });
    await openDialog(list.getByRole("button", { name: m.delete.trigger, exact: true }), dialog);
    await dialog.getByRole("button", { name: m.delete.confirm, exact: true }).click();
    await page.waitForURL(`**/en/research?deleted=${research}`);
    await expect(list.getByRole("status")).toHaveText(m.delete.done);

    /* a new research is opened for real; its run's start is answered 503, so nothing runs */
    await page.route("**/api/v1/research/conversations/*/runs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      return route.fulfill({ status: 503, json: { code: "RESEARCH_UNAVAILABLE", message: errors.RESEARCH_UNAVAILABLE, traceId: "e2e" } });
    });
    const dock = page.locator('.dock[data-dock="research"]');
    const field = page.getByLabel(m.composer.ask, { exact: true });
    await field.fill(QUESTION);
    await dock.getByRole("button", { name: m.composer.submit, exact: true }).click();
    await page.waitForURL(/[?&]research=/);
    made.push(new URL(page.url()).searchParams.get("research") ?? "");
    /* the line saying the delete happened goes once the start's refresh has rendered the page without `deleted`: a
       column keyed by `deleted` was mounted again there, and lost the question, the box and its Retry */
    await expect(list.getByRole("status")).toHaveCount(0);
    const box = dock.locator('[role="log"] .error');
    await expect(box).toContainText(m.errors.notStarted);
    await expect(box).toContainText(errors.RESEARCH_UNAVAILABLE);
    await expect(dock.getByRole("button", { name: m.errors.retry, exact: true })).toBeVisible();
    await expect(field).toHaveValue(QUESTION);
    await expect(field).toBeFocused();
  } finally {
    for (const id of made) await context.request.delete(`/api/v1/research/conversations/${id}`, { headers: { origin } });
    await context.close();
  }
});

test("research · en · Copy report puts the paragraphs with their markers and the pages they cite on the clipboard, and the status bar says copied (48 § 11.9; unit 73)", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.research;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT, permissions: ["clipboard-read", "clipboard-write"] });
  try {
    await context.addCookies(await accountSession(browser, baseURL, "research", RESEARCHER));
    const page = await context.newPage();
    await page.goto(`/en/research?research=${seeded.done}`, { waitUntil: "networkidle" });
    await page.locator('.dock[data-dock="research"] article.run').first().getByRole("button", { name: m.actions.copy, exact: true }).click();
    await expect(page.locator(".statusbar [role=status]")).toHaveText(m.actions.copied);
    /* the system's clipboard may give the lines back with its own line ends (CRLF on Windows) */
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    /* the seed's first report: three paragraphs, the second's pages marked in its text, the sections as `[21.3]`, then the pages they cite */
    expect(copied.split("\n\n")).toEqual([
      "Stripe keeps an idempotency key for 24 hours after the first request; a write retried after that is processed as a new one [1]. The section gives no window for how long a key is kept. [21.3]",
      "PayPal documents the same floor for its payment requests [2], and the draft HTTP standard leaves the window to the server while naming 24 hours as common [4].",
      "None of the pages read changes the figures of the next section. [21.4]",
      [
        "[1] Idempotent requests · https://docs.stripe.com/api/idempotent_requests",
        "[2] Idempotency guidelines for retried payment requests and their keys · https://developer.paypal.com/reference/guidelines/idempotency/",
        "[4] The Idempotency-Key HTTP Header Field · https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/",
      ].join("\n"),
    ]);
  } finally {
    await context.close();
  }
});
