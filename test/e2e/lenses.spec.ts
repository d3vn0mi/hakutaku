// Lenses, entry points and grouping on the sample, end to end: keys 1, 2 and 3 and the lens
// buttons switch lenses and their legends; Ownership is shown but disabled; the stat band's entry
// points, cycles and code files switch lens; under History a selected file is joined to the
// files that change together with it by dashed curves, from the map's own co-change or from an
// outline fetched once; grouping lays the map out again; and the lens and grouping are
// remembered across reloads.
import { expect, type Page, test } from "@playwright/test";
import type { MapData } from "../../src/query/view/index.js";
import {
  drawnNodes,
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  hasMapProbe,
  hasWebGL,
  listView,
  mapDrawn,
  openViewer,
  selectedId,
  toToken,
} from "./helpers.js";

const LEGEND = {
  structure:
    "Each dot is a file. The closer to the centre, the more of the code depends on it. Curves through the middle are imports between components.",
  risk: "Orange marks hotspots: files the code depends on that also change often. Orange curves are imports that run in a loop.",
  history:
    "Brighter files changed more in the last 90 days. Select one to see, dashed, the files that change together with it.",
  entries:
    "Orange marks entry points: where code starts running (scripts, plugin entries, routes, units).",
};
const PREFS = "hakutaku:view:observatory";
const KEPLER = "web/src/orbits/kepler.ts";
// The fragment that opens kepler.ts. The repository's secret scan reads a quoted value of 16
// characters or more after a name such as "token" as a secret, so it is passed by this name.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const CODE = 0;
const ON_MAP = new Set([0, 1, 2]); // code, test and test-support files are drawn

const pressed = (page: Page, name: string | RegExp) =>
  expect(page.getByRole("button", { name })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

// The Component grouping's button: the depth control's Components starts with the same word.
const componentGrouping = (page: Page) =>
  page.locator("#group").getByRole("button", { name: /^Component/ });

// The value, or a failure naming what the sample lacks.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`the sample has no ${what}`);
  }
  return value;
}

// A file's index in the map.
function fileOf(m: MapData, path: string): number {
  const f = m.files.findIndex((x) => x[F.path] === path);
  must(m.files[f], path);
  return f;
}

// The files that change together with a file, as the map holds them.
function partnersOf(m: MapData, file: number): number[] {
  const cochange = must(m.cochange, "co-change in its map");
  const out: number[] = [];
  for (let i = 0; i < cochange.length; i += 3) {
    if (cochange[i] === file) out.push(cochange[i + 1]);
  }
  return out;
}

// The files an import joins to a file, either way.
function importNeighbours(m: MapData, file: number): Set<number> {
  const near = new Set<number>();
  for (let i = 0; i < m.imports.length; i += 3) {
    const [a, b] = [m.imports[i], m.imports[i + 1]];
    if (a === file) near.add(b);
    if (b === file) near.add(a);
  }
  return near;
}

// The nodes a selected file keeps bright while only code files are shown: the file, the code
// files an import joins to it, the libraries it imports, and, given, its co-change partners.
function brightAround(
  m: MapData,
  file: number,
  partners: number[] = [],
): number {
  const near = new Set<number>([
    file,
    ...partners,
    ...importNeighbours(m, file),
  ]);
  const libraries = new Set<number>();
  for (let i = 0; i < m.libImports.length; i += 2) {
    if (m.libImports[i] === file) libraries.add(m.libImports[i + 1]);
  }
  return (
    [...near].filter((f) => m.files[f][F.kind] === CODE).length + libraries.size
  );
}

// The nodes drawn at Files depth with tests hidden: code files, hubs and libraries.
const shownAtFiles = (m: MapData) =>
  m.counts.productionFiles +
  m.components.filter((c) => c[1] > 0).length +
  m.counts.libraries;

test("keys 1, 2 and 3 switch lenses and their legends", async ({ page }) => {
  await openViewer(page, E2E.sample);
  await pressed(page, "Structure");
  await expect(page.locator("#legend")).toHaveText(LEGEND.structure);
  for (const [key, name, legend] of [
    ["2", "Risk", LEGEND.risk],
    ["3", "History", LEGEND.history],
    ["1", "Structure", LEGEND.structure],
  ] as const) {
    await page.keyboard.press(key);
    await pressed(page, name);
    await expect(page.locator('#lens [aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator("#legend")).toHaveText(legend);
  }
  await page.keyboard.press("2");
  await expect(page.locator("#legend")).toHaveText(
    "Orange marks hotspots: files the code depends on that also change often. Orange curves are imports that run in a loop.",
  );
  // a key typed into Find is the field's, not a lens's
  await page.locator("#q").focus();
  await page.keyboard.press("3");
  await expect(page.locator("#q")).toHaveValue("3");
  await pressed(page, "Risk");
  // the buttons do what the keys do, and name their keys
  await page.getByRole("button", { name: "History" }).click();
  await pressed(page, "History");
  await expect(page.locator("#legend")).toHaveText(LEGEND.history);
  for (const [name, key] of [
    ["Structure", "1"],
    ["Risk", "2"],
    ["History", "3"],
  ]) {
    await expect(page.getByRole("button", { name })).toHaveAttribute(
      "aria-keyshortcuts",
      key,
    );
  }
});

test("Ownership is shown and disabled", async ({ page }) => {
  await openViewer(page, E2E.sample);
  const ownership = page.getByRole("button", { name: "Ownership" });
  await expect(ownership).toBeDisabled();
  await expect(ownership).toBeVisible();
  await expect(ownership).toHaveAttribute(
    "title",
    "Later: it needs a decision on what an owner is",
  );
  await expect(ownership).toHaveAttribute("aria-pressed", "false");
});

test("the entry points and cycles stats switch lens and say so", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const first = must(m.cycles[0]?.[0], "cycle");
  await openViewer(page, E2E.sample);
  const entries = page.locator('#statband [data-stat="entries"]');
  const legend = page.locator("#legend");
  await expect(entries).toHaveAttribute("aria-pressed", "false");
  await entries.click();
  await expect(legend).toHaveText(
    "Orange marks entry points: where code starts running (scripts, plugin entries, routes, units).",
  );
  await expect(entries).toHaveAttribute("aria-pressed", "true");
  // a second click turns them off; from another lens, the stat goes back to Structure
  await entries.click();
  await expect(legend).toHaveText(LEGEND.structure);
  await expect(entries).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("3");
  await entries.click();
  await pressed(page, "Structure");
  await expect(legend).toHaveText(LEGEND.entries);

  await page.locator('#statband [data-stat="cycles"]').click();
  await pressed(page, "Risk");
  expect(await selectedId(page)).toBe(`observatory:${m.files[first][F.path]}`);
  // another lens turns the entry points off, so Structure comes back without them
  await expect(entries).toHaveAttribute("aria-pressed", "false");
  await expect(legend).toHaveText(LEGEND.risk);
  await page.getByRole("button", { name: "Structure" }).click();
  await expect(legend).toHaveText(LEGEND.structure);

  // the code files stat turns the entry points off, and goes back to Structure
  await entries.click();
  await expect(legend).toHaveText(LEGEND.entries);
  const files = page.locator('#statband [data-stat="files"]');
  await files.click();
  await expect(legend).toHaveText(LEGEND.structure);
  await expect(entries).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "History" }).click();
  await files.click();
  await pressed(page, "Structure");
});

test("lens and grouping are remembered across reloads", async ({ page }) => {
  await openViewer(page, E2E.sample);
  // nothing is written until the viewer changes one of them
  expect(await page.evaluate((k) => localStorage.getItem(k), PREFS)).toBeNull();
  await page.keyboard.press("2");
  await page.getByRole("button", { name: /^Folder/ }).click();
  expect(
    JSON.parse(
      (await page.evaluate((k) => localStorage.getItem(k), PREFS)) ?? "null",
    ),
  ).toEqual({ lens: "risk", depth: "files", group: "folder" });
  await page.reload();
  await openViewer(page, page.url());
  await pressed(page, "Risk");
  await pressed(page, /^Folder/);
  await expect(componentGrouping(page)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#legend")).toHaveText(LEGEND.risk);
});

test("History draws the selection's co-change partners, dashed", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const kepler = fileOf(m, KEPLER);
  const partners = partnersOf(m, kepler);
  // partners on the map at Files depth with tests hidden: production files only
  const visible = partners.filter((p) => m.files[p][F.kind] === CODE).length;
  const onMap = partners.filter((p) => ON_MAP.has(m.files[p][F.kind])).length;
  expect(visible).toBeGreaterThan(0);
  expect(onMap).toBeGreaterThan(visible); // kepler.test.ts among them
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    await expectNoWebGL(page);
    // a browser that cannot draw the map still switches lens, with its legend
    await page.keyboard.press("3");
    await pressed(page, "History");
    await expect(page.locator("#legend")).toHaveText(LEGEND.history);
    return;
  }
  const map = page.locator("#map");
  const shown = shownAtFiles(m);
  await expect(map).toHaveAttribute("data-cochange", "0");
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(shown - brightAround(m, kepler)),
  );
  await page.keyboard.press("3");
  await expect(map).toHaveAttribute("data-cochange", String(visible));
  // the partners stay bright with the file's other neighbours
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(shown - brightAround(m, kepler, partners)),
  );
  // a code file that changes together with one no import joins to it keeps that one bright too
  const code = (f: number) => m.files[f][F.kind] === CODE;
  const loner = m.files.findIndex(
    (_, f) =>
      code(f) &&
      partnersOf(m, f).some((p) => code(p) && !importNeighbours(m, f).has(p)),
  );
  must(m.files[loner], "file that changes with one it does not import");
  const lonerPartners = partnersOf(m, loner);
  const dimmed = shown - brightAround(m, loner, lonerPartners);
  expect(dimmed).toBeLessThan(shown - brightAround(m, loner));
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({ kind: "file", repo: m.repo, path: m.files[loner][F.path] }),
  );
  await expect(map).toHaveAttribute("data-dimmed", String(dimmed));
  await expect(map).toHaveAttribute(
    "data-cochange",
    String(lonerPartners.filter(code).length),
  );
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_KEPLER);
  await expect(map).toHaveAttribute("data-cochange", String(visible));
  // with tests shown, the test files that change with it are joined too
  await page.getByRole("checkbox", { name: /^Tests/ }).check();
  await expect(map).toHaveAttribute("data-cochange", String(onMap));
  // the other lenses draw no co-change
  await page.getByRole("button", { name: "Structure" }).click();
  await expect(map).toHaveAttribute("data-cochange", "0");
  await page.getByRole("button", { name: "Risk" }).click();
  await expect(map).toHaveAttribute("data-cochange", "0");
});

test("History fetches a file's partners once when the map does not carry them", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const kepler = fileOf(m, KEPLER);
  const visible = partnersOf(m, kepler).filter(
    (p) => m.files[p][F.kind] === CODE,
  ).length;
  // the map as a repo above the inline limit sends it: no outlines and no co-change
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    await route.fulfill({
      response,
      json: { ...map, outline: null, cochange: null },
    });
  });
  const asked: string[] = [];
  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname === "/api/outline")
      asked.push(u.searchParams.get("file") ?? "");
  });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await page.keyboard.press("3");
  await pressed(page, "History");
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    await expectNoWebGL(page);
    // without a map, nothing asks for co-change
    expect(asked).toEqual([]);
    return;
  }
  const map = page.locator("#map");
  await expect(map).toHaveAttribute("data-cochange", String(visible));
  expect(asked).toEqual([`observatory:${KEPLER}`]);
  // the outline is kept: leaving History and coming back asks no more
  await page.getByRole("button", { name: "Structure" }).click();
  await expect(map).toHaveAttribute("data-cochange", "0");
  await page.getByRole("button", { name: "History" }).click();
  await expect(map).toHaveAttribute("data-cochange", String(visible));
  expect(asked).toHaveLength(1);
});

test("an outline from another build draws nothing and says the map was rebuilt", async ({
  page,
  browserName,
}) => {
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    await route.fulfill({
      response,
      json: { ...map, outline: null, cochange: null },
    });
  });
  await page.route(/\/api\/outline\?/, async (route) => {
    const response = await route.fetch();
    const outline = await response.json();
    await route.fulfill({
      response,
      json: { ...outline, builtCommit: "0123456789ab" },
    });
  });
  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/outline")
      asked.push(request.url());
  });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // the list view stands in the map's place, and draws no co-change: History asks for no
    // outline, so nothing from the other build arrives and nothing says the map was rebuilt
    await expectNoWebGL(page);
    await page.keyboard.press("3");
    await pressed(page, "History");
    await expect(page.locator("#legend")).toHaveText(LEGEND.history);
    expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
    await expect(listView(page).getByRole("button")).toHaveCount(
      (await fetchMap(E2E.sample)).counts.productionFiles,
    );
    expect(asked).toEqual([]);
    await expect(page.locator("#toast")).not.toContainText("rebuilt");
    return;
  }
  await page.keyboard.press("3");
  await expect(page.locator("#toast")).toContainText(
    "The map was rebuilt at 0123456789ab. Reload to see it.",
  );
  await expect(page.locator("#map")).toHaveAttribute("data-cochange", "0");
  expect(asked).toHaveLength(1);
});

test("grouping by language makes one hub per language", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const code = m.files.filter((f) => f[F.kind] === CODE);
  const langs = new Set(code.map((f) => f[F.lang]));
  const folders = new Set(
    code.map((f) => (f[F.path].includes("/") ? f[F.path].split("/")[0] : "")),
  );
  const components = m.components.filter((c) => c[1] > 0).length;
  // the languages make another number of hubs than the components, so the count tells them apart
  expect(langs.size).not.toBe(components);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const map = page.locator("#map");
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (webgl) await expect(map).toHaveAttribute("data-hubs", String(components));
  else await expectNoWebGL(page);
  // the grouping in use, pressed again, changes nothing
  await componentGrouping(page).click();
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);

  const language = page.getByRole("button", { name: /^Language/ });
  await language.click();
  await expect(language).toHaveAttribute("aria-pressed", "true");
  await expect(componentGrouping(page)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // a new grouping clears the selection, and the address keeps only its session
  expect(await selectedId(page)).toBeNull();
  await expect(page.locator("#detail")).toBeHidden();
  await expect(page).toHaveURL(
    (u) => u.hash === "" && u.searchParams.get("s") !== null,
  );
  if (!webgl) return;
  await expect(map).toHaveAttribute("data-hubs", String(langs.size));
  await expect(map).toHaveAttribute("data-dimmed", "0");
  await page.getByRole("button", { name: /^Folder/ }).click();
  await expect(map).toHaveAttribute("data-hubs", String(folders.size));
});

test("at Components depth the legend names the hubs of the grouping", async ({
  page,
}) => {
  // what an earlier visit left: History, at Components depth, grouped by language
  await page.addInitScript((key) => {
    if (location.protocol === "http:") {
      localStorage.setItem(
        key,
        JSON.stringify({
          lens: "history",
          depth: "components",
          group: "language",
        }),
      );
    }
  }, PREFS);
  await openViewer(page, E2E.sample);
  await pressed(page, "History");
  await pressed(page, /^Language/);
  const legend = page.locator("#legend");
  await expect(legend).toHaveText(
    "Each hub is a language, sized by its code files. Curves are imports between languages; thicker means more of them.",
  );
  await page.getByRole("button", { name: /^Folder/ }).click();
  await expect(legend).toHaveText(
    "Each hub is a folder, sized by its code files. Curves are imports between folders; thicker means more of them.",
  );
  await componentGrouping(page).click();
  await expect(legend).toHaveText(
    "Each hub is a component, sized by its code files. Curves are imports between components; thicker means more of them.",
  );
});

const LABEL_TOP = 8; // the files a lens labels, as the map holds it

// The production files each lens labels, worked out from the map alone, as node keys, sorted:
// under Structure the top 8 by rank; under Risk and History the top 8 by hotspot and by churn,
// rank breaking ties, and none whose value is 0.
function lensLabels(
  m: MapData,
): Record<"risk" | "history" | "structure", string[]> {
  const production = m.files
    .map((_, i) => i)
    .filter((i) => m.files[i][F.kind] === CODE)
    .sort((a, b) => m.files[a][F.rank] - m.files[b][F.rank]);
  const top = (files: number[]) =>
    files
      .slice(0, LABEL_TOP)
      .map((f) => `f${f}`)
      .sort();
  const by = (at: typeof F.hotspot | typeof F.churn) =>
    top(
      production
        .filter((f) => m.files[f][at] > 0)
        .sort((a, b) => m.files[b][at] - m.files[a][at]),
    );
  return {
    risk: by(F.hotspot),
    history: by(F.churn),
    structure: top(production),
  };
}

// The map with its three code files of the lowest rank and no hotspot made the ones that changed
// most. In the sample as mapped, the files that changed are also its hotspots, so Risk and
// History would label the same eight files and could not be told apart.
function churned(m: MapData): MapData {
  const quiet = m.files
    .map((_, i) => i)
    .filter((i) => m.files[i][F.kind] === CODE && m.files[i][F.hotspot] === 0)
    .sort((a, b) => m.files[b][F.rank] - m.files[a][F.rank])
    .slice(0, 3);
  expect(quiet).toHaveLength(3);
  const most = Math.max(...m.files.map((f) => f[F.churn]));
  const files = m.files.map((f, i) => {
    if (!quiet.includes(i)) return f;
    const changed = [...f] as typeof f;
    changed[F.churn] = most + 1;
    return changed;
  });
  return { ...m, files };
}

test("each lens labels its own top files", async ({ page, browserName }) => {
  const m = churned(await fetchMap(E2E.sample));
  const expected = lensLabels(m);
  // each lens has files to label, and no two lenses label the same ones
  for (const keys of Object.values(expected)) {
    expect(keys.length).toBeGreaterThan(0);
  }
  expect(new Set(Object.values(expected).map((k) => k.join(" "))).size).toBe(3);
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: churned((await response.json()) as MapData),
    });
  });
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // no map, so no label is drawn, and no hook reads the map
    await expectNoWebGL(page);
    expect(await hasMapProbe(page)).toBe(false);
    return;
  }
  const production = m.files.flatMap((f, i) =>
    f[F.kind] === CODE ? [`f${i}`] : [],
  );
  // the files whose labels the map forces, as sigma holds them, and those the last frame drew
  const labelled = async () => {
    const { nodes, labels } = await drawnNodes(page, production);
    return {
      forced: production
        .filter(
          (_, i) => nodes[i]?.forceLabel === true && nodes[i]?.label !== "",
        )
        .sort(),
      drawn: labels.filter((key) => key.startsWith("f")).sort(),
    };
  };
  for (const [key, lens, name] of [
    ["2", "risk", "Risk"],
    ["3", "history", "History"],
    ["1", "structure", "Structure"],
  ] as const) {
    await page.keyboard.press(key);
    await pressed(page, name);
    await expect
      .poll(labelled)
      .toEqual({ forced: expected[lens], drawn: expected[lens] });
  }
});
