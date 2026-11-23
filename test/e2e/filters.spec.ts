// Filters and the list view end to end, on the sample: a filter dims the files it leaves out, as
// well as what a selection dims and never the selected node, and moves and hides nothing; each
// filter keeps the files it names, on the map and in the list view; L lists the files, ranked,
// under the filters, and Enter or a click selects one; over the map, L and Esc close the list,
// while in a browser that cannot draw the map the list stays in its place; the list shows 200
// files at a time; and names that hold markup are listed as text.
import { expect, test } from "@playwright/test";
import type { MapData, MapFile } from "../../src/query/view/index.js";
import {
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  hasWebGL,
  listView,
  mapDrawn,
  openViewer,
  selectedId,
  toToken,
} from "./helpers.js";

const CODE = 0;
const TESTS = new Set([1, 2]); // test and test-support files
const FLAG_ENTRY = 1;
const HOTSPOT_MARK = 0.35;
const KEPLER = "web/src/orbits/kepler.ts";
// The fragment that opens kepler.ts. The repository's secret scan reads a quoted value of 16
// characters or more after a name such as "token" as a secret, so it is passed by this name.
const AT_KEPLER = "web~src~orbits~kepler.ts";
// The names the language filter gives the languages it knows; any other keeps its own.
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  shell: "Shell",
};

// The value, or a failure naming what the sample lacks.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`the sample has no ${what}`);
  }
  return value;
}

const byPath = (m: MapData) => (a: number, b: number) =>
  m.files[a][F.path] < m.files[b][F.path] ? -1 : 1;

// The production files keep holds, by rank.
function kept(m: MapData, keep: (file: MapFile) => boolean): number[] {
  return m.files
    .map((_, f) => f)
    .filter((f) => m.files[f][F.kind] === CODE && keep(m.files[f]))
    .sort((a, b) => m.files[a][F.rank] - m.files[b][F.rank] || byPath(m)(a, b));
}

// The test and test-support files, by path.
function testsOf(m: MapData): number[] {
  return m.files
    .map((_, f) => f)
    .filter((f) => TESTS.has(m.files[f][F.kind]))
    .sort(byPath(m));
}

// What the list view says of a file: its path, rank and importers, or that it is a test.
function labelOf(m: MapData, f: number): string {
  const file = m.files[f];
  if (file[F.kind] !== CODE) return `${file[F.path]}, test`;
  const importers = new Set<number>();
  for (let i = 0; i < m.imports.length; i += 3) {
    if (m.imports[i + 1] === f) importers.add(m.imports[i]);
  }
  const n = importers.size;
  return `${file[F.path]}, rank ${file[F.rank]}, ${n} importer${n === 1 ? "" : "s"}`;
}

test("a filter dims and moves nothing", async ({ page, browserName }) => {
  const m = await fetchMap(E2E.sample);
  const inCycle = m.files.filter(
    (f) => f[F.kind] === CODE && f[F.cycle] !== 0,
  ).length;
  expect(inCycle).toBeGreaterThan(0);
  expect(inCycle).toBeLessThan(m.counts.productionFiles);
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // in the map's place, the list holds only what the filter keeps
    await expectNoWebGL(page);
    await page.getByLabel("Files in a cycle").check();
    await expect(listView(page).getByRole("button")).toHaveCount(inCycle);
    return;
  }
  const map = page.locator("#map");
  const nodes = await map.getAttribute("data-nodes");
  const curves = await map.getAttribute("data-curves");
  await page.getByLabel("Files in a cycle").check();
  // only the production files outside a cycle dim: no hub, no library, and no node hides
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(m.counts.productionFiles - inCycle),
  );
  await expect(map).toHaveAttribute("data-nodes", nodes ?? "");
  await expect(map).toHaveAttribute("data-curves", curves ?? "");
  // shown, the test files outside a cycle dim too
  const testsOut = testsOf(m).filter((f) => m.files[f][F.cycle] === 0).length;
  expect(testsOut).toBeGreaterThan(0);
  await page.getByRole("checkbox", { name: /^Tests/ }).check();
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(m.counts.productionFiles - inCycle + testsOut),
  );
  await page.getByRole("checkbox", { name: /^Tests/ }).uncheck();
  await page.getByLabel("Files in a cycle").uncheck();
  await expect(map).toHaveAttribute("data-dimmed", "0");
  await expect(map).toHaveAttribute("data-nodes", nodes ?? "");
});

test("a filter dims along with a selection, and never the selected node", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const code = (f: number) => m.files[f][F.kind] === CODE;
  const cycled = (f: number) => m.files[f][F.cycle] !== 0;
  const near = (file: number) => {
    const out = new Set<number>();
    for (let i = 0; i < m.imports.length; i += 3) {
      const [a, b] = [m.imports[i], m.imports[i + 1]];
      if (a === file && code(b)) out.add(b);
      if (b === file && code(a)) out.add(a);
    }
    return [...out];
  };
  // a code file outside the cycle, joined to code files both in it and outside it
  const file = must(
    m.files
      .map((_, f) => f)
      .find(
        (f) =>
          code(f) &&
          !cycled(f) &&
          near(f).some(cycled) &&
          near(f).some((g) => !cycled(g)),
      ),
    "code file outside the cycle joined to files in it and out of it",
  );
  const libraries = new Set<number>();
  for (let i = 0; i < m.libImports.length; i += 2) {
    if (m.libImports[i] === file) libraries.add(m.libImports[i + 1]);
  }
  const shown =
    m.counts.productionFiles +
    m.components.filter((c) => c[1] > 0).length +
    m.counts.libraries;
  const id = `observatory:${m.files[file][F.path]}`;
  await openViewer(page, E2E.sample, {
    token: toToken({ kind: "file", repo: m.repo, path: m.files[file][F.path] }),
  });
  expect(await selectedId(page)).toBe(id);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // the list in the map's place holds what the filter keeps, and the selection holds
    await expectNoWebGL(page);
    await page.getByLabel("Files in a cycle").check();
    await expect(listView(page).getByRole("button")).toHaveText(
      kept(m, (f) => f[F.cycle] !== 0).map((f) => labelOf(m, f)),
    );
    expect(await selectedId(page)).toBe(id);
    return;
  }
  const map = page.locator("#map");
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(shown - 1 - near(file).length - libraries.size),
  );
  // the filter dims the neighbours outside the cycle too; the file itself, outside it, stays lit
  await page.getByLabel("Files in a cycle").check();
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(shown - 1 - near(file).filter(cycled).length - libraries.size),
  );
  // with nothing selected, the filter alone dims
  await page
    .locator("#crumbs")
    .getByRole("button", { name: "Map", exact: true })
    .click();
  expect(await selectedId(page)).toBeNull();
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(m.counts.productionFiles - kept(m, (f) => f[F.cycle] !== 0).length),
  );
});

test("each filter keeps what it names, on the map and in the list view", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const code = m.files.filter((f) => f[F.kind] === CODE);
  const codeIn = (lang: number) =>
    code.filter((f) => f[F.lang] === lang).length;
  // a language that holds some code files and not all of them
  const lang = must(
    m.langs
      .map((_, i) => i)
      .find((i) => codeIn(i) > 0 && codeIn(i) < code.length),
    "language holding part of the code",
  );
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  const component = must(m.files[kepler], KEPLER)[F.component];
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  // over the map, L opens the list; in a browser that cannot draw the map, it is open already
  if (webgl) await page.keyboard.press("l");
  else await expectNoWebGL(page);
  const list = listView(page);
  await expect(list).toBeVisible();
  const map = page.locator("#map");
  const shown = await map.getAttribute("data-nodes");
  // the list holds what the filters keep, by rank, and the map dims the other production files
  const expectKept = async (what: string, keep: (file: MapFile) => boolean) => {
    const files = kept(m, keep);
    if (files.length === 0) {
      await expect(list.getByRole("button"), what).toHaveCount(0);
      await expect(list, what).toContainText("No file passes the filters.");
    } else {
      await expect(list.getByRole("button"), what).toHaveText(
        files.map((f) => labelOf(m, f)),
      );
    }
    if (webgl) {
      await expect(map, what).toHaveAttribute(
        "data-dimmed",
        String(m.counts.productionFiles - files.length),
      );
      await expect(map, what).toHaveAttribute("data-nodes", shown ?? "");
    }
  };
  await expectKept("no filter", () => true);

  const language = page.getByLabel("Language", { exact: true });
  await expect(language.locator("option")).toHaveText([
    "All languages",
    ...m.langs.map((l, i) => `${LANGUAGE_NAMES[l] ?? l} (${codeIn(i)})`),
  ]);
  await language.selectOption(String(lang));
  await expectKept("language", (f) => f[F.lang] === lang);
  await language.selectOption("");
  await expectKept("all languages", () => true);

  const components = page.getByLabel("Component", { exact: true });
  await expect(components.locator("option")).toHaveText([
    "All components",
    ...m.components.map(([path]) => path),
  ]);
  await components.selectOption(String(component));
  await expectKept("component", (f) => f[F.component] === component);

  // every filter that is set must hold
  await page.getByLabel("Entry points only").check();
  await expectKept(
    "component and entry points",
    (f) => f[F.component] === component && (f[F.flags] & FLAG_ENTRY) !== 0,
  );
  await components.selectOption("");
  await expectKept("entry points", (f) => (f[F.flags] & FLAG_ENTRY) !== 0);
  await page.getByLabel("Entry points only").uncheck();

  await page.getByLabel("Files in a cycle").check();
  await expectKept("files in a cycle", (f) => f[F.cycle] !== 0);
  await page.getByLabel("Files in a cycle").uncheck();

  const changed = page.getByLabel("Changed in the last");
  await expect(changed.locator("option")).toHaveText([
    "Any",
    "7 days",
    "30 days",
    "90 days",
  ]);
  for (const days of [7, 30, 90]) {
    await changed.selectOption(String(days));
    await expectKept(
      `changed in the last ${days} days`,
      (f) => f[F.changedDaysAgo] >= 0 && f[F.changedDaysAgo] < days,
    );
  }
  await changed.selectOption("");
  await expectKept("changed at any time", () => true);

  // Hotspot above: the box turns on the threshold, which starts at the mark
  const hotspot = page.getByLabel("Hotspot above");
  const threshold = page.getByLabel("Hotspot threshold");
  const value = page.locator("#filters output");
  await expect(threshold).toBeDisabled();
  await expect(threshold).toHaveValue(String(HOTSPOT_MARK));
  await expect(value).toHaveText("0.35");
  await hotspot.check();
  await expect(threshold).toBeEnabled();
  await expectKept("hotspot above 0.35", (f) => f[F.hotspot] > HOTSPOT_MARK);
  await threshold.fill("0.1");
  await expect(value).toHaveText("0.10");
  await expectKept("hotspot above 0.1", (f) => f[F.hotspot] > 0.1);
  await hotspot.uncheck();
  await expect(threshold).toBeDisabled();
  await expectKept("no hotspot threshold", () => true);
  // the box turns the threshold on again where it was left
  await hotspot.check();
  await expect(value).toHaveText("0.10");
  await expectKept("hotspot above 0.1 again", (f) => f[F.hotspot] > 0.1);
});

test("L lists the files under the filters, and Enter opens one", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const entries = kept(m, (f) => (f[F.flags] & FLAG_ENTRY) !== 0);
  expect(entries.length).toBeGreaterThan(0);
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  const box = page.getByLabel("Entry points only");
  await box.check();
  // a key pressed on a checkbox is the checkbox's, so the focus leaves it before L
  await box.blur();
  await page.keyboard.press("l");
  const list = listView(page);
  await expect(list.getByRole("button")).toHaveCount(entries.length);
  await expect(list.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Enter");
  // over the map the pick closes the list; in the map's place the list stays
  if (webgl) await expect(list).toBeHidden();
  else await expect(list).toBeVisible();
  expect(await selectedId(page)).toBe(
    `observatory:${m.files[entries[0]][F.path]}`,
  );
  await expect(page.locator("#detail h2")).toBeFocused();
});

test("over the map, L and Esc close the list and keep the selection; in the map's place the list stays", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  const [component] = must(
    m.components[must(m.files[kepler], KEPLER)[F.component]],
    `component of ${KEPLER}`,
  );
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const list = listView(page);
  const first = list.getByRole("button").first();
  const heading = page.locator("#detail h2");
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (webgl) {
    await expect(list).toBeHidden();
    await page.keyboard.press("l");
    await expect(first).toBeFocused();
    // Esc closes the list, not the selection, and the focus goes back where it was
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
    await expect(heading).toBeFocused();
    // L closes it too, typed with Shift or without
    await page.keyboard.press("Shift+L");
    await expect(first).toBeFocused();
    await page.keyboard.press("l");
    await expect(list).toBeHidden();
    await expect(heading).toBeFocused();
  } else {
    await expectNoWebGL(page);
    // L, typed with Shift or without, only moves the focus to the list, which stays
    await page.keyboard.press("Shift+L");
    await expect(first).toBeFocused();
    await page.keyboard.press("l");
    await expect(list).toBeVisible();
    await expect(first).toBeFocused();
  }
  // with no list over the map, Esc climbs one level, as it does from the list in the map's place
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBe(`observatory:${component}/`);
  if (webgl) await expect(list).toBeHidden();
  else await expect(list).toBeVisible();
  // an l typed into Find is the box's
  const q = page.locator("#q");
  await q.focus();
  await page.keyboard.press("l");
  await expect(q).toHaveValue("l");
  await expect(q).toBeFocused();
  if (webgl) await expect(list).toBeHidden();
  else await expect(first).not.toBeFocused();
});

test("while Tests is on, the list ends with the test files by path, and a click selects one", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const tests = testsOf(m);
  expect(tests.length).toBeGreaterThan(0);
  const all = [...kept(m, () => true), ...tests];
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (webgl) await page.keyboard.press("l");
  else await expectNoWebGL(page);
  const list = listView(page);
  await expect(list.getByRole("button")).toHaveCount(m.counts.productionFiles);
  await page.getByRole("checkbox", { name: /^Tests/ }).check();
  await expect(list.getByRole("button")).toHaveText(
    all.map((f) => labelOf(m, f)),
  );
  await expect(list.locator("h3")).toHaveText(
    `Files, ranked ${all.length} files`,
  );
  const last = must(tests.at(-1), "test file");
  await list.getByRole("button").last().click();
  expect(await selectedId(page)).toBe(`observatory:${m.files[last][F.path]}`);
  if (webgl) await expect(list).toBeHidden();
  else await expect(list).toBeVisible();
});

test("the list shows 200 files at a time, and says how many more there are", async ({
  page,
  browserName,
}) => {
  // the sample, with code files added past the first 200 of the list: 330 in all
  const m = await fetchMap(E2E.sample);
  const lang = m.langs.indexOf("typescript");
  const extra = 330 - m.counts.productionFiles;
  expect(extra).toBeGreaterThan(0);
  const grow = (map: MapData) => {
    for (let i = 0; i < extra; i++) {
      const rank = map.counts.productionFiles + i + 1;
      map.files.push([
        `zz/f${String(i).padStart(3, "0")}.ts`,
        CODE,
        lang,
        -1,
        10,
        rank,
        0,
        0,
        0,
        -1,
        0,
        0,
      ]);
    }
    map.counts.productionFiles += extra;
  };
  grow(m);
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    grow(map);
    await route.fulfill({ response, json: map });
  });
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (webgl) await page.keyboard.press("l");
  else await expectNoWebGL(page);
  const list = listView(page);
  const items = list.getByRole("listitem");
  const all = kept(m, () => true);
  expect(all).toHaveLength(330);
  await expect(items).toHaveCount(200);
  await expect(items.getByRole("button")).toHaveText(
    all.slice(0, 200).map((f) => labelOf(m, f)),
  );
  const more = list.getByRole("button", { name: "Show 130 more" });
  await more.click();
  await expect(items).toHaveCount(330);
  await expect(items.getByRole("button")).toHaveText(
    all.map((f) => labelOf(m, f)),
  );
  // the focus moves to the first file the press added, and nothing more remains to show
  await expect(items.nth(200).getByRole("button")).toBeFocused();
  await expect(more).toHaveCount(0);
  await expect(list.getByRole("button", { name: /^Show / })).toHaveCount(0);
});

test("the list pages 200 files at a time", async ({ page, browserName }) => {
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
  await openViewer(page, scale);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (webgl) await page.keyboard.press("l");
  else await expectNoWebGL(page);
  const items = listView(page).getByRole("listitem");
  await expect(items).toHaveCount(200);
  await page.getByRole("button", { name: "Show 200 more" }).click();
  await expect(items).toHaveCount(400);
  await expect(items.nth(200).getByRole("button")).toBeFocused();
});

test("names that hold markup are listed as text", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.markup);
  const all = [...kept(m, () => true), ...testsOf(m)];
  expect(all.length).toBeGreaterThan(0);
  await openViewer(page, E2E.markup);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (webgl) await page.keyboard.press("l");
  else await expectNoWebGL(page);
  await page.getByRole("checkbox", { name: /^Tests/ }).check();
  await expect(listView(page).getByRole("button")).toHaveText(
    all.map((f) => labelOf(m, f)),
  );
  await expect(page.locator("img, [onerror], [onload]")).toHaveCount(0);
});

test.describe("without WebGL", () => {
  // Each browser's own switch, in a browser launched for this test: Chromium's turns its 3D APIs
  // off, and Firefox's preference turns WebGL off, so the page meets a browser that has no WebGL
  // at all. A launch option set for a group of tests would need a worker of its own, which
  // Playwright refuses.
  test("the list view replaces the map", async ({
    playwright,
    browserName,
  }) => {
    const browser = await playwright[browserName].launch(
      browserName === "chromium"
        ? { args: ["--disable-3d-apis"] }
        : { firefoxUserPrefs: { "webgl.disabled": true } },
    );
    try {
      const page = await browser.newPage();
      const m = await fetchMap(E2E.sample);
      await openViewer(page, E2E.sample);
      expect(await hasWebGL(page)).toBe(false);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "nomap");
      await expect(page.locator("#map-notice")).toHaveText(
        "This browser cannot draw the map (no WebGL). The list view shows the same files.",
      );
      await expectNoWebGL(page);
      const list = listView(page);
      await expect(list.getByRole("button")).toHaveText(
        kept(m, () => true).map((f) => labelOf(m, f)),
      );
      // the map's own controls are gone, and the stat band still works
      await expect(
        page.getByRole("button", { name: "Fit the map" }),
      ).toBeHidden();
      await page.locator('#statband [data-stat="tests"]').click();
      await expect(
        page.getByRole("checkbox", { name: /^Tests/ }),
      ).toBeChecked();
      await expect(list.getByRole("button")).toHaveCount(
        m.counts.productionFiles + m.counts.tests,
      );
      await list.getByRole("button").first().click();
      expect(await selectedId(page)).not.toBeNull();
      await expect(list).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
