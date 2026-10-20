import { expect, test } from "@playwright/test";

import { loadRubric } from "@/lib/rubrics/load";
import { CHANGE_CLASSES } from "@/lib/schemas/improve";
import { E2E_LOCALES } from "@/lib/schemas/e2e";

import { axeFindings, CATALOGUES, fill, VIEWPORT } from "./support";

/*
 * The Rubric page (feature-specs/30 § 6, § 10.7): at 1440 and at 390, in EN and in PT, the screen's structure is
 * there, every number on it is the published file's, and axe finds nothing. The file is read from the repository,
 * not typed here, so a rubric that changes changes what this expects.
 *
 * It leaves no part for the report: it measures no criterion of a gate.
 */

const { rubric, sha256 } = loadRubric("v1.2");
const PHONE = { width: 390, height: 844 } as const;

for (const locale of E2E_LOCALES) {
  for (const [name, viewport] of [
    ["desktop", VIEWPORT],
    ["phone", PHONE],
  ] as const) {
    test(`the rubric page · ${locale} · ${name}`, async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const m = CATALOGUES[locale].rubric;
      const context = await browser.newContext({ baseURL, viewport });
      try {
        const page = await context.newPage();
        const response = await page.goto(`/${locale}/rubric`, { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);
        await expect(page.getByRole("heading", { level: 1, name: m.title })).toBeVisible();

        /* The tiers, in order, with the file's bases. */
        const tiers = page.getByRole("region", { name: m.tiers.label });
        await expect(tiers.locator("tbody tr")).toHaveCount(8);
        await expect(tiers.locator(".rubric-base")).toHaveText(Object.values(rubric.tiers).map((tier) => String(tier.base)));
        for (const [tier, label] of Object.entries(m.tiers.name)) await expect(tiers.getByText(label, { exact: true }), tier).toBeVisible();

        /* The scoring rule, stated once, with the file's bonus and tier. */
        await expect(page.getByText(m.rule.statement, { exact: true })).toBeVisible();
        await expect(page.getByText(fill(m.rule.formulaBonus, { bonus: rubric.adjustments.corroboration.bonus, tier: rubric.adjustments.corroboration.minTier }))).toBeVisible();

        /* The chips: seven rows and the row of the tiers the book never cites. */
        const chips = page.getByRole("region", { name: m.chips.label });
        await expect(chips.locator("tbody tr")).toHaveCount(8);

        /* The adjustments: the file's factors, formatted for the language. */
        const factor = (value: number) => new Intl.NumberFormat(locale === "pt" ? "pt-BR" : "en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
        const adjustments = page.getByRole("region", { name: m.adjustments.label });
        const { relevance, recency, independence, corroboration } = rubric.adjustments;
        await expect(adjustments.locator("td.n")).toHaveText([
          [relevance.direct, relevance.partial, relevance.tangential].map(factor).join(" / "),
          [...recency.windows.map((window) => window.factor), recency.older].map(factor).join(" / "),
          [independence.none, independence.vendor, independence.employer].map(factor).join(" / "),
          fill(m.adjustments.corroboration.value, { bonus: corroboration.bonus }),
        ]);

        /* The thresholds: every class, its two numbers from the file, the curator's class with none. */
        const thresholds = page.getByRole("region", { name: m.thresholds.label });
        const rows = thresholds.locator("tbody tr");
        await expect(rows).toHaveCount(CHANGE_CLASSES.length);
        for (const [index, changeClass] of CHANGE_CLASSES.entries()) {
          const threshold = rubric.thresholds[changeClass];
          const cells = rows.nth(index).locator("td");
          await expect(cells.nth(0), changeClass).toContainText(m.thresholds.class[changeClass]);
          if (threshold === null) {
            await expect(cells.nth(1), changeClass).toHaveText(m.thresholds.curatorAlways);
          } else {
            await expect(cells.nth(1), changeClass).toContainText(String(threshold.acceptAt));
            await expect(cells.nth(2), changeClass).toHaveText(String(threshold.floorAt));
            await expect(cells.nth(3).getByRole("img"), changeClass).toHaveAttribute("aria-label", fill(m.thresholds.bar, { floor: threshold.floorAt, accept: threshold.acceptAt }));
          }
        }

        /* The four worked examples: each one's score and decision from the file. */
        const examples = page.locator(".rubric-example");
        await expect(examples).toHaveCount(rubric.examples.length);
        for (const [index, example] of rubric.examples.entries()) {
          await expect(examples.nth(index), example.id).toContainText(example.id);
          await expect(examples.nth(index).locator(".rubric-math-result"), example.id).toContainText(fill(m.examples.result, { score: example.score }));
          await expect(examples.nth(index).locator(".st-block"), example.id).toHaveText(m.examples.status[example.decision]);
        }

        /* The changelog ends with this version; the status bar names the version and the file's hash. */
        await expect(page.locator(".rubric-changelog-cell")).toHaveCount(rubric.changelog.length);
        await expect(page.locator(".rubric-changelog-current")).toContainText(rubric.version);
        const status = page.locator("footer.statusbar");
        await expect(status).toContainText(fill(m.statusbar.page, { version: rubric.version }));
        if (name === "desktop") await expect(status).toContainText(fill(m.statusbar.sha, { sha: sha256.slice(0, 8) }));

        /* The download is the second endpoint, and nothing is offered that is not built. */
        await expect(page.getByRole("link", { name: fill(m.download, { version: rubric.version }), exact: true })).toHaveAttribute("href", `/api/v1/rubric/${rubric.version}`);
        await expect(page.getByText("Suggest a change", { exact: true })).toHaveCount(0);

        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect(sideways, "the page scrolls sideways").toBe(false);
        expect(await axeFindings(page, `rubric ${locale} ${name}`)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

test("opened from a chapter, the header says so and links back; otherwise it does not", async ({ browser, baseURL }) => {
  const m = CATALOGUES.en.rubric;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto("/en/rubric?from=15.9");
    const opened = page.getByRole("link", { name: fill(m.openedFrom, { chapter: "15", section: "15.9" }), exact: true });
    await expect(opened).toBeVisible();
    await expect(opened).toHaveAttribute("href", "/en/ch/15/15.9");
    await page.goto("/en/rubric?from=nonsense");
    await expect(page.getByText(fill(m.openedFrom, { chapter: "15", section: "15.9" }))).toHaveCount(0);
    await page.goto("/en/rubric");
    await expect(page.locator(".rubric-head-caps a.cap")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
