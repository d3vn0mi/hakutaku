// The performance budgets, end to end. The 20,000-file repo opens at Core depth within its
// budget, and Find answers within its budget there and on the sample. No step of an interaction
// blocks the page: Find, the selection it makes, and the 6,000-line Source tab, which a worker
// highlights in chunks.
//
// Without HAKUTAKU_BENCH=1, the looser bounds a shared CI runner can keep apply. With it (npm run
// bench:viewer, on a mid-range laptop), every check is held to the laptop's budget, and two more
// are defined: the frames per second of a scripted pan and zoom, and the tab's memory. A shared
// runner has no GPU, so its frame rate and memory say nothing about a laptop's, and CI does not
// even list those two.
import { expect, type Page, test } from "@playwright/test";
import {
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  firstViewMs,
  formatId,
  hasWebGL,
  lastMeasure,
  mapDrawn,
  openViewer,
  watchFirstView,
  watchLongTasks,
} from "./helpers.js";

const BENCH = process.env.HAKUTAKU_BENCH === "1";
const CODE = 0; // FILE_KINDS.indexOf("code")
const FIND = "hakutaku:find";
// The longest task an interaction may run in Chromium, which reports long tasks. Firefox reports
// none, so there the same interaction must complete, from its first key to the Source tab's last
// line, within the second bound.
const LONGEST_TASK_MS = BENCH ? 50 : 200;
const INTERACTION_MS = BENCH ? 3000 : 10_000;

// The value, or a failure naming what the repo lacks.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`there is no ${what}`);
  }
  return value;
}

const box = (page: Page) =>
  page.getByRole("combobox", { name: "Find in the code map" });
// the matches in Find's list, not the choices of the filters' selects
const matches = (page: Page) => page.getByRole("listbox").getByRole("option");

// Presses F and types the query one key at a time; returns how long the search for the whole
// query took. Each key searches once, so the page has then recorded one more hakutaku:find for
// each key, the last for the whole query.
async function findMs(page: Page, query: string): Promise<number> {
  const count = () =>
    page.evaluate((name) => performance.getEntriesByName(name).length, FIND);
  const before = await count();
  await page.keyboard.press("f");
  await expect(box(page)).toBeFocused();
  await page.keyboard.type(query);
  await expect(box(page)).toHaveValue(query);
  await expect.poll(count).toBe(before + query.length);
  return lastMeasure(page, FIND);
}

test("the 20,000-file map opens at Core depth within budget, and Find stays within 50 ms", async ({
  page,
  browserName,
}) => {
  // The global setup builds the 20,000-file repo when CI is set or HAKUTAKU_E2E_WITH_SCALE=1.
  // Without either the test is skipped; with one, the repo must be there.
  const built =
    Boolean(process.env.CI) || process.env.HAKUTAKU_E2E_WITH_SCALE === "1";
  test.skip(
    !built,
    "the 20,000-file repo is built only when CI is set or HAKUTAKU_E2E_WITH_SCALE=1",
  );
  test.setTimeout(180_000);
  const scale = must(E2E.scale, "20,000-file repo served by the global setup");
  const m = await fetchMap(scale);
  expect(m.files).toHaveLength(20_000);
  const top = must(
    m.files.find((f) => f[F.kind] === CODE && f[F.rank] === 1),
    "production file of rank 1",
  );
  await watchFirstView(page);
  await openViewer(page, scale);
  await expect(
    page.locator("#depth").getByRole("button", { name: /^Core/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  expect(await firstViewMs(page, webgl)).toBeLessThanOrEqual(
    BENCH ? 3000 : 9000,
  );
  // the most depended-on file, by its name, from the keyboard alone
  const path = top[F.path];
  expect(
    await findMs(page, path.slice(path.lastIndexOf("/") + 1)),
  ).toBeLessThanOrEqual(50);
  await expect(matches(page).first().locator("span")).toHaveText(path);
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail")).toHaveAttribute(
    "data-node-id",
    formatId({ kind: "file", repo: m.repo, path }),
  );
});

test("Find on the sample stays within its budget", async ({ page }) => {
  await openViewer(page, E2E.sample);
  expect(await findMs(page, "orbit")).toBeLessThanOrEqual(BENCH ? 30 : 50);
  await expect(matches(page).first()).toBeVisible();
});

test("no interaction blocks the page", async ({ page, browserName }) => {
  // Each long task, by its start and length, in a browser that reports them, and the moment the
  // Source tab's code says it is complete.
  const watched = await watchLongTasks(page);
  await page.addInitScript(() => {
    const seen = { complete: null as number | null };
    Object.defineProperty(window, "__hakutakuComplete", { value: seen });
    new MutationObserver(() => {
      if (
        seen.complete === null &&
        document.querySelector('.code[data-complete="true"]') !== null
      ) {
        seen.complete = performance.now();
      }
    }).observe(document, {
      attributes: true,
      attributeFilter: ["data-complete"],
      childList: true,
      subtree: true,
    });
  });
  await openViewer(page, E2E.bigfile);
  // from the first key on; the page's own load is another matter
  const from = await page.evaluate(() => performance.now());
  await page.keyboard.press("f");
  await page.keyboard.type("target");
  await expect(matches(page).first().locator("span")).toHaveText(/^target\b/);
  await page.keyboard.press("Enter");
  // a definition picked in Find opens on its Source tab, a file of 6,000 lines
  await expect(page.locator("#detail")).toHaveAttribute(
    "data-node-id",
    "bigfile:src/big.ts#target",
  );
  await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('.code[data-complete="true"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".code .line")).toHaveCount(6000);
  // the frames after the last chunk, whose layout is part of rendering it
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(done, 0)),
        ),
      ),
  );
  const took = await page.evaluate((start) => {
    const seen = (
      window as unknown as { __hakutakuComplete: { complete: number | null } }
    ).__hakutakuComplete;
    return seen.complete === null ? null : seen.complete - start;
  }, from);
  const blocks = { ...(await watched(from)), took };
  if (browserName === "chromium") {
    expect(blocks.recorded).toBe(true);
    expect(blocks.longest).toBeLessThan(LONGEST_TASK_MS);
  } else {
    // Firefox reports no long tasks: the same interaction must complete within its bound
    expect(blocks.recorded).toBe(false);
    expect(must(blocks.took, "moment the Source tab completed")).toBeLessThan(
      INTERACTION_MS,
    );
  }
});

// The frames the page draws per second while the mouse drags the map back and forth and the
// wheel zooms it in and out, for ms milliseconds: requestAnimationFrame's callbacks, counted in
// the page.
async function panAndZoomFps(page: Page, ms: number): Promise<number> {
  const area = must(await page.locator("#sigma").boundingBox(), "map's box");
  const x = area.x + area.width / 2;
  const y = area.y + area.height / 2;
  await page.evaluate(() => {
    const frames = { count: 0, first: 0, last: 0, on: true };
    Object.defineProperty(window, "__hakutakuFrames", { value: frames });
    const tick = (now: number) => {
      if (frames.count === 0) frames.first = now;
      frames.count++;
      frames.last = now;
      if (frames.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const until = Date.now() + ms;
  for (let i = 0; Date.now() < until; i++) {
    const way = i % 2 === 0 ? 1 : -1;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 120 * way, y + 60 * way, { steps: 12 });
    await page.mouse.up();
    await page.mouse.wheel(0, -240 * way);
  }
  return page.evaluate(() => {
    const frames = (
      window as unknown as {
        __hakutakuFrames: {
          count: number;
          first: number;
          last: number;
          on: boolean;
        };
      }
    ).__hakutakuFrames;
    frames.on = false;
    return ((frames.count - 1) * 1000) / (frames.last - frames.first);
  });
}

// Chromium's JS heap total for the page, in MB, through the DevTools protocol.
async function jsHeapTotalMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const total = must(
    metrics.find((metric) => metric.name === "JSHeapTotalSize"),
    "JSHeapTotalSize in Chromium's metrics",
  );
  return total.value / (1024 * 1024);
}

// What the bench holds a laptop to while the map is panned and zoomed: frames per second, and
// the tab's memory in MB.
const PAN_AND_ZOOM = [
  { name: "sample", link: () => E2E.sample, fps: 57, mb: 250 },
  {
    name: "20,000 files",
    link: () =>
      must(
        E2E.scale,
        "20,000-file repo (the bench sets HAKUTAKU_E2E_WITH_SCALE=1)",
      ),
    fps: 30,
    mb: 600,
  },
];

// Defined only for the bench, so a run without it does not list them at all. The laptop's
// browsers both draw the map; its memory is read in Chromium, which reports it.
for (const { name, link, fps, mb } of BENCH ? PAN_AND_ZOOM : []) {
  test(`pan, zoom and memory: ${name}`, async ({ page, browserName }) => {
    test.setTimeout(180_000);
    await openViewer(page, link());
    expect(await hasWebGL(page), "the bench needs a browser that draws").toBe(
      true,
    );
    expect(await mapDrawn(page)).toBe(true);
    expect(await panAndZoomFps(page, 2000)).toBeGreaterThanOrEqual(fps);
    if (browserName === "chromium") {
      expect(await jsHeapTotalMB(page)).toBeLessThanOrEqual(mb);
    }
  });
}
