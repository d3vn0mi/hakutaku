// The galaxy on the sample, end to end: at Files depth the map draws every production file, hub
// and library with the sample's import curves, the panels around it read from the same map, and
// the zoom controls are named buttons. A browser that cannot draw the map shows the list view in
// its place, with the same files, and no zoom.
import { expect, test } from "@playwright/test";
import type { HistoryData, MapData } from "../../src/query/view/index.js";
import {
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  hasWebGL,
  listView,
  mapDrawn,
  openViewer,
} from "./helpers.js";

const fmt = (n: number) => n.toLocaleString("en-US");
// "1 importer", "2 importers": one in the singular, as the lists count.
const count = (n: number, one: string) =>
  `${fmt(n)} ${n === 1 ? one : `${one}s`}`;

// GET history from the server of a link, with the link's session.
async function fetchHistory(url: string): Promise<HistoryData> {
  const link = new URL(url);
  const r = await fetch(new URL("/api/history", link), {
    headers: { "x-hakutaku-session": link.searchParams.get("s") ?? "" },
  });
  if (!r.ok) throw new Error(`GET /api/history answered ${r.status}`);
  return (await r.json()) as HistoryData;
}

test("draws the sample's production files, hubs and libraries at Files depth", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  await openViewer(page, E2E.sample);
  // Chromium draws with SwiftShader, so it must always draw. A browser that has no WebGL at
  // all, as headless Firefox can be, must say so in place of the map.
  const webgl = await hasWebGL(page);
  // once per browser in the run's output, so that a CI log says which path each browser took
  console.log(`webgl: ${browserName} ${webgl}`);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // the list view, in the map's place, holds the same production files
    await expectNoWebGL(page);
    await expect(listView(page).getByRole("button")).toHaveCount(
      m.counts.productionFiles,
    );
    return;
  }
  await expect(page.locator("#map-notice")).toBeHidden();
  await expect(listView(page)).toBeHidden();
  const hubs = m.components.filter((c) => c[1] > 0).length; // a hub per component that holds production files
  const map = page.locator("#map");
  await expect(map).toHaveAttribute(
    "data-nodes",
    String(m.counts.productionFiles + hubs + m.counts.libraries),
  );
  await expect(map).toHaveAttribute("data-hubs", String(hubs));
  // tests are hidden at first, so a curve joins two production files; each pair is drawn once
  const curves = new Set<string>();
  for (let i = 0; i < m.imports.length; i += 3) {
    const [src, dst] = [m.imports[i], m.imports[i + 1]];
    if (m.files[src][F.kind] === 0 && m.files[dst][F.kind] === 0)
      curves.add(`${src} ${dst}`);
  }
  await expect(map).toHaveAttribute("data-curves", String(curves.size));
  await expect(map).toHaveAttribute("data-dimmed", "0");
  await expect(map).toHaveAttribute("data-cochange", "0");
});

test("the stat band, legend and bottom panels read from the map", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const history = await fetchHistory(E2E.sample);
  await openViewer(page, E2E.sample);
  const n = (k: string) => page.locator(`#statband [data-stat="${k}"] b`);
  await expect(n("files")).toHaveText(
    m.counts.productionFiles.toLocaleString("en-US"),
  );
  await expect(n("entries")).toHaveText(String(m.counts.entryPoints));
  await expect(n("components")).toHaveText(String(m.counts.components));
  await expect(n("cycles")).toHaveText(String(m.counts.cycles));
  await expect(n("tests")).toHaveText(m.counts.tests.toLocaleString("en-US"));
  await expect(page.locator("#legend")).toHaveText(
    "Each dot is a file. The closer to the centre, the more of the code depends on it. Curves through the middle are imports between components.",
  );

  const top = m.files.findIndex((f) => f[F.rank] === 1);
  const importers = new Set<number>();
  for (let i = 0; i < m.imports.length; i += 3)
    if (m.imports[i + 1] === top) importers.add(m.imports[i]);
  const core = page.locator("#core-list li").first();
  await expect(core).toContainText(m.files[top][F.path]);
  await expect(core.locator(".v")).toHaveText(
    count(importers.size, "importer"),
  );

  const hot = m.files
    .filter((f) => f[F.kind] === 0 && f[F.hotspot] > 0)
    .sort(
      (a, b) =>
        b[F.hotspot] - a[F.hotspot] ||
        a[F.rank] - b[F.rank] ||
        (a[F.path] < b[F.path] ? -1 : 1),
    )[0];
  expect(hot).toBeDefined();
  await expect(page.locator("#hot-list li").first()).toContainText(hot[F.path]);
  await expect(page.locator("#hot-list li").first().locator(".v")).toHaveText(
    count(hot[F.churn], "change"),
  );

  await expect(page.locator("#timeline rect")).toHaveCount(26);
  // the latest week, and only that one, is drawn in the accent
  await expect(page.locator("#timeline rect.now")).toHaveCount(1);
  await expect(page.locator("#timeline rect").last()).toHaveClass(/\bnow\b/);
  await expect(page.locator("#timeline rect.now")).toHaveCSS(
    "fill",
    "rgb(232, 97, 60)",
  );
  await expect(page.locator("#timeline rect title")).toHaveText(
    history.weeks.map(
      (w) =>
        `${count(w.commits, "commit")}, week of ${new Date(w.start * 1000).toISOString().slice(0, 10)}`,
    ),
  );
  const peak = Math.max(0, ...history.weeks.map((w) => w.commits));
  await expect(page.locator("#timeline .peak")).toHaveText(
    `peak ${count(peak, "commit")}/week`,
  );
});

test("the stat band, the Core and Hotspots lists and the change activity count one thing in the singular", async ({
  page,
}) => {
  // the sample's history with one commit in every week, so the peak is one commit too
  await page.route("**/api/history", async (route) => {
    const response = await route.fetch();
    const history = (await response.json()) as HistoryData;
    await route.fulfill({
      response,
      json: {
        ...history,
        weeks: history.weeks.map((w) => ({ ...w, commits: 1 })),
      },
    });
  });
  // the sample's map with one importer left to the file of rank 1, and one change to the top
  // hotspot: neither moves in its list
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    const top = map.files.findIndex((f) => f[F.rank] === 1);
    const hot = map.files
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f[F.kind] === 0 && f[F.hotspot] > 0)
      .sort(
        (a, b) =>
          b.f[F.hotspot] - a.f[F.hotspot] ||
          a.f[F.rank] - b.f[F.rank] ||
          (a.f[F.path] < b.f[F.path] ? -1 : 1),
      )[0].i;
    const imports: number[] = [];
    let kept = false;
    for (let i = 0; i < map.imports.length; i += 3) {
      if (map.imports[i + 1] === top) {
        if (kept) continue;
        kept = true;
      }
      imports.push(map.imports[i], map.imports[i + 1], map.imports[i + 2]);
    }
    const files = map.files.map((f, i) => {
      if (i !== hot) return f;
      const changed = [...f] as typeof f;
      changed[F.churn] = 1;
      return changed;
    });
    // and one of each thing the stat band counts
    const counts = {
      ...map.counts,
      productionFiles: 1,
      entryPoints: 1,
      components: 1,
      cycles: 1,
      tests: 1,
    };
    await route.fulfill({
      response,
      json: { ...map, imports, files, counts },
    });
  });
  await openViewer(page, E2E.sample);
  await expect(page.locator("#core-list li").first().locator(".v")).toHaveText(
    "1 importer",
  );
  await expect(page.locator("#hot-list li").first().locator(".v")).toHaveText(
    "1 change",
  );
  await expect(page.locator("#statband button span")).toHaveText([
    "code file",
    "entry point",
    "component",
    "cycle",
    "test",
  ]);
  await expect(page.locator("#statband button b")).toHaveText([
    "1",
    "1",
    "1",
    "1",
    "1",
  ]);
  await expect(page.locator("#timeline rect")).toHaveCount(26);
  await expect(page.locator("#timeline rect title").first()).toHaveText(
    /^1 commit, week of \d{4}-\d{2}-\d{2}$/,
  );
  await expect(page.locator("#timeline .peak")).toHaveText(
    "peak 1 commit/week",
  );
});

test("an empty Core or Hotspots list says why it is empty", async ({
  page,
}) => {
  // the sample holds more code files than the lists show
  expect((await fetchMap(E2E.sample)).counts.productionFiles).toBeGreaterThan(
    5,
  );
  const core = page.locator("#core-list");
  const hot = page.locator("#hot-list");
  const coreNote = page.locator("#core-list + .none");
  const hotNote = page.locator("#hot-list + .none");
  // the sample as it reads: both lists hold files, and neither says it is empty
  await openViewer(page, E2E.sample);
  await expect(core.locator("li")).toHaveCount(5);
  await expect(hot.locator("li").first()).toBeVisible();
  await expect(page.locator(".bottom .none")).toHaveCount(0);
  // a repo whose code files have not changed in the last 90 days has no hotspot: a file is one
  // only when it also changes, so Hotspots says that none changed
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    const files = map.files.map((f) => {
      const still = [...f] as typeof f;
      still[F.churn] = 0;
      still[F.hotspot] = 0;
      return still;
    });
    await route.fulfill({ response, json: { ...map, files } });
  });
  await openViewer(page, E2E.sample);
  await expect(core.locator("li")).toHaveCount(5);
  await expect(coreNote).toHaveCount(0);
  await expect(core).not.toHaveAttribute("hidden");
  // the empty list is hidden, so that a screen reader meets the note, not a list of nothing
  await expect(hot).toHaveAttribute("hidden", "");
  await expect(hot.locator("li")).toHaveCount(0);
  await expect(hotNote).toHaveText("No code file changed in the last 90 days.");
  // a map that holds no code file at all: both lists say so
  await page.unroute("**/api/map");
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    const files = map.files.map((f) => {
      if (f[F.kind] !== 0) return f;
      const test = [...f] as typeof f;
      test[F.kind] = 1;
      return test;
    });
    await route.fulfill({ response, json: { ...map, files } });
  });
  await openViewer(page, E2E.sample);
  for (const [list, note] of [
    [core, coreNote],
    [hot, hotNote],
  ]) {
    await expect(list).toHaveAttribute("hidden", "");
    await expect(list.locator("li")).toHaveCount(0);
    await expect(note).toHaveText("No code files on this map.");
  }
});

test("the show toggles carry their counts, and the tests stat turns Tests on", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  await openViewer(page, E2E.sample);
  await expect(page.locator("#show .n")).toHaveText([
    fmt(m.counts.productionFiles),
    fmt(m.counts.tests),
    fmt(m.counts.libraries),
    fmt(m.counts.importEdges),
  ]);
  const tests = page.getByRole("checkbox", { name: /^Tests/ });
  await expect(tests).not.toBeChecked();
  await page.locator('#statband [data-stat="tests"]').click();
  await expect(tests).toBeChecked();
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // in the map's place, the list view lists the tests while Tests is on
    await expectNoWebGL(page);
    const files = listView(page).getByRole("button");
    await expect(files).toHaveCount(m.counts.productionFiles + m.counts.tests);
    await tests.uncheck();
    await expect(files).toHaveCount(m.counts.productionFiles);
    return;
  }
  const hubs = m.components.filter((c) => c[1] > 0).length;
  const others = hubs + m.counts.libraries;
  const nodes = page.locator("#map");
  await expect(nodes).toHaveAttribute(
    "data-nodes",
    String(m.counts.productionFiles + m.counts.tests + others),
  );
  await tests.uncheck();
  await expect(nodes).toHaveAttribute(
    "data-nodes",
    String(m.counts.productionFiles + others),
  );
});

test("the tests stat says why no test shows where the map draws none", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  expect(m.counts.tests).toBeGreaterThan(0);
  const toast = page.locator("#toast");
  const tests = page.getByRole("checkbox", { name: /^Tests/ });
  const stat = page.locator('#statband [data-stat="tests"]');
  const depth = (name: string) =>
    page
      .locator("#depth")
      .getByRole("button", { name: new RegExp(`^${name}`) });
  const map = page.locator("#map");
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // the list in the map's place lists tests at every depth: at Core the stat shows them there,
    // and has nothing to explain
    await expectNoWebGL(page);
    await depth("Core").click();
    await expect(depth("Core")).toHaveAttribute("aria-pressed", "true");
    await stat.click();
    await expect(tests).toBeChecked();
    await expect(listView(page).getByRole("button")).toHaveCount(
      m.counts.productionFiles + m.counts.tests,
    );
    await expect(toast).toBeHidden();
    return;
  }
  // at Components and Core depth the map draws no test: the stat turns Tests on, which the list
  // view would show, and says why the map shows none; each depth on a fresh page, so that the
  // toast is the one this click showed
  for (const name of ["Components", "Core"]) {
    await openViewer(page, E2E.sample);
    await depth(name).click();
    await expect(depth(name)).toHaveAttribute("aria-pressed", "true");
    const nodes = await map.getAttribute("data-nodes");
    await expect(toast).toBeHidden();
    await stat.click();
    await expect(tests).toBeChecked();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText("The map shows tests at Files depth only.");
    await expect(map).toHaveAttribute("data-nodes", nodes ?? "");
  }
  // at Files depth the stat draws the tests, and has nothing to say
  await openViewer(page, E2E.sample);
  await depth("Files").click();
  await stat.click();
  await expect(map).toHaveAttribute(
    "data-nodes",
    String(
      m.counts.productionFiles +
        m.counts.tests +
        m.components.filter((c) => c[1] > 0).length +
        m.counts.libraries,
    ),
  );
  await expect(toast).toBeHidden();
});

test("the zoom controls are named buttons, shown only with the map", async ({
  page,
  browserName,
}) => {
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  // without a map to move, the list view stands in its place and the zoom has nothing to do
  for (const name of ["Zoom in", "Zoom out", "Fit the map"]) {
    const button = page.getByRole("button", { name });
    if (webgl) await expect(button).toBeVisible();
    else await expect(button).toBeHidden();
  }
});
