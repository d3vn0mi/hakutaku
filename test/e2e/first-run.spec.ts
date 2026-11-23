// A first run on the sample, end to end: once the sample is mapped, hakutaku view shows its map
// within the budget, or, in a browser without WebGL, the list view in the map's place within the
// same budget; and Find reaches every production file from the keyboard. HAKUTAKU_BENCH=1 holds
// the time to the budget a mid-range laptop must meet (npm run bench:viewer); without it, the
// looser bound a shared CI runner can keep applies.
import { expect, test } from "@playwright/test";
import {
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  firstViewMs,
  formatId,
  hasWebGL,
  mapDrawn,
  openViewer,
  watchFirstView,
} from "./helpers.js";

const BENCH = process.env.HAKUTAKU_BENCH === "1";
const CODE = 0; // FILE_KINDS.indexOf("code")

test("map then view shows the map, or the list view in its place, within budget", async ({
  page,
  browserName,
}) => {
  await watchFirstView(page);
  await openViewer(page, E2E.sample);
  // Chromium draws with SwiftShader, so it must always draw; a browser without WebGL shows the
  // list view in the map's place, and is held to the same budget
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  expect(await firstViewMs(page, webgl)).toBeLessThanOrEqual(
    BENCH ? 1000 : 3000,
  );
});

test("every production file can be reached by Find", async ({ page }) => {
  test.setTimeout(180_000);
  const m = await fetchMap(E2E.sample);
  const production = m.files.filter((f) => f[F.kind] === CODE);
  expect(production.length).toBeGreaterThan(0);
  await openViewer(page, E2E.sample);
  const detail = page.locator("#detail");
  for (const f of production) {
    // the whole path, then Enter, which picks the first match
    await page.locator("#q").fill(f[F.path]);
    await page.keyboard.press("Enter");
    await expect(detail).toHaveAttribute(
      "data-node-id",
      formatId({ kind: "file", repo: m.repo, path: f[F.path] }),
    );
  }
});
