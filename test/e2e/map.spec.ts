// The galaxy on the sample, end to end: at Files depth the map draws every production file, hub
// and library with the sample's import curves, the panels around it read from the same map, and
// the zoom controls are named buttons. A browser that cannot draw the map shows the list view in
// its place, with the same files, and no zoom.
import { expect, test } from "@playwright/test";
import type { HistoryData } from "../../src/query/view/index.js";
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
  await expect(core).toContainText(`${importers.size} importers`);

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
  await expect(page.locator("#hot-list li").first()).toContainText(
    `${hot[F.churn]} changes`,
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
        `${w.commits} commits, week of ${new Date(w.start * 1000).toISOString().slice(0, 10)}`,
    ),
  );
  const peak = Math.max(0, ...history.weeks.map((w) => w.commits));
  await expect(page.locator("#timeline .peak")).toHaveText(
    `peak ${peak} commits/week`,
  );
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
