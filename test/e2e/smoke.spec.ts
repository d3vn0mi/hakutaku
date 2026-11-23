// The served viewer on the sample, end to end: it loads under its CSP from its own server only,
// a map that cannot load says why, and the page --open hands the opener sends the browser on to
// the link.
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { openBrowser } from "../../dist/viewer/server.js";
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

test("the page --open hands the opener sends the browser on to the link, session and all", async ({
  page,
}) => {
  // the opener as openBrowser runs it, given the page's path in place of the link
  const handed: string[][] = [];
  const opened = openBrowser(E2E.sample, {
    platform: "linux",
    spawn: ((_: string, args: string[]) => {
      handed.push(args);
      return { on() {}, unref() {} };
    }) as never,
    dir: E2E.root,
  });
  try {
    expect(handed).toHaveLength(1);
    const [path = ""] = handed[0] ?? [];
    expect(path).toMatch(/\.html$/);
    expect(path).not.toContain("?s=");
    await page.goto(pathToFileURL(path).href, { waitUntil: "commit" });
    await expect(page).toHaveURL(E2E.sample);
    // the session came along: the API gives the page its map only with it
    await expect(page.locator("html")).toHaveAttribute(
      "data-ready",
      /^(?:data|map|nomap)$/,
      { timeout: 60_000 },
    );
  } finally {
    opened.remove();
  }
});
