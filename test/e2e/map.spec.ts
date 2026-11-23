// The galaxy on the sample, end to end: at Files depth the map draws every production file, hub
// and library with the sample's import curves, the panels around it read from the same map, the
// zoom controls are named buttons that move the camera, and a pointer over a node shows its name.
// A browser that cannot draw the map shows the list view in its place, with the same files, and
// no zoom.
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { HistoryData, MapData } from "../../src/query/view/index.js";
import {
  type Camera,
  drawnNodes,
  E2E,
  ECOSYSTEMS,
  expectNoWebGL,
  F,
  fetchMap,
  hasMapProbe,
  hasWebGL,
  listView,
  mapCamera,
  mapDrawn,
  openViewer,
  toToken,
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
    await expectNoToast(toast);
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
  await expectNoToast(toast);
});

// That no toast has shown on this page: a toast hides by itself after a few seconds but keeps its
// text, so a check that waits for it to be hidden would pass once one had come and gone; its text
// is read instead, at once, and it is hidden.
async function expectNoToast(toast: Locator): Promise<void> {
  expect(await toast.textContent()).toBe("");
  expect(await toast.isHidden()).toBe(true);
}

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

// The production files of a map, by rank.
const byRank = (m: MapData): number[] =>
  m.files
    .map((_, i) => i)
    .filter((i) => m.files[i][F.kind] === 0)
    .sort((a, b) => m.files[a][F.rank] - m.files[b][F.rank]);

// The value, or a failure naming what is missing.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`there is no ${what}`);
  }
  return value;
}

// The camera that shows the whole map, as the page opens it; and one step of the zoom, and the
// closest a selection's flight comes, as render.ts holds them.
const FIT: Camera = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };
const ZOOM_STEP = 1.5;
const FOCUS_RATIO = 0.45;

// How far from the middle of the map's area a node is drawn, in CSS pixels.
async function fromMiddle(page: Page, key: string): Promise<number> {
  const box = must(await page.locator("#sigma").boundingBox(), "map area");
  const [node] = (await drawnNodes(page, [key])).nodes;
  const at = must(node, `drawn node ${key}`);
  return Math.hypot(
    at.x - (box.x + box.width / 2),
    at.y - (box.y + box.height / 2),
  );
}

test("the zoom and fit buttons move the camera, and the map with it", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const [ecosystem, name] = must(m.externals[0], "library");
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // nothing is drawn, so there is no camera to move, nor a hook to read one
    await expectNoWebGL(page);
    expect(await hasMapProbe(page)).toBe(false);
    return;
  }
  const button = (label: string) => page.getByRole("button", { name: label });
  const ratio = async () => (await mapCamera(page)).ratio;
  // the first library, on the outer ring, drawn far from the middle
  expect(await mapCamera(page)).toEqual(FIT);
  const far = await fromMiddle(page, "x0");
  expect(far).toBeGreaterThan(50);
  // each step is animated, and ends one step closer or further, the map drawn larger or smaller
  // about the same middle
  await button("Zoom in").click();
  await expect.poll(ratio).toBeCloseTo(1 / ZOOM_STEP, 9);
  expect(await fromMiddle(page, "x0")).toBeCloseTo(far * ZOOM_STEP, 0);
  await button("Zoom out").click();
  await expect.poll(ratio).toBeCloseTo(1, 9);
  expect(await fromMiddle(page, "x0")).toBeCloseTo(far, 0);
  await button("Zoom out").click();
  await expect.poll(ratio).toBeCloseTo(ZOOM_STEP, 9);
  expect(await fromMiddle(page, "x0")).toBeCloseTo(far / ZOOM_STEP, 0);
  expect(await mapCamera(page)).toMatchObject({ x: 0.5, y: 0.5, angle: 0 });
  // a selection flies to its node and comes closer; Fit shows the whole map again
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({
      kind: "external",
      repo: m.repo,
      ecosystem: ECOSYSTEMS[ecosystem],
      name,
    }),
  );
  await expect.poll(ratio).toBeCloseTo(FOCUS_RATIO, 9);
  await expect.poll(() => fromMiddle(page, "x0")).toBeLessThan(1);
  await button("Fit the map").click();
  await expect.poll(() => mapCamera(page)).toEqual(FIT);
  // under reduced motion each move is made at once, by the time the click is done
  await page.emulateMedia({ reducedMotion: "reduce" });
  await button("Zoom in").click();
  expect(await ratio()).toBeCloseTo(1 / ZOOM_STEP, 9);
  await button("Fit the map").click();
  expect(await mapCamera(page)).toEqual(FIT);
});

// Records, in every document the page opens from now on, the text each canvas is given to draw.
// A canvas cleared from its corner starts its list again, so each list holds what the canvas
// shows now. The function returned reads the texts of the canvases of a class, in drawing order.
async function watchCanvasText(
  page: Page,
): Promise<(canvas: string) => Promise<string[]>> {
  await page.addInitScript(() => {
    const shown = new Map<HTMLCanvasElement, string[]>();
    Object.defineProperty(window, "__hakutakuCanvasText", { value: shown });
    const proto = CanvasRenderingContext2D.prototype;
    const fillText = proto.fillText;
    const clearRect = proto.clearRect;
    proto.fillText = function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<CanvasRenderingContext2D["fillText"]>
    ) {
      const texts = shown.get(this.canvas) ?? [];
      shown.set(this.canvas, texts);
      texts.push(String(args[0]));
      fillText.apply(this, args);
    };
    proto.clearRect = function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<CanvasRenderingContext2D["clearRect"]>
    ) {
      if (args[0] <= 0 && args[1] <= 0) shown.set(this.canvas, []);
      clearRect.apply(this, args);
    };
  });
  return (canvas) =>
    page.evaluate(
      (cls) =>
        [
          ...(
            window as unknown as {
              __hakutakuCanvasText: Map<HTMLCanvasElement, string[]>;
            }
          ).__hakutakuCanvasText,
        ]
          .filter(([c]) => c.classList.contains(cls))
          .flatMap(([, texts]) => texts),
      canvas,
    );
}

test("a pointer over a node tags it with its name, and over no node shows no tag", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const drawnText = await watchCanvasText(page);
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // nothing is drawn, so nothing can be pointed at, and no hook reads the map
    await expectNoWebGL(page);
    expect(await hasMapProbe(page)).toBe(false);
    return;
  }
  // every node the map draws, with the name its tag must say: a file by its file name, a library
  // by its own; hubs, which the tests do not point at, only so that nothing is overlooked
  const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const named = [
    ...byRank(m).map((f) => ({ key: `f${f}`, name: base(m.files[f][F.path]) })),
    ...m.externals.map(([, lib], e) => ({ key: `x${e}`, name: lib })),
  ];
  const hubs = Number(await page.locator("#map").getAttribute("data-hubs"));
  const keys = [
    ...named.map((n) => n.key),
    ...Array.from({ length: hubs }, (_, i) => `h${i}`),
  ];
  const { nodes } = await drawnNodes(page, keys);
  const drawn = nodes.filter((n) => n !== null);
  expect(drawn).toHaveLength(
    Number(await page.locator("#map").getAttribute("data-nodes")),
  );
  // whether the map's own area is what the page shows at a point, not a panel over it
  const onMap = (points: Array<[number, number]>) =>
    page.evaluate(
      (ps) =>
        ps.map(([x, y]) => {
          const top = document.elementFromPoint(x, y);
          return top !== null && top.closest("#sigma") !== null;
        }),
      points,
    );
  const open = await onMap(
    nodes.map((n): [number, number] => (n === null ? [-1, -1] : [n.x, n.y])),
  );
  // a node that no other node's disc reaches, in the open: a pointer at its middle is over it
  // alone
  const alone = (i: number): boolean => {
    const n = nodes[i];
    return (
      n !== null &&
      open[i] === true &&
      drawn.every(
        (o) => o === n || Math.hypot(o.x - n.x, o.y - n.y) > o.size + 2,
      )
    );
  };
  // a file the map does not label, so that only its tag can name it, and a library
  const file = named.findIndex(
    (n, i) => n.key.startsWith("f") && nodes[i]?.label === "" && alone(i),
  );
  const library = named.findIndex((n, i) => n.key.startsWith("x") && alone(i));
  const map = page.locator("#map");
  for (const i of [file, library]) {
    const at = must(nodes[i], "unlabelled file and library alone on the map");
    await page.mouse.move(at.x, at.y);
    await expect(map).toHaveClass(/\bpointing\b/);
    await expect.poll(() => drawnText("sigma-hovers")).toEqual([named[i].name]);
  }
  // and over a point of the map's area that no node is near, no tag
  const box = must(await page.locator("#sigma").boundingBox(), "map area");
  const grid: Array<[number, number]> = [];
  for (let x = box.x + 20; x < box.x + box.width - 20; x += 40) {
    for (let y = box.y + 20; y < box.y + box.height - 20; y += 40) {
      if (drawn.every((o) => Math.hypot(o.x - x, o.y - y) > o.size + 12)) {
        grid.push([x, y]);
      }
    }
  }
  const empty = must(
    grid[(await onMap(grid)).indexOf(true)],
    "point of the map's area far from every node",
  );
  await page.mouse.move(...empty);
  await expect(map).not.toHaveClass(/\bpointing\b/);
  await expect.poll(() => drawnText("sigma-hovers")).toEqual([]);
});
