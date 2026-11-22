// The served viewer on the sample, end to end: it loads under its CSP from its own server only,
// and a map that cannot load says why.
import { expect, test } from "@playwright/test";
import { E2E, openViewer, query, requestLog, watchCsp } from "./helpers.js";

test("the sample loads under its CSP, from its own server only", async ({
  page,
}) => {
  const violations = await watchCsp(page);
  const log = requestLog(page, new URL(E2E.sample).origin);
  await openViewer(page, E2E.sample, { ready: "data" });
  const overview = JSON.parse(
    query("code_overview", "observatory", { repo: "observatory" }),
  );
  await expect(page.locator(".brand")).toContainText(
    `observatory \u00b7 ${overview.builtCommit}`,
  );
  await expect(page).toHaveTitle("hakutaku \u00b7 observatory");
  expect(await violations()).toEqual([]);
  expect(log.outside).toEqual([]);
});

test("a map that cannot load says why", async ({ page }) => {
  await page.route("**/api/map", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "not_built", message: "not built", reason: "no store" },
      }),
    }),
  );
  await page.goto(E2E.sample);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "error");
  await expect(page.locator("#fatal")).toContainText("hakutaku map");
});
